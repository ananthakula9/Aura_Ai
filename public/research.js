// Aura AI — public/research.js
// Frontend for Deep Research. Imported (and initialized) by app.js with
// explicit dependencies — one-way dependency, no circular imports, and no
// second chat system: research cards render into the existing conversation
// DOM, reuse the existing markdown renderer, and persist a summary message
// through the same conversation-storage path as normal chat.
//
// Surfaces:
//   - Composer: 🔍 research toggle + depth picker (Auto/Quick/Standard/Deep/Maximum)
//   - Plan card (in chat): editable questions, Start/Cancel
//   - Live activity: step list + real stats, driven ONLY by SSE research.* events
//   - Controls: Start / Pause / Resume / Stop / Report from partial — all real
//   - Report: TOC, collapsible sections, clickable [n] citations with source
//     cards + evidence quotes, findings (FACT/ANALYSIS/INFERENCE), comparison
//     tables, timelines, SVG charts (Download/Copy/Open data), conflicts,
//     limitations, sources, QC badge, Markdown export, print, follow-up research
//   - Activity drawer: right panel (desktop) / bottom sheet (mobile)
//   - Sidebar "Research" section: previous sessions, re-openable
//   - Topic discovery overlay

// ---- deps injected by app.js at init ----
let D = null;

// ---- research composer state ----
let researchOn = false;
let researchDepth = localStorage.getItem('aura_research_depth') || 'auto';
const DEPTHS = [
  { id: 'auto', name: 'Auto', desc: 'Aura picks the right depth for this question.' },
  { id: 'quick', name: 'Quick', desc: 'Few searches, small report, fast.' },
  { id: 'standard', name: 'Standard', desc: 'Multiple sources, cross-checking, structured findings.' },
  { id: 'deep', name: 'Deep', desc: 'Planning, multiple passes, verification, conflicts, charts.' },
  { id: 'maximum', name: 'Maximum', desc: 'Parallel branches, large evidence sets, full verification.' },
];

// ---- live sessions being watched (id -> { es, ui, session, reportCard }) ----
const watched = new Map();

const STEP_DEFS = [
  { id: 'understand', label: 'Understanding request' },
  { id: 'plan', label: 'Building research plan' },
  { id: 'discover', label: 'Discovering sources' },
  { id: 'read', label: 'Reading sources & extracting evidence' },
  { id: 'verify', label: 'Verifying claims' },
  { id: 'analyze', label: 'Analyzing evidence' },
  { id: 'report', label: 'Generating report' },
];

// Cumulative step states driven by real backend events only.
const EVENT_STEP = {
  'research.started': { understand: 'done', plan: 'done', discover: 'active' },
  'research.planning': { understand: 'done', plan: 'active' },
  'research.plan_created': { understand: 'done', plan: 'done' },
  'research.search_completed': { discover: 'active' },
  'research.search_failed': { discover: 'active' },
  'research.source_opened': { discover: 'done', read: 'active' },
  'research.source_failed': { discover: 'done', read: 'active' },
  'research.evidence_extracted': { read: 'active' },
  'research.question_started': { read: 'active' },
  'research.question_done': { read: 'active' },
  'research.gap_analysis': { read: 'active' },
  'research.gap_identified': { read: 'active' },
  'research.refining': { read: 'active' },
  'research.verification_started': { read: 'done', verify: 'active' },
  'research.conflict_found': { verify: 'active' },
  'research.verification_done': { verify: 'done' },
  'research.analysis_started': { verify: 'done', analyze: 'active' },
  'research.chart_created': { analyze: 'active' },
  'research.analysis_done': { analyze: 'done' },
  'research.report_started': { analyze: 'done', report: 'active' },
  'research.report_ready': { report: 'active' },
  'research.qc_started': { report: 'active' },
  'research.qc_revision': { report: 'active' },
  'research.qc_done': { report: 'active' },
  'research.completed': { report: 'done' },
  'research.partially_completed': { report: 'done' },
};

const TERMINAL_EVENTS = ['research.completed', 'research.partially_completed', 'research.cancelled', 'research.failed'];

// ============================================================
// INIT
// ============================================================
function initResearch(deps) {
  D = deps;

  const toggle = document.getElementById('researchToggle');
  const pill = document.getElementById('researchDepthPill');
  const menu = document.getElementById('researchDepthMenu');
  const label = document.getElementById('researchDepthLabel');
  const shell = document.getElementById('inputShell');
  const input = document.getElementById('userInput');

  function renderDepthLabel() {
    const d = DEPTHS.find(x => x.id === researchDepth) || DEPTHS[0];
    label.textContent = `Research · ${d.name}`;
  }
  function renderDepthMenu() {
    menu.innerHTML = '';
    DEPTHS.forEach(d => {
      const item = document.createElement('div');
      item.className = 'research-depth-item' + (d.id === researchDepth ? ' active' : '');
      item.innerHTML = `<span class="depth-name">${d.name}</span><span class="depth-desc">${d.desc}</span>`;
      item.addEventListener('click', () => {
        researchDepth = d.id;
        localStorage.setItem('aura_research_depth', d.id);
        renderDepthLabel();
        menu.classList.remove('open');
      });
      menu.appendChild(item);
    });
  }

  function setResearchMode(on) {
    researchOn = on;
    toggle.classList.toggle('on', on);
    shell.classList.toggle('research-on', on);
    input.placeholder = on ? 'Ask Aura to research anything…' : 'Message Aura AI...';
  }

  toggle.addEventListener('click', () => setResearchMode(!researchOn));
  pill.addEventListener('click', (e) => { e.stopPropagation(); renderDepthMenu(); menu.classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (!pill.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCitePop(); menu.classList.remove('open'); }
  });
  renderDepthLabel();

  const drawer = document.getElementById('rsDrawer');
  document.getElementById('rsDrawerClose').addEventListener('click', () => drawer.classList.remove('open'));

  const topicsOverlay = document.getElementById('rsTopicsOverlay');
  document.getElementById('rsSuggestTopics').addEventListener('click', openTopics);
  document.getElementById('rsTopicsClose').addEventListener('click', () => topicsOverlay.classList.remove('open'));
  topicsOverlay.addEventListener('click', (e) => { if (e.target === topicsOverlay) topicsOverlay.classList.remove('open'); });

  refreshResearchSidebar();
}

function isResearchMode() { return researchOn; }

// ============================================================
// API HELPERS
// ============================================================
async function apiPost(path, body) {
  try {
    const res = await D.apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { message: 'Could not reach the server.' } }; }
}
async function apiGet(path) {
  try {
    const res = await D.apiFetch(path);
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { message: 'Could not reach the server.' } }; }
}
async function apiPatch(path, body) {
  try {
    const res = await D.apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { message: 'Could not reach the server.' } }; }
}

// ============================================================
// SEND FLOW
// ============================================================
async function handleResearchSend(text, attachments, helpers) {
  if (!text) return;
  helpers.clearComposer();
  helpers.showLoading();

  let outcome;
  try {
    const res = await D.apiFetch('/api/research', {
      method: 'POST',
      body: JSON.stringify({
        query: text,
        mode: researchDepth,
        attachments: (attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, dataBase64: a.dataBase64 })),
      }),
    });
    outcome = { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    outcome = { ok: false, data: { message: 'Could not reach the server. Check your connection and try again.' } };
  }
  helpers.hideLoading();

  if (outcome.ok && outcome.data.session) {
    renderPlanCard(outcome.data.session, text, null);
    refreshResearchSidebar();
    return;
  }
  D.addErrorCard('Could not start research', outcome.data.message || 'Try rephrasing the request.', null);
}

function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function truncatePlain(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function escTruncate(s, n) { return D.escapeHtml(truncatePlain(s, n)); }

// ============================================================
// PLAN CARD
// ============================================================
// Renders into `existingWrap` when provided (restored sessions), otherwise
// appends a fresh message row to the conversation.
function renderPlanCard(session, originalQuery, existingWrap) {
  let wrap = existingWrap;
  if (!wrap) {
    D.ensureConversationStarted();
    wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = `<div class="avatar aura-ring aura-1">A</div><div class="bubble-col" style="max-width:100%;"></div>`;
    D.conversationInner.appendChild(wrap);
  } else {
    wrap.querySelector('.bubble-col').innerHTML = '';
  }
  const col = wrap.querySelector('.bubble-col');

  const card = document.createElement('div');
  card.className = 'rs-card';
  col.appendChild(card);
  if (!existingWrap) D.scrollToBottom();

  const state = { editing: false, snapshot: null, questions: session.plan.questions.map(q => ({ ...q })) };
  render();

  function render() {
    const modeLabel = session.mode === 'auto' ? `Auto → ${cap(session.effectiveMode)}` : cap(session.effectiveMode);
    const startLabel = session.state === 'paused' ? 'Resume Research' : 'Start Research';
    card.innerHTML = `
      <div class="rs-card-head">
        <span class="rs-badge">Research Plan</span>
        <span class="rs-card-title">${D.escapeHtml(session.plan.objective)}</span>
      </div>
      <div class="rs-card-body">
        ${session.attachments?.length ? `<div class="rs-scope-row"><span class="rs-scope-chip">📎 ${session.attachments.length} file${session.attachments.length > 1 ? 's' : ''}: ${D.escapeHtml(session.attachments.map(a => a.filename).join(', '))}</span></div>` : ''}
        ${session.plan.scope.regions.length || session.plan.scope.timeframe ? `<div class="rs-scope-row">${session.plan.scope.regions.map(r => `<span class="rs-scope-chip">${D.escapeHtml(r)}</span>`).join('')}${session.plan.scope.timeframe ? `<span class="rs-scope-chip">${D.escapeHtml(session.plan.scope.timeframe)}</span>` : ''}</div>` : ''}
        <div class="rs-questions"></div>
        <div class="rs-card-actions">
          ${state.editing
            ? `<button class="rs-btn primary" data-act="save">Save plan</button>
               <button class="rs-btn" data-act="cancel-edit">Cancel</button>`
            : `<button class="rs-btn primary" data-act="start">${startLabel}</button>
               <button class="rs-btn" data-act="edit">Edit Plan</button>
               <button class="rs-btn" data-act="addq">Add Question</button>
               <button class="rs-btn danger" data-act="discard">${session.state === 'created' ? 'Cancel' : 'Delete'}</button>`}
          <span class="rs-mode-note">Depth: ${modeLabel} · ${session.plan.questions.length} question${session.plan.questions.length === 1 ? '' : 's'}</span>
        </div>
      </div>`;

    const qWrap = card.querySelector('.rs-questions');
    state.questions.forEach((q, i) => {
      const row = document.createElement('div');
      row.className = 'rs-question' + (state.editing ? ' editing' : '');
      if (state.editing) {
        row.innerHTML = `<span class="q-idx">${i + 1}</span><input class="q-text" value="${D.escapeHtml(q.text)}"><button class="q-remove" title="Remove question">✕</button>`;
        row.querySelector('.q-remove').addEventListener('click', () => {
          if (state.questions.length <= 1) return; // always at least one
          state.questions = state.questions.filter(x => x.id !== q.id);
          render();
        });
      } else {
        const status = q.status === 'researched' ? '<span class="q-status ok">✓ researched</span>'
          : q.status === 'not_found' ? '<span class="q-status miss">no evidence found</span>'
          : '<span class="q-status">—</span>';
        row.innerHTML = `<span class="q-idx">${i + 1}</span><span class="q-text">${D.escapeHtml(q.text)}</span>${status}`;
      }
      qWrap.appendChild(row);
    });
    if (state.editing) {
      const add = document.createElement('button');
      add.className = 'rs-add-q';
      add.textContent = '+ Add question';
      add.addEventListener('click', () => {
        state.questions.push({ id: 'q_new_' + Date.now(), text: '' });
        render();
        const inputs = card.querySelectorAll('.q-text');
        inputs[inputs.length - 1]?.focus();
      });
      qWrap.appendChild(add);
    }

    card.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'edit' || act === 'addq') {
          state.snapshot = state.questions.map(q => ({ ...q }));
          state.editing = true;
          if (act === 'addq') state.questions.push({ id: 'q_new_' + Date.now(), text: '' });
          render();
          const inputs = card.querySelectorAll('.q-text');
          (act === 'addq' ? inputs[inputs.length - 1] : inputs[0])?.focus();
          return;
        }
        if (act === 'cancel-edit') {
          state.questions = state.snapshot || state.questions;
          state.editing = false;
          render();
          return;
        }
        if (act === 'save') {
          const questions = [...card.querySelectorAll('.rs-question .q-text')].map(i => i.value.trim()).filter(Boolean);
          if (questions.length === 0) { D.toast?.('Keep at least one question.'); return; }
          const r = await apiPatch(`/api/research/${session.id}/plan`, { questions });
          if (!r.ok) { D.toast?.(r.data.message || 'Could not save the plan.'); return; }
          Object.assign(session, r.data.session);
          state.questions = session.plan.questions.map(q => ({ ...q }));
          state.editing = false;
          render();
          refreshResearchSidebar();
          return;
        }
        if (act === 'discard') {
          await D.apiFetch(`/api/research/${session.id}`, { method: 'DELETE' });
          wrap.remove();
          refreshResearchSidebar();
          return;
        }
        if (act === 'start') {
          btn.disabled = true;
          const endpoint = session.state === 'paused' ? 'resume' : 'start';
          const r = await apiPost(`/api/research/${session.id}/${endpoint}`, {});
          if (!r.ok) { btn.disabled = false; D.toast?.(r.data.message || 'Could not start.'); return; }
          session.state = session.state === 'paused' ? 'researching' : 'researching'; // SSE snapshot corrects if needed
          renderActivityCard(session, wrap);
          watchSession(session.id);
          openDrawer(session);
          return;
        }
      });
    });
  }
}

