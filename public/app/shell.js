// The Console shell interactions: settings (theme switcher) + new-graph popovers
// (ports), the More menu, the ⌘K command palette, the global keyboard layer, and
// the proximity queue rail. The queue is a reserved forward-hook (channels /
// "what wakes Claude") — inert until that lands.
import { view, $ } from './state.js';
import { toggleMode } from './theme.js';
import {
  previewNode, ensureGraph, doExport, doWipe, updateChip, togglePopover,
} from './topbar.js';
import { openOverlay, isOverlayOpen } from './graph-view.js';
import { openDrawer, spawnComponent } from './drawer.js';
import { togglePinMode } from './comments.js';
import { labelFor } from './labels.js';
import { initQueue, pushQueue } from './queue.js';
import { initWakePanel } from './wake-panel.js';

const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
function closeAllPopovers() {
  document.querySelectorAll('.popover:not(.hidden), #settings-panel:not(.hidden), #new-graph-panel:not(.hidden)').forEach(p => p.classList.add('hidden'));
  const bp = $('branch-picker'); if (bp) bp.remove();
}

/* ---------- settings (theme switcher) ---------- */
async function populateThemeSelect() {
  const sel = $('settings-theme');
  if (!sel) return;
  let themes = [], current = 'web-chat';
  try {
    const [list, g] = await Promise.all([
      fetch('/api/themes').then(r => r.json()),
      fetch('/api/theme?scope=global').then(r => r.json()),
    ]);
    themes = list.themes || [];
    current = g.name || 'web-chat';
  } catch {}
  sel.innerHTML = '';
  const groups = { builtin: 'built-in', local: 'this project', system: 'system' };
  for (const loc of Object.keys(groups)) {
    const inLoc = themes.filter(t => t.location === loc);
    if (!inLoc.length) continue;
    const og = document.createElement('optgroup');
    og.label = groups[loc];
    for (const t of inLoc) {
      const o = document.createElement('option');
      o.value = t.name; o.textContent = t.name;
      if (t.name === current) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}
export function openSettings() {
  const p = $('settings-panel'); if (!p) return;
  p.classList.remove('hidden');
  populateThemeSelect();
}
function initSettings() {
  const sel = $('settings-theme');
  if (sel) sel.addEventListener('change', async () => {
    await fetch('/api/theme/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sel.value, scope: 'global' }),
    });
  });
}

/* ---------- new graph ---------- */
export function openNewGraph() {
  const panel = $('new-graph-panel'); if (!panel) return;
  panel.classList.remove('hidden');
  const nameEl = $('new-graph-name');
  if (nameEl) { nameEl.value = ''; setTimeout(() => nameEl.focus(), 0); }
}
async function startNewGraph() {
  const nameEl = $('new-graph-name');
  const name = ((nameEl && nameEl.value) || '').trim();
  $('new-graph-panel').classList.add('hidden');
  view.previewing = false; view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
  try {
    await fetch('/api/graph/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  } catch {}
}
function initNewGraph() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('btn-new-graph-go', 'click', startNewGraph);
  on('btn-new-graph-cancel', 'click', () => $('new-graph-panel').classList.add('hidden'));
  on('new-graph-name', 'keydown', (e) => { if (e.key === 'Enter') startNewGraph(); else if (e.key === 'Escape') $('new-graph-panel').classList.add('hidden'); });
}

/* ---------- More menu ---------- */
function initMoreMenu() {
  const btn = $('btn-more');
  const menu = $('more-menu');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); togglePopover('more-menu'); });
  if (menu) menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]'); if (!act) return;
    menu.classList.add('hidden');
    ({
      export: doExport, wipe: doWipe, newgraph: openNewGraph,
      settings: openSettings, shortcuts: () => toggleLegend(true),
    })[act.dataset.act]?.();
  });
}

