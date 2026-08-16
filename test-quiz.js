// test-quiz.js — end-to-end verification of the quiz component feature.
//
// Boots the REAL express app (server.js) with a real HTTP listener, stubs
// only the provider HTTP call (global.fetch, which providers.js uses for
// Gemini/Mistral), and makes REAL POST /api/chat requests — including the
// exact prompt "Create a 5-question quiz about space." — then asserts the
// actual JSON response contains components[0].type === "quiz".
//
// Covers the two ways a quiz can arrive:
//   A) the model emits the ```quiz fence (structured path)
//   B) the model writes a plain-text quiz — the intent-detection +
//      normalization fallback must convert it into the same component
// And the guards: non-quiz requests must NEVER produce a component, and
// malformed quiz output must degrade to plain text without crashing.
//
// Run: node test-quiz.js

const assert = require('assert');

// ---- 1. Stub the provider fetch BEFORE requiring server.js ----
// Only Gemini/Mistral API URLs are intercepted; everything else (the
// health check, the test's own HTTP client) delegates to the real fetch.
const originalFetch = global.fetch;
let lastGeminiBody = null;
global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com') || u.includes('api.mistral.ai')) {
    lastGeminiBody = JSON.parse(options.body);
    const text = global.fetch._mockResponseText; // set per-scenario below
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      }),
    };
  }
  return originalFetch(url, options);
};

const PORT = 3999;
process.env.PORT = String(PORT);
process.env.GEMINI_API_KEY = 'test-key';

const server = require('./server');

const SYSTEM_PROMPT = 'You are Aura, an AI assistant with personality.';

function chatBody(userText) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
    model: 'Aura 1 Flash',
  };
}

// ---- Realistic model outputs ----

// Fenced component quiz (the structured path).
const FENCED_QUIZ = `Here's your space quiz!

\`\`\`quiz
{"type":"quiz","title":"Space Quiz","questions":[
{"question":"What is the largest planet in our solar system?","options":["Earth","Jupiter","Saturn","Mars"],"answer":1,"explanation":"Jupiter is more than twice as massive as all the other planets combined."},
{"question":"Which planet is known as the Red Planet?","options":["Venus","Mars","Mercury","Neptune"],"answer":1,"explanation":"Iron oxide on its surface gives Mars its reddish color."},
{"question":"What is the closest star to Earth?","options":["Proxima Centauri","Sirius","The Sun","Alpha Centauri A"],"answer":2,"explanation":"The Sun is the star at the center of our solar system."},
{"question":"How many planets are in our solar system?","options":["7","8","9","10"],"answer":1,"explanation":"Since 2006 there are 8 recognized planets."},
{"question":"What force keeps planets in orbit around the Sun?","options":["Magnetism","Friction","Gravity","Inertia"],"answer":2,"explanation":"Gravity is the attractive force that governs orbital motion."}
]}
\`\`\`

Good luck!`;

// Plain-text quiz, options on their own lines (fallback path).
const PLAIN_SPACE_QUIZ = `Space Quiz
1. What gives Mars its distinctive reddish color?
   a) Iron oxide
   b) Water ice
   c) Volcanic ash
   d) Sulfur
2. How many humans have walked on the Moon?
   a) 12
   b) 9
   c) 15
   d) 8
3. Which planet has the most moons?
   a) Earth
   b) Saturn
   c) Jupiter
   d) Neptune
4. What is the Sun primarily made of?
   a) Liquid rock
   b) Hydrogen and helium
   c) Iron
   d) Carbon
5. What is the name of our galaxy?
   a) Andromeda
   b) Milky Way
   c) Whirlpool
   d) Sombrero
Answers:
1. a
2. a
3. b
4. b
5. b`;

