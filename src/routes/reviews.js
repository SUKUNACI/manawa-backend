const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// 10 avis max par heure par utilisateur
const createReviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop d\'avis postés, réessayez dans une heure' },
});

// POST /api/reviews
router.post('/', requireAuth, requireRole('CLIENT'), createReviewLimiter, async (req, res, next) => {
  try {
    const { professionalId, rating, comment, projectId } = req.body;

    if (!professionalId || !rating) {
      return res.status(400).json({ error: 'professionalId et rating sont requis' });
    }
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: 'La note doit être un entier entre 1 et 5' });
    }

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { review: true } });
      if (!project || project.clientId !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
      if (project.status !== 'COMPLETED') return res.status(400).json({ error: 'La mission doit être terminée pour laisser un avis' });
      if (project.review) return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cette mission' });
    }

    const review = await prisma.review.create({
      data: { authorId: req.user.id, professionalId, rating, comment, projectId: projectId || undefined },
    });

    const agg = await prisma.review.aggregate({
      where: { professionalId },
      _avg: { rating: true },
      _count: true,
    });
    await prisma.professional.update({
      where: { id: professionalId },
      data: { averageRating: agg._avg.rating || 0, reviewCount: agg._count },
    });

    res.status(201).json(review);
  } catch (err) {
    next(err);
  }
});

// GET /api/reviews/professional/:id
router.get('/professional/:id', requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    const reviews = await prisma.review.findMany({
      where: { professionalId: req.params.id },
      include: { author: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });
    res.json(reviews);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
