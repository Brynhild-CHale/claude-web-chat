// The phone chrome's pure model (design spec §8.2–§8.6, §8.9): every rule of
// the pull, the sheet, the tab, the badge and the Tasks root that carries a
// number, as functions of their arguments. jsdom cannot lay out (§10.1), so the
// geometry, the gestures and the looks live HERE, where plain `node --test`
// pins them (test/sheet-model.test.js), and the DOM modules only apply them:
//
//   computeStops · stopList · stopName · nearest · snapTarget · stepStop ·
//   dragHeight · openStopFor · atLeastHalf · scrimFrac   → the sheet's height
//   isTap · classify                                     → the tab's gestures
//   normalizeDock · dockFor                              → docking the tab (N2)
//   tabLook · tabAnnounce · badgeLook                    → the tab and the badge
//   categoryLines                                        → the Tasks root
//   keyboardInset · kbFrame · keyboardUp                 → the keyboard (§8.5)
//
// The engine row: a number in the phone sheet lives in this file; never a
// second stop, snap or gesture rule.
//
// It COMPOSES chat-present.js (uiState, categories' phone lines): what Claude
// is doing and what runs is decided there, once, for the desktop and the phone
// alike; this module only chooses how the phone's tab, badge and lines say it.
// No document, window, storage or timer, and no clock: `now` is passed in.
import { atLeast, uiState } from './chat-present.js';

// ── constants ────────────────────────────────────────────────────────────────

export const TAB_H = 23;            // the grip tab's height
export const TOP_GAP = 22;          // full = avail − TOP_GAP: the tab sits flush under the topbar
export const HALF_FRAC = 0.53;      // half = avail × HALF_FRAC …
export const HALF_MIN = 220;        // … clamped to [HALF_MIN, HALF_MAX] …
export const HALF_MAX = 420;
export const HALF_GAP_MIN = 96;     // … and dropped when full − half < HALF_GAP_MIN (or full < HALF_MIN)
export const TAP_SLOP = 6;          // a tap moves at most this far on BOTH axes; past it the axis decides
export const SNAP_PUSH = 40;        // a drag this far from its starting stop always moves at least one stop
export const ASK_HALF_MIN = 320;    // an ask's card plus the composer need about 290 px: open full below this
export const TAB_W = 56;            // the tab's width …
export const TAB_W_ALERT = 124;     // … while it reads QUESTION or NEEDS YOU
export const BADGE_GAP = 4;         // the badge sits BADGE_GAP px off the tab's inner side
export const KB_MIN = 80;           // the keyboard is up when it hides more than this (§8.5)
export const KB_INSET = 8;          // the pinned sheet's gap under the visual viewport's top
export const LABEL_MAX = 160;       // a step in the tab's aria-label is cut to this
export const DOCKS = Object.freeze(['left', 'center', 'right']);
export const DOCK_DEFAULT = 'right';

const finite = (v) => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── stops (§8.2) ─────────────────────────────────────────────────────────────

// The sheet's stops for an available height (bottombar.top − topbar.bottom):
// `full` leaves the tab flush under the topbar; `half` is 53 % of it within
// [220, 420], or null when it would sit too near full (or full is under 220),
// so a short screen (a landscape phone) has one stop.
export function computeStops(avail) {
  const a = finite(avail) ? Math.max(0, Math.round(avail)) : 0;
  const full = Math.max(0, a - TOP_GAP);
  let half = clamp(Math.round(a * HALF_FRAC), HALF_MIN, HALF_MAX);
  if (full - half < HALF_GAP_MIN || full < HALF_MIN) half = null;
  return Object.freeze({ avail: a, full, half });
}

// The stops, lowest first: [0, half?, full] (one 0 when there is no room at all).
export function stopList(stops) {
  const out = [0];
  if (stops && finite(stops.half) && stops.half > 0) out.push(stops.half);
  if (stops && finite(stops.full) && stops.full > out[out.length - 1]) out.push(stops.full);
  return out;
}

const at = (h, s) => Math.abs(h - s) < 0.5;

// `data-stop`: closed, half, full, or between (a drag, a settle).
export function stopName(h, stops) {
  const v = finite(h) ? h : 0;
  if (at(v, 0)) return 'closed';
  if (stops && finite(stops.half) && at(v, stops.half)) return 'half';
  if (stops && finite(stops.full) && at(v, stops.full)) return 'full';
  return 'between';
}

