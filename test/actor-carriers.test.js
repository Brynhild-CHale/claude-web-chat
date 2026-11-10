// The actor carriers and the remote private-create refusal (annotation engine
// tranche 6, U743; PLAN.md 6B.1, 6B.2; contracts 03 C-03.20, C-03.21,
// C-03.21a, C-03.23 and its table, C-03.23a, C-03.24; 04 C-04.25; 11 C-11.7a;
// rulings U743@remote-patch-shared-false (b), U743-U757@remote-private-create-
// vs-ink (b)):
//   * C-04.25 (the lock): a remote POST /api/elements (the portal's
//     X-WC-Remote: 1 or the hub's relayed request) with payload.shared: false
//     is refused 403 {ok: false, remote: true} for a comment, a highlight, a
//     chat pin and a plug-in type, before the family switch, writing nothing;
//     a local one is accepted, a remote shared one too.
//   * the edit half (a daemon rule stricter than C-04.25): a remote PATCH that
//     sets shared to false is refused with the same body, the element
//     unchanged; a local one, a remote shared: true and a remote edit naming
//     no shared are accepted.
//   * the element version's `actor` sibling: only for a request with a valid
//     relay credential and a valid actor header, without its name, outside
//     both hashes; no reader, frame, ring entry or store accessor serves it,
//     and a reader holding the alpha.6 SIBLINGS list reads the log as before
//     (the AG-1 shape, in process) — a version written without one is byte
//     for byte what that reader writes.
//   * the queued message's `actor` and `by`: stored on the item; GET
//     /api/queue, its frames and the ring omit both; a wake's batch drops the
//     actor and keeps `by`; the retained ack and the park keep the actor; the
//     delivered block reads "... [web-chat message m-...] by=<name>:" and the
//     Push's line "Pushed from: ... by=<name>"; below read the ring drops `by`.
//   * the asks decide audit line and the control audit line carry the actor
//     for a relayed decide or invoke, and no row is handed it.
//   * U743b (the corrective): a relayed undo's version carries the actor.
// A relay secret is never printed: a failure message masks it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const { withServer, withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const { createRelayCredential } = require('../lib/server/relay-credential');
const { RELAY_HEADER, ACTOR_HEADER } = require('../lib/core/writer-token');
const { LEVEL_HEADER } = require('../lib/core/cors');
const { createServer } = require('../lib/server');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createControl } = require('../lib/server/control');
const { createAsks } = require('../lib/server/domain/asks');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { createElementLog, SIBLINGS } = require('../lib/core/element-log');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { projectToolInput, inputHash } = require('../lib/core/tool-input');
const { messageMarkers, MESSAGE_MARKER_RE } = require('../lib/core/prompt-class');
const { wakeEnvelope, messageBlock } = require('../lib/channel/envelope');
const { startChannelBridge } = require('../lib/channel/bridge');
const { createModTransport } = require('../lib/server/mod-transport');
const queue = require('../lib/server/domain/queue');

// Pin the box grab's browser finder to nothing (test/element-routes.test.js).
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const EXAMPLES = path.join(__dirname, '..', 'test-support', 'contracts', 'examples');
const example = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));
const NAMED = example('03-actor-header-named');
const UNNAMED = example('03-actor-header');
const { name: NAME, ...STORED } = NAMED;
// The actor's ids: none of them may appear in anything served.
const IDS = [NAMED.user, NAMED.session, NAMED.activity];

const SECRET = crypto.createHash('sha256').update('wc-u743-relay-secret').digest('hex');
const OTHER = crypto.createHash('sha256').update('wc-u743-another-secret').digest('hex');
const masked = (s) => String(s).split(SECRET).join('<secret>');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
// The portal's remote label (a tunnel viewer: the project is opted in at full).
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
// A request the hub relayed: the credential, the level stamp, the actor.
const relayed = ({ level = 'full', actor = NAMED, secret = SECRET } = {}) => ({
  'X-WC-Remote': '1', [RELAY_HEADER]: secret, [LEVEL_HEADER]: level,
  ...(actor ? { [ACTOR_HEADER]: JSON.stringify(actor) } : {}),
});

const RANGE = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const LOCATOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const PLUGIN = 'u743-mark';

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${masked(r.text)}`);
  return r.json;
}
const logText = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const versionsOn = (root, id) => logText(root).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t === 'ver' && r.id === id);
const carriesNoActor = (what, text) => {
  for (const id of IDS) assert.ok(!String(text).includes(id), `${what}: carries the actor's ${id.slice(0, 4)} id`);
};

// One daemon in connected mode (a relay secret, a record whose ceiling is
// full), whose tunnel viewers are opted in at full; a rendered pane m1 and an
// approved plug-in type with a declared payload.
async function boot(t) {
  const record = () => path.join(userPaths().connectorDir, 'hub-u743.json');
  const d = await withServer(t, {
    seed: ({ root }) => {
      writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'full' } } });
      writeJsonAtomic(record(), { ceiling: 'full' });
    },
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'option', connectorRecord: record() }),
  });
  assert.equal(d.srv.relay.connected, true);
  await ok(d.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello world</p>' }), 'render m1');
  approveElementPack(d, { name: 'u743-pack', type: PLUGIN, json: { payload: { keys: ['anchor', 'shared', 'label'] } } });
  return d;
}

