// A committed node's capture entries, projected per reader (annotation engine
// tranche 5, 5A.4; U620 — a corrective to U564 and U525c; K.5 J2; AD5;
// PQ-4F-1 (a): privacy by the latest version; GT-16).
//
// A shared stroke group's picture (box-grab.js, U564/U618) is committed into
// its node as box-grab.js wrote it: every member's id@v, the `describe` (its
// union bbox and count), `url` (element:<newest>), and both images (`image`,
// `image_without`: digests and sizes; the bytes are only the picture routes').
// A member made private AFTER the commit leaves the node as committed (a node
// is never rewritten), so GET /api/captures?node=<id> projects the node's
// entries per response, by U525c's rule (lib/server/preview.js
// projectPictures): an element reference rides only for an id whose LATEST
// log version is shared; `elements`, `new`, `url` and `describe` projected;
// the images, id, seq, ts and source kept. A reader with seesPrivate (the
// local browser; lib/server/audience) reads the node as committed; Claude's
// own reads (lib/client: the host, below seesPrivate), a network peer and a
// remote viewer read the projection. A box grab's entry is untouched (a box
// grab is always shared). The live list is box-grab.js's withdrawn rule's,
// proved here, not changed.
//
// The daemon is real (withServer); the strokes type is U565's fixture pack,
// staged and approved through the pipeline's own routes; the browser is the
// box grab's seams (findChrome, captureImpl) — no test here launches Chrome.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const { withServer, waitUntil } = require('../test-support/helpers');
const { stageElementPack, approveFromFrame } = require('../test-support/element-type-fixture');
const { encodePng, solid } = require('../test-support/png-encode');
const { PUBLIC_DIR, projectPaths } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const { setSeams, PICTURE } = require('../lib/server/box-grab');
const client = require('../lib/client');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const MOUNT = 'cnp1';
const PANE_HTML = '<div class="wrap"><svg class="art" viewBox="0 0 200 100" width="400" height="200"><g><path d="M0 0 L10 10"/></g></svg>'
  + '<p class="prose">The chart the user marked.</p></div>';
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = '10.0.0.5';

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }
const clone = (v) => JSON.parse(JSON.stringify(v));

