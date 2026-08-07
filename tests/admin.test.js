const request = require('supertest');
const express = require('express');
const { adminToken, proToken, clientToken } = require('./helpers');

// ── Mock Prisma ────────────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => ({
  user: {
    findUnique: jest.fn(),
    findMany:   jest.fn().mockResolvedValue([]),
    count:      jest.fn().mockResolvedValue(0),
    update:     jest.fn(),
    delete:     jest.fn(),
  },
  professional: {
    findUnique: jest.fn(),
    findMany:   jest.fn().mockResolvedValue([]),
    count:      jest.fn().mockResolvedValue(0),
    update:     jest.fn(),
  },
  project: {
    count:    jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
  quote: {
    count:    jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    update:   jest.fn(),
  },
  payment: {
    count:     jest.fn().mockResolvedValue(0),
    findMany:  jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    findUnique: jest.fn(),
    update:    jest.fn(),
  },
  subscription: {
    count:    jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    update:   jest.fn(),
  },
  promoCode: {
    count:      jest.fn().mockResolvedValue(0),
    findMany:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    delete:     jest.fn(),
  },
  portfolioProject: {
    count:      jest.fn().mockResolvedValue(0),
    findMany:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    delete:     jest.fn(),
  },
  message: {
    findMany:  jest.fn().mockResolvedValue([]),
    count:     jest.fn().mockResolvedValue(0),
    groupBy:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    delete:    jest.fn(),
  },
  review: {
    count:    jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    update:   jest.fn(),
    delete:   jest.fn(),
  },
  supportTicket: {
    count:      jest.fn().mockResolvedValue(0),
    findMany:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    groupBy:    jest.fn().mockResolvedValue([]),
    update:     jest.fn(),
  },
  supportMessage: {
    findMany: jest.fn().mockResolvedValue([]),
    create:   jest.fn(),
    deleteMany: jest.fn(),
  },
  notification: {
    count:    jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    create:   jest.fn(),
    groupBy:  jest.fn().mockResolvedValue([]),
  },
  pushToken: {
    count:      jest.fn().mockResolvedValue(0),
    findMany:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    update:     jest.fn(),
    delete:     jest.fn(),
    groupBy:    jest.fn().mockResolvedValue([]),
  },
  portfolioComment: {
    delete: jest.fn(),
  },
  dispute: {
    count:      jest.fn().mockResolvedValue(0),
    findMany:   jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  companyMember: {
    findMany: jest.fn().mockResolvedValue([]),
    delete:   jest.fn(),
  },
  promoUsage: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  $transaction: jest.fn(fn => fn({
    user:         { update: jest.fn(), delete: jest.fn() },
    professional: { update: jest.fn() },
    payment:      { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    promoCode:    { update: jest.fn() },
    promoUsage:   { create: jest.fn() },
    supportTicket:  { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    supportMessage: { deleteMany: jest.fn() },
    notification:   { deleteMany: jest.fn() },
    pushToken:      { deleteMany: jest.fn() },
    quote:          { deleteMany: jest.fn() },
    review:         { deleteMany: jest.fn() },
    follow:         { deleteMany: jest.fn() },
    portfolioItem:  { deleteMany: jest.fn() },
    portfolioProject: { deleteMany: jest.fn() },
    message:        { deleteMany: jest.fn() },
  })),
}));

// ── Mock appConfig ─────────────────────────────────────────────────────────────
jest.mock('../src/utils/appConfig', () => ({
  getConfig:    jest.fn().mockResolvedValue(null),
  getAllConfig:  jest.fn().mockResolvedValue({}),
  setConfig:    jest.fn().mockResolvedValue({}),
}));

// ── Mock trustScore ────────────────────────────────────────────────────────────
jest.mock('../src/utils/trustScore', () => ({
  computeTrustScore:      jest.fn().mockReturnValue(75),
  getTrustScoreBreakdown: jest.fn().mockReturnValue({ total: 75, bonus: [], penalties: [] }),
}));

const prisma    = require('../src/config/db');
const appConfig = require('../src/utils/appConfig');
const adminRoutes = require('../src/routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

// ── Fixtures ───────────────────────────────────────────────────────────────────
const ADMIN_ID  = 'admin-1';
const PRO_ID    = 'pro-1';
const USER_ID   = 'user-pro-1';
const CLIENT_ID = 'client-1';

const mockAdminUser = { id: ADMIN_ID, role: 'ADMIN', email: 'admin@test.com', suspended: false, adminLevel: 'SUPER', adminPermissions: null };
const mockProUser   = { id: USER_ID,  role: 'PROFESSIONAL', email: 'pro@test.com', suspended: false, adminLevel: null, adminPermissions: null };

const mockProfessional = {
  id: PRO_ID, userId: USER_ID, trade: 'Maçon', identityStatus: 'PENDING',
  verifiedByAdmin: false, decennaleVerified: false, trialEndsAt: null,
  averageRating: 0, reviewCount: 0, complaintsCount: 0,
  completedMissionsCount: 0, cancelledMissionsCount: 0, accountType: 'INDEPENDENT',
  user: { id: USER_ID, firstName: 'Marie', lastName: 'Martin', email: 'pro@test.com' },
};

// requireAuth appelle prisma.user.findUnique — toujours résoudre l'admin
function useAdmin() {
  prisma.user.findUnique.mockResolvedValue(mockAdminUser);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. AUTHENTIFICATION & AUTORISATION
// ══════════════════════════════════════════════════════════════════════════════

describe('Admin — auth guards', () => {
  test('401 sans token', async () => {
    const res = await request(app).get('/api/admin/dashboard');
    expect(res.status).toBe(401);
  });

  test('403 avec token CLIENT', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: CLIENT_ID, role: 'CLIENT', suspended: false });
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${clientToken(CLIENT_ID)}`);
    expect(res.status).toBe(403);
  });

  test('403 avec token PROFESSIONAL', async () => {
    prisma.user.findUnique.mockResolvedValue(mockProUser);
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${proToken(USER_ID)}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. TABLEAU DE BORD
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/dashboard', () => {
  beforeEach(() => {
    useAdmin();
    prisma.user.count.mockResolvedValue(42);
    prisma.project.count.mockResolvedValue(10);
    prisma.quote.count.mockResolvedValue(5);
    prisma.payment.count.mockResolvedValue(3);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 150000 } });
    prisma.subscription.count.mockResolvedValue(7);
    prisma.professional.count.mockResolvedValue(2);
    prisma.promoCode.count.mockResolvedValue(1);
    prisma.portfolioProject.count.mockResolvedValue(8);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.message.findMany.mockResolvedValue([]);
  });

  test('retourne 200 avec toutes les clés attendues', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('users');
    expect(res.body).toHaveProperty('projects');
    expect(res.body).toHaveProperty('quotes');
    expect(res.body).toHaveProperty('payments');
    expect(res.body).toHaveProperty('subscriptions');
    expect(res.body).toHaveProperty('promos');
    expect(res.body).toHaveProperty('portfolio');
    expect(res.body).toHaveProperty('pendingVerifications');
  });

  test('agrège correctement users.total et projects.total', async () => {
    // user.count appelé 3× : total, pros, clients
    prisma.user.count
      .mockResolvedValueOnce(100)  // total
      .mockResolvedValueOnce(30)   // professionals
      .mockResolvedValueOnce(70);  // clients
    // project.count appelé 4× : OPEN, IN_PROGRESS, COMPLETED, CANCELLED
    prisma.project.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.users.total).toBe(100);
    expect(res.body.users.professionals).toBe(30);
    expect(res.body.users.clients).toBe(70);
    expect(res.body.projects.total).toBe(10); // 4+3+2+1
    expect(res.body.projects.open).toBe(4);
  });

  test('revenue est 0 quand aggregate retourne null', async () => {
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.payments.revenue).toBe(0);
  });

  test('inclut promos.active et portfolio.total', async () => {
    prisma.promoCode.count.mockResolvedValue(5);
    prisma.portfolioProject.count.mockResolvedValue(12);

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.promos.active).toBe(5);
    expect(res.body.portfolio.total).toBe(12);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. VÉRIFICATION D'IDENTITÉ
// ══════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/admin/professionals/:id/verify', () => {
  beforeEach(() => {
    useAdmin();
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);
    prisma.professional.update.mockResolvedValue({
      ...mockProfessional, identityStatus: 'APPROVED', verifiedByAdmin: true,
    });
  });

  test('approuve l\'identité d\'un pro PENDING', async () => {
    const res = await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/verify`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.professional.identityStatus).toBe('APPROVED');
    expect(prisma.professional.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ identityStatus: 'APPROVED', verifiedByAdmin: true }) })
    );
  });

  test('retourne 404 si pro introuvable', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/admin/professionals/inexistant/verify')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });

  test('définit trialEndsAt si pas encore défini', async () => {
    const res = await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/verify`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    const updateCall = prisma.professional.update.mock.calls[0][0];
    // trialEndsAt doit être présent dans le data (pas undefined) quand trialEndsAt est null
    expect(updateCall.data.trialEndsAt).toBeDefined();
  });

  test('ne redéfinit pas trialEndsAt si déjà fixé', async () => {
    prisma.professional.findUnique.mockResolvedValue({
      ...mockProfessional, trialEndsAt: new Date('2099-01-01'),
    });

    await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/verify`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    const updateCall = prisma.professional.update.mock.calls[0][0];
    expect(updateCall.data.trialEndsAt).toBeUndefined();
  });
});

