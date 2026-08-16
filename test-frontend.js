// test-frontend.js — verifies the quiz component RENDERING path in the
// real frontend code (public/app.js + public/components.js), driven
// against a real DOM via jsdom. Covers: the real buildQuizCard() renderer
// (progress, one-question-at-a-time navigation, submit gating, score,
// review with feedback, retry) and the addAI() integration (card appears
// below the message text).
//
// Run: node test-frontend.js   (requires: npm i --no-save jsdom)

const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// ---- environment stubs jsdom doesn't provide ----
window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
}));
window.AbortController = AbortController;
// The /api/chat response mirrors the REAL deployed-style response shape —
// including the components array the server produces for a quiz request.
// Set after QUIZ is defined below (scenario 11 drives the real
// handleSend() → callChatAPI() path against this stub).
let chatResponseBody = null;
window.fetch = async (url, options = {}) => {
  const u = String(url);
  let body = { ok: true };
  if (u.includes('/api/chat')) {
    body = chatResponseBody || { text: '...', model: 'Aura 1 Flash', latencyMs: 0, truncated: false, components: [] };
  } else if (u.includes('/api/health')) {
    body = { ok: true, keyConfigured: false, defaultModel: 'Aura 1 Flash', models: [{ displayName: 'Aura 1 Flash', description: 'x', isDefault: true }], accountsEnabled: false, googleOAuthEnabled: false };
  } else if (u.includes('/api/auth/me')) {
    body = { user: null, accountsEnabled: false, googleOAuthEnabled: false };
  }
  return { ok: true, status: 200, json: async () => body };
};

// ---- load the REAL pipeline.js, components.js and app.js ----
// All three use ES module syntax, which jsdom can't execute — strip the
// import/export statements so they run as ONE classic script in the
// window (top-level class/const declarations are script-scoped, so a
// single combined eval is required).
const strip = src => src
  .replace(/export\s*\{[\s\S]*?\}\s*;?\s*$/, '')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"];\s*$/gm, '');

const pipelineSrc = strip(fs.readFileSync('public/pipeline.js', 'utf8'));
const componentsSrc = strip(fs.readFileSync('public/components.js', 'utf8'));
const researchSrc = strip(fs.readFileSync('public/research.js', 'utf8'));
const appSrc = strip(fs.readFileSync('public/app.js', 'utf8'));
window.eval(pipelineSrc + '\n' + componentsSrc + '\n' + researchSrc + '\n' + appSrc);
console.log('app + components + research loaded');

// A quiz where the user answers 2 of 3 correctly.
const QUIZ = {
  type: 'quiz',
  title: 'Space Quiz',
  questions: [
    { question: 'What is the largest planet?', options: ['Earth', 'Jupiter', 'Saturn'], answer: 1, explanation: 'Jupiter is the largest.' },
    { question: 'How many planets are in our solar system?', options: ['7', '8', '9'], answer: 1, explanation: 'There are 8 planets.' },
    { question: 'What is the Red Planet?', options: ['Mars', 'Venus', 'Mercury'], answer: 0, explanation: 'Iron oxide makes Mars red.' },
  ],
};
chatResponseBody = {
  text: "Here's your space quiz!",
  model: 'Aura 1 Flash',
  latencyMs: 42,
  truncated: false,
  components: [QUIZ],
};