// The stop nearest a height (the lower one on a tie).
export function nearest(h, stops) {
  const v = finite(h) ? h : 0;
  let best = 0;
  for (const s of stopList(stops)) if (Math.abs(v - s) < Math.abs(v - best)) best = s;
  return best;
}

// Where a release settles: the nearest stop, except that a drag of more than
// SNAP_PUSH px away from the stop it started at (`from`) always moves at least
// one stop that way — 45 px up from closed opens half (full when there is no
// half), 42 px down from full drops to half, 30 px from half stays.
export function snapTarget({ from, h, stops } = {}) {
  const near = nearest(h, stops);
  if (!finite(from) || !finite(h)) return near;
  const list = stopList(stops);
  if (h - from > SNAP_PUSH) {
    const up = list.find((s) => s > from);
    return up === undefined ? near : Math.max(near, up);
  }
  if (from - h > SNAP_PUSH) {
    const down = [...list].reverse().find((s) => s < from);
    return down === undefined ? near : Math.min(near, down);
  }
  return near;
}

// ArrowUp (+1) and ArrowDown (−1) on the tab: the next stop that way, held at
// the ends.
export function stepStop(h, dir, stops) {
  const v = finite(h) ? h : 0;
  const list = stopList(stops);
  if (dir > 0) {
    const up = list.find((s) => s > v + 0.5);
    return up === undefined ? list[list.length - 1] : up;
  }
  if (dir < 0) {
    const down = [...list].reverse().find((s) => s < v - 0.5);
    return down === undefined ? 0 : down;
  }
  return nearest(v, stops);
}

// A drag's height: the height it started from, moved by the pointer's travel
// (`dy` in screen pixels, down positive, so a drag up grows the sheet), held to
// [0, full].
export function dragHeight({ start, dy, stops } = {}) {
  const full = stops && finite(stops.full) ? stops.full : 0;
  return clamp((finite(start) ? start : 0) - (finite(dy) ? dy : 0), 0, full);
}

// A tap-open's stop: half, or full while an ask is pending and half is missing
// or too short for its card and the composer.
export function openStopFor(stops, { askPending = false } = {}) {
  const full = stops && finite(stops.full) ? stops.full : 0;
  const half = stops && finite(stops.half) ? stops.half : null;
  if (askPending && (half === null || half < ASK_HALF_MIN)) return full;
  return half === null ? full : half;
}

// The badge, the Queue and chat:tasks open at least half: never lower an open sheet.
export function atLeastHalf(h, stops) {
  const half = stops && finite(stops.half) ? stops.half : stops && finite(stops.full) ? stops.full : 0;
  return Math.max(finite(h) ? h : 0, half);
}

// The scrim's dim, as the sheet's share of full.
export function scrimFrac(h, full) {
  if (!finite(full) || full <= 0 || !finite(h)) return 0;
  return clamp(h / full, 0, 1);
}

// ── gestures (§8.4) ──────────────────────────────────────────────────────────

// A tap: within TAP_SLOP on both axes (a sideways swipe is not a tap).
export function isTap(dx, dy) {
  return Math.abs(finite(dx) ? dx : 0) <= TAP_SLOP && Math.abs(finite(dy) ? dy : 0) <= TAP_SLOP;
}

// A drag's axis: 'y' once it has gone past TAP_SLOP vertically and at least as
// far as sideways; 'x' only for a closed sheet with a dock handler, past
// TAP_SLOP sideways and more than twice as far as vertically; else null (still
// undecided).
export function classify({ dx = 0, dy = 0, dockable = false, closed = false } = {}) {
  const ax = Math.abs(finite(dx) ? dx : 0);
  const ay = Math.abs(finite(dy) ? dy : 0);
  if (ay > TAP_SLOP && ay >= ax) return 'y';
  if (dockable && closed && ax > TAP_SLOP && ax > 2 * ay) return 'x';
  return null;
}

// ── docking (§8.9, N2) ───────────────────────────────────────────────────────

// A stored or attribute dock: a known one, else the default (right).
export function normalizeDock(v) {
  return DOCKS.includes(v) ? v : DOCK_DEFAULT;
}

