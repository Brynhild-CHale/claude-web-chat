// A shared stroke group's picture (annotation engine tranche 4, 4F.2; U564;
// DECISIONS N.1 AD3, AD5; K.5 J2; L.5 F4 (a); RULED PICTURE@when AG3 (a),
// U564@change-picture (a), U564@request-path-grab-event (a),
// U522-U564@data-el-ids (a), U563-U580@catalogue-tool-edits (a)).
//
// lib/server/box-grab.js renders the picture — a second job kind on the box
// grab's one render queue — from the live export document under the
// SHARED-ONLY projection, clipped to the group's bbox inside its box marker
// (`.el-marker[data-el-ids~=…]`, written by U522's document runtime) plus the
// margin; only on the user's Send to Claude of a shared stroke or on Claude's
// request (POST /api/elements/:id/picture, inspect_capture); never on add,
// share or a wake. Its settle folds the image onto the group's queued item,
// and only when an undelivered one exists.
//
// The daemon is real (withServer); the strokes type is U565's checked-in
// fixture pack, staged and approved through the pipeline's own routes; the
// browser is the box grab's seams (findChrome, captureImpl) — no test here
// launches a Chrome, except the one opted in by WEB_CHAT_E2E_CHROME.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { withServer, waitUntil, e2eGate } = require('../test-support/helpers');
const { stageElementPack, approveFromFrame } = require('../test-support/element-type-fixture');
const { encodePng, solid } = require('../test-support/png-encode');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const { CHROME_HINT } = require('../lib/replay/find');
const { regionClip, regionScript } = require('../lib/replay/chrome');
const {
  setSeams, boxGrabFor, markerSelector, relOf, PICTURE, PICTURE_MARGIN_PX, PICTURE_PRIVATE_HINT,
} = require('../lib/server/box-grab');
const inspectCapture = require('../lib/mcp/tools/inspect_capture');
const { PANE_HEADER } = require('../lib/core/writer-token');
const client = require('../lib/client');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const MOUNT = 'ip1';
const PANE_HTML = '<div class="wrap"><svg class="art" viewBox="0 0 200 100" width="400" height="200"><g><path d="M0 0 L10 10"/></g></svg>'
  + '<p class="prose">The chart the user marked.</p></div>';
