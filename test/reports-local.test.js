// The report path's local half (annotation engine PLAN.md 2B.1; DECISIONS.md
// A3, B6 = b; ruling U311@qualifier-mechanism = a): lib/server/domain/reports.js
// (ctx.reports), the per-surface counter on hello and reset, the `report`
// socket message from local peers, gen on the wire, and the dangling-mountId
// drop on a dom event.
//
// Every test drives a real daemon (withServer) through real sockets, as the
// chrome speaks to it: a report is a `report` frame on /ws, a pin is POST
// /api/elements {type: comment} without the writer token (the chrome's own request). Reports
// are not acknowledged on the wire, so a test waits on ctx.reports' stats.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil, wsConnect, tmpRoot, commentBody } = require('../test-support/helpers');
const { routePaths } = require('../test-support/doc-truth');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { stableHash } = require('../lib/core/stable-json');
const { specHash } = require('../lib/server/domain/lineage');
const { liveIsDirty, snapshotView } = require('../lib/server/domain/turns');
const { paneSpec, storeDigest, markdownSpec, MAX_ITEMS } = require('../lib/server/domain/reports');

const T = 20000;
const until = (pred, what) => waitUntil(pred, { timeout: T, interval: 5, what });

// A socket that records every frame; resolves once its hello is in. `headers`
// ride its upgrade (X-WC-Remote, x-test-peer).
async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await until(() => frames.some((f) => f.type === 'hello'), 'the hello');
  const of = (type) => frames.filter((f) => f.type === type);
  return {
    ws, frames, of,
    hello: () => of('hello')[0],
    send: (frame) => ws.send(JSON.stringify(frame)),
    report: (surface, mounts) => ws.send(JSON.stringify({ type: 'report', surface, mounts })),
  };
}

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status === 200 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

async function commit(api, msg) {
  await ok(api.post('/api/turn-begin', { message: msg }), 'turn-begin');
  return (await ok(api.post('/api/turn-end', { author: 'claude', summary: msg }), 'turn-end')).node_id;
}

// A pin on a pane, as the chrome sends it (no writer token).
async function pinOn(d, mount, text = 'a note') {
  const r = await ok(d.anonApi.post('/api/elements', commentBody({ text, shared: true, anchor: { mount, selector: 'p', text: 'x' } })), `pin on ${mount}`);
  assert.ok(Number.isSafeInteger(r.pin.v) && r.pin.v > 0, 'the pin names its log version');
  return { id: r.pin.id, v: r.pin.v };
}

const resetsOf = (s, n) => until(() => s.of('reset').length >= n, `reset #${n}`);
const stats = (d) => d.srv.reports.stats();
const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('local accept: a local chrome\'s report is held with a daemon-stamped {spec, store} and a {peer, device} source', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  await ok(d.api.post('/api/store', { patch: { k: 1 } }), 'store');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  s.send({ type: 'client', device: 'desktop' });
  const hello = s.hello();
  assert.ok(Number.isSafeInteger(hello.surface) && hello.surface > 0, 'hello carries the clock-seeded counter');
  assert.equal(hello.surface, d.srv.state.surface);
  const p1 = hello.mounts.find((m) => m.id === 'p1');
  assert.equal(p1.gen, 0, 'the hello\'s pane record carries its gen');

  s.report(hello.surface, [{ mount: 'p1', gen: p1.gen, items: [{ id: pin.id, v: pin.v, state: 'exact', how: 'path' }] }]);
  await until(() => stats(d).accepted === 1, 'the report accepted');
  const [a] = d.srv.reports.answers({ mount: 'p1' });
  assert.equal(a.id, pin.id);
  assert.equal(a.v, pin.v);
  assert.equal(a.state, 'exact');
  assert.equal(a.how, 'path');
  assert.deepStrictEqual(a.source, { peer: 'local', device: 'desktop' });
  assert.deepStrictEqual(a.qual, { spec: specHash(d.srv.state.mounts.get('p1')), store: stableHash(d.srv.state.store) });
  assert.equal(a.qual.store, stableHash({ k: 1 }));
  assert.equal(a.live_only, false);
  assert.equal(a.surface, hello.surface);
  assert.equal(stats(d).held, 1);
  assert.equal(sumOf(stats(d).refused), 0);
});