/* ---------- command palette (⌘K) ---------- */
let paletteItems = [], paletteSel = 0, componentCache = null;
export function openPalette() {
  const pal = $('cmd-palette'); if (!pal) return;
  closeAllPopovers();
  pal.classList.remove('hidden');
  const inp = $('cmd-input');
  inp.value = '';
  buildPalette('');
  // guard the deferred focus: if the palette was closed again before this fires,
  // don't re-focus the input (else focus lingers and swallows single-key shortcuts).
  setTimeout(() => { if (!pal.classList.contains('hidden')) inp.focus(); }, 0);
}
function closePalette() {
  const p = $('cmd-palette'); if (p) p.classList.add('hidden');
  const inp = $('cmd-input'); if (inp) inp.blur(); // else focus lingers and swallows single-key shortcuts
}
async function ensureComponents() {
  if (componentCache) return componentCache;
  try { componentCache = (await fetch('/api/components').then(r => r.json())).components || []; }
  catch { componentCache = []; }
  return componentCache;
}
async function buildPalette(q) {
  const ql = q.toLowerCase();
  const cmds = [
    { kind: 'cmd', label: 'New pane', run: openDrawer },
    { kind: 'cmd', label: 'Open graph', run: openOverlay },
    { kind: 'cmd', label: 'New graph', run: openNewGraph },
    { kind: 'cmd', label: 'Wipe surface', run: doWipe },
    { kind: 'cmd', label: 'Export node', run: doExport },
    { kind: 'cmd', label: 'Toggle light / dark', run: toggleMode },
    { kind: 'cmd', label: 'Pin comment', run: togglePinMode },
    { kind: 'cmd', label: 'Settings', run: openSettings },
  ];
  const nodes = (view.graphCache?.nodes || []).map(n => ({
    kind: 'node', label: `${labelFor(n.id)}${n.name ? ' · ' + n.name : ''}`, run: () => previewNode(n.id),
  }));
  const comps = (await ensureComponents()).map(c => ({
    kind: 'component', label: c.name, run: () => spawnComponent(c),
  }));
  const all = [...cmds, ...nodes, ...comps];
  paletteItems = ql ? all.filter(i => i.label.toLowerCase().includes(ql)) : all;
  paletteSel = 0;
  renderPalette();
}
function renderPalette() {
  const list = $('cmd-list'); if (!list) return;
  if (!paletteItems.length) { list.innerHTML = '<div class="palette-empty">no matches</div>'; return; }
  list.innerHTML = '';
  paletteItems.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (i === paletteSel ? ' sel' : '');
    row.innerHTML = `<span class="kind">${it.kind}</span><span>${it.label}</span>`;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); runPalette(it); });
    list.appendChild(row);
  });
}
function runPalette(it) { closePalette(); it && it.run && it.run(); }
function initPalette() {
  const inp = $('cmd-input');
  const trigger = $('cmd-trigger');
  if (trigger) trigger.addEventListener('click', openPalette);
  if (!inp) return;
  inp.addEventListener('input', () => buildPalette(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteItems.length - 1, paletteSel + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(0, paletteSel - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteItems[paletteSel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
}

/* ---------- keyboard legend ---------- */
function toggleLegend(force) {
  const el = $('key-legend'); if (!el) return;
  const show = force === undefined ? el.classList.contains('hidden') : force;
  el.classList.toggle('hidden', !show);
}

/* ---------- queue rail (hover to reveal) ---------- */
// Expand when the cursor is over the rail tab itself, retract when it leaves — a
// proximity zone reached too far left and stole the cursor before it could hit
// the pane header buttons (close/minimize/pin). Q still pins it open. The rail's
// content (items, push, count) is owned by queue.js; this file only handles the
// reveal/toggle chrome + the P shortcut.
let railPinned = false;
function setRail(open) { const r = $('queue-rail'); if (r) r.classList.toggle('open', open); }
function initRail() {
  const rail = $('queue-rail');
  if (!rail) return;
  rail.addEventListener('pointerenter', () => setRail(true));
  rail.addEventListener('pointerleave', () => { if (!railPinned) setRail(false); });
}
function toggleRail() { railPinned = !railPinned; setRail(railPinned); }

/* ---------- global keyboard layer ---------- */
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    // ⌘K opens the palette from anywhere (even inside a field).
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); return; }
    // Focus ownership: panes are shadow-rooted mounts, so a keystroke whose real
    // target lives in a shadow root belongs to that pane — but only stand down when
    // that target is EDITABLE (B5: a focused pane BUTTON must not swallow single-key
    // hotkeys; only typing does). document.activeElement only ever resolves to the pane
    // HOST (a <div>), never the <input> inside it, so isEditable(activeElement) alone
    // can't see typing inside a pane — composedPath()[0] pierces to the true target
    // (same idiom as comments.js).
    const src = e.composedPath && e.composedPath()[0];
    const root = src && src.getRootNode && src.getRootNode();
    if (root && root.host && isEditable(src)) return; // editable pane target owns the key
    // Light-DOM chrome fields (palette, bookmark name, jump box) still guard by activeElement.
    if (isEditable(document.activeElement) || meta) return;
    // Escape sits BELOW the focus guards (F12) so typing in any editable/shadow context
    // never triggers a chrome-wide close/unpin (e.g. a reply draft mid-type).
    if (e.key === 'Escape') {
      closePalette(); closeAllPopovers(); toggleLegend(false);
      if (railPinned) { railPinned = false; setRail(false); }
      return;
    }
    if (isOverlayOpen()) return;
    switch (e.key) {
      case 'q': case 'Q': e.preventDefault(); toggleRail(); break;
      case 'p': case 'P': e.preventDefault(); pushQueue(); break;
      case 'g': case 'G': e.preventDefault(); openOverlay(); break;
      case 'n': case 'N': e.preventDefault(); openDrawer(); break;
      case 't': case 'T': e.preventDefault(); toggleMode(); break;
      case 'c': case 'C': e.preventDefault(); togglePinMode(); break;
      case 'b': case 'B': e.preventDefault(); togglePopover('bookmark-pop', true); { const bm = $('bookmark-name'); if (bm) setTimeout(() => bm.focus(), 0); } break;
      case '[': e.preventDefault(); stepNode('up'); break;
      case ']': e.preventDefault(); stepNode('down'); break;
      case '?': e.preventDefault(); toggleLegend(); break;
      case '/': if (e.shiftKey) { e.preventDefault(); toggleLegend(); } break;
      default: break;
    }
  });
}
async function stepNode(dir) {
  await ensureGraph();
  const btn = $(dir === 'up' ? 'btn-up' : 'btn-down');
  if (btn && !btn.disabled) btn.click();
}

export function initShell() {
  initSettings();
  initNewGraph();
  initMoreMenu();
  initPalette();
  initRail();
  initQueue();
  initWakePanel();
  initKeyboard();
}