const PRIV_UNDER = 'wcu564 the private ink text';
const PRIV_NOTE = 'wcu564 the private highlight note';
const SHARED_NOTE = 'wcu564 the shared highlight note';
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const BROWSER = Object.freeze({ origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
// inspect_capture's description at 503b8f2f (catalogue 1.0.0; RULED
// U563-U580@catalogue-tool-edits (a): no description or inputSchema change).
const DESCRIPTION_SHA256 = '67073f464d26acccd57731b47c3d4f0d9d2e401d02263a0163428610b69242dc';
const INPUT_SCHEMA_SHA256 = '9a9f620cf3db9a451e52d474b6b550ab8e513a28dd12f22709965df09fdd2f57';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

async function ok(p, what) {
  const r = await p;
  const body = r.json !== undefined ? r.json : r.body;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(body)}`);
  return body;
}

// The svg's element record as the chrome's resolver makes it (U565's way).
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

// A stroke's body as target-frame.js's commit builds it, its points offset by
// `dx` so each stroke's extent is its own.
function strokeBody(anchor, { shared = true, under = 'wcu564 the shared ink', dx = 0 } = {}) {
  const raw = [];
  for (let i = 0; i < 12; i++) raw.push(0.1 + dx + i * 0.03, 0.7 - i * 0.04, 0.5, i * 8);
  const points = strokes.roundPoints(strokes.decimate(raw));
  return {
    type: TYPE,
    anchor,
    payload: {
      text_under: under, bbox: strokes.bboxOf(points),
      shared, tool: 'pen', width: 2 / 400, colour: 'accent', points, stride: strokes.STROKE_STRIDE, aspect: 2,
    },
  };
}

// A stub of captureClip: a 40×30 PNG, each call recorded.
function stubCapture() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return { png: encodePng(solid(40, 30, [20, 120, 200]), 40, 30, { alpha: false }) };
  };
  fn.calls = calls;
  return fn;
}

// A daemon with the fixture strokes type listed, the pane rendered and the
// box grab's browser seams faked.
async function boot(t, { chrome = '/fake/chrome', captureImpl = stubCapture() } = {}) {
  const d = await withServer(t);
  const staged = await stageElementPack(t, d, { dir: PACK_DIR, owner: 'acme', repo: 'strokes-u564' });
  assert.equal(staged.res.json.ok, true, staged.res.text);
  const approved = await approveFromFrame(d.srv, { name: PACK, tier: 'local' });
  assert.equal(approved.res.status, 200, JSON.stringify(approved.res.body));
  await ok(d.api.post('/api/render', { id: MOUNT, html: PANE_HTML }), 'render the pane');
  setSeams(d.srv.state, { findChrome: () => chrome, ...(captureImpl ? { captureImpl } : {}) });
  const anchor = svgRecord();
  const post = async (opts) => (await ok(d.anonApi.post('/api/elements', strokeBody(anchor, opts)), 'POST a stroke')).element;
  const push = async () => {
    await ok(d.api.post('/api/queue/push', {}), 'push');
    const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    if (pending) await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');
  };
  const send = (id) => ok(d.anonApi.post(`/api/elements/${id}/send`, {}), `send ${id}`);
  return { d, srv: d.srv, anchor, post, push, send, calls: captureImpl && captureImpl.calls };
}

const elementItems = (srv) => srv.state.queue.filter((it) => it.kind === 'element');
const pictures = (srv) => srv.state.captures.filter((c) => c && c.kind === PICTURE);
const captureOf = (srv, id) => srv.state.captures.find((c) => c.id === id);
async function settled(srv, capture) {
  await waitUntil(() => { const c = captureOf(srv, capture); return c && c.image && c.image.state !== 'pending'; }, { timeout: 10000, what: `${capture}'s image to settle` });
  await settle();
  return captureOf(srv, capture).image;
}
const grabOps = (srv) => srv.bus.read({ kinds: ['element'] }).events.filter((e) => e.op === 'grab' && e.type === TYPE);

// The document's element payload (elements-doc-src dataElement).
function dataOf(html) {
  const m = /<script type="application\/json" data-wc-elements>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the document carries an element payload');
  return JSON.parse(m[1]);
}
const drawnByModule = (html, type) => html.includes(`window.__wcMount.elements.define(${JSON.stringify(type)}, draw,`);
// Whether the document names element `id` as data does: a JSON string or an id@v.
const names = (html, id) => html.includes(`"${id}"`) || new RegExp(`\\b${id}@\\d`).test(html);

// ── the send path ───────────────────────────────────────────────────────────

test('a Send to Claude of a shared stroke queues ONE render (never on add or share), from the shared-only export: the shared strokes drawn by their module, no private stroke and no private highlight in the html', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  await ok(d.api.post('/api/markdown', { id: 'md-1', text: '## Kept prose\n\nThe paragraph under the highlights.' }), 'md-1');
  const hl = (shared, note) => ({ type: 'highlight', anchor: { v: 1, kind: 'source', md: 'md-1', slug: 'kept-prose', quote: { exact: 'Kept', prefix: '', suffix: '' } }, payload: { note, shared } });
  const privHl = (await ok(d.anonApi.post('/api/elements', hl(false, PRIV_NOTE)), 'private highlight')).element;
  const sharedHl = (await ok(d.anonApi.post('/api/elements', hl(true, SHARED_NOTE)), 'shared highlight')).element;
  assert.equal(privHl.shared, false);

  const priv = await b.post({ shared: false, under: PRIV_UNDER, dx: 0.5 });
  const a = await b.post({ dx: 0 });
  const bb = await b.post({ dx: 0.05 });
  // A private one shared by PATCH: a share, not a send.
  const c = await b.post({ shared: false, dx: 0.1 });
  await ok(d.anonApi.patch(`/api/elements/${c.id}`, { shared: true }), 'share c');
  await settle();
  assert.equal(calls.length, 0, 'no render on add or share');
  assert.equal(pictures(srv).length, 0);
  assert.ok(elementItems(srv).length >= 1, 'the shared strokes raised their item as ever');

  await b.push();
  assert.deepEqual(elementItems(srv), [], 'delivered');
  const tabCapture = srv.state.store.tab_capture;
  const sent = await b.send(a.id);
  assert.equal(sent.ok, true);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture capture' });
  const cap = pictures(srv)[0];
  const image = await settled(srv, cap.id);
  assert.equal(image.state, 'ready', JSON.stringify(image));
  await settle(10);
  assert.equal(calls.length, 1, 'ONE render');

  // The source document, as handed to the browser — before the capture.
  const { html } = calls[0];
  const data = dataOf(html);
  const ids = data.items.map((it) => it.id).sort();
  assert.deepEqual(ids, [a.id, bb.id, c.id, sharedHl.id].sort(), 'the shared strokes and the shared highlight, nothing else');
  assert.ok(data.items.every((it) => it.shared !== false), 'no private item');
  assert.ok(drawnByModule(html, TYPE), 'the strokes type is drawn by its own module (not the generic mark)');
  assert.ok((data.types || []).some((r) => r.type === TYPE), 'listed, not removed');
  assert.ok(!(data.removed || []).includes(TYPE));
  assert.ok(names(html, a.id) && names(html, sharedHl.id), 'the matcher sees a shared id');
  assert.ok(!names(html, priv.id), 'no private stroke id');
  assert.ok(!html.includes(PRIV_UNDER), 'no private stroke text');
  assert.ok(!html.includes(JSON.stringify(priv.points)), 'no private stroke points');
  assert.ok(!names(html, privHl.id) && !html.includes(PRIV_NOTE), 'no private highlight');
  assert.ok(html.includes(SHARED_NOTE), 'the shared highlight\'s text is kept (level full)');

  // The region: the group's bbox inside its box marker, plus the margin.
  const members = [a, bb, c].map((r) => srv.elements.record(r.id, r.id === c.id ? 2 : 1));
  assert.deepEqual(calls[0].region, { selector: markerSelector(c.id), rel: relOf(members), margin: PICTURE_MARGIN_PX });
  assert.equal(calls[0].region.selector, `.el-marker[data-el-ids~="${c.id}"]`);
  assert.equal(calls[0].clip, undefined, 'a region, not a clip');
  assert.ok(!html.includes('data-wc-picture'), 'a first picture greys nothing');

  // The capture: profile element-picture, url the newest member, no capture item.
  assert.equal(cap.profile, PICTURE);
  assert.equal(cap.source, `element:${TYPE}`);
  assert.equal(cap.url, `element:${c.id}`);
  assert.deepEqual(cap.distilled.elements, [`${a.id}@1`, `${bb.id}@1`, `${c.id}@2`]);
  assert.equal(cap.distilled.describe.count, 3);
  assert.ok(!srv.state.queue.some((it) => it.kind === 'capture'), 'no capture item');
  assert.deepEqual(srv.state.store.tab_capture, tabCapture, 'no tab_capture bump');

  // The 'grab' op folded the image onto the send's queued item.
  const items = elementItems(srv);
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].image.state, 'ready');
  assert.equal(items[0].image.capture, cap.id);
  assert.equal(items[0].image.sha256, image.sha256);
  assert.ok(items[0].describe, 'U562\'s describe still on the item');
  assert.equal(grabOps(srv).length, 1);
});