test('B6 across a restore (the D18 case): every reset carries a larger surface; a pre-restore report is stale-surface, the same with the new surface accepted', async (t) => {
  const d = await withServer(t);
  const s = await socket(t, d.port);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>v0</p>' }), 'render 0');
  const n0 = await commit(d.api, 'first');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>v1</p>' }), 'render 1');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>v2</p>' }), 'render 2');
  const pin = await pinOn(d, 'p1');
  const n1 = await commit(d.api, 'second');
  assert.equal(d.srv.state.mounts.get('p1').gen, 2, 'rendered three times: gen 2');
  const s0 = s.hello().surface;

  await ok(d.api.post('/api/graph/active', { id: n0 }), 'set active n0');
  await resetsOf(s, 1);
  await ok(d.api.post('/api/graph/active', { id: n1 }), 'set active n1');
  await resetsOf(s, 2);
  const [r1, r2] = s.of('reset');
  assert.ok(r1.surface > s0 && r2.surface > r1.surface, `strictly larger: ${s0} < ${r1.surface} < ${r2.surface}`);
  assert.equal(r2.surface, d.srv.reports.surface());
  const p1 = r2.mounts.find((m) => m.id === 'p1');
  assert.equal(p1.gen ?? 0, 0, 'the restored pane carries no gen (D18): it reads as 0');

  // A report against the pre-restore surface with gen 0 — equal to the
  // restored pane's gen — is the D18 hazard: it is refused for its surface.
  s.report(s0, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  await until(() => stats(d).refused['stale-surface'] === 1, 'stale-surface');
  assert.equal(stats(d).held, 0);
  s.report(r2.surface, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  await until(() => stats(d).accepted === 1, 'the current surface accepted');
  // No report is refused for its node: n1 is active, and a Set active to n0
  // with the new surface is accepted just as well.
  await ok(d.api.post('/api/graph/active', { id: n0 }), 'set active n0 again');
  await resetsOf(s, 3);
  assert.equal(stats(d).held, 0, 'a bump empties the held table');
  const r3 = s.of('reset')[2];
  s.report(r3.surface, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'orphaned' }] }]);
  await until(() => stats(d).accepted === 2, 'accepted on the older node');
  const refused = stats(d).refused;
  assert.deepStrictEqual(Object.keys(refused), ['stale-surface'], 'nothing else refused, no node reason');
});

test('Wipe and New graph each bump the counter and stamp it on their reset; an id re-rendered after a Wipe, reported with the old surface, is stale-surface', async (t) => {
  const d = await withServer(t);
  const s = await socket(t, d.port);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>a</p>' }), 'render');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>b</p>' }), 're-render');
  const pin = await pinOn(d, 'p1');
  const before = d.srv.reports.surface();
  await ok(d.api.post('/api/graph/wipe', {}), 'wipe');
  await resetsOf(s, 1);
  assert.equal(s.of('reset')[0].surface, before + 1);
  const r = await ok(d.api.post('/api/render', { id: 'p1', html: '<p>c</p>' }), 'render after wipe');
  assert.ok(r);
  assert.equal(d.srv.state.mounts.get('p1').gen, 0, 'the cleared id restarts at gen 0');
  s.report(before, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  await until(() => stats(d).refused['stale-surface'] === 1, 'stale-surface after the wipe');
  assert.equal(stats(d).held, 0);

  const mid = d.srv.reports.surface();
  await ok(d.api.post('/api/graph/new', { name: 'fresh' }), 'new graph');
  await resetsOf(s, 2);
  assert.equal(s.of('reset')[1].surface, mid + 1);
  assert.equal(d.srv.state.surface, mid + 1);
});

