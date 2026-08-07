// Backup automatique de la base de données
// Usage: node scripts/backup.js
// Planification Windows: schtasks /create /tn "MANAWA Backup" /tr "node C:\Users\HP\Desktop\MANAWA\backend\scripts\backup.js" /sc daily /st 00:00

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '../backups');
const MAX_BACKUPS = 30; // Garder 30 jours

async function runBackup() {
  const p = new PrismaClient();
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const [users, professionals, projects, quotes, payments, messages,
           portfolioProjects, portfolioItems, reviews, follows,
           notifications, subscriptions, disputes, promoCodes] = await Promise.all([
      p.user.findMany({ select: { id: true, email: true, firstName: true, lastName: true, role: true, city: true, phone: true, avatarUrl: true, emailVerified: true, suspended: true, deletedAt: true, createdAt: true, updatedAt: true, adminLevel: true } }),
      p.professional.findMany(),
      p.project.findMany(),
      p.quote.findMany(),
      p.payment.findMany(),
      p.message.findMany(),
      p.portfolioProject.findMany({ include: { images: true } }),
      p.portfolioItem.findMany(),
      p.review.findMany(),
      p.follow.findMany(),
      p.notification.findMany(),
      p.subscription.findMany(),
      p.dispute.findMany(),
      p.promoCode.findMany(),
    ]);

    // Nettoyer les refresh tokens expirés
    const deleted = await p.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (deleted.count > 0) console.log(`[Backup] 🧹 ${deleted.count} refresh tokens expirés supprimés`);

    const backup = {
      date: new Date().toISOString(),
      counts: { users: users.length, professionals: professionals.length, projects: projects.length, payments: payments.length },
      users, professionals, projects, quotes, payments, messages,
      portfolioProjects, portfolioItems, reviews, follows,
      notifications, subscriptions, disputes, promoCodes,
    };

    const filename = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(backup));

    console.log(`[Backup] ✅ ${filename} — ${users.length} users, ${projects.length} projects, ${payments.length} payments`);

    // Supprimer les anciens backups au-delà de MAX_BACKUPS
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
      .sort();
    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(0, files.length - MAX_BACKUPS);
      toDelete.forEach(f => {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        console.log(`[Backup] 🗑 Ancien backup supprimé: ${f}`);
      });
    }
  } catch (err) {
    console.error('[Backup] ❌ Erreur:', err.message);
    process.exit(1);
  } finally {
    await p.$disconnect();
  }
}

runBackup();
