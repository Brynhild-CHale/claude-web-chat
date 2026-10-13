// The chat chrome's presentation model (design spec §7.3): what the status bar,
// the trays, the chat panel's strip and the phone's tab, badge and Tasks say,
// computed from the store (chat-state.js) and the queue's snapshot
// (queue.js queueSnapshot()). Every word the chat chrome shows about Claude's
// state is chosen HERE, once, so the desktop and the phone can never disagree.
//
//   uiState(mirror, { now, approvalsReady })   → the one state line
//   categories(mirror, queueSnapshot, { now }) → the chips, trays and Tasks lines
//   runningCount(mirror, { now })              → the badge's and the segment's N
//   announce(prev, next, { now, gate })        → live-region text, or null
//   fmtClock · fmtShort · ago                  → the time phrases
//
// Pure and DOM-free: functions of their arguments, shared with the phone, run
// under plain `node --test` (test/chat-present.test.js). `now` is the SERVER's
// clock (chat-state's serverNow()), the one that stamped every time in the
// store; omitted, it is derived from the store's skew.
//
// D9, the heartbeat ruling: the most specific TRUE statement, and never "dead"
// or "disconnected" for a live process. A quiet session is "quiet, check the
// terminal"; a suspended one (Ctrl-Z) reads SUSPENDED in idle ink and is never
// worded or announced as offline (deviation 16).
import { ago } from './labels.js';
import { atLeast, TASK_KEEP_MS } from './chat-state.js';
import { pendingElicitation, elicitationLine } from './prompts-mod.js';

export { ago, atLeast };

// ── time ─────────────────────────────────────────────────────────────────────

// A running clock: `0:42`, `1:02:33`.
export function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

// A short span: `42s`, `14m`, `2h 5m`, `3d 4h`.
export function fmtShort(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// A span in words, for a sentence: "18 days", "40 minutes".
function fmtLong(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s < 120) return unit(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 120) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 48) return unit(h, 'hour');
  return unit(Math.floor(h / 24), 'day');
}

// ── reading the store ────────────────────────────────────────────────────────

const mapOf = (v) => (v instanceof Map ? v : new Map());
const finite = (v) => Number.isFinite(v);
const nowOf = (m, now) => (finite(now) ? now : Date.now() + (finite(m.skew) ? m.skew : 0));
const levelOf = (m) => (m.access && m.access.level) || 'basic';
const plural = (n, one, many) => (n === 1 ? one : many);

// One line, quoted, cut short for the bar: “The rail now collapses to 56px…”.
function quote(s, max = 60) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return `“${one.length > max ? `${one.slice(0, max).trimEnd()}…` : one}”`;
}

// The followed conversation's live state: the full Live at `read` and above, else
// the one its StatusRow implies — the same fields, with no content in them.
function liveOf(m, cid) {
  if (!cid) return null;
  const c = mapOf(m.conversations).get(cid);
  if (atLeast(levelOf(m), 'read') && c && c.live) return { live: c.live, content: true, conversation: c };
  const r = mapOf(m.status).get(cid);
  if (!r) return c && c.live ? { live: c.live, content: false, conversation: c } : null;
  return {
    content: false,
    conversation: c || null,
    live: {
      state: r.state,
      since: r.since,
      quiet: r.quiet ? { since: r.last_activity_at } : null,
      step: r.step_kind ? { kind: r.step_kind } : null,
      waiting: r.waiting_kind ? { kind: r.waiting_kind } : null,
      last_activity_at: r.last_activity_at,
    },
  };
}

const WORKING = new Set(['working', 'compacting']);
// Whether Claude is at it in a conversation — what makes a task's dot move.
function isWorking(m, cid) {
  if (!cid) return false;
  const c = mapOf(m.conversations).get(cid);
  if (c && c.live) return WORKING.has(c.live.state);
  const r = mapOf(m.status).get(cid);
  return !!(r && WORKING.has(r.state));
}

