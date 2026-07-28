const express = require('express');
const prisma = require('../config/db');
const upload = require('../config/upload');
const { verifyMagicBytes } = require('../config/upload');
const { uploadBuffer } = require('../config/cloudinary');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { computeTrustScore, getTrustScoreBreakdown } = require('../utils/trustScore');
const { isPremiumActive, isOnTrial, getActiveTier, getTierConfig, PREMIUM_PRICE_FCFA } = require('./subscriptions');

const router = express.Router();

function generateCompanyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MNW-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Champs utilisateur exposables publiquement — jamais de hash, codes OTP, tokens push
const PUBLIC_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  city: true,
  latitude: true,
  longitude: true,
  role: true,
  emailVerified: true,
  phoneVerified: true,
  suspended: true,
  createdAt: true,
};

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/professionals
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { trade, city, minRating, lat, lng } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    const pros = await prisma.professional.findMany({
      where: {
        OR: trade ? [{ trade }, { trades: { has: trade } }] : undefined,
        averageRating: minRating ? { gte: parseFloat(minRating) } : undefined,
        user: city ? { city } : undefined,
      },
      include: { user: { select: PUBLIC_USER_SELECT }, portfolio: true, subscription: true },
      orderBy: { averageRating: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });

    let result = pros;
    if (lat && lng) {
      result = pros
        .map((p) => ({
          ...p,
          distanceKm: p.user.latitude
            ? Math.round(distanceKm(parseFloat(lat), parseFloat(lng), p.user.latitude, p.user.longitude) * 10) / 10
            : null,
        }))
        .filter((p) => p.distanceKm === null || p.distanceKm <= p.interventionRadiusKm)
        .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    }

    const proIds = result.map(p => p.id);
    const [quoteCounts, quoteAcceptedCounts, badReviewCounts] = await Promise.all([
      prisma.quote.groupBy({ by: ['professionalId'], where: { professionalId: { in: proIds } }, _count: true }),
      prisma.quote.groupBy({ by: ['professionalId'], where: { professionalId: { in: proIds }, status: 'ACCEPTED' }, _count: true }),
      prisma.review.groupBy({ by: ['professionalId'], where: { professionalId: { in: proIds }, rating: { lt: 3 } }, _count: true }),
    ]);
    const qSentMap = Object.fromEntries(quoteCounts.map(q => [q.professionalId, q._count]));
    const qAccMap = Object.fromEntries(quoteAcceptedCounts.map(q => [q.professionalId, q._count]));
    const badRevMap = Object.fromEntries(badReviewCounts.map(q => [q.professionalId, q._count]));

    const TIER_PRIORITY = { ELITE: 3, PRO: 2, ESSENTIEL: 1, GRATUIT: 0 };
    const withScores = result.map((p) => {
      const extras = { quoteSentCount: qSentMap[p.id] || 0, quoteAcceptedCount: qAccMap[p.id] || 0, badReviewCount: badRevMap[p.id] || 0 };
      const activeTier = getActiveTier(p.subscription, p);
      return { ...p, trustScore: computeTrustScore(p, extras), isPremium: activeTier !== 'GRATUIT', tier: activeTier, isOnTrial: isOnTrial(p), subscription: undefined };
    });
    withScores.sort((a, b) => (TIER_PRIORITY[b.tier] - TIER_PRIORITY[a.tier]) || (b.averageRating - a.averageRating));

    res.json(withScores);
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/featured/random
router.get('/featured/random', optionalAuth, async (req, res, next) => {
  try {
    const premiumPros = await prisma.professional.findMany({
      where: { subscription: { status: 'ACTIVE', expiresAt: { gt: new Date() } } },
      include: { user: { select: PUBLIC_USER_SELECT }, portfolio: true },
    });

    const shuffled = premiumPros.sort(() => Math.random() - 0.5).slice(0, 5);
    res.json(shuffled.map((p) => ({ ...p, trustScore: computeTrustScore(p, {}), isPremium: true })));
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/trades (distinct trades from DB)
router.get('/trades', async (req, res, next) => {
  try {
    const pros = await prisma.professional.findMany({ select: { trades: true } });
    const allTrades = new Set();
    pros.forEach((p) => { if (p.trades) p.trades.forEach((t) => allTrades.add(t)); });
    const defaults = ['Maçon', 'Électricien', 'Plombier', 'Carreleur', 'Charpentier', 'Peintre', 'Couvreur', 'Climatisation', 'Étanchéité'];
    defaults.forEach((t) => allTrades.add(t));
    res.json([...allTrades].sort());
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/feed/portfolio
router.get('/feed/portfolio', optionalAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    const items = await prisma.portfolioItem.findMany({
      include: {
        professional: { include: { user: { select: { firstName: true, lastName: true } } } },
        likes: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });

    const result = items.map((item) => ({
      ...item,
      likeCount: item.likes.length,
      likedByMe: req.user ? item.likes.some((l) => l.userId === req.user.id) : false,
      likes: undefined,
    }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/professionals/me
router.patch('/me', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { trade, trades, companyName, siret, description, yearsExperience, hourlyRate, interventionRadiusKm, qualibatNumber } = req.body;

    const current = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } });
    const tier = getActiveTier(current.subscription, current);
    const tierCfg = getTierConfig(tier);

    const data = { trade, companyName, siret, description, hourlyRate, interventionRadiusKm, qualibatNumber };

    if (Array.isArray(trades)) {
      const maxTrades = tierCfg.maxTrades;
      if (trades.length > maxTrades) {
        return res.status(400).json({ error: `Votre abonnement ${tierCfg.label} vous permet jusqu'à ${maxTrades} métier(s). Passez à Pro ou Élite pour en ajouter jusqu'à 6.` });
      }
      data.trades = trades;
      data.trade = trades[0] || current.trade;
    }

    if (yearsExperience !== undefined && yearsExperience !== current.yearsExperience) {
      const cooldownDays = tier !== 'GRATUIT' ? 90 : 365;
      if (current.lastExperienceUpdate) {
        const daysSinceUpdate = (Date.now() - new Date(current.lastExperienceUpdate).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate < cooldownDays) {
          const daysLeft = Math.ceil(cooldownDays - daysSinceUpdate);
          return res.status(400).json({ error: `Vous pourrez modifier vos années d'expérience dans ${daysLeft} jour(s).${tier === 'GRATUIT' ? ' (Abonnement payant : tous les 3 mois au lieu d\'1 fois par an)' : ''}` });
        }
      }
      data.yearsExperience = yearsExperience;
      data.lastExperienceUpdate = new Date();
    }

    const pro = await prisma.professional.update({ where: { userId: req.user.id }, data });
    res.json(pro);
  } catch (err) {
    next(err);
  }
});

// POST /api/professionals/me/portfolio
router.post('/me/portfolio', requireAuth, requireRole('PROFESSIONAL'), upload.single('photo'), verifyMagicBytes, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo requise' });
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { portfolio: true, subscription: true } });



    const imageUrl = await uploadBuffer(req.file.buffer, 'manawa/portfolio');
    const item = await prisma.portfolioItem.create({
      data: { professionalId: pro.id, imageUrl, caption: req.body.caption || null },
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/professionals/me/portfolio/:itemId
router.delete('/me/portfolio/:itemId', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const item = await prisma.portfolioItem.findUnique({ where: { id: req.params.itemId } });

    if (!item || item.professionalId !== pro.id) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    await prisma.portfolioLike.deleteMany({ where: { portfolioItemId: req.params.itemId } });
    await prisma.portfolioItem.delete({ where: { id: req.params.itemId } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/professionals/portfolio/:itemId/like
router.post('/portfolio/:itemId/like', requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.portfolioLike.findUnique({
      where: { userId_portfolioItemId: { userId: req.user.id, portfolioItemId: req.params.itemId } },
    });

    if (existing) {
      await prisma.portfolioLike.delete({ where: { id: existing.id } });
      return res.json({ liked: false });
    }
    await prisma.portfolioLike.create({ data: { userId: req.user.id, portfolioItemId: req.params.itemId } });
    res.json({ liked: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/professionals/:id/follow
router.post('/:id/follow', requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.follow.findUnique({
      where: { followerId_professionalId: { followerId: req.user.id, professionalId: req.params.id } },
    });

    if (existing) {
      await prisma.follow.delete({ where: { id: existing.id } });
      return res.json({ following: false });
    }
    await prisma.follow.create({ data: { followerId: req.user.id, professionalId: req.params.id } });
    res.json({ following: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/me/followers
router.get('/me/followers', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const followers = await prisma.follow.findMany({
      where: { professionalId: pro.id },
      include: { follower: { select: { firstName: true, lastName: true, city: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(followers);
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/me/views
router.get('/me/views', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } });
    const views = await prisma.profileView.findMany({
      where: { professionalId: pro.id },
      include: { viewer: { select: { id: true, firstName: true, lastName: true, city: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const byViewer = new Map();
    for (const v of views) {
      if (!byViewer.has(v.viewer.id)) {
        byViewer.set(v.viewer.id, { viewer: v.viewer, lastViewedAt: v.createdAt, viewCount: 1 });
      } else {
        byViewer.get(v.viewer.id).viewCount += 1;
      }
    }

    const viewTier = getActiveTier(pro.subscription, pro);
    const tierHasStats = getTierConfig(viewTier).hasStats;
    const response = { totalViews: views.length, views: Array.from(byViewer.values()), isPremium: viewTier !== 'GRATUIT', canSeeVisitors: getTierConfig(viewTier).canSeeVisitors };

    if (tierHasStats) {
      const weeks = {};
      for (const v of views) {
        const weekStart = new Date(v.createdAt);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const key = weekStart.toISOString().slice(0, 10);
        weeks[key] = (weeks[key] || 0) + 1;
      }
      response.weeklyViews = Object.entries(weeks).sort().slice(-8).map(([week, count]) => ({ week, count }));

      const acceptedQuotesCount = await prisma.quote.count({ where: { professionalId: pro.id, status: 'ACCEPTED' } });
      response.conversionRate = views.length > 0 ? Math.round((acceptedQuotesCount / views.length) * 1000) / 10 : 0;
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /api/professionals/me/documents
router.post('/me/documents', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { decennaleDocUrl } = req.body;
    const pro = await prisma.professional.update({
      where: { userId: req.user.id },
      data: { decennaleDocUrl, verifiedByAdmin: false },
    });
    res.json(pro);
  } catch (err) {
    next(err);
  }
});

// POST /api/professionals/me/verification
router.post(
  '/me/verification',
  requireAuth,
  requireRole('PROFESSIONAL'),
  upload.fields([{ name: 'idDocumentRecto', maxCount: 1 }, { name: 'idDocumentVerso', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const existing = await prisma.professional.findUnique({ where: { userId: req.user.id }, select: { identityStatus: true } });
      if (existing && existing.identityStatus === 'PENDING') {
        return res.status(400).json({ error: "Votre demande de vérification est déjà en cours d'examen. Veuillez patienter." });
      }
      if (existing && existing.identityStatus === 'APPROVED') {
        return res.status(400).json({ error: "Votre identité est déjà vérifiée." });
      }

      if (!req.files?.idDocumentRecto || !req.files?.idDocumentVerso || !req.files?.selfie) {
        return res.status(400).json({ error: "La pièce d'identité (recto et verso) et le selfie sont tous requis" });
      }
      const [idDocumentUrl, idDocumentVersoUrl, selfieUrl] = await Promise.all([
        uploadBuffer(req.files.idDocumentRecto[0].buffer, 'manawa/verification'),
        uploadBuffer(req.files.idDocumentVerso[0].buffer, 'manawa/verification'),
        uploadBuffer(req.files.selfie[0].buffer, 'manawa/verification'),
      ]);
      const pro = await prisma.professional.update({
        where: { userId: req.user.id },
        data: { idDocumentUrl, idDocumentVersoUrl, selfieUrl, identityStatus: 'PENDING', identityRejectionReason: null },
      });
      res.json(pro);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/professionals/me/status
router.get('/me/status', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    res.json({
      identityStatus: pro.identityStatus,
      verifiedByAdmin: pro.verifiedByAdmin,
      identityRejectionReason: pro.identityRejectionReason || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/professionals/me/company-code
router.get('/me/company-code', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    if (pro.accountType !== 'ENTREPRISE') return res.status(403).json({ error: 'Réservé aux comptes Entreprise' });

    let code = pro.companyCode;
    if (!code) {
      let unique = false;
      while (!unique) {
        code = generateCompanyCode();
        const exists = await prisma.professional.findUnique({ where: { companyCode: code } });
        if (!exists) unique = true;
      }
      await prisma.professional.update({ where: { id: pro.id }, data: { companyCode: code } });
    }
    res.json({ companyCode: code });
  } catch (err) { next(err); }
});

// POST /api/professionals/me/join-company
router.post('/me/join-company', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { companyCode } = req.body;
    if (!companyCode) return res.status(400).json({ error: 'Code entreprise requis' });

    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      include: { memberOf: true },
    });
    if (pro.accountType !== 'INDEPENDENT') return res.status(403).json({ error: 'Seuls les indépendants peuvent rejoindre une entreprise' });
    if (pro.memberOf) return res.status(400).json({ error: "Vous êtes déjà membre d'une entreprise" });

    const company = await prisma.professional.findUnique({ where: { companyCode: companyCode.trim().toUpperCase() } });
    if (!company) return res.status(404).json({ error: 'Code entreprise invalide' });
    if (company.accountType !== 'ENTREPRISE') return res.status(400).json({ error: 'Ce code ne correspond pas à un compte entreprise' });
    if (company.id === pro.id) return res.status(400).json({ error: 'Vous ne pouvez pas rejoindre votre propre entreprise' });

    const membership = await prisma.companyMember.create({
      data: { companyId: company.id, memberId: pro.id },
    });
    res.status(201).json({ membership, companyName: company.companyName || company.trade });
  } catch (err) { next(err); }
});

// GET /api/professionals/me/company-members
router.get('/me/company-members', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    if (pro.accountType !== 'ENTREPRISE') return res.status(403).json({ error: 'Réservé aux comptes Entreprise' });

    const members = await prisma.companyMember.findMany({
      where: { companyId: pro.id, status: 'ACTIVE' },
      include: {
        member: {
          include: { user: { select: { firstName: true, lastName: true, city: true, avatarUrl: true, phoneVerified: true } }, portfolio: true, subscription: true },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const result = members.map((m) => {
      const score = computeTrustScore(m.member, {});
      return { ...m, memberScore: score, isQualified: score >= 60 };
    });

    const qualifiedCount = result.filter(r => r.isQualified).length;
    const qualityRate = result.length > 0 ? qualifiedCount / result.length : 0;

    res.json({
      members: result,
      stats: {
        total: result.length,
        qualified: qualifiedCount,
        qualityRate: Math.round(qualityRate * 100),
        meetsThreshold: qualityRate >= 0.8,
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/professionals/me/company-members/:memberId
router.delete('/me/company-members/:memberId', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    if (pro.accountType !== 'ENTREPRISE') return res.status(403).json({ error: 'Réservé aux comptes Entreprise' });

    const membership = await prisma.companyMember.findFirst({
      where: { companyId: pro.id, memberId: req.params.memberId },
    });
    if (!membership) return res.status(404).json({ error: 'Membre introuvable' });

    await prisma.companyMember.delete({ where: { id: membership.id } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// DELETE /api/professionals/me/leave-company
router.delete('/me/leave-company', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { memberOf: true } });
    if (!pro.memberOf) return res.status(400).json({ error: "Vous n'êtes membre d'aucune entreprise" });
    await prisma.companyMember.delete({ where: { id: pro.memberOf.id } });
    res.json({ left: true });
  } catch (err) { next(err); }
});

// GET /api/professionals/:id (GÉNÉRIQUE - DOIT ÊTRE À LA FIN)
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, city: true, avatarUrl: true, phoneVerified: true, emailVerified: true, createdAt: true } },
        portfolio: { include: { likes: true } },
        reviews: { include: { author: { select: { firstName: true, lastName: true } } } },
        followers: true,
        subscription: true,
        memberOf: { include: { company: { select: { companyName: true, trade: true } } } },
      },
    });
    if (!pro) return res.status(404).json({ error: 'Professionnel introuvable' });

    if (req.user && req.user.id !== pro.userId) {
      prisma.profileView.create({ data: { viewerId: req.user.id, professionalId: pro.id } }).catch(() => {});
    }

    const isFollowing = req.user ? pro.followers.some((f) => f.followerId === req.user.id) : false;
    const portfolio = pro.portfolio.map((item) => ({
      ...item,
      likeCount: item.likes.length,
      likedByMe: req.user ? item.likes.some((l) => l.userId === req.user.id) : false,
      likes: undefined,
    }));

    const [quoteSentCount, quoteAcceptedCount, badReviewCount, goodReviewCount] = await Promise.all([
      prisma.quote.count({ where: { professionalId: pro.id } }),
      prisma.quote.count({ where: { professionalId: pro.id, status: 'ACCEPTED' } }),
      prisma.review.count({ where: { professionalId: pro.id, rating: { lt: 3 } } }),
      prisma.review.count({ where: { professionalId: pro.id, rating: { gte: 4 } } }),
    ]);
    const extras = { quoteSentCount, quoteAcceptedCount, badReviewCount, goodReviewCount };

    if (pro.accountType === 'ENTREPRISE') {
      const members = await prisma.companyMember.findMany({
        where: { companyId: pro.id, status: 'ACTIVE' },
        include: { member: { include: { user: { select: PUBLIC_USER_SELECT }, portfolio: true } } },
      });
      if (members.length > 0) {
        const memberScores = members.map(m => computeTrustScore(m.member, {}));
        const qualifiedCount = memberScores.filter(s => s >= 60).length;
        extras.memberQualityRate = qualifiedCount / members.length;
        extras.memberCount = members.length;
      }
    }

    const activeTier = getActiveTier(pro.subscription, pro);
    res.json({ ...pro, portfolio, isFollowing, followerCount: pro.followers.length, followers: undefined, trustScore: computeTrustScore(pro, extras), trustScoreBreakdown: getTrustScoreBreakdown(pro, extras), isPremium: activeTier !== 'GRATUIT', tier: activeTier, isOnTrial: isOnTrial(pro), trialEndsAt: pro.trialEndsAt, subscription: undefined });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
