// lib/server/control/mod.js — control on the mod (spec §15.7 'Control on the
// mod', §15.2 path 1, §6.9 'Ruled (Q7, Q-H)', §15.6 'In place'; rulings Q-B,
// Q-C, Q-E, Q7, Q-H, B1 (a), B2 (a), B-confirm (4), F6, C-defaults (a)).
//
//   installModControl(control, {bridge, mirror, forkTurn, bus, env, now, log,
//                               timers}) → {features(), unregister()}
//
// Where a web-chat mod is attached to a session (tier 2: ctx.bridge, U87), it
// makes three controls immediate or possible, without editing the control
// domain (lib/server/control/index.js) — each goes in through its seams:
//
// ── 1. THE MOD PATH OF THE INTERRUPT (§15.2 path 1; Q-B: mod → tty → hook) ──
// control.interrupt.addPath(fn, {probe}). fn answers null — so the tty or the
// hook path serves — unless the request is mode 'now' and the conversation's
// current session has a mod attached (bridge.attached). Then ONE op,
//   bridge.enqueue(sid, {op: 'abort', args: {}}, {deliverWithinMs: 1000,
//                                                 resultWithinMs: 1500})
// and the mod aborts ITS running turn, then TaskStops any foreground Bash the
// abort backgrounded (U88: result {aborted: true, stopped: [task ids]}):
//   ok                              → {via: 'mod', expires_at: now + 2000}
//   refused, delivered: false       → null (the mod never took it: tty or hook)
//   refused 'no-turn' or 'expired'  → null (the mod took it and did nothing)
//   any other delivered refusal,
//   'no-result' included            → still {via: 'mod', …}: NEVER a second
//                                     path on top — an Esc reaching a turn the
//                                     abort already ended can open Rewind, and
//                                     a halt flag would stop the NEXT turn.
// A remote request takes this path too (B2 (a): a remote Stop takes the mod
// abort or the hook, never the injection). The probe (bridge.attached on the
// conversation's session, mode-independent) makes the Stop frame's state view
// say 'Interrupt' (ruling F6, Q-B2 (a)). The stopped ids go to the daemon's log
// (ids only), where gate V43 reads them.
//
// ── 2. THE ROW 'task-stop' (§6.9 Ruled; Q7, Q-H) ────────────────────────────
// Kill, Cancel and Remove through the tray's stopper (public/app/mod-controls.js),
// whose confirm is this row's control frame:
//   fields ['task_id'], params {task_id} (TaskStop's id grammar, else a bad
//   target), key the task id, layouts ['confirm'], limit once per 1.5 s PER
//   TASK (notes-B decision 10: §15.5 names none, so the interrupt's).
//   describe → {title: 'Stop this task now', summary, lines: [kind · id]} —
//     never the task's title, which the model wrote (§6.9).
//   check → the row in mirror.tasks() by its id (else an agent row by the
//     tool_use id it had, as the queue route finds it): none or not running →
//     'not_running'; a provisional agent row (still keyed by its tool_use id)
//     → 'not_ready'; its conversation with no mod attached (bridge.sessionOf)
//     → 'no-mod'.
//   run → bridge.enqueue(sid, {op: 'taskStop', args: {task_id}}): ok →
//     mirror.markStopRequested(task_id), {ok: true, via: 'mod', said}; a
//     refusal → {ok: false, refused, hint}. Nothing here kills a process: the
//     row confirms from the [killed] footer or the agent's notification.
// POST /api/queue/task-stop (lib/server/routes/queue.js) is pane-callable and
// never reaches the mod (§6.9, Q-C): an immediate stop is a control action.
//
// ── 3. THE ROW 'resume' — experimental, off by default (§15.6; Q-E) ─────────
// "Fork here and switch the terminal": fork the conversation from before a
// turn and switch the user's own terminal into the fork, behind ONE confirm.
// Only with WEB_CHAT_REWIND_IN_PLACE=1, read ONCE at install (§11.1: it takes
// `claude-web-chat restart`), until gate V33 has recorded what a switch does to
// web-chat's own connection.
//   fields ['turn_id'], params {turn} | {turn_id} (as fork's), key the turn id,
//   layouts ['confirm'], limit {scope: 'project', ms: 5000} — its own bucket
//   (§15.5).
//   check → the flag off → 'off'; an unknown turn → 'unknown'; its conversation
//     has no mod attached → 'no-mod'; that conversation working, compacting,
//     asking or waiting (live.js's ACTIVE_STATES) → 'busy' (C-defaults (a),
//     Q-B8); then the fork's own anchor refusals (unknown, superseded, first)
//     through mirror.forkAnchor.
//   run → forkTurn(turn_id) (fork.js's own path: its argv, timeout, env scrub,
//     parse and its 'fork' event; ruling F6, Q-B4 (a)) → {ok, session_id} →
//     bridge.enqueue(sid, {op: 'command', args: {name: 'resume', args: <the
//     fork's id>}}, {resultWithinMs: 10000}) → then, C-defaults (a) (Q-B9), ONE
//     {op: 'fill', args: {text}} with the turn's prompt only when the mirror
//     holds it whole (no `truncated`) and unmasked (no redaction mark, no
//     withheld or partial-line mark: lib/core/redact's own spellings, through
//     MASK, WITHHELD and PARTIAL_LINE), and no longer than a fill takes;
//     otherwise no fill, and the answer's `said` says so. The fill goes to the
//     fork's session once the mod says hello for it, else the switched one,
//     waiting at most FILL_ATTACH_MS for the first.
//   One main-bus event per run, {kind: 'control', op: 'resume', id,
//   conversation_id, session_id (the switched session's), outcome: 'switched' |
//   'failed'} — content-free, like fork's. → {ok: true, via: 'mod', said,
//   filled}. A switch that failed after the fork names `claude --resume <id>`
//   in its hint, shown inside the frame only (the chrome never receives it,
//   B-confirm (4)).
//
// features() → {task_stop: {ok} | {ok: false, reason: 'no-mod'},
//               resume:    {ok} | {ok: false, reason: 'off' | 'no-mod'}}
// (U94a maps resume onto capabilities.rewind_in_place.)
//
// NOT HERE: a route (every action is a frame's, §15.5, C46); an Esc or a halt
// flag on top of a mod abort; a resume without the flag and a confirm; a model
// or effort control (Q10); a pid, a kill or a signal.

