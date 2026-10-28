// The Console shell interactions: settings (theme switcher) + new-graph / wipe
// popovers, the More menu, the ⌘K command palette, the ONE dismiss layer that
// closes every chrome panel, the global keyboard layer, and
// the proximity queue rail — live since channels landed: it shows the queued
// wake items public/app/queue.js maintains, and Q pins it open.
import { $ } from './state.js';
import { toggleMode, modeToggleable, effectiveMode, syncModeToggle } from './theme.js';
import {
  previewNode, ensureGraph, doExport, doWipe, updateChip, togglePopover, showReaimNote, leavePreview,
  returnToActive,
} from './topbar.js';
import { openOverlay, closeOverlay, isOverlayOpen, escapeInOverlay, hasFloatPreview, displayNodeList, forwardEscapeFrom } from './graph-view.js';
import { initReplay, openReplay, closeReplay, isReplayOpen, replayTargetLabel } from './replay.js';
import { openDrawer, openDrawerManage, closeDrawer, spawnComponent } from './drawer.js';
import { components as componentList } from './components.js';
import { closePinPop } from './comments.js';
import { toggle as toggleTool, disarm } from './tools.js';
import { armed } from './overlay.js';
import { checkForUpdatesNow } from './version.js';
import { labelFor, nodeTime } from './labels.js';
import { panes, revealPane } from './mounts.js';
import { paletteSections, blockHint } from './page.js';
import { initQueue, pushQueue, setRailOpener, setQueueCards } from './queue.js';
import { ELEMENT_ROW_CAP, capRows, moreLabel } from './row-caps.js';
import { initWakePanel } from './wake-panel.js';
import { isPickingFile } from './brand.js';
import { openSessions, toggleSessions } from './sessions.js';
import { closePaneHistory } from './pane-history.js';
import { isRemote } from './remote.js';
import { bus } from './bus.js';
import { escapeChatViews } from './chat-slots.js';
import { closeChat, resetChatWindow } from './chat-dock.js';
import { registerAction, registerKeyedElement, lookup, chordOf, keyFor, CONTEXTS } from './hotkeys.js';

const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/* ---------- the dismiss layer (one engine for every chrome panel) ----------
   Every transient chrome panel — the More menu, Settings, New graph, Wipe, the
   bookmark popover, the ⌘K palette, the shortcut legend and
   the component drawer — is dismissed HERE. Before this each one had its own
   story (or none): clicking anywhere else, or moving focus away, left them open
   until the user happened to find Escape.

   Openness is ONE lever now: `.hidden`, for popovers, the palette, the legend
   and the drawer alike. The drawer used to express it as `.open`, which is why
   this file carried two special cases (one in OPEN_PANELS, one in closePanel)
   and why `togglePopover` could not keep its trigger's aria-expanded honest.

   The ordering trap: a naive document-click listener that "closes everything"
   makes the trigger button un-toggleable — the listener closes the menu, then
   the button's own click handler sees it closed and reopens it. So the dismiss
   pass runs on pointerdown and deliberately SKIPS the panel owned by whatever
   trigger was pressed (`aria-controls`, which every trigger already declares
   for a11y), leaving that panel for the trigger's own toggle to flip. That is
   exactly what ＋ was missing: it declared no aria-controls, so it was dismissed
   out from under its own toggle and could never close the drawer. */
const OPEN_PANELS = '.popover:not(.hidden), .palette:not(.hidden), .legend:not(.hidden), .drawer:not(.hidden)';

/* ---------- the popover registry (PLAN.md 2A.4; verdict S-18) ----------
   OPEN_PANELS is a light-DOM selector, so a `.popover` inside a shadow root —
   an annotation tool's panel drawn in its own realm — was invisible to this
   layer: it survived Escape and an outside press. And every panel that closes
   by more than `.hidden` (the pin popover, the drawer, the palette, the replay
   player, pane history) grew closePanel by one more special case.

   A panel that needs either registers here instead:

     registerPopover({el, close, contains?, isOpen?}) → unregister
       el        the panel: an Element, or () => Element | null for one built
                 per open (the comment popover is).
       close()   how it closes — called with no argument by every path below:
                 an outside press, focus leaving it, Escape, a window blur,
                 another panel opening (closeAllPopovers).
       contains(target, path)   optional: whether a press or focus at `target`
                 (composedPath()[0]) with the event's composed `path` is inside
                 the panel. Default: the path holds the panel, or the panel
                 contains the target — so a press inside a shadow-rooted
                 popover is inside it, and one outside closes it.
       isOpen()  optional: default, the element is connected and not .hidden.

   openPanels() is the OPEN_PANELS set plus every open entry; closePanel closes
   a registered panel through its own close (the last registration of one
   element wins) and any other by `.hidden`. Still ONE layer: an entry adds no
   listener, and nothing here may grow a second outside-press or Escape path. */
const popovers = [];   // registry entries, in registration order
const panelOf = (entry) => {
  let el = null;
  try { el = typeof entry.el === 'function' ? entry.el() : entry.el; } catch (e) { console.error('[web-chat] a popover\'s el() failed', e); }
  return el && el.nodeType === 1 ? el : null;
};
function entryIsOpen(entry) {
  const el = panelOf(entry);
  if (!el) return false;
  if (entry.isOpen) {
    try { return !!entry.isOpen(); } catch (e) { console.error('[web-chat] a popover\'s isOpen() failed', e); return false; }
  }
  return el.isConnected && !el.classList.contains('hidden');
}
export function registerPopover(spec) {
  const s = spec || {};
  const elOk = typeof s.el === 'function' || (s.el && s.el.nodeType === 1);
  if (!elOk || typeof s.close !== 'function') {
    throw new TypeError('registerPopover takes {el: Element | () => Element|null, close(), contains?(target, path), isOpen?()}');
  }
  const entry = {
    el: s.el, close: s.close,
    contains: typeof s.contains === 'function' ? s.contains : null,
    isOpen: typeof s.isOpen === 'function' ? s.isOpen : null,
  };
  popovers.push(entry);
  return () => { const i = popovers.indexOf(entry); if (i >= 0) popovers.splice(i, 1); };
}
// The entry a panel element belongs to: the last registration of it wins.
function entryOf(el) {
  for (let i = popovers.length - 1; i >= 0; i--) if (panelOf(popovers[i]) === el) return popovers[i];
  return null;
}
function openPanels() {
  const out = [...document.querySelectorAll(OPEN_PANELS)];
  for (const entry of popovers) {
    if (!entryIsOpen(entry)) continue;
    const el = panelOf(entry);
    if (!out.includes(el)) out.push(el);
  }
  return out;
}