// A local socket's frames, collected.
async function frames(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { got.push(data.toString()); });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  return got;
}

// ── C-04.25: the create refusal ─────────────────────────────────────────────

test('C-04.25: a remote POST /api/elements with payload.shared: false is refused 403 {ok: false, remote: true} for every family, before the family switch, writing nothing', async (t) => {
  const d = await boot(t);
  const { srv, root } = d;
  const bodies = {
    comment: { type: 'comment', anchor: LOCATOR, payload: { text: 'a private note', shared: false } },
    highlight: { type: 'highlight', anchor: RANGE('m1'), payload: { color: 'gold', note: 'n', shared: false } },
    'chat pin': { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 't-1' }, payload: { text: 'a private chat pin', shared: false } },
    'plug-in type': { type: PLUGIN, anchor: RANGE('m1'), payload: { label: 'l', shared: false } },
  };
  const seq = srv.elements.maxSeq();
  const bytes = logText(root);
  const comments = srv.state.comments.length;
  const refs = (srv.state.elements || []).slice();
  for (const [what, body] of Object.entries(bodies)) {
    for (const [via, headers] of [['the portal', REMOTE], ['the hub', relayed()]]) {
      const r = await d.anonApi.post('/api/elements', body, headers);
      assert.equal(r.status, 403, `${what} through ${via}: ${masked(r.text)}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.remote, true, `${what} through ${via}: the remote body (the connector's daemon-rule)`);
      assert.equal(r.json.error, 'private elements are not available remotely');
      assert.equal(typeof r.json.hint, 'string');
    }
  }
  assert.equal(srv.elements.maxSeq(), seq, 'no seq spent');
  assert.equal(logText(root), bytes, 'the log is untouched');
  assert.equal(srv.state.comments.length, comments, 'no pin on the surface');
  assert.deepEqual(srv.state.elements || [], refs, 'no reference on the surface');

  // The same request without the marker (this machine's own browser) is
  // accepted; a chat pin goes on to its own rules (no chat anchor here).
  for (const what of ['comment', 'highlight', 'plug-in type']) {
    const r = await ok(d.anonApi.post('/api/elements', bodies[what]), `${what}, local`);
    assert.equal((r.element || {}).shared, false, `${what}: written private`);
  }
  const chat = await d.anonApi.post('/api/elements', bodies['chat pin']);
  assert.notEqual(chat.json && chat.json.remote, true, `the local chat pin is not refused as remote: ${chat.text}`);

  // Remote and shared (or shared left out): accepted.
  for (const what of ['comment', 'highlight', 'plug-in type']) {
    const body = bodies[what];
    await ok(d.anonApi.post('/api/elements', { ...body, payload: { ...body.payload, shared: true } }, REMOTE), `${what}, remote shared`);
    const { shared: _s, ...rest } = body.payload;
    await ok(d.anonApi.post('/api/elements', { ...body, payload: rest }, relayed()), `${what}, relayed, shared left out`);
  }
});

// ── the edit half (U743@remote-patch-shared-false (b)) ──────────────────────

test('the edit half: a remote PATCH that sets shared: false is refused with the create\'s body and nothing changes; local, shared: true and a shared-less edit are accepted', async (t) => {
  const d = await boot(t);
  const { srv } = d;
  const c = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'shared one', shared: true } }), 'comment')).pin;
  const h = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE('m1'), payload: { color: 'gold', note: 'n' } }), 'highlight')).element;
  const now = (id) => { const v = srv.elements.latest(id); return [v.v, v.payload.shared]; };
  const before = { c: now(c.id), h: now(h.id) };
  const seq = srv.elements.maxSeq();
  for (const [via, headers] of [['the portal', REMOTE], ['the hub', relayed()]]) {
    // A comment reads `shared` by truth (`!!shared`), so a falsy non-false
    // value would make it private too: refused, fail closed.
    for (const [id, body] of [[c.id, { shared: false }], [c.id, { payload: { shared: false } }], [c.id, { shared: null }], [c.id, { shared: 0 }], [h.id, { payload: { shared: false } }], [h.id, { shared: false }]]) {
      const r = await d.anonApi.patch(`/api/elements/${id}`, body, headers);
      assert.equal(r.status, 403, `${id} ${JSON.stringify(body)} through ${via}: ${masked(r.text)}`);
      assert.deepEqual({ ok: r.json.ok, remote: r.json.remote, error: r.json.error }, { ok: false, remote: true, error: 'private elements are not available remotely' });
    }
  }
  assert.deepEqual({ c: now(c.id), h: now(h.id) }, before, 'v and shared as before');
  assert.equal(srv.elements.maxSeq(), seq, 'nothing written');

  // Remote shared: true (no change) and a remote edit naming no shared.
  const same = await ok(d.anonApi.patch(`/api/elements/${c.id}`, { shared: true }, REMOTE), 'remote shared: true');
  assert.equal(same.unchanged, true);
  const ed = await ok(d.anonApi.patch(`/api/elements/${c.id}`, { text: 'edited remotely' }, relayed()), 'relayed text edit');
  assert.deepEqual([ed.pin.v, ed.pin.shared], [2, true]);
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { note: 'remote note' } }, REMOTE), 'remote highlight edit');
  // The local browser keeps its private toggle.
  const priv = await ok(d.anonApi.patch(`/api/elements/${c.id}`, { shared: false }), 'local shared: false');
  assert.equal(priv.pin.shared, false);
});

