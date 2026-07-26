const request = require('supertest');
const express = require('express');
const { clientToken, proToken } = require('./helpers');

jest.mock('../src/config/db', () => ({
  user:          { findUnique: jest.fn() },
  supportTicket: {
    findMany:  jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    create:    jest.fn(),
    update:    jest.fn(),
  },
  supportMessage: {
    create: jest.fn(),
  },
}));

const prisma = require('../src/config/db');
const supportRoutes = require('../src/routes/support');

const app = express();
app.use(express.json());
app.use('/api/support', supportRoutes);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

const CLIENT_ID = 'client-1';
const mockClient = { id: CLIENT_ID, role: 'CLIENT', suspended: false };

const mockTicket = {
  id: 'ticket-1', userId: CLIENT_ID, category: 'PAYMENT',
  subject: 'Problème paiement', status: 'OPEN',
  createdAt: new Date(), updatedAt: new Date(),
  messages: [{ id: 'msg-1', content: 'Aide moi', isAdmin: false, createdAt: new Date() }],
};

// ══ GET /api/support/tickets ═════════════════════════════════════════════════

describe('GET /api/support/tickets', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockClient);
    prisma.supportTicket.findMany.mockResolvedValue([mockTicket]);
  });

  test('retourne les tickets du client connecté', async () => {
    const res = await request(app)
      .get('/api/support/tickets')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: CLIENT_ID } })
    );
  });

  test('401 sans token', async () => {
    const res = await request(app).get('/api/support/tickets');
    expect(res.status).toBe(401);
  });
});

// ══ POST /api/support/tickets ════════════════════════════════════════════════

describe('POST /api/support/tickets', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockClient);
    prisma.supportTicket.create.mockResolvedValue(mockTicket);
  });

  test('crée un ticket et retourne 201', async () => {
    const res = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ category: 'PAYMENT', subject: 'Problème paiement', message: 'Aide moi' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(prisma.supportTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: CLIENT_ID, category: 'PAYMENT', subject: 'Problème paiement' }),
      })
    );
  });

  test('400 si category manquante', async () => {
    const res = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ subject: 'Test', message: 'Contenu' });

    expect(res.status).toBe(400);
  });

  test('400 si subject manquant', async () => {
    const res = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ category: 'PAYMENT', message: 'Contenu' });

    expect(res.status).toBe(400);
  });

  test('400 si message manquant', async () => {
    const res = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ category: 'PAYMENT', subject: 'Test' });

    expect(res.status).toBe(400);
  });

  test('401 sans token', async () => {
    const res = await request(app).post('/api/support/tickets').send({});
    expect(res.status).toBe(401);
  });
});

// ══ GET /api/support/tickets/:id ═════════════════════════════════════════════

describe('GET /api/support/tickets/:id', () => {
  beforeEach(() => prisma.user.findUnique.mockResolvedValue(mockClient));

  test('retourne le ticket avec ses messages', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(mockTicket);

    const res = await request(app)
      .get('/api/support/tickets/ticket-1')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ticket-1');
    expect(prisma.supportTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ticket-1', userId: CLIENT_ID } })
    );
  });

  test('404 si ticket introuvable ou appartient à un autre user', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/support/tickets/inexistant')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`);

    expect(res.status).toBe(404);
  });
});

// ══ POST /api/support/tickets/:id/messages ════════════════════════════════════

describe('POST /api/support/tickets/:id/messages', () => {
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(mockClient);
    prisma.supportMessage.create.mockResolvedValue({
      id: 'smsg-1', ticketId: 'ticket-1', content: 'Réponse', isAdmin: false, createdAt: new Date(),
    });
  });

  test('ajoute un message au ticket et retourne 201', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(mockTicket);
    prisma.supportTicket.update.mockResolvedValue({ ...mockTicket, status: 'OPEN' });

    const res = await request(app)
      .post('/api/support/tickets/ticket-1/messages')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ message: 'Réponse complémentaire' });

    expect(res.status).toBe(201);
    expect(prisma.supportMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ticketId: 'ticket-1', senderId: CLIENT_ID, isAdmin: false }),
      })
    );
  });

  test('400 si le ticket est fermé', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ ...mockTicket, status: 'CLOSED' });

    const res = await request(app)
      .post('/api/support/tickets/ticket-1/messages')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ message: 'Réponse' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fermé/i);
  });

  test('400 si message vide', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(mockTicket);

    const res = await request(app)
      .post('/api/support/tickets/ticket-1/messages')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('404 si ticket introuvable', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/support/tickets/inexistant/messages')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`)
      .send({ message: 'Test' });

    expect(res.status).toBe(404);
  });
});