test('gen on the wire: render frames, a queue Revert\'s re-broadcast, markdown frames and hello/reset\'s markdown entries; stale-gen, unknown-gen and not-live', async (t) => {
  const d = await withServer(t);
  const s = await socket(t, d.port);
  const HTML = '<form><input id="a"><button>Apply</button></form>';
  await ok(d.api.post('/api/render', { id: 'p1', html: HTML }), 'render');
  await until(() => s.of('render').length === 1, 'render frame');
  assert.equal(s.of('render')[0].gen, 0);
  await ok(d.api.post('/api/render', { id: 'p1', html: HTML + ' ' }), 're-render');
  await until(() => s.of('render').length === 2, 'second render frame');
  assert.equal(s.of('render')[1].gen, 1);

  // A queue Revert re-broadcasts the pane as it stands (emitMount): same gen.
  s.send({ type: 'pane:form', id: 'p1', form_state: { '#a:0': { value: 'typed' } } });
  s.send({ type: 'event', payload: { type: 'change', mountId: 'p1', tag: 'INPUT' } });
  let item;
  await until(async () => (item = (await d.api.get('/api/queue')).json.items.find((x) => x.kind === 'activity')), 'activity item');
  const del = await d.api.del('/api/queue/' + item.id + '?revert=1');
  assert.equal(del.json.reverted, true);
  await until(() => s.of('render').length === 3, 'the revert\'s render frame');
  assert.equal(s.of('render')[2].gen, 1, 'the unchanged gen');

  // Markdown: the frame and the full-surface entries carry the item's gen.
  await ok(d.api.post('/api/markdown', { id: 'md-a', text: '# One' }), 'markdown');
  await ok(d.api.post('/api/markdown', { id: 'md-a', text: '# Two' }), 'markdown again');
  await until(() => s.of('markdown').length === 2, 'markdown frames');
  assert.deepStrictEqual(s.of('markdown').map((f) => f.gen), [0, 1]);
  const late = await socket(t, d.port);
  assert.equal(late.hello().markdown.find((m) => m.id === 'md-a').gen, 1, 'hello\'s markdown entry');
  assert.equal(late.hello().mounts.find((m) => m.id === 'p1').gen, 1, 'hello\'s pane record');
  await ok(d.api.post('/api/graph/wipe', {}), 'wipe');
  await resetsOf(s, 1);
  await ok(d.api.post('/api/markdown', { id: 'md-b', text: 'b' }), 'markdown b');
  await ok(d.api.post('/api/graph/new', { name: 'g' }), 'new graph');
  await resetsOf(s, 2);
  // After New graph nothing is live; render again and read a reset's entries.
  await ok(d.api.post('/api/markdown', { id: 'md-c', text: 'c' }), 'markdown c');
  await ok(d.api.post('/api/markdown', { id: 'md-c', text: 'c2' }), 'markdown c2');
  const n = await commit(d.api, 'with md');
  await ok(d.api.post('/api/markdown', { id: 'md-d', text: 'd' }), 'markdown d');
  await commit(d.api, 'after md');
  await ok(d.api.post('/api/graph/active', { id: n }), 'set active');
  await resetsOf(s, 3);
  const entry = s.of('reset')[2].markdown.find((m) => m.id === 'md-c');
  assert.ok(entry, 'the reset names the markdown item');
  assert.equal(entry.gen ?? 0, 0, 'a restored markdown item has no live gen: it reads as 0');

  // The gen checks, on the current surface.
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>x</p>' }), 'p2');
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>y</p>' }), 'p2 again');
  const pin = await pinOn(d, 'p2');
  const sur = d.srv.reports.surface();
  const item1 = { id: pin.id, v: pin.v, state: 'exact' };
  s.report(sur, [{ mount: 'p2', gen: 0, items: [item1] }]);
  await until(() => stats(d).refused['stale-gen'] === 1, 'stale-gen');
  s.report(sur, [{ mount: 'p2', gen: 2, items: [item1] }]);
  await until(() => stats(d).refused['unknown-gen'] === 1, 'unknown-gen');
  await ok(d.api.post('/api/clear', { id: 'p2' }), 'clear p2');
  s.report(sur, [{ mount: 'p2', gen: 1, items: [item1] }]);
  await until(() => stats(d).refused['not-live'] === 1, 'not-live');
  assert.equal(stats(d).accepted, 0);
  assert.equal(stats(d).held, 0);
});

