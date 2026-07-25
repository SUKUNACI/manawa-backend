const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');
const generateQuotePdf = require('../utils/generateQuotePdf');
const { getActiveTier, getTierConfig } = require('./subscriptions');

const router = express.Router();

// POST /api/quotes — Créer un devis (simple ou détaillé)
router.post('/', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { projectId, amount, description, mode, items, validityDays } = req.body;

    if (!projectId || !description) {
      return res.status(400).json({ error: 'projectId et description sont requis' });
    }

    const quoteMode = mode === 'DETAILED' ? 'DETAILED' : 'SIMPLE';

    if (quoteMode === 'SIMPLE' && !amount) {
      return res.status(400).json({ error: 'Le montant est requis pour un devis simple' });
    }

    if (quoteMode === 'DETAILED' && (!items || items.length === 0)) {
      return res.status(400).json({ error: 'Au moins une ligne est requise pour un devis détaillé' });
    }

    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id }, include: { subscription: true } });

    if (!pro.verifiedByAdmin) {
      return res.status(403).json({ error: "Votre identité doit être vérifiée avant de pouvoir envoyer un devis. Rendez-vous dans Compte → Vérification d'identité." });
    }

    const quoteTier = getActiveTier(pro.subscription, pro);
    const quoteTierCfg = getTierConfig(quoteTier);
    if (quoteTierCfg.maxQuotesPerMonth !== null) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const quotesThisMonth = await prisma.quote.count({
        where: { professionalId: pro.id, createdAt: { gte: startOfMonth } },
      });
      if (quotesThisMonth >= quoteTierCfg.maxQuotesPerMonth) {
        return res.status(403).json({
          error: `Limite de ${quoteTierCfg.maxQuotesPerMonth} devis/mois atteinte pour l'abonnement ${quoteTierCfg.label}. Passez à Pro ou Élite pour des devis illimités.`,
          limitReached: true,
          maxQuotesPerMonth: quoteTierCfg.maxQuotesPerMonth,
          tier: quoteTier,
        });
      }
    }

    const existingPending = await prisma.quote.findFirst({
      where: { projectId, professionalId: pro.id, status: 'PENDING' },
    });
    if (existingPending) {
      return res.status(409).json({ error: "Vous avez déjà un devis en attente sur ce projet. Attendez la réponse du client ou annulez-le d'abord." });
    }

    // Calculer le montant total pour les devis détaillés
    let totalAmount = amount;
    if (quoteMode === 'DETAILED') {
      totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
    }

    // Calculer la date d'expiration
    const days = validityDays || 15;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const quote = await prisma.quote.create({
      data: {
        projectId,
        professionalId: pro.id,
        mode: quoteMode,
        amount: totalAmount,
        description,
        validityDays: days,
        expiresAt,
        items: quoteMode === 'DETAILED' ? {
          create: items.map((item, index) => ({
            category: item.category || 'OTHER',
            label: item.label,
            quantity: item.quantity || 1,
            unit: item.unit || null,
            unitPrice: item.unitPrice,
            total: (item.quantity || 1) * item.unitPrice,
            sortOrder: index,
          })),
        } : undefined,
      },
      include: { items: true },
    });

    // Générer le PDF en arrière-plan
    const fullQuote = await prisma.quote.findUnique({
      where: { id: quote.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        professional: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
        project: { include: { client: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
      },
    });
    generateQuotePdf(fullQuote, fullQuote.professional, fullQuote.project)
      .then(pdfUrl => prisma.quote.update({ where: { id: quote.id }, data: { pdfUrl } }))
      .catch(() => {});

    // Notifier le client
    const projectData = fullQuote.project;
    if (projectData) {
      sendPushNotification(projectData.clientId, 'Nouveau devis reçu', `Un professionnel a envoyé un devis de ${totalAmount.toLocaleString()} FCFA pour "${projectData.title}"`, { type: 'new_quote', projectId });
    }

    res.status(201).json(quote);
  } catch (err) {
    next(err);
  }
});