test('one capture per send: a second send with no member changed reuses the picture; a change picture greys the members the previous one showed and leaves the new one in colour', async (t) => {
  const b = await boot(t);
  const { srv, calls } = b;
  const a = await b.post({ dx: 0 });
  const bb = await b.post({ dx: 0.05 });
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the first picture' });
  const first = pictures(srv)[0];
  await settled(srv, first.id);
  assert.equal(calls.length, 1);

  await b.push();
  await b.send(a.id);
  await settle(10);
  assert.equal(calls.length, 1, 'no second render');
  assert.equal(pictures(srv).length, 1, 'no second capture');
  const items = elementItems(srv);
  assert.equal(items.length, 1);
  assert.equal(items[0].image.capture, first.id, 'the queued item carries the same picture');

  // A new member: the change picture.
  const dd = await b.post({ dx: 0.2 });
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 2, { timeout: 10000, what: 'the change picture' });
  const second = pictures(srv)[1];
  await settled(srv, second.id);
  assert.equal(calls.length, 2);
  const { html } = calls[1];
  const style = /<style data-wc-picture>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'one injected style');
  assert.ok(style[1].includes(`[${strokes.STROKE_ID_ATTR}="${a.id}"]`) && style[1].includes(`[${strokes.STROKE_ID_ATTR}="${bb.id}"]`), 'the older members greyed');
  assert.ok(!style[1].includes(`"${dd.id}"`), 'the new member left in colour');
  assert.match(style[1], /grayscale/);
  assert.equal(second.distilled.previous, first.id);
  assert.deepEqual(second.distilled.new, [dd.id]);
  assert.equal(second.url, `element:${dd.id}`);
  const rel = relOf([a, bb, dd].map((r) => srv.elements.record(r.id, 1)));
  assert.deepEqual(calls[1].region, { selector: markerSelector(dd.id), rel, margin: PICTURE_MARGIN_PX });
  assert.ok(rel.x >= 0.09 && rel.x <= 0.11 && rel.w > 0.4, JSON.stringify(rel));
});