// ── the element version's actor sibling ─────────────────────────────────────

test('the actor sibling: only a valid credential\'s valid header, without its name; outside both hashes; never served by a reader, a frame, the ring or the store', async (t) => {
  const d = await boot(t);
  const { srv, root } = d;
  const seen = await frames(t, d);
  const body = { type: 'highlight', anchor: RANGE('m1'), payload: { color: 'gold', note: 'from the hub' } };
  const w = await ok(d.anonApi.post('/api/elements', body, relayed()), 'relayed highlight');
  const id = w.element.id;
  assert.deepEqual(w.element.writer, { class: 'remote', owner: 'remote', verified: false }, 'the writer class is unchanged');
  const [v1] = versionsOn(root, id);
  assert.deepEqual(v1.actor, STORED, 'the sixth sibling: the header without its name');
  assert.ok(!('name' in v1.actor));
  assert.deepEqual(v1.provenance, { origin: 'remote', device: 'desktop' }, 'provenance never holds the actor');
  // An edit and a reply through the hub carry it too (C-03.23's write paths).
  await ok(d.anonApi.patch(`/api/elements/${id}`, { payload: { note: 'edited from the hub' } }, relayed()), 'relayed edit');
  assert.deepEqual(versionsOn(root, id)[1].actor, STORED);
  const c = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'thread', shared: true } }, relayed()), 'relayed comment')).pin;
  await ok(d.anonApi.post(`/api/elements/${c.id}/reply`, { text: 'a reply from the hub' }, relayed()), 'relayed reply');
  assert.deepEqual(versionsOn(root, c.id).map((r) => r.actor), [STORED, STORED]);
  // A glyph move through the hub is a version too (routes/element-glyph).
  await ok(d.anonApi.post(`/api/elements/${encodeURIComponent(c.id)}/glyph`, { dx: 12, dy: -8, corner: 'tr' }, relayed()), 'relayed glyph move');
  assert.deepEqual(versionsOn(root, c.id).map((r) => r.actor), [STORED, STORED, STORED], 'the glyph move records the actor');

  // The same version written without one: the same hashes, no actor field.
  const local = await ok(d.anonApi.post('/api/elements', body), 'local highlight');
  const [lv] = versionsOn(root, local.element.id);
  assert.deepEqual([lv.payload_hash, lv.src_hash], [v1.payload_hash, v1.src_hash], 'outside both hashes');
  assert.ok(!('actor' in lv), 'a local write records no actor field');
  // No credential, no actor: a tunnel request carrying the header, a local
  // one, and a relayed one whose secret is not this daemon's.
  for (const [what, headers] of [
    ['the portal with an actor header', { ...REMOTE, [ACTOR_HEADER]: JSON.stringify(NAMED) }],
    ['a local request with an actor header', { [ACTOR_HEADER]: JSON.stringify(NAMED) }],
    ['a relayed request with another secret', relayed({ secret: OTHER })],
    ['a relayed request with an actor that does not validate', { ...relayed({ actor: null }), [ACTOR_HEADER]: JSON.stringify({ ...NAMED, v: 2 }) }],
  ]) {
    const r = await d.anonApi.post('/api/elements', body, headers);
    if (r.status === 403) continue; // the other secret is basic at the stamp's gate: nothing written at all
    assert.ok(r.status === 200, `${what}: ${masked(r.text)}`);
    assert.ok(!('actor' in versionsOn(root, r.json.element.id)[0]), `${what}: no actor recorded`);
  }

  // Served nowhere, at any level: the readers, the ring, the frames, the store.
  await waitUntil(() => seen.some((f) => f.includes(id)), { timeout: 5000, what: 'the element frame' });
  const texts = [
    ['GET /api/elements, local', (await d.api.get('/api/elements')).text],
    ['GET /api/elements, a local browser', (await d.anonApi.get('/api/elements')).text],
    ['GET /api/elements, relayed', (await d.anonApi.get('/api/elements', relayed())).text],
    [`GET /api/elements?type=comment`, (await d.api.get('/api/elements?type=comment')).text],
    ['the ring', (await d.api.get('/api/events?since=0')).text],
    ['the frames', seen.join('\n')],
    ['the write answers', JSON.stringify(w)],
  ];
  for (const [what, text] of texts) carriesNoActor(what, text);
  for (const view of [srv.elements.version(id, 1), srv.elements.latest(id), ...srv.elements.versionsOf(id)]) {
    assert.ok(!('actor' in view), 'the store hands out no actor');
    assert.equal(view.actor, undefined);
  }
  assert.deepEqual(srv.elements.log.version(id, 1).actor, STORED, 'the log keeps it (the record layer, for the reconcile)');
});

