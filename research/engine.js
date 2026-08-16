// Aura AI — research/engine.js
// The Deep Research orchestrator. One module owns the full research state
// machine and every "agent" phase, driving REAL work through the existing
// provider layer (providers.js / models.js) and the web-access layer
// (search.js):
//
//   createSession()  planner agent — decomposes the request into an
//                    editable research plan (synchronous, 1 model call)
//   start()          discovery + reading + evidence-extraction agents —
//                    iterative web research per question with budgets,
//                    dedup, caching, retries, cancellation checkpoints
//   verify()         verification + contradiction agents — deterministic
//                    numeric conflict detection + model cross-checking
//   analyze()        analysis agent — findings (FACT/ANALYSIS/INFERENCE)
//                    with confidence labels + chart specs from real data
//   report()         report agent — sectioned report with [n] citations
//                    tied to real sources, then a deterministic quality-
//                    control pass (citation coverage, numeric consistency,
//                    completeness) with one revision round if needed
//
// Every observable state transition emits a research.* event; the activity
// UI is driven exclusively by these real events. Nothing is faked: failed
// searches/fetches are recorded as errors, unfinished questions surface as
// limitations, and citations that don't map to a real source are stripped.

const crypto = require('crypto');
const models = require('../models');
const providers = require('../providers');
const search = require('./search');
const agents = require('./agents');
const dataAgent = require('./data');

