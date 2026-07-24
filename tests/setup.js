process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-manawa';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.PORT = '4001';

// Désactiver Sentry en test
process.env.SENTRY_DSN = '';

// Mock Firebase pour éviter l'initialisation réelle
jest.mock('../src/config/firebase-admin', () => ({
  initializeFirebase: () => null,
  getMessaging: () => null,
  isInitialized: () => false,
}));

// Mock push notifications
jest.mock('../src/config/pushNotifications', () => ({
  setMessaging: jest.fn(),
  sendPushNotification: jest.fn().mockResolvedValue({ sent: false }),
  sendPushToMultiple: jest.fn().mockResolvedValue({ sent: 0, total: 0 }),
  sendViaFCM: jest.fn().mockResolvedValue(null),
  sendViaExpo: jest.fn().mockResolvedValue(null),
  detectTokenType: jest.fn().mockReturnValue('EXPO'),
}));

// Mock mailer
jest.mock('../src/config/mailer', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue({ sent: false, devCode: '123456' }),
  isConfigured: false,
}));

// Désactiver le rate limiter en test
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
