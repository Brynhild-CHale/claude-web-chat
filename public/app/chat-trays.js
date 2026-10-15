// The status bar's chips and their tray (design spec §7.6): one chip per
// category of background work — shells, agents, workflows and monitors — and
// one tray, a .popover over the bar, listing a category's rows. The queue has no
// chip: it has its own rail (the maintainer's ruling of 2026-10-15).
//
//   initChatTrays()  takes #cs-chips over from the bar (chat-bar.js
//                    claimChips), builds #cs-tray, renders now and on every
//                    `mirror` bus event (one animation frame), and
//                    answers `chat:tasks`; idempotent. → the tray element, or
//                    null on a page with no #cs-chips
//   stopTrays()      undoes all of it: the chips and the tray go, the bar gets
//                    #cs-chips back (release), no timer is left
//   openTray(cat)    opens the tray on a category → whether it opened
//   closeTray()
//
// WHAT IT SHOWS is chat-present.js's categories(mirror, null, {now}) — the
// task categories, no queue — and nothing else: each entry's label, title, sub,
// tone, pulse, hidden and RowModel rows. This module keeps no copy of the
// mirror; each render asks again.
//
// THE CHIPS. A chip is button.cs-chip, data-cs-cat (U17's --cs-cat ink),
// aria-controls="cs-tray" — so the shell's dismiss layer treats it as the tray's
// toggle — with a dot (data-cs-tone, data-pulse while Claude works on something
// that runs in it) and its label; at ≤ 1000 px app.css shows the dot and the
// count, the label staying in the title. Below `read` an entry is counts only:
// the chip is aria-disabled and opens nothing. A click toggles the tray on its
// category; another chip swaps the content. Opening closes the graph overlay
// first (the tray would sit under it) and dispatches wc:close-popovers keeping
// the tray. Only the open category's chip has aria-expanded true.
//
// THE TRAY is a .popover, so public/app/shell.js owns its dismissal (Escape, an
// outside pointerdown, focus leaving, the window blurring); none of them closes
// the chat dock. This module watches the tray's class to hear it close, and then
// stops its ticker and the rows' followers. Rows are keyed by id, so a redraw
// keeps an expanded Output and its tail. While the tray is open ONE
// setInterval(…, 1000) redraws the metas (their clocks and ages); it is cleared
// on close. A perpetual chrome timer is never a setTimeout chain (§10.1).
//
// `chat:tasks` {category?} opens that category's tray, else the first one with
// a tray, at desktop width; below 760 px the phone's sheet answers it (tranche 5),
// and a flip below 760 px closes an open tray.
import { bus } from './bus.js';
import { mirror, serverNow } from './chat-state.js';
import { categories } from './chat-present.js';
import { claimChips } from './chat-bar.js';
import { isOverlayOpen, closeOverlay } from './graph-view.js';
import { isNarrow } from './viewport.js';
import { rowEl, updateRow } from './chat-rows.js';
import { runAction, stopFollowers } from './chat-actions.js';

export const TICK_MS = 1000;
const HOST_END = '/chat-host:tray';
const SHOW_COMMENT = 0x80;   // NodeFilter.SHOW_COMMENT, spelled out: the constant is not global everywhere

let els = null;          // { chips, tray, title, sub, close, rows }
let release = null;      // claimChips()'s
let offs = [];
let observer = null;
let frame = null;
let ticker = null;
let openCat = null;      // the category the tray shows, while it is open
let shown = [];          // the last render's categories (what a click acts on)
const rowEls = new Map();   // row id → element, for the open category

const trayOpen = () => !!els && !els.tray.classList.contains('hidden');