async function ok(p, what) {
  const r = await p;
  const body = r.json !== undefined ? r.json : r.body;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(body)}`);
  return body;
}

// A request's socket address set from a test header, so a request reads as a
// network peer to lib/server/audience (test/element-routes-private.test.js's
// seam).
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

// The svg's element record as the chrome's resolver makes it.
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

function strokeBody(anchor, { dx = 0 } = {}) {
  const raw = [];
  for (let i = 0; i < 12; i++) raw.push(0.1 + dx + i * 0.03, 0.7 - i * 0.04, 0.5, i * 8);
  const points = strokes.roundPoints(strokes.decimate(raw));
  return {
    type: TYPE,
    anchor,
    payload: {
      text_under: 'wcu620 the shared ink', bbox: strokes.bboxOf(points),
      shared: true, tool: 'pen', width: 2 / 400, colour: 'accent', points, stride: strokes.STROKE_STRIDE, aspect: 2,
    },
  };
}

// captureClip's stub: the first PNG (the clip's size when it has one), and the
// second (U618's without-the-line shot) whenever the job asks for it.
function pairCapture() {
  const fn = async (opts) => {
    const w = opts && opts.clip && opts.clip.w > 0 ? Math.round(opts.clip.w) : 40;
    const h = opts && opts.clip && opts.clip.h > 0 ? Math.round(opts.clip.h) : 30;
    const png = encodePng(solid(w, h, [20, 120, 200]), w, h, { alpha: false });
    return opts && opts.second ? { png, png_without: encodePng(solid(44, 32, [200, 200, 200]), 44, 32, { alpha: false }) } : { png };
  };
  return fn;
}

// A daemon with the fixture strokes type listed, the pane rendered, the box
// grab's browser seams faked, and the three readers below seesPrivate.
async function boot(t) {
  const d = await withServer(t);
  t.after(stubPeers(d.server));
  const staged = await stageElementPack(t, d, { dir: PACK_DIR, owner: 'acme', repo: 'strokes-u620' });
  assert.equal(staged.res.json.ok, true, staged.res.text);
  const approved = await approveFromFrame(d.srv, { name: PACK, tier: 'local' });
  assert.equal(approved.res.status, 200, JSON.stringify(approved.res.body));
  await ok(d.api.post('/api/render', { id: MOUNT, html: PANE_HTML }), 'render the pane');
  setSeams(d.srv.state, { findChrome: () => '/fake/chrome', captureImpl: pairCapture() });
  const anchor = svgRecord();
  const post = async (opts) => (await ok(d.anonApi.post('/api/elements', strokeBody(anchor, opts)), 'POST a stroke')).element;
  const send = (id) => ok(d.anonApi.post(`/api/elements/${id}/send`, {}), `send ${id}`);
  const get = (p, headers = {}) => client.request(d.port, 'GET', p, null, { headers, timeout: 10000 });
  // Below seesPrivate: Claude's tools (lib/client, the host), a network peer,
  // a remote viewer through the portal's header.
  const below = [
    ['lib/client (the host)', (p) => get(p)],
    ['a network peer', (p) => get(p, { 'x-test-peer': PEER })],
    ['a remote viewer', (p) => get(p, REMOTE)],
  ];
  return { d, srv: d.srv, post, send, get, below };
}

const pictures = (srv) => srv.state.captures.filter((c) => c && c.kind === PICTURE);
const captureOf = (srv, id) => srv.state.captures.find((c) => c.id === id);
async function pictureOf(srv, sendFirst) {
  await sendFirst();
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  await waitUntil(() => { const c = captureOf(srv, cap.id); return c && c.image && c.image.state !== 'pending'; }, { timeout: 10000, what: 'the picture to settle' });
  await settle();
  const rec = captureOf(srv, cap.id);
  assert.equal(rec.image.state, 'ready', JSON.stringify(rec.image));
  assert.equal(rec.image_without && rec.image_without.state, 'ready', JSON.stringify(rec.image_without));
  return rec;
}
// Whether `text` names element `id`: a JSON string, an id@v or an element url.
const namesId = (text, id) => text.includes(`"${id}"`) || new RegExp(`\\b${id}@\\d`).test(text) || text.includes(`element:${id}"`);

