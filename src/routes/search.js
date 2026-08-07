const express = require('express');
const prisma = require('../config/db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;

function clampLimit(raw) {
  const n = parseInt(raw) || DEFAULT_LIMIT;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}

function clampPage(raw) {
  return Math.max(1, parseInt(raw) || 1);
}

// ---------------------------------------------------------------------------
// Recherche pros
// ---------------------------------------------------------------------------

async function searchProfessionals(q, { skip = 0, take = DEFAULT_LIMIT } = {}) {
  return prisma.professional.findMany({
    where: {
      user: { deletedAt: null },
      OR: [
        { user: { firstName: { contains: q, mode: 'insensitive' } } },
        { user: { lastName: { contains: q, mode: 'insensitive' } } },
        { trade: { contains: q, mode: 'insensitive' } },
        { trades: { has: q } },
        { description: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { user: { city: { contains: q, mode: 'insensitive' } } },
      ],
    },
    select: {
      id: true,
      userId: true,
      trade: true,
      trades: true,
      companyName: true,
      averageRating: true,
      reviewCount: true,
      verifiedByAdmin: true,
      user: {
        select: {
          firstName: true,
          lastName: true,
          avatarUrl: true,
          city: true,
        },
      },
      subscription: {
        select: { tier: true },
      },
    },
    skip,
    take,
  });
}

async function countProfessionals(q) {
  return prisma.professional.count({
    where: {
      user: { deletedAt: null },
      OR: [
        { user: { firstName: { contains: q, mode: 'insensitive' } } },
        { user: { lastName: { contains: q, mode: 'insensitive' } } },
        { trade: { contains: q, mode: 'insensitive' } },
        { trades: { has: q } },
        { description: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { user: { city: { contains: q, mode: 'insensitive' } } },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Recherche réalisations (portfolio)
// ---------------------------------------------------------------------------

async function searchPortfolio(q, { skip = 0, take = DEFAULT_LIMIT } = {}) {
  return prisma.portfolioProject.findMany({
    where: {
      professional: { user: { deletedAt: null } },
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tradeCategory: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      tradeCategory: true,
      images: {
        select: { imageUrl: true },
        orderBy: { sortOrder: 'asc' },
        take: 3,
      },
      professional: {
        select: {
          id: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
    skip,
    take,
  });
}

async function countPortfolio(q) {
  return prisma.portfolioProject.count({
    where: {
      professional: { user: { deletedAt: null } },
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tradeCategory: { contains: q, mode: 'insensitive' } },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Recherche forfaits
// ---------------------------------------------------------------------------

async function searchPackages(q, { skip = 0, take = DEFAULT_LIMIT } = {}) {
  return prisma.servicePackage.findMany({
    where: {
      active: true,
      professional: { user: { deletedAt: null } },
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      price: true,
      duration: true,
      category: true,
      images: true,
      ordersCount: true,
      professional: {
        select: {
          id: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
    skip,
    take,
  });
}

async function countPackages(q) {
  return prisma.servicePackage.count({
    where: {
      active: true,
      professional: { user: { deletedAt: null } },
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Historique — helpers AppConfig
// ---------------------------------------------------------------------------

const HISTORY_SIZE = 10;

function historyKey(userId) {
  return `search_history_${userId}`;
}

async function getHistory(userId) {
  const row = await prisma.appConfig.findUnique({ where: { key: historyKey(userId) } });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(userId, q) {
  const key = historyKey(userId);
  const existing = await getHistory(userId);
  // Dédoublonner + mettre le nouveau terme en tête
  const updated = [q, ...existing.filter(t => t !== q)].slice(0, HISTORY_SIZE);
  await prisma.appConfig.upsert({
    where: { key },
    create: { key, value: JSON.stringify(updated), description: `Historique recherches utilisateur ${userId}` },
    update: { value: JSON.stringify(updated) },
  });
  return updated;
}

async function clearHistory(userId) {
  const key = historyKey(userId);
  await prisma.appConfig.deleteMany({ where: { key } });
}

// ---------------------------------------------------------------------------
// GET /api/search?q=&type=&page=&limit=
// ---------------------------------------------------------------------------
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { q, type = 'all', page, limit } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Le terme de recherche doit contenir au moins 2 caractères' });
    }

    const term = q.trim();
    const validTypes = ['all', 'professionals', 'portfolio', 'packages'];

    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type invalide. Valeurs acceptées : ${validTypes.join(', ')}` });
    }

    const take = clampLimit(limit);
    const pageNum = clampPage(page);
    const skip = (pageNum - 1) * take;

    if (type === 'all') {
      // Recherche parallèle dans les 3 entités — pas de pagination, juste les N premiers
      const [professionals, portfolio, packages] = await Promise.all([
        searchProfessionals(term, { skip: 0, take }),
        searchPortfolio(term, { skip: 0, take }),
        searchPackages(term, { skip: 0, take }),
      ]);

      return res.json({
        query: term,
        professionals,
        portfolio,
        packages,
        total: professionals.length + portfolio.length + packages.length,
      });
    }

    if (type === 'professionals') {
      const [results, total] = await Promise.all([
        searchProfessionals(term, { skip, take }),
        countProfessionals(term),
      ]);
      return res.json({
        query: term,
        professionals: results,
        pagination: {
          page: pageNum,
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
        },
      });
    }

    if (type === 'portfolio') {
      const [results, total] = await Promise.all([
        searchPortfolio(term, { skip, take }),
        countPortfolio(term),
      ]);
      return res.json({
        query: term,
        portfolio: results,
        pagination: {
          page: pageNum,
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
        },
      });
    }

    if (type === 'packages') {
      const [results, total] = await Promise.all([
        searchPackages(term, { skip, take }),
        countPackages(term),
      ]);
      return res.json({
        query: term,
        packages: results,
        pagination: {
          page: pageNum,
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
        },
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/search/history — enregistre une recherche (si user connecté)
// ---------------------------------------------------------------------------
router.post('/history', optionalAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentification requise pour sauvegarder l\'historique' });
    }

    const { q } = req.body;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Le terme de recherche doit contenir au moins 2 caractères' });
    }

    const history = await saveHistory(req.user.id, q.trim());
    res.json({ success: true, history });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/search/history — retourne l'historique
// ---------------------------------------------------------------------------
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const history = await getHistory(req.user.id);
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/search/history — vide l'historique
// ---------------------------------------------------------------------------
router.delete('/history', requireAuth, async (req, res, next) => {
  try {
    await clearHistory(req.user.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
