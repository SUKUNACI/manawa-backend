const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

router.use(requireAuth);

// 5 tickets max par heure, 20 messages par heure
const createTicketLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop de tickets créés, réessayez dans une heure' },
});

const ticketMessageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop de messages envoyés, réessayez dans une heure' },
});

// GET /api/support/tickets — mes tickets
router.get('/tickets', async (req, res, next) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    res.json(tickets);
  } catch (err) {
    next(err);
  }
});

// POST /api/support/tickets — créer un ticket
router.post('/tickets', createTicketLimiter, async (req, res, next) => {
  try {
    const { category, subject, message } = req.body;
    if (!category || !subject || !message) {
      return res.status(400).json({ error: 'Catégorie, sujet et message sont requis' });
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        category,
        subject,
        messages: {
          create: { senderId: req.user.id, content: message, isAdmin: false },
        },
      },
      include: { messages: true },
    });

    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// GET /api/support/tickets/:id — détail d'un ticket avec messages
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket non trouvé' });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/support/tickets/:id/messages — répondre à un ticket
router.post('/tickets/:id/messages', ticketMessageLimiter, async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket non trouvé' });
    if (ticket.status === 'CLOSED') return res.status(400).json({ error: 'Ce ticket est fermé' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const msg = await prisma.supportMessage.create({
      data: { ticketId: ticket.id, senderId: req.user.id, content: message, isAdmin: false },
    });

    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: 'OPEN' } });

    res.status(201).json(msg);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
