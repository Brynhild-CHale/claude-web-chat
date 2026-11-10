// The connector's derived signals, chat status and heartbeat rows (tranche 6,
// U729): lib/connector/signals.js — turn signals from the hold's graph
// entries, asks and conversations from one host-read status poll, resync on
// C-05.43's four triggers, 06-chat-status.json (A-06.1) from host reads only,
// and 07-heartbeat.json's chat rows (contract 05 §3.9; 06 C-06.24; 07 C-07.7,
// C-07.33 to C-07.37; 11 C-11.1).
//
// Each test runs a real daemon through withServer on an ephemeral port
// (sandbox HOME) under the real lifecycle with a stub supervisor that answers
// that port, its tick captured so a test runs it by hand, and a stub link that
// records every frame. Every frame is validated through U734's loader against
// the locked schemas (the conformsTo helper below, which lives in this test
// and nowhere in the product). No port in the band, no hub, nothing spawned.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const realClient = require('../lib/client');
const realRegistry = require('../lib/util/registry');
const { createLifecycle } = require('../lib/connector/lifecycle');
const { createSignals, STATUS_MIN_MS } = require('../lib/connector/signals');
const { minimalHeartbeat } = require('../lib/connector/link');
const { acquireWakeLock } = require('../lib/server/domain/turns');
const { projectToolInput, inputHash } = require('../lib/core/tool-input');
const { withServer, waitUntil } = require('../test-support/helpers');
const { createValidator } = require('../test-support/contracts-loader');

const CHAT = '01jbzam3n5p7q9r1s3t5v7w9y2';
const MACHINE = 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1';
const SESSION = '3f1c2a4e-9b7d-4e21-8a55-0c6d7e8f9a10';
const validator = createValidator({ folders: 'all' });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function assertOutsideBand(port) {
  assert.ok(![5170, 5171, 5172].includes(port) && !(port >= 5173 && port <= 5272), `port ${port} is outside the band`);
}

// conformsTo(name, value): a frame or body against the locked schemas. '05'
// takes a whole 05 frame (its (ch, kind) names the def); a schema name takes
// a body.
function conformsTo(name, value) {
  if (name === '05') {
    const r = validator.validateFrame(value);
    assert.ok(r.ok, `${value.ch}/${value.kind} fails ${r.schema}#${r.def}: ${JSON.stringify(r.errors)}`);
    return;
  }
  const v = validator.ajv.getSchema(`https://web-chat-contracts/schemas/${name}.json`);
  assert.ok(v, `no schema ${name}`);
  assert.ok(v(value), `${name} fails: ${JSON.stringify(v.errors)}`);
}

// ── stubs ──────────────────────────────────────────────────────────────────

// The link's surface signals use: state, send (recorded as the whole frame
// the link would write), signalRoom, and the 'ready' / 'signals.open' events.
function stubLink() {
  const l = new EventEmitter();
  l.state = 'up';
  l.room = 256;
  l.frames = [];
  const seqs = {};
  l.send = (ch, kind, body) => {
    seqs[ch] = (seqs[ch] || 0) + 1;
    const frame = { ch, kind, id: `c${l.frames.length + 1}`, seq: seqs[ch], at: Date.now(), ...body };
    l.frames.push(frame);
    return frame.id;
  };
  l.signalRoom = () => l.room;
  l.kinds = () => l.frames.map((f) => f.kind);
  l.of = (kind) => l.frames.filter((f) => f.kind === kind);
  l.signals = () => l.frames.filter((f) => f.ch === 'events');
  l.statuses = () => l.of('chat.status').map((f) => f.status);
  l.mark = () => l.frames.length;
  l.since = (n) => l.frames.slice(n);
  return l;
}

// lib/client, counting each GET by path and letting a test rewrite an answer.
// The hold's stream is the real one (a test ends it from the daemon's side).
function clientSpy() {
  const c = { ...realClient, gets: [], rewrite: null };
  c.get = async (p, o) => {
    c.gets.push(p);
    const r = await realClient.get(p, o);
    return c.rewrite ? c.rewrite(p, r) : r;
  };
  c.count = (p) => c.gets.filter((g) => g === p).length;
  return c;
}

// The daemon drops every open connection (the hold's stream with them) and
// goes on listening: the hold closes, and the lifecycle opens it again.
function dropConnections(d) {
  d.server.closeAllConnections();
}

