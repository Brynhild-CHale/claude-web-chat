// The transient marks (annotation engine PLAN.md 2B.2; DECISIONS.md C6;
// readiness R3 seam 11 / X-9, GT-20; notes-B Q8-Q10; ruling
// U313@marks-remote-level = a): lib/server/domain/marks.js (ctx.marks), the
// host-only POST/GET /api/marks (lib/server/routes/marks.js), lib/driver's
// setMarks / clearMarks, and the ws-only `marks` frame carried in hello and
// reset.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil, wsConnect, tmpRoot } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { classify } = require('../lib/core/remote-policy');
const { createDriver } = require('../lib/driver');
const client = require('../lib/client');
const { createMarks, MAX_MARKS, MAX_OWNERS } = require('../lib/server/domain/marks');

const T = 20000;
const until = (pred, what) => waitUntil(pred, { timeout: T, interval: 5, what });
const MARKER = 'wc-u313-mark-label';

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status === 200 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await until(() => frames.some((f) => f.type === 'hello'), 'the hello');
  return { ws, frames, of: (type) => frames.filter((f) => f.type === type), hello: () => frames.find((f) => f.type === 'hello') };
}

function driver(t, d, owner = 'marks', opts = {}) {
  const drv = createDriver({ owner, port: d.port, ...opts });
  t.after(() => drv.release().catch(() => {}));
  return drv;
}

// Two committed nodes (p1, then p2); answers the first, which a Set active
// onto (a reset) reaches.
async function twoNodes(d) {
  const ids = [];
  for (const id of ['p1', 'p2']) {
    await ok(d.api.post('/api/render', { id, html: `<p>${id}</p>` }), `render ${id}`);
    await ok(d.api.post('/api/turn-begin', { message: id }), 'begin');
    ids.push((await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'end')).node_id);
  }
  return ids[0];
}

const mark = (i, extra = {}) => ({ mount: 'p1', kind: 'look', label: `${MARKER} ${i}`, ...extra });

// ── the holder ──────────────────────────────────────────────────────────────

test('the holder: replace-all per owner, an empty set clears it, malformed sets refused whole, caps on marks and owners', () => {
  const sent = [];
  const bus = { emit: (x) => sent.push(x) };
  const m = createMarks({ bus, now: () => 7 });
  assert.equal(m.set('service:a', [mark(1), mark(2)], { writer: { class: 'driver', owner: 'service:a', verified: true } }).count, 2);
  assert.equal(m.set('service:a', [mark(3)]).count, 1, 'replace-all');
  assert.deepStrictEqual(m.sets(), [{ owner: 'service:a', marks: [mark(3)] }]);
  assert.deepStrictEqual(sent.map((x) => Object.keys(x)), [['ws'], ['ws']], 'ws-only: no event');
  assert.deepStrictEqual(sent[1].ws, { type: 'marks', owner: 'service:a', marks: [mark(3)] });
  for (const [bad, field] of [
    [[{ kind: 'x' }], 'marks[0].mount'], [[{ mount: 'p1', kind: 'two words' }], 'marks[0].kind'],
    [[{ mount: 'p1', kind: 'x', element: 'not a pin' }], 'marks[0].element'], [[{ mount: 'p1', kind: 'x', color: 'red' }], 'marks[0].color'],
    [[{ mount: 'p1', kind: 'x', label: 'y'.repeat(201) }], 'marks[0].label'], [[{ mount: 'p1', kind: 'x', anchor: 'p' }], 'marks[0].anchor'],
  ]) {
    const r = m.set('service:a', bad);
    assert.equal(r.ok, false);
    assert.equal(r.field, field);
  }
  assert.equal(m.set('service:a', 'nope').ok, false);
  assert.equal(m.set('service:a', Array.from({ length: MAX_MARKS + 1 }, (_, i) => mark(i))).status, 413);
  assert.equal(m.set('service:a', [{ mount: 'p1', kind: 'x', label: 'y'.repeat(200), anchor: { text: 'z'.repeat(70000) } }]).status, 413);
  assert.deepStrictEqual(m.sets(), [{ owner: 'service:a', marks: [mark(3)] }], 'a refused set changed nothing');
  m.set('service:a', []);
  assert.deepStrictEqual(m.sets(), []);
  for (let i = 0; i < MAX_OWNERS; i++) assert.equal(m.set(`o${i}`, [mark(i)]).ok, true);
  assert.equal(m.set('one-more', [mark(0)]).status, 409);
  assert.equal(m.set('o0', [mark(9)]).ok, true, 'an owner already holding a set may replace it');
  m.clear();
  assert.deepStrictEqual(m.sets(), []);
});

