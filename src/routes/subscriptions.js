const express = require('express');
const crypto = require('crypto');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const geniuspay = require('../utils/geniuspay');
const { sendPushNotification } = require('../config/pushNotifications');
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

    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      include: { user: true },
    });

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

    // Abonnement gratuit (code promo 100%) : activation directe
    if (finalAmount === 0) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const transactionId = `sub-free-${tier.toLowerCase()}-${pro.id}-${Date.now()}`;
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
              finalAmount: 0,
            },
          }),
          prisma.promoCode.update({ where: { id: promoData.promo.id }, data: { usedCount: { increment: 1 } } }),
        ]);
      }
      return res.json({ activated: true, tier, expiresAt, discount: promoData ? promoData.discountAmount : 0, finalAmount: 0 });
    }

    // Paiement réel via GeniusPay
    const idempotencyKey = crypto.randomUUID();
    const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000';
    const successUrl = `${base}/api/subscriptions/success?proId=${pro.id}&tier=${tier}&ikey=${idempotencyKey}`;
    const errorUrl = `${base}/api/subscriptions/error?proId=${pro.id}&tier=${tier}`;

    const paymentResult = await geniuspay.createPayment({
      amount: finalAmount,
      description: `Abonnement MANAWA ${TIERS[tier].label} — 1 mois`,
      customerName: `${pro.user.firstName} ${pro.user.lastName}`,
      customerEmail: pro.user.email,
      customerPhone: pro.user.phone || '',
      quoteId: null,
      projectId: null,
      isDeposit: false,
      userId: req.user.id,
      idempotencyKey,
      successUrl,
      errorUrl,
    });

    const paymentData = paymentResult.data || paymentResult;
    const geniuspayRef = paymentData.reference;
    const paymentUrl = paymentData.checkout_url || paymentData.payment_url || paymentData.checkoutUrl;

    // Enregistrer la souscription en attente de paiement
    await prisma.subscription.upsert({
      where: { professionalId: pro.id },
      create: {
        professionalId: pro.id,
        tier,
        status: 'PENDING_PAYMENT',
        transactionId: geniuspayRef,
        startedAt: null,
        expiresAt: null,
      },
      update: {
        tier,
        status: 'PENDING_PAYMENT',
        transactionId: geniuspayRef,
        startedAt: null,
        expiresAt: null,
      },
    });

    // Stocker le code promo en attente pour l'appliquer après confirmation
    if (promoData) {
      await prisma.appConfig.upsert({
        where: { key: `pending_promo_${geniuspayRef}` },
        create: {
          key: `pending_promo_${geniuspayRef}`,
          value: JSON.stringify({
            promoCodeId: promoData.promo.id,
            professionalId: pro.id,
            tier,
            originalAmount: tierConfig.price,
            discountAmount: promoData.discountAmount,
            finalAmount,
          }),
        },
        update: {
          value: JSON.stringify({
            promoCodeId: promoData.promo.id,
            professionalId: pro.id,
            tier,
            originalAmount: tierConfig.price,
            discountAmount: promoData.discountAmount,
            finalAmount,
          }),
        },
      });
    }

    return res.json({
      paymentUrl,
      reference: geniuspayRef,
      tier,
      finalAmount,
      discount: promoData ? promoData.discountAmount : 0,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Subscription] checkout error:', JSON.stringify(detail));
    // Erreur GeniusPay → message lisible au lieu de 500 générique
    if (err.response?.status === 401 || err.response?.data?.error?.code === 'INVALID_API_KEY') {
      return res.status(503).json({ error: 'Service de paiement temporairement indisponible. Veuillez réessayer plus tard.' });
    }
    if (err.response?.data?.error?.message) {
      return res.status(502).json({ error: err.response.data.error.message });
    }
    next(err);
  }
});

// GET /api/subscriptions/success — callback GeniusPay (redirect deep link)
router.get('/success', async (req, res) => {
  const { proId, tier, ikey } = req.query;
  const deepLink = `manawa://subscription/success?tier=${encodeURIComponent(tier || '')}`;
  const deepLinkEncoded = deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.send(`
    <html>
      <head>
        <title>Abonnement activé</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px 24px; background: #0A0D14; color: #fff; }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h2 { color: #22C55E; font-size: 24px; margin-bottom: 8px; }
          p { color: #9CA3AF; font-size: 15px; line-height: 1.5; }
          .btn { display: inline-block; margin-top: 32px; background: #F4720B; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-size: 16px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="icon">✅</div>
        <h2>Abonnement activé !</h2>
        <p>Votre paiement a été confirmé.<br>Retour automatique sur MANAWA...</p>
        <a class="btn" href="${deepLinkEncoded}">Retourner sur MANAWA</a>
        <script>
          var dl = document.querySelector('.btn').getAttribute('href');
          window.onload = function() { window.location.href = dl; };
        </script>
      </body>
    </html>
  `);
});

// GET /api/subscriptions/error — callback GeniusPay échec
router.get('/error', async (req, res) => {
  const { tier } = req.query;
  const deepLink = `manawa://subscription/error?tier=${encodeURIComponent(tier || '')}`;
  const deepLinkEncoded = deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.send(`
    <html>
      <head>
        <title>Paiement échoué</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px 24px; background: #0A0D14; color: #fff; }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h2 { color: #EF4444; font-size: 24px; margin-bottom: 8px; }
          p { color: #9CA3AF; font-size: 15px; line-height: 1.5; }
          .btn { display: inline-block; margin-top: 32px; background: #F4720B; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-size: 16px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="icon">❌</div>
        <h2>Paiement échoué</h2>
        <p>Une erreur s'est produite.<br>Retour automatique sur MANAWA...</p>
        <a class="btn" href="${deepLinkEncoded}">Retourner sur MANAWA</a>
        <script>
          var dl = document.querySelector('.btn').getAttribute('href');
          window.onload = function() { window.location.href = dl; };
        </script>
      </body>
    </html>
  `);
});


module.exports = router;
module.exports.isPremiumActive = isPremiumActive;
module.exports.isOnTrial = isOnTrial;
module.exports.getActiveTier = getActiveTier;
module.exports.getTierConfig = getTierConfig;
module.exports.TIERS = TIERS;
module.exports.PREMIUM_PRICE_FCFA = 5000;
