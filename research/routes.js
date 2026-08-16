// Aura AI — research/routes.js
// Express router for the Deep Research API. Mounted at /api/research by
// server.js. Follows the app's established conventions: untrusted input
// validated server-side, per-IP rate limiting, ownership scoping, generic
// error messages to the client (details logged server-side only), and SSE
// for real-time event delivery (no websockets, no extra framework).
//
// Endpoints:
//   POST   /                     create session (planner runs; returns editable plan)
//   GET    /                     list sessions for this owner
//   GET    /:id                  full session snapshot
//   PATCH  /:id/plan             edit objective/questions before (or after) start
//   POST   /:id/start            begin / resume execution
//   POST   /:id/pause            pause at the next checkpoint
//   POST   /:id/resume           same as start from paused
//   POST   /:id/stop             cancel
//   POST   /:id/report-from-partial   synthesize a report from collected evidence
//   POST   /:id/followup         new child session focused on a follow-up question
//   GET    /:id/events           SSE: replay + live research.* events
//   GET    /:id/export.md        Markdown export (headings, citations, tables, sources)
//   DELETE /:id                  delete session
//   POST   /topics               topic suggestions (one model call)

const express = require('express');
const crypto = require('crypto');
const engine = require('./engine');
const store = require('./store');
const search = require('./search');
const attachments = require('../attachments');
const models = require('../models');
const providers = require('../providers');

