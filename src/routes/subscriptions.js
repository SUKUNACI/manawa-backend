const express = require('express');
const axios = require('axios');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const CINETPAY_API_URL = 'https://api-checkout.cinetpay.com/v2/payment';
const CINETPAY_CHECK_URL = 'https://api-checkout.cinetpay.com/v2/payment/check';
const isCinetPayConfigured = !!(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID);

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

function getTierConfig(tier) {
  return TIERS[tier] || TIERS.GRATUIT;
}

// GET /api/subscriptions/me
router.get('/me', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } });
    const tier = getActiveTier(pro.subscription, pro);
    const tierConfig = getTierConfig(tier);
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
        price: t.price,
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

// POST /api/subscriptions/checkout
router.post('/checkout', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { tier = 'ESSENTIEL' } = req.body;
    const tierConfig = TIERS[tier];
    if (!tierConfig || tier === 'GRATUIT') {
      return res.status(400).json({ error: 'Tier invalide' });
    }

    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const transactionId = `sub-${tier.toLowerCase()}-${pro.id}-${Date.now()}`;

    if (!isCinetPayConfigured) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.subscription.upsert({
        where: { professionalId: pro.id },
        create: { professionalId: pro.id, tier, status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
        update: { tier, status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
      });
      return res.json({ devMode: true, activated: true, tier, expiresAt });
    }

    const { data } = await axios.post(CINETPAY_API_URL, {
      apikey: process.env.CINETPAY_API_KEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: transactionId,
      amount: tierConfig.price,
      currency: 'XOF',
      description: `Abonnement ${tierConfig.label} MANAWA - 1 mois`,
      notify_url: `${process.env.BACKEND_PUBLIC_URL}/api/subscriptions/notify`,
      return_url: `${process.env.BACKEND_PUBLIC_URL}/api/subscriptions/return`,
      channels: 'MOBILE_MONEY',
      customer_name: req.user.email,
    });

    if (data.code !== '201') return res.status(400).json({ error: data.message || 'Erreur lors de la création du paiement' });

    await prisma.subscription.upsert({
      where: { professionalId: pro.id },
      create: { professionalId: pro.id, tier, status: 'INACTIVE', transactionId },
      update: { tier, transactionId },
    });

    res.json({ devMode: false, paymentUrl: data.data.payment_url });
  } catch (err) {
    if (err.response) {
      console.error(err.response.data);
      return res.status(500).json({ error: 'Impossible de contacter le service de paiement' });
    }
    next(err);
  }
});

// POST /api/subscriptions/notify
router.post('/notify', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const transactionId = req.body.cpm_trans_id;
    if (!transactionId) return res.sendStatus(400);

    const { data } = await axios.post(CINETPAY_CHECK_URL, {
      apikey: process.env.CINETPAY_API_KEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: transactionId,
    });

    if (data.data?.status === 'ACCEPTED') {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.subscription.updateMany({
        where: { transactionId },
        data: { status: 'ACTIVE', startedAt: new Date(), expiresAt },
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

router.get('/return', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:80px;"><h2>Abonnement traité</h2><p>Vous pouvez retourner sur l'application.</p></body></html>`);
});

module.exports = router;
module.exports.isPremiumActive = isPremiumActive;
module.exports.isOnTrial = isOnTrial;
module.exports.getActiveTier = getActiveTier;
module.exports.getTierConfig = getTierConfig;
module.exports.TIERS = TIERS;
module.exports.PREMIUM_PRICE_FCFA = 5000;
