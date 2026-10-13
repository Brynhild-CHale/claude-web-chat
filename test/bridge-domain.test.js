// The mod bridge's domain (lib/server/domain/bridge.js, spec §15.7): the
// registry of mod-attached sessions, the per-session op queue, the event
// intake that publishes each mod event once on the hook tap, the bridge log,
// and the lifecycle.
//
// The domain is driven directly here — transport-independent, it answers
// {status, body} — with a real hook tap (lib/server/hook-tap), a fake mirror
// (subscribe + conversationOf) and, where time matters, a clock the test
// moves whose timers fire only when advance() reaches them. One test wires a
// REAL createMirror to show the synthetic envelope changes no turn, ask or
// live state but its progress clocks. The routes, host-only gate and the
// fake mod over HTTP are test/bridge-routes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome } = require('../test-support/helpers');
const { createBridge, LOG_MAX_BYTES } = require('../lib/server/domain/bridge');
const { createHookTap } = require('../lib/server/hook-tap');
const { projectPaths, realpath } = require('../lib/core/paths');
const P = require('../lib/core/mod-protocol');
const { projectToolInput, toolKind, stepLabel, callLabel, inputHash } = require('../lib/core/tool-input');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createAsks } = require('../lib/server/domain/asks');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bridge-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A clock the test moves. Its timers fire only inside advance(), in time
// order, each followed by a turn of the event loop.
function fakeClock(start = 1790000000000) {
  let t = start;
  let seq = 0;
  const pending = new Map();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    tick(ms = 1) { t += ms; return t; },
    pending: () => pending.size,
    timers: Object.freeze({
      setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn }); return seq; },
      clearTimeout(h) { pending.delete(h); },
    }),
    async advance(ms = 0) {
      const end = t + ms;
      for (let fired = 0; ; fired++) {
        if (fired > 100000) throw new Error('fakeClock: a timer re-arms itself without moving on');
        let next = null;
        for (const [h, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [h, p];
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        await settle();
      }
      t = Math.max(t, end);
      await settle();
    },
  };
}