// Three shared strokes, one picture, committed; then the member the picture's
// url names is made private.
async function committedThenUnshared(t) {
  const b = await boot(t);
  const { d, srv } = b;
  const members = [await b.post({ dx: 0 }), await b.post({ dx: 0.05 }), await b.post({ dx: 0.1 })];
  const rec = await pictureOf(srv, () => b.send(members[0].id));
  const all = members.map((m) => `${m.id}@1`);
  assert.deepEqual(rec.distilled.elements, all);
  const end = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'commit');
  assert.ok(end.node_id, JSON.stringify(end));
  const node = srv.graph.nodes.get(end.node_id);
  const committed = clone(node.captures.find((c) => c.id === rec.id));
  assert.deepEqual(committed.distilled.elements, all);
  assert.ok(committed.distilled.describe && committed.distilled.describe.bbox, 'committed with its describe');
  assert.equal(committed.image.state, 'ready');
  assert.equal(committed.image_without.state, 'ready');
  const urlId = committed.url.slice('element:'.length);
  const priv = members.find((m) => m.id === urlId);
  assert.ok(priv, `the picture's url names a member: ${committed.url}`);
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${end.node_id}.json`);
  const fileBefore = fs.readFileSync(nodeFile, 'utf8');

  await ok(d.anonApi.patch(`/api/elements/${priv.id}`, { shared: false }), 'un-share the url\'s member');
  await settle();
  const live = clone(captureOf(srv, rec.id));
  assert.equal(live.image.state, 'withdrawn', 'the live picture is withdrawn (box-grab.js)');
  const kept = members.filter((m) => m !== priv);
  return { ...b, members, priv, kept, cap: rec.id, nodeId: end.node_id, node, nodeFile, fileBefore, committed, live };
}

// ── (i) GET /api/captures?node=<id> ─────────────────────────────────────────

test('GET /api/captures?node=<id> below seesPrivate: a member made private since the commit is named nowhere — no id@v, no describe, no url — the url falls back as box-grab.js withdrawFrom writes it, and both image blocks stay as committed', async (t) => {
  const s = await committedThenUnshared(t);
  const route = `/api/captures?node=${encodeURIComponent(s.nodeId)}`;
  const bboxText = JSON.stringify(s.committed.distilled.describe.bbox);
  for (const [who, read] of s.below) {
    const r = await read(route);
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.source, 'node');
    assert.equal(r.body.node, s.nodeId);
    const text = JSON.stringify(r.body);
    assert.ok(!namesId(text, s.priv.id), `${who}: names the private member: ${text}`);
    assert.ok(!text.includes(bboxText), `${who}: the union bbox (covering the private member) rides`);
    const entry = r.body.captures.find((c) => c.id === s.cap);
    assert.ok(entry, `${who}: the picture entry is listed`);
    assert.deepEqual(entry.distilled.elements, s.kept.map((m) => `${m.id}@1`), `${who}: the shared members stay`);
    assert.equal(entry.distilled.describe, undefined, `${who}: no describe`);
    assert.equal(entry.url, `element:${s.kept[s.kept.length - 1].id}`, `${who}: the url falls back to the newest kept member`);
    assert.equal(entry.url, s.live.url, `${who}: the url as box-grab.js withdrawFrom wrote the live one`);
    assert.deepEqual(entry.distilled.elements, s.live.distilled.elements, `${who}: the members as the live withdrawal kept them`);
    for (const k of ['id', 'seq', 'ts', 'source', 'kind']) assert.deepEqual(entry[k], s.committed[k], `${who}: its ${k}`);
    assert.deepEqual(entry.image, s.committed.image, `${who}: the image block (digest, size) as committed`);
    assert.deepEqual(entry.image_without, s.committed.image_without, `${who}: the image_without block as committed`);
    assert.equal(entry.image.data, undefined, `${who}: never bytes`);
  }
  // The node is never rewritten: in memory and on disk as committed.
  assert.deepEqual(clone(s.node.captures.find((c) => c.id === s.cap)), s.committed, 'the node in memory is as committed');
  assert.equal(fs.readFileSync(s.nodeFile, 'utf8'), s.fileBefore, 'the node file is untouched');
});

test('GET /api/captures?node=<id> for a reader with seesPrivate (the local browser): the node\'s entries as committed', async (t) => {
  const s = await committedThenUnshared(t);
  const r = await s.d.anonApi.get(`/api/captures?node=${encodeURIComponent(s.nodeId)}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.captures, clone(s.node.captures), 'every entry as committed');
  assert.deepEqual(r.json.captures.find((c) => c.id === s.cap), s.committed);
  assert.equal(fs.readFileSync(s.nodeFile, 'utf8'), s.fileBefore, 'the node file is untouched');
});

test('GET /api/captures?node=<id> below seesPrivate fails closed: a member whose latest version the log cannot read is named nowhere', async (t) => {
  const s = await committedThenUnshared(t);
  const store = s.srv.graph.elements;
  const lost = s.kept[0].id;
  const latest = store.latest;
  store.latest = function (id, ...rest) { return id === lost ? null : latest.call(this, id, ...rest); };
  t.after(() => { store.latest = latest; });
  const route = `/api/captures?node=${encodeURIComponent(s.nodeId)}`;
  for (const [who, read] of s.below) {
    const r = await read(route);
    assert.equal(r.status, 200, who);
    const text = JSON.stringify(r.body);
    assert.ok(!namesId(text, lost), `${who}: names the member with no readable record: ${text}`);
    assert.ok(!namesId(text, s.priv.id), `${who}: names the private member: ${text}`);
    const entry = r.body.captures.find((c) => c.id === s.cap);
    assert.deepEqual(entry.distilled.elements, s.kept.slice(1).map((m) => `${m.id}@1`), `${who}: only the readable shared member stays`);
  }
});

// ── (ii) both PNGs ──────────────────────────────────────────────────────────

