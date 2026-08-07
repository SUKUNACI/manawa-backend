const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { requireAuth, requireRole, requireSuperAdmin } = require('../middleware/auth');
const { sendPushNotification, sendPushToMultiple } = require('../config/pushNotifications');
const { computeTrustScore, getTrustScoreBreakdown } = require('../utils/trustScore');
const { getConfig, getAllConfig } = require('../utils/appConfig');
const { refundPayment } = require('../utils/geniuspay');

const router = express.Router();

const NAME_RE = /^[^<>&"'/\\]+$/;
function sanitizeName(value, field) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 50 || !NAME_RE.test(v)) return null;
  return v;
}

// Rate limiting global sur le router admin
const adminReadLimit = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de requêtes — réessayez dans une minute' } });
const adminWriteLimit = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de requêtes — réessayez dans une minute' } });
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return adminReadLimit(req, res, next);
  return adminWriteLimit(req, res, next);
});

// Tous les endpoints admin nécessitent authentification + rôle ADMIN
router.use(requireAuth, requireRole('ADMIN'));

// Vérification CSRF : pour toute opération d'écriture, le header X-CSRF-Token
// doit correspondre au cookie adminCsrf (Double Submit Cookie pattern)
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'test') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.adminCsrf;
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: 'Token CSRF invalide' });
  }
  next();
});

// Middleware de permissions granulaires pour les admins STANDARD
// Les super admins et les admins sans restrictions (adminPermissions === null) passent toujours.
const SECTION_PREFIXES = {
  'verif-id':      ['/professionals/', '/professionals'],
  'users-all':     ['/users-all', '/users'],
  'professionals': ['/professionals/', '/professionals'],
  'clients':       ['/users'],
  'projects':      ['/projects'],
  'payments':      ['/payments'],
  'audit':         ['/audit-logs'],
  'analytics':     ['/analytics'],
  'moderation':    ['/moderation'],
  'security':      ['/security'],
  'market':        ['/market'],
  'subscriptions': ['/subscriptions'],
  'disputes':      ['/disputes'],
  'reviews':       ['/reviews'],
  'companies':     ['/companies'],
  'portfolio':     ['/portfolio'],
  'promos':        ['/promos'],
  'quotes-admin':  ['/quotes'],
  'push':          ['/notifications'],
  'messaging':     ['/messaging'],
  'support':       ['/support'],
  'deleted':       ['/users-deleted'],
  'communication': ['/communication'],
};

router.use((req, res, next) => {
  // Super admin ou pas de restrictions → passe
  if (!req.user || req.user.adminLevel === 'SUPER' || !req.user.adminPermissions) return next();

  let allowed;
  try { allowed = JSON.parse(req.user.adminPermissions); } catch { return res.status(403).json({ error: 'Permissions invalides — contactez le super admin' }); }
  if (!Array.isArray(allowed)) return res.status(403).json({ error: 'Format de permissions invalide — contactez le super admin' });

  const path = req.path; // ex: "/support/tickets/123"

  // Routes exclues du contrôle (lecture du profil, alertes, dashboard)
  const FREE_PREFIXES = ['/me', '/alerts', '/dashboard', '/admin-logs', '/admins', '/teams'];
  if (FREE_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) return next();

  // Chercher si la section correspondant à ce préfixe est autorisée
  for (const [section, prefixes] of Object.entries(SECTION_PREFIXES)) {
    if (prefixes.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) {
      if (!allowed.includes(section)) {
        return res.status(403).json({ error: 'Accès non autorisé à cette section (' + section + ')' });
      }
      return next();
    }
  }

  // Préfixe inconnu → bloquer par défaut pour éviter tout bypass silencieux
  return res.status(403).json({ error: 'Accès non autorisé (section non répertoriée)' });
});

// Helper : écrire une entrée dans le journal d'actions admin
async function writeAdminLog(req, action, targetType, targetId, metadata) {
  try {
    await prisma.adminLog.create({
      data: {
        adminId:    req.user?.id || 'system',
        action,
        targetType: targetType || null,
        targetId:   targetId   || null,
        metadata:   metadata ? JSON.stringify(metadata) : null,
        ipAddress:  req.ip || null,
      },
    });
  } catch {}
}

// GET /api/admin/me — infos d'affichage de l'admin connecté
router.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { firstName: true, lastName: true, email: true, adminLevel: true, securityQuestion: true, adminPermissions: true },
  });
  res.json(user || {});
});