function closePanel(el) {
  if (!el) return;
  const entry = entryOf(el);
  if (entry) {
    try { entry.close(); } catch (e) { console.error('[web-chat] a popover\'s close() failed', e); }
    return;
  }
  el.classList.add('hidden');
  // keep any aria-expanded trigger honest — togglePopover does this on the
  // normal path, but this bulk close bypasses it.
  document.querySelectorAll(`[aria-controls="${el.id}"]`).forEach((c) => c.setAttribute('aria-expanded', 'false'));
}

// The five panels closePanel used to special-case, each closing exactly as it
// did. closePalette is hoisted (it is declared with the palette, below).
//   * the comment composer / chooser / thread is built per open and
//     body-appended, so it is removed, not hidden — and comments.js owns the
//     reference, hence its hook rather than el.remove() here;
//   * ONE closeDrawer: it also restores focus to ＋ and disarms a primed install;
//   * the palette's close also drops the input's focus;
//   * the replay player's also unloads the player;
//   * pane history's also unloads the version preview.
registerPopover({ el: () => document.querySelector('.pin-pop'), close: () => closePinPop() });
registerPopover({ el: () => $('drawer'), close: () => closeDrawer() });
registerPopover({ el: () => $('cmd-palette'), close: () => closePalette() });
registerPopover({ el: () => $('replay-pop'), close: () => closeReplay() });
registerPopover({ el: () => $('pane-history'), close: () => closePaneHistory() });

// Close every open chrome panel except `keep` — the one a trigger is about to
// toggle, or the one that is being opened. Called with no argument it closes
// everything, which is what Escape and a window blur want.
function closeAllPopovers(keep) {
  for (const p of openPanels()) if (p !== keep) closePanel(p);
}

// The panel a pressed element owns, if any — `[aria-controls]` is the trigger
// contract, so a trigger is never dismissed out from under its own toggle. The
// id is looked up in the trigger's own root first (a registered popover in a
// shadow root, toggled from beside it), then the document, then the registry.
function ownedPanel(el) {
  const trig = el && el.closest && el.closest('[aria-controls]');
  if (!trig) return null;
  const id = trig.getAttribute('aria-controls');
  const root = trig.getRootNode && trig.getRootNode();
  const inRoot = root && root !== document && typeof root.getElementById === 'function' ? root.getElementById(id) : null;
  return inRoot || document.getElementById(id)
    || popovers.map(panelOf).find((p) => p && p.id === id) || null;
}

// Resolve an event to its real target — composedPath()[0] pierces a pane's
// shadow root, so a click inside a mount counts as "outside every panel".
function eventTarget(e) {
  const src = (e.composedPath && e.composedPath()[0]) || e.target;
  return src && src.nodeType === 1 ? src : (src && src.parentElement) || null;
}

// Is a press or focus at `el` (with the event's composed path) inside panel p?
function insidePanel(p, el, path) {
  const entry = entryOf(p);
  if (entry && entry.contains) {
    try { return !!entry.contains(el, path || []); } catch (e) { console.error('[web-chat] a popover\'s contains() failed', e); return false; }
  }
  if (path && path.includes(p)) return true;
  return !!el && p.contains(el);
}

function dismissFrom(el, path) {
  const keep = ownedPanel(el);
  for (const p of openPanels()) {
    if (p === keep) continue;
    if (insidePanel(p, el, path)) continue; // a click/focus INSIDE a panel keeps it
    closePanel(p);
  }
}

/* ---------- docks: closed only by a pointerdown on the zones they name ----------
   A dock (the chat drawer, #chat-dock) is NOT a transient panel: it is in no
   OPEN_PANELS class, so focus leaving it, the window blurring (the user
   switching to the terminal) and another panel opening never close it. It
   declares instead WHERE an outside press closes it — `data-dismiss-zone`, a
   selector list ("#contents-nav, .well-wrap": the surface) — and it closes on a
   pointerdown inside one of those and in no other case, so the queue rail, the
   topbar, the status bar, a tray and every popover leave it open (design spec
   §7.8). A window-mode dock carries no attribute and never closes this way.

   Containment is composed: the target is walked up through each shadow root's
   host (lightOf, below), because `closest` stops at a shadow boundary and a
   press inside a pane is a press on the surface. A dock closes through its
   owner — the chat dock without pulling focus back, since the press already put
   the user somewhere — and any other zone element by `.hidden`. */
const OPEN_DOCKS = '[data-dismiss-zone]:not(.hidden)';
function closeDock(el) {
  if (el.id === 'chat-dock') { closeChat({ returnFocus: false }); return; }
  el.classList.add('hidden');
  document.querySelectorAll(`[aria-controls="${el.id}"]`).forEach((c) => c.setAttribute('aria-expanded', 'false'));
}
function dismissDocks(el) {
  const at = el && lightOf(el);
  if (!at || !at.closest) return;
  for (const dock of document.querySelectorAll(OPEN_DOCKS)) {
    const zone = dock.getAttribute('data-dismiss-zone');
    let inZone = false;
    try { inZone = !!zone && !!at.closest(zone); } catch { inZone = false; }   // a malformed selector names no zone
    if (inZone && !dock.contains(at)) closeDock(dock);
  }
}

