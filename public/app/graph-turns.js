// --- A node's chat turns in the graph inspector, and the rewind marks ---
// (design spec §2.8 "What the chrome shows", §15.4; ruled Q1, attach.)
//
// Each closed chat turn attaches to the next committed node, as `commit` (the
// turn whose Stop committed it) or `folded` (a no-change turn that rode along).
// This module draws them, through graph-view.js's seams and nothing else:
//
//   * onInspectorRender — under the inspector's GRAPH/WHEN/CHANGED block, a
//     <section id="gi-turns"> listing the selected node's turns from
//     GET /api/mirror/node/:ref: role, prompt preview, time, duration, tools,
//     files ±, an interrupted/stopped tag, and superseded turns dimmed as
//     "rewound". The rows are not buttons: the inspector → chat link is
//     deferred (§2.8, §13).
//     Its "↶ N of M turns rewound" line reads the marks below: it waits for
//     a refresh of them in flight, and a refresh that changes them draws the
//     open node's section again.
//   * setNodeMarker — a ↶ to the left of each node whose turns a rewind in the
//     terminal superseded, from GET /api/mirror/nodes (§15.4). Canvas and
//     inspector only: the phone's graph log draws none in 0.8.5 (notes-B Q18,
//     ruling U80@marks-scope).
//
//   * the 'turns' overlay host (3C.1, L2: the third chat-pin host) — each
//     turn row is stamped data-turn-id and ends in one empty slot
//     (span.gi-turn-pins, a class); overlay.js registerHost('turns') places
//     every chat-comment pin on a turn (on the turn itself or on any of its
//     items, passages or diff lines) at its turn row's slot, so the overlay
//     draws ONE marker per row with the count. The draw is chat-comment's own
//     (chat-pins.js, at this host's glyph size): the glyph, the count and, on
//     hover, the pins' explain lines. A tap (chat-pins.js onMarkerTap) closes
//     the graph and opens the chat at the turn (bus chat:open {view: 'turn'}),
//     or — when every pin of the row is unavailable (L5 d: no turn to open) —
//     the pin list, each pin with its own quote and explain line. The host's
//     root is the static #gv-inspector, its well #gi-turns (rebuilt per
//     paint); the never-draw census keeps a badge off the inspector's preview
//     iframe and the glance. No canvas marker: the ↶ marks are the canvas's
//     only producer here (HOSTS@L2). The pins' states are the daemon's,
//     relayed by chat-pins.js; this host requests nothing (O2: the inspector's
//     own node read is its view of the conversations its turns name).
//
// Below the `read` mirror level nothing is drawn and nothing is requested, so
// the inspector is 0.8.0's for a basic viewer (notes-B Q19). Any answer that is
// not a turn list (403, 404, 503, a disabled body, the shell's {ok: true})
// draws nothing.
//
// Timers (§10.1): no poller. A bus 'mirror' change to the stream, while the
// graph is open, schedules ONE refresh of the marks 2 s later — a one-shot
// setTimeout, never a chain; stopGraphTurns() clears it.
import { onInspectorRender, setNodeMarker, isOverlayOpen, layoutAndRender, closeOverlay } from './graph-view.js';
import { mirror, atLeast, normalizeTurn } from './chat-state.js';
import { fmtShort } from './chat-present.js';
import { nodeTime } from './labels.js';
import { bus } from './bus.js';
import { $ } from './state.js';
import { registerHost } from './overlay.js';
import { KINDS as CHAT_KINDS, onMarkerTap, openPinList, chatPinOf } from './chat-pins.js';

// GET /api/mirror/nodes at most once per this long.
export const REFRESH_GAP_MS = 2000;
// How long after a stream change the marks are refreshed.
export const REFRESH_DELAY_MS = 2000;

// The turn list's overlay host (overlay.js HOST_NAMES; its layer
// #el-layer-turns at the ladder's --z-turns-pins) and its badge: 18 × 16 px,
// hung from the row slot's top-left corner (the slot is the same size).
export const TURNS_HOST = 'turns';
export const TURNS_GLYPH = Object.freeze({ dx: 0, dy: 0, w: 18, h: 16 });
const UNAVAILABLE = 'unavailable';

const ROLE_MARK = Object.freeze({ commit: '●', folded: '◦' });
const ROLE_TITLE = Object.freeze({ commit: 'committed this node', folded: 'rode into this node (no surface change)' });
// What a turn with no prompt preview says instead, by its author (§2.4).
const AUTHOR_LINE = Object.freeze({
  system: 'system turn', 'task-notification': 'task notification', channel: 'channel wake', parked: 'parked delivery',
});