test('the withdrawn picture\'s two PNGs are refused below seesPrivate: GET /api/elements/:id/picture ?as=json, ?which=without and ?which=without&as=json, through every member, carry no bytes and no private id', async (t) => {
  const s = await committedThenUnshared(t);
  const files = [`${s.cap}.png`, `${s.cap}.without.png`].map((f) => path.join(s.d.root, '.web-chat', 'captures', f));
  assert.ok(files.every((f) => !fs.existsSync(f)), 'both files deleted at the un-share');
  for (const [who, read] of s.below) {
    for (const via of [...s.kept, s.priv]) {
      for (const q of ['?as=json', '?which=without', '?which=without&as=json', '']) {
        const r = await read(`/api/elements/${via.id}/picture${q}${q ? '&' : '?'}capture=${s.cap}`);
        assert.notEqual(r.status, 200, `${who} via ${via.id} ${q}: ${JSON.stringify(r.body)}`);
        const body = r.body && typeof r.body === 'object' ? r.body : {};
        assert.equal(body.data, undefined, `${who}: no first PNG`);
        assert.equal(body.data_without, undefined, `${who}: no second PNG`);
        if (via !== s.priv) assert.ok(!namesId(JSON.stringify(r.body), s.priv.id), `${who}: ${JSON.stringify(r.body)}`);
      }
    }
  }
  // Claude's own reader (the host): 404, the picture withdrawn.
  for (const q of ['?as=json', '?which=without', '?which=without&as=json']) {
    const r = await s.get(`/api/elements/${s.kept[0].id}/picture${q}&capture=${s.cap}`);
    assert.equal(r.status, 404, `${q}: ${JSON.stringify(r.body)}`);
  }
});

// ── unchanged entries ───────────────────────────────────────────────────────

test('a node whose group stays shared is served unchanged below seesPrivate, and a box grab\'s entry is untouched', async (t) => {
  const b = await boot(t);
  const { d, srv } = b;
  await ok(d.api.post('/api/render', { id: 'cnp-grab', html: '<p class="lead">Hello world</p>' }), 'a pane to grab');
  const grab = (await ok(d.api.post('/api/elements', {
    type: 'box-grab',
    anchor: { v: 1, kind: 'page', item: 'cnp-grab', mount: 'cnp-grab', rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } },
    payload: {
      rect: { x: 4, y: 6, w: 32, h: 20, item: 'cnp-grab', viewport: { w: 1024, h: 700 } },
      meta: { item_path: '#cnp-grab', element_path: 'p.lead', html: '<p class="lead">Hello world</p>', mode: 'light', viewport: { w: 1024, h: 700 } },
    },
    device: 'desktop',
  }), 'POST a box grab')).element;
  await waitUntil(() => { const c = captureOf(srv, grab.grab.capture); return c && c.image && c.image.state !== 'pending'; }, { timeout: 10000, what: 'the grab to settle' });
  const members = [await b.post({ dx: 0 }), await b.post({ dx: 0.05 })];
  const rec = await pictureOf(srv, () => b.send(members[0].id));
  const end = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'commit');
  assert.ok(end.node_id, JSON.stringify(end));
  const node = srv.graph.nodes.get(end.node_id);
  const committed = clone(node.captures);
  const grabEntry = committed.find((c) => c.id === grab.grab.capture);
  assert.ok(grabEntry && grabEntry.kind === 'box-grab', 'the node holds the box grab\'s entry');
  assert.ok(committed.find((c) => c.id === rec.id), 'the node holds the picture');
  for (const [who, read] of b.below) {
    const r = await read(`/api/captures?node=${encodeURIComponent(end.node_id)}`);
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.body.captures, committed, `${who}: every entry as committed`);
  }

  // A member of a group made private: the box grab's entry still untouched.
  await ok(d.anonApi.patch(`/api/elements/${members[1].id}`, { shared: false }), 'un-share');
  await settle();
  for (const [who, read] of b.below) {
    const r = await read(`/api/captures?node=${encodeURIComponent(end.node_id)}`);
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.body.captures.find((c) => c.id === grab.grab.capture), grabEntry, `${who}: the box grab's entry as committed`);
    assert.ok(!namesId(JSON.stringify(r.body), members[1].id), `${who}: ${JSON.stringify(r.body)}`);
  }
});

