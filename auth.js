// Aura AI — auth.js
// Password hashing (bcrypt) + opaque session tokens stored server-side in
// Postgres, delivered to the browser as an HTTP-only, Secure, SameSite
// cookie. No JWT, no secrets in localStorage, no secrets in any frontend
// JS file — the browser only ever holds a random opaque token it cannot
// read the meaning of.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'aura_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 12;

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  // A Google-only account has no password_hash at all — there is nothing
  // to compare against, so email/password login must fail cleanly rather
  // than throwing inside bcrypt on a null hash.
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

async function createSessionForUser(res, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.createSession(token, userId, expiresAt);
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  return token;
}

async function clearSession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    try { await db.deleteSession(token); } catch { /* best effort */ }
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Middleware: attaches req.user if a valid session cookie is present.
// Never throws/blocks — routes decide for themselves whether auth is
// required, so guest-mode routes keep working untouched.
async function attachUser(req, res, next) {
  req.user = null;
  if (!db.isConfigured()) return next();

  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();

  try {
    const session = await db.findSession(token);
    if (session) {
      req.user = { id: session.user_id, email: session.email };
    }
  } catch (e) {
    console.error('session lookup failed:', e.message);
  }
  next();
}

// Middleware: hard-requires a logged-in user, for routes that only make
// sense for an account (saved conversations, account deletion, etc).
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Log in to use this feature.' });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  isValidEmail,
  isValidPassword,
  hashPassword,
  verifyPassword,
  createSessionForUser,
  clearSession,
  attachUser,
  requireAuth,
};
