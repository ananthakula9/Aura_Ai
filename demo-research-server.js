// demo-research-server.js — keyless development server for the Deep
// Research UI. Serves the real frontend and stubs ONLY the research API
// with realistic fixture data (plan → SSE events → report), so the UI can
// be developed/demoed without a Gemini key or real web access.
//
// Usage: node demo-research-server.js   → http://localhost:3999
// Normal chat (/api/chat) is NOT stubbed — this server is for research UI
// work; use the real server (npm start) for everything else.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3999;
app.use(express.json({ limit: '45mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function fixtureSession(query, mode) {
  const id = crypto.randomUUID();
  return {
    id,
    owner: 'demo',
    query,
    mode: mode || 'auto',
    effectiveMode: mode && mode !== 'auto' ? mode : 'deep',
    state: 'created',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    intent: { complexity: 'complex', topicType: 'regulation', recency: 'current', providers: ['government', 'news', 'general'], signals: { wantsCompare: true, wantsTimeline: true, wantsData: false, entities: 2 } },
    agentsRan: [
      { key: 'intent', label: 'Intent Analyzer', role: 'Classify complexity, topic, providers.', modelBacked: false },
      { key: 'planner', label: 'Research Planner', role: 'Decompose into questions.', modelBacked: true },
      { key: 'discovery', label: 'Discovery Agent', role: 'Find candidate sources.', modelBacked: false },
      { key: 'primarySource', label: 'Primary Source Agent', role: 'Steer toward official documents.', modelBacked: false },
      { key: 'evidence', label: 'Evidence Agent', role: 'Extract claims + quotes.', modelBacked: true },
      { key: 'verification', label: 'Verification Agent', role: 'Cross-check claims.', modelBacked: true },
      { key: 'synthesis', label: 'Synthesis Agent', role: 'Findings with confidence.', modelBacked: true },
      { key: 'report', label: 'Report Agent', role: 'Write the cited report.', modelBacked: true },
      { key: 'quality', label: 'Quality Agent', role: 'Transparent scoring.', modelBacked: false },
    ],
    version: 1, refreshOf: null, refreshInstruction: null, diff: null,
    datasets: [], content: {}, challenge: null,
    plan: {
      objective: `Analyze the current state and future impact of: ${query.slice(0, 120)}`,
      topic: query.slice(0, 60),
      scope: { regions: ['EU', 'USA', 'India', 'UK', 'China'], timeframe: '2024-2026', audience: '', output: 'report' },
      questions: [
        { id: 'q1', text: 'What major regulations exist in each jurisdiction?', status: 'pending', searches: 0, evidence: 0 },
        { id: 'q2', text: 'What stage is each regulation at?', status: 'pending', searches: 0, evidence: 0 },
        { id: 'q3', text: 'What obligations exist for companies?', status: 'pending', searches: 0, evidence: 0 },
        { id: 'q4', text: 'How do the jurisdictions differ?', status: 'pending', searches: 0, evidence: 0 },
      ],
      autoQuestions: true,
    },
    sources: [],
    evidence: [],
    conflicts: [],
    findings: [],
    charts: [],
    report: null,
    qc: null,
    limitations: [],
    stats: { searches: 0, sourcesFound: 0, sourcesReviewed: 0, sourcesFailed: 1, claimsExtracted: 0, claimsVerified: 0, conflictsFound: 0, chartsCreated: 0, modelCalls: 0, searchesFailed: 0 },
    events: [],
    errors: [],
    attachments: [],
  };
}

const DEMO_SOURCES = [
  { n: 1, url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', domain: 'eur-lex.europa.eu', title: 'Regulation (EU) 2024/1689 — AI Act', tier: 1, kind: 'Government / Official', origin: 'web', ok: true, status: 'used', dateHint: '2024-07-12', accessedAt: Date.now(), usedFor: 4, filename: null },
  { n: 2, url: 'https://www.nist.gov/itl/ai-risk-management-framework', domain: 'nist.gov', title: 'NIST AI Risk Management Framework', tier: 1, kind: 'Government / Official', origin: 'web', ok: true, status: 'used', dateHint: '2025-01-20', accessedAt: Date.now(), usedFor: 3, filename: null },
  { n: 3, url: 'https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai', domain: 'mckinsey.com', title: 'The state of AI — global survey', tier: 2, kind: 'Industry Research', origin: 'web', ok: true, status: 'used', dateHint: '2025-05-01', accessedAt: Date.now(), usedFor: 3, filename: null },
  { n: 4, url: 'https://blog.techblog.example/ai-regulation-roundup', domain: 'blog.techblog.example', title: 'AI regulation roundup (blog)', tier: 3, kind: 'Aggregator / Community', origin: 'web', ok: false, status: 'failed', dateHint: null, accessedAt: Date.now(), usedFor: 0, filename: null },
];

const DEMO_EVIDENCE = [
  { id: 'e1', sourceN: 1, questionId: 'q1', claim: 'The EU AI Act entered into force on 1 August 2024.', quote: 'This Regulation shall enter into force on the twentieth day following that of its publication in the Official Journal.', numbers: [], verified: 'supported', claimState: { status: 'strongly_supported', supportingSources: [1, 3], independentConfirmation: 2, contradictions: 0 } },
  { id: 'e2', sourceN: 1, questionId: 'q3', claim: 'Penalties for prohibited practices reach 35M EUR or 7% of worldwide turnover.', quote: 'shall be subject to administrative fines of up to 35 000 000 EUR or, if the offender is an undertaking, up to 7 % of its total worldwide annual turnover', numbers: [{ value: 35, unit: 'M EUR', context: 'max fine' }, { value: 7, unit: '%', context: 'turnover fine' }], verified: 'supported', claimState: { status: 'supported', supportingSources: [1], independentConfirmation: 1, contradictions: 0 } },
  { id: 'e3', sourceN: 2, questionId: 'q1', claim: 'The US NIST AI RMF is a voluntary risk framework.', quote: 'The AI RMF is voluntary, right-sized, and use-case driven.', numbers: [], verified: 'supported', claimState: { status: 'supported', supportingSources: [2], independentConfirmation: 1, contradictions: 0 } },
  { id: 'e4', sourceN: 3, questionId: 'q2', claim: 'Enterprise AI adoption reached 78 percent of surveyed organizations.', quote: 'Seventy-eight percent of respondents say their organizations use AI in at least one business function.', numbers: [{ value: 78, unit: '%', context: 'enterprise adoption' }], verified: 'supported', claimState: { status: 'supported', supportingSources: [3], independentConfirmation: 1, contradictions: 1 } },
  { id: 'e5', sourceN: 2, questionId: 'q2', claim: 'An alternate survey measured adoption at 55 percent.', quote: 'about 55 percent of organizations report ongoing AI adoption', numbers: [{ value: 55, unit: '%', context: 'enterprise adoption' }], verified: 'conflicting', claimState: { status: 'conflicting', supportingSources: [2], independentConfirmation: 1, contradictions: 1 } },
];

const DEMO_CONFLICTS = [
  { id: 'c1', subject: 'enterprise adoption percent', entries: [
    { sourceN: 3, value: 78, unit: '%', quote: 'Seventy-eight percent of respondents…', sourceTitle: 'The state of AI — global survey', sourceUrl: 'https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai' },
    { sourceN: 2, value: 55, unit: '%', quote: 'about 55 percent of organizations…', sourceTitle: 'NIST AI Risk Management Framework', sourceUrl: 'https://www.nist.gov/itl/ai-risk-management-framework' },
  ], explanation: "The surveys cover different populations (McKinsey's is large-enterprise skewed) and different definitions of \"adoption\". Treat both as reported; the direction (rising adoption) is consistent." },
];

const DEMO_FINDINGS = [
  { id: 'f1', statement: 'The EU has enacted a comprehensive, horizontal AI regulation in force since August 2024.', type: 'fact', confidence: 'high', citations: [1], claims: ['e1'], questionId: 'q1' },
  { id: 'f2', statement: 'The US approach combines voluntary frameworks (NIST AI RMF) with sector-specific rules rather than one federal AI act.', type: 'fact', confidence: 'high', citations: [2], claims: ['e3'], questionId: 'q1' },
  { id: 'f3', statement: 'Enterprise AI adoption keeps rising across surveys, though headline figures differ by methodology.', type: 'analysis', confidence: 'conflicting', citations: [2, 3], claims: ['e4', 'e5'], questionId: 'q2' },
  { id: 'f4', statement: 'Global companies face the strictest obligations in the EU, making it the de-facto baseline for compliance programs.', type: 'inference', confidence: 'moderate', citations: [1, 2], claims: ['e2'], questionId: 'q3' },
];

const DEMO_CHARTS = [
  { id: 'ch1', type: 'bar', title: 'Maximum fines under the EU AI Act by violation tier', unit: 'M EUR', period: 'as of 2025', sourceN: 1, series: [{ label: 'Prohibited practices', value: 35 }, { label: 'High-risk duties', value: 15 }, { label: 'Misleading info', value: 7 }], note: 'Fines can alternatively be a % of global turnover.' },
  { id: 'ch2', type: 'line', title: 'Reported enterprise AI adoption (surveys)', unit: '%', period: '2021-2025', sourceN: 3, series: [{ label: '2021', value: 56, date: '2021' }, { label: '2022', value: 50, date: '2022' }, { label: '2023', value: 55, date: '2023' }, { label: '2024', value: 72, date: '2024' }, { label: '2025', value: 78, date: '2025' }], note: 'Different survey populations across years — see conflicts section.' },
];

function demoReport(session) {
  return {
    title: `Deep Research: ${session.plan.topic}`,
    generatedAt: Date.now(),
    sections: [
      { kind: 'executive-summary', heading: 'Executive Summary', body: `This report analyzes **${session.plan.topic}** across the requested jurisdictions. The EU has the most comprehensive framework in force [1], the US pairs voluntary NIST guidance with sector rules [2], and adoption keeps rising across industry surveys [3]. Companies operating globally should treat EU obligations as their compliance floor [1] [2].` },
      { kind: 'landscape', heading: 'Current Landscape', body: `The regulatory landscape has hardened from guidance into law.\n\n- **EU** — horizontal act in force 2024-08-01 with phased obligations through 2027 [1]\n- **US** — NIST AI RMF (voluntary) plus executive-branch directives [2]\n- Adoption context — enterprise use keeps expanding [3]` },
      { kind: 'findings', heading: 'Key Findings' },
      { kind: 'comparison', heading: 'Framework Comparison', note: 'High-level comparison synthesized from the gathered evidence.', columns: ['Dimension', 'EU', 'US'], rows: [['Legal form', 'Binding regulation [1]', 'Voluntary framework + sector rules [2]'], ['Enforcement', 'Fines up to 35M EUR / 7% turnover [1]', 'Agency-specific enforcement [2]']], cellCitations: { '0': [1, 2] } },
      { kind: 'timeline', heading: 'Timeline', events: [
        { date: '2024-07', label: 'EU AI Act published in Official Journal', description: 'Published 12 July 2024.', citation: 1 },
        { date: '2024-08', label: 'EU AI Act enters into force', description: 'Twentieth day after publication.', citation: 1 },
        { date: '2025-01', label: 'NIST AI RMF updated guidance', citation: 2 },
        { date: '2026-08', label: 'General-purpose AI obligations begin', description: 'Phase-in continues through 2027.', citation: 1 },
      ] },
      { kind: 'conflicts', heading: 'Conflicting Evidence', conflicts: DEMO_CONFLICTS },
      { kind: 'limitations', heading: 'Limitations', items: ['1 source could not be opened (blog.techblog.example) — the report uses the evidence that was successfully gathered.', 'No reliable evidence was found for: "UK and China stage details" — narrow the follow-up to dig deeper.'] },
      { kind: 'sources', heading: 'Sources', sources: DEMO_SOURCES.filter(s => s.status === 'used') },
    ],
  };
}

// ---- fake progress driver ----
function emit(session, type, data = {}) {
  session.events.push({ seq: session.events.length + 1, t: Date.now(), type, data });
}

function runDemo(session) {
  session.state = 'researching';
  const script = [
    () => emit(session, 'research.started', { mode: session.effectiveMode, questions: session.plan.questions.length }),
    () => { session.sources = DEMO_SOURCES.map(s => ({ ...s })); session.stats.sourcesFound = session.sources.length; emit(session, 'research.search_completed', { query: session.plan.questions[0].text, found: 4 }); },
    () => emit(session, 'research.source_opened', { url: DEMO_SOURCES[0].url, title: DEMO_SOURCES[0].title }),
    () => emit(session, 'research.source_opened', { url: DEMO_SOURCES[1].url, title: DEMO_SOURCES[1].title }),
    () => emit(session, 'research.evidence_extracted', { source: 1, claims: 2, title: DEMO_SOURCES[0].title }),
    () => emit(session, 'research.source_failed', { url: DEMO_SOURCES[3].url, error: 'HTTP 503' }),
    () => emit(session, 'research.source_opened', { url: DEMO_SOURCES[2].url, title: DEMO_SOURCES[2].title }),
    () => emit(session, 'research.evidence_extracted', { source: 3, claims: 1, title: DEMO_SOURCES[2].title }),
    () => { session.plan.questions.forEach(q => { q.status = 'researched'; q.evidence = 2; }); emit(session, 'research.question_done', { question: session.plan.questions[3].text, status: 'researched', evidence: 4 }); },
    () => { session.state = 'verifying'; emit(session, 'research.verification_started'); },
    () => { session.evidence = DEMO_EVIDENCE.map(e => ({ ...e })); session.stats.claimsExtracted = session.evidence.length; session.conflicts = DEMO_CONFLICTS.map(c => ({ ...c })); session.stats.conflictsFound = 1; emit(session, 'research.conflict_found', { subject: 'enterprise adoption percent' }); },
    () => { session.stats.claimsVerified = 5; emit(session, 'research.verification_done', { verified: 5, conflicts: 1 }); },
    () => { session.state = 'analyzing'; emit(session, 'research.analysis_started'); },
    () => { session.findings = DEMO_FINDINGS; session.charts = DEMO_CHARTS; session.stats.chartsCreated = 2; emit(session, 'research.chart_created', { title: DEMO_CHARTS[0].title, type: 'bar' }); },
    () => emit(session, 'research.analysis_done', { findings: 4, charts: 2 }),
    () => { session.state = 'reporting'; emit(session, 'research.report_started'); },
    () => { session.report = demoReport(session); emit(session, 'research.report_ready', { title: session.report.title, sections: session.report.sections.length }); },
    () => { session.qc = { checks: [{ name: 'citationCoverage', pass: true }, { name: 'numericConsistency', pass: true }, { name: 'completeness', pass: true }], score: 0.86, citationCoverage: 0.92 }; emit(session, 'research.qc_done', { score: 0.86, coverage: 0.92 }); },
    () => { session.state = 'completed'; session.stats.sourcesReviewed = 3; session.stats.searches = 4; emit(session, 'research.completed', { stats: session.stats }); },
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (session.control === 'pause' || i >= script.length) {
      if (session.control === 'pause' && i < script.length) { session.state = 'paused'; emit(session, 'research.paused', {}); }
      clearInterval(timer);
      if (i >= script.length) { session.state = 'completed'; }
      return;
    }
    if (session.control === 'stop') { session.state = 'cancelled'; emit(session, 'research.cancelled', {}); clearInterval(timer); return; }
    script[i++]();
  }, 900);
}

// ---- API stubs mirroring the real routes' shapes ----
app.get('/api/health', (req, res) => res.json({ ok: true, keyConfigured: true, defaultModel: 'Aura 1 Flash', models: [{ displayName: 'Aura 1 Flash', description: 'd', isDefault: true }], accountsEnabled: false, googleOAuthEnabled: false, researchEnabled: true }));
app.get('/api/auth/me', (req, res) => res.json({ user: null, accountsEnabled: false, googleOAuthEnabled: false }));
app.get('/api/chat', (req, res) => res.status(501).json({ error: 'DEMO', message: 'Chat is not stubbed — run npm start for real chat.' }));

app.post('/api/research', (req, res) => {
  const { query, mode } = req.body || {};
  if (!query) return res.status(400).json({ error: 'BAD_REQUEST', message: 'query required' });
  const session = fixtureSession(query, mode);
  sessions.set(session.id, session);
  setTimeout(() => emit(session, 'research.plan_created', { questions: session.plan.questions.length }), 30);
  res.status(201).json({ session });
});

app.get('/api/research', (req, res) => res.json({ sessions: [...sessions.values()].map(s => ({ id: s.id, query: s.query, mode: s.mode, effectiveMode: s.effectiveMode, state: s.state, createdAt: s.createdAt, updatedAt: s.updatedAt })) }));

app.get('/api/research/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND', message: 'nope' });
  res.json({ session: JSON.parse(JSON.stringify(s)), running: ['researching', 'verifying', 'analyzing', 'reporting'].includes(s.state) });
});