// ── who may report ──────────────────────────────────────────────────────────

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

test('a remote socket at basic, read and full, and a network peer: the report moves nothing, refused.peer counts it', async (t) => {
  const roots = { read: tmpRoot('wc-rep-read-'), full: tmpRoot('wc-rep-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const ds = { basic: await withServer(t, { seed }), read: await withServer(t, { root: roots.read }), full: await withServer(t, { root: roots.full }) };
  for (const [level, d] of Object.entries(ds)) {
    // An upgrade carrying x-test-peer comes from that address (a network peer).
    d.server.prependListener('upgrade', (r) => {
      const addr = r.headers['x-test-peer'];
      if (addr) Object.defineProperty(r.socket, 'remoteAddress', { value: addr, configurable: true });
    });
    await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render');
    const pin = await pinOn(d, 'p1');
    const remote = await socket(t, d.port, { 'X-WC-Remote': '1' });
    const peer = await socket(t, d.port, { 'x-test-peer': '10.0.0.5' });
    const sur = d.srv.reports.surface();
    const msg = [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }];
    remote.report(sur, msg);
    peer.report(sur, msg);
    await until(() => stats(d).refused.peer === 2, `${level}: refused.peer`);
    assert.equal(stats(d).accepted, 0, `${level}: nothing accepted`);
    assert.equal(stats(d).held, 0, `${level}: nothing held`);
    // The same report from a local socket is accepted (the rig is sound).
    const local = await socket(t, d.port);
    local.report(sur, msg);
    await until(() => stats(d).accepted === 1, `${level}: the local one`);
  }
});

test('a service pane\'s answers are held live-only and never recordable; a Claude pane\'s are', async (t) => {
  const d = await withServer(t);
  const drv = require('../lib/driver').createDriver({ owner: 'svc', port: d.port });
  const r = await drv.render({ id: 'svc-p', html: '<p>live</p>' });
  assert.notEqual(r && r.ok, false, JSON.stringify(r));
  assert.equal(d.srv.state.mounts.get('svc-p').owner, 'service:svc');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>mine</p>' }), 'render p1');
  const a = await pinOn(d, 'svc-p');
  const b = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  s.report(s.hello().surface, [
    { mount: 'svc-p', gen: 0, items: [{ id: a.id, v: a.v, state: 'exact' }] },
    { mount: 'p1', gen: 0, items: [{ id: b.id, v: b.v, state: 're-resolved' }] },
  ]);
  await until(() => stats(d).accepted === 2, 'both accepted');
  assert.equal(stats(d).live_only, 1);
  assert.equal(d.srv.reports.answers({ mount: 'svc-p' })[0].live_only, true);
  const st = d.srv.state;
  const got = d.srv.reports.recordable({ specOf: (m) => (st.mounts.has(m) ? paneSpec(st.mounts.get(m)) : null), storeDigest: storeDigest(st.store) });
  assert.deepStrictEqual(got.map((x) => x.mount), ['p1'], 'the service pane\'s answer is never recordable');
  // A qualifier that does not match the node records nothing.
  assert.deepStrictEqual(d.srv.reports.recordable({ specOf: () => 'nope', storeDigest: storeDigest(st.store) }), []);
  assert.deepStrictEqual(d.srv.reports.recordable({ specOf: (m) => paneSpec(st.mounts.get(m)), storeDigest: storeDigest({ other: 1 }) }), []);
});

test('shape: hidden refused, an unknown id@v dropped, a version anchored on another mount dropped, a 5 KB record dropped, 501 items and 256 KB refused; every refusal counted', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const a = await pinOn(d, 'p1');
  const b = await pinOn(d, 'p2');
  const s = await socket(t, d.port);
  const sur = s.hello().surface;
  const good = { id: a.id, v: a.v, state: 'exact' };
  s.report(sur, [{ mount: 'p1', gen: 0, items: [
    { ...good, state: 'hidden' },
    { ...good, state: 'draw-failed' },
    { id: a.id, v: a.v + 50, state: 'exact' },
    { id: 'c999', v: 1, state: 'exact' },
    { id: b.id, v: b.v, state: 'exact' },
    { ...good, record: { mount: 'p1', pad: 'x'.repeat(5 * 1024) } },
    { ...good, record: { mount: 'p2' } },
    { ...good, how: 'x'.repeat(33) },
    { ...good, tie: 'near' },
    { ...good, record: { mount: 'p1', kind: 'element' }, how: 'exact-find', tie: 0.5 },
  ] }]);
  await until(() => stats(d).accepted === 1, 'the one good item');
  const drop = stats(d).dropped_items;
  assert.deepStrictEqual(drop, { state: 2, 'unknown-version': 2, 'other-mount': 1, record: 2, shape: 2 });
  const [held] = d.srv.reports.answers({ mount: 'p1' });
  assert.deepStrictEqual(held.record, { mount: 'p1', kind: 'element' });
  assert.equal(held.tie, 0.5);

  const many = Array.from({ length: MAX_ITEMS + 1 }, () => good);
  s.report(sur, [{ mount: 'p1', gen: 0, items: many }]);
  await until(() => stats(d).refused['too-many-items'] === 1, 'too-many-items');
  s.ws.send(JSON.stringify({ type: 'report', surface: sur, mounts: [{ mount: 'p1', gen: 0, items: [good] }], pad: 'x'.repeat(257 * 1024) }));
  await until(() => stats(d).refused['too-large'] === 1, 'too-large');
  s.report(sur, Array.from({ length: 201 }, () => ({ mount: 'p1', gen: 0, items: [] })));
  await until(() => stats(d).refused['too-many-mounts'] === 1, 'too-many-mounts');
  s.ws.send(JSON.stringify({ type: 'report', surface: 'now', mounts: [] }));
  await until(() => stats(d).refused.shape === 1, 'shape');
  s.report(sur + 1, [{ mount: 'p1', gen: 0, items: [good] }]);
  await until(() => stats(d).refused['unknown-surface'] === 1, 'unknown-surface');
  assert.equal(stats(d).accepted, 1, 'none of those accepted anything');
});