// ============================================================
// ACTIVITY CARD (live state)
// ============================================================
function renderActivityCard(session, wrap) {
  const col = wrap.querySelector('.bubble-col');
  col.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'rs-card';
  col.appendChild(card);

  const ui = {
    session, card, wrap,
    steps: {}, stats: { ...blankStats(), ...(session.stats || {}) },
    lastEvent: null, feed: [],
    render() { renderActivityInner(ui); },
  };
  watched.set(session.id, { ...(watched.get(session.id) || {}), ui, session });

  ui.render();
  D.scrollToBottom();
}

function blankStats() {
  return { searches: 0, sourcesFound: 0, sourcesReviewed: 0, sourcesFailed: 0, claimsExtracted: 0, claimsVerified: 0, conflictsFound: 0, chartsCreated: 0 };
}

function renderActivityInner(ui) {
  const s = ui.session;
  const stepsHtml = STEP_DEFS.map(st => {
    const cls = ui.steps[st.id] || '';
    const sub = st.id === 'read' && ui.stats.sourcesReviewed ? `${ui.stats.sourcesReviewed} read`
      : st.id === 'discover' && ui.stats.sourcesFound ? `${ui.stats.sourcesFound} found` : '';
    return `<div class="rs-step ${cls}" data-step="${st.id}"><span class="step-dot"></span><span>${st.label}</span><span class="step-sub">${sub}</span></div>`;
  }).join('');

  const badge = stateBadge(s.state);
  const controls = controlsFor(s);

  ui.card.innerHTML = `
    <div class="rs-card-head">
      <span class="rs-badge ${badge.cls}">${badge.label}</span>
      <span class="rs-card-title">${D.escapeHtml(s.plan.objective)}</span>
    </div>
    <div class="rs-card-body">
      <div class="rs-current">${ui.lastEvent ? currentLine(ui.lastEvent) : 'Preparing…'}</div>
      <div class="rs-steps">${stepsHtml}</div>
      <div class="rs-stats">
        ${statCell(ui.stats.sourcesFound, 'Sources found')}
        ${statCell(ui.stats.sourcesReviewed, 'Reviewed')}
        ${statCell(ui.stats.claimsExtracted, 'Claims')}
        ${statCell(ui.stats.claimsVerified, 'Verified')}
        ${statCell(ui.stats.conflictsFound, 'Conflicts')}
        ${statCell(ui.stats.chartsCreated, 'Charts')}
      </div>
      ${s.errors?.length ? `<div class="rs-error-note">${s.errors.length} issue${s.errors.length === 1 ? '' : 's'} so far — research continues with the sources that work.</div>` : ''}
      <div class="rs-card-actions">${controls.html}</div>
    </div>`;

  controls.wire(ui.card, ui);
  const drawer = document.getElementById('rsDrawer');
  if (drawer?.classList.contains('open') && drawer.dataset.sessionId === s.id) renderDrawerFor(s.id);
}

function statCell(v, k) { return `<div class="rs-stat"><div class="v">${v ?? 0}</div><div class="k">${k}</div></div>`; }

function stateBadge(state) {
  switch (state) {
    case 'completed': return { cls: 'state-done', label: 'Research Complete' };
    case 'partial': return { cls: 'state-done', label: 'Partially Completed' };
    case 'paused': return { cls: 'state-paused', label: 'Paused' };
    case 'cancelled': return { cls: 'state-stopped', label: 'Stopped' };
    case 'failed': return { cls: 'state-stopped', label: 'Failed' };
    default: return { cls: 'state-running', label: 'Researching' };
  }
}

function controlsFor(s) {
  const running = ['researching', 'verifying', 'analyzing', 'reporting', 'planning'].includes(s.state);
  const paused = s.state === 'paused';
  const stopped = ['cancelled', 'failed'].includes(s.state);
  const hasEvidence = (s.stats?.claimsExtracted || 0) > 0;

  let html = '';
  if (running) html += `<button class="rs-btn" data-act="pause">⏸ Pause</button><button class="rs-btn danger" data-act="stop">■ Stop</button>`;
  if (paused) html += `<button class="rs-btn primary" data-act="resume">▶ Resume</button><button class="rs-btn danger" data-act="stop">■ Stop</button>`;
  if (stopped && hasEvidence && !s.report) html += `<button class="rs-btn primary" data-act="partial-report">Generate report from collected evidence</button>`;
  html += `<button class="rs-btn" data-act="view-sources">View sources</button><button class="rs-btn" data-act="view-plan">View plan</button>`;

  return {
    html,
    wire(card, ui) {
      card.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          btn.disabled = true;
          if (act === 'pause') { await apiPost(`/api/research/${ui.session.id}/pause`, {}); return; }
          if (act === 'resume' || act === 'start') {
            const r = await apiPost(`/api/research/${ui.session.id}/resume`, {});
            if (!r.ok) { btn.disabled = false; D.toast?.(r.data.message || 'Could not resume.'); return; }
            ui.session.state = 'researching';
            watchSession(ui.session.id);
            ui.render();
            return;
          }
          if (act === 'stop') { await apiPost(`/api/research/${ui.session.id}/stop`, {}); return; }
          if (act === 'partial-report') {
            const r = await apiPost(`/api/research/${ui.session.id}/report-from-partial`, {});
            if (!r.ok) { btn.disabled = false; D.toast?.(r.data.message || 'Could not generate.'); return; }
            ui.session.state = 'reporting';
            watchSession(ui.session.id);
            ui.render();
            return;
          }
          btn.disabled = false;
          if (act === 'view-sources') showSourcesSheet(ui.session);
          if (act === 'view-plan') showPlanSheet(ui.session);
        });
      });
    },
  };
}

function currentLine(ev) {
  const t = ev.type.replace('research.', '').replace(/_/g, ' ');
  let detail = '';
  if (ev.type === 'research.search_completed') detail = `“${escTruncate(ev.data.query, 60)}” — ${ev.data.found} result${ev.data.found === 1 ? '' : 's'}`;
  else if (ev.type === 'research.source_opened') detail = escTruncate(ev.data.title || ev.data.url, 70);
  else if (ev.type === 'research.evidence_extracted') detail = `${ev.data.claims} claim${ev.data.claims === 1 ? '' : 's'} from source [${ev.data.source}]`;
  else if (ev.type === 'research.question_started') detail = escTruncate(ev.data.question, 80);
  else if (ev.type === 'research.question_done') detail = `${escTruncate(ev.data.question, 60)} — ${ev.data.status === 'researched' ? `${ev.data.evidence} evidence items` : 'no reliable evidence found'}`;
  else if (ev.type === 'research.conflict_found') detail = `conflicting figures: ${D.escapeHtml(ev.data.subject)}`;
  else if (ev.type === 'research.chart_created') detail = D.escapeHtml(ev.data.title);
  else if (ev.type === 'research.qc_done') detail = `quality score ${Math.round((ev.data.score || 0) * 100)}/100`;
  else if (ev.type === 'research.search_failed') detail = `${escTruncate(ev.data.query, 50)} — will continue with other searches`;
  return `<span class="cur-label">${cap(t)}</span>${detail ? ` — ${detail}` : ''}`;
}

// ============================================================
// SSE WATCHER — the ONLY driver of live UI updates
// ============================================================
function watchSession(sessionId) {
  const existing = watched.get(sessionId);
  if (existing?.es) return;

  const es = new EventSource(`/api/research/${sessionId}/events`);
  watched.set(sessionId, { ...(existing || {}), es });

  es.addEventListener('research', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    onResearchEvent(sessionId, ev);
  });
  es.addEventListener('snapshot', (e) => {
    try {
      const snap = JSON.parse(e.data);
      const w = watched.get(sessionId);
      if (w?.ui && snap.state && !w.ui.session.report) {
        w.ui.session.state = snap.state;
        w.ui.render();
      }
    } catch { /* ignore */ }
  });
  es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
}

