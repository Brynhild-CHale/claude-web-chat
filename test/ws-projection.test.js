// What each WebSocket gets (lib/server/ws.js, spec §5.4): every `mirror:*`
// frame projected per socket by its level and posture (lib/core/remote-policy
// FRAME_RULES / projectFrame), the graph's conversation text taken off the
// hello, reset, lock and node-added frames of a socket below `read`
// (TEXT_RULES), backpressure on the stream, a level change told to the socket
// it moved (mirror:access) — and a local socket's frames exactly the bytes they
// were before any of this.
//
// The sockets are real `ws` clients against the real attachWebSocket, on a
// bare loopback http server with a real audience (lib/server/audience) over a
// scratch tunnel.json. A remote viewer connects as the portal's relay does,
// with `X-WC-Remote: 1` from loopback; a network peer is a stubbed
// `req.socket.remoteAddress` on its upgrade (spec §10.1). The last test boots
// the real daemon (withServer): with the server's audience or without one, a
// project that has not opted in holds a remote viewer to the heartbeat.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { createBus } = require('../lib/core/bus');
const { createState } = require('../lib/server/state');
const { createAudience } = require('../lib/server/audience');
const { attachWebSocket, STREAM_HOLD_BYTES, STREAM_RESUME_BYTES } = require('../lib/server/ws');

// ── the rig ─────────────────────────────────────────────────────────────────

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

// A scratch project and its tunnel.json; `optIn(level)` writes this project's
// opt-in ('read' | 'full'), or none.
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wsproj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const configFile = path.join(dir, 'tunnel', 'tunnel.json');
  const optIn = (level) => writeJsonAtomic(configFile, level ? { ...TUNNEL, remote: { mirror: { [root]: level } } } : { ...TUNNEL });
  return { root, configFile, optIn };
}

// attachWebSocket on a bare loopback http server, with a real audience (pass
// `audience: false` for none). An upgrade that carries x-test-peer comes from
// that address instead: its socket's remoteAddress is stubbed before the
// upgrade is handled (spec §10.1's network peer).
async function wsHost(t, { optIn, audience } = {}) {
  const s = scratch(t);
  if (optIn !== undefined) s.optIn(optIn);
  const aud = audience === false ? undefined
    : audience || createAudience({ root: s.root, configFile: s.configFile, pollMs: 25 });
  if (aud) t.after(() => aud.stop());
  const state = createState();
  const graph = { active: null, nodes: new Map(), lock: null };
  const bus = createBus();
  const httpServer = http.createServer((r, res) => { res.statusCode = 404; res.end(); });
  httpServer.prependListener('upgrade', (r) => {
    const addr = r.headers['x-test-peer'];
    if (addr) Object.defineProperty(r.socket, 'remoteAddress', { value: addr, configurable: true });
  });
  const api = attachWebSocket(httpServer, { state, graph, paths: null, bus, projectName: 'proj', audience: aud });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    api.shutdown();
    api.terminate();
    httpServer.closeAllConnections();
    httpServer.close(r);
  }));
  return { ...s, api, state, graph, bus, audience: aud, port: httpServer.address().port };
}