function supervisorFor(state, startedBy) {
  return {
    async ensureRunning() { return { state: 'running', port: state.port, pid: process.pid, started_by: startedBy }; },
    startedBy: () => startedBy,
    forget() {},
  };
}

// A daemon under the real lifecycle (its tick captured), signals installed,
// a stub link and, unless a test passes its own, the real registry.
async function rig(t, d, { startedBy = 'connector', registry = realRegistry, ring = null } = {}) {
  const state = { port: d.port };
  const client = clientSpy();
  const ticks = [];
  const supervisor = supervisorFor(state, startedBy);
  const lifecycle = createLifecycle({
    supervisor,
    deps: {
      client,
      setInterval: (fn) => { ticks.push(fn); return { unref() {} }; },
      clearInterval() {},
    },
  });
  const link = stubLink();
  const logs = [];
  const signals = createSignals({ log: (l) => logs.push(l), deps: { client, registry, portOf: () => state.port } });
  const ctx = { link, supervisor, ...(ring ? { ring } : {}) };
  lifecycle.install(ctx);
  const uninstall = signals.install(ctx);
  const chat = { id: CHAT, root: d.root, owned_root: false };
  signals.track(chat);
  t.after(async () => { await lifecycle.stop(chat); uninstall(); });
  await lifecycle.run(chat);
  await waitUntil(() => lifecycle.heldBy(CHAT), { what: 'the hold', timeout: 5000 });
  // The first poll: the chat's opening resync.
  await waitUntil(() => link.of('resync').length >= 1, { what: 'the opening resync', timeout: 5000 });
  const tick = async () => { await ticks[0](); await signals.pollNow(CHAT, { fresh: false }); };
  return { state, client, ticks, tick, lifecycle, link, signals, logs, chat, supervisor, ctx };
}

function assertTextFree(frame, ...words) {
  const text = JSON.stringify(frame);
  for (const w of words) assert.ok(!text.includes(w), `${frame.kind} carries no '${w}'`);
  for (const k of ['message', 'summary', 'reply', 'error', 'pid', 'port', 'tool_name', 'subject', 'input', 'questions', 'plan']) {
    assert.ok(!new RegExp(`"${k}"`).test(text), `${frame.kind} has no ${k} key`);
  }
}

// The turn routes as the host calls them (lib/client: no Origin, no
// Sec-Fetch-*), so the lock records the session; a render is Claude's write.
const post = async (d, p, body) => {
  if (p === '/api/render') return d.api.post(p, body);
  const json = await realClient.post(p, body, { port: d.port, noSpawn: true });
  return { status: 200, json };
};

// A browser tab kept open: a local viewer.
async function openViewer(t, d) {
  const sock = d.ws();
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  return sock;
}

function askBody({ name = 'Bash', input = { command: 'echo SIGNALS-ASK-TEXT' }, session = SESSION } = {}) {
  return {
    v: 1,
    envelope: {
      v: 1, event: 'PermissionRequest', ts: Date.now(), session_id: session, transcript_path: '/tmp/t.jsonl',
      cwd: '/p', prompt_id: null, claude_pid: 4242, entrypoint: 'cli', permission_mode: 'default', agent: null,
      tool: { name, kind: 'permission', label: name, call: name, input: {}, input_hash: inputHash(input) },
      ask: null,
    },
    kind: 'permission',
    display: projectToolInput(name, input, { profile: 'display' }),
  };
}

// ── turn signals (C-05.39) ─────────────────────────────────────────────────