const readable = () => atLeast(mirror.access && mirror.access.level, 'read');
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const clock = (ts) => nodeTime({ created_at: ts });   // the chrome's one HH:MM

async function getJson(url) {
  try {
    const r = await fetch(url);
    if (!r || !r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* ── the marks ────────────────────────────────────────────────────────────── */

let summaries = new Map();   // node id → {turns, superseded, rewound_at?}
let lastFetch = -Infinity;
let inFlight = null;
let marksRev = 0;            // bumped whenever a refresh changes a mark

// "2 of 3 turns rewound in the terminal at 14:02"
function rewoundSentence(s) {
  const at = Number.isFinite(s.rewound_at) ? ` at ${clock(s.rewound_at)}` : '';
  return `${s.superseded} of ${s.turns} turn${s.turns === 1 ? '' : 's'} rewound in the terminal${at}`;
}

function summaryOf(id) {
  const s = summaries.get(id);
  return s && s.superseded > 0 ? s : null;
}

function readSummaries(body) {
  const out = new Map();
  if (!isPlain(body) || !isPlain(body.nodes)) return out;
  for (const [id, raw] of Object.entries(body.nodes)) {
    if (!id || id.length > 128 || !isPlain(raw)) continue;
    const s = { turns: count(raw.turns), superseded: count(raw.superseded) };
    if (Number.isFinite(raw.rewound_at)) s.rewound_at = raw.rewound_at;
    out.set(id, s);
  }
  return out;
}

const markKey = (s) => (s && s.superseded > 0 ? `${s.superseded}/${s.turns}@${s.rewound_at ?? ''}` : '');
function marksChanged(before, after) {
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (markKey(before.get(id)) !== markKey(after.get(id))) return true;
  }
  return false;
}

// The marker's refresh: true when any node's mark changed.
function refresh() {
  if (!readable()) {
    const had = [...summaries.values()].some((s) => s.superseded > 0);
    summaries = new Map();
    if (had) marksRev++;
    return Promise.resolve(had);
  }
  if (inFlight) return inFlight;
  if (Date.now() - lastFetch < REFRESH_GAP_MS) return Promise.resolve(false);
  lastFetch = Date.now();
  const p = (async () => {
    const body = await getJson('/api/mirror/nodes');
    const next = readable() ? readSummaries(body) : new Map();
    const changed = marksChanged(summaries, next);
    summaries = next;
    if (changed) marksRev++;
    return changed;
  })().finally(() => { if (inFlight === p) inFlight = null; });
  inFlight = p;
  // A change re-runs the open node's section, whichever caller asked (the
  // graph's own refresh, or the stream-change one-shot below).
  p.then((changed) => { if (changed) rerunOpen(); }, () => {});
  return p;
}

function mark(id) {
  if (!readable()) return null;
  const s = summaryOf(id);
  return s ? { text: '↶', title: rewoundSentence(s) } : null;
}

/* ── the stream-change refresh: one-shot ──────────────────────────────────── */

let timer = null;
function clearTimer() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
}
function schedule(ms) {
  if (timer !== null) return;
  timer = setTimeout(fire, Math.max(0, ms));
}
function fire() {
  timer = null;
  if (!isOverlayOpen() || !readable()) return;
  const wait = REFRESH_GAP_MS - (Date.now() - lastFetch);
  if (wait > 0 && !inFlight) { schedule(wait); return; }   // the gap still holds: once more, when it ends
  refresh().then((changed) => { if (changed && isOverlayOpen()) layoutAndRender(); });
}
function onMirror(detail) {
  const what = detail && Array.isArray(detail.what) ? detail.what : [];
  if (!what.includes('stream') && !what.includes('all')) return;
  if (!isOverlayOpen() || !readable()) return;
  schedule(REFRESH_DELAY_MS);
}

/* ── the inspector section ────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function turnsOf(body) {
  if (!isPlain(body) || body.ok === false || body.disabled || !Array.isArray(body.turns)) return null;
  const out = [];
  for (const raw of body.turns) {
    if (!isPlain(raw)) continue;
    const t = normalizeTurn(raw);
    if (!t) continue;
    out.push({ t, role: raw.role === 'commit' ? 'commit' : 'folded', unavailable: raw.unavailable === true });
  }
  const seq = (x) => (Number.isFinite(x.t.seq) ? x.t.seq : Infinity);
  return out.map((x, i) => [x, i]).sort((a, b) => (seq(a[0]) - seq(b[0])) || (a[1] - b[1])).map(([x]) => x);
}

function turnText(t) {
  const preview = t.prompt && typeof t.prompt.preview === 'string' ? t.prompt.preview.trim() : '';
  if (t.author === 'system') return preview ? `› ${preview}` : AUTHOR_LINE.system;
  return preview || AUTHOR_LINE[t.author] || '(no prompt)';
}

// The row's chat-pin slot: empty, the 'turns' host's anchor (a class only).
const pinSlot = () => el('span', 'gi-turn-pins');

function turnRow({ t, role, unavailable }) {
  const li = el('li', 'gi-turn');
  li.dataset.role = role;
  li.dataset.turnId = t.id;
  li.appendChild(el('span', 'gi-turn-role', ROLE_MARK[role])).title = ROLE_TITLE[role];
  if (unavailable) {
    li.classList.add('gi-turn-gone');
    li.appendChild(el('span', 'gi-turn-text', 'turn no longer in the chat history'));
    li.appendChild(pinSlot());
    return li;
  }
  li.appendChild(el('span', 'gi-turn-text', turnText(t)));
  const meta = [];
  const at = Number.isFinite(t.started_at) ? t.started_at : t.ended_at;
  if (Number.isFinite(at)) meta.push(clock(at));
  if (Number.isFinite(t.duration_ms)) meta.push(fmtShort(t.duration_ms));
  if (t.counts && Number.isFinite(t.counts.tools)) meta.push(`${t.counts.tools} tool${t.counts.tools === 1 ? '' : 's'}`);
  if (t.code && t.code.status === 'ready') meta.push(`files +${count(t.code.additions)} −${count(t.code.deletions)}`);
  const line = el('span', 'gi-turn-meta', meta.join(' · '));
  if (t.status === 'interrupted' || t.ended_by) {
    line.appendChild(el('span', 'gi-turn-tag', t.ended_by === 'web' || t.ended_by === 'hook' ? 'stopped from this page' : 'interrupted'));
  }
  if (t.superseded === true) {
    li.classList.add('gi-turn-rewound');
    line.appendChild(el('span', 'gi-turn-tag gi-turn-tag-rewound', 'rewound'));
  }
  li.appendChild(line);
  li.appendChild(pinSlot());
  return li;
}

function section(id, turns) {
  listed = new Map(turns.map(({ t }) => [t.id, t.conversation_id || null]));
  const sec = el('section', 'gi-turns');
  sec.id = 'gi-turns';
  sec.setAttribute('aria-label', 'Chat turns');
  sec.appendChild(el('div', 'gi-turns-head', `CHAT TURNS · ${turns.length}`));
  const s = summaryOf(id);
  if (s) sec.appendChild(el('div', 'gi-turns-sum', `↶ ${rewoundSentence(s)}`));
  if (!turns.length) {
    sec.appendChild(el('div', 'gi-turns-empty', 'No chat turns rode into this node.'));
    return sec;
  }
  const list = el('ol', 'gi-turns-list');
  for (const x of turns) list.appendChild(turnRow(x));
  sec.appendChild(list);
  return sec;
}

// The last inspector paint's hook context: what a change of the marks re-runs.
let open = null;

async function onInspector(ctx) {
  const { box, id, current } = ctx;
  if (!id || !box || !readable()) return;
  open = ctx;
  const body = await getJson('/api/mirror/node/' + encodeURIComponent(id));
  if (!current() || !readable()) return;
  // The summary line reads the marks: a refresh of them in flight is waited
  // for, so the line is not painted from the cache it is about to replace.
  if (inFlight) { try { await inFlight; } catch { /* the marks stay as they were */ } }
  if (!current() || !readable()) return;
  const turns = turnsOf(body);
  if (!turns) return;
  const meta = box.querySelector('.gv-meta');
  if (!meta) return;
  const old = document.getElementById('gi-turns');
  if (old) old.remove();
  const sec = section(id, turns);
  sec.dataset.marks = String(marksRev);
  meta.after(sec);
  markPins();
}

