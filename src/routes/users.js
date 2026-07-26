const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const upload = require('../config/upload');
const { verifyMagicBytes } = require('../config/upload');
const { uploadBuffer } = require('../config/cloudinary');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// PATCH /api/users/me
router.patch('/me',
  requireAuth,
  [
    body('firstName').optional().trim().notEmpty().isLength({ max: 50 }).escape(),
    body('lastName').optional().trim().notEmpty().isLength({ max: 50 }).escape(),
    body('phone').optional({ nullable: true }).trim().matches(/^\+?[0-9\s\-().]{6,20}$/),
    body('city').optional({ nullable: true }).trim().isLength({ max: 100 }).escape(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const { firstName, lastName, phone, city } = req.body;

      const nameFields = req.user.role === 'PROFESSIONAL' ? {} : { firstName, lastName };

      const user = await prisma.user.update({
        where: { id: req.user.id },
        data: { ...nameFields, phone, city },
        include: { professional: true },
      });

      const { passwordHash: _, ...userSafe } = user;
      res.json(userSafe);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/users/me/recently-viewed
router.get('/me/recently-viewed', requireAuth, async (req, res, next) => {
  try {
    const views = await prisma.profileView.findMany({
      where: { viewerId: req.user.id },
      include: { professional: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const seen = new Set();
    const unique = [];
    for (const v of views) {
      if (!seen.has(v.professionalId)) { seen.add(v.professionalId); unique.push(v); }
    }
    res.json(unique.slice(0, 10).map((v) => v.professional));
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/following
router.get('/me/following', requireAuth, async (req, res, next) => {
  try {
    const follows = await prisma.follow.findMany({
      where: { followerId: req.user.id },
      include: { professional: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(follows.map((f) => f.professional));
  } catch (err) {
    next(err);
  }
});

// POST /api/users/me/avatar
router.post('/me/avatar', requireAuth, upload.single('avatar'), verifyMagicBytes, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo requise' });
    const avatarUrl = await uploadBuffer(req.file.buffer, 'manawa/avatars');
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl }, include: { professional: true } });
    const { passwordHash: _, ...userSafe } = user;
    res.json(userSafe);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
