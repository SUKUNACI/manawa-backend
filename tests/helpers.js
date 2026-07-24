const jwt = require('jsonwebtoken');

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });
}

function clientToken(id = 'client-1') {
  return makeToken({ id, role: 'CLIENT', email: 'client@test.com' });
}

function proToken(id = 'pro-user-1') {
  return makeToken({ id, role: 'PROFESSIONAL', email: 'pro@test.com' });
}

function adminToken(id = 'admin-1') {
  return makeToken({ id, role: 'ADMIN', email: 'admin@test.com' });
}

module.exports = { makeToken, clientToken, proToken, adminToken };
