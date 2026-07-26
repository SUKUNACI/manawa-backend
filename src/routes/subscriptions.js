const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const { getConfig } = require('../utils/appConfig');

const router = express.Router();

const TIERS = {
  GRATUIT: {
    label: 'Gratuit',
    price: 0,
    color: 'muted',
    icon: 'user',
    maxTrades: 3,
    maxQuotesPerMonth: 5,
    searchPriority: false,
    canSeeVisitors: false,
    hasStats: false,
    radiusLimitKm: 30,
    projectsDelayMs: 60 * 60 * 1000,
    earlyNotifications: false,
    featuredOnHome: false,
    badge: null,
    benefits: [
      { icon: 'image', text: 'Portfolio illimité', color: 'blue' },
      { icon: 'file-text', text: '5 devis / mois', color: 'orange' },
      { icon: 'briefcase', text: '3 métiers', color: 'orange' },
    ],
  },
  ESSENTIEL: {
    label: 'Essentiel',
    price: 2500,
    color: 'blue',
    icon: 'award',
    maxTrades: 3,
    maxQuotesPerMonth: 20,
    searchPriority: false,
    canSeeVisitors: false,
    hasStats: false,
    radiusLimitKm: 30,
    projectsDelayMs: 0,
    earlyNotifications: false,
    featuredOnHome: false,
    badge: 'Essentiel',
    benefits: [
      { icon: 'image', text: 'Portfolio illimité', color: 'blue' },
      { icon: 'file-text', text: '20 devis / mois', color: 'blue' },
      { icon: 'briefcase', text: '3 métiers', color: 'blue' },
      { icon: 'clock', text: 'Accès projets immédiat', color: 'blue' },
      { icon: 'award', text: 'Badge Essentiel', color: 'blue' },
    ],
  },
  PRO: {
    label: 'Pro',
    price: 5000,
    color: 'orange',
    icon: 'trending-up',
    maxTrades: 6,
    maxQuotesPerMonth: null,
    searchPriority: true,
    canSeeVisitors: true,
    hasStats: true,
    radiusLimitKm: null,
    projectsDelayMs: 0,
    earlyNotifications: false,
    featuredOnHome: false,
    badge: 'Pro',
    benefits: [
      { icon: 'image', text: 'Portfolio illimité', color: 'orange' },
      { icon: 'file-text', text: 'Devis illimités', color: 'orange' },
      { icon: 'briefcase', text: '6 métiers', color: 'orange' },
      { icon: 'trending-up', text: 'Priorité dans la recherche', color: 'orange' },
      { icon: 'eye', text: 'Voir vos visiteurs', color: 'orange' },
      { icon: 'bar-chart-2', text: 'Statistiques avancées', color: 'orange' },
      { icon: 'map-pin', text: "Rayon d'intervention illimité", color: 'orange' },
      { icon: 'award', text: 'Badge Pro', color: 'orange' },
    ],
  },
  ELITE: {
    label: 'Élite',
    price: 10000,
    color: 'gold',
    icon: 'star',
    maxTrades: 6,
    maxQuotesPerMonth: null,
    searchPriority: true,
    canSeeVisitors: true,
    hasStats: true,
    radiusLimitKm: null,
    projectsDelayMs: 0,
    earlyNotifications: true,
    featuredOnHome: true,
    badge: '⭐ Élite',
    benefits: [
      { icon: 'image', text: 'Portfolio illimité', color: 'gold' },
      { icon: 'file-text', text: 'Devis illimités', color: 'gold' },
      { icon: 'briefcase', text: '6 métiers', color: 'gold' },
      { icon: 'trending-up', text: 'Priorité dans la recherche', color: 'gold' },
      { icon: 'eye', text: 'Voir vos visiteurs', color: 'gold' },
      { icon: 'bar-chart-2', text: 'Statistiques avancées', color: 'gold' },
      { icon: 'map-pin', text: "Rayon d'intervention illimité", color: 'gold' },
      { icon: 'bell', text: 'Notifications 2h en avance', color: 'gold' },
      { icon: 'home', text: 'Mise en avant mensuelle accueil', color: 'gold' },
      { icon: 'star', text: 'Badge ⭐ Élite', color: 'gold' },
    ],
  },
};

function getActiveTier(subscription, pro) {
  const trialActive = !!pro?.trialEndsAt && new Date(pro.trialEndsAt) > new Date();
  const paidActive = !!subscription && subscription.status === 'ACTIVE' && subscription.expiresAt && new Date(subscription.expiresAt) > new Date();

  if (trialActive) return 'PRO';
  if (paidActive) return subscription.tier || 'ESSENTIEL';
  return 'GRATUIT';
}

function isPremiumActive(subscription, pro) {
  return getActiveTier(subscription, pro) !== 'GRATUIT';
}

function isOnTrial(pro) {
  return !!pro?.trialEndsAt && new Date(pro.trialEndsAt) > new Date();
}

function getTierConfig(tier, prices) {
  const base = TIERS[tier] || TIERS.GRATUIT;
  if (!prices) return base;
  // Override avec les prix dynamiques si fournis
  const priceMap = { ESSENTIEL: prices.essentiel, PRO: prices.pro, ELITE: prices.elite };
  if (priceMap[tier] !== undefined) return { ...base, price: priceMap[tier] };
  return base;
}

async function getDynamicPrices() {
  const [essentiel, pro, elite] = await Promise.all([
    getConfig('price_essentiel'),
    getConfig('price_pro'),
    getConfig('price_elite'),
  ]);
  return {
    essentiel: essentiel ?? 2500,
    pro: pro ?? 5000,
    elite: elite ?? 10000,
  };
}

