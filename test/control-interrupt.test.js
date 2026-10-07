// The interrupt (lib/server/control/interrupt.js, spec §15.2, Q-B; rulings B2
// (a) and U81-U85-U86@click-token): its paths, the one control event, the
// limiter, the halt flag's life, the halt script reading a flag this module
// wrote, the Stop layout's state view and its long-poll.
//
// Everything runs through control.invoke('interrupt', …) — the pipeline the
// answer origin's gate calls — with a fake mirror facade, a real change bus and
// a sandboxed HOME. One case drives a REAL createMirror over the same bus, to
// pin that the event's shape is U12b's: the facade stamps ended_by 'web' for a
// tty interrupt and 'hook' for a halt on the turn closed next.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { withTempHome, tmpRoot } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createBus } = require('../lib/core/bus');
const { userPaths, PACKAGE_ROOT } = require('../lib/core/paths');
const { createHookTap } = require('../lib/server/hook-tap');
const { createRedactor } = require('../lib/core/redact');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createControl } = require('../lib/server/control');
const { HALT_TTL_S, TTY_EXPIRY_MS, INTERRUPT_GAP_MS } = require('../lib/server/control/interrupt');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const HALT_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh');

function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

function fakeMirror(conversations) {
  const subs = new Set();
  const m = {
    conversations,
    snapshot: () => ({ conversations: m.conversations }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ev) { for (const fn of [...subs]) fn({ kind: 'mirror', ...ev }); },
    set(id, patch) {
      m.conversations = m.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c));
    },
  };
  return m;
}

function conv(id, { state = 'working', sid = S1, pid = 4242, interrupt = 'tty', name = 'fix the tests' } = {}) {
  return { id, name, current_session_id: sid, process: pid ? { pid, interrupt } : null, live: { state } };
}

