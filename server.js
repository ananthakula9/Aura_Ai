// Aura AI — server.js
// Serves the static frontend, routes chat requests to Gemini and/or
// Mistral per each Aura model's provider strategy (see models.js), and
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
const providers = require('./providers');
const attachments = require('./attachments');
const components = require('./components');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// Raised from a smaller default to accommodate base64-encoded image/document
// attachments (up to 3 files, individually capped in attachments.js — this
// body limit is just an outer safety net against a wildly oversized
// request, not the real enforcement point).
app.use(express.json({ limit: '45mb' }));
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
    keyConfigured: Boolean(GEMINI_API_KEY), // reports Gemini only — MISTRAL_API_KEY's presence is never exposed here or anywhere else client-facing
    defaultModel: models.DEFAULT_DISPLAY_NAME, // Aura display name, never a raw Gemini/Mistral model ID
    models: models.getPublicModelList(),        // [{ displayName, description, isDefault }] — no provider names, no raw model IDs
    accountsEnabled: db.isConfigured(),
    googleOAuthEnabled: oauth.isConfigured(),
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Slow down a moment.' });
    }

    const { systemPrompt, messages, model, maxTokens, attachments: rawAttachments } = req.body || {};

    if (!systemPrompt || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'systemPrompt and messages[] are required.' });
    }

    // Attachments are treated as untrusted input regardless of what the
    // client claims about them — validateAttachments re-derives the real
    // MIME type from file bytes, enforces per-file and aggregate size
    // limits, and enforces the 3-file cap server-side (never trusting the
    // frontend's own enforcement of that limit).
    let validatedAttachments = [];
    try {
      validatedAttachments = attachments.validateAttachments(rawAttachments);
    } catch (attachErr) {
      if (attachErr instanceof attachments.AttachmentError) {
        return res.status(400).json({ error: attachErr.code, message: attachErr.message });
      }
      throw attachErr;
    }

    // Cap payload size defensively — this is a chat proxy, not a general passthrough.
    const trimmedMessages = messages.slice(-20);

    // `model` here is an Aura display name from the browser (e.g. "Aura 1
    // Flash"), never a raw provider model ID. resolveModelEntry is the
    // only place that turns it into a registry entry carrying the real
    // Gemini/Mistral model IDs and provider strategy — anything not in the
    // registry (typo, stale cache, forged value) resolves to the default
    // entry instead of being passed through to any provider.
    const requestedDisplayName = typeof model === 'string' ? model.trim() : '';
    const entry = models.resolveModelEntry(requestedDisplayName);
    const displayNameForResponse = entry.displayName;

    // The quiz/component instructions are appended server-side (never
    // client-controlled): they tell the model to emit structured quiz
    // JSON inside a ```quiz fenced block when the user asks for a quiz,
    // and to behave exactly as before for every other request. See
    // components.js for the format and the parser.
    const result = await runChatWithFallback({
      entry,
      systemPrompt: systemPrompt + components.QUIZ_SYSTEM_PROMPT_APPENDIX,
      messages: trimmedMessages,
      maxTokens,
      attachments: validatedAttachments,
    });

    // Extract any structured components (quiz) from the raw provider
    // text. First the structured path (```quiz fences / bare JSON), then —
    // only if nothing was found AND the user's last message clearly asked
    // for an interactive quiz/test — a safe plain-text → component
    // normalization fallback (see components.js). components is always an
    // array — empty when the model produced none, so plain chat responses
    // are byte-for-byte unchanged in shape apart from this new field.
    const lastUserMessage = [...trimmedMessages].reverse().find(m => m && m.role === 'user')?.content || '';
    const parsed = components.extractComponents(result.text, lastUserMessage);

    res.json({
      text: parsed.text,
      model: displayNameForResponse, // always the Aura display name — never "gemini-3.6-flash" or "mistral-large-latest"
      latencyMs: result.latencyMs,
      truncated: Boolean(result.truncated), // true if the provider hit its output-token limit — see providers.js. Not auto-continued; surfaced for debug visibility only.
      components: parsed.components, // [{ type: 'quiz', title, questions }] — [] when the model produced no structured components
    });

  } catch (err) {
    if (err instanceof providers.ProviderError) {
      // A provider failure that reached here means either: it wasn't
      // retryable (e.g. bad API key, malformed request) so no fallback was
      // attempted, or it WAS retryable but the fallback also failed. Either
      // way, the user gets a clean, generic message — never the raw
      // provider error text, which could hint at internal model IDs, key
      // validity, or account-specific details.
      console.error(`chat endpoint provider error [${err.provider}]:`, err.message);
      const status = err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
      const message = err.isMultimodalRequest
        ? 'Image and document analysis is temporarily unavailable. You can still chat normally, or try again in a moment.'
        : 'Aura AI is temporarily unable to respond. Please try again in a moment.';
      return res.status(status).json({ error: 'UPSTREAM_ERROR', message });
    }
    console.error('chat endpoint error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
  }
});

