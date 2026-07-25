const express = require('express');
const crypto = require('crypto');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const geniuspay = require('../utils/geniuspay');

const router = express.Router();

// POST /api/payments/create-checkout
router.post('/create-checkout', requireAuth, requireRole('CLIENT'), async (req, res, next) => {
  try {
    const { quoteId, isDeposit } = req.body;
    console.log('[Payment] create-checkout called, quoteId:', quoteId, 'isDeposit:', isDeposit);

    if (!quoteId) return res.status(400).json({ error: 'quoteId est requis' });

    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { project: true, professional: true },
    });
    console.log('[Payment] quote found:', quote?.id, 'status:', quote?.status);
    if (!quote || quote.status !== 'ACCEPTED') {
      console.log('[Payment] quote not accepted, status:', quote?.status);
      return res.status(400).json({ error: 'Ce devis doit être accepté avant paiement' });
    }
    if (quote.project.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const amount = Math.round(isDeposit ? quote.amount * 0.3 : quote.amount * 0.7);
    const description = `${isDeposit ? 'Acompte 30%' : 'Solde 70%'} - ${quote.project.title}`;

    const paymentResult = await geniuspay.createPayment({
      amount,
      description,
      customerName: req.user.name || req.user.email,
      customerEmail: req.user.email,
      customerPhone: req.user.phone || '',
      quoteId,
      projectId: quote.projectId,
      isDeposit,
      userId: req.user.id,
      successUrl: `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000'}/api/payments/success`,
      errorUrl: `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000'}/api/payments/error`,
    });

    // GeniusPay response: { success: true, data: { reference, checkout_url, ... } }
    const paymentData = paymentResult.data || paymentResult;
    const geniuspayReference = paymentData.reference;
    const checkoutUrl = paymentData.checkout_url || paymentData.payment_url || paymentData.checkoutUrl;

    await prisma.payment.upsert({
      where: { quoteId },
      create: {
        quoteId,
        geniuspayRef: geniuspayReference,
        amount,
        status: 'pending',
        isDeposit,
        fees: paymentData.fees || 0,
        netAmount: paymentData.net_amount || amount,
      },
      update: {
        geniuspayRef: geniuspayReference,
        amount,
        status: 'pending',
        isDeposit,
        fees: paymentData.fees || 0,
        netAmount: paymentData.net_amount || amount,
      },
    });

    res.json({
      success: true,
      checkoutUrl,
      reference: geniuspayReference,
      amount,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Payment creation error:', JSON.stringify(detail));
    res.status(500).json({ error: 'Erreur lors de la création du paiement', detail });
  }
});

// POST /api/payments/webhooks/geniuspay
router.post('/webhooks/geniuspay', express.json(), async (req, res) => {
  try {
    const signature = req.header('X-Webhook-Signature');
    const timestamp = req.header('X-Webhook-Timestamp');
    const event = req.header('X-Webhook-Event');

    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'Missing signature or timestamp' });
    }

    // Vérifier la signature du webhook
    if (!geniuspay.verifyWebhookSignature(signature, timestamp, req.body)) {
      console.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Vérifier le timestamp (protection contre les replay attacks)
    if (!geniuspay.verifyWebhookTimestamp(timestamp)) {
      console.warn('Webhook timestamp too old');
      return res.status(400).json({ error: 'Timestamp too old' });
    }

    const { data } = req.body;

    // Traiter différents événements de paiement
    if (event === 'payment.success' && data.status === 'completed') {
      const reference = data.reference;
      const metadata = data.metadata || {};

      // Mettre à jour le paiement en base de données
      const payment = await prisma.payment.findUnique({
        where: { geniuspayRef: reference },
        include: { quote: { include: { project: true } } },
      });

      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'succeeded',
            completedAt: new Date(),
            fees: data.fees || payment.fees,
            netAmount: data.net_amount || payment.netAmount,
            paymentMethod: data.payment_method || payment.paymentMethod,
          },
        });

        // Si c'est le dernier paiement (solde), marquer le devis comme complété
        if (!payment.isDeposit) {
          await prisma.quote.update({
            where: { id: payment.quoteId },
            data: { status: 'COMPLETED' },
          });
        }
      }

      res.json({ success: true, message: 'Payment processed' });
    } else if (event === 'payment.failed') {
      const reference = data.reference;
      await prisma.payment.updateMany({
        where: { geniuspayRef: reference },
        data: { status: 'failed' },
      });

      res.json({ success: true, message: 'Payment failure recorded' });
    } else {
      res.json({ success: true, message: 'Event processed' });
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// GET /api/payments/ping-geniuspay — test connectivité + création paiement test
router.get('/ping-geniuspay', async (req, res) => {
  const axios = require('axios');
  try {
    // Test 1 : account
    const r = await axios.get('https://geniuspay.ci/api/v1/merchant/account', {
      timeout: 10000,
      headers: { 'X-API-Key': process.env.GENIUSPAY_API_KEY, 'X-API-Secret': process.env.GENIUSPAY_API_SECRET },
    });
    // Test 2 : créer un vrai paiement test
    let paymentTest = null;
    try {
      const p = await axios.post('https://geniuspay.ci/api/v1/merchant/payments', {
        amount: 1000, currency: 'XOF', description: 'Test paiement',
        customer: { name: 'Test User', email: 'test@test.com', phone: '0700000000' },
        success_url: 'https://example.com/success',
        error_url: 'https://example.com/error',
      }, {
        timeout: 10000,
        headers: { 'X-API-Key': process.env.GENIUSPAY_API_KEY, 'X-API-Secret': process.env.GENIUSPAY_API_SECRET, 'Content-Type': 'application/json' },
      });
      paymentTest = { ok: true, status: p.status, data: p.data };
    } catch (pe) {
      paymentTest = { ok: false, code: pe.code, status: pe.response?.status, data: pe.response?.data, msg: pe.message };
    }
    res.json({ account: { ok: true, status: r.status, data: r.data }, payment: paymentTest });
  } catch (err) {
    res.json({ ok: false, code: err.code, status: err.response?.status, data: err.response?.data, msg: err.message });
  }
});

// GET /api/payments/success
router.get('/success', (req, res) => {
  res.send(`
    <html>
      <head><title>Paiement réussi</title></head>
      <body style="font-family:sans-serif;text-align:center;padding-top:80px;">
        <h2>✓ Paiement réussi</h2>
        <p>Votre paiement a été traité avec succès.</p>
        <p style="color:#666;margin-top:20px;">Vous pouvez retourner sur l'application MANAWA.</p>
      </body>
    </html>
  `);
});

// GET /api/payments/error
router.get('/error', (req, res) => {
  res.send(`
    <html>
      <head><title>Erreur de paiement</title></head>
      <body style="font-family:sans-serif;text-align:center;padding-top:80px;">
        <h2>✗ Paiement échoué</h2>
        <p>Une erreur s'est produite lors du traitement de votre paiement.</p>
        <p style="color:#666;margin-top:20px;">Veuillez réessayer ou contacter le support.</p>
      </body>
    </html>
  `);
});

// GET /api/payments/status/:quoteId
router.get('/status/:quoteId', requireAuth, async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { quoteId: req.params.quoteId },
      include: { quote: { include: { project: true } } },
    });
    if (!payment) return res.status(404).json({ error: 'Aucun paiement trouvé' });

    if (payment.quote.project.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Récupérer les détails actualisés depuis GeniusPay si nécessaire
    if (payment.status === 'pending' && payment.geniuspayRef) {
      try {
        const geniuspayData = await geniuspay.getPayment(payment.geniuspayRef);
        if (geniuspayData.status === 'completed') {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: 'succeeded',
              completedAt: new Date(),
              fees: geniuspayData.fees,
              netAmount: geniuspayData.net_amount,
              paymentMethod: geniuspayData.payment_method,
            },
          });
          payment.status = 'succeeded';
        }
      } catch (err) {
        console.error('Error fetching payment status from GeniusPay:', err.message);
      }
    }

    const { quote, ...paymentData } = payment;
    res.json(paymentData);
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/check/:reference
router.get('/check/:reference', requireAuth, async (req, res, next) => {
  try {
    const geniuspayData = await geniuspay.getPayment(req.params.reference);
    res.json(geniuspayData);
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/providers (list MMO providers)
router.get('/providers', async (req, res, next) => {
  try {
    const country = req.query.country || null;
    const providersData = await geniuspay.getPawapayProviders(country);
    res.json(providersData);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
