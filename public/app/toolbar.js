// The annotation toolbar (annotation engine 2D.8 and 2D.7's "comment on the
// registry"; DECISIONS.md I.6, K.1 C2 = b; notes-read-toolbar.md §1, W-7, W-12,
// W-17). A MINIMAL, FUNCTIONAL toolbar from the mock-ups' model — pinned slots
// in order, the hidden tools behind a reveal, one armed tool, the small
// settings on the armed slot — whose LOOK is expected to change with the design
// studio's final mock-up (H-2 b): the look is one render function per surface
// (renderBar, renderTray) and one app.css block (`toolbar (U338)`), tokens only.
//
// What it draws from, never a copy of its own:
//   toolbar-state.js  toolbarState().tools (GET /api/toolbar's tools[], U337 —
//                     no second GET), project.pinned / hidden, canWrite,
//                     canWriteUser; every write is patchToolbar({pinned} |
//                     {hidden}) — the project record through U332's route,
//                     never browser storage, never state.store — and the redraw
//                     comes from the `toolbar` frame (onToolbarChange).
//   tools.js          arming (toggle / disarm, U337) over the overlay's ONE
//                     armed-tool state (K.2-3): this module keeps no armed
//                     copy; `tools:notice` refusals are drawn as one transient
//                     line of text.
//   tool-settings.js  the small and large settings frames (U336): the armed
//                     slot clicked again opens the small one anchored to it,
//                     editing the profile armed().profile names (K.2-14).
//   hotkeys.js        the key shown in a slot's title is the one bound now; a
//                     listed tool's bound arm key gets a DESCRIPTIVE legend row
//                     `tool.<type>` (comment's "Pin comment · C", where the
//                     chrome's own C row used to be), so the legend and the
//                     palette (keyFor('tool.comment')) follow a rebind.
//   input-mode.js     the finger-draws switch: this DEVICE's auto / on / off
//                     (setFingerDraws, browser storage through U334, drawn at
//                     every level); on the host only, "make this my default"
//                     writes the user record (patchUserToolbar, K.2-15).
//
// THE SURFACES. Desktop (≥ 760 px): #toolbar in #topbar after #dock — the
// pointer tool #tb-pointer (a chrome control, not a slot), #tb-slots (one
// button per pinned, listed type; a hidden tool armed from its key or the tray
// shows as one extra "visiting" slot), #tb-reveal. Narrow (< 760 px): #bb-tools
// in #bottombar between the stepper / ↩ active and Graph (ruling C3's note) —
// the armed tool or the pointer as one button, the slots that fit, and
// #bb-tools-reveal. Both reveals open ONE tray, #tb-tray, a .popover in the
// shell's registry (closed by its one dismiss layer and Escape owner).
//
// TEXT ONLY. Every pack string (a label, a pack name) reaches the DOM through
// textContent or an attribute, never markup. Icons are <img> from
// /api/toolbar/icon/<type> (?mode=dark when web-chat's own mode is dark —
// <html data-theme>, never the browser's scheme); a type without icons gets a
// generic glyph.
//
// Below `full` (canWrite false) the tray is view only: every control disabled
// but this device's finger-draws switch, and "View only: pins and order belong
// to the host." Arming there is refused by tools.js with its notice.
//
// NOT here (later, with the mock-up or 4A/4B): a hotkey pane or rebinding UI,
// profile management, the not-installed popup (W-11), API-key or pack-state
// chips (W-14, W-15), tool-drawn settings content.
import { bus } from './bus.js';
import { toolbarState, onToolbarChange, patchToolbar, patchUserToolbar, settingsOf, iconSrc } from './toolbar-state.js';
import { toggle, disarm, listedTools, visiting, NOTICE } from './tools.js';
import { armed, onArmedChange } from './overlay.js';
import { registerAction, bindingsView, onHotkeysChange } from './hotkeys.js';
import { openToolSettings, closeToolSettings, isToolSettingsOpen } from './tool-settings.js';
import { registerPopover, handleEscape } from './shell.js';
import { isNarrow } from './viewport.js';
import { FINGER_DRAWS_MODES, fingerDraws, fingerDrawsMode, setFingerDraws, onFingerDrawsChange } from './input-mode.js';

