// The chat mirror's registry after the listen (PLAN.md 4G.1, MIRROR@lazy-registry;
// U571; RULED U571@queue-release-gap (a); settled default REGISTRY@deferred-ready).
//
// createServer ARMS the mirror — the hook tap and the main bus subscribed, so an
// envelope is ingested from construction — and the registry load and the
// sources' start run from ONE immediate after the server is listening (the
// boot's figure is the listen alone). `mirror.ready` is a deferred pending from
// construction, resolved once the registry has loaded and the sources have
// started, or on stop(), or when web-chat is switched off; a chat pin reads
// `indexing` (never `unavailable`) while the registry has not loaded. Pinned:
//   * withServer over a seeded conversations.json of 50 synthetic records: at
//     the body's first line ready is pending and none of the 50 is listed;
//     after ready all 50 are — and a GET /api/mirror issued at once waits and
//     answers the whole list, its body the same as one issued after ready;
//   * an envelope published in the gap (before any await) is ingested, never
//     ignored as not-running, and its conversation is listed;
//   * queueRelease.send for an autosend message in the gap releases as a daemon
//     without a mirror does (the accepted gap, asserted so a change is
//     deliberate); a bridge session attached in the gap stays attached;
//   * createServer alone (never listened) never starts the mirror: the bridge
//     is started (its tap subscription detaches a session on SessionEnd), and
//     stop() resolves ready; start()'s fixed-port listen starts it; a failed
//     bind never does;
//   * a facade alone (the `sources` seam, a fake transcripts source): after
//     arm() and before start(), engine.indexing is true for a well-formed id and
//     the resolver answers `indexing`; after start() settles it follows the
//     fake (`unavailable {rule: 'gone'}`); ensureConversation waits for ready
//     and reaches the fake once; ready resolves when switched off;
//   * ensureLoaded's duplicate rule: a repeated id keeps the first record.
// The Claude tier is a private fake (test-support/claude-home, isolate: true)
// fed only synthetic transcripts (test-support/claude-records). A test never
// requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { withServer, withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { projectPaths } = require('../lib/core/paths');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { LISTEN_HOST } = require('../lib/core/cors');
const P = require('../lib/core/mod-protocol');
const client = require('../lib/client');
const queue = require('../lib/server/domain/queue');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createChatAnchorsSource } = require('../lib/server/mirror/chat-anchors');
const { READY_WAIT_MS } = require('../lib/server/routes/mirror');