function onResearchEvent(sessionId, ev) {
  const w = watched.get(sessionId);
  if (w?.ui && w.ui.wrap.isConnected && !w.session?.report) {
    const stepMap = EVENT_STEP[ev.type];
    if (stepMap) for (const [k, v] of Object.entries(stepMap)) w.ui.steps[k] = v;
    w.ui.lastEvent = ev;
    if (ev.type === 'research.search_completed' || ev.type === 'research.search_failed') w.ui.stats.searches = (w.ui.stats.searches || 0) + 1;
    if (ev.type === 'research.evidence_extracted') w.ui.stats.claimsExtracted = (w.ui.stats.claimsExtracted || 0) + ev.data.claims;
    if (ev.type === 'research.conflict_found') w.ui.stats.conflictsFound = (w.ui.stats.conflictsFound || 0) + 1;
    if (ev.type === 'research.chart_created') w.ui.stats.chartsCreated = (w.ui.stats.chartsCreated || 0) + 1;
    if (ev.type === 'research.verification_done') w.ui.stats.claimsVerified = ev.data.verified || 0;
    if (ev.type === 'research.source_opened') w.ui.stats.sourcesReviewed = (w.ui.stats.sourcesReviewed || 0) + 1;
    if (ev.type === 'research.source_failed') w.ui.stats.sourcesFailed = (w.ui.stats.sourcesFailed || 0) + 1;
    if (w.session) w.ui.stats.sourcesFound = w.session.sources?.length ?? w.ui.stats.sourcesFound;
    w.ui.feed = [...(w.ui.feed || []), ev].slice(-40);
    if (ev.type === 'research.paused') w.ui.session.state = 'paused';
    if (ev.type === 'research.cancelled') w.ui.session.state = 'cancelled';
    w.ui.render();
  } else if (w?.ui) {
    // Card still mounted but report exists (report-from-partial flow):
    // refresh stats-driven activity only.
    w.ui.lastEvent = ev;
  }
  refreshResearchSidebarThrottled();

  if (TERMINAL_EVENTS.includes(ev.type)) {
    if (w?.es) { w.es.close(); w.es = null; }
    finalizeSession(sessionId, ev);
  }
}

async function finalizeSession(sessionId, ev) {
  const { ok, data } = await apiGet(`/api/research/${sessionId}`);
  const w = watched.get(sessionId);
  if (!ok || !data.session) {
    refreshResearchSidebar();
    return;
  }
  const session = data.session;
  if (w?.ui && w.ui.wrap.isConnected) {
    if (session.report && ['completed', 'partial'].includes(session.state)) {
      renderReportCard(session, w.ui.wrap);
      persistSummary(session);
    } else {
      w.session = session;
      w.ui.session = session;
      w.ui.stats = { ...blankStats(), ...session.stats };
      w.ui.render();
    }
  }
  refreshResearchSidebar();
  updateDrawerDone(sessionId, session);
}

// Persist a compact summary message into the conversation so research is
// visible in saved history (full report stays in the session).
function persistSummary(session) {
  if (!session.report) return;
  const top = session.report.sections.find(s => s.kind === 'executive-summary');
  const summary = [
    `🔍 **Deep Research complete: ${session.report.title}**`,
    top ? top.body.slice(0, 700) : '',
    `_${session.stats.sourcesReviewed || 0} sources reviewed · ${session.stats.claimsExtracted || 0} claims · ${session.stats.conflictsFound || 0} conflicts · QC ${Math.round((session.qc?.score || 0) * 100)}/100_`,
  ].filter(Boolean).join('\n\n');
  D.persistMessage?.('assistant', summary);
}

// ============================================================
// REPORT CARD
// ============================================================
function renderReportCard(session, wrap) {
  const col = wrap.querySelector('.bubble-col');
  col.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'rs-card';
  col.appendChild(card);
  buildReportInto(card, session);
  D.scrollToBottom();
  watched.set(session.id, { ...(watched.get(session.id) || {}), reportCard: card, session });
}

function buildReportInto(card, session) {
  const r = session.report;
  const badge = stateBadge(session.state);
  const flagged = session.qc?.checks?.filter(c => !c.pass) || [];

  card.innerHTML = `
    <div class="rs-card-head">
      <span class="rs-badge ${badge.cls}">${badge.label}</span>
      ${session.version > 1 ? `<span class="rs-version-badge">v${session.version}</span>` : ''}
      <span class="rs-card-title">${D.escapeHtml(r.title)}</span>
    </div>
    <div class="rs-card-body">
      <div class="rs-scope-row">
        <span class="rs-scope-chip">${cap(session.effectiveMode)} mode</span>
        <span class="rs-scope-chip">${session.stats.sourcesReviewed || 0} sources</span>
        <span class="rs-scope-chip">${session.stats.claimsExtracted || 0} claims</span>
        ${session.stats.conflictsFound ? `<span class="rs-scope-chip">${session.stats.conflictsFound} conflict${session.stats.conflictsFound > 1 ? 's' : ''}</span>` : ''}
        ${session.intent ? `<span class="rs-scope-chip" title="Auto-detected">${D.escapeHtml(cap(session.intent.complexity))} · ${D.escapeHtml(cap(session.intent.topicType))}</span>` : ''}
        ${session.parentId && session.version > 1 ? `<span class="rs-scope-chip">refreshed research</span>` : ''}
      </div>
      ${session.diff ? diffHtml(session.diff) : ''}
      <div class="rs-toc">${r.sections.map((s, i) => `<a data-sec="sec${i}">${String(i + 1).padStart(2, '0')} ${D.escapeHtml(s.heading)}</a>`).join('')}</div>
      <div class="rs-sections"></div>
      <div class="rs-qc-row">
        <span class="rs-qc-score">QC ${Math.round((session.qc?.score ?? 0) * 100)}/100${session.qc?.overallLabel ? ` · ${session.qc.overallLabel}` : ''}</span>
        <span class="rs-qc-note">citation coverage ${Math.round((session.qc?.citationCoverage ?? 1) * 100)}%${flagged.length ? ` · flagged: ${flagged.map(c => c.name).join(', ')}` : ' · all checks passed'}</span>
        <button class="rs-mini-btn" data-ract="quality-tab">Full quality breakdown</button>
      </div>
      <div class="rs-footer-actions">
        <a class="rs-btn" href="/api/research/${session.id}/export.md" download style="text-decoration:none;">⬇ Markdown</a>
        <a class="rs-btn" href="/api/research/${session.id}/export.json" download style="text-decoration:none;" title="Structured data (findings, evidence, sources, charts) for further analysis">⬇ JSON</a>
        <button class="rs-btn" data-ract="print">🖨 Print / PDF</button>
        <button class="rs-btn" data-ract="copy">Copy report</button>
        <button class="rs-btn" data-ract="sources">View sources</button>
        <button class="rs-btn ${session.challenge ? '' : 'danger'}" data-ract="challenge" ${session.challenge ? 'disabled title="Challenge already run"' : 'title="Search for opposing evidence and test the conclusions"'}>${session.challenge ? '✓ Challenged' : '⚔ Challenge My Research'}</button>
        <button class="rs-btn" data-ract="refresh" title="Create the next research version with newer evidence">⟳ Find newer evidence</button>
      </div>
      <div class="rs-content-row">
        <span class="rs-conf-label" style="margin-right:2px;">Create:</span>
        <button class="rs-mini-btn" data-cgen="quiz">Quiz</button>
        <button class="rs-mini-btn" data-cgen="notes">Study notes</button>
        <button class="rs-mini-btn" data-cgen="summary">Executive summary</button>
        <button class="rs-mini-btn" data-cgen="article">Article</button>
      </div>
      <div class="rs-followup-row">
        <input class="rs-followup-input" placeholder="Research further: ask a follow-up question…" maxlength="1000">
        <button class="rs-btn primary" data-ract="followup">Research</button>
      </div>
    </div>`;

  const sectionsEl = card.querySelector('.rs-sections');
  r.sections.forEach((s, i) => sectionsEl.appendChild(buildSection(s, i, session)));

  // Research map — visual graph of question → sources → findings.
  const findingsSec = r.sections.find(s => s.kind === 'findings');
  if (findingsSec) {
    const mapIdx = r.sections.indexOf(findingsSec);
    const mapEl = buildResearchMap(session);
    if (mapEl) sectionsEl.children[mapIdx]?.insertAdjacentElement('afterend', mapEl);
  }

  card.querySelectorAll('.rs-toc a').forEach(a => {
    a.addEventListener('click', () => {
      const target = card.querySelector(`[data-sec-target="${a.dataset.sec}"]`);
      if (target) {
        target.classList.remove('collapsed');
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  wireReportActions(card, session);
  wireCitations(card, session);
}

function wireReportActions(card, session) {
  card.querySelectorAll('[data-ract]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.ract;
      if (act === 'print') printReport(card);
      if (act === 'quality-tab') { drawerTab = 'quality'; openDrawer(session); }
      if (act === 'copy') {
        navigator.clipboard.writeText(reportToText(session)).then(() => {
          btn.textContent = '✓ Copied';
          setTimeout(() => (btn.textContent = 'Copy report'), 1500);
        });
      }
      if (act === 'sources') { drawerTab = 'sources'; openDrawer(session); }
      if (act === 'followup') {
        const input = card.querySelector('.rs-followup-input');
        const q = input.value.trim();
        if (!q) { input.focus(); return; }
        btn.disabled = true;
        const { ok, data } = await apiPost(`/api/research/${session.id}/followup`, { question: q });
        btn.disabled = false;
        if (!ok || !data.session) { D.toast?.(data.message || 'Could not start follow-up.'); return; }
        launchFollowupCard(data.session, q);
      }
      if (act === 'challenge') {
        btn.disabled = true;
        btn.textContent = '⚔ Challenging…';
        const { ok, data } = await apiPost(`/api/research/${session.id}/challenge`, {});
        if (!ok) { btn.disabled = false; btn.textContent = '⚔ Challenge My Research'; D.toast?.(data.message || 'Could not run the challenge.'); return; }
        const refreshed = await apiGet(`/api/research/${session.id}`);
        const wrap = card.closest('.msg');
        if (refreshed.ok && refreshed.data.session && wrap) {
          renderReportCard(refreshed.data.session, wrap);
          D.toast?.('Challenge complete — see the Adversarial Challenge section.');
        }
      }
      if (act === 'refresh') {
        btn.disabled = true;
        const { ok, data } = await apiPost(`/api/research/${session.id}/refresh`, { instruction: 'Find newer evidence and update conclusions.' });
        btn.disabled = false;
        if (!ok || !data.session) { D.toast?.(data.message || 'Could not start a new version.'); return; }
        launchFollowupCard(data.session, 'Refreshed research');
        watchSession(data.session.id);
      }
    });
  });

  // Content generation: quiz renders through the existing quiz card builder.
  card.querySelectorAll('[data-cgen]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.cgen;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Generating…';
      const { ok, data } = await apiPost(`/api/research/${session.id}/content`, { kind });
      btn.disabled = false;
      btn.textContent = label;
      if (!ok || !data.content) { D.toast?.(data.message || 'Could not generate.'); return; }
      showArtifactModal(kind, data.content, session);
    });
  });
}

