// The fixture strokes pack, end to end on a real daemon (annotation engine
// tranche 4, plan 4F.4, U565; DECISIONS.md N.1 AD3 (b), AD5, AD6; B1; rulings
// PRIVATE@create AF2 (a), REQ@ink-tools AD6 (c), WRITER@undo-selection AF10
// (a), UNDO@scope AF9 (a), U513-U565@payload-decl (a), U561@stroke-keys-and-
// window (a), U511-U565@approveElementPack-twice (a), SEARCH@latest).
//
// test-support/element-packs/strokes-fixture is a checked-in pack with one
// box-placed strokes type, `scribble`. This file takes it down the path the
// first real strokes pack takes (the ink pack, U566), in order, through the
// pipeline's own routes and nothing hand-installed:
//   (1) a direct `pack install` is refused with the get/review/approve hint (B1);
//   (2) staged (test-support/element-type-fixture stageElementPack: the
//       GitHub stand-in plus POST /api/packs/quarantine) → listed nowhere;
//   (3) approved from the answer surface's confirm frame (approveFromFrame)
//       → listed, its payload declaration registered;
//   (4) GET /api/elements/types/scribble/draw.js serves the fixture's bytes (U511);
//   (5) its element.json declares exactly lib/core/strokes STROKE_KEYS ∪
//       DESCRIBE_KEYS; a payload with a key it does not name is refused, the
//       refusal naming the key (no silent loss);
//   (6) a stroke built by lib/core/strokes (decimate, roundPoints) on a svg
//       target's element record, shared false, POSTed as target-frame.js's
//       commit sends it → stored private; no queue item, nothing in a Push's
//       envelope; GET /api/elements/search below seesPrivate (a network peer
//       at basic, the remote read viewer, Claude's lib/client) → 0 hits for
//       its text_under, the host's own browser → 1;
//   (7) POST /api/elements/undo {item} by its writer drops its reference (the
//       engine's undo over a plug-in type, U518's rule); a pane's newer stroke
//       on the same item is named in `newer` and the hint and left as it is;
//   (8) a second stroke shared (PATCH) and sent (POST /:id/send) → one queue
//       item, delivered on Push.
// The document case (a private stroke absent from a document for a reader
// below seesPrivate) is U590's, over U521 (notes-F §2).
//
// Who is who (test/element-undo.test.js's terms): `anonApi` is a local
// browser (the writer 'user'); with X-WC-Pane: <mount> a pane's stamp; a
// remote viewer is lib/client's request carrying X-WC-Remote: 1 at the
// project's `read` opt-in seeded into the sandbox's tunnel.json; a network
// peer is a request whose socket address is stubbed to 10.0.0.5 (basic).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { withServer, tmpRoot } = require('../test-support/helpers');
const { fakeForge, repoWithArchive } = require('../test-support/packs');
const { stageElementPack, approveFromFrame } = require('../test-support/element-type-fixture');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, PUBLIC_DIR } = require('../lib/core/paths');
const { schemaRow, PLUGIN_META_KEY } = require('../lib/core/element-log');
const { PANE_HEADER } = require('../lib/core/writer-token');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const client = require('../lib/client');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE_DIR = path.join(PACK_DIR, 'elements', 'scribble');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const MOUNT = 'sp1';
const PANE_HTML = '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path d="M0 0 L10 10"/></g></svg>'
  + '<p class="prose">Some prose beside the chart.</p></div>';
const UNDER = 'wcu565 the rising line under the stroke';
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const PANE = Object.freeze({ [PANE_HEADER]: MOUNT });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test', style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
});