function initDismissLayer() {
  // The drawer opens itself (it is not a `togglePopover` panel), and must still
  // obey "one panel at a time". A window event keeps that one-way: drawer.js
  // already imports from this file's neighbours, and an import back the other
  // way would close a cycle.
  window.addEventListener('wc:close-popovers', (e) => closeAllPopovers(e.detail && e.detail.keep));
  // pointerdown, not click: it beats the trigger's own click handler, which is
  // what makes the skip-the-owned-panel dance above work.
  // The same pointerdown closes an open dock pressed outside on its zones —
  // and only this path does: focus and blur below never reach a dock.
  document.addEventListener('pointerdown', (e) => {
    const el = eventTarget(e);
    dismissFrom(el, e.composedPath ? e.composedPath() : null);
    dismissDocks(el);
  }, true);
  // focus leaving a panel dismisses it too (tabbing past it, or a pane taking focus)
  document.addEventListener('focusin', (e) => {
    const el = eventTarget(e);
    // …but focus FALLING to <body> is not a move to somewhere else: it is what a
    // deliberate .blur() leaves behind — the comment thread's first-Escape draft
    // guard does exactly that — and it must not be read as an outside click.
    if (!el || el === document.body || el === document.documentElement) return;
    dismissFrom(el, e.composedPath ? e.composedPath() : null);
  });
  // and the whole window losing focus closes them all, like a native menu —
  // except (a) while a native file chooser (Settings → Brand) holds focus: that
  // blur is the user answering the panel, not leaving it; and (b) focus moving
  // INTO an iframe blurs this window too. Clicking the replay player's own
  // document is using the panel, not leaving it, so a panel holding the
  // now-focused frame is kept. (Deferred a tick: activeElement names the frame
  // only once the move has landed.)
  window.addEventListener('blur', () => {
    if (isPickingFile()) return;
    setTimeout(() => {
      const a = document.activeElement;
      // (A registered panel that holds the frame counts too.)
      const keep = a && a.tagName === 'IFRAME' ? (a.closest(OPEN_PANELS) || openPanels().find((p) => p.contains(a))) : null;
      closeAllPopovers(keep || undefined);
    }, 0);
  });
}

/* ---------- settings (theme switcher) ---------- */
async function populateThemeSelect() {
  const sel = $('settings-theme');
  if (!sel) return;
  let themes = [], current = 'earthy';
  try {
    const [list, g] = await Promise.all([
      fetch('/api/themes').then(r => r.json()),
      fetch('/api/theme?scope=global').then(r => r.json()),
    ]);
    themes = list.themes || [];
    current = g.name || 'earthy'; // no theme.json = the stock look, Earthy
  } catch {}
  sel.innerHTML = '';
  // A theme a pack installed (/api/themes tags it with the pack's name) lists
  // under "Installed", whichever tier it landed in, and says which pack — the
  // name `pack remove` takes. Everything else groups by where it lives.
  const groups = { builtin: 'built-in', installed: 'Installed', local: 'this project', system: 'system' };
  const groupOf = (t) => (t.pack && t.location !== 'builtin' ? 'installed' : t.location);
  for (const loc of Object.keys(groups)) {
    const inLoc = themes.filter(t => groupOf(t) === loc);
    if (!inLoc.length) continue;
    const og = document.createElement('optgroup');
    og.label = groups[loc];
    for (const t of inLoc) {
      const o = document.createElement('option');
      o.value = t.name;
      // A builtin pack shows its display name (`georgetown-blue` reads as
      // "Georgetown Blue"); the value stays the id apply_theme resolves. A
      // single-mode pack says so here, where the ◑ toggle's absence is chosen.
      o.textContent = (t.title || t.name) + (t.modes && t.modes.length === 1 ? ` (${t.modes[0]} only)` : '')
        + (loc === 'installed' ? ` — ${t.pack}` : '');
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
  syncModeToggle();
  populateThemeSelect();
}
function initSettings() {
  // Mode: the ◑ lever in words. toggleMode re-syncs both controls (theme.js
  // syncModeToggle), and does nothing under a single-mode pack.
  const seg = $('settings-mode');
  if (seg) seg.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-mode]');
    if (b && !b.disabled && b.dataset.mode !== effectiveMode()) toggleMode();
  });
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
  // The reset was broadcast before this answer and, while previewing, folded
  // into liveSnapshot: render it (see postSetActive in graph-view.js).
  leavePreview({ restoreSnapshot: true });
}
function initNewGraph() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('btn-new-graph-go', 'click', startNewGraph);
  on('btn-new-graph-cancel', 'click', () => $('new-graph-panel').classList.add('hidden'));
  on('new-graph-name', 'keydown', (e) => { if (e.key === 'Enter') startNewGraph(); else if (e.key === 'Escape') $('new-graph-panel').classList.add('hidden'); });
  // The graph screen's ◇ New: the same panel (the name is optional — a graph can
  // be named later by clicking its title on the canvas). The panel lives under the
  // overlay on the stacking scale, so the graph closes first.
  on('gv-new', 'click', () => { closeOverlay(); openNewGraph(); });
  on('gv-log-new', 'click', () => { closeOverlay(); openNewGraph(); });   // the phone log's ◇
}

/* ---------- wipe surface ----------
   A wipe bookmarks the point it happened at (the server sets pendingBookmark,
   so the next committed node carries the label) — which was a bookmark nobody
   could name, because the wipe fired the instant the menu item was clicked.
   #wipe-panel is the same shape as #new-graph-panel: a name field, Cancel,
   confirm. The field opens PREFILLED with a label that is true of every wipe
   ("before cleanup") and selected, so ↵ takes it and typing replaces it. An
   EMPTY name still wipes and still bookmarks, just unlabelled. */
export const WIPE_DEFAULT_NAME = 'before cleanup';
export function openWipe() {
  const panel = $('wipe-panel'); if (!panel) return;
  closeAllPopovers(panel);
  panel.classList.remove('hidden');
  const nameEl = $('wipe-name');
  if (nameEl) {
    nameEl.value = WIPE_DEFAULT_NAME;
    setTimeout(() => { if (!panel.classList.contains('hidden')) { nameEl.focus(); nameEl.select(); } }, 0);
  }
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

/* ---------- remote access setup ----------
   ⌘K "Set up remote access…" and ⋯ → Set up remote access open the setup page
   in a NEW TAB — not a pane, not a popover. The page takes a Cloudflare API
   token, so it lives on its own origin (lib/server/tunnel-setup), where no pane
   can script it; /tunnel/setup starts it and redirects there. `noopener`: this
   tab keeps no handle on it (the page also sends COOP same-origin). Offered
   only locally — setting up the tunnel is the host's act, and the portal
   refuses the route to a remote viewer anyway. */
export function openRemoteSetup() {
  window.open('/tunnel/setup', '_blank', 'noopener');
}

/* ---------- More menu ---------- */
function initMoreMenu() {
  const btn = $('btn-more');
  const menu = $('more-menu');
  // Hidden in the markup, shown once the page knows it is local — so a remote
  // viewer never sees it flash (remote.js fails closed to local).
  const setupItem = $('menu-remote-setup');
  if (setupItem) isRemote().then((remote) => { setupItem.hidden = remote; });
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); togglePopover('more-menu'); });
  if (menu) menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]'); if (!act) return;
    menu.classList.add('hidden');
    ({
      export: doExport, wipe: openWipe, newgraph: openNewGraph, replay: () => openReplay(),
      settings: openSettings, sessions: openSessions, shortcuts: () => toggleLegend(true),
      checkupdate: checkForUpdatesNow, remotesetup: openRemoteSetup,
    })[act.dataset.act]?.();
  });
}