// The ask a waiting conversation's act is for: an answerable one from the asks
// domain first, else the live wait the store recorded (the read-only card's).
function askFor(m, cid, kind, wait) {
  let best = null;
  for (const a of mapOf(m.awaiting).values()) {
    if (a.conversation_id !== cid || a.state !== 'pending' || a.kind !== kind) continue;
    if (!best || (best.source === 'live' && a.source !== 'live') || (a.created_at || 0) > (best.created_at || 0)) best = a;
  }
  if (best) return best;
  const a = { id: null, conversation_id: cid, kind, state: 'pending', answerable: false, source: 'live' };
  if (wait && wait.tool) a.tool_name = wait.tool;
  if (wait && wait.summary) a.summary = wait.summary;
  return a;
}

// Every other live, non-headless conversation that is waiting on the user: the
// bar's "other session · needs you".
function othersOf(m, cid) {
  const out = [];
  const seen = new Set();
  for (const c of mapOf(m.conversations).values()) {
    seen.add(c.id);
    if (c.id === cid || c.headless) continue;
    const s = c.live && c.live.state;
    if (s !== 'question' && s !== 'waiting') continue;
    const o = { id: c.id, state: s, waiting_kind: (c.live.waiting && c.live.waiting.kind) || (s === 'question' ? 'question' : 'other') };
    if (c.title) o.title = c.title;
    out.push(o);
  }
  for (const r of mapOf(m.status).values()) {
    if (seen.has(r.id) || r.id === cid || (r.state !== 'question' && r.state !== 'waiting')) continue;
    out.push({ id: r.id, state: r.state, waiting_kind: r.waiting_kind || (r.state === 'question' ? 'question' : 'other') });
  }
  return out;
}

// ── uiState ──────────────────────────────────────────────────────────────────

const LABEL = { working: 'WORKING', question: 'QUESTION', waiting: 'NEEDS YOU', idle: 'IDLE', offline: 'OFFLINE',
  suspended: 'SUSPENDED' };
const LAST_ACTIVITY_AFTER_MS = 15000;

function out(key, head, { meta = '', detail = '', pace = 'normal', act = null, ask = null, others = [], conn = 'live',
  headless = false } = {}) {
  return Object.freeze({
    key,
    label: LABEL[key],
    head,
    detail,
    text: meta ? `${head} · ${meta}` : head,
    meta,
    pace,
    act,
    ask,
    others: Object.freeze(others),
    conn,
    headless,
  });
}

