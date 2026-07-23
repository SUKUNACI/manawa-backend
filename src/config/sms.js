const isConfigured = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER;

let twilioClient = null;
if (isConfigured) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Envoie un SMS avec un code de vérification.
 * Si les identifiants Twilio ne sont pas configurés dans .env,
 * le SMS n'est PAS envoyé : le code est simplement retourné (mode test).
 * ⚠️ Ce mode test ne doit JAMAIS être actif en production.
 */
async function sendVerificationSms(toPhone, code) {
  if (!isConfigured) {
    console.log(`[MODE TEST - pas de SMS envoyé] Code pour ${toPhone} : ${code}`);
    return { sent: false, devCode: code };
  }

  await twilioClient.messages.create({
    body: `Votre code de vérification MANAWA est : ${code}`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: toPhone,
  });
  return { sent: true };
}

module.exports = { sendVerificationSms, isConfigured };