export const GUTTER = 16;          // px kept clear at every viewport edge (the tray)
export const GAP = 6;              // px between the reveal (or the bottom bar) and the tray
export const NOTICE_MS = 4000;     // how long a notice line stays
export const LEGEND_SECTION = 'Keyboard';
export const LEGEND_ORDER = 60;    // where the chrome's "Pin comment" row stood
// The phone half's slots "that fit": an estimate from the window's width — the
// bottom bar's other controls take about PHONE_BAR_FIXED px at a phone's
// layout, each slot PHONE_SLOT_PX — never fewer than one. The real fit is the
// maintainer's real-phone check (E3).
export const PHONE_BAR_FIXED = 340;
export const PHONE_SLOT_PX = 50;

// The art board's strings.
export const STRINGS = Object.freeze({
  pinned: 'Pinned · slot order',
  hidden: 'Hidden · by pack',
  listed: 'Listed · not pinned',
  filter: 'Filter tools',
  slotKeys: 'Slot keys 1–9 follow the pinned order',
  viewOnly: 'View only: pins and order belong to the host.',
  noPinned: 'No pinned tools',
  fingerDraws: 'Finger draws · this device',
  fingerAuto: 'auto: finger-draws on until a pen is seen on this device',
  fingerPan: 'one finger draws, two fingers scroll',
  penSeen: 'a pen has been seen here',
  penNotSeen: 'no pen seen here yet',
  makeDefault: 'Make this my default on every device',
  more: 'More settings…',
});

const ACTION_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

// ── reading the records ─────────────────────────────────────────────────────

const toolOf = (type) => listedTools().find((t) => t.type === type) || null;
const labelOf = (t) => (t && str(t.label)) || (t && str(t.type)) || '';
const packOf = (t) => (t && isObject(t.pack) && str(t.pack.name)) || '';
const canWrite = () => toolbarState().canWrite !== false;
function lists() {
  const p = toolbarState().project || {};
  return {
    pinned: Array.isArray(p.pinned) ? p.pinned.filter((x) => typeof x === 'string') : [],
    hidden: Array.isArray(p.hidden) ? p.hidden.filter((x) => typeof x === 'string') : [],
  };
}
// A tool's icon URL is toolbar-state.js's iconSrc (one spelling of the route).

// The chords bound to arm a tool now (no profile), as the registry merged them.
function chordsOfTool(type) {
  const out = [];
  for (const b of bindingsView()) {
    if (b.unbound || b.inert || b.descriptive) continue;
    const t = b.target;
    if (isObject(t) && t.kind === 'tool' && t.type === type && !t.profile) out.push(b);
  }
  return out;
}
// The display of the first key that arms `type`, or ''.
export function toolKey(type) {
  const b = chordsOfTool(type)[0];
  return b ? b.display : '';
}

// ── the legend rows the tools' keys get ─────────────────────────────────────
// A listed tool with a bound arm key gets one DESCRIPTIVE row in the hotkey
// registry (`tool.<type>`, run null: listed for the legend and keyFor, never
// looked up — the tools' 'tool' target kind runs the key), labelled with its
// manifest's arm label, where the chrome's own "Pin comment" row stood. It is
// re-registered whenever the bound chords change.
const legendRows = new Map();   // type → {sig, off}
let syncing = false;
function syncLegend() {
  if (syncing) return;
  syncing = true;
  try {
    const want = new Map();
    listedTools().forEach((t, i) => {
      const id = `tool.${t.type}`;
      if (!ACTION_ID.test(id)) return;
      const chords = chordsOfTool(t.type).map((b) => b.chord);
      if (!chords.length) return;
      const arm = (Array.isArray(t.hotkeys) ? t.hotkeys : []).find((h) => isObject(h) && h.action === 'arm' && str(h.label));
      const label = arm ? arm.label : labelOf(t);
      const order = LEGEND_ORDER + (i + 1) / 1000;
      want.set(t.type, { id, label, chords, order, sig: JSON.stringify([label, chords, order]) });
    });
    for (const [type, row] of [...legendRows]) {
      const w = want.get(type);
      if (w && w.sig === row.sig) continue;
      row.off();
      legendRows.delete(type);
    }
    for (const [type, w] of want) {
      if (legendRows.has(type)) continue;
      try {
        const off = registerAction({ id: w.id, label: w.label, defaultChord: w.chords, context: 'page', run: null,
          legend: { section: LEGEND_SECTION, order: w.order } });
        legendRows.set(type, { sig: w.sig, off });
      } catch (e) { console.error('[web-chat] toolbar: a legend row could not be registered', e); }
    }
  } finally {
    syncing = false;
  }
}

