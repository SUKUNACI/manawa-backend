const prisma = require('../config/db');

// Valeurs par défaut — utilisées si la clé n'existe pas encore en DB
// readonly: true          → ne peut jamais être modifiée via l'API (valeur figée à la création)
// requiresConfirmation: true → exige req.body.confirmPassword (mot de passe admin) avant d'accepter
const DEFAULTS = {
  commission_rate:        { value: '0.08',  description: 'Taux de commission sur les paiements (ex: 0.08 = 8%)', requiresConfirmation: true },
  price_essentiel:        { value: '2500',  description: 'Prix mensuel abonnement Essentiel (FCFA)', requiresConfirmation: true },
  price_pro:              { value: '5000',  description: 'Prix mensuel abonnement Pro (FCFA)', requiresConfirmation: true },
  price_elite:            { value: '10000', description: 'Prix mensuel abonnement Élite (FCFA)', requiresConfirmation: true },
  trial_days:             { value: '14',    description: 'Durée de la période d\'essai (jours)' },
  max_quotes_essentiel:   { value: '20',    description: 'Devis maximum/mois pour le plan Essentiel' },
  max_trades_essentiel:   { value: '3',     description: 'Métiers maximum pour les plans Gratuit et Essentiel' },
  max_trades_premium:     { value: '6',     description: 'Métiers maximum pour les plans Pro et Élite' },
  intervention_radius_km: { value: '30',    description: 'Rayon d\'intervention par défaut (km)' },
  app_maintenance_mode:   { value: 'false', description: 'Mode maintenance — bloque les connexions non-admin', requiresConfirmation: true },
  app_name:               { value: 'MANAWA', description: 'Nom de l\'application affiché aux utilisateurs', readonly: true },
  support_email:          { value: 'support@manawa.app', description: 'Email de contact support affiché dans l\'app', readonly: true },
};

// Seed : insère les clés manquantes avec leurs valeurs par défaut
async function seedConfig() {
  for (const [key, { value, description }] of Object.entries(DEFAULTS)) {
    await prisma.appConfig.upsert({
      where: { key },
      create: { key, value, description },
      update: {}, // ne pas écraser si déjà présent
    });
  }
}

// Lire une config (retourne la valeur typée si possible)
async function getConfig(key) {
  const row = await prisma.appConfig.findUnique({ where: { key } });
  const raw = row ? row.value : (DEFAULTS[key]?.value ?? null);
  if (raw === null) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  return isNaN(num) ? raw : num;
}

// Lire toutes les configs
async function getAllConfig() {
  await seedConfig();
  const rows = await prisma.appConfig.findMany({ orderBy: { key: 'asc' } });
  const result = {};
  for (const row of rows) {
    result[row.key] = {
      value: row.value,
      description: row.description || DEFAULTS[row.key]?.description || '',
      readonly: DEFAULTS[row.key]?.readonly || false,
      requiresConfirmation: DEFAULTS[row.key]?.requiresConfirmation || false,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
  return result;
}

module.exports = { getConfig, getAllConfig, seedConfig, DEFAULTS };
