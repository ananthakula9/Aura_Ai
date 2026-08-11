// Aura AI — app.js
// Frontend application logic. Talks only to this server's own /api/chat
// and /api/health — never to any AI provider directly, and never handles
// an API key. Imports the untouched Aura pipeline from pipeline.js.

import {
  AuraMemory, detectMood, runAuraEngine, runCringeCheck,
  scoreAndEvent, STYLE_GUIDANCE, slangGuidance
} from './pipeline.js';

// ============================================================
// STATE
// ============================================================
const memory = new AuraMemory();
let currentMode = 'AUTO';
let debugMode = false;
let eventsEnabled = true;
let memoryEnabled = true;
let manualSlangOverride = -1;
let humorLevel = 3;
let confidenceLevel = 3;
let emojiFrequency = 1;
let responseLength = 'balanced';
let creativityLevel = 1; // 0 focused, 1 balanced, 2 creative
let availableModels = [];   // populated from /api/health: [{ displayName, isDefault }]
let selectedModel = null;   // an Aura display name (e.g. "Aura 1 Flash") — never a raw Gemini model ID
let inFlightController = null;
let chatHistory = [];

// ============================================================
// GUEST CONVERSATION STATE — IN MEMORY ONLY, NEVER PERSISTED
// This is the entire guest "conversation store": one plain JS object that
// lives only as long as this page/tab does. It is intentionally NOT:
//   - written to localStorage
//   - written to sessionStorage
//   - written to IndexedDB
//   - sent to the server in any save/create/list call
// A refresh, tab close, or reopen always starts from this same empty
// literal below — there is no code path anywhere in this file that reads
// a guest conversation back from any storage API. If you're looking for
// where guest chats "persist", the answer is: nowhere, by design.
// ============================================================
let guestConversation = { messages: [] };

let activeConvoId = null; // only meaningful for logged-in (server) conversations

// ============================================================
// AUTH STATE
// Guests: see guestConversation above — memory-only, gone on refresh.
// Logged-in: conversations are created/read/updated via /api/conversations,
// scoped server-side to req.user.id — see db.js for the ownership checks.
// ============================================================
let currentUser = null;       // { id, email } | null
let accountsEnabled = false;  // whether the server has a database configured
let googleOAuthEnabled = false; // whether the server has Google OAuth configured
let authMode = 'login';       // 'login' | 'signup'
let welcomeModalDismissedThisSession = false;

// ============================================================
// DOM REFS
// ============================================================
const $ = (id) => document.getElementById(id);

const conversationInner = $('conversationInner');
const emptyState = $('emptyState');
const conversation = $('conversation');
const userInput = $('userInput');
const sendBtn = $('sendBtn');
const meterFill = $('meterFill');
const meterScore = $('meterScore');
const statCurrentStyle = $('statCurrentStyle');
const statAuraLevel = $('statAuraLevel');
const recentEventsEl = $('recentEvents');

const modalOverlay = $('modalOverlay');
const modelSelect = $('modelSelect');
const serverStatus = $('serverStatus');
const statusDotLg = $('statusDotLg');
const topStatusDot = $('topStatusDot');
const modelPillName = $('modelPillName');
const modelPill = $('modelPill');
const modelPopover = $('modelPopover');

const slangSlider = $('slangSlider');
const slangVal = $('slangVal');
const humorSlider = $('humorSlider');
const humorVal = $('humorVal');
const confidenceSlider = $('confidenceSlider');
const confidenceVal = $('confidenceVal');
const emojiSlider = $('emojiSlider');
const emojiVal = $('emojiVal');
const creativitySlider = $('creativitySlider');
const creativityVal = $('creativityVal');
const debugToggle = $('debugToggle');
const eventsToggle = $('eventsToggle');
const memoryToggle = $('memoryToggle');
const clearBtn = $('clearBtn');
const resetSettingsBtn = $('resetSettingsBtn');

const sidebar = $('sidebar');
const sidebarList = $('sidebarList');
const sidebarScrim = $('sidebarScrim');
const searchInput = $('searchInput');

// ============================================================
// THEME
// ============================================================
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'system') {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    root.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
  } else {
    root.setAttribute('data-theme', pref);
  }
  document.querySelectorAll('.theme-opt').forEach(o => o.classList.toggle('active', o.dataset.theme === pref));
}
const savedTheme = localStorage.getItem('aura_theme') || 'dark';
applyTheme(savedTheme);
document.getElementById('themeSelect').addEventListener('click', (e) => {
  const opt = e.target.closest('.theme-opt');
  if (!opt) return;
  localStorage.setItem('aura_theme', opt.dataset.theme);
  applyTheme(opt.dataset.theme);
});

// ============================================================
// GUEST CONVERSATION HANDLING — memory-only, no sidebar list
// A guest has exactly one conversation at a time: whatever is in
// guestConversation.messages. There is no list to search/rename/delete
// because there is nothing saved to list — the sidebar shows a short
// explanatory note instead (see renderGuestSidebar below). Starting a
// "new chat" as a guest simply replaces guestConversation with a fresh
// empty object; nothing is written anywhere first.
// ============================================================
function startFreshGuestConversation() {
  guestConversation = { messages: [] };
  chatHistory = [];
  Object.assign(memory, new AuraMemory());
  conversationInner.innerHTML = '';
  conversationInner.appendChild(emptyState);
  renderGuestSidebar();
}

function renderGuestSidebar() {
  sidebarList.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'sidebar-empty';
  note.style.textAlign = 'left';
  note.style.padding = '10px 8px';
  note.style.lineHeight = '1.5';
  note.innerHTML = 'You\u2019re browsing as a guest.<br>This chat isn\u2019t saved and will disappear on refresh.<br><br><button class="sidebar-inline-signin" id="sidebarInlineSignin">Sign in to save conversations</button>';
  sidebarList.appendChild(note);
  const btn = document.getElementById('sidebarInlineSignin');
  if (btn) btn.addEventListener('click', () => openAuthModal('login'));
}

