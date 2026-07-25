const prisma = require('../config/db');

async function logPaymentStatus({ paymentId, fromStatus, toStatus, reason, triggeredBy = 'system', ipAddress = null, metadata = null }) {
  try {
    await prisma.paymentAuditLog.create({
      data: {
        paymentId,
        fromStatus,
        toStatus,
        reason,
        triggeredBy,
        ipAddress,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });
  } catch (err) {
    console.error('[AuditLog] Erreur écriture log paiement:', err.message);
  }
}

module.exports = { logPaymentStatus };