// The control domain over a fake mirror and a real bus; frames are recorded.
async function rig(t, { conversations, clock = fakeClock(), start = true } = {}) {
  const home = withTempHome(t);
  const root = tmpRoot('wc-interrupt-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bus = createBus();
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  const events = [];
  bus.subscribe((e) => events.push(e));
  const mirror = fakeMirror(conversations || [conv('c1'), conv('c2', { sid: S2, pid: 4343 })]);
  const control = createControl({ root, bus, mirror, now: clock.now });
  t.after(() => control.stop());
  if (start) await control.start();
  const controls = () => events.filter((e) => e.kind === 'control');
  const flagOf = (sid) => userPaths().haltFlag(sid);
  return { home, root, bus, frames, events, controls, mirror, control, clock, flagOf };
}

const interrupt = (control, target, ctx = {}) => control.invoke('interrupt', { mode: 'now', ...target }, ctx);

// ── the paths ───────────────────────────────────────────────────────────────

test('tty: a working conversation whose process says tty → one control event via tty, target_pid, a 2 s expiry, no flag', async (t) => {
  const r = await rig(t);
  const a = await interrupt(r.control, { conversation_id: 'c1' });
  assert.deepEqual([a.ok, a.accepted, a.via], [true, true, 'tty']);
  const [e, ...more] = r.controls();
  assert.equal(more.length, 0, 'exactly one event');
  assert.deepEqual(
    { ...e, seq: 0, ts: 0 },
    { seq: 0, ts: 0, kind: 'control', op: 'interrupt', id: a.request_id, conversation_id: 'c1', session_id: S1, via: 'tty', target_pid: 4242, expires_at: r.clock.now() + TTY_EXPIRY_MS },
  );
  assert.equal(TTY_EXPIRY_MS, 2000);
  assert.equal(fs.existsSync(r.flagOf(S1)), false, 'no flag written');
  assert.deepEqual(r.frames, [], 'never a ws frame');
});

test('hook: the same request marked remote writes the halt flag (floor(now/1000) + 1800) and the event is via hook, in seconds', async (t) => {
  const r = await rig(t);
  const a = await interrupt(r.control, { conversation_id: 'c1' }, { remote: true, device: 'mobile' });
  assert.deepEqual([a.ok, a.via], [true, 'hook']);
  const expiry = Math.floor(r.clock.now() / 1000) + HALT_TTL_S;
  assert.equal(HALT_TTL_S, 1800);
  assert.equal(fs.readFileSync(r.flagOf(S1), 'utf8'), String(expiry), 'the digits the halt script reads');
  const [e] = r.controls();
  assert.deepEqual([e.via, e.expires_at, 'target_pid' in e, e.session_id], ['hook', expiry, false, S1]);
  assert.deepEqual(r.frames, []);
  // The audit says where it came from.
  const line = JSON.parse(fs.readFileSync(path.join(r.root, '.web-chat', 'control', 'audit.log'), 'utf8').trim());
  assert.deepEqual([line.via, line.origin, line.device], ['hook', 'remote', 'mobile']);
});

test("mode 'after-step' always takes the hook; no session id and no tty → 'no-path'; idle → 'not-busy'; unknown → 'unknown'", async (t) => {
  const r = await rig(t, {
    conversations: [conv('c1'), conv('c3', { sid: null, pid: null }), conv('c4', { state: 'idle' }), conv('c5', { sid: null, pid: 99, interrupt: null })],
  });
  const a = await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  assert.equal(a.via, 'hook', 'a tty-capable conversation still halts after the step');
  assert.ok(fs.existsSync(r.flagOf(S1)));
  assert.deepEqual(await interrupt(r.control, { conversation_id: 'c3' }), { ok: false, refused: 'no-path', hint: 'this conversation can be stopped only in its terminal' });
  assert.equal((await interrupt(r.control, { conversation_id: 'c5' })).refused, 'no-path', 'a process without tty and no session');
  assert.equal((await interrupt(r.control, { conversation_id: 'c4' })).refused, 'not-busy');
  assert.equal((await interrupt(r.control, { conversation_id: 'nope' })).refused, 'unknown');
  assert.equal(r.controls().length, 1, 'refusals emit nothing');
  for (const state of ['compacting', 'question', 'waiting']) {
    r.mirror.set('c4', { live: { state } });
    r.clock.tick(INTERRUPT_GAP_MS + 1);
    assert.equal((await interrupt(r.control, { conversation_id: 'c4' })).ok, true, `${state} is busy`);
  }
});

test('the limiter: a second interrupt within 1.5 s is rate_limited with no event; 1.6 s later accepted; a refusal starts no window; another conversation is free', async (t) => {
  const r = await rig(t);
  assert.equal(INTERRUPT_GAP_MS, 1500);
  // A refused 'not-busy' does not start the window.
  r.mirror.set('c1', { live: { state: 'idle' } });
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).refused, 'not-busy');
  r.mirror.set('c1', { live: { state: 'working' } });
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).ok, true, 'the refusal left no window');
  r.clock.tick(1000);
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).refused, 'rate_limited');
  assert.equal(r.controls().length, 1, 'no second event');
  assert.equal((await interrupt(r.control, { conversation_id: 'c2' })).ok, true, 'another conversation is not limited');
  r.clock.tick(600);
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).ok, true, '1.6 s after the first');
  assert.equal(r.controls().length, 3);
});

// ── the event's shape, read by a real mirror facade ─────────────────────────

const LIVE_ONLY = SOURCES.filter((s) => s.name === 'live');

async function realMirror(t) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-ctl-facade-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  let ts = Date.now();
  mirror = createMirror({
    root, hooks, mainBus, mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: LIVE_ONLY,
  });
  const closes = [];
  mirror.subscribe((e) => { if (e.op === 'turn-closed') closes.push(e); });
  await mirror.start();
  const env = (event, extra = {}) => ({
    v: 1, event, ts: (ts += 1), session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  const publish = (event, extra) => hooks.publish(env(event, extra));
  const prompt = (pid) => publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text: `prompt ${pid}` } });
  publish('SessionStart', { session: { source: 'startup' } });
  return { root, mirror, mainBus, closes, prompt };
}