test('a member edited since the picture (a new version, the same ids) draws a new picture: the reuse is by the members\' id@v set, never by ids alone', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  const a = await b.post({ dx: 0 });
  const bb = await b.post({ dx: 0.05 });
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the first picture' });
  const first = pictures(srv)[0];
  await settled(srv, first.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.distilled.elements, [`${a.id}@1`, `${bb.id}@1`]);

  await ok(d.anonApi.patch(`/api/elements/${bb.id}`, { colour: 'gold' }), 'edit bb');
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 2, { timeout: 10000, what: 'the picture of the edited group' });
  const second = pictures(srv)[1];
  await settled(srv, second.id);
  assert.equal(calls.length, 2, 'a second render: bb is at a new version');
  assert.deepEqual(second.distilled.elements, [`${a.id}@1`, `${bb.id}@2`]);
  assert.ok(!calls[1].html.includes('data-wc-picture'), 'no member is new, so none is greyed');
});

// ── the box grab's own render site ──────────────────────────────────────────

test('a box grab over a pane beside a private highlight hands captureImpl a document with no private element, and draws a shared plug-in element by its module', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  await ok(d.api.post('/api/markdown', { id: 'md-1', text: '## Kept prose' }), 'md-1');
  const privHl = (await ok(d.anonApi.post('/api/elements', {
    type: 'highlight', anchor: { v: 1, kind: 'source', md: 'md-1', slug: 'kept-prose', quote: { exact: 'Kept', prefix: '', suffix: '' } },
    payload: { note: PRIV_NOTE, shared: false },
  }), 'private highlight')).element;
  const priv = await b.post({ shared: false, under: PRIV_UNDER });
  const shared = await b.post({ dx: 0.2 });
  const grab = (await ok(d.anonApi.post('/api/elements', {
    type: 'box-grab',
    anchor: { v: 1, kind: 'page', item: MOUNT, mount: MOUNT, rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } },
    payload: { rect: { x: 4, y: 6, w: 32, h: 20, item: MOUNT, viewport: { w: 1024, h: 700 } }, meta: { mode: 'light', viewport: { w: 1024, h: 700 } } },
    device: 'desktop',
  }), 'box grab')).element;
  await settled(srv, grab.grab.capture);
  assert.equal(calls.length, 1, 'the box grab\'s one render');
  const { html } = calls[0];
  assert.ok(calls[0].clip && !calls[0].region, 'the box grab still clips by its rect');
  const data = dataOf(html);
  assert.ok(data.items.every((it) => it.shared !== false), 'no private item');
  assert.ok(!names(html, privHl.id) && !html.includes(PRIV_NOTE), 'no private highlight');
  assert.ok(!names(html, priv.id) && !html.includes(PRIV_UNDER), 'no private stroke');
  assert.ok(data.items.some((it) => it.id === shared.id), 'the shared stroke is in the document');
  assert.ok(drawnByModule(html, TYPE), 'drawn by its module (ctx.elementTypes reaches the build)');
  assert.ok(!(data.removed || []).includes(TYPE), 'never as a removed type\'s generic mark');
  assert.equal(pictures(srv).length, 0, 'a box grab makes no stroke picture');
});

