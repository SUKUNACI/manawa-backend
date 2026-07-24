const request = require('supertest');
const express = require('express');
const { proToken, clientToken } = require('./helpers');

jest.mock('../src/config/db', () => ({
  user: { findUnique: jest.fn() },
  professional: { findUnique: jest.fn() },
  project: { findUnique: jest.fn(), update: jest.fn() },
  quote: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  quoteItem: { createMany: jest.fn() },
}));

// Mock PDF — évite les vraies générations
jest.mock('../src/utils/generateQuotePdf', () => jest.fn().mockResolvedValue('https://res.cloudinary.com/test/quote.pdf'));

const prisma = require('../src/config/db');
const quoteRoutes = require('../src/routes/quotes');

// Middleware auth réel (signe des vrais JWT en test)
const { requireAuth, requireRole } = require('../src/middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/quotes', quoteRoutes);
app.use((err, req, res, next) => {
  console.error('[QUOTE TEST ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

const PRO_USER_ID = 'pro-user-1';
const CLIENT_USER_ID = 'client-1';

const mockProUser = { id: PRO_USER_ID, role: 'PROFESSIONAL', email: 'pro@test.com', suspended: false };
const mockClientUser = { id: CLIENT_USER_ID, role: 'CLIENT', email: 'client@test.com', suspended: false };

const mockPro = {
  id: 'pro-1',
  userId: PRO_USER_ID,
  verifiedByAdmin: true,
  identityStatus: 'APPROVED',
  subscription: null,
};

const mockProject = {
  id: 'project-1',
  clientId: CLIENT_USER_ID,
  status: 'OPEN',
};

const mockQuote = {
  id: 'quote-1',
  projectId: 'project-1',
  professionalId: 'pro-1',
  status: 'PENDING',
  mode: 'SIMPLE',
  amount: 1000,
  description: 'Travaux de maçonnerie',
  version: 1,
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  items: [],
  project: mockProject,
  professional: { user: { firstName: 'Marie', lastName: 'Martin' } },
  revisions: [],
};

// ─── POST /api/quotes ─────────────────────────────────────────────────────────

describe('POST /api/quotes', () => {
  beforeEach(() => {
    // requireAuth récupère l'utilisateur depuis la DB
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where?.id === PRO_USER_ID) return Promise.resolve(mockProUser);
      if (where?.id === CLIENT_USER_ID) return Promise.resolve(mockClientUser);
      return Promise.resolve(null);
    });
    prisma.professional.findUnique.mockResolvedValue(mockPro);
    prisma.project.findUnique.mockResolvedValue(mockProject);
    prisma.quote.findFirst.mockResolvedValue(null); // pas de devis en attente
    prisma.quote.create.mockResolvedValue({ ...mockQuote, items: [] });
    prisma.quote.findUnique.mockResolvedValue({ ...mockQuote, items: [], professional: { user: { firstName: 'Marie', lastName: 'Martin', email: 'pro@test.com', phone: null, city: null } }, project: { ...mockProject, client: { firstName: 'Client', lastName: 'Test', email: 'client@test.com', phone: null, city: null }, title: 'Projet test', clientId: CLIENT_USER_ID } });
    prisma.quoteItem.createMany.mockResolvedValue({ count: 0 });
  });

  test('crée un devis SIMPLE avec succès', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({
        projectId: 'project-1',
        description: 'Travaux de maçonnerie',
        mode: 'SIMPLE',
        amount: 1000,
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('retourne 400 si projectId manquant', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ description: 'Test', amount: 500 });

    expect(res.status).toBe(400);
  });

  test('retourne 400 si montant manquant en mode SIMPLE', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ projectId: 'project-1', description: 'Test', mode: 'SIMPLE' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/montant/i);
  });

  test('retourne 400 si items manquants en mode DETAILED', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ projectId: 'project-1', description: 'Test', mode: 'DETAILED', items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ligne/i);
  });

  test('retourne 403 si identité non vérifiée', async () => {
    prisma.professional.findUnique.mockResolvedValue({
      ...mockPro,
      verifiedByAdmin: false,
    });

    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ projectId: 'project-1', description: 'Test', amount: 500 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/identité/i);
  });

  test('retourne 409 si devis en attente déjà existant', async () => {
    prisma.quote.findFirst.mockResolvedValue(mockQuote);

    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ projectId: 'project-1', description: 'Test', amount: 500 });

    expect(res.status).toBe(409);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .send({ projectId: 'project-1', description: 'Test', amount: 500 });

    expect(res.status).toBe(401);
  });

  test('retourne 403 si CLIENT essaie de créer un devis', async () => {
    const res = await request(app)
      .post('/api/quotes')
      .set('Authorization', `Bearer ${clientToken(CLIENT_USER_ID)}`)
      .send({ projectId: 'project-1', description: 'Test', amount: 500 });

    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/quotes/:id (accepter/refuser) ─────────────────────────────────

describe('PATCH /api/quotes/:id', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where?.id === PRO_USER_ID) return Promise.resolve(mockProUser);
      if (where?.id === CLIENT_USER_ID) return Promise.resolve(mockClientUser);
      return Promise.resolve(null);
    });
    prisma.quote.findUnique.mockResolvedValue(mockQuote);
    prisma.quote.update.mockResolvedValue({ ...mockQuote, status: 'ACCEPTED' });
    prisma.project.findUnique.mockResolvedValue(mockProject);
  });

  test('client peut accepter un devis', async () => {
    const res = await request(app)
      .patch('/api/quotes/quote-1')
      .set('Authorization', `Bearer ${clientToken(CLIENT_USER_ID)}`)
      .send({ status: 'ACCEPTED' });

    expect(res.status).toBe(200);
  });

  test('client peut refuser un devis', async () => {
    prisma.quote.update.mockResolvedValue({ ...mockQuote, status: 'REFUSED' });

    const res = await request(app)
      .patch('/api/quotes/quote-1')
      .set('Authorization', `Bearer ${clientToken(CLIENT_USER_ID)}`)
      .send({ status: 'REFUSED' });

    expect(res.status).toBe(200);
  });

  test('retourne 400 si statut invalide', async () => {
    const res = await request(app)
      .patch('/api/quotes/quote-1')
      .set('Authorization', `Bearer ${clientToken(CLIENT_USER_ID)}`)
      .send({ status: 'EXPIRED' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ACCEPTED ou REFUSED/i);
  });

  test('retourne 400 si devis expiré', async () => {
    prisma.quote.findUnique.mockResolvedValue({
      ...mockQuote,
      expiresAt: new Date(Date.now() - 1000),
    });
    prisma.quote.update.mockResolvedValue({ ...mockQuote, status: 'EXPIRED' });

    const res = await request(app)
      .patch('/api/quotes/quote-1')
      .set('Authorization', `Bearer ${clientToken(CLIENT_USER_ID)}`)
      .send({ status: 'ACCEPTED' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expiré/i);
  });

  test('retourne 403 si pro essaie d\'accepter un devis', async () => {
    const res = await request(app)
      .patch('/api/quotes/quote-1')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`)
      .send({ status: 'ACCEPTED' });

    expect(res.status).toBe(403);
  });
});

// ─── GET /api/quotes/mine ─────────────────────────────────────────────────────

describe('GET /api/quotes/mine', () => {
  test('retourne les devis du pro connecté', async () => {
    prisma.user.findUnique.mockResolvedValue(mockProUser);
    prisma.professional.findUnique.mockResolvedValue(mockPro);
    prisma.quote.findMany.mockResolvedValue([mockQuote]);

    const res = await request(app)
      .get('/api/quotes/mine')
      .set('Authorization', `Bearer ${proToken(PRO_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/quotes/mine');
    expect(res.status).toBe(401);
  });
});