// ---- structured observability (V2): one line per phase, session-scoped,
// no user content — enough to debug runs from the logs alone. ----
function log(session, phase, fields = {}) {
  const extras = typeof fields === 'string' ? fields
    : Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[research ${session.id.slice(0, 8)} v${session.version || 1}] ${phase}${extras ? ' ' + extras : ''}`);
}

// ============================================================
// MODE BUDGETS
// ============================================================
const MODES = {
  quick: {
    label: 'Quick', maxQuestions: 3, searches: 2, sourcesPerSearch: 2,
    maxSources: 6, passes: 1, verify: false, gapAnalysis: false,
    charts: false, reportDepth: 'brief', description: 'Few searches, small report, fast.',
  },
  standard: {
    label: 'Standard', maxQuestions: 5, searches: 5, sourcesPerSearch: 3,
    maxSources: 12, passes: 1, verify: 'key', gapAnalysis: false,
    charts: true, reportDepth: 'normal', description: 'Multiple sources, cross-checking, structured findings.',
  },
  deep: {
    label: 'Deep', maxQuestions: 8, searches: 10, sourcesPerSearch: 3,
    maxSources: 20, passes: 2, verify: 'key', gapAnalysis: true,
    charts: true, reportDepth: 'thorough', description: 'Planning, multiple passes, verification, conflicts, charts.',
  },
  maximum: {
    label: 'Maximum', maxQuestions: 12, searches: 16, sourcesPerSearch: 4,
    maxSources: 30, passes: 2, verify: 'all', gapAnalysis: true,
    charts: true, reportDepth: 'comprehensive', description: 'Parallel branches, large evidence sets, full verification.',
  },
};

// Heuristic auto-depth, V2: the deterministic Intent Analyzer classifies
// the request (simple/moderate/complex/investigative) and complexity maps
// directly to a mode. Kept as a thin wrapper so existing callers/tests of
// pickAutoMode keep working.
function pickAutoMode(query) {
  const intent = agents.analyzeIntent(query);
  return agents.COMPLEXITY_CONFIG[intent.complexity].mode;
}

// ============================================================
// SESSION SHAPE + EVENT BUS
// ============================================================
const EventEmitter = require('events');

function newId() { return crypto.randomUUID(); }

function blankSession({ owner, query, mode, parentId, attachments }) {
  const requested = MODES[mode] ? mode : 'auto';
  return {
    id: newId(),
    owner,
    parentId: parentId || null,
    query: String(query || '').slice(0, 2000),
    mode: requested,               // what the user asked for ('auto' allowed)
    effectiveMode: null,           // resolved on creation
    state: 'created',              // created|planning|researching|verifying|analyzing|reporting|challenging|completed|paused|cancelled|failed|partial
    control: 'idle',               // idle|run|pause|stop  (engine writes run; commands set pause/stop)
    createdAt: Date.now(),
    updatedAt: Date.now(),

    // V2 — intent, selected agents, versioning, datasets, challenge, content
    intent: null,                  // {complexity, topicType, recency, providers, signals} from agents.analyzeIntent
    agentsRan: [],                 // [{key,label}] — what actually ran (mirrors events)
    version: 1,                    // research version (refresh creates v2, v3…)
    refreshOf: null,               // parent session id when this is a refresh
    refreshInstruction: null,      // e.g. "find newer evidence"
    diff: null,                    // deterministic diff vs the parent version
    datasets: [],                  // deterministic analyses of uploaded CSVs
    content: {},                   // generated artifacts: {quiz|notes|summary|article: {…, generatedAt}}
    challenge: null,               // adversarial challenge results (user-invoked)

    plan: {
      objective: '',
      topic: '',
      scope: { regions: [], timeframe: '', audience: '', output: '' },
      questions: [],               // [{id, text, status: pending|researched|not_found, searches:0, evidence:0, origin:'plan'|'adaptive'}]
      autoQuestions: true,
    },
    sources: [],                   // [{n, url, canonical, domain, title, tier, kind, ok, status, dateHint, accessedAt, usedFor, origin, dedupeOf}]
    evidence: [],                  // [{id, sourceN, questionId, claim, quote, numbers, verified, status, claimState}]
    conflicts: [],                 // [{id, subject, entries, explanation}]
    findings: [],                  // [{id, statement, type, confidence, citations, claims, questionId}]
    charts: [],                    // [{id, type, title, unit, period, sourceN, series, note, origin}]
    report: null,                  // normalized report object (see buildReport)
    qc: null,                      // quality-control result (V2: documented metric set)
    limitations: [],

    stats: { searches: 0, sourcesFound: 0, sourcesReviewed: 0, sourcesFailed: 0,
             claimsExtracted: 0, claimsVerified: 0, conflictsFound: 0, chartsCreated: 0,
             modelCalls: 0, searchesFailed: 0, duplicatesSkipped: 0, earlyStopped: false },
    events: [],                    // [{seq, t, type, data}]
    errors: [],                    // [{phase, message, at}]

    attachments: (attachments || []).map(a => ({
      filename: a.filename, mimeType: a.mimeType, category: a.category,
      dataBase64: a.buffer.toString('base64'),
    })),
  };
}

// Per-session live event bus — SSE subscribers attach here. The session's
// persisted `events` array is the durable replay log.
function emit(session, type, data = {}) {
  const event = { seq: session.events.length + 1, t: Date.now(), type, data };
  session.events.push(event);
  if (session.events.length > 800) session.events = session.events.slice(-800); // bound memory
  session.updatedAt = Date.now();
  busFor(session.id).emit('event', event);
  return event;
}

const buses = new Map();
function busFor(sessionId) {
  let bus = buses.get(sessionId);
  if (!bus) { bus = new EventEmitter(); bus.setMaxListeners(50); buses.set(sessionId, bus); }
  return bus;
}

// Checkpoint consulted between every unit of work: honors pause/stop.
function controlGate(session) {
  if (session.control === 'stop') return 'stop';
  if (session.control === 'pause') return 'pause';
  return 'run';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// MODEL CALLS (routed through the existing provider layer)
// ============================================================
class EngineAbort extends Error {
  constructor(reason) { super(`Research ${reason}`); this.name = 'EngineAbort'; this.reason = reason; }
}

// One JSON-producing model call with a strict budget guard. Text phases
// fall back Gemini→Mistral exactly like the chat route's strategy; search
// itself cannot fall back (Mistral has no grounding tool) and is handled
// in searchWebPhase, not here.
// One Gemini→Mistral attempt pair, with a bounded quota-backoff retry.
// Found during real-API validation: free/low-tier keys hit per-minute
// quota windows where BOTH providers can 429 at once; without a wait the
// whole research run failed instantly. One backoff round (15s, then a
// final 30s round only if the first retry also quota-failed) rides out
// the window without ever looping.
const QUOTA_BACKOFF_MS = [15_000, 30_000];

async function callModelJson({ session, systemPrompt, userPrompt, maxTokens = 3000, attachments = null, phase = 'model' }) {
  const geminiModel = models.MODEL_REGISTRY.find(m => m.geminiModel).geminiModel;
  const mistralModel = models.MODEL_REGISTRY.find(m => m.mistralModel)?.mistralModel;
  const apiKey = process.env.GEMINI_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY;
  const messages = [{ role: 'user', content: userPrompt }];

  const isQuota = (err) => err instanceof providers.ProviderError &&
    (err.httpStatus === 429 || String(err.providerErrorCode || '').includes('RESOURCE_EXHAUSTED'));

  let attempt = 0;
  while (true) {
    session.stats.modelCalls++;
    let text = '';
    let truncated = false;
    let lastErr = null;
    try {
      const result = await providers.callGemini({
        apiKey, geminiModel, systemPrompt, messages, maxTokens, attachments,
      });
      text = result.text;
      truncated = Boolean(result.truncated);
    } catch (geminiErr) {
      lastErr = geminiErr;
      if (providers.isRetryableFailure(geminiErr.httpStatus, geminiErr.providerErrorCode)) {
        if (attachments && attachments.length > 0) throw geminiErr; // no multimodal fallback, same rule as chat
        if (mistralKey && mistralModel) {
          try {
            const result = await providers.callMistral({ apiKey: mistralKey, mistralModel, systemPrompt, messages, maxTokens });
            text = result.text;
            truncated = truncated || Boolean(result.truncated);
            lastErr = null;
          } catch (mistralErr) { lastErr = mistralErr; }
        }
      }
      // Both providers quota-failed → wait out the window and retry (once
      // per backoff tier, then give up honestly).
      if (lastErr && isQuota(lastErr) && attempt < QUOTA_BACKOFF_MS.length) {
        const wait = QUOTA_BACKOFF_MS[attempt++];
        emit(session, 'research.provider_backoff', { phase, waitMs: wait, attempt });
        log(session, 'quota-backoff', `phase=${phase} wait=${wait}ms attempt=${attempt}`);
        await sleep(wait);
        continue;
      }
      if (lastErr) throw lastErr;
    }

    const parsed = extractJson(text);
    if (parsed) return parsed;
    // Truncated-to-unparseable: Gemini 3.x can spend the ENTIRE combined
    // budget on thinking, returning 200 with empty/partial visible text
    // (found live on section revisions with large current bodies). One
    // retry with a doubled budget beats failing the phase.
    if (truncated && maxTokens < 8000) {
      emit(session, 'research.provider_backoff', { phase, retryReason: 'truncated-output', newBudget: Math.min(maxTokens * 2, 8192) });
      log(session, 'truncated-retry', `phase=${phase} budget=${maxTokens}->${Math.min(maxTokens * 2, 8192)}`);
      maxTokens = Math.min(maxTokens * 2, 8192);
      continue;
    }
    throw new Error(`Model returned non-JSON output during ${phase}.`);
  }
}

// Same lenient JSON extraction used by components.js — first '{' to last '}'.
function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// ============================================================
// PLANNER AGENT (runs at session creation so the plan is editable)
// ============================================================
const PLANNER_SYSTEM = `You are the research planning agent for Aura AI Deep Research. Decompose the user's research request into a focused research plan. Respond with ONLY a JSON object, no prose, no code fences:

{
  "objective": "One-sentence research objective",
  "topic": "Short topic label",
  "scope": { "regions": ["..."], "timeframe": "e.g. 2023-present", "audience": "", "output": "report" },
  "questions": ["Research question 1", "Research question 2", "..."]
}

Rules:
- Questions must be independently answerable from public web sources and together cover the whole request.
- Split naturally by entity/jurisdiction/aspect when the request names several (e.g. one question per region).
- Include a comparison/synthesis question when the request asks to compare.
- 3-${MODES.maximum.maxQuestions} questions max, ordered by importance. Never number them — plain question strings.`;

async function runPlanner(session) {
  session.state = 'planning';
  emit(session, 'research.planning');

  // V2: deterministic Intent Analyzer runs first — it decides the agents,
  // providers and recency context before any model call. Recorded on the
  // session so the UI can explain "why these agents".
  session.intent = agents.analyzeIntent(session.query);
  if (session.mode === 'auto') {
    session.effectiveMode = agents.COMPLEXITY_CONFIG[session.intent.complexity].mode;
  }
  const budget = MODES[session.effectiveMode];
  log(session, 'intent', `complexity=${session.intent.complexity} topic=${session.intent.topicType} recency=${session.intent.recency} mode=${session.effectiveMode}`);

  // V2: uploaded CSVs are analyzed deterministically at creation time (the
  // Data Analyst Agent's non-model half). Results become first-class
  // evidence context for every later phase.
  for (const att of session.attachments) {
    if (/\.(csv|tsv)$/i.test(att.filename) || att.mimeType === 'text/csv') {
      const text = Buffer.from(att.dataBase64, 'base64').toString('utf8');
      const parsed = dataAgent.parseCsv(text);
      if (parsed.error) {
        session.errors.push({ phase: 'data', message: `Could not parse ${att.filename}: ${parsed.error}`, at: Date.now() });
      } else {
        const analysis = dataAgent.analyzeDataset(parsed, att.filename);
        session.datasets.push(analysis);
        emit(session, 'research.dataset_analyzed', { name: analysis.name, rows: analysis.rowCount, columns: analysis.columnCount });
        log(session, 'dataset', `file=${att.filename} rows=${analysis.rowCount}`);
      }
    }
  }

  let plan;
  try {
    plan = await callModelJson({
      session, phase: 'planning',
      systemPrompt: PLANNER_SYSTEM,
      userPrompt: `Research request: ${session.query}\n\nResearch depth: ${budget.label}. Produce at most ${budget.maxQuestions} research questions.\n\nDetected context — topic type: ${session.intent.topicType}; recency: ${session.intent.recency}; jurisdictions/entities: ${session.intent.signals.entities}; comparison requested: ${session.intent.signals.wantsCompare}; timeline requested: ${session.intent.signals.wantsTimeline}.\n${session.datasets.length ? `The user attached ${session.datasets.length} dataset(s): ${session.datasets.map(d => `${d.name} (${d.rowCount} rows)`).join(', ')}. Include a question about the uploaded data where relevant.\n` : ''}${session.intent.signals.wantsCompare ? 'Include comparison dimensions appropriate to what is being compared (countries: regulation/adoption/market/dates; companies: products/pricing/features/position; studies: methodology/sample/results).\n' : ''}`,
      maxTokens: 3000,
      attachments: sessionAttachmentsForModel(session),
    });
  } catch (err) {
    // Planner failure is fatal for a session that hasn't started — surface
    // honestly rather than inventing a plan.
    session.state = 'failed';
    session.errors.push({ phase: 'planning', message: err.message, at: Date.now() });
    emit(session, 'research.failed', { phase: 'planning', message: err.message });
    throw err;
  }

  const questions = (Array.isArray(plan.questions) ? plan.questions : [])
    .filter(q => typeof q === 'string' && q.trim())
    .slice(0, budget.maxQuestions)
    .map(q => ({ id: 'q' + Math.random().toString(36).slice(2, 8), text: q.trim(), status: 'pending', searches: 0, evidence: 0, origin: 'plan' }));

  session.plan = {
    objective: typeof plan.objective === 'string' && plan.objective.trim() ? plan.objective.trim() : session.query,
    topic: typeof plan.topic === 'string' && plan.topic.trim() ? plan.topic.trim() : session.query.slice(0, 80),
    scope: {
      regions: Array.isArray(plan.scope?.regions) ? plan.scope.regions.filter(r => typeof r === 'string').slice(0, 8) : [],
      timeframe: typeof plan.scope?.timeframe === 'string' ? plan.scope.timeframe.slice(0, 60) : '',
      audience: typeof plan.scope?.audience === 'string' ? plan.scope.audience.slice(0, 120) : '',
      output: typeof plan.scope?.output === 'string' ? plan.scope.output.slice(0, 120) : '',
    },
    questions: questions.length > 0 ? questions : [{ id: 'q0', text: session.query, status: 'pending', searches: 0, evidence: 0 }],
    autoQuestions: true,
  };

  // Attached files become Tier-"provided" sources immediately — they are
  // user-supplied evidence, distinct from web sources but first-class in
  // the evidence store.
  for (const att of session.attachments) {
    addSource(session, {
      url: null, domain: 'attached file', title: att.filename,
      tier: 1, kind: 'Your File', origin: 'file', ok: true, filename: att.filename,
    });
  }

  session.state = 'created';
  // Record which agents this session will run (V2 agent plan, surfaced in UI).
  session.agentsRan = agents.selectAgents({
    providers: session.intent.providers,
    topicType: session.intent.topicType,
    verification: budget.verify === false ? 'none' : String(budget.verify),
    hasDatasets: session.datasets.length > 0,
    signals: session.intent.signals,
    challenge: false,
  });
  emit(session, 'research.plan_created', { questions: session.plan.questions.length, objective: session.plan.objective, agents: session.agentsRan.map(a => a.key) });
  return session;
}

function sessionAttachmentsForModel(session) {
  if (!session.attachments.length) return null;
  return session.attachments.map(a => ({
    // Gemini inline_data accepts text/plain, not text/csv — the bytes are
    // identical, and the research engine parses the CSV itself (data.js).
    mimeType: a.mimeType === 'text/csv' ? 'text/plain' : a.mimeType,
    buffer: Buffer.from(a.dataBase64, 'base64'),
  }));
}

// ============================================================
// SOURCE + EVIDENCE STORE
// ============================================================
function addSource(session, { url, domain, title, tier, kind, origin, ok, status, dateHint, filename }) {
  // V2 dedup: exact URL, canonical URL equivalence (tracking params,
  // http/https, www, trailing slash), and syndicated-title near-duplicates
  // all collapse onto the first-seen source. Duplicates are counted
  // (stats.duplicatesSkipped) so "independent confirmation" is honest.
  const canonical = url ? search.canonicalUrl(url) : null;
  const normTitle = search.normalizeTitle(title);
  const existing = canonical
    ? session.sources.find(s => s.canonical === canonical || (s.url && search.canonicalUrl(s.url) === canonical))
    : null;
  const titleDup = canonical && normTitle && normTitle.length > 15
    ? session.sources.find(s => s.dedupeOf === null && search.normalizeTitle(s.title) === normTitle)
    : null;
  const dup = existing || titleDup;
  if (dup) {
    session.stats.duplicatesSkipped++;
    return dup;
  }
  const n = session.sources.length + 1;
  const source = {
    n, url: url || null,
    canonical: canonical || null,
    domain: domain || (url ? search.domainOf(url) : ''),
    title: (title || '').slice(0, 200) || (url || 'source'),
    tier: tier || 3, kind: kind || 'Web',
    origin: origin || 'web', ok: ok !== false,
    status: status || null,
    dateHint: dateHint || null, accessedAt: Date.now(),
    usedFor: 0, filename: filename || null, dedupeOf: null,
  };
  session.sources.push(source);
  session.stats.sourcesFound = session.sources.length;
  return source;
}

function addEvidence(session, sourceN, questionId, claim, quote, numbers) {
  const id = 'e' + Math.random().toString(36).slice(2, 9);
  session.evidence.push({
    id, sourceN, questionId,
    claim: String(claim || '').slice(0, 600),
    quote: String(quote || '').slice(0, 900),
    numbers: Array.isArray(numbers) ? numbers.slice(0, 8) : [],
    verified: null,
  });
  const src = session.sources.find(s => s.n === sourceN);
  if (src) src.usedFor++;
  const q = session.plan.questions.find(q => q.id === questionId);
  if (q) q.evidence = session.evidence.filter(e => e.questionId === questionId).length;
  session.stats.claimsExtracted = session.evidence.length;
  return id;
}

// ============================================================
// DISCOVERY + READING + EXTRACTION (the research loop)
// ============================================================
const EXTRACTION_SYSTEM = `You are the evidence-extraction agent for Aura AI Deep Research. You receive source text and research questions. Extract ONLY claims actually supported by the given text. Respond with ONLY a JSON object:

{
  "claims": [
    { "claim": "A concise factual claim in your own words", "quote": "THE EXACT supporting passage copied verbatim from the source text", "question": "which research question this answers (copy the question text)", "numbers": [{"value": 42, "unit": "%", "context": "adoption rate"}] }
  ]
}

Rules:
- Every quote must be copied EXACTLY from the source text (trim to the relevant sentence(s)). If you cannot quote it, do not include the claim.
- Extract numbers, dates, and named entities precisely as stated.
- 2-8 claims per source; only claims relevant to the research questions.
- No commentary, no analysis, no conclusions — evidence only.`;

// V2: which logical search provider handles this search — rotates through
// the intent's priority list so question #1 may hit Government while #2
// hits General Web, matching the topic's source-diversity needs.
function providerForSearch(session, index) {
  const providersList = session.intent?.providers?.length ? session.intent.providers : ['general'];
  return providersList[index % providersList.length];
}

async function searchOnce(session, query, questionId, searchIndex = 0) {
  const budget = MODES[session.effectiveMode];
  if (session.stats.searches >= budget.searches) return { answer: '', sources: [] };

  // V2 stop intelligence: marginal-utility check. If the last 3 searches
  // added no new evidence AND the core questions are answered, stop
  // searching (documented: newEvidencePerSearch history in session).
  session.searchHistory = session.searchHistory || [];
  if (session.searchHistory.length >= 3) {
    const recentYield = session.searchHistory.slice(-3).reduce((a, b) => a + b, 0);
    const coreAnswered = session.plan.questions.filter(q => q.origin === 'plan').every(q => q.status !== 'pending');
    if (recentYield === 0 && coreAnswered) {
      if (!session.stats.earlyStopped) {
        session.stats.earlyStopped = true;
        emit(session, 'research.early_stop', { reason: 'Additional searches stopped producing new evidence; core questions are answered.' });
        log(session, 'early-stop', 'yield=0 over last 3 searches');
      }
      return { answer: '', sources: [] };
    }
  }

  const provider = providerForSearch(session, searchIndex);
  let result;
  try {
    result = await search.searchWeb({
      apiKey: process.env.GEMINI_API_KEY,
      geminiModel: models.MODEL_REGISTRY.find(m => m.geminiModel).geminiModel,
      query, context: session.plan.objective, provider,
    });
  } catch (err) {
    session.stats.searchesFailed++;
    session.errors.push({ phase: 'search', message: `Search failed for "${query.slice(0, 60)}": ${err.message}`, at: Date.now() });
    emit(session, 'research.search_failed', { query: query.slice(0, 120), message: err.message });
    session.searchHistory.push(0);
    return { answer: '', sources: [] };
  }

  session.stats.searches++;
  const q = session.plan.questions.find(x => x.id === questionId);
  if (q) q.searches++;
  emit(session, 'research.search_completed', { query: query.slice(0, 120), found: result.sources.length, provider });

  // Register candidate sources (deduped by canonical URL + syndicated
  // title), keep search answer as evidence material tied to the grounded
  // chunks (marked origin so citations stay honest about what was actually
  // opened vs. grounded).
  for (const s of result.sources.slice(0, budget.sourcesPerSearch * 2)) {
    const { tier, kind } = search.classifySource(s.url);
    addSource(session, { url: s.url, title: s.title, tier, kind, origin: 'web', ok: null, status: 'candidate' });
  }
  if (result.answer && result.sources.length > 0) {
    const grounded = addSource(session, {
      url: result.sources[0].url,
      title: `Search synthesis — ${result.queries?.[0] || query.slice(0, 60)}`,
      tier: search.classifySource(result.sources[0].url).tier,
      kind: 'Search Result Synthesis',
      origin: 'grounded-answer', ok: true, status: 'used',
    });
    addEvidence(session, grounded.n, questionId, `Search summary: ${result.answer.slice(0, 500)}`, '(grounded search answer — see linked source)', []);
  }
  // Marginal-utility bookkeeping: researchQuestion records the evidence
  // delta for each search round (concurrency-safe — no shared slot).
  return result;
}

async function readAndExtractSource(session, source, question) {
  if (session.sources.filter(s => s.status === 'used').length >= MODES[session.effectiveMode].maxSources) return;

  if (source.origin === 'file') {
    const att = session.attachments.find(a => a.filename === source.filename);
    await extractFromText(session, source, `(file content attached: ${source.filename})`, null, question,
      att ? [{ mimeType: att.mimeType === 'text/csv' ? 'text/plain' : att.mimeType, buffer: Buffer.from(att.dataBase64, 'base64') }] : null);
    return;
  }
  if (!source.url) return;

  emit(session, 'research.source_opened', { url: source.url, title: source.title });
  const page = await search.fetchPageText(source.url);
  if (!page.ok) {
    source.ok = false; source.status = 'failed';
    session.stats.sourcesFailed++;
    session.errors.push({ phase: 'read', message: `Could not open ${source.url}: ${page.error}`, at: Date.now() });
    emit(session, 'research.source_failed', { url: source.url, error: page.error });
    return;
  }
  source.ok = true; source.status = 'used';
  if (page.dateHint) source.dateHint = page.dateHint;
  if (page.title && source.title === source.url) source.title = page.title;
  session.stats.sourcesReviewed = session.sources.filter(s => s.status === 'used' && s.origin !== 'grounded-answer').length;

  await extractFromText(session, source, page.text.slice(0, 45_000), page.finalUrl, question);
}

async function extractFromText(session, source, text, finalUrl, question, attachments = null) {
  const questionList = session.plan.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  try {
    const out = await callModelJson({
      session, phase: 'extraction',
      systemPrompt: EXTRACTION_SYSTEM,
      userPrompt: `RESEARCH QUESTIONS:\n${questionList}\n\nCURRENT FOCUS QUESTION: ${question.text}\n\nSOURCE: ${source.title}${finalUrl ? ` (${finalUrl})` : ''}\n\nSOURCE TEXT:\n"""\n${text}\n"""`,
      maxTokens: 6000,
      attachments,
    });
    const claims = Array.isArray(out.claims) ? out.claims : [];
    let added = 0;
    for (const c of claims) {
      if (!c || typeof c.claim !== 'string' || typeof c.quote !== 'string') continue;
      if (!c.claim.trim() || !c.quote.trim()) continue;
      const numbers = (Array.isArray(c.numbers) ? c.numbers : [])
        .filter(nb => nb && (typeof nb.value === 'number' || typeof nb.value === 'string' && /^-?\d[\d,.]*$/.test(nb.value)))
        .map(nb => ({
          value: typeof nb.value === 'number' ? nb.value : parseFloat(nb.value.replace(/,/g, '')),
          unit: String(nb.unit || '').slice(0, 20),
          context: String(nb.context || '').slice(0, 120),
        }));
      addEvidence(session, source.n, question.id, c.claim, c.quote, numbers);
      added++;
    }
    if (added > 0) emit(session, 'research.evidence_extracted', { source: source.n, title: source.title.slice(0, 80), claims: added });
  } catch (err) {
    session.errors.push({ phase: 'extraction', message: `Extraction failed for ${source.title.slice(0, 60)}: ${err.message}`, at: Date.now() });
  }
}

// Ranks a question's candidate sources: tier + relevance + context-aware
// recency (V2 profile from the intent analyzer — current topics reward
// fresh sources, historical topics reward established ones).
function pickSourcesToRead(session, question, limit) {
  const qWords = question.text.toLowerCase();
  const profile = session.intent?.recency || 'evergreen';
  return session.sources
    .filter(s => s.status === 'candidate' && s.origin === 'web')
    .map(s => ({ s, score: search.scoreCandidate(s, qWords, s.dateHint, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.s);
}

async function researchQuestion(session, question, searchIndex = 0) {
  const budget = MODES[session.effectiveMode];
  emit(session, 'research.question_started', { question: question.text });

  const claimsBefore = session.evidence.length;
  await searchOnce(session, question.text, question.id, searchIndex);
  if (controlGate(session) !== 'run') return;

  let toRead = pickSourcesToRead(session, question, budget.sourcesPerSearch);
  for (const src of toRead) {
    if (controlGate(session) !== 'run') return;
    await readAndExtractSource(session, src, question);
  }
  session.searchHistory = session.searchHistory || [];
  session.searchHistory.push(session.evidence.length - claimsBefore);

  // Iterative research: if the question still has thin evidence, refine
  // the query using what was found and search again (second pass).
  const substantiveEvidence = session.evidence.filter(e => e.questionId === question.id && !e.claim.startsWith('Search summary'));
  const hasEvidence = substantiveEvidence.length >= 2;
  if (!hasEvidence && budget.passes > 1 && session.stats.searches < budget.searches) {
    const refined = refineQuery(session, question);
    if (refined) {
      emit(session, 'research.refining', { question: question.text, refined: refined.slice(0, 120) });
      const before2 = session.evidence.length;
      await searchOnce(session, refined, question.id, searchIndex + 1);
      if (controlGate(session) !== 'run') return;
      toRead = pickSourcesToRead(session, question, budget.sourcesPerSearch);
      for (const src of toRead) {
        if (controlGate(session) !== 'run') return;
        await readAndExtractSource(session, src, question);
      }
      session.searchHistory.push(session.evidence.length - before2);
    }
  }

  const count = session.evidence.filter(e => e.questionId === question.id).length;
  question.status = count > 0 ? 'researched' : 'not_found';
  emit(session, 'research.question_done', { question: question.text, status: question.status, evidence: count });
}

// Deterministic query refinement: append scope/distinguishing terms rather
// than another model call (cost control).
function refineQuery(session, question) {
  const extras = [];
  const topicWord = session.plan.topic.split(/\s+/).slice(0, 3).join(' ');
  if (topicWord && !question.text.toLowerCase().includes(topicWord.toLowerCase())) extras.push(topicWord);
  const region = session.plan.scope.regions[0];
  if (region && !question.text.toLowerCase().includes(region.toLowerCase())) extras.push(region);
  if (extras.length === 0) return null;
  return `${question.text} ${extras.join(' ')} latest report statistics`.slice(0, 300);
}

// ============================================================
// GAP ANALYSIS (deep/maximum)
// ============================================================
async function runGapAnalysis(session) {
  const budget = MODES[session.effectiveMode];
  if (!budget.gapAnalysis) return;
  emit(session, 'research.gap_analysis');
  const gaps = session.plan.questions.filter(q => q.status !== 'researched');
  const followups = [];
  for (const q of gaps) {
    if (session.stats.searches >= budget.searches) break;
    const alt = alternativePhrasing(session, q);
    if (alt) followups.push({ q, alt });
  }
  for (const { q, alt } of followups.slice(0, 3)) {
    if (controlGate(session) !== 'run') return;
    emit(session, 'research.gap_identified', { question: q.text, alternative: alt.slice(0, 120) });
    await searchOnce(session, alt, q.id);
    const toRead = pickSourcesToRead(session, q, 2);
    for (const src of toRead) {
      if (controlGate(session) !== 'run') return;
      await readAndExtractSource(session, src, q);
    }
    const count = session.evidence.filter(e => e.questionId === q.id).length;
    if (count > 0) q.status = 'researched';
  }
}

function alternativePhrasing(session, q) {
  // Swap the question's lead verb for search-friendlier phrasing —
  // deterministic, no model call.
  const text = q.text
    .replace(/^what\b/i, 'overview of')
    .replace(/^how\b/i, 'explained')
    .replace(/^why\b/i, 'reasons for')
    .replace(/^which\b/i, 'list of')
    .replace(/\?$/, '');
  const scope = session.plan.scope.timeframe || '2025 2026';
  return `${text} ${scope} report data`.slice(0, 300);
}

// ============================================================
// ADAPTIVE PLANNING (V2) — the plan evolves during execution.
// After the first pass, the planner agent looks at the collected evidence
// and may propose up to 2 new subquestions ("an important unanswered
// question has emerged"). These become plan tasks with origin:'adaptive'
// and are researched like any other question.
// ============================================================
const ADAPTIVE_SYSTEM = `You are the adaptive planning agent for Aura AI Deep Research. You receive a research plan and the evidence collected so far. Decide whether an IMPORTANT unanswered question has emerged that the original plan misses. Respond with ONLY a JSON object:

{ "new_questions": ["..."] }

Rules:
- Propose at most 2 questions, ONLY if the evidence clearly reveals an important gap or a newly surfaced subtopic worth investigating.
- If the existing plan already covers everything, return {"new_questions": []}.
- Never rephrase existing questions. New questions only.`;

async function runAdaptivePlanning(session) {
  const budget = MODES[session.effectiveMode];
  const complexity = session.intent?.complexity || 'moderate';
  if (!agents.COMPLEXITY_CONFIG[complexity].adaptive) return;
  if (session.stats.searches >= budget.searches) return;

  emit(session, 'research.adaptive_planning');
  try {
    const evidenceListing = session.evidence.slice(0, 40).map(e => `- ${e.claim}`).join('\n');
    const out = await callModelJson({
      session, phase: 'adaptive-planning',
      systemPrompt: ADAPTIVE_SYSTEM,
      userPrompt: `RESEARCH REQUEST: ${session.query}\n\nCURRENT PLAN QUESTIONS:\n${session.plan.questions.map(q => `- ${q.text} [${q.status}]`).join('\n')}\n\nEVIDENCE COLLECTED:\n${evidenceListing || '(none)'}\n\nShould the plan grow?`,
      maxTokens: 2048,
    });
    const existing = new Set(session.plan.questions.map(q => q.text.toLowerCase()));
    const proposed = (Array.isArray(out.new_questions) ? out.new_questions : [])
      .filter(q => typeof q === 'string' && q.trim() && q.trim().length < 400)
      .filter(q => !existing.has(q.trim().toLowerCase()))
      .slice(0, 2);
    for (const text of proposed) {
      if (session.plan.questions.length >= budget.maxQuestions) break;
      const q = { id: 'qa' + Math.random().toString(36).slice(2, 8), text: text.trim(), status: 'pending', searches: 0, evidence: 0, origin: 'adaptive' };
      session.plan.questions.push(q);
      emit(session, 'research.task_created', { question: q.text, origin: 'adaptive', reason: 'Important unanswered question emerged from the evidence.' });
      log(session, 'adaptive-task', q.text.slice(0, 60));
    }
  } catch (err) {
    session.errors.push({ phase: 'adaptive-planning', message: err.message, at: Date.now() });
  }
}

// ============================================================
// PARALLEL QUESTION RUNNER (V2)
// Questions are independent → they run with bounded concurrency
// (1 for simple/quick, 2-3 for deeper modes). Budget checks and
// pause/stop checkpoints stay exact because JS is single-threaded:
// the search-cap check in searchOnce is atomic within a sync section.
// ============================================================
async function runQuestions(session, questions) {
  const complexity = session.intent?.complexity || 'moderate';
  const concurrency = Math.max(1, Math.min(agents.COMPLEXITY_CONFIG[complexity].concurrency, questions.length));
  let cursor = 0;
  async function worker(workerIndex) {
    while (true) {
      if (controlGate(session) !== 'run') return;
      const i = cursor++;
      if (i >= questions.length) return;
      await researchQuestion(session, questions[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
}

// ============================================================
// VERIFICATION + CONTRADICTION AGENTS
// ============================================================
// Extracts numeric assertions from evidence deterministically and flags
// two claims from DIFFERENT sources as a conflict candidate when they
// share enough context words but state different values.
function detectNumericConflicts(session) {
  const conflicts = [];
  const numeric = [];
  for (const e of session.evidence) {
    for (const num of e.numbers) {
      if (typeof num.value !== 'number' || Number.isNaN(num.value)) continue;
      const words = new Set(`${e.claim} ${num.context || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
      numeric.push({ evidenceId: e.id, sourceN: e.sourceN, value: num.value, unit: (num.unit || '').toLowerCase(), words, claim: e.claim });
    }
  }
  for (let i = 0; i < numeric.length; i++) {
    for (let j = i + 1; j < numeric.length; j++) {
      const a = numeric[i], b = numeric[j];
      if (a.sourceN === b.sourceN) continue;
      if (Math.abs(a.value - b.value) < 1e-9) continue;
      if (a.unit !== b.unit) continue;
      let shared = 0;
      for (const w of a.words) if (b.words.has(w)) shared++;
      if (shared >= 3) {
        const srcA = session.sources.find(s => s.n === a.sourceN);
        const srcB = session.sources.find(s => s.n === b.sourceN);
        const evA = session.evidence.find(e => e.id === a.evidenceId);
        const evB = session.evidence.find(e => e.id === b.evidenceId);
        const subject = [...a.words].filter(w => b.words.has(w)).slice(0, 4).join(' ');
        const already = conflicts.some(c =>
          c.entries.some(en => en.sourceN === a.sourceN && en.value === a.value) &&
          c.entries.some(en => en.sourceN === b.sourceN && en.value === b.value));
        if (already) continue;
        conflicts.push({
          id: 'c' + Math.random().toString(36).slice(2, 8),
          subject: subject || 'reported figures',
          entries: [
            { sourceN: a.sourceN, value: a.value, unit: num_unit(a), quote: evA?.quote?.slice(0, 400) || a.claim, sourceTitle: srcA?.title, sourceUrl: srcA?.url },
            { sourceN: b.sourceN, value: b.value, unit: num_unit(b), quote: evB?.quote?.slice(0, 400) || b.claim, sourceTitle: srcB?.title, sourceUrl: srcB?.url },
          ],
          explanation: 'Sources report different figures for what appears to be the same metric. This usually reflects different survey populations, definitions, or time periods — treat both as reported and prefer the more authoritative/primary source for decisions.',
        });
        evA && (evA.verified = 'conflicting');
        evB && (evB.verified = 'conflicting');
      }
    }
  }
  return conflicts;

  function num_unit(x) { return x.unit; }
}