(async () => {
  await new Promise(r => setTimeout(r, 100)); // let checkAuthAndInit settle

  assert.strictEqual(typeof window.buildQuizCard, 'function', 'buildQuizCard defined');
  assert.strictEqual(typeof window.addAI, 'function', 'addAI defined');

  const card = window.buildQuizCard(QUIZ);
  assert.ok(card, 'card built');
  window.document.body.appendChild(card);

  const q = (n) => card.querySelector(`[data-opt="${n}"]`);
  const progress = () => card.querySelector('[data-role="progress"]').textContent;
  const submitBtn = () => card.querySelector('[data-role="submit"]');
  const nextBtn = () => card.querySelector('[data-role="next"]');
  const backBtn = () => card.querySelector('[data-role="back"]');
  const retryBtn = () => card.querySelector('[data-role="retry"]');
  const scoreEl = () => card.querySelector('[data-role="score"]');

  // ---- 1. initial render: one question, progress, submit gated ----
  assert.strictEqual(card.querySelectorAll('.quiz-option').length, 3, 'only current question options rendered');
  assert.strictEqual(progress(), 'Question 1 of 3', 'progress label');
  assert.ok(submitBtn().hidden, 'submit hidden until last question');
  assert.ok(nextBtn() && !nextBtn().hidden, 'next visible');
  assert.ok(backBtn().disabled, 'back disabled on first question');
  assert.strictEqual(scoreEl().hidden, true, 'score hidden pre-submit');
  console.log('✓ initial render: 1 question at a time, progress "Question 1 of 3", submit gated');

  // ---- 2. answer q1 (wrong: Earth), navigate ----
  q(0).click();
  assert.ok(q(0).classList.contains('selected'), 'selection highlighted');
  nextBtn().click();
  assert.strictEqual(progress(), 'Question 2 of 3', 'navigated forward');
  assert.ok(!backBtn().disabled, 'back enabled');

  // ---- 3. answer q2 (correct: 8), navigate to last ----
  q(1).click();
  nextBtn().click();
  assert.strictEqual(progress(), 'Question 3 of 3');
  assert.ok(nextBtn().hidden, 'next hidden on last question');
  assert.ok(!submitBtn().hidden, 'submit visible on last question');
  assert.ok(submitBtn().disabled, 'submit still disabled — not all answered');

  // ---- 4. answer q3 (correct: Mars), submit enabled ----
  q(0).click();
  assert.ok(!submitBtn().disabled, 'submit enabled once all answered');

  // ---- 5. submit: score + review feedback ----
  submitBtn().click();
  assert.strictEqual(scoreEl().textContent, '2 / 3', 'score 2/3');
  assert.ok(retryBtn() && !retryBtn().hidden, 'retry visible after submit');
  assert.ok(submitBtn().hidden, 'submit hidden after submit');
  const fb = card.querySelector('.quiz-feedback');
  assert.ok(fb && !fb.hidden, 'feedback shown on last question');
  assert.ok(fb.textContent.includes('Correct'), 'last answer correct feedback');
  assert.ok(card.querySelector('.quiz-option.correct'), 'correct option marked green');
  assert.strictEqual(card.querySelectorAll('.quiz-option:disabled').length, 3, 'options locked after submit');
  console.log('✓ submit: score "2 / 3", correct mark + feedback, options locked');

  // ---- 6. review: navigate back, see wrong answer + explanation ----
  backBtn().click();
  assert.strictEqual(progress(), 'Question 2 of 3', 'review navigation works');
  const fb2 = card.querySelector('.quiz-feedback');
  assert.ok(fb2 && !fb2.hidden && fb2.textContent.includes('There are 8 planets.'), 'review shows explanation on q2');
  backBtn().click();
  const fb1 = card.querySelector('.quiz-feedback');
  assert.ok(fb1.textContent.includes('Correct answer'), 'q1 (wrong) shows correct answer in review');
  assert.ok(fb1.textContent.includes('Jupiter'), 'q1 explanation shown');
  assert.ok(card.querySelector('.quiz-option.wrong'), 'wrong selection marked red on q1');
  console.log('✓ review: navigate back, per-question feedback + explanations + wrong mark');

  // ---- 7. retry resets everything ----
  retryBtn().click();
  assert.strictEqual(progress(), 'Question 1 of 3', 'retry returns to question 1');
  assert.strictEqual(scoreEl().hidden, true, 'score hidden after retry');
  assert.ok(retryBtn().hidden, 'retry hidden after retry');
  assert.strictEqual(card.querySelectorAll('.quiz-option:disabled').length, 0, 'options re-enabled');
  assert.strictEqual(card.querySelectorAll('.quiz-option.selected, .quiz-option.correct, .quiz-option.wrong').length, 0, 'all marks cleared');
  assert.ok(!submitBtn().hidden || !nextBtn().hidden, 'navigation restored');
  console.log('✓ retry: full reset to question 1, fresh state');

  // ---- 8. addAI integration: card renders below the message text ----
  card.remove();
  window.addAI('Here\'s your space quiz!', null, null, false, Date.now(), 0, [QUIZ]);
  const msgs = window.document.querySelectorAll('.msg.ai');
  const msg = msgs[msgs.length - 1];
  assert.ok(msg.querySelector('.bubble').textContent.includes('Here\'s your space quiz!'), 'text bubble rendered');
  const renderedCard = msg.querySelector('.quiz-card');
  assert.ok(renderedCard, 'quiz card rendered inside the message');
  assert.strictEqual(msg.querySelector('.bubble').nextElementSibling, renderedCard, 'card directly below the text bubble');
  assert.strictEqual(renderedCard.querySelector('.quiz-title').textContent, 'Space Quiz');
  console.log('✓ addAI renders the quiz card below the message text bubble');

  // ---- 9. empty components / non-quiz components are a no-op ----
  window.addAI('plain text', null, null, false, Date.now(), 0, []);
  const msgs2 = window.document.querySelectorAll('.msg.ai');
  assert.strictEqual(msgs2[msgs2.length - 1].querySelector('.quiz-card'), null, 'no card for empty components');
  console.log('✓ empty components are a no-op');

  // ---- 10. XSS guard: model text is escaped ----
  const evil = window.buildQuizCard({ type: 'quiz', title: '<img src=x onerror=alert(1)>', questions: [{ question: 'Q?', options: ['<script>alert(1)</script>', 'safe'], answer: 1 }] });
  assert.ok(!evil.querySelector('.quiz-title').innerHTML.includes('<img'), 'title escaped');
  assert.ok(!evil.querySelector('.quiz-option').innerHTML.includes('<script'), 'option escaped');
  console.log('✓ model-provided text is escaped (no HTML injection)');

  // ---- 11. FULL integration: a natural-language quiz request driven
  // through the REAL handleSend() → runInference() → callChatAPI() →
  // addAI() path renders an interactive quiz card in the chat UI. ----
  const userInput = window.document.getElementById('userInput');
  userInput.value = 'Create a 5-question quiz about space.';
  await window.handleSend();
  await new Promise(r => setTimeout(r, 0)); // let the render settle
  const liveMsgs = window.document.querySelectorAll('.msg.ai');
  const liveMsg = liveMsgs[liveMsgs.length - 1];
  assert.ok(liveMsg.querySelector('.bubble').textContent.includes("Here's your space quiz!"), 'live message text rendered');
  const liveCard = liveMsg.querySelector('.quiz-card');
  assert.ok(liveCard, 'interactive quiz card rendered after a natural-language quiz request');
  assert.strictEqual(liveCard.querySelector('.quiz-title').textContent, 'Space Quiz');
  assert.strictEqual(liveCard.querySelector('[data-role="progress"]').textContent, 'Question 1 of 3', 'card is interactive (progress visible)');
  // And it's actually playable: answer q1, submit, see a score.
  liveCard.querySelector('[data-opt="0"]').click();
  liveCard.querySelector('[data-role="next"]').click();
  liveCard.querySelector('[data-opt="1"]').click();
  liveCard.querySelector('[data-role="next"]').click();
  liveCard.querySelector('[data-opt="0"]').click();
  liveCard.querySelector('[data-role="submit"]').click();
  assert.strictEqual(liveCard.querySelector('[data-role="score"]').textContent, '2 / 3', 'live card scores 2 / 3');
  console.log('✓ FULL FLOW: "Create a 5-question quiz about space." → /api/chat-shaped response → interactive quiz card rendered and playable in the DOM');

  console.log('\nALL FRONTEND QUIZ TESTS PASSED ✅');
  dom.window.close();
})().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exitCode = 1;
  dom.window.close();
});