// ── Claude's request ────────────────────────────────────────────────────────

test('POST /api/elements/:id/picture: lib/client renders and answers the settled image; a browser, a pane and a remote request are refused; a private group renders nothing; a request alone emits no grab op and adds no queue item', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  const a = await b.post({ dx: 0 });
  const priv = await b.post({ shared: false, under: PRIV_UNDER, dx: 0.5 });
  await b.push();
  const ops = grabOps(srv).length;
  const route = `/api/elements/${a.id}/picture`;

  // Refused before anything is drawn.
  const browser = await d.api.post(route, {});
  assert.equal(browser.status, 403, browser.text);
  const fetched = await client.request(d.port, 'POST', route, {}, { headers: BROWSER });
  assert.equal(fetched.status, 403, 'a browser request (Origin + Sec-Fetch)');
  const pane = await client.request(d.port, 'POST', route, {}, { headers: { ...BROWSER, [PANE_HEADER]: MOUNT } });
  assert.equal(pane.status, 403, 'a pane\'s fetch');
  const remote = await client.request(d.port, 'POST', route, {}, { headers: REMOTE });
  assert.equal(remote.status, 403, 'a remote viewer');
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(pictures(srv).length, 0);

  // An all-private group: the engine refuses 'private'; the route answers 404
  // (a private element answers nothing to a reader below seesPrivate, C-16-2).
  const refused = boxGrabFor({ state: srv.state }).picture(priv.id, { reason: 'request' });
  assert.deepEqual(refused, { ok: false, refused: 'private', status: 409, hint: PICTURE_PRIVATE_HINT });
  const hidden = await client.request(d.port, 'POST', `/api/elements/${priv.id}/picture`, {});
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.ok(!JSON.stringify(hidden.body).includes(PRIV_UNDER));
  await settle();
  assert.equal(calls.length, 0, 'nothing rendered');

  // Claude's tools (lib/client): rendered and settled in the answer.
  const r = await client.request(d.port, 'POST', route, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.image.state, 'ready');
  assert.match(r.body.capture, /^cap\d+$/);
  assert.deepEqual(r.body.elements, [`${a.id}@1`]);
  assert.equal(r.body.data, undefined, 'the POST answers the block; the bytes are the GET\'s');
  assert.equal(calls.length, 1);
  await settle(10);
  assert.equal(grabOps(srv).length, ops, 'no grab op: no undelivered item for the group');
  assert.deepEqual(elementItems(srv), [], 'no queue item from a request alone');

  // Asked again with nothing changed: the same picture, no render.
  const again = await client.request(d.port, 'POST', route, {});
  assert.equal(again.body.capture, r.body.capture);
  assert.equal(again.body.reused, true);
  assert.equal(calls.length, 1);

  // GET: the PNG, and ?as=json with the same bytes.
  const png = fs.readFileSync(path.join(d.root, '.web-chat', 'captures', `${r.body.capture}.png`));
  const json = await client.request(d.port, 'GET', `${route}?as=json`);
  assert.equal(json.status, 200);
  assert.equal(json.body.capture, r.body.capture);
  assert.equal(sha(Buffer.from(json.body.data, 'base64')), sha(png));
  assert.equal(json.body.image.sha256, sha(png));
  const bytes = await d.anonApi.get(route);
  assert.equal(bytes.status, 200);
  const privGet = await client.request(d.port, 'GET', `/api/elements/${priv.id}/picture?as=json`);
  assert.equal(privGet.status, 404);

  // With an undelivered item for the group, the request's settle folds onto it.
  const e = await b.post({ dx: 0.1 });
  assert.equal(elementItems(srv).length, 1, 'the add raised its item');
  const r2 = await client.request(d.port, 'POST', `/api/elements/${e.id}/picture`, {});
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.notEqual(r2.body.capture, r.body.capture, 'a new member: a new picture');
  await settle(10);
  assert.equal(calls.length, 2);
  const items = elementItems(srv);
  assert.equal(items.length, 1, 'no second row');
  assert.equal(items[0].image.capture, r2.body.capture, 'the picture folded onto the queued item');
  assert.equal(grabOps(srv).length, ops + 1);
});