function renderGuestConversationInPlace() {
  conversationInner.innerHTML = '';
  if (guestConversation.messages.length === 0) {
    conversationInner.appendChild(emptyState);
    return;
  }
  guestConversation.messages.forEach(m => {
    if (m.role === 'user') addUser(m.content, false, m.timestamp);
    else addAI(m.content, null, null, false, m.timestamp);
  });
}

function startFreshConversation() {
  if (currentUser) {
    createServerConversation();
  } else {
    startFreshGuestConversation();
  }
}

// init happens after the auth check below (checkAuthAndInit), so the app
// knows whether to show the guest's fresh in-memory conversation or load
// the logged-in user's saved server conversations before rendering.

searchInput.addEventListener('input', () => {
  if (currentUser) {
    apiFetch('/api/conversations').then(r => r.json()).then(d => renderServerSidebarList(d.conversations || [], activeConvoId));
  }
  // guest sidebar has nothing to search — intentionally a no-op
});

// ============================================================
// SIDEBAR (mobile drawer + desktop collapse)
// ============================================================
function openSidebar() {
  sidebar.classList.remove('collapsed');
  if (window.innerWidth <= 760) sidebarScrim.classList.add('show');
}
function closeSidebar() {
  sidebar.classList.add('collapsed');
  sidebarScrim.classList.remove('show');
}
function toggleSidebar() {
  if (sidebar.classList.contains('collapsed')) openSidebar(); else closeSidebar();
}
$('menuToggle').addEventListener('click', toggleSidebar);
$('collapseBtn').addEventListener('click', closeSidebar);
sidebarScrim.addEventListener('click', closeSidebar);

$('newChatBtn').addEventListener('click', () => { startFreshConversation(); if (window.innerWidth <= 760) closeSidebar(); });
$('newChatBtnTop').addEventListener('click', startFreshConversation);

$('clearAllBtn').addEventListener('click', async () => {
  const btn = $('clearAllBtn');
  if (btn.dataset.confirming === '1') {
    if (currentUser) {
      await apiFetch('/api/conversations', { method: 'DELETE' });
      await createServerConversation();
    } else {
      startFreshGuestConversation();
    }
    btn.dataset.confirming = '0';
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg> Clear all conversations';
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Click again to confirm';
    setTimeout(() => {
      if (btn.dataset.confirming === '1') {
        btn.dataset.confirming = '0';
        btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg> Clear all conversations';
      }
    }, 3000);
  }
});