// ── AG-1's shape: an alpha.6 reader over an actor sibling ───────────────────

// lib/core/element-log.js as it would read with alpha.6's SIBLINGS (five, no
// actor): the module's own source with that one line put back, compiled
// beside the real one so its requires resolve.
function alpha6ElementLog() {
  const file = require.resolve('../lib/core/element-log');
  const src = fs.readFileSync(file, 'utf8');
  const now = `const SIBLINGS = [${SIBLINGS.map((k) => `'${k}'`).join(', ')}];`;
  assert.equal(src.split(now).length, 2, 'the SIBLINGS line is spelled once');
  assert.equal(SIBLINGS.at(-1), 'actor', 'actor is the newest sibling');
  const old = `const SIBLINGS = [${SIBLINGS.slice(0, -1).map((k) => `'${k}'`).join(', ')}];`;
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src.replace(now, old), file);
  assert.deepEqual(m.exports.SIBLINGS, ['original', 'writer', 'provenance', 'owner', 'display']);
  return m.exports;
}

test('AG-1, in process: a log holding an actor sibling reads under alpha.6\'s SIBLINGS without error; a version written without one is byte for byte what alpha.6 writes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u743-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = alpha6ElementLog();
  const at = 1_790_000_000_000;
  const open = (mod, name) => mod.createElementLog({ file: path.join(dir, name), redactor: createRedactor(), now: () => at, bootId: 'b-u743' });
  const payload = { text: 'a pin', shared: true, replies: [], anchor: LOCATOR };
  const writer = { class: 'remote', owner: 'remote', verified: false };
  const provenance = { origin: 'remote', device: 'mobile' };

  // Written today with an actor, then read by the alpha.6 copy.
  const now = open({ createElementLog }, 'with-actor.jsonl');
  now.load();
  now.ensureElement({ id: 'c1', kind: 'comment', created_at: at });
  const a = now.appendVersion({ id: 'c1', payload, writer, provenance, actor: STORED, author: 'user', at });
  now.appendVersion({ id: 'c1', payload: { ...payload, text: 'edited' }, parent_v: 1, writer, provenance, author: 'user', at });
  now.close();
  const reader = open(old, 'with-actor.jsonl');
  reader.load();
  const v1 = reader.version('c1', 1);
  assert.ok(v1, 'the alpha.6 reader finds the version');
  assert.equal(v1.payload_hash, a.payload_hash);
  assert.deepEqual(v1.payload, a.payload);
  assert.deepEqual(v1.actor, STORED, 'kept as an unknown field of the record');
  assert.equal(reader.latest('c1').v, 2);
  assert.deepEqual(reader.versionsOf('c1').map((r) => r.v), [1, 2]);
  assert.doesNotThrow(() => reader.maskView(v1));
  reader.close();

  // Written without one: today's bytes are alpha.6's.
  const lines = (name, mod) => {
    const log = open(mod, name);
    log.load();
    log.ensureElement({ id: 'c1', kind: 'comment', created_at: at });
    log.appendVersion({ id: 'c1', payload, writer, provenance, author: 'user', at });
    log.close();
    return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((l) => l.includes('"t":"ver"'));
  };
  const today = lines('today.jsonl', { createElementLog });
  const then = lines('then.jsonl', old);
  assert.equal(today.length, 1);
  assert.deepEqual(today, then, 'byte-identical');
  assert.ok(!today[0].includes('"actor"'));
  // Hashes: the same payload with and without the actor.
  assert.ok(a.payload_hash && JSON.parse(today[0]).payload_hash === a.payload_hash && JSON.parse(today[0]).src_hash === a.src_hash);
});

// ── the queued message's actor and by ───────────────────────────────────────

// A channel bridge fed the ring's wake (lib/channel/bridge, with a fake client
// and notify sink, as test/channel-bridge-target.test.js): what it notifies.
async function bridged(t, event) {
  const notified = [];
  const connects = [];
  const bridge = startChannelBridge({
    notify: (method, params) => { notified.push(params); return Promise.resolve(); },
    client: { subscribeSSE: (o) => { connects.push(o); return { close() {} }; }, get: async () => ({ boot: event.boot }), post: async () => ({ ok: true }) },
    root: 'x', log: () => {}, pid: 111,
  });
  t.after(() => bridge.stop());
  await new Promise((r) => setImmediate(r));
  connects[0].onEvent(event);
  await waitUntil(() => notified.length === 1, { timeout: 2000, what: 'the notification' });
  return notified[0].content;
}