function diffHtml(diff) {
  return `
  <div class="rs-diff">
    <div class="rs-diff-title">What changed since v${diff.fromVersion}</div>
    ${diff.newSources.slice(0, 5).map(s => `<div class="rs-diff-row add">New source: ${D.escapeHtml(truncatePlain(s.title, 70))}</div>`).join('')}
    ${diff.newSources.length > 5 ? `<div class="rs-diff-row add">…and ${diff.newSources.length - 5} more new sources</div>` : ''}
    ${diff.newFindings.slice(0, 4).map(f => `<div class="rs-diff-row add">New finding (${f.type}): ${D.escapeHtml(truncatePlain(f.statement, 90))}</div>`).join('')}
    ${diff.removedFindings.slice(0, 3).map(f => `<div class="rs-diff-row del">No longer supported: ${D.escapeHtml(truncatePlain(f, 90))}</div>`).join('')}
    ${diff.confidenceChanges.map(c => `<div class="rs-diff-row chg">Confidence ${c.from} → ${c.to}: ${D.escapeHtml(truncatePlain(c.statement, 80))}</div>`).join('')}
    ${diff.newSources.length + diff.newFindings.length + diff.removedFindings.length + diff.confidenceChanges.length === 0 ? '<div class="rs-diff-row">No material changes found vs the previous version.</div>' : ''}
  </div>`;
}

function showArtifactModal(kind, content, session) {
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:16px;">${D.escapeHtml(content.title || kind)}</h2>
      <button class="icon-btn">✕</button>
    </div>
    <div class="rs-artifact-modal-body" data-role="body"></div>
    <div style="font-size:11px; color:var(--text-faint); margin-top:10px;">Generated from this research — citations refer to the report's sources.</div>`);
  const body = overlay.querySelector('[data-role="body"]');
  if (kind === 'quiz' && D.buildQuizCard) {
    const quizCard = D.buildQuizCard(content);
    if (quizCard) body.appendChild(quizCard);
    else body.textContent = 'Quiz could not be rendered.';
  } else {
    body.innerHTML = withCitations(D.renderMarkdown(content.body || ''));
    wireCitations(body, session);
  }
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
}

// ---- research map: question → sources → findings SVG ----
function buildResearchMap(session) {
  const questions = (session.plan?.questions || []).slice(0, 6);
  const findings = (session.findings || []).slice(0, 6);
  const sources = (session.sources || []).filter(s => s.status === 'used').slice(0, 8);
  if (questions.length === 0 || (sources.length === 0 && findings.length === 0)) return null;

  const c = chartColors();
  const W = 600;
  const qH = 34, sH = 26, fH = 34;
  const colQ = 190, colS = 380, colF = 560;
  const height = Math.max(questions.length * qH + 30, sources.length * sH + 30, findings.length * fH + 30) + 20;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': 'Research map' });

  const heads = [['Questions', 10], ['Sources', colS - 90], ['Findings', colF - 80]];
  for (const [label, x] of heads) {
    const t = svgEl('text', { x, y: 16, fill: c.faint, 'font-size': 10, 'font-weight': 700, 'text-transform': 'uppercase' });
    t.textContent = label.toUpperCase();
    svg.appendChild(t);
  }

  const qY = (i) => 34 + i * qH + qH / 2;
  const sY = (i) => 34 + i * sH + sH / 2;
  const fY = (i) => 34 + i * fH + fH / 2;

  const node = (x, y, w, text, fill, textColor) => {
    const rect = svgEl('rect', { x, y: y - 12, width: w, height: 24, rx: 6, fill, opacity: 0.9 });
    svg.appendChild(rect);
    const t = svgEl('text', { x: x + 8, y: y + 3.5, fill: textColor, 'font-size': 9.5 });
    t.textContent = truncatePlain(text, Math.floor((w - 14) / 5.2));
    svg.appendChild(t);
  };

  questions.forEach((q, i) => node(10, qY(i), colQ - 30, `${i + 1}. ${q.text}`, 'rgba(139,92,246,0.16)', c.text));
  sources.forEach((s, i) => node(colS - 90, sY(i), 170, s.domain || s.title, 'rgba(56,189,248,0.13)', c.text));
  findings.forEach((f, i) => node(colF - 80, fY(i), 150, `${f.type}: ${f.statement}`, f.type === 'fact' ? 'rgba(74,222,128,0.13)' : f.type === 'inference' ? 'rgba(251,191,36,0.13)' : 'rgba(139,92,246,0.1)', c.text));

  // edges: question → its evidence's sources; source → findings citing it
  const srcIndexByN = new Map(sources.map((s, i) => [s.n, i]));
  questions.forEach((q, qi) => {
    const srcNs = new Set((session.evidence || []).filter(e => e.questionId === q.id).map(e => e.sourceN));
    srcNs.forEach(n => {
      const si = srcIndexByN.get(n);
      if (si === undefined) return;
      svg.appendChild(svgEl('path', { d: `M ${colQ - 30} ${qY(qi)} C ${colQ + 10} ${qY(qi)}, ${colS - 130} ${sY(si)}, ${colS - 90} ${sY(si)}`, fill: 'none', stroke: c.border, 'stroke-width': 1 }));
    });
  });
  findings.forEach((f, fi) => {
    f.citations.forEach(n => {
      const si = srcIndexByN.get(n);
      if (si === undefined) return;
      svg.appendChild(svgEl('path', { d: `M ${colS + 80} ${sY(si)} C ${colS + 120} ${sY(si)}, ${colF - 120} ${fY(fi)}, ${colF - 80} ${fY(fi)}`, fill: 'none', stroke: c.aura2, 'stroke-width': 1, opacity: 0.5 }));
    });
  });

  const wrap = document.createElement('div');
  wrap.className = 'rs-map';
  wrap.appendChild(svg);
  const legend = document.createElement('div');
  legend.className = 'rs-map-legend';
  legend.innerHTML = `<span>◼ questions → their evidence sources</span><span style="color:var(--aura-2);">— sources → the findings they support</span>`;
  wrap.appendChild(legend);
  return wrap;
}

function launchFollowupCard(session, question) {
  D.ensureConversationStarted();
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = `<div class="avatar aura-ring aura-1">A</div><div class="bubble-col" style="max-width:100%;"></div>`;
  D.conversationInner.appendChild(wrap);
  renderPlanCard(session, question, wrap);
  const startBtn = wrap.querySelector('[data-act="start"]');
  if (startBtn) startBtn.click();
  D.scrollToBottom();
}

