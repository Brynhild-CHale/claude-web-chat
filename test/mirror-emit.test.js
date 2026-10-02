// The mirror's emission (lib/server/mirror/emit.js, spec §2.9): change
// collection over the model, the 100 ms flush on an injected clock and timers,
// the per-engine rev, the four frames and the compact ring events on the mirror
// bus, StatusRow's typed and content-free fields, index mode, the volume bound,
// a wall clock stepped back, and the reset a failed send owes. Unit tests over
// the real model, turn machine and change bus, wired the way createServer wires
// them (two buses, one broadcaster): no server, no files, no real timers.

const test = require('node:test');
const assert = require('node:assert');

const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine } = require('../lib/server/mirror/turn-machine');
const { createBus } = require('../lib/core/bus');
const {
  createEmitter, statusRowOf, aggregateOf, FLUSH_MS, STATES, WAITING_KINDS, AGGREGATE_ORDER, COUNT_KEYS, COUNT_MAX,
  STATUS_ROWS_MAX,
} = require('../lib/server/mirror/emit');

const C1 = '0b9e2c4a-1f3d-4e5a-9c7b-2d8f6a1e3b50';
const C2 = '7c1d5e8f-2a4b-4c6d-8e0f-1a2b3c4d5e6f';

// A manual clock: `advance(ms)` runs every timer that falls due within it, in
// order, with the clock set to each one's time first. With `skew`, every timer
// fires that many milliseconds early (but at least 1 ms out), as a Node timer
// armed against a stale loop time can. `stepWall(ms)` steps the wall clock
// (`now`) alone, as an NTP step or a clock set by hand does: the timers run on a
// monotonic clock of their own, as Node's do, and keep their times.
function manualClock({ start = 1_790_000_000_000, skew = 0 } = {}) {
  let t = start;
  let wall = 0;
  let n = 0;
  const pending = new Map();
  return {
    now: () => t + wall,
    stepWall(ms) { wall += ms; },
    setTimeout(fn, ms) {
      const handle = { n: ++n };
      pending.set(handle, { at: t + (skew ? Math.max(1, ms - skew) : Math.max(0, ms)), fn, n });
      return handle;
    },
    clearTimeout(handle) { pending.delete(handle); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [h, e] of pending) {
          if (e.at > end) continue;
          if (!next || e.at < next[1].at || (e.at === next[1].at && e.n < next[1].n)) next = [h, e];
        }
        if (!next) break;
        pending.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => pending.size,
  };
}

// The redaction point is the model's, and tested there: these tests need text
// to pass unchanged, so a frame can be searched for it.
const passRedactor = { text: (s) => s, value: (v) => v };

// createServer's wiring: the surface's bus and the mirror bus, each with its own
// ring, both broadcasting through the one WebSocket broadcaster.
function setup({ skew = 0 } = {}) {
  const clock = manualClock({ skew });
  const model = createModel({ redactor: passRedactor });
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const sent = [];
  const broadcast = (frame) => sent.push({ at: clock.now(), frame });
  mainBus.setBroadcaster(broadcast);
  mirrorBus.setBroadcaster(broadcast);
  const em = createEmitter({ model, bus: mirrorBus, now: clock.now, timers: clock });
  const tm = createTurnMachine({ model: em.model, now: clock.now, transition: em.transition });
  const frames = (type) => sent.filter((s) => s.frame.type === type).map((s) => s.frame);
  const ring = (op) => mirrorBus.events.filter((e) => !op || e.op === op);
  return { clock, model, mainBus, mirrorBus, sent, em, tm, frames, ring };
}

// Envelope v1, as the hooks post it (spec §1.3).
const prompt = (cid, pid, ts, text = 'go on') => ({ event: 'UserPromptSubmit', session_id: cid, prompt_id: pid, ts, prompt: { text } });
const pre = (cid, useId, ts, name = 'Bash', label = 'Bash · npm test') => ({
  event: 'PreToolUse', session_id: cid, ts, tool: { name, use_id: useId, kind: name, label, call: `${name}(…)` },
});
const post = (cid, useId, ts, ms = 5) => ({ event: 'PostToolUse', session_id: cid, ts, tool: { name: 'Bash', use_id: useId }, result: { ok: true, duration_ms: ms } });
const stop = (cid, ts, msg = 'Done.') => ({ event: 'Stop', session_id: cid, ts, stop: { last_assistant_message: msg } });

// live.js's write for a working conversation (spec §2.6).
function working(em, cid, at, step) {
  em.model.upsertLive(cid, { state: 'working', since: at, quiet: null, step, waiting: null, last_activity_at: at });
}

// The basic projection's types (spec §5.3), written out here as an independent
// oracle of what a StatusRow may hold.
const WORD = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const isWord = (v) => typeof v === 'string' && WORD.test(v) && !v.includes('__');
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isCounts = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 8
  && Object.entries(v).every(([k, n]) => isWord(k) && Number.isInteger(n) && n >= 0 && n <= 9999);
const ROW_TYPES = {
  id: isId, state: isWord, since: isNumber, quiet: (v) => typeof v === 'boolean', step_kind: isWord,
  waiting_kind: isWord, last_activity_at: isNumber, ended_reason: isWord, counts: isCounts,
};

function assertTypedRow(row) {
  for (const [k, v] of Object.entries(row)) {
    assert.ok(Object.hasOwn(ROW_TYPES, k), `a StatusRow has no field ${k}`);
    assert.ok(ROW_TYPES[k](v), `${k} must be typed, got ${JSON.stringify(v)}`);
  }
  for (const k of ['id', 'state', 'quiet', 'counts']) assert.ok(Object.hasOwn(row, k), `a StatusRow always has ${k}`);
  assert.ok(STATES.includes(row.state), `state ${row.state} is one of STATES`);
  assert.deepStrictEqual(Object.keys(row.counts), COUNT_KEYS);
  if (Object.hasOwn(row, 'waiting_kind')) assert.ok(WAITING_KINDS.includes(row.waiting_kind));
}

test('one flush sends at most one status frame, and one update, one stream frame and one ring event per conversation', () => {
  const { clock, em, tm, sent, ring } = setup();
  const t0 = clock.now();
  // Everything a busy 100 ms can hold, in two conversations at once: meta, live
  // state, a task, a turn and forty tool-call hooks each.
  for (const cid of [C1, C2]) {
    const tag = cid.slice(0, 4);
    em.model.upsertConversation(cid, { title: 'a session', headless: false });
    tm.ingest(cid, prompt(cid, `p-${tag}`, t0));
    working(em, cid, t0, { kind: 'Bash', tool: 'Bash', label: 'Bash · npm test', started_at: t0 });
    for (let i = 0; i < 20; i++) {
      tm.ingest(cid, pre(cid, `toolu_${tag}_${i}`, t0 + i));
      tm.ingest(cid, post(cid, `toolu_${tag}_${i}`, t0 + i + 1));
    }
    em.model.upsertTask({ id: `bg-${tag}`, conversation_id: cid, kind: 'shell', title: 'npm run dev', status: 'running', started_at: t0 });
  }
  assert.equal(sent.length, 0, 'nothing goes out before the flush');

  clock.advance(FLUSH_MS);
  const out = sent.map((s) => s.frame);
  assert.equal(out.filter((f) => f.type === 'mirror:status').length, 1, 'one status frame for the whole flush');
  for (const cid of [C1, C2]) {
    const mine = out.filter((f) => f.conversation_id === cid);
    assert.equal(mine.filter((f) => f.type === 'mirror:update').length, 1, `one update frame for ${cid}`);
    assert.equal(mine.filter((f) => f.type === 'mirror:stream').length, 1, `one stream frame for ${cid}`);
    assert.equal(ring('update').filter((e) => e.conversation_id === cid).length, 1, `one ring event for ${cid}`);
    const stream = mine.find((f) => f.type === 'mirror:stream');
    const ids = new Set(stream.items.map((it) => it.id));
    for (let i = 0; i < 20; i++) assert.ok(ids.has(`toolu_${cid.slice(0, 4)}_${i}`), 'every coalesced change rides the one frame');
  }
  assert.deepStrictEqual([...new Set(out.map((f) => f.rev))], [1], 'one flush, one rev');
  assert.equal(new Set(sent.map((s) => s.at)).size, 1, 'and one instant');

  // The ring event is compact and content-free: an id and three counts.
  const ev = ring('update').find((e) => e.conversation_id === C1);
  assert.deepStrictEqual(new Set(Object.keys(ev)), new Set(['seq', 'ts', 'kind', 'op', 'conversation_id', 'rev', 'items', 'turns', 'tasks']));
  assert.equal(ev.kind, 'mirror');
  for (const k of ['rev', 'items', 'turns', 'tasks']) assert.equal(typeof ev[k], 'number', k);
  assert.equal(ev.tasks, 1);
  assert.equal(ev.turns, 1);

  // Nothing more is pending: the next flush has nothing to say.
  assert.equal(clock.pending(), 0);
  assert.equal(em.flush(), null);
});

