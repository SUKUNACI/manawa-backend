const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, role: true, email: true, suspended: true } });
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (user.suspended) return res.status(403).json({ error: 'Votre compte a été suspendu' });
    req.user = { id: user.id, role: user.role, email: user.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé pour ce rôle' });
    }
    next();
  };
}

async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id }, select: { id: true, role: true, email: true, suspended: true } });
    if (user && !user.suspended) req.user = { id: user.id, role: user.role, email: user.email };
  } catch {}
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };
