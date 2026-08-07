const express = require('express');
const crypto = require('crypto');
const prisma = require('../config/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const geniuspay = require('../utils/geniuspay');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function packageSelect(include = {}) {
  return {
    id: true,
    professionalId: true,
    title: true,
    description: true,
    price: true,
    duration: true,
    category: true,
    included: true,
    images: true,
    active: true,
    ordersCount: true,
    createdAt: true,
    updatedAt: true,
    ...include,
  };
}

// ---------------------------------------------------------------------------
// PRO — créer un forfait
// POST /api/packages
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { title, description, price, duration, category, included, images } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Le titre est requis' });
    }
    const parsedPrice = parseFloat(price);
    if (!parsedPrice || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Le prix doit être supérieur à 0' });
    }

    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Profil professionnel introuvable' });

    const pkg = await prisma.servicePackage.create({
      data: {
        professionalId: pro.id,
        title: title.trim(),
        description: description?.trim() || null,
        price: parsedPrice,
        duration: duration?.trim() || null,
        category: category?.trim() || null,
        included: Array.isArray(included) ? included : [],
        images: Array.isArray(images) ? images : [],
      },
      select: packageSelect(),
    });

    res.status(201).json(pkg);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PRO — mes forfaits
// GET /api/packages/mine
// ---------------------------------------------------------------------------
router.get('/mine', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Profil professionnel introuvable' });

    const packages = await prisma.servicePackage.findMany({
      where: { professionalId: pro.id },
      select: packageSelect(),
      orderBy: { createdAt: 'desc' },
    });

    res.json(packages);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// CLIENT — mes commandes
// GET /api/packages/my-orders
// ---------------------------------------------------------------------------
router.get('/my-orders', requireAuth, async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    let orders;

    if (role === 'CLIENT') {
      orders = await prisma.packageOrder.findMany({
        where: { clientId: userId },
        include: {
          package: { select: { title: true, images: true, category: true } },
          professional: { include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else if (role === 'PROFESSIONAL') {
      const pro = await prisma.professional.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!pro) return res.json([]);
      orders = await prisma.packageOrder.findMany({
        where: { professionalId: pro.id },
        include: {
          package: { select: { title: true, images: true, category: true } },
          client: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Détail d'une commande
// GET /api/packages/orders/:orderId
// ---------------------------------------------------------------------------
router.get('/orders/:orderId', requireAuth, async (req, res, next) => {
  try {
    const order = await prisma.packageOrder.findUnique({
      where: { id: req.params.orderId },
      include: {
        package: { select: packageSelect() },
        client: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, phone: true, email: true } },
        professional: { include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } } },
        project: { select: { id: true, title: true, status: true } },
      },
    });

    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const { id: userId, role } = req.user;
    const isClient = order.clientId === userId;
    let isPro = false;
    if (role === 'PROFESSIONAL') {
      const pro = await prisma.professional.findUnique({ where: { userId }, select: { id: true } });
      isPro = pro && pro.id === order.professionalId;
    }
    const isAdmin = role === 'ADMIN';

    if (!isClient && !isPro && !isAdmin) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUBLIC — forfaits actifs d'un pro
// GET /api/packages/pro/:proId
// ---------------------------------------------------------------------------
router.get('/pro/:proId', optionalAuth, async (req, res, next) => {
  try {
    const packages = await prisma.servicePackage.findMany({
      where: { professionalId: req.params.proId, active: true },
      select: packageSelect(),
      orderBy: { createdAt: 'desc' },
    });

    res.json(packages);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUBLIC — feed forfaits avec filtres
// GET /api/packages?category=&minPrice=&maxPrice=&search=&page=
// ---------------------------------------------------------------------------
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { category, minPrice, maxPrice, search, page = '1' } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = 20;
    const skip = (pageNum - 1) * pageSize;

    const where = { active: true };

    if (category) where.category = category;
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = parseFloat(minPrice);
      if (maxPrice) where.price.lte = parseFloat(maxPrice);
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [packages, total] = await Promise.all([
      prisma.servicePackage.findMany({
        where,
        select: {
          ...packageSelect(),
          professional: {
            select: {
              id: true,
              averageRating: true,
              reviewCount: true,
              verifiedByAdmin: true,
              user: { select: { firstName: true, lastName: true, avatarUrl: true, city: true } },
            },
          },
        },
        orderBy: [{ ordersCount: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      prisma.servicePackage.count({ where }),
    ]);

    res.json({
      packages,
      pagination: {
        page: pageNum,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PRO — modifier un forfait
// PATCH /api/packages/:id
// ---------------------------------------------------------------------------
router.patch('/:id', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Profil professionnel introuvable' });

    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.id } });
    if (!pkg) return res.status(404).json({ error: 'Forfait introuvable' });
    if (pkg.professionalId !== pro.id) return res.status(403).json({ error: 'Accès refusé' });

    const { title, description, price, duration, category, included, images, active } = req.body;
    const data = {};

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: 'Le titre ne peut pas être vide' });
      data.title = title.trim();
    }
    if (description !== undefined) data.description = description?.trim() || null;
    if (price !== undefined) {
      const p = parseFloat(price);
      if (!p || p <= 0) return res.status(400).json({ error: 'Le prix doit être supérieur à 0' });
      data.price = p;
    }
    if (duration !== undefined) data.duration = duration?.trim() || null;
    if (category !== undefined) data.category = category?.trim() || null;
    if (included !== undefined) data.included = Array.isArray(included) ? included : [];
    if (images !== undefined) data.images = Array.isArray(images) ? images : [];
    if (active !== undefined) data.active = Boolean(active);

    const updated = await prisma.servicePackage.update({
      where: { id: req.params.id },
      data,
      select: packageSelect(),
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PRO — supprimer (soft : active: false)
// DELETE /api/packages/:id
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({
      where: { userId: req.user.id },
      select: { id: true },
    });
    if (!pro) return res.status(404).json({ error: 'Profil professionnel introuvable' });

    const pkg = await prisma.servicePackage.findUnique({ where: { id: req.params.id } });
    if (!pkg) return res.status(404).json({ error: 'Forfait introuvable' });
    if (pkg.professionalId !== pro.id) return res.status(403).json({ error: 'Accès refusé' });

    await prisma.servicePackage.update({
      where: { id: req.params.id },
      data: { active: false },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// CLIENT — commander un forfait
// POST /api/packages/:id/order
// ---------------------------------------------------------------------------
router.post('/:id/order', requireAuth, requireRole('CLIENT'), async (req, res, next) => {
  try {
    const { note } = req.body;

    const pkg = await prisma.servicePackage.findUnique({
      where: { id: req.params.id },
      include: {
        professional: {
          include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } },
        },
      },
    });

    if (!pkg || !pkg.active) return res.status(404).json({ error: 'Forfait introuvable ou inactif' });

    // Un pro ne peut pas commander ses propres forfaits
    if (pkg.professional.userId === req.user.id) {
      return res.status(403).json({ error: 'Vous ne pouvez pas commander vos propres forfaits' });
    }

    const client = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { firstName: true, lastName: true, email: true, phone: true },
    });

    // Créer la commande en PENDING_PAYMENT
    const order = await prisma.packageOrder.create({
      data: {
        packageId: pkg.id,
        clientId: req.user.id,
        professionalId: pkg.professionalId,
        amount: pkg.price,
        status: 'PENDING_PAYMENT',
        note: note?.trim() || null,
      },
    });

    // Initier le paiement GeniusPay
    const idempotencyKey = crypto.randomUUID();
    const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000';
    const successUrl = `${base}/api/packages/payment/success?orderId=${order.id}`;
    const errorUrl = `${base}/api/packages/payment/error?orderId=${order.id}`;

    let paymentUrl = null;
    let geniuspayRef = null;

    try {
      const paymentResult = await geniuspay.createPayment({
        amount: pkg.price,
        description: `Forfait MANAWA : ${pkg.title}`,
        customerName: `${client.firstName} ${client.lastName}`,
        customerEmail: client.email,
        customerPhone: client.phone || '',
        quoteId: null,
        projectId: null,
        isDeposit: false,
        userId: req.user.id,
        idempotencyKey,
        successUrl,
        errorUrl,
      });

      const paymentData = paymentResult.data || paymentResult;
      geniuspayRef = paymentData.reference;
      paymentUrl = paymentData.checkout_url || paymentData.payment_url || paymentData.checkoutUrl;

      // Enregistrer la référence GeniusPay dans la commande
      await prisma.packageOrder.update({
        where: { id: order.id },
        data: { transactionId: geniuspayRef, paymentUrl },
      });
    } catch (gpErr) {
      // Annuler la commande si GeniusPay échoue
      await prisma.packageOrder.delete({ where: { id: order.id } });

      const detail = gpErr.response?.data || gpErr.message;
      console.error('[PackageOrder] GeniusPay error:', JSON.stringify(detail));

      if (gpErr.response?.status === 401 || gpErr.response?.data?.error?.code === 'INVALID_API_KEY') {
        return res.status(503).json({ error: 'Service de paiement temporairement indisponible. Veuillez réessayer plus tard.' });
      }
      if (gpErr.response?.data?.error?.message) {
        return res.status(502).json({ error: gpErr.response.data.error.message });
      }
      throw gpErr;
    }

    res.status(201).json({
      orderId: order.id,
      paymentUrl,
      reference: geniuspayRef,
      amount: pkg.price,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUBLIC — détail d'un forfait
// GET /api/packages/:id
// (doit être après toutes les routes spécifiques comme /mine, /my-orders, etc.)
// ---------------------------------------------------------------------------
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const pkg = await prisma.servicePackage.findUnique({
      where: { id: req.params.id },
      select: {
        ...packageSelect(),
        professional: {
          select: {
            id: true,
            averageRating: true,
            reviewCount: true,
            verifiedByAdmin: true,
            trades: true,
            description: true,
            user: { select: { firstName: true, lastName: true, avatarUrl: true, city: true } },
          },
        },
      },
    });

    if (!pkg) return res.status(404).json({ error: 'Forfait introuvable' });

    res.json(pkg);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Pages de retour GeniusPay (redirect deep link)
// ---------------------------------------------------------------------------
router.get('/payment/success', (req, res) => {
  const orderId = encodeURIComponent((req.query.orderId || '').replace(/[^a-zA-Z0-9_-]/g, ''));
  const deepLink = `manawa://package/success?orderId=${orderId}`;
  const deepLinkEncoded = deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  res.send(`
    <html>
      <head>
        <title>Commande confirmée</title>
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
        <h2>Commande confirmée !</h2>
        <p>Votre paiement a été reçu.<br>Retour automatique sur MANAWA...</p>
        <a class="btn" href="${deepLinkEncoded}">Retourner sur MANAWA</a>
        <script>
          var dl = document.querySelector('.btn').getAttribute('href');
          window.onload = function() { window.location.href = dl; };
        </script>
      </body>
    </html>
  `);
});

router.get('/payment/error', (req, res) => {
  const orderId = encodeURIComponent((req.query.orderId || '').replace(/[^a-zA-Z0-9_-]/g, ''));
  const deepLink = `manawa://package/error?orderId=${orderId}`;
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