/* ---------- command palette (⌘K) ---------- */
let paletteItems = [], paletteSel = 0;
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
/* ---------- palette sources (PLAN.md 2A.4; verdict S-19) ----------
   Rows a feature adds to ⌘K — the annotation engine's elements first — come in
   through one registration, never an edit to buildPalette:

     registerPaletteSource(name, {rows(q) → [{kind, label, hint, run}], cap?})
       → unregister

   rows(q) is called on every build with the typed query and may answer every
   row it has: the palette narrows them by its own one match (kind, label and
   hint, like every other row) and then caps them (row-caps.js capRows, cap
   default ELEMENT_ROW_CAP), the rest standing as ONE '+N more — type to narrow'
   row that narrows nothing and closes nothing. A source's rows come after the
   palette's own, sources in registration order (a re-registration of a name
   replaces it and goes last); a source that throws is reported and skipped. */
const paletteSources = new Map();   // name → {name, rows, cap}
export function registerPaletteSource(name, source) {
  const n = typeof name === 'string' ? name.trim() : '';
  const src = source || {};
  if (!n || typeof src.rows !== 'function') {
    throw new TypeError('registerPaletteSource takes (name, {rows(q) → [{kind, label, hint, run}], cap?})');
  }
  const entry = { name: n, rows: src.rows, cap: Number.isInteger(src.cap) && src.cap > 0 ? src.cap : ELEMENT_ROW_CAP };
  paletteSources.delete(n);
  paletteSources.set(n, entry);
  return () => { if (paletteSources.get(n) === entry) paletteSources.delete(n); };
}
// Every source's rows for query q, narrowed by `match` and capped per source.
function sourceRows(q, match) {
  const out = [];
  for (const s of [...paletteSources.values()]) {
    let got;
    try { got = s.rows(q); } catch (e) { console.error(`[web-chat] the palette source '${s.name}' failed`, e); continue; }
    if (!Array.isArray(got)) continue;
    const rows = [];
    for (const r of got) {
      if (!r || typeof r.label !== 'string' || !r.label) continue;
      const row = {
        kind: typeof r.kind === 'string' && r.kind ? r.kind : s.name,
        label: r.label, hint: r.hint == null ? '' : String(r.hint),
        run: typeof r.run === 'function' ? r.run : null,
      };
      if (match(row)) rows.push(row);
    }
    const capped = capRows(rows, s.cap);
    out.push(...capped.rows);
    if (capped.more) out.push({ kind: s.name, label: moreLabel(capped.more), more: true });
  }
  return out;
}

/* ---------- queue cards per element type (K.2-11, K.2-18) ----------
   An element's queue item is type-managed: the type supplies the CARD the rail
   draws for it, the engine owns the ITEM — its id, its type, stage and hold,
   remove and re-send — so a card never writes the queue itself.

     registerQueueCard(type, {render(item, slotEl, ctx), unmount?(slotEl)})
       → unregister
     queueCardOf(type) → the card, or null

   The last registration of a type wins, and its unregister restores the one
   before. The rail (queue.js itemRow) draws an element item of a registered
   type through its card, into a slot inside a row the rail owns, else its
   generic row. queue.js cannot import this file (this file imports it: the
   cycle), so the lookup is handed in, the way chat-actions hands in the
   message rows' actions; a registration redraws the rail. */
const queueCards = new Map();   // type → [{card}], the last one current
const redrawCards = setQueueCards(queueCardOf);
export function registerQueueCard(type, card) {
  const t = typeof type === 'string' ? type.trim() : '';
  if (!t || !card || typeof card.render !== 'function') {
    throw new TypeError('registerQueueCard takes (type, {render(item, slotEl, ctx), unmount?(slotEl)})');
  }
  const entry = { card };
  if (!queueCards.has(t)) queueCards.set(t, []);
  queueCards.get(t).push(entry);
  redrawCards();
  return () => {
    const stack = queueCards.get(t);
    const i = stack ? stack.indexOf(entry) : -1;
    if (i < 0) return;
    stack.splice(i, 1);
    if (!stack.length) queueCards.delete(t);
    redrawCards();
  };
}
export function queueCardOf(type) {
  const stack = typeof type === 'string' ? queueCards.get(type) : null;
  return stack && stack.length ? stack[stack.length - 1].card : null;
}