for (const [via, endedBy, patch, ctx] of [
  ['tty', 'web', { pid: 4242, interrupt: 'tty' }, {}],
  ['hook', 'hook', null, { remote: true }],
]) {
  test(`a real createMirror reads the event: via ${via} stamps ended_by '${endedBy}' on the turn closed next${via === 'hook' ? ', and the flag goes with it' : ''}`, async (t) => {
    const h = await realMirror(t);
    h.prompt('pA');
    const live = () => h.mirror.snapshot({ level: 'local' }).conversations[0];
    assert.ok(live(), 'the conversation is mirrored');
    // The facade's own conversation, with the process row an MCP probe would give.
    const facade = {
      snapshot: (o) => {
        const s = h.mirror.snapshot(o);
        return { ...s, conversations: s.conversations.map((c) => ({ ...c, process: patch ? { ...(c.process || {}), ...patch } : c.process })) };
      },
      subscribe: (fn) => h.mirror.subscribe(fn),
    };
    const control = createControl({ root: h.root, bus: h.mainBus, mirror: facade });
    t.after(() => control.stop());
    await control.start();
    const c = live();
    assert.ok(['working', 'compacting', 'question', 'waiting'].includes(c.live.state), `busy: ${c.live.state}`);
    const a = await control.invoke('interrupt', { conversation_id: c.id, mode: 'now' }, ctx);
    assert.equal(a.via, via, JSON.stringify(a));
    if (via === 'hook') assert.ok(fs.existsSync(userPaths().haltFlag(S1)), 'the flag is written');
    h.prompt('pB'); // the next prompt with no Stop closes pA interrupted
    const closed = h.closes.find((e) => e.turn_id === 'pA');
    assert.ok(closed, 'pA closed');
    assert.equal(closed.ended_by, endedBy);
    assert.equal(h.mirror.liveOf(S1).last_turn.ended_by, endedBy);
    assert.equal(fs.existsSync(userPaths().haltFlag(S1)), false, 'no flag outlives the turn');
  });
}

// ── the halt flag's life ────────────────────────────────────────────────────

test("the halt flag is removed on the mirror's turn-closed for its session, and on a process-gone naming it", async (t) => {
  const r = await rig(t);
  await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  await interrupt(r.control, { conversation_id: 'c2', mode: 'after-step' });
  assert.ok(fs.existsSync(r.flagOf(S1)) && fs.existsSync(r.flagOf(S2)));
  r.mirror.emit({ op: 'turn-closed', conversation_id: 'c2', session_id: S2, turn_id: 'p1', outcome: 'done', by: 'stop' });
  assert.equal(fs.existsSync(r.flagOf(S2)), false, 'turn-closed for its session');
  assert.ok(fs.existsSync(r.flagOf(S1)), 'another session keeps its flag');
  r.mirror.emit({ op: 'process-gone', conversation_id: 'c1', session_ids: [S1], pid: 4242 });
  assert.equal(fs.existsSync(r.flagOf(S1)), false, 'process-gone naming it');
  assert.deepEqual(r.control.interrupt.flags(), []);
});

test('stop() removes the flags this control wrote; start sweeps an expired flag and keeps a live one (another daemon\'s)', async (t) => {
  const r = await rig(t, { start: false });
  const dir = userPaths().haltDir;
  fs.mkdirSync(dir, { recursive: true });
  const nowS = Math.floor(r.clock.now() / 1000);
  const OLD = '33333333-3333-4333-8333-333333333333';
  const LIVE = '44444444-4444-4444-8444-444444444444';
  const ODD = '55555555-5555-4555-8555-555555555555';
  fs.writeFileSync(path.join(dir, OLD), String(nowS - 5));
  fs.writeFileSync(path.join(dir, LIVE), String(nowS + 600));
  fs.writeFileSync(path.join(dir, ODD), '{"not":"a flag"}');
  fs.writeFileSync(path.join(dir, 'not a session'), String(nowS - 5));
  await r.control.start();
  assert.equal(fs.existsSync(path.join(dir, OLD)), false, 'expired: swept');
  assert.ok(fs.existsSync(path.join(dir, LIVE)), "live: another daemon's, kept");
  assert.ok(fs.existsSync(path.join(dir, ODD)), 'not a flag this format knows: kept');
  assert.ok(fs.existsSync(path.join(dir, 'not a session')), 'not a session name: never touched');

  await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  assert.ok(fs.existsSync(r.flagOf(S1)));
  await r.control.stop();
  assert.equal(fs.existsSync(r.flagOf(S1)), false, 'the flags this control wrote go at stop()');
  assert.ok(fs.existsSync(path.join(dir, LIVE)), 'the other daemon\'s live flag stays');
});

