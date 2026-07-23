const Mailjet = require('node-mailjet');

const MJ_API_KEY = process.env.MAILJET_API_KEY;
const MJ_SECRET_KEY = process.env.MAILJET_SECRET_KEY;
const FROM_EMAIL = process.env.MAILJET_FROM_EMAIL || 'noreply@manawa.app';
const FROM_NAME = process.env.MAILJET_FROM_NAME || 'MANAWA';

const isConfigured = !!(MJ_API_KEY && MJ_SECRET_KEY);

let mailjet = null;
if (isConfigured) {
  mailjet = new Mailjet({ apiKey: MJ_API_KEY, apiSecret: MJ_SECRET_KEY });
}

function buildHtml(code, isVerification) {
  const title = isVerification ? 'Vérification de votre adresse email' : 'Réinitialisation de mot de passe';
  const label = isVerification ? 'Votre code de vérification' : 'Votre code de réinitialisation';
  const footer = isVerification
    ? "Si vous n'avez pas créé de compte MANAWA, ignorez cet email."
    : "Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.";

  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0A0D14;color:#fff;border-radius:12px;">
      <h2 style="color:#F97316;margin-bottom:8px;">MANAWA</h2>
      <p style="color:#9CA3AF;margin-bottom:24px;">${title}</p>
      <div style="background:#1A1F2E;border-radius:10px;padding:24px;text-align:center;margin-bottom:24px;">
        <p style="color:#9CA3AF;font-size:13px;margin-bottom:8px;">${label}</p>
        <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#F97316;">${code}</span>
      </div>
      <p style="color:#9CA3AF;font-size:13px;">Ce code expire dans <strong style="color:#fff;">15 minutes</strong>.</p>
      <p style="color:#6B7280;font-size:12px;margin-top:24px;">${footer}</p>
    </div>`;
}

async function sendVerificationEmail(to, code, purpose) {
  const isVerification = purpose === 'verify';

  const subject = isVerification
    ? 'Vérifiez votre adresse email — MANAWA'
    : 'Réinitialisation de votre mot de passe — MANAWA';

  const text = isVerification
    ? `Votre code de vérification est : ${code}\n\nCe code expire dans 15 minutes.`
    : `Votre code de réinitialisation est : ${code}\n\nCe code expire dans 15 minutes.`;

  const html = buildHtml(code, isVerification);

  if (!isConfigured) {
    const label = isVerification ? 'vérification' : 'reset';
    console.log(`[MAILJET non configuré] Code ${label} pour ${to} : ${code}`);
    return { sent: false, devCode: code };
  }

  try {
    const response = await mailjet
      .post('send', { version: 'v3.1' })
      .request({
        Messages: [
          {
            From: { Email: FROM_EMAIL, Name: FROM_NAME },
            To: [{ Email: to }],
            Subject: subject,
            TextPart: text,
            HTMLPart: html,
          },
        ],
      });

    const status = response.body?.Messages?.[0]?.Status;
    if (status && status !== 'success') {
      throw new Error(`Mailjet message status: ${status}`);
    }

    return { sent: true };
  } catch (err) {
    const statusCode = err.statusCode || err.response?.statusCode;
    const errorInfo = err.response?.body || err.message;
    console.error(`[Mailjet] Erreur envoi email (${statusCode}):`, errorInfo);

    if (statusCode === 401) throw new Error('Mailjet : clés API invalides');
    if (statusCode === 429) throw new Error('Mailjet : limite de débit atteinte, réessayez plus tard');
    if (statusCode >= 500) throw new Error('Mailjet : erreur serveur, réessayez plus tard');

    throw new Error(`Impossible d'envoyer l'email de ${isVerification ? 'vérification' : 'réinitialisation'}`);
  }
}

module.exports = { sendVerificationEmail, isConfigured };
