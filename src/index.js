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
const disputeRoutes = require('./routes/disputes');

// Firebase initialization
const { initializeFirebase, getMessaging } = require('./config/firebase-admin');
const { setMessaging } = require('./config/pushNotifications');

const helmet = require('helmet');

const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
app.use(cookieParser());

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:8081', 'http://localhost:19006'];

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Helmet : CSP désactivée sur le panel admin (onclick inline + scripts CDN)
// Routes API : CSP restrictive + headers sécurité complets (corrige ZAP alerts)
const ADMIN_PANEL_PATH_EARLY = process.env.ADMIN_PANEL_PATH || '/admin';
app.use((req, res, next) => {
  if (req.path.startsWith(ADMIN_PANEL_PATH_EARLY) || req.path.startsWith('/admin')) {
    return helmet({
      contentSecurityPolicy: false,
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })(req, res, next);
  }
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        connectSrc: ["'none'"],
        fontSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })(req, res, next);
});

// Cache-Control: no-store sur les routes API sensibles (corrige ZAP alert)
// req.originalUrl contient le chemin complet (/api/auth/login), pas req.path (/login)
const SENSITIVE_API_PATHS = ['/api/auth', '/api/payments', '/api/users', '/api/admin', '/api/verification', '/api/subscriptions'];
app.use((req, res, next) => {
  if (SENSITIVE_API_PATHS.some(p => req.originalUrl.startsWith(p))) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

app.use(cors({ origin: allowedOrigins, credentials: true }));

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
  express.json({ limit: '1mb' })(req, res, next);
});

// Routes REST
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/professionals', professionalRoutes);
// Injecte le cookie httpOnly adminToken comme Bearer header
// Appliqué sur /api/quotes ET /api/admin pour permettre l'accès depuis le back-office
const injectAdminCookie = (req, res, next) => {
  const cookieToken = req.cookies?.adminToken;
  if (cookieToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${cookieToken}`;
  }
  next();
};
app.use('/api/quotes', injectAdminCookie, quoteRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', injectAdminCookie, adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/portfolio-projects', portfolioProjectsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/disputes', disputeRoutes);

// Panel d'administration
const prismaForIPGuard = require('./config/db');
const fs = require('fs');
const adminPanelDir = require('path').join(__dirname, '../admin-panel');

// Cache-busting : hash MD5 de dashboard.js calculé au démarrage
let dashboardHash = 'v1';
try {
  const content = fs.readFileSync(require('path').join(adminPanelDir, 'dashboard.js'));
  dashboardHash = require('crypto').createHash('md5').update(content).digest('hex').slice(0, 8);
} catch {}

// Restriction IP : lit la liste en DB (AppConfig key=admin_allowed_ips)
const adminIPGuard = async (req, res, next) => {
  try {
    const row = await prismaForIPGuard.appConfig.findUnique({ where: { key: 'admin_allowed_ips' } });
    let allowedIPs = [];
    if (row) { try { allowedIPs = JSON.parse(row.value).map(e => e.ip); } catch {} }
    if (allowedIPs.length === 0) return next();
    const clientIP = (req.ip || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
    if (allowedIPs.includes(clientIP)) return next();
    console.warn(`[AdminPanel] IP refusée : ${clientIP}`);
    return res.status(403).send('Accès interdit');
  } catch { return res.status(503).send('Accès temporairement indisponible'); }
};

// Auth cookie : login.html, login.js et les assets statiques (.js/.css) sont publics
const adminPanelAuth = (req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login.js') return next();
  if (req.path.match(/\.(js|css|png|jpg|ico|svg|woff2?)(\?.*)?$/)) return next();
  const token = req.cookies?.adminToken;
  if (!token) return res.redirect('/admin/login.html');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'ADMIN') return res.redirect('/admin/login.html');
    next();
  } catch { return res.redirect('/admin/login.html'); }
};

// Servir index.html avec hash injecté et Cache-Control no-store
app.use('/admin', adminIPGuard, adminPanelAuth, (req, res, next) => {
  if (req.path !== '/' && req.path !== '/index.html') return next();
  try {
    let html = fs.readFileSync(require('path').join(adminPanelDir, 'index.html'), 'utf8');
    html = html.replace(/dashboard\.js(\?v=[^"']*)?/g, 'dashboard.js?v=' + dashboardHash);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch { return next(); }
});

app.use('/admin', adminIPGuard, adminPanelAuth, express.static(adminPanelDir, {
  setHeaders: (res, filePath) => {
    // Forcer no-store sur dashboard.js et index.html — jamais de cache navigateur
    if (filePath.endsWith('dashboard.js') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

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

// Rate limit Socket.IO : 60 messages/min par userId
const socketMessageCounts = new Map();
function isSocketRateLimited(userId) {
  const now = Date.now();
  const entry = socketMessageCounts.get(userId) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  socketMessageCounts.set(userId, entry);
  return entry.count > 60;
}

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, socket.id);

  socket.on('send_message', (message) => {
    if (message.senderId !== socket.userId) return;
    if (isSocketRateLimited(socket.userId)) {
      socket.emit('error', { message: 'Trop de messages, réessayez dans une minute' });
      return;
    }
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

// Nettoyage des refresh tokens expirés (toutes les 24h)
async function cleanExpiredRefreshTokens() {
  try {
    const { count } = await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) console.log(`[CRON] ${count} refresh token(s) expiré(s) supprimé(s)`);
  } catch (err) {
    console.error('[CRON] Erreur nettoyage refresh tokens:', err.message);
  }
}

setInterval(cleanExpiredRefreshTokens, 24 * 60 * 60 * 1000);
cleanExpiredRefreshTokens();

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

const { seedConfig, ensureSuperAdmin } = require('./utils/appConfig');

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Serveur MANAWA démarré sur le port ${PORT}`);
  seedConfig().catch(err => console.error('[Config] Erreur seed:', err.message));
  ensureSuperAdmin().catch(err => console.error('[Boot] Erreur ensureSuperAdmin:', err.message));
});