test('turn signals: a turn-begin then a turn-end on the daemon give turn.begun then turn.ended, each valid and text-free', async (t) => {
  const d = await withServer(t);
  assertOutsideBand(d.port);
  const r = await rig(t, d);
  const at = r.link.mark();
  assert.strictEqual((await post(d, '/api/turn-begin', { message: 'SIGNALS-PROMPT-TEXT', session_id: SESSION })).status, 200);
  await post(d, '/api/render', { id: 'sig-p1', html: '<div>p1</div>' });
  assert.strictEqual((await post(d, '/api/turn-end', { author: 'claude', summary: 'SIGNALS-SUMMARY', reply: 'SIGNALS-REPLY' })).status, 200);
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'turn.ended'), { what: 'turn.ended', timeout: 5000 });
  const turns = r.link.since(at).filter((f) => f.kind.startsWith('turn.'));
  assert.deepStrictEqual(turns.map((f) => f.kind), ['turn.begun', 'turn.ended']);
  const [begun, ended] = turns;
  for (const f of turns) {
    conformsTo('05', f);
    assertTextFree(f, 'SIGNALS-PROMPT-TEXT', 'SIGNALS-SUMMARY', 'SIGNALS-REPLY');
    assert.strictEqual(f.chat, CHAT);
    assert.strictEqual(f.boot, d.srv.bus.bootId);
  }
  assert.strictEqual(begun.author, 'user', 'an absent author is user');
  assert.strictEqual(begun.session_id, SESSION);
  assert.strictEqual(ended.outcome, 'committed');
  assert.strictEqual(ended.node, d.srv.graph.active, "node is the turn-end entry's id");
  const ring = d.srv.bus.read({ since: 0 }).events;
  const begin = ring.find((e) => e.kind === 'graph' && e.op === 'turn-begin');
  const end = ring.find((e) => e.kind === 'graph' && e.op === 'turn-end');
  assert.strictEqual(begun.daemon_seq, begin.seq);
  assert.strictEqual(ended.daemon_seq, end.seq);
  assert.strictEqual(begun.daemon_at, begin.ts);
  // The entry ran the status poll at once: the status saw the lock come and go.
  await post(d, '/api/unlock', {});
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'chat.status'), { what: 'a status', timeout: 5000 });
  // An unlock with nothing held derives nothing; a turn-end replayed by a
  // reopened hold derives nothing again.
  const n = r.link.since(at).filter((f) => f.kind.startsWith('turn.')).length;
  let reopened = false;
  r.lifecycle.subscribe((m) => { if (m.type === 'open') reopened = true; });
  // The reopened hold reads the ring from its start (as from a hub cursor
  // behind it): every turn entry comes again.
  r.lifecycle.setCursorProvider(() => 0);
  dropConnections(d);
  await waitUntil(() => reopened && r.lifecycle.heldBy(CHAT), { what: 'the hold back', timeout: 5000 });
  await settle(200);
  assert.strictEqual(r.link.since(at).filter((f) => f.kind.startsWith('turn.')).length, n, 'no turn signal twice');
});

test("C-05.39's special rows: an upgraded wake lock gives nothing; a stolen stale lock gives turn.ended superseded then turn.begun", async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  let at = r.link.mark();
  acquireWakeLock(d.srv.graph, d.srv.bus, { message: 'SIGNALS-WAKE-TEXT' });
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'turn.begun'), { what: "the wake's turn.begun", timeout: 5000 });
  const wake = r.link.since(at).find((f) => f.kind === 'turn.begun');
  assert.strictEqual(wake.author, 'wake');
  conformsTo('05', wake);

  at = r.link.mark();
  const up = await post(d, '/api/turn-begin', { message: 'SIGNALS-UPGRADE-TEXT', session_id: SESSION });
  assert.strictEqual(up.json.upgraded_wake_lock, true);
  await waitUntil(() => d.srv.bus.read({ since: 0 }).events.some((e) => e.upgraded_wake_lock === true), { what: 'the upgrade entry' });
  await settle(200);
  assert.deepStrictEqual(r.link.since(at).filter((f) => f.kind.startsWith('turn.')), [], 'the same turn: no signal');

  // The held lock goes stale; another session's prompt steals it.
  d.srv.graph.lock.started_at = 1;
  at = r.link.mark();
  const stole = await post(d, '/api/turn-begin', { message: 'SIGNALS-STEAL-TEXT', session_id: 'other-session-1' });
  assert.strictEqual(stole.json.stole_stale_lock, true);
  await waitUntil(() => r.link.since(at).filter((f) => f.kind.startsWith('turn.')).length >= 2, { what: 'the steal', timeout: 5000 });
  const turns = r.link.since(at).filter((f) => f.kind.startsWith('turn.'));
  assert.deepStrictEqual(turns.map((f) => f.kind), ['turn.ended', 'turn.begun']);
  assert.strictEqual(turns[0].outcome, 'superseded');
  assert.strictEqual(turns[0].node, null);
  assert.strictEqual(turns[0].ended, null);
  assert.strictEqual(turns[0].ended_by, null);
  assert.strictEqual(turns[0].daemon_seq, turns[1].daemon_seq, 'both carry the turn-begin seq');
  assert.strictEqual(turns[1].session_id, 'other-session-1');
  for (const f of turns) {
    conformsTo('05', f);
    assertTextFree(f, 'SIGNALS-WAKE-TEXT', 'SIGNALS-UPGRADE-TEXT', 'SIGNALS-STEAL-TEXT');
  }
});