const VERIFY_SYSTEM = `You are the verification agent for Aura AI Deep Research. You receive key claims with their supporting evidence quotes and source titles. Cross-check each claim against its OWN evidence only — does the quote actually support the claim? Respond with ONLY a JSON object:

{ "verdicts": [ { "claim": "<the claim text>", "verdict": "supported" | "unverified" | "rejected", "reason": "one line why" } ] }

Rules:
- "supported" only when the quote plainly states the claim's substance.
- "unverified" when the quote is vague, partial, or about something else.
- "rejected" when the quote contradicts or clearly fails to support the claim.
- Never invent external knowledge to verify a claim.`;

async function runVerification(session) {
  const budget = MODES[session.effectiveMode];
  emit(session, 'research.verification_started');

  // Deterministic conflict detection first — always runs, no model needed.
  const conflicts = detectNumericConflicts(session);
  session.conflicts = conflicts;
  session.stats.conflictsFound = conflicts.length;
  for (const c of conflicts) emit(session, 'research.conflict_found', { subject: c.subject });

  // Model cross-check of key claims (statistic-bearing first).
  if (budget.verify !== false) {
    const pool = session.evidence
      .filter(e => e.verified !== 'conflicting' && !e.claim.startsWith('Search summary'))
      .sort((a, b) => (b.numbers.length - a.numbers.length) || (a.claim.length - b.claim.length));
    const key = budget.verify === 'all' ? pool : pool.filter(e => e.numbers.length > 0).slice(0, 12).concat(pool.slice(0, 4));
    const subset = [...new Set(key)].slice(0, budget.verify === 'all' ? 40 : 16);
    if (subset.length > 0) {
      try {
        const srcMap = new Map(session.sources.map(s => [s.n, s]));
        const listing = subset.map(e => `- CLAIM: ${e.claim}\n  QUOTE: ${e.quote}\n  SOURCE: [${e.sourceN}] ${srcMap.get(e.sourceN)?.title || ''}`).join('\n\n');
        const out = await callModelJson({
          session, phase: 'verification',
          systemPrompt: VERIFY_SYSTEM,
          userPrompt: `Verify each claim against its evidence:\n\n${listing}`,
          maxTokens: 3600,
        });
        const verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
        for (const v of verdicts) {
          if (!v || typeof v.claim !== 'string') continue;
          const ev = subset.find(e => e.claim === v.claim || e.claim.includes(v.claim.slice(0, 60)));
          if (ev && ['supported', 'unverified', 'rejected'].includes(v.verdict)) ev.verified = v.verdict;
        }
      } catch (err) {
        session.errors.push({ phase: 'verification', message: err.message, at: Date.now() });
      }
    }
    session.stats.claimsVerified = session.evidence.filter(e => e.verified === 'supported' || e.verified === 'unverified' || e.verified === 'conflicting').length;
  }
  emit(session, 'research.verification_done', {
    verified: session.stats.claimsVerified,
    conflicts: session.stats.conflictsFound,
  });
}

