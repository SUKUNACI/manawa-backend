const express = require('express');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');
const { createVideoRoom, deleteVideoRoom } = require('../utils/daily');

const router = express.Router();

// POST /api/video-calls — initier un appel vidéo
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { participantId, projectId } = req.body;
    const initiatorId = req.user.id;

    if (!participantId) {
      return res.status(400).json({ error: 'participantId est requis' });
    }
    if (participantId === initiatorId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas appeler vous-même' });
    }

    // Vérifier que le participant existe
    const participant = await prisma.user.findUnique({
      where: { id: participantId },
      select: { id: true, firstName: true, lastName: true, suspended: true, deletedAt: true },
    });
    if (!participant || participant.deletedAt) {
      return res.status(404).json({ error: 'Participant introuvable' });
    }
    if (participant.suspended) {
      return res.status(403).json({ error: 'Ce compte est suspendu' });
    }

    // Vérifier que DAILY_API_KEY est configuré
    if (!process.env.DAILY_API_KEY) {
      return res.status(503).json({ error: 'Le service d\'appel vidéo n\'est pas configuré. Contactez l\'administrateur.' });
    }

    // Nom de room unique : mnw-{8 premiers chars d'un uuid}
    const roomName = `mnw-${uuidv4().replace(/-/g, '').substring(0, 8)}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1 heure

    // Créer la room Daily.co
    let roomData;
    try {
      roomData = await createVideoRoom(roomName, 60);
    } catch (err) {
      console.error('[VideoCall] Erreur création room Daily.co:', err.message);
      return res.status(502).json({ error: 'Impossible de créer la salle vidéo. Réessayez dans un instant.' });
    }

    if (!roomData || !roomData.url) {
      return res.status(502).json({ error: 'Réponse invalide du service vidéo.' });
    }

    const roomUrl = roomData.url;

    // Créer l'enregistrement en DB
    const videoCall = await prisma.videoCall.create({
      data: {
        roomName,
        roomUrl,
        initiatorId,
        participantId,
        status: 'PENDING',
        projectId: projectId || null,
        expiresAt,
      },
    });

    // Récupérer le nom de l'initiateur pour la notification
    const initiator = await prisma.user.findUnique({
      where: { id: initiatorId },
      select: { firstName: true, lastName: true },
    });
    const initiatorName = initiator ? `${initiator.firstName} ${initiator.lastName}` : 'Quelqu\'un';

    // Envoyer push notification au participant (fire-and-forget)
    sendPushNotification(
      participantId,
      `📹 Appel vidéo de ${initiatorName}`,
      'Rejoignez la consultation maintenant',
      { type: 'video_call', roomUrl, callId: videoCall.id }
    ).catch(err => console.error('[VideoCall] Erreur push notification:', err.message));

    return res.status(201).json({
      callId: videoCall.id,
      roomUrl,
      roomName,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/video-calls/active — appels actifs/pending du user (non expirés)
router.get('/active', requireAuth, async (req, res, next) => {
  try {
    const calls = await prisma.videoCall.findMany({
      where: {
        OR: [
          { initiatorId: req.user.id },
          { participantId: req.user.id },
        ],
        status: { in: ['PENDING', 'ACTIVE'] },
        expiresAt: { gt: new Date() },
      },
      include: {
        initiator: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        participant: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(calls);
  } catch (err) {
    next(err);
  }
});

// GET /api/video-calls/history — historique paginé
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    const [calls, total] = await Promise.all([
      prisma.videoCall.findMany({
        where: {
          OR: [
            { initiatorId: req.user.id },
            { participantId: req.user.id },
          ],
        },
        include: {
          initiator: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          participant: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.videoCall.count({
        where: {
          OR: [
            { initiatorId: req.user.id },
            { participantId: req.user.id },
          ],
        },
      }),
    ]);

    return res.json({
      calls,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/video-calls/:id/join — participant rejoint l'appel
router.patch('/:id/join', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const videoCall = await prisma.videoCall.findUnique({ where: { id } });
    if (!videoCall) {
      return res.status(404).json({ error: 'Appel introuvable' });
    }

    // Seul le participant peut rejoindre
    if (videoCall.participantId !== req.user.id) {
      return res.status(403).json({ error: 'Vous n\'êtes pas le participant de cet appel' });
    }

    if (videoCall.status === 'ENDED' || videoCall.status === 'MISSED') {
      return res.status(400).json({ error: 'Cet appel est terminé' });
    }

    if (new Date() > videoCall.expiresAt) {
      return res.status(400).json({ error: 'Cet appel a expiré' });
    }

    const updated = await prisma.videoCall.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        startedAt: videoCall.startedAt || new Date(),
      },
    });

    return res.json({ roomUrl: updated.roomUrl, callId: updated.id, status: updated.status });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/video-calls/:id/end — terminer l'appel
router.patch('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const videoCall = await prisma.videoCall.findUnique({ where: { id } });
    if (!videoCall) {
      return res.status(404).json({ error: 'Appel introuvable' });
    }

    // Initiateur ou participant peut terminer l'appel
    if (videoCall.initiatorId !== req.user.id && videoCall.participantId !== req.user.id) {
      return res.status(403).json({ error: 'Vous ne participez pas à cet appel' });
    }

    if (videoCall.status === 'ENDED') {
      return res.status(400).json({ error: 'Cet appel est déjà terminé' });
    }

    await prisma.videoCall.update({
      where: { id },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
      },
    });

    // Supprimer la room Daily.co en arrière-plan (fire-and-forget)
    deleteVideoRoom(videoCall.roomName).catch(err =>
      console.error('[VideoCall] Erreur suppression room Daily.co:', err.message)
    );

    return res.json({ success: true, message: 'Appel terminé' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