// Typed rows, as the design draws them (Theme §4c): a KIND column (node /
// section / block / command), the label, and a hint on the right — a node's time
// (labels.js nodeTime), a section's block count, a block's section number and
// type, a command's key. Every field is
// set as text (renderPalette), because node names and block titles are user- or
// agent-supplied.
async function buildPalette(q) {
  const ql = q.toLowerCase();
  const remote = await isRemote();
  const cmds = [
    { kind: 'command', label: 'Add a block…', key: keyFor('chrome.add'), run: () => openDrawer() },
    { kind: 'command', label: 'Component packs…', run: openDrawerManage },
    { kind: 'command', label: 'Open graph', key: keyFor('chrome.graph'), run: openOverlay },
    { kind: 'command', label: 'New graph', run: openNewGraph },
    { kind: 'command', label: 'Wipe surface', run: openWipe },
    { kind: 'command', label: 'Export node', run: doExport },
    ...(replayTargetLabel() ? [{ kind: 'command', label: `Replay to ${replayTargetLabel()}`, key: keyFor('chrome.replay'), run: () => openReplay() }] : []),
    { kind: 'command', label: modeToggleable() ? 'Toggle light / dark' : 'Toggle light / dark — this theme has one mode', key: keyFor('chrome.mode'), run: toggleMode },
    // Comment is a tool on the registry (U338): its C is comment's element.json
    // default, and its key the toolbar's legend row for it (tool.comment).
    { kind: 'command', label: 'Pin comment', key: keyFor('tool.comment'), run: () => toggleTool({ kind: 'tool', type: 'comment' }) },
    { kind: 'command', label: 'Settings', run: openSettings },
    { kind: 'command', label: 'Sessions…', key: keyFor('chrome.sessions'), run: openSessions },
    { kind: 'command', label: 'Chat with Claude', key: keyFor('chrome.chat'), run: openChatComposer },
    // The keyboard way out of a window dragged somewhere unusable: the handles
    // are pointer-only.
    { kind: 'command', label: 'Reset the chat window', run: resetChatWindow },
    // The first chip in the status bar: its own trigger, so the row opens what
    // a click would — the trays' first non-empty tray. Listed only while there
    // is one.
    ...(firstChip() ? [{ kind: 'command', label: 'Background tasks', run: () => { const b = firstChip(); if (b) b.click(); } }] : []),
    ...(remote ? [] : [{ kind: 'command', label: 'Set up remote access…', run: openRemoteSetup }]),
  ];
  // The blocks on the page now — the design's "block" rows. What is SHOWN
  // (panes), so while previewing an older node these are that node's blocks.
  const blocks = [...panes].map(([id, p]) => ({
    kind: 'block',
    label: p.title && p.title !== id ? `${id} · ${p.title}` : id,
    hint: blockHint(id),
    run: () => revealPane(id),
  }));
  // The page's # / ## headings (page.js outline) — a row scrolls to its heading.
  const sections = paletteSections();
  // The display topology (graph-view.displayNodeList), not view.graphCache.nodes:
  // every other viewer surface reads what the DAG draws, and a palette row for a
  // collapsed turn previewed a node with no drawn children — the topbar's ↓ dead,
  // and only displayParentOf's raw fallback to get back out of it.
  const nodes = displayNodeList().map(n => {
    const what = n.name || n.trigger_summary || '';
    return { kind: 'node', label: `${labelFor(n.id)}${what ? ' · ' + what : ''}`, hint: nodeTime(n), run: () => previewNode(n.id) };
  });
  // The ONE component cache (public/app/components.js). This module used to
  // memoise its own and never invalidate it, so a component saved mid-session —
  // or a whole pack installed from the drawer — stayed invisible here until the
  // page was reloaded. Spawning one is a command ("Add block · name").
  const comps = (await componentList()).map(c => ({
    kind: 'command', label: `Add block · ${c.name}`, hint: c.builtin ? 'built in' : '', run: () => spawnComponent(c),
  }));
  const all = [...cmds, ...sections, ...blocks, ...nodes, ...comps];
  // The kind and hint are searchable too: "block" lists the page's blocks, a
  // time finds a node, a type finds its blocks.
  const hay = (i) => `${i.kind} ${i.label} ${i.hint || ''} ${i.key || ''}`.toLowerCase();
  const match = (i) => !ql || hay(i).includes(ql);
  // …then the registered sources' rows, each capped (palette sources, above).
  paletteItems = [...all.filter(match), ...sourceRows(q, match)];
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
    row.dataset.kind = it.kind;
    // textContent, not an innerHTML template: `it.label` carries a graph node's
    // `name`, which is user- or API-supplied text the server only trim()s. A
    // bookmark named `R&D <plan>` used to render half-swallowed, and one named
    // `<img src=x onerror=…>` executed in the privileged chrome origin the
    // moment ⌘K opened. (Same reasoning as the minbar chip in mounts.js.)
    const kindEl = document.createElement('span');
    kindEl.className = 'kind';
    kindEl.textContent = it.kind;
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = it.label;
    row.append(kindEl, labelEl);
    if (it.key || it.hint) {
      const hint = document.createElement(it.key ? 'kbd' : 'span');
      hint.className = 'hint';
      hint.textContent = it.key || it.hint;
      row.appendChild(hint);
    }
    row.addEventListener('mousedown', (e) => { e.preventDefault(); runPalette(it); });
    list.appendChild(row);
  });
  if (inp) inp.setAttribute('aria-activedescendant', `cmd-opt-${paletteSel}`);
}
function runPalette(it) {
  // A source's '+N more' row stands for rows not drawn: it keeps the palette up.
  if (it && it.more) { const inp = $('cmd-input'); if (inp) inp.focus(); return; }
  closePalette(); it && it.run && it.run();
}
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

// "Message Claude": open the chat on its composer. Sent whether or not the chat
// is open — an open dock only re-applies the focus. Nothing answers it below
// 760px until the phone sheet does.
function openChatComposer() { bus.emit('chat:open', { view: 'chat', focus: 'composer' }); }
function firstChip() { const c = $('cs-chips'); return c ? c.querySelector('button') : null; }

/* ---------- keyboard legend ---------- */
const isLegendOpen = () => { const el = $('key-legend'); return !!el && !el.classList.contains('hidden'); };
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
//
// THE QUEUE ROUTE (design spec §8.7): on a narrow screen the phone sheet holds
// the rail in its Tasks → Queue page (chat-sheet-queue.js moves the element
// there; it is never cloned). It registers a route here, setQueueRoute({active,
// toggle, open}) → unregister: while route.active() answers true, the bottom
// bar's Queue and Q call route.toggle(), the opener queue.js raises for push
// feedback calls route.open(), the rail's hover does nothing while it is
// .in-sheet, railPinned is never set, and the '‹ Page' label is never applied
// (the route's module keeps #bb-queue's aria-expanded). With no route, or one
// that answers false, every path below is exactly today's. One route at a time:
// a later registration replaces the earlier one, whose unregister then does
// nothing. No listener is added or removed here when a route comes or goes.
let railPinned = false;
let queueRoute = null;
export function setQueueRoute(route) {
  if (!route || typeof route.active !== 'function' || typeof route.toggle !== 'function' || typeof route.open !== 'function') {
    throw new TypeError('setQueueRoute: expects {active, toggle, open}');
  }
  queueRoute = route;
  return () => { if (queueRoute === route) queueRoute = null; };
}
// The route in force now, or null (none, or it answers false or throws).
function routeNow() {
  const r = queueRoute;
  if (!r) return null;
  try { return r.active() ? r : null; } catch (e) { console.error('[web-chat] the queue route failed to answer', e); return null; }
}
function viaRoute(how) {
  const r = routeNow();
  if (!r) return false;
  try { r[how](); } catch (e) { console.error(`[web-chat] the queue route failed to ${how}`, e); }
  return true;
}
function setRail(open) {
  const r = $('queue-rail'); if (r) r.classList.toggle('open', open);
  // Under 760px the open rail IS the queue screen (app.css), so the bottom bar's
  // Queue [n] turns into the way back: "‹ Page". Not while the sheet holds the
  // rail: there the bar keeps 'Queue', and its aria-expanded is the route's.
  const bb = $('bb-queue');
  if (bb) {
    const routed = !!routeNow();
    const page = !!open && !routed;
    if (!routed) {
      bb.setAttribute('aria-expanded', String(!!open));
      bb.classList.toggle('on', !!open);
    }
    const label = bb.querySelector('.bb-queue-label'); if (label) label.textContent = page ? '‹ Page' : 'Queue';
    bb.setAttribute('aria-label', page ? 'Back to the page' : 'Queue to Claude');
  }
}
function initRail() {
  const rail = $('queue-rail');
  if (!rail) return;
  // Hover is a mouse affordance. A finger "enters" on touchstart and "leaves"
  // on lift, which opened and shut the rail inside one tap; touch takes the
  // click-to-pin path below instead. A rail in the sheet has no hover at all.
  const inSheet = () => rail.classList.contains('in-sheet');
  rail.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch' && !inSheet()) setRail(true); });
  rail.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !inSheet() && !railPinned) setRail(false); });
  // queue.js raises push confirmations / rejections / recovery buttons inside
  // .rail-expanded. Give it the ability to PIN the rail open (not just reveal it —
  // the ack rejection lands 6s later, long after the pointer has left), so no
  // feedback is ever posted into a container the user can't see or click. With
  // the sheet's route in force it opens the sheet on Tasks → Queue instead
  // (never a close, so the feedback always shows).
  setRailOpener(() => { if (viaRoute('open')) return; railPinned = true; setRail(true); });
  // The design's rail opens on a click as well as a hover (a touch screen has no
  // hover), and its ESC chip is a real close — the same as Escape or Q.
  const collapsed = rail.querySelector('.rail-collapsed');
  if (collapsed) collapsed.addEventListener('click', () => { if (viaRoute('open')) return; railPinned = true; setRail(true); });
  const close = rail.querySelector('.rail-close');
  if (close) close.addEventListener('click', () => { railPinned = false; setRail(false); });
}
function toggleRail() {
  if (viaRoute('toggle')) return;
  railPinned = !railPinned; setRail(railPinned);
}

