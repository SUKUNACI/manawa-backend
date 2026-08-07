const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth, requireEmailVerified } = require('../middleware/auth');
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
router.post('/', requireAuth, requireEmailVerified, messageLimiter, async (req, res, next) => {
  try {
    const { receiverId, content } = req.body;
    if (!receiverId || !content || !content.trim()) {
      return res.status(400).json({ error: 'receiverId et content sont requis' });
    }

    // Vérifier que le destinataire existe et n'est pas suspendu
    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true, suspended: true, role: true },
    });
    if (!receiver) return res.status(404).json({ error: 'Destinataire introuvable' });
    if (receiver.suspended) return res.status(403).json({ error: 'Ce compte est suspendu' });

    // Un utilisateur ne peut envoyer un message qu'à quelqu'un avec qui il a une relation :
    // CLIENT → PROFESSIONAL : doit avoir un projet en commun (devis soumis ou accepté)
    // PROFESSIONAL → CLIENT : idem
    // Tout autre combinaison (CLIENT→CLIENT, etc.) est refusée
    const senderId = req.user.id;
    const senderRole = req.user.role;
    const receiverRole = receiver.role;

    if (senderRole !== 'ADMIN' && receiverRole !== 'ADMIN') {
      // Vérifier une relation via devis ou projet
      const clientId   = senderRole === 'CLIENT' ? senderId : receiverId;
      const proUserId  = senderRole === 'PROFESSIONAL' ? senderId : receiverId;

      if ((senderRole === 'CLIENT' && receiverRole !== 'PROFESSIONAL') ||
          (senderRole === 'PROFESSIONAL' && receiverRole !== 'CLIENT')) {
        return res.status(403).json({ error: 'Messagerie réservée aux échanges client-professionnel' });
      }

      const pro = await prisma.professional.findUnique({ where: { userId: proUserId }, select: { id: true } });
      if (!pro) return res.status(403).json({ error: 'Aucune relation avec ce professionnel' });

      const hasRelation = await prisma.quote.findFirst({
        where: {
          professionalId: pro.id,
          project: { clientId },
        },
        select: { id: true },
      });

      // Autoriser aussi si une conversation existe déjà (pour les suites d'échanges)
      const existingConversation = await prisma.message.findFirst({
        where: {
          OR: [
            { senderId, receiverId },
            { senderId: receiverId, receiverId: senderId },
          ],
        },
        select: { id: true },
      });

      if (!hasRelation && !existingConversation) {
        return res.status(403).json({ error: 'Vous ne pouvez contacter ce professionnel qu\'après avoir soumis un projet' });
      }
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