test('the replace rule: another viewer at an equal key never replaces; the same viewer does; a newer storeEpoch does', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render');
  const pin = await pinOn(d, 'p1');
  const A = await socket(t, d.port);
  const B = await socket(t, d.port);
  const sur = A.hello().surface;
  const say = (s, state) => s.report(sur, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state }] }]);
  const heldState = () => d.srv.reports.answers({ mount: 'p1' })[0].state;

  say(A, 'exact');
  await until(() => stats(d).accepted === 1, 'A');
  say(B, 'orphaned');
  await until(() => stats(d).dropped_items.outranked === 1, 'B outranked');
  assert.equal(heldState(), 'exact', 'A\'s answer kept');
  say(A, 're-resolved');
  await until(() => stats(d).accepted === 2, 'A again');
  assert.equal(heldState(), 're-resolved', 'A replaces its own at an equal key');
  await ok(d.api.post('/api/store', { patch: { moved: 1 } }), 'store write');
  say(B, 'orphaned');
  await until(() => stats(d).accepted === 3, 'B after the store write');
  assert.equal(heldState(), 'orphaned', 'a newer storeEpoch replaces');
  assert.equal(d.srv.reports.answers({ mount: 'p1' })[0].qual.store, stableHash({ moved: 1 }));
  assert.equal(stats(d).held, 1);
});