// The one state line (§7.3's wording table). `key` is one of working, question,
// waiting, idle, offline, suspended; `head` + `meta` are the bar (the step and
// its clock or age), `label` · `detail` the panel's strip; `text` is the whole
// line (a title, an aria-label); `act` is answer | approve | review | null for
// `ask`; `pace` is 'quiet' for a quiet working session (a still dot or bar);
// `others` lists the other conversations waiting on the user; `conn` is the
// socket's state, so announce() can tell a first connection from a return;
// `headless` is true for a `claude -p` job, which the store follows only when
// the tab chose it and for which announce() never speaks (§2.2).
// `approvalsReady`: an approvals slot is registered (chat-slots.js), so a
// permission the level may answer gets the answer frame (`approve`).
export function uiState(mirror, { now, approvalsReady = false } = {}) {
  const m = mirror || {};
  now = nowOf(m, now);
  const level = levelOf(m);
  const conn = m.conn || 'connecting';

  // The socket first: nothing else is known while it is down.
  if (conn !== 'live') {
    if (m.access && m.access.remote) {
      return out('offline', "Offline · can't reach this computer · retrying",
        { detail: "can't reach the host, retrying", conn });
    }
    const clientNow = now - (finite(m.skew) ? m.skew : 0);
    const gone = fmtShort(clientNow - (finite(m.connSince) ? m.connSince : clientNow));
    const verb = conn === 'connecting' ? 'connecting' : 'reconnecting';
    return out('offline', `Offline · ${verb}…`, { meta: gone, detail: `surface offline, ${verb} (${gone})`, conn });
  }

  // Connected, with no mirror to read: the connection's own wording.
  if (m.availability === 'disabled') {
    const hint = m.hint || '';
    return out('idle', hint ? `Chat mirror off · ${hint}` : 'Chat mirror off', { detail: hint || 'the chat mirror is off' });
  }
  if (m.availability !== 'ok' || level === 'off') {
    return out('idle', 'Live', { detail: m.availability === 'unknown' && level !== 'off'
      ? "reading Claude's status…" : "Claude's status isn't available on this surface" });
  }

  const cid = m.followed;
  const others = othersOf(m, cid);
  const known = liveOf(m, cid);
  if (!known) return out('idle', 'No Claude session', { detail: 'start claude in this project', others });
  const { live: L, content, conversation } = known;
  const since = (t) => (finite(t) ? t : finite(L.since) ? L.since : now);
  // Every line about the followed conversation carries `others`, and whether it
  // is a headless one: only its record can say, so below `read` it is never.
  const headless = !!(conversation && conversation.headless === true);
  const say = (key, head, opts = {}) => out(key, head, { ...opts, others, headless });

  // An MCP server's form the page can answer (§15.7): its hook holds the
  // terminal's dialog back, so the session reads busy while it waits.
  const elicit = L.state === 'question' || L.state === 'waiting' ? null : pendingElicitation(m, cid);
  if (elicit) return say('waiting', elicitationLine(elicit), { detail: elicitationLine(elicit), act: 'answer', ask: elicit });

  switch (L.state) {
    case 'question': {
      const ask = askFor(m, cid, 'question', L.waiting);
      const q = content ? (L.waiting && L.waiting.summary) || ask.summary || '' : '';
      if (!content) return say('question', 'Needs you · question', { detail: 'a question is waiting', act: 'answer', ask });
      return say('question', q ? `Question · ${q}` : 'Question · see the terminal',
        { detail: q || 'a question is waiting', act: 'answer', ask });
    }
    case 'waiting': {
      const kind = (L.waiting && L.waiting.kind) || 'other';
      if (kind === 'plan') {
        const ask = askFor(m, cid, 'plan', L.waiting);
        return say('waiting', content ? 'Plan ready · review it' : 'Needs you · plan approval',
          { detail: 'plan approval', act: 'review', ask });
      }
      if (kind === 'permission') {
        const ask = askFor(m, cid, 'permission', L.waiting);
        const answerable = approvalsReady && ask.answerable === true && ask.state === 'pending' && atLeast(level, 'full');
        const act = answerable ? 'approve' : 'review';
        if (!content) return say('waiting', 'Needs you · permission', { detail: 'permission', act, ask });
        const tool = (L.waiting && L.waiting.tool) || ask.tool_name || 'a tool';
        // Beside a mounted answer frame the chrome names the tool and never the
        // subject: a trusted click lands beside text a pane cannot rewrite (§4.5).
        const subject = act === 'approve' ? tool : (L.waiting && L.waiting.summary) || ask.summary || tool;
        return say('waiting', `Permission · ${subject}`, { detail: `Permission · ${subject}`, act, ask });
      }
      const what = content ? (L.waiting && L.waiting.summary) || '' : '';
      const ask = askFor(m, cid, 'other', L.waiting);
      return say('waiting', what ? `Needs you · ${what} — answer in the terminal` : 'Needs you — answer in the terminal',
        { detail: what || 'answer in the terminal', ask });
    }
    case 'compacting': {
      const clock = fmtClock(now - since(L.step && L.step.started_at));
      return say('working', 'Compacting', { meta: clock, detail: `compacting the conversation · ${clock}` });
    }
    case 'working': {
      const step = L.step || null;
      const name = step ? (content && step.label) || step.kind || '' : '';
      if (L.quiet) {
        const dur = fmtShort(now - (finite(L.quiet.since) ? L.quiet.since : since(L.last_activity_at)));
        return say('working', `Quiet ${dur}${name ? ` · ${name}` : ''} — check the terminal`, {
          detail: `quiet for ${dur}${name ? ` (last: ${name})` : ''}; check the terminal`, pace: 'quiet',
        });
      }
      const started = step && content ? since(step.started_at) : content ? since(L.turn_started_at) : since(L.since);
      const clock = fmtClock(now - started);
      const quietFor = finite(L.last_activity_at) ? now - L.last_activity_at : 0;
      const last = content && quietFor >= LAST_ACTIVITY_AFTER_MS ? ` · last activity ${ago(L.last_activity_at, now)}` : '';
      if (!name) return say('working', 'Working', { meta: clock, detail: `${clock}${last}` });
      return say('working', content ? name : `Working · ${name}`, { meta: clock, detail: `${name} · ${clock}${last}` });
    }
    case 'suspended':
      return say('suspended', 'Suspended · resume it in the terminal (fg)',
        { detail: 'stopped with Ctrl-Z; fg in the terminal resumes it' });
    case 'ended': {
      const when = ago(finite(conversation && conversation.ended_at) ? conversation.ended_at : L.since, now);
      return say('idle', 'Session ended', { meta: when || '', detail: when ? `session ended ${when}` : 'session ended' });
    }
    case 'idle':
      return idleState(m, L, content, now, say);
    default:
      return say('idle', 'Status unknown — check the terminal',
        { detail: 'no recent sign of this session; check the terminal' });
  }
}