async function ok(p, what) {
  const r = await p;
  const body = r.json !== undefined ? r.json : r.body;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(body)}`);
  return body;
}
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);

// Requests carrying x-test-peer arrive from that address (a network peer).
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => { server.off('request', onRequest); };
}

// The svg's element record as the chrome's resolver makes it: the pane's
// html mounted the way the chrome mounts it (mount-runtime attachAndExtract),
// then lib/core/anchors record on the outermost svg — the anchor a strokes
// type's commit sends (target-frame.js: the frame's record).
function svgRecord() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
    const host = dom.window.document.createElement('div');
    host.dataset.mountId = MOUNT;
    dom.window.document.body.appendChild(host);
    const root = dom.window.__wcMount.attachAndExtract(host, PANE_HTML).root;
    return JSON.parse(JSON.stringify(anchors.record(root, root.querySelector('svg.art'), { mount: MOUNT })));
  } finally { dom.window.close(); }
}

// A stroke's body exactly as target-frame.js's commit builds it: the samples
// in frame units (x, y, pressure, ms), decimated and rounded by
// lib/core/strokes, width as a fraction of the frame's width, shared as the
// type passes it (false: PRIVATE@create).
function strokeBody(anchor, { shared = false, under = UNDER, extra = {} } = {}) {
  const raw = [];
  for (let i = 0; i < 12; i++) raw.push(0.1 + i * 0.07, 0.8 - i * 0.05, 0.5, i * 8);
  const points = strokes.roundPoints(strokes.decimate(raw));
  return {
    type: TYPE,
    anchor,
    payload: {
      text_under: under, bbox: strokes.bboxOf(points),
      shared, tool: 'pen', width: 2 / 200, colour: 'accent', points, stride: strokes.STROKE_STRIDE, aspect: 2,
      ...extra,
    },
  };
}

test('the fixture strokes pack: review → approve from the confirm frame → listed → served → a stroke stored private → absent below seesPrivate → undone → shared and sent', async (t) => {
  const root = tmpRoot('wc-u565-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } });
  const d = await withServer(t, { root, seed });
  t.after(stubPeers(d.server));
  const call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
  const listedTypes = async () => (await ok(d.api.get('/api/elements/types'), 'types')).types.map((r) => r.type);
  await ok(d.api.post('/api/render', { id: MOUNT, html: PANE_HTML }), 'render the pane');
  const anchor = svgRecord();
  assert.equal(anchor.kind, 'element');
  assert.equal(anchor.mount, MOUNT);
  const ids = {};

  await t.test('(1) a direct install of the fixture is refused with the get/review/approve hint (B1), and nothing lands', async () => {
    const forge = await fakeForge(t, { repos: { 'acme/direct': repoWithArchive(PACK_DIR) } });
    const url = forge.url('acme', 'direct');
    const r = await d.api.post('/api/packs/install', { url });
    assert.equal(r.json.ok, false, r.text);
    assert.match(r.json.hint, new RegExp(`claude-web-chat pack get ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, then claude-web-chat pack review ${PACK} and claude-web-chat pack approve ${PACK}`));
    assert.ok(!(await listedTypes()).includes(TYPE));
  });

  await t.test('(2) staged through the real quarantine: waiting on its card, listed nowhere', async () => {
    const staged = await stageElementPack(t, d, { dir: PACK_DIR, owner: 'acme', repo: 'strokes' });
    assert.equal(staged.res.json.ok, true, staged.res.text);
    const waiting = (await ok(d.api.get('/api/packs'), 'packs')).quarantined;
    assert.deepEqual(waiting.map((q) => [q.name, (q.elements || []).map((e) => e.name)]), [[PACK, [TYPE]]]);
    assert.ok(!(await listedTypes()).includes(TYPE), 'quarantined: not listed');
    const draw = await d.api.get(`/api/elements/types/${TYPE}/draw.js`);
    assert.equal(draw.status, 404, 'nor served');
  });

  await t.test('(3) approved from the confirm frame: the review names the type, the install lands, the type is listed', async () => {
    const out = await approveFromFrame(d.srv, { name: PACK, tier: 'local' });
    assert.equal(out.doc.status, 200);
    assert.ok(out.desc.lines.some((l) => l.startsWith(`Element type ${TYPE} — schema ${TYPE}@1 · anchors element`)), JSON.stringify(out.desc.lines));
    assert.equal(out.res.status, 200, JSON.stringify(out.res.body));
    assert.deepEqual(out.res.body, { ok: true, said: `Installed ${PACK}: ${TYPE}` });
    const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
    assert.ok(row, 'listed once approved');
    assert.equal(row.builtin, false);
    assert.equal(row.private, true);
    assert.equal(row.family, 'page');
    assert.deepEqual(row.anchors, ['element']);
    assert.equal(row.toolbar.input, 'strokes');
    assert.equal(row.toolbar.place, 'box');
    const bytes = fs.readFileSync(path.join(TYPE_DIR, 'draw.js'));
    assert.equal(row.draw.sha256, crypto.createHash('sha256').update(bytes).digest('hex'), 'the listing carries the installed draw.js digest');
    assert.equal((await ok(d.api.get('/api/packs'), 'packs')).quarantined.length, 0);
  });

  await t.test('(4) GET /api/elements/types/scribble/draw.js serves the fixture\'s bytes, and they are self-contained and under 2 KB', async () => {
    const bytes = fs.readFileSync(path.join(TYPE_DIR, 'draw.js'));
    const r = await d.anonApi.get(`/api/elements/types/${TYPE}/draw.js`);
    assert.equal(r.status, 200);
    assert.equal(r.text, bytes.toString('utf8'), 'byte-equal to the checked-in file');
    assert.match(r.headers.get('content-type'), /^text\/javascript/);
    assert.ok(bytes.length < 2048, `${bytes.length} bytes`);
    const src = bytes.toString('utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /\bimport\b|\bfetch\(|\beval\(|new Function|XMLHttpRequest|WebSocket/, 'no import, fetch or eval: it is inlined under PREVIEW_CSP');
    assert.match(code, /^export default function draw\(group, ctx\)/m, 'the default export is the function draw');
    assert.match(code, /^export function create\(input, ctx\)/m, 'create a named export');
  });

  await t.test('(5) element.json declares exactly STROKE_KEYS ∪ DESCRIBE_KEYS; a payload with a key it does not name is refused, naming the key', async () => {
    const json = JSON.parse(fs.readFileSync(path.join(TYPE_DIR, 'element.json'), 'utf8'));
    const want = [...strokes.STROKE_KEYS, ...strokes.DESCRIBE_KEYS];
    assert.deepEqual([...json.payload.keys].sort(), [...want].sort(), 'the contract every strokes type meets');
    assert.equal(json.payload.keys.length, new Set(json.payload.keys).size, 'no key twice');
    const row = schemaRow(`${TYPE}@1`);
    assert.ok(row && row.plugin, 'the registry registered the declaration');
    assert.deepEqual([...row.keys].sort(), [...want, PLUGIN_META_KEY].sort());

    const before = (d.srv.state.elements || []).slice();
    const r = await d.anonApi.post('/api/elements', strokeBody(anchor, { extra: { pressure_curve: 'soft' } }));
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, 'the payload does not fit the type\'s schema');
    assert.match(r.json.detail, /pressure_curve/, 'the refusal names the key it does not take');
    assert.deepEqual(d.srv.state.elements || [], before, 'nothing stored');
  });

  await t.test('(6) a stroke committed shared:false is stored private: no queue item, nothing in a Push\'s envelope, 0 hits below seesPrivate, 1 for the host\'s browser', async () => {
    const body = strokeBody(anchor);
    assert.ok(strokes.isStrokePayload(body.payload), 'a stroke payload by lib/core/strokes');
    const rec = (await ok(d.anonApi.post('/api/elements', body), 'POST the stroke')).element;
    ids.priv = rec.id;
    assert.match(rec.id, /^p/, 'a plug-in id');
    assert.equal(rec.type, TYPE);
    assert.equal(rec.shared, false, 'stored private');
    assert.deepEqual(rec.points, body.payload.points);
    assert.deepEqual(rec.writer, { class: 'user', owner: 'user', verified: false });
    assert.deepEqual(d.srv.state.elements, [`${rec.id}@1`], 'its reference on the surface');
    assert.equal(d.srv.elements.record(rec.id, 1).shared, false);

    assert.deepEqual(d.srv.state.queue.filter((it) => it.kind === 'element'), [], 'no queue item');
    const pushed = await ok(d.api.post('/api/queue/push', { note: 'wcu565 the private push' }), 'push');
    const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(!has(pushed, rec.id) && !has(pending, rec.id), 'the Push and its envelope never name it');
    assert.ok(!has(pending, UNDER));
    if (pending) await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');

    const q = `/api/elements/search?q=${encodeURIComponent('rising line')}`;
    const peer = await call('GET', q, null, PEER);
    assert.equal(peer.status, 403, 'basic: refused before anything is read');
    assert.ok(!has(peer.body, rec.id) && !has(peer.body, UNDER));
    const remote = await call('GET', q, null, REMOTE);
    assert.equal(remote.status, 200, JSON.stringify(remote.body));
    assert.deepEqual(remote.body, { hits: [], truncated: false }, 'the remote read viewer: 0 hits');
    const tool = await call('GET', q);
    assert.equal(tool.status, 200);
    assert.deepEqual(tool.body, { hits: [], truncated: false }, 'lib/client (Claude\'s tools): 0 hits');
    const mine = await ok(d.anonApi.get(q), 'the host\'s browser');
    assert.deepEqual(mine.hits.map((h) => [h.id, h.type, h.field, h.shared]), [[rec.id, TYPE, 'text_under', false]], 'the host\'s own browser: 1');

    const list = await call('GET', `/api/elements?type=${TYPE}`);
    assert.ok(!has(list.body, rec.id), 'GET /api/elements for lib/client: dropped');
    const local = await ok(d.anonApi.get(`/api/elements?type=${TYPE}`), 'GET for the browser');
    assert.deepEqual(local.elements.map((e) => [e.id, e.shared]), [[rec.id, false]]);
  });

  await t.test('(7) the engine\'s undo over the plug-in type: the writer\'s own stroke undone, a pane\'s newer one named in the hint and left (AF10)', async () => {
    const theirs = (await ok(d.anonApi.post('/api/elements', strokeBody(anchor, { under: 'wcu565 the pane\'s own stroke' }), PANE), 'the pane\'s stroke')).element;
    assert.deepEqual(theirs.writer, { class: 'pane', owner: `pane:${MOUNT}`, verified: false });
    const r = await ok(d.anonApi.post('/api/elements/undo', { item: MOUNT }), 'undo');
    assert.deepEqual(r.undone, { id: ids.priv, type: TYPE, v: 1, item: MOUNT, how: 'removed' });
    assert.deepEqual(r.newer, [{ id: theirs.id, type: TYPE, writer_class: 'pane' }]);
    assert.match(r.hint, new RegExp(`a newer annotation on this pane is ${TYPE} by pane; it was left as it is`));
    assert.deepEqual(d.srv.state.elements, [`${theirs.id}@1`], 'the stroke\'s reference dropped, the pane\'s left');
    // The pane's own undo takes its own; then nothing of the user's is live.
    const own = await ok(d.anonApi.post('/api/elements/undo', { item: MOUNT }, PANE), 'the pane\'s undo');
    assert.equal(own.undone.id, theirs.id);
    assert.deepEqual(d.srv.state.elements, []);
    const none = await d.anonApi.post('/api/elements/undo', { item: MOUNT });
    assert.equal(none.status, 409, none.text);
    assert.equal(none.json.error, 'nothing to undo');
  });

  await t.test('(8) a second stroke, re-drawn, shared (PATCH) and sent: one queue item, delivered on Push', async () => {
    const rec = (await ok(d.anonApi.post('/api/elements', strokeBody(anchor, { under: 'wcu565 the shared stroke' })), 'POST')).element;
    assert.equal(rec.shared, false);
    const patched = await ok(d.anonApi.patch(`/api/elements/${rec.id}`, { shared: true }), 'share it');
    assert.equal(patched.element.shared, true);
    assert.equal(patched.element.v, 2);
    const sent = await ok(d.anonApi.post(`/api/elements/${rec.id}/send`, {}), 'send it');
    assert.equal(sent.ok, true);
    const items = d.srv.state.queue.filter((it) => it.kind === 'element');
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(sent.item.id, items[0].id, 'the send names the one item');
    const pushed = await ok(d.api.post('/api/queue/push', {}), 'push');
    assert.equal(pushed.pushed, 1);
    assert.equal(pushed.mode, 'parked', 'no channel in a test: the delivery parks for the next message');
    const content = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending.envelope.content;
    assert.ok(content.includes(rec.id), 'the shared stroke delivered');
    assert.ok(!content.includes(ids.priv), 'the undone private stroke never named');
    assert.deepEqual(d.srv.state.queue.filter((it) => it.kind === 'element'), [], 'the queue drained');
  });
});

test('the user tier, the way U566\'s global install takes it: staged global, approved from the confirm frame with tier \'user\' → installed in the user tier, listed', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u565-user-') });
  const staged = await stageElementPack(t, d, { dir: PACK_DIR, owner: 'acme', repo: 'strokes-user', global: true });
  assert.equal(staged.res.json.ok, true, staged.res.text);
  const out = await approveFromFrame(d.srv, { name: PACK, tier: 'user' });
  assert.equal(out.doc.status, 200);
  assert.deepEqual(out.body, { name: PACK, tier: 'system' }, 'the helper\'s \'user\' is the row\'s \'system\'');
  assert.equal(out.res.status, 200, JSON.stringify(out.res.body));
  assert.equal(out.res.body.ok, true, JSON.stringify(out.res.body));
  assert.equal(fs.readFileSync(path.join(userPaths().elementTypesDir, TYPE, 'draw.js'), 'utf8'),
    fs.readFileSync(path.join(TYPE_DIR, 'draw.js'), 'utf8'), 'the user tier holds the fixture\'s draw.js');
  const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
  assert.ok(row, 'listed once approved');
  assert.equal(row.tier, 'system', 'the listing names the user tier \'system\'');
});

// GT-22's per-sample allocation clause (U561a): the fixture's create hands the
// wet layer ONE held options object on every pointermove dispatch, its
// predicted set per call — never a fresh `{ predicted }` per event.
test('the fixture\'s create hands wet.push the SAME options object on every pointermove dispatch, its predicted set per call', async () => {
  const src = fs.readFileSync(path.join(TYPE_DIR, 'draw.js'), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const calls = [];
  const handle = { frame: { target: {} }, push() {}, commit() {}, cancel() {} };
  const wet = {
    begin() { return true; },
    push(samples, opts) { calls.push({ samples, opts, predicted: opts ? opts.predicted : undefined }); return samples.length; },
    paint() { return true; },
    end() {}, cancel() {},
  };
  const ctx = { wet, stroke: { begin: () => handle } };
  const ev = (type) => ({ type, pointerId: 7 });
  mod.create({ phase: 'pointerdown', event: ev('pointerdown'), samples: [], predicted: [] }, ctx);
  const s1 = [{ clientX: 1, clientY: 2 }], p1 = [{ clientX: 3, clientY: 4 }];
  const s2 = [{ clientX: 5, clientY: 6 }], p2 = [];
  mod.create({ phase: 'pointermove', event: ev('pointermove'), samples: s1, predicted: p1 }, ctx);
  mod.create({ phase: 'pointermove', event: ev('pointermove'), samples: s2, predicted: p2 }, ctx);
  mod.create({ phase: 'pointerup', event: ev('pointerup'), samples: [], predicted: [] }, ctx);
  assert.equal(calls.length, 2, 'one wet.push per pointermove');
  assert.strictEqual(calls[0].samples, s1);
  assert.strictEqual(calls[1].samples, s2);
  assert.ok(calls[0].opts && typeof calls[0].opts === 'object');
  assert.strictEqual(calls[1].opts, calls[0].opts, 'the same options object across dispatches');
  assert.strictEqual(calls[0].predicted, p1, 'predicted set for the first call');
  assert.strictEqual(calls[1].predicted, p2, 'and for the second');
});