/* ---------- the narrow bottom bar ----------
   Under 760px (app.css) the topbar's ↑/↓, ↩ active and Graph move to a bar under
   the thumb, beside Queue [n]. Nothing here decides anything of its own: ↑/↓ go
   through stepNode (which clicks the topbar's buttons, so the drawn-topology rule
   and the disabled state are theirs — topbar.updateChip mirrors them onto this
   bar), ↩ active is returnToActive, and Queue is the rail's own pin toggle —
   or, while the phone sheet holds the rail, its route (setQueueRoute). */
function initBottomBar() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('bb-up', () => stepNode('up'));
  on('bb-down', () => stepNode('down'));
  on('bb-return', () => returnToActive());
  on('bb-graph', () => openOverlay());
  on('bb-queue', () => toggleRail());
}

/* ---------- Escape: ONE owner, one precedence order ----------
   Escape used to be claimed by two document keydown listeners — this module's and
   the graph overlay's — neither stopping propagation, neither able to see the
   other's state, and their order an accident of module init order. It now has a
   single owner, and the layers are closed most-specific-first:

     0. the shortcut legend, when `?` summoned it over the overlay
     1. the glance / float preview      ┐ raised from INSIDE the overlay, so they
     2. the graph rename panel          ┘ must never outlive it   (escapeInOverlay)
     3. the graph overlay itself        ┘
     4. every chrome panel + the armed tool + the pinned queue rail
     5. the chat (chat-slots escapeChatViews) — only when 4 had nothing open,
        so ONE layer goes per press: a tray or the bar's note, then a detail
        view the dock pops, then the drawer (or a window holding focus)

   An editable chrome field that owns its own Escape (a comment reply draft, the
   bookmark / new-graph / wipe name, the palette input) still wins over 4 — but not
   over 0–3: the overlay is modal, and the jump box inside it holds a filter, not a
   draft, so Escape from there closes the overlay exactly as it always did. */
export function handleEscape() {
  if (isReplayOpen()) { closeReplay(); return; }  // raised above the overlay, so it goes first
  // The shortcut sheet summoned OVER the overlay is the topmost layer on screen,
  // so it closes first — the overlay under it survives that Escape.
  if (isOverlayOpen() && isLegendOpen()) { toggleLegend(false); return; }
  if (escapeInOverlay()) return;      // glance ▸ rename panel ▸ the overlay
  // Read BEFORE anything closes: whether this press had a chrome layer to take.
  const hadLayer = openPanels().length > 0 || railPinned || !!armed();
  closeAllPopovers();                 // the palette, the legend and a comment thread are panels too
  if (armed()) disarm();              // …and Escape puts the armed tool down (pin mode is comment armed)
  if (railPinned) { railPinned = false; setRail(false); }
  if (!hadLayer) escapeChatViews();   // the chat is the last layer, one per press
}

/* ---------- modality: the three modal layers ----------
   The graph overlay, the ⌘K palette and the replay player each declare
   role="dialog" aria-modal="true" (index.html), and nothing kept that promise:
   Tab walked out of them into the panes hidden underneath, and a keystroke from
   a pane field went into that field unseen. This module owns modality for all
   three, observing them by id so neither graph-view.js nor replay.js has to know:

     * while one is open, everything BEHIND it in #stage — the page, the topbar,
       the rail, the bottom bar, and a modal under the top one — is `inert`, so
       focus, Tab and a screen reader's cursor stay in the dialog. A chrome panel
       raised OVER a modal (the graph's rename panel, the bookmark popover, the
       shortcut legend) stays live, and so do the in-page notice (#reaim-note,
       role=status — a note raised FROM the graph screen must still be announced,
       and its hover/focus hold must still engage) and what a modal puts outside
       #stage (the glance, a comment thread).
     * on close, focus goes back where it was when the modal opened — but only
       if it was left stranded (on <body>, or inside the now-hidden layer), and
       not when the modal's own action opened a panel that holds it now. The
       graph overlay also hands focus back itself (graph-view.js closeOverlay's
       returnFocusTo), synchronously as it hides — while this layer's observer
       has not yet run and the page is still inert, so a browser refuses that
       focus() whenever the opener was behind the overlay. The restore here runs
       after the inert pass, and acts only when focus was left stranded, so the
       two never fight; it is the one that lands for an opener on the page.
     * a keystroke from an editable field behind the open modal is dropped in the
       capture phase (initKeyboard), for the browsers and the moments where
       `inert` has not caught up — the overlay's own jump box and the palette's
       input are inside their modal and keep every key.

   Tab and reader order WITHIN the page still follow the DOM, not a run's visual
   (CSS `order`) arrangement, and drag / resize have no keyboard path yet. */