// GET /api/admin/alerts — alertes critiques pour la topbar (polling toutes les 60s)
router.get('/alerts', async (req, res, next) => {
  try {
    const now          = new Date();
    const twoDaysAgo   = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [pendingVerif, urgentTickets, openDisputes, pendingPayments] = await Promise.all([
      prisma.professional.count({ where: { identityStatus: 'PENDING', user: { deletedAt: null } } }),
      prisma.supportTicket.count({ where: { status: 'OPEN', createdAt: { lte: twoDaysAgo } } }),
      prisma.dispute.count({ where: { status: 'OPEN', createdAt: { lte: sevenDaysAgo } } }),
      prisma.payment.count({ where: { status: 'pending', createdAt: { lte: twoDaysAgo } } }),
    ]);

    const alerts = [];
    if (pendingVerif > 0)    alerts.push({ type: 'VERIF',   level: 'warning', count: pendingVerif,    label: pendingVerif    + ' vérification'  + (pendingVerif    > 1 ? 's' : '') + ' en attente',         page: 'verif-id'  });
    if (urgentTickets > 0)   alerts.push({ type: 'SUPPORT', level: 'urgent',  count: urgentTickets,   label: urgentTickets   + ' ticket'         + (urgentTickets   > 1 ? 's' : '') + ' ouverts > 48h',      page: 'support'   });
    if (openDisputes > 0)    alerts.push({ type: 'DISPUTE', level: 'urgent',  count: openDisputes,    label: openDisputes    + ' litige'         + (openDisputes    > 1 ? 's' : '') + ' non résolu'  + (openDisputes > 1 ? 's' : '') + ' > 7j', page: 'disputes' });
    if (pendingPayments > 0) alerts.push({ type: 'PAYMENT', level: 'warning', count: pendingPayments, label: pendingPayments + ' paiement'       + (pendingPayments > 1 ? 's' : '') + ' en attente > 48h',    page: 'payments'  });

    res.json({ alerts, total: alerts.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/admin-logs — journal des actions admin (super admin seulement)
router.get('/admin-logs', requireSuperAdmin, async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const skip  = (page - 1) * limit;
    const { adminId, action, dateFrom, dateTo } = req.query;

    const where = {};
    if (adminId) where.adminId = adminId;
    if (action)  where.action  = { contains: action, mode: 'insensitive' };
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.adminLog.count({ where }),
    ]);

    // Enrichir avec le nom de l'admin
    const adminIds = [...new Set(logs.map(l => l.adminId))];
    const admins = await prisma.user.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const adminMap = Object.fromEntries(admins.map(a => [a.id, a]));
    const enriched = logs.map(l => ({ ...l, admin: adminMap[l.adminId] || null }));

    res.json({ logs: enriched, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/me/security-setup — configurer la question secrète (une seule fois, immuable ensuite)
router.post('/me/security-setup', requireSuperAdmin, async (req, res, next) => {
  try {
    const { currentPassword, question, answer } = req.body;
    if (!currentPassword || !question || !answer) {
      return res.status(400).json({ error: 'Mot de passe actuel, question et réponse sont requis' });
    }
    if (answer.trim().length < 2) {
      return res.status(400).json({ error: 'La réponse doit contenir au moins 2 caractères' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordHash: true, securityAnswerHash: true },
    });

    if (user.securityAnswerHash) {
      return res.status(403).json({ error: 'La question secrète est déjà configurée et ne peut plus être modifiée.' });
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(403).json({ error: 'Mot de passe actuel incorrect' });

    const answerHash = await bcrypt.hash(answer.trim().toLowerCase(), 12);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { securityQuestion: question.trim(), securityAnswerHash: answerHash },
    });
    // Sauvegarde dans AppConfig pour restauration automatique au démarrage
    await prisma.appConfig.upsert({
      where: { key: 'super_admin_security' },
      create: { key: 'super_admin_security', value: JSON.stringify({ question: question.trim(), answerHash }), description: 'Backup question secrète super admin' },
      update: { value: JSON.stringify({ question: question.trim(), answerHash }) },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/me/change-password — changer le mot de passe (ancien mdp + réponse question secrète)
router.post('/me/change-password', requireSuperAdmin, async (req, res, next) => {
  try {
    const { currentPassword, securityAnswer, newPassword } = req.body;
    if (!currentPassword || !securityAnswer || !newPassword) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordHash: true, securityAnswerHash: true, securityQuestion: true },
    });

    if (!user.securityAnswerHash) {
      return res.status(400).json({ error: 'Aucune question secrète configurée. Configurez-la d\'abord.' });
    }

    const [pwOk, answerOk] = await Promise.all([
      bcrypt.compare(currentPassword, user.passwordHash),
      bcrypt.compare(securityAnswer.trim().toLowerCase(), user.securityAnswerHash),
    ]);

    if (!pwOk)     return res.status(403).json({ error: 'Mot de passe actuel incorrect' });
    if (!answerOk) return res.status(403).json({ error: 'Réponse à la question secrète incorrecte' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: newHash } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/create-admin — créer un compte administrateur STANDARD (super admin seulement)
router.post('/create-admin', requireSuperAdmin, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const firstName = sanitizeName(req.body.firstName);
    const lastName = sanitizeName(req.body.lastName);
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    // Garde absolue : on ne crée que des admins STANDARD, jamais SUPER
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.user.create({
      data: { email, passwordHash, firstName, lastName, role: 'ADMIN', adminLevel: 'STANDARD' },
    });
    const { passwordHash: _, ...safe } = admin;
    res.status(201).json(safe);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/admins — liste des comptes administrateurs (super admin seulement)
router.get('/admins', requireSuperAdmin, async (req, res, next) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', deletedAt: null },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        adminLevel: true, suspended: true, createdAt: true,
        lastLoginAt: true, adminPermissions: true, adminTeamId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Enrichir avec les données complètes de l'équipe (nom, couleur, permissions, preset)
    const teamIds = [...new Set(admins.map(a => a.adminTeamId).filter(Boolean))];
    const teams = teamIds.length
      ? await prisma.adminTeam.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, name: true, color: true, permissions: true, preset: true },
        })
      : [];
    const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));

    const enriched = admins.map(a => ({ ...a, team: a.adminTeamId ? teamMap[a.adminTeamId] || null : null }));
    res.json({ admins: enriched });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/admins/:id/suspend — suspendre un admin STANDARD
router.patch('/admins/:id/suspend', requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de suspendre le super admin' });
    if (target.id === req.user.id) return res.status(403).json({ error: 'Vous ne pouvez pas vous suspendre vous-même' });
    await prisma.user.update({ where: { id: req.params.id }, data: { suspended: true } });
    await writeAdminLog(req, 'ADMIN_SUSPEND', 'User', req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/admins/:id/reactivate — réactiver un admin STANDARD
router.patch('/admins/:id/reactivate', requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de modifier le super admin' });
    await prisma.user.update({ where: { id: req.params.id }, data: { suspended: false } });
    await writeAdminLog(req, 'ADMIN_REACTIVATE', 'User', req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/admins/:id — supprimer un admin STANDARD
router.delete('/admins/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de supprimer le super admin' });
    if (target.id === req.user.id) return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
    await prisma.user.delete({ where: { id: req.params.id } });
    await writeAdminLog(req, 'ADMIN_DELETE', 'User', req.params.id, { email: target.email });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/admins/:id/reset-password — réinitialiser le mot de passe d'un admin STANDARD
router.patch('/admins/:id/reset-password', requireSuperAdmin, async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de modifier le mot de passe du super admin via cette route' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/admins/:id/profile — modifier le profil d'un admin STANDARD
router.patch('/admins/:id/profile', requireSuperAdmin, async (req, res, next) => {
  try {
    const { email } = req.body;
    const firstName = req.body.firstName !== undefined ? sanitizeName(req.body.firstName) : undefined;
    const lastName  = req.body.lastName  !== undefined ? sanitizeName(req.body.lastName)  : undefined;
    if (req.body.firstName !== undefined && !firstName) return res.status(400).json({ error: 'Prénom invalide' });
    if (req.body.lastName  !== undefined && !lastName)  return res.status(400).json({ error: 'Nom invalide' });
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de modifier le profil du super admin via cette route' });

    // Vérifier unicité email si changé
    if (email && email !== target.email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName  !== undefined && { lastName }),
        ...(email     && { email }),
      },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    await writeAdminLog(req, 'ADMIN_PROFILE_UPDATE', 'User', req.params.id, { fields: Object.keys(req.body) });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/admins/:id/permissions — définir les permissions manuelles d'un admin STANDARD
// Si l'admin est dans une équipe, le détache automatiquement (permissions manuelles priment)
router.patch('/admins/:id/permissions', requireSuperAdmin, async (req, res, next) => {
  try {
    const { permissions } = req.body;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Impossible de restreindre le super admin' });

    const serialized = permissions === null ? null : JSON.stringify(permissions);
    const updates = { adminPermissions: serialized };

    // Détacher de l'équipe si on définit des permissions manuelles spécifiques
    if (permissions !== null && target.adminTeamId) {
      updates.adminTeamId = null;
    }

    await prisma.user.update({ where: { id: req.params.id }, data: updates });
    await writeAdminLog(req, 'ADMIN_PERMISSIONS_UPDATE', 'User', req.params.id, {
      permissions,
      detachedFromTeam: !!updates.adminTeamId,
    });
    res.json({ success: true, detachedFromTeam: permissions !== null && !!target.adminTeamId });
  } catch (err) {
    next(err);
  }
});

// Profils de permissions par équipe prédéfinie
const TEAM_PRESETS = {
  verification: {
    label: 'Vérification',
    description: 'Vérifie les documents et identités des professionnels',
    color: '#3b82f6',
    permissions: ['verif-id', 'professionals'],
  },
  support: {
    label: 'Support',
    description: 'Gère les tickets et la communication avec les utilisateurs',
    color: '#22c55e',
    permissions: ['support', 'communication', 'clients', 'users-all'],
  },
  finance: {
    label: 'Finance',
    description: 'Suit les paiements, remboursements et commissions',
    color: '#e8b84b',
    permissions: ['payments', 'subscriptions', 'analytics', 'disputes'],
  },
  moderation: {
    label: 'Modération',
    description: 'Gère les signalements, avis et comptes suspects',
    color: '#ef4444',
    permissions: ['moderation', 'reviews', 'disputes', 'deleted'],
  },
  commercial: {
    label: 'Commercial',
    description: 'Suit les abonnements, promotions et statistiques marché',
    color: '#8b5cf6',
    permissions: ['market', 'subscriptions', 'analytics', 'promos'],
  },
  custom: {
    label: 'Personnalisée',
    description: 'Permissions définies manuellement',
    color: '#f4720b',
    permissions: null,
  },
};

// PATCH /api/admin/admins/:id/team — assigner un admin à une équipe
// Synchronise automatiquement les permissions de l'admin avec celles de l'équipe
router.patch('/admins/:id/team', requireSuperAdmin, async (req, res, next) => {
  try {
    const { teamId } = req.body;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') return res.status(404).json({ error: 'Admin introuvable' });
    if (target.adminLevel === 'SUPER') return res.status(403).json({ error: 'Le super admin ne peut pas être assigné à une équipe' });

    let newPermissions = null;

    if (teamId) {
      const team = await prisma.adminTeam.findUnique({ where: { id: teamId } });
      if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
      // Hérite des permissions de l'équipe
      newPermissions = team.permissions || null;
    }
    // Si teamId est null : retrait de l'équipe → permissions effacées (accès total par défaut)

    await prisma.user.update({
      where: { id: req.params.id },
      data: { adminTeamId: teamId || null, adminPermissions: newPermissions },
    });
    await writeAdminLog(req, 'ADMIN_TEAM_ASSIGN', 'user', req.params.id, { teamId: teamId || null });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/teams/presets — liste des équipes prédéfinies
router.get('/teams/presets', requireSuperAdmin, (req, res) => {
  res.json({ presets: Object.entries(TEAM_PRESETS).map(([key, p]) => ({ key, ...p })) });
});

// GET /api/admin/teams — liste des équipes
router.get('/teams', requireSuperAdmin, async (req, res, next) => {
  try {
    const teams = await prisma.adminTeam.findMany({ orderBy: { createdAt: 'asc' } });
    const counts = await prisma.user.groupBy({
      by: ['adminTeamId'],
      where: { role: 'ADMIN', deletedAt: null, adminTeamId: { not: null } },
      _count: { _all: true },
    });
    const countMap = Object.fromEntries(counts.map(c => [c.adminTeamId, c._count._all]));
    res.json({ teams: teams.map(t => ({ ...t, memberCount: countMap[t.id] || 0 })) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/teams — créer une équipe
router.post('/teams', requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, description, color, preset, permissions } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom d\'équipe requis' });
    if (preset && !TEAM_PRESETS[preset]) return res.status(400).json({ error: 'Preset invalide' });

    const existing = await prisma.adminTeam.findUnique({ where: { name: name.trim() } });
    if (existing) return res.status(409).json({ error: 'Une équipe avec ce nom existe déjà' });

    // Résoudre les permissions : preset → permissions prédéfinies, custom → permissions manuelles
    let resolvedPermissions = null;
    if (preset && preset !== 'custom') {
      resolvedPermissions = JSON.stringify(TEAM_PRESETS[preset].permissions);
    } else if (permissions && Array.isArray(permissions)) {
      resolvedPermissions = JSON.stringify(permissions);
    }

    const resolvedColor = color || (preset ? TEAM_PRESETS[preset].color : '#f4720b');

    const team = await prisma.adminTeam.create({
      data: {
        name: name.trim(),
        description: description?.trim() || (preset ? TEAM_PRESETS[preset].description : null),
        color: resolvedColor,
        permissions: resolvedPermissions,
        preset: preset || 'custom',
        createdBy: req.user.id,
      },
    });
    await writeAdminLog(req, 'TEAM_CREATE', 'team', team.id, { name: team.name, preset });
    res.status(201).json(team);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/teams/:id — modifier une équipe
// Si les permissions changent, synchronise tous les membres
router.patch('/teams/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, description, color, permissions } = req.body;

    const existing = await prisma.adminTeam.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Équipe introuvable' });

    const updates = {
      ...(name !== undefined        && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(color !== undefined       && { color: color || null }),
    };

    // Mise à jour des permissions et synchronisation des membres
    if (permissions !== undefined) {
      const newPerms = Array.isArray(permissions) ? JSON.stringify(permissions) : null;
      updates.permissions = newPerms;
      updates.preset = 'custom';
      // Synchroniser tous les membres de cette équipe
      await prisma.user.updateMany({
        where: { adminTeamId: req.params.id, role: 'ADMIN' },
        data: { adminPermissions: newPerms },
      });
    }

    const updated = await prisma.adminTeam.update({ where: { id: req.params.id }, data: updates });
    await writeAdminLog(req, 'TEAM_UPDATE', 'team', req.params.id, { changes: Object.keys(updates) });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/teams/:id — supprimer une équipe
// Retire les membres et efface leurs permissions héritées
router.delete('/teams/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const team = await prisma.adminTeam.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });

    // Retirer les membres et effacer les permissions héritées de l'équipe
    await prisma.user.updateMany({
      where: { adminTeamId: req.params.id, role: 'ADMIN' },
      data: { adminTeamId: null, adminPermissions: null },
    });
    await prisma.adminTeam.delete({ where: { id: req.params.id } });
    await writeAdminLog(req, 'TEAM_DELETE', 'team', req.params.id, { name: team.name });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 1. TABLEAU DE BORD
// ============================================================

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const now        = new Date();
    const d7ago      = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const d14ago     = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const d30ago     = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d60ago     = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [
      // Totaux cumulés
      totalUsers, totalPros, totalClients,
      projectsOpen, projectsInProgress, projectsCompleted, projectsCancelled,
      totalQuotes, totalPayments, revenueAgg,
      activePremiumSubscriptions, pendingVerifications, activePromoCodes, totalPortfolioProjects,

      // Deltas 7 jours courants
      newUsers7,   newPros7,   newClients7,
      newProjects7, newQuotes7,
      revenue7Agg,

      // Deltas 7 jours précédents (j-14 → j-7)
      newUsers7prev,   newPros7prev,   newClients7prev,
      newProjects7prev, newQuotes7prev,
      revenue7prevAgg,

      // Deltas 30 jours courants
      newUsers30, newPros30, newClients30,
      newProjects30, newQuotes30,
      revenue30Agg,

      // Deltas 30 jours précédents (j-60 → j-30)
      newUsers30prev, newPros30prev, newClients30prev,
      newProjects30prev, newQuotes30prev,
      revenue30prevAgg,
    ] = await Promise.all([
      // Totaux
      prisma.user.count(),
      prisma.user.count({ where: { role: 'PROFESSIONAL' } }),
      prisma.user.count({ where: { role: 'CLIENT' } }),
      prisma.project.count({ where: { status: 'OPEN' } }),
      prisma.project.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.project.count({ where: { status: 'COMPLETED' } }),
      prisma.project.count({ where: { status: 'CANCELLED' } }),
      prisma.quote.count(),
      prisma.payment.count({ where: { status: 'succeeded' } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.professional.count({ where: { identityStatus: 'PENDING' } }),
      prisma.promoCode.count({ where: { active: true } }),
      prisma.portfolioProject.count(),

      // 7j courants
      prisma.user.count({ where: { createdAt: { gte: d7ago } } }),
      prisma.user.count({ where: { role: 'PROFESSIONAL', createdAt: { gte: d7ago } } }),
      prisma.user.count({ where: { role: 'CLIENT', createdAt: { gte: d7ago } } }),
      prisma.project.count({ where: { createdAt: { gte: d7ago } } }),
      prisma.quote.count({ where: { createdAt: { gte: d7ago } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', createdAt: { gte: d7ago } } }),

      // 7j précédents
      prisma.user.count({ where: { createdAt: { gte: d14ago, lt: d7ago } } }),
      prisma.user.count({ where: { role: 'PROFESSIONAL', createdAt: { gte: d14ago, lt: d7ago } } }),
      prisma.user.count({ where: { role: 'CLIENT', createdAt: { gte: d14ago, lt: d7ago } } }),
      prisma.project.count({ where: { createdAt: { gte: d14ago, lt: d7ago } } }),
      prisma.quote.count({ where: { createdAt: { gte: d14ago, lt: d7ago } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', createdAt: { gte: d14ago, lt: d7ago } } }),

      // 30j courants
      prisma.user.count({ where: { createdAt: { gte: d30ago } } }),
      prisma.user.count({ where: { role: 'PROFESSIONAL', createdAt: { gte: d30ago } } }),
      prisma.user.count({ where: { role: 'CLIENT', createdAt: { gte: d30ago } } }),
      prisma.project.count({ where: { createdAt: { gte: d30ago } } }),
      prisma.quote.count({ where: { createdAt: { gte: d30ago } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', createdAt: { gte: d30ago } } }),

      // 30j précédents
      prisma.user.count({ where: { createdAt: { gte: d60ago, lt: d30ago } } }),
      prisma.user.count({ where: { role: 'PROFESSIONAL', createdAt: { gte: d60ago, lt: d30ago } } }),
      prisma.user.count({ where: { role: 'CLIENT', createdAt: { gte: d60ago, lt: d30ago } } }),
      prisma.project.count({ where: { createdAt: { gte: d60ago, lt: d30ago } } }),
      prisma.quote.count({ where: { createdAt: { gte: d60ago, lt: d30ago } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', createdAt: { gte: d60ago, lt: d30ago } } }),
    ]);

    const totalRevenue = revenueAgg._sum.amount || 0;

    function delta(curr, prev) {
      const diff = curr - prev;
      const pct  = prev > 0 ? Math.round((diff / prev) * 100) : (curr > 0 ? 100 : 0);
      return { curr, prev, diff, pct };
    }

    const rev7     = revenue7Agg._sum.amount     || 0;
    const rev7prev = revenue7prevAgg._sum.amount  || 0;
    const rev30    = revenue30Agg._sum.amount     || 0;
    const rev30prev= revenue30prevAgg._sum.amount || 0;

    // 10 derniers utilisateurs inscrits
    const latestUsers = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, city: true, createdAt: true },
    });

    // 10 dernières activités
    const latestActivities = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, senderId: true, receiverId: true, content: true, createdAt: true,
        sender: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    res.json({
      users:    { total: totalUsers, professionals: totalPros, clients: totalClients },
      projects: {
        open: projectsOpen, inProgress: projectsInProgress,
        completed: projectsCompleted, cancelled: projectsCancelled,
        total: projectsOpen + projectsInProgress + projectsCompleted + projectsCancelled,
      },
      quotes:        { total: totalQuotes },
      payments:      { total: totalPayments, revenue: totalRevenue },
      subscriptions: { activePremium: activePremiumSubscriptions },
      promos:        { active: activePromoCodes },
      portfolio:     { total: totalPortfolioProjects },
      pendingVerifications,
      latestUsers,
      latestActivities,
      delta7: {
        users:    delta(newUsers7,    newUsers7prev),
        pros:     delta(newPros7,     newPros7prev),
        clients:  delta(newClients7,  newClients7prev),
        projects: delta(newProjects7, newProjects7prev),
        quotes:   delta(newQuotes7,   newQuotes7prev),
        revenue:  delta(rev7,         rev7prev),
      },
      delta30: {
        users:    delta(newUsers30,    newUsers30prev),
        pros:     delta(newPros30,     newPros30prev),
        clients:  delta(newClients30,  newClients30prev),
        projects: delta(newProjects30, newProjects30prev),
        quotes:   delta(newQuotes30,   newQuotes30prev),
        revenue:  delta(rev30,         rev30prev),
      },
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
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search, role, dateFrom, dateTo } = req.query;

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

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
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

// GET /api/admin/users-all — liste fusionnée clients + professionnels
router.get('/users-all', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip  = (page - 1) * limit;
    const { search, role, status, dateFrom, dateTo } = req.query;

    const where = {
      deletedAt: null,
      role: { in: ['CLIENT', 'PROFESSIONAL'] },
    };

    if (role && ['CLIENT', 'PROFESSIONAL'].includes(role.toUpperCase())) {
      where.role = role.toUpperCase();
    }

    if (status === 'suspended') where.suspended = true;
    else if (status === 'active') where.suspended = false;

    if (search) {
      where.OR = [
        { id: { startsWith: search } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
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
          professional: {
            select: {
              id: true,
              trade: true,
              identityStatus: true,
              averageRating: true,
              reviewCount: true,
              subscription: { select: { status: true } },
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
        projects: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            quotes: {
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: {
                id: true, amount: true, status: true, mode: true,
                createdAt: true, pdfUrl: true,
                professional: {
                  select: {
                    trade: true,
                    user: { select: { firstName: true, lastName: true } },
                  },
                },
                payments: { select: { id: true, status: true, amount: true, isDeposit: true } },
              },
            },
          },
        },
        reviewsWritten: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true, rating: true, comment: true, createdAt: true,
            professional: {
              select: {
                user: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Agrégats rapides
    const [quoteCount, paymentCount, paymentTotal] = await Promise.all([
      prisma.quote.count({ where: { project: { clientId: req.params.id } } }),
      prisma.payment.count({ where: { quote: { project: { clientId: req.params.id } }, status: 'succeeded' } }),
      prisma.payment.aggregate({
        where: { quote: { project: { clientId: req.params.id } }, status: 'succeeded' },
        _sum: { amount: true },
      }),
    ]);

    const { passwordHash, ...userSafe } = user;
    res.json({
      ...userSafe,
      _stats: {
        quoteCount,
        paymentCount,
        totalSpent: paymentTotal._sum.amount || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id — modifier les infos de base
router.patch('/users/:id', async (req, res, next) => {
  try {
    // Ni le rôle ADMIN ni le niveau SUPER ne peuvent être assignés via l'API
    if (req.body.role === 'ADMIN') return res.status(403).json({ error: 'Promotion au rôle ADMIN interdite via l\'API' });
    if (req.body.adminLevel) return res.status(403).json({ error: 'Modification du niveau admin interdite via l\'API' });
    const { email, city, phone } = req.body;
    const firstName = req.body.firstName !== undefined ? sanitizeName(req.body.firstName) : undefined;
    const lastName  = req.body.lastName  !== undefined ? sanitizeName(req.body.lastName)  : undefined;
    if (req.body.firstName !== undefined && !firstName) return res.status(400).json({ error: 'Prénom invalide' });
    if (req.body.lastName  !== undefined && !lastName)  return res.status(400).json({ error: 'Nom invalide' });

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Interdit de modifier un compte admin via cette route générique
    if (user.role === 'ADMIN') {
      return res.status(403).json({ error: 'Modification d\'un compte admin interdite via cette route — utilisez /admins/:id/profile' });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName  !== undefined && { lastName }),
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

    // Interdit de suspendre un compte admin (DoS ciblé)
    if (user.role === 'ADMIN') {
      return res.status(403).json({ error: 'Impossible de suspendre un compte admin via cette route — utilisez /admins/:id/suspend' });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: true },
    });

    await writeAdminLog(req, 'USER_SUSPEND', 'User', req.params.id);
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

    // Interdit de réactiver un compte admin via cette route générique
    if (user.role === 'ADMIN') {
      return res.status(403).json({ error: 'Impossible de réactiver un compte admin via cette route — utilisez /admins/:id/reactivate' });
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: false },
    });

    await writeAdminLog(req, 'USER_REACTIVATE', 'User', req.params.id);
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

    await writeAdminLog(req, 'USER_DELETE', 'User', req.params.id, { role: user.role });
    res.json({ message: 'Compte supprimé (archivé)' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/deleted — liste des comptes supprimés
// GET /api/admin/users-deleted/stats — KPIs comptes supprimés (agrégats, sans rapatrier toutes les lignes)
router.get('/users-deleted/stats', async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [total, restorable] = await Promise.all([
      prisma.user.count({ where: { deletedAt: { not: null } } }),
      prisma.user.count({ where: { deletedAt: { gte: thirtyDaysAgo } } }),
    ]);
    res.json({ total, restorable, old: total - restorable });
  } catch (err) { next(err); }
});

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

    await writeAdminLog(req, 'USER_RESTORE', 'User', req.params.id);
    res.json({ message: 'Compte réactivé avec succès' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id/purge — suppression définitive (irréversible, super admin uniquement)
router.delete('/users/:id/purge', requireSuperAdmin, async (req, res, next) => {
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

    await writeAdminLog(req, 'USER_PURGE', 'User', req.params.id, { role: user.role, email: user.email });
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

    // Interdit de reset le mot de passe d'un compte admin (élévation de privilèges)
    if (user.role === 'ADMIN') {
      return res.status(403).json({ error: 'Impossible de réinitialiser le mot de passe d\'un compte admin' });
    }

    // Générer un mot de passe temporaire
    const tempPassword = crypto.randomBytes(6).toString('hex'); // 12 caractères
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash },
    });

    await writeAdminLog(req, 'USER_RESET_PASSWORD', 'User', req.params.id);

    res.json({ message: 'Mot de passe réinitialisé avec succès.', temporaryPassword: tempPassword });
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
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { trade, city, identityStatus, premium, search, dateFrom, dateTo } = req.query;

    const where = { user: { deletedAt: null } };

    if (dateFrom || dateTo) {
      where.user = { ...where.user };
      where.user.createdAt = {};
      if (dateFrom) where.user.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.user.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

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

    await sendPushNotification(
      updated.user.id,
      'Identité vérifiée ✅',
      'Félicitations ! Votre identité a été validée par notre équipe. Vous pouvez maintenant envoyer des devis.',
      { type: 'identity_approved' }
    );

    await writeAdminLog(req, 'PRO_VERIFY', 'Professional', req.params.id);
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

    await writeAdminLog(req, 'PRO_REJECT', 'Professional', req.params.id, { reason: rejectionReason });
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

// PATCH /api/admin/professionals/:id/revoke-decennale — révoquer la validation décennale
router.patch('/professionals/:id/revoke-decennale', async (req, res, next) => {
  try {
    const professional = await prisma.professional.findUnique({ where: { id: req.params.id } });
    if (!professional) return res.status(404).json({ error: 'Professionnel non trouvé' });

    const updated = await prisma.professional.update({
      where: { id: req.params.id },
      data: { decennaleVerified: false },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });

    res.json({ message: 'Validation décennale révoquée', professional: updated });
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

// GET /api/admin/projects/map — tous les projets géolocalisés (pour la carte)
router.get('/projects/map', async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = { latitude: { not: null }, longitude: { not: null } };
    if (status) where.status = status;

    const projects = await prisma.project.findMany({
      where,
      select: {
        id: true, title: true, city: true, latitude: true, longitude: true,
        status: true, tradeNeeded: true, budgetMin: true, budgetMax: true,
        createdAt: true,
        client: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    res.json({ projects });
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
            payments: true,
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
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
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

    const [depositAgg, balanceAgg] = await Promise.all([
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', isDeposit: true } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'succeeded', isDeposit: false } }),
    ]);

    res.json({
      totalRevenue: totalRevenueAgg._sum.amount || 0,
      totalSuccessfulPayments: totalRevenueAgg._count,
      failedPayments,
      revenueByMonth,
      depositTotal: depositAgg._sum.amount || 0,
      balanceTotal: balanceAgg._sum.amount || 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/export-accounting — export comptable CSV SYSCOHADA (super admin)
router.get('/payments/export-accounting', requireSuperAdmin, async (req, res, next) => {
  try {
    const { dateFrom, dateTo, status } = req.query;
    const where = {};
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        quote: {
          select: {
            id: true, amount: true,
            project: { select: { title: true, city: true } },
            professional: { select: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
      take: 10000,
    });

    const COMMISSION_RATE = await getConfig('commission_rate') || 0.08;

    // En-têtes format comptable SYSCOHADA
    const headers = [
      'Date', 'N° Pièce', 'Journal', 'Code Journal',
      'Compte Débit', 'Compte Crédit', 'Libellé',
      'Montant HT (FCFA)', 'TVA (FCFA)', 'Montant TTC (FCFA)',
      'Commission MANAWA (FCFA)', 'Net Pro (FCFA)',
      'Réf. GeniusPay', 'Statut', 'Type', 'Rapproché',
      'Réf. Bancaire', 'Rapproché le',
    ];

    const rows = payments.map((p, i) => {
      const num = String(i + 1).padStart(5, '0');
      const date = new Date(p.createdAt).toLocaleDateString('fr-FR');
      const pro = p.quote?.professional?.user
        ? p.quote.professional.user.firstName + ' ' + p.quote.professional.user.lastName
        : '—';
      const project = p.quote?.project?.title || '—';
      const libelle = (p.isDeposit ? 'ACOMPTE 30% — ' : 'SOLDE 70% — ') + project + ' / ' + pro;
      const isSuccess = p.status === 'succeeded';
      const commission = isSuccess ? Math.round(p.amount * COMMISSION_RATE) : 0;
      const netPro = isSuccess ? Math.round(p.amount - commission - (p.fees || 0)) : 0;
      // Comptes SYSCOHADA : 4111 clients, 7071 prestations de services, 4431 TVA (exonéré BTP CI)
      const debit  = isSuccess ? '5211' : '4713'; // Banque / Clients douteux
      const credit = isSuccess ? '7071' : '4111'; // Prestations / Clients

      return [
        date,
        'PAY-' + num,
        p.isDeposit ? 'VTE-ACP' : 'VTE-SLD',
        p.isDeposit ? 'AC' : 'SL',
        debit,
        credit,
        libelle,
        p.amount,
        0,
        p.amount,
        commission,
        netPro,
        p.geniuspayRef || '',
        p.status,
        p.isDeposit ? 'Acompte 30%' : 'Solde 70%',
        p.reconciledAt ? 'Oui' : 'Non',
        p.bankRef || '',
        p.reconciledAt ? new Date(p.reconciledAt).toLocaleDateString('fr-FR') : '',
      ];
    });

    const csv = [headers, ...rows]
      .map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="manawa_comptabilite_' + new Date().toISOString().slice(0,10) + '.csv"');
    res.send('﻿' + csv); // BOM UTF-8 pour Excel
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/reconciliation — liste des paiements à rapprocher / rapprochés
router.get('/payments/reconciliation', requireSuperAdmin, async (req, res, next) => {
  try {
    const { reconciled, dateFrom, dateTo } = req.query;
    const where = { status: 'succeeded' };
    if (reconciled === 'true')  where.reconciledAt = { not: null };
    if (reconciled === 'false') where.reconciledAt = null;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

    const [payments, total, totalAmount] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          quote: {
            select: {
              project: { select: { title: true } },
              professional: { select: { user: { select: { firstName: true, lastName: true } } } },
            },
          },
        },
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({ where, _sum: { amount: true } }),
    ]);

    res.json({ payments, total, totalAmount: totalAmount._sum.amount || 0 });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/payments/:id/reconcile — marquer un paiement comme rapproché (super admin)
router.patch('/payments/:id/reconcile', requireSuperAdmin, async (req, res, next) => {
  try {
    const { bankRef } = req.body;
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.status !== 'succeeded') return res.status(400).json({ error: 'Seuls les paiements réussis peuvent être rapprochés' });
    if (payment.reconciledAt) return res.status(409).json({ error: 'Ce paiement est déjà rapproché' });

    await prisma.payment.update({
      where: { id: req.params.id },
      data: { reconciledAt: new Date(), reconciledBy: req.user.id, bankRef: bankRef || null },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/payments/:id/unreconcile — annuler le rapprochement (super admin)
router.patch('/payments/:id/unreconcile', requireSuperAdmin, async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    await prisma.payment.update({
      where: { id: req.params.id },
      data: { reconciledAt: null, reconciledBy: null, bankRef: null },
    });
    res.json({ success: true });
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
    const [payment, logs] = await Promise.all([
      prisma.payment.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          amount: true,
          status: true,
          isDeposit: true,
          geniuspayRef: true,
          createdAt: true,
          completedAt: true,
          quote: {
            select: {
              id: true,
              amount: true,
              project: { select: { id: true, title: true } },
              professional: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
            },
          },
        },
      }),
      prisma.paymentAuditLog.findMany({
        where: { paymentId: req.params.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    res.json({ payment, logs });
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

// GET /api/admin/support/stats
router.get('/support/stats', async (req, res, next) => {
  try {
    const [total, open, inProgress, resolved, closed, byCategory, byPriority] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      prisma.supportTicket.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.supportTicket.count({ where: { status: 'RESOLVED' } }),
      prisma.supportTicket.count({ where: { status: 'CLOSED' } }),
      prisma.supportTicket.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.supportTicket.groupBy({ by: ['priority'], _count: { _all: true } }),
    ]);

    // Temps moyen de résolution sur tickets résolus/fermés
    const doneTickets = await prisma.supportTicket.findMany({
      where: { status: { in: ['RESOLVED', 'CLOSED'] } },
      select: { createdAt: true, updatedAt: true, firstResponseAt: true, resolvedAt: true },
    });

    const avgResolutionHours = doneTickets.length
      ? Math.round(doneTickets.reduce((s, t) => s + (t.updatedAt - t.createdAt), 0) / doneTickets.length / 3600000)
      : null;

    // Délai moyen de 1ère réponse (sur tickets qui ont firstResponseAt)
    const withFirstResp = doneTickets.filter(t => t.firstResponseAt);
    const avgFirstResponseHours = withFirstResp.length
      ? Math.round(withFirstResp.reduce((s, t) => s + (t.firstResponseAt - t.createdAt), 0) / withFirstResp.length / 3600000 * 10) / 10
      : null;

    // Taux de résolution
    const resolveRate = total > 0 ? Math.round((resolved + closed) / total * 100 * 10) / 10 : 0;

    res.json({
      total, open, inProgress, resolved, closed,
      avgResolutionHours,
      avgFirstResponseHours,
      resolveRate,
      byCategory: Object.fromEntries(byCategory.map(r => [r.category, r._count._all])),
      byPriority: Object.fromEntries(byPriority.map(r => [r.priority, r._count._all])),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/support/tickets — tickets paginés avec recherche
router.get('/support/tickets', async (req, res, next) => {
  try {
    const { status, category, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip  = (page - 1) * limit;

    const where = {};
    if (status)   where.status   = status;
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { id:      { startsWith: search } },
        { subject: { contains: search, mode: 'insensitive' } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName:  { contains: search, mode: 'insensitive' } } },
        { user: { email:     { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip,
        include: {
          user:     { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      prisma.supportTicket.count({ where }),
    ]);

    res.json({ tickets, total, page, totalPages: Math.ceil(total / limit) });
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

    // Enregistrer firstResponseAt si c'est la 1ère réponse admin sur ce ticket
    const updateData = { status: 'IN_PROGRESS' };
    if (!ticket.firstResponseAt) updateData.firstResponseAt = new Date();
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: updateData });

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

    const updateData = { status };
    if (status === 'RESOLVED' || status === 'CLOSED') updateData.resolvedAt = new Date();

    const ticket = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: updateData,
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

// PATCH /api/admin/support/tickets/:id/priority — changer la priorité
router.patch('/support/tickets/:id/priority', async (req, res, next) => {
  try {
    const { priority } = req.body;
    if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
      return res.status(400).json({ error: 'Priorité invalide. Valeurs : LOW | NORMAL | HIGH | URGENT' });
    }
    await prisma.supportTicket.update({ where: { id: req.params.id }, data: { priority } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/support/tickets/:id/assign — assigner à un admin
router.patch('/support/tickets/:id/assign', async (req, res, next) => {
  try {
    const { assignedTo } = req.body;
    await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { assignedTo: assignedTo || null },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// FINANCES & REVENUS
// ══════════════════════════════════════════════════════════════

// GET /api/admin/finances/summary — résumé financier global (super admin seulement)
router.get('/finances/summary', requireSuperAdmin, async (req, res, next) => {
  try {
    const COMMISSION_RATE = await getConfig('commission_rate') || 0.08;

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
    const [activeSubscriptions, priceEssentiel, pricePro, priceElite] = await Promise.all([
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      getConfig('price_essentiel'),
      getConfig('price_pro'),
      getConfig('price_elite'),
    ]);
    const avgSubPrice = ((priceEssentiel || 2500) + (pricePro || 5000) + (priceElite || 10000)) / 3;
    const subRevenue = Math.round(activeSubscriptions * avgSubPrice);

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

// GET /api/admin/finances/commissions — commissions par professionnel (super admin seulement)
router.get('/finances/commissions', requireSuperAdmin, async (req, res, next) => {
  try {
    const COMMISSION_RATE = await getConfig('commission_rate') || 0.08;
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

// PATCH /api/admin/finances/commissions/:professionalId/mark-paid — super admin seulement
router.patch('/finances/commissions/:professionalId/mark-paid', requireSuperAdmin, async (req, res, next) => {
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

    const COMMISSION_RATE = await getConfig('commission_rate') || 0.08;
    const totalMarked = payments.reduce((s, p) => s + p.amount * COMMISSION_RATE, 0);

    res.json({ success: true, count: payments.length, totalMarked });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/finances/payments/:paymentId/mark-paid — super admin seulement
router.patch('/finances/payments/:paymentId/mark-paid', requireSuperAdmin, async (req, res, next) => {
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

// POST /api/admin/payments/:id/refund — remboursement via GeniusPay (super admin)
router.post('/payments/:id/refund', requireSuperAdmin, async (req, res, next) => {
  try {
    const { amount, reason, note } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Montant de remboursement requis' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Le motif est requis' });

    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
      include: { quote: { select: { project: { select: { title: true } } } } },
    });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.status !== 'succeeded') return res.status(400).json({ error: 'Seuls les paiements réussis peuvent être remboursés' });
    if (payment.refundedAt) return res.status(409).json({ error: 'Ce paiement a déjà été remboursé' });
    if (Number(amount) > payment.amount) return res.status(400).json({ error: 'Le montant ne peut pas dépasser le paiement original (' + payment.amount + ' FCFA)' });
    if (!payment.geniuspayRef) return res.status(400).json({ error: 'Aucune référence GeniusPay — utilisez le remboursement manuel' });

    let refundRef = null;
    try {
      const gpResult = await refundPayment(payment.geniuspayRef, Number(amount), reason.trim());
      refundRef = gpResult?.reference || gpResult?.id || null;
    } catch (gpErr) {
      const errMsg = gpErr.response?.data?.message || gpErr.message;
      return res.status(502).json({ error: 'GeniusPay : ' + errMsg });
    }

    const newStatus = Number(amount) >= payment.amount ? 'refunded' : 'partial_refund';

    // Mise à jour atomique : updateMany avec condition refundedAt IS NULL
    // Protège contre la race condition TOCTOU (double remboursement simultané)
    const updated = await prisma.payment.updateMany({
      where: { id: req.params.id, refundedAt: null },
      data: { refundAmount: Number(amount), refundedAt: new Date(), refundRef, refundNote: note?.trim() || reason.trim(), status: newStatus },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: 'Ce paiement vient d\'être remboursé en parallèle — opération annulée' });
    }

    await writeAdminLog(req, 'PAYMENT_REFUND', 'Payment', req.params.id, { amount: Number(amount), refundRef, mode: 'geniuspay' });
    res.json({ success: true, refundRef, status: newStatus });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payments/:id/refund-manual — remboursement manuel hors GeniusPay (super admin)
router.post('/payments/:id/refund-manual', requireSuperAdmin, async (req, res, next) => {
  try {
    const { amount, reason, note } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Montant requis' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Le motif est requis' });

    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.refundedAt) return res.status(409).json({ error: 'Ce paiement a déjà été remboursé' });
    if (Number(amount) > payment.amount) return res.status(400).json({ error: 'Montant supérieur au paiement original (' + payment.amount + ' FCFA)' });

    const manualRef = 'MANUAL-' + req.user.id.substring(0, 8).toUpperCase();
    const newStatus = Number(amount) >= payment.amount ? 'refunded' : 'partial_refund';

    // Mise à jour atomique : updateMany avec condition refundedAt IS NULL
    const updated = await prisma.payment.updateMany({
      where: { id: req.params.id, refundedAt: null },
      data: { refundAmount: Number(amount), refundedAt: new Date(), refundRef: manualRef, refundNote: note?.trim() || reason.trim(), status: newStatus },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: 'Ce paiement vient d\'être remboursé en parallèle — opération annulée' });
    }

    await writeAdminLog(req, 'PAYMENT_REFUND_MANUAL', 'Payment', req.params.id, { amount: Number(amount), mode: 'manual' });
    res.json({ success: true, refundRef: manualRef, status: newStatus });
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
    const { status = 'PENDING', contentType, dateFrom, dateTo, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const where = {};
    if (status) where.status = status;
    if (contentType) where.contentType = contentType;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo)   where.createdAt.lte = new Date(dateTo + 'T23:59:59.999Z');
    }

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

// GET /api/admin/moderation/reports/:id — détail d'un signalement
router.get('/moderation/reports/:id', async (req, res, next) => {
  try {
    const r = await prisma.contentReport.findUnique({
      where: { id: req.params.id },
      include: { reporter: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!r) return res.status(404).json({ error: 'Signalement introuvable' });

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

    res.json({ ...r, content });
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
    const days = Math.min(365, Math.max(7, parseInt(req.query.days) || 365));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const dateFilter = { createdAt: { gte: since } };

    // ── Entonnoir de conversion ──────────────────────────────
    const [
      totalProjects,
      projectsWithQuote,
      acceptedQuotes,
      paidProjects,
      totalClients,
      clientsWithMultipleProjects,
    ] = await Promise.all([
      prisma.project.count({ where: dateFilter }),
      prisma.project.count({ where: { ...dateFilter, quotes: { some: {} } } }),
      prisma.quote.count({ where: { ...dateFilter, status: 'ACCEPTED' } }),
      prisma.payment.count({ where: { ...dateFilter, status: 'succeeded', isDeposit: true } }),
      prisma.user.count({ where: { role: 'CLIENT' } }),
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
        where: { triggeredBy: { notIn: ['system', null] } },
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

// POST /api/admin/security/clean-otps — nettoyer les OTP expirés (super admin seulement : UPDATE sur toute la table)
router.post('/security/clean-otps', requireSuperAdmin, async (req, res, next) => {
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
// GESTION DES IPs AUTORISÉES POUR LE PANEL ADMIN
// Stockées en AppConfig sous la clé "admin_allowed_ips" (JSON array de {ip, label, addedBy, addedAt})
// ──────────────────────────────────────────────────────────────

// GET /api/admin/security/allowed-ips — liste des IPs autorisées
router.get('/security/allowed-ips', requireSuperAdmin, async (req, res, next) => {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: 'admin_allowed_ips' } });
    const ips = row ? JSON.parse(row.value) : [];
    res.json({ ips });
  } catch (err) { next(err); }
});

// POST /api/admin/security/allowed-ips — ajouter une IP
router.post('/security/allowed-ips', requireSuperAdmin, async (req, res, next) => {
  try {
    const { ip, label } = req.body;
    if (!ip || !ip.trim()) return res.status(400).json({ error: 'Adresse IP requise' });

    const ipTrimmed = ip.trim();
    // Validation basique IPv4 / IPv6
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipTrimmed);
    const ipv6 = /^[0-9a-fA-F:]{3,39}$/.test(ipTrimmed);
    if (!ipv4 && !ipv6) return res.status(400).json({ error: 'Format d\'adresse IP invalide' });

    const row = await prisma.appConfig.findUnique({ where: { key: 'admin_allowed_ips' } });
    const ips = row ? JSON.parse(row.value) : [];

    if (ips.some(e => e.ip === ipTrimmed)) {
      return res.status(409).json({ error: 'Cette IP est déjà dans la liste' });
    }

    const newEntry = { ip: ipTrimmed, label: label?.trim() || '', addedBy: req.user.email, addedAt: new Date().toISOString() };
    ips.push(newEntry);

    await prisma.appConfig.upsert({
      where: { key: 'admin_allowed_ips' },
      create: { key: 'admin_allowed_ips', value: JSON.stringify(ips), description: 'IPs autorisées à accéder au panel admin' },
      update: { value: JSON.stringify(ips), updatedBy: req.user.email },
    });

    await writeAdminLog(req, 'ADMIN_IP_ADD', 'AppConfig', 'admin_allowed_ips', { ip: ipTrimmed, label: label?.trim() || '' });
    res.json({ success: true, entry: newEntry, ips });
  } catch (err) { next(err); }
});

// DELETE /api/admin/security/allowed-ips/:ip — supprimer une IP
router.delete('/security/allowed-ips/:ip', requireSuperAdmin, async (req, res, next) => {
  try {
    const ipToRemove = decodeURIComponent(req.params.ip);

    const row = await prisma.appConfig.findUnique({ where: { key: 'admin_allowed_ips' } });
    if (!row) return res.status(404).json({ error: 'Aucune liste d\'IPs configurée' });

    const ips = JSON.parse(row.value);
    const filtered = ips.filter(e => e.ip !== ipToRemove);

    if (filtered.length === ips.length) return res.status(404).json({ error: 'IP non trouvée dans la liste' });

    // Empêcher de supprimer sa propre IP (risque de se bloquer)
    const clientIP = (req.ip || '').replace(/^::ffff:/, '');
    if (clientIP === ipToRemove) {
      return res.status(403).json({ error: 'Impossible de supprimer votre propre IP — vous perdriez l\'accès' });
    }

    await prisma.appConfig.update({
      where: { key: 'admin_allowed_ips' },
      data: { value: JSON.stringify(filtered), updatedBy: req.user.email },
    });

    await writeAdminLog(req, 'ADMIN_IP_REMOVE', 'AppConfig', 'admin_allowed_ips', { ip: ipToRemove });
    res.json({ success: true, ips: filtered });
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

// PATCH /api/admin/subscriptions/:professionalId — activer / changer tier / annuler (super admin seulement)
router.patch('/subscriptions/:professionalId', requireSuperAdmin, async (req, res, next) => {
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

// POST /api/admin/disputes — créer un litige manuellement (signalement téléphone/email)
router.post('/disputes', async (req, res, next) => {
  try {
    const { paymentId, reason, description } = req.body;
    if (!paymentId || !reason) return res.status(400).json({ error: 'paymentId et reason sont requis' });

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { quote: { include: { project: { select: { clientId: true } } } } },
    });
    if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
    if (payment.status !== 'succeeded') return res.status(400).json({ error: 'Seul un paiement confirmé peut faire l\'objet d\'un litige' });

    const existing = await prisma.dispute.findFirst({
      where: { paymentId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    });
    if (existing) return res.status(409).json({ error: 'Un litige ouvert existe déjà sur ce paiement' });

    const dispute = await prisma.dispute.create({
      data: {
        paymentId,
        clientId: payment.quote.project.clientId,
        reason,
        description: description || null,
        status: 'OPEN',
      },
    });
    res.status(201).json(dispute);
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

// POST /api/admin/communication/broadcast — envoyer une notification push (super admin seulement)
router.post('/communication/broadcast', requireSuperAdmin, async (req, res, next) => {
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
// GESTION DES ENTREPRISES
// ══════════════════════════════════════════════════════════════

// GET /api/admin/companies/stats
router.get('/companies/stats', async (req, res, next) => {
  try {
    const [totalCompanies, totalMembers, companiesWithMembers, totalIndependents] = await Promise.all([
      prisma.professional.count({ where: { accountType: 'ENTREPRISE', user: { deletedAt: null } } }),
      prisma.companyMember.count({ where: { status: 'ACTIVE' } }),
      prisma.companyMember.groupBy({ by: ['companyId'], _count: { _all: true } }).then(r => r.length),
      prisma.professional.count({ where: { accountType: 'INDEPENDENT', user: { deletedAt: null } } }),
    ]);

    // Taux de couverture : indépendants rattachés / total indépendants
    const attachedIndependents = await prisma.companyMember.count({ where: { status: 'ACTIVE' } });
    const coverageRate = totalIndependents > 0 ? Math.round((attachedIndependents / totalIndependents) * 100) : 0;

    res.json({
      totalCompanies,
      totalMembers,
      companiesWithMembers,
      totalIndependents,
      coverageRate,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/companies — liste paginée
router.get('/companies', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;
    const { search } = req.query;

    const where = { accountType: 'ENTREPRISE', user: { deletedAt: null } };
    if (search) {
      where.OR = [
        { companyName: { contains: search, mode: 'insensitive' } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { companyCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [companies, total] = await Promise.all([
      prisma.professional.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          companyName: true,
          companyCode: true,
          trade: true,
          siret: true,
          averageRating: true,
          reviewCount: true,
          completedMissionsCount: true,
          createdAt: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true, city: true, avatarUrl: true, suspended: true } },
          subscription: { select: { status: true, tier: true, expiresAt: true } },
          companyMembers: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              joinedAt: true,
              member: {
                select: {
                  id: true, trade: true, averageRating: true, reviewCount: true,
                  user: { select: { firstName: true, lastName: true, city: true, avatarUrl: true } },
                },
              },
            },
          },
        },
      }),
      prisma.professional.count({ where }),
    ]);

    // Calculer qualityRate pour chaque entreprise
    const result = companies.map(c => {
      const members = c.companyMembers || [];
      const qualified = members.filter(m => {
        const s = m.member;
        // Score simplifié : pros avec rating >= 4 ou missions complétées > 0 → qualifiés
        return (s.averageRating >= 4 && s.reviewCount > 0) || s.completedMissionsCount > 0;
      }).length;
      const qualityRate = members.length > 0 ? Math.round((qualified / members.length) * 100) : null;
      return { ...c, memberCount: members.length, qualityRate };
    });

    res.json({ companies: result, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/companies/:id — détail complet
router.get('/companies/:id', async (req, res, next) => {
  try {
    const company = await prisma.professional.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        companyName: true,
        companyCode: true,
        trade: true,
        trades: true,
        siret: true,
        description: true,
        employeeCount: true,
        averageRating: true,
        reviewCount: true,
        completedMissionsCount: true,
        cancelledMissionsCount: true,
        complaintsCount: true,
        accountType: true,
        identityStatus: true,
        decennaleVerified: true,
        rgeLabel: true,
        createdAt: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, city: true, avatarUrl: true, suspended: true, createdAt: true } },
        subscription: { select: { status: true, tier: true, expiresAt: true, startedAt: true } },
        companyMembers: {
          where: { status: 'ACTIVE' },
          orderBy: { joinedAt: 'desc' },
          include: {
            member: {
              select: {
                id: true,
                trade: true,
                trades: true,
                averageRating: true,
                reviewCount: true,
                completedMissionsCount: true,
                cancelledMissionsCount: true,
                identityStatus: true,
                user: { select: { id: true, firstName: true, lastName: true, email: true, city: true, avatarUrl: true, suspended: true } },
              },
            },
          },
        },
      },
    });

    if (!company) return res.status(404).json({ error: 'Entreprise non trouvée' });
    if (company.accountType !== 'ENTREPRISE') return res.status(400).json({ error: 'Ce professionnel n\'est pas une entreprise' });

    res.json(company);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/companies/:id/members/:memberId — retirer un membre
router.delete('/companies/:id/members/:memberId', async (req, res, next) => {
  try {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: req.params.id, memberId: req.params.memberId },
    });
    if (!membership) return res.status(404).json({ error: 'Membre non trouvé dans cette entreprise' });

    await prisma.companyMember.delete({ where: { id: membership.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// CONFIGURATION & PARAMÈTRES
// ══════════════════════════════════════════════════════════════

// GET /api/admin/config — super admin seulement
router.get('/config', requireSuperAdmin, async (req, res, next) => {
  try {
    const config = await getAllConfig();
    res.json(config);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/config — super admin seulement
router.patch('/config', requireSuperAdmin, async (req, res, next) => {
  try {
    const { confirmPassword, ...updates } = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Body doit être un objet { key: value }' });
    }

    const { DEFAULTS } = require('../utils/appConfig');

    // Vérifier si l'une des clés à modifier est readonly ou requiresConfirmation
    for (const key of Object.keys(updates)) {
      if (!DEFAULTS[key]) {
        return res.status(400).json({ error: `Clé inconnue: ${key}` });
      }
      if (DEFAULTS[key].readonly) {
        return res.status(403).json({ error: `La clé "${key}" est en lecture seule et ne peut pas être modifiée.` });
      }
    }

    // Si l'une des clés nécessite une confirmation, vérifier le mot de passe admin
    const needsConfirmation = Object.keys(updates).some(k => DEFAULTS[k]?.requiresConfirmation);
    if (needsConfirmation) {
      if (!confirmPassword) {
        return res.status(403).json({ error: 'Ce paramètre nécessite une confirmation par mot de passe admin.', requiresConfirmation: true });
      }
      const admin = await prisma.user.findUnique({ where: { id: req.user.id }, select: { passwordHash: true } });
      const valid = await bcrypt.compare(confirmPassword, admin.passwordHash);
      if (!valid) {
        return res.status(403).json({ error: 'Mot de passe incorrect.', requiresConfirmation: true });
      }
    }

    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      // Validations métier
      if (key === 'commission_rate') {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0 || num > 0.5) {
          return res.status(400).json({ error: 'commission_rate doit être entre 0 et 0.5 (50%)' });
        }
      }
      if (['price_essentiel', 'price_pro', 'price_elite'].includes(key)) {
        const num = parseInt(value);
        if (isNaN(num) || num < 0) {
          return res.status(400).json({ error: `${key} doit être un entier positif` });
        }
      }
      if (key === 'app_maintenance_mode' && !['true', 'false'].includes(String(value))) {
        return res.status(400).json({ error: 'app_maintenance_mode doit être true ou false' });
      }

      const row = await prisma.appConfig.upsert({
        where: { key },
        create: { key, value: String(value), description: DEFAULTS[key].description, updatedBy: req.user.id },
        update: { value: String(value), updatedBy: req.user.id },
      });
      results.push(row);
    }

    res.json({ success: true, updated: results });
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

// ══════════════════════════════════════════════════════════════
// MESSAGERIE
// ══════════════════════════════════════════════════════════════

// GET /api/admin/messaging/stats
router.get('/messaging/stats', async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000);

    const [total, last30d, last7d, unread, topSenders] = await Promise.all([
      prisma.message.count(),
      prisma.message.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.message.count({ where: { createdAt: { gte: sevenDaysAgo  } } }),
      prisma.message.count({ where: { read: false } }),
      prisma.message.groupBy({
        by: ['senderId'],
        _count: { _all: true },
        orderBy: { _count: { senderId: 'desc' } },
        take: 5,
      }),
    ]);

    // Conversations distinctes (paires uniques triées)
    const allPairs = await prisma.message.findMany({
      select: { senderId: true, receiverId: true },
      distinct: ['senderId', 'receiverId'],
    });
    const pairSet = new Set(allPairs.map(m => [m.senderId, m.receiverId].sort().join('|')));
    const totalConversations = pairSet.size;

    const pairsLast30d = await prisma.message.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { senderId: true, receiverId: true },
      distinct: ['senderId', 'receiverId'],
    });
    const activeConversations = new Set(pairsLast30d.map(m => [m.senderId, m.receiverId].sort().join('|'))).size;

    // Enrichir top senders
    const senderIds = topSenders.map(s => s.senderId);
    const senderUsers = await prisma.user.findMany({
      where: { id: { in: senderIds } },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    const senderMap = Object.fromEntries(senderUsers.map(u => [u.id, u]));

    res.json({
      total, last30d, last7d, unread,
      totalConversations, activeConversations,
      topSenders: topSenders.map(s => ({
        user: senderMap[s.senderId] || null,
        count: s._count._all,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/messaging/conversations — liste paginée des conversations
router.get('/messaging/conversations', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 20;
    const { search } = req.query;

    // Charger tous les messages récents pour grouper par paire
    // On prend les N messages les plus récents puis on déduplique par paire
    const where = {};
    if (search) {
      const matchingUsers = await prisma.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName:  { contains: search, mode: 'insensitive' } },
            { email:     { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      const ids = matchingUsers.map(u => u.id);
      if (ids.length === 0) return res.json({ conversations: [], total: 0, page, pages: 0 });
      where.OR = [{ senderId: { in: ids } }, { receiverId: { in: ids } }];
    }

    // Dernier message par paire — on charge un grand batch et on déduplique
    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: {
        id: true, senderId: true, receiverId: true,
        content: true, read: true, createdAt: true,
        sender:   { select: { id: true, firstName: true, lastName: true, email: true, role: true, avatarUrl: true } },
        receiver: { select: { id: true, firstName: true, lastName: true, email: true, role: true, avatarUrl: true } },
      },
    });

    const convMap = new Map();
    for (const m of messages) {
      const key = [m.senderId, m.receiverId].sort().join('|');
      if (!convMap.has(key)) convMap.set(key, m);
    }
    const allConvs = Array.from(convMap.values());
    const total = allConvs.length;
    const paginated = allConvs.slice((page - 1) * limit, page * limit);

    // Enrichir avec nombre de messages non lus par paire
    const enriched = await Promise.all(paginated.map(async m => {
      const [msgCount, unreadCount] = await Promise.all([
        prisma.message.count({
          where: {
            OR: [
              { senderId: m.senderId, receiverId: m.receiverId },
              { senderId: m.receiverId, receiverId: m.senderId },
            ],
          },
        }),
        prisma.message.count({
          where: {
            OR: [
              { senderId: m.senderId, receiverId: m.receiverId, read: false },
              { senderId: m.receiverId, receiverId: m.senderId, read: false },
            ],
          },
        }),
      ]);
      return { ...m, msgCount, unreadCount };
    }));

    res.json({ conversations: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/admin/messaging/conversations/:userA/:userB — messages entre deux users
router.get('/messaging/conversations/:userA/:userB', async (req, res, next) => {
  try {
    const { userA, userB } = req.params;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const skip  = (page - 1) * limit;

    const where = {
      OR: [
        { senderId: userA, receiverId: userB },
        { senderId: userB, receiverId: userA },
      ],
    };

    const [messages, total, userAInfo, userBInfo] = await Promise.all([
      prisma.message.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, senderId: true, content: true, read: true, createdAt: true,
        },
      }),
      prisma.message.count({ where }),
      prisma.user.findUnique({ where: { id: userA }, select: { id: true, firstName: true, lastName: true, email: true, role: true, avatarUrl: true } }),
      prisma.user.findUnique({ where: { id: userB }, select: { id: true, firstName: true, lastName: true, email: true, role: true, avatarUrl: true } }),
    ]);

    res.json({ messages, total, page, pages: Math.ceil(total / limit), userA: userAInfo, userB: userBInfo });
  } catch (err) { next(err); }
});

// DELETE /api/admin/messaging/messages/:id — supprimer un message
router.delete('/messaging/messages/:id', async (req, res, next) => {
  try {
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg) return res.status(404).json({ error: 'Message non trouvé' });
    await prisma.message.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// GESTION DES DEVIS
// ══════════════════════════════════════════════════════════════

// GET /api/admin/quotes/stats
router.get('/quotes/stats', async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      total, pending, accepted, refused, expired, revised,
      last30d, totalAmount, acceptedAmount, byMode,
    ] = await Promise.all([
      prisma.quote.count(),
      prisma.quote.count({ where: { status: 'PENDING' } }),
      prisma.quote.count({ where: { status: 'ACCEPTED' } }),
      prisma.quote.count({ where: { status: 'REFUSED' } }),
      prisma.quote.count({ where: { status: 'EXPIRED' } }),
      prisma.quote.count({ where: { status: 'REVISED' } }),
      prisma.quote.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.quote.aggregate({ _sum: { amount: true } }),
      prisma.quote.aggregate({ where: { status: 'ACCEPTED' }, _sum: { amount: true } }),
      prisma.quote.groupBy({ by: ['mode'], _count: { _all: true } }),
    ]);

    const acceptRate = total > 0 ? Math.round((accepted / total) * 100) : 0;

    res.json({
      total, pending, accepted, refused, expired, revised, last30d,
      acceptRate,
      totalAmount: totalAmount._sum.amount || 0,
      acceptedAmount: acceptedAmount._sum.amount || 0,
      byMode: byMode.map(r => ({ mode: r.mode, count: r._count._all })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/quotes — liste paginée
router.get('/quotes', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = 20;
    const skip   = (page - 1) * limit;
    const { status, mode, search } = req.query;

    const where = {};
    if (status && ['PENDING','ACCEPTED','REFUSED','EXPIRED','REVISED'].includes(status.toUpperCase())) {
      where.status = status.toUpperCase();
    }
    if (mode && ['SIMPLE','DETAILED'].includes(mode.toUpperCase())) {
      where.mode = mode.toUpperCase();
    }
    if (search) {
      where.OR = [
        { professional: { user: { firstName: { contains: search, mode: 'insensitive' } } } },
        { professional: { user: { lastName:  { contains: search, mode: 'insensitive' } } } },
        { professional: { user: { email:     { contains: search, mode: 'insensitive' } } } },
        { professional: { companyName: { contains: search, mode: 'insensitive' } } },
        { project: { title: { contains: search, mode: 'insensitive' } } },
        { project: { client: { firstName: { contains: search, mode: 'insensitive' } } } },
        { project: { client: { lastName:  { contains: search, mode: 'insensitive' } } } },
        { project: { client: { email:     { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [quotes, total] = await Promise.all([
      prisma.quote.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, amount: true, status: true, mode: true,
          version: true, createdAt: true, expiresAt: true, pdfUrl: true,
          description: true,
          _count: { select: { items: true, payments: true } },
          professional: {
            select: {
              id: true, trade: true, companyName: true,
              user: { select: { firstName: true, lastName: true, email: true } },
            },
          },
          project: {
            select: {
              id: true, title: true, tradeNeeded: true, city: true, status: true,
              client: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
          payments: { select: { id: true, status: true, amount: true, isDeposit: true } },
        },
      }),
      prisma.quote.count({ where }),
    ]);

    res.json({ quotes, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/admin/quotes/:id — détail complet
router.get('/quotes/:id', async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { include: { auditLogs: { orderBy: { createdAt: 'desc' }, take: 5 } } },
        professional: {
          select: {
            id: true, trade: true, companyName: true, averageRating: true,
            user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, city: true } },
          },
        },
        project: {
          include: {
            client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, city: true } },
          },
        },
        parentQuote: { select: { id: true, version: true, amount: true, status: true, createdAt: true } },
        revisions: {
          orderBy: { version: 'asc' },
          select: { id: true, version: true, amount: true, status: true, createdAt: true, description: true },
        },
      },
    });

    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    res.json(quote);
  } catch (err) { next(err); }
});

// PATCH /api/admin/quotes/:id/cancel — expirer un devis admin
router.patch('/quotes/:id/cancel', async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    if (!['PENDING', 'REVISED'].includes(quote.status)) {
      return res.status(400).json({ error: `Impossible d'expirer un devis en statut ${quote.status}` });
    }
    const updated = await prisma.quote.update({
      where: { id: req.params.id },
      data: { status: 'EXPIRED' },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS PUSH
// ══════════════════════════════════════════════════════════════

// GET /api/admin/notifications/stats
router.get('/notifications/stats', async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000);

    const [
      totalTokens, activeTokens, inactiveTokens,
      tokensByPlatform, tokensByType,
      totalNotifs, notifsLast30d, notifsLast7d,
      unreadNotifs, totalBroadcasts, broadcastsLast30d,
      usersWithToken, totalUsers,
    ] = await Promise.all([
      prisma.pushToken.count(),
      prisma.pushToken.count({ where: { isActive: true } }),
      prisma.pushToken.count({ where: { isActive: false } }),
      prisma.pushToken.groupBy({ by: ['platform'], _count: { _all: true } }),
      prisma.pushToken.groupBy({ by: ['type'],     _count: { _all: true } }),
      prisma.notification.count(),
      prisma.notification.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.notification.count({ where: { createdAt: { gte: sevenDaysAgo  } } }),
      prisma.notification.count({ where: { read: false } }),
      prisma.broadcastLog.count(),
      prisma.broadcastLog.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.pushToken.groupBy({ by: ['userId'], where: { isActive: true } }).then(r => r.length),
      prisma.user.count({ where: { deletedAt: null } }),
    ]);

    const coverageRate = totalUsers > 0 ? Math.round((usersWithToken / totalUsers) * 100) : 0;
    const deliveryRate = totalTokens > 0 ? Math.round((activeTokens / totalTokens) * 100) : 0;

    res.json({
      tokens: {
        total: totalTokens,
        active: activeTokens,
        inactive: inactiveTokens,
        byPlatform: tokensByPlatform.map(r => ({ platform: r.platform, count: r._count._all })),
        byType:     tokensByType.map(r => ({ type: r.type, count: r._count._all })),
        coverageRate,
        deliveryRate,
        usersWithToken,
      },
      notifications: {
        total: totalNotifs,
        last30d: notifsLast30d,
        last7d:  notifsLast7d,
        unread:  unreadNotifs,
        readRate: totalNotifs > 0 ? Math.round(((totalNotifs - unreadNotifs) / totalNotifs) * 100) : 0,
      },
      broadcasts: {
        total: totalBroadcasts,
        last30d: broadcastsLast30d,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/tokens — liste paginée de tous les tokens
router.get('/notifications/tokens', async (req, res, next) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const limit   = 25;
    const skip    = (page - 1) * limit;
    const { platform, type, active, search } = req.query;

    const where = {};
    if (platform) where.platform = platform;
    if (type)     where.type = type;
    if (active === 'true')  where.isActive = true;
    if (active === 'false') where.isActive = false;
    if (search) {
      where.user = {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName:  { contains: search, mode: 'insensitive' } },
          { email:     { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [tokens, total] = await Promise.all([
      prisma.pushToken.findMany({
        where, skip, take: limit,
        orderBy: { lastUsed: 'desc' },
        select: {
          id: true, platform: true, type: true, isActive: true,
          deviceId: true, lastUsed: true, createdAt: true,
          token: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        },
      }),
      prisma.pushToken.count({ where }),
    ]);

    res.json({ tokens, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/admin/notifications/history — historique in-app paginé
router.get('/notifications/history', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const skip  = (page - 1) * limit;
    const { userId, type, read } = req.query;

    const where = {};
    if (userId) where.userId = userId;
    if (type)   where.type = type;
    if (read === 'true')  where.read = true;
    if (read === 'false') where.read = false;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        },
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({ notifications, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// POST /api/admin/notifications/send — envoyer une notif ciblée
router.post('/notifications/send', async (req, res, next) => {
  try {
    const { userId, title, body, type } = req.body;
    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title et body sont requis' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Enregistrer en DB
    const notif = await prisma.notification.create({
      data: {
        userId,
        type: type || 'ADMIN',
        title,
        body,
        message: body,
      },
    });

    // Envoyer push
    const pushResult = await sendPushNotification(userId, title, body, { type: type || 'ADMIN', notifId: notif.id });

    res.json({
      success: true,
      notificationId: notif.id,
      push: pushResult,
    });
  } catch (err) { next(err); }
});

// DELETE /api/admin/notifications/tokens/:id — invalider un token
router.delete('/notifications/tokens/:id', async (req, res, next) => {
  try {
    const token = await prisma.pushToken.findUnique({ where: { id: req.params.id } });
    if (!token) return res.status(404).json({ error: 'Token non trouvé' });
    await prisma.pushToken.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// CODES PROMO & OFFRES
// ══════════════════════════════════════════════════════════════

// GET /api/admin/promos/stats
router.get('/promos/stats', async (req, res, next) => {
  try {
    const now = new Date();
    const [total, active, expired, totalUsages, topPromo] = await Promise.all([
      prisma.promoCode.count(),
      prisma.promoCode.count({ where: { active: true, OR: [{ validUntil: null }, { validUntil: { gt: now } }] } }),
      prisma.promoCode.count({ where: { validUntil: { lt: now } } }),
      prisma.promoUsage.count(),
      prisma.promoCode.findFirst({
        orderBy: { usedCount: 'desc' },
        select: { code: true, usedCount: true, description: true },
      }),
    ]);
    res.json({ total, active, expired, totalUsages, topPromo });
  } catch (err) { next(err); }
});

// GET /api/admin/promos — liste paginée
router.get('/promos', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;
    const { search, status } = req.query;
    const now = new Date();

    const where = {};
    if (search) where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
    if (status === 'active') where.active = true;
    else if (status === 'inactive') where.active = false;
    else if (status === 'expired') { where.validUntil = { lt: now }; }

    const [promos, total] = await Promise.all([
      prisma.promoCode.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: { _count: { select: { usages: true } } },
      }),
      prisma.promoCode.count({ where }),
    ]);

    res.json({ promos, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// POST /api/admin/promos — créer un code
router.post('/promos', async (req, res, next) => {
  try {
    const { code, description, discountType, discountValue, maxUses, validFrom, validUntil, applicableTiers, active } = req.body;
    if (!code || !discountType || discountValue == null) return res.status(400).json({ error: 'code, discountType et discountValue sont requis' });
    if (!['PERCENT', 'FIXED'].includes(discountType)) return res.status(400).json({ error: 'discountType doit être PERCENT ou FIXED' });
    if (discountType === 'PERCENT' && (discountValue <= 0 || discountValue > 100)) return res.status(400).json({ error: 'Pourcentage invalide (1–100)' });

    const promo = await prisma.promoCode.create({
      data: {
        code: code.toUpperCase().trim(),
        description: description || null,
        discountType,
        discountValue: parseFloat(discountValue),
        maxUses: maxUses ? parseInt(maxUses) : null,
        validFrom: validFrom ? new Date(validFrom) : new Date(),
        validUntil: validUntil ? new Date(validUntil) : null,
        applicableTiers: Array.isArray(applicableTiers) ? applicableTiers : [],
        active: active !== false,
        createdBy: req.user.id,
      },
    });
    res.status(201).json(promo);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Ce code promo existe déjà' });
    next(err);
  }
});

// PATCH /api/admin/promos/:id — modifier
router.patch('/promos/:id', async (req, res, next) => {
  try {
    const { description, discountType, discountValue, maxUses, validFrom, validUntil, applicableTiers, active } = req.body;
    const data = {};
    if (description !== undefined) data.description = description;
    if (discountType !== undefined) data.discountType = discountType;
    if (discountValue !== undefined) data.discountValue = parseFloat(discountValue);
    if (maxUses !== undefined) data.maxUses = maxUses ? parseInt(maxUses) : null;
    if (validFrom !== undefined) data.validFrom = new Date(validFrom);
    if (validUntil !== undefined) data.validUntil = validUntil ? new Date(validUntil) : null;
    if (applicableTiers !== undefined) data.applicableTiers = Array.isArray(applicableTiers) ? applicableTiers : [];
    if (active !== undefined) data.active = active;

    const promo = await prisma.promoCode.update({ where: { id: req.params.id }, data });
    res.json(promo);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Code promo non trouvé' });
    next(err);
  }
});

// DELETE /api/admin/promos/:id — supprimer
router.delete('/promos/:id', async (req, res, next) => {
  try {
    await prisma.promoCode.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Code promo non trouvé' });
    next(err);
  }
});

// GET /api/admin/promos/:id/usages — historique d'utilisation
router.get('/promos/:id/usages', async (req, res, next) => {
  try {
    const usages = await prisma.promoUsage.findMany({
      where: { promoCodeId: req.params.id },
      orderBy: { usedAt: 'desc' },
      include: {
        professional: {
          select: {
            trade: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
    res.json(usages);
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// PORTFOLIOS & RÉALISATIONS
// ══════════════════════════════════════════════════════════════

// GET /api/admin/portfolio/stats
router.get('/portfolio/stats', async (req, res, next) => {
  try {
    const [totalProjects, totalLikes, totalComments, totalItems, topProject] = await Promise.all([
      prisma.portfolioProject.count(),
      prisma.portfolioProjectLike.count(),
      prisma.portfolioComment.count(),
      prisma.portfolioItem.count(),
      prisma.portfolioProject.findFirst({
        orderBy: { likes: { _count: 'desc' } },
        select: {
          id: true, title: true,
          _count: { select: { likes: true, comments: true } },
          professional: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);

    res.json({ totalProjects, totalLikes, totalComments, totalItems, topProject });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/portfolio/projects — liste paginée
router.get('/portfolio/projects', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;
    const { search, category } = req.query;

    const where = {};
    if (category) where.tradeCategory = category;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { professional: { user: { firstName: { contains: search, mode: 'insensitive' } } } },
        { professional: { user: { lastName: { contains: search, mode: 'insensitive' } } } },
        { professional: { companyName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.portfolioProject.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          description: true,
          tradeCategory: true,
          createdAt: true,
          _count: { select: { likes: true, comments: true, images: true } },
          images: { take: 1, orderBy: { sortOrder: 'asc' }, select: { imageUrl: true } },
          professional: {
            select: {
              id: true, trade: true,
              user: { select: { firstName: true, lastName: true, email: true, city: true } },
            },
          },
        },
      }),
      prisma.portfolioProject.count({ where }),
    ]);

    res.json({ projects, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/portfolio/projects/:id — détail complet
router.get('/portfolio/projects/:id', async (req, res, next) => {
  try {
    const project = await prisma.portfolioProject.findUnique({
      where: { id: req.params.id },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        likes: { select: { id: true } },
        comments: {
          where: { parentId: null },
          orderBy: { createdAt: 'desc' },
          include: {
            author: { select: { firstName: true, lastName: true, avatarUrl: true, role: true } },
            replies: {
              orderBy: { createdAt: 'asc' },
              include: { author: { select: { firstName: true, lastName: true, avatarUrl: true, role: true } } },
            },
          },
        },
        professional: {
          select: {
            id: true, trade: true, averageRating: true,
            companyName: true,
            user: { select: { firstName: true, lastName: true, email: true, city: true, avatarUrl: true } },
          },
        },
      },
    });

    if (!project) return res.status(404).json({ error: 'Réalisation non trouvée' });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/portfolio/projects/:id — supprimer réalisation (cascade)
router.delete('/portfolio/projects/:id', async (req, res, next) => {
  try {
    const project = await prisma.portfolioProject.findUnique({ where: { id: req.params.id } });
    if (!project) return res.status(404).json({ error: 'Réalisation non trouvée' });
    await prisma.portfolioProject.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/portfolio/comments/:id — supprimer un commentaire
router.delete('/portfolio/comments/:id', async (req, res, next) => {
  try {
    const comment = await prisma.portfolioComment.findUnique({ where: { id: req.params.id } });
    if (!comment) return res.status(404).json({ error: 'Commentaire non trouvé' });
    await prisma.portfolioComment.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
