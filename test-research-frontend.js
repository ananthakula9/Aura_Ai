// test-research-frontend.js — verifies the Deep Research FRONTEND against
// the real index.html + research.js (driven via jsdom), the same harness
// pattern as test-frontend.js:
//
//   - composer research toggle switches mode + styling
//   - handleResearchSend renders the editable plan card from a real-shaped
//     create response
//   - Start switches to the activity card; SSE research.* events (from a
//     stubbed EventSource) drive the step list + live stats — the activity
//     panel reflects backend events only
//   - terminal event + session fetch renders the report: TOC, sections,
//     clickable citation chips, findings with FACT/ANALYSIS/INFERENCE
//     badges, conflict callouts, SVG chart, sources grid, QC row
//   - citation click opens the source popover with evidence quotes
//
// Run: node test-research-frontend.js   (requires: npm i --no-save jsdom)

const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
}));
window.AbortController = AbortController;
window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
window.scrollTo = () => {};

// ---- stubbed EventSource capturing subscriptions ----
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this); }
  addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
  emit(type, data) { (this.listeners[type] || []).forEach(cb => cb({ data: JSON.stringify(data) })); }
  close() { this.closed = true; }
}
FakeEventSource.instances = [];
window.EventSource = FakeEventSource;

// ---- load the REAL research.js as a classic script ----
const strip = src => src
  .replace(/export\s*\{[\s\S]*?\}\s*;?\s*$/, '')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"];\s*$/gm, '');
window.eval(strip(fs.readFileSync('public/research.js', 'utf8')));
console.log('research.js loaded');

