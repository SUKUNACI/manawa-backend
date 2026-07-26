const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');
const { computeTrustScore, getTrustScoreBreakdown } = require('../utils/trustScore');

const router = express.Router();

// Tous les endpoints admin nécessitent authentification + rôle ADMIN
router.use(requireAuth, requireRole('ADMIN'));

// ============================================================
// 1. TABLEAU DE BORD
// ============================================================

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    // Compteurs utilisateurs
    const [totalUsers, totalPros, totalClients] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'PROFESSIONAL' } }),
      prisma.user.count({ where: { role: 'CLIENT' } }),
    ]);

    // Projets par statut
    const [projectsOpen, projectsInProgress, projectsCompleted, projectsCancelled] = await Promise.all([
      prisma.project.count({ where: { status: 'OPEN' } }),
      prisma.project.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.project.count({ where: { status: 'COMPLETED' } }),
      prisma.project.count({ where: { status: 'CANCELLED' } }),
    ]);

    // Devis
    const totalQuotes = await prisma.quote.count();

    // Paiements et chiffre d'affaires
    const [totalPayments, revenueAgg] = await Promise.all([
      prisma.payment.count(),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: 'succeeded' },
      }),
    ]);
    const totalRevenue = revenueAgg._sum.amount || 0;

    // Abonnements Premium actifs
    const activePremiumSubscriptions = await prisma.subscription.count({
      where: { status: 'ACTIVE' },
    });

    // Vérifications en attente
    const pendingVerifications = await prisma.professional.count({
      where: { identityStatus: 'PENDING' },
    });

    // 10 derniers utilisateurs inscrits
    const latestUsers = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        city: true,
        createdAt: true,
      },
    });

    // 10 dernières activités (messages envoyés comme proxy d'activité)
    const latestActivities = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        content: true,
        createdAt: true,
        sender: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    res.json({
      users: { total: totalUsers, professionals: totalPros, clients: totalClients },
      projects: {
        open: projectsOpen,
        inProgress: projectsInProgress,
        completed: projectsCompleted,
        cancelled: projectsCancelled,
        total: projectsOpen + projectsInProgress + projectsCompleted + projectsCancelled,
      },
      quotes: { total: totalQuotes },
      payments: { total: totalPayments, revenue: totalRevenue },
      subscriptions: { activePremium: activePremiumSubscriptions },
      pendingVerifications,
      latestUsers,
      latestActivities,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 2. GESTION DES UTILISATEURS
// ============================================================

// GET /api/admin/users — liste paginée avec recherche et filtre par rôle
router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search, role } = req.query;

    const where = { deletedAt: null };

    if (role && ['CLIENT', 'PROFESSIONAL', 'ADMIN'].includes(role.toUpperCase())) {
      where.role = role.toUpperCase();
    }

    if (search) {
      where.OR = [
        { id: { startsWith: search } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          avatarUrl: true,
          city: true,
          suspended: true,
          emailVerified: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id — détail d'un utilisateur
router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        professional: true,
        projects: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const { passwordHash, ...userSafe } = user;
    res.json(userSafe);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id — modifier les infos de base
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { firstName, lastName, email, city, phone } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
        ...(email !== undefined && { email }),
        ...(city !== undefined && { city }),
        ...(phone !== undefined && { phone }),
      },
    });

    const { passwordHash, ...userSafe } = updated;
    res.json(userSafe);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/suspend — suspendre un compte
router.patch('/users/:id/suspend', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: true },
    });

    const { passwordHash, ...userSafe } = updated;
    res.json({ message: 'Compte suspendu', user: userSafe });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/reactivate — réactiver un compte
router.patch('/users/:id/reactivate', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: false },
    });

    const { passwordHash, ...userSafe } = updated;
    res.json({ message: 'Compte réactivé', user: userSafe });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id — soft delete (marquer comme supprimé)
