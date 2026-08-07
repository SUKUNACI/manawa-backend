const axios = require('axios');

const DAILY_API = 'https://api.daily.co/v1';

async function createVideoRoom(name, expiryMinutes = 60) {
  if (!process.env.DAILY_API_KEY) return null; // graceful degradation
  const exp = Math.floor(Date.now() / 1000) + expiryMinutes * 60;
  const res = await axios.post(`${DAILY_API}/rooms`, {
    name,
    properties: { exp, enable_chat: true, enable_screenshare: false, max_participants: 2 },
  }, {
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' },
  });
  return res.data; // { id, name, url, ... }
}

async function deleteVideoRoom(name) {
  if (!process.env.DAILY_API_KEY) return;
  await axios.delete(`${DAILY_API}/rooms/${name}`, {
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` },
  }).catch(() => {}); // ignore 404
}

module.exports = { createVideoRoom, deleteVideoRoom };