test('mirror:status goes out only when a row changed', () => {
  const { clock, em, tm, sent, frames } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'one session' });
  tm.ingest(C1, prompt(C1, 'p1', t0));
  working(em, C1, t0, { kind: 'Edit', tool: 'Edit', label: 'Edit · a.js', started_at: t0 });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 1, 'the conversation appeared');

  // A tool call is an item: the stream moves, the row does not.
  tm.ingest(C1, pre(C1, 'toolu_a', clock.now(), 'Edit', 'Edit · a.js'));
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:stream').length, 2);
  assert.equal(frames('mirror:status').length, 1, 'no status for an item');

  // The same kind of step on another file: the label is content, and only the
  // update frame (read and above) carries it.
  em.model.upsertLive(C1, { step: { kind: 'Edit', tool: 'Edit', label: 'Edit · b.js', started_at: t0 } });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:update').at(-1).live.step.label, 'Edit · b.js');
  assert.equal(frames('mirror:status').length, 1, 'no status for a label');

  // The same live state written again: nothing at all goes out.
  const before = sent.length;
  em.model.upsertLive(C1, { step: { kind: 'Edit', tool: 'Edit', label: 'Edit · b.js', started_at: t0 } });
  clock.advance(FLUSH_MS);
  assert.equal(sent.length, before, 'an unchanged live state sends nothing');

  // Another kind of step, a wait, a running task: each changes the row.
  em.model.upsertLive(C1, { step: { kind: 'Bash', tool: 'Bash', label: 'Bash · npm test', started_at: clock.now() } });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 2);
  assert.equal(frames('mirror:status')[1].conversations[0].step_kind, 'Bash');

  em.model.upsertLive(C1, { state: 'waiting', since: clock.now(), step: null,
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)', pending: false } });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 3);
  const waitRow = frames('mirror:status')[2].conversations[0];
  assert.equal(waitRow.state, 'waiting');
  assert.equal(waitRow.waiting_kind, 'permission');
  assert.ok(!('step_kind' in waitRow), 'a field with no value is left out');

  em.model.upsertTask({ id: 'bg1', conversation_id: C1, kind: 'shell', title: 'npm run dev', status: 'running', started_at: clock.now() });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 4);
  assert.deepStrictEqual(frames('mirror:status')[3].conversations[0].counts, { shells: 1, agents: 0, workflows: 0, monitors: 0 });

  // A second conversation's item does not resend the first one's row either.
  em.model.upsertConversation(C2, { title: 'two' });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 5, 'a new conversation is a new row');
  tm.ingest(C2, prompt(C2, 'p2', clock.now()));
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').length, 5, 'a turn and a prompt item change no row');
});

test('rev is monotonic per engine and per object, and only a flush that drained a change moves it', () => {
  const { clock, model, em, tm, sent } = setup();
  assert.equal(em.rev(), 0);
  assert.equal(em.flush(), null, 'nothing pending: nothing sent');
  assert.equal(em.rev(), 0, 'and no rev used');

  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'revs' });
  for (let turn = 0; turn < 3; turn++) {
    const pid = `p-rev-${turn}`;
    tm.ingest(C1, prompt(C1, pid, clock.now()));
    for (let i = 0; i < 12; i++) {
      const id = `toolu_rev_${turn}_${i}`;
      tm.ingest(C1, pre(C1, id, clock.now()));
      working(em, C1, t0, { kind: 'Bash', tool: 'Bash', label: `Bash · step ${i}`, started_at: clock.now() });
      clock.advance(30);
      tm.ingest(C1, post(C1, id, clock.now(), 30));
      clock.advance(25);
    }
    em.model.upsertTask({ id: `bg-${turn}`, conversation_id: C1, kind: 'shell', title: 'dev server', status: turn === 2 ? 'done' : 'running', started_at: t0 });
    tm.ingest(C1, stop(C1, clock.now()));
    clock.advance(FLUSH_MS * 3);
  }
  assert.ok(em.rev() >= 10, `several flushes ran (rev ${em.rev()})`);

  // Frames never go back in rev, and the frames of one flush share one rev and
  // one instant.
  let prev = 0;
  const revAt = new Map();
  for (const { at, frame } of sent) {
    assert.ok(frame.rev >= prev, 'frame revs never go back');
    prev = frame.rev;
    if (revAt.has(frame.rev)) assert.equal(revAt.get(frame.rev), at, `rev ${frame.rev} is one flush`);
    revAt.set(frame.rev, at);
  }
  assert.equal(prev, em.rev());

  // Every object a frame carries changed in that flush and carries its rev; an
  // object's rev only grows.
  const last = new Map();
  for (const { frame } of sent) {
    const objects = [];
    if (frame.conversation) objects.push(['c', frame.conversation]);
    if (frame.live) objects.push(['l', { ...frame.live, id: frame.conversation_id }]);
    for (const x of frame.tasks || []) objects.push(['k', x]);
    for (const x of frame.turns || []) objects.push(['t', x]);
    for (const x of frame.items || []) objects.push(['i', x]);
    for (const [kind, o] of objects) {
      const key = `${kind}:${o.id}`;
      assert.equal(o.rev, frame.rev, `${key} carries the rev of its frame`);
      if (last.has(key)) assert.ok(o.rev > last.get(key), `${key}'s rev grows`);
      last.set(key, o.rev);
    }
  }
  // The model, which the snapshot reads, agrees with the last frame on each.
  let checked = 0;
  for (const [key, r] of last) {
    const kind = key[0];
    const id = key.slice(2);
    if (kind === 't') { assert.equal(model.serializeTurn(id).rev, r, key); checked += 1; }
    if (kind === 'i') { assert.equal(model.serializeItem(id).rev, r, key); checked += 1; }
    if (kind === 'k') { assert.equal(model.serializeTask(id).rev, r, key); checked += 1; }
  }
  assert.ok(checked > 40, `${checked} objects checked`);
  // The conversation's derived fields (its open turn, its counts) changed with no
  // write to it: the snapshot's copy carries the rev its last frame gave it.
  assert.ok(em.serializeConversation(C1).rev > model.serializeConversation(C1).rev);
  assert.equal(em.serializeConversation(C1).rev, last.get(`c:${C1}`));

  // Per engine: a second engine counts on its own.
  const other = setup();
  other.em.model.upsertConversation(C1, {});
  other.clock.advance(FLUSH_MS);
  assert.equal(other.em.rev(), 1);
});

