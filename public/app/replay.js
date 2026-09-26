// The replay player overlay.
//
// A replay plays one lineage of the graph forward, node by node. Everything
// that draws it lives in ONE document the daemon serves — /replay
// (lib/server/replay/document.js: stage, caption bar, scrubber, controller) —
// and this module only frames it: an iframe of that document plus the choices
// around it (from / to, speed, transition, captions), "Open this node", and a
// download of the same document as replay.html.
//
// It never touches the live surface. The frames are the node preview document
// running inside the replay's own iframe, under PREVIEW_CSP, so nothing here
// mounts a pane, applies a snapshot or enters preview — which is why this
// module must not import mounts.js (test/replay-chrome.test.js holds it to
// that, transitively). Opening a node on the surface is the one hand-off, and
// it goes through a hook shell.js injects, as does the Escape forwarder the
// graph viewer already has for its preview frames.
//
// The panel is a `.popover`: the shell's dismiss layer and its one Escape owner
// close it like every other chrome panel (shell.js closePanel → closeReplay).
import { view, $ } from './state.js';
import { nodeById, labelFor } from './labels.js';
import { getLocalJson, setLocalJson } from './storage.js';

const PREFS_KEY = 'wc:replay-prefs';
const SPEEDS = ['0.5', '1', '1.5', '2', '4'];
const DEFAULT_PREFS = { speed: '1', transition: 'cut', captions: 'prompt' };

let hooks = { openNode: null, forwardEscapeFrom: null };
// The replay being shown: its endpoints and the lineage the pickers offer.
let cur = { to: null, from: null, lineage: [] };

const pop = () => $('replay-pop');
const frame = () => $('rpo-frame');
export function isReplayOpen() { const p = pop(); return !!p && !p.classList.contains('hidden'); }

function prefs() {
  const p = { ...DEFAULT_PREFS, ...getLocalJson(PREFS_KEY, {}) };
  if (!SPEEDS.includes(String(p.speed))) p.speed = DEFAULT_PREFS.speed;
  if (!['cut', 'fade'].includes(p.transition)) p.transition = DEFAULT_PREFS.transition;
  if (!['prompt', 'summary', 'none'].includes(p.captions)) p.captions = DEFAULT_PREFS.captions;
  return p;
}
function savePrefs(patch) { setLocalJson(PREFS_KEY, { ...prefs(), ...patch }); }

// The player inside the frame, once its document has booted.
function player() {
  try { return frame().contentWindow.__wcReplay || null; } catch { return null; }
}

function note(text) { const n = $('rpo-note'); if (n) n.textContent = text || ''; }

// The query both the frame and the download are built from.
function query(extra = {}) {
  const p = prefs();
  const q = new URLSearchParams();
  if (cur.from) q.set('from', cur.from);
  if (cur.to) q.set('to', cur.to);
  q.set('transition', p.transition);
  q.set('captions', p.captions);
  for (const [k, v] of Object.entries(extra)) if (v != null) q.set(k, String(v));
  return q.toString();
}

// (Re)load the player. `at` keeps the step on screen across a reload (a
// transition or caption change rebuilds the document).
function load({ at = null } = {}) {
  const fr = frame();
  if (!fr) return;
  fr.src = '/replay?' + query({ chrome: 1, autoplay: at == null ? 1 : 0, speed: prefs().speed, at });
  if (hooks.forwardEscapeFrom) hooks.forwardEscapeFrom(fr);
  const dl = $('rpo-download');
  if (dl) dl.href = '/api/replay/html?' + query({ chrome: 1 });
}

// The root of `id`'s tree, by the raw parent chain of the last graph payload.
function rootOf(id) {
  let n = nodeById(id);
  const seen = new Set();
  while (n && n.parent_id && !seen.has(n.id)) {
    seen.add(n.id);
    const p = nodeById(n.parent_id);
    if (!p) break;
    n = p;
  }
  return n ? n.id : id;
}