function buildSection(s, i, session) {
  const sec = document.createElement('div');
  sec.className = 'rs-section';
  sec.dataset.secTarget = `sec${i}`;

  const head = document.createElement('div');
  head.className = 'rs-section-head';
  const regenerable = typeof s.body === 'string' && s.body && ['executive-summary', 'background', 'landscape', 'risks', 'outlook', 'conclusion', 'methodology', 'recommendations', 'opportunities'].includes(s.kind);
  head.innerHTML = `<span class="rs-section-num">${String(i + 1).padStart(2, '0')}</span><span class="rs-section-title">${D.escapeHtml(s.heading)}</span>
    ${regenerable ? `<span class="rs-section-tools">
      <button class="rs-mini-btn" data-sact="regen" title="Rewrite this section from the same evidence">↻</button>
      <button class="rs-mini-btn" data-sact="simplify" title="Rewrite for a non-expert reader">✎</button>
      <button class="rs-mini-btn" data-sact="ask" title="Ask Aura about this section">?</button>
    </span>` : ''}
    <span class="rs-section-caret">▾</span>`;
  head.addEventListener('click', (e) => { if (!e.target.closest('[data-sact]')) sec.classList.toggle('collapsed'); });
  sec.appendChild(head);

  // Section tools (V2): real regenerate/simplify model passes + Ask Aura.
  if (regenerable) {
    head.querySelectorAll('[data-sact]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.dataset.sact === 'ask') {
          const input = document.getElementById('userInput');
          input.value = `About this section of my research "${session.report.title}" — ${s.heading}: "${session.report.sections[i].body.slice(0, 400)}…" — `;
          input.focus();
          input.dispatchEvent(new Event('input'));
          return;
        }
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '…';
        const { ok, data } = await apiPost(`/api/research/${session.id}/section/${s.kind}`, {
          action: btn.dataset.sact === 'regen' ? 'regenerate' : 'simplify',
        });
        btn.disabled = false;
        btn.textContent = original;
        if (!ok) { D.toast?.(data.message || 'Could not revise the section.'); return; }
        Object.assign(session, data.session);
        const wrap = sec.closest('.msg');
        if (wrap) renderReportCard(session, wrap);
      });
    });
  }

  const body = document.createElement('div');
  body.className = 'rs-section-body';

  if (typeof s.body === 'string' && s.body) {
    body.innerHTML = withCitations(D.renderMarkdown(s.body));
  }

  if (s.kind === 'findings') {
    for (const f of session.findings || []) body.appendChild(buildFinding(f, session));
    for (const ch of session.charts || []) body.appendChild(buildChart(ch, session));
    // Dataset analyses (V2 Data Analyst Agent).
    for (const ds of session.datasets || []) body.appendChild(buildDatasetSummary(ds, session));
  }
  if (s.kind === 'comparison') {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'rs-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'rs-table';
    tbl.innerHTML = `<thead><tr>${s.columns.map(c => `<th>${D.escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>${s.rows.map((row, ri) => `<tr>${row.map(cell => `<td>${withCitations(D.renderMarkdown(cell))}${(s.cellCitations?.[String(ri)] || []).map(n => citeChip(n)).join(' ')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    wrapEl.appendChild(tbl);
    body.appendChild(wrapEl);
    if (s.note) { const p = document.createElement('p'); p.textContent = s.note; body.appendChild(p); }
  }
  if (s.kind === 'timeline') {
    const tl = document.createElement('div');
    tl.className = 'rs-timeline';
    for (const ev of s.events) {
      const item = document.createElement('div');
      item.className = 'rs-tl-item';
      item.innerHTML = `<span class="rs-tl-dot"></span><span class="rs-tl-date">${D.escapeHtml(ev.date)}</span><span class="rs-tl-body"><span>${D.escapeHtml(ev.label)}</span>${ev.citation ? citeChip(ev.citation) : ''}${ev.description ? `<span class="tl-desc">${D.escapeHtml(ev.description)}</span>` : ''}</span>`;
      tl.appendChild(item);
    }
    body.appendChild(tl);
  }
  if (s.kind === 'conflicts') {
    for (const c of s.conflicts || []) {
      const div = document.createElement('div');
      div.className = 'rs-conflict';
      div.innerHTML = `
        <div class="rs-conflict-head">⚠ Conflicting evidence — ${D.escapeHtml(c.subject)}</div>
        <div class="rs-conflict-entries">
          ${c.entries.map(en => `<div class="rs-conflict-entry"><b>${D.escapeHtml(String(en.value) + (en.unit || ''))}</b> ${citeChip(en.sourceN)} <span class="src-ref">${D.escapeHtml(en.sourceTitle || '')}</span></div>`).join('')}
        </div>
        <div class="rs-conflict-why">${D.escapeHtml(c.explanation)}</div>`;
      body.appendChild(div);
    }
  }
  if (s.kind === 'challenge' && s.challenge) {
    for (const v of s.challenge.verdicts || []) {
      const div = document.createElement('div');
      div.className = 'rs-challenge-item';
      div.innerHTML = `
        <div class="rs-challenge-top">
          <span class="rs-challenge-verdict ${v.verdict}">${v.verdict}</span>
          <span class="rs-challenge-statement">${D.escapeHtml(v.statement)}</span>
        </div>
        <div class="rs-challenge-reason">${D.escapeHtml(v.reasoning)}</div>
        ${v.confidenceBefore !== v.confidenceAfter ? `<div class="rs-challenge-conf">confidence updated: ${D.escapeHtml(v.confidenceBefore)} → <b>${D.escapeHtml(v.confidenceAfter)}</b></div>` : ''}`;
      body.appendChild(div);
    }
    if (!(s.challenge.verdicts || []).length) {
      const p = document.createElement('p');
      p.textContent = 'Challenge ran, but no verdicts could be produced.';
      body.appendChild(p);
    }
  }
  if (s.kind === 'limitations') {
    const div = document.createElement('div');
    div.className = 'rs-limitations';
    for (const item of s.items || []) {
      const el = document.createElement('div');
      el.className = 'rs-limitation';
      el.textContent = item;
      div.appendChild(el);
    }
    body.appendChild(div);
  }
  if (s.kind === 'sources') {
    const grid = document.createElement('div');
    grid.className = 'rs-sources-grid';
    for (const src of s.sources || []) grid.appendChild(buildSourceCard(src, session));
    body.appendChild(grid);
  }

  sec.appendChild(body);
  return sec;
}

// Dataset summary card (V2 Data Analyst Agent) — deterministic stats table.
function buildDatasetSummary(ds, session) {
  const div = document.createElement('div');
  div.className = 'rs-chart';
  const numericCols = (ds.columns || []).filter(c => c.type === 'numeric' && c.stats);
  div.innerHTML = `
    <div class="rs-chart-head">
      <span class="rs-chart-title">📊 Dataset: ${D.escapeHtml(ds.name)}</span>
      <span class="rs-chart-meta">${ds.rowCount} rows · ${ds.columnCount} columns</span>
    </div>
    ${numericCols.length ? `<div class="rs-table-wrap"><table class="rs-table">
      <thead><tr><th>Column</th><th>Mean</th><th>Median</th><th>Min</th><th>Max</th><th>Std dev</th><th>Outliers</th></tr></thead>
      <tbody>${numericCols.map(c => `<tr><td>${D.escapeHtml(c.name)}</td><td>${c.stats.mean}</td><td>${c.stats.median}</td><td>${c.stats.min}</td><td>${c.stats.max}</td><td>${c.stats.stdev}</td><td>${c.stats.outliers.count}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}
    ${ds.groups ? `<div style="font-size:12px; color:var(--text-dim); margin:6px 0;">Group means for <b>${D.escapeHtml(ds.groups.measure)}</b> by <b>${D.escapeHtml(ds.groups.by)}</b>: ${ds.groups.entries.map(g => `${D.escapeHtml(g.label)}=${g.mean} (n=${g.n})`).join(' · ')}</div>` : ''}
    ${ds.trend ? `<div style="font-size:12px; color:var(--text-dim);">Trend — <b>${D.escapeHtml(ds.trend.valueColumn)}</b> over <b>${D.escapeHtml(ds.trend.dateColumn)}</b>: ${D.escapeHtml(ds.trend.direction)} (${ds.trend.firstValue} → ${ds.trend.lastValue}, ${ds.trend.method}).</div>` : ''}
    ${ds.notes?.length ? `<div class="rs-chart-note">${ds.notes.map(D.escapeHtml).join(' ')}</div>` : ''}`;
  return div;
}

function buildFinding(f, session) {
  const div = document.createElement('div');
  div.className = 'rs-finding';
  const linkedClaims = (f.claims || []).map(id => session.evidence.find(e => e.id === id)).filter(Boolean);
  div.innerHTML = `
    <div class="rs-finding-top">
      <span class="rs-finding-type ${f.type}">${f.type}</span>
      <span class="rs-finding-text">${D.escapeHtml(f.statement)}</span>
    </div>
    <div class="rs-finding-meta">
      <span class="rs-conf-label ${f.confidence}">${f.confidence} confidence</span>
      <span>${f.citations.map(n => citeChip(n)).join(' ')}</span>
      ${linkedClaims.length ? `<span class="rs-conf-label" title="Traceable to extracted evidence">🔗 ${linkedClaims.length} claim${linkedClaims.length === 1 ? '' : 's'}</span>` : ''}
      <div class="rs-claim-actions">
        <button class="rs-mini-btn" data-fact="evidence">Show evidence</button>
        <button class="rs-mini-btn" data-fact="sources">Show sources</button>
        <button class="rs-mini-btn" data-fact="further">Research further</button>
        <button class="rs-mini-btn" data-fact="copy">Copy</button>
      </div>
    </div>`;
  div.querySelectorAll('[data-fact]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.fact === 'sources') showEvidenceForSources(f.citations, session, f.statement);
      // V2 traceability chain: Finding → Claims → Evidence → Source.
      if (btn.dataset.fact === 'evidence') showFindingTrace(f, linkedClaims, session);
      if (btn.dataset.fact === 'copy') {
        navigator.clipboard.writeText(f.statement).then(() => { btn.textContent = '✓'; setTimeout(() => (btn.textContent = 'Copy'), 1200); });
      }
      if (btn.dataset.fact === 'further') {
        apiPost(`/api/research/${session.id}/followup`, { question: `Verify and go deeper on this finding: ${f.statement}` })
          .then(({ ok, data }) => {
            if (!ok || !data.session) { D.toast?.(data.message || 'Could not start follow-up research.'); return; }
            launchFollowupCard(data.session, f.statement);
          });
      }
    });
  });
  return div;
}

// The full traceability modal: Finding → supporting claims (with states)
// → evidence quotes → source links. One of the core V2 features.
function showFindingTrace(f, linkedClaims, session) {
  closeCitePop();
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:15px;">Evidence trace</h2>
      <button class="icon-btn">✕</button>
    </div>
    <div style="font-size:13px; color:var(--text); line-height:1.55; margin-bottom:12px;">
      <span class="rs-finding-type ${f.type}" style="margin-right:6px;">${f.type}</span>
      <b>${D.escapeHtml(f.statement)}</b>
      <span style="color:var(--text-faint); font-size:11.5px;"> — ${f.confidence} confidence</span>
    </div>
    ${linkedClaims.length ? linkedClaims.map(ev => `
      <div style="margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:7px; margin-bottom:3px;">
          ${ev.claimState ? `<span class="rs-claim-state ${ev.claimState.status}">${ev.claimState.status.replace(/_/g, ' ')}</span>` : ''}
          <span style="font-size:12px; color:var(--text);">${D.escapeHtml(ev.claim)}</span>
        </div>
        <div class="rs-evidence-quote" style="margin-left:8px;">“${D.escapeHtml(ev.quote.slice(0, 350))}”</div>
        <div style="font-size:11px; color:var(--text-faint);">from ${citeChip(ev.sourceN)} ${ev.claimState ? `· ${ev.claimState.independentConfirmation} independent source${ev.claimState.independentConfirmation === 1 ? '' : 's'}` : ''}</div>
      </div>`).join('') : '<div style="color:var(--text-faint); font-size:12.5px;">No claim-level links were computed for this finding — see the cited sources instead.</div>'}
  `);
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
  wireCitations(overlay, session);
}

function citeChip(n) { return `<span class="cite" data-n="${n}">${n}</span>`; }

// [n] in rendered markdown → clickable chip. Input is already HTML-escaped
// by renderMarkdown, so matching plain [digits] is safe here.
function withCitations(html) {
  return String(html).replace(/\[(\d{1,3})\]/g, (_, n) => `<span class="cite" data-n="${n}">${n}</span>`);
}

function buildSourceCard(src, session) {
  const div = document.createElement('div');
  div.className = 'rs-source-card';
  const tierCls = src.tier === 1 ? 't1' : src.tier === 2 ? 't2' : 't3';
  const authority = src.tier === 1 ? 'Very High' : src.tier === 2 ? 'High' : 'Medium';
  const supports = (session.findings || []).filter(f => f.citations.includes(src.n)).length;
  const contradicts = (session.conflicts || []).filter(c => c.entries.some(en => en.sourceN === src.n)).length;
  div.innerHTML = `
    <div class="rs-source-name">${src.n}. ${D.escapeHtml(src.title)}</div>
    <div class="rs-source-meta">
      ${sourceStars(src.tier)}
      <span class="tier-badge ${tierCls}">Tier ${src.tier}</span>
      <span class="rs-scope-chip">${D.escapeHtml(src.kind)}</span>
      ${src.dateHint ? `<span class="rs-scope-chip">${D.escapeHtml(src.dateHint)}</span>` : ''}
    </div>
    <div class="rs-source-domain">${src.url ? D.escapeHtml(src.domain || src.url) : D.escapeHtml(src.filename || 'attached file')}</div>
    <div class="rs-source-used">Authority ${authority} · used in ${src.usedFor || 0} claims · supports ${supports} finding${supports === 1 ? '' : 's'}${contradicts ? ` · contradicts ${contradicts}` : ''}${src.status === 'failed' ? ' · could not be opened' : ''}</div>
    <div class="rs-source-actions">
      ${src.url ? `<a class="rs-mini-btn" href="${D.escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Open source</a>` : ''}
      <button class="rs-mini-btn" data-srcn="${src.n}">View evidence</button>
    </div>`;
  div.querySelector('[data-srcn]')?.addEventListener('click', () => showEvidenceForSources([src.n], session, src.title));
  return div;
}

// ============================================================
// CITATION POPOVER + EVIDENCE / SOURCES / PLAN SHEETS
// ============================================================
function wireCitations(container, session) {
  container.addEventListener('click', (e) => {
    const cite = e.target.closest('.cite');
    if (!cite) return;
    openCitePop(cite, parseInt(cite.dataset.n, 10), session);
  });
}

let citePop = null;
function closeCitePop() { if (citePop) { citePop.remove(); citePop = null; } }

function openCitePop(anchor, n, session) {
  closeCitePop();
  const src = session.sources?.find(s => s.n === n);
  if (!src) return;
  const evidence = (session.evidence || []).filter(ev => ev.sourceN === n).slice(0, 3);

  const pop = document.createElement('div');
  pop.className = 'rs-cite-pop';
  const tierCls = src.tier === 1 ? 't1' : src.tier === 2 ? 't2' : 't3';
  pop.innerHTML = `
    <button class="pop-close" title="Close">✕</button>
    <div class="pop-title">${D.escapeHtml(src.title)}</div>
    <div class="pop-meta">
      <span class="tier-badge ${tierCls}">Tier ${src.tier} · ${D.escapeHtml(src.kind)}</span>
      ${src.dateHint ? `<span class="rs-scope-chip">published ${D.escapeHtml(src.dateHint)}</span>` : ''}
      <span class="rs-scope-chip">accessed ${new Date(src.accessedAt).toLocaleDateString()}</span>
    </div>
    ${evidence.length ? evidence.map(ev => `
      <div class="rs-evidence-quote">
        <span class="ev-claim">${D.escapeHtml(ev.claim)}</span>
        “${D.escapeHtml(ev.quote.slice(0, 320))}${ev.quote.length > 320 ? '…' : ''}”
        ${ev.verified === 'supported' ? '<span class="rs-conf-label high">✓ verified</span>' : ev.verified === 'conflicting' ? '<span class="rs-conf-label conflicting">⚠ conflicting</span>' : ''}
      </div>`).join('') : '<div style="color:var(--text-faint); font-size:12px;">No extracted quotes for this source.</div>'}
    ${src.url ? `<a class="pop-link" href="${D.escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${D.escapeHtml(src.url)} ↗</a>` : ''}`;
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 6;
  let left = Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - popRect.width - 12);
  if (rect.bottom + popRect.height > window.innerHeight) top = rect.top + window.scrollY - popRect.height - 6;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, left)}px`;

  pop.querySelector('.pop-close').addEventListener('click', closeCitePop);
  setTimeout(() => {
    document.addEventListener('click', function onDoc(e) {
      if (citePop && !citePop.contains(e.target) && !e.target.closest('.cite')) {
        closeCitePop();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 0);
  citePop = pop;
}

function modalSheet(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><div class="modal-body">${innerHtml}</div></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  return overlay;
}

function showEvidenceForSources(ns, session, title) {
  closeCitePop();
  const evidence = (session.evidence || []).filter(ev => ns.includes(ev.sourceN));
  const sources = (session.sources || []).filter(s => ns.includes(s.n));
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:16px;">${D.escapeHtml(title || 'Evidence')}</h2>
      <button class="icon-btn">✕</button>
    </div>
    ${sources.map(src => `
      <div style="margin-bottom:14px;">
        <div style="font-weight:650; font-size:13.5px;">[${src.n}] ${D.escapeHtml(src.title)}</div>
        <div style="font-size:11.5px; color:var(--text-faint); margin:2px 0 8px;">${src.url ? D.escapeHtml(src.url) : 'attached file'}</div>
        ${evidence.filter(ev => ev.sourceN === src.n).map(ev => `
          <div class="rs-evidence-quote">
            <span class="ev-claim">${D.escapeHtml(ev.claim)}</span>
            “${D.escapeHtml(ev.quote.slice(0, 400))}”
          </div>`).join('') || '<div style="color:var(--text-faint); font-size:12px;">No quotes extracted.</div>'}
      </div>`).join('')}`);
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
}

function showSourcesSheet(session) {
  closeCitePop();
  const used = (session.sources || []).filter(s => s.status === 'used' || s.origin === 'file');
  const candidates = (session.sources || []).filter(s => s.status === 'candidate');
  const failed = (session.sources || []).filter(s => s.status === 'failed');
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:16px;">Sources</h2>
      <button class="icon-btn">✕</button>
    </div>
    <div style="font-size:12px; color:var(--text-faint); margin-bottom:12px;">${used.length} reviewed · ${candidates.length} discovered but not read · ${failed.length} could not be opened</div>
    <div class="rs-sources-grid">${used.map(src => sourceCardHtml(src)).join('')}</div>
    ${candidates.length ? `<div class="sidebar-section-label" style="padding:14px 0 6px; text-align:left;">Discovered (not read)</div>
      <div style="display:flex; flex-direction:column; gap:5px;">${candidates.map(s => `<div style="font-size:12px; color:var(--text-dim);">[${s.n}] ${escTruncate(s.title, 90)} — <a href="${D.escapeHtml(s.url || '#')}" target="_blank" rel="noopener noreferrer" style="color:var(--aura-2);">${D.escapeHtml(s.domain)}</a></div>`).join('')}</div>` : ''}`);
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelectorAll('[data-srcn]').forEach(btn => {
    btn.addEventListener('click', () => showEvidenceForSources([parseInt(btn.dataset.srcn, 10)], session, ''));
  });
}

function sourceCardHtml(src) {
  const tierCls = src.tier === 1 ? 't1' : src.tier === 2 ? 't2' : 't3';
  return `
    <div class="rs-source-card">
      <div class="rs-source-name">${src.n}. ${D.escapeHtml(src.title)}</div>
      <div class="rs-source-meta"><span class="tier-badge ${tierCls}">Tier ${src.tier}</span><span class="rs-scope-chip">${D.escapeHtml(src.kind)}</span></div>
      <div class="rs-source-domain">${src.url ? D.escapeHtml(src.domain || src.url) : D.escapeHtml(src.filename || 'attached file')}</div>
      <div class="rs-source-actions">
        ${src.url ? `<a class="rs-mini-btn" href="${D.escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Open</a>` : ''}
        <button class="rs-mini-btn" data-srcn="${src.n}">Evidence</button>
      </div>
    </div>`;
}

function showPlanSheet(session) {
  closeCitePop();
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:16px;">Research plan</h2>
      <button class="icon-btn">✕</button>
    </div>
    <div class="rs-objective">${D.escapeHtml(session.plan.objective)}</div>
    <div class="rs-questions">${session.plan.questions.map((q, i) => `
      <div class="rs-question"><span class="q-idx">${i + 1}</span><span class="q-text">${D.escapeHtml(q.text)}</span>
        <span class="q-status ${q.status === 'researched' ? 'ok' : q.status === 'not_found' ? 'miss' : ''}">${q.status === 'researched' ? '✓ researched' : q.status === 'not_found' ? 'no evidence found' : q.status}</span>
      </div>`).join('')}</div>`);
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
}

// ============================================================
// CHARTS — deterministic SVG from validated chart specs
// ============================================================
function buildChart(ch, session) {
  const div = document.createElement('div');
  div.className = 'rs-chart';
  div.innerHTML = `
    <div class="rs-chart-head">
      <span class="rs-chart-title">${D.escapeHtml(ch.title)}</span>
      <span class="rs-chart-meta">${D.escapeHtml([ch.unit, ch.period].filter(Boolean).join(' · '))}</span>
    </div>
    <div class="rs-chart-svg"></div>
    ${ch.note ? `<div class="rs-chart-note">${D.escapeHtml(ch.note)}</div>` : ''}
    <div class="rs-chart-actions">
      <button class="rs-mini-btn" data-ch="dl">Download SVG</button>
      <button class="rs-mini-btn" data-ch="copy">Copy data</button>
      <button class="rs-mini-btn" data-ch="open">Open data</button>
      ${ch.sourceN ? citeChip(ch.sourceN) : ''}
    </div>`;

  const svg = (ch.type === 'line' || ch.type === 'timeline') ? lineChartSvg(ch) : barChartSvg(ch);
  div.querySelector('.rs-chart-svg').appendChild(svg);

  div.querySelectorAll('[data-ch]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.ch === 'dl') {
        const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n` + svg.outerHTML], { type: 'image/svg+xml' });
        downloadBlob(blob, `aura-chart-${ch.id || Date.now()}.svg`);
      }
      if (btn.dataset.ch === 'copy') {
        navigator.clipboard.writeText(ch.series.map(p => `${p.label}\t${p.value}`).join('\n')).then(() => {
          btn.textContent = '✓';
          setTimeout(() => (btn.textContent = 'Copy data'), 1200);
        });
      }
      if (btn.dataset.ch === 'open') openDataTable(ch);
    });
  });
  return div;
}

function chartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    aura1: style.getPropertyValue('--aura-1').trim() || '#8b5cf6',
    aura2: style.getPropertyValue('--aura-2').trim() || '#38bdf8',
    text: style.getPropertyValue('--text-dim').trim() || '#9a9cad',
    faint: style.getPropertyValue('--text-faint').trim() || '#64667a',
    border: style.getPropertyValue('--border').trim() || '#2b2d38',
  };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function axisGrid(svg, c, geom, max) {
  const { padL, padR, padT, innerH, W } = geom;
  for (let i = 0; i <= 4; i++) {
    const y = padT + innerH - (innerH * i) / 4;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: c.border, 'stroke-width': 1, opacity: 0.6 }));
    const t = svgEl('text', { x: padL - 6, y: y + 3, fill: c.faint, 'font-size': 9, 'text-anchor': 'end' });
    t.textContent = fmtNum((max * i) / 4);
    svg.appendChild(t);
  }
}

function barChartSvg(ch) {
  const W = 560, H = 260, padL = 44, padR = 12, padT = 16, padB = 46;
  const c = chartColors();
  const geom = { padL, padR, padT, innerH: H - padT - padB, W };
  const innerW = W - padL - padR;
  const values = ch.series.map(p => p.value);
  const max = Math.max(...values, 0.0001);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ch.title });
  axisGrid(svg, c, geom, max);

  const barW = Math.min(52, (innerW / ch.series.length) * 0.62);
  ch.series.forEach((p, i) => {
    const cx = padL + (innerW / ch.series.length) * (i + 0.5);
    const h = (p.value / max) * geom.innerH;
    svg.appendChild(svgEl('rect', { x: cx - barW / 2, y: padT + geom.innerH - h, width: barW, height: Math.max(h, 1), rx: 4, fill: c.aura1, opacity: 0.88 }));
    const vt = svgEl('text', { x: cx, y: padT + geom.innerH - h - 5, fill: c.text, 'font-size': 9.5, 'font-weight': 600, 'text-anchor': 'middle' });
    vt.textContent = fmtNum(p.value);
    svg.appendChild(vt);
    const lt = svgEl('text', { x: cx, y: padT + geom.innerH + 14, fill: c.faint, 'font-size': 9.5, 'text-anchor': 'middle' });
    lt.textContent = truncatePlain(p.label, 16);
    svg.appendChild(lt);
  });
  return svg;
}

function lineChartSvg(ch) {
  const W = 560, H = 260, padL = 44, padR = 14, padT = 16, padB = 46;
  const c = chartColors();
  const geom = { padL, padR, padT, innerH: H - padT - padB, W };
  const innerW = W - padL - padR;
  const values = ch.series.map(p => p.value);
  const max = Math.max(...values, 0.0001);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ch.title });
  axisGrid(svg, c, geom, max);

  const pts = ch.series.map((p, i) => ({
    x: padL + (ch.series.length === 1 ? innerW / 2 : (innerW / (ch.series.length - 1)) * i),
    y: padT + geom.innerH - (p.value / max) * geom.innerH,
  }));
  svg.appendChild(svgEl('path', {
    d: `M ${pts.map(p => `${p.x},${p.y}`).join(' L ')} L ${pts[pts.length - 1].x},${padT + geom.innerH} L ${pts[0].x},${padT + geom.innerH} Z`,
    fill: c.aura1, opacity: 0.12,
  }));
  svg.appendChild(svgEl('path', { d: `M ${pts.map(p => `${p.x},${p.y}`).join(' L ')}`, fill: 'none', stroke: c.aura2, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  pts.forEach((pt, i) => {
    svg.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: 3.5, fill: c.aura2 }));
    const vt = svgEl('text', { x: pt.x, y: pt.y - 8, fill: c.text, 'font-size': 9.5, 'font-weight': 600, 'text-anchor': 'middle' });
    vt.textContent = fmtNum(ch.series[i].value);
    svg.appendChild(vt);
    const lt = svgEl('text', { x: pt.x, y: padT + geom.innerH + 14, fill: c.faint, 'font-size': 9.5, 'text-anchor': 'middle' });
    lt.textContent = truncatePlain(ch.series[i].date || ch.series[i].label, 14);
    svg.appendChild(lt);
  });
  return svg;
}

function openDataTable(ch) {
  const overlay = modalSheet(`
    <div class="modal-header" style="padding:0 0 10px; border-bottom:1px solid var(--border-soft); margin-bottom:14px;">
      <h2 style="font-size:16px;">${D.escapeHtml(ch.title)}</h2>
      <button class="icon-btn">✕</button>
    </div>
    <div class="rs-table-wrap"><table class="rs-table">
      <thead><tr><th>${ch.type === 'timeline' ? 'Date' : 'Label'}</th><th>Value${ch.unit ? ` (${D.escapeHtml(ch.unit)})` : ''}</th></tr></thead>
      <tbody>${ch.series.map(p => `<tr><td>${D.escapeHtml(p.date || p.label)}</td><td>${fmtNum(p.value)}</td></tr>`).join('')}</tbody>
    </table></div>
    ${ch.period ? `<div style="font-size:12px; color:var(--text-faint);">Period: ${D.escapeHtml(ch.period)}</div>` : ''}`);
  overlay.querySelector('.icon-btn').addEventListener('click', () => overlay.remove());
}

function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ============================================================
// PRINT + TEXT EXPORT
// ============================================================
function printReport(card) {
  card.classList.add('rs-report-printing');
  const onAfter = () => { card.classList.remove('rs-report-printing'); window.removeEventListener('afterprint', onAfter); };
  window.addEventListener('afterprint', onAfter);
  setTimeout(() => window.print(), 50);
}

function reportToText(session) {
  const r = session.report;
  const lines = [`# ${r.title}`, ''];
  for (const s of r.sections) {
    lines.push(`## ${s.heading}`, '');
    if (s.body) lines.push(s.body, '');
    if (s.kind === 'findings') {
      for (const f of session.findings || []) lines.push(`- (${f.type}/${f.confidence}) ${f.statement} [${f.citations.join(',')}]`);
      lines.push('');
    }
    if (s.kind === 'comparison' && s.columns) {
      lines.push(`| ${s.columns.join(' | ')} |`);
      lines.push(`|${s.columns.map(() => '---').join('|')}|`);
      for (const row of s.rows) lines.push(`| ${row.join(' | ')} |`);
      lines.push('');
    }
    if (s.kind === 'timeline') for (const ev of s.events) lines.push(`- ${ev.date} — ${ev.label}${ev.citation ? ` [${ev.citation}]` : ''}`);
    if (s.kind === 'sources') for (const src of s.sources || []) lines.push(`${src.n}. ${src.title} — ${src.url || 'attached file'}`);
  }
  return lines.join('\n');
}

// ============================================================
// ACTIVITY DRAWER — V2: five tabs (Activity | Sources | Evidence |
// Conflicts | Quality), all rendered from real session state / SSE events.
// ============================================================
let drawerTab = 'activity';

function openDrawer(session) {
  const drawer = document.getElementById('rsDrawer');
  if (!drawer) return;
  drawer.dataset.sessionId = session.id;
  drawer.classList.add('open');
  document.getElementById('rsDrawerTitle').textContent = 'Research Activity';
  const tabs = document.getElementById('rsDrawerTabs');
  if (tabs && !tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.rs-tab');
      if (!tab) return;
      drawerTab = tab.dataset.rtab;
      renderDrawerFor(drawer.dataset.sessionId);
    });
  }
  renderDrawerFor(session.id);
}

function renderDrawerFor(sessionId) {
  const body = document.getElementById('rsDrawerBody');
  if (!body) return;
  const w = watched.get(sessionId);
  const session = w?.session;
  document.querySelectorAll('#rsDrawerTabs .rs-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.rtab === drawerTab);
    const counts = { sources: session?.sources?.length || 0, evidence: session?.evidence?.filter(e => !e.claim.startsWith('Search summary')).length || 0, conflicts: session?.conflicts?.length || 0 };
    if (t.dataset.rtab in counts) t.textContent = `${t.dataset.rtab[0].toUpperCase() + t.dataset.rtab.slice(1)} (${counts[t.dataset.rtab]})`;
  });
  if (!session) { body.innerHTML = '<div style="color:var(--text-faint); font-size:12.5px;">No active research.</div>'; return; }

  const badge = stateBadge(session.state);
  const stEl = document.getElementById('rsDrawerState');
  if (stEl) { stEl.textContent = badge.label; stEl.className = `rs-badge ${badge.cls}`; }

  if (drawerTab === 'sources') { body.innerHTML = drawerSourcesHtml(session); wireDrawerSources(body, session); return; }
  if (drawerTab === 'evidence') { body.innerHTML = drawerEvidenceHtml(session); wireDrawerEvidence(body, session); return; }
  if (drawerTab === 'conflicts') { body.innerHTML = drawerConflictsHtml(session); return; }
  if (drawerTab === 'quality') { body.innerHTML = drawerQualityHtml(session); return; }

  body.innerHTML = `
    <div>
      <div class="rs-drawer-label">Objective</div>
      <div style="font-size:12.5px; color:var(--text); line-height:1.5; margin-top:4px;">${D.escapeHtml(session.plan.objective)}</div>
      ${session.agentsRan?.length ? `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:7px;">${session.agentsRan.map(a => `<span class="rs-scope-chip" title="${D.escapeHtml(a.role)}">${D.escapeHtml(a.label)}</span>`).join('')}</div>` : ''}
    </div>
    <div>
      <div class="rs-drawer-label">Steps</div>
      <div class="rs-steps" style="margin-top:6px; margin-bottom:0;">
        ${STEP_DEFS.map(st => `<div class="rs-step ${w?.ui?.steps?.[st.id] || ''}"><span class="step-dot"></span><span>${st.label}</span></div>`).join('')}
      </div>
    </div>
    <div>
      <div class="rs-drawer-label">Live numbers</div>
      <div class="rs-stats" style="margin-top:6px; margin-bottom:0; grid-template-columns:repeat(2,1fr);">
        ${statCell(session.stats?.sourcesFound, 'Found')}${statCell(session.stats?.sourcesReviewed, 'Reviewed')}
        ${statCell(session.stats?.claimsExtracted, 'Claims')}${statCell(session.stats?.claimsVerified, 'Verified')}
        ${statCell(session.stats?.conflictsFound, 'Conflicts')}${statCell(session.stats?.searches, 'Searches')}
      </div>
    </div>
    <div>
      <div class="rs-drawer-label">Timeline</div>
      <div class="rs-timeline" style="margin-top:4px;">
        ${(w?.ui?.feed || w?.session?.events?.slice(-20) || []).slice(-16).reverse().map(ev => `<div class="rs-tl2-item"><span class="feed-time">${new Date(ev.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span class="rs-tl2-dot ${/failed|conflict/.test(ev.type) ? 'warn' : /completed|plan_created/.test(ev.type) ? 'ok' : ''}"></span><span>${D.escapeHtml(feedLine(ev))}</span></div>`).join('') || '<div style="color:var(--text-faint); font-size:11.5px;">Waiting for events…</div>'}
      </div>
    </div>`;
}

// ---- Sources tab: source cards V2 with star rating + usage counts ----
function sourceStars(tier) {
  const stars = tier === 1 ? 5 : tier === 2 ? 3 : 2;
  return `<span class="rs-stars" title="Tier ${tier} source">${'★'.repeat(stars)}<span class="off">${'★'.repeat(5 - stars)}</span></span>`;
}

function drawerSourcesHtml(session) {
  const used = (session.sources || []).filter(s => s.status === 'used' || s.origin === 'file');
  if (used.length === 0) return '<div style="color:var(--text-faint); font-size:12px;">No sources reviewed yet.</div>';
  return used.map(src => {
    const supports = (session.findings || []).filter(f => f.citations.includes(src.n)).length;
    const contradicts = (session.conflicts || []).filter(c => c.entries.some(en => en.sourceN === src.n)).length;
    return `
    <div class="rs-source-card" style="margin-bottom:8px;">
      <div class="rs-source-name">${src.n}. ${D.escapeHtml(src.title)}</div>
      <div class="rs-source-meta">${sourceStars(src.tier)}<span class="rs-scope-chip">${D.escapeHtml(src.kind)}</span>${src.dateHint ? `<span class="rs-scope-chip">${D.escapeHtml(src.dateHint)}</span>` : ''}${src.inherited ? `<span class="rs-scope-chip">inherited</span>` : ''}</div>
      <div class="rs-source-domain">${src.url ? D.escapeHtml(src.domain || src.url) : 'attached file'}</div>
      <div class="rs-source-used">Used in ${src.usedFor || 0} claims · supports ${supports} finding${supports === 1 ? '' : 's'}${contradicts ? ` · contradicts ${contradicts} claim${contradicts === 1 ? '' : 's'}` : ''}</div>
      <div class="rs-source-actions">
        ${src.url ? `<a class="rs-mini-btn" href="${D.escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Open</a>` : ''}
        <button class="rs-mini-btn" data-srcn="${src.n}">Evidence</button>
      </div>
    </div>`;
  }).join('');
}

function wireDrawerSources(body, session) {
  body.querySelectorAll('[data-srcn]').forEach(btn => {
    btn.addEventListener('click', () => showEvidenceForSources([parseInt(btn.dataset.srcn, 10)], session, ''));
  });
}

// ---- Evidence tab: claim states + traceability ----
function drawerEvidenceHtml(session) {
  const evidence = (session.evidence || []).filter(e => !e.claim.startsWith('Search summary'));
  if (evidence.length === 0) return '<div style="color:var(--text-faint); font-size:12px;">No evidence extracted yet.</div>';
  const stateLabel = { strongly_supported: 'strongly supported', supported: 'supported', weak: 'weak', unverified: 'unverified', conflicting: 'conflicting', rejected: 'rejected' };
  return evidence.slice(0, 60).map(e => `
    <div class="rs-evidence-item" data-evid="${e.id}">
      <div class="rs-evidence-top">
        <span class="rs-claim-state ${e.claimState?.status || 'unverified'}">${stateLabel[e.claimState?.status] || e.claimState?.status || 'unverified'}</span>
        <span class="rs-evidence-claim">${D.escapeHtml(e.claim)}</span>
      </div>
      <div class="rs-evidence-meta">
        <span>source [${e.sourceN}]</span>
        ${e.claimState ? `<span>${e.claimState.independentConfirmation} independent source${e.claimState.independentConfirmation === 1 ? '' : 's'}</span>` : ''}
        <span>click to trace →</span>
      </div>
    </div>`).join('');
}

function wireDrawerEvidence(body, session) {
  body.querySelectorAll('[data-evid]').forEach(el => {
    el.addEventListener('click', () => {
      const ev = session.evidence.find(x => x.id === el.dataset.evid);
      if (ev) showEvidenceForSources([ev.sourceN], session, ev.claim);
    });
  });
}

// ---- Conflicts tab ----
function drawerConflictsHtml(session) {
  if (!(session.conflicts || []).length) return '<div style="color:var(--text-faint); font-size:12px;">No conflicting evidence detected.</div>';
  return session.conflicts.map(c => `
    <div class="rs-conflict">
      <div class="rs-conflict-head" style="font-size:12px;">⚠ ${D.escapeHtml(c.subject)}</div>
      <div class="rs-conflict-entries">
        ${c.entries.map(en => `<div class="rs-conflict-entry" style="font-size:11.5px;"><b>${en.value}${en.unit || ''}</b> ${citeChip(en.sourceN)} <span class="src-ref">${D.escapeHtml(en.sourceTitle || '')}</span></div>`).join('')}
      </div>
      <div class="rs-conflict-why" style="font-size:11px;">${D.escapeHtml(c.explanation)}</div>
    </div>`).join('');
}

// ---- Quality tab: transparent metrics with documented formulas ----
function drawerQualityHtml(session) {
  const qc = session.qc;
  if (!qc) return '<div style="color:var(--text-faint); font-size:12px;">Quality checks run when the report is generated.</div>';
  const overallCls = qc.overallLabel === 'Strong' ? '' : qc.overallLabel === 'Good' ? 'good' : qc.overallLabel === 'Fair' ? 'fair' : 'weak';
  return `
    <div class="rs-overall-pill ${overallCls}">Overall: ${qc.overallLabel} (${Math.round((qc.overall ?? 0) * 100)}/100)</div>
    ${(qc.metrics || []).map(m => `
      <div class="rs-qmetric">
        <div class="rs-qmetric-top">
          <span class="rs-qmetric-name">${D.escapeHtml(m.label)}</span>
          <span class="rs-qmetric-val">${m.value === null ? 'n/a' : Math.round(m.value * 100) + '%'}</span>
        </div>
        <div class="rs-qmetric-bar"><div class="rs-qmetric-fill" style="width:${m.value === null ? 0 : Math.round(m.value * 100)}%"></div></div>
        <div class="rs-qmetric-note">${D.escapeHtml(m.formula)}</div>
      </div>`).join('')}
    ${qc.conflictsDetected ? `<div style="font-size:11.5px; color:var(--warn); margin-top:6px;">${qc.conflictsDetected} conflict${qc.conflictsDetected === 1 ? '' : 's'} detected — see the Conflicts tab.</div>` : ''}`;
}

function feedLine(ev) {
  const base = ev.type.replace('research.', '').replace(/_/g, ' ');
  const extras = {
    'research.search_completed': `“${truncatePlain(ev.data.query, 42)}” (${ev.data.found})`,
    'research.source_opened': truncatePlain(ev.data.title || ev.data.url, 48),
    'research.evidence_extracted': `${ev.data.claims} claims`,
    'research.conflict_found': ev.data.subject,
    'research.chart_created': truncatePlain(ev.data.title, 44),
    'research.question_done': `${truncatePlain(ev.data.question, 44)} — ${ev.data.status}`,
    'research.completed': 'report ready',
  };
  return cap(base) + (extras[ev.type] ? `: ${extras[ev.type]}` : '');
}

function updateDrawerDone(sessionId, session) {
  const drawer = document.getElementById('rsDrawer');
  if (drawer?.classList.contains('open') && drawer.dataset.sessionId === sessionId) {
    watched.set(sessionId, { ...(watched.get(sessionId) || {}), session });
    renderDrawerFor(sessionId);
  }
}

// ============================================================
// SIDEBAR — "Research" section listing sessions
// ============================================================
let sidebarTimer = null;
function refreshResearchSidebarThrottled() {
  if (sidebarTimer) return;
  sidebarTimer = setTimeout(() => { sidebarTimer = null; refreshResearchSidebar(); }, 2500);
}

async function refreshResearchSidebar() {
  const listEl = document.getElementById('sidebarList');
  if (!listEl) return;
  let existing = document.getElementById('rsSidebarSection');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'rsSidebarSection';
    listEl.appendChild(existing);
  }

  let sessions = [];
  try {
    const res = await D.apiFetch('/api/research');
    const data = await res.json();
    sessions = data.sessions || [];
  } catch { sessions = []; }

  if (sessions.length === 0) { existing.innerHTML = ''; return; }

  existing.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sidebar-section-label';
  label.textContent = 'Research';
  existing.appendChild(label);

  sessions.slice(0, 8).forEach(s => {
    const item = document.createElement('div');
    item.className = 'convo-item';
    item.title = s.query;
    const dot = s.state === 'completed' || s.state === 'partial' ? 'var(--gain)'
      : ['paused', 'created'].includes(s.state) ? 'var(--warn)'
      : ['failed', 'cancelled'].includes(s.state) ? 'var(--loss)' : 'var(--aura-2)';
    item.innerHTML = `<span style="font-size:12px; flex-shrink:0;">🔍</span><span class="convo-title" style="font-size:12.5px;">${escTruncate(s.query, 34)}</span><span style="width:7px; height:7px; border-radius:50%; background:${dot}; flex-shrink:0;"></span>`;
    item.addEventListener('click', () => openResearchSession(s.id));
    existing.appendChild(item);
  });
}

async function openResearchSession(id) {
  const { ok, data } = await apiGet(`/api/research/${id}`);
  if (!ok || !data.session) return;
  const session = data.session;

  // Render the research workspace view into the conversation area.
  D.conversationInner.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'msg user';
  intro.style.maxWidth = '88%';
  intro.innerHTML = `<div class="avatar">You</div><div class="bubble-col"><div class="bubble"></div></div>`;
  intro.querySelector('.bubble').textContent = session.query;
  D.conversationInner.appendChild(intro);

  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = `<div class="avatar aura-ring aura-1">A</div><div class="bubble-col" style="max-width:100%;"></div>`;
  D.conversationInner.appendChild(wrap);

  if (session.report && ['completed', 'partial'].includes(session.state)) {
    renderReportCard(session, wrap);
  } else if (['researching', 'verifying', 'analyzing', 'reporting', 'planning'].includes(session.state)) {
    renderActivityCard(session, wrap);
    watchSession(id);
    openDrawer(session);
  } else {
    renderPlanCard(session, session.query, wrap);
    if (session.state === 'paused') watchSession(id);
  }
  D.scrollToBottom();
  if (window.innerWidth <= 760) D.closeSidebar?.();
}

// ============================================================
// TOPIC DISCOVERY
// ============================================================
async function openTopics() {
  const overlay = document.getElementById('rsTopicsOverlay');
  const loading = document.getElementById('rsTopicsLoading');
  const errEl = document.getElementById('rsTopicsError');
  const tableEl = document.getElementById('rsTopicsTable');
  overlay.classList.add('open');
  loading.style.display = ''; errEl.style.display = 'none'; tableEl.style.display = 'none';

  const { ok, data } = await apiPost('/api/research/topics', {});
  loading.style.display = 'none';
  if (!ok || !data.topics) {
    errEl.textContent = data.message || 'Could not generate topics right now.';
    errEl.style.display = '';
    return;
  }

  tableEl.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:10px;">
      ${data.topics.map((t, i) => `
        <div style="border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:12px 14px;">
          <div style="display:flex; align-items:flex-start; gap:8px;">
            <span class="rs-topic-cat">${D.escapeHtml(t.category)}</span>
            <span style="font-size:14px; font-weight:650; color:var(--text); flex:1;">${D.escapeHtml(t.topic)}</span>
          </div>
          ${t.whyItMatters ? `<div style="font-size:12.5px; color:var(--text-dim); margin-top:5px; line-height:1.5;">${D.escapeHtml(t.whyItMatters)}</div>` : ''}
          ${t.researchQuestions?.length ? `<div style="margin-top:7px; font-size:12px; color:var(--text-dim);">${t.researchQuestions.map(q => `<div style="display:flex; gap:6px; padding:1px 0;"><span style="color:var(--aura-1);">›</span><span>${D.escapeHtml(q)}</span></div>`).join('')}</div>` : ''}
          <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:8px;">
            <span class="rs-scope-chip">Difficulty: ${D.escapeHtml(t.difficulty || '—')}</span>
            <span class="rs-scope-chip">Data: ${D.escapeHtml(t.dataAvailability || '—')}</span>
            <span class="rs-scope-chip">Depth: ${D.escapeHtml(t.expectedDepth || 'Standard')}</span>
            <span class="rs-scope-chip">Impact: ${D.escapeHtml(t.impact || '—')}</span>
          </div>
          ${t.methodology ? `<div style="font-size:11.5px; color:var(--text-faint); margin-top:6px;">Methodology: ${D.escapeHtml(t.methodology)}</div>` : ''}
          <div style="display:flex; gap:7px; margin-top:10px;">
            <button class="rs-btn primary" data-topic="${D.escapeHtml(t.topic)}" data-depth="${(t.expectedDepth || 'Standard').toLowerCase()}" style="font-size:12px;">Research this</button>
            <button class="rs-btn" data-expand="${i}" style="font-size:12px;">${t.researchQuestions?.length ? 'Use questions' : 'Expand'}</button>
          </div>
        </div>`).join('')}
    </div>`;
  tableEl.style.display = '';
  tableEl.querySelectorAll('[data-topic]').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.classList.remove('open');
      const input = document.getElementById('userInput');
      if (btn.dataset.depth && ['quick', 'standard', 'deep'].includes(btn.dataset.depth)) {
        researchDepth = btn.dataset.depth;
        localStorage.setItem('aura_research_depth', researchDepth);
        document.getElementById('researchDepthLabel').textContent = `Research · ${cap(researchDepth)}`;
      }
      input.value = `Research ${btn.dataset.topic}`;
      input.dispatchEvent(new Event('input'));
      if (!researchOn) document.getElementById('researchToggle')?.click();
      input.focus();
    });
  });
  tableEl.querySelectorAll('[data-expand]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = data.topics[parseInt(btn.dataset.expand, 10)];
      const input = document.getElementById('userInput');
      overlay.classList.remove('open');
      input.value = `Research ${t.topic}. Address: ${(t.researchQuestions || []).join(' ')}`;
      input.dispatchEvent(new Event('input'));
      if (!researchOn) document.getElementById('researchToggle')?.click();
      input.focus();
    });
  });
}

// ============================================================
// EXPORTS
// ============================================================
export {
  initResearch,
  isResearchMode,
  handleResearchSend,
  refreshResearchSidebar,
  openResearchSession,
};
