// The Console shell interactions: settings (theme switcher) + new-graph / wipe
// popovers, the More menu, the ⌘K command palette, the ONE dismiss layer that
// closes every chrome panel, the global keyboard layer, and
// the proximity queue rail. The queue is a reserved forward-hook (channels /
// "what wakes Claude") — inert until that lands.
import { view, $ } from './state.js';
import { toggleMode } from './theme.js';
import {
  previewNode, ensureGraph, doExport, doWipe, updateChip, togglePopover, showReaimNote,
} from './topbar.js';
import { openOverlay, isOverlayOpen, escapeInOverlay, hasFloatPreview } from './graph-view.js';
import { openDrawer, spawnComponent } from './drawer.js';
import { togglePinMode } from './comments.js';
import { checkForUpdatesNow } from './version.js';
import { labelFor } from './labels.js';
import { initQueue, pushQueue, setRailOpener } from './queue.js';
import { initWakePanel } from './wake-panel.js';

const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/* ---------- the dismiss layer (one engine for every chrome panel) ----------
   Every transient chrome panel — the More menu, Settings, New graph, Wipe, the
   bookmark popover, the branch picker, the ⌘K palette, the shortcut legend and
   the component drawer — is dismissed HERE. Before this each one had its own
   story (or none): clicking anywhere else, or moving focus away, left them open
   until the user happened to find Escape.

   Openness is expressed two ways in the markup (`.hidden` for popovers /
   palette / legend, `.open` for the drawer), so OPEN_PANELS lists both and
   closePanel() knows which lever each one uses.

   The ordering trap: a naive document-click listener that "closes everything"
   makes the trigger button un-toggleable — the listener closes the menu, then
   the button's own click handler sees it closed and reopens it. So the dismiss
   pass runs on pointerdown and deliberately SKIPS the panel owned by whatever
   trigger was pressed (`aria-controls`, which every trigger already declares
   for a11y), leaving that panel for the trigger's own toggle to flip. */
const OPEN_PANELS = '.popover:not(.hidden), .palette:not(.hidden), .legend:not(.hidden), .drawer.open';
const openPanels = () => [...document.querySelectorAll(OPEN_PANELS)];

function closePanel(el) {
  if (!el) return;
  if (el.id === 'branch-picker') { el.remove(); return; } // built per open, not reused
  if (el.classList.contains('drawer')) { el.classList.remove('open'); return; }
  if (el.id === 'cmd-palette') { closePalette(); return; }  // also drops input focus
  el.classList.add('hidden');
  // keep any aria-expanded trigger honest — togglePopover does this on the
  // normal path, but this bulk close bypasses it.
  document.querySelectorAll(`[aria-controls="${el.id}"]`).forEach((c) => c.setAttribute('aria-expanded', 'false'));
}

// Close every open chrome panel except `keep` — the one a trigger is about to
// toggle, or the one that is being opened. Called with no argument it closes
// everything, which is what Escape and a window blur want.
function closeAllPopovers(keep) {
  for (const p of openPanels()) if (p !== keep) closePanel(p);
}

// The panel a pressed element owns, if any — `[aria-controls]` is the trigger
// contract, so a trigger is never dismissed out from under its own toggle.
function ownedPanel(el) {
  const trig = el && el.closest && el.closest('[aria-controls]');
  if (!trig) return null;
  return document.getElementById(trig.getAttribute('aria-controls'));
}

// Resolve an event to its real target — composedPath()[0] pierces a pane's
// shadow root, so a click inside a mount counts as "outside every panel".
function eventTarget(e) {
  const src = (e.composedPath && e.composedPath()[0]) || e.target;
  return src && src.nodeType === 1 ? src : (src && src.parentElement) || null;
}

function dismissFrom(el) {
  const keep = ownedPanel(el);
  for (const p of openPanels()) {
    if (p === keep) continue;
    if (el && p.contains(el)) continue; // a click/focus INSIDE a panel keeps it
    closePanel(p);
  }
}

function initDismissLayer() {
  // pointerdown, not click: it beats the trigger's own click handler, which is
  // what makes the skip-the-owned-panel dance above work.
  document.addEventListener('pointerdown', (e) => dismissFrom(eventTarget(e)), true);
  // focus leaving a panel dismisses it too (tabbing past it, or a pane taking focus)
  document.addEventListener('focusin', (e) => dismissFrom(eventTarget(e)));
  // and the whole window losing focus closes them all, like a native menu
  window.addEventListener('blur', () => closeAllPopovers());
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
  closeAllPopovers(p); // one panel at a time (see the dismiss layer)
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
  closeAllPopovers(panel); // one panel at a time (see the dismiss layer)
  panel.classList.remove('hidden');
  const nameEl = $('new-graph-name');
  if (nameEl) { nameEl.value = ''; setTimeout(() => nameEl.focus(), 0); }
}
async function startNewGraph() {
  const nameEl = $('new-graph-name');
  const name = ((nameEl && nameEl.value) || '').trim();
  $('new-graph-panel').classList.add('hidden');
  try {
    const r = await fetch('/api/graph/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const body = await r.json().catch(() => ({}));
    if (body.pending) { showReaimNote("Claude is mid-turn — the new graph starts when the turn ends."); return; }
  } catch { return; }
  view.previewing = false; view.liveSnapshot = null;
  $('main').classList.remove('preview-readonly');
}
function initNewGraph() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('btn-new-graph-go', 'click', startNewGraph);
  on('btn-new-graph-cancel', 'click', () => $('new-graph-panel').classList.add('hidden'));
  on('new-graph-name', 'keydown', (e) => { if (e.key === 'Enter') startNewGraph(); else if (e.key === 'Escape') $('new-graph-panel').classList.add('hidden'); });
}

