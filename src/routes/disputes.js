const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// POST /api/disputes — ouvrir un litige sur un paiement
router.post('/', requireAuth, requireRole('CLIENT'), async (req, res, next) => {
  try {
    const { paymentId, reason, description } = req.body;

    if (!paymentId || !reason) {
      return res.status(400).json({ error: 'paymentId et reason sont requis' });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        quote: {
          include: {
            project: { select: { clientId: true, title: true } },
            professional: {
              include: { user: { select: { id: true, firstName: true, lastName: true } } },
            },
          },
        },
      },
    });

    if (!payment) {
      return res.status(404).json({ error: 'Paiement introuvable' });
    }

    if (payment.quote.project.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Ce paiement ne vous appartient pas' });
    }

    if (payment.status !== 'succeeded') {
      return res.status(400).json({ error: 'Un litige ne peut être ouvert que sur un paiement confirmé' });
    }

    const existing = await prisma.dispute.findFirst({
      where: { paymentId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    });
    if (existing) {
      return res.status(409).json({ error: 'Un litige est déjà ouvert sur ce paiement' });
    }

    const dispute = await prisma.dispute.create({
      data: {
        paymentId,
        clientId: req.user.id,
        reason,
        description: description || null,
        status: 'OPEN',
      },
    });

    // Notifier le pro
    const pro = payment.quote.professional;
    const proTokens = await prisma.pushToken.findMany({ where: { userId: pro.user.id } });
    if (proTokens.length > 0) {
      await sendPushNotification(
        proTokens.map(t => t.token),
        'Litige ouvert',
        `Un litige a été ouvert sur le projet "${payment.quote.project.title}"`,
        { type: 'DISPUTE_OPENED', disputeId: dispute.id }
      );
    }

    res.status(201).json(dispute);
  } catch (err) {
    next(err);
  }
});

// GET /api/disputes/mine — litiges du client connecté
router.get('/mine', requireAuth, requireRole('CLIENT'), async (req, res, next) => {
  try {
    const disputes = await prisma.dispute.findMany({
      where: { clientId: req.user.id },
      include: {
        payment: {
          include: {
            quote: {
              include: {
                project: { select: { title: true } },
                professional: {
                  include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(disputes);
  } catch (err) {
    next(err);
  }
});

// GET /api/disputes/:id — détail d'un litige
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    let whereClause = { id: req.params.id };
    if (role === 'CLIENT') {
      whereClause.clientId = userId;
    } else if (role === 'PROFESSIONAL') {
      whereClause.payment = { quote: { professional: { userId } } };
    } else if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const dispute = await prisma.dispute.findFirst({
      where: whereClause,
      include: {
        payment: {
          include: {
            quote: {
              include: {
                project: { select: { title: true, clientId: true } },
                professional: {
                  include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
                },
              },
            },
          },
        },
        client: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });

    if (!dispute) return res.status(404).json({ error: 'Litige introuvable' });

    res.json(dispute);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