// The marks changed: the open node's section, painted from the older marks,
// is drawn again (its turns too: a rewind dims them). One painted after the
// change, or none at all, is left alone.
function rerunOpen() {
  const o = open;
  if (!o || !offs || !isOverlayOpen() || !o.current()) return;
  const sec = document.getElementById('gi-turns');
  if (!sec || sec.dataset.marks === String(marksRev)) return;
  onInspector(o).catch((e) => console.error('[web-chat] the chat turns section failed', e));
}

/* ── the 'turns' host: the chat pins on each turn row ──────────────────────── */

let listed = new Map();       // turn id → conversation id, of the painted section's rows
const placedAt = new Map();   // pin id → {turn_id, conversation_id}: the row place() put it on
let pinsDirty = null;         // the host's settle trigger, while it is registered

function markPins() { if (pinsDirty) pinsDirty(); }
const str = (v) => (typeof v === 'string' && v ? v : null);

// The row of a turn in the painted section, and its slot.
function slotOf(sec, tid) {
  for (const li of sec.querySelectorAll('li.gi-turn')) {
    if (li.dataset.turnId !== tid) continue;
    return li.querySelector(':scope > .gi-turn-pins');
  }
  return null;
}
// place(row): the slot of the turn row the pin's anchor names (its turn, or
// the turn its item, passage or diff line is in) — so a turn's pins group on
// its row — with the daemon's state; null (unplaced, not drawn) below `read`,
// with the graph closed, with no section painted, or when the node lists no
// such turn. DOM queries only.
function placePin(row) {
  const a = row && row.anchor;
  const ans = row && row.answer;
  if (!a || !ans || !str(ans.state) || !readable() || !isOverlayOpen()) { placedAt.delete(row && row.id); return null; }
  const sec = $('gi-turns');
  const tids = [str(a.turn_id), str(ans.turn_id_now)].filter(Boolean);
  for (const tid of sec ? tids : []) {
    const cid = listed.get(tid);
    if (cid && str(a.conversation_id) && cid !== a.conversation_id) continue;
    const slot = slotOf(sec, tid);
    if (!slot) continue;
    placedAt.set(row.id, { turn_id: tid, conversation_id: cid || str(a.conversation_id) });
    return { state: ans.state, how: 'turn', el: slot };
  }
  placedAt.delete(row.id);
  return null;
}
// A marker's tap: the chat at the turn (the graph closes first: the chat
// opens under it), once per tap; a row whose pins are all unavailable has no
// turn to open, so the pin list opens instead, raised over the graph to the
// glance's rung (a panel raised from inside the overlay).
function onTurnsTap(ids, { x, y } = {}) {
  const pins = (Array.isArray(ids) ? ids : []).map((id) => [String(id), chatPinOf(id)]).filter(([, p]) => p);
  if (!pins.length) return;
  const stateOf = (p) => (p.row && p.row.answer ? p.row.answer.state : null);
  const live = pins.find(([id, p]) => stateOf(p) !== UNAVAILABLE && placedAt.has(id));
  if (!live) {
    const pop = openPinList(pins.map(([id]) => id), x, y);
    if (pop) pop.style.zIndex = 'var(--z-glance)';
    return;
  }
  const at = placedAt.get(live[0]);
  if (isOverlayOpen()) closeOverlay();
  bus.emit('chat:open', { view: 'turn', id: at.turn_id, conversation_id: at.conversation_id });
}
// settle: a paint of the section (markPins), the graph's open and close (its
// class), and the mirror's level crossing `read`.
function settlePins(trigger) {
  pinsDirty = trigger;
  let was = readable();
  const offMirror = bus.on('mirror', () => {
    const now = readable();
    if (now !== was) { was = now; trigger(); }
  });
  const ov = $('overlay');
  let mo = null;
  if (ov && typeof MutationObserver === 'function') {
    mo = new MutationObserver(() => trigger());
    mo.observe(ov, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    offMirror();
    if (mo) mo.disconnect();
    if (pinsDirty === trigger) pinsDirty = null;
  };
}
function registerTurnsHost() {
  const root = $('gv-inspector');
  if (!root) return null;
  try {
    return registerHost(TURNS_HOST, {
      root, well: () => $('gi-turns'), rung: '--z-turns-pins', kinds: [...CHAT_KINDS], glyph: TURNS_GLYPH,
      place: placePin, hidden: () => null, settle: settlePins,
    });
  } catch (e) {
    console.error('[web-chat] the turn list\'s chat-pin host failed to register', e);
    return null;
  }
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

let offs = null;
export function initGraphTurns() {
  if (offs) return;
  offs = [
    onInspectorRender(onInspector),
    setNodeMarker({ mark, refresh }),
    bus.on('mirror', onMirror),
    onMarkerTap(TURNS_HOST, onTurnsTap),
  ];
  const hostOff = registerTurnsHost();
  if (hostOff) offs.push(hostOff);
}

export function stopGraphTurns() {
  clearTimer();
  summaries = new Map();
  open = null;
  listed = new Map();
  placedAt.clear();
  if (!offs) return;
  for (const off of offs) { try { off(); } catch { /* already gone */ } }
  offs = null;
}
