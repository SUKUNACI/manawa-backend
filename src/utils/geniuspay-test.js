// 🧪 Utilitaire de Test GeniusPay
// Utilise: node src/utils/geniuspay-test.js

const geniuspay = require('./geniuspay');

async function testGeniusPay() {
  console.log('\n🧪 Test GeniusPay Integration\n');

  try {
    // Test 1: Account Info
    console.log('1️⃣  Récupérer infos du compte...');
    const account = await geniuspay.getAccountInfo();
    if (account.success) {
      console.log(`   ✅ Compte: ${account.data.business_name} (${account.data.status})`);
      console.log(`   📍 Env: ${account.data.environment}\n`);
    } else {
      console.log(`   ❌ Erreur: ${account.error?.message}\n`);
      process.exit(1);
    }

    // Test 2: Account Balance
    console.log('2️⃣  Récupérer solde du compte...');
    const balance = await geniuspay.getAccountBalance();
    if (balance.success) {
      console.log(`   ✅ Solde disponible: ${balance.data.available} XOF`);
      console.log(`   ⏳ En attente: ${balance.data.pending} XOF`);
      console.log(`   💰 Total: ${balance.data.total} XOF\n`);
    } else {
      console.log(`   ❌ Erreur: ${balance.error?.message}\n`);
    }

    // Test 3: PawaPay Providers
    console.log('3️⃣  Lister fournisseurs Mobile Money (CI)...');
    const providers = await geniuspay.getPawapayProviders('CI');
    if (providers.success) {
      const country = providers.data;
      console.log(`   ✅ Pays: ${country.country_name}`);
      console.log(`   💱 Devise: ${country.currency}`);
      console.log(`   📱 Opérateurs:`);
      country.providers.forEach(p => {
        console.log(`      • ${p.name} (${p.code})`);
      });
      console.log('');
    } else {
      console.log(`   ❌ Erreur: ${providers.error?.message}\n`);
    }

    // Test 4: Create Payment (simulé)
    console.log('4️⃣  Créer un paiement de test (mode checkout)...');
    const paymentResult = await geniuspay.createPayment({
      amount: 15000,
      description: 'Test Paiement - MANAWA',
      customerName: 'Test User',
      customerEmail: 'test@example.com',
      customerPhone: '+2250748123456',
      quoteId: 999,
      projectId: 998,
      isDeposit: true,
      userId: 997,
      successUrl: 'http://localhost:4000/api/payments/success',
      errorUrl: 'http://localhost:4000/api/payments/error',
    });

    if (paymentResult.success) {
      console.log(`   ✅ Paiement créé avec succès`);
      console.log(`   📋 Référence: ${paymentResult.data.reference}`);
      console.log(`   💳 Montant: ${paymentResult.data.amount} XOF`);
      console.log(`   🔗 Checkout URL: ${paymentResult.data.checkout_url || paymentResult.data.payment_url}`);
      console.log(`   ⏱️  Expire: ${paymentResult.data.expires_at}\n`);

      // Test 5: Get Payment
      const reference = paymentResult.data.reference;
      console.log(`5️⃣  Récupérer les détails du paiement...`);
      const payment = await geniuspay.getPayment(reference);
      if (payment.success) {
        console.log(`   ✅ Paiement trouvé`);
        console.log(`   Status: ${payment.data.status}`);
        console.log(`   Frais: ${payment.data.fees} XOF`);
        console.log(`   Net: ${payment.data.net_amount} XOF\n`);
      } else {
        console.log(`   ❌ Erreur: ${payment.error?.message}\n`);
      }
    } else {
      console.log(`   ⚠️  Erreur: ${paymentResult.error?.message}\n`);
    }

    // Test 6: Webhook Signature
    console.log('6️⃣  Tester vérification signature webhook...');
    const testTimestamp = Math.floor(Date.now() / 1000);
    const testPayload = { id: 123, status: 'completed' };
    const secret = process.env.GENIUSPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.log('   ⚠️  GENIUSPAY_WEBHOOK_SECRET non défini — test de signature ignoré\n');
      return;
    }
    const testSignature = require('crypto')
      .createHmac('sha256', secret)
      .update(`${testTimestamp}.${JSON.stringify(testPayload)}`)
      .digest('hex');

    const isValid = geniuspay.verifyWebhookSignature(testSignature, testTimestamp, testPayload);
    console.log(`   ${isValid ? '✅' : '❌'} Signature webhook: ${isValid ? 'valide' : 'invalide'}`);

    const isValidTimestamp = geniuspay.verifyWebhookTimestamp(testTimestamp);
    console.log(`   ${isValidTimestamp ? '✅' : '❌'} Timestamp: ${isValidTimestamp ? 'valide' : 'trop ancien'}\n`);

    console.log('✅ Tous les tests terminés!\n');
  } catch (err) {
    console.error('\n❌ Erreur:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run tests
if (require.main === module) {
  testGeniusPay();
}

module.exports = { testGeniusPay };