// ============================================================
// EVIDENCE GRAPH (V2)
// Deterministic relationship graph over the session's real entities:
//
//   SOURCE ──contains──► EVIDENCE ──supports──► FINDING
//        └────────────────── contradicts ──► EVIDENCE (conflict entries)
//
// Links are computed in code (no model): a finding links to the evidence
// whose source it cites AND whose claim text overlaps the finding's words.
// This is what makes Report → Finding → Claim → Evidence → Source fully
// traceable in the UI, and it is unit-testable.
// ============================================================
function tokenSet(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
}

function buildClaimGraph(session) {
  const srcByN = new Map(session.sources.map(s => [s.n, s]));
  const conflictSources = new Set();
  for (const c of session.conflicts) for (const en of c.entries) conflictSources.add(en.sourceN);

  // Claim-level state for every substantive piece of evidence.
  for (const ev of session.evidence) {
    if (ev.claim.startsWith('Search summary')) { ev.claimState = null; continue; }
    const src = srcByN.get(ev.sourceN);

    // Which OTHER evidence states essentially the same claim? (same source
    // excluded — corroboration must come from elsewhere)
    const myTokens = tokenSet(ev.claim);
    const corroborating = session.evidence.filter(other =>
      other !== ev && !other.claim.startsWith('Search summary') &&
      other.sourceN !== ev.sourceN && overlap(myTokens, tokenSet(other.claim)) >= 0.34);

    const supportingSources = new Set([ev.sourceN, ...corroborating.filter(o => o.verified !== 'rejected').map(o => o.sourceN)]);
    const independentDomains = new Set([...supportingSources].map(n => srcByN.get(n)?.domain).filter(Boolean));
    const contradicted = conflictSources.has(ev.sourceN) || ev.verified === 'conflicting';

    // Status ladder (documented): rejected beats everything; conflicting
    // next; then support strength by independent confirmation count.
    let status;
    if (ev.verified === 'rejected') status = 'rejected';
    else if (contradicted) status = 'conflicting';
    else if (ev.verified === 'unverified') status = 'weak';
    else if (independentDomains.size >= 2) status = 'strongly_supported';
    else if (ev.verified === 'supported' || supportingSources.size >= 1) status = 'supported';
    else status = 'unverified';

    ev.claimState = {
      status,
      supportingSources: [...supportingSources],
      independentConfirmation: independentDomains.size,
      contradictions: contradicted ? 1 : 0,
    };
  }

  // Findings → claim links (evidence cited by the finding's sources whose
  // claim overlaps the finding statement).
  for (const f of session.findings) {
    const fTokens = tokenSet(f.statement);
    f.claims = session.evidence
      .filter(ev => !ev.claim.startsWith('Search summary') && f.citations.includes(ev.sourceN))
      .filter(ev => overlap(fTokens, tokenSet(ev.claim)) >= 0.12)
      .slice(0, 8)
      .map(ev => ev.id);
  }
}

function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

// Summary counts for the UI's evidence panel.
function claimStateSummary(session) {
  const counts = { strongly_supported: 0, supported: 0, weak: 0, conflicting: 0, rejected: 0, unverified: 0 };
  for (const ev of session.evidence) {
    if (!ev.claimState) continue;
    counts[ev.claimState.status] = (counts[ev.claimState.status] || 0) + 1;
  }
  return counts;
}

// ============================================================
// ANALYSIS AGENT — findings with FACT/ANALYSIS/INFERENCE + charts
// ============================================================
const ANALYSIS_SYSTEM = `You are the analysis agent for Aura AI Deep Research. You receive verified evidence (claims + quotes + source numbers) for a research plan. Produce findings and, when the evidence contains real comparable numbers, chart specs. Respond with ONLY a JSON object:

{
  "findings": [
    { "statement": "A key finding grounded in the evidence", "type": "fact" | "analysis" | "inference", "confidence": "high" | "moderate" | "limited" | "conflicting", "citations": [1, 2] }
  ],
  "charts": [
    { "type": "bar" | "line" | "timeline", "title": "Chart title", "unit": "unit or empty", "period": "time period covered", "sourceN": 1, "series": [ { "label": "category/entity", "value": 12.5, "date": "2024-08" } ], "note": "caveat or empty" }
  ]
}

Rules:
- "fact": directly stated by cited evidence. "analysis": interpretation across multiple pieces of evidence. "inference": reasoned conclusion beyond the evidence — never present inference as fact.
- citations MUST be source numbers that appear in the evidence you used. Never cite a source you were not given.
- Charts ONLY from numbers actually present in the evidence — copy the values exactly. A timeline uses "date" fields. No chart if the data doesn't support one.
- 4-10 findings, most important first.`;