// ============================================================
// AUTH: server calls
// All auth calls use fetch with credentials so the HTTP-only session
// cookie is sent automatically — the frontend never touches the token
// itself, and never stores anything auth-related in localStorage.
// ============================================================
async function apiFetch(url, options = {}) {
  return fetch(url, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
}

async function checkAuthAndInit() {
  try {
    const healthRes = await apiFetch('/api/health');
    const health = await healthRes.json();
    accountsEnabled = Boolean(health.accountsEnabled);
  } catch { accountsEnabled = false; }

  if (accountsEnabled) {
    try {
      const res = await apiFetch('/api/auth/me');
      const data = await res.json();
      currentUser = data.user || null;
    } catch { currentUser = null; }
  } else {
    currentUser = null;
  }

  updateAccountUI();

  if (currentUser) {
    markWelcomeSeen(); // an authenticated user never needs the welcome modal
    await loadServerConversationList();
  } else {
    // Every load starts from a fresh, empty guest conversation — there is
    // no prior guest state to restore from anywhere.
    startFreshGuestConversation();
    maybeShowWelcomeModal();
  }
}

function updateAccountUI() {
  const accountBtn = $('accountBtn');
  const accountAvatar = $('accountAvatar');
  const accountLabel = $('accountLabel');
  const guestBanner = $('guestBanner');
  const sidebarCard = $('sidebarAccountCard');
  const sidebarAvatar = $('sidebarAccountAvatar');
  const sidebarTitle = $('sidebarAccountTitle');
  const sidebarSub = $('sidebarAccountSub');

  if (currentUser) {
    accountBtn.classList.add('logged-in');
    accountAvatar.textContent = currentUser.email.slice(0, 1).toUpperCase();
    accountLabel.textContent = currentUser.email.split('@')[0];
    guestBanner.classList.remove('show');

    sidebarCard.classList.add('logged-in');
    sidebarAvatar.textContent = currentUser.email.slice(0, 1).toUpperCase();
    sidebarTitle.textContent = currentUser.email;
    sidebarSub.textContent = 'Account';
  } else {
    accountBtn.classList.remove('logged-in');
    accountAvatar.textContent = 'G';
    accountLabel.textContent = 'Guest';
    if (accountsEnabled && !localStorage.getItem('aura_guest_banner_dismissed')) {
      guestBanner.classList.add('show');
    }

    sidebarCard.classList.remove('logged-in');
    sidebarAvatar.textContent = 'G';
    sidebarTitle.textContent = 'Sign in';
    sidebarSub.textContent = 'Save your chats';
  }
}

$('guestBannerDismiss').addEventListener('click', () => {
  $('guestBanner').classList.remove('show');
  localStorage.setItem('aura_guest_banner_dismissed', '1');
});
$('guestBannerAuthBtn').addEventListener('click', () => openAuthModal('landing'));

// ---------- top-bar account popover ----------
const accountBtn = $('accountBtn');
const accountPopover = $('accountPopover');

function buildAccountMenuItems(popoverEl) {
  popoverEl.innerHTML = '';
  if (currentUser) {
    const header = document.createElement('div');
    header.className = 'account-popover-header';
    header.innerHTML = `<b>${escapeHtml(currentUser.email)}</b>Signed in`;
    popoverEl.appendChild(header);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'account-popover-item';
    logoutBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg> Log out';
    logoutBtn.addEventListener('click', handleLogout);
    popoverEl.appendChild(logoutBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'account-popover-item danger';
    deleteBtn.dataset.confirming = '0';
    deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg> Delete account';
    deleteBtn.addEventListener('click', () => {
      if (deleteBtn.dataset.confirming === '1') {
        handleDeleteAccount();
      } else {
        deleteBtn.dataset.confirming = '1';
        deleteBtn.innerHTML = 'Click again to permanently delete';
        setTimeout(() => { deleteBtn.dataset.confirming = '0'; deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg> Delete account'; }, 3000);
      }
    });
    popoverEl.appendChild(deleteBtn);
  } else {
    const signinBtn = document.createElement('button');
    signinBtn.className = 'account-popover-item';
    signinBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/></svg> Sign in';
    signinBtn.addEventListener('click', () => openAuthModal('landing'));
    popoverEl.appendChild(signinBtn);

    if (!accountsEnabled) {
      const note = document.createElement('div');
      note.className = 'account-popover-header';
      note.style.borderTop = '1px solid var(--border-soft)';
      note.style.borderBottom = 'none';
      note.textContent = 'Accounts are not configured on this server.';
      popoverEl.appendChild(note);
    }
  }
}

accountBtn.addEventListener('click', () => { buildAccountMenuItems(accountPopover); accountPopover.classList.toggle('open'); });
document.addEventListener('click', (e) => {
  if (!accountBtn.contains(e.target) && !accountPopover.contains(e.target)) accountPopover.classList.remove('open');
});

// ---------- sidebar account card (bottom of sidebar) ----------
const sidebarAccountCard = $('sidebarAccountCard');
const sidebarAccountPopover = $('sidebarAccountPopover');
sidebarAccountCard.addEventListener('click', () => {
  if (currentUser) {
    buildAccountMenuItems(sidebarAccountPopover);
    sidebarAccountPopover.classList.toggle('open');
  } else {
    openAuthModal('landing');
  }
});
document.addEventListener('click', (e) => {
  if (!sidebarAccountCard.contains(e.target) && !sidebarAccountPopover.contains(e.target)) sidebarAccountPopover.classList.remove('open');
});

// ---------- auth modal: landing view + email form view ----------
const authModalOverlay = $('authModalOverlay');
const authLandingView = $('authLandingView');
const authFormView = $('authFormView');
const authLandingError = $('authLandingError');
const authForm = $('authForm');
const authEmail = $('authEmail');
const authPassword = $('authPassword');
const authError = $('authError');
const authSubmitBtn = $('authSubmitBtn');
const authHeadline = $('authHeadline');
const authSubtext = $('authSubtext');
const authSwitch = $('authSwitch');

function openAuthModal(view) {
  authLandingError.classList.remove('show');
  authError.classList.remove('show');
  if (view === 'landing') {
    authLandingView.style.display = '';
    authFormView.style.display = 'none';
  } else {
    showAuthForm(view); // 'login' | 'signup'
  }
  authModalOverlay.classList.add('open');
  accountPopover.classList.remove('open');
  sidebarAccountPopover.classList.remove('open');
}

function showAuthForm(mode) {
  authMode = mode;
  authLandingView.style.display = 'none';
  authFormView.style.display = '';
  authError.classList.remove('show');
  authForm.reset();
  if (mode === 'login') {
    authHeadline.textContent = 'Welcome back';
    authSubtext.textContent = 'Log in to access your saved conversations';
    authSubmitBtn.textContent = 'Log in';
    authSwitch.innerHTML = 'Don\u2019t have an account? <button type="button" id="authSwitchBtn">Sign up</button>';
    authPassword.setAttribute('autocomplete', 'current-password');
  } else {
    authHeadline.textContent = 'Create your account';
    authSubtext.textContent = 'Save conversations across sessions and devices';
    authSubmitBtn.textContent = 'Sign up';
    authSwitch.innerHTML = 'Already have an account? <button type="button" id="authSwitchBtn">Log in</button>';
    authPassword.setAttribute('autocomplete', 'new-password');
  }
  $('authSwitchBtn').addEventListener('click', () => showAuthForm(mode === 'login' ? 'signup' : 'login'));
}

function closeAuthModal() { authModalOverlay.classList.remove('open'); }

$('closeAuthModalBtn').addEventListener('click', closeAuthModal);
authModalOverlay.addEventListener('click', (e) => { if (e.target === authModalOverlay) closeAuthModal(); });
$('authGuestBtn').addEventListener('click', () => { closeAuthModal(); markWelcomeSeen(); });
$('authShowEmailLoginBtn').addEventListener('click', () => showAuthForm('login'));
$('authShowSignupBtn').addEventListener('click', () => showAuthForm('signup'));
$('authBackBtn').addEventListener('click', () => { authLandingView.style.display = ''; authFormView.style.display = 'none'; });

// "Continue with Google" — real server-side OAuth redirect, or a clear
// inline error if the server hasn't been configured with Google OAuth
// credentials. There is no fake/simulated Google login path.
$('authGoogleBtn').addEventListener('click', () => {
  if (!googleOAuthEnabled) {
    authLandingError.textContent = 'Google sign-in isn\u2019t configured on this server yet. Use email instead, or continue as a guest.';
    authLandingError.classList.add('show');
    return;
  }
  window.location.href = '/api/auth/google';
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.remove('show');
  authSubmitBtn.disabled = true;
  const originalLabel = authSubmitBtn.textContent;
  authSubmitBtn.textContent = authMode === 'login' ? 'Logging in…' : 'Creating account…';

  try {
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ email: authEmail.value.trim(), password: authPassword.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      authError.textContent = data.message || 'Something went wrong.';
      authError.classList.add('show');
      return;
    }

    currentUser = data.user;
    updateAccountUI();
    closeAuthModal();
    markWelcomeSeen();
    localStorage.removeItem('aura_guest_banner_dismissed');
    // The in-memory guest conversation (if any) is simply discarded —
    // never merged into the account, never written anywhere.
    guestConversation = { messages: [] };
    await loadServerConversationList();
  } catch (err) {
    authError.textContent = 'Could not reach the server. Try again.';
    authError.classList.add('show');
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = originalLabel;
  }
});

// ---------- first-visit welcome modal ----------
// A minimal anonymous flag — not chat data, not a token, not personal
// information — just "has this browser already seen the welcome modal".
// Guests who dismiss or pick a path are not re-prompted on every reload.
const WELCOME_SEEN_KEY = 'aura_welcome_seen';
function markWelcomeSeen() { localStorage.setItem(WELCOME_SEEN_KEY, '1'); }
function maybeShowWelcomeModal() {
  if (!localStorage.getItem(WELCOME_SEEN_KEY)) {
    openAuthModal('landing');
  }
}

// If we just came back from a Google OAuth redirect with an error, surface
// it once and clean the URL so refreshing doesn't re-show it.
(function checkOAuthErrorParam() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('auth_error');
  if (err) {
    openAuthModal('landing');
    authLandingError.textContent = err;
    authLandingError.classList.add('show');
    params.delete('auth_error');
    const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', cleanUrl);
  }
})();

async function handleLogout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
  currentUser = null;
  activeConvoId = null;
  chatHistory = [];
  accountPopover.classList.remove('open');
  updateAccountUI();
  // Logging out always starts a brand new, empty guest conversation — this
  // is never the previous account's chat, and nothing from the account's
  // saved history is copied into guest state.
  startFreshGuestConversation();
}

async function handleDeleteAccount() {
  try {
    await apiFetch('/api/auth/account', { method: 'DELETE' });
  } catch { /* best effort */ }
  currentUser = null;
  activeConvoId = null;
  chatHistory = [];
  accountPopover.classList.remove('open');
  updateAccountUI();
  startFreshGuestConversation();
}

// ---------- server-backed conversation list (logged-in users) ----------
async function loadServerConversationList() {
  try {
    const res = await apiFetch('/api/conversations');
    if (!res.ok) throw new Error('failed to load conversations');
    const data = await res.json();
    const list = data.conversations || [];

    if (list.length > 0) {
      await switchToServerConversation(list[0].id);
    } else {
      await createServerConversation();
    }
    renderServerSidebarList(list, list[0]?.id);
  } catch (err) {
    console.error('loadServerConversationList failed:', err);
    addErrorCard('Could not load conversations', 'There was a problem reaching the server for your saved chats.', loadServerConversationList);
  }
}

async function createServerConversation() {
  const res = await apiFetch('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'New chat' }) });
  const data = await res.json();
  activeConvoId = data.conversation.id;
  chatHistory = [];
  Object.assign(memory, new AuraMemory());
  conversationInner.innerHTML = '';
  conversationInner.appendChild(emptyState);
  const listRes = await apiFetch('/api/conversations');
  const listData = await listRes.json();
  renderServerSidebarList(listData.conversations || [], activeConvoId);
  return data.conversation;
}

async function switchToServerConversation(id) {
  const res = await apiFetch(`/api/conversations/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  activeConvoId = id;
  chatHistory = data.conversation.messages.map(m => ({ role: m.role, content: m.content }));
  Object.assign(memory, new AuraMemory());
  conversationInner.innerHTML = '';
  if (data.conversation.messages.length === 0) {
    conversationInner.appendChild(emptyState);
  } else {
    data.conversation.messages.forEach(m => {
      if (m.role === 'user') addUser(m.content, false, new Date(m.created_at).getTime());
      else addAI(m.content, null, null, false, new Date(m.created_at).getTime());
    });
  }
  if (window.innerWidth <= 760) closeSidebar();
}

function renderServerSidebarList(list, activeId) {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = list.filter(c => !query || c.title.toLowerCase().includes(query));

  sidebarList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = query ? 'No matching conversations.' : 'No conversations yet.';
    sidebarList.appendChild(empty);
    return;
  }

  const label = document.createElement('div');
  label.className = 'sidebar-section-label';
  label.textContent = 'Recent';
  sidebarList.appendChild(label);

  filtered.forEach(convo => {
    const item = document.createElement('div');
    item.className = 'convo-item' + (convo.id === activeId ? ' active' : '');

    const titleEl = document.createElement('div');
    titleEl.className = 'convo-title';
    titleEl.textContent = convo.title;
    item.appendChild(titleEl);

    const actions = document.createElement('div');
    actions.className = 'convo-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'convo-action-btn';
    renameBtn.title = 'Rename';
    renameBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.value = convo.title;
      titleEl.textContent = '';
      titleEl.appendChild(inputEl);
      inputEl.focus(); inputEl.select();
      const commit = async () => {
        const v = inputEl.value.trim();
        if (v && v !== convo.title) {
          await apiFetch(`/api/conversations/${convo.id}`, { method: 'PATCH', body: JSON.stringify({ title: v.slice(0, 60) }) });
        }
        const res = await apiFetch('/api/conversations');
        const data = await res.json();
        renderServerSidebarList(data.conversations || [], activeConvoId);
      };
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { renderServerSidebarList(list, activeId); }
      });
      inputEl.addEventListener('blur', commit);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'convo-action-btn danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiFetch(`/api/conversations/${convo.id}`, { method: 'DELETE' });
      const res = await apiFetch('/api/conversations');
      const data = await res.json();
      if (convo.id === activeConvoId) {
        if (data.conversations.length > 0) await switchToServerConversation(data.conversations[0].id);
        else await createServerConversation();
      }
      renderServerSidebarList(data.conversations || [], activeConvoId);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(actions);

    item.addEventListener('click', () => switchToServerConversation(convo.id).then(() => {
      apiFetch('/api/conversations').then(r => r.json()).then(d => renderServerSidebarList(d.conversations || [], activeConvoId));
    }));
    sidebarList.appendChild(item);
  });
}

// ============================================================
// SETTINGS MODAL
// ============================================================
function openModal() { modalOverlay.classList.add('open'); }
function closeModal() { modalOverlay.classList.remove('open'); }
$('settingsBtnTop').addEventListener('click', openModal);
$('settingsBtnSidebar').addEventListener('click', openModal);
$('closeModalBtn').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ---------- health check + model list ----------
async function checkServerHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    // data.models is [{ displayName, description, isDefault }] — Aura
    // branded names only, the server never sends a raw Gemini model ID here.
    availableModels = data.models || [];
    googleOAuthEnabled = Boolean(data.googleOAuthEnabled);

    const savedModel = localStorage.getItem('aura_model');
    const savedIsValid = savedModel && availableModels.some(m => m.displayName === savedModel);
    selectedModel = savedIsValid ? savedModel : (data.defaultModel || availableModels[0]?.displayName || 'Aura 1 Flash');
    localStorage.setItem('aura_model', selectedModel);

    populateModelSelect();
    populateModelPopover();
    modelPillName.textContent = selectedModel;

    if (data.keyConfigured) {
      serverStatus.textContent = 'Connected — server key configured';
      statusDotLg.className = 'status-dot-lg ok';
      topStatusDot.className = 'status-dot ok';
    } else {
      serverStatus.textContent = 'Server running, but GEMINI_API_KEY is not set';
      statusDotLg.className = 'status-dot-lg bad';
      topStatusDot.className = 'status-dot bad';
    }
  } catch (e) {
    serverStatus.textContent = 'Could not reach server';
    statusDotLg.className = 'status-dot-lg bad';
    topStatusDot.className = 'status-dot bad';
  }
}

function populateModelSelect() {
  modelSelect.innerHTML = '';
  availableModels.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.displayName;
    opt.textContent = m.displayName + (m.isDefault ? '  (default)' : '');
    if (m.displayName === selectedModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });
}
modelSelect.addEventListener('change', () => {
  selectedModel = modelSelect.value;
  localStorage.setItem('aura_model', selectedModel);
  modelPillName.textContent = selectedModel;
  populateModelPopover();
});

function populateModelPopover() {
  modelPopover.innerHTML = '';
  availableModels.forEach(m => {
    const item = document.createElement('div');
    item.className = 'model-popover-item' + (m.displayName === selectedModel ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(m.displayName)}</span><span class="check">✓</span>`;
    item.title = m.description || '';
    item.addEventListener('click', () => {
      selectedModel = m.displayName;
      localStorage.setItem('aura_model', selectedModel);
      modelPillName.textContent = selectedModel;
      populateModelSelect();
      populateModelPopover();
      modelPopover.classList.remove('open');
    });
    modelPopover.appendChild(item);
  });
}
modelPill.addEventListener('click', () => modelPopover.classList.toggle('open'));
document.addEventListener('click', (e) => {
  if (!modelPill.contains(e.target) && !modelPopover.contains(e.target)) modelPopover.classList.remove('open');
});

checkServerHealth();

// ---------- personality controls ----------
document.getElementById('modeBar').addEventListener('click', (e) => {
  const opt = e.target.closest('.chip-opt');
  if (!opt) return;
  document.querySelectorAll('#modeBar .chip-opt').forEach(c => c.classList.remove('active'));
  opt.classList.add('active');
  currentMode = opt.dataset.mode;
});

slangSlider.addEventListener('input', () => {
  manualSlangOverride = parseInt(slangSlider.value);
  slangVal.textContent = manualSlangOverride === -1 ? 'Auto' : `Level ${manualSlangOverride}`;
});
humorSlider.addEventListener('input', () => { humorLevel = parseInt(humorSlider.value); humorVal.textContent = humorLevel; });
confidenceSlider.addEventListener('input', () => { confidenceLevel = parseInt(confidenceSlider.value); confidenceVal.textContent = confidenceLevel; });
emojiSlider.addEventListener('input', () => {
  emojiFrequency = parseInt(emojiSlider.value);
  emojiVal.textContent = ['None', 'Low', 'Medium', 'High'][emojiFrequency];
});

debugToggle.addEventListener('change', () => { debugMode = debugToggle.checked; });
eventsToggle.addEventListener('change', () => { eventsEnabled = eventsToggle.checked; });
memoryToggle.addEventListener('change', () => { memoryEnabled = memoryToggle.checked; });

document.getElementById('lengthBar').addEventListener('click', (e) => {
  const opt = e.target.closest('.chip-opt');
  if (!opt) return;
  document.querySelectorAll('#lengthBar .chip-opt').forEach(c => c.classList.remove('active'));
  opt.classList.add('active');
  responseLength = opt.dataset.length;
});

creativitySlider.addEventListener('input', () => {
  creativityLevel = parseInt(creativitySlider.value);
  creativityVal.textContent = ['Focused', 'Balanced', 'Creative'][creativityLevel];
});

clearBtn.addEventListener('click', async () => {
  if (currentUser && activeConvoId) {
    await apiFetch(`/api/conversations/${activeConvoId}`, { method: 'DELETE' });
    await createServerConversation();
  } else {
    startFreshGuestConversation();
  }
  updateMeter();
  closeModal();
});

resetSettingsBtn.addEventListener('click', () => {
  currentMode = 'AUTO';
  manualSlangOverride = -1;
  humorLevel = 3; confidenceLevel = 3; emojiFrequency = 1;
  responseLength = 'balanced'; creativityLevel = 1; memoryEnabled = true;

  document.querySelectorAll('#modeBar .chip-opt').forEach(c => c.classList.toggle('active', c.dataset.mode === 'AUTO'));
  document.querySelectorAll('#lengthBar .chip-opt').forEach(c => c.classList.toggle('active', c.dataset.length === 'balanced'));
  slangSlider.value = -1; slangVal.textContent = 'Auto';
  humorSlider.value = 3; humorVal.textContent = 3;
  confidenceSlider.value = 3; confidenceVal.textContent = 3;
  emojiSlider.value = 1; emojiVal.textContent = 'Low';
  creativitySlider.value = 1; creativityVal.textContent = 'Balanced';
  memoryToggle.checked = true;
});

// ============================================================
// AURA STATUS PANEL (personality tab live stats)
// ============================================================
const auraStyleLabels = {
  normal: 'Normal', witty: 'Witty', confident: 'Confident', playful: 'Playful',
  deadpan: 'Deadpan', concise: 'Concise', cinematic: 'Cinematic', supportive: 'Supportive',
  chaotic: 'Chaotic', 'skill-based': 'Skill-based', restraint: 'Restraint',
};
let lastStyle = '—';
let recentEventLog = [];

function updateMeter() {
  const pct = Math.max(0, Math.min(100, (memory.auraScore / 1000) * 100));
  meterFill.style.width = pct + '%';
  meterScore.textContent = memory.auraScore;
  statCurrentStyle.textContent = auraStyleLabels[lastStyle] || '—';
  const level = memory.auraScore >= 800 ? 'Legendary' : memory.auraScore >= 600 ? 'Confident' : memory.auraScore >= 400 ? 'Steady' : memory.auraScore >= 200 ? 'Quiet' : 'Reset';
  statAuraLevel.textContent = level;
}
function renderRecentEvents() {
  if (recentEventLog.length === 0) {
    recentEventsEl.innerHTML = '<div class="empty">No aura events yet this session.</div>';
    return;
  }
  recentEventsEl.innerHTML = '';
  recentEventLog.slice(-5).reverse().forEach(ev => {
    const row = document.createElement('div');
    row.className = 'aura-tag ' + (ev.delta > 0 ? 'gain' : 'loss');
    row.style.alignSelf = 'flex-start';
    const sign = ev.delta > 0 ? '+' : '';
    row.textContent = `${ev.type.toLowerCase()} ${sign}${ev.delta}`;
    recentEventsEl.appendChild(row);
  });
}
updateMeter();

// ============================================================
// MARKDOWN RENDERING (lightweight, no dependency)
// ============================================================
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  const codeBlocks = [];
  let working = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || 'text', code: code.replace(/\n$/, '') });
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  working = escapeHtml(working);

  working = working.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  working = working.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  working = working.replace(/^# (.*)$/gm, '<h1>$1</h1>');

  working = working.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  working = working.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  working = working.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  working = working.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');

  const lines = working.split('\n');
  const out = [];
  let listBuffer = [];
  let listType = null;

  function flushList() {
    if (listBuffer.length === 0) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>` + listBuffer.map(li => `<li>${li}</li>`).join('') + `</${tag}>`);
    listBuffer = [];
    listType = null;
  }

  for (const line of lines) {
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (ulMatch) {
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuffer.push(ulMatch[1]);
    } else if (olMatch) {
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuffer.push(olMatch[1]);
    } else {
      flushList();
      out.push(line);
    }
  }
  flushList();
  working = out.join('\n');

  const blocks = working.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  working = blocks.map(b => {
    if (/^<(h1|h2|h3|ul|ol|blockquote)/.test(b)) return b;
    if (b.includes('\u0000CODEBLOCK')) return b;
    return `<p>${b.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  working = working.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => {
    const block = codeBlocks[parseInt(i)];
    const escaped = escapeHtml(block.code);
    return `<div class="code-block"><div class="code-block-header"><span>${escapeHtml(block.lang)}</span><button class="code-copy-btn" data-code="${encodeURIComponent(block.code)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy</button></div><pre><code>${escaped}</code></pre></div>`;
  });

  return working;
}

function wireCodeCopyButtons(container) {
  container.querySelectorAll('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = decodeURIComponent(btn.dataset.code);
      navigator.clipboard.writeText(code).then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = '✓ Copied';
        setTimeout(() => { btn.innerHTML = original; }, 1500);
      });
    });
  });
}

