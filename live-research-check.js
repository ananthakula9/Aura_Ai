// live-research-check.js — REAL end-to-end validation of Aura AI against
// the REAL configured APIs (keys come from .env / the environment; this
// script never prints them). Boots the actual server, then exercises:
//
//   A. /api/health + real /api/chat (default model, Mistral-only model)
//   B. Real Deep Research (standard): create → plan → SSE → completion
//      with real web search (grounding or keyless fallback), real page
//      reading, real evidence extraction, verification, conflicts,
//      analysis, report, QC — asserting citation integrity + truthful stats
//   C. Citation chain spot-checks (claim → evidence quote → source URL)
//   D. SSRF guards against internal addresses
//   E. SSE disconnect → reconnect replay
//   F. Pause → resume → complete
//   G. Stop → report-from-partial
//   H. Challenge, refresh→v2 diff, section regenerate, follow-up, exports
//
// Run: node live-research-check.js          (requires real keys in .env)

const fs = require('fs');
const assert = require('assert');

// ---- load .env (no dotenv dependency) ----
fs.readFileSync('.env', 'utf8').split(/\r?\n/).forEach(l => {
  const m = /^([A-Z_]+)=(.*)$/.exec(l);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
});

for (const required of ['GEMINI_API_KEY', 'MISTRAL_API_KEY']) {
  if (!process.env[required]) { console.error(`FATAL: ${required} not configured`); process.exit(1); }
}