function fakeMirror() {
  const subs = new Set();
  const conv = new Map(); // session → conversation
  return {
    subs,
    conv,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    conversationOf(id) { return conv.get(id) || ([...conv.values()].includes(id) ? id : null); },
    emit(e) { for (const fn of [...subs]) fn(e); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, { clock = fakeClock(), mirror = fakeMirror(), start = true, ...opts } = {}) {
  const root = project(t);
  const hooks = createHookTap();
  const published = [];
  hooks.subscribe((e) => { if (e.event === P.MOD_EVENT) published.push(e); });
  const logs = [];
  let n = 0;
  const bridge = createBridge({
    root, hooks, mirror, now: clock.now, timers: clock.timers, log: (m) => logs.push(m),
    // Deterministic, distinct tokens.
    randomBytes: (k) => { n += 1; return Buffer.alloc(k, n); },
    ...opts,
  });
  t.after(() => bridge.stop());
  if (start) bridge.start();
  const logFile = path.join(projectPaths(root).modDir, 'bridge.log');
  const h = {
    root, hooks, mirror, clock, bridge, published, logs, logFile,
    logLines: () => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    helloBody: (extra = {}) => ({
      v: 1, protocol: P.MOD_PROTOCOL, session_id: S1, cc_version: '2.1.296', mod_version: '0.8.5',
      ops: [...P.OPS], events: [...P.EVENT_KINDS], root, ...extra,
    }),
  };
  h.attach = (sid = S1, extra = {}) => {
    const a = bridge.hello(h.helloBody({ session_id: sid, ...extra }));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    return a.body.token;
  };
  return h;
}

// ── hello ────────────────────────────────────────────────────────────────────

test('hello: a valid hello answers a 48-hex token and the intersected ops and events', (t) => {
  const h = setup(t);
  const a = h.bridge.hello(h.helloBody({ ops: ['abort', 'submit', 'teleport'], events: ['turn.step', 'tool.call', 'session.end', 'nope'] }));
  assert.equal(a.status, 200);
  assert.match(a.body.token, /^[0-9a-f]{48}$/);
  assert.deepEqual(a.body, {
    ok: true, token: a.body.token, protocol: 1, wait_max_ms: 20000, flush_ms: 100, permission_wait_ms: 0,
    ops: ['abort', 'submit'], events: ['turn.step', 'tool.call'],
  });
  assert.equal(h.bridge.attached(S1), true);
  assert.equal(h.bridge.attached(S1.toUpperCase()), true);
  assert.equal(h.bridge.any(), true);
});

test('hello: an extra key, a bad session id, a missing field or no root → 400; nothing attaches', (t) => {
  const h = setup(t);
  const noRoot = h.helloBody();
  delete noRoot.root;
  const noCc = h.helloBody();
  delete noCc.cc_version;
  for (const body of [h.helloBody({ token: 'abc' }), h.helloBody({ session_id: 'nope' }), noCc, noRoot, null, 'x']) {
    const a = h.bridge.hello(body);
    assert.equal(a.status, 400, JSON.stringify(body));
    assert.equal(a.body.error, 'bad_request');
    assert.equal(a.body.token, undefined);
  }
  assert.equal(h.bridge.any(), false);
});

test('hello: another protocol → 409 protocol; below 2.1.287 → 409 too-old, 2.1.287 accepted', (t) => {
  const h = setup(t);
  const proto = h.bridge.hello(h.helloBody({ protocol: 2 }));
  assert.equal(proto.status, 409);
  assert.equal(proto.body.refused, 'protocol');
  assert.equal(proto.body.hint, 'run claude-web-chat mod on again');
  const old = h.bridge.hello(h.helloBody({ cc_version: '2.1.286' }));
  assert.equal(old.status, 409);
  assert.equal(old.body.refused, 'too-old');
  assert.equal(h.bridge.hello(h.helloBody({ cc_version: '2.1.287' })).status, 200);
  assert.equal(h.bridge.hello(h.helloBody({ session_id: S2, cc_version: '2.2.0' })).status, 200);
});

test('hello: a disabled project (the marker) → 409 disabled, with its scope', (t) => {
  const h = setup(t);
  fs.writeFileSync(projectPaths(h.root).disabled, '');
  const a = h.bridge.hello(h.helloBody());
  assert.equal(a.status, 409);
  assert.equal(a.body.refused, 'disabled');
  assert.equal(a.body.scope, 'project');
  assert.equal(a.body.retry_ms, 30000);
  assert.equal(a.body.token, undefined);
  assert.equal(h.bridge.any(), false);
});

test('hello: another project\'s root → 409 wrong-project, no token, one refused line; a symlinked spelling of the same root is accepted', (t) => {
  const h = setup(t);
  const other = project(t);
  const a = h.bridge.hello(h.helloBody({ root: other }));
  assert.equal(a.status, 409);
  assert.equal(a.body.refused, 'wrong-project');
  assert.equal(a.body.token, undefined);
  assert.equal(h.bridge.any(), false);
  assert.deepEqual(h.logLines().map((l) => [l.what, l.outcome, l.session_id]), [['refused', 'wrong-project', S1]]);
  // A symlink's spelling of the same root.
  const dir = project(t);
  fs.symlinkSync(h.root, path.join(dir, 'via-link'));
  assert.equal(h.bridge.hello(h.helloBody({ root: path.join(dir, 'via-link') })).status, 200);
  // macOS: os.tmpdir() is /var/folders/…, really /private/var/folders/….
  const real = realpath(h.root);
  assert.ok(real);
  assert.equal(h.bridge.hello(h.helloBody({ session_id: S2, root: real })).status, 200);
  if (process.platform === 'darwin') assert.notEqual(real, h.root, 'the /var vs /private/var spelling is exercised');
});

test('hello: a second hello for one session supersedes the first; the old token answers 401 superseded', async (t) => {
  const h = setup(t);
  const first = h.attach();
  const second = h.attach();
  assert.notEqual(first, second);
  const old = await h.bridge.poll(first);
  assert.equal(old.status, 401);
  assert.equal(old.body.refused, 'superseded');
  assert.equal((await h.bridge.poll(second)).status, 200);
  const unknown = await h.bridge.poll('f'.repeat(48));
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.refused, 'token');
  assert.equal((await h.bridge.poll('nope')).body.refused, 'token');
  assert.equal(h.bridge.events(first, { events: [] }).status, 401);
  assert.equal(h.bridge.result(first, { id: 'op_1', ok: true }).status, 401);
});

test('hello: a re-hello answers the superseded instance\'s waiting poll [] and hands later ops only to the new token', async (t) => {
  const h = setup(t);
  const first = h.attach();
  let oldAnswer = null;
  h.bridge.poll(first, { waitMs: 20000 }).then((r) => { oldAnswer = r; });
  await settle();
  assert.equal(oldAnswer, null, 'the first instance waits');
  const second = h.attach();
  await settle();
  assert.deepEqual(oldAnswer, { status: 200, body: { ok: true, ops: [] } }, 'answered at the re-hello, not left to take the next op');
  assert.equal(h.bridge.status().sessions[0].polling, false);
  const done = h.bridge.enqueue(S1, { op: 'usage' });
  const a = await h.bridge.poll(second, { waitMs: 20000 });
  assert.deepEqual(a.body.ops.map((o) => o.op), ['usage']);
  h.bridge.result(second, { id: a.body.ops[0].id, ok: true, result: { n: 1 } });
  assert.deepEqual(await done, { ok: true, result: { n: 1 } });
});

test('setPermissionWait(1500) makes the next hello answer permission_wait_ms 1500; out of range is a TypeError', (t) => {
  const h = setup(t);
  h.bridge.setPermissionWait(1500);
  assert.equal(h.bridge.hello(h.helloBody()).body.permission_wait_ms, 1500);
  for (const bad of [-1, 590001, 1.5, '100', null, NaN]) assert.throws(() => h.bridge.setPermissionWait(bad), TypeError);
  h.bridge.setPermissionWait(590000);
  h.bridge.setPermissionWait(0);
  assert.equal(h.bridge.hello(h.helloBody()).body.permission_wait_ms, 0);
});

// ── ops ──────────────────────────────────────────────────────────────────────

test('ops: an op enqueued before the poll is answered at once', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const done = h.bridge.enqueue(S1, { op: 'abort' });
  const a = await h.bridge.poll(token, { waitMs: 20000 });
  assert.equal(a.status, 200);
  assert.equal(a.body.ops.length, 1);
  const [op] = a.body.ops;
  assert.match(op.id, /^op_[a-z0-9]+$/);
  assert.deepEqual({ ...op, id: 'x' }, { id: 'x', op: 'abort', args: {}, expires_at: h.clock.now() + 3000 });
  assert.deepEqual(h.bridge.result(token, { id: op.id, ok: true, result: { aborted: true } }), { status: 200, body: { ok: true } });
  assert.deepEqual(await done, { ok: true, result: { aborted: true } });
});