test('a symlink named like a session is never followed, read or removed — by the sweep or by a removal', async (t) => {
  const r = await rig(t, { start: false });
  const dir = userPaths().haltDir;
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(r.home, 'precious.txt');
  fs.writeFileSync(outside, '1'); // an "expired flag" body, behind a link
  const LINK = '66666666-6666-4666-8666-666666666666';
  fs.symlinkSync(outside, path.join(dir, LINK));
  await r.control.start();
  assert.ok(fs.lstatSync(path.join(dir, LINK)).isSymbolicLink(), 'the link stays');
  assert.equal(fs.readFileSync(outside, 'utf8'), '1', 'its target is untouched');

  // A flag written over a planted link replaces the link, never writes through it.
  fs.symlinkSync(outside, r.flagOf(S1));
  await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  assert.equal(fs.readFileSync(outside, 'utf8'), '1', 'the write did not follow the link');
  assert.ok(fs.lstatSync(r.flagOf(S1)).isFile());
  // …and a removal unlinks only a regular file.
  fs.unlinkSync(r.flagOf(S1));
  fs.symlinkSync(outside, r.flagOf(S1));
  r.mirror.emit({ op: 'turn-closed', conversation_id: 'c1', session_id: S1, turn_id: 'p1', outcome: 'interrupted', by: 'status' });
  assert.ok(fs.lstatSync(r.flagOf(S1)).isSymbolicLink(), 'a link where the flag was is left alone');
  assert.ok(fs.existsSync(outside));
});

test('the halt script prints its halt for a session whose flag interrupt.js wrote, and nothing once the flag is removed', async (t) => {
  const r = await rig(t, { clock: fakeClock(Date.now()) });
  await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  const fire = (event) => spawnSync('sh', [HALT_SCRIPT, event], {
    env: { PATH: process.env.PATH, HOME: r.home, CLAUDE_CODE_SESSION_ID: S1 },
    input: '{}', encoding: 'utf8', timeout: 10_000,
  });
  const pre = fire('pre');
  assert.equal(pre.status, 0);
  const out = JSON.parse(pre.stdout);
  assert.equal(out.continue, false);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(fire('post').stdout).continue, false);
  r.mirror.emit({ op: 'turn-closed', conversation_id: 'c1', session_id: S1, turn_id: 'p1', outcome: 'interrupted', by: 'status' });
  const after = fire('pre');
  assert.deepEqual([after.status, after.stdout], [0, ''], 'nothing once removed');
});

// ── the Stop layout's state view ────────────────────────────────────────────

function captureSurface() {
  const s = { spec: null };
  s.register = (kind, spec) => { s.spec = spec; return () => { s.spec = null; }; };
  s.ensure = async () => ({ port: 1 });
  return s;
}

// Drive GET /answer/api/control/state through the registered api with a fake
// res and kit: what the surface does after its gate.
function stateRead(surface, query, { remote = false } = {}) {
  return new Promise((resolve) => {
    const res = { writableEnded: false, destroyed: false };
    const kit = { json: (_res, status, body) => { res.writableEnded = true; resolve({ status, body }); } };
    const req = { method: 'GET', headers: remote ? { 'x-wc-remote': '1' } : {} };
    surface.spec.api(req, res, kit, { rest: 'state', query, body: null });
  });
}

