// lib/server/control/session-ops.js — the session controls on the mod (spec
// §15.7 'Session controls', §15.5, §15.6 'In place'; rulings Q10, Q-E, Q-C,
// B1 (a), B-confirm (4); 2026-10-13: D1 (a), D-defaults (a)
// U93@controls-placement-and-timers; notes-C D7, D8, Q-C16..Q-C19).
//
//   installSessionOps(control, {bridge, mirror, env, log}) → uninstall()
//                                 (uninstall.features() → {ok} | {ok: false,
//                                 reason: 'no-mod'}; uninstall.ACTIONS)
//   createContextReadings({hooks, mirror, now}) → {forConversation(cid),
//                                 forSession(sid), stop(), size()}
//
// Two halves, both daemon-side; the chrome's half is public/app/session-ops.js
// (#cp-ops, the panel header).
//
// ── 1. FIVE ROWS ON THE CONTROL DOMAIN (§15.5) ──────────────────────────────
// Added through control.action — never by editing the table — beside U89's
// rows (control/mod.js), with names of their own (the `session-` prefix, so
// they never meet U89's 'task-stop' and 'resume'):
//
//   session-compact {conversation_id}         /compact
//   session-plan    {conversation_id}         /plan  (ENTERS plan mode; nothing
//                                             leaves it but the terminal's
//                                             Shift+Tab: Q10, no other mode switch)
//   session-rename  {conversation_id, name}   /rename <name>
//   session-clear   {conversation_id}         /clear
//   session-resume  {conversation_id, target} /resume <target's session id>,
//                                             experimental: behind
//                                             WEB_CHAT_REWIND_IN_PLACE=1, as the
//                                             in-place fork (Q-E, notes-C Q-C17)
//
// Each: fields exactly the query keys its document is minted with (the 'one
// name per target' rule), layouts ['confirm'], limit once per 2 s per
// conversation (§15.5: "a session control at most once per 2 s"), describe in
// plain words from server state and the target only, and
//   check → 'experimental' (resume, flag off) · 'not-live' (unknown or ended)
//           · 'no-mod' (bridge.sessionOf finds no attached mod) · 'bad-name'
//           (rename: a line break or a control character, or — after
//           lib/core/text stripControls and a trim — what validateOp's rename
//           bound refuses: empty, over 64, led by '/') · 'plan-on' (plan mode
//           is already on) · 'bad-target' (resume: not an ended conversation of
//           this project, other than this one, with a session id)
//   run   → ONE bridge.enqueue(bridge.sessionOf(conversation_id),
//           {op: 'command', args: {name, args?}}, {resultWithinMs: 5000})
//           → {ok: true, via: 'mod', said} | {ok: false, refused:
//           'mod-refused' | 'timeout' | 'no-result', hint}
// The answer's `said` is what the confirm frame's generic 'done' shows (U89's
// Q-B3 grant). The domain writes the one audit line per action and refusal:
// ids and the outcome. The rename's name is held on its target as a
// NON-ENUMERABLE property, so the audit's target (Object.entries) never carries
// what the user typed (§15.5: never a command or its text).
//
// Class P2 (§15.5): the actions run only through the answer origin's frames;
// nothing here is a main-origin route (C46). No model, effort, config or
// permission-mode control beyond entering plan mode (Q10).
//
// ── 2. THE CONTEXT READING (notes-C D8; ruled D1 (a)) ───────────────────────
// U90 leaves the mod's `session.measure` to this unit, and no frame or snapshot
// field carries it. createContextReadings subscribes to the hook tap and keeps,
// per session, the latest ModEvent session.measure's `context` as numbers only,
// {tokens, window, percent, at}; the rate limits and the cost the event also
// carries are dropped on arrival and never kept. A `{window}`-only context
// (Claude Code's before its first request) is not a reading. A session is
// forgotten on a main-loop SessionEnd on the tap and on the mirror's
// process-gone. GET /api/mirror/context (lib/server/routes/mirror-context.js)
// answers forConversation(cid): the newest reading among the sessions the
// mirror maps to that conversation. Before the first reading there is none, and
// the meter is hidden: the transcript fallback §15.7 names is not built (D1 (a)).

const { isSafeId } = require('../../core/paths');
const { CONTROL_RE, stripControls } = require('../../core/text');
const { MOD_EVENT, isUuid, validateOp } = require('../../core/mod-protocol');
const { BadTarget } = require('./index');
const { FLAG } = require('./mod');