test('a lock gone with no turn entry (a guardReaim steal): turn.ended superseded with daemon_seq null, after a second read agrees', async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  await post(d, '/api/turn-begin', { message: 'x', session_id: SESSION });
  await waitUntil(() => r.link.of('turn.begun').length === 1, { what: 'turn.begun' });
  await settle(100);
  const at = r.link.mark();
  // The lock vanishes the way guardReaim's steal leaves it: no ring entry.
  d.srv.graph.lock = null;
  await r.tick();
  assert.deepStrictEqual(r.link.since(at).filter((f) => f.kind === 'turn.ended'), [], 'one read is not enough (a turn-end may be on its way)');
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'turn.ended'), { what: 'the poll-derived end', timeout: 5000 });
  const ended = r.link.since(at).find((f) => f.kind === 'turn.ended');
  assert.strictEqual(ended.outcome, 'superseded');
  assert.strictEqual(ended.daemon_seq, null);
  conformsTo('05', ended);
  await settle(400);
  assert.strictEqual(r.link.since(at).filter((f) => f.kind === 'turn.ended').length, 1, 'once');
});

// ── asks (C-05.40) ─────────────────────────────────────────────────────────

test('asks: created gives ask.opened on the next poll, a decision ask.updated, its resolution ask.closed; each valid and text-free', async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  await openViewer(t, d);
  let at = r.link.mark();
  const created = await d.srv.asks.create(askBody());
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  await r.tick();
  const opened = r.link.since(at).filter((f) => f.kind.startsWith('ask.'));
  assert.deepStrictEqual(opened.map((f) => f.kind), ['ask.opened']);
  assert.strictEqual(opened[0].ask.id, created.id);
  assert.strictEqual(opened[0].ask.state, 'pending');
  assert.strictEqual(opened[0].ask.tool_kind, 'bash', 'the class word, lower-cased; never the tool name');
  assert.strictEqual(opened[0].daemon_seq, null, 'from the status poll');

  at = r.link.mark();
  const view = d.srv.asks.publicView(created.id);
  const decided = d.srv.asks.decide(created.id, { behavior: 'allow' }, { via: 'web', version: view.version });
  assert.strictEqual(decided.ok, true, JSON.stringify(decided));
  await r.tick();
  const updated = r.link.since(at).filter((f) => f.kind.startsWith('ask.'));
  assert.deepStrictEqual(updated.map((f) => f.kind), ['ask.updated']);
  assert.strictEqual(updated[0].ask.state, 'decided');

  at = r.link.mark();
  assert.strictEqual(d.srv.asks.handed(created.id, created.secret).ok, true);
  await r.tick();
  const closed = r.link.since(at).filter((f) => f.kind.startsWith('ask.'));
  assert.deepStrictEqual(closed.map((f) => f.kind), ['ask.closed']);
  assert.strictEqual(closed[0].ask.id, created.id);

  at = r.link.mark();
  await r.tick();
  assert.deepStrictEqual(r.link.since(at).filter((f) => f.kind.startsWith('ask.')), [], 'an unchanged list sends nothing');
  for (const f of [...opened, ...updated, ...closed]) {
    conformsTo('05', f);
    assertTextFree(f, 'SIGNALS-ASK-TEXT', 'echo', 'Bash');
  }
});

// ── resync (C-05.43) ───────────────────────────────────────────────────────

