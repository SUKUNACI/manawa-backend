const express = require('express');
const prisma = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { detectTokenType } = require('../config/pushNotifications');

const router = express.Router();

// POST /api/notifications/register-token — Register push token (FCM, APNs, or Expo)
router.post('/register-token', requireAuth, async (req, res, next) => {
  try {
    const { token, type, deviceId } = req.body;

    if (!token || token.trim() === '') {
      return res.status(400).json({ error: 'Token requis' });
    }

    // Auto-detect token type if not provided
    const detectedType = type || detectTokenType(token);

    if (!detectedType) {
      return res.status(400).json({ error: 'Format de token invalide' });
    }

    // Validate token format
    if (detectedType === 'EXPO' && !token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Token Expo invalide' });
    }

    if (detectedType === 'FCM' && token.length < 100) {
      return res.status(400).json({ error: 'Token FCM invalide' });
    }

    if (detectedType === 'APNs' && !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ error: 'Token APNs invalide' });
    }

    // Create or update push token
    const pushToken = await prisma.pushToken.upsert({
      where: { token },
      update: {
        userId: req.user.id,
        isActive: true,
        deviceId: deviceId || null,
        lastUsed: new Date(),
      },
      create: {
        userId: req.user.id,
        token,
        platform: detectedType === 'APNs' ? 'iOS' : 'Android',
        type: detectedType,
        deviceId: deviceId || null,
        isActive: true,
      },
    });

    // For backward compatibility, also store in user.expoPushToken if Expo token
    if (detectedType === 'EXPO') {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { expoPushToken: token },
      });
    }

    res.json({
      registered: true,
      token: pushToken.id,
      type: detectedType,
      message: `Token ${detectedType} enregistré avec succès`,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/unregister-token — Unregister all tokens (logout)
router.delete('/unregister-token', requireAuth, async (req, res, next) => {
  try {
    // Mark all tokens as inactive (don't delete, keep history)
    await prisma.pushToken.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false },
    });

    // Also clear legacy expoPushToken
    await prisma.user.update({
      where: { id: req.user.id },
      data: { expoPushToken: null },
    });

    res.json({
      unregistered: true,
      message: 'Tous les tokens ont été désactivés',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/tokens — List user's registered tokens (admin/debug)
router.get('/tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        platform: true,
        type: true,
        isActive: true,
        deviceId: true,
        lastUsed: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      tokens,
      total: tokens.length,
      active: tokens.filter(t => t.isActive).length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/history — List user's notifications
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 30);

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });

    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
