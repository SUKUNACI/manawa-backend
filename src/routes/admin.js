const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushNotification, sendPushToMultiple } = require('../config/pushNotifications');
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

// ══════════════════════════════════════════════════════════════
// MODÉRATION DE CONTENU
// ══════════════════════════════════════════════════════════════

// GET /api/admin/moderation/reports — liste paginée des signalements
router.get('/moderation/reports', async (req, res, next) => {
  try {
    const { status = 'PENDING', contentType, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const where = {};
    if (status) where.status = status;
    if (contentType) where.contentType = contentType;

    const [reports, total] = await Promise.all([
      prisma.contentReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
        include: {
          reporter: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      prisma.contentReport.count({ where }),
    ]);

    // Enrichir chaque signalement avec le contenu ciblé
    const enriched = await Promise.all(reports.map(async (r) => {
      let content = null;
      try {
        if (r.contentType === 'REVIEW') {
          const rev = await prisma.review.findUnique({
            where: { id: r.contentId },
            include: {
              author: { select: { firstName: true, lastName: true, email: true } },
              professional: { include: { user: { select: { firstName: true, lastName: true } } } },
            },
          });
          if (rev) content = {
            text: rev.comment || '(sans commentaire)',
            rating: rev.rating,
            authorName: (rev.author.firstName || '') + ' ' + (rev.author.lastName || ''),
            authorEmail: rev.author.email,
            targetName: (rev.professional.user.firstName || '') + ' ' + (rev.professional.user.lastName || ''),
          };
        } else if (r.contentType === 'COMMENT') {
          const com = await prisma.portfolioComment.findUnique({
            where: { id: r.contentId },
            include: { author: { select: { firstName: true, lastName: true, email: true } } },
          });
          if (com) content = {
            text: com.content,
            rating: com.rating,
            authorName: (com.author.firstName || '') + ' ' + (com.author.lastName || ''),
            authorEmail: com.author.email,
          };
        } else if (r.contentType === 'PORTFOLIO') {
          const pp = await prisma.portfolioProject.findUnique({
            where: { id: r.contentId },
            include: { professional: { include: { user: { select: { firstName: true, lastName: true, email: true } } } } },
          });
          if (pp) content = {
            text: pp.title + ' — ' + pp.description,
            authorName: (pp.professional.user.firstName || '') + ' ' + (pp.professional.user.lastName || ''),
            authorEmail: pp.professional.user.email,
          };
        }
      } catch (_) {}
      return { ...r, content };
    }));

    res.json({ reports: enriched, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/moderation/stats — compteurs par statut
router.get('/moderation/stats', async (req, res, next) => {
  try {
    const [pending, dismissed, removed, byType] = await Promise.all([
      prisma.contentReport.count({ where: { status: 'PENDING' } }),
      prisma.contentReport.count({ where: { status: 'DISMISSED' } }),
      prisma.contentReport.count({ where: { status: 'REMOVED' } }),
      prisma.contentReport.groupBy({ by: ['contentType'], _count: { _all: true } }),
    ]);
    res.json({
      pending, dismissed, removed,
      total: pending + dismissed + removed,
      byType: Object.fromEntries(byType.map(b => [b.contentType, b._count._all])),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/moderation/reports/:id/dismiss — ignorer le signalement
router.patch('/moderation/reports/:id/dismiss', async (req, res, next) => {
  try {
    const report = await prisma.contentReport.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: 'Signalement introuvable' });

    await prisma.contentReport.update({
      where: { id: req.params.id },
      data: { status: 'DISMISSED', resolvedBy: req.user.id, resolvedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/moderation/reports/:id/remove — supprimer le contenu signalé
router.patch('/moderation/reports/:id/remove', async (req, res, next) => {
  try {
    const report = await prisma.contentReport.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: 'Signalement introuvable' });

    // Supprimer le contenu selon son type
    try {
      if (report.contentType === 'REVIEW') {
        const rev = await prisma.review.findUnique({ where: { id: report.contentId } });
        if (rev) {
          await prisma.review.delete({ where: { id: report.contentId } });
          // Recalculer la note moyenne du pro
          const agg = await prisma.review.aggregate({
            where: { professionalId: rev.professionalId },
            _avg: { rating: true },
            _count: true,
          });
          await prisma.professional.update({
            where: { id: rev.professionalId },
            data: { averageRating: agg._avg.rating || 0, reviewCount: agg._count },
          });
        }
      } else if (report.contentType === 'COMMENT') {
        await prisma.portfolioComment.delete({ where: { id: report.contentId } });
      } else if (report.contentType === 'PORTFOLIO') {
        await prisma.portfolioProject.delete({ where: { id: report.contentId } });
      }
    } catch (_) {
      // Contenu déjà supprimé — on marque quand même le signalement
    }

    // Marquer tous les signalements pendants de ce contenu comme traités
    await prisma.contentReport.updateMany({
      where: { contentType: report.contentType, contentId: report.contentId, status: 'PENDING' },
      data: { status: 'REMOVED', resolvedBy: req.user.id, resolvedAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// ANALYTICS MÉTIER
// ══════════════════════════════════════════════════════════════

// GET /api/admin/analytics — données analytiques complètes
router.get('/analytics', async (req, res, next) => {
  try {
    // ── Entonnoir de conversion ──────────────────────────────
    const [
      totalProjects,
      projectsWithQuote,
      acceptedQuotes,
      paidProjects,
      totalClients,
      clientsWithMultipleProjects,
    ] = await Promise.all([
      prisma.project.count(),
      prisma.project.count({ where: { quotes: { some: {} } } }),
      prisma.quote.count({ where: { status: 'ACCEPTED' } }),
      prisma.payment.count({ where: { status: 'succeeded', isDeposit: true } }),
      prisma.user.count({ where: { role: 'CLIENT' } }),
      // Clients ayant posté >1 projet
      prisma.user.count({
        where: {
          role: 'CLIENT',
          projects: { some: {} },
        },
      }),
    ]);

    // Clients avec ≥2 projets (fidélisation)
    const clientProjectCounts = await prisma.project.groupBy({
      by: ['clientId'],
      _count: { _all: true },
      having: { clientId: { _count: { gt: 1 } } },
    });
    const repeatClients = clientProjectCounts.length;
    const clientsWithProjects = await prisma.user.count({
      where: { role: 'CLIENT', projects: { some: {} } },
    });

    // ── Top 10 métiers ───────────────────────────────────────
    const tradeStats = await prisma.project.groupBy({
      by: ['tradeNeeded'],
      _count: { _all: true },
      orderBy: { _count: { tradeNeeded: 'desc' } },
      take: 10,
    });

    // Pour chaque métier : CA total (paiements succeeded liés aux projets de ce métier)
    const tradeRevenue = await Promise.all(
      tradeStats.map(async (t) => {
        const agg = await prisma.payment.aggregate({
          where: {
            status: 'succeeded',
            quote: { project: { tradeNeeded: t.tradeNeeded } },
          },
          _sum: { amount: true },
        });
        const completed = await prisma.project.count({
          where: { tradeNeeded: t.tradeNeeded, status: 'COMPLETED' },
        });
        return {
          trade: t.tradeNeeded,
          projectCount: t._count._all,
          revenue: agg._sum.amount || 0,
          completedCount: completed,
          completionRate: t._count._all > 0 ? Math.round((completed / t._count._all) * 100) : 0,
        };
      })
    );

    // ── Top 10 pros par CA ───────────────────────────────────
    const proRevenueRaw = await prisma.payment.groupBy({
      by: ['quoteId'],
      where: { status: 'succeeded' },
      _sum: { amount: true },
    });

    // Agréger par professionnel
    const proRevMap = {};
    for (const row of proRevenueRaw) {
      const quote = await prisma.quote.findUnique({
        where: { id: row.quoteId },
        select: {
          professionalId: true,
          professional: {
            select: {
              trade: true,
              user: { select: { firstName: true, lastName: true, email: true, avatarUrl: true } },
            },
          },
        },
      });
      if (!quote) continue;
      const pid = quote.professionalId;
      if (!proRevMap[pid]) {
        proRevMap[pid] = {
          professionalId: pid,
          name: (quote.professional.user.firstName || '') + ' ' + (quote.professional.user.lastName || ''),
          email: quote.professional.user.email,
          trade: quote.professional.trade,
          revenue: 0,
          paymentCount: 0,
        };
      }
      proRevMap[pid].revenue += row._sum.amount || 0;
      proRevMap[pid].paymentCount += 1;
    }
    const topPros = Object.values(proRevMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // ── Répartition géographique ─────────────────────────────
    const cityStats = await prisma.project.groupBy({
      by: ['city'],
      _count: { _all: true },
      orderBy: { _count: { city: 'desc' } },
      take: 10,
      where: { city: { not: '' } },
    });

    // ── Délai moyen projet → premier devis (en jours) ────────
    const projectsWithFirstQuote = await prisma.project.findMany({
      where: { quotes: { some: {} } },
      select: {
        createdAt: true,
        quotes: { orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
      },
      take: 500,
    });

    let totalDelayDays = 0;
    let delayCount = 0;
    for (const p of projectsWithFirstQuote) {
      if (p.quotes.length > 0) {
        const diff = new Date(p.quotes[0].createdAt) - new Date(p.createdAt);
        totalDelayDays += diff / (1000 * 60 * 60 * 24);
        delayCount++;
      }
    }
    const avgDaysToFirstQuote = delayCount > 0 ? Math.round(totalDelayDays / delayCount) : 0;

    // ── Nouveaux inscrits par mois (12 mois) ─────────────────
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const newUsersRaw = await prisma.user.findMany({
      where: { createdAt: { gte: twelveMonthsAgo } },
      select: { createdAt: true, role: true },
    });

    const growthByMonth = {};
    for (const u of newUsersRaw) {
      const d = new Date(u.createdAt);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!growthByMonth[key]) growthByMonth[key] = { clients: 0, professionals: 0 };
      if (u.role === 'CLIENT') growthByMonth[key].clients++;
      else if (u.role === 'PROFESSIONAL') growthByMonth[key].professionals++;
    }

    // ── Taux d'acceptation des devis ─────────────────────────
    const [totalQuotesSent, quotesAccepted, quotesRefused] = await Promise.all([
      prisma.quote.count(),
      prisma.quote.count({ where: { status: 'ACCEPTED' } }),
      prisma.quote.count({ where: { status: 'REFUSED' } }),
    ]);

    res.json({
      funnel: {
        totalProjects,
        projectsWithQuote,
        acceptedQuotes,
        paidProjects,
        quoteRate: totalProjects > 0 ? Math.round((projectsWithQuote / totalProjects) * 100) : 0,
        acceptanceRate: projectsWithQuote > 0 ? Math.round((acceptedQuotes / projectsWithQuote) * 100) : 0,
        paymentRate: acceptedQuotes > 0 ? Math.round((paidProjects / acceptedQuotes) * 100) : 0,
        overallConversion: totalProjects > 0 ? Math.round((paidProjects / totalProjects) * 100) : 0,
      },
      quotes: {
        total: totalQuotesSent,
        accepted: quotesAccepted,
        refused: quotesRefused,
        pending: totalQuotesSent - quotesAccepted - quotesRefused,
        acceptanceRate: totalQuotesSent > 0 ? Math.round((quotesAccepted / totalQuotesSent) * 100) : 0,
      },
      retention: {
        totalClients,
        clientsWithProjects,
        repeatClients,
        retentionRate: clientsWithProjects > 0 ? Math.round((repeatClients / clientsWithProjects) * 100) : 0,
      },
      avgDaysToFirstQuote,
      tradeStats: tradeRevenue,
      topPros,
      cityStats: cityStats.map(c => ({ city: c.city, count: c._count._all })),
      growthByMonth,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────
// SÉCURITÉ & CONFORMITÉ
// ──────────────────────────────────────────────────────────────

// GET /api/admin/security/stats
router.get('/security/stats', async (req, res, next) => {
  try {
    const now = new Date();
    const oneHourAgo   = new Date(now.getTime() - 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);

    const [
      suspendedCount,
      archivedCount,
      emailUnverified,
      emailUnverified30d,
      resetActive,
      resetStale,       // resets actifs depuis >1h (risque potentiel)
      otpOrphans,       // phoneOtpCode présent mais expiré
      recentAdminActions,
      reportsPending,
      disputesOpen,
    ] = await Promise.all([
      prisma.user.count({ where: { suspended: true, deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: { not: null } } }),
      prisma.user.count({ where: { emailVerified: false, deletedAt: null } }),
      // Inscrits depuis >30j avec email non vérifié
      prisma.user.count({ where: { emailVerified: false, deletedAt: null, createdAt: { lt: thirtyDaysAgo } } }),
      // Resets actifs (code présent + pas encore expiré)
      prisma.user.count({ where: { passwordResetCode: { not: null }, passwordResetExpiry: { gt: now }, deletedAt: null } }),
      // Resets émis depuis >1h mais encore valides (code envoyé mais pas utilisé)
      prisma.user.count({ where: { passwordResetCode: { not: null }, passwordResetExpiry: { gt: now }, updatedAt: { lt: oneHourAgo }, deletedAt: null } }),
      // OTP téléphone présent mais expiré (non nettoyé)
      prisma.user.count({ where: { phoneOtpCode: { not: null }, phoneOtpExpiry: { lt: now }, deletedAt: null } }),
      // Actions admin récentes = BroadcastLog + disputes résolues + signalements résolus (7j)
      Promise.all([
        prisma.broadcastLog.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        prisma.dispute.count({ where: { resolvedAt: { gte: sevenDaysAgo } } }),
        prisma.contentReport.count({ where: { resolvedAt: { gte: sevenDaysAgo } } }),
      ]).then(([b, d, c]) => b + d + c),
      prisma.contentReport.count({ where: { status: 'PENDING' } }),
      prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
    ]);

    res.json({
      suspendedCount,
      archivedCount,
      emailUnverified,
      emailUnverified30d,
      resetActive,
      resetStale,
      otpOrphans,
      recentAdminActions,
      reportsPending,
      disputesOpen,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/security/suspended — comptes suspendus paginés
router.get('/security/suspended', async (req, res, next) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const where = { suspended: true, deletedAt: null };
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName:  { contains: search, mode: 'insensitive' } },
        { email:     { contains: search, mode: 'insensitive' } },
      ];
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, email: true, role: true, city: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        skip, take: Number(limit),
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) { next(err); }
});

// GET /api/admin/security/alerts — alertes sécurité
router.get('/security/alerts', async (req, res, next) => {
  try {
    const now = new Date();
    const oneHourAgo    = new Date(now.getTime() - 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [staleResets, unverifiedOld, otpOrphans] = await Promise.all([
      // Resets de mdp non utilisés depuis >1h mais encore valides
      prisma.user.findMany({
        where: { passwordResetCode: { not: null }, passwordResetExpiry: { gt: now }, updatedAt: { lt: oneHourAgo }, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 30,
      }),
      // Emails non vérifiés depuis >30j
      prisma.user.findMany({
        where: { emailVerified: false, deletedAt: null, createdAt: { lt: thirtyDaysAgo } },
        select: { id: true, firstName: true, lastName: true, email: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 30,
      }),
      // OTP téléphone présent mais expiré
      prisma.user.findMany({
        where: { phoneOtpCode: { not: null }, phoneOtpExpiry: { lt: now }, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true },
        take: 20,
      }),
    ]);

    res.json({ staleResets, unverifiedOld, otpOrphans });
  } catch (err) { next(err); }
});

// GET /api/admin/security/activity — journal des actions admin récentes
router.get('/security/activity', async (req, res, next) => {
  try {
    const { limit = 30 } = req.query;
    const take = Math.min(100, Number(limit));

    const [broadcasts, disputes, reports, auditLogs] = await Promise.all([
      prisma.broadcastLog.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, adminId: true, title: true, target: true, sent: true, total: true, createdAt: true },
      }),
      prisma.dispute.findMany({
        where: { resolvedAt: { not: null } },
        orderBy: { resolvedAt: 'desc' },
        take,
        select: { id: true, resolvedBy: true, status: true, refundAmount: true, resolvedAt: true, reason: true },
      }),
      prisma.contentReport.findMany({
        where: { status: { not: 'PENDING' }, resolvedAt: { not: null } },
        orderBy: { resolvedAt: 'desc' },
        take,
        select: { id: true, resolvedBy: true, status: true, contentType: true, reason: true, resolvedAt: true },
      }),
      prisma.paymentAuditLog.findMany({
        where: { triggeredBy: { not: 'system' }, triggeredBy: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: Math.min(take, 20),
        select: { id: true, triggeredBy: true, fromStatus: true, toStatus: true, reason: true, createdAt: true, payment: { select: { amount: true } } },
      }),
    ]);

    // Fusionner et trier par date décroissante
    const events = [
      ...broadcasts.map(b => ({
        type: 'broadcast', date: b.createdAt,
        actor: b.adminId,
        summary: 'Broadcast "' + b.title + '" → ' + b.target + ' (' + b.sent + '/' + b.total + ' envoyés)',
      })),
      ...disputes.map(d => ({
        type: 'dispute', date: d.resolvedAt,
        actor: d.resolvedBy,
        summary: 'Litige résolu : ' + d.status + (d.refundAmount ? ' (' + d.refundAmount + ' FCFA remboursés)' : ''),
      })),
      ...reports.map(r => ({
        type: 'report', date: r.resolvedAt,
        actor: r.resolvedBy,
        summary: 'Signalement ' + r.contentType + ' : ' + r.status + ' — ' + r.reason,
      })),
      ...auditLogs.map(a => ({
        type: 'payment', date: a.createdAt,
        actor: a.triggeredBy,
        summary: 'Paiement ' + a.fromStatus + ' → ' + a.toStatus + (a.payment?.amount ? ' (' + a.payment.amount + ' FCFA)' : ''),
      })),
    ]
      .filter(e => e.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, take);

    res.json({ events });
  } catch (err) { next(err); }
});

// POST /api/admin/security/clean-otps — nettoyer les OTP expirés
router.post('/security/clean-otps', async (req, res, next) => {
  try {
    const now = new Date();
    const [otpResult, resetResult] = await Promise.all([
      prisma.user.updateMany({
        where: { phoneOtpCode: { not: null }, phoneOtpExpiry: { lt: now } },
        data: { phoneOtpCode: null, phoneOtpExpiry: null },
      }),
      prisma.user.updateMany({
        where: { passwordResetCode: { not: null }, passwordResetExpiry: { lt: now } },
        data: { passwordResetCode: null, passwordResetExpiry: null },
      }),
    ]);
    res.json({ cleaned: otpResult.count + resetResult.count, otpCleaned: otpResult.count, resetCleaned: resetResult.count });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────
// MARCHÉ & OPPORTUNITÉS
// ──────────────────────────────────────────────────────────────

// GET /api/admin/market
router.get('/market', async (req, res, next) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── KPIs globaux ──────────────────────────────────────────
    const [
      totalOpenProjects,
      openWithoutQuote,
      openStale,          // OPEN depuis > 7j sans aucun devis
      avgBudgetAgg,
      totalPros,
      verifiedPros,
    ] = await Promise.all([
      prisma.project.count({ where: { status: 'OPEN' } }),
      prisma.project.count({ where: { status: 'OPEN', quotes: { none: {} } } }),
      prisma.project.count({
        where: { status: 'OPEN', createdAt: { lt: sevenDaysAgo }, quotes: { none: {} } },
      }),
      prisma.project.aggregate({
        _avg: { budgetMin: true, budgetMax: true },
        where: { budgetMin: { not: null } },
      }),
      prisma.professional.count(),
      prisma.professional.count({ where: { verifiedByAdmin: true } }),
    ]);

    // ── Demande vs offre par métier ───────────────────────────
    const [projectsByTrade, prosByTrade] = await Promise.all([
      prisma.project.groupBy({
        by: ['tradeNeeded'],
        _count: { _all: true },
        orderBy: { _count: { tradeNeeded: 'desc' } },
        take: 15,
      }),
      prisma.professional.groupBy({
        by: ['trade'],
        _count: { _all: true },
      }),
    ]);

    const prosByTradeMap = Object.fromEntries(prosByTrade.map(p => [p.trade, p._count._all]));
    const tradeBalance = projectsByTrade.map(t => ({
      trade:    t.tradeNeeded,
      demand:   t._count._all,
      supply:   prosByTradeMap[t.tradeNeeded] || 0,
      ratio:    prosByTradeMap[t.tradeNeeded]
        ? (t._count._all / prosByTradeMap[t.tradeNeeded]).toFixed(2)
        : null,
    }));

    // ── Budget moyen par métier (top 10) ─────────────────────
    const budgetByTrade = await prisma.project.groupBy({
      by: ['tradeNeeded'],
      _avg: { budgetMin: true, budgetMax: true },
      _count: { _all: true },
      where: { budgetMin: { not: null } },
      orderBy: { _count: { tradeNeeded: 'desc' } },
      take: 10,
    });

    // ── Répartition géographique projets OPEN ────────────────
    const [cityDemand, citySupply] = await Promise.all([
      prisma.project.groupBy({
        by: ['city'],
        _count: { _all: true },
        where: { status: 'OPEN', city: { not: '' } },
        orderBy: { _count: { city: 'desc' } },
        take: 15,
      }),
      prisma.professional.groupBy({
        by: ['city'],
        _count: { _all: true },
        where: { city: { not: null } },
      }).catch(() => []),
    ]);

    const citySupplyMap = Object.fromEntries(
      (citySupply || []).map(c => [c.city, c._count._all])
    );
    const cityMarket = cityDemand.map(c => ({
      city:   c.city,
      demand: c._count._all,
      supply: citySupplyMap[c.city] || 0,
    }));

    // ── Projets sans réponse publiés les 30 derniers jours ───
    const staleProjects = await prisma.project.findMany({
      where: { status: 'OPEN', createdAt: { lt: sevenDaysAgo, gte: thirtyDaysAgo }, quotes: { none: {} } },
      select: {
        id: true, title: true, tradeNeeded: true, city: true,
        budgetMin: true, budgetMax: true, createdAt: true,
        client: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    // ── Temps moyen avant premier devis (en heures) ──────────
    const quotedProjects = await prisma.project.findMany({
      where: { quotes: { some: {} } },
      select: {
        createdAt: true,
        quotes: { select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
    const delays = quotedProjects
      .filter(p => p.quotes.length > 0)
      .map(p => (new Date(p.quotes[0].createdAt) - new Date(p.createdAt)) / (1000 * 60 * 60));
    const avgHoursToFirstQuote = delays.length > 0
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : null;

    // ── Évolution projets OPEN par mois (12 mois) ────────────
    const projectsByMonth = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      projectsByMonth[key] = 0;
    }
    const recentProjects = await prisma.project.findMany({
      where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - 11, 1) } },
      select: { createdAt: true },
    });
    for (const p of recentProjects) {
      const d = new Date(p.createdAt);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (projectsByMonth[key] !== undefined) projectsByMonth[key]++;
    }

    res.json({
      kpis: {
        totalOpenProjects,
        openWithoutQuote,
        openStale,
        coverageRate: totalOpenProjects > 0
          ? Math.round(((totalOpenProjects - openWithoutQuote) / totalOpenProjects) * 100)
          : 0,
        avgBudgetMin: Math.round(avgBudgetAgg._avg.budgetMin || 0),
        avgBudgetMax: Math.round(avgBudgetAgg._avg.budgetMax || 0),
        avgHoursToFirstQuote,
        totalPros,
        verifiedPros,
      },
      tradeBalance,
      budgetByTrade: budgetByTrade.map(t => ({
        trade:    t.tradeNeeded,
        count:    t._count._all,
        avgMin:   Math.round(t._avg.budgetMin || 0),
        avgMax:   Math.round(t._avg.budgetMax || 0),
      })),
      cityMarket,
      staleProjects,
      projectsByMonth,
    });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────
// GESTION DES ABONNEMENTS
// ──────────────────────────────────────────────────────────────

const SUB_PRICES = { ESSENTIEL: 2500, PRO: 5000, ELITE: 10000 };

// GET /api/admin/subscriptions/stats
router.get('/subscriptions/stats', async (req, res, next) => {
  try {
    const now = new Date();
    const in7days  = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
    const in30days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalActive,
      byTier,
      expiringIn7d,
      expiringIn30d,
      newLast30d,
      cancelledLast30d,
      trialsActive,
    ] = await Promise.all([
      prisma.subscription.count({ where: { status: 'ACTIVE', expiresAt: { gt: now } } }),
      prisma.subscription.groupBy({
        by: ['tier'],
        where: { status: 'ACTIVE', expiresAt: { gt: now } },
        _count: { _all: true },
      }),
      prisma.subscription.count({ where: { status: 'ACTIVE', expiresAt: { gt: now, lt: in7days } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', expiresAt: { gt: now, lt: in30days } } }),
      prisma.subscription.count({ where: { createdAt: { gte: thirtyDaysAgo }, status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { updatedAt: { gte: thirtyDaysAgo }, status: 'INACTIVE' } }),
      prisma.professional.count({ where: { trialEndsAt: { gt: now } } }),
    ]);

    const tierMap = Object.fromEntries(byTier.map(t => [t.tier, t._count._all]));
    const estimatedRevenue = Object.entries(SUB_PRICES).reduce((sum, [tier, price]) => {
      return sum + (tierMap[tier] || 0) * price;
    }, 0);

    // Évolution mensuelle (12 mois)
    const monthlyGrowth = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      monthlyGrowth[key] = 0;
    }
    const activatedByMonth = await prisma.subscription.findMany({
      where: { status: 'ACTIVE', startedAt: { not: null } },
      select: { startedAt: true },
    });
    for (const s of activatedByMonth) {
      const d = new Date(s.startedAt);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (monthlyGrowth[key] !== undefined) monthlyGrowth[key]++;
    }

    res.json({
      totalActive,
      byTier: tierMap,
      estimatedRevenue,
      expiringIn7d,
      expiringIn30d,
      newLast30d,
      cancelledLast30d,
      trialsActive,
      monthlyGrowth,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/subscriptions
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { status = '', tier = '', search = '', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const now  = new Date();

    const where = {};
    if (status === 'ACTIVE')   { where.status = 'ACTIVE'; where.expiresAt = { gt: now }; }
    else if (status === 'EXPIRED') { where.OR = [{ status: 'INACTIVE' }, { expiresAt: { lte: now } }]; }
    else if (status === 'EXPIRING') { where.status = 'ACTIVE'; where.expiresAt = { gt: now, lt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) }; }
    if (tier) where.tier = tier;
    if (search) {
      where.professional = {
        user: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName:  { contains: search, mode: 'insensitive' } },
            { email:     { contains: search, mode: 'insensitive' } },
          ],
        },
      };
    }

    const [subs, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        include: {
          professional: {
            select: {
              id: true,
              trade: true,
              trialEndsAt: true,
              user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, city: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.subscription.count({ where }),
    ]);

    res.json({ subscriptions: subs, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) { next(err); }
});

// PATCH /api/admin/subscriptions/:professionalId — activer / changer tier / annuler
router.patch('/subscriptions/:professionalId', async (req, res, next) => {
  try {
    const { action, tier } = req.body;
    const proId = req.params.professionalId;

    const pro = await prisma.professional.findUnique({ where: { id: proId }, include: { subscription: true } });
    if (!pro) return res.status(404).json({ error: 'Professionnel introuvable' });

    if (action === 'activate') {
      if (!tier || !['ESSENTIEL', 'PRO', 'ELITE'].includes(tier)) return res.status(400).json({ error: 'Tier invalide' });
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);
      const updated = await prisma.subscription.upsert({
        where: { professionalId: proId },
        create: { professionalId: proId, tier, status: 'ACTIVE', startedAt: new Date(), expiresAt },
        update: { tier, status: 'ACTIVE', startedAt: new Date(), expiresAt },
      });
      return res.json({ success: true, subscription: updated });
    }

    if (action === 'cancel') {
      const updated = await prisma.subscription.update({
        where: { professionalId: proId },
        data: { status: 'INACTIVE' },
      });
      return res.json({ success: true, subscription: updated });
    }

    if (action === 'extend') {
      if (!pro.subscription) return res.status(400).json({ error: 'Aucun abonnement actif' });
      const base = pro.subscription.expiresAt && new Date(pro.subscription.expiresAt) > new Date()
        ? new Date(pro.subscription.expiresAt)
        : new Date();
      base.setMonth(base.getMonth() + 1);
      const updated = await prisma.subscription.update({
        where: { professionalId: proId },
        data: { expiresAt: base, status: 'ACTIVE' },
      });
      return res.json({ success: true, subscription: updated });
    }

    return res.status(400).json({ error: 'Action invalide (activate | cancel | extend)' });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────
// LITIGES & REMBOURSEMENTS
// ──────────────────────────────────────────────────────────────

const DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED_REFUND', 'RESOLVED_PARTIAL', 'RESOLVED_REJECTED'];

// GET /api/admin/disputes/stats
router.get('/disputes/stats', async (req, res, next) => {
  try {
    const [total, open, underReview, resolvedRefund, resolvedPartial, resolvedRejected, totalRefunded] = await Promise.all([
      prisma.dispute.count(),
      prisma.dispute.count({ where: { status: 'OPEN' } }),
      prisma.dispute.count({ where: { status: 'UNDER_REVIEW' } }),
      prisma.dispute.count({ where: { status: 'RESOLVED_REFUND' } }),
      prisma.dispute.count({ where: { status: 'RESOLVED_PARTIAL' } }),
      prisma.dispute.count({ where: { status: 'RESOLVED_REJECTED' } }),
      prisma.dispute.aggregate({ where: { status: { in: ['RESOLVED_REFUND', 'RESOLVED_PARTIAL'] } }, _sum: { refundAmount: true } }),
    ]);
    res.json({
      total,
      open,
      underReview,
      resolvedRefund,
      resolvedPartial,
      resolvedRejected,
      totalRefunded: totalRefunded._sum.refundAmount || 0,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/disputes
router.get('/disputes', async (req, res, next) => {
  try {
    const { status = '', search = '', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { client: { firstName: { contains: search, mode: 'insensitive' } } },
        { client: { lastName:  { contains: search, mode: 'insensitive' } } },
        { client: { email:     { contains: search, mode: 'insensitive' } } },
        { reason: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true } },
          payment: {
            include: {
              quote: {
                include: {
                  professional: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
                  project: { select: { title: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.dispute.count({ where }),
    ]);

    res.json({ disputes, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) { next(err); }
});

// GET /api/admin/disputes/:id
router.get('/disputes/:id', async (req, res, next) => {
  try {
    const dispute = await prisma.dispute.findUnique({
      where: { id: req.params.id },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        payment: {
          include: {
            quote: {
              include: {
                professional: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
                project: { select: { id: true, title: true, city: true } },
                items: true,
              },
            },
          },
        },
      },
    });
    if (!dispute) return res.status(404).json({ error: 'Litige introuvable' });
    res.json(dispute);
  } catch (err) { next(err); }
});

// PATCH /api/admin/disputes/:id/status — changer le statut (OPEN → UNDER_REVIEW…)
router.patch('/disputes/:id/status', async (req, res, next) => {
  try {
    const { status, adminNote, refundAmount } = req.body;
    if (!DISPUTE_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

    const data = { status, adminNote: adminNote || null, updatedAt: new Date() };
    if (['RESOLVED_REFUND', 'RESOLVED_PARTIAL', 'RESOLVED_REJECTED'].includes(status)) {
      data.resolvedBy = req.user.id;
      data.resolvedAt = new Date();
    }
    if (status === 'RESOLVED_REFUND' || status === 'RESOLVED_PARTIAL') {
      if (!refundAmount || refundAmount <= 0) return res.status(400).json({ error: 'Montant de remboursement requis' });
      data.refundAmount = Number(refundAmount);
    }

    const updated = await prisma.dispute.update({ where: { id: req.params.id }, data });
    res.json(updated);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────
// COMMUNICATION
// ──────────────────────────────────────────────────────────────

// GET /api/admin/communication/stats — métriques de communication
router.get('/communication/stats', async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalMessages,
      messagesLast30d,
      activeConversations,
      totalNotifications,
      notificationsLast30d,
      unreadNotifications,
      activeDevices,
      devicesByPlatform,
      broadcastCount,
    ] = await Promise.all([
      prisma.message.count(),
      prisma.message.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      // Conversations uniques (paires expéditeur/destinataire) sur 30j
      prisma.message.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { senderId: true, receiverId: true },
        distinct: ['senderId', 'receiverId'],
      }).then(rows => {
        const pairs = new Set(rows.map(r => [r.senderId, r.receiverId].sort().join('-')));
        return pairs.size;
      }),
      prisma.notification.count(),
      prisma.notification.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.notification.count({ where: { read: false } }),
      prisma.pushToken.count({ where: { isActive: true } }),
      prisma.pushToken.groupBy({ by: ['platform'], where: { isActive: true }, _count: { _all: true } }),
      prisma.broadcastLog.count(),
    ]);

    res.json({
      messages: {
        total: totalMessages,
        last30d: messagesLast30d,
        activeConversations,
      },
      notifications: {
        total: totalNotifications,
        last30d: notificationsLast30d,
        unread: unreadNotifications,
      },
      devices: {
        active: activeDevices,
        byPlatform: devicesByPlatform.map(d => ({ platform: d.platform, count: d._count._all })),
      },
      broadcasts: {
        total: broadcastCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/communication/broadcasts — historique des broadcasts
router.get('/communication/broadcasts', async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.broadcastLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.broadcastLog.count(),
    ]);

    res.json({ logs, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/communication/broadcast — envoyer une notification push
router.post('/communication/broadcast', async (req, res, next) => {
  try {
    const { title, body, target, targetUserId } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Titre et corps requis' });
    if (!['ALL', 'CLIENTS', 'PROFESSIONALS', 'USER'].includes(target)) {
      return res.status(400).json({ error: 'Cible invalide' });
    }
    if (target === 'USER' && !targetUserId) {
      return res.status(400).json({ error: 'targetUserId requis pour cible USER' });
    }

    let userIds = [];

    if (target === 'USER') {
      const u = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
      if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
      userIds = [targetUserId];
    } else {
      const where = target === 'ALL' ? {} : { role: target === 'CLIENTS' ? 'CLIENT' : 'PROFESSIONAL' };
      const users = await prisma.user.findMany({ where, select: { id: true } });
      userIds = users.map(u => u.id);
    }

    const result = await sendPushToMultiple(userIds, title, body, { type: 'BROADCAST' });

    // Sauvegarder dans l'historique
    await prisma.broadcastLog.create({
      data: {
        adminId: req.user.id,
        title,
        body,
        target,
        targetUserId: targetUserId || null,
        sent: result.sent,
        total: result.total,
      },
    });

    // Sauvegarder en base dans Notification pour chaque destinataire
    if (userIds.length <= 500) {
      await prisma.notification.createMany({
        data: userIds.map(uid => ({
          userId: uid,
          type: 'BROADCAST',
          title,
          body,
          read: false,
        })),
        skipDuplicates: true,
      });
    }

    res.json({
      success: true,
      sent: result.sent,
      total: result.total,
      target,
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// GESTION DES AVIS
// ══════════════════════════════════════════════════════════════

// GET /api/admin/reviews/stats
router.get('/reviews/stats', async (req, res, next) => {
  try {
    const [total, flagged, ratingGroups, avgAgg] = await Promise.all([
      prisma.review.count(),
      prisma.reviewFlag.groupBy({ by: ['reviewId'], _count: true }).then(r => r.length),
      prisma.review.groupBy({ by: ['rating'], _count: { _all: true }, orderBy: { rating: 'asc' } }),
      prisma.review.aggregate({ _avg: { rating: true } }),
    ]);

    // Taux de satisfaction : % d'avis >= 4 étoiles
    const positiveCount = ratingGroups.filter(g => g.rating >= 4).reduce((s, g) => s + g._count._all, 0);
    const satisfactionRate = total > 0 ? Math.round((positiveCount / total) * 100) : 0;

    // Distribution par note (1 à 5)
    const distribution = [1, 2, 3, 4, 5].map(r => {
      const found = ratingGroups.find(g => g.rating === r);
      return { rating: r, count: found ? found._count._all : 0 };
    });

    res.json({
      total,
      flagged,
      averageRating: avgAgg._avg.rating ? Math.round(avgAgg._avg.rating * 10) / 10 : 0,
      satisfactionRate,
      distribution,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reviews — liste paginée avec filtres
router.get('/reviews', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    const { rating, flagged, search } = req.query;

    // Construire le where
    const where = {};
    if (rating) where.rating = parseInt(rating);
    if (search) {
      where.OR = [
        { author: { firstName: { contains: search, mode: 'insensitive' } } },
        { author: { lastName: { contains: search, mode: 'insensitive' } } },
        { professional: { user: { firstName: { contains: search, mode: 'insensitive' } } } },
        { professional: { user: { lastName: { contains: search, mode: 'insensitive' } } } },
        { comment: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (flagged === 'true') {
      where.flags = { some: {} };
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          author: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          professional: {
            select: {
              id: true,
              averageRating: true,
              reviewCount: true,
              user: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
          project: { select: { id: true, title: true } },
          flags: { select: { id: true, flaggedBy: true, reason: true, createdAt: true } },
        },
      }),
      prisma.review.count({ where }),
    ]);

    res.json({ reviews, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/reviews/:id — supprimer un avis + recalculer
router.delete('/reviews/:id', async (req, res, next) => {
  try {
    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      select: { id: true, professionalId: true },
    });
    if (!review) return res.status(404).json({ error: 'Avis non trouvé' });

    // Supprimer (flags cascadent grâce à onDelete: Cascade sur ReviewFlag)
    await prisma.review.delete({ where: { id: req.params.id } });

    // Recalculer averageRating et reviewCount
    const agg = await prisma.review.aggregate({
      where: { professionalId: review.professionalId },
      _avg: { rating: true },
      _count: { _all: true },
    });

    await prisma.professional.update({
      where: { id: review.professionalId },
      data: {
        averageRating: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0,
        reviewCount: agg._count._all,
      },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/reviews/:id/flag — signaler ou retirer le flag
router.patch('/reviews/:id/flag', async (req, res, next) => {
  try {
    const { action, reason } = req.body; // action: 'add' | 'remove'
    const review = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!review) return res.status(404).json({ error: 'Avis non trouvé' });

    if (action === 'add') {
      const existing = await prisma.reviewFlag.findFirst({
        where: { reviewId: req.params.id, flaggedBy: req.user.id },
      });
      if (!existing) {
        await prisma.reviewFlag.create({
          data: { reviewId: req.params.id, flaggedBy: req.user.id, reason: reason || 'admin_manual' },
        });
      }
    } else if (action === 'remove') {
      await prisma.reviewFlag.deleteMany({ where: { reviewId: req.params.id } });
    } else {
      return res.status(400).json({ error: 'action doit être "add" ou "remove"' });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