test('confirm: after a store write, an empty items list re-stamps the viewer\'s held answers with the new store; without it they keep the old one', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  const other = await socket(t, d.port);
  const sur = s.hello().surface;
  s.report(sur, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  await until(() => stats(d).accepted === 1, 'the report');
  const oldStore = stableHash(d.srv.state.store);
  assert.equal(d.srv.reports.answers()[0].qual.store, oldStore);
  await ok(d.api.post('/api/store', { patch: { q: 2 } }), 'store write');
  // Another viewer's confirm does not touch this viewer's answer.
  other.report(sur, [{ mount: 'p1', gen: 0, items: [] }]);
  await until(() => stats(d).confirms === 1, 'the other\'s confirm');
  assert.equal(d.srv.reports.answers()[0].qual.store, oldStore, 'without its own confirm the old store stays');
  s.report(sur, [{ mount: 'p1', gen: 0, items: [] }]);
  await until(() => stats(d).confirms === 2, 'the confirm');
  const a = d.srv.reports.answers()[0];
  assert.equal(a.qual.store, stableHash({ q: 2 }));
  assert.equal(a.qual.spec, specHash(d.srv.state.mounts.get('p1')));
  assert.equal(a.state, 'exact', 'the answer itself is unchanged');
});

test('a report racing a store write is counted for the gate (stamped_after_store_change)', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  const sur = s.hello().surface;
  const say = () => s.report(sur, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  say();
  await until(() => stats(d).accepted === 1, 'first');
  assert.equal(stats(d).stamped_after_store_change, 0);
  await ok(d.api.post('/api/store', { patch: { r: 1 } }), 'store write');
  say();
  await until(() => stats(d).accepted === 2, 'second');
  assert.equal(stats(d).stamped_after_store_change, 1);
  // A viewer's first report after a write may have resolved before it: counted.
  await ok(d.api.post('/api/store', { patch: { r: 2 } }), 'store write 2');
  const fresh = await socket(t, d.port);
  fresh.report(sur, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }]);
  await until(() => stats(d).accepted === 3, 'the fresh viewer');
  assert.equal(stats(d).stamped_after_store_change, 2);
});

test('monotone across a restart: the next daemon of the same root stamps a larger surface', async (t) => {
  const first = await withServer(t);
  const h1 = (await socket(t, first.port)).hello().surface;
  await first.graceful();
  const second = await withServer(t, { root: first.root });
  const h2 = (await socket(t, second.port)).hello().surface;
  assert.ok(h2 > h1, `${h2} > ${h1}`);
});

test('S-15 by construction: 200 accepted reports add no ring entry, flip no dirty check, change no snapshot, and leave no key in the draft', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render');
  await ok(d.api.post('/api/markdown', { id: 'md-a', text: '## Heading' }), 'markdown');
  const pin = await pinOn(d, 'p1');
  await commit(d.api, 'clean');
  const s = await socket(t, d.port);
  const g = d.srv.graph;
  assert.equal(liveIsDirty(g), false);
  const view0 = snapshotView(g.snapshotLive());
  const since = d.srv.bus.read({}).latest;
  const sur = s.hello().surface;
  let flips = 0;
  for (let i = 0; i < 200; i++) {
    const states = ['exact', 're-resolved', 'orphaned'];
    s.report(sur, [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: states[i % 3], tie: i }] }]);
    if (i % 20 === 0) {
      await until(() => stats(d).accepted === i + 1, `report ${i}`);
      if (liveIsDirty(g)) flips += 1;
    }
  }
  await until(() => stats(d).accepted === 200, 'all 200');
  assert.equal(flips, 0, 'no dirty-check flip');
  assert.equal(liveIsDirty(g), false);
  assert.deepStrictEqual(d.srv.bus.read({ since }).events, [], 'no ring entry');
  assert.equal(snapshotView(g.snapshotLive()), view0, 'the live snapshot is unchanged');
  assert.deepStrictEqual(s.frames.filter((f) => f.type !== 'hello'), [], 'no ws frame');
  // A markdown item's spec is its text's, not the pane hash of nothing.
  assert.notEqual(markdownSpec('## Heading'), markdownSpec('## Other'));
  await d.graceful();
  const draftFile = projectPaths(d.root).draft;
  const raw = fs.readFileSync(draftFile, 'utf8');
  for (const word of ['surface', 'report', 'qual', 'live_only']) assert.ok(!raw.includes(`"${word}"`), `the draft has no "${word}" key`);
});