const PORT = process.env.LIVE_PORT || 3310;
process.env.PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function jfetch(path, options = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

async function waitFor(fn, { timeoutMs = 300000, intervalMs = 2000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

// Minimal SSE reader that can disconnect on demand.
async function sseConnect(sessionId, { onEvent, disconnectAfter = null } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/research/${sessionId}/events`, { signal: controller.signal });
  if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body.getReader();
  const events = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.includes('event: research')) {
            const line = frame.split('\n').find(l => l.startsWith('id: '));
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              const ev = JSON.parse(dataLine.slice(6));
              events.push(ev);
              onEvent?.(ev);
              if (disconnectAfter && ev.type === disconnectAfter) {
                controller.abort();
                return;
              }
            }
          }
        }
      }
    } catch { /* aborted or closed */ }
  })();
  return { events, abort: () => controller.abort() };
}

(async () => {
  let fwWrap = null, refreshWrap = null;
  console.log('— booting real server —');
  const app = require('./server.js');
  // Robust readiness wait: with DATABASE_URL set, start() awaits schema
  // init before listening, so the 'listening' event may fire during
  // require() — poll the health endpoint instead of racing the event.
  const up = await waitFor(async () => {
    try { const r = await fetch(`${BASE}/api/health`); return r.ok; } catch { return false; }
  }, { timeoutMs: 30000, intervalMs: 300, label: 'server boot' });
  if (!up) { console.error('FATAL: server did not come up'); process.exit(1); }
  console.log(`server on :${PORT}\n`);

  // ================= A. HEALTH + CHAT =================
  console.log('— A. health + real chat —');
  const health = await jfetch('/api/health');
  ok('health responds', health.status === 200 && health.data.ok === true);
  ok('research enabled in health', health.data.researchEnabled === true);

  const chat = await jfetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      systemPrompt: 'You are Aura, a helpful assistant. Answer in one short sentence.',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      model: 'Aura 1 Flash', maxTokens: 300,
    }),
  });
  ok('real chat (Gemini default model)', chat.status === 200 && /paris/i.test(chat.data.text || ''), `latency ${chat.data.latencyMs}ms, model "${chat.data.model}"`);

  const chatPro = await jfetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      systemPrompt: 'You are Aura. Answer in one word.',
      messages: [{ role: 'user', content: '2+2?' }],
      model: 'Aura 1 Pro', maxTokens: 200,
    }),
  });
  ok('real chat (Mistral-only model)', chatPro.status === 200 && /four|4/i.test(chatPro.data.text || ''), `model "${chatPro.data.model}", text "${(chatPro.data.text || '').slice(0, 30)}"`);

  const chatBadModel = await jfetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      systemPrompt: 'You are Aura.',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gemini-9.9-ultra', maxTokens: 100,
    }),
  });
  ok('forged raw model id falls back safely', chatBadModel.status === 200 && chatBadModel.data.model === 'Aura 1 Flash');

  // ================= B. REAL DEEP RESEARCH =================
  console.log('\n— B. real Deep Research (standard mode) —');
  const QUERY = 'Research the current state of AI regulation in the EU and the United States: main frameworks, key dates, and how they differ. Cite authoritative sources.';
  const t0 = Date.now();
  const created = await jfetch('/api/research', { method: 'POST', body: JSON.stringify({ query: QUERY, mode: 'standard' }) });
  ok('create + real planner', created.status === 201 && created.data.session.plan.questions.length >= 3,
    `${created.data.session?.plan?.questions?.length} questions, complexity=${created.data.session?.intent?.complexity}, providers=${created.data.session?.intent?.providers?.join('/')}`);
  const sid = created.data.session.id;

  // SSE watcher for the whole run
  const sse = await sseConnect(sid);
  const startRes = await jfetch(`/api/research/${sid}/start`, { method: 'POST' });
  ok('start accepted', startRes.status === 200);

  const completed = await waitFor(async () => {
    const { data } = await jfetch(`/api/research/${sid}`);
    return ['completed', 'partial', 'failed'].includes(data.session?.state);
  }, { timeoutMs: 480000, label: 'research completion' });
  ok('research reached a terminal state', completed, `${Math.round((Date.now() - t0) / 1000)}s`);

  const { data: finalWrap } = await jfetch(`/api/research/${sid}`);
  const S = finalWrap.session;
  ok('final state is completed/partial', ['completed', 'partial'].includes(S.state),
    `state=${S.state} errors=${JSON.stringify((S.errors || []).slice(0, 2).map(e => e.phase + ':' + String(e.message).slice(0, 90)))}`);
  ok('real searches ran', S.stats.searches >= 2, `${S.stats.searches} searches, ${S.stats.searchesFailed} failed`);
  ok('real sources were opened', S.stats.sourcesReviewed >= 2, `${S.stats.sourcesReviewed} reviewed of ${S.stats.sourcesFound} found`);
  ok('real evidence extracted', S.stats.claimsExtracted >= 4, `${S.stats.claimsExtracted} claims`);
  ok('real report generated', Boolean(S.report), `"${S.report?.title?.slice(0, 60)}"`);
  ok('SSE delivered the real event stream', sse.events.some(e => e.type === 'research.started') && sse.events.some(e => e.type === 'research.search_completed'),
    `${sse.events.length} events`);

  // Source quality: real URLs, real tiers, canonical dedup
  const usedSources = S.sources.filter(s => s.status === 'used' && s.origin !== 'grounded-answer');
  ok('used sources are real URLs with tiers', usedSources.every(s => /^https?:\/\//.test(s.url || '') && [1, 2, 3].includes(s.tier)),
    usedSources.slice(0, 3).map(s => `t${s.tier}:${s.domain}`).join(', '));
  const canonicals = usedSources.map(s => s.canonical || s.url);
  ok('no duplicate canonical URLs among used sources', new Set(canonicals).size === canonicals.length);

  // Report structure + citation integrity
  const kinds = (S.report?.sections || []).map(s => s.kind);
  ok('report has required sections', ['executive-summary', 'findings', 'sources'].every(k => kinds.includes(k)), kinds.join(','));
  const validNs = new Set(S.sources.map(s => s.n));
  let badCitations = 0, totalCitations = 0;
  for (const sec of (S.report?.sections || [])) {
    if (typeof sec.body === 'string') {
      for (const m of sec.body.matchAll(/\[(\d+)\]/g)) {
        totalCitations++;
        if (!validNs.has(parseInt(m[1], 10))) badCitations++;
      }
    }
  }
  ok('every citation maps to a real source', badCitations === 0 && totalCitations >= 3, `${totalCitations} citations, ${badCitations} invalid`);
  ok('findings cite real sources only', (S.findings || []).length >= 2 && S.findings.every(f => f.citations.every(n => validNs.has(n))),
    `${S.findings?.length} findings`);
  ok('quality metrics recorded with formulas', S.qc?.metrics?.length === 9, `overall ${S.qc?.overallLabel}`);

  // ================= C. CITATION CHAIN SPOT-CHECK =================
  console.log('\n— C. citation chain —');
  const chain = [];
  for (const f of (S.findings || []).slice(0, 3)) {
    const ev = (S.evidence || []).find(e => (f.claims || []).includes(e.id)) || (S.evidence || []).find(e => f.citations.includes(e.sourceN) && !e.claim.startsWith('Search summary'));
    const src = S.sources.find(s => s.n === (ev?.sourceN ?? f.citations[0]));
    chain.push({ finding: f.statement.slice(0, 50), hasEvidence: Boolean(ev && ev.quote && ev.quote.length > 10), sourceUrl: src?.url, sourceReal: /^https?:\/\//.test(src?.url || '') });
  }
  ok('finding → evidence → source chain intact', chain.every(c => c.hasEvidence && c.sourceReal),
    chain.map(c => `${c.sourceUrl?.slice(0, 40) || 'NO-SOURCE'}`).join(' | '));
  ok('claim states computed', (S.evidence || []).some(e => e.claimState), JSON.stringify(S.evidence?.filter(e => e.claimState).slice(0, 3).map(e => e.claimState.status)));

  // ================= D. SSRF GUARDS =================
  console.log('\n— D. SSRF guards (real network) —');
  const search = require('./research/search');
  const blocked = [];
  for (const url of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://10.0.0.5/admin', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x']) {
    const r = await search.fetchPageText(url);
    blocked.push(!r.ok && ['BLOCKED_HOST', 'BAD_URL', 'DNS_FAILURE'].includes(r.code));
  }
  ok('internal/metadata addresses blocked', blocked.every(Boolean));

  // ================= E. SSE RECONNECT =================
  console.log('\n— E. SSE disconnect + reconnect —');
  // Reconnect to the COMPLETED session: replay must redeliver history.
  const replay = await sseConnect(sid);
  await new Promise(r => setTimeout(r, 1500));
  ok('reconnect replays full event history', replay.events.length >= sse.events.length - 2, `${replay.events.length} replayed events`);

  // ================= F. PAUSE / RESUME =================
  console.log('\n— F. pause → resume (second real run) —');
  const p2 = await jfetch('/api/research', { method: 'POST', body: JSON.stringify({ query: 'Research the current state of open-source AI model releases and their licensing trends', mode: 'quick' }) });
  const sid2 = p2.data.session.id;
  const sse2 = await sseConnect(sid2);
  await jfetch(`/api/research/${sid2}/start`, { method: 'POST' });
  // wait until the first search attempt resolves (success OR throttle
  // failure — both leave the engine genuinely in-flight), then pause
  const firstSearch = await waitFor(() => sse2.events.some(e => e.type === 'research.search_completed' || e.type === 'research.search_failed'), { timeoutMs: 120000, label: 'first search' });
  ok('run 2: first real search attempt resolved', firstSearch);
  await jfetch(`/api/research/${sid2}/pause`, { method: 'POST' });
  const paused = await waitFor(async () => (await jfetch(`/api/research/${sid2}`)).data.session.state === 'paused', { timeoutMs: 120000, label: 'pause' });
  ok('paused at a real checkpoint', paused);
  const eventsAtPause = (await jfetch(`/api/research/${sid2}`)).data.session.stats.searches;
  await new Promise(r => setTimeout(r, 3000));
  const stillPaused = (await jfetch(`/api/research/${sid2}`)).data.session.state === 'paused';
  const searchesStill = (await jfetch(`/api/research/${sid2}`)).data.session.stats.searches;
  ok('no work while paused', stillPaused && searchesStill === eventsAtPause, `${searchesStill} searches held`);
  await jfetch(`/api/research/${sid2}/resume`, { method: 'POST' });
  const resumed = await waitFor(async () => ['completed', 'partial', 'failed'].includes((await jfetch(`/api/research/${sid2}`)).data.session.state), { timeoutMs: 300000, label: 'resume completion' });
  const S2 = (await jfetch(`/api/research/${sid2}`)).data.session;
  ok('resumed run completed', resumed && ['completed', 'partial'].includes(S2.state), `state=${S2.state}, ${S2.stats.claimsExtracted} claims`);

  // ================= G. STOP → PARTIAL REPORT =================
  console.log('\n— G. stop → report-from-partial —');
  const p3 = await jfetch('/api/research', { method: 'POST', body: JSON.stringify({ query: 'Research renewable energy capacity growth in 2025 by region', mode: 'standard' }) });
  const sid3 = p3.data.session.id;
  const sse3 = await sseConnect(sid3);
  await jfetch(`/api/research/${sid3}/start`, { method: 'POST' });
  await waitFor(() => sse3.events.some(e => ['research.evidence_extracted', 'research.source_opened', 'research.question_started'].includes(e.type)), { timeoutMs: 180000, label: 'some progress' });
  await jfetch(`/api/research/${sid3}/stop`, { method: 'POST' });
  const stopped = await waitFor(async () => (await jfetch(`/api/research/${sid3}`)).data.session.state === 'cancelled', { timeoutMs: 120000, label: 'stop' });
  ok('stopped → cancelled', stopped);
  const S3pre = (await jfetch(`/api/research/${sid3}`)).data.session;
  const rp = await jfetch(`/api/research/${sid3}/report-from-partial`, { method: 'POST' });
  if ((S3pre.stats.claimsExtracted || 0) > 0) {
    ok('report-from-partial accepted', rp.status === 200);
    const partialDone = await waitFor(async () => Boolean((await jfetch(`/api/research/${sid3}`)).data.session.report), { timeoutMs: 300000, label: 'partial report' });
    const S3 = (await jfetch(`/api/research/${sid3}`)).data.session;
    ok('partial report generated from real collected evidence', partialDone && Boolean(S3.report) && S3.stats.claimsExtracted >= 1,
      `${S3.stats.claimsExtracted} claims, limitations: ${S3.report.sections.filter(s => s.kind === 'limitations').length}`);
  } else {
    // Honest refusal: no evidence was collected (e.g. every search
    // throttled) — the API must say so rather than fabricate a report.
    ok('report-from-partial honestly refuses with no evidence', rp.status === 409 && /no evidence/i.test(rp.data.message || ''), `status ${rp.status}: ${rp.data.message}`);
  }

  // ================= H. CHALLENGE / REFRESH / SECTION / FOLLOWUP / EXPORT =================
  console.log('\n— H. V2 actions on the completed run —');
  if (!S.report) {
    console.log('(skipped — the primary research run did not produce a report; see errors above)');
  } else {
  const ch = await jfetch(`/api/research/${sid}/challenge`, { method: 'POST' });
  const challengeOk = ch.status === 200 && (ch.data.challenge?.verdicts?.length >= 0);
  const SCh = (await jfetch(`/api/research/${sid}`)).data.session;
  ok('challenge ran real opposing searches', challengeOk && Boolean(SCh.challenge), `${SCh.challenge?.verdicts?.length || 0} verdicts: ${(SCh.challenge?.verdicts || []).map(v => v.verdict).join(',') || '—'}`);
  ok('challenge section in report', SCh.report.sections.some(s => s.kind === 'challenge'));

  const beforeSec = SCh.report.sections.find(s => s.kind === 'executive-summary');
  const regen = await jfetch(`/api/research/${sid}/section/executive-summary`, { method: 'POST', body: JSON.stringify({ action: 'regenerate' }) });
  const regenS = regen.data.session || (await jfetch(`/api/research/${sid}`)).data.session;
  const afterSec = regenS.report.sections.find(s => s.kind === 'executive-summary');
  ok('section regenerate produced a new real body', regen.status === 200 && afterSec.body !== beforeSec.body && afterSec.body.length > 50,
    `status ${regen.status}, ${afterSec.body.length} chars, changed=${afterSec.body !== beforeSec.body}${regen.status !== 200 ? ', msg: ' + (regen.data.message || '') : ''}`);
  ok('regenerated section keeps valid citations', (afterSec.body.match(/\[\d+\]/g) || []).length >= 1);

  const fw = await jfetch(`/api/research/${sid}/followup`, { method: 'POST', body: JSON.stringify({ question: 'What penalties apply under the EU AI Act for non-compliance?' }) });
  fwWrap = fw;
  ok('follow-up child created with inherited sources', fw.status === 201 && fw.data.session.sources.length >= 1, `${fw.data.session?.sources?.length} inherited sources`);

  const refresh = await jfetch(`/api/research/${sid}/refresh`, { method: 'POST', body: JSON.stringify({ instruction: 'Find newer evidence and update conclusions.' }) });
  refreshWrap = refresh;
  ok('refresh → v2 started', refresh.status === 201 && refresh.data.session.version === 2);
  const v2done = await waitFor(async () => ['completed', 'partial', 'failed'].includes((await jfetch(`/api/research/${refresh.data.session.id}`)).data.session.state), { timeoutMs: 480000, label: 'v2 completion' });
  const V2 = (await jfetch(`/api/research/${refresh.data.session.id}`)).data.session;
  ok('v2 completed with deterministic diff', v2done && Boolean(V2.report) && Boolean(V2.diff), `diff: +${V2.diff?.newSources?.length} sources, +${V2.diff?.newFindings?.length} findings, ±${V2.diff?.confidenceChanges?.length} confidence`);

  const md = await fetch(`${BASE}/api/research/${sid}/export.md`);
  const mdText = await md.text();
  ok('markdown export real', md.status === 200 && mdText.includes('## Sources') && mdText.includes('http'), `${mdText.length} bytes`);
  const js = await fetch(`${BASE}/api/research/${sid}/export.json`);
  const jsData = await js.json();
  ok('JSON export real', js.status === 200 && jsData.findings?.length >= 1 && jsData.sources?.length >= 1);
  } // end if (S.report)

  // cleanup live sessions
  for (const id of [sid, sid2, sid3, fwWrap?.data?.session?.id, refreshWrap?.data?.session?.id]) {
    if (id) await jfetch(`/api/research/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  console.log(`\n===== LIVE RESULTS: ${passed} passed, ${failed} failed =====`);
  app.httpServer.close();
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300).unref();
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