// ── the DOM ─────────────────────────────────────────────────────────────────

let dom = null;
let trayAnchor = null;
let settingsFor = null;      // the type whose settings frame this module opened
let noticeTimer = null;
const FOCUS = 'data-tb-focus';

function button(cls, text, { id, label, title } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (id) b.id = id;
  if (text) b.textContent = text;
  if (label) b.setAttribute('aria-label', label);
  if (title) b.title = title;
  return b;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// A tool's icon: its <img>, or the generic glyph for a type without icons.
function iconOf(t) {
  if (t && t.icons) {
    const img = document.createElement('img');
    img.className = 'tb-icon';
    img.alt = '';
    img.draggable = false;
    img.src = iconSrc(t.type);
    return img;
  }
  const g = el('span', 'tb-glyph', (labelOf(t).trim()[0] || '◆').toUpperCase());
  g.setAttribute('aria-hidden', 'true');
  return g;
}
function syncIcon(b, t) {
  const cur = b.firstElementChild;
  if (t && t.icons && cur && cur.tagName === 'IMG') {
    const src = iconSrc(t.type);
    if (cur.getAttribute('src') !== src) cur.src = src;
    return;
  }
  b.replaceChildren(iconOf(t));
}

function buildDom() {
  const bar = document.getElementById('toolbar');
  const bb = document.getElementById('bb-tools');
  const d = { bar, bb };
  if (bar) {
    d.pointer = button('dock-btn tb-pointer', '↖', { id: 'tb-pointer', label: 'Pointer', title: 'Pointer' });
    d.pointer.addEventListener('click', () => { closeToolSettings(); disarm(); });
    d.slots = el('div', 'tb-slots');
    d.slots.id = 'tb-slots';
    d.reveal = button('dock-btn tb-reveal', '▾', { id: 'tb-reveal', label: 'All tools', title: 'All tools' });
    bar.replaceChildren(d.pointer, d.slots, d.reveal);
  }
  if (bb) {
    d.armedBtn = button('tb-slot bb-armed', '');
    d.armedBtn.addEventListener('click', () => { if (armed()) { closeToolSettings(); disarm(); } });
    d.phoneSlots = el('div', 'bb-slots');
    d.phoneReveal = button('bb-tools-reveal', '▾', { id: 'bb-tools-reveal', label: 'All tools', title: 'All tools' });
    bb.replaceChildren(d.armedBtn, d.phoneSlots, d.phoneReveal);
  }
  for (const r of [d.reveal, d.phoneReveal]) {
    if (!r) continue;
    r.setAttribute('aria-controls', 'tb-tray');
    r.setAttribute('aria-haspopup', 'dialog');
    r.setAttribute('aria-expanded', 'false');
    r.addEventListener('click', () => toggleTray(r));
  }

  const tray = el('div', 'popover tb-tray hidden');
  tray.id = 'tb-tray';
  tray.setAttribute('role', 'dialog');
  tray.setAttribute('aria-label', 'Tools');
  d.head = el('div', 'tb-tray-head');
  d.filter = document.createElement('input');
  d.filter.id = 'tb-filter';
  d.filter.className = 'tb-filter';
  d.filter.type = 'search';
  d.filter.placeholder = STRINGS.filter;
  d.filter.setAttribute('aria-label', STRINGS.filter);
  d.filter.autocomplete = 'off';
  d.filter.addEventListener('input', () => renderTray());
  d.list = el('div', 'tb-tray-list');
  d.fd = el('div', 'tb-fd');
  d.keys = el('p', 'tb-tray-note', STRINGS.slotKeys);
  d.viewOnly = el('p', 'tb-view-only', STRINGS.viewOnly);
  tray.append(d.head, d.filter, d.list, d.fd, d.keys, d.viewOnly);
  // Escape from the filter (a field): the shell's keyboard layer leaves a
  // field's keys to it, so that one press is forwarded to the one Escape owner.
  tray.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.metaKey || e.ctrlKey) return;
    const src = (e.composedPath && e.composedPath()[0]) || e.target;
    if (src && (src.tagName === 'INPUT' || src.tagName === 'TEXTAREA' || src.tagName === 'SELECT')) handleEscape();
  });
  document.body.appendChild(tray);
  d.tray = tray;

  d.notice = el('div', 'tb-notice');
  d.notice.setAttribute('role', 'status');
  d.notice.setAttribute('aria-live', 'polite');
  document.body.appendChild(d.notice);
  return d;
}