test('the queued message: actor and by on the item, in no projection; the wake drops the actor and keeps by; the ack and the park keep the actor; by= on the block and the Pushed-from line, dropped below read', async (t) => {
  const d = await boot(t);
  const { srv } = d;
  const q = await ok(d.anonApi.post('/api/queue/message', { text: 'hello from afar', send: 'hold' }, relayed()), 'relayed message');
  const item = srv.state.queue.find((it) => it.id === q.id);
  assert.deepEqual(item.actor, STORED, 'the item keeps the actor without its name');
  assert.equal(item.by, NAME, 'and the name as its own field');
  assert.deepEqual([item.origin, item.device], ['remote', 'desktop'], 'provenance unchanged');
  assert.ok(!JSON.stringify(q).includes(NAME) && !JSON.stringify(q).includes('actor'), 'the answer carries neither');
  // No credential: neither (the portal with the header; a local request).
  const tq = await ok(d.anonApi.post('/api/queue/message', { text: 'tunnel', send: 'hold' }, { ...REMOTE, [ACTOR_HEADER]: JSON.stringify(NAMED) }), 'tunnel message');
  const lq = await ok(d.api.post('/api/queue/message', { text: 'local', send: 'hold' }), 'local message');
  for (const it of srv.state.queue.filter((x) => x.id === tq.id || x.id === lq.id)) {
    assert.ok(!('actor' in it) && !('by' in it), `${it.id}: no actor, no by`);
  }

  // The projections: GET /api/queue at every level, its frames, the ring.
  const seen = await frames(t, d);
  await ok(d.anonApi.post('/api/queue/message', { text: 'a second', send: 'hold' }, relayed()), 'second relayed message');
  await waitUntil(() => seen.some((f) => f.includes('"queue"')), { timeout: 5000, what: 'the queue frame' });
  for (const [what, text] of [
    ['GET /api/queue, local', (await d.api.get('/api/queue')).text],
    ['GET /api/queue, relayed full', (await d.anonApi.get('/api/queue', relayed())).text],
    ['GET /api/queue, relayed basic', (await d.anonApi.get('/api/queue', relayed({ level: 'basic' }))).text],
    ['the queue frames', seen.join('\n')],
    ['the ring', (await d.api.get('/api/events?since=0')).text],
  ]) {
    carriesNoActor(what, text);
    assert.ok(!text.includes(`"by":`), `${what}: no by`);
  }

  // A Push through the hub, a channel live: the wake.
  item.staged = true;
  srv.state.wakeConsumers = 1;
  srv.state.wakeConsumerSeenAt = Date.now();
  const push = await ok(d.anonApi.post('/api/queue/push', {}, relayed()), 'relayed push');
  assert.equal(push.mode, 'wake', JSON.stringify(push));
  assert.ok(!('by' in push), 'the push answer carries no by (it spreads the provenance alone)');
  const ring = (await d.api.get('/api/events?since=0')).json.events;
  const wake = ring.filter((e) => e.kind === 'wake').at(-1);
  assert.equal(wake.by, NAME, 'the wake event: by beside origin and device');
  assert.deepEqual([wake.origin, wake.device], ['remote', 'desktop']);
  const sent = wake.batch.find((it) => it.id === q.id);
  assert.ok(sent && !('actor' in sent), 'the wake\'s batch drops the actor');
  assert.equal(sent.by, NAME, 'and keeps by for the message block');
  carriesNoActor('the wake', JSON.stringify(wake));
  const pa = srv.state.pendingAck;
  assert.deepEqual(pa.batch.find((it) => it.id === q.id).actor, STORED, 'the retained ack keeps the actor');
  assert.equal(pa.by, NAME);

  // What Claude reads: the bridge builds the envelope from the ring's wake.
  const content = await bridged(t, wake);
  assert.match(content, new RegExp(`^Pushed from: origin=remote device=desktop by=${NAME}$`, 'm'));
  assert.match(content, new RegExp(`^Message from the user \\[web-chat message ${item.msg_id}\\] by=${NAME}:$`, 'm'));
  assert.deepEqual(messageMarkers(content), [item.msg_id], 'MESSAGE_MARKER_RE still finds the marker');
  assert.ok(new RegExp(MESSAGE_MARKER_RE.source).test(content));
  carriesNoActor('the envelope', content);

  // Below read the ring drops by (TEXT_RULES.entries.wake); read keeps it.
  const at = async (level) => (await d.anonApi.get('/api/events?since=0', relayed({ level }))).json.events.filter((e) => e.kind === 'wake').at(-1);
  const basic = await at('basic');
  assert.ok(basic && !('by' in basic), 'basic: no by on the wake');
  assert.ok(!JSON.stringify(basic).includes(NAME), 'basic: the name nowhere in the entry');
  assert.equal((await at('read')).by, NAME, 'read: by kept');

  // Hold for the next message: the park keeps the actor and by, and renders
  // both lines; GET /api/queue/pending below read shows neither.
  const parked = await ok(d.anonApi.post('/api/queue/repush', { seq: pa.seq, park: true }, relayed()), 'relayed hold');
  assert.equal(parked.mode, 'parked');
  const park = srv.state.pendingWake;
  assert.deepEqual(park.batch.find((it) => it.id === q.id).actor, STORED, 'the park keeps the actor');
  assert.equal(park.by, NAME);
  assert.match(park.envelope.content, new RegExp(`^Pushed from: origin=remote device=desktop by=${NAME}$`, 'm'));
  assert.match(park.envelope.content, new RegExp(`\\[web-chat message ${item.msg_id}\\] by=${NAME}:`));
  carriesNoActor('the park\'s envelope', JSON.stringify(park.envelope));
  const pendBasic = (await d.anonApi.get('/api/queue/pending', relayed({ level: 'basic' }))).text;
  assert.ok(!pendBasic.includes(NAME), 'GET /api/queue/pending below read: no name');
  carriesNoActor('GET /api/queue/pending, basic', pendBasic);
  const pendLocal = (await d.api.get('/api/queue/pending')).text;
  carriesNoActor('GET /api/queue/pending, local', pendLocal);
  assert.ok(!pendLocal.includes('"by":'), 'the park is served without a by field');

  // A channel reconnecting drains the park (drainPending): the wake it emits
  // drops the actor and keeps by, and the ack it retains keeps the actor.
  const drained = queue.drainPending(srv.state, srv.bus);
  assert.ok(drained, 'the park drains');
  const dsent = drained.batch.find((it) => it.id === q.id);
  assert.ok(dsent && !('actor' in dsent), 'the drained wake\'s batch drops the actor');
  assert.equal(drained.by, NAME, 'the drained wake keeps by');
  const dpa = srv.state.pendingAck;
  assert.deepEqual(dpa.batch.find((it) => it.id === q.id).actor, STORED, 'the drain\'s retained ack keeps the actor');
  assert.equal(dpa.by, NAME);
});