describe('PATCH /api/admin/professionals/:id/reject', () => {
  beforeEach(() => {
    useAdmin();
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);
    prisma.professional.update.mockResolvedValue({
      ...mockProfessional,
      identityStatus: 'REJECTED',
      identityRejectionReason: 'Document flou',
      user: { id: USER_ID, firstName: 'Marie', lastName: 'Martin', email: 'pro@test.com' },
    });
  });

  test('rejette l\'identité avec motif', async () => {
    const res = await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/reject`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.professional.identityStatus).toBe('REJECTED');
  });

  test('utilise le motif par défaut si reason absent', async () => {
    await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/reject`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`)
      .send({});

    const updateCall = prisma.professional.update.mock.calls[0][0];
    expect(updateCall.data.identityRejectionReason).toBe('Document non conforme');
  });

  test('utilise le motif fourni', async () => {
    await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/reject`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`)
      .send({ reason: 'Photo illisible' });

    const updateCall = prisma.professional.update.mock.calls[0][0];
    expect(updateCall.data.identityRejectionReason).toBe('Photo illisible');
  });

  test('retourne 404 si pro introuvable', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/admin/professionals/inexistant/reject')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/professionals/:id/verify-decennale', () => {
  beforeEach(() => {
    useAdmin();
    prisma.professional.findUnique.mockResolvedValue(mockProfessional);
    prisma.professional.update.mockResolvedValue({ ...mockProfessional, decennaleVerified: true });
  });

  test('valide la décennale', async () => {
    const res = await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/verify-decennale`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(prisma.professional.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { decennaleVerified: true } })
    );
  });

  test('retourne 404 si pro introuvable', async () => {
    prisma.professional.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/admin/professionals/inexistant/verify-decennale')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/professionals/:id/revoke-decennale', () => {
  beforeEach(() => {
    useAdmin();
    prisma.professional.findUnique.mockResolvedValue({ ...mockProfessional, decennaleVerified: true });
    prisma.professional.update.mockResolvedValue({ ...mockProfessional, decennaleVerified: false });
  });

  test('révoque la décennale', async () => {
    const res = await request(app)
      .patch(`/api/admin/professionals/${PRO_ID}/revoke-decennale`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(prisma.professional.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { decennaleVerified: false } })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. RESET MOT DE PASSE
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/users/:id/reset-password', () => {
  const mockUser = { id: USER_ID, role: 'PROFESSIONAL', email: 'pro@test.com' };

  beforeEach(() => {
    // mockImplementation évite les Once values qui contaminent les tests suivants
    prisma.user.findUnique.mockImplementation(({ where } = {}) => {
      if (where?.id === ADMIN_ID) return Promise.resolve(mockAdminUser);
      if (where?.id === USER_ID)  return Promise.resolve(mockUser);
      return Promise.resolve(null);
    });
    prisma.user.update.mockResolvedValue(mockUser);
  });

  test('génère un mot de passe temporaire', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${USER_ID}/reset-password`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('temporaryPassword');
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword.length).toBeGreaterThan(0);
  });

  test('le mot de passe temporaire est différent à chaque appel', async () => {
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/admin/users/${USER_ID}/reset-password`).set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`),
      request(app).post(`/api/admin/users/${USER_ID}/reset-password`).set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`),
    ]);

    expect(r1.body.temporaryPassword).not.toBe(r2.body.temporaryPassword);
  });

  test('appelle prisma.user.update avec un hash bcrypt', async () => {
    await request(app)
      .post(`/api/admin/users/${USER_ID}/reset-password`)
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ passwordHash: expect.any(String) }) })
    );
    const hash = prisma.user.update.mock.calls[0][0].data.passwordHash;
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  test('retourne 404 si user introuvable', async () => {
    // mockImplementation retourne null pour tout ID inconnu → 404
    const res = await request(app)
      .post('/api/admin/users/inexistant/reset-password')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. FINANCES — calcul des commissions
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finances/summary', () => {
  const makePayment = (amount, commissionPaid = false) => ({
    id: `pay-${amount}`, amount, commissionPaid,
    isDeposit: false, status: 'succeeded',
    createdAt: new Date(), completedAt: new Date(),
    quote: { professional: { user: { firstName: 'A', lastName: 'B', email: 'a@b.com' } }, project: { title: 'P' } },
  });

  beforeEach(() => {
    useAdmin();
    prisma.subscription.count.mockResolvedValue(2);
  });

  test('calcule totalTransactions, totalCommissions, commissionsDues correctement (taux 8%)', async () => {
    appConfig.getConfig.mockResolvedValue(null); // taux par défaut = 0.08
    prisma.payment.findMany.mockResolvedValue([
      makePayment(100000, false),
      makePayment(50000,  true),
    ]);

    const res = await request(app)
      .get('/api/admin/finances/summary')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTransactions).toBe(150000);
    expect(res.body.totalCommissions).toBeCloseTo(12000);     // 150000 × 0.08
    expect(res.body.commissionsDues).toBeCloseTo(8000);       // 100000 × 0.08 (non payé)
    expect(res.body.commissionsPercues).toBeCloseTo(4000);    // 50000 × 0.08 (payé)
  });

  test('respecte un taux de commission personnalisé', async () => {
    // commission_rate → 0.10 ; puis price_essentiel/pro/elite → null
    appConfig.getConfig
      .mockResolvedValueOnce(0.10)
      .mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([makePayment(200000, false)]);

    const res = await request(app)
      .get('/api/admin/finances/summary')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.commissionRate).toBe(0.10);
    expect(res.body.totalCommissions).toBeCloseTo(20000);
    expect(res.body.commissionsDues).toBeCloseTo(20000);
  });

  test('retourne 0 partout sans paiements', async () => {
    appConfig.getConfig.mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/admin/finances/summary')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTransactions).toBe(0);
    expect(res.body.totalCommissions).toBe(0);
    expect(res.body.commissionsDues).toBe(0);
    expect(res.body.commissionsPercues).toBe(0);
  });

  test('retourne revenueByMonth avec 12 entrées', async () => {
    appConfig.getConfig.mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/admin/finances/summary')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.revenueByMonth).toBeDefined();
    expect(Object.keys(res.body.revenueByMonth)).toHaveLength(12);
  });
});