// ── the bar ─────────────────────────────────────────────────────────────────

function slotButton(type) {
  const b = button('dock-btn tb-slot', '');
  b.dataset.type = type;
  // The small settings frame is this trigger's panel: the dismiss layer leaves
  // it to the slot's own click (U336's hand-off).
  b.setAttribute('aria-controls', 'tool-settings-small');
  b.addEventListener('click', () => onSlot(b));
  return b;
}

function updateSlot(b, t, { visit = false } = {}) {
  const a = armed();
  const on = !!(a && a.type === t.type);
  const label = labelOf(t);
  const key = toolKey(t.type);
  b.classList.toggle('armed', on);
  b.classList.toggle('active', on);
  b.classList.toggle('visiting', visit);
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', visit ? `${label}, hidden tool, armed` : (key ? `${label} (${key})` : label));
  b.title = visit ? `${label} · hidden tool, armed · click to put down` : (key ? `${label} · ${key}` : label);
  syncIcon(b, t);
}

function reconcile(container, tools, visit) {
  const have = new Map([...container.children].map((c) => [c.dataset.type, c]));
  const out = tools.map((t) => {
    const b = have.get(t.type) || slotButton(t.type);
    updateSlot(b, t, { visit: t.type === visit });
    return b;
  });
  const now = [...container.children];
  if (now.length !== out.length || now.some((c, i) => c !== out[i])) container.replaceChildren(...out);
}

function phoneFit() {
  const w = Number(window.innerWidth) || 0;
  return Math.max(1, Math.floor((w - PHONE_BAR_FIXED) / PHONE_SLOT_PX));
}

// THE bar's render: both halves, from the records and the one armed state.
function renderBar() {
  if (!dom) return;
  const { pinned } = lists();
  const bar = pinned.map(toolOf).filter(Boolean);
  const visit = visiting();
  const visitTool = visit ? toolOf(visit) : null;
  const withVisit = visitTool ? [...bar, visitTool] : bar;
  const a = armed();
  if (dom.bar) {
    reconcile(dom.slots, withVisit, visitTool ? visit : null);
    dom.pointer.classList.toggle('armed', !a);
    dom.pointer.classList.toggle('active', !a);
    dom.pointer.setAttribute('aria-pressed', String(!a));
  }
  if (dom.bb) {
    const fit = bar.slice(0, phoneFit());
    reconcile(dom.phoneSlots, fit, null);
    const t = a ? toolOf(a.type) : null;
    const b = dom.armedBtn;
    b.classList.toggle('armed', !!a);
    if (a) {
      const label = labelOf(t) || a.type;
      syncIcon(b, t || { type: a.type, label });
      b.setAttribute('aria-label', `Put down ${label}`);
      b.title = `${label} · tap to put down`;
    } else {
      b.replaceChildren(el('span', 'tb-glyph', '↖'));
      b.setAttribute('aria-label', 'Pointer');
      b.title = 'Pointer';
    }
  }
}

// A slot pressed: an unarmed type is armed (tools.toggle); the ARMED slot
// pressed again opens its small settings (or closes them), and a type that
// declares none is put down; a visiting slot is put down.
function onSlot(b) {
  const type = b.dataset.type;
  const a = armed();
  if (b.classList.contains('visiting')) { closeToolSettings(); disarm(); return; }
  if (!a || a.type !== type) {
    closeToolSettings();
    toggle({ kind: 'tool', type });
    return;
  }
  if (isToolSettingsOpen() && settingsFor === type) { closeToolSettings(); return; }
  const t = toolOf(type);
  const small = t && isObject(t.settings) && isObject(t.settings.small) ? t.settings.small : null;
  if (!small) { closeToolSettings(); disarm(); return; }
  openSettings(t, 'small', b);
}