function setAttr(el, name, value) {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
function refocus(el) {
  try { el.focus({ preventScroll: true }); } catch { /* detached, or nothing focusable here */ }
}

// ── the tray's markup ────────────────────────────────────────────────────────

function hostEnd() {
  const walker = document.createTreeWalker(document.body, SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() === HOST_END) return n;
  return null;
}

function buildTray(bar) {
  const tray = document.createElement('div');
  tray.id = 'cs-tray';
  tray.className = 'popover cs-tray hidden';
  tray.setAttribute('role', 'dialog');
  tray.setAttribute('aria-labelledby', 'cs-tray-title');
  const head = document.createElement('div');
  head.className = 'cs-tray-head';
  const title = document.createElement('span');
  title.id = 'cs-tray-title';
  title.className = 'cs-tray-title';
  const sub = document.createElement('span');
  sub.id = 'cs-tray-sub';
  sub.className = 'cs-tray-sub';
  const close = document.createElement('button');
  close.id = 'cs-tray-close';
  close.className = 'pane-btn';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  head.append(title, sub, close);
  const rows = document.createElement('div');
  rows.id = 'cs-tray-rows';
  rows.className = 'cs-tray-rows';
  rows.setAttribute('role', 'list');
  tray.append(head, rows);
  // In index.html's tray host, just before its closing marker; with no host
  // (an older page), beside the bar among the panels.
  const end = hostEnd();
  if (end) end.parentNode.insertBefore(tray, end);
  else if (bar) bar.after(tray);
  else document.body.append(tray);
  return { tray, title, sub, close, rows };
}

// ── rendering ────────────────────────────────────────────────────────────────

// "2 shells running — show": the chip's label, said with what it means.
function chipLabel(entry) {
  const [head, ...rest] = String(entry.label || entry.cat).split(' · ');
  const said = (entry.running ? `${head} running` : head) + (rest.length ? `, ${rest.join(', ')}` : '');
  return entry.hidden ? said : `${said} — show`;
}

function paintChip(b, entry) {
  b.dataset.csCat = entry.cat;
  setAttr(b, 'aria-controls', 'cs-tray');
  setAttr(b, 'aria-expanded', String(trayOpen() && openCat === entry.cat));
  setAttr(b, 'aria-label', chipLabel(entry));
  setAttr(b, 'aria-disabled', entry.hidden ? 'true' : null);
  setAttr(b, 'title', entry.label);
  const dot = b.querySelector('.cs-chip-dot');
  dot.dataset.csTone = entry.tone || 'muted';
  if (entry.pulse) dot.dataset.pulse = 'true';
  else delete dot.dataset.pulse;
  setText(b.querySelector('.cs-chip-count'), String(entry.running || entry.count || 0));
  setText(b.querySelector('.cs-chip-label'), entry.label);
}

function newChip() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cs-chip';
  const dot = document.createElement('span');
  dot.className = 'cs-chip-dot';
  dot.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'cs-chip-count';
  count.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'cs-chip-label';
  b.append(dot, count, label);
  return b;
}

function paintChips() {
  const have = new Map([...els.chips.querySelectorAll('.cs-chip')].map((b) => [b.dataset.csCat, b]));
  shown.forEach((entry, i) => {
    let b = have.get(entry.cat);
    have.delete(entry.cat);
    if (!b) b = newChip();
    paintChip(b, entry);
    if (els.chips.children[i] !== b) els.chips.insertBefore(b, els.chips.children[i] || null);
  });
  for (const b of have.values()) b.remove();
}

function paintRows(entry) {
  const seen = new Set();
  entry.rows.forEach((model, i) => {
    seen.add(model.id);
    let el = rowEls.get(model.id);
    if (el) updateRow(el, model);
    else {
      el = rowEl(model, { density: 'compact' });
      rowEls.set(model.id, el);
    }
    if (els.rows.children[i] !== el) els.rows.insertBefore(el, els.rows.children[i] || null);
  });
  for (const [id, el] of [...rowEls]) {
    if (seen.has(id)) continue;
    rowEls.delete(id);
    stopFollowers(el);
    el.remove();
  }
}

function paintTray() {
  if (!trayOpen() || !openCat) return;
  const entry = shown.find((e) => e.cat === openCat);
  if (!entry || entry.hidden) {   // the category emptied, or its content is no longer readable here
    closeTray({ returnFocus: false });
    return;
  }
  els.tray.dataset.csCat = entry.cat;
  setText(els.title, entry.title);
  setText(els.sub, entry.sub || '');
  paintRows(entry);
}

// The bar's categories: Claude's background work. The queue's entry stays
// categories()'s, for the phone's Tasks and the rail's message rows.
const barCategories = () => categories(mirror, null, { now: serverNow() });

function render() {
  if (frame !== null) {
    cancelFrame(frame);
    frame = null;
  }
  if (!els) return;
  shown = barCategories();
  paintChips();
  paintTray();
}

function cancelFrame(h) {
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(h);
}

// Every event of one frame is one render.
function schedule() {
  if (!els || frame !== null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') {
    render();
    return;
  }
  frame = raf(() => {
    frame = null;
    render();
  });
}

// ── the ticker, while the tray is open ───────────────────────────────────────

function tick() {
  if (typeof document === 'undefined' || !els || !els.tray.isConnected) {
    stopTicker();
    return;
  }
  if (!trayOpen()) {
    stopTicker();
    return;
  }
  render();
}

function startTicker() {
  if (ticker !== null) return;
  ticker = setInterval(tick, TICK_MS);
  if (ticker && typeof ticker === 'object' && typeof ticker.unref === 'function') ticker.unref();
}