test('GET /api/captures?node= for an unknown node is still a 404', async (t) => {
  const b = await boot(t);
  for (const [who, read] of b.below) {
    const r = await read('/api/captures?node=n-nope');
    assert.equal(r.status, 404, who);
  }
});

// ── the live list (box-grab.js's withdrawn rule; no edit here) ──────────────

test('live GET /api/captures names no private member after the un-share, for every reader below seesPrivate', async (t) => {
  const s = await committedThenUnshared(t);
  for (const [who, read] of s.below) {
    const r = await read('/api/captures');
    assert.equal(r.status, 200, who);
    const text = JSON.stringify(r.body);
    assert.ok(!namesId(text, s.priv.id), `${who}: ${text}`);
    const entry = r.body.captures.find((c) => c.id === s.cap);
    assert.ok(entry, `${who}: the picture is still listed`);
    assert.deepEqual(entry.distilled.elements, s.kept.map((m) => `${m.id}@1`));
    assert.equal(entry.distilled.describe, undefined);
    assert.equal(entry.image.state, 'withdrawn');
    assert.equal(entry.image_without.state, 'withdrawn');
  }
});

// ── GET /api/captures/:id/raw (inspect_capture) ─────────────────────────────

test('GET /api/captures/:id/raw below seesPrivate: after a Wipe the record comes from the committed node, and its url names no private member — it falls back as box-grab.js withdrawFrom writes it; the local browser reads it as committed', async (t) => {
  const s = await committedThenUnshared(t);
  await ok(s.d.api.post('/api/graph/wipe', {}), 'wipe');
  await settle();
  assert.equal(captureOf(s.srv, s.cap), undefined, 'the live picture is gone: findCapture reaches the committed node');
  const route = `/api/captures/${encodeURIComponent(s.cap)}/raw`;
  for (const [who, read] of s.below) {
    for (const q of ['', '?query=wcu620']) {
      const r = await read(route + q);
      assert.equal(r.status, 200, `${who} ${q}: ${JSON.stringify(r.body)}`);
      const text = JSON.stringify(r.body);
      assert.ok(!namesId(text, s.priv.id), `${who} ${q}: names the private member: ${text}`);
      assert.equal(r.body.id, s.cap);
      assert.equal(r.body.url, `element:${s.kept[s.kept.length - 1].id}`, `${who} ${q}: the url falls back to the newest kept member`);
      assert.equal(r.body.url, s.live.url, `${who} ${q}: as box-grab.js withdrawFrom wrote the live one`);
    }
  }
  const r = await s.d.anonApi.get(route);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.url, s.committed.url, 'the local browser reads the url as committed');
  assert.deepEqual(clone(s.node.captures.find((c) => c.id === s.cap)), s.committed, 'the node in memory is as committed');
  assert.equal(fs.readFileSync(s.nodeFile, 'utf8'), s.fileBefore, 'the node file is untouched');
});

// ── GET /api/graph/node/:id (U620b: the node read's captures[]) ─────────────
// The node read answers the committed node whole; below seesPrivate its
// `captures` go through the captures route's own rule (routes/capture.js
// nodeCapturesFor, called from graph.js privateFor where PRIVATE_RULES.routes'
// row names captures[]), so a member made private since the commit is named
// nowhere in it — nor in the node read's top-level `elements` (U620c: by the
// element's latest version, the same reading): GT-16, F9.

