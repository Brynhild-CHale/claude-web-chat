const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { EventEmitter } = require('events');
const launch = require('../lib/cli/commands/launch');

// `open` resolves on a real future tick (not synchronously) and records its
// ordering relative to spawn, so a dropped `await` in launch.js is observable.
function fakeDeps(overrides = {}) {
  const calls = { opened: 0, spawned: [], exits: [], errs: [], order: [] };
  const child = new EventEmitter();
  const deps = {
    open: async () => { await new Promise((r) => setTimeout(r, 5)); calls.opened++; calls.order.push('open'); },
    spawn: (cmd, args, opts) => { calls.spawned.push({ cmd, args, opts }); calls.order.push('spawn'); return child; },
    exit: (c) => { calls.exits.push(c); },
    errlog: (m) => { calls.errs.push(m); },
    platform: 'darwin',
    ...overrides,
  };
  return { calls, child, deps };
}

test('launch: opens the surface BEFORE spawning claude, forwarding args', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch(['--resume'], deps);
  await new Promise((r) => setTimeout(r, 20)); // let async open() resolve first

  assert.deepEqual(calls.order, ['open', 'spawn'], 'open must complete before spawn');
  assert.equal(calls.spawned.length, 1);
  assert.equal(calls.spawned[0].cmd, 'claude');
  assert.deepEqual(calls.spawned[0].args, ['--resume']);
  assert.equal(calls.spawned[0].opts.stdio, 'inherit');
  assert.equal(calls.spawned[0].opts.shell, false, 'no shell on non-Windows');

  child.emit('exit', 0);
  await p;
  assert.deepEqual(calls.exits, [0]);
});

test('launch: forwards an empty arg list and propagates a non-zero exit code', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch([], deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.spawned[0].args, []);
  child.emit('exit', 3);
  await p;
  assert.deepEqual(calls.exits, [3]);
});

test('launch: signal-terminated session exits 128+signum, not 0', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch([], deps);
  await new Promise((r) => setTimeout(r, 20));
  child.emit('exit', null, 'SIGTERM');
  await p;
  assert.deepEqual(calls.exits, [128 + os.constants.signals.SIGTERM]);
  assert.notEqual(calls.exits[0], 0, 'a killed session must not report success');
});

test('launch: exit with null code and no signal is non-zero', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch([], deps);
  await new Promise((r) => setTimeout(r, 20));
  child.emit('exit', null, null);
  await p;
  assert.deepEqual(calls.exits, [1]);
});

test('launch: error then exit fires the callback once (no double-exit)', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch([], deps);
  await new Promise((r) => setTimeout(r, 20));
  child.emit('error', new Error('boom'));
  child.emit('exit', 0); // late exit must be ignored
  await p;
  assert.deepEqual(calls.exits, [1], 'only the first settlement counts');
});

test('launch: missing `claude` binary → exit 127 with a helpful message', async () => {
  const { calls, child, deps } = fakeDeps();
  const p = launch([], deps);
  await new Promise((r) => setTimeout(r, 20));
  const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT';
  child.emit('error', e);
  await p;
  assert.deepEqual(calls.exits, [127]);
  assert.match(calls.errs.join('\n'), /claude/i);
});

test('launch: on Windows spawns the claude.cmd shim with shell:true', async () => {
  const { calls, child, deps } = fakeDeps({ platform: 'win32' });
  const p = launch(['--resume'], deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.spawned[0].cmd, 'claude.cmd');
  assert.equal(calls.spawned[0].opts.shell, true);
  child.emit('exit', 0);
  await p;
});

test('launch: a failing surface (open throws) exits non-zero and never spawns claude', async () => {
  const { calls, deps } = fakeDeps({ open: async () => { throw new Error('no free port'); } });
  await launch([], deps);
  assert.equal(calls.spawned.length, 0, 'must not attach a session to a dead surface');
  assert.deepEqual(calls.exits, [1]);
});

test('cli index loads with launch registered (help lists it)', () => {
  const { main } = require('../lib/cli');
  const orig = console.log;
  let out = '';
  console.log = (s) => { out += s; };
  try { main(['help']); } finally { console.log = orig; }
  assert.match(out, /launch/);
});
