const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { BADGES, computeBadges } = require('../utils/badges');

const router = express.Router();

/**
 * GET /api/badges/:proId
 * Public (optionalAuth) — retourne les badges d'un professionnel avec métadonnées.
 * Lance un recalcul non-bloquant en arrière-plan, puis retourne les badges existants.
 */
router.get('/:proId', optionalAuth, async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { id: req.params.proId },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Professionnel introuvable' });

    // Recalcul non-bloquant
    computeBadges(pro.id).catch(() => {});

    // Retourner les badges actuellement en base
    const badges = await prisma.professionalBadge.findMany({
      where: { professionalId: pro.id },
      orderBy: { earnedAt: 'asc' },
    });

    res.json(badges.map(b => ({ ...b, ...BADGES[b.badgeKey] })).filter(b => b.label));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/badges/compute
 * Authentifié (PROFESSIONAL) — force le recalcul et retourne les badges nouvellement débloqués.
 */
router.post('/compute', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Profil professionnel introuvable' });

    // Badges actuels avant recalcul
    const before = await prisma.professionalBadge.findMany({
      where: { professionalId: pro.id },
      select: { badgeKey: true },
    });
    const beforeKeys = new Set(before.map(b => b.badgeKey));

    // Recalcul complet
    const allBadges = await computeBadges(pro.id);

    // Nouvellement débloqués = présents après mais absents avant
    const newBadges = allBadges.filter(b => !beforeKeys.has(b.badgeKey));

    res.json({ badges: allBadges, newBadges });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