// Where a released horizontal drag docks: by thirds of the width.
export function dockFor(x, width) {
  if (!finite(x) || !finite(width) || width <= 0) return DOCK_DEFAULT;
  if (x < width / 3) return 'left';
  if (x < (2 * width) / 3) return 'center';
  return 'right';
}

// ── the tab (§8.3) ───────────────────────────────────────────────────────────

// Most urgent first: several conversations collapse into the most urgent state.
const URGENCY = ['waiting', 'question', 'working', 'offline', 'suspended', 'idle'];
const rank = (key) => {
  const i = URGENCY.indexOf(key);
  return i < 0 ? URGENCY.length : i;
};

function clip(text) {
  const chars = Array.from(String(text || ''));
  return chars.length <= LABEL_MAX ? chars.join('') : `${chars.slice(0, LABEL_MAX - 1).join('').trimEnd()}…`;
}

const mapOf = (v) => (v instanceof Map ? v : new Map());

// Every conversation the tab collapses over: the followed one first, then each
// other live, non-headless one (the store's conversations, and its status rows
// below `read`, where they are all it has).
function candidates(m) {
  const ids = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
  const convs = mapOf(m.conversations);
  if (m.followed) add(m.followed);
  for (const c of convs.values()) if (!c.headless) add(c.id);
  for (const r of mapOf(m.status).values()) {
    const c = convs.get(r.id);
    if (!(c && c.headless)) add(r.id);
  }
  return ids;
}

// The tab's aria-label. No clock or age in it: nothing redraws the tab while a
// session is quiet, so a "4m" here would go stale.
function labelOf(s, elsewhere) {
  const where = elsewhere ? ' in another session' : '';
  switch (s.key) {
    case 'working': {
      if (s.pace === 'quiet') return 'Claude is working, quiet — check the terminal';
      const step = clip(String(s.head || '').replace(/^Working(?: · |$)/, ''));
      return step ? `Claude is working — ${step}` : 'Claude is working';
    }
    case 'question':
      return `Claude has a question${where} — open the chat`;
    case 'waiting': {
      const kind = s.ask && s.ask.kind;
      if (kind === 'permission') return `Claude needs you${where}: permission prompt`;
      if (kind === 'plan') return `Claude needs you${where}: plan approval`;
      return `Claude needs you${where} — answer in the terminal`;
    }
    case 'offline':
      return `Chat with Claude — ${s.conn === 'connecting' ? 'connecting' : 'reconnecting'}`;
    case 'suspended':
      return 'Claude is suspended — resume it in the terminal';
    default:
      return 'Chat with Claude — idle';
  }
}

// What the closed tab shows: `state` (data-cs-state), `quiet` (a still bar in
// the working ink), `alert` (question or waiting: the wide tab), `word`
// (QUESTION or NEEDS YOU, chat-present's label, while alerting), `width`,
// `label` (its aria-label) and `conversationId` (whose state it is). Each
// candidate is read through uiState, asked about that conversation; the socket
// being down makes every one offline. A tie keeps the followed conversation.
export function tabLook(mirror, { now, approvalsReady = false } = {}) {
  const m = mirror || {};
  const followed = m.followed || null;
  let best = uiState(m, { now, approvalsReady });
  let bestId = followed;
  for (const id of candidates(m)) {
    if (id === followed) continue;
    if (rank(best.key) === 0) break;
    const s = uiState({ ...m, followed: id }, { now, approvalsReady });
    if (rank(s.key) < rank(best.key)) { best = s; bestId = id; }
  }
  const alert = best.key === 'question' || best.key === 'waiting';
  return Object.freeze({
    state: best.key,
    quiet: best.pace === 'quiet',
    alert,
    word: alert ? best.label : '',
    width: alert ? TAB_W_ALERT : TAB_W,
    label: labelOf(best, bestId !== followed),
    conversationId: bestId,
  });
}

const SPOKEN = new Set(['waiting', 'question', 'offline']);

// #chat-live's text for a tab change: only a move INTO waiting, question or
// offline says anything (the new label). Suspended is never announced, nor as
// offline; a first look (no `prev`) says nothing.
export function tabAnnounce(prev, next) {
  if (!prev || !next || prev.state === next.state || !SPOKEN.has(next.state)) return '';
  return next.label || '';
}