function stopTicker() {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

// ── opening and closing ──────────────────────────────────────────────────────

const chipFor = (cat) => (els ? [...els.chips.querySelectorAll('.cs-chip')].find((b) => b.dataset.csCat === cat) : null);

function markChips() {
  if (!els) return;
  for (const b of els.chips.querySelectorAll('.cs-chip')) {
    setAttr(b, 'aria-expanded', String(trayOpen() && openCat === b.dataset.csCat));
  }
}

function clearRows() {
  stopFollowers(els.rows);
  rowEls.clear();
  els.rows.replaceChildren();
}

// What follows the tray closing, however it closed: the shell's dismiss layer
// (it adds .hidden) or closeTray.
function closed() {
  if (!els) return;
  openCat = null;
  stopTicker();
  clearRows();
  delete els.tray.dataset.csCat;
  markChips();
}

export function openTray(cat) {
  if (!els) return false;
  shown = barCategories();
  const entry = shown.find((e) => e.cat === cat);
  if (!entry || entry.hidden) return false;
  const chip = chipFor(cat);
  if (isOverlayOpen()) {
    closeOverlay();   // the tray would open under the graph
    if (chip) refocus(chip);
  }
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: els.tray } }));
  if (openCat !== cat) clearRows();
  openCat = cat;
  els.tray.classList.remove('hidden');
  startTicker();
  paintChips();
  paintTray();
  markChips();
  return true;
}

export function closeTray({ returnFocus = true } = {}) {
  if (!els) return;
  const chip = openCat ? chipFor(openCat) : null;
  const had = trayOpen();
  els.tray.classList.add('hidden');
  closed();
  if (had && returnFocus && chip && els.tray.contains(document.activeElement)) refocus(chip);
}

// ── events ───────────────────────────────────────────────────────────────────

function onChipClick(e) {
  const t = e.target;
  const b = t && typeof t.closest === 'function' ? t.closest('.cs-chip') : null;
  if (!b || !els || !els.chips.contains(b)) return;
  if (b.getAttribute('aria-disabled') === 'true') return;
  const cat = b.dataset.csCat;
  if (trayOpen() && openCat === cat && !isOverlayOpen()) closeTray();
  else openTray(cat);
}

function onRowClick(e) {
  const t = e.target;
  const btn = t && typeof t.closest === 'function' ? t.closest('button[data-action]') : null;
  if (!btn || btn.disabled || !els || !els.rows.contains(btn)) return;
  const el = btn.closest('.cs-row');
  const entry = shown.find((x) => x.cat === openCat);
  const model = el && entry ? entry.rows.find((r) => r.id === el.dataset.rowId) : null;
  if (!model) return;
  runAction(model, btn.dataset.action, { rowEl: el, density: 'compact', button: btn });
}

function onClose() { closeTray(); }

function onTasks(detail) {
  if (!els || isNarrow()) return;
  shown = barCategories();
  const want = detail && typeof detail.category === 'string' ? detail.category : null;
  const pick = shown.find((e) => e.cat === want && !e.hidden) || shown.find((e) => !e.hidden && e.rows.length);
  if (pick) openTray(pick.cat);
}

// Below 760px the bar and its tray are not drawn (app.css): an open tray closes,
// so no ticker runs for a tray nobody can see.
function onNarrow(detail) {
  if (detail && detail.narrow && trayOpen()) closeTray({ returnFocus: false });
}

function onTrayClass() {
  if (els && openCat && !trayOpen()) closed();
}

// ── the module's surface ─────────────────────────────────────────────────────

export function initChatTrays() {
  if (els) return els.tray;
  if (typeof document === 'undefined') return null;
  const chips = document.getElementById('cs-chips');
  if (!chips) return null;
  release = claimChips();
  const stale = document.getElementById('cs-tray');
  if (stale) stale.remove();
  els = { chips, ...buildTray(document.getElementById('chat-statusbar')) };
  chips.addEventListener('click', onChipClick);
  els.rows.addEventListener('click', onRowClick);
  els.close.addEventListener('click', onClose);
  const MO = window.MutationObserver;
  if (typeof MO === 'function') {
    observer = new MO(onTrayClass);
    observer.observe(els.tray, { attributes: true, attributeFilter: ['class'] });
  }
  offs = [bus.on('mirror', schedule), bus.on('chat:tasks', onTasks),
    bus.on('viewport:narrow', onNarrow)];
  render();
  return els.tray;
}

export function stopTrays() {
  stopTicker();
  if (frame !== null) {
    cancelFrame(frame);
    frame = null;
  }
  for (const off of offs.splice(0)) off();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (els) {
    stopFollowers(els.rows);
    els.chips.removeEventListener('click', onChipClick);
    els.rows.removeEventListener('click', onRowClick);
    els.close.removeEventListener('click', onClose);
    for (const b of els.chips.querySelectorAll('.cs-chip')) b.remove();   // #cs-chips goes back empty
    els.tray.remove();
  }
  els = null;
  openCat = null;
  shown = [];
  rowEls.clear();
  const r = release;
  release = null;
  if (r) r();
}