describe('GET /api/admin/finances/commissions', () => {
  const makeFullPayment = (proId, amount, commissionPaid = false) => ({
    id: `pay-${proId}-${amount}`, amount, commissionPaid,
    createdAt: new Date(), completedAt: new Date(), status: 'succeeded', isDeposit: false,
    quote: {
      professional: {
        id: proId, trade: 'Maçon', subscription: null,
        user: { id: `user-${proId}`, firstName: 'Pro', lastName: proId, email: `${proId}@test.com`, avatarUrl: null, city: 'Abidjan' },
      },
      project: { title: 'Projet test', id: 'proj-1' },
    },
  });

  beforeEach(() => {
    useAdmin();
    appConfig.getConfig.mockResolvedValue(null); // taux 8%
  });

  test('regroupe les paiements par professionnel', async () => {
    prisma.payment.findMany.mockResolvedValue([
      makeFullPayment('pro-a', 100000),
      makeFullPayment('pro-a', 50000),
      makeFullPayment('pro-b', 80000),
    ]);

    const res = await request(app)
      .get('/api/admin/finances/commissions')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    const pros = res.body.professionals;
    expect(pros).toHaveLength(2);

    const proA = pros.find(p => p.professionalId === 'pro-a');
    expect(proA.totalTransactions).toBe(150000);
    expect(proA.commissionDue).toBeCloseTo(12000); // 150000 × 0.08 (tout non payé)
  });

  test('filtre status=due — exclut les pros sans commission due', async () => {
    prisma.payment.findMany.mockResolvedValue([
      makeFullPayment('pro-a', 100000, false), // due
      makeFullPayment('pro-b', 50000,  true),  // payé → commissionDue = 0
    ]);

    const res = await request(app)
      .get('/api/admin/finances/commissions?status=due')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.professionals).toHaveLength(1);
    expect(res.body.professionals[0].professionalId).toBe('pro-a');
  });

  test('filtre status=paid — exclut les pros avec commission due', async () => {
    prisma.payment.findMany.mockResolvedValue([
      makeFullPayment('pro-a', 100000, false),
      makeFullPayment('pro-b', 50000,  true),
    ]);

    const res = await request(app)
      .get('/api/admin/finances/commissions?status=paid')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.professionals).toHaveLength(1);
    expect(res.body.professionals[0].professionalId).toBe('pro-b');
  });

  test('trie par commissionDue décroissante', async () => {
    prisma.payment.findMany.mockResolvedValue([
      makeFullPayment('pro-petit',  10000, false),
      makeFullPayment('pro-grand', 200000, false),
      makeFullPayment('pro-moyen',  50000, false),
    ]);

    const res = await request(app)
      .get('/api/admin/finances/commissions')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    const dues = res.body.professionals.map(p => p.commissionDue);
    expect(dues[0]).toBeGreaterThan(dues[1]);
    expect(dues[1]).toBeGreaterThan(dues[2]);
  });

  test('pagination — retourne page 1 avec le bon total', async () => {
    const payments = Array.from({ length: 5 }, (_, i) => makeFullPayment(`pro-${i}`, 10000));
    prisma.payment.findMany.mockResolvedValue(payments);

    const res = await request(app)
      .get('/api/admin/finances/commissions?page=1&limit=2')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.total).toBe(5);
    expect(res.body.professionals).toHaveLength(2);
    expect(res.body.totalPages).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. SUPPORT
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/support/stats', () => {
  beforeEach(() => {
    useAdmin();
    prisma.supportTicket.count
      .mockResolvedValueOnce(10)  // total
      .mockResolvedValueOnce(4)   // OPEN
      .mockResolvedValueOnce(3)   // IN_PROGRESS
      .mockResolvedValueOnce(2)   // RESOLVED
      .mockResolvedValueOnce(1);  // CLOSED
    prisma.supportTicket.groupBy.mockResolvedValue([
      { category: 'PAYMENT', _count: { _all: 5 } },
      { category: 'ACCOUNT', _count: { _all: 3 } },
    ]);
    prisma.supportTicket.findMany.mockResolvedValue([]); // pas de tickets résolus = avgResolutionHours null
  });

  test('retourne les compteurs par statut', async () => {
    const res = await request(app)
      .get('/api/admin/support/stats')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.open).toBe(4);
    expect(res.body.inProgress).toBe(3);
    expect(res.body.resolved).toBe(2);
    expect(res.body.closed).toBe(1);
  });

  test('retourne byCategory indexé par clé', async () => {
    const res = await request(app)
      .get('/api/admin/support/stats')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.byCategory.PAYMENT).toBe(5);
    expect(res.body.byCategory.ACCOUNT).toBe(3);
  });

  test('avgResolutionHours est null sans tickets résolus', async () => {
    const res = await request(app)
      .get('/api/admin/support/stats')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.avgResolutionHours).toBeNull();
  });

  test('calcule avgResolutionHours sur les tickets résolus', async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now - 48 * 3600 * 1000);
    prisma.supportTicket.findMany.mockResolvedValue([
      { createdAt: twoDaysAgo, updatedAt: now }, // 48h
    ]);

    const res = await request(app)
      .get('/api/admin/support/stats')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.body.avgResolutionHours).toBe(48);
  });
});

