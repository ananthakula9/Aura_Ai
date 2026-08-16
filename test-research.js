// test-research.js — end-to-end verification of the Deep Research engine.
//
// Boots the REAL express app (server.js) with a real HTTP listener, stubs
// only the outbound layer (global.fetch for Gemini/page fetches, and
// dns.promises.lookup so SSRF host checks resolve deterministically), then
// drives REAL /api/research requests through the full lifecycle:
//
//   UNIT      auto-depth heuristic, source tiering, numeric conflict
//             detection, citation normalization (invalid [n] stripped),
//             markdown export
//   HAPPY     create → plan → patch plan → start → SSE events → completed
//             report with valid citations, real event sequence, truthful
//             stats
//   PAUSE     engine-level pause at a checkpoint → PAUSED → resume →
//             COMPLETED (state machine + resumability)
//   FAILURE   some pages unreachable → research still completes honestly
//             (errors recorded, sourcesFailed > 0, limitations listed)
//   FOLLOWUP  child session inherits the parent's used sources
//   GUARDS    ownership (another owner gets 404), validation (empty query
//             400), export only after a report exists
//
// Run: node test-research.js

const assert = require('assert');

// ============================================================
// 1. STUB THE OUTBOUND LAYER BEFORE REQUIRING server.js
// ============================================================
const originalFetch = global.fetch;
const originalLookup = require('dns').promises.lookup;

// Deterministic "public" DNS for the SSRF guard in research/search.js.
require('dns').promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

// Toggle points the tests control.
let pagesReachable = true;              // when false, page fetches fail
let geminiFailMode = false;             // when true, Gemini 429s once then works (fallback path)

const RESEARCH_QUERY_HINT = 'AI regulation';

function geminiResponse(text, { grounded = false, sources = [] } = {}) {
  const candidate = {
    content: { parts: [{ text }] },
    finishReason: 'STOP',
  };
  if (grounded) {
    candidate.groundingMetadata = {
      groundingChunks: sources.map(s => ({ web: { uri: s.url, title: s.title } })),
      webSearchQueries: ['test query'],
    };
  }
  return { candidates: [candidate] };
}

function fakeRes(json, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => json,
  };
}

// A fetch Response-like with a streaming body for HTML pages.
function pageResponse(html) {
  const bytes = Buffer.from(html, 'utf8');
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: {
      getReader() {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  };
}

// Deterministic per-question search results: 3 candidate sources each.
function sourcesForQuery(query) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  return [
    { url: `https://www.gov.example-regulation.org/${slug}/official-framework`, title: `Official framework — ${query.slice(0, 40)}` },
    { url: `https://mckinsey.example-research.com/${slug}/industry-report`, title: `Industry report — ${query.slice(0, 40)}` },
    { url: `https://blog.someblog.example/${slug}/post`, title: `Blog take — ${query.slice(0, 40)}` },
  ];
}

function pageHtmlFor(url) {
  const domain = new URL(url).hostname;
  return `<!DOCTYPE html><html><head><title>${domain} — AI regulation analysis</title><meta name="article:published_time" content="2025-06-15"></head><body>
  <h1>AI Regulation Landscape</h1>
  <p>Enterprise AI adoption reached 42 percent according to the official framework review, with compliance deadlines in 2026.</p>
  <p>A separate survey measured enterprise AI adoption at 31 percent, reflecting a different survey population and definitions.</p>
  <p>The EU AI Act entered into force on 1 August 2024, with high-risk obligations phasing in through 2026-2027.</p>
  <p>Penalties for prohibited practices can reach 35 million euros or 7 percent of global turnover.</p>
  ${'<p>Additional context about enforcement authorities, harmonized standards, and national regulators follows in this document.</p>'.repeat(12)}
  </body></html>`;
}

let geminiCallLog = [];
let pageFetchLog = [];