test('GET /api/graph/node/:id below seesPrivate: a member made private since the commit is named nowhere in captures[] — no id@v, no describe, no url — the entry as GET /api/captures?node= projects it, and the node is untouched', async (t) => {
  const s = await committedThenUnshared(t);
  const route = `/api/graph/node/${encodeURIComponent(s.nodeId)}`;
  const bboxText = JSON.stringify(s.committed.distilled.describe.bbox);
  for (const [who, read] of s.below) {
    const r = await read(route);
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.id, s.nodeId, who);
    assert.ok(Array.isArray(r.body.captures), `${who}: the node read carries captures[]`);
    const caps = JSON.stringify(r.body.captures);
    assert.ok(!namesId(caps, s.priv.id), `${who}: captures[] names the private member: ${caps}`);
    assert.ok(!caps.includes(bboxText), `${who}: the union bbox (covering the private member) rides in captures[]`);
    // The whole node read, its top-level `elements` included: those id@v
    // references are judged by the element's LATEST version (U620c; graph.js
    // sharedRef through domain/elements latestShared, the pictures' reading —
    // p@1 was shared at the commit, p is private now).
    const text = JSON.stringify(r.body);
    assert.ok(!namesId(text, s.priv.id), `${who}: the node read names the private member: ${text}`);
    assert.ok(Array.isArray(r.body.elements), `${who}: the node read carries elements`);
    for (const m of s.kept) assert.ok(r.body.elements.includes(`${m.id}@1`), `${who}: the shared member ${m.id}@1 stays in elements: ${JSON.stringify(r.body.elements)}`);
    const entry = r.body.captures.find((c) => c.id === s.cap);
    assert.ok(entry, `${who}: the picture entry is listed`);
    assert.deepEqual(entry.distilled.elements, s.kept.map((m) => `${m.id}@1`), `${who}: the shared members stay`);
    assert.equal(entry.distilled.describe, undefined, `${who}: no describe`);
    assert.equal(entry.url, `element:${s.kept[s.kept.length - 1].id}`, `${who}: the url falls back to the newest kept member`);
    assert.deepEqual(entry.image, s.committed.image, `${who}: the image block as committed`);
    assert.deepEqual(entry.image_without, s.committed.image_without, `${who}: the image_without block as committed`);
    // The one rule: what the captures route answers the same reader.
    const viaCaptures = await read(`/api/captures?node=${encodeURIComponent(s.nodeId)}`);
    assert.equal(viaCaptures.status, 200, who);
    assert.deepEqual(r.body.captures, viaCaptures.body.captures, `${who}: captures[] as GET /api/captures?node= projects them`);
  }
  assert.deepEqual(clone(s.node.captures.find((c) => c.id === s.cap)), s.committed, 'the node in memory is as committed');
  assert.equal(fs.readFileSync(s.nodeFile, 'utf8'), s.fileBefore, 'the node file is untouched');
});

test('GET /api/graph/node/:id for a reader with seesPrivate (the local browser): captures[] as committed — the private member\'s id@v and the describe ride', async (t) => {
  const s = await committedThenUnshared(t);
  const r = await s.d.anonApi.get(`/api/graph/node/${encodeURIComponent(s.nodeId)}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.captures, clone(s.node.captures), 'every entry as committed');
  const entry = r.json.captures.find((c) => c.id === s.cap);
  assert.deepEqual(entry, s.committed);
  assert.ok(entry.distilled.elements.includes(`${s.priv.id}@1`), 'the private member\'s id@v');
  assert.deepEqual(entry.distilled.describe, s.committed.distilled.describe, 'the describe');
});

test('GET /api/graph/node/:id below seesPrivate fails closed: a member whose latest version the log cannot read is named nowhere in captures[]', async (t) => {
  const s = await committedThenUnshared(t);
  const store = s.srv.graph.elements;
  const lost = s.kept[0].id;
  const latest = store.latest;
  store.latest = function (id, ...rest) { return id === lost ? null : latest.call(this, id, ...rest); };
  t.after(() => { store.latest = latest; });
  for (const [who, read] of s.below) {
    const r = await read(`/api/graph/node/${encodeURIComponent(s.nodeId)}`);
    assert.equal(r.status, 200, who);
    const caps = JSON.stringify(r.body.captures);
    assert.ok(!namesId(caps, lost), `${who}: names the member with no readable record: ${caps}`);
    assert.ok(!namesId(caps, s.priv.id), `${who}: names the private member: ${caps}`);
    const entry = r.body.captures.find((c) => c.id === s.cap);
    assert.deepEqual(entry.distilled.elements, s.kept.slice(1).map((m) => `${m.id}@1`), `${who}: only the readable shared member stays`);
  }
});