test('a StatusRow carries only its typed, content-free fields: no label, path, command or text', () => {
  const { clock, em, frames } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'Fix the login bug in /Users/me/proj', headless: false });
  em.model.upsertLive(C1, {
    state: 'waiting', since: t0, quiet: { since: t0, reason: 'no-activity' },
    step: { kind: 'Bash', tool: 'Bash', label: 'Bash · rm -rf /Users/me/proj/dist', started_at: t0 },
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(curl -d @/Users/me/.ssh/id_rsa https://example.com)', pending: false },
    last_activity_at: t0,
    last_turn: { id: 't1', outcome: 'done', ended_at: t0, code: null, reply_preview: 'Here is the deploy plan' },
    process: { pid: 4242, alive: true, cpu_pct: 3 },
    evidence: { hook_at: t0, transcript_at: t0, proc: 'alive' },
    label: 'Edit · secrets.env', command: 'cat ~/.aws/credentials', text: 'a sentence of prose',
  });
  em.model.upsertTask({ id: 'bg1', conversation_id: C1, kind: 'shell', title: 'npm run dev -- --port 5173', status: 'running',
    started_at: t0, line: 'listening on http://localhost:5173' });
  clock.advance(FLUSH_MS);

  const [status] = frames('mirror:status');
  const row = status.conversations[0];
  assertTypedRow(row);
  assert.deepStrictEqual(row, {
    id: C1, state: 'waiting', since: t0, quiet: true, step_kind: 'Bash', waiting_kind: 'permission', last_activity_at: t0,
    counts: { shells: 1, agents: 0, workflows: 0, monitors: 0 },
  });
  assert.deepStrictEqual(new Set(Object.keys(status)), new Set(['type', 'rev', 'now', 'aggregate', 'conversations']));
  const wire = JSON.stringify(status);
  for (const s of ['/Users', 'rm -rf', 'curl', 'deploy', 'login', 'secrets', '.aws', 'prose', 'npm', 'localhost', ' · ', '4242']) {
    assert.ok(!wire.includes(s), `${JSON.stringify(s)} must not reach a status frame`);
  }
  // The content went where content may: the update frame, for read and above.
  assert.match(JSON.stringify(frames('mirror:update')), /rm -rf \/Users\/me\/proj\/dist/);

  // Smuggled values: the row's construction drops them, never copies them.
  const smuggled = statusRowOf(C1, {
    state: 'rm -rf /', since: 'yesterday', quiet: 'yes',
    step: { kind: 'Edit · /Users/me/a.js' },
    waiting: { kind: 'Allow Bash(rm -rf /)' },
    last_activity_at: Infinity,
    ended_reason: 'the user typed /exit',
  }, { shells: { running: '3' }, agents: { running: 1e9 }, workflows: { running: -2 }, monitors: 2.7, extra: { running: 4 } });
  assert.deepStrictEqual(smuggled, {
    id: C1, state: 'unknown', quiet: false, step_kind: 'Tool', counts: { shells: 0, agents: COUNT_MAX, workflows: 0, monitors: 2 },
  });
  assert.equal(statusRowOf(C1, { state: 'waiting', waiting: { kind: 'Allow Bash(rm -rf /)' } }, {}).waiting_kind, 'other');
  assert.equal(statusRowOf(C1, { state: 'question', waiting: null }, {}).waiting_kind, 'question');
  assert.ok(!('waiting_kind' in statusRowOf(C1, { state: 'working', waiting: { kind: 'permission' } }, {})),
    'a wait not yet confirmed is not the row\'s');
  const ended = statusRowOf(C1, { state: 'ended', ended_reason: 'the user typed /exit', evidence: { proc: 'gone' } }, {});
  assert.equal(ended.ended_reason, 'process-gone');
  assert.equal(statusRowOf(C1, { state: 'ended', evidence: { proc: 'unknown' } }, {}).ended_reason, 'session-end');
  assert.equal(statusRowOf(C1, { state: 'ended', ended_reason: 'pid-reused' }, {}).ended_reason, 'pid-reused');
  assert.ok(!('ended_reason' in statusRowOf(C1, { state: 'idle', ended_reason: 'pid-reused' }, {})));

  // And for any live object at all, however hostile: a seeded sweep.
  let seed = 0x5eed;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const HOSTILE = [
    'Edit · /Users/me/proj/src/app.js', 'rm -rf /', '/Users/me/.ssh/id_rsa', 'curl https://example.com/x?token=abc',
    'mcp__github__create_issue', 'mcp__web-chat__render', 'the deploy key is in the notes', 'Bash(npm test)', '', '  ',
    'x'.repeat(5000), 'Edit', 'MCP', 'working', 'waiting', 'question', 'permission', 'plan', 'ended', 'gone', 'unknown',
    '__proto__', 'constructor', 'a.b', 'pid-reused', null, undefined, 42, -1, 1e12, NaN, Infinity, true, false, {}, [],
    { kind: 'Bash' }, { tool: 'mcp__x__y' }, ['Edit'],
  ];
  const pick = () => HOSTILE[Math.floor(rand() * HOSTILE.length)];
  const maybe = (v) => (rand() < 0.5 ? v : pick());
  let mcpSeen = 0;
  for (let i = 0; i < 500; i++) {
    const tool = pick();
    const live = {
      state: maybe(STATES[Math.floor(rand() * STATES.length)]), since: maybe(t0), quiet: pick(),
      step: rand() < 0.7 ? { kind: pick(), tool, label: pick() } : pick(),
      waiting: rand() < 0.7 ? { kind: maybe(WAITING_KINDS[Math.floor(rand() * WAITING_KINDS.length)]), summary: pick() } : pick(),
      last_activity_at: maybe(t0), ended_reason: pick(), evidence: rand() < 0.5 ? { proc: pick() } : pick(),
    };
    const counts = {};
    for (const k of COUNT_KEYS) counts[k] = rand() < 0.5 ? { running: pick() } : pick();
    const r = statusRowOf(C1, live, counts);
    assertTypedRow(r);
    const stepTool = live.step && typeof live.step === 'object' && !Array.isArray(live.step) ? live.step.tool : null;
    if (typeof stepTool === 'string' && stepTool.startsWith('mcp__')) {
      assert.equal(r.step_kind, 'MCP', `${stepTool} collapses to MCP`);
      mcpSeen += 1;
    }
  }
  assert.ok(mcpSeen > 20, `the sweep put an MCP tool in the step ${mcpSeen} times`);
});

