'use strict';
const config = require('../config');

/**
 * Login with Amazon: exchange the long-lived refresh token for a short-lived access
 * token. Amazon issues these for an hour; we refresh five minutes early so a long
 * job never dies holding an expired one.
 */
let cached = { token: null, expiresAt: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expiresAt - 300_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.amazon.refreshToken,
    client_id: config.amazon.clientId,
    client_secret: config.amazon.clientSecret,
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Amazon rejected our credentials (${res.status}): ${detail.slice(0, 200)}`);
  }

  const json = await res.json();
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

module.exports = { accessToken };