// Idle says how the last turn ended, most specific first.
function idleState(m, L, content, now, say) {
  if (content && L.stale_status) {
    const quietFor = fmtLong(now - (finite(L.last_activity_at) ? L.last_activity_at : finite(L.since) ? L.since : now));
    return say('idle', `Idle — the session says busy, but nothing has happened for ${quietFor}`,
      { detail: 'status looks stale' });
  }
  const t = content ? L.last_turn : null;
  if (t) {
    const when = ago(t.ended_at, now) || '';
    const at = when ? ` · ${when}` : '';
    if (t.outcome === 'interrupted' || t.outcome === 'abandoned') {
      // Who stopped it (§2.6): the store's live state says, else the stream's turn.
      let by = t.ended_by;
      if (!by && m.stream && Array.isArray(m.stream.turns)) {
        const turn = m.stream.turns.find((x) => x.id === t.id);
        by = turn && turn.ended_by;
      }
      if (by === 'web' || by === 'hook') {
        return say('idle', 'Stopped · from this page', { meta: when, detail: `stopped from the web-chat page${at}` });
      }
      return say('idle', 'Stopped · interrupted in the terminal', { meta: when, detail: `interrupted${at}` });
    }
    if (t.outcome === 'error') {
      const why = t.error || 'the turn failed';
      return say('idle', `Stopped · ${why} — see the terminal`, { meta: when, detail: `stopped: ${why}` });
    }
    const files = t.code && finite(t.code.files) ? t.code.files : 0;
    if (files > 0) {
      const changed = `${files} ${plural(files, 'file', 'files')} changed`;
      return say('idle', `Done · ${changed}`, { meta: when, detail: `done · ${changed}${at}` });
    }
    if (t.reply_preview) {
      return say('idle', `Done · ${quote(t.reply_preview)}`, { meta: when, detail: when ? `replied ${when}` : 'replied' });
    }
    return say('idle', 'Done', { meta: when, detail: `done${at}` });
  }
  const when = ago(finite(L.last_activity_at) ? L.last_activity_at : L.since, now) || '';
  return say('idle', 'Idle', { meta: when, detail: when ? `last active ${when}` : 'idle' });
}

// ── categories ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  { cat: 'shells', kind: 'shell', title: 'Shells', one: 'shell', many: 'shells', tag: 'SHELL', runs: 'running', stop: 'Kill' },
  { cat: 'agents', kind: 'agent', title: 'Agents', one: 'agent', many: 'agents', tag: 'AGENT', runs: 'running', stop: 'Cancel' },
  { cat: 'workflows', kind: 'workflow', title: 'Workflows', one: 'workflow', many: 'workflows', tag: 'WORKFLOW', runs: 'running',
    stop: 'Cancel' },
  { cat: 'monitors', kind: 'monitor', title: 'Monitors', one: 'monitor', many: 'monitors', tag: 'MONITOR', runs: 'watching',
    stop: 'Remove' },
];
const FINISHED = new Set(['done', 'failed', 'killed', 'stopped', 'expired', 'unknown']);
const STOP_UNCONFIRMED_MS = 60000;
const RECENT_EVENT_MS = 60000;