test('a StatusRow passes the typed basic projection unchanged (lib/core/remote-policy projectValue)', (t) => {
  const policy = require('../lib/core/remote-policy');
  if (typeof policy.projectValue !== 'function') {
    t.skip('projectValue and FRAME_RULES land with U05 (wc085/remote-policy); this check runs once both are merged');
    return;
  }
  const rule = (type) => (policy.FRAME_RULES || []).find((r) => r && r.type === type);
  assert.ok(rule('mirror:status') && rule('mirror:status').basic, 'FRAME_RULES types mirror:status for basic viewers (spec §5.3)');
  assert.ok(rule('mirror:reset') && rule('mirror:reset').basic, 'and mirror:reset');
  for (const type of ['mirror:update', 'mirror:stream']) assert.ok(rule(type), `FRAME_RULES has a row for ${type}`);

  // Every shape a row takes: working on a tool, on an MCP tool, quiet, a
  // permission, a question, ended, with running tasks, and a headless one.
  const { clock, em, tm, frames } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'shapes' });
  em.model.upsertConversation(C2, { title: 'headless', headless: true });
  const shapes = [
    { state: 'working', since: t0, step: { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: t0 }, last_activity_at: t0 },
    { step: { kind: 'MCP', tool: 'mcp__github__create_issue', label: 'github · create_issue · login', started_at: t0 } },
    { quiet: { since: t0, reason: 'no-activity' } },
    { state: 'waiting', step: null, waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)' } },
    { state: 'question', waiting: { kind: 'question', tool: 'AskUserQuestion', summary: 'Keep the 56px rail?' } },
    { state: 'ended', waiting: null, quiet: null, evidence: { proc: 'gone' } },
  ];
  em.model.upsertTask({ id: 'bg1', conversation_id: C1, kind: 'monitor', title: 'tail', status: 'running', started_at: t0 });
  em.model.upsertLive(C2, { state: 'working', since: t0, last_activity_at: t0 });
  for (const s of shapes) {
    em.model.upsertLive(C1, { ...s, last_activity_at: clock.now() });
    clock.advance(FLUSH_MS);
  }
  tm.ingest(C1, prompt(C1, 'p-shapes', clock.now()));
  clock.advance(FLUSH_MS);
  // Both shapes of a reset: every conversation, and one (in separate flushes: a
  // reset of every conversation would cover the other).
  em.reset({ reason: 'disabled' });
  clock.advance(FLUSH_MS);
  em.beginIndex({ conversation_id: C2 })();
  clock.advance(FLUSH_MS);
  assert.ok(frames('mirror:status').length >= shapes.length);

  for (const f of frames('mirror:status')) {
    const { type, ...body } = f;
    assert.equal(type, 'mirror:status');
    assert.deepStrictEqual(policy.projectValue(rule('mirror:status').basic, body), body, 'a status frame passes unchanged');
    assert.deepStrictEqual(policy.projectFrame(f, 'basic', 'status'), f, 'and so does the frame a basic socket is sent');
    for (const row of f.conversations) assertTypedRow(row);
  }
  assert.equal(frames('mirror:reset').length, 2);
  for (const f of frames('mirror:reset')) assert.deepStrictEqual(policy.projectFrame(f, 'basic', 'status'), f, 'a reset passes unchanged');
  // The content frames never reach a basic socket, whatever its posture.
  for (const f of [...frames('mirror:update'), ...frames('mirror:stream')]) assert.equal(policy.projectFrame(f, 'basic', 'full'), null);
});

test('every MCP tool\'s step collapses to MCP', () => {
  for (const name of ['mcp__github__create_issue', 'mcp__web-chat__render', 'mcp__claude_ai_Gmail__send_email', 'mcp__x']) {
    const row = statusRowOf(C1, { state: 'working', step: { kind: 'MCP', tool: name, label: 'github · create_issue · fix the login bug' } }, {});
    assert.equal(row.step_kind, 'MCP', name);
  }
  // Even with only a kind, and the server's name in it.
  assert.equal(statusRowOf(C1, { state: 'working', step: { kind: 'mcp__github__create_issue' } }, {}).step_kind, 'MCP');
  // Tools that are not MCP keep the head word the tool table gives them.
  assert.equal(statusRowOf(C1, { state: 'working', step: { tool: 'MultiEdit' } }, {}).step_kind, 'Edit');
  assert.equal(statusRowOf(C1, { state: 'working', step: { kind: 'Reply' } }, {}).step_kind, 'Reply');
  assert.equal(statusRowOf(C1, { state: 'compacting', step: { kind: 'Compacting' } }, {}).step_kind, 'Compacting');

  // On the wire: a status frame never names the server or the tool.
  const { clock, em, tm, frames } = setup();
  const t0 = clock.now();
  tm.ingest(C1, prompt(C1, 'p-mcp', t0));
  tm.ingest(C1, pre(C1, 'toolu_mcp', t0, 'mcp__github__create_issue', 'github · create_issue · fix the login bug'));
  working(em, C1, t0, { kind: 'MCP', tool: 'mcp__github__create_issue', label: 'github · create_issue · fix the login bug', started_at: t0 });
  clock.advance(FLUSH_MS);
  const [status] = frames('mirror:status');
  assert.equal(status.conversations[0].step_kind, 'MCP');
  assert.ok(!/github|create_issue|login/.test(JSON.stringify(status)));
  assert.match(JSON.stringify(frames('mirror:stream')), /github/, 'the stream, for read and above, names it');
});

test('a catch-up in index mode sends no turn or item frames, then exactly one mirror:reset', () => {
  const { clock, em, tm, sent, ring } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'found late' });
  em.model.upsertConversation(C2, { title: 'live alongside' });
  clock.advance(FLUSH_MS);
  const mark = sent.length;

  const end = em.beginIndex({ conversation_id: C1 });
  // A long transcript found late: 120 turns, read in chunks over two seconds as
  // the tailer would, while the other conversation works live.
  const old = (n) => t0 - 10_000_000 + n * 10_000;
  for (let chunk = 0; chunk < 20; chunk++) {
    const changes = [];
    for (let k = 0; k < 6; k++) {
      const n = chunk * 6 + k;
      changes.push({ type: 'opener', prompt_id: `old-${n}`, kind: 'prompt', text: `old prompt ${n}`, ts: old(n), uuid: `u-o-${n}` });
      changes.push({ type: 'item', item: { id: `r_old_${n}`, kind: 'reply', text: `old reply ${n}` }, ts: old(n) + 10, uuid: `u-r-${n}` });
      changes.push({ type: 'turn-duration', duration_ms: 900, ts: old(n) + 20, uuid: `u-d-${n}` });
    }
    tm.applyChanges(C1, C1, changes);
    tm.ingest(C2, pre(C2, `toolu_c2_${chunk}`, clock.now()));
    em.model.upsertLive(C1, { state: 'idle', since: t0, last_activity_at: clock.now() });
    clock.advance(FLUSH_MS);
  }
  const during = sent.slice(mark).map((s) => s.frame);
  assert.equal(during.filter((f) => f.type === 'mirror:stream' && f.conversation_id === C1).length, 0,
    'no turn or item frame for the conversation catching up');
  assert.ok(during.filter((f) => f.type === 'mirror:stream' && f.conversation_id === C2).length >= 10, 'the other conversation streams on');
  assert.ok(during.some((f) => f.type === 'mirror:update' && f.conversation_id === C1 && f.live), 'its live state goes on');
  assert.ok(during.some((f) => f.type === 'mirror:status'), 'and so does the heartbeat');
  assert.equal(during.filter((f) => f.type === 'mirror:reset').length, 0, 'no reset while it runs');
  assert.ok(ring('update').some((e) => e.conversation_id === C1 && e.turns > 0), 'its changes were drained and counted');

  // A record read after the end but before the flush is covered by the reset too.
  end();
  end(); // idempotent
  tm.applyChanges(C1, C1, [{ type: 'opener', prompt_id: 'old-last', kind: 'prompt', text: 'the last one', ts: old(200), uuid: 'u-o-last' }]);
  clock.advance(FLUSH_MS);
  const after = sent.slice(mark).map((s) => s.frame);
  assert.deepStrictEqual(after.filter((f) => f.type === 'mirror:reset'), [{ type: 'mirror:reset', reason: 'catch-up', conversation_id: C1 }]);
  assert.equal(after.filter((f) => f.type === 'mirror:stream' && f.conversation_id === C1).length, 0);
  assert.equal(ring('reset').length, 1);
  assert.deepStrictEqual({ ...ring('reset')[0], seq: 0, ts: 0 }, { seq: 0, ts: 0, kind: 'mirror', op: 'reset', reason: 'catch-up', conversation_id: C1 });
  // The reset is the last thing its flush sends: after the changes it covers.
  assert.equal(sent.at(-1).frame.type, 'mirror:reset');

  // Live again: the next change streams as usual.
  tm.ingest(C1, prompt(C1, 'new-1', clock.now(), 'now live'));
  clock.advance(FLUSH_MS);
  const streams = sent.slice(mark).filter((s) => s.frame.type === 'mirror:stream' && s.frame.conversation_id === C1);
  assert.equal(streams.length, 1);
  assert.ok(streams[0].frame.items.some((it) => it.id === 'p_new-1'));
  assert.equal(sent.slice(mark).filter((s) => s.frame.type === 'mirror:reset').length, 1, 'and no second reset');
});

