'use strict';
/**
 * Talking to Shopify.
 *
 * The store's own app authenticates with a client credentials grant rather than a
 * stored token — it exchanges its key and secret for a token that lasts a day. We do
 * the same thing with the same credentials rather than minting a second set, so there
 * is one app on the store and one place to change its permissions.
 *
 * The credentials are read from the sync app's environment file. Nothing is copied or
 * printed; if that file moves, SHOPIFY_API_KEY and SHOPIFY_API_SECRET_KEY can be set on
 * this app instead and they win.
 */
const fs = require('fs');

const LARAVEL_ENV = process.env.SHOPIFY_ENV_FILE || '/var/www/retailedge-shopify/.env';
const API_VERSION = '2024-10';

let cached = null;

function credentials() {
  if (process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET_KEY) {
    return {
      shop: process.env.SHOPIFY_STORE_NAME,
      key: process.env.SHOPIFY_API_KEY,
      secret: process.env.SHOPIFY_API_SECRET_KEY,
    };
  }
  let text;
  try {
    text = fs.readFileSync(LARAVEL_ENV, 'utf8');
  } catch (err) {
    throw new Error(`No Shopify credentials: set SHOPIFY_API_KEY and SHOPIFY_API_SECRET_KEY, or make ${LARAVEL_ENV} readable`);
  }
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return { shop: env.SHOPIFY_STORE_NAME, key: env.SHOPIFY_API_KEY, secret: env.SHOPIFY_API_SECRET_KEY };
}

/** A token good for a day, kept until shortly before it lapses. */
async function accessToken() {
  if (cached && Date.now() < cached.expires - 300_000) return cached;

  const { shop, key, secret } = credentials();
  if (!shop || !key || !secret) throw new Error('Shopify credentials are incomplete');

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: key, client_secret: secret }),
  });
  if (!res.ok) {
    // Deliberately not logging the body — it can echo the credentials back.
    throw new Error(`Shopify refused the token exchange (${res.status})`);
  }
  const json = await res.json();
  cached = { shop, token: json.access_token, expires: Date.now() + (json.expires_in || 86400) * 1000 };
  return cached;
}

async function request(path, { method = 'GET', body } = {}) {
  const { shop, token } = await accessToken();
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Shopify returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * What this app is allowed to do on the store.
 *
 * Worth asking before attempting a write: a missing scope comes back as a flat 403
 * with nothing to say which permission is absent, and that is a confusing thing to
 * debug from the other end.
 */
async function scopes() {
  // Asked of the installation, not of the token.
  //
  // /admin/oauth/access_scopes.json answers for the token presented, and a token minted
  // from client credentials can still carry the scopes as they were before the merchant
  // approved an update — it reported eight scopes for a full day after write_orders had
  // genuinely been granted. Believing it would mean refusing to write while holding
  // permission to, which is a maddening thing to debug.
  const res = await request('/graphql.json', {
    method: 'POST',
    body: { query: '{ currentAppInstallation { accessScopes { handle } } }' },
  });
  const granted = res?.data?.currentAppInstallation?.accessScopes;
  if (!granted) throw new Error("could not read the app's granted scopes");
  return granted.map((s) => s.handle);
}

module.exports = { request, scopes, accessToken, API_VERSION };