async function runAnalysis(session) {
  session.state = 'analyzing';
  emit(session, 'research.analysis_started');
  const budget = MODES[session.effectiveMode];

  const srcMap = new Map(session.sources.map(s => [s.n, s]));
  const evidenceListing = session.evidence
    .filter(e => !e.claim.startsWith('Search summary') || session.evidence.length < 4)
    .slice(0, budget.verify === 'all' ? 120 : 70)
    .map(e => `[${e.sourceN}] (${srcMap.get(e.sourceN)?.title || ''}) CLAIM: ${e.claim}${e.verified === 'conflicting' ? ' [CONFLICTING]' : e.verified === 'supported' ? ' [verified]' : ''}${e.numbers.length ? ` NUMBERS: ${e.numbers.map(n => `${n.value}${n.unit} (${n.context})`).join('; ')}` : ''}`)
    .join('\n');

  const conflictsListing = session.conflicts.map(c => `CONFLICT on "${c.subject}": [${c.entries[0].sourceN}] says ${c.entries[0].value}${c.entries[0].unit} vs [${c.entries[1].sourceN}] says ${c.entries[1].value}${c.entries[1].unit}`).join('\n');

  let out;
  try {
    out = await callModelJson({
      session, phase: 'analysis',
      systemPrompt: ANALYSIS_SYSTEM,
      userPrompt: `RESEARCH OBJECTIVE: ${session.plan.objective}\n\nQUESTIONS:\n${session.plan.questions.map(q => `- ${q.text} [${q.status}]`).join('\n')}\n\nEVIDENCE:\n${evidenceListing}\n\n${conflictsListing ? 'DETECTED CONFLICTS:\n' + conflictsListing + '\n' : ''}Produce findings (and charts only if real comparable numbers exist above).`,
      maxTokens: 8000,
    });
  } catch (err) {
    session.errors.push({ phase: 'analysis', message: err.message, at: Date.now() });
    out = { findings: [], charts: [] };
  }

  const validNs = new Set(session.sources.map(s => s.n));
  session.findings = (Array.isArray(out.findings) ? out.findings : [])
    .filter(f => f && typeof f.statement === 'string' && f.statement.trim())
    .map(f => ({
      id: 'f' + Math.random().toString(36).slice(2, 8),
      statement: f.statement.slice(0, 900),
      type: ['fact', 'analysis', 'inference'].includes(f.type) ? f.type : 'analysis',
      confidence: ['high', 'moderate', 'limited', 'conflicting'].includes(f.confidence) ? f.confidence : 'moderate',
      citations: (Array.isArray(f.citations) ? f.citations : []).filter(n => Number.isInteger(n) && validNs.has(n)).slice(0, 6),
      questionId: null,
    }))
    .filter(f => f.citations.length > 0); // a finding without a real citation is not a finding

  const evidenceNumbers = new Set(session.evidence.flatMap(e => e.numbers.map(n => n.value)));
  if (budget.charts) {
    session.charts = (Array.isArray(out.charts) ? out.charts : [])
      .filter(c => c && typeof c.title === 'string' && Array.isArray(c.series) && c.series.length >= 2)
      .map(c => ({
        id: 'ch' + Math.random().toString(36).slice(2, 8),
        type: ['bar', 'line', 'timeline'].includes(c.type) ? c.type : 'bar',
        title: c.title.slice(0, 160),
        unit: String(c.unit || '').slice(0, 30),
        period: String(c.period || '').slice(0, 60),
        sourceN: Number.isInteger(c.sourceN) && validNs.has(c.sourceN) ? c.sourceN : null,
        series: c.series
          .filter(pt => pt && typeof pt.label === 'string' && (typeof pt.value === 'number' || typeof pt.value === 'string' && /^-?\d[\d.,]*$/.test(pt.value)))
          .slice(0, 14)
          .map(pt => ({ label: pt.label.slice(0, 60), value: typeof pt.value === 'number' ? pt.value : parseFloat(String(pt.value).replace(/,/g, '')), date: typeof pt.date === 'string' ? pt.date.slice(0, 20) : null })),
        note: String(c.note || '').slice(0, 240),
      }))
      .filter(c => c.series.length >= 2)
      // Numeric consistency gate: every chart value must exist in evidence.
      .filter(c => c.series.every(pt => evidenceNumbers.has(pt.value)))
      .slice(0, 4);
    // V2: dataset charts come from the deterministic data analysis — real
    // computed aggregates from the user's uploaded CSVs, values never
    // re-typed by a model, so they bypass the evidence-number gate by
    // construction (their numbers ARE the computed statistics).
    if (session.datasets.length > 0) {
      for (const ds of session.datasets) {
        const fileSource = session.sources.find(s => s.origin === 'file' && s.filename === ds.name);
        for (const ch of dataAgent.datasetCharts(ds, fileSource?.n ?? null)) {
          if (ch.trendRef && ch.trendRef.samples) ch.series = ch.trendRef.samples;
          session.charts.push(ch);
        }
      }
    }
    session.stats.chartsCreated = session.charts.length;
    for (const ch of session.charts) emit(session, 'research.chart_created', { title: ch.title, type: ch.type, origin: ch.origin || 'evidence' });
  }

  // V2 evidence graph: claim states + finding→claim links.
  buildClaimGraph(session);
  emit(session, 'research.analysis_done', { findings: session.findings.length, charts: session.charts.length, claimStates: claimStateSummary(session) });
  log(session, 'analysis', `findings=${session.findings.length} charts=${session.charts.length}`);
}

// ============================================================
// REPORT AGENT + NORMALIZATION + QUALITY CONTROL
// ============================================================
const REPORT_SYSTEM = `You are the report agent for Aura AI Deep Research. Write a professional research report from the given findings and evidence. Respond with ONLY a JSON object:

{
  "title": "Report title",
  "sections": [
    { "kind": "executive-summary", "body": "markdown. Must cover: what was researched, why it matters, what was discovered (with [n] citations), implications." },
    { "kind": "background", "body": "markdown with [n] citations where claims appear" },
    { "kind": "landscape", "heading": "Current Landscape", "body": "markdown with [n] citations" },
    { "kind": "findings", "heading": "Key Findings" },
    { "kind": "comparison", "heading": "Comparison", "note": "intro sentence", "columns": ["Dimension", "A", "B"], "rows": [["row label", "cell", "cell"]], "cellCitations": { "0": [1,2] } },
    { "kind": "timeline", "heading": "Timeline", "events": [ { "date": "2024-03", "label": "What happened", "citation": 2 } ] },
    { "kind": "risks", "body": "markdown with [n] citations" },
    { "kind": "outlook", "body": "markdown with [n] citations" },
    { "kind": "conclusion", "body": "markdown" }
  ]
}

Rules:
- EVERY external fact in body text carries a [n] citation matching a source number you were given. Uncited external claims are forbidden.
- [n] must be the number of a source listed in SOURCES. Never invent numbers.
- Use only section kinds that fit this research; always include executive-summary, findings, conclusion.
- Comparison tables/timelines ONLY when the request compares things or involves dated events, and only from given evidence (cellCitations maps row index -> source numbers).
- Body is GitHub-flavored markdown (## subheads, bullets, bold). No title heading inside bodies.`;

async function runReport(session) {
  session.state = 'reporting';
  emit(session, 'research.report_started');
  const srcMap = new Map(session.sources.map(s => [s.n, s]));

  const sourcesListing = session.sources
    .filter(s => s.origin !== 'grounded-answer' || s.usedFor > 0)
    .map(s => `[${s.n}] ${s.title}${s.dateHint ? ` (${s.dateHint})` : ''} ${s.url || ''}`)
    .join('\n');
  const evidenceListing = session.evidence.slice(0, 80)
    .map(e => `[${e.sourceN}] ${e.claim}${e.verified === 'conflicting' ? ' [CONFLICTING]' : ''}`)
    .join('\n');
  const findingsListing = session.findings.map(f => `- (${f.type}/${f.confidence}${f.citations.length ? `, cites ${f.citations.join(',')}` : ''}) ${f.statement}`).join('\n');
  const conflictsListing = session.conflicts.map(c => `- ${c.subject}: [${c.entries[0].sourceN}] ${c.entries[0].value}${c.entries[0].unit} vs [${c.entries[1].sourceN}] ${c.entries[1].value}${c.entries[1].unit}`).join('\n');
  const wantsComparison = /compar|versus|\bvs\b|differ|across|each/i.test(session.query);
  const wantsTimeline = session.evidence.some(e => /\b(19|20)\d{2}\b/.test(e.claim)) && /timeline|dates|history|when|schedule|rollout|deadline/i.test(session.query + ' ' + session.plan.objective);

  let out;
  try {
    out = await callModelJson({
      session, phase: 'report',
      systemPrompt: REPORT_SYSTEM,
      userPrompt: `RESEARCH REQUEST: ${session.query}\nOBJECTIVE: ${session.plan.objective}\n\nSOURCES:\n${sourcesListing}\n\nFINDINGS:\n${findingsListing}\n\nEVIDENCE:\n${evidenceListing}\n\n${conflictsListing ? 'CONFLICTS:\n' + conflictsListing + '\n' : ''}Depth: ${MODES[session.effectiveMode].reportDepth}.${wantsComparison ? ' The request involves comparison — include a comparison section.' : ''}${wantsTimeline ? ' Include a timeline section.' : ''}`,
      maxTokens: 8000,
    });
  } catch (err) {
    session.errors.push({ phase: 'report', message: err.message, at: Date.now() });
    throw err; // a report failure fails the session honestly
  }

  session.report = normalizeReport(session, out);
  emit(session, 'research.report_ready', { title: session.report.title, sections: session.report.sections.length });

  // ---- quality-control pass (deterministic checks + one revision) ----
  emit(session, 'research.qc_started');
  session.qc = runQualityChecks(session);
  if (session.qc.citationCoverage < 0.7 && session.qc.citedSections > 0) {
    emit(session, 'research.qc_revision');
    try {
      const revised = await callModelJson({
        session, phase: 'report-revision',
        systemPrompt: REPORT_SYSTEM + `\n\nREVISION MODE: a previous draft had insufficient citation coverage (${Math.round(session.qc.citationCoverage * 100)}%). Rewrite keeping the same structure but adding [n] citations to every external claim, using only the given sources.`,
        userPrompt: `SOURCES:\n${sourcesListing}\n\nFINDINGS:\n${findingsListing}\n\nEVIDENCE:\n${evidenceListing}\n\nPREVIOUS DRAFT:\n${JSON.stringify(out).slice(0, 12000)}\n\nProduce the revised report.`,
        maxTokens: 8000,
      });
      const revisedReport = normalizeReport(session, revised);
      const revisedQc = runQualityChecks({ ...session, report: revisedReport });
      if (revisedQc.score > session.qc.score) { session.report = revisedReport; session.qc = revisedQc; }
    } catch { /* keep original draft; QC result stands */ }
  }
  emit(session, 'research.qc_done', { score: session.qc.score, coverage: session.qc.citationCoverage });

  // A run with failed searches (not just failed page opens) is also
  // partial — found during real-API validation, where a fully
  // search-throttled run still labeled itself "completed".
  const degraded = session.errors.length > 0 &&
    (session.stats.sourcesFailed > 0 || session.stats.searchesFailed > 0);
  session.state = degraded ? 'partial' : 'completed';
  emit(session, session.state === 'partial' ? 'research.partially_completed' : 'research.completed', {
    title: session.report.title,
    stats: { ...session.stats },
  });
}