test('index mode nests, and a catch-up of every conversation ends in one reset with no conversation id', () => {
  const { clock, em, tm, sent, ring } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, {});
  em.model.upsertConversation(C2, {});
  clock.advance(FLUSH_MS);
  const mark = sent.length;
  const streams = () => sent.slice(mark).filter((s) => s.frame.type === 'mirror:stream').length;
  const resets = () => sent.slice(mark).filter((s) => s.frame.type === 'mirror:reset').map((s) => s.frame);

  // Boot: everything is caught up at once, and one conversation's own catch-up
  // runs inside it.
  const all = em.beginIndex();
  const one = em.beginIndex({ conversation_id: C1 });
  for (let i = 0; i < 5; i++) {
    tm.ingest(C1, pre(C1, `toolu_b1_${i}`, t0 + i));
    tm.ingest(C2, pre(C2, `toolu_b2_${i}`, t0 + i));
    clock.advance(FLUSH_MS);
  }
  one();
  clock.advance(FLUSH_MS);
  assert.equal(streams(), 0, 'no stream frame for anyone while everything catches up');
  assert.deepStrictEqual(resets(), [], 'the inner end waits for the outer one, which covers it');
  tm.ingest(C2, pre(C2, 'toolu_b2_last', clock.now()));
  all();
  clock.advance(FLUSH_MS);
  assert.deepStrictEqual(resets(), [{ type: 'mirror:reset', reason: 'catch-up' }], 'one reset, for every conversation');
  assert.equal(streams(), 0);
  assert.equal(ring('reset').length, 1);
  assert.ok(!('conversation_id' in ring('reset')[0]));

  // The same scope twice: one reset, at the outermost end.
  const a = em.beginIndex({ conversation_id: C2, reason: 'catch-up' });
  const b = em.beginIndex({ conversation_id: C2 });
  tm.ingest(C2, pre(C2, 'toolu_n1', clock.now()));
  a();
  clock.advance(FLUSH_MS);
  assert.equal(resets().length, 1, 'still inside the second');
  b();
  clock.advance(FLUSH_MS);
  assert.deepStrictEqual(resets().at(-1), { type: 'mirror:reset', reason: 'catch-up', conversation_id: C2 });
  assert.equal(resets().length, 2);

  // A catch-up that ends and begins again before the flush owes one reset, when
  // the second one ends.
  const c = em.beginIndex({ conversation_id: C1 });
  c();
  const d = em.beginIndex({ conversation_id: C1 });
  tm.ingest(C1, pre(C1, 'toolu_r1', clock.now()));
  clock.advance(FLUSH_MS);
  assert.equal(resets().length, 2);
  d();
  clock.advance(FLUSH_MS);
  assert.equal(resets().length, 3);
  assert.equal(streams(), 0, 'every change since the catch-ups began is covered by a reset');

  // A malformed id is refused, not taken for everything.
  const before = em.stats().indexing;
  em.beginIndex({ conversation_id: 'not an id / with spaces' })();
  assert.equal(em.stats().indexing, before);
});

test('reset() goes out at the next flush, after the changes it covers and in place of their stream', () => {
  const { clock, em, tm, sent, frames } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'switching off' });
  tm.ingest(C1, prompt(C1, 'p1', t0));
  assert.equal(em.reset({ reason: 'disabled' }), true);
  assert.equal(sent.length, 0, 'deferred to the flush');
  clock.advance(FLUSH_MS);
  assert.deepStrictEqual(sent.at(-1).frame, { type: 'mirror:reset', reason: 'disabled' });
  assert.equal(frames('mirror:stream').length, 0, 'the reset stands for the stream it covers');
  assert.equal(frames('mirror:update').length, 1, 'the update still went out before it');

  // The reason is one lowercase word, whatever is passed; an id must be an id.
  em.reset({ reason: 'Not a word! /Users/me', conversation_id: C1 });
  em.reset({ reason: 'catch-up', conversation_id: C1 }); // the latest reason wins
  clock.advance(FLUSH_MS);
  assert.deepStrictEqual(sent.at(-1).frame, { type: 'mirror:reset', reason: 'catch-up', conversation_id: C1 });
  em.reset({ reason: 'Not a word! /Users/me' });
  clock.advance(FLUSH_MS);
  assert.deepStrictEqual(sent.at(-1).frame, { type: 'mirror:reset', reason: 'reset' });
  assert.equal(em.reset({ conversation_id: 'two words' }), false);
  assert.equal(em.reset({ conversation_id: 42 }), false);
});

// A broadcaster that throws on the frames `fails(frame)` picks, as many times as
// `times` says, and hands every other frame to the setup's record.
function flakyBroadcaster({ clock, mirrorBus, sent }, fails, times = 1) {
  const left = { n: times };
  mirrorBus.setBroadcaster((frame) => {
    if (left.n > 0 && fails(frame)) { left.n -= 1; throw new Error('a socket went away'); }
    sent.push({ at: clock.now(), frame });
  });
  return left;
}

test('frames that fail to go out make a mirror:reset due in the same flush, so the chrome refetches what they carried', () => {
  const s = setup();
  const { clock, em, tm, sent, ring } = s;
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'flaky' });
  em.model.upsertConversation(C2, { title: 'steady' });
  tm.ingest(C1, prompt(C1, 'p1', t0));
  tm.ingest(C2, prompt(C2, 'p2', t0));
  clock.advance(FLUSH_MS);
  const mark = sent.length;

  // The broadcaster throws once, on C1's frames: its turn closing, which no
  // later delta would bring back. The drain has already spent those changes.
  const left = flakyBroadcaster(s, (f) => f.conversation_id === C1 && f.type !== 'mirror:reset');
  tm.ingest(C1, stop(C1, clock.now()));
  tm.ingest(C2, pre(C2, 'toolu_c2', clock.now()));
  clock.advance(FLUSH_MS);
  const out = sent.slice(mark).map((x) => x.frame);
  assert.equal(left.n, 0, 'the broadcaster threw');
  assert.equal(out.filter((f) => f.conversation_id === C1 && f.type !== 'mirror:reset').length, 0, 'C1\'s frames were lost');
  assert.deepStrictEqual(out.filter((f) => f.type === 'mirror:reset'), [{ type: 'mirror:reset', reason: 'error', conversation_id: C1 }],
    'one reset for what they carried');
  assert.equal(out.at(-1).type, 'mirror:reset', 'at the end of the same flush');
  assert.ok(out.some((f) => f.type === 'mirror:stream' && f.conversation_id === C2), 'the other conversation streams on');
  assert.deepStrictEqual(ring('reset').map((e) => [e.reason, e.conversation_id]), [['error', C1]]);
  assert.equal(em.stats().errors, 1);
  assert.equal(em.stats().resets_due, 0);

  // The next change streams as usual, with no second reset.
  tm.ingest(C1, prompt(C1, 'p3', clock.now()));
  clock.advance(FLUSH_MS);
  const after = sent.slice(mark).map((x) => x.frame);
  assert.ok(after.some((f) => f.type === 'mirror:stream' && f.conversation_id === C1 && (f.items || []).some((it) => it.id === 'p_p3')));
  assert.equal(after.filter((f) => f.type === 'mirror:reset').length, 1);
});