const LIMIT_MS = 2000;                 // §15.5: a session control at most once per 2 s
const RESULT_MS = 5000;                // the command's answer
const SAID_MAX = 120;
const NAME_IN_MAX = 1000;              // longer than this is not a name at all (400)
const TITLE_SHOWN_MAX = 80;
const READINGS_MAX = 64;               // sessions with a reading, at most

const ACTIONS = Object.freeze(['session-compact', 'session-plan', 'session-rename', 'session-clear', 'session-resume']);

const SAID = Object.freeze({
  compact: 'Compacting — it runs after the current turn',
  plan: 'Plan mode requested',
  rename: 'Renamed',
  clear: 'Cleared — a new session started',
  resume: 'Switched',
});

const HINTS = Object.freeze({
  experimental: `experimental: set ${FLAG}=1 and run claude-web-chat restart`,
  notLive: 'that conversation is not running in a terminal any more',
  noMod: 'no web-chat mod is attached to the terminal this conversation runs in — use the terminal',
  badName: 'a name is 1 to 64 characters on one line, not starting with /',
  planOn: 'plan mode is already on — leave it in the terminal (Shift+Tab)',
  badTarget: 'that is not an ended conversation of this project',
  failed: 'the mod did not run it — try it in the terminal',
});

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function shownTitle(c) {
  const raw = c && (typeof c.title === 'string' && c.title ? c.title : (typeof c.name === 'string' ? c.name : ''));
  const s = stripControls(raw || '').trim();
  return s ? cap(s, TITLE_SHOWN_MAX) : 'Untitled session';
}

// The rename's name, cleaned, or null when it is refused ('bad-name').
function cleanName(raw) {
  if (typeof raw !== 'string' || CONTROL_RE.test(raw)) return null;   // one line, no controls
  const s = stripControls(raw).trim();                                // bidi and invisible marks go
  const v = validateOp('command', { name: 'rename', args: s });       // the wire's own bound
  return v && v.ok === true ? s : null;
}