// GET /api/subscriptions/me
router.get('/me', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const [pro, prices] = await Promise.all([
      prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } }),
      getDynamicPrices(),
    ]);
    const tier = getActiveTier(pro.subscription, pro);
    const tierConfig = getTierConfig(tier, prices);
    const onTrial = isOnTrial(pro);
    const trialDaysLeft = onTrial ? Math.max(0, Math.ceil((new Date(pro.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24))) : null;

    res.json({
      isPremium: tier !== 'GRATUIT',
      isOnTrial: onTrial,
      tier,
      trialEndsAt: pro.trialEndsAt || null,
      trialDaysLeft,
      status: pro.subscription?.status || 'INACTIVE',
      expiresAt: pro.subscription?.expiresAt || null,
      price: tierConfig.price,
      benefits: tierConfig.benefits,
      tierConfig,
      plans: Object.entries(TIERS).filter(([key]) => key !== 'GRATUIT').map(([key, t]) => ({
        key,
        label: t.label,
        price: getTierConfig(key, prices).price,
        color: t.color,
        icon: t.icon,
        benefits: t.benefits,
        badge: t.badge,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Calculer le montant après promo
function applyPromo(promo, baseAmount) {
  if (!promo) return { discountAmount: 0, finalAmount: baseAmount };
  let discountAmount = promo.discountType === 'PERCENT'
    ? Math.round(baseAmount * promo.discountValue / 100)
    : Math.min(promo.discountValue, baseAmount);
  const finalAmount = Math.max(0, baseAmount - discountAmount);
  return { discountAmount, finalAmount };
}

// Valider un code promo sans l'appliquer
async function validatePromoForCheckout(code, tier, proId) {
  const now = new Date();
  const promo = await prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
  if (!promo) return { valid: false, error: 'Code promo invalide' };
  if (!promo.active) return { valid: false, error: 'Code promo désactivé' };
  if (promo.validUntil && promo.validUntil < now) return { valid: false, error: 'Code promo expiré' };
  if (promo.validFrom > now) return { valid: false, error: 'Code promo pas encore actif' };
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return { valid: false, error: 'Code promo épuisé' };
  if (promo.applicableTiers.length > 0 && !promo.applicableTiers.includes(tier)) {
    return { valid: false, error: `Code promo non applicable au plan ${tier}` };
  }
  const alreadyUsed = await prisma.promoUsage.findUnique({ where: { promoCodeId_professionalId: { promoCodeId: promo.id, professionalId: proId } } });
  if (alreadyUsed) return { valid: false, error: 'Vous avez déjà utilisé ce code promo' };
  return { valid: true, promo };
}

// POST /api/subscriptions/validate-promo
router.post('/validate-promo', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { code, tier = 'ESSENTIEL' } = req.body;
    if (!code) return res.status(400).json({ error: 'Code requis' });
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    const result = await validatePromoForCheckout(code, tier, pro.id);
    if (!result.valid) return res.status(400).json({ error: result.error });

    const prices = await getDynamicPrices();
    const tierConfig = getTierConfig(tier, prices);
    const { discountAmount, finalAmount } = applyPromo(result.promo, tierConfig.price);

    res.json({
      valid: true,
      code: result.promo.code,
      description: result.promo.description,
      discountType: result.promo.discountType,
      discountValue: result.promo.discountValue,
      originalAmount: tierConfig.price,
      discountAmount,
      finalAmount,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/checkout
router.post('/checkout', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { tier = 'ESSENTIEL', promoCode } = req.body;
    if (!TIERS[tier] || tier === 'GRATUIT') {
      return res.status(400).json({ error: 'Tier invalide' });
    }
    const prices = await getDynamicPrices();
    const tierConfig = getTierConfig(tier, prices);

    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const transactionId = `sub-${tier.toLowerCase()}-${pro.id}-${Date.now()}`;

    // Valider et appliquer le code promo si fourni
    let promoData = null;
    let finalAmount = tierConfig.price;
    if (promoCode) {
      const promoResult = await validatePromoForCheckout(promoCode, tier, pro.id);
      if (!promoResult.valid) return res.status(400).json({ error: promoResult.error });
      const applied = applyPromo(promoResult.promo, tierConfig.price);
      promoData = { promo: promoResult.promo, ...applied };
      finalAmount = applied.finalAmount;
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.subscription.upsert({
      where: { professionalId: pro.id },
      create: { professionalId: pro.id, tier, status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
      update: { tier, status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
    });
    if (promoData) {
      await prisma.$transaction([
        prisma.promoUsage.create({
          data: {
            promoCodeId: promoData.promo.id,
            professionalId: pro.id,
            tier,
            originalAmount: tierConfig.price,
            discountAmount: promoData.discountAmount,
            finalAmount: promoData.finalAmount,
          },
        }),
        prisma.promoCode.update({ where: { id: promoData.promo.id }, data: { usedCount: { increment: 1 } } }),
      ]);
    }
    return res.json({ activated: true, tier, expiresAt, discount: promoData ? promoData.discountAmount : 0, finalAmount });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
module.exports.isPremiumActive = isPremiumActive;
module.exports.isOnTrial = isOnTrial;
module.exports.getActiveTier = getActiveTier;
module.exports.getTierConfig = getTierConfig;
module.exports.TIERS = TIERS;
module.exports.PREMIUM_PRICE_FCFA = 5000;