app.patch('/api/research/:id/plan', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND', message: 'nope' });
  const { questions } = req.body || {};
  if (Array.isArray(questions)) {
    s.plan.questions = questions.filter(Boolean).map((text, i) => ({ id: 'q' + i, text, status: 'pending', searches: 0, evidence: 0 }));
    s.plan.autoQuestions = false;
  }
  res.json({ session: JSON.parse(JSON.stringify(s)) });
});

app.post('/api/research/:id/start', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND', message: 'nope' });
  if (!s.report) runDemo(s);
  res.json({ started: true });
});
app.post('/api/research/:id/pause', (req, res) => { const s = sessions.get(req.params.id); if (s) s.control = 'pause'; res.json({ pausing: true }); });
app.post('/api/research/:id/resume', (req, res) => { const s = sessions.get(req.params.id); if (s) { s.control = 'run'; s.state = s.state === 'paused' ? 'researching' : s.state; runDemo(s); } res.json({ resumed: true }); });
app.post('/api/research/:id/stop', (req, res) => { const s = sessions.get(req.params.id); if (s) s.control = 'stop'; res.json({ stopping: true }); });
app.post('/api/research/:id/followup', (req, res) => {
  const parent = sessions.get(req.params.id);
  const { question } = req.body || {};
  if (!parent || !question) return res.status(400).json({ error: 'BAD_REQUEST', message: 'need question' });
  const child = fixtureSession(question, parent.mode);
  child.parentId = parent.id;
  child.sources = parent.sources.map(s => ({ ...s }));
  sessions.set(child.id, child);
  res.status(201).json({ session: JSON.parse(JSON.stringify(child)) });
});