test('no Chrome: the image is chrome-not-found with its hint, and the queued item still carries U562\'s describe', async (t) => {
  const b = await boot(t, { chrome: null });
  const { srv, calls } = b;
  const a = await b.post({ dx: 0 });
  await b.post({ dx: 0.05 });
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture capture' });
  const image = await settled(srv, pictures(srv)[0].id);
  assert.deepEqual(image, { state: 'chrome-not-found', hint: CHROME_HINT });
  assert.equal(calls.length, 0, 'nothing rendered');
  const items = elementItems(srv);
  assert.equal(items.length, 1);
  assert.equal(items[0].image.state, 'chrome-not-found');
  assert.equal(items[0].image.hint, CHROME_HINT);
  assert.equal(items[0].describe.count, 2, 'the description still delivered');
});

// ── inspect_capture ─────────────────────────────────────────────────────────

async function launchMcp(t, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pic-mcp-'));
  fs.mkdirSync(path.join(cwd, '.web-chat'), { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pic-home-'));
  let mcp = null;
  t.after(async () => { if (mcp) await mcp.close(); });
  t.after(() => { for (const dir of [cwd, home]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [MCP_BIN], cwd,
    env: { ...process.env, WEB_CHAT_CHANNEL: '0', ...env, HOME: home, USERPROFILE: home },
  });
  mcp = new Client({ name: 'ink-picture-test', version: '0.0.0' });
  await mcp.connect(transport);
  return mcp;
}

test('inspect_capture: the picture\'s capture returns [text, image]; capture_id element:<id> renders first; no Chrome gives the state, its hint and the describe and no image', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  const a = await b.post({ dx: 0 });
  await b.push();
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(d.port) });

  // element:<id>: drawn first, then read as its capture.
  const first = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: `element:${a.id}` } });
  assert.ok(!first.isError, JSON.stringify(first));
  assert.deepEqual(first.content.map((c) => c.type), ['text', 'image']);
  assert.equal(calls.length, 1, 'rendered first');
  const cap = pictures(srv)[0];
  const png = fs.readFileSync(path.join(d.root, '.web-chat', 'captures', `${cap.id}.png`));
  assert.equal(sha(Buffer.from(first.content[1].data, 'base64')), sha(png));
  const meta = JSON.parse(first.content[0].text);
  assert.equal(meta.id, cap.id);
  assert.equal(meta.element, a.id);
  assert.equal(meta.type, TYPE);
  assert.deepEqual(meta.elements, [`${a.id}@1`]);
  assert.equal(meta.describe.count, 1);
  assert.equal(meta.image.state, 'ready');

  // The capture id itself: the same image, no second render.
  const own = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: cap.id } });
  assert.deepEqual(own.content.map((c) => c.type), ['text', 'image']);
  assert.equal(sha(Buffer.from(own.content[1].data, 'base64')), sha(png));
  assert.equal(calls.length, 1);
  assert.deepEqual(elementItems(srv), [], 'Claude\'s request put no row on the rail');

  // No Chrome: a new member's picture degrades, with the describe.
  setSeams(srv.state, { findChrome: () => null });
  const e = await b.post({ dx: 0.1 });
  await b.push();
  const none = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: `element:${e.id}` } });
  assert.ok(!none.isError, JSON.stringify(none));
  assert.deepEqual(none.content.map((c) => c.type), ['text'], 'no image block');
  const body = JSON.parse(none.content[0].text);
  assert.equal(body.image.state, 'chrome-not-found');
  assert.equal(body.image.hint, CHROME_HINT);
  assert.equal(body.describe.count, 2);
  assert.equal(calls.length, 1);
});