// ============================================================
// CHAT ROUTING: per-model provider strategy (see models.js), overridden
// by attachment presence.
//
//   No attachments:
//     'gemini-with-fallback' — Gemini first; on a retryable
//         provider-availability failure, fall back to Mistral once.
//     'mistral-only' — Mistral directly; Gemini is never called.
//
//   With attachments (images/documents):
//     ALWAYS Gemini, regardless of the selected model's normal strategy.
//     Verified during implementation that Gemini's generateContent
//     natively accepts inline image/PDF/TXT data, while Mistral's
//     chat-completions endpoint has no equivalent PDF/TXT document input
//     at all, and its documented vision-capable model lineup does not
//     clearly include the mistral-large-latest model this app uses for
//     text — attaching files to a Mistral call in this app would either
//     be silently ignored or fail unpredictably. Rather than guess, this
//     app never sends attachments to Mistral: if Gemini can't serve a
//     multimodal request, the user gets a clean "temporarily unavailable"
//     error instead of a broken/degraded response from the wrong provider.
//     (See providers.js's callMistral for a defense-in-depth guard against
//     ever accidentally reaching this state.)
//
// This function is the ONLY place that decides which provider(s) to call
// for a given request — providers.js just makes the HTTP calls, and
// models.js just declares the strategy per model.
// ============================================================
async function runChatWithFallback({ entry, systemPrompt, messages, maxTokens, attachments: fileAttachments }) {
  const hasAttachments = Array.isArray(fileAttachments) && fileAttachments.length > 0;

  if (hasAttachments) {
    if (!GEMINI_API_KEY) {
      const err = new providers.ProviderError('Gemini is not configured on this server.', {
        httpStatus: 503, provider: 'gemini', providerErrorCode: 'NOT_CONFIGURED',
      });
      err.isMultimodalRequest = true;
      throw err;
    }
    try {
      return await providers.callGemini({
        apiKey: GEMINI_API_KEY,
        geminiModel: entry.geminiModel || models.MODEL_REGISTRY.find(m => m.geminiModel).geminiModel,
        systemPrompt, messages, maxTokens,
        attachments: fileAttachments,
      });
    } catch (geminiErr) {
      // Tag the error as multimodal-related (a separate flag, not the
      // provider's own providerErrorCode field, which is reserved for
      // Gemini's actual error taxonomy and used elsewhere for retry
      // classification) so the route handler can show an image/document-
      // specific message instead of the generic chat failure message.
      if (geminiErr instanceof providers.ProviderError) {
        geminiErr.isMultimodalRequest = true;
      }
      // No Mistral fallback for multimodal requests — see the routing
      // comment above for why. The error propagates as-is to the
      // ProviderError handler in the route above.
      throw geminiErr;
    }
  }

  if (entry.strategy === 'mistral-only') {
    if (!MISTRAL_API_KEY) {
      throw new providers.ProviderError('Mistral is not configured on this server.', {
        httpStatus: 503, provider: 'mistral', providerErrorCode: 'NOT_CONFIGURED',
      });
    }
    return providers.callMistral({
      apiKey: MISTRAL_API_KEY,
      mistralModel: entry.mistralModel,
      systemPrompt, messages, maxTokens,
    });
  }

  // strategy === 'gemini-with-fallback'
  if (!GEMINI_API_KEY) {
    throw new providers.ProviderError('Gemini is not configured on this server.', {
      httpStatus: 503, provider: 'gemini', providerErrorCode: 'NOT_CONFIGURED',
    });
  }

  try {
    return await providers.callGemini({
      apiKey: GEMINI_API_KEY,
      geminiModel: entry.geminiModel,
      systemPrompt, messages, maxTokens,
    });
  } catch (geminiErr) {
    if (!(geminiErr instanceof providers.ProviderError)) throw geminiErr;

    const shouldFallback = providers.isRetryableFailure(geminiErr.httpStatus, geminiErr.providerErrorCode);
    if (!shouldFallback) {
      // Permanent failure (bad key, malformed request, bad model config,
      // etc) — surface it directly rather than masking it with a fallback
      // that would also just fail, or silently produce a response from a
      // different provider for a problem that needs fixing, not retrying.
      throw geminiErr;
    }

    console.warn(`Gemini retryable failure (status ${geminiErr.httpStatus}, code ${geminiErr.providerErrorCode}) — falling back to Mistral.`);

    if (!MISTRAL_API_KEY) {
      // Gemini failed in a retryable way, but there's no fallback
      // available — report this as the (retryable) Gemini failure rather
      // than a confusing "Mistral not configured" message, since from the
      // user's perspective this model is still "Gemini-backed."
      throw geminiErr;
    }

    // Fall back once. If Mistral ALSO fails, that error propagates up as
    // a clean user-facing error per the ProviderError catch above — no
    // further retry loop.
    return providers.callMistral({
      apiKey: MISTRAL_API_KEY,
      mistralModel: entry.mistralModel,
      systemPrompt, messages, maxTokens,
    });
  }
}

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

  const httpServer = app.listen(PORT, () => {
    console.log(`Aura AI server running on port ${PORT}`);
    console.log(`Gemini key configured: ${Boolean(GEMINI_API_KEY)}`);
  });
  // Exposed for tests so a harness can close the listener cleanly (same
  // pattern as `module.exports = app` below — this file is run directly
  // by `npm start`, never required in production). Note: this must be
  // attached to the app object, not module.exports, because the
  // `module.exports = app` at the bottom of the file replaces the whole
  // exports object after this function runs.
  app.httpServer = httpServer;
}

start();

// Exported for testing (dispatching requests directly against the app
// without a real HTTP listener). Railway's `npm start` runs this file
// directly and never requires it, so this export has no production effect.
module.exports = app;
