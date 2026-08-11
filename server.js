// Aura AI — server.js
// Serves the static frontend, proxies chat requests to Google Gemini, and
// (when DATABASE_URL is configured) provides account auth + saved
// conversation history. Guest mode works with zero database configured —
// auth/save-history features degrade gracefully rather than breaking chat.

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./db');
const auth = require('./auth');
const models = require('./models');
const oauth = require('./oauth');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// AURA_DEFAULT_MODEL, if set, overrides which registry entry's apiModel
// backs "the default" — but the env var must name a real Gemini model ID
// that already exists in models.js's registry, keeping the allowlist
// guarantee intact even when overridden.
const envDefaultOverride = process.env.AURA_DEFAULT_MODEL;
const DEFAULT_API_MODEL = (envDefaultOverride && models.MODEL_REGISTRY.some(m => m.apiModel === envDefaultOverride))
  ? envDefaultOverride
  : models.resolveApiModel(models.DEFAULT_DISPLAY_NAME);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.attachUser);
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory rate limiter (per IP) so a stray loop can't burn the key's quota.
const rateBuckets = new Map();
const RATE_LIMIT = 30;          // requests
const RATE_WINDOW_MS = 60_000;  // per minute

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// Separate, stricter rate limit for auth endpoints — protects against
// credential-stuffing / brute force independent of the chat limiter.
const authBuckets = new Map();
const AUTH_RATE_LIMIT = 10;
const AUTH_RATE_WINDOW_MS = 60_000;
function isAuthRateLimited(ip) {
  const now = Date.now();
  const bucket = authBuckets.get(ip) || [];
  const recent = bucket.filter(t => now - t < AUTH_RATE_WINDOW_MS);
  recent.push(now);
  authBuckets.set(ip, recent);
  return recent.length > AUTH_RATE_LIMIT;
}
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(GEMINI_API_KEY),
    defaultModel: models.DEFAULT_DISPLAY_NAME, // Aura display name, never a raw Gemini model ID
    models: models.getPublicModelList(),        // [{ displayName, description, isDefault }]
    accountsEnabled: db.isConfigured(),
    googleOAuthEnabled: oauth.isConfigured(),
  });
});

// Convert the OpenAI-style {role: 'user'|'assistant', content: string} history
// the frontend already sends into Gemini's {role: 'user'|'model', parts: [{text}]}
// format. This is the only shape translation needed — the frontend and
// pipeline.js are untouched, so this conversion happens entirely server-side.
function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'SERVER_NOT_CONFIGURED',
        message: 'GEMINI_API_KEY is not set on the server. Add it in Railway → Variables.',
      });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Slow down a moment.' });
    }

    const { systemPrompt, messages, model, maxTokens } = req.body || {};

    if (!systemPrompt || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'systemPrompt and messages[] are required.' });
    }

    // Cap payload size defensively — this is a chat proxy, not a general passthrough.
    const trimmedMessages = messages.slice(-20);

    // `model` here is an Aura display name from the browser (e.g. "Aura 1
    // Flash"), never a raw Gemini model ID — resolveApiModel is the only
    // place that turns it into something sent to Google, and it always
    // falls back to the default for anything not in the registry. This is
    // the enforcement point that stops arbitrary model IDs from reaching
    // the Gemini API via a forged request.
    const requestedDisplayName = typeof model === 'string' ? model.trim() : '';
    const displayNameForResponse = models.isKnownDisplayName(requestedDisplayName)
      ? requestedDisplayName
      : models.DEFAULT_DISPLAY_NAME;
    const apiModel = requestedDisplayName
      ? models.resolveApiModel(requestedDisplayName)
      : DEFAULT_API_MODEL;

    const startedAt = Date.now();

    const geminiRes = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(apiModel)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(trimmedMessages),
        // Note: temperature/top_p/top_k are deprecated on Gemini 3.x models
        // and are intentionally omitted — only maxOutputTokens is set here.
        generationConfig: {
          maxOutputTokens: Math.min(maxTokens || 700, 1200),
        },
      }),
    });

    const data = await geminiRes.json();
    const latencyMs = Date.now() - startedAt;

    if (!geminiRes.ok) {
      // If the specific model Google rejected was a non-default pick, retry
      // once against the default rather than surfacing a raw Gemini error
      // about an internal model ID the user was never shown.
      if (apiModel !== DEFAULT_API_MODEL && (geminiRes.status === 404 || geminiRes.status === 400)) {
        const retryRes = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(DEFAULT_API_MODEL)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: toGeminiContents(trimmedMessages),
            generationConfig: { maxOutputTokens: Math.min(maxTokens || 700, 1200) },
          }),
        });
        const retryData = await retryRes.json();
        if (retryRes.ok) {
          const retryText = retryData?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
          return res.json({
            text: retryText,
            model: models.DEFAULT_DISPLAY_NAME,
            latencyMs: Date.now() - startedAt,
            modelFallback: true,
          });
        }
      }
      return res.status(geminiRes.status).json({
        error: 'UPSTREAM_ERROR',
        message: data?.error?.message || 'Gemini request failed.',
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
    res.json({ text, model: displayNameForResponse, latencyMs });

  } catch (err) {
    console.error('chat endpoint error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
  }
});

