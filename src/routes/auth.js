const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');

const router = express.Router();

const ACCESS_TOKEN_TTL  = '15m';
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 jours en ms

function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

async function generateRefreshToken(userId) {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL);
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });
  return token;
}

// Rate limit par IP (register + login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});

// Rate limit par compte (login uniquement) — 5 échecs max avant blocage 1h
const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `account:${req.body?.email?.toLowerCase() || req.ip}`,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives sur ce compte, réessayez dans 1 heure' },
});

// POST /api/auth/register
router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail(),
    body('password').isLength({ min: 8 }),
    body('firstName').notEmpty().trim().escape(),
    body('lastName').notEmpty().trim().escape(),
    body('role').isIn(['CLIENT', 'PROFESSIONAL']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password, firstName, lastName, role, phone, city, trades, accountType, companyName } = req.body;
      const tradesArray = Array.isArray(trades) && trades.length > 0 ? trades.slice(0, 3) : ['Non spécifié'];

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          phone,
          city,
          role,
          professional:
            role === 'PROFESSIONAL'
              ? { create: { trade: tradesArray[0], trades: tradesArray, accountType: accountType || 'INDEPENDENT', companyName: accountType === 'ENTREPRISE' ? companyName : undefined } }
              : undefined,
        },
        include: { professional: true },
      });

      const accessToken  = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user.id);

      const { passwordHash: _, ...userSafe } = user;
      res.status(201).json({ user: userSafe, token: accessToken, refreshToken });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  accountLimiter,
  [body('email').isEmail(), body('password').notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;
      const user = await prisma.user.findUnique({
        where: { email },
        include: { professional: true },
      });
      if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

      if (user.deletedAt) return res.status(403).json({ error: 'Ce compte a été supprimé. Contactez le support pour le réactiver.' });
      if (user.suspended) return res.status(403).json({ error: 'Votre compte a été suspendu. Contactez le support.' });

      const accessToken  = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user.id);

      const { passwordHash: _, ...userSafe } = user;
      res.json({ user: userSafe, token: accessToken, refreshToken });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/refresh — échange un refresh token contre un nouvel access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken requis' });

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await prisma.refreshToken.delete({ where: { id: stored.id } });
      return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
    }

    if (stored.user.suspended) {
      return res.status(403).json({ error: 'Compte suspendu' });
    }

    // Rotation : invalide l'ancien, génère un nouveau
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    const newAccessToken  = generateAccessToken(stored.user);
    const newRefreshToken = await generateRefreshToken(stored.user.id);

    res.json({ token: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — révoque le refresh token
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.clearCookie('adminToken');
    res.json({ loggedOut: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/admin-session — pose un cookie httpOnly après login admin réussi
router.post('/admin-session', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token requis' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'ADMIN') return res.status(403).json({ error: 'Accès refusé' });
    res.cookie('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 min, durée de l'access token
    });
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
});

module.exports = router;
