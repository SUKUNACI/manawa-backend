/**
 * Score de confiance dynamique (0–100)
 * Combinaison de bonus (actions positives) et pénalités (comportement négatif).
 * Calculé à la volée, jamais stocké en base.
 */

// --- BONUS (max théorique ~130, capé à 100) ---
const BONUS = {
  AVATAR:              10,  // Photo de profil
  EMAIL_VERIFIED:      10,  // Email vérifié
  IDENTITY_VERIFIED:   20,  // Identité vérifiée par admin
  PORTFOLIO_MIN3:      15,  // Portfolio avec min 3 photos
  PHONE_VERIFIED:      10,  // Téléphone vérifié
  DESCRIPTION:          5,  // Description complète (>50 chars)
  FIRST_QUOTE_SENT:     5,  // Au moins 1 devis envoyé
  FIRST_QUOTE_ACCEPTED: 10, // Au moins 1 devis accepté
  RATING_PER_STAR:      5,  // Par avis ≥4 étoiles (max 5 = +25)
  RATING_MAX:          25,
  DECENNALE:           10,  // Assurance décennale vérifiée
  COMPLETION_RATE:     20,  // Taux de complétion (proportionnel)
  SENIORITY:           10,  // Ancienneté (max 12 mois)
  COMPANY_QUALITY:     20,  // ≥80% des membres ont trustScore ≥60
};

// --- PENALITES ---
const PENALTY = {
  PER_COMPLAINT:       -10, // Par plainte reçue
  PER_CANCELLATION:     -5, // Par mission annulée
  PER_BAD_REVIEW:       -8, // Par avis < 3 étoiles
  LOW_RATING:          -15, // Note moyenne < 2.5
};