// Deterministic report normalization: strip markdown-fence wrappers,
// validate every [n] citation against real sources (invalid ones are
// removed — never shown), drop malformed sections, and always append a
// generated sources section + limitations.
function normalizeReport(session, raw) {
  const validNs = new Set(session.sources.map(s => s.n));
  const stripBadCitations = (text) => String(text || '')
    .replace(/\[(\d+)\]/g, (m, d) => (validNs.has(parseInt(d, 10)) ? m : ''))
    .replace(/ ?\[\]/g, '');

  const sections = [];
  const rawSections = Array.isArray(raw?.sections) ? raw.sections : [];
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue;
    const kind = String(s.kind || '');
    if (kind === 'executive-summary') {
      const body = stripBadCitations(s.body).trim();
      if (body) sections.push({ kind, heading: 'Executive Summary', body });
    } else if (['background', 'landscape', 'risks', 'outlook', 'conclusion', 'methodology', 'recommendations', 'opportunities'].includes(kind)) {
      const body = stripBadCitations(s.body).trim();
      if (body) sections.push({ kind, heading: String(s.heading || defaultHeading(kind)).slice(0, 80), body });
    } else if (kind === 'findings') {
      sections.push({ kind, heading: String(s.heading || 'Key Findings').slice(0, 80) });
    } else if (kind === 'comparison') {
      const columns = Array.isArray(s.columns) ? s.columns.filter(c => typeof c === 'string').slice(0, 6) : [];
      const rows = Array.isArray(s.rows)
        ? s.rows.filter(r => Array.isArray(r)).slice(0, 20).map(r => r.map(c => stripBadCitations(String(c ?? '')).slice(0, 300)))
        : [];
      if (columns.length >= 2 && rows.length >= 1) {
        const cellCitations = {};
        const cc = s.cellCitations && typeof s.cellCitations === 'object' ? s.cellCitations : {};
        for (const [k, v] of Object.entries(cc)) {
          const ns = (Array.isArray(v) ? v : []).filter(n => Number.isInteger(n) && validNs.has(n)).slice(0, 3);
          if (ns.length) cellCitations[String(k)] = ns;
        }
        sections.push({ kind, heading: String(s.heading || 'Comparison').slice(0, 80), note: stripBadCitations(String(s.note || '')).slice(0, 300), columns, rows, cellCitations });
      }
    } else if (kind === 'timeline') {
      const events = (Array.isArray(s.events) ? s.events : [])
        .filter(ev => ev && typeof ev.date === 'string' && typeof ev.label === 'string')
        .slice(0, 15)
        .map(ev => ({
          date: ev.date.slice(0, 24),
          label: stripBadCitations(String(ev.label)).slice(0, 200),
          description: stripBadCitations(String(ev.description || '')).slice(0, 400),
          citation: Number.isInteger(ev.citation) && validNs.has(ev.citation) ? ev.citation : null,
        }));
      if (events.length >= 2) sections.push({ kind, heading: String(s.heading || 'Timeline').slice(0, 80), events });
    } else if (kind === 'challenge') {
      // V2: adversarial-challenge section survives re-normalization.
      if (s.challenge && Array.isArray(s.challenge.verdicts)) {
        sections.push({ kind, heading: String(s.heading || 'Adversarial Challenge').slice(0, 80), challenge: s.challenge });
      }
    }
  }

  if (!sections.some(s => s.kind === 'executive-summary')) {
    sections.unshift({ kind: 'executive-summary', heading: 'Executive Summary', body: session.plan.objective });
  }
  if (!sections.some(s => s.kind === 'findings')) sections.push({ kind: 'findings', heading: 'Key Findings' });
  if (!sections.some(s => s.kind === 'conclusion')) sections.push({ kind: 'conclusion', heading: 'Conclusion', body: '' });

  // Conflicts section — generated deterministically from real conflicts.
  if (session.conflicts.length > 0) {
    sections.push({ kind: 'conflicts', heading: 'Conflicting Evidence', conflicts: session.conflicts });
  }

  // Limitations — honest accounting of what didn't finish.
  const limitations = [];
  for (const q of session.plan.questions.filter(q => q.status === 'not_found')) {
    limitations.push(`No reliable evidence was found for: "${q.text}".`);
  }
  if (session.stats.searchesFailed > 0) limitations.push(`${session.stats.searchesFailed} search${session.stats.searchesFailed > 1 ? 'es' : ''} failed and ${session.stats.sourcesFailed} source${session.stats.sourcesFailed === 1 ? '' : 's'} could not be opened; the report uses the evidence that was successfully gathered.`);
  if (session.state === 'partial') limitations.push('Research partially completed — see the notes above.');
  session.limitations = limitations;
  if (limitations.length > 0) sections.push({ kind: 'limitations', heading: 'Limitations', items: limitations });

  // Sources section — always generated from the real source store.
  sections.push({ kind: 'sources', heading: 'Sources', sources: session.sources.filter(s => s.origin !== 'grounded-answer' || s.usedFor > 0) });

  return {
    title: String(raw?.title || session.plan.topic || 'Research Report').slice(0, 200),
    generatedAt: Date.now(),
    sections,
  };
}

function defaultHeading(kind) {
  return { background: 'Background', landscape: 'Current Landscape', risks: 'Risks', outlook: 'Future Outlook', conclusion: 'Conclusion', methodology: 'Methodology', recommendations: 'Recommendations', opportunities: 'Opportunities' }[kind] || 'Section';
}

// ============================================================
// QUALITY SCORING V2 — transparent, documented metrics.
// Every metric is deterministic with its formula stated inline; nothing is
// invented to look impressive. `checks` keeps the V1 pass/fail list (old
// tests + revision triggers depend on it); `metrics` adds the richer
// dashboard values with their calculation notes.
// ============================================================
function runQualityChecks(session) {
  const r = session.report;
  const bodySections = r.sections.filter(s => typeof s.body === 'string' && ['executive-summary', 'background', 'landscape', 'risks', 'outlook', 'conclusion', 'methodology', 'recommendations', 'opportunities'].includes(s.kind));
  const externalClaimRe = /\b(is|are|was|were|has|have|will|by|from|of|reported|according)\b/i;
  const sentenceRe = /[^.!?\n]+[.!?]?/g;

  // --- citation coverage: external-claim sentences carrying [n] / total ---
  let claimTotal = 0, claimCited = 0, citedSections = 0;
  for (const s of bodySections) {
    if (/\[\d+\]/.test(s.body)) citedSections++;
    const sentences = s.body.match(sentenceRe) || [];
    for (const sent of sentences) {
      const trimmed = sent.trim();
      if (trimmed.split(/\s+/).length < 7) continue;
      if (!externalClaimRe.test(trimmed)) continue;
      if (/^(note|caveat|this report|the report|limitations)/i.test(trimmed)) continue;
      claimTotal++;
      if (/\[\d+\]/.test(trimmed)) claimCited++;
    }
  }
  const citationCoverage = claimTotal === 0 ? 1 : claimCited / claimTotal;

  const usedSources = session.sources.filter(s => s.status === 'used' && s.origin !== 'grounded-answer');
  const evidenceNumbers = new Set(session.evidence.flatMap(e => e.numbers.map(n => n.value)));

  // --- numeric consistency: table/chart numbers must exist in evidence ---
  let numericConsistent = true;
  for (const c of (r.sections.filter(s => s.kind === 'comparison'))) {
    for (const row of c.rows) {
      for (const cell of row) {
        const nums = (String(cell).match(/-?\d[\d.,]*/g) || []).map(x => parseFloat(x.replace(/,/g, '')));
        for (const n of nums) {
          if (Math.abs(n) > 0 && !evidenceNumbers.has(n) && !session.evidence.some(e => e.claim.includes(String(n)))) {
            numericConsistent = false;
          }
        }
      }
    }
  }

  // --- source quality: share of used sources that are Tier 1/2 ---
  const tierOk = usedSources.filter(s => s.tier <= 2).length;
  const sourceQuality = usedSources.length === 0 ? 0 : tierOk / usedSources.length;

  // --- source diversity: distinct domains / used sources (1.0 = all different) ---
  const domains = new Set(usedSources.map(s => s.domain));
  const sourceDiversity = usedSources.length === 0 ? 0 : domains.size / usedSources.length;

  // --- evidence coverage: plan questions with ≥2 substantive evidence ---
  const answeredWell = session.plan.questions.filter(q =>
    session.evidence.filter(e => e.questionId === q.id && !e.claim.startsWith('Search summary')).length >= 2).length;
  const evidenceCoverage = session.plan.questions.length === 0 ? 1 : answeredWell / session.plan.questions.length;

  // --- recency: share of used dated sources within the topic's freshness
  //     window (≤1y for current, ≤3y scientific, any for historical) ---
  const window = session.intent?.recency === 'current' ? 1 : session.intent?.recency === 'scientific' ? 3 : Infinity;
  const dated = usedSources.filter(s => s.dateHint);
  const fresh = dated.filter(s => (Date.now() - new Date(s.dateHint).getTime()) / (365.25 * 24 * 3600 * 1000) <= window);
  const recency = dated.length === 0 ? null : fresh.length / dated.length;

  // --- independent confirmation: findings citing ≥2 distinct domains ---
  const findingsIndependentlyConfirmed = session.findings.filter(f => {
    const fd = new Set(f.citations.map(n => session.sources.find(s => s.n === n)?.domain).filter(Boolean));
    return fd.size >= 2;
  }).length;
  const independentConfirmation = session.findings.length === 0 ? 1 : findingsIndependentlyConfirmed / session.findings.length;

  const unanswered = session.plan.questions.filter(q => q.status === 'not_found').length;
  const completeness = session.plan.questions.length === 0 ? 1 : (session.plan.questions.length - unanswered) / session.plan.questions.length;
  const findingsCited = session.findings.length === 0 ? 0 : session.findings.filter(f => f.citations.length > 0).length / session.findings.length;

  const checks = [
    { name: 'citationCoverage', pass: citationCoverage >= 0.7 },
    { name: 'citationValidity', pass: true },
    { name: 'sourceQuality', pass: tierOk >= Math.min(2, usedSources.length) },
    { name: 'numericConsistency', pass: numericConsistent },
    { name: 'contradictionHandling', pass: session.conflicts.every(c => c.entries.length >= 2) },
    { name: 'completeness', pass: completeness >= 0.6 },
    { name: 'findingsCited', pass: session.findings.length === 0 || findingsCited === 1 },
  ];
  const score = checks.filter(c => c.pass).length / checks.length;

  // Weighted overall (weights favor traceability + integrity): documented.
  const metrics = [
    { key: 'sourceQuality', label: 'Source Quality', value: sourceQuality, formula: 'Tier 1/2 sources ÷ used sources' },
    { key: 'evidenceCoverage', label: 'Evidence Coverage', value: evidenceCoverage, formula: 'questions with ≥2 substantive evidence ÷ total questions' },
    { key: 'citationCoverage', label: 'Citation Coverage', value: citationCoverage, formula: 'external-claim sentences carrying [n] ÷ external-claim sentences' },
    { key: 'sourceDiversity', label: 'Source Diversity', value: sourceDiversity, formula: 'distinct domains ÷ used sources' },
    { key: 'recency', label: 'Recency', value: recency === null ? null : recency, formula: `dated sources within ${window === Infinity ? 'any age (historical topic)' : window + 'y'} ÷ dated sources` },
    { key: 'independentConfirmation', label: 'Independent Confirmation', value: independentConfirmation, formula: 'findings citing ≥2 distinct domains ÷ findings' },
    { key: 'conflictHandling', label: 'Conflict Handling', value: session.conflicts.length === 0 ? 1 : session.conflicts.filter(c => c.entries.length >= 2 && c.explanation).length / session.conflicts.length, formula: 'conflicts with ≥2 entries + explanation ÷ conflicts' },
    { key: 'numericIntegrity', label: 'Numeric Integrity', value: numericConsistent ? 1 : 0, formula: 'all table/chart numbers traced to evidence' },
    { key: 'completeness', label: 'Completeness', value: completeness, formula: 'answered questions ÷ total questions' },
  ];
  const scored = metrics.filter(m => typeof m.value === 'number');
  const overall = scored.length === 0 ? 0 : scored.reduce((a, m) => a + m.value, 0) / scored.length;
  const label = overall >= 0.8 ? 'Strong' : overall >= 0.6 ? 'Good' : overall >= 0.4 ? 'Fair' : 'Weak';

  return {
    checks, score: Math.round(score * 100) / 100,
    metrics: metrics.map(m => ({ ...m, value: typeof m.value === 'number' ? Math.round(m.value * 100) / 100 : null })),
    overall: Math.round(overall * 100) / 100, overallLabel: label,
    citationCoverage: Math.round(citationCoverage * 100) / 100, citedSections, claimTotal, claimCited,
    conflictsDetected: session.conflicts.length,
    runAt: Date.now(),
  };
}

