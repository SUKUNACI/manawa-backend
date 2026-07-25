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

setInterval(expireQuotes, 60 * 60 * 1000); // toutes les heures
expireQuotes(); // exécuter au démarrage

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Serveur MANAWA démarré sur le port ${PORT}`);
});