test('ops: a waiting poll is answered when an op is enqueued; a poll past its wait answers []', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const waiting = h.bridge.poll(token, { waitMs: 5000 });
  const done = h.bridge.enqueue(S1, { op: 'command', args: { name: 'plan' } });
  const a = await waiting;
  assert.deepEqual(a.body.ops.map((o) => [o.op, o.args]), [['command', { name: 'plan' }]]);
  h.bridge.result(token, { id: a.body.ops[0].id, ok: false, refused: 'busy', error: 'the turn is running' });
  assert.deepEqual(await done, { ok: false, refused: 'busy', error: 'the turn is running', delivered: true });

  let answered = null;
  h.bridge.poll(token, { waitMs: 5000 }).then((r) => { answered = r; });
  await h.clock.advance(4999);
  assert.equal(answered, null);
  await h.clock.advance(1);
  assert.deepEqual(answered, { status: 200, body: { ok: true, ops: [] } });
  // The wait is capped at 20 s.
  answered = null;
  h.bridge.poll(token, { waitMs: 999999 }).then((r) => { answered = r; });
  await h.clock.advance(19999);
  assert.equal(answered, null);
  await h.clock.advance(1);
  assert.deepEqual(answered.body.ops, []);
});

test('ops: a second poll for one session answers the first []; past 32 waiters a poll answers [] at once', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const first = h.bridge.poll(token, { waitMs: 20000 });
  const second = h.bridge.poll(token, { waitMs: 20000 });
  assert.deepEqual(await first, { status: 200, body: { ok: true, ops: [] } });
  h.bridge.enqueue(S1, { op: 'usage' });
  assert.equal((await second).body.ops[0].op, 'usage');

  const sids = Array.from({ length: 33 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const tokens = sids.map((sid) => h.attach(sid));
  const states = tokens.slice(0, 32).map(() => null);
  tokens.slice(0, 32).forEach((tok, i) => { h.bridge.poll(tok, { waitMs: 20000 }).then((r) => { states[i] = r; }); });
  await settle();
  assert.ok(states.every((s) => s === null), 'the first 32 wait');
  assert.equal(h.bridge.status().sessions.filter((s) => s.polling).length, 32);
  const over = await h.bridge.poll(tokens[32], { waitMs: 20000 });
  assert.deepEqual(over.body.ops, [], 'the 33rd answers at once');
  await h.clock.advance(20000);
  assert.ok(states.every((s) => s && s.body.ops.length === 0));
});

test('ops: at most 8 per answer, oldest first', async (t) => {
  const h = setup(t);
  const token = h.attach();
  for (let i = 0; i < 11; i++) h.bridge.enqueue(S1, { op: 'fill', args: { text: `t${i}` } });
  const a = await h.bridge.poll(token);
  assert.deepEqual(a.body.ops.map((o) => o.args.text), ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  const b = await h.bridge.poll(token);
  assert.deepEqual(b.body.ops.map((o) => o.args.text), ['t8', 't9', 't10']);
});

test('enqueue: not-attached, queue-full past 32, and validateOp\'s not-allowed and bad-args — none of them queued', async (t) => {
  const h = setup(t);
  assert.deepEqual(await h.bridge.enqueue(S2, { op: 'abort' }), { ok: false, refused: 'not-attached', hint: 'no mod is attached to that session', delivered: false });
  const token = h.attach();
  const refusedBefore = [
    [{ op: 'model' }, 'not-allowed'],
    [{ op: 'command', args: { name: 'model', args: 'opus' } }, 'not-allowed'],
    [{ op: 'command', args: { name: 'config' } }, 'not-allowed'],
    [{ op: 'submit', args: { text: '/permissions' } }, 'bad-args'],
    [{ op: 'permissionDecision', args: { request_id: 'r1', decision: { mode: 'bypassPermissions' } } }, 'not-allowed'],
    [{ op: 'taskStop', args: { task_id: '../x' } }, 'bad-args'],
  ];
  for (const [op, refused] of refusedBefore) {
    const r = await h.bridge.enqueue(S1, op);
    assert.equal(r.ok, false);
    assert.equal(r.refused, refused, JSON.stringify(op));
    assert.equal(r.delivered, false);
  }
  assert.equal(h.bridge.status().sessions[0].queued, 0, 'nothing refused was queued');
  for (let i = 0; i < 32; i++) h.bridge.enqueue(S1, { op: 'usage' });
  assert.equal((await h.bridge.enqueue(S1, { op: 'usage' })).refused, 'queue-full');
  assert.throws(() => h.bridge.enqueue(S1, { op: 'usage' }, { deliverWithinMs: -1 }), TypeError);
  assert.equal((await h.bridge.poll(token)).body.ops.length, 8, 'the 32 queued usage ops are there to take');
});

test('enqueue: an op not handed out in time is withdrawn and never handed out later; a taken one with no result is no-result', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const stale = h.bridge.enqueue(S1, { op: 'abort' }, { deliverWithinMs: 2000 });
  await h.clock.advance(2000);
  assert.deepEqual(await stale, { ok: false, refused: 'timeout', hint: 'the mod did not take the op in time', delivered: false });
  assert.deepEqual((await h.bridge.poll(token)).body.ops, [], 'never handed out late');

  // Withdrawn on the clock even when its timer has not fired yet.
  const late = h.bridge.enqueue(S1, { op: 'abort' }, { deliverWithinMs: 2000 });
  h.clock.tick(2000);
  assert.deepEqual((await h.bridge.poll(token)).body.ops, []);
  assert.equal((await late).refused, 'timeout');

  const taken = h.bridge.enqueue(S1, { op: 'usage' }, { resultWithinMs: 4000 });
  const [op] = (await h.bridge.poll(token)).body.ops;
  await h.clock.advance(4000);
  assert.deepEqual(await taken, { ok: false, refused: 'no-result', hint: 'the mod took the op and did not answer', delivered: true });
  assert.equal(h.bridge.result(token, { id: op.id, ok: true }).status, 404, 'a result after the settle is unknown');
});

test('result: resolves its enqueue exactly once; a second result answers 404 unknown-op; a result over 8 KiB settles too-large', async (t) => {
  const h = setup(t);
  const token = h.attach();
  let resolved = 0;
  const done = h.bridge.enqueue(S1, { op: 'messages' }).then((r) => { resolved += 1; return r; });
  const [op] = (await h.bridge.poll(token)).body.ops;
  assert.equal(h.bridge.result(token, { id: op.id, ok: true, result: { count: 4 } }).status, 200);
  assert.deepEqual(h.bridge.result(token, { id: op.id, ok: true, result: { count: 5 } }), { status: 404, body: { ok: false, refused: 'unknown-op' } });
  assert.deepEqual(await done, { ok: true, result: { count: 4 } });
  await settle();
  assert.equal(resolved, 1);
  assert.equal(h.bridge.result(token, { id: 'op_zzz', ok: true }).status, 404);
  assert.equal(h.bridge.result(token, { id: op.id, ok: true, extra: 1 }).status, 400);

  const big = h.bridge.enqueue(S1, { op: 'usage' });
  const [op2] = (await h.bridge.poll(token)).body.ops;
  assert.equal(h.bridge.result(token, { id: op2.id, ok: true, result: 'x'.repeat(9000) }).status, 413);
  assert.equal((await big).refused, 'too-large');
});

// ── events ───────────────────────────────────────────────────────────────────

test('events: each accepted event is published exactly once, after the answer, as a synthetic ModEvent', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 500;
  const a = h.bridge.events(token, {
    events: [
      { kind: 'turn.start', at, turn_id: 't1', secret: 'x' },
      { kind: 'turn.step', at: at + 1, turn_id: 't1', index: 0, delta: 'Hel' },
      { kind: 'teleport', at },
      'garbage',
    ],
  });
  assert.deepEqual(a, { status: 200, body: { ok: true, accepted: 2, dropped: 2 } });
  assert.equal(h.published.length, 0, 'nothing before the answer has gone');
  await settle();
  assert.equal(h.published.length, 2);
  const [start, step] = h.published;
  assert.deepEqual({ ...start, seq: 0 }, {
    seq: 0, kind: 'hook', v: 1, event: 'ModEvent', synthetic: true, ts: at, session_id: S1, mod: { kind: 'turn.start', turn_id: 't1' },
  });
  assert.deepEqual(step.mod, { kind: 'turn.step', turn_id: 't1', index: 0, delta: 'Hel' });
  await settle();
  assert.equal(h.published.length, 2, 'once');
  const st = h.bridge.status();
  assert.equal(st.counters.events_dropped, 2);
  assert.equal(st.counters.events_published, 2);
});