test('a frame that fails to be built makes a reset due too, and the log names the error\'s kind, never its text', () => {
  const clock = manualClock();
  const model = createModel({ redactor: passRedactor });
  const boom = { n: 0 };
  const flaky = {
    ...model,
    serializeTurn(...args) {
      if (boom.n > 0) { boom.n -= 1; throw new TypeError('a turn about /Users/me/secret-project'); }
      return model.serializeTurn(...args);
    },
  };
  const bus = createBus({ maxEvents: 2000 });
  const sent = [];
  bus.setBroadcaster((frame) => sent.push(frame));
  const logs = [];
  const em = createEmitter({ model: flaky, bus, now: clock.now, timers: clock, log: (m) => logs.push(m) });
  const tm = createTurnMachine({ model: em.model, now: clock.now, transition: em.transition });
  tm.ingest(C1, prompt(C1, 'p1', clock.now()));
  clock.advance(FLUSH_MS);
  const mark = sent.length;

  // Armed after the ingest: the turn machine reads the turn too, and only the
  // flush's read should meet the fault.
  tm.ingest(C1, stop(C1, clock.now()));
  boom.n = 1;
  clock.advance(FLUSH_MS);
  const out = sent.slice(mark);
  assert.equal(boom.n, 0, 'the framing threw');
  assert.equal(out.filter((f) => f.type === 'mirror:stream').length, 0);
  assert.deepStrictEqual(out.filter((f) => f.type === 'mirror:reset'), [{ type: 'mirror:reset', reason: 'error', conversation_id: C1 }]);
  assert.equal(em.stats().errors, 1);
  assert.match(logs.join('\n'), /frame failed \(TypeError\)/);
  assert.ok(!logs.join('\n').includes('secret-project'), 'an error\'s message could quote what it was handling');
});

test('a status frame that fails makes a reset due for every conversation; a reset that fails stays due for the next flush', () => {
  const s = setup();
  const { clock, em, tm, sent } = s;
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'one' });
  em.model.upsertConversation(C2, { title: 'two' });
  working(em, C1, t0, { kind: 'Edit', tool: 'Edit', label: 'Edit · a.js', started_at: t0 });
  tm.ingest(C2, prompt(C2, 'p2', t0));
  clock.advance(FLUSH_MS);
  let mark = sent.length;

  // The status carries every conversation's row: losing it loses them all.
  flakyBroadcaster(s, (f) => f.type === 'mirror:status');
  em.model.upsertLive(C1, { state: 'waiting', since: clock.now(), step: null,
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)', pending: false } });
  tm.ingest(C2, pre(C2, 'toolu_c2', clock.now()));
  clock.advance(FLUSH_MS);
  let out = sent.slice(mark).map((x) => x.frame);
  assert.equal(out.filter((f) => f.type === 'mirror:status').length, 0, 'the status was lost');
  assert.deepStrictEqual(out.filter((f) => f.type === 'mirror:reset'), [{ type: 'mirror:reset', reason: 'error' }],
    'one reset, with no conversation id');
  assert.equal(out.filter((f) => f.type === 'mirror:stream').length, 0, 'the reset stands for the stream of its flush');
  assert.equal(out.at(-1).type, 'mirror:reset');

  // The broadcaster down for a whole flush: the reset owed for it cannot go out
  // either. It stays due, with no timer spinning on it, and goes out with the
  // next flush, in place of the stream it covers.
  mark = sent.length;
  const left = flakyBroadcaster(s, () => true, Infinity);
  tm.ingest(C2, post(C2, 'toolu_c2', clock.now()));
  clock.advance(FLUSH_MS);
  assert.equal(sent.length, mark, 'nothing went out');
  assert.equal(em.stats().resets_due, 1, 'the reset stays due');
  assert.equal(clock.pending(), 0, 'and nothing spins on it');
  clock.advance(10 * FLUSH_MS);
  assert.equal(sent.length, mark);

  left.n = 0; // the broadcaster is back
  tm.ingest(C2, pre(C2, 'toolu_c2_next', clock.now()));
  clock.advance(FLUSH_MS);
  out = sent.slice(mark).map((x) => x.frame);
  assert.deepStrictEqual(out.filter((f) => f.type === 'mirror:reset'), [{ type: 'mirror:reset', reason: 'error', conversation_id: C2 }]);
  assert.equal(out.filter((f) => f.type === 'mirror:stream').length, 0);
  assert.equal(em.stats().resets_due, 0);

  // Then the stream carries on as usual.
  tm.ingest(C2, post(C2, 'toolu_c2_next', clock.now()));
  clock.advance(FLUSH_MS);
  assert.equal(sent.at(-1).frame.type, 'mirror:stream');
  assert.equal(sent.slice(mark).filter((x) => x.frame.type === 'mirror:reset').length, 1);
});

test('a burst of 300 tool calls yields at most ten stream frames a second, and loses none of them', () => {
  // On time, and with timers that fire early: the bound is the engine's clock's,
  // not the timer's promise.
  for (const skew of [0, 30, 99]) {
    const { clock, em, tm, sent, ring } = setup({ skew });
    const t0 = clock.now();
    em.model.upsertConversation(C1, { title: 'burst' });
    tm.ingest(C1, prompt(C1, 'p-burst', t0));
    // 300 calls in three seconds: every hook a separate write, as the tap delivers them.
    for (let i = 0; i < 300; i++) {
      const id = `toolu_burst_${i}`;
      const name = ['Read', 'Edit', 'Bash', 'Grep'][i % 4];
      tm.ingest(C1, pre(C1, id, clock.now(), name, `${name} · file${i}.js`));
      working(em, C1, t0, { kind: name, tool: name, label: `${name} · file${i}.js`, started_at: clock.now() });
      clock.advance(3);
      tm.ingest(C1, post(C1, id, clock.now(), 3));
      em.model.upsertLive(C1, { step: null, last_activity_at: clock.now() });
      clock.advance(7);
    }
    tm.ingest(C1, stop(C1, clock.now()));
    clock.advance(FLUSH_MS * 2);

    const streams = sent.filter((s) => s.frame.type === 'mirror:stream');
    for (const s of streams) {
      const inSecond = streams.filter((x) => x.at >= s.at && x.at < s.at + 1000).length;
      assert.ok(inSecond <= 10, `skew ${skew}: ${inSecond} stream frames in the second from ${s.at - t0} ms`);
    }
    for (let i = 1; i < streams.length; i++) {
      assert.ok(streams[i].at - streams[i - 1].at >= FLUSH_MS, `skew ${skew}: flushes are FLUSH_MS apart at least`);
    }
    // Frames kept flowing through the burst (about one per 100 ms), not 600 of them.
    assert.ok(streams.length >= 25 && streams.length <= 35, `skew ${skew}: ${streams.length} stream frames for 300 calls`);
    for (const type of ['mirror:update', 'mirror:status']) {
      assert.ok(sent.filter((s) => s.frame.type === type).length <= streams.length + 1, `${type} is bounded by the flushes too`);
    }
    assert.ok(ring('update').length <= streams.length + 1, 'and so is the ring');

    // Nothing was lost to coalescing: each call's last word in the stream is its end.
    const last = new Map();
    for (const s of streams) for (const it of s.frame.items || []) last.set(it.id, it);
    for (let i = 0; i < 300; i++) assert.equal(last.get(`toolu_burst_${i}`).status, 'done', `skew ${skew}: toolu_burst_${i}`);
    const turns = streams.flatMap((s) => s.frame.turns || []).filter((x) => x.id === 'p-burst');
    assert.equal(turns.at(-1).status, 'done');
    assert.equal(turns.at(-1).counts.tools, 300);
    assert.equal(clock.pending(), 0, 'and nothing is left armed');
  }
});