router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    if (user.role === 'ADMIN') {
      return res.status(403).json({ error: 'Impossible de supprimer un compte admin' });
    }

    await prisma.user.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), suspended: true },
    });

    res.json({ message: 'Compte supprimé (archivé)' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/deleted — liste des comptes supprimés
router.get('/users-deleted', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search;

    const where = { deletedAt: { not: null } };
    if (search) {
      where.OR = [
        { id: { startsWith: search } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, email: true, role: true, city: true, deletedAt: true, createdAt: true },
        orderBy: { deletedAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/restore — réactiver un compte supprimé
router.patch('/users/:id/restore', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (!user.deletedAt) return res.status(400).json({ error: 'Ce compte n\'est pas supprimé' });

    await prisma.user.update({
      where: { id: req.params.id },
      data: { deletedAt: null, suspended: false },
    });

    res.json({ message: 'Compte réactivé avec succès' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id/purge — suppression définitive (irréversible)
router.delete('/users/:id/purge', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, include: { professional: true } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (!user.deletedAt) return res.status(400).json({ error: 'Ce compte doit d\'abord être supprimé (soft delete) avant de pouvoir être purgé' });

    await prisma.$transaction(async (tx) => {
      if (user.professional) {
        const proId = user.professional.id;
        await tx.subscription.deleteMany({ where: { professionalId: proId } });
        await tx.follow.deleteMany({ where: { professionalId: proId } });
        await tx.profileView.deleteMany({ where: { professionalId: proId } });
        await tx.review.deleteMany({ where: { professionalId: proId } });
        const portfolioItems = await tx.portfolioItem.findMany({ where: { professionalId: proId }, select: { id: true } });
        if (portfolioItems.length > 0) {
          await tx.portfolioLike.deleteMany({ where: { portfolioItemId: { in: portfolioItems.map(p => p.id) } } });
        }
        await tx.portfolioItem.deleteMany({ where: { professionalId: proId } });
        const quotes = await tx.quote.findMany({ where: { professionalId: proId }, select: { id: true } });
        if (quotes.length > 0) {
          await tx.quoteItem.deleteMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });
          await tx.payment.deleteMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });
        }
        await tx.quote.deleteMany({ where: { professionalId: proId } });
        await tx.professional.delete({ where: { id: proId } });
      }

      await tx.portfolioLike.deleteMany({ where: { userId: req.params.id } });
      await tx.profileView.deleteMany({ where: { viewerId: req.params.id } });
      await tx.follow.deleteMany({ where: { followerId: req.params.id } });
      await tx.review.deleteMany({ where: { authorId: req.params.id } });
      await tx.message.deleteMany({ where: { OR: [{ senderId: req.params.id }, { receiverId: req.params.id }] } });
      const userTickets = await tx.supportTicket.findMany({ where: { userId: req.params.id }, select: { id: true } });
      if (userTickets.length > 0) {
        await tx.supportMessage.deleteMany({ where: { ticketId: { in: userTickets.map(t => t.id) } } });
        await tx.supportTicket.deleteMany({ where: { userId: req.params.id } });
      }

      const projects = await tx.project.findMany({ where: { clientId: req.params.id }, select: { id: true } });
      if (projects.length > 0) {
        const projectIds = projects.map(p => p.id);
        const projectQuotes = await tx.quote.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
        if (projectQuotes.length > 0) {
          await tx.quoteItem.deleteMany({ where: { quoteId: { in: projectQuotes.map(q => q.id) } } });
          await tx.payment.deleteMany({ where: { quoteId: { in: projectQuotes.map(q => q.id) } } });
        }
        await tx.quote.deleteMany({ where: { projectId: { in: projectIds } } });
        await tx.review.deleteMany({ where: { projectId: { in: projectIds } } });
        await tx.projectPhoto.deleteMany({ where: { projectId: { in: projectIds } } });
        await tx.project.deleteMany({ where: { clientId: req.params.id } });
      }

      await tx.user.delete({ where: { id: req.params.id } });
    });

    res.json({ message: 'Compte définitivement supprimé' });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/reset-password — réinitialiser le mot de passe
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Générer un mot de passe temporaire
    const tempPassword = crypto.randomBytes(6).toString('hex'); // 12 caractères
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash },
    });

    res.json({
      message: 'Mot de passe réinitialisé',
      temporaryPassword: tempPassword,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 3. GESTION DES PROFESSIONNELS
// ============================================================

// GET /api/admin/professionals — liste paginée avec filtres
router.get('/professionals', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { trade, city, identityStatus, premium, search } = req.query;

    const where = { user: { deletedAt: null } };

    if (search) {
      where.OR = [
        { user: { id: { startsWith: search } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { trade: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (trade) {
      where.trade = { contains: trade, mode: 'insensitive' };
    }

    if (city) {
      where.user = { ...(where.user || {}), city: { contains: city, mode: 'insensitive' } };
    }

    if (identityStatus && ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'].includes(identityStatus.toUpperCase())) {
      where.identityStatus = identityStatus.toUpperCase();
    }

    if (premium === 'true') {
      where.subscription = { status: 'ACTIVE' };
    } else if (premium === 'false') {
      where.OR = [
        { subscription: null },
        { subscription: { status: { not: 'ACTIVE' } } },
      ];
    }

    const [professionals, total] = await Promise.all([
      prisma.professional.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              phone: true,
              city: true,
              avatarUrl: true,
              phoneVerified: true,
              suspended: true,
              createdAt: true,
            },
          },
          portfolio: { select: { id: true } },
          subscription: { select: { status: true, expiresAt: true } },
        },
      }),
      prisma.professional.count({ where }),
    ]);

    const prosWithScore = professionals.map(p => ({
      ...p,
      trustScore: getTrustScoreBreakdown(p, {}),
    }));

    res.json({
      professionals: prosWithScore,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/professionals/:id — détail complet
router.get('/professionals/:id', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            city: true,
            avatarUrl: true,
            suspended: true,
            emailVerified: true,
            phoneVerified: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        portfolio: { orderBy: { createdAt: 'desc' } },
        reviews: {
          orderBy: { createdAt: 'desc' },
          include: { author: { select: { firstName: true, lastName: true } } },
        },
        quotes: { orderBy: { createdAt: 'desc' }, take: 20 },
        subscription: true,
      },
    });

    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    // Calcul enrichi du score de confiance
    const [quoteSentCount, quoteAcceptedCount, badReviewCount, goodReviewCount] = await Promise.all([
      prisma.quote.count({ where: { professionalId: professional.id } }),
      prisma.quote.count({ where: { professionalId: professional.id, status: 'ACCEPTED' } }),
      prisma.review.count({ where: { professionalId: professional.id, rating: { lt: 3 } } }),
      prisma.review.count({ where: { professionalId: professional.id, rating: { gte: 4 } } }),
    ]);
    const extras = { quoteSentCount, quoteAcceptedCount, badReviewCount, goodReviewCount };

    res.json({
      ...professional,
      trustScore: getTrustScoreBreakdown(professional, extras),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/professionals/:id/verify — valider l'identité
router.patch('/professionals/:id/verify', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const trialEndsAt = new Date();
    trialEndsAt.setMonth(trialEndsAt.getMonth() + 3);

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: {
        identityStatus: 'APPROVED',
        verifiedByAdmin: true,
        trialEndsAt: professional.trialEndsAt ? undefined : trialEndsAt,
      },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });

    res.json({ message: 'Identité vérifiée', professional: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/professionals/:id/reject — rejeter l'identité
router.patch('/professionals/:id/reject', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const { reason } = req.body;
    const rejectionReason = reason || 'Document non conforme';

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { identityStatus: 'REJECTED', identityRejectionReason: rejectionReason },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    // Notifier le professionnel par push
    await sendPushNotification(
      updated.user.id,
      'Vérification d\'identité refusée',
      `Motif : ${rejectionReason}. Vous pouvez soumettre de nouveaux documents.`,
      { type: 'identity_rejected', reason: rejectionReason }
    );

    res.json({ message: 'Identité rejetée', professional: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/professionals/:id/verify-decennale — valider l'assurance décennale
router.patch('/professionals/:id/verify-decennale', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { decennaleVerified: true },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });

    res.json({ message: 'Assurance décennale vérifiée', professional: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/professionals/:id/complaint — enregistrer une plainte
router.post('/professionals/:id/complaint', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { complaintsCount: { increment: 1 } },
    });

    res.json({ message: 'Plainte enregistrée', complaintsCount: updated.complaintsCount });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/professionals/:id/complaint — retirer une plainte
router.delete('/professionals/:id/complaint', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });
    if (professional.complaintsCount <= 0) return res.status(400).json({ error: 'Aucune plainte à retirer' });

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { complaintsCount: { decrement: 1 } },
    });

    res.json({ message: 'Plainte retirée', complaintsCount: updated.complaintsCount });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/professionals/:id/suspend — suspendre un professionnel
router.patch('/professionals/:id/suspend', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const updated = await prisma.user.update({
      where: { id: professional.userId },
      data: { suspended: true },
    });

    const { passwordHash, ...userSafe } = updated;
    res.json({ message: 'Professionnel suspendu', user: userSafe });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/professionals/:id/reactivate — réactiver un professionnel
router.patch('/professionals/:id/reactivate', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const updated = await prisma.user.update({
      where: { id: professional.userId },
      data: { suspended: false },
    });

    const { passwordHash, ...userSafe } = updated;
    res.json({ message: 'Professionnel réactivé', user: userSafe });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/professionals/:id — supprimer un professionnel
router.delete('/professionals/:id', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    await prisma.$transaction(async (tx) => {
      const proId = req.params.id;
      await tx.subscription.deleteMany({ where: { professionalId: proId } });
      await tx.follow.deleteMany({ where: { professionalId: proId } });
      await tx.profileView.deleteMany({ where: { professionalId: proId } });
      await tx.review.deleteMany({ where: { professionalId: proId } });
      const portfolioItems = await tx.portfolioItem.findMany({ where: { professionalId: proId }, select: { id: true } });
      if (portfolioItems.length > 0) {
        await tx.portfolioLike.deleteMany({ where: { portfolioItemId: { in: portfolioItems.map(p => p.id) } } });
      }
      await tx.portfolioItem.deleteMany({ where: { professionalId: proId } });
      const quotes = await tx.quote.findMany({ where: { professionalId: proId }, select: { id: true } });
      if (quotes.length > 0) {
        await tx.payment.deleteMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });
      }
      await tx.quote.deleteMany({ where: { professionalId: proId } });
      await tx.professional.delete({ where: { id: proId } });
    });

    res.json({ message: 'Profil professionnel supprimé' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 4. GESTION DES PROJETS
// ============================================================

// GET /api/admin/projects — liste paginée avec filtres
router.get('/projects', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { status, trade, city, search } = req.query;

    const where = {};
    if (status) where.status = status;
    if (trade) where.tradeNeeded = trade;
    if (city) where.city = city;
    if (search) {
      where.OR = [
        { id: { startsWith: search } },
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { client: { firstName: { contains: search, mode: 'insensitive' } } },
        { client: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true, city: true } },
          photos: true,
          quotes: {
            include: { professional: { include: { user: { select: { firstName: true, lastName: true } } } } },
          },
          review: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.project.count({ where }),
    ]);

    res.json({ projects, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/projects/:id — détail d'un projet
router.get('/projects/:id', async (req, res, next) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, city: true } },
        photos: true,
        quotes: {
          include: {
            professional: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
            payment: true,
          },
        },
        review: { include: { author: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!project) return res.status(404).json({ error: 'Projet introuvable' });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/projects/:id — modifier le statut d'un projet
router.patch('/projects/:id', async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/projects/:id — supprimer un projet
router.delete('/projects/:id', async (req, res, next) => {
  try {
    await prisma.quote.deleteMany({ where: { projectId: req.params.id } });
    await prisma.projectPhoto.deleteMany({ where: { projectId: req.params.id } });
    await prisma.review.deleteMany({ where: { projectId: req.params.id } });
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 5. GESTION DES PAIEMENTS
// ============================================================

// GET /api/admin/payments — liste paginée avec filtres
router.get('/payments', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { status, dateFrom, dateTo, amountMin, amountMax, search, isDeposit } = req.query;

    const where = {};

    if (isDeposit !== undefined) {
      where.isDeposit = isDeposit === 'true';
    }

    if (search) {
      where.OR = [
        { id: { startsWith: search } },
        { quote: { professional: { user: { firstName: { contains: search, mode: 'insensitive' } } } } },
        { quote: { professional: { user: { lastName: { contains: search, mode: 'insensitive' } } } } },
        { quote: { project: { title: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    if (amountMin || amountMax) {
      where.amount = {};
      if (amountMin) where.amount.gte = parseFloat(amountMin);
      if (amountMax) where.amount.lte = parseFloat(amountMax);
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          quote: {
            select: {
              id: true,
              amount: true,
              status: true,
              project: { select: { id: true, title: true, clientId: true } },
              professional: {
                select: {
                  id: true,
                  user: { select: { firstName: true, lastName: true, email: true } },
                },
              },
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({
      payments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/stats — statistiques de paiement
router.get('/payments/stats', async (req, res, next) => {
  try {
    // CA total (paiements réussis)
    const totalRevenueAgg = await prisma.payment.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { status: 'succeeded' },
    });

    // Paiements échoués
    const failedPayments = await prisma.payment.count({
      where: { status: 'failed' },
    });

    // CA par mois (12 derniers mois)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const monthlyPayments = await prisma.payment.findMany({
      where: {
        status: 'succeeded',
        createdAt: { gte: twelveMonthsAgo },
      },
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Grouper par mois
    const revenueByMonth = {};
    for (const payment of monthlyPayments) {
      const key = `${payment.createdAt.getFullYear()}-${String(payment.createdAt.getMonth() + 1).padStart(2, '0')}`;
      revenueByMonth[key] = (revenueByMonth[key] || 0) + payment.amount;
    }

    res.json({
      totalRevenue: totalRevenueAgg._sum.amount || 0,
      totalSuccessfulPayments: totalRevenueAgg._count,
      failedPayments,
      revenueByMonth,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/:id — détail d'un paiement
router.get('/payments/:id', async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: {
        quote: {
          include: {
            project: {
              include: {
                client: {
                  select: { id: true, firstName: true, lastName: true, email: true },
                },
              },
            },
            professional: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, email: true } },
              },
            },
          },
        },
      },
    });

    if (!payment) return res.status(404).json({ error: 'Paiement non trouvé' });

    res.json(payment);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/:id/audit-logs — journal d'audit d'un paiement
router.get('/payments/:id/audit-logs', async (req, res, next) => {
  try {
    const logs = await prisma.paymentAuditLog.findMany({
      where: { paymentId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/audit-logs — journal global (tous paiements, paginé)
router.get('/audit-logs', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const { triggeredBy, reason } = req.query;

    const where = {};
    if (triggeredBy) where.triggeredBy = triggeredBy;
    if (reason) where.reason = { contains: reason, mode: 'insensitive' };

    const [logs, total] = await Promise.all([
      prisma.paymentAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          payment: {
            select: {
              id: true,
              amount: true,
              isDeposit: true,
              geniuspayRef: true,
              quote: {
                select: {
                  project: { select: { title: true } },
                  professional: {
                    select: { user: { select: { firstName: true, lastName: true } } },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.paymentAuditLog.count({ where }),
    ]);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 6. SUPPORT / TICKETS
// ============================================================

// GET /api/admin/support/tickets — tous les tickets
router.get('/support/tickets', async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) where.status = status;

    const tickets = await prisma.supportTicket.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    res.json({ tickets });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/support/tickets/:id — détail ticket
router.get('/support/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true, avatarUrl: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket non trouvé' });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/support/tickets/:id/reply — répondre à un ticket
router.post('/support/tickets/:id/reply', async (req, res, next) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket non trouvé' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const msg = await prisma.supportMessage.create({
      data: { ticketId: ticket.id, senderId: req.user.id, content: message, isAdmin: true },
    });

    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: 'IN_PROGRESS' } });

    // Notifier l'utilisateur
    await sendPushNotification(
      ticket.userId,
      'Réponse du support',
      message.length > 80 ? message.substring(0, 80) + '...' : message,
      { type: 'support_reply', ticketId: ticket.id }
    );

    res.status(201).json(msg);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/support/tickets/:id/status — changer le statut
router.patch('/support/tickets/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    const ticket = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { status },
    });

    if (status === 'RESOLVED') {
      await sendPushNotification(
        ticket.userId,
        'Ticket résolu',
        'Votre demande d\'assistance a été traitée.',
        { type: 'support_resolved', ticketId: ticket.id }
      );
    }

    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// FINANCES & REVENUS
// ══════════════════════════════════════════════════════════════

const COMMISSION_RATE = 0.08; // 8%

// GET /api/admin/finances/summary — résumé financier global
router.get('/finances/summary', async (req, res, next) => {
  try {
    // Paiements réussis
    const payments = await prisma.payment.findMany({
      where: { status: 'succeeded' },
      include: {
        quote: {
          include: {
            professional: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
            project: { select: { title: true } },
          },
        },
      },
      orderBy: { completedAt: 'desc' },
    });

    const totalTransactions = payments.reduce((s, p) => s + p.amount, 0);
    const totalCommissions = totalTransactions * COMMISSION_RATE;
    const commissionsDues = payments
      .filter(p => !p.commissionPaid)
      .reduce((s, p) => s + p.amount * COMMISSION_RATE, 0);
    const commissionsPercues = payments
      .filter(p => p.commissionPaid)
      .reduce((s, p) => s + p.amount * COMMISSION_RATE, 0);

    // Abonnements actifs
    const activeSubscriptions = await prisma.subscription.count({ where: { status: 'ACTIVE' } });
    const subRevenue = activeSubscriptions * 5000; // 5 000 FCFA/mois estimé

    // Revenus par mois (12 derniers mois)
    const now = new Date();
    const revenueByMonth = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      revenueByMonth[key] = { transactions: 0, commissions: 0 };
    }

    for (const p of payments) {
      const d = new Date(p.completedAt || p.createdAt);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (revenueByMonth[key] !== undefined) {
        revenueByMonth[key].transactions += p.amount;
        revenueByMonth[key].commissions += p.amount * COMMISSION_RATE;
      }
    }

    res.json({
      commissionRate: COMMISSION_RATE,
      totalTransactions,
      totalCommissions,
      commissionsDues,
      commissionsPercues,
      activeSubscriptions,
      estimatedSubRevenue: subRevenue,
      revenueByMonth,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/finances/commissions — commissions par professionnel (paginé)
router.get('/finances/commissions', async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Grouper les paiements réussis par professionnel
    const allPayments = await prisma.payment.findMany({
      where: { status: 'succeeded' },
      include: {
        quote: {
          include: {
            professional: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, city: true } },
                subscription: { select: { status: true, tier: true } },
              },
            },
            project: { select: { title: true, id: true } },
          },
        },
      },
      orderBy: { completedAt: 'desc' },
    });

    // Construire un index par professionnel
    const proMap = {};
    for (const p of allPayments) {
      const pro = p.quote?.professional;
      if (!pro) continue;
      const pid = pro.id;
      if (!proMap[pid]) {
        proMap[pid] = {
          professionalId: pid,
          user: pro.user,
          trade: pro.trade,
          subscription: pro.subscription,
          totalTransactions: 0,
          totalCommission: 0,
          commissionDue: 0,
          commissionPaid: 0,
          payments: [],
        };
      }
      const commission = p.amount * COMMISSION_RATE;
      proMap[pid].totalTransactions += p.amount;
      proMap[pid].totalCommission += commission;
      if (p.commissionPaid) {
        proMap[pid].commissionPaid += commission;
      } else {
        proMap[pid].commissionDue += commission;
      }
      proMap[pid].payments.push({
        id: p.id,
        amount: p.amount,
        commission,
        isDeposit: p.isDeposit,
        commissionPaid: p.commissionPaid,
        projectTitle: p.quote?.project?.title || '',
        createdAt: p.createdAt,
        completedAt: p.completedAt,
      });
    }

    let rows = Object.values(proMap);

    // Filtres
    if (status === 'due') rows = rows.filter(r => r.commissionDue > 0);
    if (status === 'paid') rows = rows.filter(r => r.commissionDue === 0);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        (r.user.firstName + ' ' + r.user.lastName).toLowerCase().includes(q) ||
        r.user.email.toLowerCase().includes(q)
      );
    }

    // Trier par commission due décroissante
    rows.sort((a, b) => b.commissionDue - a.commissionDue);

    const total = rows.length;
    const paged = rows.slice(skip, skip + Number(limit));

    res.json({ professionals: paged, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/finances/commissions/:professionalId/mark-paid — marquer toutes les commissions d'un pro comme payées
router.patch('/finances/commissions/:professionalId/mark-paid', async (req, res, next) => {
  try {
    const { professionalId } = req.params;

    // Récupérer tous les paiements réussis de ce pro avec commissionPaid=false
    const payments = await prisma.payment.findMany({
      where: {
        status: 'succeeded',
        commissionPaid: false,
        quote: { professionalId },
      },
    });

    if (payments.length === 0) {
      return res.status(400).json({ error: 'Aucune commission en attente pour ce professionnel' });
    }

    await prisma.payment.updateMany({
      where: {
        status: 'succeeded',
        commissionPaid: false,
        quote: { professionalId },
      },
      data: { commissionPaid: true },
    });

    const totalMarked = payments.reduce((s, p) => s + p.amount * COMMISSION_RATE, 0);

    res.json({ success: true, count: payments.length, totalMarked });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/finances/payments/:paymentId/mark-paid — marquer une commission individuelle comme payée
router.patch('/finances/payments/:paymentId/mark-paid', async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId } });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.status !== 'succeeded') return res.status(400).json({ error: 'Seuls les paiements réussis ont des commissions' });

    const updated = await prisma.payment.update({
      where: { id: req.params.paymentId },
      data: { commissionPaid: !payment.commissionPaid },
    });

    res.json({ success: true, commissionPaid: updated.commissionPaid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
