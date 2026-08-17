// Aura AI — public/palette.js
// Command palette (Ctrl/Cmd+K). Every action is REAL — it either triggers
// an existing wired control or performs a direct operation. Conversations
// search reuses the sidebar's own client-side filter (and shows results
// you can jump to by pressing Enter with the sidebar list focused).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const overlay = document.createElement('div');
  overlay.className = 'rs-palette';
  overlay.id = 'rsPalette';
  overlay.innerHTML = `
    <div class="rs-palette-panel" role="dialog" aria-label="Command palette">
      <input class="rs-palette-input" id="rsPaletteInput" placeholder="Search Aura… (actions, conversations)" aria-label="Search Aura">
      <div class="rs-palette-list" id="rsPaletteList" role="listbox"></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#rsPaletteInput');
  const list = overlay.querySelector('#rsPaletteList');
  let selected = 0;

  const ACTIONS = [
    { label: 'New chat', icon: '＋', hint: 'Start a fresh conversation', run: () => $('newChatBtnTop')?.click() },
    { label: 'Suggest research topics', icon: '🔍', hint: 'Deep Research ideas', run: () => { close(); $('rsSuggestTopics')?.click(); } },
    { label: 'Toggle theme', icon: '◐', hint: 'Dark / light', run: () => {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        localStorage.setItem('aura_theme', next);
        root.setAttribute('data-theme', next);
        document.querySelectorAll('.theme-opt').forEach(o => o.classList.toggle('active', o.dataset.theme === next));
      } },
    { label: 'Open settings', icon: '⚙', hint: 'Models, personality, developer', run: () => $('settingsBtnTop')?.click() },
    { label: 'Search conversations', icon: '⌕', hint: 'Filter the sidebar list', run: () => {
        const si = $('searchInput');
        if (si) { si.focus(); si.select(); }
      } },
    { label: 'Focus composer', icon: '↑', hint: 'Ask Aura something', run: () => { $('userInput')?.focus(); } },
  ];

  function open() {
    overlay.classList.add('open');
    input.value = '';
    selected = 0;
    render();
    input.focus();
  }
  function close() { overlay.classList.remove('open'); }

  function render() {
    const q = input.value.trim().toLowerCase();
    const filtered = ACTIONS.filter(a => !q || a.label.toLowerCase().includes(q) || a.hint.toLowerCase().includes(q));
    list.innerHTML = '';
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rs-palette-empty';
      empty.textContent = 'No matching actions.';
      list.appendChild(empty);
      return;
    }
    filtered.forEach((a, i) => {
      const btn = document.createElement('button');
      btn.className = 'rs-palette-item' + (i === selected ? ' selected' : '');
      btn.setAttribute('role', 'option');
      btn.innerHTML = `<span class="pi-icon">${a.icon}</span><span>${a.label}</span><span class="pi-hint">${a.hint}</span>`;
      btn.addEventListener('click', () => { close(); a.run(); });
      list.appendChild(btn);
    });
    list._filtered = filtered;
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      overlay.classList.contains('open') ? close() : open();
      return;
    }
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); return; }
    const filtered = list._filtered || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    if (e.key === 'Enter' && filtered[selected]) { e.preventDefault(); close(); filtered[selected].run(); }
  });
  input.addEventListener('input', () => { selected = 0; render(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
})();