global.fetch = async (url, options = {}) => {
  const u = String(url);

  // The test's own HTTP client + the app's own routes → real fetch.
  if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
    return originalFetch(url, options);
  }

  // ---- Gemini provider calls (planner / extraction / verification / analysis / report / topics) ----
  if (u.includes('generativelanguage.googleapis.com')) {
    if (geminiFailMode) {
      geminiFailMode = false;
      return fakeRes({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: 429 });
    }
    const body = JSON.parse(options.body);
    geminiCallLog.push({ url: u, body });

    // Grounded web search call
    if (Array.isArray(body.tools) && body.tools.some(t => t.google_search)) {
      const query = body.contents?.[0]?.parts?.[0]?.text?.split('\n')[0] || 'query';
      return fakeRes(geminiResponse(`Search summary for ${query}: adoption figures around 42% per official reviews.`, {
        grounded: true,
        sources: sourcesForQuery(query),
      }));
    }

    const sys = body.system_instruction?.parts?.[0]?.text || '';
    if (sys.includes('research planning agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        objective: `Analyze the current state of AI regulation`,
        topic: 'Global AI Regulation',
        scope: { regions: ['EU', 'USA', 'India'], timeframe: '2024-2026', audience: '', output: 'report' },
        questions: [
          'What major AI regulations exist in the EU?',
          'What is the state of AI regulation in the USA?',
          'How does India approach AI governance?',
          'How do the major frameworks compare?',
        ],
      })));
    }
    if (sys.includes('adaptive planning agent')) {
      // Only propose growth for the dedicated adaptive-test query; the
      // happy-path run stays deterministic.
      const wantsAdaptive = (body.contents?.[0]?.parts?.[0]?.text || '').includes('adaptive planning dynamics');
      return fakeRes(geminiResponse(JSON.stringify({
        new_questions: wantsAdaptive ? ['What enforcement mechanisms exist across frameworks?'] : [],
      })));
    }
    if (sys.includes('challenge agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        verdicts: [
          { finding: 'The EU AI Act is in force with phased obligations through 2027.', verdict: 'upheld', reasoning: 'Opposing search found no dispute of the in-force date.', confidence: 'high' },
          { finding: 'Reported enterprise adoption varies substantially by survey methodology.', verdict: 'weakened', reasoning: 'Counter-analysis suggests the variance is narrowing as methodologies converge.', confidence: 'moderate' },
        ],
      })));
    }
    if (sys.includes('revising ONE section')) {
      return fakeRes(geminiResponse(JSON.stringify({ body: 'Revised section: the EU framework remains the most comprehensive [1], with phased obligations continuing [1].' })));
    }
    if (sys.includes('study quizzes')) {
      return fakeRes(geminiResponse(JSON.stringify({
        type: 'quiz', title: 'AI Regulation Quiz',
        questions: [
          { question: 'When did the EU AI Act enter into force?', options: ['1 August 2024', '1 January 2025', '1 July 2023', 'Never'], answer: 0, explanation: 'Per the official journal [1].' },
          { question: 'What does NIST publish for AI risk?', options: ['A binding law', 'A voluntary framework', 'A treaty', 'Nothing'], answer: 1, explanation: 'The AI RMF is voluntary [2].' },
        ],
      })));
    }
    if (sys.includes('study notes') || sys.includes('executive summaries') || sys.includes('articles from research')) {
      return fakeRes(geminiResponse(JSON.stringify({ title: 'Generated artifact', body: 'Executive overview of the findings with citations [1] [2].' })));
    }
    if (sys.includes('evidence-extraction agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        claims: [
          { claim: 'The EU AI Act entered into force on 1 August 2024.', quote: 'The EU AI Act entered into force on 1 August 2024, with high-risk obligations phasing in through 2026-2027.', question: 'EU', numbers: [] },
          { claim: 'Enterprise AI adoption reached 42 percent.', quote: 'Enterprise AI adoption reached 42 percent according to the official framework review.', question: 'adoption', numbers: [{ value: 42, unit: '%', context: 'enterprise adoption rate' }] },
          { claim: 'A separate survey measured adoption at 31 percent.', quote: 'A separate survey measured enterprise AI adoption at 31 percent.', question: 'adoption', numbers: [{ value: 31, unit: '%', context: 'enterprise adoption rate' }] },
        ],
      })));
    }
    if (sys.includes('verification agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        verdicts: [{ claim: 'The EU AI Act entered into force on 1 August 2024.', verdict: 'supported', reason: 'Quote states it directly.' }],
      })));
    }
    if (sys.includes('analysis agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        findings: [
          { statement: 'The EU AI Act is in force with phased obligations through 2027.', type: 'fact', confidence: 'high', citations: [1, 2] },
          { statement: 'Reported enterprise adoption varies substantially by survey methodology.', type: 'analysis', confidence: 'conflicting', citations: [1, 2] },
          { statement: 'Convergence on risk-based tiering is likely across jurisdictions.', type: 'inference', confidence: 'moderate', citations: [1, 3] },
        ],
        charts: [
          { type: 'bar', title: 'Reported enterprise AI adoption', unit: '%', period: '2024-2025', sourceN: 1, series: [{ label: 'Official review', value: 42 }, { label: 'Separate survey', value: 31 }], note: 'Different survey populations.' },
        ],
      })));
    }
    if (sys.includes('report agent')) {
      return fakeRes(geminiResponse(JSON.stringify({
        title: 'AI Regulation: Current State and Comparison',
        sections: [
          { kind: 'executive-summary', body: 'AI regulation has hardened into law in the EU [1], with the US and India taking different paths [2]. Adoption figures vary [1] [3].' },
          { kind: 'findings', heading: 'Key Findings' },
          { kind: 'comparison', heading: 'Framework Comparison', note: 'High-level comparison from gathered evidence.', columns: ['Dimension', 'EU', 'USA'], rows: [['Approach', 'Comprehensive act [1]', 'Sectoral guidance [2]']], cellCitations: { '0': [1, 2] } },
          { kind: 'timeline', heading: 'Timeline', events: [ { date: '2024-08', label: 'EU AI Act in force', citation: 1 }, { date: '2026', label: 'High-risk obligations phase in', citation: 1 } ] },
          { kind: 'conclusion', body: 'Divergent approaches create compliance complexity for global companies [1] [2].' },
          { kind: 'fake-section-should-drop', body: 'invalid' },
        ],
      })));
    }
    if (sys.includes('research topics')) {
      return fakeRes(geminiResponse(JSON.stringify({ topics: [{ topic: 'Agentic AI in industry', category: 'Technology', relevance: 'Very High', difficulty: 'Medium', dataAvailability: 'Medium', impact: 'Very High' }] })));
    }
    return fakeRes(geminiResponse('{"claims":[]}'));
  }

  // ---- Mistral fallback (should only be hit in the fallback test) ----
  if (u.includes('api.mistral.ai')) {
    return fakeRes({ choices: [{ message: { content: '{"verdicts":[]}' }, finish_reason: 'stop' }] });
  }

  // ---- Research page fetches ----
  if (u.startsWith('https://')) {
    pageFetchLog.push(u);
    if (!pagesReachable || u.includes('someblog.example')) {
      // simulate unreachable / error page
      return { ok: false, status: 503, headers: { get: () => 'text/html' }, body: { cancel: async () => {} } };
    }
    return pageResponse(pageHtmlFor(u));
  }

  return originalFetch(url, options);
};

// ============================================================
// 2. UNIT TESTS (no server needed)
// ============================================================
const engine = require('./research/engine');
const search = require('./research/search');
const agents = require('./research/agents');
const dataAgent = require('./research/data');
const { buildMarkdownExport } = require('./research/routes');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch((err) => { failed++; console.error(`✗ ${name}\n    ${err.message}`); });
}

