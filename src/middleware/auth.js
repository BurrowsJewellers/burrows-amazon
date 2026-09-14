'use strict';
const jwt = require('jsonwebtoken');

/**
 * The same login as the rest of the dashboard.
 *
 * burrows-dashboard signs a JWT at login and sends it as `Authorization: Bearer`.
 * We verify it with the same secret, so there is one login, one session, and no
 * second password for anyone to manage. A user who is signed out of the dashboard
 * is signed out of here too, with no coordination needed.
 *
 * Matches the dashboard's own middleware: any valid token is accepted. Its 64 routes
 * gate on being logged in rather than on role, and there is no reason for this one
 * to be stricter than the sales and roster data already behind that login.
 */
function requireAuth(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Fail closed. A missing secret must never mean "let everyone in".
    console.error('[auth] JWT_SECRET is not set — refusing every request');
    return res.status(500).json({ error: 'Authentication is not configured' });
  }

  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Sign in to the dashboard first' });
  }

  try {
    req.user = jwt.verify(token, secret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired — sign in again' });
  }
}

module.exports = { requireAuth };