function installSessionOps(control, {
  bridge = null,
  mirror = null,
  env = process.env,
  log = () => {},
} = {}) {
  if (!control || typeof control.action !== 'function') throw new TypeError('installSessionOps needs the control domain');
  const say = (m) => { try { log(m); } catch { /* a logger never breaks a control */ } };
  const inPlace = !!env && env[FLAG] === '1';   // read once (§11.1: it takes a restart)
  let removed = false;

  const anyMod = () => {
    if (!bridge || typeof bridge.any !== 'function') return false;
    try { return bridge.any() === true; } catch { return false; }
  };
  const modSessionOf = (cid) => {
    if (!bridge || typeof bridge.sessionOf !== 'function' || typeof bridge.enqueue !== 'function') return null;
    let sid = null;
    try { sid = bridge.sessionOf(cid); } catch { sid = null; }
    return isSafeId(sid) ? sid : null;
  };

  function conversations() {
    if (!mirror || typeof mirror.snapshot !== 'function') return [];
    let snap = null;
    try { snap = mirror.snapshot({ level: 'local' }); } catch { return []; }
    return snap && Array.isArray(snap.conversations) ? snap.conversations.filter(isPlain) : [];
  }
  const conversation = (cid) => conversations().find((c) => c.id === cid) || null;
  const stateOf = (c) => (c && isPlain(c.live) && typeof c.live.state === 'string' ? c.live.state : null);
  const modeOf = (c) => (c && (typeof c.permission_mode === 'string' && c.permission_mode ? c.permission_mode : c.mode)) || null;

  // The conversation a resume target (a session id) belongs to: an ended one
  // of this project, not the one asking, with a session id. → {c, sid} | null
  function resumeTarget(target) {
    const sid = lower(target.target);
    const list = conversations();
    let cid = null;
    if (mirror && typeof mirror.conversationOf === 'function') {
      try { cid = mirror.conversationOf(sid); } catch { cid = null; }
    }
    const c = (cid && list.find((x) => x.id === cid))
      || list.find((x) => lower(x.current_session_id) === sid
        || (Array.isArray(x.sessions) && x.sessions.some((s) => isPlain(s) && lower(s.session_id) === sid)))
      || null;
    if (!c || c.id === target.conversation_id || stateOf(c) !== 'ended') return null;
    return { c, sid };
  }

  // ── params ────────────────────────────────────────────────────────────────
  function cidOf(s) {
    if (!isSafeId(s.conversation_id)) throw new BadTarget('conversation_id: a conversation id');
    return s.conversation_id;
  }
  const plainParams = (source) => ({ conversation_id: cidOf(isPlain(source) ? source : {}) });
  function renameParams(source) {
    const s = isPlain(source) ? source : {};
    const target = { conversation_id: cidOf(s) };
    if (typeof s.name !== 'string' || s.name.length > NAME_IN_MAX) throw new BadTarget('name: a string');
    // Not enumerable: the audit's target never holds the name typed.
    Object.defineProperty(target, 'name', { value: s.name, enumerable: false });
    return target;
  }
  function resumeParams(source) {
    const s = isPlain(source) ? source : {};
    const target = { conversation_id: cidOf(s), target: null };
    if (!isUuid(s.target)) throw new BadTarget('target: a session id');
    target.target = s.target.toLowerCase();
    return target;
  }

  // ── check ─────────────────────────────────────────────────────────────────
  function common(target) {
    const c = conversation(target.conversation_id);
    if (!c || stateOf(c) === 'ended') return { refused: 'not-live', hint: HINTS.notLive };
    if (!modSessionOf(target.conversation_id)) return { refused: 'no-mod', hint: HINTS.noMod };
    return { c };
  }
  const checkWith = (more) => async (target) => {
    const r = common(target);
    if (r.refused) return r;
    return more ? more(target, r.c) : null;
  };
  const checkRename = checkWith((target) => (cleanName(target.name) === null ? { refused: 'bad-name', hint: HINTS.badName } : null));
  const checkPlan = checkWith((target, c) => (modeOf(c) === 'plan' ? { refused: 'plan-on', hint: HINTS.planOn } : null));
  const checkResumeRest = checkWith((target) => (resumeTarget(target) ? null : { refused: 'bad-target', hint: HINTS.badTarget }));
  async function checkResume(target) {
    if (!inPlace) return { refused: 'experimental', hint: HINTS.experimental };
    return checkResumeRest(target);
  }

  // ── run ───────────────────────────────────────────────────────────────────
  async function command(target, name, args, said) {
    const sid = modSessionOf(target.conversation_id);
    if (!sid) return { ok: false, refused: 'mod-refused', hint: HINTS.noMod };
    const op = { op: 'command', args: args === undefined ? { name } : { name, args } };
    let r = null;
    try { r = await bridge.enqueue(sid, op, { resultWithinMs: RESULT_MS }); } catch (e) {
      say(`control: session ${name} failed (${(e && e.code) || 'error'})`);
      r = null;
    }
    if (isPlain(r) && r.ok === true) return { ok: true, via: 'mod', said: cap(said, SAID_MAX) };
    const why = isPlain(r) && typeof r.refused === 'string' ? r.refused : 'failed';
    const refused = why === 'timeout' || why === 'no-result' ? why : 'mod-refused';
    const hint = isPlain(r) && typeof r.hint === 'string' && r.hint ? r.hint : HINTS.failed;
    say(`control: session ${name} not run (${why})`);
    return { ok: false, refused, hint };
  }

  async function runRename(target) {
    const name = cleanName(target.name);
    if (name === null) return { ok: false, refused: 'bad-name', hint: HINTS.badName };
    return command(target, 'rename', name, SAID.rename);
  }
  async function runResume(target) {
    const t = resumeTarget(target);
    if (!t) return { ok: false, refused: 'bad-target', hint: HINTS.badTarget };
    return command(target, 'resume', t.sid, SAID.resume);
  }

  // ── describe ──────────────────────────────────────────────────────────────
  const describers = {
    'session-compact': async () => ({
      title: 'Compact this conversation now',
      summary: 'Claude Code summarises the conversation so far to free up context, as /compact does in the terminal. It runs after the current turn.',
    }),
    'session-plan': async () => ({
      title: 'Turn on plan mode — it also switches the model, as /plan does in the terminal',
      summary: 'Claude plans before it edits. Leave plan mode in the terminal (Shift+Tab).',
    }),
    'session-rename': async (target) => {
      const n = cleanName(target.name);
      return n === null
        ? { title: 'Rename this session', summary: `That name cannot be used: ${HINTS.badName}.` }
        : { title: `Rename this session to “${n}”`, summary: 'As /rename does in the terminal.' };
    },
    'session-clear': async () => ({
      title: 'Clear this session: Claude starts a new one, and this one stays resumable',
      summary: 'As /clear does in the terminal. The conversation so far stays on disk; /resume brings it back.',
    }),
    'session-resume': async (target) => {
      const t = resumeTarget(target);
      return {
        title: `Switch this terminal to “${t ? shownTitle(t.c) : 'another conversation'}”`,
        summary: 'Experimental. The terminal resumes that conversation, as /resume does; this one stays on disk.',
      };
    },
  };

  const features = () => (anyMod() ? { ok: true } : { ok: false, reason: 'no-mod' });

  const row = (name, { fields, params, check, run }) => control.action(name, {
    fields,
    layouts: ['confirm'],
    limit: { scope: 'conversation', ms: LIMIT_MS },
    params,
    key: (target) => target.conversation_id,
    describe: describers[name],
    check,
    run,
    features,
  });

  const offs = [
    row('session-compact', { fields: ['conversation_id'], params: plainParams, check: checkWith(null),
      run: (t) => command(t, 'compact', undefined, SAID.compact) }),
    row('session-plan', { fields: ['conversation_id'], params: plainParams, check: checkPlan,
      run: (t) => command(t, 'plan', undefined, SAID.plan) }),
    row('session-rename', { fields: ['conversation_id', 'name'], params: renameParams, check: checkRename, run: runRename }),
    row('session-clear', { fields: ['conversation_id'], params: plainParams, check: checkWith(null),
      run: (t) => command(t, 'clear', undefined, SAID.clear) }),
    row('session-resume', { fields: ['conversation_id', 'target'], params: resumeParams, check: checkResume, run: runResume }),
  ];

  function uninstall() {
    if (removed) return;
    removed = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  }
  uninstall.features = features;
  uninstall.ACTIONS = ACTIONS;
  return uninstall;
}