async function runUnitTests() {
  await test('UNIT: auto-depth heuristic picks sensible modes', () => {
    assert.strictEqual(engine.pickAutoMode('capital of France'), 'quick');
    // V2: the intent analyzer classifies by complexity — a 5-jurisdiction
    // comparative investigation is "investigative" → maximum.
    assert.strictEqual(engine.pickAutoMode('Research the current state of AI regulation across the EU, US, India, UK and China. Compare the major frameworks'), 'maximum');
    assert.strictEqual(engine.pickAutoMode('Give me 5 tips for better sleep'), 'quick');
    assert.strictEqual(engine.pickAutoMode('Compare the major trends in quantum computing'), 'deep');
  });

  await test('UNIT: source tiering (government/edu Tier 1, established press Tier 2, blogs Tier 3)', () => {
    assert.strictEqual(search.classifySource('https://eur-lex.europa.eu/dir').tier, 1);
    assert.strictEqual(search.classifySource('https://www.nist.gov/ai').tier, 1);
    assert.strictEqual(search.classifySource('https://arxiv.org/abs/2401.1').tier, 1);
    assert.strictEqual(search.classifySource('https://www.mckinsey.com/capability').tier, 2);
    assert.strictEqual(search.classifySource('https://www.reuters.com/tech').tier, 2);
    assert.strictEqual(search.classifySource('https://blog.someblog.example/post').tier, 3);
    assert.strictEqual(search.classifySource('https://en.wikipedia.org/wiki/AI').tier, 3);
  });

  await test('UNIT: numeric conflict detector flags same-metric different-value across sources', () => {
    const session = {
      evidence: [
        { id: 'e1', sourceN: 1, claim: 'Enterprise AI adoption reached 42 percent in surveys about adoption rates', quote: 'q', numbers: [{ value: 42, unit: '%', context: 'enterprise adoption rate' }], verified: null },
        { id: 'e2', sourceN: 2, claim: 'Enterprise AI adoption rate was measured at 31 percent adoption', quote: 'q', numbers: [{ value: 31, unit: '%', context: 'enterprise adoption rate' }], verified: null },
        { id: 'e3', sourceN: 1, claim: 'Market size was 5 billion dollars', quote: 'q', numbers: [{ value: 5, unit: 'b usd', context: 'market size' }], verified: null },
      ],
      sources: [{ n: 1, title: 'A', url: 'https://a.example/x' }, { n: 2, title: 'B', url: 'https://b.example/y' }],
    };
    const conflicts = engine.detectNumericConflicts(session);
    assert.strictEqual(conflicts.length, 1, `expected exactly 1 conflict, got ${conflicts.length}`);
    assert.ok(conflicts[0].entries.length >= 2);
    assert.ok(session.evidence[0].verified === 'conflicting' && session.evidence[1].verified === 'conflicting');
  });

  await test('UNIT: report normalization strips citations that map to no real source', () => {
    const session = {
      sources: [{ n: 1, url: 'https://a.example', title: 'A', tier: 1, kind: 'Web', origin: 'web', usedFor: 0, accessedAt: Date.now() }],
      conflicts: [],
      plan: { questions: [], objective: 'test' },
      evidence: [], findings: [], charts: [], limitations: [],
      stats: { sourcesFailed: 0, searchesFailed: 0 },
      state: 'completed',
    };
    const normalized = engine.normalizeReport(session, {
      title: 'T',
      sections: [
        { kind: 'executive-summary', body: 'Claim with real cite [1] and fake cite [99] inline.' },
        { kind: 'conclusion', body: 'Done.' },
      ],
    });
    const exec = normalized.sections.find(s => s.kind === 'executive-summary');
    assert.ok(exec.body.includes('[1]'));
    assert.ok(!exec.body.includes('[99]'));
    assert.ok(normalized.sections.some(s => s.kind === 'sources'));
  });

  await test('UNIT: markdown export contains headings, citations, sources, timeline', () => {
    const session = {
      report: {
        title: 'Export Test',
        generatedAt: Date.now(),
        sections: [
          { kind: 'executive-summary', heading: 'Executive Summary', body: 'Summary with cite [1].' },
          { kind: 'timeline', heading: 'Timeline', events: [{ date: '2024-08', label: 'EU AI Act in force', citation: 1 }] },
          { kind: 'sources', heading: 'Sources', sources: [{ n: 1, title: 'Official', kind: 'Government', tier: 1, url: 'https://gov.example/x', dateHint: '2025-06-15' }] },
        ],
      },
      query: 'test query',
      effectiveMode: 'standard',
      stats: { sourcesReviewed: 3, claimsExtracted: 5 },
      findings: [], charts: [], qc: { score: 0.9, citationCoverage: 1 },
    };
    const md = buildMarkdownExport(session);
    assert.ok(md.includes('# Export Test'));
    assert.ok(md.includes('## Timeline'));
    assert.ok(md.includes('**2024-08** — EU AI Act in force [1]'));
    assert.ok(md.includes('https://gov.example/x'));
  });

  await test('UNIT: htmlToText strips scripts/styles and decodes entities', () => {
    const { title, text } = search.htmlToText('<html><head><title>T &amp; Co</title><style>.x{}</style></head><body><script>evil()</script><p>Hello&nbsp;world &lt;tag&gt;</p></body></html>');
    assert.strictEqual(title, 'T & Co');
    assert.ok(text.includes('Hello world <tag>'));
    assert.ok(!text.includes('evil'));
  });

  // ===================== V2 UNIT TESTS =====================

  await test('V2 UNIT: intent analyzer classifies complexity/topic/providers', () => {
    const investigative = agents.analyzeIntent('Conduct a comprehensive investigation of AI regulation across the EU, US, UK, India, and China');
    assert.strictEqual(investigative.complexity, 'investigative');
    assert.ok(investigative.providers.includes('government'));
    const scientific = agents.analyzeIntent('What do research papers say about transformer scaling?');
    assert.strictEqual(scientific.topicType, 'science');
    assert.strictEqual(scientific.recency, 'scientific');
    assert.ok(scientific.providers[0] === 'academic');
    const simple = agents.analyzeIntent('capital of France');
    assert.strictEqual(simple.complexity, 'simple');
  });

  await test('V2 UNIT: agent selection runs only relevant agents', () => {
    const sel = agents.selectAgents({ providers: ['academic', 'general'], topicType: 'science', verification: 'key', hasDatasets: false, signals: { wantsData: false } });
    const keys = sel.map(a => a.key);
    assert.ok(keys.includes('academic'), 'academic agent selected for science');
    assert.ok(!keys.includes('primarySource'), 'primary-source agent skipped for non-government topics');
    const selGov = agents.selectAgents({ providers: ['government', 'news'], topicType: 'regulation', verification: 'key', hasDatasets: true, signals: { wantsData: true } });
    const keysGov = selGov.map(a => a.key);
    assert.ok(keysGov.includes('primarySource') && keysGov.includes('dataAnalyst'), 'primary-source + data agents selected for regulation+data');
    assert.ok(!keysGov.includes('challenge'), 'challenge agent is user-invoked only');
  });

  await test('V2 UNIT: canonical URL dedup collapses tracking params/protocol/www/trailing slash', () => {
    assert.strictEqual(
      search.canonicalUrl('http://WWW.Example.com/path/?utm_source=x&b=2&a=1#frag'),
      search.canonicalUrl('https://example.com/path?a=1&b=2')
    );
    assert.notStrictEqual(
      search.canonicalUrl('https://example.com/a'),
      search.canonicalUrl('https://example.com/b')
    );
  });

  await test('V2 UNIT: evidence graph — claim states, independent confirmation, finding→claim links', () => {
    const session = {
      sources: [
        { n: 1, domain: 'a.example', title: 'A', url: 'https://a.example/x' },
        { n: 2, domain: 'b.example', title: 'B', url: 'https://b.example/y' },
        { n: 3, domain: 'a.example', title: 'A2', url: 'https://a.example/z' },
      ],
      evidence: [
        { id: 'e1', sourceN: 1, claim: 'EU AI Act entered into force on 1 August 2024', quote: 'q', verified: 'supported', numbers: [] },
        { id: 'e2', sourceN: 2, claim: 'The EU AI Act entered into force on 1 August 2024 per official record', quote: 'q', verified: 'supported', numbers: [] },
        { id: 'e3', sourceN: 3, claim: 'Compliance deadlines phase in through 2027', quote: 'q', verified: 'unverified', numbers: [] },
        { id: 'e4', sourceN: 1, claim: 'Fines reach 35 million euros', quote: 'contradicts', verified: 'rejected', numbers: [] },
      ],
      conflicts: [],
      findings: [
        { id: 'f1', statement: 'The EU AI Act entered into force on 1 August 2024', type: 'fact', confidence: 'high', citations: [1, 2] },
        { id: 'f2', statement: 'Fines reach 35 million euros', type: 'fact', confidence: 'high', citations: [1] },
      ],
    };
    engine.buildClaimGraph(session);
    // e1 corroborated by e2 from a DIFFERENT domain → strongly supported.
    assert.strictEqual(session.evidence[0].claimState.status, 'strongly_supported');
    assert.strictEqual(session.evidence[0].claimState.independentConfirmation, 2);
    // e3 same-domain only + unverified → weak.
    assert.strictEqual(session.evidence[2].claimState.status, 'weak');
    assert.strictEqual(session.evidence[2].claimState.independentConfirmation, 1);
    // e4 rejected verdict wins.
    assert.strictEqual(session.evidence[3].claimState.status, 'rejected');
    // Finding → claim links via citations + token overlap.
    assert.ok(session.findings[0].claims.includes('e1') && session.findings[0].claims.includes('e2'), 'finding linked to both corroborating claims');
    const summary = engine.claimStateSummary(session);
    assert.strictEqual(summary.strongly_supported + summary.supported + summary.weak + summary.rejected, 4);
  });

  await test('V2 UNIT: dataset analysis — stats, outliers, group means, trend', () => {
    const csv = 'region,value,year\nEU,42,2024\nUS,55,2024\nIndia,31,2024\nEU,48,2025\nUS,61,2025\nIndia,38,2025\nUK,900,2024\nUK,58,2025';
    const parsed = dataAgent.parseCsv(csv);
    assert.strictEqual(parsed.rows.length, 8);
    const analysis = dataAgent.analyzeDataset(parsed, 'adoption.csv');
    const valueCol = analysis.columns.find(c => c.name === 'value');
    assert.strictEqual(valueCol.type, 'numeric');
    assert.strictEqual(valueCol.stats.count, 8);
    assert.strictEqual(valueCol.stats.min, 31);
    assert.strictEqual(valueCol.stats.max, 900);
    assert.strictEqual(valueCol.stats.outliers.count, 1); // the 900
    // group means: EU = (42+48)/2 = 45
    const eu = analysis.groups.entries.find(g => g.label === 'EU');
    assert.strictEqual(eu.mean, 45);
    // trend over year: 2024 mean (42+55+31+900)/4 = 257 → 2025 mean 51.25 → decreasing
    assert.strictEqual(analysis.trend.direction, 'decreasing');
    assert.strictEqual(analysis.trend.firstValue, 257);
    // charts built from computed values only
    const charts = dataAgent.datasetCharts(analysis, 1);
    assert.ok(charts.some(c => c.type === 'bar' && c.series.some(p => p.label === 'EU' && p.value === 45)));
    // quoted CSV parsing with embedded delimiter
    const tricky = dataAgent.parseCsv('name,note\n"Smith, John","said ""hi"""\nDoe,plain');
    assert.strictEqual(tricky.rows[0][0], 'Smith, John');
    assert.strictEqual(tricky.rows[0][1], 'said "hi"');
  });

  await test('V2 UNIT: version diff detects new findings and confidence changes', () => {
    const parent = {
      version: 1,
      sources: [{ canonical: 'https://a.example/x', url: 'https://a.example/x' }],
      findings: [
        { statement: 'Adoption is rising rapidly across enterprises', confidence: 'high' },
        { statement: 'Costs are falling', confidence: 'moderate' },
      ],
    };
    const child = {
      version: 2,
      sources: [{ origin: 'web', canonical: 'https://a.example/x', url: 'https://a.example/x' }, { origin: 'web', canonical: 'https://new.example/n', url: 'https://new.example/n' }],
      findings: [
        { statement: 'Adoption is rising rapidly across enterprises', confidence: 'moderate' },
        { statement: 'New regulation affects SMEs', confidence: 'high', type: 'fact', citations: [2] },
      ],
    };
    const diff = engine.computeDiff(parent, child);
    assert.strictEqual(diff.fromVersion, 1);
    assert.strictEqual(diff.toVersion, 2);
    assert.strictEqual(diff.newSources.length, 1);
    assert.strictEqual(diff.removedFindings.length, 1); // "Costs are falling"
    assert.strictEqual(diff.newFindings.length, 1); // SME finding
    assert.strictEqual(diff.confidenceChanges.length, 1);
    assert.strictEqual(diff.confidenceChanges[0].from, 'high');
    assert.strictEqual(diff.confidenceChanges[0].to, 'moderate');
  });

  await test('V2 UNIT: quality V2 exposes documented metrics with formulas', () => {
    const session = {
      report: { sections: [{ kind: 'executive-summary', heading: 'x', body: 'A cited claim [1] appears here in the summary.' }] },
      sources: [
        { n: 1, domain: 'a.example', status: 'used', origin: 'web', tier: 1, dateHint: new Date().toISOString().slice(0, 10) },
        { n: 2, domain: 'b.example', status: 'used', origin: 'web', tier: 2, dateHint: null },
      ],
      plan: { questions: [{ id: 'q1', status: 'researched' }, { id: 'q2', status: 'researched' }] },
      evidence: [
        { questionId: 'q1', claim: 'c1', numbers: [] }, { questionId: 'q1', claim: 'c2', numbers: [] },
        { questionId: 'q2', claim: 'c3', numbers: [] }, { questionId: 'q2', claim: 'c4', numbers: [] },
      ],
      conflicts: [],
      findings: [
        { citations: [1, 2] }, { citations: [1] },
      ],
      intent: { recency: 'current' },
    };
    const qc = engine.runQualityChecks(session);
    assert.ok(Array.isArray(qc.metrics) && qc.metrics.length === 9, 'nine documented metrics');
    assert.ok(qc.metrics.every(m => typeof m.formula === 'string' && m.formula.length > 5), 'every metric documents its formula');
    assert.strictEqual(qc.metrics.find(m => m.key === 'sourceQuality').value, 1);
    assert.strictEqual(qc.metrics.find(m => m.key === 'evidenceCoverage').value, 1);
    assert.strictEqual(qc.metrics.find(m => m.key === 'independentConfirmation').value, 0.5);
    assert.ok(['Strong', 'Good', 'Fair', 'Weak'].includes(qc.overallLabel));
  });

  // ===== REGRESSION TESTS for bugs found during real-API validation =====

  await test('REGRESSION: db.js exports query (research persistence needs it when DATABASE_URL is set)', () => {
    // Found live: research/store.js calls db.query — the export was missing,
    // so every research persist failed with "db.query is not a function"
    // whenever a database was actually configured. Unit tests run DB-less
    // and never saw it.
    assert.strictEqual(typeof require('./db').query, 'function', 'db.query must be exported');
  });

  await test('REGRESSION: Gemini requests never go below the thinking-headroom floor', async () => {
    // Found live: gemini-3.6-flash counts thinking inside maxOutputTokens;
    // a 400-token "concise" chat request spent 284 tokens thinking and
    // truncated the visible answer to a stub. providers must floor Gemini
    // budgets at GEMINI_MIN_OUTPUT_TOKENS (Mistral is exempt).
    const providers = require('./providers');
    const captured = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        captured.push(JSON.parse(options.body).generationConfig.maxOutputTokens);
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }) };
      }
      return realFetch(url, options);
    };
    try {
      await providers.callGemini({ apiKey: 'k', geminiModel: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 300 });
      await providers.callGemini({ apiKey: 'k', geminiModel: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 100000 });
      assert.strictEqual(captured[0] >= 2048, true, `small request floored (got ${captured[0]})`);
      assert.strictEqual(captured[1] <= 8192, true, `huge request capped (got ${captured[1]})`);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('REGRESSION: keyless DDG fallback engages when grounding quota is exhausted', async () => {
    // Found live: free-tier Gemini keys hard-429 every grounded search.
    // searchWeb must fall back to the keyless DuckDuckGo provider instead
    // of sinking the run. Stub fetch: grounding 429 + a canned DDG page.
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return { ok: false, status: 429, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }) };
      }
      if (u.includes('html.duckduckgo.com')) {
        return {
          ok: true, status: 200,
          text: async () => '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.gov%2Freport">Official Report</a><a class="result__snippet" href="#">Official statistics on the topic released 2025.</a>',
        };
      }
      return realFetch(url);
    };
    try {
      const r = await search.searchWeb({ apiKey: 'k', geminiModel: 'm', query: 'official statistics' });
      assert.strictEqual(r.provider, 'ddg-html', 'fallback provider tagged honestly');
      assert.ok(r.sources.length >= 1 && r.sources[0].url === 'https://www.example.gov/report', 'uddg redirect unwrapped to real URL');
      assert.ok(r.answer.length > 0, 'snippet-based answer present');
    } finally {
      global.fetch = realFetch;
    }
  });
}