test('a wall clock stepped back holds no frame back: the next write goes out within FLUSH_MS', () => {
  // On time, and with timers that fire early. Only the wall clock steps: the
  // timers run on a monotonic clock of their own, as Node's do.
  for (const skew of [0, 30, 99]) {
    const { clock, em, tm, sent, frames } = setup({ skew });
    const t0 = clock.now();
    em.model.upsertConversation(C1, { title: 'clock' });
    tm.ingest(C1, prompt(C1, 'p-clock', t0));
    working(em, C1, t0, { kind: 'Bash', tool: 'Bash', label: 'Bash · npm test', started_at: t0 });
    clock.advance(FLUSH_MS);
    assert.equal(frames('mirror:status').at(-1).conversations[0].state, 'working');

    // Right after that flush an NTP step puts the wall clock back a minute, and
    // Claude stops on a permission prompt. The bar must say so now, not a
    // minute from now.
    clock.stepWall(-60_000);
    const mark = sent.length;
    em.model.upsertLive(C1, { state: 'waiting', since: clock.now(), step: null,
      waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)', pending: false } });
    clock.advance(FLUSH_MS);
    const out = sent.slice(mark).map((s) => s.frame);
    const status = out.find((f) => f.type === 'mirror:status');
    assert.ok(status, `skew ${skew}: the status went out within FLUSH_MS of the write`);
    assert.equal(status.conversations[0].state, 'waiting');
    assert.equal(status.conversations[0].waiting_kind, 'permission');
    assert.ok(out.some((f) => f.type === 'mirror:update' && f.live && f.live.state === 'waiting'), `skew ${skew}: and so did the live state`);

    // And the mirror keeps its pace on the clock it now reads: five seconds of
    // tool calls, about one frame per FLUSH_MS, none held back and none closer
    // together than FLUSH_MS.
    const mark2 = sent.length;
    for (let i = 0; i < 50; i++) {
      tm.ingest(C1, pre(C1, `toolu_clock_${i}`, clock.now()));
      clock.advance(FLUSH_MS);
    }
    const streams = sent.slice(mark2).filter((s) => s.frame.type === 'mirror:stream');
    assert.ok(streams.length >= 45, `skew ${skew}: ${streams.length} stream frames in five seconds`);
    for (let i = 1; i < streams.length; i++) {
      assert.ok(streams[i].at - streams[i - 1].at >= FLUSH_MS, `skew ${skew}: flushes are FLUSH_MS apart again`);
    }
    const seen = new Set(streams.flatMap((s) => (s.frame.items || []).map((it) => it.id)));
    for (let i = 0; i < 50; i++) assert.ok(seen.has(`toolu_clock_${i}`), `skew ${skew}: toolu_clock_${i} went out`);
    assert.equal(clock.pending(), 0, 'and nothing is left armed');
  }
});

test('nothing the emitter sends lands in the main bus\'s ring', () => {
  const { clock, mainBus, mirrorBus, em, tm, sent } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { title: 'volume' });
  const end = em.beginIndex({ conversation_id: C2 });
  for (let i = 0; i < 150; i++) {
    tm.ingest(C1, pre(C1, `toolu_v_${i}`, clock.now()));
    tm.ingest(C1, post(C1, `toolu_v_${i}`, clock.now() + 1));
    tm.applyChanges(C2, C2, [{ type: 'opener', prompt_id: `cu-${i}`, kind: 'prompt', text: 'old', ts: t0 - 1e7 + i * 1000, uuid: `cu-u-${i}` }]);
    working(em, C1, t0, { kind: 'Bash', tool: 'Bash', label: 'Bash · make', started_at: clock.now() });
    clock.advance(9);
  }
  end();
  em.reset({ reason: 'disabled' });
  em.transition({ kind: 'mirror', op: 'state', conversation_id: C1, state: 'idle', prev: 'working' });
  clock.advance(FLUSH_MS * 2);

  assert.ok(sent.length > 20, 'the frames reached the one broadcaster');
  assert.equal(mainBus.events.length, 0, 'the main ring holds none of it');
  assert.equal(mainBus.read({ since: 0 }).latest, 0);
  assert.ok(mirrorBus.events.length > 20, 'the mirror ring holds it all');
  for (const e of mirrorBus.events) assert.equal(e.kind, 'mirror');
  for (const op of ['update', 'reset', 'turn-open', 'state']) assert.ok(mirrorBus.events.some((e) => e.op === op), `${op} is on the mirror ring`);
});

test('transitions go on the mirror ring at once, compact and content-free, with no frame', () => {
  const { clock, em, tm, sent, ring } = setup();
  tm.ingest(C1, prompt(C1, 'p1', clock.now()));
  assert.deepStrictEqual(ring().map((e) => e.op), ['turn-open'], 'the turn machine\'s transition is on the ring before any flush');
  assert.equal(sent.length, 0, 'and sends no frame');

  const e = em.transition({
    kind: 'surface', op: 'state', conversation_id: C1, session_id: C1, pid: 4242, state: 'waiting', prev: 'working',
    waiting_kind: 'permission', ask_id: 'ask_0123456789ab', at: clock.now(), stale: false, why: null,
    label: 'Bash · rm -rf /Users/me', summary: 'Allow Bash(rm -rf dist)?', live: { state: 'x' }, seq: 1,
    session_ids: [C1, 'not an id/../x', 7, { a: 1 }], 'two words': 'x',
  });
  assert.equal(e.kind, 'mirror');
  assert.equal(e.op, 'state');
  for (const k of ['label', 'summary', 'live', 'two words']) assert.ok(!(k in e), `${k} is dropped`);
  assert.notEqual(e.seq, 1, 'the ring owns seq');
  assert.deepStrictEqual(e.session_ids, [C1, 7]);
  for (const [k, v] of Object.entries({ conversation_id: C1, pid: 4242, state: 'waiting', prev: 'working', waiting_kind: 'permission',
    ask_id: 'ask_0123456789ab', stale: false, why: null })) assert.deepStrictEqual(e[k], v, k);
  assert.equal(ring().at(-1), e);
  assert.equal(sent.length, 0, 'a transition is ring-only');
  assert.ok(em.stats().dropped >= 5);

  assert.equal(em.transition({ op: 'turn closed', conversation_id: C1 }), null, 'an op that is not a token sends nothing');
  assert.equal(em.transition('turn-closed'), null);
  assert.equal(em.transition(null), null);
  assert.equal(ring().length, 2);
});