// ============================================================
// MESSAGE RENDERING
// ============================================================
function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ensureConversationStarted() { if (emptyState.parentElement) emptyState.remove(); }

function addUser(text, persist = true, timestamp = Date.now()) {
  ensureConversationStarted();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="avatar">You</div><div class="bubble-col"><div class="bubble"></div><div class="msg-meta" style="justify-content:flex-end;"><span class="msg-time">${formatTime(timestamp)}</span></div></div>`;
  div.querySelector('.bubble').textContent = text;
  conversationInner.appendChild(div);
  scrollToBottom();

  if (persist) {
    if (currentUser && activeConvoId) {
      apiFetch(`/api/conversations/${activeConvoId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: text }),
      }).then(() => {
        apiFetch('/api/conversations').then(r => r.json()).then(d => renderServerSidebarList(d.conversations || [], activeConvoId));
      }).catch(err => console.error('failed to persist user message:', err));
    } else {
      // Guest: held only in the in-memory guestConversation object for
      // this page's lifetime — never written to any storage API.
      guestConversation.messages.push({ role: 'user', content: text, timestamp });
    }
  }
}

function addAI(text, debugInfo, auraEvent, persist = true, timestamp = Date.now(), auraIntensity = 0) {
  ensureConversationStarted();
  const div = document.createElement('div');
  div.className = 'msg ai';

  const avatarClass = auraIntensity > 0 ? `avatar aura-ring aura-${auraIntensity}` : 'avatar';
  div.innerHTML = `<div class="${avatarClass}">A</div><div class="bubble-col"><div class="bubble"></div><div class="msg-meta"></div></div>`;

  const bubble = div.querySelector('.bubble');
  bubble.innerHTML = renderMarkdown(text);
  wireCodeCopyButtons(bubble);

  const meta = div.querySelector('.msg-meta');

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(timestamp);
  meta.appendChild(timeEl);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.title = 'Copy response';
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
      setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>'; }, 1500);
    });
  });
  actions.appendChild(copyBtn);

  const regenBtn = document.createElement('button');
  regenBtn.className = 'msg-action-btn';
  regenBtn.title = 'Regenerate response';
  regenBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>';
  regenBtn.addEventListener('click', () => regenerateFrom(div, text));
  actions.appendChild(regenBtn);

  meta.appendChild(actions);

  if (eventsEnabled && auraEvent) {
    const tag = document.createElement('div');
    tag.className = `aura-tag ${auraEvent.delta > 0 ? 'gain' : 'loss'}`;
    const sign = auraEvent.delta > 0 ? '+' : '';
    tag.textContent = `${auraEvent.type.toLowerCase()} ${sign}${auraEvent.delta}`;
    meta.appendChild(tag);
  }

  if (debugMode && debugInfo) {
    const box = document.createElement('div');
    box.className = 'debug-box';
    box.innerHTML = debugInfo;
    div.querySelector('.bubble-col').appendChild(box);
  }

  conversationInner.appendChild(div);
  scrollToBottom();

  if (persist) {
    if (currentUser && activeConvoId) {
      apiFetch(`/api/conversations/${activeConvoId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'assistant', content: text }),
      }).catch(err => console.error('failed to persist assistant message:', err));
    } else {
      // Guest: in-memory only, same as the user-message branch above.
      guestConversation.messages.push({ role: 'assistant', content: text, timestamp });
    }
  }
}

function addErrorCard(title, message, onRetry) {
  ensureConversationStarted();
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `<div class="avatar">A</div><div class="bubble-col"></div>`;
  const col = div.querySelector('.bubble-col');

  const card = document.createElement('div');
  card.className = 'error-card';
  card.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    <div class="error-card-body">
      <div class="error-card-title">${escapeHtml(title)}</div>
      <div class="error-card-msg">${escapeHtml(message)}</div>
    </div>`;
  col.appendChild(card);

  if (onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'error-retry-btn';
    retryBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Retry';
    retryBtn.addEventListener('click', () => { div.remove(); onRetry(); });
    card.querySelector('.error-card-body').appendChild(retryBtn);
  }

  conversationInner.appendChild(div);
  scrollToBottom();
}

let loadingEl = null;
function addLoading() {
  ensureConversationStarted();
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `<div class="avatar aura-ring aura-1">A</div><div class="bubble-col"><div class="thinking-row"><div class="thinking-dots"><span></span><span></span><span></span></div><button class="stop-gen-btn" id="stopGenBtn"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg> Stop</button></div></div>`;
  conversationInner.appendChild(div);
  loadingEl = div;
  scrollToBottom();
  div.querySelector('#stopGenBtn').addEventListener('click', () => {
    if (inFlightController) inFlightController.abort();
  });
}
function removeLoading() { if (loadingEl) { loadingEl.remove(); loadingEl = null; } }
function scrollToBottom() { conversation.scrollTop = conversation.scrollHeight; }

document.getElementById('suggestionRow').addEventListener('click', (e) => {
  const chip = e.target.closest('.suggestion-chip');
  if (!chip) return;
  userInput.value = chip.dataset.prompt;
  handleSend();
});

// ============================================================
// TEXTAREA AUTOSIZE
// ============================================================
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
});

