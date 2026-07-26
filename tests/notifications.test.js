const request = require('supertest');
const express = require('express');
const { clientToken } = require('./helpers');

jest.mock('../src/config/db', () => ({
  user:         { findUnique: jest.fn(), update: jest.fn() },
  pushToken:    {
    upsert:      jest.fn(),
    findMany:    jest.fn().mockResolvedValue([]),
    updateMany:  jest.fn().mockResolvedValue({ count: 0 }),
  },
  notification: {
    findMany: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../src/config/pushNotifications', () => ({
  detectTokenType: jest.fn(),
  sendPushNotification: jest.fn().mockResolvedValue({ sent: false }),
}));

const prisma         = require('../src/config/db');
const { detectTokenType } = require('../src/config/pushNotifications');
const notifRoutes    = require('../src/routes/notifications');

const app = express();
app.use(express.json());
app.use('/api/notifications', notifRoutes);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const USER_ID   = 'user-1';
const mockUser  = { id: USER_ID, role: 'CLIENT', suspended: false };

const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const FCM_TOKEN  = 'x'.repeat(152); // > 100 chars
const APNS_TOKEN = 'a'.repeat(64);  // 64 hex chars

// ══ POST /api/notifications/register-token ════════════════════════════════

describe('POST /api/notifications/register-token', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.pushToken.upsert.mockResolvedValue({ id: 'pt-1', token: EXPO_TOKEN, type: 'EXPO' });
    prisma.user.update.mockResolvedValue(mockUser);
  });

  test('enregistre un token Expo et retourne registered:true', async () => {
    detectTokenType.mockReturnValue('EXPO');

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: EXPO_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(true);
    expect(res.body.type).toBe('EXPO');
    expect(prisma.pushToken.upsert).toHaveBeenCalled();
  });

  test('enregistre un token FCM', async () => {
    detectTokenType.mockReturnValue('FCM');
    prisma.pushToken.upsert.mockResolvedValue({ id: 'pt-2', token: FCM_TOKEN, type: 'FCM' });

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: FCM_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('FCM');
  });

  test('400 si token vide', async () => {
    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: '' });

    expect(res.status).toBe(400);
  });

  test('400 si token absent', async () => {
    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('400 si detectTokenType retourne null', async () => {
    detectTokenType.mockReturnValue(null);

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: 'token-invalide' });

    expect(res.status).toBe(400);
  });

  test('400 si token Expo mal formaté', async () => {
    detectTokenType.mockReturnValue('EXPO');

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: 'pas-un-token-expo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Expo invalide/i);
  });

  test('400 si token FCM trop court', async () => {
    detectTokenType.mockReturnValue('FCM');

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: 'court' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/FCM invalide/i);
  });

  test('400 si token APNs non hexadécimal 64 chars', async () => {
    detectTokenType.mockReturnValue('APNs');

    const res = await request(app)
      .post('/api/notifications/register-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`)
      .send({ token: 'pas-hex' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/APNs invalide/i);
  });

  test('401 sans token JWT', async () => {
    const res = await request(app)
      .post('/api/notifications/register-token')
      .send({ token: EXPO_TOKEN });

    expect(res.status).toBe(401);
  });
});

// ══ DELETE /api/notifications/unregister-token ════════════════════════════

describe('DELETE /api/notifications/unregister-token', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.update.mockResolvedValue(mockUser);
  });

  test('désactive tous les tokens et retourne unregistered:true', async () => {
    const res = await request(app)
      .delete('/api/notifications/unregister-token')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.unregistered).toBe(true);
    expect(prisma.pushToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, data: { isActive: false } })
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { expoPushToken: null } })
    );
  });

  test('401 sans token JWT', async () => {
    const res = await request(app).delete('/api/notifications/unregister-token');
    expect(res.status).toBe(401);
  });
});

// ══ GET /api/notifications/tokens ════════════════════════════════════════

describe('GET /api/notifications/tokens', () => {
  beforeEach(() => prisma.user.findUnique.mockResolvedValue(mockUser));

  test('retourne les tokens avec total et active', async () => {
    prisma.pushToken.findMany.mockResolvedValue([
      { id: 'pt-1', platform: 'Android', type: 'FCM',  isActive: true,  deviceId: null, lastUsed: new Date(), createdAt: new Date() },
      { id: 'pt-2', platform: 'iOS',     type: 'APNs', isActive: false, deviceId: null, lastUsed: new Date(), createdAt: new Date() },
    ]);

    const res = await request(app)
      .get('/api/notifications/tokens')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.active).toBe(1);
    expect(Array.isArray(res.body.tokens)).toBe(true);
  });

  test('401 sans token JWT', async () => {
    const res = await request(app).get('/api/notifications/tokens');
    expect(res.status).toBe(401);
  });
});

// ══ GET /api/notifications/history ═══════════════════════════════════════

describe('GET /api/notifications/history', () => {
  beforeEach(() => prisma.user.findUnique.mockResolvedValue(mockUser));

  test('retourne l\'historique des notifications paginé', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n-1', title: 'Test', body: 'Corps', read: false, createdAt: new Date() },
    ]);

    const res = await request(app)
      .get('/api/notifications/history')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } })
    );
  });

  test('respecte le paramètre page', async () => {
    prisma.notification.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/notifications/history?page=2')
      .set('Authorization', `Bearer ${clientToken(USER_ID)}`);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 30 }) // page 2 = skip 30 (limit=30)
    );
  });

  test('401 sans token JWT', async () => {
    const res = await request(app).get('/api/notifications/history');
    expect(res.status).toBe(401);
  });
});