/* ---------- wipe surface ----------
   A wipe bookmarks the point it happened at (the server sets pendingBookmark,
   so the next committed node carries the label) — which was a bookmark nobody
   could name, because the wipe fired the instant the menu item was clicked.
   #wipe-panel is the same shape as #new-graph-panel: a name field, Cancel,
   confirm. An EMPTY name still wipes and still bookmarks, just unlabelled. */
export function openWipe() {
  const panel = $('wipe-panel'); if (!panel) return;
  closeAllPopovers(panel);
  panel.classList.remove('hidden');
  const nameEl = $('wipe-name');
  if (nameEl) { nameEl.value = ''; setTimeout(() => { if (!panel.classList.contains('hidden')) nameEl.focus(); }, 0); }
}
function closeWipe() { const p = $('wipe-panel'); if (p) p.classList.add('hidden'); }
async function confirmWipe() {
  const nameEl = $('wipe-name');
  const name = ((nameEl && nameEl.value) || '').trim();
  closeWipe();
  await doWipe(name);
}
function initWipe() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('btn-wipe-go', 'click', confirmWipe);
  on('btn-wipe-cancel', 'click', closeWipe);
  on('wipe-name', 'keydown', (e) => { if (e.key === 'Enter') confirmWipe(); else if (e.key === 'Escape') closeWipe(); });
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
      export: doExport, wipe: openWipe, newgraph: openNewGraph,
      settings: openSettings, shortcuts: () => toggleLegend(true),
      checkupdate: checkForUpdatesNow,
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
    { kind: 'cmd', label: 'Wipe surface', run: openWipe },
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
  const inp = $('cmd-input');
  if (!paletteItems.length) {
    list.innerHTML = '<div class="palette-empty">no matches</div>';
    if (inp) inp.removeAttribute('aria-activedescendant');
    return;
  }
  list.innerHTML = '';
  paletteItems.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (i === paletteSel ? ' sel' : '');
    // The rows are divs driven from the input (↑/↓/↵). Give them option semantics
    // and point aria-activedescendant at the selected one so the keyboard model
    // the sighted user already has is the one a screen reader is told about.
    row.id = `cmd-opt-${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === paletteSel));
    row.innerHTML = `<span class="kind">${it.kind}</span><span>${it.label}</span>`;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); runPalette(it); });
    list.appendChild(row);
  });
  if (inp) inp.setAttribute('aria-activedescendant', `cmd-opt-${paletteSel}`);
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
  if (show) closeAllPopovers(el); // one panel at a time (see the dismiss layer)
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
  // queue.js raises push confirmations / rejections / recovery buttons inside
  // .rail-expanded. Give it the ability to PIN the rail open (not just reveal it —
  // the ack rejection lands 6s later, long after the pointer has left), so no
  // feedback is ever posted into a container the user can't see or click.
  setRailOpener(() => { railPinned = true; setRail(true); });
}
function toggleRail() { railPinned = !railPinned; setRail(railPinned); }

/* ---------- Escape: ONE owner, one precedence order ----------
   Escape used to be claimed by two document keydown listeners — this module's and
   the graph overlay's — neither stopping propagation, neither able to see the
   other's state, and their order an accident of module init order. It now has a
   single owner, and the layers are closed most-specific-first:

     1. the glance / float preview      ┐ raised from INSIDE the overlay, so they
     2. the graph rename panel          ┘ must never outlive it   (escapeInOverlay)
     3. the graph overlay itself        ┘
     4. every chrome panel + the pinned queue rail

   An editable chrome field that owns its own Escape (a comment reply draft, the
   bookmark / new-graph / wipe name, the palette input) still wins over 4 — but not
   over 1–3: the overlay is modal, and the jump box inside it holds a filter, not a
   draft, so Escape from there closes the overlay exactly as it always did. */
export function handleEscape() {
  if (escapeInOverlay()) return;      // glance ▸ rename panel ▸ the overlay
  closeAllPopovers();                 // the palette + legend are panels too
  if (railPinned) { railPinned = false; setRail(false); }
}

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
    // An editable target owns its own keys: a pane's shadow-rooted field (F12 —
    // document.activeElement only ever resolves to the pane HOST, so pierce with
    // composedPath), or a light-DOM chrome field (palette, bookmark name, jump box).
    const editable = (root && root.host && isEditable(src)) || isEditable(document.activeElement);
    if (e.key === 'Escape' && !meta) {
      // …except the modal overlay layers, which take Escape even from a field
      // inside them. See handleEscape for the full precedence order.
      if (hasFloatPreview() || isOverlayOpen() || !editable) handleEscape();
      return;
    }
    if (editable || meta) return;
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
  initWipe();
  initMoreMenu();
  initPalette();
  initRail();
  initQueue();
  initWakePanel();
  initKeyboard();
  initDismissLayer();
}
