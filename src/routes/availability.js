const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Validate result and send 400 if any error */
function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0].msg });
    return false;
  }
  return true;
}

/** Parse "HH:MM" → minutes since midnight */
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** True if two [start,end) intervals overlap */
function intervalsOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

/** dayOfWeek number for a given Date (UTC) */
function utcDayOfWeek(date) {
  return new Date(date).getUTCDay();
}

// ─── GET /api/availability/:proId ─────────────────────────────────────────────
// Public — retourne les créneaux récurrents + exceptions d'un pro
router.get(
  '/:proId',
  optionalAuth,
  [param('proId').isUUID().withMessage('proId invalide')],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;
      const { proId } = req.params;

      const professional = await prisma.professional.findUnique({
        where: { id: proId },
        select: { id: true },
      });
      if (!professional) return res.status(404).json({ error: 'Professionnel introuvable' });

      const slots = await prisma.availabilitySlot.findMany({
        where: { professionalId: proId },
        orderBy: [{ type: 'asc' }, { dayOfWeek: 'asc' }, { date: 'asc' }],
      });

      res.json({ slots });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/availability/slots ──────────────────────────────────────────────
// Pro only — remplace tous les créneaux récurrents
router.put(
  '/slots',
  requireAuth,
  requireRole('PROFESSIONAL'),
  [
    body('slots').isArray().withMessage('slots doit être un tableau'),
    body('slots.*.dayOfWeek')
      .isInt({ min: 0, max: 6 })
      .withMessage('dayOfWeek doit être compris entre 0 et 6'),
    body('slots.*.startTime')
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('startTime doit être au format HH:MM'),
    body('slots.*.endTime')
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('endTime doit être au format HH:MM'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const professional = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!professional) return res.status(403).json({ error: 'Profil professionnel introuvable' });

      const { slots } = req.body;

      // Validate time logic: startTime < endTime
      for (const slot of slots) {
        if (timeToMinutes(slot.startTime) >= timeToMinutes(slot.endTime)) {
          return res
            .status(400)
            .json({ error: `startTime doit être avant endTime (jour ${slot.dayOfWeek})` });
        }
      }

      // Transaction: delete old RECURRING, create new ones
      const result = await prisma.$transaction(async (tx) => {
        await tx.availabilitySlot.deleteMany({
          where: { professionalId: professional.id, type: 'RECURRING' },
        });

        if (slots.length === 0) return [];

        const created = await tx.availabilitySlot.createMany({
          data: slots.map((s) => ({
            professionalId: professional.id,
            type: 'RECURRING',
            dayOfWeek: s.dayOfWeek,
            startTime: s.startTime,
            endTime: s.endTime,
          })),
        });

        return created;
      });

      // Return fresh list
      const updated = await prisma.availabilitySlot.findMany({
        where: { professionalId: professional.id, type: 'RECURRING' },
        orderBy: [{ dayOfWeek: 'asc' }],
      });

      res.json({ slots: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/availability/exception ─────────────────────────────────────────
// Pro only — crée une exception ponctuelle
router.post(
  '/exception',
  requireAuth,
  requireRole('PROFESSIONAL'),
  [
    body('date').isISO8601().withMessage('date doit être une date ISO 8601 valide'),
    body('available')
      .isBoolean()
      .withMessage('available doit être un booléen'),
    body('note').optional().isString().isLength({ max: 500 }).withMessage('note max 500 chars'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const professional = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!professional) return res.status(403).json({ error: 'Profil professionnel introuvable' });

      const { date, available, note } = req.body;

      const exception = await prisma.availabilitySlot.create({
        data: {
          professionalId: professional.id,
          type: 'EXCEPTION',
          date: new Date(date),
          available: Boolean(available),
          note: note || null,
        },
      });

      res.status(201).json({ exception });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/availability/exception/:id ────────────────────────────────────
// Pro only — supprime une exception
router.delete(
  '/exception/:id',
  requireAuth,
  requireRole('PROFESSIONAL'),
  [param('id').isUUID().withMessage('id invalide')],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const professional = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!professional) return res.status(403).json({ error: 'Profil professionnel introuvable' });

      const slot = await prisma.availabilitySlot.findUnique({
        where: { id: req.params.id },
      });

      if (!slot) return res.status(404).json({ error: 'Exception introuvable' });
      if (slot.professionalId !== professional.id)
        return res.status(403).json({ error: 'Accès refusé' });
      if (slot.type !== 'EXCEPTION')
        return res.status(400).json({ error: 'Ce créneau n\'est pas une exception' });

      await prisma.availabilitySlot.delete({ where: { id: req.params.id } });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/availability/:proId/bookings ────────────────────────────────────
// Public — créneaux occupés (sans données client) pour un mois donné
router.get(
  '/:proId/bookings',
  optionalAuth,
  [
    param('proId').isUUID().withMessage('proId invalide'),
    query('month')
      .optional()
      .matches(/^\d{4}-\d{2}$/)
      .withMessage('month doit être au format YYYY-MM'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;
      const { proId } = req.params;

      const professional = await prisma.professional.findUnique({
        where: { id: proId },
        select: { id: true },
      });
      if (!professional) return res.status(404).json({ error: 'Professionnel introuvable' });

      let dateFilter = {};
      if (req.query.month) {
        const [year, month] = req.query.month.split('-').map(Number);
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month, 1));
        dateFilter = { gte: start, lt: end };
      }

      const bookings = await prisma.booking.findMany({
        where: {
          professionalId: proId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          ...(req.query.month ? { date: dateFilter } : {}),
        },
        select: {
          id: true,
          date: true,
          startTime: true,
          endTime: true,
          status: true,
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      });

      res.json({ bookings });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/availability/bookings ──────────────────────────────────────────
// Authentifié — créer une réservation
router.post(
  '/bookings',
  requireAuth,
  [
    body('professionalId').isUUID().withMessage('professionalId invalide'),
    body('date').isISO8601().withMessage('date doit être une date ISO 8601 valide'),
    body('startTime')
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('startTime doit être au format HH:MM'),
    body('endTime')
      .matches(/^\d{2}:\d{2}$/)
      .withMessage('endTime doit être au format HH:MM'),
    body('note').optional().isString().isLength({ max: 1000 }).withMessage('note max 1000 chars'),
    body('projectId').optional().isUUID().withMessage('projectId invalide'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const { professionalId, date, startTime, endTime, note, projectId } = req.body;

      // startTime < endTime
      if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
        return res.status(400).json({ error: 'startTime doit être avant endTime' });
      }

      // Pas dans le passé
      const bookingDate = new Date(date);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if (bookingDate < today) {
        return res.status(400).json({ error: 'Impossible de réserver dans le passé' });
      }

      // Le pro ne peut pas se booker lui-même
      const professional = await prisma.professional.findUnique({
        where: { id: professionalId },
        select: { id: true, userId: true },
      });
      if (!professional) return res.status(404).json({ error: 'Professionnel introuvable' });
      if (professional.userId === req.user.id) {
        return res.status(403).json({ error: 'Un professionnel ne peut pas se réserver lui-même' });
      }

      // Vérifier que le project appartient au client si fourni
      if (projectId) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, clientId: true },
        });
        if (!project) return res.status(404).json({ error: 'Projet introuvable' });
        if (project.clientId !== req.user.id) {
          return res.status(403).json({ error: 'Ce projet ne vous appartient pas' });
        }
      }

      // 1) Vérifier exception indisponible ce jour-là
      const dayStart = new Date(date);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setUTCHours(23, 59, 59, 999);

      const exception = await prisma.availabilitySlot.findFirst({
        where: {
          professionalId,
          type: 'EXCEPTION',
          available: false,
          date: { gte: dayStart, lte: dayEnd },
        },
      });
      if (exception) {
        return res
          .status(409)
          .json({ error: 'Le professionnel est indisponible ce jour-là' });
      }

      // 2) Vérifier que le créneau est dans un slot récurrent ce jour
      const dow = utcDayOfWeek(bookingDate);
      const recurringSlots = await prisma.availabilitySlot.findMany({
        where: {
          professionalId,
          type: 'RECURRING',
          dayOfWeek: dow,
        },
      });

      const reqStart = timeToMinutes(startTime);
      const reqEnd = timeToMinutes(endTime);

      const coveredBySlot = recurringSlots.some((s) => {
        const sStart = timeToMinutes(s.startTime);
        const sEnd = timeToMinutes(s.endTime);
        return reqStart >= sStart && reqEnd <= sEnd;
      });

      if (!coveredBySlot) {
        return res.status(409).json({
          error: 'Ce créneau ne correspond à aucune disponibilité du professionnel ce jour',
        });
      }

      // 3) Vérifier chevauchement avec bookings existants
      const overlapping = await prisma.booking.findFirst({
        where: {
          professionalId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          date: { gte: dayStart, lte: dayEnd },
        },
      });

      if (overlapping) {
        const existStart = timeToMinutes(overlapping.startTime);
        const existEnd = timeToMinutes(overlapping.endTime);
        if (intervalsOverlap(reqStart, reqEnd, existStart, existEnd)) {
          return res.status(409).json({ error: 'Ce créneau est déjà occupé' });
        }
      }

      // Créer la réservation
      const booking = await prisma.booking.create({
        data: {
          professionalId,
          clientId: req.user.id,
          date: new Date(date),
          startTime,
          endTime,
          note: note || null,
          projectId: projectId || null,
          status: 'PENDING',
        },
        include: {
          professional: {
            include: { user: { select: { id: true, firstName: true, lastName: true } } },
          },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      // Push notification au pro
      const clientName = `${booking.client.firstName} ${booking.client.lastName}`;
      await sendPushNotification(
        professional.userId,
        'Nouvelle demande de réservation',
        `${clientName} souhaite vous réserver le ${new Date(date).toLocaleDateString('fr-FR')} de ${startTime} à ${endTime}`,
        { type: 'new_booking', bookingId: booking.id }
      );

      res.status(201).json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/availability/my-bookings ────────────────────────────────────────
// Authentifié — mes réservations (client ou pro)
router.get('/my-bookings', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    let where = {};

    if (req.user.role === 'PROFESSIONAL') {
      const professional = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!professional) return res.status(403).json({ error: 'Profil professionnel introuvable' });
      where = { professionalId: professional.id };
    } else {
      where = { clientId: req.user.id };
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include: {
          professional: {
            include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
          },
          client: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          project: { select: { id: true, title: true } },
        },
        orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({
      bookings,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/availability/bookings/:id/confirm ─────────────────────────────
// Pro confirme une réservation
router.patch(
  '/bookings/:id/confirm',
  requireAuth,
  requireRole('PROFESSIONAL'),
  [param('id').isUUID().withMessage('id invalide')],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const professional = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        select: { id: true },
      });
      if (!professional) return res.status(403).json({ error: 'Profil professionnel introuvable' });

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { client: { select: { id: true, firstName: true, lastName: true } } },
      });

      if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
      if (booking.professionalId !== professional.id)
        return res.status(403).json({ error: 'Accès refusé' });
      if (booking.status !== 'PENDING')
        return res.status(409).json({ error: `La réservation est déjà au statut ${booking.status}` });

      const updated = await prisma.booking.update({
        where: { id: req.params.id },
        data: { status: 'CONFIRMED' },
        include: {
          professional: {
            include: { user: { select: { id: true, firstName: true, lastName: true } } },
          },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      // Notifier le client
      await sendPushNotification(
        booking.clientId,
        'Réservation confirmée',
        `Votre réservation du ${new Date(booking.date).toLocaleDateString('fr-FR')} de ${booking.startTime} à ${booking.endTime} a été confirmée.`,
        { type: 'booking_confirmed', bookingId: booking.id }
      );

      res.json({ booking: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /api/availability/bookings/:id/cancel ──────────────────────────────
// Client ou pro annule une réservation
router.patch(
  '/bookings/:id/cancel',
  requireAuth,
  [
    param('id').isUUID().withMessage('id invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('reason max 500 chars'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          professional: { select: { id: true, userId: true } },
          client: { select: { id: true } },
        },
      });

      if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });

      // Vérifier que l'utilisateur est le client ou le pro de cette réservation
      const isClient = booking.clientId === req.user.id;
      const isPro = booking.professional.userId === req.user.id;
      if (!isClient && !isPro) {
        return res.status(403).json({ error: 'Accès refusé' });
      }

      if (booking.status === 'CANCELLED') {
        return res.status(409).json({ error: 'Cette réservation est déjà annulée' });
      }
      if (booking.status === 'COMPLETED') {
        return res.status(409).json({ error: 'Impossible d\'annuler une réservation terminée' });
      }

      const updated = await prisma.booking.update({
        where: { id: req.params.id },
        data: {
          status: 'CANCELLED',
          cancelReason: req.body.reason || null,
          cancelledBy: req.user.id,
        },
        include: {
          professional: {
            include: { user: { select: { id: true, firstName: true, lastName: true } } },
          },
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      // Notifier l'autre partie
      const notifyUserId = isClient ? booking.professional.userId : booking.clientId;
      const cancellerName = isClient
        ? `${updated.client.firstName} ${updated.client.lastName}`
        : `${updated.professional.user.firstName} ${updated.professional.user.lastName}`;

      await sendPushNotification(
        notifyUserId,
        'Réservation annulée',
        `${cancellerName} a annulé la réservation du ${new Date(booking.date).toLocaleDateString('fr-FR')} de ${booking.startTime} à ${booking.endTime}.`,
        { type: 'booking_cancelled', bookingId: booking.id }
      );

      res.json({ booking: updated });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