// ============================================================
// AUTH ROUTES
// ============================================================
function requireDb(req, res, next) {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'ACCOUNTS_NOT_CONFIGURED', message: 'Accounts are not available — the server has no database configured.' });
  }
  next();
}

app.post('/api/auth/signup', requireDb, async (req, res) => {
  try {
    if (isAuthRateLimited(clientIp(req))) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
    }
    const { email, password } = req.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!auth.isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
    }
    if (!auth.isValidPassword(password)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be at least 8 characters.' });
    }

    const existing = await db.findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'EMAIL_TAKEN', message: 'An account with that email already exists.' });
    }

    const passwordHash = await auth.hashPassword(password);
    const user = await db.createUser(normalizedEmail, passwordHash);
    await auth.createSessionForUser(res, user.id);

    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not create account.' });
  }
});

app.post('/api/auth/login', requireDb, async (req, res) => {
  try {
    if (isAuthRateLimited(clientIp(req))) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
    }
    const { email, password } = req.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    const user = await db.findUserByEmail(normalizedEmail);
    // Constant-shape response whether the email exists or not, to avoid
    // leaking which emails are registered.
    const ok = user ? await auth.verifyPassword(password || '', user.password_hash) : false;

    if (!ok) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' });
    }

    await auth.createSessionForUser(res, user.id);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not log in.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await auth.clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null, accountsEnabled: db.isConfigured(), googleOAuthEnabled: oauth.isConfigured() });
});

// ============================================================
// GOOGLE OAUTH ROUTES
// Standard server-side authorization code flow. The client secret and
// the token exchange itself never touch the browser — the browser is
// only ever redirected to Google and then back to our own callback,
// which does the real work and finishes by setting the same kind of
// httpOnly session cookie email/password login uses.
// ============================================================
app.get('/api/auth/google', requireDb, (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(503).json({
      error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'Google sign-in is not set up on this server yet.',
    });
  }
  const state = oauth.generateState();
  res.cookie(oauth.STATE_COOKIE, state, oauth.stateCookieOptions());
  res.redirect(oauth.buildAuthUrl(state));
});

app.get('/api/auth/google/callback', requireDb, async (req, res) => {
  const failRedirect = (reason) => res.redirect(`/?auth_error=${encodeURIComponent(reason)}`);

  if (!oauth.isConfigured()) {
    return failRedirect('Google sign-in is not configured on this server.');
  }

  try {
    const { code, state, error: googleError } = req.query;

    if (googleError) {
      return failRedirect('Google sign-in was cancelled or denied.');
    }

    const expectedState = req.cookies?.[oauth.STATE_COOKIE];
    res.clearCookie(oauth.STATE_COOKIE, { path: '/' });
    if (!state || !expectedState || state !== expectedState) {
      return failRedirect('Sign-in request could not be verified. Please try again.');
    }
    if (!code) {
      return failRedirect('Google did not return an authorization code.');
    }

    const tokens = await oauth.exchangeCodeForTokens(code);
    const profile = await oauth.fetchGoogleProfile(tokens.access_token);

    if (!profile.email) {
      return failRedirect('Your Google account has no email address to sign in with.');
    }

    const user = await db.findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email.toLowerCase(),
      displayName: profile.name || null,
      avatarUrl: profile.picture || null,
    });

    await auth.createSessionForUser(res, user.id);
    res.redirect('/');
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    failRedirect('Something went wrong finishing Google sign-in. Please try again.');
  }
});