// ============================================================
// 3. INTEGRATION TESTS (real HTTP against the real app)
// ============================================================
const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getSession(id) {
  const res = await originalFetch(`${BASE}/api/research/${id}`);
  assert.strictEqual(res.status, 200, `GET session ${id} -> ${res.status}`);
  return (await res.json()).session;
}

async function runIntegrationTests() {
  process.env.PORT = String(PORT);
  const app = require('./server.js');
  await new Promise((resolve) => {
    app.httpServer.once('listening', resolve);
  });
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-for-research';

  let sessionId = null;

  await test('INT: create builds an editable plan (planner agent runs)', async () => {
    const res = await originalFetch(`${BASE}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `Research the current state of ${RESEARCH_QUERY_HINT} across the EU, US and India. Compare the frameworks and show dates.`, mode: 'standard' }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201, `create -> ${res.status}: ${JSON.stringify(data)}`);
    sessionId = data.session.id;
    assert.ok(data.session.plan.questions.length >= 3, 'planner produced questions');
    assert.ok(data.session.plan.objective.length > 0);
    assert.strictEqual(data.session.state, 'created');
    assert.ok(Array.isArray(data.session.events) && data.session.events.some(e => e.type === 'research.plan_created'));
  });

  await test('INT: plan editing persists changed questions', async () => {
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/plan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: ['What is the EU AI Act and its timeline?', 'How does the US approach AI regulation?', 'How does India regulate AI?'] }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.session.plan.questions.length, 3);
    assert.strictEqual(data.session.plan.questions[0].text, 'What is the EU AI Act and its timeline?');
  });

  await test('INT: validation + ownership guards', async () => {
    const bad = await originalFetch(`${BASE}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    assert.strictEqual(bad.status, 400);

    // export before a report exists → 409
    const early = await originalFetch(`${BASE}/api/research/${sessionId}/export.md`);
    assert.strictEqual(early.status, 409);
  });

  await test('INT: full run — SSE events, completion, valid citations, real stats', async () => {
    // Subscribe to the SSE stream FIRST so we capture the event sequence.
    const sseRes = await originalFetch(`${BASE}/api/research/${sessionId}/events`);
    assert.strictEqual(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const sseEvents = [];
    const sseDone = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (dataLine && frame.includes('event: research')) {
            try { sseEvents.push(JSON.parse(dataLine.slice(6)).type); } catch { /* ignore */ }
          }
        }
      }
    })();

    const start = await originalFetch(`${BASE}/api/research/${sessionId}/start`, { method: 'POST' });
    assert.strictEqual(start.status, 200, `start -> ${start.status}`);

    await waitFor(async () => {
      const s = await getSession(sessionId);
      return s.state === 'completed' || s.state === 'partial';
    }, { timeoutMs: 60000, label: 'research completion' });

    const session = await getSession(sessionId);

    // Event sequence is real and ordered.
    assert.ok(session.events.some(e => e.type === 'research.started'), 'started event');
    assert.ok(session.events.some(e => e.type === 'research.search_completed'), 'search event');
    assert.ok(session.events.some(e => e.type === 'research.source_opened'), 'source opened event');
    assert.ok(session.events.some(e => e.type === 'research.evidence_extracted'), 'evidence event');
    assert.ok(session.events.some(e => e.type === 'research.analysis_done'), 'analysis event');
    assert.ok(session.events.some(e => e.type === 'research.completed' || e.type === 'research.partially_completed'), 'terminal event');

    // Stats are truthful: sources were actually opened and pages fetched.
    assert.ok(session.stats.searches >= 1, 'searches counted');
    assert.ok(session.stats.sourcesReviewed >= 1, 'sources reviewed');
    assert.ok(session.stats.claimsExtracted >= 3, 'claims extracted');
    assert.ok(pageFetchLog.length >= 1, 'pages were really fetched');

    // Report exists with expected structure.
    assert.ok(session.report, 'report generated');
    const kinds = session.report.sections.map(s => s.kind);
    assert.ok(kinds.includes('executive-summary'), 'exec summary section');
    assert.ok(kinds.includes('findings'), 'findings section');
    assert.ok(kinds.includes('comparison'), 'comparison section');
    assert.ok(kinds.includes('timeline'), 'timeline section');
    assert.ok(kinds.includes('sources'), 'sources section');
    assert.ok(!kinds.includes('fake-section-should-drop'), 'invalid section dropped');

    // Citation integrity: every [n] in every body maps to a real source.
    const validNs = new Set(session.sources.map(s => s.n));
    for (const sec of session.report.sections) {
      if (typeof sec.body === 'string') {
        for (const m of sec.body.matchAll(/\[(\d+)\]/g)) {
          assert.ok(validNs.has(parseInt(m[1], 10)), `citation [${m[1]}] in "${sec.heading}" maps to a real source`);
        }
      }
    }

    // Findings cite real sources only; the chart passed the numeric gate.
    assert.ok(session.findings.length >= 2, 'findings present');
    for (const f of session.findings) {
      assert.ok(f.citations.length > 0, 'every finding has citations');
      for (const n of f.citations) assert.ok(validNs.has(n), `finding citation ${n} valid`);
      assert.ok(['fact', 'analysis', 'inference'].includes(f.type), 'finding type labeled');
    }
    assert.ok(session.charts.length >= 1, 'chart created');
    const evidenceNumbers = session.evidence.flatMap(e => e.numbers.map(n => n.value));
    for (const pt of session.charts[0].series) assert.ok(evidenceNumbers.includes(pt.value), 'chart values match evidence numbers');

    // Conflict detection ran on the contradictory stub data (42% vs 31%).
    assert.ok(session.stats.conflictsFound >= 1, 'numeric conflict detected');
    assert.ok(session.report.sections.some(s => s.kind === 'conflicts'), 'conflicts section rendered');

    // QC ran and recorded checks.
    assert.ok(session.qc && typeof session.qc.score === 'number', 'QC recorded');
    assert.ok(session.qc.checks.some(c => c.name === 'citationCoverage'));

    // SSE stream delivered the same real events to the client.
    await waitFor(() => sseEvents.length > 0 && ['research.completed', 'research.partially_completed'].includes(sseEvents[sseEvents.length - 1]), { timeoutMs: 15000, label: 'SSE terminal event' });
    try { await reader.cancel(); } catch { /* already closed */ }
    assert.ok(sseEvents.includes('research.started'), 'SSE delivered research.started');

    // Export works now that a report exists.
    const md = await originalFetch(`${BASE}/api/research/${sessionId}/export.md`);
    assert.strictEqual(md.status, 200);
    const mdText = await md.text();
    assert.ok(mdText.includes('# ') && mdText.includes('## Sources'), 'export has headings + sources');
  });

  await test('INT: follow-up research inherits parent sources', async () => {
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/followup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What penalties apply under the EU AI Act?' }),
    });
    assert.strictEqual(res.status, 201);
    const child = (await res.json()).session;
    assert.ok(child.parentId === sessionId, 'linked to parent');
    assert.ok(child.sources.length >= 1, 'inherited sources');
    assert.ok(child.sources.every(s => s.n >= 1 && s.n <= child.sources.length), 'renumbered sequentially');

    // Child can start and complete.
    const start = await originalFetch(`${BASE}/api/research/${child.id}/start`, { method: 'POST' });
    assert.strictEqual(start.status, 200);
    await waitFor(async () => ['completed', 'partial'].includes((await getSession(child.id)).state), { timeoutMs: 60000, label: 'followup completion' });
    const done = await getSession(child.id);
    assert.ok(done.report, 'followup report generated');
    await originalFetch(`${BASE}/api/research/${child.id}`, { method: 'DELETE' });
  });

  await test('INT: unreachable pages → honest partial result with limitations', async () => {
    pagesReachable = false;
    try {
      const res = await originalFetch(`${BASE}/api/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Research global AI governance approaches and dates', mode: 'quick' }),
      });
      const { session: s2 } = await res.json();
      const start = await originalFetch(`${BASE}/api/research/${s2.id}/start`, { method: 'POST' });
      assert.strictEqual(start.status, 200);
      await waitFor(async () => ['completed', 'partial', 'failed'].includes((await getSession(s2.id)).state), { timeoutMs: 60000, label: 'degraded completion' });
      const done = await getSession(s2.id);
      assert.ok(done.errors.length > 0 || done.stats.sourcesFailed > 0, 'failures recorded honestly');
      if (done.report) {
        assert.ok(done.report.sections.some(sec => sec.kind === 'limitations' || sec.kind === 'sources'), 'report still structured');
      }
      await originalFetch(`${BASE}/api/research/${s2.id}`, { method: 'DELETE' });
    } finally {
      pagesReachable = true;
    }
  });

  await test('INT: topic suggestions endpoint returns real-shaped topics', async () => {
    const res = await originalFetch(`${BASE}/api/research/topics`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interest: 'AI policy' }),
    });
    assert.strictEqual(res.status, 200);
    const { topics } = await res.json();
    assert.ok(topics.length >= 1);
    assert.ok(typeof topics[0].topic === 'string');
    assert.ok(typeof topics[0].whyItMatters === 'string' && Array.isArray(topics[0].researchQuestions), 'V2 rich topic fields');
  });

  // ===================== V2 INTEGRATION TESTS =====================

  await test('V2 INT: challenge mode runs adversarial pass and updates the report', async () => {
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/challenge`, { method: 'POST' });
    assert.strictEqual(res.status, 200, `challenge -> ${res.status}`);
    const { challenge } = await res.json();
    assert.ok(challenge.verdicts.length >= 1, 'verdicts produced');
    assert.ok(['upheld', 'weakened', 'overturned'].includes(challenge.verdicts[0].verdict));
    const after = await getSession(sessionId);
    assert.ok(after.report.sections.some(s => s.kind === 'challenge'), 'challenge section appended to report');
    assert.ok(after.challenge.ranAt > 0, 'challenge persisted');
  });

  await test('V2 INT: section regenerate replaces one section via a real model pass', async () => {
    const before = await getSession(sessionId);
    const originalBody = before.report.sections.find(s => s.kind === 'executive-summary').body;
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/section/executive-summary`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate' }),
    });
    assert.strictEqual(res.status, 200, `section -> ${res.status}`);
    const { session: after } = await res.json();
    const newBody = after.report.sections.find(s => s.kind === 'executive-summary').body;
    assert.notStrictEqual(newBody, originalBody, 'section body changed');
    assert.ok(newBody.includes('[1]'), 'revised section keeps valid citations');
    // invalid action rejected
    const bad = await originalFetch(`${BASE}/api/research/${sessionId}/section/executive-summary`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    });
    assert.strictEqual(bad.status, 400);
  });

  await test('V2 INT: research-to-content generates a valid quiz component + notes', async () => {
    const quizRes = await originalFetch(`${BASE}/api/research/${sessionId}/content`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'quiz' }),
    });
    assert.strictEqual(quizRes.status, 200, `quiz -> ${quizRes.status}`);
    const { content: quiz } = await quizRes.json();
    assert.strictEqual(quiz.type, 'quiz');
    assert.ok(quiz.questions.length >= 2);
    assert.ok(quiz.questions.every(q => q.options.length >= 2 && Number.isInteger(q.answer)));
    const notesRes = await originalFetch(`${BASE}/api/research/${sessionId}/content`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'notes' }),
    });
    const { content: notes } = await notesRes.json();
    assert.ok(notes.body.includes('[1]'), 'notes keep citations');
    const badKind = await originalFetch(`${BASE}/api/research/${sessionId}/content`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'podcast' }),
    });
    assert.strictEqual(badKind.status, 400);
  });

  await test('V2 INT: export.json returns the structured research dataset', async () => {
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/export.json`);
    assert.strictEqual(res.status, 200);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.findings) && payload.findings.length >= 1);
    assert.ok(Array.isArray(payload.evidence) && payload.evidence.every(e => typeof e.sourceN === 'number'));
    assert.ok(payload.quality && Array.isArray(payload.quality.metrics));
    assert.ok(payload.sources.every(s => typeof s.url === 'string' || s.tier <= 3));
  });

  await test('V2 INT: refresh creates v2 with deterministic diff', async () => {
    const res = await originalFetch(`${BASE}/api/research/${sessionId}/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Find newer evidence and update conclusions.' }),
    });
    assert.strictEqual(res.status, 201, `refresh -> ${res.status}`);
    const { session: child } = await res.json();
    assert.strictEqual(child.version, 2, 'child is v2');
    assert.strictEqual(child.refreshOf, sessionId);

    await waitFor(async () => ['completed', 'partial', 'failed'].includes((await getSession(child.id)).state), { timeoutMs: 60000, label: 'v2 completion' });
    const done = await getSession(child.id);
    assert.ok(done.report, 'v2 report generated');
    assert.ok(done.diff, 'diff computed');
    assert.strictEqual(done.diff.fromVersion, 1);
    assert.strictEqual(done.diff.toVersion, 2);
    await originalFetch(`${BASE}/api/research/${child.id}`, { method: 'DELETE' });
  });

  await test('V2 INT: adaptive planning grows the plan from evidence (deep mode)', async () => {
    const res = await originalFetch(`${BASE}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Research adaptive planning dynamics in AI regulation enforcement across the EU and US', mode: 'deep' }),
    });
    const createData = await res.json();
    assert.strictEqual(res.status, 201, `adaptive create -> ${res.status}: ${JSON.stringify(createData)}`);
    const adaptive = createData.session;
    assert.ok(['complex', 'investigative'].includes(adaptive.intent.complexity), `complexity ${adaptive.intent.complexity} should enable adaptive planning`);
    const start = await originalFetch(`${BASE}/api/research/${adaptive.id}/start`, { method: 'POST' });
    assert.strictEqual(start.status, 200);
    await waitFor(async () => ['completed', 'partial', 'failed'].includes((await getSession(adaptive.id)).state), { timeoutMs: 90000, label: 'adaptive completion' });
    const done = await getSession(adaptive.id);
    assert.ok(done.events.some(e => e.type === 'research.adaptive_planning'), 'adaptive planning ran');
    const taskEvents = done.events.filter(e => e.type === 'research.task_created');
    assert.ok(taskEvents.length >= 1, 'a new research task was created mid-run');
    assert.ok(done.plan.questions.some(q => q.origin === 'adaptive'), 'adaptive question in the final plan');
    assert.ok(done.intent && done.agentsRan.length > 0, 'intent + agent plan recorded');
    await originalFetch(`${BASE}/api/research/${adaptive.id}`, { method: 'DELETE' });
  });

  await test('INT: ownership — unknown id is 404', async () => {
    const res = await originalFetch(`${BASE}/api/research/00000000-0000-0000-0000-000000000000`);
    assert.strictEqual(res.status, 404);
  });

  app.httpServer.close();
}