test('by=: an unnamed actor, or a name that sanitises to nothing, prints no by= and changes neither line', () => {
  const base = { kind: 'message', id: 'q1', msg_id: 'm-0123abcd', text: 'hi', skill: null, files: [], source: 'composer', chars: 2 };
  const plain = messageBlock(base);
  assert.equal(plain.split('\n')[0], 'Message from the user [web-chat message m-0123abcd]:');
  for (const by of [undefined, null, '', ' ​ ', '<>']) {
    assert.equal(messageBlock({ ...base, by }), plain, JSON.stringify(by));
    const env = wakeEnvelope([{ ...base, by }], { origin: 'remote', device: 'mobile', by });
    assert.match(env.content, /^Pushed from: origin=remote device=mobile$/m, JSON.stringify(by));
    assert.ok(!env.content.includes('by='), JSON.stringify(by));
  }
  assert.equal(messageBlock({ ...base, by: 'Ada  L' }).split('\n')[0], 'Message from the user [web-chat message m-0123abcd] by=Ada L:');
  const env = wakeEnvelope([base], { origin: 'remote', device: 'mobile', by: 'Ada' });
  assert.equal(env.meta.by, undefined, 'the meta carries no name');
  assert.ok(!JSON.stringify(env.meta).includes('Ada'));
});

test('the queued message: a relayed actor without a name stores the actor and no by', async (t) => {
  const d = await boot(t);
  const q = await ok(d.anonApi.post('/api/queue/message', { text: 'unnamed', send: 'hold' }, relayed({ actor: UNNAMED })), 'relayed message');
  const item = d.srv.state.queue.find((it) => it.id === q.id);
  assert.deepEqual(item.actor, UNNAMED);
  assert.ok(!('by' in item));
  assert.equal(messageBlock(item).split('\n')[0], `Message from the user [web-chat message ${item.msg_id}]:`);
});

test('the mod\'s submit: a relayed message\'s block names its sender by=<name> and carries no actor', (t) => {
  const state = { queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {}, wakeConsumers: 0, wakeConsumerSeenAt: 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0 };
  const bus = createBus({ bootId: 'boot-u743' });
  const ops = [];
  const bridge = { sessionOf: () => '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', enqueue: (sid, op) => { ops.push(op); return Promise.resolve({ ok: true, result: {} }); } };
  const transport = createModTransport({ bridge, mirror: { snapshot: () => ({ primary: 'c1' }), liveOf: () => null }, state, bus });
  t.after(() => transport.stop());
  const item = queue.enqueueMessage(state, bus, { text: 'from the phone', skill: null, files: [], chars: 14, conversation_id: 'c1' },
    { origin: 'remote', device: 'mobile', actor: STORED, by: NAME });
  assert.deepEqual(item.actor, STORED);
  assert.deepEqual(transport(item), { via: 'mod' });
  const text = ops[0].args.text;
  assert.ok(text.startsWith(`Pushed from: origin=remote device=mobile by=${NAME}\n`), text);
  assert.ok(text.includes(`[web-chat message ${item.msg_id}] by=${NAME}:`), text);
  carriesNoActor('the submitted block', text);
});