// ============================================================
// BACKEND CALL — talks only to our own /api/chat
// ============================================================
async function callChatAPI(systemPrompt, userMessage, historyOverride) {
  const messages = [
    ...(historyOverride || chatHistory).slice(-10),
    { role: 'user', content: userMessage }
  ];

  inFlightController = new AbortController();
  const startedAt = performance.now();

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemPrompt, messages, model: selectedModel, maxTokens: responseLengthToTokens() }),
    signal: inFlightController.signal,
  });

  const data = await res.json();
  const clientLatency = Math.round(performance.now() - startedAt);
  inFlightController = null;

  if (!res.ok) {
    if (data.error === 'SERVER_NOT_CONFIGURED') throw new Error('NO_KEY');
    if (data.error === 'RATE_LIMITED') throw new Error('RATE_LIMITED');
    throw new Error(data.message || `Server error (${res.status})`);
  }

  return { text: data.text || '', model: data.model, latencyMs: data.latencyMs ?? clientLatency };
}

function responseLengthToTokens() {
  if (responseLength === 'concise') return 300;
  if (responseLength === 'detailed') return 1100;
  return 700;
}

// ============================================================
// AURA SYSTEM PROMPT (unchanged core, extended with new dials)
// ============================================================
function buildSystemPrompt(engineDecision, slangLevel) {
  const substanceNotice = engineDecision.requiresSubstance
    ? `\n\n⚠️ THIS IS A SUBSTANTIVE REQUEST (knowledge, math, code, writing, analysis, homework, or similar). The General AI Core leads completely here. Give a real, complete, correct answer first — explanation, working, code, whatever the question needs. A personality touch is only allowed as a small addition AFTER the substance is fully there, never as a replacement for it. If you're unsure or don't know something, say so plainly instead of guessing or hallucinating.`
    : '';

  const lengthNotice = responseLength === 'concise'
    ? 'Keep responses tight — favor brevity even for substantive answers, trimming to the essential parts.'
    : responseLength === 'detailed'
      ? 'For substantive questions, favor thoroughness — full explanations, examples, and context where useful.'
      : 'Match response length to what the question actually needs.';

  const creativityNotice = creativityLevel === 0
    ? 'Favor precise, predictable, focused phrasing.'
    : creativityLevel === 2
      ? 'Some varied, less conventional phrasing is welcome where it fits.'
      : '';

  const emojiNotice = ['Use no emoji.', 'Use at most one emoji, only if it truly fits.', 'Up to two emoji are fine if they fit naturally.', 'Emoji are welcome where they add to the tone, but never spammed.'][emojiFrequency];

  return `You are Aura AI — a genuinely capable general-purpose AI assistant that also understands internet "aura farming" (deliberately doing/saying things that increase perceived coolness, confidence, charisma). The central paradox: overdoing it becomes cringe and LOSES aura. Restraint and timing matter more than volume.

PRIORITY ORDER — always in this sequence, never reversed:
1. Safety
2. Accuracy — never sacrifice correctness for style
3. Understanding what the user actually needs
4. Helpfulness — fully answer the question or complete the task
5. Natural conversation
6. Aura / personality
7. Extra stylistic flourish

You are a real assistant first. You can explain science, math, history, code — debug programs, solve equations, summarize text, help with homework, brainstorm, reason step by step, and admit uncertainty instead of making things up. The aura personality is a communication layer on top of that competence, never a substitute for it. The user should never feel like they're talking to a meme bot instead of a real AI.

For THIS response, an internal engine has already decided the following control values for the personality layer only — they govern tone, not content:

- Response style: ${engineDecision.style} — ${STYLE_GUIDANCE[engineDecision.style]}
- Aura intensity: ${engineDecision.intensity}/4 (0=none, 4=rare max — only go big if this is 3 or 4)
- Slang guidance: ${slangGuidance(slangLevel)}
- Humor level: ${humorLevel}/4 — ${humorLevel <= 1 ? 'keep humor minimal or absent' : humorLevel >= 3 ? 'humor is welcome when it fits naturally' : 'light humor only when it clearly fits'}
- Confidence level: ${confidenceLevel}/4 — ${confidenceLevel <= 1 ? 'stay measured and understated' : confidenceLevel >= 3 ? 'a self-assured, composed tone is welcome' : 'moderate, natural confidence'}
- Emoji: ${emojiNotice}
- ${lengthNotice}
- ${creativityNotice}${substanceNotice}

Hard rules:
- Never say "aura", "+points", or announce that you're farming aura, unless the user's message itself used that word first.
- Do not use "sigma", "gigachad", or similar generic internet-tough-guy language.
- Do not repeat phrasing patterns you may have used earlier in this conversation.
- Never be cruel, mocking, or dismissive to create "aura" — confidence is not cruelty.

Respond naturally, as the character would — not like you're reading a checklist.`;
}