// Password reset without an email provider is out of scope for a minimal
// deploy, but a signed-in user can always change their password directly.
app.post('/api/auth/change-password', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!auth.isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'New password must be at least 8 characters.' });
    }
    const user = await db.findUserByEmail(req.user.email);
    const ok = user && await auth.verifyPassword(currentPassword || '', user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
    }
    const newHash = await auth.hashPassword(newPassword);
    await db.updateUserPassword(user.id, newHash);
    // Rotate all sessions so other logged-in devices need the new password.
    await db.deleteAllSessionsForUser(user.id);
    await auth.createSessionForUser(res, user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('change-password error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not change password.' });
  }
});

app.delete('/api/auth/account', requireDb, auth.requireAuth, async (req, res) => {
  try {
    await db.deleteUser(req.user.id); // cascades to sessions + conversations + messages
    await auth.clearSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error('account deletion error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not delete account.' });
  }
});

// ============================================================
// CONVERSATION ROUTES (logged-in users only — guests use localStorage
// entirely client-side and never hit these routes)
// ============================================================
app.get('/api/conversations', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const list = await db.listConversations(req.user.id);
    res.json({ conversations: list });
  } catch (err) {
    console.error('list conversations error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not load conversations.' });
  }
});

app.post('/api/conversations', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 100) : 'New chat';
    const convo = await db.createConversation(req.user.id, title);
    res.json({ conversation: convo });
  } catch (err) {
    console.error('create conversation error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not create conversation.' });
  }
});

app.get('/api/conversations/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const convo = await db.getConversationWithMessages(req.user.id, req.params.id);
    if (!convo) return res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    res.json({ conversation: convo });
  } catch (err) {
    console.error('get conversation error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not load conversation.' });
  }
});

app.patch('/api/conversations/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : null;
    if (!title) return res.status(400).json({ error: 'BAD_REQUEST', message: 'title is required.' });
    const updated = await db.renameConversation(req.user.id, req.params.id, title);
    if (!updated) return res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    res.json({ conversation: updated });
  } catch (err) {
    console.error('rename conversation error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not rename conversation.' });
  }
});

app.delete('/api/conversations/:id', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const deleted = await db.deleteConversation(req.user.id, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete conversation error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not delete conversation.' });
  }
});

app.delete('/api/conversations', requireDb, auth.requireAuth, async (req, res) => {
  try {
    await db.deleteAllConversations(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete all conversations error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not clear conversations.' });
  }
});

app.post('/api/conversations/:id/messages', requireDb, auth.requireAuth, async (req, res) => {
  try {
    const { role, content } = req.body || {};
    if (role !== 'user' && role !== 'assistant') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'role must be "user" or "assistant".' });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'content is required.' });
    }
    const message = await db.addMessage(req.user.id, req.params.id, role, content.slice(0, 20000));
    res.json({ message });
  } catch (err) {
    if (err.message === 'NOT_FOUND_OR_FORBIDDEN') {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    }
    console.error('add message error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save message.' });
  }
});

// SPA fallback — anything not matched above serves the frontend.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  if (db.isConfigured()) {
    try {
      await db.ensureSchema();
      console.log('Database schema ready — accounts and saved history enabled.');
    } catch (e) {
      console.error('Failed to initialize database schema:', e.message);
      console.error('Accounts/saved history will not work until this is fixed.');
    }
  } else {
    console.log('DATABASE_URL not set — running in guest-only mode (no accounts, no saved history).');
  }

  app.listen(PORT, () => {
    console.log(`Aura AI server running on port ${PORT}`);
    console.log(`Gemini key configured: ${Boolean(GEMINI_API_KEY)}`);
  });
}

start();

// Exported for testing (dispatching requests directly against the app
// without a real HTTP listener). Railway's `npm start` runs this file
// directly and never requires it, so this export has no production effect.
module.exports = app;
