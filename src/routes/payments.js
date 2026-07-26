const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const geniuspay = require('../utils/geniuspay');
const { logPaymentStatus } = require('../utils/paymentAudit');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// Notifie le pro quand un paiement est confirmé
async function notifyProPaymentReceived(paymentId) {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        quote: {
          include: {
            project: true,
            professional: { include: { user: true } },
          },
        },
      },
    });
    if (!payment) return;

    const pro = payment.quote.professional;
    const projectTitle = payment.quote.project.title;
    const amount = payment.amount.toLocaleString('fr-FR');
    const type = payment.isDeposit ? 'acompte (30%)' : 'solde (70%)';
    const title = payment.isDeposit ? '💰 Acompte reçu !' : '💰 Solde reçu !';
    const body = `Le client a payé l'${type} de ${amount} FCFA pour "${projectTitle}".`;

    sendPushNotification(pro.userId, title, body, {
      type: 'payment_received',
      paymentId,
      quoteId: payment.quoteId,
      projectId: payment.quote.projectId,
      isDeposit: payment.isDeposit,
    });
  } catch (err) {
    console.error('[Payment] Erreur notification pro:', err.message);
  }
}

// 5 tentatives de paiement max par utilisateur par heure
const paymentRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Trop de tentatives de paiement. Réessayez dans une heure.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// Vérifie le montant reçu vs attendu (±1 FCFA pour les arrondis)
// Retourne true si le montant est valide, false sinon
async function verifyAndUpdatePayment(payment, gpData, reason = 'recheck') {
  const receivedAmount = gpData?.amount || gpData?.paid_amount;
  if (receivedAmount !== undefined && Math.abs(receivedAmount - payment.amount) > 1) {
    console.error(
      `[Payment] MONTANT INCORRECT — id: ${payment.id}, attendu: ${payment.amount}, reçu: ${receivedAmount}`
    );
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'failed', metadata: JSON.stringify({ reason: 'amount_mismatch', expected: payment.amount, received: receivedAmount }) },
    });
    await logPaymentStatus({
      paymentId: payment.id,
      fromStatus: payment.status,
      toStatus: 'failed',
      reason: 'amount_mismatch',
      metadata: { expected: payment.amount, received: receivedAmount },
    });
    return false;
  }
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'succeeded', completedAt: new Date() },
  });
  await logPaymentStatus({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: 'succeeded',
    reason,
  });
  notifyProPaymentReceived(payment.id);
  return true;
}

