const express = require('express');
const prisma = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendPushNotification } = require('../config/pushNotifications');

const router = express.Router();

// Génère un code de parrainage unique format REF-XXXXXX
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'REF-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Cherche le userId associé à un code de parrainage dans AppConfig
// Les clés sont de la forme referral_code_{userId}
async function findReferrerByCode(code) {
  const configs = await prisma.appConfig.findMany({
    where: { key: { startsWith: 'referral_code_' }, value: code },
  });
  if (configs.length === 0) return null;
  // extraire le userId de la clé
  const userId = configs[0].key.replace('referral_code_', '');
  return userId;
}

// GET /api/referrals/my-code — retourne le code de parrainage du pro connecté
router.get('/my-code', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const configKey = `referral_code_${userId}`;

    let config = await prisma.appConfig.findUnique({ where: { key: configKey } });

    if (!config) {
      // Générer un code unique (retry si collision)
      let code;
      let attempts = 0;
      do {
        code = generateReferralCode();
        const existing = await prisma.appConfig.findFirst({
          where: { key: { startsWith: 'referral_code_' }, value: code },
        });
        if (!existing) break;
        attempts++;
      } while (attempts < 10);

      config = await prisma.appConfig.upsert({
        where: { key: configKey },
        create: { key: configKey, value: code, description: `Code de parrainage du pro ${userId}` },
        update: {},
      });
    }

    const code = config.value;

    // Statistiques filleuls
    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      select: { status: true },
    });

    const total = referrals.length;
    const qualified = referrals.filter(r => r.status === 'QUALIFIED' || r.status === 'REWARDED').length;
    const rewarded = referrals.filter(r => r.status === 'REWARDED').length;

    res.json({ code, total, qualified, rewarded });
  } catch (err) {
    next(err);
  }
});

// POST /api/referrals/use — utiliser un code de parrainage
router.post('/use', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Le code de parrainage est requis' });

    const userId = req.user.id;

    // Vérifier que le user n'a pas déjà un parrain
    const existingReferral = await prisma.referral.findUnique({ where: { referredId: userId } });
    if (existingReferral) {
      return res.status(409).json({ error: 'Vous avez déjà été parrainé' });
    }

    // Trouver le parrain associé au code
    const referrerId = await findReferrerByCode(code.trim().toUpperCase());
    if (!referrerId) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    // Vérifier que le user n'est pas son propre parrain
    if (referrerId === userId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre code de parrainage' });
    }

    // Récupérer les infos du parrain pour la notification et la réponse
    const referrer = await prisma.user.findUnique({
      where: { id: referrerId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!referrer) {
      return res.status(404).json({ error: 'Code de parrainage invalide' });
    }

    // Récupérer les infos du filleul pour la notification
    const referred = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });

    // Créer le Referral
    await prisma.referral.create({
      data: {
        referrerId,
        referredId: userId,
        code: code.trim().toUpperCase(),
        status: 'PENDING',
      },
    });

    // Notifier le parrain
    const filleulName = referred ? `${referred.firstName} ${referred.lastName}` : 'Un artisan';
    sendPushNotification(
      referrerId,
      '🎉 Nouveau filleul !',
      `${filleulName} a rejoint MANAWA grâce à votre code !`,
      { type: 'referral_new', referredId: userId }
    );

    res.json({
      success: true,
      referrerName: `${referrer.firstName} ${referrer.lastName}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/referrals/mine — liste des filleuls du pro connecté
router.get('/mine', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const userId = req.user.id;

    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      include: {
        referred: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = referrals.map(r => ({
      id: r.id,
      status: r.status,
      code: r.code,
      createdAt: r.createdAt,
      qualifiedAt: r.qualifiedAt,
      rewardedAt: r.rewardedAt,
      rewardType: r.rewardType,
      rewardValue: r.rewardValue,
      referred: r.referred,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/referrals/my-referrer — retourne le parrain du pro connecté (si existant)
router.get('/my-referrer', requireAuth, requireRole('PROFESSIONAL'), async (req, res, next) => {
  try {
    const userId = req.user.id;

    const referral = await prisma.referral.findUnique({
      where: { referredId: userId },
      include: {
        referrer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (!referral) {
      return res.json({ referrer: null });
    }

    res.json({
      referrer: referral.referrer,
      status: referral.status,
      createdAt: referral.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