describe('GET /api/admin/support/tickets — filtre category', () => {
  beforeEach(() => {
    useAdmin();
    prisma.supportTicket.findMany.mockResolvedValue([]);
  });

  test('passe category au where Prisma', async () => {
    await request(app)
      .get('/api/admin/support/tickets?category=PAYMENT')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ category: 'PAYMENT' }) })
    );
  });

  test('passe status au where Prisma', async () => {
    await request(app)
      .get('/api/admin/support/tickets?status=OPEN')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(prisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'OPEN' }) })
    );
  });

  test('retourne 200 avec tableau vide', async () => {
    const res = await request(app)
      .get('/api/admin/support/tickets')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. MESSAGERIE ADMIN
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/messaging/stats', () => {
  beforeEach(() => {
    useAdmin();
    prisma.message.count.mockResolvedValue(100);
    prisma.message.findMany.mockResolvedValue([]);
    prisma.message.groupBy.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
  });

  test('retourne 200 avec les clés attendues', async () => {
    const res = await request(app)
      .get('/api/admin/messaging/stats')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('unread');
    expect(res.body).toHaveProperty('totalConversations');
    expect(res.body).toHaveProperty('activeConversations');
    expect(res.body).toHaveProperty('topSenders');
  });
});

describe('DELETE /api/admin/messaging/messages/:id', () => {
  beforeEach(() => {
    useAdmin();
  });

  test('supprime le message et retourne success', async () => {
    prisma.message.findUnique.mockResolvedValue({ id: 'msg-1', content: 'hello' });
    prisma.message.delete.mockResolvedValue({ id: 'msg-1' });

    const res = await request(app)
      .delete('/api/admin/messaging/messages/msg-1')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
  });

  test('retourne 404 si message introuvable', async () => {
    prisma.message.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/messaging/messages/inexistant')
      .set('Authorization', `Bearer ${adminToken(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});