const crypto = require('crypto');
const { MASK, WITHHELD, PARTIAL_LINE } = require('../../core/redact');
const { isTaskId, ARG_TEXT_MAX } = require('../../core/mod-protocol');
const { isSafeId } = require('../../core/paths');
const { ACTIVE_STATES } = require('../mirror/live');
const { BadTarget } = require('./index');
const { HINTS: FORK_HINTS } = require('./fork');

const FLAG = 'WEB_CHAT_REWIND_IN_PLACE';
const ABORT_DELIVER_MS = 1000;
const ABORT_RESULT_MS = 1500;
const MOD_EXPIRY_MS = 2000;
const TASK_STOP_GAP_MS = 1500;
const RESUME_GAP_MS = 5000;
const RESUME_RESULT_MS = 10000;
const FILL_ATTACH_MS = 3000;
const FILL_DELIVER_MS = 3000;
const FILL_RESULT_MS = 3000;
// The interrupt's: a mod that took the abort and did nothing with it.
const ABORT_NOT_DONE = Object.freeze(['no-turn', 'expired']);
const LABEL_TAIL_RE = /^[A-Za-z0-9.: -]{1,48}$/;
const KIND_WORDS = Object.freeze({ shell: 'Shell', agent: 'Agent', workflow: 'Workflow', monitor: 'Monitor' });

const SAID = Object.freeze({
  stopping: 'Stopping — the row confirms when the task ends',
  switched: 'Switched — the terminal now runs the fork',
  filled: 'Switched — the terminal now runs the fork, your prompt back in its box',
  notWhole: 'Switched — the terminal now runs the fork. Your prompt was not refilled: part of it is hidden here',
  noPrompt: 'Switched — the terminal now runs the fork. There was no typed prompt to refill',
  fillFailed: 'Switched — the terminal now runs the fork. Your prompt could not be refilled',
});

