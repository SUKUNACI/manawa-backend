const express = require('express');
const prisma = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_TYPES = ['REVIEW', 'COMMENT', 'PORTFOLIO'];
const VALID_REASONS = [
  'Contenu offensant ou inapproprié',
  'Harcèlement ou menace',
  'Faux avis ou commentaire trompeur',
  'Spam ou publicité non sollicitée',
  'Contenu sexuellement explicite',
  'Violation de la vie privée',
  'Autre',
];

// POST /api/reports — signaler un contenu
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { contentType, contentId, reason, details } = req.body;

    if (!VALID_TYPES.includes(contentType)) {
      return res.status(400).json({ error: 'Type de contenu invalide' });
    }
    if (!contentId) return res.status(400).json({ error: 'contentId requis' });
    if (!reason) return res.status(400).json({ error: 'Raison requise' });

    // Vérifier que le contenu existe
    let exists = false;
    if (contentType === 'REVIEW') {
      exists = !!(await prisma.review.findUnique({ where: { id: contentId } }));
    } else if (contentType === 'COMMENT') {
      exists = !!(await prisma.portfolioComment.findUnique({ where: { id: contentId } }));
    } else if (contentType === 'PORTFOLIO') {
      exists = !!(await prisma.portfolioProject.findUnique({ where: { id: contentId } }));
    }
    if (!exists) return res.status(404).json({ error: 'Contenu introuvable' });

    // Éviter les doublons (même reporter, même contenu)
    const existing = await prisma.contentReport.findFirst({
      where: { reporterId: req.user.id, contentType, contentId, status: 'PENDING' },
    });
    if (existing) return res.status(409).json({ error: 'Vous avez déjà signalé ce contenu' });

    const report = await prisma.contentReport.create({
      data: {
        reporterId: req.user.id,
        contentType,
        contentId,
        reason,
        details: details || null,
      },
    });

    res.status(201).json({ success: true, reportId: report.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/reasons — liste des raisons disponibles
router.get('/reasons', requireAuth, (req, res) => {
  res.json(VALID_REASONS);
});

module.exports = router;