// ── X-9 / GT-20: never the store, the ring or a node ────────────────────────

test('x9 (GT-20): 50 driver.setMarks → 0 ring entries; a no-change turn commits nothing; Set active preserves nothing; no node, draft or store holds them', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  await ok(d.api.post('/api/turn-begin', { message: 'base' }), 'begin');
  const n1 = (await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'end')).node_id;
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  await ok(d.api.post('/api/turn-begin', { message: 'second' }), 'begin');
  const n2 = (await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'end')).node_id;
  const nodes = d.srv.graph.nodes.size;

  const since = d.srv.bus.read().latest;
  const drv = driver(t, d);
  for (let i = 0; i < 50; i++) {
    const r = await drv.setMarks([mark(i)]);
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const after = d.srv.bus.read({ since });
  assert.deepStrictEqual(after.events, [], '0 ring entries');
  assert.equal(d.srv.marks.sets()[0].marks[0].label, `${MARKER} 49`);
  assert.ok(!JSON.stringify(d.srv.state.store).includes(MARKER));

  await ok(d.api.post('/api/turn-begin', { message: 'nothing' }), 'begin');
  const end = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'end');
  assert.equal(end.skipped, 'no-change', 'a following no-change turn commits nothing');
  await ok(d.api.post('/api/graph/active', { id: n1 }), 'set active n1');
  assert.equal(d.srv.graph.nodes.size, nodes, 'no preserve node');
  assert.equal(d.srv.graph.active, n1);
  void n2;
  await d.graceful();
  const dir = path.join(d.root, '.web-chat');
  const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p]);
  for (const f of walk(path.join(dir, 'graph'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(MARKER), `${f} holds no mark`);
  const draft = path.join(dir, 'draft.json');
  if (fs.existsSync(draft)) assert.ok(!fs.readFileSync(draft, 'utf8').includes(MARKER), 'draft.json holds no mark');
  for (const n of d.srv.graph.nodes.values()) assert.ok(!JSON.stringify(n.store || {}).includes(MARKER));
});

// ── on the wire ─────────────────────────────────────────────────────────────

test('on the wire: each set a `marks` frame; hello carries the sets; an empty set clears its owner\'s; a reset clears them all', async (t) => {
  const d = await withServer(t);
  const n1 = await twoNodes(d);
  const s = await socket(t, d.port);
  assert.deepStrictEqual(s.hello().marks, []);
  const a = driver(t, d, 'alpha');
  const b = driver(t, d, 'beta');
  await a.setMarks([mark(1)]);
  await b.setMarks([mark(2), mark(3)]);
  await until(() => s.of('marks').length === 2, 'two frames');
  assert.deepStrictEqual(s.of('marks'), [
    { type: 'marks', owner: 'service:alpha', marks: [mark(1)] },
    { type: 'marks', owner: 'service:beta', marks: [mark(2), mark(3)] },
  ]);
  const s2 = await socket(t, d.port);
  assert.deepStrictEqual(s2.hello().marks, [
    { owner: 'service:alpha', marks: [mark(1)] },
    { owner: 'service:beta', marks: [mark(2), mark(3)] },
  ]);
  await a.clearMarks();
  await until(() => s.of('marks').length === 3, 'the clear');
  assert.deepStrictEqual(s.of('marks')[2], { type: 'marks', owner: 'service:alpha', marks: [] });
  assert.deepStrictEqual(d.srv.marks.sets(), [{ owner: 'service:beta', marks: [mark(2), mark(3)] }]);

  await ok(d.api.post('/api/graph/active', { id: n1 }), 'set active (a reset)');
  await until(() => s.of('reset').length === 1, 'the reset');
  assert.deepStrictEqual(s.of('reset')[0].marks, [], 'the reset carries none');
  assert.deepStrictEqual(d.srv.marks.sets(), []);
  const s3 = await socket(t, d.port);
  assert.deepStrictEqual(s3.hello().marks, [], 'the next hello carries none');
});

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

