const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const prisma = require('../config/db');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});

// POST /api/auth/register
router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
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

      const token = jwt.sign(
        { id: user.id, role: user.role, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const { passwordHash: _, ...userSafe } = user;
      res.status(201).json({ user: userSafe, token });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
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

      const token = jwt.sign(
        { id: user.id, role: user.role, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const { passwordHash: _, ...userSafe } = user;
      res.json({ user: userSafe, token });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
