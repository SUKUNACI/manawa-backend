const axios = require('axios');
const crypto = require('crypto');

const GENIUSPAY_BASE_URL = 'https://geniuspay.ci/api/v1/merchant';
const API_KEY = process.env.GENIUSPAY_API_KEY;
const API_SECRET = process.env.GENIUSPAY_API_SECRET;
const WEBHOOK_SECRET = process.env.GENIUSPAY_WEBHOOK_SECRET;

const client = axios.create({
  baseURL: GENIUSPAY_BASE_URL,
  timeout: 15000,
  headers: {
    'X-API-Key': API_KEY,
    'X-API-Secret': API_SECRET,
    'Content-Type': 'application/json',
  },
});

// Initier un paiement GeniusPay
async function createPayment(payload) {
  try {
    const response = await client.post('/payments', {
      amount: payload.amount,
      currency: 'XOF',
      description: payload.description,
      customer: {
        name: payload.customerName,
        email: payload.customerEmail,
        phone: payload.customerPhone,
      },
      metadata: {
        quoteId: payload.quoteId,
        projectId: payload.projectId,
        isDeposit: payload.isDeposit,
        userId: payload.userId,
      },
      success_url: payload.successUrl,
      error_url: payload.errorUrl,
      // Omit payment_method to show checkout page
    });

    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('[GeniusPay] createPayment error — status:', status, 'code:', err.code, 'data:', JSON.stringify(data), 'msg:', err.message);
    throw err;
  }
}

// Récupérer les détails d'un paiement par référence
async function getPayment(reference) {
  try {
    const response = await client.get(`/payments/${reference}`);
    return response.data;
  } catch (err) {
    console.error('GeniusPay getPayment error:', err.response?.data || err.message);
    throw err;
  }
}

// Lister les paiements avec filtres
async function listPayments(filters = {}) {
  try {
    const response = await client.get('/payments', { params: filters });
    return response.data;
  } catch (err) {
    console.error('GeniusPay listPayments error:', err.response?.data || err.message);
    throw err;
  }
}

// Récupérer les infos du compte
async function getAccountInfo() {
  try {
    const response = await client.get('/account');
    return response.data;
  } catch (err) {
    console.error('GeniusPay getAccountInfo error:', err.response?.data || err.message);
    throw err;
  }
}

// Récupérer le solde du compte
async function getAccountBalance() {
  try {
    const response = await client.get('/account/balance');
    return response.data;
  } catch (err) {
    console.error('GeniusPay getAccountBalance error:', err.response?.data || err.message);
    throw err;
  }
}

// Récupérer les fournisseurs MMO disponibles
async function getPawapayProviders(country = null) {
  try {
    const url = country ? `/pawapay/providers?country=${country}` : '/pawapay/providers';
    const response = await client.get(url);
    return response.data;
  } catch (err) {
    console.error('GeniusPay getPawapayProviders error:', err.response?.data || err.message);
    throw err;
  }
}

// Vérifier la signature d'un webhook
function verifyWebhookSignature(signature, timestamp, payload) {
  if (!WEBHOOK_SECRET) {
    console.warn('GENIUSPAY_WEBHOOK_SECRET not configured');
    return false;
  }

  // Format: signature = HMAC-SHA256(timestamp + "." + json_payload, secret)
  const data = `${timestamp}.${JSON.stringify(payload)}`;
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(data)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// Vérifier le timestamp (protection contre les replay attacks - 5 min)
function verifyWebhookTimestamp(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 5 * 60; // 5 minutes
  return Math.abs(now - parseInt(timestamp)) <= maxAge;
}

module.exports = {
  createPayment,
  getPayment,
  listPayments,
  getAccountInfo,
  getAccountBalance,
  getPawapayProviders,
  verifyWebhookSignature,
  verifyWebhookTimestamp,
};