// "Running" has ONE definition — the chip, the phone's badge and its Tasks
// segment all count it: a row whose status is `running`, which a live monitor's
// is (deviation 19).
export const isRunning = (t) => !!t && t.status === 'running';

// A finished row is shown for 15 minutes after it ended; a failure until the
// user has seen it (chat-state's markSeen), however old.
function shown(m, t, now) {
  if (!FINISHED.has(t.status)) return true;
  if (t.status === 'failed' && !(m.seen instanceof Set && m.seen.has(t.id))) return true;
  return !finite(t.ended_at) || now - t.ended_at < TASK_KEEP_MS;
}

function tasksIn(m, C, now) {
  const rows = [];
  for (const t of mapOf(m.tasks).values()) if (t.kind === C.kind && shown(m, t, now)) rows.push(t);
  // Running first, oldest first (a new one joins at the end); then finished,
  // the most recent first.
  return rows.sort((a, b) => (isRunning(b) - isRunning(a))
    || (isRunning(a) ? (a.started_at || 0) - (b.started_at || 0) : (b.ended_at || 0) - (a.ended_at || 0)));
}

function runningIn(m, C, now) {
  if (atLeast(levelOf(m), 'read')) return tasksIn(m, C, now).filter(isRunning).length;
  let n = 0;
  for (const r of mapOf(m.status).values()) n += (r.counts && finite(r.counts[C.cat]) ? r.counts[C.cat] : 0);
  return n;
}

// The badge's and the Tasks segment's number: every running task, every kind.
export function runningCount(mirror, { now } = {}) {
  const m = mirror || {};
  const at = nowOf(m, now);
  return CATEGORIES.reduce((n, C) => n + runningIn(m, C, at), 0);
}

const action = (id, label, { destructive = false, confirm = null } = {}) => Object.freeze({ id, label, destructive, confirm });

function taskMeta(t, now) {
  const since = (x) => (finite(x) ? now - x : NaN);
  if (isRunning(t)) {
    if (finite(t.stop_requested_at)) {
      return now - t.stop_requested_at < STOP_UNCONFIRMED_MS ? 'stopping…' : 'stop not confirmed — stop it in the terminal';
    }
    const meta = t.meta || {};
    if (t.kind === 'shell') {
      const parts = [];
      if (finite(t.started_at)) parts.push(fmtShort(since(t.started_at)));
      if (finite(meta.port)) parts.push(`:${meta.port}`);
      return parts.join(' · ');
    }
    if (t.kind === 'agent') {
      const parts = [];
      if (finite(t.started_at)) parts.push(fmtClock(since(t.started_at)));
      if (finite(meta.tools)) parts.push(`${meta.tools} ${plural(meta.tools, 'tool', 'tools')}`);
      return parts.join(' · ');
    }
    if (t.kind === 'workflow') {
      let step = meta.step;
      if (!step && Array.isArray(t.steps) && t.steps.length) {
        const at = t.steps.findIndex((s) => s.state === 'running');
        step = { index: at >= 0 ? at + 1 : t.steps.filter((s) => s.state === 'done').length, total: t.steps.length };
      }
      return step && finite(step.index) && finite(step.total) ? `step ${step.index} / ${step.total}` : '';
    }
    // a monitor
    const events = finite(meta.events) ? meta.events : 0;
    if (finite(meta.last_event_at) && now - meta.last_event_at >= RECENT_EVENT_MS) return `last fired ${ago(meta.last_event_at, now)}`;
    return events ? `${events} ${plural(events, 'event', 'events')}` : 'no events yet';
  }
  const when = ago(t.ended_at, now);
  const at = when ? ` · ${when}` : '';
  switch (t.status) {
    case 'done':
      return finite(t.exit_code) ? `exit ${t.exit_code}${at}` : when ? `done ${when}` : 'done';
    case 'failed':
      return finite(t.exit_code) ? `exit ${t.exit_code}${at}` : `failed${at}`;
    case 'killed':
      if (t.stopped_by === 'session-end') return 'stopped at session end';
      if (t.stopped_by === 'claude') return `killed by Claude${at}`;
      if (t.stopped_by === 'user') return `killed by you${at}`;
      if (t.stopped_by === 'memory') return `killed: out of memory${at}`;
      if (t.stopped_by === 'timeout') return `timed out${at}`;
      return `killed${at}`;
    case 'stopped':
      return t.stopped_by && t.stopped_by !== 'session-end' ? `stopped${at}` : 'stopped at session end';
    case 'expired': {
      const n = finite(t.meta && t.meta.events) ? t.meta.events : 0;
      return `expired · ${n} ${plural(n, 'event', 'events')}`;
    }
    default:
      return 'status unknown';
  }
}

