const request = require('supertest');
const express = require('express');
const { proToken, clientToken } = require('./helpers');

jest.mock('../src/config/db', () => ({
  user:         { findUnique: jest.fn() },
  professional: { findUnique: jest.fn() },
  subscription: { upsert: jest.fn(), updateMany: jest.fn() },
  promoCode:    { findUnique: jest.fn() },
  promoUsage:   { findUnique: jest.fn() },
  $transaction: jest.fn(ops => Promise.all(ops)),
}));

jest.mock('../src/utils/appConfig', () => ({
  getConfig: jest.fn().mockResolvedValue(null),
}));

const prisma    = require('../src/config/db');
const appConfig = require('../src/utils/appConfig');
const subscriptionRoutes = require('../src/routes/subscriptions');

const app = express();
app.use(express.json());
app.use('/api/subscriptions', subscriptionRoutes);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const PRO_ID   = 'pro-user-1';
const CLIENT_ID = 'client-1';
const mockPro  = { id: PRO_ID, role: 'PROFESSIONAL', suspended: false };
const mockCli  = { id: CLIENT_ID, role: 'CLIENT',    suspended: false };

const mockProfessional = {
  id: 'p-1', userId: PRO_ID, trialEndsAt: null,
  subscription: null,
};

const mockProfessionalWithTrial = {
  ...mockProfessional,
  trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // dans 10 jours
};

const mockProfessionalWithSub = {
  ...mockProfessional,
  subscription: {
    tier: 'ESSENTIEL', status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
  },
};

// ══ GET /api/subscriptions/me ════════════════════════════════════════════

describe('GET /api/subscriptions/me', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockPro);
    appConfig.getConfig.mockResolvedValue(null); // prix par défaut
  });

  test('retourne GRATUIT sans abonnement ni trial', async () => {
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);

    const res = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('GRATUIT');
    expect(res.body.isPremium).toBe(false);
    expect(res.body.isOnTrial).toBe(false);
  });

  test('retourne PRO avec trial actif', async () => {
    prisma.professional.findUnique.mockResolvedValue(mockProfessionalWithTrial);

    const res = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('PRO');
    expect(res.body.isOnTrial).toBe(true);
    expect(res.body.trialDaysLeft).toBeGreaterThan(0);
  });

  test('retourne ESSENTIEL avec abonnement actif', async () => {
    prisma.professional.findUnique.mockResolvedValue(mockProfessionalWithSub);

    const res = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('ESSENTIEL');
    expect(res.body.isPremium).toBe(true);
  });

  test('inclut la liste des plans disponibles', async () => {
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);

    const res = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`);

    expect(res.body.plans).toBeDefined();
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans.length).toBeGreaterThan(0);
    expect(res.body.plans.every(p => p.key !== 'GRATUIT')).toBe(true);
  });

  test('403 si CLIENT essaie d\'accéder', async () => {
    prisma.user.findUnique.mockResolvedValue(mockCli);

    const res = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`);

    expect(res.status).toBe(403);
  });

  test('401 sans token', async () => {
    const res = await request(app).get('/api/subscriptions/me');
    expect(res.status).toBe(401);
  });
});

// ══ POST /api/subscriptions/validate-promo ════════════════════════════════

describe('POST /api/subscriptions/validate-promo', () => {
  const mockPromoCode = {
    id: 'promo-1', code: 'TEST10', active: true,
    discountType: 'PERCENT', discountValue: 10,
    description: '10% de remise',
    validFrom: new Date(Date.now() - 1000),
    validUntil: null,
    maxUses: null, usedCount: 0,
    applicableTiers: [],
  };

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockPro);
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);
    appConfig.getConfig.mockResolvedValue(null);
    prisma.promoUsage.findUnique.mockResolvedValue(null);
  });

  test('valide un code promo valide et retourne les montants', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(mockPromoCode);

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ code: 'TEST10', tier: 'ESSENTIEL' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.discountAmount).toBeGreaterThan(0);
    expect(res.body.finalAmount).toBeLessThan(res.body.originalAmount);
  });

  test('400 si code inexistant', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ code: 'INEXISTANT', tier: 'ESSENTIEL' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalide/i);
  });

  test('400 si code désactivé', async () => {
    prisma.promoCode.findUnique.mockResolvedValue({ ...mockPromoCode, active: false });

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ code: 'TEST10', tier: 'ESSENTIEL' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/désactivé/i);
  });

  test('400 si code expiré', async () => {
    prisma.promoCode.findUnique.mockResolvedValue({
      ...mockPromoCode, validUntil: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ code: 'TEST10', tier: 'ESSENTIEL' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expiré/i);
  });

  test('400 si code déjà utilisé par ce pro', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(mockPromoCode);
    prisma.promoUsage.findUnique.mockResolvedValue({ id: 'usage-1' });

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ code: 'TEST10', tier: 'ESSENTIEL' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/déjà utilisé/i);
  });

  test('400 si code requis manquant', async () => {
    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('403 si CLIENT essaie de valider', async () => {
    prisma.user.findUnique.mockResolvedValue(mockCli);

    const res = await request(app)
      .post('/api/subscriptions/validate-promo')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ code: 'TEST10' });

    expect(res.status).toBe(403);
  });
});

// ══ POST /api/subscriptions/checkout ════════════════════════════════════════

describe('POST /api/subscriptions/checkout', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockPro);
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);
    appConfig.getConfig.mockResolvedValue(null);
    prisma.promoCode.findUnique.mockResolvedValue(null);
    prisma.subscription.upsert.mockResolvedValue({
      professionalId: 'p-1', tier: 'ESSENTIEL', status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  });

  test('active l\'abonnement et retourne activated:true', async () => {
    const res = await request(app)
      .post('/api/subscriptions/checkout')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ tier: 'ESSENTIEL' });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.tier).toBe('ESSENTIEL');
    expect(res.body).toHaveProperty('expiresAt');
    expect(prisma.subscription.upsert).toHaveBeenCalled();
  });

  test('accepte les tiers valides : PRO, ELITE', async () => {
    for (const tier of ['PRO', 'ELITE']) {
      prisma.subscription.upsert.mockResolvedValue({ tier, status: 'ACTIVE', expiresAt: new Date() });

      const res = await request(app)
        .post('/api/subscriptions/checkout')
        .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
        .send({ tier });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe(tier);
    }
  });

  test('400 si tier invalide', async () => {
    const res = await request(app)
      .post('/api/subscriptions/checkout')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ tier: 'INVALIDE' });

    expect(res.status).toBe(400);
  });

  test('400 si tier GRATUIT', async () => {
    const res = await request(app)
      .post('/api/subscriptions/checkout')
      .set('Authorization', `Bearer ${proToken(PRO_ID)}`)
      .send({ tier: 'GRATUIT' });

    expect(res.status).toBe(400);
  });

  test('403 si CLIENT essaie de souscrire', async () => {
    prisma.user.findUnique.mockResolvedValue(mockCli);

    const res = await request(app)
      .post('/api/subscriptions/checkout')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ tier: 'ESSENTIEL' });

    expect(res.status).toBe(403);
  });

  test('401 sans token', async () => {
    const res = await request(app).post('/api/subscriptions/checkout').send({ tier: 'ESSENTIEL' });
    expect(res.status).toBe(401);
  });
});