// ============================================================
// TOP-LEVEL RUN LOOP (state machine driver)
// ============================================================
const running = new Map(); // sessionId -> Promise

// Wrapper: marks the session as running for the whole execution (even when
// the engine is driven directly — tests, reportFromPartial) so isRunning()
// and control checks are accurate.
function executeSession(session, opts) {
  running.set(session.id, Promise.resolve());
  return executeInner(session, opts);
}

async function executeInner(session, { fromPhase = 'research' } = {}) {
  const budget = MODES[session.effectiveMode];
  try {
    if (fromPhase === 'research') {
      session.state = 'researching';
      emit(session, 'research.started', { mode: session.effectiveMode, questions: session.plan.questions.length, agents: session.agentsRan?.map(a => a.key) || [] });

      await runQuestions(session, session.plan.questions.filter(q => q.origin !== 'adaptive'));
      if (controlGate(session) === 'run') await runGapAnalysis(session);
      // V2 adaptive research: the plan itself can grow mid-run.
      if (controlGate(session) === 'run') await runAdaptivePlanning(session);
      if (controlGate(session) === 'run') await runQuestions(session, session.plan.questions.filter(q => q.origin === 'adaptive'));
    }
    if (controlGate(session) !== 'run') throw new EngineAbort(session.control);

    if (fromPhase === 'research' || fromPhase === 'verify') {
      if (budget.verify !== false || session.conflicts.length === 0) {
        session.state = 'verifying';
        await runVerification(session);
      }
    }
    if (controlGate(session) !== 'run') throw new EngineAbort(session.control);

    await runAnalysis(session);
    if (controlGate(session) !== 'run') throw new EngineAbort(session.control);

    await runReport(session);
    // V2 versioning: a refresh computes its deterministic diff vs the
    // parent snapshot captured at creation.
    if (session.refreshOf && session._parentForDiff && !session.diff) {
      session.diff = computeDiff(session._parentForDiff, session);
      emit(session, 'research.diff_ready', { fromVersion: session.diff.fromVersion, toVersion: session.diff.toVersion, newSources: session.diff.newSources.length, newFindings: session.diff.newFindings.length });
    }
    if (session.state !== 'completed' && session.state !== 'partial') {
      session.state = 'completed';
      emit(session, 'research.completed', { stats: { ...session.stats } });
    }
  } catch (err) {
    if (err instanceof EngineAbort) {
      if (err.reason === 'stop') {
        session.state = 'cancelled';
        emit(session, 'research.cancelled', { stats: { ...session.stats } });
      } else {
        session.state = 'paused';
        emit(session, 'research.paused', { stats: { ...session.stats } });
      }
    } else {
      session.state = 'failed';
      session.errors.push({ phase: session.state, message: err.message, at: Date.now() });
      emit(session, 'research.failed', { message: err.message });
    }
  } finally {
    running.delete(session.id);
  }
}

// Public controls — all real: they set the control flag the loop checks
// between every unit of work. Pause takes effect at the next checkpoint;
// resume restarts the loop at the right phase from stored progress.
function startSession(session) {
  if (running.has(session.id)) return { alreadyRunning: true };
  if (!['created', 'paused', 'cancelled'].includes(session.state)) return { error: `Cannot start from state "${session.state}".` };
  session.control = 'run';
  session.errors = session.errors.filter(e => e.phase !== 'resume');
  const fromPhase = session.state === 'paused' ? resumePhase(session) : 'research';
  const p = executeSession(session, { fromPhase }).catch(() => {});
  running.set(session.id, p);
  return { started: true };
}

function resumePhase(session) {
  // If we got as far as evidence, conflict detection is idempotent —
  // always re-run verification onward so pause/resume is simple + correct.
  if (session.evidence.length > 0 && ['verifying', 'analyzing', 'reporting'].includes(session.pausedAtState || '')) {
    return 'verify';
  }
  return 'research';
}

function pauseSession(session) {
  // Setting the control flag is meaningful whether the loop is between
  // units right now or about to check at its next checkpoint; startSession
  // always resets control to 'run', so a stale 'pause' can't trap a
  // future run.
  session.pausedAtState = session.state;
  session.control = 'pause';
  return { pausing: true };
}

function stopSession(session) {
  session.control = 'stop';
  return { stopping: true };
}

// After a stop, the user may still want a report from what was gathered —
// this runs only the synthesis phases on the real collected evidence.
async function reportFromPartial(session) {
  if (running.has(session.id)) return { error: 'Still running.' };
  if (!['cancelled', 'paused', 'failed'].includes(session.state)) return { error: `Cannot report from state "${session.state}".` };
  if (session.evidence.length === 0) return { error: 'No evidence was collected to report from.' };
  session.control = 'run';
  const p = (async () => {
    try {
      await runVerification(session);
      await runAnalysis(session);
      await runReport(session);
    } catch (err) {
      session.state = 'failed';
      session.errors.push({ phase: 'partial-report', message: err.message, at: Date.now() });
      emit(session, 'research.failed', { message: err.message });
    } finally {
      running.delete(session.id);
    }
  })();
  running.set(session.id, p);
  return { started: true };
}

function isRunning(sessionId) { return running.has(sessionId); }

// Follow-up research: a NEW session seeded with the parent's sources and
// evidence (cost control — no re-reading), focused on the follow-up question.
async function createFollowup(parent, question, owner) {
  const child = blankSession({ owner, query: question, mode: parent.mode === 'auto' ? 'auto' : parent.effectiveMode, parentId: parent.id });
  child.effectiveMode = parent.effectiveMode;
  child.state = 'created';

  // Inherit web sources that were successfully used.
  const numMap = new Map();
  for (const src of parent.sources.filter(s => s.status === 'used')) {
    const clone = { ...src, usedFor: 0 };
    numMap.set(src.n, clone);
    child.sources.push(clone);
  }
  // Renumber sequentially.
  child.sources.forEach((s, i) => { numMap.set(s.n, i + 1); s.n = i + 1; });
  child.stats.sourcesFound = child.sources.length;

  child.plan = {
    objective: `Follow-up on "${parent.plan.objective.slice(0, 120)}": ${question.slice(0, 200)}`,
    topic: `Follow-up: ${question.slice(0, 60)}`,
    scope: { ...parent.plan.scope },
    questions: [{ id: 'q0', text: question, status: 'pending', searches: 0, evidence: 0, origin: 'plan' }],
    autoQuestions: false,
  };
  emit(child, 'research.plan_created', { questions: 1, followupOf: parent.id });
  return child;
}

// ============================================================
// CHALLENGE MODE (V2) — adversarial pass over completed research.
// For the top findings, the Challenge Agent searches for OPPOSING
// evidence, tests assumptions, and updates confidence honestly:
// findings can come back upheld, weakened, or overturned. Never silently.
// ============================================================
const CHALLENGE_SEARCH_PREFIX = 'criticism problems counterarguments opposing evidence skeptical analysis';
const CHALLENGE_SYSTEM = `You are the challenge agent for Aura AI Deep Research, running an adversarial review. You receive findings, their supporting evidence, AND newly searched potentially-opposing evidence. Test each finding: do the opposing angles materially weaken it? Respond with ONLY a JSON object:

{ "verdicts": [ { "finding": "<the finding statement>", "verdict": "upheld" | "weakened" | "overturned", "reasoning": "2-3 sentences: what was tested, what the opposing evidence says", "confidence": "high" | "moderate" | "limited" | "conflicting" } ] }

Rules:
- "upheld": opposing search found nothing that undermines it.
- "weakened": credible counter-evidence or untested assumptions narrow the claim's scope.
- "overturned": the evidence contradicts the finding's core assertion.
- Be genuinely adversarial — your job is to try to disprove, not to reassure.`;

const runningChallenge = new Set();

async function runChallenge(session) {
  if (!session.report || !['completed', 'partial'].includes(session.state)) {
    return { error: 'Challenge requires a completed report.' };
  }
  if (runningChallenge.has(session.id)) return { error: 'A challenge is already running on this session.' };
  runningChallenge.add(session.id);
  session.state = 'challenging';
  session.control = 'run';
  emit(session, 'research.challenge_started');

  try {
    const targets = session.findings.filter(f => f.type !== 'inference' || f.confidence !== 'limited').slice(0, 5);
    const opposing = [];
    const budget = Math.min(3, Math.max(1, Math.floor(MODES[session.effectiveMode].searches / 3)));

    for (let i = 0; i < Math.min(targets.length, budget); i++) {
      const f = targets[i];
      const query = `${f.statement.slice(0, 140)} ${CHALLENGE_SEARCH_PREFIX}`.slice(0, 300);
      emit(session, 'research.challenge_search', { finding: f.statement.slice(0, 100) });
      const before = session.sources.length;
      try {
        const result = await search.searchWeb({
          apiKey: process.env.GEMINI_API_KEY,
          geminiModel: models.MODEL_REGISTRY.find(m => m.geminiModel).geminiModel,
          query, context: session.plan.objective, provider: 'general',
        });
        session.stats.searches++;
        for (const s of result.sources.slice(0, 3)) {
          const { tier, kind } = search.classifySource(s.url);
          const src = addSource(session, { url: s.url, title: s.title, tier, kind, origin: 'web', ok: null, status: 'candidate' });
          if (src.status === 'candidate') {
            const page = await search.fetchPageText(s.url);
            if (page.ok) {
              src.ok = true; src.status = 'used';
              if (page.dateHint) src.dateHint = page.dateHint;
              opposing.push({ sourceN: src.n, title: src.title, text: page.text.slice(0, 8000) });
              emit(session, 'research.source_opened', { url: s.url, title: src.title, origin: 'challenge' });
            }
          }
        }
      } catch (err) {
        session.errors.push({ phase: 'challenge', message: `Challenge search failed: ${err.message}`, at: Date.now() });
      }
      if (session.sources.length > before) emit(session, 'research.source_found', { context: 'challenge' });
    }

    // Verdict pass.
    let verdicts = [];
    try {
      const findingsListing = targets.map(f => `FINDING (${f.type}/${f.confidence}): ${f.statement}\nSUPPORT: ${f.claims?.map(id => session.evidence.find(e => e.id === id)?.claim).filter(Boolean).join(' | ') || f.citations.join(',')}`).join('\n\n');
      const opposingListing = opposing.map(o => `[${o.sourceN}] ${o.title}\n${o.text.slice(0, 2500)}`).join('\n---\n');
      const out = await callModelJson({
        session, phase: 'challenge',
        systemPrompt: CHALLENGE_SYSTEM,
        userPrompt: `RESEARCH: ${session.plan.objective}\n\nFINDINGS UNDER TEST:\n${findingsListing}\n\nPOTENTIALLY OPPOSING EVIDENCE:\n${opposingListing || '(no opposing material retrieved)'}`,
        maxTokens: 3600,
      });
      verdicts = Array.isArray(out.verdicts) ? out.verdicts : [];
    } catch (err) {
      session.errors.push({ phase: 'challenge', message: err.message, at: Date.now() });
    }

    const srcByN = new Map(session.sources.map(s => [s.n, s]));
    session.challenge = {
      ranAt: Date.now(),
      searchedOpposing: true,
      verdicts: verdicts
        .filter(v => v && typeof v.finding === 'string' && ['upheld', 'weakened', 'overturned'].includes(v.verdict))
        .map(v => {
          const f = targets.find(t => t.statement === v.finding || t.statement.includes(v.finding.slice(0, 60)));
          const before = f?.confidence || 'moderate';
          if (f && ['high', 'moderate', 'limited', 'conflicting'].includes(v.confidence)) f.confidence = v.confidence;
          return {
            findingId: f?.id || null, statement: v.finding, verdict: v.verdict,
            reasoning: String(v.reasoning || '').slice(0, 900),
            confidenceBefore: before, confidenceAfter: f?.confidence || v.confidence || before,
          };
        }),
    };

    // Append the challenge section to the report (idempotent replace).
    session.report.sections = session.report.sections.filter(s => s.kind !== 'challenge');
    session.report.sections.splice(Math.max(0, session.report.sections.findIndex(s => s.kind === 'sources')), 0, {
      kind: 'challenge', heading: 'Adversarial Challenge', challenge: session.challenge,
    });
    emit(session, 'research.challenge_done', {
      upheld: session.challenge.verdicts.filter(v => v.verdict === 'upheld').length,
      weakened: session.challenge.verdicts.filter(v => v.verdict === 'weakened').length,
      overturned: session.challenge.verdicts.filter(v => v.verdict === 'overturned').length,
    });
    log(session, 'challenge', `verdicts=${session.challenge.verdicts.length}`);
    session.state = 'completed';
    return { ok: true };
  } finally {
    runningChallenge.delete(session.id);
  }
}