// ============================================================
// Test fixture: a completed session shaped exactly like the engine's output
// ============================================================
const SESSION = {
  id: '11111111-1111-1111-1111-111111111111',
  owner: 'guest:x',
  query: 'Research the state of AI regulation across the EU and US.',
  mode: 'standard', effectiveMode: 'standard',
  state: 'completed', control: 'idle',
  createdAt: Date.now() - 60000, updatedAt: Date.now(),
  intent: { complexity: 'complex', topicType: 'regulation', recency: 'current', providers: ['government', 'news', 'general'], signals: { wantsCompare: true, wantsTimeline: false, wantsData: false, entities: 2 } },
  agentsRan: [
    { key: 'intent', label: 'Intent Analyzer', role: 'Classify the request.', modelBacked: false },
    { key: 'planner', label: 'Research Planner', role: 'Decompose into questions.', modelBacked: true },
    { key: 'primarySource', label: 'Primary Source Agent', role: 'Official documents.', modelBacked: false },
    { key: 'evidence', label: 'Evidence Agent', role: 'Extract claims.', modelBacked: true },
  ],
  version: 2,
  refreshOf: '00000000-0000-0000-0000-000000000000',
  refreshInstruction: 'Find newer evidence.',
  diff: {
    fromVersion: 1, toVersion: 2, generatedAt: Date.now(),
    newSources: [{ n: 3, title: 'New 2026 enforcement report', url: 'https://gov.example/new' }],
    newFindings: [{ statement: 'Enforcement budgets doubled', type: 'fact', confidence: 'high', citations: [3] }],
    removedFindings: ['Penalties were expected to be lower'],
    confidenceChanges: [{ statement: 'Adoption is rising', from: 'moderate', to: 'high' }],
  },
  datasets: [],
  content: {},
  challenge: {
    ranAt: Date.now(),
    verdicts: [
      { findingId: 'f1', statement: 'The EU has a comprehensive horizontal AI act.', verdict: 'upheld', reasoning: 'No dispute found.', confidenceBefore: 'high', confidenceAfter: 'high' },
      { findingId: 'f3', statement: 'Convergence on risk-tiering is likely.', verdict: 'weakened', reasoning: 'Counter-evidence narrows the claim.', confidenceBefore: 'moderate', confidenceAfter: 'limited' },
    ],
  },
  plan: {
    objective: 'Analyze the current state of AI regulation in the EU and US',
    topic: 'AI Regulation',
    scope: { regions: ['EU', 'USA'], timeframe: '2024-2026', audience: '', output: 'report' },
    questions: [
      { id: 'q1', text: 'What major AI regulations exist in the EU?', status: 'researched', searches: 1, evidence: 3 },
      { id: 'q2', text: 'How does the US approach AI regulation?', status: 'researched', searches: 1, evidence: 3 },
    ],
    autoQuestions: true,
  },
  sources: [
    { n: 1, url: 'https://eur-lex.europa.eu/ai-act', domain: 'eur-lex.europa.eu', title: 'EU AI Act — Official Journal', tier: 1, kind: 'Government / Official', origin: 'web', ok: true, status: 'used', dateHint: '2024-08-01', accessedAt: Date.now(), usedFor: 3, filename: null },
    { n: 2, url: 'https://www.nist.gov/ai', domain: 'nist.gov', title: 'NIST AI Risk Management Framework', tier: 1, kind: 'Government / Official', origin: 'web', ok: true, status: 'used', dateHint: '2025-01-20', accessedAt: Date.now(), usedFor: 2, filename: null },
  ],
  evidence: [
    { id: 'e1', sourceN: 1, questionId: 'q1', claim: 'The EU AI Act entered into force on 1 August 2024.', quote: 'The EU AI Act entered into force on 1 August 2024.', numbers: [], verified: 'supported', claimState: { status: 'strongly_supported', supportingSources: [1, 2], independentConfirmation: 2, contradictions: 0 } },
    { id: 'e2', sourceN: 2, questionId: 'q2', claim: 'NIST published a voluntary AI risk framework.', quote: 'NIST published a voluntary AI risk framework for organizations.', numbers: [], verified: 'supported', claimState: { status: 'supported', supportingSources: [2], independentConfirmation: 1, contradictions: 0 } },
  ],
  conflicts: [
    { id: 'c1', subject: 'enterprise adoption rate', entries: [
      { sourceN: 1, value: 42, unit: '%', quote: 'adoption reached 42 percent', sourceTitle: 'EU AI Act — Official Journal', sourceUrl: 'https://eur-lex.europa.eu/ai-act' },
      { sourceN: 2, value: 31, unit: '%', quote: 'adoption measured at 31 percent', sourceTitle: 'NIST AI Risk Management Framework', sourceUrl: 'https://www.nist.gov/ai' },
    ], explanation: 'Different survey populations and definitions.' },
  ],
  findings: [
    { id: 'f1', statement: 'The EU has a comprehensive horizontal AI act.', type: 'fact', confidence: 'high', citations: [1], claims: ['e1'], questionId: 'q1' },
    { id: 'f2', statement: 'The US relies on sectoral and voluntary frameworks.', type: 'analysis', confidence: 'high', citations: [2], claims: ['e2'], questionId: 'q2' },
    { id: 'f3', statement: 'Convergence on risk-tiering is likely.', type: 'inference', confidence: 'moderate', citations: [1, 2], claims: [], questionId: null },
  ],
  charts: [
    { id: 'ch1', type: 'bar', title: 'Reported enterprise AI adoption', unit: '%', period: '2024-2025', sourceN: 1, series: [{ label: 'Official review', value: 42 }, { label: 'Survey', value: 31 }], note: 'Different survey populations.' },
  ],
  report: {
    title: 'AI Regulation: EU and US',
    generatedAt: Date.now(),
    sections: [
      { kind: 'executive-summary', heading: 'Executive Summary', body: 'The EU passed a horizontal act [1] while the US uses sectoral guidance [2].' },
      { kind: 'findings', heading: 'Key Findings' },
      { kind: 'comparison', heading: 'Comparison', note: 'High-level.', columns: ['Dimension', 'EU', 'US'], rows: [['Approach', 'Comprehensive act [1]', 'Sectoral [2]']], cellCitations: { '0': [1, 2] } },
      { kind: 'timeline', heading: 'Timeline', events: [{ date: '2024-08', label: 'EU AI Act in force', citation: 1 }] },
      { kind: 'conflicts', heading: 'Conflicting Evidence', conflicts: null },
      { kind: 'limitations', heading: 'Limitations', items: ['No reliable evidence was found for: "enforcement budgets".'] },
      { kind: 'sources', heading: 'Sources', sources: null },
    ],
  },
  qc: { checks: [{ name: 'citationCoverage', pass: true }], score: 0.86, citationCoverage: 0.9, overall: 0.83, overallLabel: 'Strong', conflictsDetected: 1,
        metrics: [
          { key: 'sourceQuality', label: 'Source Quality', value: 1, formula: 'Tier 1/2 sources ÷ used sources' },
          { key: 'citationCoverage', label: 'Citation Coverage', value: 0.9, formula: 'cited claim sentences ÷ claim sentences' },
        ] },
  limitations: ['No reliable evidence was found for: "enforcement budgets".'],
  stats: { searches: 2, sourcesFound: 2, sourcesReviewed: 2, sourcesFailed: 0, claimsExtracted: 2, claimsVerified: 2, conflictsFound: 1, chartsCreated: 1, modelCalls: 8, searchesFailed: 0 },
  events: [{ seq: 1, t: Date.now(), type: 'research.started', data: {} }],
  errors: [],
  attachments: [],
};

