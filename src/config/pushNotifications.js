const axios = require('axios');
const prisma = require('./db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

let messaging = null;

function setMessaging(fcmMessaging) {
  messaging = fcmMessaging;
}

// Detect token type based on format
function detectTokenType(token) {
  if (token.startsWith('ExponentPushToken[')) return 'EXPO';
  if (token.length === 64 && /^[a-f0-9]{64}$/.test(token)) return 'APNs';
  if (token.length > 100) return 'FCM';
  return null;
}

// Send via Firebase Cloud Messaging
async function sendViaFCM(token, title, body, data = {}) {
  if (!messaging) {
    console.warn('[Push] Firebase not initialized, falling back to Expo');
    return null;
  }

  try {
    const message = {
      notification: {
        title: title.substring(0, 200),
        body: body.substring(0, 4000),
      },
      data: Object.keys(data).reduce((acc, key) => {
        acc[key] = String(data[key]);
        return acc;
      }, {}),
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default',
          icon: 'notification_icon',
          color: '#F4720B',
        },
      },
      token: token,
    };

    const response = await messaging.send(message);
    console.log('[FCM] ✅ Sent to', token.substring(0, 20) + '...', 'ID:', response);
    return { sent: true, type: 'FCM', messageId: response };
  } catch (err) {
    console.error('[FCM] ❌ Error:', err.message);
    return null;
  }
}

// Send via Expo (backward compatibility)
async function sendViaExpo(token, title, body, data = {}) {
  try {
    const message = {
      to: token,
      sound: 'default',
      title: title.substring(0, 200),
      body: body.substring(0, 4000),
      data,
    };

    const response = await axios.post(EXPO_PUSH_URL, message, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    console.log('[Expo] ✅ Sent to', token.substring(0, 40) + '...');
    return { sent: true, type: 'EXPO', ticket: response.data };
  } catch (err) {
    console.error('[Expo] ❌ Error:', err.message);
    return null;
  }
}

// Main function: Send to single user
async function sendPushNotification(userId, title, body, data = {}) {
  try {
    // Get user's tokens from PushToken table (new) + legacy expoPushToken
    const tokens = await prisma.pushToken.findMany({
      where: {
        userId: userId,
        isActive: true,
      },
    });

    if (tokens.length === 0) {
      console.warn('[Push] No active tokens for user:', userId);
      return { sent: false, reason: 'no_tokens' };
    }

    let successCount = 0;

    for (const tokenRecord of tokens) {
      let result = null;

      if (tokenRecord.type === 'FCM') {
        result = await sendViaFCM(tokenRecord.token, title, body, data);
      } else if (tokenRecord.type === 'EXPO') {
        result = await sendViaExpo(tokenRecord.token, title, body, data);
      }

      if (result?.sent) {
        successCount++;
        // Update last used timestamp
        await prisma.pushToken.update({
          where: { id: tokenRecord.id },
          data: { lastUsed: new Date() },
        });
      } else {
        // Mark token as inactive if send failed
        await prisma.pushToken.update({
          where: { id: tokenRecord.id },
          data: { isActive: false },
        });
      }
    }

    return { sent: successCount > 0, count: successCount, total: tokens.length };
  } catch (err) {
    console.error('[Push] Error sending to user', userId, ':', err.message);
    return { sent: false, reason: err.message };
  }
}

// Send to multiple users (optimized for FCM multicast)
async function sendPushToMultiple(userIds, title, body, data = {}) {
  const results = [];

  for (const userId of userIds) {
    const result = await sendPushNotification(userId, title, body, data);
    results.push({ userId, ...result });
  }

  const successCount = results.filter(r => r.sent).length;
  return {
    sent: successCount,
    total: userIds.length,
    details: results,
  };
}

module.exports = {
  setMessaging,
  sendPushNotification,
  sendPushToMultiple,
  sendViaFCM,
  sendViaExpo,
  detectTokenType,
};