const MODALS = ['replay-pop', 'overlay', 'cmd-palette'];   // topmost first
// Over a modal, the notice, or the chat status bar: never inert. The bar is a
// row of #stage that no modal covers (the graph overlay is inset by its height,
// design spec §7.1), so it stays live beside the graph — what Claude is doing,
// and the way to the chat, are never shut off by the screen the user opened.
const LAYERS = '.popover, .legend, .drawer, .reaim-note, #chat-statusbar';
const isShown = (el) => !!el && !el.classList.contains('hidden');
const topModal = () => MODALS.map((id) => $(id)).find(isShown) || null;
const modalOf = (el) => MODALS.map((id) => $(id)).find((m) => m && el && m.contains(el)) || null;

// Is this child of #stage behind the open modal `top`?
function behind(child, top) {
  if (!top || child === top) return false;
  if (MODALS.includes(child.id)) return true;   // a modal under the top one
  return !child.matches(LAYERS);
}
// The light-DOM element a node sits under: a pane's field → its mount host.
function lightOf(n) {
  while (n && n.getRootNode) {
    const r = n.getRootNode();
    if (!r || !r.host) break;
    n = r.host;
  }
  return n;
}
function isBehindModal(node) {
  const top = topModal();
  const stage = $('stage');
  if (!top || !stage) return false;
  let n = lightOf(node);
  while (n && n.parentElement !== stage) n = n.parentElement;
  return !!n && behind(n, top);
}
// What holds focus, through any shadow root (a pane's field, not its host).
function deepActive() {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

const inerted = new Set();    // the elements THIS layer made inert
const wasOpen = new Map();    // modal id → open at the last sync
const openers = new Map();    // modal id → where focus was when it opened
const entered = new Map();    // modal id → where focus came from when it moved in
let lastOutside = null;       // the last element focused outside every modal

// The overlay moves focus into itself synchronously as it opens, before any
// observer can look, so where focus came FROM is recorded on the way in.
function trackFocus(e) {
  const t = (e.composedPath && e.composedPath()[0]) || e.target;
  const m = modalOf(lightOf(t));
  if (!m) { lastOutside = t; return; }
  if (entered.has(m.id)) return;
  const from = e.relatedTarget;
  entered.set(m.id, !from ? null : (modalOf(from) ? from : lastOutside));
}

function openerFor(modal) {
  const a = deepActive();
  if (a && a !== document.body && !modal.contains(lightOf(a))) return a;
  return entered.get(modal.id) || null;
}

function restoreFocus(modal) {
  const opener = openers.get(modal.id);
  openers.delete(modal.id);
  entered.delete(modal.id);
  const a = document.activeElement;
  const stranded = !a || a === document.body || modal.contains(a);
  if (!stranded || !opener || !opener.isConnected) return;
  // The modal's action opened a panel (⌘K → Settings, → Wipe…): it owns focus.
  if (openPanels().length) return;
  const top = topModal();
  const home = lightOf(opener);
  if (top && !top.contains(home)) return;
  if (!home || home.closest('.hidden, [inert]')) return;
  try { opener.focus({ preventScroll: true }); } catch {}
}

function syncModality() {
  const stage = $('stage');
  if (!stage) return;
  const closed = [];
  for (const id of MODALS) {
    const el = $(id);
    const open = isShown(el);
    if (open && !wasOpen.get(id)) openers.set(id, openerFor(el));
    if (!open && wasOpen.get(id)) closed.push(el);
    wasOpen.set(id, open);
  }
  const top = topModal();
  for (const child of stage.children) {
    const want = behind(child, top);
    if (want && !child.hasAttribute('inert')) { child.setAttribute('inert', ''); inerted.add(child); }
    else if (!want && inerted.has(child)) { child.removeAttribute('inert'); inerted.delete(child); }
  }
  // After the inert pass: an opener behind the modal is focusable again now.
  for (const el of closed) restoreFocus(el);
}

function initModality() {
  const MO = window.MutationObserver;
  const obs = MO ? new MO(syncModality) : null;
  for (const id of MODALS) {
    const el = $(id);
    if (el && obs) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('focusin', trackFocus, true);
  syncModality();
}

/* ---------- global keyboard layer ---------- */
function initKeyboard() {
  // Before anything else sees it — the pane's own listeners, this layer's
  // `editable` early return below, the graph's single-key handler (which reads
  // the retargeted pane HOST, a <div>, as not editable): a keystroke from an
  // editable field BEHIND an open modal is dropped. Escape and Tab stay
  // navigation, and a ⌘/Ctrl chord is the browser's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab' || e.metaKey || e.ctrlKey) return;
    const src = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!isEditable(src) || !isBehindModal(src)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
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
      if (hasFloatPreview() || isOverlayOpen() || isReplayOpen() || !editable) handleEscape();
      return;
    }
    // Every other key is ONE lookup in the hotkey registry (public/app/hotkeys.js),
    // over the defaults registered below (registerKeyDefaults) ⊕ the user's
    // bindings ⊕ this project's. A single key never fires from an editable field
    // (only ⌘K, whenField, does); a ⌘/Ctrl chord other than ⌘K is the browser's.
    // The overlay owns every other single key while it is open (arrows, Space, ↵,
    // A, E, B — graph-view.js), so it is its own context: only the actions that
    // answer there (`?`, whose sheet opens over it; ⌘K, which it swallows) do.
    // e.repeat rides along: an action registered repeat: false (the last-tool
    // toggle) fires once per press, never on the key's auto-repeat — the
    // registry's rule, not this dispatch's.
    const a = lookup(chordOf(e), isOverlayOpen() ? 'overlay' : 'page', { inField: editable, repeat: e.repeat === true });
    if (a) { e.preventDefault(); a.run(); }
  });
}
async function stepNode(dir) {
  await ensureGraph();
  const btn = $(dir === 'up' ? 'btn-up' : 'btn-down');
  if (btn && !btn.disabled) btn.click();
}

/* ---------- the chrome's keys, registered in the hotkey registry ----------
   Every key the page binds, as the table the registry looks up, the legend and
   the palette's key column are drawn from, and a binding record names
   (`{kind: 'chrome', action: <id>}`, the user record only). The ids are stable:
   records name them. The rows with no `run` are descriptive — the graph
   overlay's and the replay player's keys (their own handlers in graph-view.js
   and replay.js keep them while open) and Escape (one owner, handleEscape) —
   listed for the legend, never looked up and never rebindable. */