test('resync: after a hello.ack, after a forced coalesce, after the hold recovers from a close — each from one status poll', async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  const opening = r.link.of('resync')[0];
  assert.strictEqual(opening.reason, 'poll_recovered', "a chat's first poll resyncs");
  conformsTo('05', opening);

  // hello.ack: every chat's status in full, then a resync.
  let at = r.link.mark();
  let health = r.client.count('/api/health');
  let mirror = r.client.count('/api/mirror/status');
  r.link.emit('ready');
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'resync'), { what: 'the reconnect resync' });
  await settle(50);
  let resyncs = r.link.since(at).filter((f) => f.kind === 'resync');
  assert.strictEqual(resyncs.length, 1);
  assert.strictEqual(resyncs[0].reason, 'reconnect');
  assert.strictEqual(r.link.since(at)[0].kind, 'chat.status', 'the full status first');
  assert.strictEqual(r.client.count('/api/health') - health, 1, 'one status poll: one health read');
  assert.strictEqual(r.client.count('/api/mirror/status') - mirror, 1, 'one mirror status read');
  conformsTo('05', resyncs[0]);

  // A forced coalesce: the window is full, so signals are dropped and counted.
  r.link.room = 0;
  at = r.link.mark();
  await post(d, '/api/turn-begin', { message: 'x', session_id: SESSION });
  await waitUntil(() => d.srv.bus.read({ since: 0 }).events.some((e) => e.op === 'turn-begin'), { what: 'the entry' });
  await settle(200);
  assert.deepStrictEqual(r.link.since(at).filter((f) => f.ch === 'events'), [], 'nothing derived goes while the window is full');
  r.link.room = 256;
  health = r.client.count('/api/health');
  r.link.emit('signals.open');
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'resync'), { what: 'the backpressure resync' });
  resyncs = r.link.since(at).filter((f) => f.kind === 'resync');
  assert.strictEqual(resyncs.length, 1);
  assert.strictEqual(resyncs[0].reason, 'backpressure');
  assert.ok(resyncs[0].dropped >= 1, 'the drop is counted');
  assert.strictEqual(resyncs[0].turn_in_flight, true, 'the snapshot carries the held turn');
  assert.strictEqual(r.client.count('/api/health') - health, 1);
  conformsTo('05', resyncs[0]);

  // The hold closes and opens again.
  at = r.link.mark();
  dropConnections(d);
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'resync'), { what: 'the hold recovered', timeout: 6000 });
  resyncs = r.link.since(at).filter((f) => f.kind === 'resync');
  assert.strictEqual(resyncs.length, 1);
  assert.strictEqual(resyncs[0].reason, 'poll_recovered');
  conformsTo('05', resyncs[0]);
});

test('resync: a boot change (the daemon restarted on the same root) resyncs with reason reset under the new boot', async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  const firstBoot = d.srv.bus.bootId;
  const at = r.link.mark();
  await d.stop();
  const d2 = await withServer(t, { root: d.root });
  assertOutsideBand(d2.port);
  r.state.port = d2.port;
  await waitUntil(() => r.link.since(at).some((f) => f.kind === 'resync' && f.boot === d2.srv.bus.bootId), { what: 'the reset resync', timeout: 8000 });
  const resync = r.link.since(at).find((f) => f.kind === 'resync' && f.boot === d2.srv.bus.bootId);
  assert.notStrictEqual(d2.srv.bus.bootId, firstBoot);
  assert.strictEqual(resync.reason, 'reset');
  conformsTo('05', resync);
});

// ── the status poll and the boot that orders a record ──────────────────────

test('the status poll: one health read per tick (shared with the idle check); X-WC-Boot orders a conversations record', async (t) => {
  const d = await withServer(t);
  // started_by other, so the idle check reads health on the tick too; a held
  // lock keeps it from restarting the daemon.
  const r = await rig(t, d, { startedBy: 'other' });
  await post(d, '/api/turn-begin', { message: 'x', session_id: SESSION });
  await waitUntil(() => r.link.of('turn.begun').length === 1, { what: 'turn.begun' });
  await settle(150);
  for (let i = 0; i < 3; i++) {
    const before = r.client.count('/api/health');
    await r.tick();
    assert.strictEqual(r.client.count('/api/health') - before, 1, `tick ${i}: one health read`);
  }
  // The record the hub holds: the opening resync's, at the daemon's boot.
  const conv0 = r.link.signals().filter((f) => f.kind === 'conversations' || f.kind === 'resync');
  assert.ok(conv0.every((f) => f.boot === d.srv.bus.bootId));
  // Same (boot, rev): nothing more.
  let at = r.link.mark();
  await r.tick();
  assert.deepStrictEqual(r.link.since(at).filter((f) => f.kind === 'conversations'), []);
  // The answer's X-WC-Boot names the record's boot, whatever health says: a
  // new header boot is a boot change, and its record goes even at a lower rev.
  r.client.rewrite = (p, res) => (p === '/api/mirror/status' ? { body: { ...res.body, rev: 0 }, headers: { ...res.headers, 'x-wc-boot': 'boot-from-header' } } : res);
  at = r.link.mark();
  await r.tick();
  const reset = r.link.since(at).find((f) => f.kind === 'resync');
  assert.ok(reset, 'a resync');
  assert.strictEqual(reset.reason, 'reset');
  assert.strictEqual(reset.boot, 'boot-from-header');
  assert.strictEqual(reset.record.rev, 0);
  // A rev above the held one within that boot moves the record.
  r.client.rewrite = (p, res) => (p === '/api/mirror/status' ? { body: { ...res.body, rev: 7 }, headers: { ...res.headers, 'x-wc-boot': 'boot-from-header' } } : res);
  at = r.link.mark();
  await r.tick();
  const conv = r.link.since(at).filter((f) => f.kind === 'conversations');
  assert.strictEqual(conv.length, 1);
  assert.strictEqual(conv[0].record.rev, 7);
  assert.strictEqual(conv[0].boot, 'boot-from-header');
  conformsTo('05', conv[0]);
  for (const row of conv[0].record.conversations) assert.ok(!('counts' in row), 'rows without counts');
});