// ── the context reading ─────────────────────────────────────────────────────

const finiteAtLeastZero = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// A ModEvent session.measure's context, as numbers only, or null.
function readingOf(context, at) {
  if (!isPlain(context)) return null;
  const { tokens, window } = context;
  if (!finiteAtLeastZero(tokens) || !finiteAtLeastZero(window) || window === 0) return null;
  const pct = finiteAtLeastZero(context.percent) ? context.percent : (tokens / window) * 100;
  return Object.freeze({ tokens, window, percent: Math.min(100, Math.round(pct * 10) / 10), at });
}

function createContextReadings({ hooks = null, mirror = null, now = Date.now } = {}) {
  const readings = new Map();   // session id (lower case) → {tokens, window, percent, at}
  const offs = [];
  let stopped = false;

  function onHook(env) {
    if (!isPlain(env) || typeof env.session_id !== 'string') return;
    const sid = env.session_id.toLowerCase();
    if (env.event === 'SessionEnd' && env.synthetic !== true && !isPlain(env.agent)) {
      readings.delete(sid);
      return;
    }
    if (env.event !== MOD_EVENT || !isPlain(env.mod) || env.mod.kind !== 'session.measure') return;
    if (env.mod.agent_id !== undefined) return;   // a subagent's, never the session's
    const at = Number.isFinite(env.ts) ? env.ts : now();
    const r = readingOf(env.mod.context, at);
    if (!r) return;                                // {window} only: no reading yet
    readings.delete(sid);
    readings.set(sid, r);
    if (readings.size > READINGS_MAX) readings.delete(readings.keys().next().value);
  }

  function onMirror(e) {
    if (!isPlain(e) || e.op !== 'process-gone' || !Array.isArray(e.session_ids)) return;
    for (const id of e.session_ids) if (typeof id === 'string') readings.delete(id.toLowerCase());
  }

  if (hooks && typeof hooks.subscribe === 'function') offs.push(hooks.subscribe(onHook));
  if (mirror && typeof mirror.subscribe === 'function') {
    try { offs.push(mirror.subscribe(onMirror)); } catch { /* no transitions: SessionEnd still forgets */ }
  }

  const copy = (r) => (r ? { tokens: r.tokens, window: r.window, percent: r.percent, at: r.at } : null);

  function forSession(sid) {
    return typeof sid === 'string' ? copy(readings.get(sid.toLowerCase()) || null) : null;
  }

  // The newest reading among the conversation's sessions, or null.
  function forConversation(cid) {
    if (stopped || typeof cid !== 'string' || !cid || !mirror || typeof mirror.conversationOf !== 'function') return null;
    let conv = null;
    try { conv = mirror.conversationOf(cid); } catch { conv = null; }
    if (!conv) return null;
    let best = null;
    for (const [sid, r] of readings) {
      let c = null;
      try { c = mirror.conversationOf(sid); } catch { c = null; }
      if (c === conv && (!best || r.at >= best.at)) best = r;
    }
    return copy(best);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
    readings.clear();
  }

  return { forConversation, forSession, stop, size: () => readings.size };
}

module.exports = {
  installSessionOps, createContextReadings,
  ACTIONS, SAID, HINTS, LIMIT_MS, RESULT_MS, READINGS_MAX,
};
