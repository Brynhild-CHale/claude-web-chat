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
const { PUBLIC_DIR, projectPaths } = require('../lib/core/paths');
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

  // Sent with the add's item still queued (the usual case): the Send draws.
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
  const items = elementItems(srv).filter((it) => it.type === TYPE);
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
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the first picture' });
  const first = pictures(srv)[0];
  await settled(srv, first.id);
  assert.equal(calls.length, 1);

  await b.send(a.id);
  await settle(10);
  assert.equal(calls.length, 1, 'no second render');
  assert.equal(pictures(srv).length, 1, 'no second capture');
  const items = elementItems(srv);
  assert.equal(items.length, 1);
  assert.equal(items[0].image.capture, first.id, 'the queued item carries the same picture');

  // A new member: the change picture.
  const dd = await b.post({ dx: 0.2 });
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
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the first picture' });
  const first = pictures(srv)[0];
  await settled(srv, first.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.distilled.elements, [`${a.id}@1`, `${bb.id}@1`]);

  await ok(d.anonApi.patch(`/api/elements/${bb.id}`, { colour: 'gold' }), 'edit bb');
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 2, { timeout: 10000, what: 'the picture of the edited group' });
  const second = pictures(srv)[1];
  await settled(srv, second.id);
  assert.equal(calls.length, 2, 'a second render: bb is at a new version');
  assert.deepEqual(second.distilled.elements, [`${a.id}@1`, `${bb.id}@2`]);
  assert.ok(!calls[1].html.includes('data-wc-picture'), 'no member is new, so none is greyed');
});

// The user's Send to Claude draws the picture in every state of the stroke
// (PICTURE@when (a)): routes/elements.js tells the engine of each stroke Send
// (boxGrabFor(ctx).sent), since a Send that shares a private stroke, or finds
// its item already queued, emits no 'send' event of its own.
const sendEvents = (srv) => srv.bus.read({ kinds: ['element'] }).events.filter((e) => e.op === 'send' && e.type === TYPE);

test('a Send of a stroke shared by PATCH, its item still queued, draws one picture (the send emits no send event)', async (t) => {
  const b = await boot(t);
  const { d, srv, calls } = b;
  const a = await b.post({ shared: false, dx: 0 });
  await ok(d.anonApi.patch(`/api/elements/${a.id}`, { shared: true }), 'share a');
  await settle();
  assert.equal(calls.length, 0, 'no render on share');
  assert.equal(elementItems(srv).length, 1, 'the share raised the item');
  const sent = await b.send(a.id);
  assert.equal(sent.already, true, 'the item was already queued');
  assert.equal(sendEvents(srv).length, 0, 'no send event');
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  assert.equal((await settled(srv, pictures(srv)[0].id)).state, 'ready');
  await settle(10);
  assert.equal(calls.length, 1, 'one render');
  assert.equal(pictures(srv).length, 1);
  const items = elementItems(srv);
  assert.equal(items.length, 1);
  assert.equal(items[0].image.capture, pictures(srv)[0].id, 'the picture folded onto the queued item');
});

test('a Send of a private stroke shares it and draws one picture', async (t) => {
  const b = await boot(t);
  const { srv, calls } = b;
  const a = await b.post({ shared: false, dx: 0 });
  await settle();
  assert.deepEqual(elementItems(srv), [], 'a private stroke raises nothing');
  const sent = await b.send(a.id);
  assert.equal(sent.ok, true);
  assert.equal(sent.element.shared, true, 'the Send shared it');
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  assert.equal((await settled(srv, cap.id)).state, 'ready');
  await settle(10);
  assert.equal(calls.length, 1, 'one render');
  assert.deepEqual(cap.distilled.elements, [`${a.id}@2`], 'the shared version');
  assert.ok(!calls[0].html.includes(`${a.id}@1`), 'never the private version');
  const items = elementItems(srv);
  assert.equal(items.length, 1);
  assert.equal(items[0].image.capture, cap.id);
});