test('a remote socket at basic gets no marks frame and no `marks` in hello or reset; at read the frame whole', async (t) => {
  const roots = { read: tmpRoot('wc-marks-read-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read' } } });
  const ds = { basic: await withServer(t, { seed }), read: await withServer(t, { root: roots.read }) };
  for (const [level, d] of Object.entries(ds)) {
    const n1 = await twoNodes(d);
    const drv = driver(t, d);
    await drv.setMarks([mark(1)]);
    const remote = await socket(t, d.port, { 'X-WC-Remote': '1' });
    const local = await socket(t, d.port);
    await drv.setMarks([mark(2)]);
    await until(() => local.of('marks').length === 1, `${level}: the local frame`);
    await ok(d.api.post('/api/graph/active', { id: n1 }), 'a reset');
    await until(() => local.of('reset').length === 1 && remote.of('reset').length === 1, `${level}: the resets`);
    if (level === 'basic') {
      assert.equal(remote.of('marks').length, 0, 'basic: no marks frame');
      assert.ok(!('marks' in remote.hello()), 'basic: no marks in hello');
      assert.ok(!('marks' in remote.of('reset')[0]), 'basic: no marks in reset');
    } else {
      assert.deepStrictEqual(remote.of('marks'), local.of('marks'), 'read: the frame whole');
      assert.deepStrictEqual(remote.hello().marks, [{ owner: 'service:marks', marks: [mark(1)] }]);
      assert.deepStrictEqual(remote.of('reset')[0].marks, []);
    }
    assert.deepStrictEqual(local.hello().marks, [{ owner: 'service:marks', marks: [mark(1)] }]);
  }
});

// ── the route ───────────────────────────────────────────────────────────────

function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

test('the route is host only: a remote request, a network peer and a browser are refused; the portal refuses it too', async (t) => {
  const d = await withServer(t);
  t.after(stubPeers(d.server));
  const body = { marks: [mark(1)] };
  // The rig is sound: the same request from the host's own process is taken.
  const host = await client.request(d.port, 'POST', '/api/marks', body);
  assert.equal(host.status, 200, JSON.stringify(host.body));
  await client.request(d.port, 'POST', '/api/marks', { marks: [] });
  for (const [what, headers] of [['remote', { 'X-WC-Remote': '1' }], ['network peer', { 'x-test-peer': '10.0.0.5' }]]) {
    for (const m of ['POST', 'GET']) {
      const r = await client.request(d.port, m, '/api/marks', m === 'POST' ? body : null, { headers });
      assert.equal(r.status, 403, `${what} ${m}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  const browser = await d.anonApi.post('/api/marks', body);
  assert.equal(browser.status, 403, 'a browser request (fetch metadata) is not the host');
  assert.deepStrictEqual(d.srv.marks.sets(), [], 'nothing held');
  for (const m of ['POST', 'GET']) {
    const v = classify(m, '/api/marks');
    assert.equal(v.allow, false, m);
    assert.equal(v.key, '* /api/marks');
    assert.match(v.hint, /host/i);
  }
});

test('the writer stamp: a lease names the driver\'s owner, verified; a service token, verified; a tokenless caller\'s declaration, unverified — none refused', async (t) => {
  const d = await withServer(t);
  const leased = await driver(t, d, 'leased').setMarks([mark(1)]);
  assert.deepStrictEqual(leased.writer, { class: 'driver', owner: 'service:leased', verified: true });
  const tok = d.srv.writers.mintService({ name: 'svc-x' });
  const svc = await createDriver({ owner: 'svc-x', port: d.port, writerToken: tok }).setMarks([mark(2)]);
  assert.deepStrictEqual(svc.writer, { class: 'service', owner: 'service:svc-x', verified: true });
  const plain = await client.post('/api/marks', { marks: [mark(3)], owner: 'service:declared' }, { port: d.port });
  assert.deepStrictEqual(plain.writer, { class: 'service', owner: 'service:declared', verified: false });
  const got = await client.get('/api/marks', { port: d.port });
  assert.deepStrictEqual(got.sets.map((s) => [s.owner, s.writer.verified, s.marks.length]),
    [['service:leased', true, 1], ['service:svc-x', true, 1], ['service:declared', false, 1]]);
  const bad = await client.request(d.port, 'POST', '/api/marks', { marks: [{ kind: 'x' }] });
  assert.equal(bad.status, 400);
});