// POST /api/payments/create-checkout
router.post('/create-checkout', requireAuth, requireRole('CLIENT'), paymentRateLimit, async (req, res, next) => {
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

    // Vérifier si ce type de paiement (acompte ou solde) existe déjà
    const existingPayment = await prisma.payment.findUnique({
      where: { quoteId_isDeposit: { quoteId, isDeposit } },
    });
    if (existingPayment) {
      // Si pending, re-vérifier chez GeniusPay (webhook peut avoir manqué)
      if (existingPayment.status === 'pending' && existingPayment.geniuspayRef) {
        try {
          const gpResponse = await geniuspay.getPayment(existingPayment.geniuspayRef);
          const gpData = gpResponse?.data || gpResponse;
          const realStatus = gpData?.status;
          if (realStatus === 'completed' || realStatus === 'success') {
            const valid = await verifyAndUpdatePayment(existingPayment, gpData);
            if (valid) existingPayment.status = 'succeeded';
          }
        } catch {}
      }
      if (existingPayment.status === 'succeeded') {
        return res.status(400).json({ error: 'Ce paiement a déjà été effectué avec succès.' });
      }
    }

    // Vérifier que l'acompte est payé avant de permettre le paiement du solde
    if (!isDeposit) {
      const depositPayment = await prisma.payment.findUnique({
        where: { quoteId_isDeposit: { quoteId, isDeposit: true } },
      });
      if (!depositPayment || depositPayment.status !== 'succeeded') {
        return res.status(400).json({ error: "L'acompte doit être payé avant de régler le solde." });
      }
    }

    const amount = Math.round(isDeposit ? quote.amount * 0.3 : quote.amount * 0.7);
    const description = `${isDeposit ? 'Acompte 30%' : 'Solde 70%'} - ${quote.project.title}`;

    // Clé d'idempotence : réutiliser la clé existante sur retry, en générer une nouvelle sinon
    // Garantit que GeniusPay retourne la même réponse si la requête est rejouée (réseau coupé, double-clic, etc.)
    const idempotencyKey = existingPayment?.idempotencyKey || crypto.randomUUID();

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
      idempotencyKey,
      successUrl: `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000'}/api/payments/success?quoteId=${quoteId}&isDeposit=${isDeposit}`,
      errorUrl: `${process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000'}/api/payments/error?quoteId=${quoteId}`,
    });

    const paymentData = paymentResult.data || paymentResult;
    const geniuspayReference = paymentData.reference;
    const checkoutUrl = paymentData.checkout_url || paymentData.payment_url || paymentData.checkoutUrl;

    if (existingPayment) {
      await prisma.payment.update({
        where: { id: existingPayment.id },
        data: { geniuspayRef: geniuspayReference, idempotencyKey, status: 'pending', fees: paymentData.fees || 0, netAmount: paymentData.net_amount || amount },
      });
    } else {
      await prisma.payment.create({
        data: { quoteId, geniuspayRef: geniuspayReference, idempotencyKey, amount, status: 'pending', isDeposit, fees: paymentData.fees || 0, netAmount: paymentData.net_amount || amount },
      });
    }

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
    // Whitelist IP GeniusPay — activer en ajoutant GENIUSPAY_WEBHOOK_IPS dans Railway
    // Format : "1.2.3.4,5.6.7.8" (IPs séparées par virgule, à demander à GeniusPay)
    const allowedIPs = process.env.GENIUSPAY_WEBHOOK_IPS
      ? process.env.GENIUSPAY_WEBHOOK_IPS.split(',').map(ip => ip.trim())
      : [];

    if (allowedIPs.length > 0) {
      const requestIP = req.ip || req.socket?.remoteAddress || '';
      const normalizedIP = requestIP.replace('::ffff:', ''); // normaliser IPv4-mapped IPv6
      if (!allowedIPs.includes(normalizedIP)) {
        console.warn(`[Webhook] IP non autorisée : ${normalizedIP}`);
        return res.status(403).json({ error: 'IP not allowed' });
      }
    }

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

      const payment = await prisma.payment.findUnique({
        where: { geniuspayRef: reference },
        include: { quote: { include: { project: true } } },
      });

      if (payment && payment.status !== 'succeeded') {
        // Si déjà succeeded (double webhook) → ignorer silencieusement
        // Si failed (cron a expiré mais webhook arrive quand même) → on corrige en succeeded
        const receivedAmount = data.amount || data.paid_amount;
        if (receivedAmount !== undefined && Math.abs(receivedAmount - payment.amount) > 1) {
          console.error(`[Payment] MONTANT INCORRECT — ref: ${reference}, attendu: ${payment.amount}, reçu: ${receivedAmount}.`);
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'failed', metadata: JSON.stringify({ reason: 'amount_mismatch', expected: payment.amount, received: receivedAmount }) },
          });
          await logPaymentStatus({
            paymentId: payment.id,
            fromStatus: payment.status,
            toStatus: 'failed',
            reason: 'amount_mismatch',
            ipAddress: req.ip,
            metadata: { expected: payment.amount, received: receivedAmount, ref: reference },
          });
          return res.status(400).json({ error: 'Amount mismatch' });
        }

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
        await logPaymentStatus({
          paymentId: payment.id,
          fromStatus: payment.status,
          toStatus: 'succeeded',
          reason: 'webhook',
          ipAddress: req.ip,
          metadata: { ref: reference, method: data.payment_method },
        });
        notifyProPaymentReceived(payment.id);

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
      const failedPayment = await prisma.payment.findUnique({ where: { geniuspayRef: reference } });
      if (failedPayment) {
        await prisma.payment.update({ where: { id: failedPayment.id }, data: { status: 'failed' } });
        await logPaymentStatus({
          paymentId: failedPayment.id,
          fromStatus: failedPayment.status,
          toStatus: 'failed',
          reason: 'webhook',
          ipAddress: req.ip,
          metadata: { ref: reference },
        });
      }
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

// GET /api/payments/success — redirige vers l'app via deep link
router.get('/success', (req, res) => {
  const { quoteId } = req.query;
  const deepLink = `manawa://payment/success?quoteId=${quoteId || ''}`;
  res.send(`
    <html>
      <head>
        <title>Paiement réussi</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; text-align: center; padding: 60px 24px; background: #0A0D14; color: #fff; }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h2 { color: #22C55E; font-size: 24px; margin-bottom: 8px; }
          p { color: #9CA3AF; font-size: 15px; line-height: 1.5; }
          .btn { display: inline-block; margin-top: 32px; background: #F4720B; color: #fff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-size: 16px; font-weight: 600; }
        </style>
        <script>
          window.onload = function() {
            window.location.href = '${deepLink}';
            setTimeout(function() {}, 3000);
          };
        </script>
      </head>
      <body>
        <div class="icon">✅</div>
        <h2>Paiement réussi !</h2>
        <p>Votre paiement a été traité avec succès.<br>Retour automatique sur MANAWA...</p>
        <a class="btn" href="${deepLink}">Retourner sur MANAWA</a>
      </body>
    </html>
  `);
});