test('a fresh Send (no item queued) is drawn once, not twice: the send event and the route\'s own word reuse one picture', async (t) => {
  const b = await boot(t);
  const { srv, calls } = b;
  const a = await b.post({ dx: 0 });
  await b.push();
  assert.deepEqual(elementItems(srv), [], 'delivered');
  const sent = await b.send(a.id);
  assert.equal(sent.already, undefined, 'a fresh raise');
  assert.equal(sendEvents(srv).length, 1, 'the send event');
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  assert.equal((await settled(srv, pictures(srv)[0].id)).state, 'ready');
  await settle(10);
  assert.equal(calls.length, 1, 'one render');
  assert.equal(pictures(srv).length, 1, 'one capture');
  assert.equal(grabOps(srv).length, 1, 'one grab op');
  assert.equal(elementItems(srv)[0].image.capture, pictures(srv)[0].id);
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
  // The text is the JSON, then (U619) the line naming the images (a blank line apart).
  const meta = JSON.parse(first.content[0].text.split('\n\n')[0]);
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

// Withdrawal never edits a committed node's object (a commit and a restore
// copy captures one level deep), and survives a restore.
test('a withdrawal leaves a committed node\'s picture as committed — in memory as on disk — and a Set active of that node withdraws it again: no private id, no describe, the picture routes answer withdrawn', async (t) => {
  const b = await boot(t);
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  const mid = await b.post({ dx: 0.05 });
  const last = await b.post({ dx: 0.1 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  assert.equal((await settled(srv, cap.id)).state, 'ready');
  const all = [`${a.id}@1`, `${mid.id}@1`, `${last.id}@1`];
  assert.deepEqual(cap.distilled.elements, all);

  const end = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'commit');
  assert.ok(end.node_id, JSON.stringify(end));
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${end.node_id}.json`);
  const node = srv.graph.nodes.get(end.node_id);
  const inNode = () => node.captures.find((c) => c.id === cap.id);
  assert.ok(inNode(), 'the node holds the picture');
  const committed = JSON.parse(JSON.stringify(inNode()));
  assert.deepEqual(committed.distilled.elements, all);
  assert.ok(committed.distilled.describe, 'committed with its describe');

  await ok(d.anonApi.patch(`/api/elements/${mid.id}`, { shared: false }), 'un-share the middle stroke');
  await settle(10);
  const live = captureOf(srv, cap.id);
  assert.deepEqual(live.distilled.elements, [`${a.id}@1`, `${last.id}@1`], 'the live picture is withdrawn');
  assert.equal(live.image.state, 'withdrawn');

  // (a) the committed node's object is untouched, and equals its file.
  assert.deepEqual(inNode().distilled.elements, all, 'the node still names every member');
  assert.deepEqual(JSON.parse(JSON.stringify(inNode())), committed, 'the node\'s capture is as committed');
  const onDisk = JSON.parse(fs.readFileSync(nodeFile, 'utf8')).captures.find((c) => c.id === cap.id);
  assert.deepEqual(JSON.parse(JSON.stringify(inNode())), onDisk, 'memory equals the node file');

  // (b) Set active that node (from a later one): its copy of the picture is
  // restored, and withdrawn again.
  await ok(d.api.post('/api/render', { id: 'ip-later', html: '<p>a later turn</p>' }), 'a later pane');
  const later = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'commit a later node');
  assert.ok(later.node_id && later.node_id !== end.node_id, JSON.stringify(later));
  const moved = await ok(d.api.post('/api/graph/active', { id: end.node_id }), 'set active');
  assert.equal(moved.active, end.node_id);
  assert.notEqual(moved.unchanged, true, JSON.stringify(moved));
  await settle(10);
  assert.ok(captureOf(srv, cap.id) !== live, 'the live picture is the node\'s restored copy');
  const privateRef = (text) => text.includes(`"${mid.id}"`) || new RegExp(`\\b${mid.id}@\\d`).test(text) || text.includes(`element:${mid.id}"`);
  const listed = await client.request(d.port, 'GET', '/api/captures');
  assert.equal(listed.status, 200);
  const rec = listed.body.captures.find((c) => c.id === cap.id);
  assert.ok(rec, 'the restored picture is listed');
  assert.ok(!privateRef(JSON.stringify(listed.body)), JSON.stringify(rec));
  assert.equal(rec.distilled.describe, undefined, 'no describe');
  assert.equal(rec.image.state, 'withdrawn');
  for (const via of [a.id, last.id]) {
    const r = await client.request(d.port, 'GET', `/api/elements/${via}/picture?as=json&capture=${cap.id}`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.image.state, 'withdrawn');
    assert.equal(r.body.data, undefined);
  }
  // The node itself is still as committed.
  assert.deepEqual(JSON.parse(JSON.stringify(inNode())), committed);
});

// The node's in-place preview projects a committed picture entry per reader
// (U525c; GT-22 F9 at 06f4023f, PQ-4F-1, form 10 BB2 a): a member made private
// after the commit leaves the embedded entry for every reader without
// seesPrivate — no id, no id@v, no url naming it, no describe (the union bbox
// covering it) — while the entry's id, digest and dimensions stay; the local
// browser (seesPrivate) gets the entry as committed; a reader whose element
// payload is null (a remote viewer at off) gets no element reference at all.
// The node is never rewritten, and the captures route answers as it did.
test('node preview: a committed picture entry names a member made private since only to a reader with seesPrivate; the entry\'s id and digest stay for every reader; a null payload drops every element reference', async (t) => {
  const b = await boot(t);
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  const mid = await b.post({ dx: 0.05 });
  const last = await b.post({ dx: 0.1 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  assert.equal((await settled(srv, cap.id)).state, 'ready');
  const all = [`${a.id}@1`, `${mid.id}@1`, `${last.id}@1`];
  const end = await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'commit');
  assert.ok(end.node_id, JSON.stringify(end));
  const node = srv.graph.nodes.get(end.node_id);
  const committed = JSON.parse(JSON.stringify(node.captures.find((c) => c.id === cap.id)));
  assert.deepEqual(committed.distilled.elements, all);
  assert.ok(committed.distilled.describe && committed.distilled.describe.bbox, 'committed with its describe');
  assert.equal(committed.image.state, 'ready');
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${end.node_id}.json`);
  const fileBefore = fs.readFileSync(nodeFile, 'utf8');
  const listedBefore = await client.request(d.port, 'GET', '/api/captures');

  await ok(d.anonApi.patch(`/api/elements/${mid.id}`, { shared: false }), 'un-share the middle stroke');
  await settle(10);
  const listedAfter = await client.request(d.port, 'GET', '/api/captures');

  const route = `/preview/node/${end.node_id}`;
  const embedded = (html) => {
    const m = /const NODE = (\{[\s\S]*?\});\n/.exec(html);
    assert.ok(m, 'the document embeds the node');
    const n = JSON.parse(m[1]);
    const entry = (n.captures || []).find((c) => c.id === cap.id);
    assert.ok(entry, 'the picture entry rides');
    return entry;
  };
  const bboxText = JSON.stringify(committed.distilled.describe.bbox);
  const namesMid = (text) => text.includes(`"${mid.id}"`) || new RegExp(`\\b${mid.id}@\\d`).test(text) || text.includes(`element:${mid.id}"`);
  const keepsPicture = (entry, who) => {
    assert.equal(entry.id, cap.id, `${who}: the entry's id`);
    assert.equal(entry.seq, committed.seq, `${who}: its seq`);
    assert.equal(entry.ts, committed.ts, `${who}: its taken-at`);
    assert.equal(entry.source, committed.source, `${who}: its source (the type)`);
    assert.deepEqual(entry.image, committed.image, `${who}: the image (digest, dimensions) as committed`);
  };

  // (a) the local browser (seesPrivate): the entry as committed.
  const ownRes = await d.anonApi.get(route);
  assert.equal(ownRes.status, 200, 'the local browser\'s preview');
  const own = embedded(ownRes.text);
  assert.deepEqual(own, committed, 'the local seesPrivate reader sees the entry as committed');

  // (b) lib/client (local, no seesPrivate: what Claude's tools read through):
  // the private member and its extent are gone, the shared members and the
  // picture stay. (The test helper's `api` sends fetch metadata, so it reads
  // as a local browser, as `anonApi` does.)
  const readers = [
    ['lib/client', () => client.request(d.port, 'GET', route)],
  ];
  for (const [who, get] of readers) {
    const r = await get();
    assert.equal(r.status, 200, who);
    const html = typeof r.body === 'string' ? r.body : r.text;
    const entry = embedded(html);
    keepsPicture(entry, who);
    assert.deepEqual(entry.distilled.elements, [`${a.id}@1`, `${last.id}@1`], `${who}: the shared members stay`);
    assert.equal(entry.url, `element:${last.id}`, `${who}: the url names the newest member it may`);
    assert.equal(entry.distilled.describe, undefined, `${who}: no describe (its bbox covers the private member)`);
    assert.ok(!namesMid(JSON.stringify(entry)), `${who}: the entry names no private member: ${JSON.stringify(entry)}`);
    assert.ok(!html.includes(bboxText), `${who}: the union bbox reaches no part of the document`);
  }

  // (c) a remote viewer at off: no element payload, so no element reference.
  const remote = await client.request(d.port, 'GET', route, null, { headers: REMOTE });
  assert.equal(remote.status, 200);
  const far = embedded(typeof remote.body === 'string' ? remote.body : remote.text);
  keepsPicture(far, 'remote');
  assert.deepEqual(far.distilled.elements, [], 'remote: no id@v at all');
  assert.equal(far.url, '', 'remote: no element url');
  assert.equal(far.distilled.describe, undefined, 'remote: no describe');
  for (const id of [a.id, mid.id, last.id]) {
    assert.ok(!new RegExp(`\\b${id}@\\d`).test(JSON.stringify(far)) && !JSON.stringify(far).includes(`element:${id}"`), `remote: no reference to ${id}`);
  }

  // (d) nothing rewritten: the node in memory and on disk as committed; the
  // captures route answers by its own projection, as before this unit.
  assert.deepEqual(JSON.parse(JSON.stringify(node.captures.find((c) => c.id === cap.id))), committed, 'the node is untouched');
  assert.equal(fs.readFileSync(nodeFile, 'utf8'), fileBefore, 'the node file is untouched');
  assert.equal(listedBefore.status, 200);
  assert.equal(listedAfter.status, 200);
  const after = listedAfter.body.captures.find((c) => c.id === cap.id);
  assert.deepEqual(after.distilled.elements, [`${a.id}@1`, `${last.id}@1`], 'the route\'s own withdrawal');
  assert.equal(after.image.state, 'withdrawn');
  assert.ok(!namesMid(JSON.stringify(listedAfter.body)));
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

// ── the picture with and without the line (tranche 5, U618) ──────────────────
// RULED REQ@ink-scope-v2 (b+) (3): what Claude receives for a stroke group is
// a pair of screenshots, with and without the ink — TWO PNGs of one clip from
// ONE browser session (captureClip's `second`, U617), the second after
// hideStyle(this group's members) (REQ@picture-without (a): other groups and
// other types stay; H4 b: group.container and group.blend alike), both from
// the one shared-only document (J2: no private stroke in either). The record
// keeps `image` and gains the sibling `image_without` over
// captures/<capture>.without.png (U618@without-file-name H5 a); both are
// withdrawn, swept and served together (GET …/picture?which=without,
// ?as=json's image_without and data_without). A Send renders at the viewer's
// viewport (PICTURE@viewer-viewport); a request of Claude's at VIEWPORT.

const {
  hideStyle, itemSelector, imageBlock, RENDER_QUEUE_MAX, VIEWPORT, WITHOUT_FAILED_ERROR,
} = require('../lib/server/box-grab');
const { approveElementPack } = require('../test-support/element-type-fixture');

// A stub of captureClip that takes both shots: the first 40×30 blue, the
// second (without the line) 44×32 grey — a different size only so each
// image's record provably reads its own file (a real pair shares the clip).
function pairCapture() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const png = encodePng(solid(40, 30, [20, 120, 200]), 40, 30, { alpha: false });
    return opts.second ? { png, png_without: encodePng(solid(44, 32, [200, 200, 200]), 44, 32, { alpha: false }) } : { png };
  };
  fn.calls = calls;
  return fn;
}
const capturesDir = (d) => path.join(d.root, '.web-chat', 'captures');
const hiddenIds = (style) => [...style.matchAll(/\[data-el-id="([^"]+)"\](?! \*)/g)].map((m) => m[1]).sort();

test('U618: a picture job hands captureImpl ONE call with second.style hiding exactly the group\'s members — never a private sibling or another group — from a source document with 0 private strokes; both files written, image and image_without ready with their own digests and sizes, the queue item\'s block carrying `without`', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv, calls } = b;
  await ok(d.api.post('/api/render', { id: 'ip2', html: PANE_HTML }), 'a second pane');
  const other = (await ok(d.anonApi.post('/api/elements', strokeBody({ ...b.anchor, mount: 'ip2' })), 'another group\'s stroke')).element;
  const priv = await b.post({ shared: false, under: PRIV_UNDER, dx: 0.3 });
  const a = await b.post({ dx: 0 });
  const bb = await b.post({ dx: 0.05 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  const image = await settled(srv, cap.id);
  await settle(10);
  assert.equal(calls.length, 1, 'ONE render call: one browser session for both shots');
  assert.equal(image.state, 'ready');

  // The second shot's style: this group's members, CSS-escaped, nothing else.
  const { second, html } = calls[0];
  assert.ok(second && typeof second.style === 'string', 'captureImpl receives `second`');
  assert.equal(second.style, hideStyle([a.id, bb.id]), 'hideStyle over the members, in group order');
  assert.deepEqual(hiddenIds(second.style), [a.id, bb.id].sort(), 'exactly the members');
  assert.ok(!second.style.includes(`"${priv.id}"`), 'never the private sibling');
  assert.ok(!second.style.includes(`"${other.id}"`), 'never another group');
  assert.match(second.style, /visibility: hidden !important/);
  assert.ok(!/display\s*:/.test(second.style), 'visibility, never display: every box keeps its place');
  assert.ok(!html.includes('visibility: hidden'), 'the hide style is never in the first shot\'s document');

  // J2: the one source document carries 0 private strokes.
  const data = dataOf(html);
  assert.ok(!data.items.some((it) => it.id === priv.id), 'no private stroke in the payload');
  assert.ok(data.items.every((it) => it.shared !== false));
  assert.ok(!names(html, priv.id) && !html.includes(PRIV_UNDER), 'no private stroke id or text anywhere in the source');
  assert.ok(data.items.some((it) => it.id === other.id), 'another group stays on the page');

  // Both files, each read by its own record.
  const dir = capturesDir(d);
  const first = fs.readFileSync(path.join(dir, `${cap.id}.png`));
  const without = fs.readFileSync(path.join(dir, `${cap.id}.without.png`));
  const rec = captureOf(srv, cap.id);
  assert.deepEqual(rec.image, { state: 'ready', width: 40, height: 30, bytes: first.length, sha256: sha(first) });
  assert.deepEqual(rec.image_without, { state: 'ready', width: 44, height: 32, bytes: without.length, sha256: sha(without) });
  assert.notEqual(rec.image.sha256, rec.image_without.sha256);
  assert.ok(!fs.existsSync(path.join(dir, `${cap.id}-without.png`)), 'never the row\'s cap<n>-without.png spelling');
  assert.match(`${cap.id}.without.png`, /^cap(\d+)\./, 'graph.js\'s sidecar id guard covers the second file');

  // The queue item's block: every first-image field unchanged, `without` beside.
  const items = elementItems(srv).filter((it) => it.type === TYPE && it.element_ids.includes(a.id));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].image, {
    state: 'ready', capture: cap.id, path: `captures/${cap.id}.png`, sha256: sha(first), width: 40, height: 30, bytes: first.length,
    without: { path: `captures/${cap.id}.without.png`, sha256: sha(without), width: 44, height: 32, bytes: without.length },
  });
  assert.deepEqual(items[0].image, imageBlock(cap.id, rec.image, rec.image_without));
});

test('U618: hideStyle\'s selector, applied to a composite group\'s markup in jsdom, hides the member\'s ink in group.container and in group.blend alike and nothing of another group; the marker boxes stay', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="el-layer">
      <div class="el-marker" data-el-ids="p3 p4" id="m1"><div class="el-container" id="c1">
        <svg><path data-el-id="p3" id="p3c"/><path data-el-id="p4" id="p4c"/></svg></div></div>
      <div class="el-marker" data-el-ids="p9" id="m2"><div class="el-container" id="c2"><svg><path data-el-id="p9" id="p9c"/></svg></div></div>
    </div>
    <div class="el-blend-layer">
      <div class="el-blend" id="b1"><svg><g data-el-id="p3" id="p3b"><path id="p3bp"/></g><path data-el-id="p4" id="p4b"/></svg></div>
      <div class="el-blend" id="b2"><svg><path data-el-id="p9" id="p9b"/></svg></div>
    </div></body>`);
  try {
    const { document } = dom.window;
    const style = document.createElement('style');
    style.textContent = hideStyle(['p3', 'p4']);
    document.head.appendChild(style);
    const vis = (id) => dom.window.getComputedStyle(document.getElementById(id)).visibility;
    for (const id of ['p3c', 'p4c', 'p3b', 'p3bp', 'p4b']) assert.equal(vis(id), 'hidden', `${id}: the member's ink is hidden (container and blend)`);
    for (const id of ['p9c', 'p9b']) assert.equal(vis(id), 'visible', `${id}: another group's ink stays`);
    for (const id of ['m1', 'm2', 'c1', 'c2', 'b1', 'b2']) assert.equal(vis(id), 'visible', `${id}: the boxes stay (the region never moves)`);
    const sel = style.sheet.cssRules[0].selectorText;
    assert.deepEqual([...document.querySelectorAll(sel)].map((e) => e.id).sort(), ['p3b', 'p3bp', 'p3c', 'p4b', 'p4c']);
  } finally { dom.window.close(); }
  assert.match(hideStyle(['p:2']), /\[data-el-id="p\\3a 2"\]/, 'an id is a CSS string: it can never close the rule');
  assert.equal(hideStyle([]), '', 'no member, no style');
});

test('U618: a change picture carries the grey style in the document (both shots) and the hide style only in `second`, hiding every member — greyed and new', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { srv, calls } = b;
  const a = await b.post({ dx: 0 });
  const bb = await b.post({ dx: 0.05 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the first picture' });
  await settled(srv, pictures(srv)[0].id);
  const dd = await b.post({ dx: 0.2 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 2, { timeout: 10000, what: 'the change picture' });
  await settled(srv, pictures(srv)[1].id);
  assert.equal(calls.length, 2);
  const { html, second } = calls[1];
  const grey = /<style data-wc-picture>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(grey, 'the grey style is in the one document both shots are taken of');
  assert.match(grey[1], /grayscale/);
  assert.ok(!html.includes('visibility: hidden'), 'the hide style is not in the document');
  assert.ok(!/grayscale/.test(second.style), 'the second shot adds only the hide style');
  assert.deepEqual(hiddenIds(second.style), [a.id, bb.id, dd.id].sort(), 'the whole group hidden: the greyed and the new');
});

test('U618: un-sharing a member withdraws both files (both deleted) and marks image and image_without withdrawn; GET ?which=without and ?as=json answer 404', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  const mid = await b.post({ dx: 0.05 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  await settled(srv, cap.id);
  const files = [`${cap.id}.png`, `${cap.id}.without.png`].map((f) => path.join(capturesDir(d), f));
  assert.ok(files.every((f) => fs.existsSync(f)), 'both files written');

  await ok(d.anonApi.patch(`/api/elements/${mid.id}`, { shared: false }), 'un-share');
  await settle(10);
  assert.ok(files.every((f) => !fs.existsSync(f)), 'both files deleted');
  const rec = captureOf(srv, cap.id);
  assert.equal(rec.image.state, 'withdrawn');
  assert.equal(rec.image_without.state, 'withdrawn');
  for (const q of ['?which=without', '?which=without&as=json', '?as=json', '']) {
    const r = await client.request(d.port, 'GET', `/api/elements/${a.id}/picture${q}${q ? '&' : '?'}capture=${cap.id}`);
    assert.equal(r.status, 404, `${q}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.data, undefined);
    assert.equal(r.body.data_without, undefined);
  }
});

test('U618: GET /api/elements/:id/picture?which=without serves the second PNG\'s bytes; ?which=with the first; ?as=json carries image_without and data_without; ?which=bogus → 400 naming it', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  await b.push();
  const made = await client.request(d.port, 'POST', `/api/elements/${a.id}/picture`, {});
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const cap = made.body.capture;
  assert.equal(made.body.image_without.state, 'ready', 'the POST answers both blocks');
  assert.equal(made.body.data_without, undefined, 'the POST answers no bytes');
  const first = fs.readFileSync(path.join(capturesDir(d), `${cap}.png`));
  const without = fs.readFileSync(path.join(capturesDir(d), `${cap}.without.png`));
  const route = `/api/elements/${a.id}/picture`;

  const w = await d.anonApi.get(`${route}?which=without`);
  assert.equal(w.status, 200);
  const raw = (url) => new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: d.port, path: url, headers: { host: `127.0.0.1:${d.port}` } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const wb = await raw(`${route}?which=without`);
  assert.equal(wb.status, 200);
  assert.match(wb.type, /image\/png/);
  assert.equal(sha(wb.buf), sha(without), 'the second PNG\'s bytes');
  const fb = await raw(`${route}?which=with`);
  assert.equal(sha(fb.buf), sha(first), 'which=with: the first');
  const plain = await raw(route);
  assert.equal(sha(plain.buf), sha(first), 'the default is the first');

  const json = await client.request(d.port, 'GET', `${route}?as=json`);
  assert.equal(json.status, 200);
  assert.equal(sha(Buffer.from(json.body.data, 'base64')), sha(first));
  assert.equal(sha(Buffer.from(json.body.data_without, 'base64')), sha(without));
  assert.deepEqual(json.body.image_without, {
    state: 'ready', capture: cap, path: `captures/${cap}.without.png`, sha256: sha(without), width: 44, height: 32, bytes: without.length,
  });
  assert.equal(json.body.image.without.sha256, sha(without), 'the image block names the second too');
  assert.equal(json.body.image.sha256, sha(first), 'the first block unchanged');

  const bogus = await client.request(d.port, 'GET', `${route}?which=bogus`);
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /bogus/);
  assert.ok(bogus.body.hint);
  const arr = await client.request(d.port, 'GET', `${route}?which=with&which=without`);
  assert.equal(arr.status, 400, 'a repeated which is no which');
  assert.ok(captureOf(srv, cap), 'the capture is live');
});

test('U618: the sweep over a restored pending pair reads both from disk, else fails both', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv } = b;
  const engine = boxGrabFor({ state: srv.state });
  const dir = capturesDir(d);
  const one = encodePng(solid(12, 10, [1, 2, 3]), 12, 10, { alpha: false });
  const two = encodePng(solid(12, 10, [9, 9, 9]), 12, 10, { alpha: false });
  fs.writeFileSync(path.join(dir, 'cap901.png'), one);
  fs.writeFileSync(path.join(dir, 'cap901.without.png'), two);
  fs.writeFileSync(path.join(dir, 'cap903.png'), one);
  const rec = (id) => ({ id, seq: Number(id.slice(3)), kind: PICTURE, profile: PICTURE, source: `element:${TYPE}`, url: '', distilled: { kind: PICTURE, type: TYPE, elements: [] }, image: { state: 'pending' }, image_without: { state: 'pending' } });
  srv.state.captures.push(rec('cap901'), rec('cap902'), rec('cap903'));
  assert.equal(engine.sweep(), 3);
  const [r1, r2, r3] = ['cap901', 'cap902', 'cap903'].map((id) => captureOf(srv, id));
  assert.deepEqual(r1.image, { state: 'ready', width: 12, height: 10, bytes: one.length, sha256: sha(one) }, 'the first from disk');
  assert.deepEqual(r1.image_without, { state: 'ready', width: 12, height: 10, bytes: two.length, sha256: sha(two) }, 'the second from disk');
  assert.equal(r2.image.state, 'failed', 'no file: failed');
  assert.equal(r2.image_without.state, 'failed', 'no file: both failed');
  assert.equal(r3.image.state, 'ready');
  assert.equal(r3.image_without.state, 'failed', 'each file read on its own');
  assert.equal(engine.sweep(), 0, 'nothing pending is left');
});

test('U618: a Send whose body carries the viewer\'s viewport renders at it; a POST picture request renders at VIEWPORT; a Send without one at VIEWPORT', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv, calls } = b;
  const a = await b.post({ dx: 0 });
  await ok(d.anonApi.post(`/api/elements/${a.id}/send`, { viewport: { w: 900, h: 700, mobile: true } }), 'send with a viewport');
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  await settled(srv, pictures(srv)[0].id);
  await settle(10);
  assert.equal(calls.length, 1, 'one render (the send event and the route\'s word reuse it)');
  assert.deepEqual([calls[0].width, calls[0].height, calls[0].mobile], [900, 700, true], 'the viewer\'s viewport');

  // Claude's request: VIEWPORT, whatever a Send handed over before.
  const e = await b.post({ dx: 0.1 });
  await ok(d.anonApi.post(`/api/elements/${e.id}/send`, { viewport: { w: 640, h: 480 } }), 'send hands a viewport');
  await waitUntil(() => calls.length === 2, { timeout: 10000, what: 'the send\'s render' });
  await settled(srv, pictures(srv)[1].id);
  assert.deepEqual([calls[1].width, calls[1].height], [640, 480]);
  const f = await b.post({ dx: 0.15 });
  boxGrabFor({ state: srv.state }).viewportFor(f.id, { w: 333, h: 444 });
  const r = await client.request(d.port, 'POST', `/api/elements/${f.id}/picture`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.length, 3);
  assert.deepEqual([calls[2].width, calls[2].height, calls[2].mobile], [VIEWPORT.w, VIEWPORT.h, false], 'a request renders at VIEWPORT');

  // A Send with no viewport (an older chrome): VIEWPORT; a clamped one clamps.
  const g = await b.post({ dx: 0.2 });
  await b.send(g.id);
  await waitUntil(() => calls.length === 4, { timeout: 10000, what: 'the bare send\'s render' });
  assert.deepEqual([calls[3].width, calls[3].height], [VIEWPORT.w, VIEWPORT.h]);
  assert.deepEqual(boxGrabFor({ state: srv.state }).viewportFor('p999', { w: 99999, h: 10 }), { w: VIEWPORT.max, h: VIEWPORT.min }, 'clamped by viewportOf');
  assert.equal(boxGrabFor({ state: srv.state }).viewportFor('p999', { w: 0, h: 0 }), null, 'no size, no viewport');
});

// A page-ink type beside the fixture's (U613's page records; U623's declared
// kind: it declares 'page'), drawn by the fixture's own draw.
const PAGE_TYPE = 'ip-ink';
function approvePageInk(d) {
  approveElementPack(d, {
    name: 'ip-pageink-pack', type: PAGE_TYPE,
    json: { anchors: ['element', 'page'], place: 'box', input: 'strokes', wake: true, private: true,
      payload: { keys: [...strokes.STROKE_KEYS, ...strokes.DESCRIBE_KEYS] } },
    draw: fs.readFileSync(path.join(PACK_DIR, 'elements', 'scribble', 'draw.js'), 'utf8'),
  });
  assert.ok(d.srv.elementTypes.listed(PAGE_TYPE), 'the page-ink type lists');
}
function pageAnchor(from, to) {
  const rec = strokes.pageRecord({
    from: { item: from, x: 0.5, y: 0.9, w: 800, h: 300 },
    to: { item: to, x: from === to ? 1.2 : 0.5, y: from === to ? 0.5 : 0.1, w: 800, h: 300 },
    frame: { w: 800, h: 1200 },
  });
  assert.ok(rec, 'a page record');
  return rec;
}
const PAGE_STROKE = { shared: true, tool: 'pen', colour: 'accent', width: 0.004, stride: 4, aspect: 800 / 1200,
  points: [0.5, 0.45, 0.5, 0, 0.5, 0.53, 0.5, 10, 0.5, 0.6167, 0.5, 20] };
const postPage = async (d, anchor, extra = {}) => (await ok(d.anonApi.post('/api/elements', { type: PAGE_TYPE, anchor, payload: { ...PAGE_STROKE, ...extra } }), 'a page stroke')).element;

test('U618: an arrow\'s region is its whole page marker plus both items\' export selectors; a margin stroke\'s names its one item; an element group\'s region is unchanged', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv, calls } = b;
  approvePageInk(d);
  await ok(d.api.post('/api/render', { id: 'pa', html: '<p>pane A</p>' }), 'pa');
  await ok(d.api.post('/api/render', { id: 'pb', html: '<p>pane B</p>' }), 'pb');
  await ok(d.api.post('/api/markdown', { id: 'md-1', text: 'A margin note sits beside this.' }), 'md-1');
  const arrow = await postPage(d, pageAnchor('pa', 'pb'));
  const r = await client.request(d.port, 'POST', `/api/elements/${arrow.id}/picture`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls[0].region, {
    selector: markerSelector(arrow.id), rel: { x: 0, y: 0, w: 1, h: 1 }, margin: PICTURE_MARGIN_PX,
    selectors: [itemSelector('pa'), itemSelector('pb')],
  });
  assert.deepEqual(calls[0].region.selectors, ['[data-pane-id="pa"], [data-md-id="pa"]', '[data-pane-id="pb"], [data-md-id="pb"]'],
    'the export shell\'s item form, CSS-escaped');
  assert.deepEqual(hiddenIds(calls[0].second.style), [arrow.id]);
  assert.equal(r.body.image_without.state, 'ready');

  const margin = await postPage(d, pageAnchor('md-1', 'md-1'));
  const m = await client.request(d.port, 'POST', `/api/elements/${margin.id}/picture`, {});
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.deepEqual(calls[1].region.selectors, [itemSelector('md-1')], 'a margin stroke: its one item');
  assert.deepEqual(calls[1].region.rel, { x: 0, y: 0, w: 1, h: 1 });

  const el = await b.post({ dx: 0 });
  const e = await client.request(d.port, 'POST', `/api/elements/${el.id}/picture`, {});
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.deepEqual(calls[2].region, { selector: markerSelector(el.id), rel: relOf([srv.elements.record(el.id, 1)]), margin: PICTURE_MARGIN_PX },
    'an element group: its bbox in its marker, no selectors');
});

test('U618: RENDER_QUEUE_MAX counts a pair as ONE job; chrome-not-found sets both images with CHROME_HINT and the describe still rides', async (t) => {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const inner = pairCapture();
  const blocking = async (opts) => { await gate; return inner(opts); };
  const b = await boot(t, { captureImpl: blocking });
  const { d, srv } = b;
  approvePageInk(d);
  const items = ['q1', 'q2', 'q3', 'q4', 'q5'];
  for (const id of items) await ok(d.api.post('/api/render', { id, html: `<p>${id}</p>` }), id);
  const made = [];
  for (const id of items) made.push(await postPage(d, pageAnchor(id, id)));
  const engine = boxGrabFor({ state: srv.state });
  const answers = made.map((el) => engine.picture(el.id, { reason: 'request' }));
  assert.equal(RENDER_QUEUE_MAX, 4);
  assert.deepEqual(answers.map((a) => a.ok), [true, true, true, true, false], 'four pairs admitted, the fifth refused');
  assert.equal(answers[4].refused, 'busy');
  assert.equal(answers[4].status, 429);
  const s = engine.stats();
  assert.equal(s.in_flight + s.waiting, RENDER_QUEUE_MAX, 'one job per pair, never two');
  release();
  for (const a of answers.slice(0, 4)) {
    assert.equal((await settled(srv, a.capture)).state, 'ready');
    assert.equal(captureOf(srv, a.capture).image_without.state, 'ready');
  }
  assert.equal(inner.calls.length, 4, 'one capture call per pair');
  assert.ok(inner.calls.every((c) => c.second && c.second.style), 'each with its second shot');

  // No Chrome: both images say so, with the hint.
  setSeams(srv.state, { findChrome: () => null });
  const a = await b.post({ dx: 0 });
  await b.post({ dx: 0.05 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).some((c) => c.distilled.elements.includes(`${a.id}@1`)), { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv).find((c) => c.distilled.elements.includes(`${a.id}@1`));
  assert.deepEqual(await settled(srv, cap.id), { state: 'chrome-not-found', hint: CHROME_HINT });
  assert.deepEqual(captureOf(srv, cap.id).image_without, { state: 'chrome-not-found', hint: CHROME_HINT });
  const item = elementItems(srv).find((it) => it.element_ids.includes(a.id));
  assert.equal(item.image.state, 'chrome-not-found');
  assert.equal(item.image.without, undefined);
  assert.equal(item.describe.count, 2, 'the text describe still delivered');
});

test('U618: a render that gives only the first shot leaves image ready and image_without failed; imageBlock then carries no `without`', async (t) => {
  const b = await boot(t);
  const { srv, calls } = b;
  const a = await b.post({ dx: 0 });
  await b.send(a.id);
  await waitUntil(() => pictures(srv).length === 1, { timeout: 10000, what: 'the picture' });
  const cap = pictures(srv)[0];
  assert.equal((await settled(srv, cap.id)).state, 'ready');
  assert.ok(calls[0].second, 'the second shot was asked for');
  assert.deepEqual(captureOf(srv, cap.id).image_without, { state: 'failed', error: WITHOUT_FAILED_ERROR });
  const item = elementItems(srv)[0];
  assert.equal(item.image.state, 'ready');
  assert.equal(item.image.without, undefined);
});

// ── U619: inspect_capture hands both images ─────────────────────────────────
// A stroke group's picture comes back as [text, with its ink, without it] and
// ONE line of the text says which is which; a box grab's capture keeps its one
// image; a second shot that did not land leaves the first alone, and the line
// names the second's state. The tool's description and inputSchema are
// catalogue 1.0.0's (the 503b8f2f test above holds both hashes).

const jsonOf = (text) => JSON.parse(text.split('\n\n')[0]);
const count = (text, sub) => text.split(sub).length - 1;

test('U619: inspect_capture on a stroke group\'s picture → [text, image, image]: with its ink, then without it, both PNGs byte-equal to the two files, and one line says which is which (ids only, no stroke text)', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv, calls } = b;
  const UNDER = 'wcu619 the shared ink text';
  const a = await b.post({ dx: 0, under: UNDER });
  const newest = await b.post({ dx: 0.05, under: UNDER });
  await b.push();
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(d.port) });

  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: `element:${a.id}` } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image', 'image'], 'text, then with, then without');
  assert.equal(calls.length, 1, 'one render for the pair');
  const cap = pictures(srv)[0];
  const dir = capturesDir(d);
  const withPng = fs.readFileSync(path.join(dir, `${cap.id}.png`));
  const withoutPng = fs.readFileSync(path.join(dir, `${cap.id}.without.png`));
  assert.equal(res.content[1].data, withPng.toString('base64'), 'the first image is the picture with the ink');
  assert.equal(res.content[2].data, withoutPng.toString('base64'), 'the second is the picture without it');
  assert.notEqual(res.content[1].data, res.content[2].data);
  for (const c of res.content.slice(1)) assert.equal(c.mimeType, 'image/png');

  const text = res.content[0].text;
  assert.equal(count(text, inspectCapture.PAIR_LINE), 1, 'the which-is-which line, once');
  assert.ok(text.endsWith(inspectCapture.PAIR_LINE), text.slice(-200));
  assert.match(inspectCapture.PAIR_LINE, /first image is the stroke group with its ink; the second is the same clip without this group's ink/);
  assert.ok(!text.includes(UNDER), 'no stroke text in the text');
  const meta = jsonOf(text);
  assert.equal(meta.id, cap.id);
  assert.equal(meta.element, newest.id, 'the url names the group\'s newest member');
  assert.deepEqual(meta.elements, [`${a.id}@1`, `${newest.id}@1`]);
  assert.equal(meta.image.state, 'ready');
  assert.equal(meta.image.sha256, sha(withPng));
  assert.equal(meta.image_without.state, 'ready');
  assert.equal(meta.image_without.sha256, sha(withoutPng));
  assert.equal(meta.data_without, undefined, 'the bytes ride the image block, never the text');

  // The capture id itself: the same pair, no second render.
  const own = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: cap.id } });
  assert.deepEqual(own.content.map((c) => c.type), ['text', 'image', 'image']);
  assert.equal(own.content[1].data, withPng.toString('base64'));
  assert.equal(own.content[2].data, withoutPng.toString('base64'));
  assert.equal(count(own.content[0].text, inspectCapture.PAIR_LINE), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(elementItems(srv), [], 'Claude\'s request put no row on the rail (PICTURE@when)');
});

test('U619: a box grab\'s capture → [text, image], unchanged: its one picture, the text the JSON alone with no which-is-which line', async (t) => {
  const b = await boot(t, { captureImpl: pairCapture() });
  const { d, srv, calls } = b;
  const body = {
    type: 'box-grab',
    anchor: { v: 1, kind: 'page', item: MOUNT, mount: MOUNT, rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } },
    payload: {
      rect: { x: 4, y: 6, w: 32, h: 20, item: MOUNT, viewport: { w: 1024, h: 700 } },
      meta: { item_path: `#${MOUNT}`, element_path: 'p.prose', html: '<p class="prose">The chart the user marked.</p>', mode: 'light', viewport: { w: 1024, h: 700 } },
    },
    device: 'desktop',
  };
  const g = (await ok(d.api.post('/api/elements', body), 'POST a box grab')).element;
  assert.ok(g.grab && typeof g.grab.capture === 'string', JSON.stringify(g));
  assert.equal((await settled(srv, g.grab.capture)).state, 'ready');
  assert.ok(!calls.some((c) => c.second), 'a box grab asks for no second shot');
  const png = fs.readFileSync(path.join(capturesDir(d), `${g.grab.capture}.png`));
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(d.port) });
  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: g.grab.capture } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image']);
  assert.equal(res.content[1].data, png.toString('base64'));
  assert.equal(res.content[1].mimeType, 'image/png');
  const text = res.content[0].text;
  assert.ok(!text.includes(inspectCapture.PAIR_LINE) && !/same clip without/.test(text), 'no which-is-which line');
  const meta = JSON.parse(text);
  assert.equal(meta.element, g.id);
  assert.equal(meta.image.sha256, sha(png));
  assert.equal(meta.image_without, undefined);
});

test('U619: a picture whose second shot failed → [text, image]: the picture with its ink alone, and the line names the second\'s state and error', async (t) => {
  const b = await boot(t);
  const { d, srv } = b;
  const a = await b.post({ dx: 0 });
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(d.port) });
  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: `element:${a.id}` } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image'], 'the with-image alone');
  const cap = pictures(srv)[0];
  assert.deepEqual(captureOf(srv, cap.id).image_without, { state: 'failed', error: WITHOUT_FAILED_ERROR });
  const png = fs.readFileSync(path.join(capturesDir(d), `${cap.id}.png`));
  assert.equal(res.content[1].data, png.toString('base64'), 'the one image is the picture with the ink');
  const text = res.content[0].text;
  const line = inspectCapture.withoutLine({ state: 'failed', error: WITHOUT_FAILED_ERROR });
  assert.equal(count(text, line), 1, 'the line, once');
  assert.ok(text.endsWith(line));
  assert.match(line, /without this group's ink is not attached: its state is failed \(/);
  assert.ok(line.includes(WITHOUT_FAILED_ERROR));
  assert.ok(!text.includes(inspectCapture.PAIR_LINE), 'never the pair line without the pair');
  assert.equal(jsonOf(text).image_without.state, 'failed');
  // The line's own forms: a record with no second names `none`; a hint-only state names the state.
  assert.match(inspectCapture.withoutLine(undefined), /its state is none\.$/);
  assert.match(inspectCapture.withoutLine({ state: 'gone' }), /its state is gone\.$/);
});