// Plain-text quiz, inline parenthesized options.
const PLAIN_PHOTOSYNTHESIS_QUIZ = `Photosynthesis Quiz
1. Where does photosynthesis mainly occur? (a) Roots (b) Leaves (c) Stem (d) Flowers
2. Which gas do plants release during photosynthesis? (a) Carbon dioxide (b) Nitrogen (c) Oxygen (d) Hydrogen
3. What pigment gives plants their green color? (a) Melanin (b) Chlorophyll (c) Carotene (d) Hemoglobin
Answers: 1. b 2. c 3. b`;

// Plain-text quiz, inline letter options with single-digit answers (math).
const PLAIN_MATH_QUIZ = `Math Quiz
1. What is 2 + 2? a) 3 b) 4 c) 5 d) 6
2. What is 10 / 2? a) 4 b) 5 c) 6 d) 8
3. What is 7 x 6? a) 36 b) 40 c) 42 d) 48
Answers:
1. b
2. c
3. c`;

// Numbered list that is NOT a quiz.
const TIPS_LIST = '5 tips to improve sleep:\n1. Keep a consistent schedule\n2. Avoid screens before bed\n3. Keep the room dark\n4. Avoid caffeine in the evening\n5. Exercise during the day';

const PROSE_ANSWER = 'Sure! Photosynthesis is the process by which green plants use sunlight to synthesize food from carbon dioxide and water, releasing oxygen as a byproduct.';

const PLAIN_RESPONSE = 'The Sun is the star at the center of our solar system. It is about 4.6 billion years old.';

