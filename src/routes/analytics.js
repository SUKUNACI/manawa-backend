const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeTrustScore } = require('../utils/trustScore');
const { getActiveTier } = require('./subscriptions');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper : vérifie que le pro a un abonnement Premium (PRO / ELITE / TRIAL)
// Retourne l'objet `pro` en cas de succès, ou écrit la réponse et retourne null.
// ---------------------------------------------------------------------------
async function requirePremium(req, res) {
  const pro = await prisma.professional.findUnique({
    where: { userId: req.user.id },
    include: { subscription: true, user: true },
  });
  if (!pro) {
    res.status(404).json({ error: 'Profil pro introuvable' });
    return null;
  }
  const tier =
    pro.subscription?.status === 'ACTIVE'
      ? pro.subscription.tier
      : pro.trialEndsAt > new Date()
      ? 'TRIAL'
      : 'GRATUIT';
  if (!['PRO', 'ELITE', 'TRIAL'].includes(tier)) {
    res.status(403).json({
      error: 'Fonctionnalité réservée aux abonnés Premium',
      upgrade: true,
    });
    return null;
  }
  return pro;
}

// ---------------------------------------------------------------------------
// GET /api/analytics/overview  (tous les pros)
// Métriques de base : vues, devis, missions, revenus, note, followers,
// trustScore, badges.
// ---------------------------------------------------------------------------
router.get(
  '/overview',
  requireAuth,
  requireRole('PROFESSIONAL'),
  async (req, res, next) => {
    try {
      const pro = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        include: {
          user: true,
          subscription: true,
          portfolio: true,
          followers: true,
          badges: true,
          quotes: { select: { id: true, status: true } },
        },
      });
      if (!pro) return res.status(404).json({ error: 'Profil pro introuvable' });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Vues profil
      const [totalViews, last30Views] = await Promise.all([
        prisma.profileView.count({ where: { professionalId: pro.id } }),
        prisma.profileView.count({
          where: { professionalId: pro.id, createdAt: { gte: thirtyDaysAgo } },
        }),
      ]);

      // Trend vues : compare les 30j précédents (30–60j) vs les 30j courants
      const prev30Start = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const prev30Views = await prisma.profileView.count({
        where: {
          professionalId: pro.id,
          createdAt: { gte: prev30Start, lt: thirtyDaysAgo },
        },
      });
      let trendStr = '+0%';
      if (prev30Views === 0 && last30Views > 0) {
        trendStr = '+100%';
      } else if (prev30Views > 0) {
        const delta = ((last30Views - prev30Views) / prev30Views) * 100;
        trendStr = (delta >= 0 ? '+' : '') + delta.toFixed(0) + '%';
      }

      // Devis
      const quoteSent = pro.quotes.length;
      const quoteAccepted = pro.quotes.filter((q) => q.status === 'ACCEPTED').length;
      const acceptRate =
        quoteSent > 0 ? ((quoteAccepted / quoteSent) * 100).toFixed(1) + '%' : '0%';

      // Missions
      const completedMissions = pro.completedMissionsCount;
      const cancelledMissions = pro.cancelledMissionsCount;
      const totalMissions = completedMissions + cancelledMissions;
      const completionRate =
        totalMissions > 0
          ? ((completedMissions / totalMissions) * 100).toFixed(1) + '%'
          : '0%';

      // Revenus via Payment → Quote → Professional
      const revenueRows = await prisma.$queryRaw`
        SELECT COALESCE(SUM(p.amount), 0)::float AS total,
               COALESCE(SUM(CASE WHEN p."createdAt" >= ${thirtyDaysAgo} THEN p.amount ELSE 0 END), 0)::float AS last30
        FROM "Payment" p
        JOIN "Quote"  q ON q.id = p."quoteId"
        WHERE q."professionalId" = ${pro.id}
          AND p.status = 'succeeded'
      `;
      const revenueTotal = Number(revenueRows[0]?.total ?? 0);
      const revenueLast30 = Number(revenueRows[0]?.last30 ?? 0);

      // Trust score (calculé à la volée)
      const extras = {
        quoteSentCount: quoteSent,
        quoteAcceptedCount: quoteAccepted,
        badReviewCount: 0, // non utilisé ici, trustScore le recalcule
      };
      const trustScore = computeTrustScore(pro, extras);

      res.json({
        profileViews: {
          total: totalViews,
          last30Days: last30Views,
          trend: trendStr,
        },
        quotes: {
          sent: quoteSent,
          accepted: quoteAccepted,
          acceptRate,
        },
        missions: {
          completed: completedMissions,
          cancelled: cancelledMissions,
          completionRate,
        },
        revenue: {
          total: revenueTotal,
          last30Days: revenueLast30,
          currency: 'XOF',
        },
        rating: {
          average: pro.averageRating,
          count: pro.reviewCount,
        },
        followers: pro.followers.length,
        trustScore,
        badges: pro.badges.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/analytics/views  [PREMIUM]
// Évolution des vues profil sur 30 jours (groupé par jour).
// ---------------------------------------------------------------------------
router.get(
  '/views',
  requireAuth,
  requireRole('PROFESSIONAL'),
  async (req, res, next) => {
    try {
      const pro = await requirePremium(req, res);
      if (!pro) return;

      const rows = await prisma.$queryRaw`
        SELECT DATE("createdAt") AS date, COUNT(*)::int AS count
        FROM "ProfileView"
        WHERE "professionalId" = ${pro.id}
          AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `;

      const days = rows.map((r) => ({
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
        count: Number(r.count),
      }));

      const peakDay =
        days.length > 0
          ? days.reduce((a, b) => (b.count > a.count ? b : a)).date
          : null;

      res.json({
        days,
        peakDay,
        topSources: [],
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/analytics/revenue  [PREMIUM]
// Revenus mensuels sur 12 mois.
// ---------------------------------------------------------------------------
router.get(
  '/revenue',
  requireAuth,
  requireRole('PROFESSIONAL'),
  async (req, res, next) => {
    try {
      const pro = await requirePremium(req, res);
      if (!pro) return;

      const rows = await prisma.$queryRaw`
        SELECT TO_CHAR(DATE_TRUNC('month', p."createdAt"), 'YYYY-MM') AS month,
               SUM(p.amount)::float AS amount
        FROM "Payment" p
        JOIN "Quote"   q ON q.id = p."quoteId"
        WHERE q."professionalId" = ${pro.id}
          AND p.status = 'succeeded'
          AND p."createdAt" >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', p."createdAt")
        ORDER BY DATE_TRUNC('month', p."createdAt") ASC
      `;

      // Construire un tableau complet des 12 derniers mois (même si certains ont 0)
      const monthMap = {};
      for (const r of rows) {
        monthMap[r.month] = Number(r.amount);
      }

      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().slice(0, 7); // 'YYYY-MM'
        months.push({ month: key, amount: monthMap[key] ?? 0 });
      }

      const total12Months = months.reduce((s, m) => s + m.amount, 0);
      const bestMonthEntry =
        months.length > 0
          ? months.reduce((a, b) => (b.amount > a.amount ? b : a))
          : null;
      const completedMissions = pro.completedMissionsCount;
      const averagePerMission =
        completedMissions > 0
          ? Math.round(total12Months / completedMissions)
          : 0;

      res.json({
        months,
        total12Months,
        bestMonth: bestMonthEntry?.month ?? null,
        averagePerMission,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/analytics/quotes  [PREMIUM]
// Analyse des devis : répartition par statut, taux d'acceptation sur 30j,
// délai de réponse moyen, top métiers.
// ---------------------------------------------------------------------------
router.get(
  '/quotes',
  requireAuth,
  requireRole('PROFESSIONAL'),
  async (req, res, next) => {
    try {
      const pro = await requirePremium(req, res);
      if (!pro) return;

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Tous les devis du pro
      const allQuotes = await prisma.quote.findMany({
        where: { professionalId: pro.id },
        select: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          project: { select: { tradeNeeded: true } },
        },
      });

      // Répartition par statut
      const byStatus = { PENDING: 0, ACCEPTED: 0, REFUSED: 0, EXPIRED: 0 };
      for (const q of allQuotes) {
        if (byStatus[q.status] !== undefined) byStatus[q.status]++;
      }

      // Taux d'acceptation sur les 30 derniers jours
      const last30Quotes = allQuotes.filter(
        (q) => new Date(q.createdAt) >= thirtyDaysAgo
      );
      const last30Total = last30Quotes.length;
      const last30Accepted = last30Quotes.filter(
        (q) => q.status === 'ACCEPTED'
      ).length;
      const acceptRateLast30Days =
        last30Total > 0
          ? ((last30Accepted / last30Total) * 100).toFixed(1) + '%'
          : '0%';

      // Délai de réponse moyen (entre createdAt et updatedAt pour les ACCEPTED/REFUSED)
      const responded = allQuotes.filter(
        (q) => q.status === 'ACCEPTED' || q.status === 'REFUSED'
      );
      let avgResponseTimeHours = 0;
      if (responded.length > 0) {
        const totalMs = responded.reduce(
          (sum, q) => sum + (new Date(q.updatedAt) - new Date(q.createdAt)),
          0
        );
        avgResponseTimeHours =
          Math.round((totalMs / responded.length / (1000 * 60 * 60)) * 10) / 10;
      }

      // Top métiers (from associated projects)
      const tradeCounts = {};
      for (const q of allQuotes) {
        const trade = q.project?.tradeNeeded;
        if (trade) tradeCounts[trade] = (tradeCounts[trade] || 0) + 1;
      }
      const topTrades = Object.entries(tradeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t]) => t);

      res.json({
        byStatus,
        acceptRateLast30Days,
        avgResponseTimeHours,
        topTrades,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/analytics/competitors  [ELITE seulement]
// Comparaison anonymisée avec les pros du même métier.
// ---------------------------------------------------------------------------
router.get(
  '/competitors',
  requireAuth,
  requireRole('PROFESSIONAL'),
  async (req, res, next) => {
    try {
      // Charger le pro courant avec les données nécessaires
      const pro = await prisma.professional.findUnique({
        where: { userId: req.user.id },
        include: { subscription: true, user: true, portfolio: true, badges: true },
      });
      if (!pro) return res.status(404).json({ error: 'Profil pro introuvable' });

      // ELITE uniquement
      const activeTier = getActiveTier(pro.subscription, pro);
      if (activeTier !== 'ELITE') {
        return res.status(403).json({
          error: 'Fonctionnalité réservée aux abonnés Élite',
          upgrade: true,
        });
      }

      // Tous les pros du même métier (trade principal)
      const peers = await prisma.professional.findMany({
        where: {
          OR: [{ trade: pro.trade }, { trades: { has: pro.trade } }],
          id: { not: pro.id },
        },
        include: {
          user: true,
          subscription: true,
          portfolio: true,
          badges: true,
        },
      });

      if (peers.length === 0) {
        return res.json({
          trade: pro.trade,
          myRank: { rating: 1, missions: 1, trustScore: 1 },
          tradeStats: {
            avgRating: pro.averageRating,
            avgMissions: pro.completedMissionsCount,
            avgTrustScore: computeTrustScore(pro, {}),
            totalPros: 1,
          },
        });
      }

      // Calcul stats pros du même métier (incluant le pro courant dans les stats agrégées)
      const allPros = [pro, ...peers];
      const allTrustScores = allPros.map((p) => computeTrustScore(p, {}));
      const allRatings = allPros.map((p) => p.averageRating);
      const allMissions = allPros.map((p) => p.completedMissionsCount);

      const avg = (arr) =>
        arr.length > 0
          ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10
          : 0;

      const avgRating = avg(allRatings);
      const avgMissions = avg(allMissions);
      const avgTrustScore = avg(allTrustScores);

      // Rang du pro courant parmi tous les pros du métier (1 = meilleur)
      const myTrustScore = computeTrustScore(pro, {});

      const rankByRating =
        allPros
          .map((p) => p.averageRating)
          .sort((a, b) => b - a)
          .indexOf(pro.averageRating) + 1;

      const rankByMissions =
        allPros
          .map((p) => p.completedMissionsCount)
          .sort((a, b) => b - a)
          .indexOf(pro.completedMissionsCount) + 1;

      const trustScoresSorted = allPros
        .map((p) => computeTrustScore(p, {}))
        .sort((a, b) => b - a);
      const rankByTrust = trustScoresSorted.indexOf(myTrustScore) + 1;

      res.json({
        trade: pro.trade,
        myRank: {
          rating: rankByRating,
          missions: rankByMissions,
          trustScore: rankByTrust,
        },
        tradeStats: {
          avgRating,
          avgMissions,
          avgTrustScore,
          totalPros: allPros.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
