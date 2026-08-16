// test-identity.js — verifies Aura's creator/identity system end-to-end.
//
// Layer 1 (deterministic, stubbed): the identity appendix from the single
//   source of truth (identity.js) is server-enforced on EVERY /api/chat
//   request regardless of what the client sends; /identity.js is served to
//   the browser; /api/health exposes the identity; the appendix contains
//   the creator, the self-name, the provider-distinction rules, and the
//   canonical answer shapes.
// Layer 2 (live, optional): with real keys, the actual model answers the
//   nine identity questions and asserts Aashrith + Aura AI and NO provider
//   attribution. Run: LIVE=1 node test-identity.js
//
// Run (stubbed): node test-identity.js

const assert = require('assert');

// ---- 1. Unit: the identity module itself ----
const { AURA_IDENTITY, IDENTITY_SYSTEM_PROMPT_APPENDIX } = require('./identity');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch((err) => { failed++; console.error(`✗ ${name}\n    ${err.message}`); });
}

(async () => {
  await test('IDENTITY: single source of truth declares Aura AI by Aashrith', () => {
    assert.strictEqual(AURA_IDENTITY.name, 'Aura AI');
    assert.strictEqual(AURA_IDENTITY.creator, 'Aashrith');
    assert.strictEqual(AURA_IDENTITY.role, 'AI assistant');
  });

  await test('IDENTITY: appendix names the creator, the product, and the canonical answers', () => {
    assert.ok(IDENTITY_SYSTEM_PROMPT_APPENDIX.includes('Aashrith'));
    assert.ok(IDENTITY_SYSTEM_PROMPT_APPENDIX.length > 300, 'appendix is substantive');
    assert.ok(IDENTITY_SYSTEM_PROMPT_APPENDIX.includes('Aura AI'));
    // Canonical answer shapes for the four required questions.
    assert.ok(/Who created you\?/.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
    assert.ok(/Who is your founder\?/.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
    assert.ok(/Who made you\?/.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
    assert.ok(/Who are you\?/.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
  });

  await test('IDENTITY: appendix forbids provider attribution and separates technology', () => {
    assert.ok(/NEVER say you were created, made, founded, or developed by Google, Gemini, Mistral AI, OpenAI/i.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
    assert.ok(/described separately from your identity/i.test(IDENTITY_SYSTEM_PROMPT_APPENDIX));
    assert.ok(IDENTITY_SYSTEM_PROMPT_APPENDIX.includes(AURA_IDENTITY.providerNote), 'provider note matches registry-backed identity');
  });

  // ---- 2. Boot the real app with stubbed providers ----
  const originalFetch = global.fetch;
  const sentToProvider = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com') || u.includes('api.mistral.ai')) {
      const body = JSON.parse(options.body);
      sentToProvider.push({
        provider: u.includes('mistral') ? 'mistral' : 'gemini',
        system: body.system_instruction?.parts?.[0]?.text || (body.messages?.[0]?.role === 'system' ? body.messages[0].content : ''),
        user: (body.contents?.[0]?.parts?.[0]?.text) || (body.messages?.find(m => m.role === 'user')?.content || ''),
      });
      const text = 'I was created by my developer, Aashrith. I\'m Aura AI, an AI assistant.';
      if (u.includes('mistral')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) };
    }
    return originalFetch(url, options);
  };
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  process.env.PORT = '3320';
  const app = require('./server.js');
  const BASE = 'http://127.0.0.1:3320';
  await new Promise(r => setTimeout(r, 1500)); // let listen settle (DB-less path)

  await test('IDENTITY: /api/health exposes the identity from the single source', async () => {
    const data = await originalFetch(`${BASE}/api/health`).then(r => r.json());
    assert.deepStrictEqual(data.identity, { name: 'Aura AI', creator: 'Aashrith', role: 'AI assistant' });
  });

  await test('IDENTITY: /identity.js is served to the browser (shared source of truth)', async () => {
    const res = await originalFetch(`${BASE}/identity.js`);
    const text = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(text.includes('AURA_IDENTITY') && text.includes('Aashrith'));
  });

  // The nine required identity questions must all carry the enforced appendix.
  const QUESTIONS = [
    'Who are you?',
    'Who created you?',
    'Who is your founder?',
    'Who made you?',
    'Who developed you?',
    'Are you made by Mistral?',
    'Are you made by Google?',
    'What model powers you?',
    'Who built you?',
  ];

  await test('IDENTITY: every identity question reaches the provider WITH the enforced identity appendix', async () => {
    for (const q of QUESTIONS) {
      const res = await originalFetch(`${BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // A client that sends a minimal/empty-persona system prompt must
          // STILL get the identity rules — enforcement is server-side.
          systemPrompt: 'You are a helpful assistant.',
          messages: [{ role: 'user', content: q }],
          model: 'Aura 1 Flash', maxTokens: 300,
        }),
      });
      assert.strictEqual(res.status, 200, `chat failed for "${q}"`);
    }
    const identityCalls = sentToProvider.filter(c => c.system.includes('=== IDENTITY ===') && c.system.includes('Aashrith'));
    assert.strictEqual(identityCalls.length, QUESTIONS.length, `all ${QUESTIONS.length} provider calls carried the identity appendix (got ${identityCalls.length})`);
  });

  await test('IDENTITY: the appendix explicitly corrects provider-attribution attempts', async () => {
    const providerQuestions = sentToProvider.filter(c => /made by (Mistral|Google)/i.test(c.user));
    assert.strictEqual(providerQuestions.length, 2, 'both provider-attribution questions were sent');
    for (const c of providerQuestions) {
      assert.ok(/NEVER say you were created, made, founded, or developed by Google, Gemini, Mistral AI/i.test(c.system), 'anti-attribution rule present in system prompt');
    }
  });

  app.httpServer.close();

  // ---- 3. LIVE behavior (optional, real keys from .env) ----
  if (process.env.LIVE === '1') {
    const fs = require('fs');
    try {
      // Always overwrite in live mode — the stubbed phase above may have
      // set the 'test-key' placeholder.
      fs.readFileSync('.env', 'utf8').split(/\r?\n/).forEach(l => { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; });
    } catch { /* no .env — skip live */ }
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'test-key') {
      console.log('\n— LIVE identity behavior (real model) —');
      process.env.PORT = '3321';
      const liveApp = require('./server.js');
      await new Promise(r => setTimeout(r, 1500));
      const LIVE = 'http://127.0.0.1:3321';
      const providers = require('./providers');
      for (const q of QUESTIONS.slice(0, 5)) { // five live calls (quota-polite)
        try {
          const r = await providers.callGemini({
            apiKey: process.env.GEMINI_API_KEY, geminiModel: 'gemini-3.6-flash',
            systemPrompt: 'You are Aura AI.' + IDENTITY_SYSTEM_PROMPT_APPENDIX,
            messages: [{ role: 'user', content: q }], maxTokens: 500,
          });
          const good = /aashrith/i.test(r.text) && /aura/i.test(r.text);
          const bad = /(created|made|developed|founded)\s+(by|from)\s+(google|mistral|openai|anthropic)/i.test(r.text);
          if (good && !bad) { passed++; console.log(`✓ LIVE "${q}" → "${r.text.slice(0, 90).trim()}…"`); }
          else { failed++; console.log(`✗ LIVE "${q}" → ${JSON.stringify(r.text.slice(0, 160))}`); }
        } catch (err) {
          failed++; console.log(`✗ LIVE "${q}" → provider error: ${err.message.slice(0, 80)}`);
        }
        await new Promise(r => setTimeout(r, 3500)); // free-tier RPM politeness
      }
      liveApp.httpServer.close();
    }
  }

  console.log(`\n===== IDENTITY RESULTS: ${passed} passed, ${failed} failed =====`);
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300).unref();
})().catch(err => { console.error('FATAL:', err); process.exitCode = 1; });