// ---- V2 demo endpoints ----
app.post('/api/research/:id/challenge', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.report) return res.status(409).json({ error: 'BAD_STATE', message: 'Need a completed report.' });
  emit(s, 'research.challenge_started');
  emit(s, 'research.challenge_search', { finding: 'EU AI Act obligations' });
  await new Promise(r => setTimeout(r, 1200));
  s.challenge = {
    ranAt: Date.now(),
    verdicts: [
      { findingId: 'f1', statement: 'The EU has enacted a comprehensive, horizontal AI regulation in force since August 2024.', verdict: 'upheld', reasoning: 'Opposing searches surfaced no dispute of the in-force date or horizontal scope across official and industry sources.', confidenceBefore: 'high', confidenceAfter: 'high' },
      { findingId: 'f4', statement: 'Global companies face the strictest obligations in the EU, making it the de-facto baseline for compliance programs.', verdict: 'weakened', reasoning: 'Counter-analysis notes several US sector rules now exceed EU stringency in specific domains, narrowing the "strictest overall" framing.', confidenceBefore: 'moderate', confidenceAfter: 'limited' },
    ],
  };
  s.report.sections = s.report.sections.filter(sec => sec.kind !== 'challenge');
  s.report.sections.splice(s.report.sections.length - 1, 0, { kind: 'challenge', heading: 'Adversarial Challenge', challenge: s.challenge });
  emit(s, 'research.challenge_done', { upheld: 1, weakened: 1, overturned: 0 });
  res.json({ ok: true, challenge: s.challenge });
});
app.post('/api/research/:id/section/:kind', (req, res) => {
  const s = sessions.get(req.params.id);
  const sec = s?.report?.sections.find(x => x.kind === req.params.kind);
  if (!sec) return res.status(409).json({ error: 'BAD_STATE', message: 'Section not found.' });
  sec.body = req.body?.action === 'simplify'
    ? 'In short: the EU made one big AI law that applies everywhere [1]. The US uses looser, industry-by-industry rules [2]. Companies follow the EU rules because they are the strictest [1] [2].'
    : 'Revised from the same evidence: the EU framework remains the most comprehensive horizontal regulation [1], while the US pairs NIST guidance with sector-specific enforcement [2]. Global compliance programs anchor on EU obligations [1].';
  sec.revisedAt = Date.now();
  res.json({ ok: true, session: JSON.parse(JSON.stringify(s)) });
});
app.post('/api/research/:id/content', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s?.report) return res.status(400).json({ error: 'BAD_REQUEST', message: 'No report.' });
  const kind = req.body?.kind;
  if (kind === 'quiz') {
    return res.json({ ok: true, content: { kind, type: 'quiz', title: 'AI Regulation Quiz', generatedAt: Date.now(), questions: [
      { question: 'When did the EU AI Act enter into force?', options: ['1 August 2024', '1 January 2025', 'Never'], answer: 0, explanation: 'Per the official journal [1].' },
      { question: 'Is the NIST AI RMF binding law?', options: ['Yes', 'No — voluntary', 'Only in the EU'], answer: 1, explanation: 'It is a voluntary framework [2].' },
    ] } });
  }
  const bodies = {
    notes: '## Key terms\n- **Horizontal regulation** — one law covering all sectors [1]\n- **Sectoral** — rules per industry [2]\n\n## Must-know dates\n- 2024-08: EU AI Act in force [1]',
    summary: 'The EU regulates AI through one comprehensive act [1]; the US through voluntary frameworks plus sector rules [2]. Companies should anchor compliance on EU obligations [1] [2].',
    article: 'AI regulation has split into two models. Brussels chose one law for everything [1]; Washington chose many smaller ones [2]. The practical consequence for any global company is simple: build to the strictest rule [1].',
  };
  if (!bodies[kind]) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown kind.' });
  res.json({ ok: true, content: { kind, title: 'Generated from research', body: bodies[kind], generatedAt: Date.now() } });
});
app.post('/api/research/:id/refresh', (req, res) => {
  const parent = sessions.get(req.params.id);
  if (!parent?.report) return res.status(409).json({ error: 'NO_REPORT', message: 'no report' });
  const child = fixtureSession(parent.query, parent.effectiveMode);
  child.version = (parent.version || 1) + 1;
  child.refreshOf = parent.id;
  child.refreshInstruction = req.body?.instruction || 'Find newer evidence.';
  child.intent = parent.intent || null;
  child.agentsRan = parent.agentsRan || [];
  child.sources = parent.sources.map(s => ({ ...s, inherited: true }));
  sessions.set(child.id, child);
  res.status(201).json({ session: JSON.parse(JSON.stringify(child)) });
});
app.get('/api/research/:id/export.json', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s?.report) return res.status(409).json({ error: 'NO_REPORT', message: 'no report yet' });
  res.setHeader('Content-Type', 'application/json');
  res.json({ id: s.id, query: s.query, version: s.version || 1, objective: s.plan.objective, sources: s.sources.filter(x => x.status === 'used'), evidence: s.evidence, findings: s.findings, charts: s.charts, stats: s.stats, exportedAt: new Date().toISOString() });
});
app.get('/api/research/:id/events', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND', message: 'nope' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: hello\ndata: {"id":"${s.id}","state":"${s.state}"}\n\n`);
  for (const ev of s.events) res.write(`id: ${ev.seq}\nevent: research\ndata: ${JSON.stringify(ev)}\n\n`);
  const timer = setInterval(() => {
    const events = s.events;
    const last = parseInt(req.headers['last-event-id'] || '0', 10) || 0;
    // stream any new events
    for (const ev of events) if (ev.seq > last && !sent.has(ev.seq)) { sent.add(ev.seq); res.write(`id: ${ev.seq}\nevent: research\ndata: ${JSON.stringify(ev)}\n\n`); }
    res.write(`: hb\n\n`);
    if (['completed', 'cancelled', 'failed'].includes(s.state)) { clearInterval(timer); res.end(); }
  }, 400);
  const sent = new Set(s.events.map(e => e.seq));
  req.on('close', () => clearInterval(timer));
});
app.get('/api/research/:id/export.md', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.report) return res.status(409).json({ error: 'NO_REPORT', message: 'no report yet' });
  res.setHeader('Content-Type', 'text/markdown');
  res.send(`# ${s.report.title}\n\n(demo export)`);
});
app.delete('/api/research/:id', (req, res) => { sessions.delete(req.params.id); res.json({ ok: true }); });
app.post('/api/research/topics', (req, res) => {
  setTimeout(() => res.json({ topics: [
    { topic: 'Agentic AI in enterprise workflows', category: 'Technology', whyItMatters: 'Autonomous agents are moving from demos into production budgets.', researchQuestions: ['Which enterprises deploy agents in production?', 'What failure modes dominate?'], difficulty: 'Medium', dataAvailability: 'Medium', expectedDepth: 'Deep', impact: 'Very High', methodology: 'Vendor docs + industry surveys + case studies' },
    { topic: 'AI governance frameworks compared', category: 'Policy', whyItMatters: 'Compliance costs hinge on which framework becomes the de-facto baseline.', researchQuestions: ['How do EU/US/India frameworks differ?', 'What are the penalty regimes?'], difficulty: 'High', dataAvailability: 'High', expectedDepth: 'Deep', impact: 'Very High', methodology: 'Primary legal texts + regulator guidance' },
    { topic: 'AI in personalized education', category: 'Education', whyItMatters: 'Learning outcomes evidence is finally accumulating.', researchQuestions: ['What do RCTs show for AI tutors?'], difficulty: 'Medium', dataAvailability: 'High', expectedDepth: 'Standard', impact: 'High', methodology: 'Peer-reviewed studies + meta-analyses' },
  ] }), 600);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Demo research UI server: http://localhost:${PORT}`));