function taskRow(m, t, C, now) {
  const level = levelOf(m);
  const caps = m.capabilities || {};
  const can = t.can || {};
  const running = isRunning(t);
  const stopping = running && finite(t.stop_requested_at);
  const busy = isWorking(m, t.conversation_id);
  const title = t.title || C.one;
  const actions = [];
  if (atLeast(level, 'read')) {
    if (t.kind === 'shell' && can.output !== false) actions.push(action('output', 'Output'));
    if (t.kind !== 'shell' && can.open !== false) actions.push(action('open', 'Open'));
  }
  // Kill, Cancel and Remove ask Claude to run TaskStop (Q7): a message, so
  // `full` and the daemon's task_stop capability; never on a finished row.
  if (running && !stopping && can.stop !== false && caps.task_stop === true && atLeast(level, 'full')) {
    const verb = C.stop;
    actions.push(action(verb.toLowerCase(), verb, {
      destructive: true,
      confirm: Object.freeze({
        text: `${verb} ${title}? Claude stops it with TaskStop${busy ? ' at its next step' : ''}.`,
        yes: verb,
        no: 'Keep',
        touch: `Confirm ${verb.toLowerCase()}`,
      }),
    }));
  }
  let line = t.line || '';
  if (t.kind === 'shell' && running && t.meta && t.meta.no_output_yet && !line) {
    line = 'no output yet — the program may buffer until it exits';
  }
  return Object.freeze({
    id: t.id,
    kind: t.kind,
    cat: C.cat,
    tone: running ? 'live' : t.status === 'failed' ? 'failed' : 'muted',
    pulse: running && busy && !stopping,
    title,
    mono: t.kind === 'shell',
    meta: taskMeta(t, now),
    steps: Array.isArray(t.steps) && t.steps.length ? t.steps : null,
    line,
    actions: Object.freeze(actions),
  });
}

// The phone's one 60 px line for a category (§8.6): its one item, or its title,
// its tray sub and a summary.
function phoneLine(entry, C, summary) {
  if (entry.rows.length === 1) {
    const r = entry.rows[0];
    return Object.freeze({ title: r.title, tag: C.tag, meta: r.meta, line: r.line, steps: r.steps, tone: r.tone, pulse: r.pulse,
      mono: r.mono });
  }
  return Object.freeze({ title: C.title, tag: '', meta: entry.sub, line: summary, steps: null, tone: entry.tone,
    pulse: entry.pulse, mono: false });
}

