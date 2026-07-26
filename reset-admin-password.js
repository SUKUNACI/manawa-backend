/**
 * Réinitialisation du mot de passe admin MANAWA
 * Usage : node reset-admin-password.js
 * Nécessite un mot de passe de script distinct du mot de passe admin.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./src/config/db');

// Mot de passe requis pour exécuter ce script (≠ mot de passe back-office)
const SCRIPT_PASSWORD = process.env.RESET_SCRIPT_PASSWORD;

function askHidden(prompt) {
  return new Promise((resolve) => {
    let input = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function handler(ch) {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '') {
        process.stdout.write('\n');
        process.exit();
      } else if (ch === '') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(prompt + '•'.repeat(input.length));
        }
      } else {
        input += ch;
        process.stdout.write('•');
      }
    });
  });
}

async function main() {
  if (!SCRIPT_PASSWORD) {
    console.error('❌ Variable RESET_SCRIPT_PASSWORD manquante dans .env');
    process.exit(1);
  }

  console.log('\n🔐 Réinitialisation du mot de passe admin MANAWA\n');

  const scriptPwd = await askHidden('Mot de passe du script : ');
  if (scriptPwd !== SCRIPT_PASSWORD) {
    console.error('❌ Mot de passe incorrect');
    process.exit(1);
  }

  const newPassword = await askHidden('Nouveau mot de passe admin : ');
  if (newPassword.length < 12) {
    console.error('❌ Le mot de passe doit faire au moins 12 caractères');
    process.exit(1);
  }

  const confirm = await askHidden('Confirmer le nouveau mot de passe : ');
  if (newPassword !== confirm) {
    console.error('❌ Les mots de passe ne correspondent pas');
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { email: 'app_manawa@proton.me' },
    data: { passwordHash: hash },
  });

  console.log('\n✅ Mot de passe admin mis à jour avec succès\n');
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
