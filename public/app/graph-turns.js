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
// Below the `read` mirror level nothing is drawn and nothing is requested, so
// the inspector is 0.8.0's for a basic viewer (notes-B Q19). Any answer that is
// not a turn list (403, 404, 503, a disabled body, the shell's {ok: true})
// draws nothing.
//
// Timers (§10.1): no poller. A bus 'mirror' change to the stream, while the
// graph is open, schedules ONE refresh of the marks 2 s later — a one-shot
// setTimeout, never a chain; stopGraphTurns() clears it.
import { onInspectorRender, setNodeMarker, isOverlayOpen, layoutAndRender } from './graph-view.js';
import { mirror, atLeast, normalizeTurn } from './chat-state.js';
import { fmtShort } from './chat-present.js';
import { nodeTime } from './labels.js';
import { bus } from './bus.js';

// GET /api/mirror/nodes at most once per this long.
export const REFRESH_GAP_MS = 2000;
// How long after a stream change the marks are refreshed.
export const REFRESH_DELAY_MS = 2000;

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

function turnRow({ t, role, unavailable }) {
  const li = el('li', 'gi-turn');
  li.dataset.role = role;
  li.appendChild(el('span', 'gi-turn-role', ROLE_MARK[role])).title = ROLE_TITLE[role];
  if (unavailable) {
    li.classList.add('gi-turn-gone');
    li.appendChild(el('span', 'gi-turn-text', 'turn no longer in the chat history'));
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
  return li;
}

function section(id, turns) {
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

/* ── lifecycle ────────────────────────────────────────────────────────────── */

let offs = null;
export function initGraphTurns() {
  if (offs) return;
  offs = [
    onInspectorRender(onInspector),
    setNodeMarker({ mark, refresh }),
    bus.on('mirror', onMirror),
  ];
}

export function stopGraphTurns() {
  clearTimer();
  summaries = new Map();
  open = null;
  if (!offs) return;
  for (const off of offs) { try { off(); } catch { /* already gone */ } }
  offs = null;
}