// GET /api/payments/error — redirige vers l'app via deep link
router.get('/error', (req, res) => {
  const { quoteId } = req.query;
  const deepLink = `manawa://payment/error?quoteId=${quoteId || ''}`;
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
        <script>
          window.onload = function() {
            window.location.href = '${deepLink}';
          };
        </script>
      </head>
      <body>
        <div class="icon">❌</div>
        <h2>Paiement échoué</h2>
        <p>Une erreur s'est produite lors du paiement.<br>Retour automatique sur MANAWA...</p>
        <a class="btn" href="${deepLink}">Retourner sur MANAWA</a>
      </body>
    </html>
  `);
});

// GET /api/payments/status/:quoteId — retourne { deposit, balance }
router.get('/status/:quoteId', requireAuth, async (req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { quoteId: req.params.quoteId },
      include: { quote: { include: { project: true } } },
    });

    if (payments.length === 0) return res.status(404).json({ error: 'Aucun paiement trouvé' });

    if (payments[0].quote.project.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Re-vérifier les paiements pending chez GeniusPay
    for (const payment of payments) {
      if (payment.status === 'pending' && payment.geniuspayRef) {
        try {
          const gpResponse = await geniuspay.getPayment(payment.geniuspayRef);
          const gpData = gpResponse?.data || gpResponse;
          if (gpData?.status === 'completed' || gpData?.status === 'success') {
            const valid = await verifyAndUpdatePayment(payment, gpData);
            if (valid) payment.status = 'succeeded';
          }
        } catch {}
      }
    }

    const deposit = payments.find(p => p.isDeposit === true);
    const balance = payments.find(p => p.isDeposit === false);

    res.json({
      deposit: deposit ? { status: deposit.status, isDeposit: true } : null,
      balance: balance ? { status: balance.status, isDeposit: false } : null,
    });
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

// GET /api/payments/history — historique paiements (client, pro, admin)
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    let payments;

    if (role === 'ADMIN') {
      payments = await prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          quote: {
            include: {
              project: { select: { title: true } },
              professional: { include: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
        },
      });
    } else if (role === 'CLIENT') {
      payments = await prisma.payment.findMany({
        where: { quote: { project: { clientId: userId } } },
        orderBy: { createdAt: 'desc' },
        include: {
          quote: {
            include: {
              project: { select: { title: true } },
              professional: { include: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
        },
      });
    } else if (role === 'PROFESSIONAL') {
      const pro = await prisma.professional.findUnique({ where: { userId } });
      if (!pro) return res.json([]);
      payments = await prisma.payment.findMany({
        where: { quote: { professionalId: pro.id } },
        orderBy: { createdAt: 'desc' },
        include: {
          quote: {
            include: {
              project: { select: { title: true } },
            },
          },
        },
      });
    } else {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const result = payments.map(p => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      isDeposit: p.isDeposit,
      paymentMethod: p.paymentMethod,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
      projectTitle: p.quote.project.title,
      proName: p.quote.professional?.user
        ? `${p.quote.professional.user.firstName} ${p.quote.professional.user.lastName}`
        : null,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/disputes — ouvrir un litige sur un paiement
router.post('/disputes', requireAuth, async (req, res, next) => {
  try {
    const { paymentId, reason, description } = req.body;
    if (!paymentId || !reason) return res.status(400).json({ error: 'paymentId et reason requis' });

    const validReasons = [
      'Travaux non réalisés',
      'Qualité non conforme',
      'Dépassement de budget non autorisé',
      'Paiement en double',
      'Annulation sans remboursement',
      'Litige contractuel',
      'Autre',
    ];
    if (!validReasons.includes(reason)) return res.status(400).json({ error: 'Raison invalide' });

    // Vérifier que le paiement appartient à un projet du client
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { quote: { include: { project: { select: { clientId: true } } } } },
    });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.quote.project.clientId !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
    if (payment.status !== 'succeeded') return res.status(400).json({ error: 'Impossible d\'ouvrir un litige sur ce paiement' });

    // Bloquer un deuxième litige sur le même paiement
    const existing = await prisma.dispute.findFirst({ where: { paymentId, clientId: req.user.id, status: { not: 'RESOLVED_REJECTED' } } });
    if (existing) return res.status(409).json({ error: 'Un litige est déjà ouvert pour ce paiement' });

    const dispute = await prisma.dispute.create({
      data: { paymentId, clientId: req.user.id, reason, description: description || null, status: 'OPEN' },
    });
    res.status(201).json(dispute);
  } catch (err) { next(err); }
});

// GET /api/payments/disputes/me — litiges du client connecté
router.get('/disputes/me', requireAuth, async (req, res, next) => {
  try {
    const disputes = await prisma.dispute.findMany({
      where: { clientId: req.user.id },
      include: {
        payment: {
          include: {
            quote: {
              include: {
                professional: { include: { user: { select: { firstName: true, lastName: true } } } },
                project: { select: { title: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(disputes);
  } catch (err) { next(err); }
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