// ── chat status (06-chat-status.json, A-06.1) ──────────────────────────────

test('chat status: valid against amendment 1, from host reads only, never the lock message; at most one a second', async (t) => {
  const d = await withServer(t);
  const mcpRow = { id: 'mcp:1', role: 'mcp', root: d.root, pid: 99999, channel: false, package_version: '0.9.0-alpha.7', last_tool_at: 1793181455020 };
  const registry = { ...realRegistry, mcpSessionsFor: (root) => (root === d.root ? [mcpRow] : []) };
  const r = await rig(t, d, { startedBy: 'other', registry });
  await openViewer(t, d);
  await post(d, '/api/turn-begin', { message: 'SIGNALS-LOCK-MESSAGE', session_id: SESSION });
  await waitUntil(() => r.link.statuses().some((s) => s.turn && s.turn.in_flight), { what: 'a status with the turn', timeout: 5000 });
  await settle(STATUS_MIN_MS + 100);
  await r.tick();
  const status = r.link.statuses().at(-1);
  conformsTo('06-chat-status', status);
  conformsTo('05', r.link.of('chat.status').at(-1));
  assert.ok(!JSON.stringify(r.link.of('chat.status')).includes('SIGNALS-LOCK-MESSAGE'), 'never lock.message');
  assert.ok(!JSON.stringify(r.link.of('chat.status')).includes(d.root), 'never a path');
  assert.ok(!/"pid"|"port"/.test(JSON.stringify(r.link.of('chat.status'))), 'never a pid or a port');
  assert.strictEqual(status.v, 1);
  assert.strictEqual(status.chat_id, CHAT);
  assert.notStrictEqual(status.boot, d.srv.bus.bootId, "the connector's boot, not the daemon's");
  assert.strictEqual(status.daemon.boot, d.srv.bus.bootId);
  assert.strictEqual(status.daemon.up, true);
  assert.strictEqual(status.daemon.instance, realRegistry.instanceId(d.root));
  assert.deepStrictEqual(status.daemon.viewer_peers, { local: 1, remote: 0 });
  assert.strictEqual(status.daemon.started_by, 'other', "the supervisor's");
  assert.strictEqual(status.daemon.held, true);
  assert.strictEqual(typeof status.daemon.mirror_enabled, 'boolean');
  const policy = await realClient.get('/api/queue/policy', { port: d.port, noSpawn: true });
  assert.strictEqual(status.session.channel, policy.channel_connected);
  assert.strictEqual(status.session.mod, policy.mod_attached);
  assert.strictEqual(status.session.launched_by, 'user');
  assert.strictEqual(status.session.attach, null);
  assert.strictEqual(status.session.count, 1);
  assert.deepStrictEqual(status.session.package_versions, ['0.9.0-alpha.7']);
  assert.strictEqual(status.queue.count, policy.queue_count);
  assert.deepStrictEqual(status.needs_you, { asks: 0 });
  assert.strictEqual(status.turn.in_flight, true);
  assert.strictEqual(status.turn.author, 'user');
  assert.strictEqual(typeof status.over_cap, 'boolean');
  assert.strictEqual(status.state, 'running');

  // Two changes within one second send one status, carrying the second.
  await settle(STATUS_MIN_MS + 50);
  await d.srv.asks.create(askBody());
  await r.tick();
  const n = r.link.statuses().length;
  assert.strictEqual(r.link.statuses().at(-1).needs_you.asks, 1, 'the first change goes at once');
  await d.srv.asks.create(askBody({ session: 'other-session-2', input: { command: 'ls' } }));
  await r.tick();
  await d.srv.asks.create(askBody({ session: 'other-session-3', input: { command: 'pwd' } }));
  await r.tick();
  assert.strictEqual(r.link.statuses().length, n, 'held inside the second');
  await waitUntil(() => r.link.statuses().length > n, { what: 'the held status', timeout: 3000 });
  await settle(STATUS_MIN_MS + 100);
  assert.strictEqual(r.link.statuses().length, n + 1, 'one status for two changes');
  assert.strictEqual(r.link.statuses().at(-1).needs_you.asks, 3);
  conformsTo('06-chat-status', r.link.statuses().at(-1));
  const seqs = r.link.statuses().map((s) => s.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq grows within the connector boot');
  assert.deepStrictEqual(r.signals.statusOf(CHAT).needs_you, { asks: 3 });
});

test('chat status: no MCP presence row → session null; a daemon that stops answering → daemon null, state starting', async (t) => {
  const d = await withServer(t);
  const registry = { ...realRegistry, mcpSessionsFor: () => [] };
  const r = await rig(t, d, { registry });
  await settle(STATUS_MIN_MS + 50);
  const s = r.signals.statusOf(CHAT);
  conformsTo('06-chat-status', s);
  assert.strictEqual(s.session, null);
  assert.strictEqual(s.daemon.started_by, 'connector');
  await d.stop();
  await r.signals.pollNow(CHAT);
  const down = r.signals.statusOf(CHAT);
  conformsTo('06-chat-status', down);
  assert.strictEqual(down.daemon, null);
  assert.strictEqual(down.state, 'starting');
  assert.ok(!('turn' in down));
  const rows = r.signals.heartbeatRows();
  assert.strictEqual(rows[0].daemon, 'crashed');
  assert.strictEqual(rows[0].boot, null);
  assert.strictEqual(rows[0].ring_seq, null);
  const base = { machine_id: MACHINE, beat: 1, interval_ms: 15000, connector_now: Date.now() };
  const body = r.signals.heartbeatBody(base);
  assert.deepStrictEqual({ ...body, chats: [] }, minimalHeartbeat(base), "the link's base, unchanged");
  conformsTo('07-heartbeat', body);
});

// ── heartbeat rows (07-heartbeat.json, C-07.35, C-07.36) ───────────────────

test('heartbeat rows: valid 07-heartbeat chat items, no pid, ring_seq the highest ring position read', async (t) => {
  const d = await withServer(t);
  const r = await rig(t, d);
  await post(d, '/api/turn-begin', { message: 'x', session_id: SESSION });
  await post(d, '/api/unlock', {});
  const latest = d.srv.bus.read({ since: 0 }).latest;
  await waitUntil(() => r.signals.heartbeatRows()[0].ring_seq === latest, { what: 'the ring position', timeout: 5000 });
  await r.tick();
  const rows = r.signals.heartbeatRows();
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.deepStrictEqual(Object.keys(row).sort(), ['boot', 'channel_connected', 'chat_id', 'daemon', 'ring_seq', 'viewers']);
  assert.strictEqual(row.chat_id, CHAT);
  assert.strictEqual(row.daemon, 'running');
  assert.strictEqual(row.boot, d.srv.bus.bootId);
  assert.strictEqual(row.viewers, 0, 'an HTTP read and the hold are not viewers');
  assert.strictEqual(row.ring_seq, latest);
  assert.strictEqual(typeof row.channel_connected, 'boolean');
  const body = r.signals.heartbeatBody({ machine_id: MACHINE, beat: 3, interval_ms: 15000, connector_now: Date.now(), echo_at: Date.now() - 50 });
  conformsTo('07-heartbeat', body);
  assert.ok(!/pid/.test(JSON.stringify(body)), 'no pid crosses (C-07.36)');

  // A ring that names its own position is the one asked.
  const d2 = await withServer(t);
  const ring = { stats: () => ({ pending: 0, inflight: 0, unacked: 0, dropped: 0, polling: false, reread: false, boot: d2.srv.bus.bootId, pos: 4242 }) };
  const r2 = await rig(t, d2, { ring });
  await r2.tick();
  assert.strictEqual(r2.signals.heartbeatRows()[0].ring_seq, 4242);
});