// POST /api/quotes/:id/revise — Créer une révision (V2, V3...) d'un devis existant
router.post('/:id/revise', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { amount, description, mode, items, validityDays } = req.body;
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });

    // Trouver le devis original (ou la dernière version)
    const parentQuote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: { items: true, project: true },
    });

    if (!parentQuote) return res.status(404).json({ error: 'Devis introuvable' });
    if (parentQuote.professionalId !== pro.id) return res.status(403).json({ error: 'Accès refusé' });
    if (!['PENDING', 'REFUSED'].includes(parentQuote.status)) {
      return res.status(400).json({ error: 'Seul un devis en attente ou refusé peut être révisé' });
    }

    const quoteMode = mode || parentQuote.mode;
    const newDescription = description || parentQuote.description;

    // Calculer le montant
    let totalAmount;
    if (quoteMode === 'DETAILED' && items && items.length > 0) {
      totalAmount = items.reduce((sum, item) => sum + ((item.quantity || 1) * item.unitPrice), 0);
    } else if (amount) {
      totalAmount = amount;
    } else {
      totalAmount = parentQuote.amount;
    }

    // Calculer la date d'expiration
    const days = validityDays || parentQuote.validityDays || 15;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    // Trouver la version la plus haute pour ce projet/pro
    const latestVersion = await prisma.quote.findFirst({
      where: { projectId: parentQuote.projectId, professionalId: pro.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const newVersion = (latestVersion?.version || 1) + 1;

    // Marquer l'ancien devis comme REVISED
    await prisma.quote.update({
      where: { id: parentQuote.id },
      data: { status: 'REVISED' },
    });

    // Créer la nouvelle version
    const newQuote = await prisma.quote.create({
      data: {
        projectId: parentQuote.projectId,
        professionalId: pro.id,
        mode: quoteMode,
        amount: totalAmount,
        description: newDescription,
        version: newVersion,
        parentQuoteId: parentQuote.id,
        validityDays: days,
        expiresAt,
        items: quoteMode === 'DETAILED' && items && items.length > 0 ? {
          create: items.map((item, index) => ({
            category: item.category || 'OTHER',
            label: item.label,
            quantity: item.quantity || 1,
            unit: item.unit || null,
            unitPrice: item.unitPrice,
            total: (item.quantity || 1) * item.unitPrice,
            sortOrder: index,
          })),
        } : undefined,
      },
      include: { items: true },
    });

    // Générer le PDF en arrière-plan
    const fullRevision = await prisma.quote.findUnique({
      where: { id: newQuote.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        professional: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
        project: { include: { client: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
      },
    });
    generateQuotePdf(fullRevision, fullRevision.professional, fullRevision.project)
      .then(pdfUrl => prisma.quote.update({ where: { id: newQuote.id }, data: { pdfUrl } }))
      .catch(() => {});

    // Notifier le client de la révision
    sendPushNotification(parentQuote.project.clientId, 'Devis révisé', `Le professionnel a envoyé une version ${newVersion} du devis pour "${parentQuote.project.title}"`, { type: 'quote_revised', projectId: parentQuote.projectId });

    res.status(201).json(newQuote);
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/:id/history — Historique des versions d'un devis
router.get('/:id/history', requireAuth, async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

    // Trouver toutes les versions de ce devis (même projet + même pro)
    const history = await prisma.quote.findMany({
      where: {
        projectId: quote.projectId,
        professionalId: quote.professionalId,
      },
      include: { items: true },
      orderBy: { version: 'asc' },
    });

    res.json(history);
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/mine — Mes devis (professionnel) - SPÉCIFIQUE (AVANT /:id)
router.get('/mine', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const quotes = await prisma.quote.findMany({
      where: { professionalId: pro.id },
      include: { project: true, items: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(quotes);
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/:id — Détail d'un devis avec ses lignes
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        professional: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } } },
        project: { select: { id: true, title: true, clientId: true } },
        revisions: { orderBy: { version: 'asc' }, select: { id: true, version: true, amount: true, status: true, createdAt: true } },
      },
    });

    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

    res.json(quote);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/quotes/:id — Annuler un devis en attente
router.delete('/:id', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { userId: req.user.id } });
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id } });

    if (!quote || quote.professionalId !== pro.id) return res.status(403).json({ error: 'Accès refusé' });
    if (quote.status !== 'PENDING') return res.status(400).json({ error: 'Seul un devis en attente peut être annulé' });

    await prisma.quote.delete({ where: { id: req.params.id } });
    res.json({ cancelled: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/quotes/:id — Accepter ou refuser un devis (client)
router.patch('/:id', requireAuth, requireRole('CLIENT'), async (req, res, next) => {
  try {
    const { status } = req.body;

    if (!['ACCEPTED', 'REFUSED'].includes(status)) {
      return res.status(400).json({ error: 'Le statut doit être ACCEPTED ou REFUSED' });
    }

    const existingQuote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { project: true } });
    if (!existingQuote) return res.status(404).json({ error: 'Devis introuvable' });
    if (existingQuote.project.clientId !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
    if (existingQuote.status !== 'PENDING') return res.status(400).json({ error: 'Ce devis a déjà été traité' });

    // Vérifier si le devis est expiré
    if (existingQuote.expiresAt && new Date() > new Date(existingQuote.expiresAt)) {
      await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Ce devis a expiré. Demandez au professionnel d\'en envoyer un nouveau.' });
    }

    const quote = await prisma.quote.update({
      where: { id: req.params.id },
      data: { status },
    });

    if (status === 'ACCEPTED') {
      await prisma.project.update({
        where: { id: quote.projectId },
        data: { status: 'IN_PROGRESS' },
      });
    }

    // Notifier le professionnel de la décision
    const pro = await prisma.professional.findUnique({ where: { id: existingQuote.professionalId }, select: { userId: true } });
    if (pro) {
      const title = status === 'ACCEPTED' ? 'Devis accepté !' : 'Devis refusé';
      const body = status === 'ACCEPTED'
        ? `Votre devis pour "${existingQuote.project.title}" a été accepté. La mission commence !`
        : `Votre devis pour "${existingQuote.project.title}" a été refusé.`;
      sendPushNotification(pro.userId, title, body, { type: 'quote_response', quoteId: quote.id, status });
    }

    res.json(quote);
  } catch (err) {
    next(err);
  }
});

