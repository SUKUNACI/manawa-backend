const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');

// Mock Prisma avant tout import de route
jest.mock('../src/config/db', () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  professional: {
    create: jest.fn(),
  },
  verificationCode: {
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    create: jest.fn(),
  },
  refreshToken: {
    create:     jest.fn().mockResolvedValue({ token: 'mock-refresh-token' }),
    findUnique: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    delete:     jest.fn(),
  },
}));

const prisma = require('../src/config/db');
const authRoutes = require('../src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

// ─── REGISTER ────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(null); // email dispo par défaut
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      email: 'test@manawa.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      role: 'CLIENT',
      phone: null,
      city: null,
      avatarUrl: null,
      emailVerified: false,
      phoneVerified: false,
      createdAt: new Date(),
    });
  });

  test('crée un compte CLIENT avec les champs requis', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'test@manawa.com',
        password: 'password123',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'CLIENT',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('test@manawa.com');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  test('retourne 409 si email déjà utilisé', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'exist@manawa.com',
        password: 'password123',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'CLIENT',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/déjà utilisé/i);
  });

  test('retourne 400 si email invalide', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'pasunemail',
        password: 'password123',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'CLIENT',
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  test('retourne 400 si mot de passe trop court', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'test@manawa.com',
        password: '123',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'CLIENT',
      });

    expect(res.status).toBe(400);
  });

  test('retourne 400 si role invalide', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'test@manawa.com',
        password: 'password123',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'ADMIN',
      });

    expect(res.status).toBe(400);
  });

  test('crée un compte PROFESSIONAL', async () => {
    prisma.professional = { create: jest.fn().mockResolvedValue({ id: 'pro-1' }) };
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      email: 'pro@manawa.com',
      firstName: 'Marie',
      lastName: 'Martin',
      role: 'PROFESSIONAL',
      phone: null,
      city: null,
      avatarUrl: null,
      emailVerified: false,
      phoneVerified: false,
      createdAt: new Date(),
      professional: { id: 'pro-1', trade: 'Maçon', trades: [] },
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'pro@manawa.com',
        password: 'password123',
        firstName: 'Marie',
        lastName: 'Martin',
        role: 'PROFESSIONAL',
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
  });
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  const hashedPassword = bcrypt.hashSync('password123', 10);

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@manawa.com',
      passwordHash: hashedPassword,
      role: 'CLIENT',
      suspended: false,
      deletedAt: null,
      firstName: 'Jean',
      lastName: 'Dupont',
      phone: null,
      city: null,
      avatarUrl: null,
      emailVerified: true,
      phoneVerified: false,
      createdAt: new Date(),
    });
  });

  test('retourne un token avec les bons identifiants', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@manawa.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe('test@manawa.com');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  test('retourne 401 si mot de passe incorrect', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@manawa.com', password: 'mauvais' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  test('retourne 401 si email introuvable', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inconnu@manawa.com', password: 'password123' });

    expect(res.status).toBe(401);
  });

  test('retourne 403 si compte suspendu', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@manawa.com',
      passwordHash: hashedPassword,
      role: 'CLIENT',
      suspended: true,
      deletedAt: null,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@manawa.com', password: 'password123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspendu/i);
  });

  test('retourne 403 si compte supprimé', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@manawa.com',
      passwordHash: hashedPassword,
      role: 'CLIENT',
      suspended: false,
      deletedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@manawa.com', password: 'password123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/supprimé/i);
  });

  test('retourne 400 si email manquant', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'password123' });

    expect(res.status).toBe(400);
  });
});
