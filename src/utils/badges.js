const prisma = require('../config/db');

const BADGES = {
  FIRST_QUOTE:    { key: 'FIRST_QUOTE',    label: 'Premier devis',        icon: 'file-text', color: '#3B82F6', description: 'A envoyé son premier devis' },
  FIRST_MISSION:  { key: 'FIRST_MISSION',  label: 'Première mission',     icon: 'briefcase', color: '#22C55E', description: 'A complété sa première mission' },
  TEN_MISSIONS:   { key: 'TEN_MISSIONS',   label: '10 missions',          icon: 'award',     color: '#F4720B', description: '10 missions complétées' },
  FIFTY_MISSIONS: { key: 'FIFTY_MISSIONS', label: '50 missions',          icon: 'star',      color: '#EAB308', description: '50 missions complétées' },
  TOP_RATED:      { key: 'TOP_RATED',      label: 'Très bien noté',       icon: 'thumbs-up', color: '#10B981', description: 'Note moyenne ≥ 4.5 sur 10+ avis' },
  VERIFIED_ID:    { key: 'VERIFIED_ID',    label: 'Identité vérifiée',    icon: 'shield',    color: '#6366F1', description: 'Identité validée par MANAWA' },
  PREMIUM:        { key: 'PREMIUM',        label: 'Membre Premium',       icon: 'zap',       color: '#F59E0B', description: 'Abonnement Premium actif' },
  FAST_RESPONDER: { key: 'FAST_RESPONDER', label: 'Réactif',              icon: 'clock',     color: '#06B6D4', description: 'Répond en moins de 2h en moyenne' },
  PORTFOLIO_RICH: { key: 'PORTFOLIO_RICH', label: 'Portfolio complet',    icon: 'image',     color: '#8B5CF6', description: '10+ réalisations publiées' },
  TRUSTED:        { key: 'TRUSTED',        label: 'Artisan de confiance', icon: 'heart',     color: '#EF4444', description: 'Score de confiance ≥ 80' },
  COMPANY:        { key: 'COMPANY',        label: 'Entreprise',           icon: 'users',     color: '#64748B', description: 'Compte entreprise vérifié' },
  EARLY_ADOPTER:  { key: 'EARLY_ADOPTER',  label: 'Early adopter',        icon: 'sunrise',   color: '#F97316', description: 'Parmi les 500 premiers inscrits' },
  REFERRER:       { key: 'REFERRER',       label: 'Ambassadeur',          icon: 'share-2',   color: '#EC4899', description: 'A parrainé 3+ artisans qualifiés' },
};

/**
 * Calcule et persiste les nouveaux badges débloqués pour un professionnel.
 * Retourne la liste complète des badges avec métadonnées.
 * @param {string} professionalId
 * @returns {Promise<Array>}
 */
async function computeBadges(professionalId) {
  const pro = await prisma.professional.findUnique({
    where: { id: professionalId },
    include: {
      user: true,
      subscription: true,
      portfolioProjects: { select: { id: true } },
      reviews: { select: { rating: true } },
      quotes: { select: { id: true } },
      badges: true,
    },
  });
  if (!pro) return [];

  const earned = new Set(pro.badges.map(b => b.badgeKey));
  const toAdd = [];

  // FIRST_QUOTE
  if (!earned.has('FIRST_QUOTE') && pro.quotes.length >= 1) toAdd.push('FIRST_QUOTE');

  // FIRST_MISSION
  if (!earned.has('FIRST_MISSION') && pro.completedMissionsCount >= 1) toAdd.push('FIRST_MISSION');

  // TEN_MISSIONS
  if (!earned.has('TEN_MISSIONS') && pro.completedMissionsCount >= 10) toAdd.push('TEN_MISSIONS');

  // FIFTY_MISSIONS
  if (!earned.has('FIFTY_MISSIONS') && pro.completedMissionsCount >= 50) toAdd.push('FIFTY_MISSIONS');

  // TOP_RATED — note moyenne ≥ 4.5 avec au moins 10 avis
  if (!earned.has('TOP_RATED') && pro.reviewCount >= 10 && pro.averageRating >= 4.5) toAdd.push('TOP_RATED');

  // VERIFIED_ID — identité approuvée par admin
  if (!earned.has('VERIFIED_ID') && pro.identityStatus === 'APPROVED') toAdd.push('VERIFIED_ID');

  // PREMIUM — abonnement actif
  if (!earned.has('PREMIUM') && pro.subscription?.status === 'ACTIVE') toAdd.push('PREMIUM');

  // PORTFOLIO_RICH — 10+ réalisations
  if (!earned.has('PORTFOLIO_RICH') && pro.portfolioProjects.length >= 10) toAdd.push('PORTFOLIO_RICH');

  // TRUSTED — score de confiance ≥ 80
  const { computeTrustScore } = require('./trustScore');
  const score = computeTrustScore(pro);
  if (!earned.has('TRUSTED') && score >= 80) toAdd.push('TRUSTED');

  // COMPANY — compte entreprise vérifié par admin
  if (!earned.has('COMPANY') && pro.accountType === 'ENTREPRISE' && pro.verifiedByAdmin) toAdd.push('COMPANY');

  // EARLY_ADOPTER — parmi les 500 premiers pros inscrits
  if (!earned.has('EARLY_ADOPTER')) {
    const rank = await prisma.professional.count({ where: { createdAt: { lt: pro.createdAt } } });
    if (rank < 500) toAdd.push('EARLY_ADOPTER');
  }

  // REFERRER — nécessite le modèle Referral, non implémenté
  // FAST_RESPONDER — nécessite tracking temps de réponse, non implémenté

  // Persister les nouveaux badges en une seule opération
  if (toAdd.length > 0) {
    await prisma.professionalBadge.createMany({
      data: toAdd.map(key => ({ professionalId, badgeKey: key })),
      skipDuplicates: true,
    });
  }

  // Retourner tous les badges avec métadonnées BADGES
  const allBadges = await prisma.professionalBadge.findMany({
    where: { professionalId },
    orderBy: { earnedAt: 'asc' },
  });
  return allBadges.map(b => ({ ...b, ...BADGES[b.badgeKey] })).filter(b => b.label);
}

module.exports = { BADGES, computeBadges };