// POST /api/quotes/:id/pdf — Générer le PDF du devis
router.post('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        professional: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
        project: { include: { client: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
      },
    });

    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

    // Vérifier que l'utilisateur est le pro ou le client concerné
    const isProOwner = quote.professional.userId === req.user.id;
    const isClient = quote.project.clientId === req.user.id;
    if (!isProOwner && !isClient && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const pdfUrl = await generateQuotePdf(quote, quote.professional, quote.project);

    // Sauvegarder l'URL du PDF dans le devis
    await prisma.quote.update({ where: { id: quote.id }, data: { pdfUrl } });

    res.json({ pdfUrl });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/:id/pdf — Télécharger le PDF existant (ou le générer)
router.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        professional: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
        project: { include: { client: { select: { firstName: true, lastName: true, email: true, phone: true, city: true } } } },
      },
    });

    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

    const isProOwner = quote.professional.userId === req.user.id;
    const isClient = quote.project.clientId === req.user.id;
    if (!isProOwner && !isClient && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    let pdfUrl = quote.pdfUrl;

    // Si pas de PDF existant, le générer
    if (!pdfUrl) {
      pdfUrl = await generateQuotePdf(quote, quote.professional, quote.project);
      await prisma.quote.update({ where: { id: quote.id }, data: { pdfUrl } });
    }

    res.json({ pdfUrl });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