// ============================================================
// SEND FLOW
// ============================================================
async function handleSend() {
  const text = userInput.value.trim();
  if (!text) return;

  memory.advanceTurn();
  memory._lastUserMessage = text;

  addUser(text);
  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;
  addLoading();

  await runInference(text, chatHistory);
}

async function runInference(userText, historyForCall) {
  try {
    const activeMemory = memoryEnabled ? memory : new AuraMemory();
    const moodResult = detectMood(userText, activeMemory);
    const engineDecision = runAuraEngine(userText, moodResult, activeMemory, currentMode);
    const slangLevel = manualSlangOverride >= 0 ? manualSlangOverride : engineDecision.slangIntensity;

    const systemPrompt = buildSystemPrompt(engineDecision, slangLevel);
    let responseText, meta;
    try {
      const result = await callChatAPI(systemPrompt, userText, historyForCall);
      responseText = result.text;
      meta = result;
    } catch (err) {
      removeLoading();
      sendBtn.disabled = false;
      if (err.name === 'AbortError') return; // user pressed Stop
      if (err.message === 'NO_KEY') {
        addErrorCard('Server not configured', "The server isn't configured with a Gemini key yet. Whoever's running this needs to set GEMINI_API_KEY in the environment.", null);
      } else if (err.message === 'RATE_LIMITED') {
        addErrorCard('Too many requests', 'Give it a moment and try again.', () => runInference(userText, historyForCall));
      } else {
        addErrorCard('Connection issue', err.message, () => runInference(userText, historyForCall));
      }
      return;
    }
    if (!responseText) responseText = '...';

    let cringeResult = runCringeCheck(responseText, engineDecision, memory);

    if (cringeResult.needsRewrite) {
      try {
        const rewritePrompt = buildSystemPrompt(
          { ...engineDecision, intensity: 0, style: 'concise' }, 0
        ) + "\n\nIMPORTANT: Your previous attempt was too forced/cringe. Rewrite it plainly and helpfully with zero slang and zero attempt at being cool.";
        const rewritten = await callChatAPI(rewritePrompt, userText, historyForCall);
        if (rewritten.text) {
          responseText = rewritten.text;
          meta = rewritten;
          cringeResult = runCringeCheck(responseText, { ...engineDecision, intensity: 0, cringeRiskBase: 5 }, memory);
        }
      } catch (e) { /* keep original if rewrite fails */ }
    }

    const scoreResult = scoreAndEvent(engineDecision, cringeResult, memory);
    lastStyle = engineDecision.style;
    if (scoreResult.event) { recentEventLog.push(scoreResult.event); recentEventLog = recentEventLog.slice(-10); renderRecentEvents(); }

    if (memoryEnabled) {
      const slangUsed = (responseText.match(/\b(bro|bruh|fr|frfr|ngl|lowkey|highkey|bet|cooked|cooking|locked in|clutch|valid|mid|based)\b/gi) || []);
      const emojiUsed = (responseText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []);
      memory.addSlang(slangUsed);
      memory.addEmojis(emojiUsed);
      memory.addStyle(engineDecision.style);
      const firstSentence = responseText.split(/(?<=[.!?])\s+/)[0];
      if (firstSentence) memory.addPhrase(firstSentence);
    }

    chatHistory.push({ role: 'user', content: userText });
    chatHistory.push({ role: 'assistant', content: responseText });
    chatHistory = chatHistory.slice(-16);

    removeLoading();
    const debugInfo = debugMode ? `
      <div class="debug-title">Aura Engine</div>
      <div class="debug-grid">
        <span>Mood</span><span><b>${engineDecision.mood}</b></span>
        <span>Substance</span><span><b>${engineDecision.requiresSubstance ? 'Yes' : 'No'}</b></span>
        <span>Opportunity</span><span><b>${engineDecision.opportunity}%</b></span>
        <span>Intensity</span><span><b>${engineDecision.intensity}/4</b></span>
        <span>Style</span><span><b>${engineDecision.style}</b></span>
        <span>Slang level</span><span><b>${slangLevel}/4</b></span>
        <span>Cringe risk</span><span><b>${cringeResult.risk}%</b></span>
        <span>Aura delta</span><span><b>${scoreResult.delta > 0 ? '+' : ''}${scoreResult.delta}</b></span>
        <span>Model</span><span><b>${meta?.model || selectedModel}</b></span>
        <span>Latency</span><span><b>${meta?.latencyMs ?? '—'}ms</b></span>
        <span>Backend</span><span><b>Gemini</b></span>
      </div>
    ` : null;
    addAI(responseText, debugInfo, scoreResult.event, true, Date.now(), engineDecision.intensity);
    updateMeter();

  } catch (err) {
    removeLoading();
    addErrorCard('Something went wrong', err.message, () => runInference(userText, historyForCall));
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
  }
}

function regenerateFrom(msgDiv, originalText) {
  const lastUser = [...chatHistory].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  msgDiv.remove();
  const lastAssistantIdx = chatHistory.map(m => m.role).lastIndexOf('assistant');
  if (lastAssistantIdx !== -1) chatHistory.splice(lastAssistantIdx, 1);
  addLoading();
  runInference(lastUser.content, chatHistory.slice(0, -1));
}

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

// keep viewport usable when mobile keyboard opens
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.querySelector('.app').style.height = window.visualViewport.height + 'px';
  });
}

// ============================================================
// KICK OFF
// Checks auth state, then loads either the server's saved conversation
// list (logged in) or the local guest conversation list — this replaces
// the old unconditional localStorage-only init.
// ============================================================
checkAuthAndInit();