test('a dom event naming no live pane reaches the ring with mountId null; a click in a live pane keeps its origin', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p><button>go</button></p>' }), 'render');
  const s = await socket(t, d.port);
  const since = d.srv.bus.read({}).latest;
  s.send({ type: 'event', payload: { type: 'click', mountId: 'el-x', tag: 'BUTTON' } });
  let ev;
  await until(() => (ev = d.srv.bus.read({ since, kinds: ['dom'] }).events[0]), 'the dom event');
  assert.equal(ev.mountId, null, 'the dangling id is dropped');
  const q = (await d.api.get('/api/queue')).json.items;
  assert.ok(!JSON.stringify(q).includes('el-x'), 'the queue names no el-x');

  s.send({ type: 'event', payload: { type: 'click', mountId: 'p1', tag: 'BUTTON' } });
  let item;
  await until(async () => (item = (await d.api.get('/api/queue')).json.items.find((x) => x.origin_mount === 'p1')), 'p1 activity');
  assert.equal(item.kind, 'activity');
  const evs = d.srv.bus.read({ since, kinds: ['dom'] }).events;
  assert.equal(evs.at(-1).mountId, 'p1');
});

test('no main-port route carries a report', () => {
  const paths = [...routePaths()];
  assert.ok(!paths.some((p) => /report/i.test(p)), `no report route: ${paths.filter((p) => /report/i.test(p))}`);
});

test('a source anchor (a highlight on prose) is anchored on its markdown item: reported for md-1 it is held, not dropped other-mount', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/markdown', { id: 'md-1', text: '## Kept prose' }), 'md-1');
  await ok(d.api.post('/api/markdown', { id: 'md-2', text: 'other' }), 'md-2');
  const anchor = { v: 1, kind: 'source', md: 'md-1', slug: 'kept-prose', quote: { exact: 'Kept', prefix: '', suffix: '' } };
  const hl = (await ok(d.api.post('/api/elements', { type: 'highlight', anchor, payload: { note: 'n' } }), 'highlight')).element;
  const s = await socket(t, d.port);
  const sur = s.hello().surface;
  const gen = s.hello().markdown.find((m) => m.id === 'md-1').gen ?? 0;
  const item = { id: hl.id, v: hl.v, state: 'exact', how: 'unique' };
  s.report(sur, [{ mount: 'md-2', gen: 0, items: [item] }]);
  await until(() => (stats(d).dropped_items['other-mount'] || 0) === 1, 'reported for another markdown item: other-mount');
  s.report(sur, [{ mount: 'md-1', gen, items: [item] }]);
  await until(() => stats(d).accepted === 1, 'reported for its own md item: accepted');
  const [a] = d.srv.reports.answers({ mount: 'md-1' });
  assert.deepStrictEqual([a.id, a.v, a.state], [hl.id, hl.v, 'exact']);
  assert.equal(stats(d).dropped_items['other-mount'], 1, 'only the md-2 report was dropped');
});