function openSettings(t, level, anchor) {
  const a = armed();
  const profile = a && a.type === t.type && typeof a.profile === 'string' && a.profile ? a.profile : null;
  const r = openToolSettings({
    type: t.type, level, anchor: anchor || undefined, schema: t.settings[level],
    value: settingsOf(t.type, profile || undefined), profile, readOnly: !canWrite(), label: labelOf(t),
  });
  if (!r || !r.ok) {
    if (r && r.hint) showNotice(r.hint);
    return r;
  }
  settingsFor = t.type;
  const frame = document.getElementById(level === 'small' ? 'tool-settings-small' : 'tool-settings-large');
  if (frame) {
    for (const old of frame.querySelectorAll('.tb-more')) old.remove();
    if (level === 'small' && isObject(t.settings.large)) {
      const more = button('tb-more', STRINGS.more);
      more.addEventListener('click', () => openSettings(t, 'large', null));
      frame.appendChild(more);
    }
  }
  return r;
}

// ── the tray ────────────────────────────────────────────────────────────────

const trayOpen = () => !!(dom && !dom.tray.classList.contains('hidden'));

function setExpanded(on) {
  for (const r of [dom.reveal, dom.phoneReveal]) if (r) r.setAttribute('aria-expanded', String(on));
}

function rectOf(x) {
  const r = x && typeof x.getBoundingClientRect === 'function' ? x.getBoundingClientRect() : null;
  return r || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

// Below the reveal on a desktop (right-aligned to it); above the bottom bar on
// a narrow screen.
function placeTray() {
  if (!trayOpen()) return;
  const t = dom.tray;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const own = rectOf(t);
  const maxLeft = Math.max(GUTTER, vw - own.width - GUTTER);
  let left;
  let top;
  if (isNarrow()) {
    const bar = rectOf(document.getElementById('bottombar'));
    const barTop = bar.height > 0 ? bar.top : vh;
    left = GUTTER;
    top = Math.max(GUTTER, barTop - GAP - own.height);
  } else {
    const a = rectOf(trayAnchor && trayAnchor.isConnected ? trayAnchor : dom.reveal);
    left = clamp(a.right - own.width, GUTTER, maxLeft);
    top = clamp(a.bottom + GAP, GUTTER, Math.max(GUTTER, vh - own.height - GUTTER));
  }
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

function openTray(anchor) {
  closeToolSettings();
  // One panel at a time: the shell closes every other open panel.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: dom.tray } }));
  trayAnchor = anchor || null;
  dom.tray.classList.remove('hidden');
  setExpanded(true);
  renderTray();
  placeTray();
  if (!isNarrow() && !dom.filter.disabled) {
    try { dom.filter.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
}

export function closeTray() {
  if (!trayOpen()) return;
  const hadFocus = dom.tray.contains(document.activeElement);
  dom.tray.classList.add('hidden');
  dom.tray.style.left = '';
  dom.tray.style.top = '';
  setExpanded(false);
  const back = trayAnchor;
  trayAnchor = null;
  if (hadFocus && back && back.isConnected) {
    try { back.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
}

function toggleTray(anchor) {
  if (!dom) return;
  if (trayOpen()) closeTray(); else openTray(anchor);
}

async function write(patch) {
  const r = await patchToolbar(patch);
  if (!r || !r.ok) showNotice((r && r.hint) || 'The toolbar was not saved.');
  return r;
}
const without = (list, type) => list.filter((x) => x !== type);

function act(text, label, run, focusKey, { disabled = false } = {}) {
  const b = button('tb-act', text, { label, title: label });
  b.setAttribute(FOCUS, focusKey);
  b.disabled = disabled;
  b.addEventListener('click', run);
  return b;
}

// One tool's row: its arm button (icon and name: arming a hidden tool is a
// "visit", chrome state only), its pack, then its actions.
function row(type, actions, write_) {
  const t = toolOf(type);
  const r = el('div', 'tb-row');
  r.dataset.type = type;
  const label = t ? labelOf(t) : type;
  const arm = button('tb-row-arm', '', { label: `Arm ${label}`, title: `Arm ${label}` });
  arm.setAttribute(FOCUS, `arm:${type}`);
  arm.disabled = !write_ || !t;
  arm.append(iconOf(t || { type, label }), el('span', 'tb-row-name', label));
  arm.addEventListener('click', () => { closeTray(); toggle({ kind: 'tool', type }); });
  const pack = el('span', 'tb-row-pack', t ? packOf(t) : 'not installed');
  const acts = el('span', 'tb-row-acts');
  acts.append(...actions);
  r.append(arm, pack, acts);
  return r;
}

function fingerDrawsBlock() {
  const box = el('div', 'tb-fd-box');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', STRINGS.fingerDraws);
  const fd = fingerDrawsMode();
  const title = el('div', 'tb-fd-title', STRINGS.fingerDraws);
  const choices = el('div', 'tb-fd-choices');
  for (const m of FINGER_DRAWS_MODES) {
    const lab = el('label', 'tb-fd-choice');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'tb-finger-draws';
    input.value = m;
    input.checked = fd.mode === m;
    input.setAttribute(FOCUS, `fd:${m}`);
    input.addEventListener('change', () => { if (input.checked) setFingerDraws(m); });
    lab.append(input, document.createTextNode(` ${m}`));
    choices.appendChild(lab);
  }
  // While finger-draws is on, the note names the gesture that scrolls (K.4 I1 = b).
  const note = el('p', 'tb-fd-note', (fd.mode === 'auto'
    ? `${STRINGS.fingerAuto} · ${fd.penSeen ? STRINGS.penSeen : STRINGS.penNotSeen}`
    : `${fd.mode} on this device`) + (fingerDraws() ? ` · ${STRINGS.fingerPan}` : ''));
  box.append(title, choices, note);
  // On the host only (the user record is host-only, H-6): the device's choice
  // as the user record's default, for every device left on auto.
  if (toolbarState().canWriteUser !== false) {
    const mk = act(STRINGS.makeDefault, STRINGS.makeDefault, async () => {
      const r = await patchUserToolbar({ fingerDraws: fingerDrawsMode().mode === 'on' });
      if (!r || !r.ok) showNotice((r && r.hint) || 'Your default was not saved.');
    }, 'fd:default', { disabled: fd.mode === 'auto' });
    mk.classList.add('tb-fd-default');
    box.appendChild(mk);
  }
  return box;
}

// THE tray's render, from the records: the head, the three lists, the
// finger-draws switch and the view-only line.
function renderTray() {
  if (!dom || !trayOpen()) return;
  const focused = document.activeElement && dom.tray.contains(document.activeElement)
    ? document.activeElement.getAttribute(FOCUS) : null;
  const tools = listedTools();
  const { pinned, hidden } = lists();
  const w = canWrite();
  const packs = new Set(tools.map(packOf));
  dom.head.textContent = `Tools · ${tools.length} from ${packs.size} pack${packs.size === 1 ? '' : 's'}`;
  dom.filter.disabled = !w;
  const q = dom.filter.value.trim().toLowerCase();
  const matches = (type) => {
    if (!q) return true;
    const t = toolOf(type);
    return [type, labelOf(t), packOf(t)].some((s) => s.toLowerCase().includes(q));
  };

  const out = [];
  // Pinned · slot order: move up / move down / unpin.
  out.push(el('h4', 'tb-sec', STRINGS.pinned));
  const pinRows = pinned.filter(matches).map((type) => {
    const i = pinned.indexOf(type);
    const label = labelOf(toolOf(type)) || type;
    const swap = (j) => () => { const next = pinned.slice(); [next[i], next[j]] = [next[j], next[i]]; write({ pinned: next }); };
    return row(type, [
      act('↑', `Move ${label} up`, swap(i - 1), `up:${type}`, { disabled: !w || i === 0 }),
      act('↓', `Move ${label} down`, swap(i + 1), `down:${type}`, { disabled: !w || i === pinned.length - 1 }),
      act('Unpin', `Unpin ${label}`, () => write({ pinned: without(pinned, type) }), `unpin:${type}`, { disabled: !w }),
    ], w);
  });
  out.push(...(pinRows.length ? pinRows : [el('p', 'tb-empty', STRINGS.noPinned)]));

  // Hidden · by pack: unhide, pin; "Pin all" per pack.
  const hid = hidden.filter((type) => toolOf(type) && matches(type));
  if (hid.length) {
    out.push(el('h4', 'tb-sec', STRINGS.hidden));
    const byPack = new Map();
    for (const type of hid) {
      const p = packOf(toolOf(type));
      if (!byPack.has(p)) byPack.set(p, []);
      byPack.get(p).push(type);
    }
    for (const [p, types] of byPack) {
      const head = el('div', 'tb-pack-head');
      const all = hidden.filter((type) => toolOf(type) && packOf(toolOf(type)) === p);
      head.append(el('span', 'tb-pack-name', p),
        act('Pin all', `Pin all of ${p}`, () => write({ pinned: [...pinned, ...all.filter((x) => !pinned.includes(x))],
          hidden: hidden.filter((x) => !all.includes(x)) }), `pinall:${p}`, { disabled: !w }));
      out.push(head);
      for (const type of types) {
        const label = labelOf(toolOf(type));
        out.push(row(type, [
          act('Unhide', `Unhide ${label}`, () => write({ hidden: without(hidden, type) }), `unhide:${type}`, { disabled: !w }),
          act('Pin', `Pin ${label}`, () => write({ pinned: [...pinned, type], hidden: without(hidden, type) }), `pinh:${type}`, { disabled: !w }),
        ], w));
      }
    }
  }

  // The listed tools that are neither (H-7): pin, hide.
  const rest = tools.map((t) => t.type).filter((type) => !pinned.includes(type) && !hidden.includes(type) && matches(type));
  if (rest.length) {
    out.push(el('h4', 'tb-sec', STRINGS.listed));
    for (const type of rest) {
      const label = labelOf(toolOf(type));
      out.push(row(type, [
        act('Pin', `Pin ${label}`, () => write({ pinned: [...pinned, type] }), `pin:${type}`, { disabled: !w }),
        act('Hide', `Hide ${label}`, () => write({ hidden: [...hidden, type] }), `hide:${type}`, { disabled: !w }),
      ], w));
    }
  }
  dom.list.replaceChildren(...out);
  dom.fd.replaceChildren(fingerDrawsBlock());
  dom.viewOnly.hidden = w;
  if (focused) {
    const again = [...dom.tray.querySelectorAll(`[${FOCUS}]`)].find((x) => x.getAttribute(FOCUS) === focused);
    if (again && !again.disabled) { try { again.focus({ preventScroll: true }); } catch { /* not focusable */ } }
  }
}

// ── notices ─────────────────────────────────────────────────────────────────

// One transient line of text under the bar (above the bottom bar when narrow).
export function showNotice(text) {
  if (!dom) return;
  dom.notice.textContent = typeof text === 'string' ? text : '';
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeTimer = null; if (dom) dom.notice.textContent = ''; }, NOTICE_MS);
}

// ── init ────────────────────────────────────────────────────────────────────

function redraw() {
  renderBar();
  renderTray();
}

let inited = false;
export function initToolbar() {
  if (inited) return;
  inited = true;
  dom = buildDom();
  registerPopover({ el: dom.tray, close: () => closeTray() });
  onToolbarChange(() => { syncLegend(); redraw(); });
  onHotkeysChange(() => { syncLegend(); if (!syncing) renderBar(); });
  onArmedChange((a) => {
    // The settings frame belongs to the armed tool: another tool armed, or
    // none, closes it.
    if (settingsFor && isToolSettingsOpen() && (!a || a.type !== settingsFor)) closeToolSettings();
    renderBar();
  });
  onFingerDrawsChange(() => renderTray());
  bus.on(NOTICE, (d) => showNotice(isObject(d) ? str(d.text) : ''));
  window.addEventListener('resize', () => { renderBar(); placeTray(); });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => redraw())
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  syncLegend();
  renderBar();
}