// ── the audit lines ─────────────────────────────────────────────────────────

// An http request to the answer surface's own listener.
function answerReq(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

test('the answer surface hands a relayed decide\'s actor (no name) to asks.decide; a tunnel or wrong-secret decide hands none', async (t) => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u743-pub-'));
  t.after(() => fs.rmSync(pub, { recursive: true, force: true }));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><meta name="wc-answer-nonce" content="{{NONCE}}"></head><body></body></html>\n');
  const ASK = 'ask_0a1b2c3d4e5f';
  const metas = [];
  const asks = {
    pending: () => [{ id: ASK }],
    decide: (id, decision, meta) => { metas.push(meta); return { ok: true, state: 'decided', outcome: 'allowed', version: 2 }; },
    noteRefusal: () => {},
    waitView: async (id) => ({ id, version: 1, state: 'pending' }),
  };
  const audience = { remoteLevel: () => 'full', levelOf: () => 'full' };
  const s = createAnswerSurface({
    asks, mainPort: () => 54322, audience, relay: createRelayCredential({ secret: SECRET }),
    publicDir: pub, fontsDir: path.join(__dirname, '..', 'public', 'fonts'), idleMs: 60_000,
  });
  t.after(() => s.close());
  const { origin, port } = await s.ensure();
  for (const [what, extra, want] of [
    ['relayed', { [RELAY_HEADER.toLowerCase()]: SECRET, [ACTOR_HEADER.toLowerCase()]: JSON.stringify(NAMED) }, STORED],
    ['the portal with an actor header', { [ACTOR_HEADER.toLowerCase()]: JSON.stringify(NAMED) }, undefined],
    ['another secret', { [RELAY_HEADER.toLowerCase()]: OTHER, [ACTOR_HEADER.toLowerCase()]: JSON.stringify(NAMED) }, undefined],
  ]) {
    const doc = await answerReq(port, { path: `/answer/ask/${ASK}?layout=bar`, headers: { 'sec-fetch-dest': 'iframe', 'x-wc-remote': '1' } });
    assert.equal(doc.status, 200, masked(doc.text));
    const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.text)[1];
    const r = await answerReq(port, {
      method: 'POST', path: `/answer/api/asks/${ASK}/decide`,
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': nonce, 'x-wc-remote': '1', ...extra },
      body: { decision: { behavior: 'allow' }, version: 1 },
    });
    assert.equal(r.status, 200, `${what}: ${masked(r.text)}`);
    assert.deepEqual(metas.at(-1).actor, want, what);
    assert.equal(metas.at(-1).remote, true);
  }
});

test('asks: the decide audit line carries the actor (no name) beside the provenance; a decide without one carries none', async (t) => {
  const subs = new Set();
  const mirror = { subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, conversationOfPid: () => 'conv_1' };
  const lines = [];
  const asks = createAsks({
    bus: createBus({ maxEvents: 200 }),
    hooks: createHookTap(),
    mirror,
    getViewers: () => ({ local: 1, remote: 1, last_local_at: null, last_remote_at: null, last_full_remote_at: null }),
    audience: null,
    answerSurface: () => ({ port: 45123, ensure: async () => ({ origin: 'http://127.0.0.1:45123', port: 45123 }), remoteAnswering: () => true }),
    redactor: createRedactor(),
    root: null,
    audit: (l) => lines.push(l),
  });
  t.after(() => asks.stop());
  const create = (useId) => asks.create({
    v: 1, kind: 'permission', display: projectToolInput('Bash', { command: 'npm test' }, { profile: 'display' }),
    envelope: {
      v: 1, event: 'PermissionRequest', ts: Date.now(), session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/p',
      prompt_id: null, claude_pid: 4242, entrypoint: 'cli', permission_mode: 'default', agent: null, ask: null,
      tool: { name: 'Bash', use_id: useId, kind: 'Bash', label: 'Bash', call: 'Bash', input: {}, input_hash: inputHash({ command: 'npm test' }) },
    },
  });
  const a = await create('tu_1');
  const r1 = asks.decide(a.id, { behavior: 'allow' }, { version: 1, remote: true, device: 'mobile', ua: 'Phone', actor: NAMED });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const b = await create('tu_2');
  asks.decide(b.id, { behavior: 'deny' }, { version: 1, remote: false, device: 'desktop' });
  const decided = lines.filter((l) => l.via === 'web' && l.outcome !== 'refused');
  const first = decided.find((l) => l.ask === a.id);
  assert.deepEqual(first.actor, STORED, 'the actor without its name');
  assert.deepEqual([first.origin, first.device], ['remote', 'mobile'], 'beside the provenance');
  assert.ok(!JSON.stringify(lines).includes(NAME), 'no name on any line');
  for (const l of lines.filter((x) => x.ask === b.id)) assert.ok(!('actor' in l), 'a decide without an actor writes none');
});