const N = 50;
const NEW = '33333333-3333-4333-8333-333333357100';
const ATTACHED = '44444444-4444-4444-8444-444444457100';
const WAIT = { timeout: 15000, interval: 20 };
const sid = (n) => `c5710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pending = (p) => Promise.race([p.then(() => 'ready'), new Promise((r) => setImmediate(() => r('pending')))]);
// Pending NOW: a few microtask turns, never a macrotask (an immediate would let
// the daemon's after-listen start run): a promise settled already reads 'ready'.
async function pendingNow(p) {
  let done = false;
  p.then(() => { done = true; });
  for (let i = 0; i < 3; i++) await Promise.resolve();
  return done ? 'ready' : 'pending';
}
const listedIds = (snap) => new Set((snap.conversations || []).map((c) => c.id));

// A synthetic transcript of one closed turn, and its conversations.json record.
let seed = 5710;
function transcript(ch, s, at) {
  const r = createRecords({ seed: seed++, sessionId: s, cwd: ch.cwd, start: at, step: 10 });
  r.prompt(`prompt of ${s}`, { promptId: `p-${s.slice(-4)}` });
  r.assistant([`reply of ${s}`]);
  r.turnDuration({ durationMs: 50 });
  ch.writeTranscript(s, r.records);
}
function stored(ch, { id, lastActivity, title = null }) {
  const created = lastActivity - 1000;
  return {
    id, created_at: created, last_activity_at: lastActivity, ended_at: lastActivity,
    title, name: null, forked_from: null, current_session_id: id, entrypoint: 'cli',
    sessions: [{ session_id: id, slug: ch.slug, reason: 'start', started_at: created, ended_at: null }],
    process: null,
  };
}

// A project whose conversations.json lists `n` ended conversations, each with
// its transcript in the private tier.
function seeded(t, n = N) {
  withTempHome(t);
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const ch = claudeHome(t, { root, isolate: true });
  const ids = Array.from({ length: n }, (_, i) => sid(i + 1));
  const at = Date.now() - 3600000;
  const list = ids.map((id, i) => { transcript(ch, id, at + i * 1000); return stored(ch, { id, lastActivity: at + i * 1000 + 500 }); });
  writeJsonAtomic(projectPaths(root).mirrorConversations, { v: 1, conversations: list });
  return { root, ch, ids };
}

const envelopeOf = (ch, event, s, extra = {}) => hookEnvelope({
  hook_event_name: event, session_id: s, transcript_path: ch.transcript(s), cwd: ch.cwd, permission_mode: 'default', ...extra,
}, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { now: Date.now() });

// ── the daemon: the registry after the listen ───────────────────────────────

test('withServer: ready is pending at the body\'s first line and none of the 50 is listed; after ready all 50 are, and an early GET /api/mirror waits and answers the same body', async (t) => {
  const w = seeded(t);
  const d = await withServer(t, { root: w.root });
  // The body's first line: the listen has answered, the immediate has not run.
  const first = d.srv.mirror.snapshot({ since: 0 });
  const early = client.get('/api/mirror?since=0', { port: d.port, noSpawn: true, timeout: 15000 });
  assert.equal(w.ids.filter((id) => listedIds(first).has(id)).length, 0, 'none of the 50 before the registry loads');
  assert.equal(await pendingNow(d.srv.mirror.ready), 'pending', 'ready is pending after the listen');
  await d.srv.mirror.ready;
  const after = d.srv.mirror.snapshot({ since: 0 });
  assert.deepEqual(w.ids.filter((id) => listedIds(after).has(id)), w.ids, 'all 50 once ready');
  const a = await early;
  assert.deepEqual(w.ids.filter((id) => listedIds(a).has(id)), w.ids, 'the early GET answers the whole list');
  const b = await client.get('/api/mirror?since=0', { port: d.port, noSpawn: true, timeout: 15000 });
  const strip = ({ now, ...rest }) => rest; // eslint-disable-line no-unused-vars
  assert.deepEqual(strip(a), strip(b), 'the body unchanged (but its clock)');
});

test('an envelope published between the listen and the registry load is ingested and delivered, never ignored as not-running', async (t) => {
  const w = seeded(t);
  w.ch.writeTranscript(NEW, []);
  const d = await withServer(t, { root: w.root });
  d.srv.hooks.publish(envelopeOf(w.ch, 'SessionStart', NEW, { source: 'startup', model: 'claude-test' }));
  assert.equal(await pendingNow(d.srv.mirror.ready), 'pending');
  await d.srv.mirror.ready;
  const st = d.srv.mirror.stats();
  assert.ok(st.ingest.accepted >= 1, 'accepted');
  assert.equal(st.ingest.ignored['not-running'], undefined, 'never ignored as not-running');
  await waitUntil(() => listedIds(d.srv.mirror.snapshot({ since: 0 })).has(NEW), { ...WAIT, what: 'the new session listed' });
  assert.ok(w.ids.every((id) => listedIds(d.srv.mirror.snapshot({ since: 0 })).has(id)), 'and the 50 beside it');
});

test('the gap: queueRelease.send releases as a daemon without a mirror (accepted, U571@queue-release-gap); a bridge session attached in it stays attached', async (t) => {
  const w = seeded(t);
  const d = await withServer(t, { root: w.root });
  const cid = w.ids[0];
  // Before the registry has loaded: no live state for the conversation, so the
  // send follows the row a daemon without a mirror follows — unknown, free,
  // released now (untargeted; parked, as no channel is live in a test).
  assert.equal(d.srv.mirror.liveOf(cid), null, 'no live state in the gap');
  assert.equal(d.srv.queueRelease.claudeFree(cid), true);
  const item = queue.enqueueMessage(d.srv.state, d.srv.bus, { text: 'in the gap', skill: null, files: [], chars: 10 }, {
    conversation_id: cid, autosend: true, staged: true,
  });
  const r = d.srv.queueRelease.send(item, { mode: 'auto', prov: {} });
  assert.notEqual(r.mode, 'queued', 'released at once, never held');
  assert.ok(r.wake || r.parked, 'delivered (woken or parked)');
  assert.equal((r.wake && r.wake.target_pid) || (r.parked && r.parked.target_pid) || undefined, undefined, 'untargeted');
  assert.equal(d.srv.state.queue.some((it) => it.id === item.id), false, 'it left the queue');
  // A mod's session attached in the gap.
  const hello = d.srv.bridge.hello({
    v: 1, protocol: P.MOD_PROTOCOL, session_id: ATTACHED, cc_version: '2.1.296', mod_version: '0.8.5',
    ops: [...P.OPS], events: [...P.EVENT_KINDS], root: w.root,
  });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(await pendingNow(d.srv.mirror.ready), 'pending');
  await d.srv.mirror.ready;
  assert.equal(d.srv.bridge.attached(ATTACHED), true, 'the registry load detached nobody');
  // After the load the mirror knows the conversation: the gap was real.
  assert.notEqual(d.srv.mirror.liveOf(cid), null, 'live state once the registry has loaded');
});

test('createServer alone never starts the mirror; the bridge, control and the scheduler are started; stop() resolves ready', async (t) => {
  const w = seeded(t);
  const { createServer } = require('../lib/server');
  const srv = createServer({ root: w.root, port: 0 });
  let stopped = false;
  t.after(async () => { if (!stopped) await srv.stop(); });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await pending(srv.mirror.ready), 'pending', 'ready pending: never listened');
  const st = srv.mirror.stats();
  assert.equal(st.conversations.conversations, 0, 'the registry not loaded');
  assert.equal(st.sources.some((s) => s.started), false, 'no source started');
  await srv.controlStarted;
  // The bridge subscribed the hook tap at construction: a SessionEnd detaches.
  const hello = srv.bridge.hello({
    v: 1, protocol: P.MOD_PROTOCOL, session_id: ATTACHED, cc_version: '2.1.296', mod_version: '0.8.5',
    ops: [...P.OPS], events: [...P.EVENT_KINDS], root: w.root,
  });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  srv.hooks.publish(envelopeOf(w.ch, 'SessionEnd', ATTACHED, { reason: 'other' }));
  assert.equal(srv.bridge.attached(ATTACHED), false, 'the bridge hears the tap before any listen');
  await srv.stop();
  stopped = true;
  await srv.mirror.ready;
  assert.equal(srv.mirror.stats().sources.some((s) => s.started), false, 'stopped before the listen: never started');
});

test('start()\'s fixed-port listen starts the mirror after the listen; a failed bind never does', async (t) => {
  const { createServer } = require('../lib/server');
  {
    const w = seeded(t);
    const srv = createServer({ root: w.root, port: 0 });
    t.after(() => srv.stop());
    const log = console.log;
    console.log = () => {};
    try { await srv.start({ writePortfile: false }); } finally { console.log = log; }
    assert.equal(await pendingNow(srv.mirror.ready), 'pending', 'start() answered before the registry load');
    await srv.mirror.ready;
    assert.deepEqual(w.ids.filter((id) => listedIds(srv.mirror.snapshot({ since: 0 })).has(id)), w.ids);
  }
  {
    const w = seeded(t, 3);
    const taken = net.createServer();
    await new Promise((r) => taken.listen(0, LISTEN_HOST, r));
    t.after(() => new Promise((r) => taken.close(() => r())));
    const srv = createServer({ root: w.root, port: taken.address().port });
    t.after(() => srv.stop());
    await assert.rejects(srv.start({ writePortfile: false }), (e) => e && e.code === 'EADDRINUSE');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.mirror.stats().conversations.conversations, 0, 'a failed bind loads no registry');
    assert.equal(srv.mirror.stats().sources.some((s) => s.started), false, 'and starts no source');
  }
});

// ── the facade alone: indexing before the registry ──────────────────────────

const CHAT = (cid, n) => ({
  v: 1, kind: 'turn', conversation_id: cid, session_id: cid, turn_id: `t-${n}`,
  quote: { exact: `prompt ${n}`, prefix: '', suffix: '' }, marks: 0, label: `turn ${n}`,
  fp: { h: '0123456789abcdef', len: 9 },
});

function facade(t, { root, ch } = {}) {
  if (!root) {
    withTempHome(t);
    root = tmpRoot();
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
    ch = claudeHome(t, { root, isolate: true });
  }
  const fake = { engine: null, ensures: 0, indexing: () => false };
  const transcripts = {
    name: 'transcripts',
    attach: (engine) => {
      fake.engine = engine;
      return {
        start: async () => {},
        stop: async () => {},
        api: {
          indexing: (cid) => fake.indexing(cid),
          opening: () => false,
          ensureConversation: async () => { fake.ensures += 1; return { ok: true }; },
        },
      };
    },
  };
  const hooks = createHookTap();
  const mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus: createBus({ maxEvents: 2000 }), redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [
      SOURCES.find((s) => s.name === 'live'),
      transcripts,
      { name: 'chat-anchors', attach: createChatAnchorsSource().attach },
    ],
  });
  t.after(() => mirror.stop());
  return { root, ch, hooks, mirror, fake };
}

test('a facade armed, not started: indexing for a well-formed id and the resolver answers indexing; after start it follows the source; ensureConversation waits for ready and reaches the source once', async (t) => {
  const h = facade(t);
  const cid = sid(1);
  h.mirror.arm();
  h.mirror.arm(); // idempotent
  assert.equal(h.fake.engine.indexing(cid), true, 'a well-formed id is indexing before the registry');
  assert.equal(h.fake.engine.indexing('not an id'), false, 'a malformed one is not');
  const [before] = await h.mirror.resolveAnchors([{ id: 'p1', v: 1, anchor: CHAT(cid, 1) }]);
  assert.equal(before.state, 'indexing', 'never unavailable before the registry has loaded');
  let settled = false;
  const ens = h.fake.engine.ensureConversation(cid).then((v) => { settled = true; return v; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'ensureConversation waits on ready');
  assert.equal(h.fake.ensures, 0, 'nothing reaches the source before it');
  assert.equal(await pending(h.mirror.ready), 'pending');
  await h.mirror.start();
  await h.mirror.ready;
  assert.deepEqual(await ens, { ok: true });
  assert.equal(h.fake.ensures, 1, 'reached the source once');
  assert.equal(h.fake.engine.indexing(cid), false, 'then the source\'s answer');
  const [after] = await h.mirror.resolveAnchors([{ id: 'p2', v: 1, anchor: CHAT(cid, 2) }]);
  assert.equal(after.state, 'unavailable');
  assert.equal(after.rule, 'gone');
});

test('ready resolves when web-chat is switched off, and on a stop() before start()', async (t) => {
  {
    const h = facade(t);
    fs.writeFileSync(projectPaths(h.root).disabled, '');
    h.mirror.arm();
    assert.equal(await pending(h.mirror.ready), 'pending');
    h.hooks.publish(envelopeOf(h.ch, 'SessionStart', NEW, { source: 'startup' }));
    assert.equal(h.mirror.enabled().enabled, false, 'switched off by the envelope\'s toggle check');
    assert.equal(await pending(h.mirror.ready), 'ready', 'a switched-off mirror strands no waiter');
    assert.equal(h.fake.engine.indexing(sid(1)), false, 'and no indexing promise');
  }
  {
    const h = facade(t);
    h.mirror.arm();
    assert.equal(await pending(h.mirror.ready), 'pending');
    await h.mirror.stop();
    assert.equal(await pending(h.mirror.ready), 'ready');
    h.mirror.arm(); // a no-op once stopped
    assert.equal(h.mirror.stats().running, false);
  }
});

test('ensureLoaded: a conversations.json with a repeated id keeps the first record', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const ch = claudeHome(t, { root, isolate: true });
  const a = sid(1);
  const b = sid(2);
  const at = Date.now() - 60000;
  for (const id of [a, b]) transcript(ch, id, at);
  const dup = { ...stored(ch, { id: a, lastActivity: at + 900, title: 'second' }), sessions: [{ session_id: b, slug: ch.slug, reason: 'start', started_at: at, ended_at: null }], current_session_id: b };
  writeJsonAtomic(projectPaths(root).mirrorConversations, {
    v: 1, conversations: [stored(ch, { id: a, lastActivity: at + 500, title: 'first' }), dup],
  });
  const h = facade(t, { root, ch });
  await h.mirror.start();
  const st = h.mirror.stats().conversations;
  assert.equal(st.conversations, 1, 'one record per id');
  assert.equal(st.sessions, 1, 'the repeat\'s sessions are not taken');
  const conv = h.mirror.snapshot({ since: 0 }).conversations.find((c) => c.id === a);
  assert.ok(conv, 'the first record listed');
  assert.equal(h.mirror.conversationOf(b), null, 'the repeated record\'s session is not held');
});

test('READY_WAIT_MS stays 2 s', () => {
  assert.equal(READY_WAIT_MS, 2000);
});