test('events: tool.call and tool.done carry the tool section lib/core/tool-input builds; a 5 MB Write content never crosses', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const input = { command: 'npm test -- --grep bridge', description: 'run the tests', timeout: 60000 };
  const expected = {
    name: 'Bash', use_id: 'toolu_1', kind: toolKind('Bash'), label: stepLabel('Bash', input), call: callLabel('Bash', input),
    input: projectToolInput('Bash', input, { profile: 'mirror' }).input, input_hash: inputHash(input),
  };
  h.bridge.events(token, { events: [{ kind: 'tool.call', at: h.clock.now() - 10, tool_use_id: 'toolu_1', tool: 'Bash', input }] });
  h.bridge.events(token, { events: [{ kind: 'tool.done', at: h.clock.now() - 5, tool_use_id: 'toolu_1', ok: true, duration_ms: 40 }] });
  await settle();
  await settle();
  assert.deepEqual(h.published[0].tool, expected);
  assert.deepEqual(h.published[0].mod.input, input);
  assert.deepEqual(h.published[1].tool, expected, 'tool.done takes the call it closes');
  assert.deepEqual(h.published[1].mod, { kind: 'tool.done', tool_use_id: 'toolu_1', ok: true, duration_ms: 40 });

  const content = 'z'.repeat(5 * 1024 * 1024);
  h.bridge.events(token, { events: [{ kind: 'tool.call', at: h.clock.now(), tool_use_id: 'toolu_2', tool: 'Write', input: { file_path: '/p/big.txt', content } }] });
  await settle();
  const env = h.published[2];
  const text = JSON.stringify(env);
  assert.ok(text.length < 32 * 1024, `the envelope is ${text.length} bytes`);
  assert.ok(!text.includes('z'.repeat(8193)));
  assert.equal(env.tool.input.file_path, '/p/big.txt');
  assert.equal(typeof env.tool.input.content_bytes, 'number', 'the projection keeps a length');
  assert.equal(env.tool.input.content, undefined);
});

test('events: a session\'s ts strictly increases and never exceeds now()', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const now = h.clock.now();
  const same = Array.from({ length: 20 }, (_, i) => ({ kind: 'turn.step', at: now - 100, turn_id: 't1', index: i, delta: 'x' }));
  h.bridge.events(token, { events: [...same, { kind: 'turn.start', at: now + 60000, turn_id: 't2' }] });
  await settle();
  const ts = h.published.map((e) => e.ts);
  assert.equal(ts.length, 21);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], `ts ${i}`);
  assert.ok(ts.every((x) => x <= now), 'none ahead of the clock');
  assert.equal(ts[0], now - 100);
  assert.equal(ts[20], now, 'a future at is clamped to now');
  // The clock has no room left: the next event waits for the next millisecond.
  h.bridge.events(token, { events: [{ kind: 'turn.complete', at: now, turn_id: 't2' }] });
  await settle();
  assert.equal(h.published.length, 21, 'not stamped yet');
  await h.clock.advance(1);
  assert.equal(h.published.length, 22);
  assert.equal(h.published[21].ts, now + 1);
});