test('control: a relayed invoke\'s reqCtx and audit line carry the actor (no name); no row is handed it; a tunnel invoke carries none', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-u743-control-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const surface = { spec: null, register(kind, spec) { surface.spec = spec; return () => {}; }, ensure: async () => ({ port: 1 }) };
  const mirror = { conversations: [], snapshot: () => ({ conversations: [] }), subscribe: () => () => {} };
  const control = createControl({ root, bus: createBus(), mirror, answerSurface: surface, relay: createRelayCredential({ secret: SECRET }) });
  t.after(() => control.stop());
  const ctxs = [];
  control.action('probe', {
    fields: ['x'], params: (q) => ({ x: String(q.x || '') }), key: (tg) => tg.x, layouts: ['confirm'],
    limit: { scope: 'conversation', ms: 60_000 },
    describe: async () => ({ title: 'probe', summary: 'probe' }),
    check: async (target, ctx) => { ctxs.push(ctx); return null; },
    run: async (target, ctx) => { ctxs.push(ctx); return { ok: true }; },
  });
  await control.start();
  const drive = (pairs, x) => new Promise((resolve) => {
    const headers = {};
    for (const [k, v] of pairs) headers[k.toLowerCase()] = v;
    const req = { method: 'POST', headers, rawHeaders: pairs.flat(), socket: { remoteAddress: '127.0.0.1' } };
    const res = { writableEnded: false, destroyed: false };
    const kit = { json: (_res, status, body) => { res.writableEnded = true; resolve({ status, body }); } };
    surface.spec.api(req, res, kit, { method: 'POST', rest: 'probe', query: {}, body: { x } });
  });
  const relayedPairs = [['X-WC-Remote', '1'], [RELAY_HEADER, SECRET], [ACTOR_HEADER, JSON.stringify(NAMED)]];
  const r1 = await drive(relayedPairs, 'a');
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await drive([['X-WC-Remote', '1'], [ACTOR_HEADER, JSON.stringify(NAMED)]], 'b');
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const r3 = await drive([...relayedPairs, ['X-WC-Unknown', '1']], 'c');
  assert.equal(r3.status, 200);
  const r4 = await drive(relayedPairs, 'c'); // rate-limited: a refusal's line carries it too
  assert.equal(r4.body.ok, false);
  const audit = fs.readFileSync(projectPaths(root).controlAudit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((l) => [l.target && l.target.x, l.outcome, l.actor]), [
    ['a', 'accepted', STORED],
    ['b', 'accepted', undefined],
    ['c', 'accepted', STORED],
    ['c', 'refused:rate_limited', STORED],
  ]);
  assert.deepEqual(audit.map((l) => l.origin), ['remote', 'remote', 'remote', 'remote']);
  assert.ok(!JSON.stringify(audit).includes(NAME), 'no name on any line');
  for (const c of ctxs) assert.ok(!('actor' in c), 'no row is handed the actor');
});

// ── U743b: the undo ────────────────────────────────────────────────────────

test('U743b: a relayed undo\'s version carries the actor (no name); a local undo\'s none', async (t) => {
  const d = await boot(t);
  const { root } = d;
  const body = { type: 'highlight', anchor: RANGE('m1'), payload: { color: 'gold', note: 'first' } };
  const id = (await ok(d.anonApi.post('/api/elements', body, relayed()), 'relayed highlight')).element.id;
  await ok(d.anonApi.patch(`/api/elements/${id}`, { payload: { note: 'second' } }, relayed()), 'relayed edit');
  const u = await ok(d.anonApi.post('/api/elements/undo', { item: 'm1' }, relayed()), 'relayed undo');
  assert.equal(u.undone.id, id);
  assert.equal(u.undone.how, 'reverted', JSON.stringify(u));
  const vers = versionsOn(root, id);
  assert.equal(vers.length, 3, 'the undo appended one version');
  assert.deepEqual(vers[2].actor, STORED, 'the undo\'s version: the actor, without its name');
  assert.ok(!('name' in vers[2].actor));
  assert.equal(vers[2].provenance.origin, 'remote', 'the provenance as before');
  carriesNoActor('the undo answer', JSON.stringify(u));

  // A local element, edited and undone locally: no actor field.
  const lid = (await ok(d.api.post('/api/elements', { ...body, anchor: RANGE('m1') }), 'local highlight')).element.id;
  await ok(d.api.patch(`/api/elements/${lid}`, { payload: { note: 'local second' } }), 'local edit');
  const lu = await ok(d.api.post('/api/elements/undo', { item: 'm1' }), 'local undo');
  assert.equal(lu.undone.id, lid, JSON.stringify(lu));
  const lv = versionsOn(root, lid);
  assert.equal(lv.length, 3);
  assert.ok(!('actor' in lv[2]), 'a local undo records no actor field');
});