// A socket that records every message it gets, raw and parsed. `headers` are
// sent on its upgrade (X-WC-Remote, x-test-peer). Resolves once its hello is in.
async function connect(t, host, headers) {
  const ws = wsConnect(host.port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const raw = [];
  const frames = [];
  ws.on('message', (d) => {
    const text = d.toString();
    raw.push(text);
    try { frames.push(JSON.parse(text)); } catch {}
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: 10000, interval: 5, what: 'the hello' });
  // The server's end of it: the one socket that joined last.
  const server = [...host.api.clients].at(-1);
  return { ws, raw, frames, server, of: (type) => frames.filter((f) => f.type === type) };
}

// Sets a socket's posture as the chrome does (its `client` frame's `mirror`)
// and waits until the server has it.
async function posture(c, value) {
  c.ws.send(JSON.stringify({ type: 'client', device: 'desktop', ...(value === undefined ? {} : { mirror: value }) }));
  const want = value === 'full' ? 'full' : 'status';
  await waitUntil(() => c.server._wc.posture === want, { timeout: 10000, interval: 5, what: `the posture ${want}` });
}

// Sends a plain marker frame to every socket and waits until each has it.
// Frames arrive in order, so a frame sent before the marker that a socket
// does not have by then was never sent to it.
let markSeq = 0;
async function settle(host, sockets) {
  const n = ++markSeq;
  host.api.broadcast({ type: 'test:mark', n });
  await waitUntil(() => sockets.every((c) => c.frames.some((f) => f.type === 'test:mark' && f.n === n)),
    { timeout: 15000, interval: 5, what: `marker ${n} on every socket` });
}

// The frames a socket got that are not the rig's own.
const mirrorFrames = (c) => c.frames.filter((f) => typeof f.type === 'string' && f.type.startsWith('mirror:'));

// One of each mirror frame, with content a basic viewer must never get.
const FRAMES = Object.freeze({
  status: { type: 'mirror:status', rev: 3, now: 1700000000000, aggregate: { state: 'working' }, secret: 'not in the schema',
    conversations: [{ id: 'c1', state: 'working', since: 1, quiet: false, step_kind: 'Edit · lib/x.js', waiting_kind: null,
      last_activity_at: 2, counts: { shells: 1, agents: 0 }, title: 'a session title' }] },
  update: { type: 'mirror:update', rev: 3, now: 1, conversation_id: 'c1', live: { step: { label: 'Edit · lib/x.js' } } },
  stream: { type: 'mirror:stream', rev: 3, now: 1, conversation_id: 'c1', items: [{ id: 'i1', text: 'the reply' }] },
  reset: { type: 'mirror:reset', reason: 'rebuilt', conversation_id: 'c1', detail: 'not in the schema' },
  ask: { type: 'mirror:ask', op: 'open', ask: { id: 'ask_1', conversation_id: 'c1', kind: 'permission', tool_kind: 'Bash',
    state: 'pending', subject: 'rm -rf dist' } },
  future: { type: 'mirror:future', text: 'a frame type no FRAME_RULES row names' },
});
// What a basic socket gets of them: the typed projections, and nothing else.
const BASIC = Object.freeze({
  status: { type: 'mirror:status', rev: 3, now: 1700000000000, aggregate: { state: 'working' },
    conversations: [{ id: 'c1', state: 'working', since: 1, quiet: false, waiting_kind: null, last_activity_at: 2,
      counts: { shells: 1, agents: 0 } }] },
  reset: { type: 'mirror:reset', reason: 'rebuilt', conversation_id: 'c1' },
  ask: { type: 'mirror:ask', op: 'open', ask: { id: 'ask_1', conversation_id: 'c1', kind: 'permission', tool_kind: 'Bash', state: 'pending' } },
});

// ── projection ──────────────────────────────────────────────────────────────

test('a local socket gets every mirror frame whole; a basic socket only the typed status, reset, access and ask', async (t) => {
  const host = await wsHost(t);
  const local = await connect(t, host);
  const remote = await connect(t, host, { 'X-WC-Remote': '1' });
  const network = await connect(t, host, { 'x-test-peer': '10.0.0.7', 'X-WC-Remote': '1' });
  for (const c of [local, remote, network]) await posture(c, 'full');
  assert.deepStrictEqual([local, remote, network].map((c) => c.server._wc.level), ['local', 'basic', 'basic']);
  assert.deepStrictEqual([local, remote, network].map((c) => c.server._wc.peer), ['local', 'remote', 'network']);

  const access = { type: 'mirror:access', level: 'basic', remote: true };
  for (const f of [FRAMES.status, FRAMES.update, FRAMES.stream, FRAMES.reset, access, FRAMES.ask, FRAMES.future]) {
    host.api.broadcast(f);
  }
  await settle(host, [local, remote, network]);

  assert.deepStrictEqual(mirrorFrames(local),
    [FRAMES.status, FRAMES.update, FRAMES.stream, FRAMES.reset, access, FRAMES.ask, FRAMES.future],
    'a local socket at the full posture: every frame, whole — even a type no row names');
  for (const c of [remote, network]) {
    assert.deepStrictEqual(mirrorFrames(c), [BASIC.status, BASIC.reset, access, BASIC.ask],
      `${c.server._wc.peer}: the typed projections only — no update, stream or unknown type, no text`);
    assert.ok(!c.raw.some((s) => s.includes('lib/x.js') || s.includes('rm -rf') || s.includes('the reply')
      || s.includes('session title') || s.includes('not in the schema')), 'no text of any kind');
  }
});

test('a read or full viewer gets the conversation; mirror:stream only while its chat is open — local sockets too', async (t) => {
  const host = await wsHost(t, { optIn: 'read' });
  const local = await connect(t, host);
  const reader = await connect(t, host, { 'X-WC-Remote': '1' });
  assert.equal(reader.server._wc.level, 'read');

  host.api.broadcast(FRAMES.status);
  host.api.broadcast(FRAMES.update);
  host.api.broadcast(FRAMES.stream);
  await settle(host, [local, reader]);
  for (const c of [local, reader]) {
    assert.deepStrictEqual(mirrorFrames(c), [FRAMES.status, FRAMES.update],
      'the status posture (the default): everything but the stream, whole');
  }

  await posture(local, 'full');
  await posture(reader, 'full');
  host.api.broadcast(FRAMES.stream);
  await settle(host, [local, reader]);
  for (const c of [local, reader]) assert.deepStrictEqual(c.of('mirror:stream'), [FRAMES.stream], 'a chat view is open: the stream');

  await posture(reader, 'status');     // `mirror: 'status'`
  await posture(local, undefined);      // a client frame with no `mirror` at all
  host.api.broadcast(FRAMES.stream);
  await settle(host, [local, reader]);
  for (const c of [local, reader]) assert.equal(c.of('mirror:stream').length, 1, 'closed again: no more stream');
});

test('a local socket\'s frames are the bytes of the frame itself — every kind, every posture', async (t) => {
  const host = await wsHost(t, { optIn: 'full' });
  host.graph.lock = { base: null, started_at: Date.now(), message: 'a prompt', author: 'user' };
  const local = await connect(t, host);
  await posture(local, 'full');
  const sent = [
    { type: 'store:patch', patch: { a: 'ü', n: 1 } },
    { type: 'lock', lock: { ...host.graph.lock, stale: false } },
    { type: 'node-added', node: { id: 'n1', label: 'n1.1', trigger_summary: 'a prompt' }, active: 'n1' },
    FRAMES.status, FRAMES.update, FRAMES.stream, FRAMES.reset, FRAMES.ask, FRAMES.future,
  ];
  const before = local.raw.length;
  for (const f of sent) host.api.broadcast(f);
  await settle(host, [local]);
  assert.deepStrictEqual(local.raw.slice(before, before + sent.length), sent.map((f) => JSON.stringify(f)));
  // The hello too: exactly what the unprojected frame serializes to.
  const hello = JSON.parse(local.raw[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.lock.message, 'a prompt');
  assert.equal(local.raw[0], JSON.stringify(hello));
});

test('one serialization per distinct result, however many sockets get it', async (t) => {
  const host = await wsHost(t, { optIn: 'read' });
  const sockets = [
    await connect(t, host), await connect(t, host), await connect(t, host),              // local
    await connect(t, host, { 'X-WC-Remote': '1' }), await connect(t, host, { 'X-WC-Remote': '1' }), // read
    await connect(t, host, { 'x-test-peer': '10.0.0.7' }), await connect(t, host, { 'x-test-peer': '10.0.0.8' }), // basic
  ];
  await posture(sockets[0], 'full');
  await posture(sockets[5], 'full');
  // Count the serializations one broadcast makes of its frame (and of its
  // projections, which keep its type). The broadcast is synchronous, so the
  // spy sees nothing else.
  const count = (frame) => {
    const real = JSON.stringify;
    let n = 0;
    JSON.stringify = function spy(v, ...rest) {
      if (v && typeof v === 'object' && v.type === frame.type) n++;
      return real.call(this, v, ...rest);
    };
    try { host.api.broadcast(frame); } finally { JSON.stringify = real; }
    return n;
  };
  assert.equal(count(FRAMES.status), 2, 'the whole frame (local and read sockets) and the basic projection (both postures)');
  assert.equal(count(FRAMES.update), 1, 'local and read get it whole; basic gets nothing');
  assert.equal(count(FRAMES.stream), 1, 'the open chats get it whole; the rest nothing');
  assert.equal(count({ type: 'store:patch', patch: { x: 1 } }), 1, 'a surface frame: today\'s one serialization');
  assert.equal(count({ type: 'lock', lock: { base: null, started_at: 1, message: 'm', author: 'user' } }), 2, 'whole, and without the text');
  assert.equal(count({ type: 'lock', lock: null }), 1, 'nothing to take off: one string for every level');
  await settle(host, sockets);
});

// ── the graph's conversation text ───────────────────────────────────────────

test('TEXT_RULES: below read, hello, reset, lock and node-added carry no prompt or session; read and local get them whole', async (t) => {
  const host = await wsHost(t);
  const LOCK = { base: null, started_at: Date.now(), message: 'the typed prompt', author: 'user',
    session_id: 'sess-1', claude_pid: 4242, prompt_id: 'prm-1' };
  host.graph.lock = { ...LOCK };
  const local = await connect(t, host);
  const basic = await connect(t, host, { 'X-WC-Remote': '1' });
  const network = await connect(t, host, { 'x-test-peer': '10.0.0.7' });
  const bare = { base: null, started_at: LOCK.started_at, author: 'user', stale: false };

  assert.deepStrictEqual(local.of('hello')[0].lock, { ...LOCK, stale: false }, 'a local hello is whole');
  for (const c of [basic, network]) {
    const hello = c.of('hello')[0];
    assert.deepStrictEqual(hello.lock, bare, `${c.server._wc.peer}: the hello's lock without its text`);
    assert.deepStrictEqual(Object.keys(hello).sort(), Object.keys(local.of('hello')[0]).sort(), 'the rest of the hello is the same');
  }

  host.api.broadcastReset();
  host.api.broadcast({ type: 'lock', lock: { ...LOCK, stale: false } });
  host.api.broadcast({ type: 'node-added', node: { id: 'n1', label: 'n1.1', trigger_summary: 'the typed prompt', author: 'user' }, active: 'n1' });
  // A frame TEXT_RULES does not name is the surface's, sent as it is to everyone.
  host.api.broadcast({ type: 'store:patch', patch: { note: 'the typed prompt' } });
  await settle(host, [local, basic, network]);

  assert.deepStrictEqual(local.of('reset')[0].lock, { ...LOCK, stale: false });
  assert.deepStrictEqual(local.of('lock')[0].lock, { ...LOCK, stale: false });
  assert.equal(local.of('node-added')[0].node.trigger_summary, 'the typed prompt');
  for (const c of [basic, network]) {
    assert.deepStrictEqual(c.of('reset')[0].lock, bare);
    assert.deepStrictEqual(c.of('lock')[0].lock, bare);
    assert.deepStrictEqual(c.of('node-added')[0], { type: 'node-added', node: { id: 'n1', label: 'n1.1', author: 'user' }, active: 'n1' });
    assert.deepStrictEqual(c.of('store:patch')[0].patch, { note: 'the typed prompt' });
  }

  // At read the conversation is the viewer's: its frames go whole.
  host.optIn('read');
  await waitUntil(() => host.audience.remoteLevel() === 'read', { timeout: 10000, interval: 10, what: 'the opt-in' });
  const reader = await connect(t, host, { 'X-WC-Remote': '1' });
  assert.equal(reader.server._wc.level, 'read');
  assert.deepStrictEqual(reader.of('hello')[0].lock, { ...LOCK, stale: false });
  host.api.broadcast({ type: 'lock', lock: { ...LOCK, stale: false } });
  await settle(host, [reader, basic, network]);
  assert.deepStrictEqual(reader.of('lock')[0].lock, { ...LOCK, stale: false });
  assert.deepStrictEqual(basic.of('lock')[1].lock, { ...LOCK, stale: false }, 'the socket that was basic is at read now too');
  assert.deepStrictEqual(network.of('lock')[1].lock, bare, 'a network peer stays below read whatever the opt-in');
});

// ── level changes ───────────────────────────────────────────────────────────

test('a tunnel.json edit moves an open remote socket\'s level: mirror:access, the listeners, and the frames after it', async (t) => {
  const host = await wsHost(t, { optIn: null });
  const local = await connect(t, host);
  const remote = await connect(t, host, { 'X-WC-Remote': '1' });
  const network = await connect(t, host, { 'x-test-peer': '10.0.0.7', 'X-WC-Remote': '1' });
  const moved = [];
  const off = host.api.onLevelChange((ws, from, to) => moved.push([ws === remote.server ? 'remote' : 'other', from, to]));
  assert.equal(typeof off, 'function');

  host.api.broadcast(FRAMES.update);
  await settle(host, [local, remote, network]);
  assert.equal(remote.of('mirror:update').length, 0, 'basic: no conversation');

  const started = Date.now();
  host.optIn('read');
  await waitUntil(() => remote.of('mirror:access').length === 1, { timeout: 10000, interval: 5, what: 'mirror:access on the remote socket' });
  const took = Date.now() - started;
  assert.deepStrictEqual(remote.of('mirror:access'), [{ type: 'mirror:access', level: 'read', remote: true }]);
  assert.deepStrictEqual(moved, [['remote', 'basic', 'read']], 'the listeners run for the socket that moved, and only it');
  assert.equal(remote.server._wc.level, 'read');
  host.api.broadcast(FRAMES.update);
  await settle(host, [local, remote, network]);
  assert.deepStrictEqual(remote.of('mirror:update'), [FRAMES.update], 'the conversation from then on');

  host.optIn(null);
  await waitUntil(() => remote.of('mirror:access').length === 2, { timeout: 10000, interval: 5, what: 'the downgrade' });
  assert.deepStrictEqual(remote.of('mirror:access')[1], { type: 'mirror:access', level: 'basic', remote: true });
  assert.deepStrictEqual(moved, [['remote', 'basic', 'read'], ['remote', 'read', 'basic']]);
  host.api.broadcast(FRAMES.update);
  await settle(host, [local, remote, network]);
  assert.equal(remote.of('mirror:update').length, 1, 'and none again after the downgrade');

  for (const c of [local, network]) assert.deepStrictEqual(c.of('mirror:access'), [], `${c.server._wc.peer}: its level never moves`);
  off();
  host.optIn('full');
  await waitUntil(() => remote.of('mirror:access').length === 3, { timeout: 10000, interval: 5, what: 'the upgrade to full' });
  assert.equal(moved.length, 2, 'an unsubscribed listener hears nothing');
  // Spec §5.4: within about 1.5 s of the edit. Measured, not asserted, outside
  // a perf run (spec §10.1): a loaded machine stalls its event loop for longer.
  if (process.env.WEB_CHAT_PERF === '1') assert.ok(took < 1500, `the level change took ${took} ms`);
});

// ── backpressure ────────────────────────────────────────────────────────────

test('backpressure: over 4 MiB waiting, no mirror:stream; once drained under 256 KiB, one mirror:reset {reason:backpressure}', async (t) => {
  assert.equal(STREAM_HOLD_BYTES, 4 * 1024 * 1024);
  assert.equal(STREAM_RESUME_BYTES, 256 * 1024);
  const host = await wsHost(t);
  const slow = await connect(t, host);
  const quick = await connect(t, host);
  await posture(slow, 'full');
  await posture(quick, 'full');

  // The slow socket stops reading; surface frames pile up in front of it.
  slow.ws.pause();
  const blob = 'x'.repeat(512 * 1024);
  for (let i = 0; i < 400 && slow.server.bufferedAmount <= STREAM_HOLD_BYTES; i++) {
    host.api.sendTo(slow.server, { type: 'store:patch', patch: { blob, i } });
  }
  assert.ok(slow.server.bufferedAmount > STREAM_HOLD_BYTES, `backlog ${slow.server.bufferedAmount} B`);

  const s1 = { ...FRAMES.stream, rev: 11 };
  const s2 = { ...FRAMES.stream, rev: 12 };
  host.api.broadcast(s1);
  host.api.broadcast(FRAMES.status);
  host.api.broadcast(s2);
  assert.equal(slow.server._wc.starved, true, 'held back');
  await settle(host, [quick]);
  assert.deepStrictEqual(quick.of('mirror:stream').map((f) => f.rev), [11, 12], 'a socket that keeps up gets the stream');

  slow.ws.resume();
  await waitUntil(() => slow.of('mirror:reset').length > 0, { timeout: 30000, interval: 10, what: 'the backpressure reset' });
  const s3 = { ...FRAMES.stream, rev: 13 };
  host.api.broadcast(s3);
  await settle(host, [slow, quick]);
  assert.deepStrictEqual(slow.of('mirror:reset'), [{ type: 'mirror:reset', reason: 'backpressure' }], 'exactly one reset');
  assert.deepStrictEqual(slow.of('mirror:stream').map((f) => f.rev), [13], 'the held frames never arrive; the stream resumes after the reset');
  const order = slow.frames.filter((f) => f.type === 'mirror:reset' || f.type === 'mirror:stream').map((f) => f.type);
  assert.deepStrictEqual(order, ['mirror:reset', 'mirror:stream']);
  assert.deepStrictEqual(slow.of('mirror:status'), [FRAMES.status], 'the status kept flowing behind the backlog');
  assert.equal(slow.server._wc.starved, false);
  assert.equal(quick.of('mirror:reset').length, 0);
});

// ── the seams ───────────────────────────────────────────────────────────────

test('sendTo projects for its one socket; onConnect runs after a socket\'s hello, which is all it was sent', async (t) => {
  const host = await wsHost(t);
  const connected = [];
  const off = host.api.onConnect((ws) => connected.push(ws));
  const local = await connect(t, host);
  const basic = await connect(t, host, { 'X-WC-Remote': '1' });
  assert.deepStrictEqual(connected, [local.server, basic.server]);
  for (const c of [local, basic]) assert.deepStrictEqual(c.frames.map((f) => f.type), ['hello'], 'nothing pushed on connect');
  off();
  await connect(t, host);
  assert.equal(connected.length, 2, 'unsubscribed');

  assert.equal(host.api.sendTo(basic.server, FRAMES.update), false, 'below its row: not sent');
  assert.equal(host.api.sendTo(basic.server, FRAMES.status), true);
  assert.equal(host.api.sendTo(local.server, FRAMES.update), true);
  assert.equal(host.api.sendTo(null, FRAMES.update), false);
  await settle(host, [local, basic]);
  assert.deepStrictEqual(mirrorFrames(basic), [BASIC.status]);
  assert.deepStrictEqual(mirrorFrames(local), [FRAMES.update]);
  assert.throws(() => host.api.onConnect(null), TypeError);
  assert.throws(() => host.api.onLevelChange('x'), TypeError);
});

test('given no audience, ws.js judges every socket with no opt-in — a remote viewer gets the heartbeat, never more', async (t) => {
  const host = await wsHost(t, { optIn: 'full', audience: false });
  const local = await connect(t, host);
  const remote = await connect(t, host, { 'X-WC-Remote': '1' });
  assert.deepStrictEqual([local.server._wc.level, remote.server._wc.level], ['local', 'basic']);
  host.api.broadcast(FRAMES.status);
  host.api.broadcast(FRAMES.update);
  await settle(host, [local, remote]);
  assert.deepStrictEqual(mirrorFrames(remote), [BASIC.status], 'a full opt-in on disk grants nothing without the server\'s audience');
  assert.deepStrictEqual(mirrorFrames(local), [FRAMES.status, FRAMES.update]);
});

test('the daemon: a remote viewer of a project that has not opted in gets no prompt text in hello, lock or node-added', async (t) => {
  const { api, port } = await withServer(t);
  const open = async (headers) => {
    const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
    t.after(() => { try { ws.terminate(); } catch {} });
    const frames = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return frames;
  };
  await api.post('/api/turn-begin', { message: 'a prompt only the host sees', author: 'user' });
  const local = await open();
  const remote = await open({ 'X-WC-Remote': '1' });
  await waitUntil(() => local.length && remote.length, { timeout: 10000, interval: 5, what: 'both hellos' });
  assert.equal(local[0].lock.message, 'a prompt only the host sees');
  assert.equal(remote[0].type, 'hello');
  assert.ok(remote[0].lock, 'the lock itself is still there: a turn is running');
  assert.equal(remote[0].lock.message, undefined);

  await api.post('/api/render', { id: 'p1', html: '<p>x</p>' });
  await api.post('/api/turn-end', { author: 'claude' }); // the node's trigger_summary: the prompt's head
  const added = (frames) => frames.find((f) => f.type === 'node-added');
  await waitUntil(() => added(local) && added(remote), { timeout: 10000, interval: 5, what: 'node-added on both' });
  assert.equal(added(local).node.trigger_summary, 'a prompt only the host sees');
  assert.equal(added(remote).node.trigger_summary, undefined);
  assert.equal(added(remote).node.id, added(local).node.id, 'the rest of the node is the same');
  assert.ok(!JSON.stringify(remote).includes('a prompt only the host sees'));
});