test('events: session.end detaches and publishes nothing; diag lands in status() shapes and publishes nothing', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const changes = [];
  h.bridge.onChange((c) => changes.push(c));
  h.bridge.events(token, { events: [{ kind: 'diag', at: h.clock.now(), shapes: { 'turn.step': ['turnId', 'index', 'chunk'] } }] });
  await settle();
  assert.deepEqual(h.bridge.status().sessions[0].shapes, { 'turn.step': ['turnId', 'index', 'chunk'] });
  assert.equal(h.published.length, 0);
  const pending = h.bridge.enqueue(S1, { op: 'usage' });
  h.bridge.events(token, {
    events: [
      { kind: 'session.end', at: h.clock.now(), reason: 'exit' },
      { kind: 'turn.start', at: h.clock.now(), turn_id: 't9' },
    ],
  });
  await settle();
  assert.equal(h.published.length, 0, 'nothing after the end, and not the end itself');
  assert.equal(h.bridge.attached(S1), false);
  assert.deepEqual(changes, [{ session_id: S1, attached: false, reason: 'session-end' }]);
  assert.equal((await pending).refused, 'detached');
  assert.equal(h.bridge.events(token, { events: [] }).status, 401, 'events for a session not attached are refused');
});

test('events: 51 events → 400; a body that is not {events: [...]} → 400', (t) => {
  const h = setup(t);
  const token = h.attach();
  const ev = { kind: 'turn.start', at: h.clock.now(), turn_id: 't' };
  assert.equal(h.bridge.events(token, { events: Array(51).fill(ev) }).status, 400);
  assert.equal(h.bridge.events(token, { events: Array(50).fill(ev) }).status, 200);
  assert.equal(h.bridge.events(token, { events: [], extra: 1 }).status, 400);
  assert.equal(h.bridge.events(token, []).status, 400);
});

test('events: past 30 envelopes per second, turn.step deltas of one step merge into one envelope; anything else is dropped and counted', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const steps = Array.from({ length: 40 }, (_, i) => ({ kind: 'turn.step', at: at + i, turn_id: 't1', index: 0, delta: `d${i};` }));
  h.bridge.events(token, { events: [...steps, { kind: 'tool.call', at: at + 41, tool_use_id: 'tu', tool: 'Read', input: {} }] });
  await settle();
  assert.equal(h.published.length, 30, 'the second\'s cap');
  await h.clock.advance(1000);
  assert.equal(h.published.length, 31, 'the merged deltas, one envelope, when the second turns over');
  const merged = h.published[30].mod;
  assert.equal(merged.delta, Array.from({ length: 10 }, (_, i) => `d${i + 30};`).join(''));
  assert.equal(merged.index, 0);
  assert.equal(merged.merged, 10);
  const c = h.bridge.status().counters;
  assert.equal(c.events_merged, 10);
  assert.equal(c.events_rate_dropped, 1, 'the tool.call past the cap');
});

// U87b: a merge never crosses a step. mod-live keys provisional replies by
// (turn, index) or message_id, so a crossed merge moved step n's tail onto
// step n+1 until the transcript landed.
const stepEv = (at, turn, index, mid, delta) => ({
  kind: 'turn.step', at, turn_id: turn, index, ...(mid ? { message_id: mid } : {}), delta,
});

test('events: past the cap, two steps\' deltas in one second give two envelopes, each with its own index, message_id and whole delta, in order', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const fill = Array.from({ length: 30 }, (_, i) => stepEv(at + i, 't1', 0, 'msg_a', `f${i};`));
  const tail0 = Array.from({ length: 5 }, (_, i) => stepEv(at + 30 + i, 't1', 0, 'msg_a', `a${i};`));
  const step1 = Array.from({ length: 5 }, (_, i) => stepEv(at + 35 + i, 't1', 1, 'msg_b', `b${i};`));
  h.bridge.events(token, { events: [...fill, ...tail0, ...step1] });
  await settle();
  assert.equal(h.published.length, 30, 'the second\'s cap');
  await h.clock.advance(1000);
  assert.equal(h.published.length, 32, 'one envelope per step when the second turns over');
  const [e0, e1] = h.published.slice(30);
  assert.deepEqual(
    { index: e0.mod.index, message_id: e0.mod.message_id, delta: e0.mod.delta, merged: e0.mod.merged },
    { index: 0, message_id: 'msg_a', delta: 'a0;a1;a2;a3;a4;', merged: 5 },
    'step 0 keeps its whole tail under its own index and id',
  );
  assert.deepEqual(
    { index: e1.mod.index, message_id: e1.mod.message_id, delta: e1.mod.delta, merged: e1.mod.merged },
    { index: 1, message_id: 'msg_b', delta: 'b0;b1;b2;b3;b4;', merged: 5 },
    'step 1 gets only its own deltas',
  );
  assert.ok(e0.ts < e1.ts, 'in order');
  const c = h.bridge.status().counters;
  assert.equal(c.events_merged, 10);
  assert.equal(c.events_rate_dropped, 0, 'no delta of either step is dropped');
  assert.equal(c.events_published, 32);
});

test('events: past the cap, a new message_id at the same index is a new step; another turn\'s step is held behind, not dropped; a step\'s late message_id joins it', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const fill = Array.from({ length: 30 }, (_, i) => ({ kind: 'turn.start', at: at + i, turn_id: `f${i}` }));
  h.bridge.events(token, {
    events: [
      ...fill,
      stepEv(at + 30, 't1', 2, null, 'p;'), // the step before its message id is known
      stepEv(at + 31, 't1', 2, 'msg_c', 'q;'),
      stepEv(at + 32, 't1', 2, null, 'r;'),
      stepEv(at + 33, 't1', 2, 'msg_d', 's;'), // same index, another message: a new step
      stepEv(at + 34, 't2', 0, null, 'u;'),
      stepEv(at + 35, 't2', 0, null, 'v;'),
    ],
  });
  await settle();
  assert.equal(h.published.length, 30);
  await h.clock.advance(1000);
  const out = h.published.slice(30).map((e) => ({
    turn_id: e.mod.turn_id, index: e.mod.index, message_id: e.mod.message_id, delta: e.mod.delta,
  }));
  assert.deepEqual(out, [
    { turn_id: 't1', index: 2, message_id: 'msg_c', delta: 'p;q;r;' },
    { turn_id: 't1', index: 2, message_id: 'msg_d', delta: 's;' },
    { turn_id: 't2', index: 0, message_id: undefined, delta: 'u;v;' },
  ]);
  assert.equal(h.bridge.status().counters.events_rate_dropped, 0);
});