async function getPath(params) {
  const q = new URLSearchParams(params);
  try {
    const r = await fetch('/api/replay/path?' + q.toString());
    const body = await r.json().catch(() => ({}));
    return r.ok ? body : { error: body.error || r.statusText };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

function fillSelect(sel, rows, selectedId) {
  if (!sel) return;
  sel.textContent = '';
  for (const r of rows) {
    const o = document.createElement('option');
    o.value = r.id;
    // textContent: a node's name is user/API-supplied text (see shell.js palette)
    const n = nodeById(r.id);
    o.textContent = r.label + (n && n.name ? ' · ' + n.name : '');
    if (r.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

// The pickers: `from` offers the lineage above `to`, `to` the lineage below
// `from` — a replay is one lineage played downward, so any pair they allow is
// a pair the server accepts.
function renderPickers() {
  const L = cur.lineage;
  const fi = Math.max(0, L.findIndex((r) => r.id === cur.from));
  const ti = L.findIndex((r) => r.id === cur.to);
  fillSelect($('rpo-from'), L.slice(0, ti + 1), cur.from);
  fillSelect($('rpo-to'), L.slice(fi), cur.to);
}

// Open the player. `to` defaults to the node being viewed (else active);
// `from` to the nearest bookmark at or above it (else its tree's root) — the
// server's default, so the first replay needs no choices at all.
export async function openReplay({ to = null, from = null } = {}) {
  const p = pop();
  if (!p) return;
  const target = to || view.viewedId || view.activeId;
  if (!target) return;
  // one panel at a time, like every other chrome panel
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: p } }));
  p.classList.remove('hidden');
  note('');

  const def = await getPath(from ? { to: target, from } : { to: target });
  if (def.error) {
    note(def.error);
    cur = { to: target, from: null, lineage: [] };
    renderPickers();
    return;
  }
  // The whole drawn lineage (root → to) for the pickers; the default path's
  // own steps if the root cannot be named.
  const all = nodeById(def.to.id) ? await getPath({ to: def.to.id, from: rootOf(def.to.id) }) : def;
  const lineage = (all.error ? def.steps : all.steps).map((s) => ({ id: s.id, label: s.label }));
  cur = { to: def.to.id, from: def.from.id, lineage };
  renderPickers();
  if (def.truncated) note(`showing the last ${def.steps.length} of ${def.total_steps} steps`);
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  const pr = prefs();
  set('rpo-speed', pr.speed); set('rpo-transition', pr.transition); set('rpo-captions', pr.captions);
  load();
  const fr = frame();
  if (fr) setTimeout(() => { if (isReplayOpen()) fr.focus(); }, 0);
}

export function closeReplay() {
  const p = pop();
  if (!p || p.classList.contains('hidden')) return;
  p.classList.add('hidden');
  // Unload the document: a paused replay still holds up to three live frames.
  const fr = frame();
  if (fr) fr.src = 'about:blank';
}

// "Open this node": the step on screen, on the surface (a preview, like
// clicking it in the graph), and the replay closes.
function openCurrent() {
  const api = player();
  const st = api && api.state();
  const step = st && api.steps[st.index];
  if (!step) return;
  closeReplay();
  if (hooks.openNode) hooks.openNode(step.id);
}

function stepIndex() {
  const api = player();
  const st = api && api.state();
  return st ? st.index : null;
}

// Keys while the player is open. Capture phase on window, so the shell's and
// the graph viewer's single-key shortcuts never see a keystroke meant for the
// player; Escape is left alone for the shell's one owner, and a focused select
// keeps its native keys (stopping propagation does not cancel them).
function onKey(e) {
  if (!isReplayOpen() || e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    e.stopPropagation();
    return;
  }
  const api = player();
  if (e.key === ' ') { e.preventDefault(); if (api) api.toggle(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); if (api) { api.pause(); api.stepBy(-1); } }
  else if (e.key === 'ArrowRight') { e.preventDefault(); if (api) { api.pause(); api.stepBy(1); } }
  e.stopPropagation();
}

export function initReplay(h = {}) {
  hooks = { ...hooks, ...h };
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('rpo-close', 'click', closeReplay);
  on('rpo-open', 'click', openCurrent);
  on('rpo-speed', 'change', (e) => {
    savePrefs({ speed: e.target.value });
    const api = player();
    if (api) api.setSpeed(Number(e.target.value));   // live — no reload
  });
  on('rpo-transition', 'change', (e) => { savePrefs({ transition: e.target.value }); load({ at: stepIndex() }); });
  on('rpo-captions', 'change', (e) => { savePrefs({ captions: e.target.value }); load({ at: stepIndex() }); });
  on('rpo-from', 'change', (e) => { cur.from = e.target.value; renderPickers(); load(); });
  on('rpo-to', 'change', (e) => { cur.to = e.target.value; renderPickers(); load(); });
  window.addEventListener('keydown', onKey, true);
}

// The ⌘K row and the ⋯ item name where the replay will arrive.
export function replayTargetLabel() {
  const id = view.viewedId || view.activeId;
  return id ? labelFor(id) : null;
}
