const express = require('express');
const axios = require('axios');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const CINETPAY_API_URL = 'https://api-checkout.cinetpay.com/v2/payment';
const CINETPAY_CHECK_URL = 'https://api-checkout.cinetpay.com/v2/payment/check';
const PREMIUM_PRICE_FCFA = 5000;
const isCinetPayConfigured = !!(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID);

function isPremiumActive(subscription, pro) {
  const paidPremium = !!subscription && subscription.status === 'ACTIVE' && subscription.expiresAt && new Date(subscription.expiresAt) > new Date();
  const trialActive = !!pro?.trialEndsAt && new Date(pro.trialEndsAt) > new Date();
  return paidPremium || trialActive;
}

function isOnTrial(pro) {
  return !!pro?.trialEndsAt && new Date(pro.trialEndsAt) > new Date();
}

const PREMIUM_BENEFITS = [
  { icon: 'award', text: 'Badge Premium visible sur votre profil', color: 'gold' },
  { icon: 'trending-up', text: 'Priorité dans les résultats de recherche', color: 'orange' },
  { icon: 'image', text: 'Portfolio illimité (au lieu de 6 photos)', color: 'blue' },
  { icon: 'bar-chart-2', text: 'Statistiques avancées (vues par semaine, taux de conversion)', color: 'purple' },
];

// GET /api/subscriptions/me
router.get('/me', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } });
    res.json({
      isPremium: isPremiumActive(pro.subscription, pro),
      isOnTrial: isOnTrial(pro),
      trialEndsAt: pro.trialEndsAt || null,
      status: pro.subscription?.status || 'INACTIVE',
      expiresAt: pro.subscription?.expiresAt || null,
      price: PREMIUM_PRICE_FCFA,
      benefits: PREMIUM_BENEFITS,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/checkout
router.post('/checkout', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const transactionId = `premium-${pro.id}-${Date.now()}`;

    if (!isCinetPayConfigured) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.subscription.upsert({
        where: { professionalId: pro.id },
        create: { professionalId: pro.id, status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
        update: { status: 'ACTIVE', transactionId, startedAt: new Date(), expiresAt },
      });
      return res.json({ devMode: true, activated: true, expiresAt });
    }

    const { data } = await axios.post(CINETPAY_API_URL, {
      apikey: process.env.CINETPAY_API_KEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: transactionId,
      amount: PREMIUM_PRICE_FCFA,
      currency: 'XOF',
      description: 'Abonnement Premium - 1 mois',
      notify_url: `${process.env.BACKEND_PUBLIC_URL}/api/subscriptions/notify`,
      return_url: `${process.env.BACKEND_PUBLIC_URL}/api/subscriptions/return`,
      channels: 'MOBILE_MONEY',
      customer_name: req.user.email,
    });

    if (data.code !== '201') return res.status(400).json({ error: data.message || 'Erreur lors de la création du paiement' });

    await prisma.subscription.upsert({
      where: { professionalId: pro.id },
      create: { professionalId: pro.id, status: 'INACTIVE', transactionId },
      update: { transactionId },
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
module.exports.PREMIUM_PRICE_FCFA = PREMIUM_PRICE_FCFA;