test('the model writers are handed arms the flush on a write, never on a read, and has no drain', () => {
  const { clock, model, em, tm } = setup();
  assert.equal(em.model.takeChanges, undefined, 'the drain is the emitter\'s alone');
  em.model.conversations();
  em.model.turn('nope');
  em.model.serializeConversation(C1);
  em.model.taskCounts(C1);
  em.model.stats();
  assert.equal(clock.pending(), 0, 'reads arm nothing');

  em.model.upsertConversation(C1, { title: 'armed' });
  assert.equal(clock.pending(), 1);
  em.model.upsertLive(C1, { state: 'idle' });
  em.model.upsertTask({ id: 'bg', conversation_id: C1, kind: 'shell', title: 't', status: 'running' });
  assert.equal(clock.pending(), 1, 'one timer for any number of writes');
  clock.advance(FLUSH_MS);
  assert.equal(clock.pending(), 0, 'an idle mirror holds no timer');

  // The turn machine's claimed writer arms it too.
  tm.ingest(C1, prompt(C1, 'p1', clock.now()));
  clock.advance(FLUSH_MS);
  assert.equal(clock.pending(), 0);
  tm.closeTurn(C1, 'p1', { outcome: 'done', by: 'stop' });
  assert.equal(clock.pending(), 1, 'a lifecycle write arms the flush');
  clock.advance(FLUSH_MS);

  // A write that bypasses the tracked model waits for schedule().
  model.upsertConversation(C1, { title: 'raw' });
  assert.equal(clock.pending(), 0);
  em.schedule();
  em.schedule();
  assert.equal(clock.pending(), 1);
  clock.advance(FLUSH_MS);
  assert.equal(em.stats().pending, false);
});

test('a removed conversation goes out as removed, with what it merged into, and leaves the status', () => {
  const { clock, em, sent, frames } = setup();
  const t0 = clock.now();
  for (const cid of [C1, C2]) {
    em.model.upsertConversation(cid, { title: 'x' });
    em.model.upsertLive(cid, { state: 'idle', since: t0, last_activity_at: t0 });
  }
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').at(-1).conversations.length, 2);

  em.model.removeConversation(C2, { merged_into: C1 });
  clock.advance(FLUSH_MS);
  const removed = frames('mirror:update').at(-1);
  assert.deepStrictEqual({ ...removed, rev: 0, now: 0 }, { type: 'mirror:update', rev: 0, now: 0, conversation_id: C2, removed: true, merged_into: C1 });
  assert.deepStrictEqual(frames('mirror:status').at(-1).conversations.map((r) => r.id), [C1]);

  // Removed and back between two flushes: no delta can say so, so a reset does.
  const mark = sent.length;
  em.model.removeConversation(C1);
  em.model.upsertConversation(C1, { title: 'back' });
  em.model.upsertLive(C1, { state: 'working', since: clock.now(), last_activity_at: clock.now() });
  clock.advance(FLUSH_MS);
  const out = sent.slice(mark).map((s) => s.frame);
  assert.ok(out.some((f) => f.type === 'mirror:update' && f.conversation && f.conversation.title === 'back'));
  assert.deepStrictEqual(out.at(-1), { type: 'mirror:reset', reason: 'rebuilt', conversation_id: C1 });
});

test('the status frame carries at most 32 rows: live and interactive first, the most recent first', () => {
  const { clock, em, frames } = setup();
  const t0 = clock.now();
  // 40 conversations: five ended, four headless, 32 live and interactive.
  for (let i = 0; i < 40; i++) {
    const cid = `conv-${i}`;
    em.model.upsertConversation(cid, { headless: i % 10 === 0 });
    em.model.upsertLive(cid, { state: i < 5 ? 'ended' : 'idle', since: t0, last_activity_at: t0 + i, evidence: { proc: 'gone' } });
  }
  clock.advance(FLUSH_MS);
  const { conversations, aggregate } = frames('mirror:status').at(-1);
  assert.equal(conversations.length, STATUS_ROWS_MAX);
  const expected = [];
  for (let i = 39; i >= 5; i--) if (i % 10 !== 0) expected.push(`conv-${i}`);
  assert.deepStrictEqual(conversations.map((r) => r.id), expected);
  assert.equal(aggregate.state, 'idle');
  assert.equal(em.status().conversations.length, STATUS_ROWS_MAX, 'the route serves the same rows');
});

test('the aggregate is the most urgent state among the interactive conversations', () => {
  const e = (state, headless = false) => ({ row: { id: 'x', state }, headless });
  assert.equal(aggregateOf([]), 'none');
  assert.equal(aggregateOf([e('idle'), e('working'), e('ended')]), 'working');
  assert.equal(aggregateOf([e('working'), e('question')]), 'question');
  assert.equal(aggregateOf([e('question'), e('waiting')]), 'waiting');
  assert.equal(aggregateOf([e('suspended'), e('idle'), e('unknown')]), 'suspended');
  assert.equal(aggregateOf([e('idle'), e('waiting', true)]), 'idle', 'a headless session never speaks for the project');
  assert.equal(aggregateOf([e('working', true)]), 'none');
  assert.deepStrictEqual([...AGGREGATE_ORDER].sort(), [...STATES].sort(), 'every state has its rank');

  const { clock, em, frames } = setup();
  const t0 = clock.now();
  em.model.upsertConversation(C1, { headless: false });
  em.model.upsertLive(C1, { state: 'idle', since: t0, last_activity_at: t0 });
  em.model.upsertConversation(C2, { headless: true });
  em.model.upsertLive(C2, { state: 'working', since: t0, last_activity_at: t0 });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').at(-1).aggregate.state, 'idle');
  assert.equal(frames('mirror:status').at(-1).conversations.length, 2, 'the headless one keeps its row');
  em.model.upsertConversation(C2, { headless: false });
  clock.advance(FLUSH_MS);
  assert.equal(frames('mirror:status').at(-1).aggregate.state, 'working', 'the aggregate alone changed: a status frame');
});

test('status() and statusRow() answer from the model as it is now, at the last flush\'s rev', () => {
  const { clock, em, frames } = setup();
  const t0 = clock.now();
  assert.deepStrictEqual(em.status(), { rev: 0, now: t0, aggregate: { state: 'none' }, conversations: [] });
  em.model.upsertConversation(C1, {});
  em.model.upsertLive(C1, { state: 'working', since: t0, step: { kind: 'Edit', tool: 'Edit', label: 'Edit · a.js' }, last_activity_at: t0 });
  const before = em.status();
  assert.equal(before.rev, 0, 'not flushed yet');
  assert.equal(before.aggregate.state, 'working');
  assertTypedRow(before.conversations[0]);
  clock.advance(FLUSH_MS);
  const after = em.status();
  assert.equal(after.rev, 1);
  assert.deepStrictEqual(after.conversations, frames('mirror:status').at(-1).conversations, 'the rows the frame carried');
  assert.deepStrictEqual(em.statusRow(C1), after.conversations[0]);
  assert.equal(em.statusRow('nope'), null);
  assert.equal(em.statusRow(42), null);
});

test('stop() clears the pending flush, and nothing goes out after it', () => {
  const { clock, em, sent } = setup();
  em.model.upsertConversation(C1, { title: 'stopping' });
  const end = em.beginIndex({ conversation_id: C1 });
  assert.equal(clock.pending(), 1);
  em.stop();
  assert.equal(clock.pending(), 0, 'no timer left behind');
  em.model.upsertLive(C1, { state: 'idle' });
  em.schedule();
  end();
  assert.equal(clock.pending(), 0, 'nothing arms one again');
  assert.equal(em.flush(), null);
  assert.equal(em.transition({ op: 'state', conversation_id: C1 }), null);
  assert.equal(em.reset({ reason: 'disabled' }), false);
  em.stop();
  clock.advance(10 * FLUSH_MS);
  assert.equal(sent.length, 0);
});

test('createEmitter requires the model, a bus of its own, a clock and timers', () => {
  const model = createModel({ redactor: passRedactor });
  const bus = createBus({ maxEvents: 2000 });
  assert.throws(() => createEmitter({ bus }), /mirror model is required/);
  assert.throws(() => createEmitter({ model }), /mirror bus is required/);
  assert.throws(() => createEmitter({ model, bus, now: 5 }), /clock/);
  assert.throws(() => createEmitter({ model, bus, timers: {} }), /timers/);
  const em = createEmitter({ model, bus });
  assert.equal(em.rev(), 0);
  em.stop();
});