const HINTS = Object.freeze({
  off: `set ${FLAG}=1 and run claude-web-chat restart`,
  noModTask: 'use Kill in the tray: the request goes to Claude',
  noModResume: 'no web-chat mod is attached to the terminal this conversation runs in',
  busy: 'Claude is working in that conversation: wait for the turn to end, or stop it first',
  notRunning: 'that task is not running any more (or was never seen) — nothing to stop',
  notReady: 'this agent has no task id yet — try again in a moment, or stop it in the terminal',
  unknownTurn: FORK_HINTS.unknown,
  noTranscripts: FORK_HINTS['no-transcripts'],
  noFork: 'the resume is not set up on this daemon',
});

// lib/core/redact's own marks, by its own builders (the conventions ratchet
// holds the mask's opening to redact.js): a prompt holding any is not whole.
const MARK_OPENINGS = Object.freeze([
  MASK('secret').split('secret')[0],
  WITHHELD('other').split('other')[0],
  PARTIAL_LINE,
]);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NODE_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
});

function installModControl(control, {
  bridge = null,
  mirror = null,
  forkTurn = null,
  bus = null,
  env = process.env,
  now = Date.now,
  log = () => {},
  timers = NODE_TIMERS,
} = {}) {
  if (!control || typeof control.action !== 'function') throw new TypeError('installModControl needs the control domain');
  const say = (m) => { try { log(m); } catch { /* a logger never breaks a control */ } };
  const inPlace = !!env && env[FLAG] === '1';
  const checked = new WeakMap(); // target → what check() resolved, for run()
  const waits = new Set(); // pending fill waits: {timer, off, resolve}
  let removed = false;

  const hasBridge = () => !!bridge && typeof bridge.enqueue === 'function';
  const anyMod = () => {
    if (!hasBridge() || typeof bridge.any !== 'function') return false;
    try { return bridge.any() === true; } catch { return false; }
  };
  const attachedSid = (sid) => {
    if (!hasBridge() || !isSafeId(sid) || typeof bridge.attached !== 'function') return false;
    try { return bridge.attached(sid) === true; } catch { return false; }
  };
  const modSessionOf = (cid) => {
    if (!hasBridge() || typeof cid !== 'string' || !cid || typeof bridge.sessionOf !== 'function') return null;
    let sid = null;
    try { sid = bridge.sessionOf(cid); } catch { sid = null; }
    return isSafeId(sid) ? sid : null;
  };

  function emit(event) {
    if (!bus || typeof bus.emit !== 'function') return;
    try { bus.emit({ event }); } catch (e) { say(`control: mod event failed (${(e && e.code) || 'error'})`); }
  }

  // The conversation, as the mirror's snapshot holds it.
  function conversation(cid) {
    if (!mirror || typeof mirror.snapshot !== 'function' || typeof cid !== 'string') return null;
    let snap = null;
    try { snap = mirror.snapshot({ level: 'local' }); } catch { return null; }
    const list = snap && Array.isArray(snap.conversations) ? snap.conversations : [];
    return list.find((c) => isPlain(c) && c.id === cid) || null;
  }
  const stateOf = (c) => (c && isPlain(c.live) && typeof c.live.state === 'string' ? c.live.state : null);

  // ── 1. the interrupt's mod path ───────────────────────────────────────────
  async function abortPath({ conversation: c, target } = {}) {
    if (removed || !isPlain(target) || target.mode !== 'now') return null;
    const sid = c && c.current_session_id;
    if (!attachedSid(sid)) return null;
    let r = null;
    try {
      r = await bridge.enqueue(sid, { op: 'abort', args: {} }, { deliverWithinMs: ABORT_DELIVER_MS, resultWithinMs: ABORT_RESULT_MS });
    } catch (e) { say(`control: mod abort failed (${(e && e.code) || 'error'})`); return null; }
    if (!isPlain(r)) return null;
    if (r.ok === true) {
      const stopped = isPlain(r.result) && Array.isArray(r.result.stopped) ? r.result.stopped.filter(isTaskId).slice(0, 16) : [];
      say(`control: mod abort ok (stopped ${stopped.length}${stopped.length ? `: ${stopped.join(' ')}` : ''})`);
      return { via: 'mod', expires_at: now() + MOD_EXPIRY_MS };
    }
    if (r.delivered !== true || ABORT_NOT_DONE.includes(r.refused)) {
      say(`control: mod abort not taken (${r.refused || 'refused'})`);
      return null;
    }
    // Taken, with no answer or a failure: the mod may have ended the turn, so
    // nothing else is sent on top.
    say(`control: mod abort unconfirmed (${r.refused || 'refused'})`);
    return { via: 'mod', expires_at: now() + MOD_EXPIRY_MS };
  }
  const abortProbe = (c) => (c && attachedSid(c.current_session_id) ? 'mod' : null);

  // ── 2. task-stop ──────────────────────────────────────────────────────────
  function taskRows() {
    if (!mirror || typeof mirror.tasks !== 'function') return [];
    try {
      const t = mirror.tasks();
      return t && Array.isArray(t.tasks) ? t.tasks.filter(isPlain) : [];
    } catch { return []; }
  }
  function findTask(id) {
    const rows = taskRows();
    return rows.find((r) => r.id === id) || rows.find((r) => r.kind === 'agent' && r.tool_use_id === id) || null;
  }

  function taskParams(q) {
    const s = isPlain(q) ? q : {};
    if (!isTaskId(s.task_id)) throw new BadTarget('task_id: the id TaskStop takes');
    return { task_id: s.task_id };
  }

  async function taskDescribe(target) {
    const row = findTask(target.task_id);
    const word = (row && KIND_WORDS[row.kind]) || 'Task';
    const id = row && isTaskId(row.id) ? row.id : target.task_id;
    return {
      title: 'Stop this task now',
      summary: 'Claude Code stops it with TaskStop, through the web-chat mod.',
      lines: [`${word} · ${id}`],
    };
  }

  async function taskCheck(target) {
    const row = findTask(target.task_id);
    if (!row || row.status !== 'running') return { refused: 'not_running', hint: HINTS.notRunning };
    if (row.kind === 'agent' && row.id === row.tool_use_id) return { refused: 'not_ready', hint: HINTS.notReady };
    if (!isTaskId(row.id)) return { refused: 'not_running', hint: HINTS.notRunning };
    const sid = modSessionOf(row.conversation_id);
    if (!sid) return { refused: 'no-mod', hint: HINTS.noModTask };
    checked.set(target, { task_id: row.id, sid });
    return null;
  }

  async function taskRun(target) {
    let c = checked.get(target);
    checked.delete(target);
    if (!c) {
      const r = await taskCheck(target);
      if (r) return { ok: false, ...r };
      c = checked.get(target);
      checked.delete(target);
    }
    let r = null;
    try { r = await bridge.enqueue(c.sid, { op: 'taskStop', args: { task_id: c.task_id } }); } catch { r = null; }
    if (!isPlain(r) || r.ok !== true) {
      const code = isPlain(r) && typeof r.refused === 'string' && r.refused ? r.refused : 'failed';
      const hint = isPlain(r) && typeof r.hint === 'string' && r.hint ? r.hint : `the mod did not stop it (${code}): use Kill in the tray, or stop it in the terminal`;
      return { ok: false, refused: code, hint };
    }
    try { if (mirror && typeof mirror.markStopRequested === 'function') mirror.markStopRequested(c.task_id); } catch (e) {
      say(`control: markStopRequested failed (${(e && e.code) || 'error'})`);
    }
    return { ok: true, via: 'mod', said: SAID.stopping };
  }

  const taskFeatures = () => (anyMod() ? { ok: true } : { ok: false, reason: 'no-mod' });

  // ── 3. resume (experimental) ──────────────────────────────────────────────
  function resumeParams(source) {
    const s = isPlain(source) ? source : {};
    const a = s.turn_id;
    const b = s.turn;
    if (a !== undefined && b !== undefined && a !== b) throw new BadTarget('turn and turn_id differ');
    const id = a !== undefined ? a : b;
    if (!isSafeId(id)) throw new BadTarget('turn: a turn id');
    return { turn_id: id };
  }

  async function turnOf(turnId) {
    if (!mirror || typeof mirror.turn !== 'function') return null;
    let r = null;
    try { r = await mirror.turn(turnId); } catch { r = null; }
    return isPlain(r) && isPlain(r.turn) ? r : null;
  }

  async function resumeDescribe(target) {
    const t = await turnOf(target.turn_id);
    const node = t && isPlain(t.turn.node) ? t.turn.node : null;
    const label = node && typeof node.label === 'string' && LABEL_TAIL_RE.test(node.label) ? node.label : null;
    return {
      title: 'Switch this terminal to the fork?',
      summary: `Fork this conversation from before ${label ? `turn ${label}` : 'this turn'} and switch the terminal it runs in to the fork. The current conversation is kept. Experimental.`,
    };
  }

  async function resumeCheck(target) {
    if (!inPlace) return { refused: 'off', hint: HINTS.off };
    if (typeof forkTurn !== 'function') return { refused: 'unavailable', hint: HINTS.noFork };
    const t = await turnOf(target.turn_id);
    if (!t) return { refused: 'unknown', hint: HINTS.unknownTurn };
    const cid = typeof t.turn.conversation_id === 'string' ? t.turn.conversation_id : null;
    const sid = modSessionOf(cid);
    if (!sid) return { refused: 'no-mod', hint: HINTS.noModResume };
    if (ACTIVE_STATES.includes(stateOf(conversation(cid)))) return { refused: 'busy', hint: HINTS.busy };
    if (!mirror || typeof mirror.forkAnchor !== 'function') return { refused: 'no-transcripts', hint: HINTS.noTranscripts };
    let anchor = null;
    try { anchor = await mirror.forkAnchor(target.turn_id); } catch { anchor = null; }
    if (!isPlain(anchor)) return { refused: 'unknown', hint: HINTS.unknownTurn };
    if (anchor.unavailable === true) return { refused: 'no-transcripts', hint: HINTS.noTranscripts };
    if (anchor.refused !== undefined) {
      const code = ['unknown', 'superseded', 'first'].includes(anchor.refused) ? anchor.refused : 'unknown';
      return { refused: code, hint: FORK_HINTS[code] };
    }
    checked.set(target, { cid, sid });
    return null;
  }

  // The prompt to refill, or why there is none: {text} | {why: SAID key}.
  function promptOf(t) {
    const items = t && Array.isArray(t.items) ? t.items : [];
    const p = items.find((it) => isPlain(it) && it.kind === 'prompt');
    if (!p || typeof p.text !== 'string' || !p.text.trim()) return { why: 'noPrompt' };
    if (p.truncated === true || p.text.length > ARG_TEXT_MAX) return { why: 'notWhole' };
    if (MARK_OPENINGS.some((m) => p.text.includes(m))) return { why: 'notWhole' };
    return { text: p.text };
  }

  // The session the fill goes to: the fork's once its mod says hello, else
  // the switched one while it is still attached; waits FILL_ATTACH_MS at most.
  function fillTarget(forkSid, sid) {
    if (attachedSid(forkSid)) return Promise.resolve(forkSid);
    if (attachedSid(sid)) return Promise.resolve(sid);
    if (removed || typeof bridge.onChange !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { timer: null, off: null, resolve: null };
      const finish = (v) => {
        if (!waits.has(w)) return;
        waits.delete(w);
        timers.clearTimeout(w.timer);
        try { if (w.off) w.off(); } catch { /* gone */ }
        resolve(v);
      };
      w.resolve = finish;
      waits.add(w);
      try {
        w.off = bridge.onChange((info) => {
          if (isPlain(info) && info.attached === true && typeof info.session_id === 'string'
            && info.session_id.toLowerCase() === String(forkSid).toLowerCase()) finish(forkSid);
        });
      } catch { w.off = null; }
      w.timer = timers.setTimeout(() => finish(null), FILL_ATTACH_MS);
    });
  }

  async function resumeRun(target) {
    let c = checked.get(target);
    checked.delete(target);
    if (!c) {
      const r = await resumeCheck(target);
      if (r) return { ok: false, ...r };
      c = checked.get(target);
      checked.delete(target);
    }
    const t0 = now();
    const id = `ri_${Math.max(0, Math.floor(t0)).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const done = (outcome) => emit({ kind: 'control', op: 'resume', id, conversation_id: c.cid, session_id: c.sid, outcome });

    let f = null;
    try { f = await forkTurn(target.turn_id); } catch { f = null; }
    if (!isPlain(f) || f.ok !== true || !isSafeId(f.session_id)) {
      done('failed');
      const refused = isPlain(f) && typeof f.refused === 'string' ? f.refused : 'fork-failed';
      const hint = isPlain(f) && typeof f.hint === 'string' ? f.hint : FORK_HINTS['fork-failed'];
      return { ok: false, refused, hint };
    }
    const forkSid = f.session_id;
    let r = null;
    try {
      r = await bridge.enqueue(c.sid, { op: 'command', args: { name: 'resume', args: forkSid } }, { resultWithinMs: RESUME_RESULT_MS });
    } catch { r = null; }
    if (!isPlain(r) || r.ok !== true) {
      done('failed');
      const why = isPlain(r) && typeof r.refused === 'string' ? r.refused : 'failed';
      say(`control: resume not switched (${why})`);
      return {
        ok: false,
        refused: 'switch-failed',
        hint: `the fork was made but the terminal did not switch (${why}): run claude --resume ${forkSid} in a terminal`,
      };
    }

    // C-defaults (a), Q-B9: refill only a whole, unmasked prompt.
    const p = promptOf(await turnOf(target.turn_id));
    let said = SAID.switched;
    let filled = false;
    if (p.text) {
      const to = await fillTarget(forkSid, c.sid);
      let fr = null;
      if (to) {
        try {
          fr = await bridge.enqueue(to, { op: 'fill', args: { text: p.text } }, { deliverWithinMs: FILL_DELIVER_MS, resultWithinMs: FILL_RESULT_MS });
        } catch { fr = null; }
      }
      filled = isPlain(fr) && fr.ok === true;
      said = filled ? SAID.filled : SAID.fillFailed;
    } else {
      said = SAID[p.why];
    }
    done('switched');
    return { ok: true, via: 'mod', said, filled };
  }

  function resumeFeatures() {
    if (!inPlace) return { ok: false, reason: 'off' };
    if (!anyMod()) return { ok: false, reason: 'no-mod' };
    return { ok: true };
  }

  // ── install ───────────────────────────────────────────────────────────────
  const offs = [];
  if (control.interrupt && typeof control.interrupt.addPath === 'function') {
    offs.push(control.interrupt.addPath(abortPath, { probe: abortProbe }));
  } else {
    say('control: no interrupt seam; the mod abort is off');
  }
  offs.push(control.action('task-stop', {
    fields: ['task_id'],
    layouts: ['confirm'],
    limit: { scope: 'conversation', ms: TASK_STOP_GAP_MS },
    params: taskParams,
    key: (target) => target.task_id,
    describe: taskDescribe,
    check: taskCheck,
    run: taskRun,
    features: taskFeatures,
  }));
  offs.push(control.action('resume', {
    fields: ['turn_id'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: RESUME_GAP_MS },
    params: resumeParams,
    key: (target) => target.turn_id,
    describe: resumeDescribe,
    check: resumeCheck,
    run: resumeRun,
    features: resumeFeatures,
  }));

  function features() {
    return { task_stop: taskFeatures(), resume: resumeFeatures() };
  }

  function unregister() {
    if (removed) return;
    removed = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
    for (const w of [...waits]) w.resolve(null);
  }

  return { features, unregister };
}

module.exports = {
  installModControl,
  FLAG, ABORT_DELIVER_MS, ABORT_RESULT_MS, MOD_EXPIRY_MS, TASK_STOP_GAP_MS, RESUME_GAP_MS, RESUME_RESULT_MS,
  FILL_ATTACH_MS, SAID, HINTS,
};