test('events: past the cap, the same index in another turn is another step, even before either names its message', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const fill = Array.from({ length: 30 }, (_, i) => ({ kind: 'turn.start', at: at + i, turn_id: `f${i}` }));
  h.bridge.events(token, {
    events: [
      ...fill,
      stepEv(at + 30, 't1', 0, null, 'a;'),
      stepEv(at + 31, 't1', 0, null, 'b;'),
      stepEv(at + 32, 't2', 0, null, 'c;'),
    ],
  });
  await settle();
  await h.clock.advance(1000);
  assert.deepEqual(h.published.slice(30).map((e) => ({ turn_id: e.mod.turn_id, index: e.mod.index, delta: e.mod.delta })), [
    { turn_id: 't1', index: 0, delta: 'a;b;' },
    { turn_id: 't2', index: 0, delta: 'c;' },
  ]);
});

test('events: past the cap, at most 30 envelopes are held; a further step is dropped and counted, and the held ones publish in order inside the cap', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const fill = Array.from({ length: 30 }, (_, i) => ({ kind: 'turn.start', at: at + i, turn_id: `f${i}` }));
  h.bridge.events(token, { events: fill });
  // 31 one-delta steps past the cap (one batch holds at most 50 events).
  h.bridge.events(token, { events: Array.from({ length: 31 }, (_, i) => stepEv(at + 30 + i, 't1', i, null, `s${i};`)) });
  await settle();
  assert.equal(h.published.length, 30);
  const c0 = h.bridge.status().counters;
  assert.equal(c0.events_merged, 30, 'thirty held');
  assert.equal(c0.events_rate_dropped, 1, 'the thirty-first step');
  await h.clock.advance(1000);
  assert.equal(h.published.length, 60, 'the held envelopes fill the next second, no more');
  assert.deepEqual(h.published.slice(30).map((e) => e.mod.index), Array.from({ length: 30 }, (_, i) => i));
  assert.deepEqual(h.published.slice(30).map((e) => e.mod.delta), Array.from({ length: 30 }, (_, i) => `s${i};`));
  await h.clock.advance(1000);
  assert.equal(h.published.length, 60, 'nothing more: the dropped step is gone, nothing is held');
  assert.equal(h.bridge.status().counters.events_published, 60);
});

test('events: past the cap, one step\'s deltas still merge into one envelope under that step\'s index and message_id', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const at = h.clock.now() - 5000;
  const fill = Array.from({ length: 30 }, (_, i) => ({ kind: 'turn.start', at: at + i, turn_id: `f${i}` }));
  const run = Array.from({ length: 15 }, (_, i) => stepEv(at + 30 + i, 't1', 3, i < 3 ? null : 'msg_e', `x${i};`));
  h.bridge.events(token, { events: [...fill, ...run] });
  await settle();
  await h.clock.advance(1000);
  assert.equal(h.published.length, 31);
  const m = h.published[30].mod;
  assert.equal(m.index, 3);
  assert.equal(m.message_id, 'msg_e');
  assert.equal(m.delta, Array.from({ length: 15 }, (_, i) => `x${i};`).join(''));
  assert.equal(m.merged, 15);
  assert.equal(h.bridge.status().counters.events_merged, 15);
});