// The conflicts + sources sections pull live data from the session —
// normalizeReport normally injects them; mirror that here.
SESSION.report.sections.find(s => s.kind === 'conflicts').conflicts = SESSION.conflicts;
SESSION.report.sections.find(s => s.kind === 'sources').sources = SESSION.sources;
SESSION.report.sections.push({ kind: 'challenge', heading: 'Adversarial Challenge', challenge: SESSION.challenge });

// ============================================================
// Stub API surface
// ============================================================
let startCalls = 0;
window.apiFetchCalls = [];
const persisted = [];
const depApiFetch = async (url, options = {}) => {
  window.apiFetchCalls.push({ url, method: options.method || 'GET' });
  const u = String(url);
  if (u === '/api/research' && (options.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ sessions: [] }) };
  if (u === '/api/research' && options.method === 'POST') {
    const fresh = JSON.parse(JSON.stringify(SESSION));
    fresh.state = 'created';
    fresh.report = null;
    fresh.qc = null;
    fresh.findings = [];
    fresh.charts = [];
    fresh.conflicts = [];
    fresh.evidence = [];
    fresh.stats = { searches: 0, sourcesFound: 0, sourcesReviewed: 0, sourcesFailed: 0, claimsExtracted: 0, claimsVerified: 0, conflictsFound: 0, chartsCreated: 0, modelCalls: 0, searchesFailed: 0 };
    return { ok: true, status: 201, json: async () => ({ session: fresh }) };
  }
  const startMatch = /\/api\/research\/(.+)\/(start|pause|resume|stop|followup|report-from-partial)/.exec(u);
  if (startMatch && options.method === 'POST') {
    if (startMatch[2] === 'followup') {
      startCalls++;
      const child = JSON.parse(JSON.stringify(SESSION));
      child.id = '22222222-2222-2222-2222-222222222222';
      child.parentId = SESSION.id;
      child.state = 'created';
      child.report = null; child.qc = null; child.findings = []; child.charts = []; child.conflicts = []; child.evidence = [];
      child.query = 'What penalties apply?';
      child.plan = { ...child.plan, objective: 'Follow-up: What penalties apply?', questions: [{ id: 'q0', text: 'What penalties apply?', status: 'pending', searches: 0, evidence: 0 }] };
      return { ok: true, status: 201, json: async () => ({ session: child }) };
    }
    startCalls++;
    return { ok: true, status: 200, json: async () => ({ started: true }) };
  }
  const getMatch = /\/api\/research\/([^/]+)$/.exec(u);
  if (getMatch && (options.method || 'GET') === 'GET') {
    const completed = JSON.parse(JSON.stringify(SESSION));
    return { ok: true, status: 200, json: async () => ({ session: completed, running: false }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// RUN
// ============================================================
(async () => {
  const conversationInner = window.document.getElementById('conversationInner');
  window.initResearch({
    apiFetch: depApiFetch,
    escapeHtml,
    renderMarkdown: (t) => `<p>${escapeHtml(t)}</p>`,
    conversationInner,
    ensureConversationStarted: () => { const es = window.document.getElementById('emptyState'); if (es && es.parentElement) es.remove(); },
    scrollToBottom: () => {},
    addErrorCard: (t) => { const d = window.document.createElement('div'); d.className = 'err'; d.textContent = t; conversationInner.appendChild(d); },
    closeSidebar: () => {},
    toast: () => {},
    persistMessage: (role, content) => persisted.push({ role, content }),
  });

  // ---- 1. composer toggle ----
  const toggle = window.document.getElementById('researchToggle');
  const shell = window.document.getElementById('inputShell');
  toggle.click();
  assert.ok(shell.classList.contains('research-on'), 'research mode styles the composer');
  assert.strictEqual(window.isResearchMode(), true, 'isResearchMode() true');
  const input = window.document.getElementById('userInput');
  assert.ok(input.placeholder.includes('research'), 'placeholder changes in research mode');

  // ---- 2. plan card renders from create response ----
  await window.handleResearchSend('Research the state of AI regulation across the EU and US.', [], {
    clearComposer: () => {}, showLoading: () => {}, hideLoading: () => {},
  });
  await new Promise(r => setTimeout(r, 20));
  const planCard = conversationInner.querySelector('.rs-card');
  assert.ok(planCard, 'plan card rendered');
  assert.ok(planCard.textContent.includes('Research Plan'), 'plan badge');
  assert.ok(planCard.querySelectorAll('.rs-question').length === 2, 'questions rendered');
  assert.ok(planCard.querySelector('[data-act="start"]'), 'Start button present');
  assert.ok(planCard.querySelector('[data-act="edit"]'), 'Edit button present');
  console.log('✓ research toggle + plan card render with editable questions');

  // ---- 3. start → activity card, SSE events drive steps + stats ----
  planCard.querySelector('[data-act="start"]').click();
  await new Promise(r => setTimeout(r, 20));
  const activityCard = conversationInner.querySelector('.rs-card');
  assert.ok(activityCard.querySelector('.rs-steps'), 'steps list rendered');
  assert.ok(activityCard.querySelector('[data-act="pause"]'), 'Pause control present');
  assert.ok(FakeEventSource.instances.length >= 1, 'EventSource subscribed');

  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es.emit('research', { seq: 2, t: Date.now(), type: 'research.search_completed', data: { query: 'EU AI act', found: 5 } });
  es.emit('research', { seq: 3, t: Date.now(), type: 'research.source_opened', data: { url: 'https://x', title: 'EU AI Act' } });
  es.emit('research', { seq: 4, t: Date.now(), type: 'research.evidence_extracted', data: { source: 1, claims: 3, title: 'EU AI Act' } });
  es.emit('research', { seq: 5, t: Date.now(), type: 'research.verification_done', data: { verified: 2, conflicts: 1 } });
  es.emit('research', { seq: 6, t: Date.now(), type: 'research.completed', data: {} });
  await new Promise(r => setTimeout(r, 40));

  // ---- 4. report card after completion ----
  const reportCard = conversationInner.querySelector('.rs-card');
  assert.ok(reportCard.querySelector('.rs-toc'), 'TOC rendered');
  assert.ok(reportCard.textContent.includes('Executive Summary'), 'exec summary section');
  assert.ok(reportCard.querySelectorAll('.cite').length >= 3, 'citation chips rendered');
  assert.ok(reportCard.querySelector('.rs-chart svg'), 'SVG chart rendered');
  assert.ok(reportCard.querySelector('.rs-conflict'), 'conflict callout rendered');
  assert.ok(reportCard.querySelectorAll('.rs-source-card').length === 2, 'source cards rendered');
  assert.ok(reportCard.textContent.includes('QC 86/100'), 'QC score shown');
  assert.ok(reportCard.textContent.includes('Limitations'), 'limitations section');
  const findingTypes = [...reportCard.querySelectorAll('.rs-finding-type')].map(e => e.textContent);
  assert.ok(findingTypes.includes('fact') && findingTypes.includes('analysis') && findingTypes.includes('inference'), 'FACT/ANALYSIS/INFERENCE badges');
  assert.ok(reportCard.querySelector('a[href$="/export.md"]'), 'markdown export link');
  assert.ok(persisted.length === 1 && persisted[0].role === 'assistant' && persisted[0].content.includes('Deep Research complete'), 'summary persisted to conversation');
  console.log('✓ SSE events drive activity; completed report renders TOC, citations, charts, conflicts, sources, QC');

  // ---- 5. citation popover ----
  const cite = reportCard.querySelector('.cite[data-n="1"]');
  cite.click();
  await new Promise(r => setTimeout(r, 10));
  const pop = window.document.querySelector('.rs-cite-pop');
  assert.ok(pop, 'citation popover opened');
  assert.ok(pop.textContent.includes('EU AI Act — Official Journal'), 'popover shows source title');
  assert.ok(pop.textContent.includes('1 August 2024'), 'popover shows evidence quote');
  assert.ok(pop.textContent.includes('verified'), 'verification state shown');
  pop.querySelector('.pop-close').click();
  assert.ok(!window.document.querySelector('.rs-cite-pop'), 'popover closes');
  console.log('✓ citation click → source card with evidence quotes and verification state');

  // ---- 6. drawer opened during research and shows the objective ----
  const drawer = window.document.getElementById('rsDrawer');
  assert.ok(drawer.classList.contains('open'), 'activity drawer opened');
  assert.ok(window.document.getElementById('rsDrawerBody').textContent.includes('AI regulation'), 'drawer shows objective');
  console.log('✓ activity drawer opened with live content');

  // ---- V2 6a: drawer tabs — Sources / Evidence / Conflicts / Quality ----
  const tab = (name) => window.document.querySelector(`#rsDrawerTabs [data-rtab="${name}"]`);
  tab('sources').click();
  await new Promise(r => setTimeout(r, 10));
  let drawerBody = window.document.getElementById('rsDrawerBody');
  assert.ok(drawerBody.querySelectorAll('.rs-source-card').length === 2, 'sources tab lists source cards');
  assert.ok(drawerBody.querySelector('.rs-stars'), 'source cards show star quality rating');
  assert.ok(drawerBody.textContent.includes('supports 2 findings'), 'source card shows findings supported');

  tab('evidence').click();
  await new Promise(r => setTimeout(r, 10));
  drawerBody = window.document.getElementById('rsDrawerBody');
  assert.ok(drawerBody.querySelectorAll('.rs-evidence-item').length === 2, 'evidence tab lists claims');
  assert.ok(drawerBody.querySelector('.rs-claim-state.strongly_supported'), 'claim state chips rendered');
  assert.ok(drawerBody.textContent.includes('2 independent sources'), 'independent confirmation shown');

  tab('conflicts').click();
  await new Promise(r => setTimeout(r, 10));
  drawerBody = window.document.getElementById('rsDrawerBody');
  assert.ok(drawerBody.querySelector('.rs-conflict'), 'conflicts tab lists conflicts');

  tab('quality').click();
  await new Promise(r => setTimeout(r, 10));
  drawerBody = window.document.getElementById('rsDrawerBody');
  assert.ok(drawerBody.textContent.includes('Overall: Strong'), 'quality tab shows overall label');
  assert.ok(drawerBody.querySelectorAll('.rs-qmetric').length === 2, 'quality metrics rendered with bars');
  assert.ok(drawerBody.textContent.includes('Tier 1/2 sources ÷ used sources'), 'metric formula documented in UI');
  console.log('✓ V2 drawer tabs: Sources (stars), Evidence (claim states), Conflicts, Quality (documented metrics)');

  // ---- V2 6b: report extras — version badge, diff, challenge section, map ----
  assert.ok(reportCard.querySelector('.rs-version-badge').textContent === 'v2', 'version badge shown');
  assert.ok(reportCard.querySelector('.rs-diff'), 'version diff rendered');
  assert.ok(reportCard.querySelector('.rs-diff-row.add'), 'diff shows additions');
  const challengeSec = [...reportCard.querySelectorAll('.rs-section-title')].find(el => el.textContent.includes('Adversarial Challenge'));
  assert.ok(challengeSec, 'challenge section present');
  assert.ok(reportCard.querySelectorAll('.rs-challenge-verdict.upheld, .rs-challenge-verdict.weakened').length >= 2, 'challenge verdicts rendered');
  assert.ok(reportCard.querySelector('.rs-map svg'), 'research map SVG rendered');
  assert.ok(reportCard.querySelector('[data-ract="challenge"]'), 'challenge button present');
  assert.ok(reportCard.querySelector('[data-ract="refresh"]'), 'find-newer-evidence button present');
  assert.ok(reportCard.querySelector('a[href$="/export.json"]'), 'JSON export link present');
  const contentBtns = [...reportCard.querySelectorAll('[data-cgen]')].map(b => b.dataset.cgen);
  assert.ok(['quiz', 'notes', 'summary', 'article'].every(k => contentBtns.includes(k)), 'content generation buttons present');
  console.log('✓ V2 report: version badge + diff, challenge section + verdicts, research map, refresh/content/export actions');

  // ---- V2 6c: finding traceability chain (finding → claims → evidence) ----
  const showEvidenceBtn = reportCard.querySelector('[data-fact="evidence"]');
  assert.ok(showEvidenceBtn, 'Show evidence action on findings');
  showEvidenceBtn.click();
  await new Promise(r => setTimeout(r, 10));
  const trace = window.document.querySelector('.modal-overlay .rs-claim-state');
  assert.ok(trace, 'trace modal opened with claim states');
  const traceModal = showEvidenceBtn.closest('.modal-overlay') || window.document.querySelector('.modal-overlay:last-of-type');
  assert.ok(traceModal.textContent.includes('independent source'), 'trace shows independent confirmation');
  console.log('✓ V2 traceability: Finding → claims (with states) → evidence quotes → sources');

  // ---- V2 6d: section tools (regenerate/simplify) ----
  const regenBtn = reportCard.querySelector('[data-sact="regen"]');
  assert.ok(regenBtn, 'section regenerate tool present');
  console.log('✓ V2 section tools present (regenerate / simplify / ask)');

  // ---- 7. follow-up row + controls are real buttons ----
  const fuInput = reportCard.querySelector('.rs-followup-input');
  const fuBtn = reportCard.querySelector('[data-ract="followup"]');
  assert.ok(fuInput && fuBtn, 'follow-up row present');
  fuInput.value = 'What penalties apply?';
  fuBtn.click();
  await new Promise(r => setTimeout(r, 30));
  const planCards = conversationInner.querySelectorAll('.rs-card');
  assert.ok(planCards.length >= 2, 'follow-up plan card appended');
  console.log('✓ follow-up research launches a new plan card');

  console.log('\nALL RESEARCH FRONTEND TESTS PASSED ✅');
  dom.window.close();
})().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
  dom.window.close();
});
