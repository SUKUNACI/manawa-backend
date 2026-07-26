require('dotenv').config();

const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
  });
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const verificationRoutes = require('./routes/verification');
const subscriptionRoutes = require('./routes/subscriptions');
const projectRoutes = require('./routes/projects');
const professionalRoutes = require('./routes/professionals');
const quoteRoutes = require('./routes/quotes');
const messageRoutes = require('./routes/messages');
const reviewRoutes = require('./routes/reviews');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const supportRoutes = require('./routes/support');
const portfolioProjectsRoutes = require('./routes/portfolio-projects');
const reportsRoutes = require('./routes/reports');

// Firebase initialization
const { initializeFirebase, getMessaging } = require('./config/firebase-admin');
const { setMessaging } = require('./config/pushNotifications');

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:8081', 'http://localhost:19006'];

app.set('trust proxy', 1);
app.use(cors({ origin: allowedOrigins }));

// Initialize Firebase
const firebaseApp = initializeFirebase();
if (firebaseApp) {
  try {
    const messaging = getMessaging();
    setMessaging(messaging);
    console.log('[Server] Firebase Cloud Messaging initialized ✅');
  } catch (err) {
    console.error('[Server] Firebase messaging initialization failed:', err.message);
  }
}

const io = new Server(server, {
  cors: { origin: allowedOrigins },
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans quelques minutes' },
});
app.use(globalLimiter);

app.use('/uploads', express.static(require('path').join(__dirname, '../uploads')));

app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhooks/geniuspay' || req.originalUrl === '/api/payments/notify' || req.originalUrl === '/api/subscriptions/notify') {
    return next();
  }
  express.json({ limit: '10mb' })(req, res, next);
});

// Routes REST
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/professionals', professionalRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/portfolio-projects', portfolioProjectsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);

// Panel d'administration (interface web)
app.use('/admin', express.static(require('path').join(__dirname, '../admin-panel')));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Messagerie temps réel (Socket.IO) — authentification par token JWT
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token requis'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch (err) {
    next(new Error('Token invalide'));
  }
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, socket.id);

  socket.on('send_message', (message) => {
    if (message.senderId !== socket.userId) return;
    const receiverSocket = onlineUsers.get(message.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('receive_message', message);
    }
  });

  socket.on('disconnect', () => {
    if (onlineUsers.get(socket.userId) === socket.id) {
      onlineUsers.delete(socket.userId);
    }
  });
});

// Sentry error handler (doit être avant le handler custom)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Middleware global d'erreurs
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  res.status(err.status || 500).json({ error: 'Erreur interne du serveur' });
});

// Expiration automatique des devis — vérifie toutes les heures
const prisma = require('./config/db');

async function expireQuotes() {
  try {
    const { count } = await prisma.quote.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (count > 0) console.log(`[CRON] ${count} devis expiré(s)`);
  } catch (err) {
    console.error('[CRON] Erreur expiration devis:', err.message);
  }
}

setInterval(expireQuotes, 60 * 60 * 1000);
expireQuotes();

// Expiration automatique des paiements pending depuis plus de 1h
const { logPaymentStatus } = require('./utils/paymentAudit');

async function expirePendingPayments() {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const expiredPayments = await prisma.payment.findMany({
      where: { status: 'pending', createdAt: { lt: oneHourAgo } },
      select: { id: true, status: true },
    });
    if (expiredPayments.length === 0) return;

    await prisma.payment.updateMany({
      where: { id: { in: expiredPayments.map(p => p.id) } },
      data: { status: 'failed' },
    });

    for (const p of expiredPayments) {
      await logPaymentStatus({ paymentId: p.id, fromStatus: 'pending', toStatus: 'failed', reason: 'cron_expiry' });
    }

    console.log(`[CRON] ${expiredPayments.length} paiement(s) pending expiré(s)`);
  } catch (err) {
    console.error('[CRON] Erreur expiration paiements:', err.message);
  }
}

setInterval(expirePendingPayments, 60 * 60 * 1000);
expirePendingPayments();

// Réconciliation paiements pending < 1h avec GeniusPay (filet de sécurité)
// Couvre les cas où : webhook manqué + client n'a pas retenté + paiement < 1h
const geniuspay = require('./utils/geniuspay');

async function reconcilePendingPayments() {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    // Seulement les pending récents (< 1h) — les plus anciens sont gérés par expirePendingPayments
    const pendingPayments = await prisma.payment.findMany({
      where: {
        status: 'pending',
        geniuspayRef: { not: null },
        createdAt: { gte: oneHourAgo },
      },
      select: { id: true, status: true, geniuspayRef: true, amount: true },
    });

    if (pendingPayments.length === 0) return;
    console.log(`[CRON] Réconciliation : ${pendingPayments.length} paiement(s) pending à vérifier`);

    let synced = 0;
    let failed = 0;

    for (const payment of pendingPayments) {
      try {
        const gpResponse = await geniuspay.getPayment(payment.geniuspayRef);
        const gpData = gpResponse?.data || gpResponse;
        const realStatus = gpData?.status;

        if (realStatus === 'completed' || realStatus === 'success') {
          const receivedAmount = gpData?.amount || gpData?.paid_amount;
          if (receivedAmount !== undefined && Math.abs(receivedAmount - payment.amount) > 1) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { status: 'failed', metadata: JSON.stringify({ reason: 'amount_mismatch', expected: payment.amount, received: receivedAmount }) },
            });
            await logPaymentStatus({ paymentId: payment.id, fromStatus: 'pending', toStatus: 'failed', reason: 'amount_mismatch', metadata: { expected: payment.amount, received: receivedAmount } });
            failed++;
          } else {
            await prisma.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', completedAt: new Date() } });
            await logPaymentStatus({ paymentId: payment.id, fromStatus: 'pending', toStatus: 'succeeded', reason: 'reconciliation' });
            synced++;
          }
        } else if (realStatus === 'failed' || realStatus === 'cancelled' || realStatus === 'expired') {
          await prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed' } });
          await logPaymentStatus({ paymentId: payment.id, fromStatus: 'pending', toStatus: 'failed', reason: 'reconciliation', metadata: { geniuspayStatus: realStatus } });
          failed++;
        }
        // Si GeniusPay retourne encore 'pending' → on ne touche rien, on re-vérifie au prochain cron
      } catch (err) {
        // GeniusPay injoignable pour ce paiement — on ignore, on réessaiera au prochain tour
        console.warn(`[CRON] Réconciliation — impossible de vérifier ${payment.geniuspayRef}: ${err.message}`);
      }
    }

    if (synced > 0 || failed > 0) {
      console.log(`[CRON] Réconciliation terminée — ${synced} confirmé(s), ${failed} échoué(s)`);
    }
  } catch (err) {
    console.error('[CRON] Erreur réconciliation paiements:', err.message);
  }
}

// Décalage de 30min par rapport aux autres crons pour éviter les pics simultanés
setTimeout(() => {
  reconcilePendingPayments();
  setInterval(reconcilePendingPayments, 60 * 60 * 1000);
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Serveur MANAWA démarré sur le port ${PORT}`);
});