test('a member made private withdraws every picture showing it: the queued item\'s image is no longer the ready picture, the picture route answers no data and no private id, inspect_capture gives no image, and GET /api/captures names neither the member nor its count', async (t) => {
  const b = await boot(t);
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  const mid = await b.post({ dx: 0.05 });
  const last = await b.post({ dx: 0.1 });
  await b.push();
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  assert.equal((await settled(srv, cap.id)).state, 'ready');
  assert.deepEqual(cap.distilled.elements, [`${a.id}@1`, `${mid.id}@1`, `${last.id}@1`]);
  assert.equal(elementItems(srv)[0].image.capture, cap.id);
  assert.equal(elementItems(srv)[0].image.state, 'ready');
  const pngFile = path.join(d.root, '.web-chat', 'captures', `${cap.id}.png`);
  assert.ok(fs.existsSync(pngFile));

  // The middle stroke is made private.
  await ok(d.anonApi.patch(`/api/elements/${mid.id}`, { shared: false }), 'un-share the middle stroke');
  await settle(10);
  const privateRef = (text) => text.includes(`"${mid.id}"`) || new RegExp(`\\b${mid.id}@\\d`).test(text) || text.includes(`element:${mid.id}"`);

  // (a) the queued item's image no longer names a ready picture.
  const items = elementItems(srv);
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.ok(!(items[0].image && items[0].image.state === 'ready' && items[0].image.capture === cap.id), JSON.stringify(items[0].image));
  assert.ok(!items[0].element_ids.includes(mid.id), 'the private member left the item');
  assert.ok(!fs.existsSync(pngFile), 'the PNG is deleted');

  // (b) the picture route, through another member, answers no data and no private id.
  const viaOther = await client.request(d.port, 'GET', `/api/elements/${last.id}/picture?as=json&capture=${cap.id}`);
  assert.notEqual(viaOther.status, 200, JSON.stringify(viaOther.body));
  assert.equal(viaOther.body.data, undefined, 'no PNG bytes');
  assert.equal(viaOther.body.image.state, 'withdrawn');
  assert.ok(!privateRef(JSON.stringify(viaOther.body)), JSON.stringify(viaOther.body));
  const bytes = await client.request(d.port, 'GET', `/api/elements/${a.id}/picture?capture=${cap.id}`);
  assert.equal(bytes.status, 404, 'no PNG through the first member either');

  // (c) inspect_capture on the picture's capture: no image block.
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(d.port) });
  const read = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: cap.id } });
  assert.ok(!(read.content || []).some((c) => c.type === 'image'), 'no image block');
  assert.ok(!privateRef(JSON.stringify(read)), JSON.stringify(read));

  // (d) the capture list names neither the private member nor the group's count.
  const listed = await client.request(d.port, 'GET', '/api/captures');
  assert.equal(listed.status, 200);
  const rec = listed.body.captures.find((c) => c.id === cap.id);
  assert.ok(rec, 'the capture is still listed');
  assert.ok(!privateRef(JSON.stringify(listed.body)), JSON.stringify(rec));
  assert.deepEqual(rec.distilled.elements, [`${a.id}@1`, `${last.id}@1`]);
  assert.equal(rec.distilled.describe, undefined, 'the describe (its count of 3 and extent) is gone');
  assert.equal(rec.image.state, 'withdrawn');
});

