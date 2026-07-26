const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// 60 messages max par heure par utilisateur
const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop de messages envoyés, réessayez dans une heure' },
});

// POST /api/messages
router.post('/', requireAuth, messageLimiter, async (req, res, next) => {
  try {
    const { receiverId, content } = req.body;
    if (!receiverId || !content || !content.trim()) {
      return res.status(400).json({ error: 'receiverId et content sont requis' });
    }
    const message = await prisma.message.create({
      data: { senderId: req.user.id, receiverId, content: content.trim() },
    });

    // Notifier le destinataire
    const sender = await prisma.user.findUnique({ where: { id: req.user.id }, select: { firstName: true, lastName: true } });
    const senderName = sender ? sender.firstName + ' ' + sender.lastName : 'Quelqu\'un';
    await sendPushNotification(receiverId, 'Nouveau message', `${senderName} : ${content.trim().substring(0, 80)}`, { type: 'new_message', senderId: req.user.id });

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/conversations
router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: req.user.id }, { receiverId: req.user.id }] },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        receiver: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const conversations = new Map();
    for (const m of messages) {
      const otherUser = m.senderId === req.user.id ? m.receiver : m.sender;
      if (!conversations.has(otherUser.id)) {
        conversations.set(otherUser.id, { otherUser, lastMessage: m });
      }
    }
    res.json(Array.from(conversations.values()));
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/unread-count
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const count = await prisma.message.count({ where: { receiverId: req.user.id, read: false } });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:userId
router.get('/:userId', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: req.user.id, receiverId: req.params.userId },
          { senderId: req.params.userId, receiverId: req.user.id },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });

    await prisma.message.updateMany({
      where: { senderId: req.params.userId, receiverId: req.user.id, read: false },
      data: { read: true },
    });

    res.json(messages.reverse());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
