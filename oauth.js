// Aura AI — oauth.js
// Server-side Google OAuth 2.0 (authorization code flow). This module is
// honest about its own availability: if GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are not both set, isConfigured() returns false and
// every route that depends on it responds with a clear "not configured"
// error instead of pretending to work. No OAuth secret is ever sent to
// the browser — the client ID is public by nature (Google's own login
// button always includes it), but the client secret is used only in the
// server-to-server token exchange in exchangeCodeForTokens() below.

const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// The full callback URL Google redirects back to, e.g.
// https://your-app.up.railway.app/api/auth/google/callback
// Must exactly match a redirect URI registered in Google Cloud Console.
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

const STATE_COOKIE = 'aura_oauth_state';

function isConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'Token exchange failed');
    err.googleResponse = data;
    throw err;
  }
  return data; // { access_token, id_token, expires_in, ... }
}

async function fetchGoogleProfile(accessToken) {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || 'Could not fetch Google profile');
  }
  return data; // { sub, email, email_verified, name, picture, ... }
}

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 10 minutes — just long enough for the redirect round trip
    path: '/',
  };
}

module.exports = {
  STATE_COOKIE,
  isConfigured,
  generateState,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleProfile,
  stateCookieOptions,
};