// ── the badge (§8.3, §8.9) ───────────────────────────────────────────────────

// The running-tasks badge: `off` at 0; dimmed unless Claude is working; on the
// tab's inner side (left of a right-docked tab, right of a left-docked one);
// merged into a centred tab, whose count and aria-label suffix it becomes.
// `running` is chat-present's runningCount (deviation 19).
export function badgeLook({ running = 0, working = false } = {}, { dock } = {}) {
  const n = finite(running) && running > 0 ? Math.floor(running) : 0;
  const d = normalizeDock(dock);
  const merged = d === 'center';
  const off = n === 0;
  const count = n === 1 ? '1 running task' : `${n} running tasks`;
  return Object.freeze({
    off,
    n,
    text: String(n),
    opacity: working ? 1 : 0.75,
    inner: d === 'right' ? 'left' : d === 'left' ? 'right' : null,
    merged,
    tabCount: merged ? n : 0,
    tabSuffix: merged && n > 0 ? `, ${n} running` : '',
    label: off ? 'No running tasks' : `${count} — open Tasks`,
  });
}

// ── the Tasks root (§8.6) ────────────────────────────────────────────────────

export const EMPTY_TASKS_NOTE = 'No background tasks right now';
export const EMPTY_QUEUE_LINE = 'Nothing queued';
export const PARKED_LINE = '⇢ Parked — delivers with your next message';

// The Tasks root's lines, from categories()'s answer, in its order: each
// category's phone line, `pulse` only while Claude works, `tappable` at `read`
// and above (the Queue at every level), `countsOnly` below `read`, and
// `running` (the category's running rows: their sum is the badge's number).
// The Queue line is always there: categories() omits an empty queue, and the
// line then says 'Nothing queued', or the parked note when the last push parked
// (`parked`: the queue snapshot's `parked` is set). `emptyNote` is the one
// muted line when no task category is present.
export function categoryLines(cats, { level, working = false, parked = false } = {}) {
  // Content at `read` and above, on chat-state's one ladder (via chat-present);
  // anything else, an unknown level included, ranks -1 and shows counts only.
  const content = atLeast(level, 'read');
  const list = Array.isArray(cats) ? cats : [];
  const lines = [];
  let tasks = 0;
  let queue = false;
  for (const entry of list) {
    if (!entry || !entry.phone) continue;
    const isQueue = entry.cat === 'queue';
    if (isQueue) queue = true;
    else tasks += 1;
    const p = entry.phone;
    lines.push(Object.freeze({
      cat: entry.cat,
      title: p.title,
      tag: p.tag,
      meta: p.meta,
      line: p.line,
      steps: p.steps,
      tone: p.tone,
      mono: p.mono,
      pulse: !!(entry.pulse && working),
      tappable: content || isQueue,
      countsOnly: !content,
      running: finite(entry.running) ? entry.running : 0,
    }));
  }
  if (!queue) {
    lines.push(Object.freeze({
      cat: 'queue', title: 'Queue', tag: '', meta: '', line: parked ? PARKED_LINE : EMPTY_QUEUE_LINE, steps: null,
      tone: 'muted', mono: false, pulse: false, tappable: true, countsOnly: !content, running: 0,
    }));
  }
  return Object.freeze({ lines: Object.freeze(lines), emptyNote: tasks ? '' : EMPTY_TASKS_NOTE });
}

// ── the keyboard (§8.5) ──────────────────────────────────────────────────────

// How much of the layout viewport the keyboard hides.
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop } = {}) {
  if (!finite(innerHeight) || !finite(vvHeight) || !finite(vvOffsetTop)) return 0;
  return innerHeight - (vvHeight + vvOffsetTop);
}

// Whether the keyboard is up: it hides more than KB_MIN px.
export function keyboardUp(inset) {
  return finite(inset) && inset > KB_MIN;
}

// The pull's frame while the keyboard is up: pinned to the visual viewport.
export function kbFrame({ vvHeight, vvOffsetTop } = {}) {
  const top = finite(vvOffsetTop) ? vvOffsetTop : 0;
  const height = finite(vvHeight) ? vvHeight : 0;
  return Object.freeze({ top: top + KB_INSET, height: Math.max(0, height - KB_INSET) });
}