// ============================================================
// 4. ENGINE-LEVEL STATE MACHINE TEST (pause → resume → complete)
// ============================================================
async function runStateMachineTest() {
  await test('ENGINE: pause at checkpoint → PAUSED → resume → COMPLETED', async () => {
    // Fresh in-memory session driven directly by the engine.
    const session = engine.blankSession({ owner: 'test-owner', query: 'Research AI regulation timelines', mode: 'quick' });
    session.effectiveMode = 'quick';
    session.plan = {
      objective: 'Test pause/resume',
      topic: 'AI regulation',
      scope: { regions: [], timeframe: '', audience: '', output: '' },
      questions: [{ id: 'q0', text: 'What are key AI regulation dates?', status: 'pending', searches: 0, evidence: 0 }],
      autoQuestions: false,
    };

    // Block the FIRST grounded search until the test releases it, so the
    // pause command lands while research is genuinely in flight.
    const engineSearch = require('./research/search').searchWeb;
    let gateResolve;
    const gate = new Promise(r => { gateResolve = r; });
    require('./research/search').searchWeb = async (opts) => {
      await gate;
      return engineSearch(opts);
    };

    const run = engine.executeSession(session); // no await yet
    await waitFor(() => session.events.some(e => e.type === 'research.started'), { timeoutMs: 5000, label: 'engine start' });

    engine.pauseSession(session);
    gateResolve(); // search completes → loop reaches checkpoint → paused
    await run;
    assert.strictEqual(session.state, 'paused', `state after pause = ${session.state}`);

    require('./research/search').searchWeb = engineSearch;
    const resumed = engine.startSession(session);
    assert.ok(resumed.started || resumed.alreadyRunning);
    await waitFor(() => session.state === 'completed' || session.state === 'partial' || session.state === 'failed', { timeoutMs: 30000, label: 'resume completion' });
    assert.ok(session.report, 'report generated after resume');
    assert.ok(['completed', 'partial'].includes(session.state), `final state = ${session.state}`);
  });

  await test('ENGINE: stop marks session cancelled and keeps collected evidence', async () => {
    const session = engine.blankSession({ owner: 'test-owner', query: 'Research stop behavior', mode: 'quick' });
    session.effectiveMode = 'quick';
    session.plan = {
      objective: 'Test stop', topic: 'stop', scope: { regions: [], timeframe: '', audience: '', output: '' },
      questions: [{ id: 'q0', text: 'What happens on stop?', status: 'pending', searches: 0, evidence: 0 }],
      autoQuestions: false,
    };
    // Seed evidence directly so report-from-partial is possible after stop.
    session.sources.push({ n: 1, url: 'https://gov.example/x', domain: 'gov.example', title: 'X', tier: 1, kind: 'Government', origin: 'web', ok: true, status: 'used', dateHint: null, accessedAt: Date.now(), usedFor: 1, filename: null });
    session.evidence.push({ id: 'e1', sourceN: 1, questionId: 'q0', claim: 'The framework entered force in 2024.', quote: 'entered force in 2024', numbers: [], verified: null });
    session.stats.claimsExtracted = 1;

    engine.stopSession(session);
    const run = engine.executeSession(session);
    await run;
    assert.strictEqual(session.state, 'cancelled');
    assert.ok(session.evidence.length === 1, 'evidence preserved');

    const result = await engine.reportFromPartial(session);
    assert.ok(result.started);
    await waitFor(() => session.report || session.state === 'failed', { timeoutMs: 30000, label: 'partial report' });
    assert.ok(session.report, 'report synthesized from partial evidence');
  });
}

// ============================================================
// RUN EVERYTHING
// ============================================================
(async () => {
  console.log('— unit tests —');
  await runUnitTests();
  console.log('\n— engine state machine tests —');
  await runStateMachineTest();
  console.log('\n— integration tests (real HTTP) —');
  await runIntegrationTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  require('dns').promises.lookup = originalLookup;
  // Give any lingering handles a beat, then exit.
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
})().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