function createRouter() {
  const router = express.Router();

  // ---- research-specific rate limiting (research is expensive: separate,
  // stricter buckets than chat so a research loop can never burn the chat
  // limiter, and vice versa) ----
  const createBuckets = new Map();
  const CREATE_LIMIT = 10;          // research actions (create/followup/challenge/refresh)
  const CREATE_WINDOW_MS = 10 * 60_000;
  const MAX_CONCURRENT_PER_OWNER = 2;

  function isCreateRateLimited(owner) {
    const now = Date.now();
    const bucket = (createBuckets.get(owner) || []).filter(t => now - t < CREATE_WINDOW_MS);
    bucket.push(now);
    createBuckets.set(owner, bucket);
    if (createBuckets.size > 5000) { // bound memory
      for (const [k, v] of createBuckets) if (v.every(t => now - t >= CREATE_WINDOW_MS)) createBuckets.delete(k);
    }
    return bucket.length > CREATE_LIMIT;
  }

  function requireGemini(res) {
    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({ error: 'RESEARCH_NOT_CONFIGURED', message: 'Deep Research needs the primary AI backend, which is not configured on this server.' });
      return false;
    }
    return true;
  }

  async function loadOwned(req, res) {
    const session = await store.load(req.params.id);
    if (!session || !store.owns(session, store.ownerKey(req))) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Research session not found.' });
      return null;
    }
    return session;
  }

  // Snapshot sent to the browser — everything the UI needs, minus raw
  // attachment bytes (files are referenced by filename only).
  function publicSession(session) {
    const { attachments: _atts, ...rest } = session;
    return { ...rest, attachments: (session.attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType })) };
  }

  // ============================================================
  // CREATE — runs the planner synchronously so the response carries an
  // editable plan (progressive disclosure: user edits, then starts).
  // ============================================================
  router.post('/', async (req, res) => {
    try {
      if (!requireGemini(res)) return;
      const owner = store.ownerKey(req);
      if (isCreateRateLimited(owner)) {
        return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many research sessions — wait a few minutes before starting another.' });
      }

      const { query, mode, depth, attachments: rawAttachments } = req.body || {};
      if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'A research question (1-2000 chars) is required.' });
      }
      const requestedMode = ['auto', 'quick', 'standard', 'deep', 'maximum'].includes(mode) ? mode
        : (['quick', 'standard', 'deep', 'maximum'].includes(depth) ? depth : 'auto');

      // Attachments use the exact same untrusted-input validation as chat.
      let validatedAttachments = [];
      try {
        validatedAttachments = attachments.validateAttachments(rawAttachments);
      } catch (attachErr) {
        if (attachErr instanceof attachments.AttachmentError) {
          return res.status(400).json({ error: attachErr.code, message: attachErr.message });
        }
        throw attachErr;
      }

      const session = engine.blankSession({ owner, query: query.trim(), mode: requestedMode, attachments: validatedAttachments });
      session.effectiveMode = requestedMode === 'auto' ? engine.pickAutoMode(query) : requestedMode;

      try {
        await engine.runPlanner(session);
      } catch (err) {
        return res.status(502).json({ error: 'PLANNING_FAILED', message: 'Could not build a research plan for this request. Try rephrasing, or again in a moment.' });
      }

      await store.save(session);
      res.status(201).json({ session: publicSession(session) });
    } catch (err) {
      console.error('research create error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      res.json({ sessions: await store.list(store.ownerKey(req)) });
    } catch (err) {
      console.error('research list error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not list research sessions.' });
    }
  });

  router.get('/:id', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    res.json({ session: publicSession(session), running: engine.isRunning(session.id) });
  });

  // ---- plan editing (real: changes what the engine researches) ----
  router.patch('/:id/plan', async (req, res) => {
    try {
      const session = await loadOwned(req, res);
      if (!session) return;
      if (engine.isRunning(session.id)) {
        return res.status(409).json({ error: 'RUNNING', message: 'Pause the research before editing the plan.' });
      }
      if (!['created', 'paused', 'cancelled'].includes(session.state)) {
        return res.status(409).json({ error: 'BAD_STATE', message: 'The plan can only be edited before research completes.' });
      }

      const { objective, questions, mode } = req.body || {};
      if (typeof objective === 'string' && objective.trim()) {
        session.plan.objective = objective.trim().slice(0, 1000);
      }
      if (Array.isArray(questions)) {
        const budget = engine.MODES[session.effectiveMode];
        const cleaned = questions
          .filter(q => typeof q === 'string' && q.trim())
          .slice(0, budget.maxQuestions)
          .map((text, i) => {
            const existing = session.plan.questions[i];
            return { id: existing?.id || 'q' + crypto.randomBytes(3).toString('hex'), text: text.trim().slice(0, 400), status: 'pending', searches: 0, evidence: 0, origin: 'plan' };
          });
        if (cleaned.length === 0) return res.status(400).json({ error: 'BAD_REQUEST', message: 'At least one research question is required.' });
        session.plan.questions = cleaned;
        session.plan.autoQuestions = false;
        // Editing resets collection state so restart is coherent.
        session.evidence = session.evidence.filter(() => false);
        session.conflicts = []; session.findings = []; session.charts = []; session.report = null; session.qc = null;
        session.stats = { ...session.stats, searches: 0, sourcesReviewed: 0, claimsExtracted: 0, claimsVerified: 0, conflictsFound: 0, chartsCreated: 0 };
      }
      if (['quick', 'standard', 'deep', 'maximum'].includes(mode)) {
        session.mode = mode;
        session.effectiveMode = mode;
        session.plan.questions = session.plan.questions.slice(0, engine.MODES[mode].maxQuestions);
      }
      engine.emit(session, 'research.plan_updated', { questions: session.plan.questions.length });
      await store.save(session);
      res.json({ session: publicSession(session) });
    } catch (err) {
      console.error('research plan update error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not update the plan.' });
    }
  });

  // ---- lifecycle controls ----
  router.post('/:id/start', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;

    // Count this owner's running sessions for the concurrency cap.
    const owner = store.ownerKey(req);
    const running = await countRunningFor(owner);
    if (!engine.isRunning(session.id) && running >= MAX_CONCURRENT_PER_OWNER) {
      return res.status(429).json({ error: 'TOO_MANY_RUNNING', message: `You can run ${MAX_CONCURRENT_PER_OWNER} research sessions at once. Wait for one to finish or stop it.` });
    }

    const result = engine.startSession(session);
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    if (result.alreadyRunning) return res.json({ started: true, alreadyRunning: true });

    // Persist checkpoints ride along with events (see saveOnEvent below) —
    // but ensure at least the started state is durable.
    await store.save(session);
    res.json({ started: true });
  });

  router.post('/:id/pause', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    const result = engine.pauseSession(session);
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    // The engine pauses at its next checkpoint and persists then; this
    // response just acknowledges the command.
    res.json({ pausing: true });
  });

  router.post('/:id/resume', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;
    if (session.state !== 'paused') {
      return res.status(409).json({ error: 'BAD_STATE', message: `Cannot resume from state "${session.state}".` });
    }
    const result = engine.startSession(session);
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    await store.save(session);
    res.json({ resumed: true });
  });

  router.post('/:id/stop', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    engine.stopSession(session);
    if (!engine.isRunning(session.id)) {
      // Not running: stop takes effect immediately (a finished report is kept).
      if (!session.report) session.state = 'cancelled';
      engine.emit(session, 'research.cancelled', {});
      await store.save(session);
    }
    res.json({ stopping: true });
  });

  router.post('/:id/report-from-partial', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;
    const result = await engine.reportFromPartial(session);
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    await store.save(session);
    res.json({ started: true });
  });

  // ---- follow-up research ----
  router.post('/:id/followup', async (req, res) => {
    try {
      if (!requireGemini(res)) return;
      const session = await loadOwned(req, res);
      if (!session) return;
      const owner = store.ownerKey(req);
      if (isCreateRateLimited(owner)) {
        return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many research sessions — wait a few minutes before starting another.' });
      }
      const { question } = req.body || {};
      if (typeof question !== 'string' || !question.trim() || question.length > 1000) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'A follow-up question is required.' });
      }
      const child = await engine.createFollowup(session, question.trim(), owner);
      await store.save(child);
      res.status(201).json({ session: publicSession(child) });
    } catch (err) {
      console.error('research followup error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not start follow-up research.' });
    }
  });

  // ============================================================
  // V2 — CHALLENGE MODE (adversarial review of completed research)
  // ============================================================
  router.post('/:id/challenge', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;
    const owner = store.ownerKey(req);
    if (isCreateRateLimited(owner)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many research actions — wait a few minutes.' });
    }
    const result = await engine.runChallenge(session);
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    await store.save(session);
    res.json({ ok: true, challenge: session.challenge });
  });

  // ============================================================
  // V2 — VERSIONED RESEARCH: refresh a completed session ("find newer
  // evidence", "add 2026 data", any instruction) → next version with a
  // deterministic diff, then start it.
  // ============================================================
  router.post('/:id/refresh', async (req, res) => {
    try {
      if (!requireGemini(res)) return;
      const session = await loadOwned(req, res);
      if (!session) return;
      if (!session.report) {
        return res.status(409).json({ error: 'NO_REPORT', message: 'Refresh needs a completed report to build on.' });
      }
      const owner = store.ownerKey(req);
      if (isCreateRateLimited(owner)) {
        return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many research sessions — wait a few minutes.' });
      }
      const { instruction } = req.body || {};
      const child = await engine.createRefresh(session, typeof instruction === 'string' ? instruction : '', owner);
      await store.save(child);
      const start = engine.startSession(child);
      if (start.error) return res.status(409).json({ error: 'BAD_STATE', message: start.error });
      await store.save(child);
      res.status(201).json({ session: publicSession(child) });
    } catch (err) {
      console.error('research refresh error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not start a new research version.' });
    }
  });

  // ============================================================
  // V2 — SECTION REGENERATE / SIMPLIFY (real model passes on one section)
  // ============================================================
  router.post('/:id/section/:kind', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;
    const { action } = req.body || {};
    if (!['regenerate', 'simplify'].includes(action)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'action must be "regenerate" or "simplify".' });
    }
    const result = await engine.regenerateSection(session, req.params.kind, { simplify: action === 'simplify' });
    if (result.error) return res.status(409).json({ error: 'BAD_STATE', message: result.error });
    await store.save(session);
    res.json({ ok: true, session: publicSession(session) });
  });

  // ============================================================
  // V2 — RESEARCH-TO-CONTENT: quiz / notes / summary / article generated
  // from the research's own evidence (quiz reuses the component pipeline).
  // ============================================================
  router.post('/:id/content', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!requireGemini(res)) return;
    const { kind } = req.body || {};
    const result = await engine.generateContent(session, kind);
    if (result.error) return res.status(400).json({ error: 'BAD_REQUEST', message: result.error });
    await store.save(session);
    res.json({ ok: true, content: result.content });
  });

  // V2 — structured JSON export (research → data for coding agents etc.)
  router.get('/:id/export.json', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!session.report) {
      return res.status(409).json({ error: 'NO_REPORT', message: 'This research has no report yet.' });
    }
    const payload = {
      id: session.id, query: session.query, version: session.version || 1,
      mode: session.effectiveMode, intent: session.intent,
      objective: session.plan.objective,
      questions: session.plan.questions.map(q => ({ text: q.text, status: q.status })),
      sources: session.sources.filter(s => s.status === 'used' || s.origin === 'file').map(s => ({
        n: s.n, title: s.title, url: s.url, domain: s.domain, tier: s.tier, kind: s.kind,
        published: s.dateHint, usedFor: s.usedFor,
      })),
      evidence: session.evidence.filter(e => !e.claim.startsWith('Search summary')).map(e => ({
        id: e.id, sourceN: e.sourceN, claim: e.claim, quote: e.quote,
        numbers: e.numbers, state: e.claimState?.status || e.verified,
        independentConfirmation: e.claimState?.independentConfirmation ?? null,
      })),
      conflicts: session.conflicts,
      findings: session.findings,
      charts: session.charts,
      datasets: session.datasets,
      stats: session.stats,
      quality: session.qc ? { overall: session.qc.overall, overallLabel: session.qc.overallLabel, metrics: session.qc.metrics } : null,
      exportedAt: new Date().toISOString(),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="aura-research-${session.id.slice(0, 8)}.json"`);
    res.json(payload);
  });

  // ============================================================
  // SSE EVENT STREAM — replay + live. The activity UI is driven ONLY by
  // these real engine events; nothing on the wire is synthetic.
  // ============================================================
  router.get('/:id/events', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return; // loadOwned already responded

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ id: session.id, state: session.state })}\n\n`);

    // Replay events the client hasn't seen (EventSource reconnects include
    // Last-Event-ID; first connect replays from the beginning).
    const lastSeq = parseInt(req.headers['last-event-id'] || '0', 10) || 0;
    for (const ev of session.events) {
      if (ev.seq <= lastSeq) continue;
      res.write(formatSse(ev));
    }
    res.write(`event: snapshot\ndata: ${JSON.stringify({ state: session.state, stats: session.stats })}\n\n`);

    const bus = engine.busFor(session.id);
    const onEvent = (ev) => {
      try { res.write(formatSse(ev)); } catch { /* connection gone; cleaned below */ }
    };
    bus.on('event', onEvent);

    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch { /* ignore */ }
    }, 15_000);

    // Persist checkpoints as research progresses — but throttled (the
    // engine mutates the session object in place, and store.load returned
    // this same object from memory, so saving the reference is enough).
    let lastSave = 0;
    const onPersist = () => {
      if (Date.now() - lastSave > 4000) { lastSave = Date.now(); store.save(session).catch(() => {}); }
    };
    bus.on('event', onPersist);

    req.on('close', () => {
      clearInterval(heartbeat);
      bus.removeListener('event', onEvent);
      bus.removeListener('event', onPersist);
      store.save(session).catch(() => {}); // final durable checkpoint
    });
  });

  function formatSse(ev) {
    return `id: ${ev.seq}\nevent: research\ndata: ${JSON.stringify(ev)}\n\n`;
  }

  async function countRunningFor(owner) {
    // Cheap approximation: an owner's recent sessions still in an active
    // state AND actually running in this process.
    const sessions = await store.list(owner, 20);
    let n = 0;
    for (const s of sessions) if (engine.isRunning(s.id)) n++;
    return n;
  }

  // ============================================================
  // MARKDOWN EXPORT — headings, citations as [n] + linked source list,
  // tables, timeline, conflicts, limitations. Deterministic from state.
  // ============================================================
  router.get('/:id/export.md', async (req, res) => {
    const session = await loadOwned(req, res);
    if (!session) return;
    if (!session.report) {
      return res.status(409).json({ error: 'NO_REPORT', message: 'This research has no report yet.' });
    }
    const md = buildMarkdownExport(session);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="aura-research-${session.id.slice(0, 8)}.md"`);
    res.send(md);
  });

  router.delete('/:id', async (req, res) => {
    const ok = await store.remove(req.params.id, store.ownerKey(req));
    if (!ok) return res.status(404).json({ error: 'NOT_FOUND', message: 'Research session not found.' });
    res.json({ ok: true });
  });

  // ============================================================
  // TOPIC DISCOVERY — one model call proposing research topics.
  // ============================================================
  router.post('/topics', async (req, res) => {
    try {
      if (!requireGemini(res)) return;
      const { interest } = req.body || {};
      const geminiModel = models.MODEL_REGISTRY.find(m => m.geminiModel).geminiModel;
      let text = '';
      try {
        const result = await providers.callGemini({
          apiKey: process.env.GEMINI_API_KEY,
          geminiModel,
          systemPrompt: `You suggest research topics. Respond with ONLY a JSON object: {"topics":[{"topic":"...","category":"Technology|Science|Business|Education|Health|Policy|History","whyItMatters":"one sentence","researchQuestions":["q1","q2"],"difficulty":"Low|Medium|High","dataAvailability":"Low|Medium|High","expectedDepth":"Quick|Standard|Deep","impact":"High|Very High","methodology":"one line: what sources/approach fits"}]}. 6 topics, timely and specific enough to research on the public web today. No prose.`,
          messages: [{ role: 'user', content: `Suggest research topics${typeof interest === 'string' && interest.trim() ? ` related to: ${interest.trim().slice(0, 300)}` : ' across Technology, Science, Business, Policy and Health'}.` }],
          maxTokens: 2200,
        });
        text = result.text;
      } catch (err) {
        return res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Could not generate topic suggestions right now.' });
      }
      const start = text.indexOf('{'); const end = text.lastIndexOf('}');
      let topics = [];
      if (start !== -1 && end > start) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
            .filter(t => t && typeof t.topic === 'string' && t.topic.trim())
            .slice(0, 8)
            .map(t => ({
              topic: t.topic.trim().slice(0, 200),
              category: String(t.category || 'General').slice(0, 30),
              whyItMatters: String(t.whyItMatters || '').slice(0, 240),
              researchQuestions: (Array.isArray(t.researchQuestions) ? t.researchQuestions : []).filter(q => typeof q === 'string').slice(0, 4),
              difficulty: String(t.difficulty || '').slice(0, 12),
              dataAvailability: String(t.dataAvailability || '').slice(0, 12),
              expectedDepth: ['Quick', 'Standard', 'Deep'].includes(t.expectedDepth) ? t.expectedDepth : 'Standard',
              impact: String(t.impact || '').slice(0, 12),
              methodology: String(t.methodology || '').slice(0, 200),
            }));
        } catch { /* fall through to empty */ }
      }
      if (topics.length === 0) {
        return res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Could not generate topic suggestions right now.' });
      }
      res.json({ topics });
    } catch (err) {
      console.error('research topics error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
    }
  });

  return router;
}

// ---- markdown export builder (deterministic; mirrors the UI report) ----
function buildMarkdownExport(session) {
  const r = session.report;
  const lines = [];
  lines.push(`# ${r.title}`, '');
  lines.push(`> Research request: _${session.query}_`, '');
  lines.push(`> Mode: **${engine.MODES[session.effectiveMode].label}** · Completed: ${new Date(r.generatedAt).toISOString().slice(0, 10)} · Sources reviewed: ${session.stats.sourcesReviewed} · Claims: ${session.stats.claimsExtracted}`, '');

  for (const s of r.sections) {
    lines.push(`## ${s.heading}`, '');
    if (s.body) { lines.push(s.body, ''); }
    if (s.kind === 'findings') {
      for (const f of session.findings) {
        const cite = f.citations.length ? ` [[${f.citations.join('],[')}]]` : '';
        lines.push(`- **${f.type.toUpperCase()}** (${f.confidence} confidence): ${f.statement}${cite}`);
      }
      lines.push('');
      for (const ch of session.charts) {
        lines.push(`**Chart (${ch.type}): ${ch.title}**${ch.unit ? ` — unit: ${ch.unit}` : ''}${ch.period ? ` — period: ${ch.period}` : ''}`, '');
        lines.push('| ' + ch.series.map(pt => pt.label).join(' | ') + ' |');
        lines.push('|' + ch.series.map(() => '---').join('|') + '|');
        lines.push('| ' + ch.series.map(pt => pt.value).join(' | ') + ' |', '');
        if (ch.note) lines.push(`_Note: ${ch.note}_`, '');
      }
    }
    if (s.kind === 'comparison' && s.columns) {
      lines.push('| ' + s.columns.join(' | ') + ' |');
      lines.push('|' + s.columns.map(() => '---').join('|') + '|');
      for (const row of s.rows) lines.push('| ' + row.join(' | ') + ' |');
      lines.push('');
    }
    if (s.kind === 'timeline') {
      for (const ev of s.events) {
        lines.push(`- **${ev.date}** — ${ev.label}${ev.citation ? ` [${ev.citation}]` : ''}${ev.description ? `\n  ${ev.description}` : ''}`);
      }
      lines.push('');
    }
    if (s.kind === 'conflicts') {
      for (const c of s.conflicts) {
        lines.push(`### ⚠ ${c.subject}`, '');
        for (const en of c.entries) {
          lines.push(`- Source [${en.sourceN}]${en.sourceTitle ? ` (${en.sourceTitle})` : ''}: **${en.value}${en.unit || ''}**`);
          if (en.quote) lines.push(`  > ${en.quote.replace(/\n/g, ' ').slice(0, 240)}`);
        }
        lines.push('', `**Why they disagree:** ${c.explanation}`, '');
      }
    }
    if (s.kind === 'limitations' && s.items) {
      for (const item of s.items) lines.push(`- ${item}`);
      lines.push('');
    }
    if (s.kind === 'sources' && s.sources) {
      for (const src of s.sources) {
        const tierLabel = src.tier === 1 ? 'Tier 1' : src.tier === 2 ? 'Tier 2' : 'Tier 3';
        lines.push(`${src.n}. **${src.title}** — ${src.kind} (${tierLabel})${src.dateHint ? `, published ${src.dateHint}` : ''}${src.url ? ` — <${src.url}>` : ' (attached file)'}`);
      }
      lines.push('');
    }
  }
  if (session.qc) {
    lines.push('---', '', `*Quality check score: ${Math.round(session.qc.score * 100)}/100 · citation coverage: ${Math.round(session.qc.citationCoverage * 100)}%*`, '');
  }
  lines.push('*Generated by Aura AI Deep Research. Verify important claims via the linked sources.*');
  return lines.join('\n');
}

module.exports = { createRouter, buildMarkdownExport };