async function viewRig(t, opts = {}) {
  const home = withTempHome(t);
  const root = tmpRoot('wc-view-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = fakeClock();
  const mirror = fakeMirror(opts.conversations || [conv('c1')]);
  const surface = captureSurface();
  const control = createControl({ root, bus: createBus(), mirror, answerSurface: surface, now: clock.now });
  t.after(() => control.stop());
  await control.start();
  return { home, root, clock, mirror, surface, control };
}

test('the state view: its fields, the path for this requester, and v bumping on a request and on the mirror\'s transition', async (t) => {
  const r = await viewRig(t);
  const v0 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.deepEqual({ ...v0, v: 0 }, {
    v: 0, conversation_id: 'c1', state: 'working', active: true, waiting: false,
    path: 'tty', label: 'Interrupt', last: null,
  });
  const remote = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' }, { remote: true })).body;
  assert.deepEqual([remote.path, remote.label, remote.v], ['hook', 'Stop after this step', v0.v], 'a remote requester never gets tty; v is not per requester');

  const a = await interrupt(r.control, { conversation_id: 'c1' });
  const v1 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.ok(v1.v > v0.v, 'v bumps on a request');
  assert.deepEqual(v1.last, { request_id: a.request_id, via: 'tty', at: r.clock.now(), outcome: 'pending' });

  r.mirror.set('c1', { live: { state: 'idle' } });
  r.mirror.emit({ op: 'state', conversation_id: 'c1', state: 'idle', prev: 'working' });
  const v2 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.ok(v2.v > v1.v, "v bumps on the mirror's transition");
  assert.deepEqual([v2.active, v2.last.outcome], [false, 'interrupted'], 'pending → interrupted when the state leaves the active set');

  // waiting: a pending prompt, which an Esc declines.
  r.mirror.set('c1', { live: { state: 'waiting' } });
  assert.equal((await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body.waiting, true);
  // A turn closed interrupted settles a later request; a process gone ends one.
  r.clock.tick(INTERRUPT_GAP_MS + 1);
  await interrupt(r.control, { conversation_id: 'c1' });
  r.mirror.emit({ op: 'process-gone', conversation_id: 'c1', session_ids: [S1], pid: 4242 });
  assert.equal((await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body.last.outcome, 'ended');
  // An unknown action, or one with no state view, is 404; a bad target 400.
  assert.equal((await stateRead(r.surface, { action: 'nothing', conversation_id: 'c1' })).status, 404);
  assert.equal((await stateRead(r.surface, { action: 'interrupt', conversation_id: '../x' })).status, 400);
});

test('the long-poll returns at the change and at its wait cap; stop() releases every waiter and leaves no timer', async (t) => {
  const r = await viewRig(t);
  const first = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  // At the change.
  const t0 = Date.now();
  const waiting = stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1', v: String(first.v), wait: '20000' });
  await new Promise((res) => setImmediate(res));
  r.mirror.set('c1', { live: { state: 'idle' } });
  r.mirror.emit({ op: 'state', conversation_id: 'c1', state: 'idle', prev: 'working' });
  const changed = await waiting;
  assert.ok(Date.now() - t0 < 5000, 'returned at the change, not the cap');
  assert.ok(changed.body.v > first.v);
  assert.equal(changed.body.state, 'idle');
  // At the wait cap, unchanged.
  const t1 = Date.now();
  const capped = await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1', v: String(changed.body.v), wait: '150' });
  assert.ok(Date.now() - t1 >= 140, 'held to its wait');
  assert.equal(capped.body.v, changed.body.v);
  // stop() releases what still waits, at once.
  const held = [1, 2, 3].map(() => stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1', v: String(changed.body.v), wait: '20000' }));
  await new Promise((res) => setImmediate(res));
  const t2 = Date.now();
  await r.control.stop();
  const released = await Promise.all(held);
  assert.ok(Date.now() - t2 < 1000, 'released at stop()');
  assert.ok(released.every((x) => x.status === 200));
  // The test file ends with no handle open: a 20 s timer left behind would hold
  // the runner past its own end.
});