function registerKeyDefaults() {
  const K = 'Keyboard';
  const G = 'In the graph';
  // ⌘K opens the palette from anywhere (even inside a field) — except under a
  // modal layer. The palette paints BELOW the graph overlay, the glance and the
  // replay player, so opening it there hid a focused #cmd-input under them: it
  // stole the graph's keys, and ↵ ran a row nobody could see. The graph has its
  // own jump box, so ⌘K there does nothing (and the browser's own ⌘K is still
  // suppressed). Fixed: no record may bind a Mod+ chord, or rebind this row.
  registerAction({ id: 'chrome.palette', label: 'Command palette', defaultChord: 'Mod+K', context: ['page', 'overlay'],
    whenField: true, rebindable: false, legend: { section: K, order: 10 },
    run: () => { if (!(isOverlayOpen() || hasFloatPreview() || isReplayOpen())) openPalette(); } });
  registerAction({ id: 'chrome.graph', label: 'Open graph', defaultChord: 'G', legend: { section: K, order: 20 },
    run: () => openOverlay() });
  // Still SPAWN — Library is the drawer's default tab.
  registerAction({ id: 'chrome.add', label: 'Add a block…', defaultChord: 'N',
    legend: { section: K, order: 30, label: 'Blocks · packs' }, run: () => openDrawer() });
  registerAction({ id: 'chrome.bookmark', label: 'Bookmark node', defaultChord: 'B', legend: { section: K, order: 40 },
    run: () => { togglePopover('bookmark-pop', true); const bm = $('bookmark-name'); if (bm) setTimeout(() => bm.focus(), 0); } });
  // To the node on screen.
  registerAction({ id: 'chrome.replay', label: 'Replay to node', defaultChord: 'R', legend: { section: K, order: 50 },
    run: () => openReplay() });
  // (Comment's C is no chrome row: it is comment's element.json default,
  // through tools.js's default source, and the toolbar draws its legend row.)
  registerAction({ id: 'chrome.prev', label: 'Previous node', defaultChord: '[',
    legend: { section: K, order: 70, row: 'step', label: 'Previous / next node' }, run: () => stepNode('up') });
  registerAction({ id: 'chrome.next', label: 'Next node', defaultChord: ']',
    legend: { section: K, order: 70, row: 'step' }, run: () => stepNode('down') });
  registerAction({ id: 'chrome.rail', label: 'Toggle queue rail', defaultChord: 'Q', legend: { section: K, order: 80 },
    run: () => toggleRail() });
  registerAction({ id: 'chrome.push', label: 'Push queue → Claude', defaultChord: 'P', legend: { section: K, order: 90 },
    run: () => pushQueue() });
  // M, "Message Claude" (the bar's step advertises aria-keyshortcuts="M").
  // Inert under a float preview and the replay player, as ⌘K is; the overlay
  // and an editable field already keep it out.
  registerAction({ id: 'chrome.chat', label: 'Chat with Claude', defaultChord: 'M', legend: { section: K, order: 100 },
    enabled: () => !(hasFloatPreview() || isReplayOpen()), run: () => openChatComposer() });
  registerAction({ id: 'chrome.sessions', label: 'Sessions on this computer', defaultChord: 'S',
    legend: { section: K, order: 110 }, run: () => toggleSessions() });
  registerAction({ id: 'chrome.mode', label: 'Light / dark', defaultChord: 'T', legend: { section: K, order: 120 },
    run: () => toggleMode() });
  registerAction({ id: 'replay.play', label: 'Replay: play · step', defaultChord: ['Space', 'ArrowLeft', 'ArrowRight'],
    context: 'replay', legend: { section: K, order: 130 }, run: null });
  // `?` is the one key the overlay's own status line advertises, so the
  // shortcut sheet opens over it too.
  registerAction({ id: 'chrome.legend', label: 'Shortcuts', defaultChord: ['?', 'Shift+/'], context: ['page', 'overlay'],
    legend: { section: K, order: 140, row: 'legend', label: 'Shortcuts · close' }, run: () => toggleLegend() });
  registerAction({ id: 'chrome.escape', label: 'Close one layer', defaultChord: 'Escape', context: CONTEXTS,
    legend: { section: K, order: 140, row: 'legend' }, run: null });
  const graphRow = (id, label, chords, order) => registerAction({ id, label, defaultChord: chords, context: 'overlay',
    legend: { section: G, order }, run: null });
  graphRow('graph.select', 'Select node', ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'], 200);
  graphRow('graph.glance', 'Glance preview', 'Space', 210);
  graphRow('graph.open', 'Open node', 'Enter', 220);
  graphRow('graph.active', 'Set active', 'A', 230);
  graphRow('graph.export', 'Export node', 'E', 240);
  graphRow('graph.bookmark', 'Bookmark node', 'B', 250);
  graphRow('graph.replay', 'Replay to node', 'R', 260);
  graphRow('graph.escape', 'Deselect · close graph', 'Escape', 270);
  // The topbar's buttons that name a key in their title, aria-label or <kbd>
  // (drawer.js and theme.js rewrite two of those titles; the registry puts the
  // bound key back each time).
  for (const [el, id] of [['cmd-trigger', 'chrome.palette'], ['btn-add', 'chrome.add'], ['btn-bookmark', 'chrome.bookmark'],
    ['btn-up', 'chrome.prev'], ['btn-down', 'chrome.next'],
    ['btn-theme-toggle', 'chrome.mode'], ['btn-graph', 'chrome.graph'],
    // …and the status bar's step, whose aria-keyshortcuts chat-bar.js sets.
    ['cs-step', 'chrome.chat']]) registerKeyedElement(el, id);
}

export function initShell() {
  initSettings();
  initNewGraph();
  initWipe();
  initMoreMenu();
  initPalette();
  initRail();
  initBottomBar();
  initQueue();
  initWakePanel();
  // The replay overlay's two hand-offs, injected so it imports neither the
  // graph viewer nor (through topbar) the mount engine: opening a node on the
  // surface — a preview, and out of the graph overlay if it was raised there —
  // and the Escape forwarder the graph viewer uses for its own preview frames.
  initReplay({
    openNode: (id) => { previewNode(id); if (isOverlayOpen()) closeOverlay(); },
    forwardEscapeFrom,
    mode: effectiveMode,
  });
  registerKeyDefaults();
  initKeyboard();
  initDismissLayer();
  initModality();
}