function computeTrustScore(pro, extras = {}) {
  let score = 0;

  // --- Bonus profil ---
  if (pro.user?.avatarUrl) score += BONUS.AVATAR;
  if (pro.user?.emailVerified) score += BONUS.EMAIL_VERIFIED;
  if (pro.verifiedByAdmin) score += BONUS.IDENTITY_VERIFIED;
  if ((pro.portfolio?.length || 0) >= 3) score += BONUS.PORTFOLIO_MIN3;
  if (pro.user?.phoneVerified) score += BONUS.PHONE_VERIFIED;
  if ((pro.description?.length || 0) > 50) score += BONUS.DESCRIPTION;
  if (pro.decennaleVerified) score += BONUS.DECENNALE;

  // --- Bonus activité ---
  const quoteSentCount = extras.quoteSentCount ?? 0;
  const quoteAcceptedCount = extras.quoteAcceptedCount ?? 0;
  if (quoteSentCount > 0) score += BONUS.FIRST_QUOTE_SENT;
  if (quoteAcceptedCount > 0) score += BONUS.FIRST_QUOTE_ACCEPTED;

  // --- Bonus avis (chaque avis ≥4 étoiles = +5, max +25) ---
  const goodReviewCount = extras.goodReviewCount ?? Math.min(Math.floor(pro.averageRating >= 4 ? pro.reviewCount : 0), 5);
  score += Math.min(goodReviewCount * BONUS.RATING_PER_STAR, BONUS.RATING_MAX);

  // --- Bonus taux de complétion ---
  const totalMissions = pro.completedMissionsCount + pro.cancelledMissionsCount;
  if (totalMissions > 0) {
    const completionRate = pro.completedMissionsCount / totalMissions;
    score += Math.round(completionRate * BONUS.COMPLETION_RATE);
  }

  // --- Bonus ancienneté ---
  const monthsActive = (Date.now() - new Date(pro.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
  score += Math.round(Math.min(monthsActive / 12, 1) * BONUS.SENIORITY);

  // --- PENALITES ---
  const complaintsCount = pro.complaintsCount || 0;
  score += complaintsCount * PENALTY.PER_COMPLAINT;

  score += pro.cancelledMissionsCount * PENALTY.PER_CANCELLATION;

  const badReviewCount = extras.badReviewCount ?? 0;
  score += badReviewCount * PENALTY.PER_BAD_REVIEW;

  if (pro.averageRating > 0 && pro.averageRating < 2.5) {
    score += PENALTY.LOW_RATING;
  }

  if (pro.accountType === 'ENTREPRISE' && extras.memberQualityRate !== undefined) {
    if (extras.memberQualityRate >= 0.8) {
      score += BONUS.COMPANY_QUALITY;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getTrustScoreBreakdown(pro, extras = {}) {
  const breakdown = { bonus: [], penalties: [], total: 0 };

  if (pro.user?.avatarUrl) breakdown.bonus.push({ label: 'Photo de profil', points: BONUS.AVATAR });
  if (pro.user?.emailVerified) breakdown.bonus.push({ label: 'Email vérifié', points: BONUS.EMAIL_VERIFIED });
  if (pro.verifiedByAdmin) breakdown.bonus.push({ label: 'Identité vérifiée', points: BONUS.IDENTITY_VERIFIED });
  if ((pro.portfolio?.length || 0) >= 3) breakdown.bonus.push({ label: 'Portfolio (3+ photos)', points: BONUS.PORTFOLIO_MIN3 });
  if (pro.user?.phoneVerified) breakdown.bonus.push({ label: 'Téléphone vérifié', points: BONUS.PHONE_VERIFIED });
  if ((pro.description?.length || 0) > 50) breakdown.bonus.push({ label: 'Description complète', points: BONUS.DESCRIPTION });
  if (pro.decennaleVerified) breakdown.bonus.push({ label: 'Assurance décennale', points: BONUS.DECENNALE });

  const quoteSentCount = extras.quoteSentCount ?? 0;
  const quoteAcceptedCount = extras.quoteAcceptedCount ?? 0;
  if (quoteSentCount > 0) breakdown.bonus.push({ label: 'Premier devis envoyé', points: BONUS.FIRST_QUOTE_SENT });
  if (quoteAcceptedCount > 0) breakdown.bonus.push({ label: 'Premier devis accepté', points: BONUS.FIRST_QUOTE_ACCEPTED });

  const goodReviewCount = extras.goodReviewCount ?? Math.min(Math.floor(pro.averageRating >= 4 ? pro.reviewCount : 0), 5);
  const ratingBonus = Math.min(goodReviewCount * BONUS.RATING_PER_STAR, BONUS.RATING_MAX);
  if (ratingBonus > 0) breakdown.bonus.push({ label: `Avis positifs (${goodReviewCount})`, points: ratingBonus });

  const totalMissions = pro.completedMissionsCount + pro.cancelledMissionsCount;
  if (totalMissions > 0) {
    const completionRate = pro.completedMissionsCount / totalMissions;
    const pts = Math.round(completionRate * BONUS.COMPLETION_RATE);
    breakdown.bonus.push({ label: `Taux complétion (${Math.round(completionRate * 100)}%)`, points: pts });
  }

  const monthsActive = (Date.now() - new Date(pro.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
  const seniorityPts = Math.round(Math.min(monthsActive / 12, 1) * BONUS.SENIORITY);
  if (seniorityPts > 0) breakdown.bonus.push({ label: `Ancienneté (${Math.round(monthsActive)} mois)`, points: seniorityPts });

  if (pro.accountType === 'ENTREPRISE') {
    if (extras.memberQualityRate !== undefined && extras.memberQualityRate >= 0.8) {
      breakdown.bonus.push({ label: `Équipe qualifiée (${Math.round(extras.memberQualityRate * 100)}% ≥ 60pts)`, points: BONUS.COMPANY_QUALITY });
    }
  }

  // Penalties
  const complaintsCount = pro.complaintsCount || 0;
  if (complaintsCount > 0) breakdown.penalties.push({ label: `Plaintes reçues (${complaintsCount})`, points: complaintsCount * PENALTY.PER_COMPLAINT });
  if (pro.cancelledMissionsCount > 0) breakdown.penalties.push({ label: `Missions annulées (${pro.cancelledMissionsCount})`, points: pro.cancelledMissionsCount * PENALTY.PER_CANCELLATION });

  const badReviewCount = extras.badReviewCount ?? 0;
  if (badReviewCount > 0) breakdown.penalties.push({ label: `Avis négatifs (${badReviewCount})`, points: badReviewCount * PENALTY.PER_BAD_REVIEW });
  if (pro.averageRating > 0 && pro.averageRating < 2.5) breakdown.penalties.push({ label: 'Note moyenne faible', points: PENALTY.LOW_RATING });

  breakdown.total = computeTrustScore(pro, extras);
  return breakdown;
}

module.exports = { computeTrustScore, getTrustScoreBreakdown };