// ============================================================
// VERSIONED RESEARCH (V2) — "find newer evidence" / "add 2026 data" / any
// refresh instruction creates the NEXT VERSION of the research: it
// inherits context, runs fresh searches, and gets a deterministic diff
// against the parent (new sources, new/removed findings, confidence
// changes). Old conclusions are context, never automatically facts.
// ============================================================
async function createRefresh(parent, instruction, owner) {
  const child = blankSession({ owner, query: parent.query, mode: parent.effectiveMode, parentId: parent.id });
  child.effectiveMode = parent.effectiveMode;
  child.version = (parent.version || 1) + 1;
  child.refreshOf = parent.id;
  child.refreshInstruction = String(instruction || '').slice(0, 500) || 'Find newer evidence and update conclusions.';
  child.intent = parent.intent ? { ...parent.intent } : agents.analyzeIntent(parent.query);
  child.state = 'created';

  // Inherit sources as already-known material (marked so the UI can show
  // provenance; they are NOT re-read — cost control).
  parent.sources.filter(s => s.status === 'used').forEach(src => {
    child.sources.push({ ...src, usedFor: 0, inherited: true, status: 'used' });
  });
  child.sources.forEach((s, i) => { s.n = i + 1; });
  child.stats.sourcesFound = child.sources.length;

  child.plan = {
    objective: `${parent.plan.objective} (v${child.version}: ${child.refreshInstruction})`,
    topic: parent.plan.topic,
    scope: { ...parent.plan.scope, timeframe: /newer|latest|202[5-9]/i.test(child.refreshInstruction) ? `${new Date().getFullYear()} latest` : parent.plan.scope.timeframe },
    questions: parent.plan.questions.map(q => ({ ...q, status: 'pending', searches: 0, evidence: 0, origin: 'plan' })),
    autoQuestions: false,
  };
  // Compact parent snapshot for the deterministic post-completion diff —
  // avoids a store round-trip (and a circular engine↔store dependency).
  child._parentForDiff = {
    version: parent.version || 1,
    sources: parent.sources.map(s => ({ canonical: s.canonical, url: s.url })),
    findings: parent.findings.map(f => ({ statement: f.statement, confidence: f.confidence })),
  };
  emit(child, 'research.plan_created', { questions: child.plan.questions.length, version: child.version });
  return child;
}

// Deterministic diff between two versions of the research.
function computeDiff(parent, child) {
  const parentUrls = new Set(parent.sources.map(s => s.canonical || s.url).filter(Boolean));
  const newSources = child.sources.filter(s => s.origin === 'web' && !s.inherited && !parentUrls.has(s.canonical || s.url)).slice(0, 30);

  const matchFinding = (a, bList) => bList.find(b => {
    const ta = tokenSet(a.statement), tb = tokenSet(b.statement);
    return overlap(ta, tb) >= 0.5;
  });

  const newFindings = child.findings.filter(f => !matchFinding(f, parent.findings)).slice(0, 20);
  const removedFindings = parent.findings.filter(f => !matchFinding(f, child.findings)).slice(0, 20);
  const confidenceChanges = [];
  for (const cf of child.findings) {
    const pf = matchFinding(cf, parent.findings);
    if (pf && pf.confidence !== cf.confidence) {
      confidenceChanges.push({ statement: cf.statement.slice(0, 200), from: pf.confidence, to: cf.confidence });
    }
  }
  return {
    fromVersion: parent.version || 1, toVersion: child.version || 2,
    generatedAt: Date.now(),
    newSources: newSources.map(s => ({ n: s.n, title: s.title, url: s.url })),
    newFindings: newFindings.map(f => ({ statement: f.statement, type: f.type, confidence: f.confidence, citations: f.citations })),
    removedFindings: removedFindings.map(f => f.statement),
    confidenceChanges: confidenceChanges.slice(0, 20),
  };
}

// ============================================================
// SECTION REGENERATION / SIMPLIFICATION (V2) — real model passes that
// replace a single report section from the same evidence base.
// ============================================================
const SECTION_SYSTEM = `You are the report agent for Aura AI Deep Research, revising ONE section of an existing report from the same evidence. Respond with ONLY a JSON object: { "body": "the revised section body as markdown with [n] citations" }. Rules: use ONLY the given sources for citations; keep the section focused; do not invent facts.`;

async function regenerateSection(session, kind, { simplify = false } = {}) {
  const section = session.report?.sections.find(s => s.kind === kind);
  if (!section || typeof section.body !== 'string') return { error: 'Section not found or not regenerable.' };
  if (running.has(session.id) || runningChallenge.has(session.id)) return { error: 'Research is still running.' };

  const srcMap = new Map(session.sources.map(s => [s.n, s]));
  const sourcesListing = session.sources.filter(s => s.origin !== 'grounded-answer' || s.usedFor > 0)
    .map(s => `[${s.n}] ${s.title}${s.dateHint ? ` (${s.dateHint})` : ''}`).join('\n');
  const evidenceListing = session.evidence.slice(0, 60).map(e => `[${e.sourceN}] ${e.claim}`).join('\n');

  try {
    const out = await callModelJson({
      session, phase: 'section-revision',
      systemPrompt: SECTION_SYSTEM + (simplify ? ' SIMPLIFY MODE: rewrite for a non-expert reader — shorter sentences, no jargon, keep every citation.' : ''),
      userPrompt: `SECTION "${section.heading}" CURRENT BODY:\n${section.body}\n\nSOURCES:\n${sourcesListing}\n\nEVIDENCE:\n${evidenceListing}\n\n${simplify ? 'Simplify' : 'Rewrite and improve'} this section.`,
      maxTokens: 6000,
    });
    if (typeof out.body !== 'string' || !out.body.trim()) return { error: 'Model returned an empty section.' };
    const validNs = new Set(session.sources.map(s => s.n));
    section.body = String(out.body).replace(/\[(\d+)\]/g, (m, d) => (validNs.has(parseInt(d, 10)) ? m : '')).trim();
    section.revisedAt = Date.now();
    emit(session, 'research.section_revised', { kind, simplify });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================
// RESEARCH-TO-CONTENT (V2) — artifacts generated from the research's own
// evidence and citations: quiz (component-shaped, rendered by the existing
// quiz card), study notes, executive summary, article.
// ============================================================
const CONTENT_KINDS = {
  quiz: {
    label: 'Quiz',
    system: `You create study quizzes from research. Respond with ONLY a JSON object: {"type":"quiz","title":"...","questions":[{"question":"...","options":["A","B","C","D"],"answer":0,"explanation":"one line, cite [n] of the source"}]}. 5-8 questions grounded ONLY in the provided findings/evidence.`,
  },
  notes: {
    label: 'Study Notes',
    system: `You write study notes from research. Respond with ONLY a JSON object: {"title":"...","body":"markdown notes with headings, key-term lists, and [n] citations to the given sources"}. Concise, exam-useful.`,
  },
  summary: {
    label: 'Executive Summary',
    system: `You write executive summaries from research. Respond with ONLY a JSON object: {"title":"...","body":"markdown: what was researched, why it matters, what was found (with [n] citations), implications, recommended actions"}. Under 400 words.`,
  },
  article: {
    label: 'Article',
    system: `You write readable articles from research. Respond with ONLY a JSON object: {"title":"...","body":"markdown article with a lede, subheads, and [n] citations to the given sources"}. 600-900 words.`,
  },
};

async function generateContent(session, kind) {
  const spec = CONTENT_KINDS[kind];
  if (!spec) return { error: 'Unknown content kind.' };
  if (!session.report) return { error: 'No report to generate from.' };

  const srcMap = new Map(session.sources.map(s => [s.n, s]));
  const sourcesListing = session.sources.filter(s => s.origin !== 'grounded-answer' || s.usedFor > 0)
    .map(s => `[${s.n}] ${s.title}${s.url ? ` — ${s.url}` : ''}`).join('\n');
  const findingsListing = session.findings.map(f => `- (${f.type}/${f.confidence}) ${f.statement} [${f.citations.join(',')}]`).join('\n');

  try {
    const out = await callModelJson({
      session, phase: `content-${kind}`,
      systemPrompt: spec.system,
      userPrompt: `RESEARCH: ${session.plan.objective}\n\nFINDINGS:\n${findingsListing}\n\nEVIDENCE:\n${session.evidence.slice(0, 40).map(e => `[${e.sourceN}] ${e.claim}`).join('\n')}\n\nSOURCES:\n${sourcesListing}`,
      maxTokens: 6000,
    });
    if (!out || (typeof out.body !== 'string' && !Array.isArray(out.questions))) return { error: 'Model returned unusable content.' };

    // Quiz → reuse the exact component normalization from components.js so
    // the existing interactive quiz card renders it.
    let content;
    if (kind === 'quiz') {
      const normalized = require('../components').normalizeQuiz
        ? require('../components').normalizeQuiz(out)
        : null;
      if (!normalized) return { error: 'Quiz generation failed validation.' };
      content = normalized;
    } else {
      const validNs = new Set(session.sources.map(s => s.n));
      content = {
        title: String(out.title || session.report.title).slice(0, 200),
        body: String(out.body || '').replace(/\[(\d+)\]/g, (m, d) => (validNs.has(parseInt(d, 10)) ? m : '')).trim(),
      };
    }
    content.generatedAt = Date.now();
    content.kind = kind;
    session.content[kind] = content;
    emit(session, 'research.content_created', { kind, label: spec.label });
    return { ok: true, content };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  MODES,
  pickAutoMode,
  blankSession,
  emit,
  busFor,
  runPlanner,
  startSession,
  pauseSession,
  stopSession,
  reportFromPartial,
  createFollowup,
  isRunning,
  detectNumericConflicts,
  normalizeReport,
  runQualityChecks,
  executeSession,   // exposed for tests
  runVerification,  // exposed for tests
  // V2
  buildClaimGraph,
  claimStateSummary,
  runAdaptivePlanning,
  runQuestions,
  runChallenge,
  createRefresh,
  computeDiff,
  regenerateSection,
  generateContent,
  CONTENT_KINDS,
};