async function postChat(body, mockResponseText) {
  lastGeminiBody = null;
  global.fetch._mockResponseText = mockResponseText;
  const res = await fetch(`http://localhost:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  await waitForServer();
  console.log('✓ server is up');

  // ---- A1. Exact prompt, model emits the ```quiz fence ----
  const quizRes = await postChat(chatBody('Create a 5-question quiz about space.'), FENCED_QUIZ);
  assert.strictEqual(quizRes.status, 200);
  assert.strictEqual(quizRes.data.components.length, 1);
  assert.strictEqual(quizRes.data.components[0].type, 'quiz');
  assert.strictEqual(quizRes.data.components[0].questions.length, 5);
  assert.ok(!quizRes.data.text.includes('```quiz') && !quizRes.data.text.includes('"type":"quiz"'));
  assert.ok(quizRes.data.text.includes('Here\'s your space quiz!'));
  assert.ok(lastGeminiBody && lastGeminiBody.system_instruction.parts[0].text.includes('QUIZ COMPONENT FORMAT'), 'quiz instructions reached the provider');
  ok(true, 'A1: fenced component quiz — components[0].type === "quiz", 5 questions, fence stripped');

  // ---- A2. Exact prompt, model writes a plain-text quiz instead ----
  const plainRes = await postChat(chatBody('Create a 5-question quiz about space.'), PLAIN_SPACE_QUIZ);
  assert.strictEqual(plainRes.status, 200);
  assert.strictEqual(plainRes.data.components.length, 1);
  const comp = plainRes.data.components[0];
  assert.strictEqual(comp.type, 'quiz');
  assert.strictEqual(comp.questions.length, 5, 'all 5 plain-text questions converted');
  assert.strictEqual(comp.title, 'Space Quiz');
  assert.strictEqual(comp.questions[0].answer, 0, 'Mars answer = Iron oxide (a)');
  assert.strictEqual(comp.questions[3].answer, 1, 'Sun composition = Hydrogen and helium (b)');
  assert.ok(!plainRes.data.text.includes('1. What gives Mars'), 'plain-text quiz stripped from visible text');
  ok(true, 'A2: plain-text quiz → converted to component (type "quiz", 5 questions, answers resolved)');

  // ---- A3. "Quiz me on photosynthesis" ----
  const photoRes = await postChat(chatBody('Quiz me on photosynthesis'), PLAIN_PHOTOSYNTHESIS_QUIZ);
  assert.strictEqual(photoRes.status, 200);
  assert.strictEqual(photoRes.data.components.length, 1);
  assert.strictEqual(photoRes.data.components[0].type, 'quiz');
  assert.strictEqual(photoRes.data.components[0].questions.length, 3);
  assert.deepStrictEqual(photoRes.data.components[0].questions.map(q => q.answer), [1, 2, 1], 'b/c/b');
  ok(true, 'A3: "Quiz me on photosynthesis" → component with inline-paren options');

  // ---- A4. "Make a math quiz" ----
  const mathRes = await postChat(chatBody('Make a math quiz'), PLAIN_MATH_QUIZ);
  assert.strictEqual(mathRes.status, 200);
  assert.strictEqual(mathRes.data.components.length, 1);
  assert.strictEqual(mathRes.data.components[0].type, 'quiz');
  assert.deepStrictEqual(mathRes.data.components[0].questions.map(q => q.answer), [1, 2, 2], 'b/c/c');
  ok(true, 'A4: "Make a math quiz" → component with single-digit options resolved');

  // ---- B1. Non-quiz request, numbered-list response → NO component ----
  const tipsRes = await postChat(chatBody('Give me 5 tips to improve sleep'), TIPS_LIST);
  assert.strictEqual(tipsRes.status, 200);
  assert.strictEqual(tipsRes.data.components.length, 0, 'numbered list is NOT converted');
  assert.strictEqual(tipsRes.data.text, TIPS_LIST, 'text unchanged');
  ok(true, 'B1: non-quiz request + numbered list → components === [], text untouched (no false positive)');

  // ---- B2. Plain chat stays plain ----
  const plainRes2 = await postChat(chatBody('What is the Sun?'), PLAIN_RESPONSE);
  assert.strictEqual(plainRes2.status, 200);
  assert.strictEqual(plainRes2.data.components.length, 0);
  assert.strictEqual(plainRes2.data.text, PLAIN_RESPONSE);
  ok(true, 'B2: normal question → components === [], text untouched');

  // ---- B3. Quiz intent but prose response → NOT converted ----
  const proseRes = await postChat(chatBody('Quiz me on photosynthesis'), PROSE_ANSWER);
  assert.strictEqual(proseRes.status, 200);
  assert.strictEqual(proseRes.data.components.length, 0, 'prose is never converted');
  assert.strictEqual(proseRes.data.text, PROSE_ANSWER);
  ok(true, 'B3: quiz intent + prose response → components === [], text preserved');

  // ---- C1. Malformed fenced JSON → no component, no crash ----
  const badRes = await postChat(chatBody('Create a quiz.'), '```quiz\n{"type":"quiz","title":"Broken","questions":[]}\n```');
  assert.strictEqual(badRes.status, 200);
  assert.strictEqual(badRes.data.components.length, 0);
  ok(true, 'C1: malformed quiz JSON → components === [], no crash');

  // ---- C2. Bare JSON quiz without a fence (lenient structured fallback) ----
  const bareJson = FENCED_QUIZ.slice(FENCED_QUIZ.indexOf('{'), FENCED_QUIZ.lastIndexOf('}') + 1);
  const bareRes = await postChat(chatBody('Create a 5-question quiz about space.'), bareJson);
  assert.strictEqual(bareRes.status, 200);
  assert.strictEqual(bareRes.data.components.length, 1);
  assert.strictEqual(bareRes.data.components[0].type, 'quiz');
  ok(true, 'C2: bare JSON quiz (no fence) still parsed');

  // ---- D. Response shape regression: model field is the Aura display name ----
  assert.strictEqual(quizRes.data.model, 'Aura 1 Flash');
  assert.strictEqual(typeof quizRes.data.latencyMs, 'number');
  assert.strictEqual(quizRes.data.truncated, false);
  ok(true, 'D: response keeps the standard { text, model, latencyMs, truncated, components } shape');

  console.log(`\nALL ${passed + 6} QUIZ COMPONENT SERVER TESTS PASSED ✅`);
  server.httpServer.close();
})().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  server.httpServer.close();
  process.exitCode = 1;
});
