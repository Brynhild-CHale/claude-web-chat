// The chat mirror's late-binding seam (lib/server/mirror/index.js PROVIDERS;
// spec §2.12, notes-D Q-D8 (a), D-confirm (3), E-confirm (1)): mirror.provide
// and mirror.conversationOf, which tranche 4's integration (U66a) wires and
// tranche 6 reuses.
//
// Pinned:
//   * no provider: snapshot()'s `asks` is [] at local, read and basic, and the
//     six provided capabilities (answer, task_stop, queue_message, interrupt,
//     code_revert, fork) are false;
//   * provide('asks') feeds snapshot()'s `asks` at local and below read, each
//     call handed the snapshot's level (the route projects below read);
//   * provide('capabilities') turns each provided key on only on an exact
//     `true`; task_stop also needs the tasks source's markStopRequested; mod
//     and rewind_in_place stay false whatever is provided (tranche 6's);
//   * a provider or a predicate that throws, or answers the wrong shape, counts
//     as absent; a second provide replaces the first, and the first's remover
//     then removes nothing; a name outside PROVIDER_NAMES is a TypeError;
//   * conversationOf: a session id → its conversation id, a conversation id →
//     itself, anything unknown → null, and nothing but the id.
// test/mirror-facade.test.js's capabilities case (no provider → false) is
// unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { home: SANDBOX } = require('../test-support/sandbox');
const { withTempHome } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES, CAPABILITIES, PROVIDER_NAMES } = require('../lib/server/mirror');

const S1 = '11111111-1111-4111-8111-111111111111';
const PROVIDED = ['answer', 'task_stop', 'queue_message', 'interrupt', 'code_revert', 'fork'];
const LIVE_ONLY = SOURCES.filter((s) => s.name === 'live');

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-provide-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The facade with `live` only (the conversation registry is part of it), and
// optionally a stand-in tasks source carrying markStopRequested.
async function setup(t, { tasks = false } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  withTempHome(t);
  const root = project(t);
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus: createBus({ maxEvents: 2000 }), redactor: createRedactor(),
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: LIVE_ONLY,
  });
  if (tasks) {
    mirror.register('tasks', { attach: () => ({ start: async () => {}, stop: async () => {}, api: { markStopRequested: () => null } }) });
  }
  await mirror.start();
  let ts = Date.now();
  const start = (sid = S1) => hooks.publish({
    v: 1, event: 'SessionStart', ts: ++ts, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: { source: 'startup' }, compact: null, stop: null, prompt: null, ask: null,
  });
  return { mirror, start };
}

const caps = (m) => m.snapshot({ level: 'local' }).capabilities;
const onKeys = (c) => Object.keys(c).filter((k) => c[k]).sort();

test('no provider: asks [] at every level, and the six provided capabilities false', async (t) => {
  const { mirror } = await setup(t, { tasks: true });
  assert.deepEqual(PROVIDER_NAMES, ['asks', 'capabilities']);
  for (const level of ['local', 'full', 'read', 'basic']) {
    assert.deepEqual(mirror.snapshot({ level }).asks, [], `${level}: no asks without a provider`);
  }
  const c = caps(mirror);
  assert.deepEqual(Object.keys(c), Object.keys(CAPABILITIES), 'every key still listed');
  for (const k of PROVIDED) assert.equal(c[k], false, `${k}: nothing provides it`);
});

test('provide(\'asks\') feeds the snapshot at local and below read, handed the snapshot\'s level', async (t) => {
  const { mirror } = await setup(t);
  const levels = [];
  const view = (level) => ({ id: `ask_${level}`, kind: 'permission', state: 'pending' });
  mirror.provide('asks', { publicViews: ({ level }) => { levels.push(level); return [view(level)]; } });
  assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, [view('local')]);
  assert.deepEqual(mirror.snapshot({ level: 'read' }).asks, [view('read')]);
  const basic = mirror.snapshot({ level: 'basic' });
  assert.deepEqual(basic.asks, [view('basic')], 'below read the provider\'s list rides the snapshot (the route projects it)');
  assert.deepEqual(Object.keys(basic).sort(), ['aggregate', 'asks', 'conversations', 'now', 'primary', 'rev'], 'and nothing more below read');
  assert.deepEqual(levels, ['local', 'read', 'basic']);
  assert.deepEqual(mirror.snapshot().asks, [view('local')], 'no level is local');
});

