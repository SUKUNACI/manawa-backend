const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccountPath = path.join(__dirname, '../../manawa-01-firebase-adminsdk-fbsvc-96ec269890.json');

let firebaseApp = null;

function loadServiceAccount() {
  // Env var en priorité (prod Railway)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch {
      console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT invalide (JSON malformé)');
      return null;
    }
  }
  // Fallback fichier local (dev)
  if (fs.existsSync(serviceAccountPath)) {
    return require(serviceAccountPath);
  }
  console.error('[Firebase] Aucun service account trouvé (fichier ni variable FIREBASE_SERVICE_ACCOUNT)');
  return null;
}

function initializeFirebase() {
  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) return null;

    if (firebaseApp) {
      console.log('[Firebase] Already initialized');
      return firebaseApp;
    }

    firebaseApp = admin.initializeApp({
      credential: admin.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

    console.log('[Firebase] ✅ Initialized successfully for project:', serviceAccount.project_id);
    return firebaseApp;
  } catch (err) {
    console.error('[Firebase] ❌ Initialization error:', err.message);
    return null;
  }
}

function getMessaging() {
  if (!firebaseApp) {
    throw new Error('[Firebase] Firebase not initialized');
  }
  const { getMessaging: fcmGetMessaging } = require('firebase-admin/messaging');
  return fcmGetMessaging(firebaseApp);
}

module.exports = {
  initializeFirebase,
  getMessaging,
  isInitialized: () => firebaseApp !== null,
};