function taskCategory(m, C, now) {
  const content = atLeast(levelOf(m), 'read');
  if (!content) {
    // Below `read`: counts only, from the status rows; nothing to list.
    let running = 0;
    let pulse = false;
    for (const r of mapOf(m.status).values()) {
      const n = r.counts && finite(r.counts[C.cat]) ? r.counts[C.cat] : 0;
      running += n;
      if (n && WORKING.has(r.state)) pulse = true;
    }
    if (!running) return null;
    const sub = `${running} ${C.runs}`;
    const entry = { cat: C.cat, label: `${running} ${plural(running, C.one, C.many)}`, title: C.title, sub, running,
      count: running, tone: 'live', pulse, hidden: true, rows: Object.freeze([]) };
    entry.phone = Object.freeze({ title: C.title, tag: '', meta: sub, line: '', steps: null, tone: 'live', pulse, mono: false });
    return Object.freeze(entry);
  }
  const tasks = tasksIn(m, C, now);
  if (!tasks.length) return null;
  const rows = tasks.map((t) => taskRow(m, t, C, now));
  const running = tasks.filter(isRunning).length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const done = tasks.length - running - failed;
  let label;
  if (running) label = `${running} ${plural(running, C.one, C.many)}${failed ? ` · ${failed} failed` : ''}`;
  else if (failed) label = `${C.many} · ${failed} failed`;
  else label = `${C.many} · ${done} done`;
  const sub = [running && `${running} ${C.runs}`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(' · ');
  const entry = {
    cat: C.cat,
    label,
    title: C.title,
    sub,
    running,
    count: tasks.length,
    tone: running ? 'live' : failed ? 'failed' : 'muted',
    pulse: rows.some((r) => r.pulse),
    hidden: false,
    rows: Object.freeze(rows),
  };
  const titles = rows.filter((r, i) => isRunning(tasks[i])).map((r) => r.title);
  const finished = tasks.length - running;
  const summary = titles.length
    ? `${titles.join(' · ')}${finished ? ` · ${finished} done` : ''}`
    : `${finished} done`;
  entry.phone = phoneLine(entry, C, summary);
  return Object.freeze(entry);
}

const QUEUE = { cat: 'queue', title: 'Queue', tag: 'QUEUE' };
const isStaged = (it) => it.staged !== false;

function queueCategory(m, queue, now) {
  const items = queue && Array.isArray(queue.items) ? queue.items.filter((it) => it && typeof it === 'object') : [];
  const count = queue && finite(queue.count) ? queue.count : items.length;
  if (!count) return null;
  const level = levelOf(m);
  const caps = m.capabilities || {};
  const send = caps.queue_message === true && atLeast(level, 'full');
  const firstStaged = items.find((it) => it.kind === 'message' && isStaged(it));
  let position = 0;
  const rows = items.map((it) => {
    const staged = isStaged(it);
    if (it.kind === 'message') {
      const meta = staged ? (position++ === 0 ? 'next' : `#${position}`) : 'held';
      const from = it.device === 'mobile' ? 'phone' : it.device === 'desktop' ? 'desktop' : '';
      const when = ago(it.enqueued_at, now);
      const actions = [];
      if (send) actions.push(action('edit', 'Edit'));
      if (send && it === firstStaged) actions.push(action('send-now', 'Send now'));
      if (atLeast(level, 'full')) actions.push(action('remove', 'Remove', { destructive: true }));
      return Object.freeze({
        id: it.id, kind: 'message', cat: 'queue', tone: meta === 'next' ? 'live' : 'muted', pulse: false,
        title: it.text || it.summary || `message · ${finite(it.chars) ? it.chars : 0} chars`, mono: false, meta, steps: null,
        line: [from && `sent from ${from}`, when].filter(Boolean).join(' · '), actions: Object.freeze(actions),
      });
    }
    return Object.freeze({
      id: it.id, kind: it.kind || 'signal', cat: 'queue', tone: staged ? 'live' : 'muted', pulse: false,
      title: it.summary || it.kind || 'signal', mono: false, meta: staged ? it.kind || 'signal' : 'held', steps: null,
      line: it.why_wake || it.source || '',
      actions: Object.freeze([
        action(staged ? 'hold' : 'stage', staged ? 'Hold' : 'Stage'),
        action('remove', 'Remove', { destructive: true }),
      ]),
    });
  });
  const staged = items.filter(isStaged).length;
  const held = items.length - staged;
  const sub = `${staged} queued${held ? ` · ${held} held` : ''}`;
  // `queue N` counts every queue item, as the rail does, and never pulses: the
  // queue is the user's, not Claude at work.
  const entry = { cat: 'queue', label: `queue ${count}`, title: QUEUE.title, sub, running: 0, count, tone: 'live',
    pulse: false, hidden: false, rows: Object.freeze(rows) };
  const next = firstStaged ? rows[items.indexOf(firstStaged)].title : '';
  const summary = next || (queue && queue.parked ? '⇢ Parked — delivers with your next message' : rows[0] ? rows[0].title : 'Nothing queued');
  entry.phone = phoneLine(entry, QUEUE, summary);
  return Object.freeze(entry);
}

// The chips, in their fixed order — shells, agents, workflows, monitors, queue —
// non-empty only. Each: `label` (the chip), `title` and `sub` (the tray's head),
// `running`, `count`, `tone` (live | muted | failed: the dot), `pulse` (the dot
// moves while Claude works on something that runs in it; the queue's never),
// `hidden` (below `read`: counts only), `rows` (RowModel, below) and `phone`
// (the Tasks line, §8.6).
//
// RowModel: {id, kind, cat, tone, pulse, title, mono, meta, steps, line,
// actions: [{id, label, destructive, confirm}]} — `confirm` is null or
// {text, yes, no, touch}: the copy of the one confirm (chat-actions.js).
export function categories(mirror, queue, { now } = {}) {
  const m = mirror || {};
  const at = nowOf(m, now);
  const list = [];
  for (const C of CATEGORIES) {
    const entry = taskCategory(m, C, at);
    if (entry) list.push(entry);
  }
  const q = queueCategory(m, queue, at);
  if (q) list.push(q);
  return Object.freeze(list);
}

// ── announce ─────────────────────────────────────────────────────────────────

export const ANNOUNCE_GAP_MS = 2000;

// One live region's memory: when it last spoke, and what it was kept from
// saying inside the gap (said on a later call while it is still true).
export const createAnnounceGate = () => ({ at: -Infinity, held: null });
const GATE = createAnnounceGate();

const askKey = (s) => (s && s.ask && s.ask.id) || '';

function transition(prev, next) {
  if (!prev || !next) return null;
  // Ctrl-Z is the user's own act, and a pause is never a disconnect.
  if (prev.key === 'suspended' || next.key === 'suspended') return null;
  if (next.key === 'offline' && prev.key !== 'offline') {
    return next.head.includes("can't reach") ? "Offline — can't reach this computer; retrying." : 'Offline — reconnecting.';
  }
  if (prev.key === 'offline' && next.key !== 'offline') return prev.conn === 'connecting' ? null : 'Back online.';
  // A headless conversation (a `claude -p` job the tab chose to follow) never
  // announces (§2.2): the surface's own comings and goings above still do.
  if (next.headless) return null;
  if (next.key === 'question' && (prev.key !== 'question' || askKey(prev) !== askKey(next))) {
    return `Claude has a question: ${next.detail}`;
  }
  if (next.key === 'waiting' && (prev.key !== 'waiting' || askKey(prev) !== askKey(next))) {
    return `Claude needs you: ${next.detail}`;
  }
  if (prev.key === 'working' && next.key === 'idle') return `Claude finished — ${next.head}`;
  return null;
}

// Live-region text for four transitions only — to a question, to a wait on the
// user (NEEDS YOU), working → idle, and offline and back — at most one per
// 2 s per gate; never for a move into or out of `suspended`, nor for a headless
// conversation (only offline and back are said while one is followed). `prev` and `next`
// are uiState() results. A transition inside the gap is held and said by a
// later call (the bar's 1 s ticker) while it is still true; pass the phone's
// region its own gate (createAnnounceGate()).
export function announce(prev, next, { now = Date.now(), gate = GATE } = {}) {
  let text = transition(prev, next);
  const held = gate.held;
  if (!text && held) {
    if (next && held.key === next.key && held.ask === askKey(next)) text = held.text;
    else gate.held = null;
  }
  if (!text) return null;
  if (now - gate.at < ANNOUNCE_GAP_MS) {
    gate.held = { key: next.key, ask: askKey(next), text };
    return null;
  }
  gate.at = now;
  gate.held = null;
  return text;
}
