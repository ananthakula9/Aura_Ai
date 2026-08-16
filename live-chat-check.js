// live-chat-check.js — live end-to-end check against REAL providers.
// Requires a locally running server (see README) and reads no secrets
// itself — the server holds the API keys.
//
// Usage: PORT=3100 node live-chat-check.js

const PORT = process.env.PORT || 3100;
const BASE = `http://localhost:${PORT}`;

const SYSTEM_PROMPT = 'You are Aura, a helpful AI assistant. Answer the user clearly and completely.';

const PROMPTS = [
  { label: 'space (exact)',        user: 'Create a 5-question quiz about space' },
  { label: 'photosynthesis',       user: 'Quiz me on photosynthesis' },
  { label: 'math',                 user: 'Make a math quiz' },
  { label: 'ww2',                  user: 'Test me on World War 2' },
  { label: 'CONTROL: capital',     user: 'What is the capital of France?' },
  { label: 'CONTROL: sleep tips',  user: 'Give me 5 tips to improve sleep' },
];

async function run() {
  for (const { label, user } of PROMPTS) {
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], model: 'Aura 1 Flash' }),
      });
    } catch (err) {
      console.log(`✗ ${label}: REQUEST FAILED (${err.message})`);
      continue;
    }
    const data = await res.json();
    const ms = Date.now() - started;
    if (!res.ok) {
      console.log(`✗ ${label}: HTTP ${res.status} — ${data.message || data.error}`);
      continue;
    }
    const comps = Array.isArray(data.components) ? data.components : [];
    const quiz = comps.find(c => c && c.type === 'quiz');
    const textPreview = (data.text || '').replace(/\s+/g, ' ').slice(0, 90);
    if (quiz) {
      const answers = quiz.questions.map(q => `${String.fromCharCode(65 + q.answer)}:${q.options[q.answer]}`);
      console.log(`✓ ${label}: QUIZ COMPONENT (${quiz.questions.length} questions, title="${quiz.title}") [${ms}ms]`);
      console.log(`    answers: ${answers.join(' | ')}`);
      console.log(`    text: ${textPreview || '(empty — card only)'}`);
    } else {
      console.log(`✗ ${label}: NO COMPONENT (components=${comps.length}) [${ms}ms]`);
      console.log(`    text: ${textPreview}`);
    }
    console.log('');
  }
}

run().catch(err => { console.error('fatal:', err); process.exitCode = 1; });