test('a real mirror ingests the envelope without changing any turn, ask or live state but its progress clocks; an unknown session is ignored', async (t) => {
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-bridge-mirror-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  let clockMs = Date.now() - 60000;
  const now = () => clockMs;
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  mirrorBus.setBroadcaster(() => {});
  const mirror = createMirror({
    root, hooks, mainBus, mirrorBus, redactor: createRedactor(), now, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: SOURCES.filter((s) => s.name === 'live'),
  });
  const asks = createAsks({ bus: mirrorBus, hooks, mirror, root, now });
  const bridge = createBridge({ root, hooks, mirror, now });
  t.after(async () => { await bridge.stop(); asks.stop(); await mirror.stop(); });
  await mirror.start();
  bridge.start();
  const env = (event, extra = {}) => ({
    v: 1, event, ts: (clockMs += 1), session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  hooks.publish(env('SessionStart', { session: { source: 'startup' } }));
  hooks.publish(env('UserPromptSubmit', { prompt_id: 'p1', prompt: { author: 'user', text: 'run the tests' } }));
  // Every leaf of the snapshot whose value differs between two reads.
  const changed = (x, y, at = '') => {
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((k) => changed(x[k], y[k], `${at}.${k}`));
    }
    return JSON.stringify(x) === JSON.stringify(y) ? [] : [at];
  };
  const snap = () => JSON.parse(JSON.stringify(mirror.snapshot({ level: 'local' })));
  const before = snap();
  const statsBefore = mirror.stats().ingest;

  const token = bridge.hello({
    v: 1, protocol: 1, session_id: S1, cc_version: '2.1.296', mod_version: '0.8.5', ops: [...P.OPS], events: [...P.EVENT_KINDS], root,
  }).body.token;
  clockMs += 1000;
  const at = clockMs - 500;
  const a = bridge.events(token, {
    events: [
      { kind: 'turn.start', at, turn_id: 'mt1' },
      { kind: 'tool.call', at: at + 1, tool_use_id: 'toolu_m1', tool: 'Bash', input: { command: 'npm test' } },
      { kind: 'permission.request', at: at + 2, request_id: 'perm1', tool: 'Bash', tool_use_id: 'toolu_m1', input: { command: 'npm test' } },
      { kind: 'tool.done', at: at + 3, tool_use_id: 'toolu_m1', ok: true },
      { kind: 'turn.complete', at: at + 4, turn_id: 'mt1', text: 'done' },
    ],
  });
  assert.equal(a.body.accepted, 5);
  await settle();
  const stats = mirror.stats().ingest;
  assert.equal(stats.accepted, statsBefore.accepted + 5, 'each envelope is the session\'s, ingested once');
  const after = snap();
  assert.equal(after.diagnostics.hooks.events_seen.ModEvent, 5);
  // The progress clocks — the snapshot's own time, the live state's activity
  // and hook evidence, the facade's last hook and its per-event counter — and
  // nothing else: no turn opened or closed, no item, no state, no ask.
  const PROGRESS = new Set([
    '.now', '.conversations.0.live.last_activity_at', '.conversations.0.live.evidence.hook_at',
    '.diagnostics.hooks.last_at', '.diagnostics.hooks.events_seen.ModEvent',
  ]);
  const moved = changed(before, after);
  assert.ok(moved.includes('.diagnostics.hooks.events_seen.ModEvent'));
  assert.deepEqual(moved.filter((k) => !PROGRESS.has(k)), [], 'no turn, item or live field moved but the clocks');
  assert.deepEqual(asks.list(), []);
  assert.deepEqual(asks.pending(), []);

  // An envelope about a session the mirror does not hold is ignored.
  const ignored = (stats.ignored && stats.ignored['unknown-session']) || 0;
  const token2 = bridge.hello({
    v: 1, protocol: 1, session_id: S2, cc_version: '2.1.296', mod_version: '0.8.5', ops: [], events: [], root,
  }).body.token;
  bridge.events(token2, { events: [{ kind: 'turn.start', at: clockMs, turn_id: 'x' }] });
  await settle();
  assert.equal(mirror.stats().ingest.ignored['unknown-session'], ignored + 1);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('lifecycle: a SessionEnd on the tap detaches an attached session (an agent\'s does not)', async (t) => {
  const h = setup(t);
  h.attach();
  const changes = [];
  h.bridge.onChange((c) => changes.push(c));
  const pending = h.bridge.enqueue(S1, { op: 'abort' });
  h.hooks.publish({ v: 1, event: 'SessionEnd', ts: h.clock.now(), session_id: S1, agent: { id: 'a1', type: 'Explore' } });
  assert.equal(h.bridge.attached(S1), true, 'an agent\'s SessionEnd');
  h.hooks.publish({ v: 1, event: 'SessionEnd', ts: h.clock.now(), session_id: S1, agent: null });
  assert.equal(h.bridge.attached(S1), false);
  assert.deepEqual(changes, [{ session_id: S1, attached: false, reason: 'session-end' }]);
  assert.deepEqual(await pending, { ok: false, refused: 'detached', hint: 'the mod detached from that session', delivered: false });
});

test('lifecycle: a mirror process-gone naming the session detaches it', async (t) => {
  const h = setup(t);
  h.attach(S1);
  h.attach(S2);
  h.mirror.emit({ kind: 'mirror', op: 'process-gone', conversation_id: 'c1', session_ids: [S2.toUpperCase()], pid: 4242 });
  assert.equal(h.bridge.attached(S1), true);
  assert.equal(h.bridge.attached(S2), false);
  assert.ok(h.logLines().some((l) => l.what === 'detach' && l.session_id === S2 && l.reason === 'process-gone'));
});

test('lifecycle: no poll for 60 s detaches the session; a waiting poll keeps it', async (t) => {
  const h = setup(t);
  const t1 = h.attach(S1);
  const t2 = h.attach(S2);
  const changes = [];
  h.bridge.onChange((c) => changes.push(c));
  h.bridge.poll(t2, { waitMs: 20000 });
  await h.clock.advance(19990);
  h.bridge.poll(t2, { waitMs: 20000 });
  await h.clock.advance(19990);
  h.bridge.poll(t2, { waitMs: 20000 });
  await h.clock.advance(19990);
  h.bridge.poll(t2, { waitMs: 20000 });
  await h.clock.advance(10100);
  assert.equal(h.bridge.attached(S1), false, 'no poll since its hello, 70 s ago (the 10 s sweep)');
  assert.equal(h.bridge.attached(S2), true);
  assert.deepEqual(changes, [{ session_id: S1, attached: false, reason: 'stale' }]);
  assert.equal((await h.bridge.poll(t1)).body.refused, 'detached');
});

test('lifecycle: every attach and detach fires onChange; sessionOf answers the conversation\'s attached session', (t) => {
  const h = setup(t);
  h.mirror.conv.set(S1, 'c1');
  h.mirror.conv.set(S2, 'c1');
  const changes = [];
  const off = h.bridge.onChange((c) => changes.push(c));
  assert.equal(h.bridge.sessionOf('c1'), null);
  h.attach(S1);
  assert.equal(h.bridge.sessionOf('c1'), S1);
  h.attach(S2);
  assert.equal(h.bridge.sessionOf('c1'), S2, 'the most recently attached');
  assert.equal(h.bridge.sessionOf(S1), S2, 'a session id resolves through its conversation');
  assert.equal(h.bridge.sessionOf('c-other'), null);
  h.hooks.publish({ v: 1, event: 'SessionEnd', ts: 1, session_id: S2 });
  assert.equal(h.bridge.sessionOf('c1'), S1);
  assert.deepEqual(changes.map((c) => [c.session_id, c.attached, c.reason]), [[S1, true, 'hello'], [S2, true, 'hello'], [S2, false, 'session-end']]);
  off();
  h.attach(S2);
  assert.equal(changes.length, 3);
});

test('lifecycle: stop() answers every waiter, resolves every pending enqueue stopped, leaves no timer, is idempotent and already settled', async (t) => {
  const h = setup(t);
  const token = h.attach();
  const h2 = h.attach(S2);
  const waiter = h.bridge.poll(token, { waitMs: 20000 });
  const queued = h.bridge.enqueue(S2, { op: 'abort' });
  const taken = h.bridge.enqueue(S1, { op: 'usage' });
  // The waiting S1 poll took `usage` at once; it now awaits its result.
  const first = await waiter;
  assert.equal(first.body.ops[0].op, 'usage');
  const waiting = h.bridge.poll(token, { waitMs: 20000 });
  h.bridge.events(h2, { events: [{ kind: 'turn.start', at: h.clock.now(), turn_id: 'z' }] });
  let state = 'pending';
  const p = h.bridge.stop();
  p.then(() => { state = 'settled'; });
  await null;
  assert.equal(state, 'settled', 'already settled: nothing to await after the registry release');
  assert.deepEqual(await waiting, { status: 200, body: { ok: true, ops: [] } });
  assert.equal((await queued).refused, 'stopped');
  assert.deepEqual(await taken, { ok: false, refused: 'stopped', hint: 'the web-chat server is shutting down', delivered: true });
  assert.equal(h.clock.pending(), 0, 'no timer left');
  await settle();
  assert.equal(h.published.length, 0, 'the drain that was queued never ran');
  assert.equal(h.bridge.any(), false);
  await h.bridge.stop();
  assert.equal((await h.bridge.enqueue(S1, { op: 'abort' })).refused, 'stopped');
  assert.equal(h.bridge.hello(h.helloBody()).status, 503);
  assert.deepEqual((await h.bridge.poll(token)).body.ops, []);
});

// ── what is reported and logged ──────────────────────────────────────────────

test('status() holds no token, no op args and no event text', async (t) => {
  const h = setup(t);
  const token = h.attach();
  h.bridge.enqueue(S1, { op: 'submit', args: { text: 'SECRET-PROMPT-TEXT' } });
  h.bridge.enqueue(S1, { op: 'command', args: { name: 'rename', args: 'SECRET-NAME' } });
  h.bridge.events(token, { events: [{ kind: 'turn.complete', at: h.clock.now(), turn_id: 't', text: 'SECRET-REPLY-TEXT' }] });
  await settle();
  const s = JSON.stringify(h.bridge.status());
  for (const needle of [token, 'SECRET-PROMPT-TEXT', 'SECRET-NAME', 'SECRET-REPLY-TEXT']) assert.ok(!s.includes(needle), needle);
  assert.equal(h.bridge.status().sessions[0].queued, 2);
});

test('the bridge log: one line per hello, refusal, detach and settled op — never args, text or a token', async (t) => {
  const h = setup(t);
  const token = h.attach();
  h.bridge.hello(h.helloBody({ session_id: S2, cc_version: '2.1.0' }));
  const done = h.bridge.enqueue(S1, { op: 'submit', args: { text: 'SECRET-PROMPT' } });
  const [op] = (await h.bridge.poll(token)).body.ops;
  h.clock.tick(120);
  h.bridge.result(token, { id: op.id, ok: true, result: { said: 'SECRET-RESULT' } });
  await done;
  h.bridge.events(token, { events: [{ kind: 'session.end', at: h.clock.now(), reason: 'exit' }] });
  await settle();
  const lines = h.logLines();
  assert.deepEqual(lines.map((l) => l.what), ['hello', 'refused', 'op', 'detach']);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'cc_version', 'mod_version', 'session_id', 'what']);
  assert.deepEqual(lines[1], { at: lines[1].at, what: 'refused', session_id: S2, outcome: 'too-old' });
  assert.deepEqual(lines[2], { at: lines[2].at, what: 'op', session_id: S1, op: 'submit', outcome: 'ok', ms: 120 });
  assert.deepEqual(lines[3], { at: lines[3].at, what: 'detach', session_id: S1, reason: 'session-end' });
  const raw = fs.readFileSync(h.logFile, 'utf8');
  for (const needle of [token, 'SECRET-PROMPT', 'SECRET-RESULT']) assert.ok(!raw.includes(needle), needle);
  assert.ok(!h.logs.join('\n').includes(token), 'nor the server log');
});

test('the bridge log moves to bridge.log.1 past 1 MiB', (t) => {
  const h = setup(t);
  fs.mkdirSync(path.dirname(h.logFile), { recursive: true });
  fs.writeFileSync(h.logFile, `${'x'.repeat(LOG_MAX_BYTES)}\n`);
  h.attach();
  assert.equal(fs.statSync(`${h.logFile}.1`).size, LOG_MAX_BYTES + 1);
  assert.deepEqual(h.logLines().map((l) => l.what), ['hello']);
});

test('the bridge log is not written once .web-chat/ has been removed: a hello or detach re-creates no directory', async (t) => {
  const h = setup(t);
  const dir = projectPaths(h.root).dir;
  fs.rmSync(dir, { recursive: true, force: true });
  h.bridge.hello(h.helloBody({ root: path.join(h.root, 'nope', '..') }));
  // The project is now "not installed" to the toggle (no .web-chat/): disabled.
  assert.equal(fs.existsSync(dir), false, 'the refusal wrote nothing');
  // An attached session detaching after the removal writes nothing either.
  fs.mkdirSync(dir);
  h.attach();
  fs.rmSync(dir, { recursive: true, force: true });
  h.mirror.emit({ kind: 'mirror', op: 'process-gone', session_ids: [S1] });
  assert.equal(h.bridge.attached(S1), false);
  await h.bridge.stop();
  assert.equal(fs.existsSync(dir), false);
});
