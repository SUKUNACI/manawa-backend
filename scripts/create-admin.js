const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const [email, password, firstName, lastName] = process.argv.slice(2);
  if (!email || !password || !firstName || !lastName) {
    console.log('Usage : node scripts/create-admin.js email motdepasse Prenom Nom');
    process.exit(1);
  }
  if (password.length < 6) {
    console.log('Le mot de passe doit faire au moins 6 caracteres.');
    process.exit(1);
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
    console.log('Compte existant promu administrateur : ' + email);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.user.create({
    data: { email, passwordHash, firstName, lastName, role: 'ADMIN' },
  });
  console.log('Compte administrateur cree : ' + admin.email);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());