test('inspect_capture: the url\'s element is read by the element log\'s own id test — a plug-in type\'s id as U513 mints it and a box grab\'s — and the description and inputSchema are 503b8f2f\'s', async (t) => {
  const b = await boot(t);
  const minted = await b.post({});
  assert.match(minted.id, /^p\d+$/);
  assert.equal(inspectCapture.elementOfUrl(`element:${minted.id}`), minted.id);
  assert.equal(inspectCapture.elementOfUrl('element:g3'), 'g3');
  assert.equal(inspectCapture.elementOfUrl('element:h12'), 'h12');
  for (const bad of ['element:x5', 'element:P1', 'element:p', 'element:p1a', 'element:g3 ', 'https://example.com/', '', null]) {
    assert.equal(inspectCapture.elementOfUrl(bad), null, String(bad));
  }
  assert.ok(inspectCapture.GRAB_URL_RE.test(`element:${minted.id}`));
  assert.equal(sha(inspectCapture.description), DESCRIPTION_SHA256, 'the description is byte-equal (catalogue 1.0.0)');
  assert.equal(sha(JSON.stringify(inspectCapture.inputSchema)), INPUT_SCHEMA_SHA256, 'the inputSchema is unchanged');
});

// ── lib/replay/chrome: the region ───────────────────────────────────────────

test('captureClip\'s region: regionClip is the element box × rel, ± margin, clamped to the document; its page script computes it from the element the selector names', async () => {
  assert.deepEqual(regionClip({ left: 100, top: 50, width: 200, height: 100 }, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 24, { w: 1280, h: 2000 }),
    { x: 126, y: 76, w: 148, h: 73 });
  assert.deepEqual(regionClip({ left: 10, top: 10, width: 200, height: 100 }, { x: 0, y: 0, w: 1, h: 1 }, 24, { w: 150, h: 2000 }),
    { x: 0, y: 0, w: 150, h: 134 }, 'clamped to the document');
  assert.deepEqual(regionClip({ left: 0, top: 0, width: 200, height: 100 }, { x: 0.5, y: 0.5, w: 0, h: 0 }, 0, { w: 1000, h: 1000 }),
    { x: 100, y: 50, w: 1, h: 1 }, 'at least one pixel');

  const dom = new JSDOM('<!doctype html><body><div class="el-marker" data-el-ids="p3 p4"></div></body>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const el = window.document.querySelector('.el-marker');
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150 });
    el.scrollIntoView = () => {};
    for (const k of ['scrollWidth', 'scrollHeight']) {
      Object.defineProperty(window.document.documentElement, k, { value: k === 'scrollWidth' ? 1280 : 2000 });
    }
    const script = regionScript({ selector: markerSelector('p4'), rel: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, margin: 24 }, 3);
    assert.deepEqual(await window.eval(script), { x: 126, y: 76, w: 148, h: 73 });
    const missing = regionScript({ selector: markerSelector('p9'), rel: { x: 0, y: 0, w: 1, h: 1 }, margin: 24 }, 2);
    assert.equal(await window.eval(missing), null, 'not on the page');
  } finally { dom.window.close(); }
});

// ── a real Chrome (opt-in) ──────────────────────────────────────────────────

const e2e = e2eGate(['chrome']);
test('a real picture: the shared group drawn in headless Chrome and clipped to its marker (opt-in)', { skip: e2e.skip }, async (t) => {
  const b = await boot(t, { chrome: e2e.chrome, captureImpl: null });
  const { d } = b;
  const a = await b.post({ dx: 0 });
  await b.post({ dx: 0.05 });
  const r = await client.request(d.port, 'POST', `/api/elements/${a.id}/picture`, {}, { timeout: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.image.state, 'ready', JSON.stringify(r.body.image));
  // The svg is 400×200 CSS px; the group's extent plus the margin on each side.
  assert.ok(r.body.image.width > 2 * PICTURE_MARGIN_PX && r.body.image.width < 400 + 2 * PICTURE_MARGIN_PX, JSON.stringify(r.body.image));
  assert.ok(r.body.image.height > 2 * PICTURE_MARGIN_PX && r.body.image.height < 200 + 2 * PICTURE_MARGIN_PX, JSON.stringify(r.body.image));
});
