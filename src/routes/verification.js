const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');
const { sendVerificationEmail } = require('../config/mailer');
const { sendVerificationSms } = require('../config/sms');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes de code, réessayez dans 15 minutes' },
});

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/verification/email/send
router.post('/email/send', requireAuth, otpLimiter, async (req, res, next) => {
  try {
    const code = generateCode();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { emailVerifyCode: code, emailVerifyExpiry: expiry },
    });

    await sendVerificationEmail(user.email, code, 'verify');
    res.json({ message: 'Code envoyé' });
  } catch (err) {
    next(err);
  }
});

// POST /api/verification/email/confirm
router.post('/email/confirm', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user.emailVerifyCode || user.emailVerifyCode !== code) {
      return res.status(400).json({ error: 'Code incorrect' });
    }
    if (new Date() > user.emailVerifyExpiry) {
      return res.status(400).json({ error: 'Code expiré, demandez-en un nouveau' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { emailVerified: true, emailVerifyCode: null, emailVerifyExpiry: null },
    });
    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/verification/phone/send
router.post('/phone/send', requireAuth, otpLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });

    const code = generateCode();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { id: req.user.id },
      data: { phone, phoneOtpCode: code, phoneOtpExpiry: expiry, phoneVerified: false },
    });

    await sendVerificationSms(phone, code);
    res.json({ message: 'Code envoyé' });
  } catch (err) {
    next(err);
  }
});

// POST /api/verification/phone/confirm
router.post('/phone/confirm', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user.phoneOtpCode || user.phoneOtpCode !== code) {
      return res.status(400).json({ error: 'Code incorrect' });
    }
    if (new Date() > user.phoneOtpExpiry) {
      return res.status(400).json({ error: 'Code expiré, demandez-en un nouveau' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { phoneVerified: true, phoneOtpCode: null, phoneOtpExpiry: null },
    });
    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/verification/password/request-reset
router.post('/password/request-reset', otpLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.json({ message: 'Si ce compte existe, un code a été envoyé.' });

    if (!user.emailVerified) {
      return res.status(400).json({ error: "Votre email doit d'abord être vérifié avant de pouvoir réinitialiser le mot de passe. Connectez-vous et vérifiez votre email depuis Sécurité & confidentialité." });
    }

    const code = generateCode();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.user.update({ where: { id: user.id }, data: { passwordResetCode: code, passwordResetExpiry: expiry } });

    await sendVerificationEmail(email, code, 'reset');
    res.json({ message: 'Si ce compte existe, un code a été envoyé.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/verification/password/reset
router.post('/password/reset', otpLimiter, async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordResetCode || user.passwordResetCode !== code) {
      return res.status(400).json({ error: 'Code incorrect' });
    }
    if (new Date() > user.passwordResetExpiry) {
      return res.status(400).json({ error: 'Code expiré, recommencez la demande' });
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSamePassword) {
      return res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'ancien" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetCode: null, passwordResetExpiry: null },
    });
    res.json({ reset: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/verification/status
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ emailVerified: user.emailVerified, phoneVerified: user.phoneVerified, phone: user.phone });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
