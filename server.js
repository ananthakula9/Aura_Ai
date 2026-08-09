// Aura AI — server.js
// Serves the static frontend and proxies chat requests to Google Gemini.
// The API key never reaches the browser: it is read from the
// GEMINI_API_KEY environment variable and attached here only.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.AURA_DEFAULT_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

app.use(express.json({ limit: '1mb' }));
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(GEMINI_API_KEY),
    defaultModel: DEFAULT_MODEL,
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

    const { systemPrompt, messages, model, maxTokens, temperature } = req.body || {};

    if (!systemPrompt || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'systemPrompt and messages[] are required.' });
    }

    // Cap payload size defensively — this is a chat proxy, not a general passthrough.
    const trimmedMessages = messages.slice(-20);
    const chosenModel = model || DEFAULT_MODEL;

    const geminiRes = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(chosenModel)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(trimmedMessages),
        generationConfig: {
          maxOutputTokens: Math.min(maxTokens || 700, 1200),
          temperature: temperature ?? 0.9,
        },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: 'UPSTREAM_ERROR',
        message: data?.error?.message || 'Gemini request failed.',
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
    res.json({ text });

  } catch (err) {
    console.error('chat endpoint error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
  }
});

// SPA fallback — anything not matched above serves the frontend.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Aura AI server running on port ${PORT}`);
  console.log(`Gemini key configured: ${Boolean(GEMINI_API_KEY)}`);
});