test('provide(\'capabilities\'): each key on only for an exact true; task_stop also needs the tasks source; mod and rewind_in_place stay off', async (t) => {
  const { mirror } = await setup(t);
  const all = Object.fromEntries([...PROVIDED, 'mod', 'rewind_in_place', 'turn_diff'].map((k) => [k, () => true]));
  mirror.provide('capabilities', all);
  assert.deepEqual(onKeys(caps(mirror)), ['answer', 'code_revert', 'fork', 'interrupt', 'queue_message'],
    'task_stop waits on the tasks source; mod, rewind_in_place and a source-backed key are never provided');
  mirror.register('tasks', { attach: () => ({ start: async () => {}, stop: async () => {}, api: { markStopRequested: () => null } }) });
  assert.equal(caps(mirror).task_stop, true, 'with the tasks source, task_stop follows its predicate');

  mirror.provide('capabilities', { answer: () => 'yes', interrupt: () => 1, fork: true, code_revert: () => true });
  assert.deepEqual(onKeys(caps(mirror)), ['code_revert'], 'a truthy non-true answer, or a non-function, is off');
});

test('a provider or a predicate that throws, or answers the wrong shape, counts as absent', async (t) => {
  const { mirror } = await setup(t);
  mirror.provide('asks', { publicViews: () => { throw new Error('boom'); } });
  assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, []);
  assert.deepEqual(mirror.snapshot({ level: 'basic' }).asks, []);
  for (const bad of [{ publicViews: () => ({ length: 1 }) }, { publicViews: () => Promise.resolve([]) }, { publicViews: 'not a function' }, {}]) {
    mirror.provide('asks', bad);
    assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, [], 'a non-array answer is no asks');
  }
  mirror.provide('capabilities', {
    answer: () => { throw new Error('boom'); },
    get fork() { throw new Error('getter'); },
    interrupt: () => true,
  });
  const c = caps(mirror);
  assert.equal(c.answer, false, 'a throwing predicate is off');
  assert.equal(c.fork, false, 'a throwing getter is off');
  assert.equal(c.interrupt, true, 'the others still answer');
  assert.ok(mirror.stats().errors >= 1, 'a throwing asks provider is counted as a failure, content-free');
});

test('a second provide replaces the first; the first\'s remover then removes nothing; a bad name throws', async (t) => {
  const { mirror } = await setup(t);
  const offA = mirror.provide('asks', { publicViews: () => [{ id: 'a' }] });
  const offB = mirror.provide('asks', { publicViews: () => [{ id: 'b' }] });
  assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, [{ id: 'b' }]);
  offA();
  assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, [{ id: 'b' }], 'a replaced provider\'s remover leaves its successor');
  offB();
  assert.deepEqual(mirror.snapshot({ level: 'local' }).asks, [], 'its own remover removes it');

  mirror.provide('capabilities', { answer: () => true });
  mirror.provide('capabilities', { fork: () => true });
  assert.deepEqual(onKeys(caps(mirror)), ['fork'], 'the whole provider is replaced, not merged');

  assert.throws(() => mirror.provide('sources', {}), TypeError);
  assert.throws(() => mirror.provide('asks', null), TypeError);
  assert.throws(() => mirror.provide('capabilities', 'on'), TypeError);
});

test('conversationOf: a session id → its conversation, a conversation id → itself, unknown → null; the id alone', async (t) => {
  const { mirror, start } = await setup(t);
  assert.equal(mirror.conversationOf(S1), null, 'before the session is seen');
  start(S1);
  const conv = mirror.snapshot({ level: 'local' }).conversations.find((c) => (c.sessions || []).some((s) => s.session_id === S1));
  assert.ok(conv, 'the session made a conversation');
  const cid = conv.id;
  assert.equal(mirror.conversationOf(S1), cid, 'the session\'s conversation');
  assert.equal(mirror.conversationOf(cid), cid, 'a conversation id answers itself');
  for (const bad of ['22222222-2222-4222-8222-222222222222', '', null, undefined, 42, {}, ['x']]) {
    assert.equal(mirror.conversationOf(bad), null, `${JSON.stringify(bad)} → null`);
  }
  assert.equal(typeof mirror.conversationOf(S1), 'string', 'content-free: an id, never a record');
});
