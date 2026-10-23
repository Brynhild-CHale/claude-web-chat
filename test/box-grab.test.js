// The box grab, daemon side (PLAN 2C.4; U328b): lib/server/box-grab.js behind
// the element API — the box-grab@1 version (a page anchor, the meta completed
// and redacted, always shared, the capture reserved first), its one capture
// record (domain/captures createCapture, the one writer), the picture drawn
// off the request by the export path's headless Chrome (lib/replay/chrome
// captureClip; a stub here through the captureImpl seam, a fake browser
// process for teardown, a real Chrome only opted in), the grab's one element
// queue item raised once the image settles, GET /api/elements/:id/grab, and
// inspect_capture's image block through lib/mcp/index.js's generic content
// pass-through (F4 (a)). Also the element item kind every waking type shares
// (K.2-10: lib/channel/policy elementItem, the queue's element drop and
// refresh) and the queue domain's re-send (K.2-17).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { withServer, waitUntil, fakeBin, e2eGate } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { encodePng, solid } = require('../test-support/png-encode');
const { projectPaths } = require('../lib/core/paths');
const { pngSize } = require('../lib/core/png');
const { SCHEMAS } = require('../lib/core/element-log');
const { classify: remoteClassify } = require('../lib/core/remote-policy');
const { classify, elementItem } = require('../lib/channel/policy');
const queueDomain = require('../lib/server/domain/queue');
const { CHROME_HINT } = require('../lib/replay/find');
const { captureClip, launchChrome, liveBrowsers } = require('../lib/replay/chrome');
const { kindsOf } = require('../lib/server/runtime/anchors-src');
const { setSeams, boxGrabFor, RENDER_QUEUE_MAX, PRIVATE_HINT, BUSY_HINT } = require('../lib/server/box-grab');
const client = require('../lib/client');

// No test here launches the machine's own Chrome: the finder is pinned to
// nothing, and a test that wants a browser hands one in through the seam.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
const FAKE_CHROME = path.join(__dirname, '..', 'test-support', 'fake-chrome.js');
const BOX_GRAB = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'box-grab');
const SECRET = fakeSecrets({ seed: 11 }).find((f) => f.id === 'github-ghp');
const RECT = (item, extra = {}) => ({ x: 4, y: 6, w: 32, h: 20, item, viewport: { w: 1024, h: 700 }, ...extra });
const PAGE = (item) => ({ v: 1, kind: 'page', item, mount: item, rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const render = (api, id, html = '<p class="lead">Hello world</p>') => ok(api.post('/api/render', { id, html }), `render ${id}`);
const grabBody = (item, meta = {}) => ({
  type: 'box-grab', anchor: PAGE(item),
  payload: { rect: RECT(item), meta: { item_path: `#${item}`, element_path: 'p.lead', html: '<p class="lead">Hello world</p>', mode: 'light', viewport: { w: 1024, h: 700 }, ...meta } },
  device: 'desktop',
});
const postGrab = async (api, item, meta) => (await ok(api.post('/api/elements', grabBody(item, meta)), 'POST box grab')).element;

// A stub of captureClip: a PNG exactly the clip's size, recorded per call.
function stubCapture(calls = []) {
  const fn = async (opts) => {
    calls.push(opts);
    return { png: encodePng(solid(opts.clip.w, opts.clip.h, [200, 40, 90]), opts.clip.w, opts.clip.h, { alpha: false }) };
  };
  fn.calls = calls;
  return fn;
}
// A stub that waits for `release()` before answering.
function heldCapture() {
  const waiters = [];
  const fn = (opts) => new Promise((resolve) => waiters.push(() => resolve({ png: encodePng(solid(opts.clip.w, opts.clip.h, [1, 2, 3]), opts.clip.w, opts.clip.h, { alpha: false }) })));
  fn.held = () => waiters.length;
  fn.releaseAll = () => { for (const w of waiters.splice(0)) w(); };
  return fn;
}
// A stub that launches a (fake) browser and never answers: it closes the
// browser when the render is aborted, as captureClip does.
function hangingCapture(t, launched = []) {
  const fake = fakeBin(t, { name: 'chrome', script: FAKE_CHROME, env: (dir) => ({ FAKE_CHROME_LOG: path.join(dir, 'log.jsonl') }) });
  t.after(() => {
    for (const b of launched) { try { process.kill(-b.proc.pid, 'SIGKILL'); } catch {} try { b.proc.kill('SIGKILL'); } catch {} }
  });
  return async ({ tmpDir, signal }) => {
    const b = launchChrome({ chromePath: fake.bin, tmpDir, grace: { closeMs: 200, termMs: 200, killMs: 500 } });
    launched.push(b);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    await b.close();
    throw new Error('aborted');
  };
}

const elementItems = (srv) => srv.state.queue.filter((it) => it.kind === 'element');
const captureOf = (srv, id) => srv.state.captures.find((c) => c.id === id);
async function settled(srv, capture) {
  await waitUntil(() => { const c = captureOf(srv, capture); return c && c.image && c.image.state !== 'pending'; }, { timeout: 10000, what: `${capture}'s image to settle` });
  return captureOf(srv, capture).image;
}

// ── the version, the capture, redaction ─────────────────────────────────────

test('a POSTed box grab: one box-grab@1 version {page anchor, shared, rect, meta (completed on the daemon), grab {capture}} and one capture record built from it; every secret masked in the log, the record, the sidecar and both capture routes', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: stubCapture() });
  await render(api, 'm1');
  srv.bus.emit({ event: { kind: 'script-error', id: 'm1', script_index: 0, message: `boom ${SECRET.text}`, stack: 'Error: boom\n    at a (x.js:1)\n    at b (x.js:2)\n    at c (x.js:3)\n    at d (x.js:4)', source: 'browser' } });
  srv.bus.emit({ event: { kind: 'script-error', id: 'other', message: 'not this pane', source: 'browser' } });
  const capsBefore = srv.state.captureSeq;

  const g = await postGrab(api, 'm1', { html: `<p class="lead">${SECRET.text}</p>`, chrome_only_key: 'dropped' });
  assert.match(g.id, /^g\d+$/);
  assert.equal(g.schema, BOX_GRAB);
  assert.equal(g.shared, true);
  assert.deepEqual(g.anchor, PAGE('m1'));
  assert.deepEqual(g.rect, RECT('m1'));
  assert.deepEqual(Object.keys(g.meta), ['item_path', 'element_path', 'html', 'theme', 'mode', 'viewport', 'script_errors']);
  assert.equal(g.meta.item_path, '#m1');
  assert.equal(g.meta.mode, 'light');
  assert.equal(typeof g.meta.theme, 'string');
  assert.ok(g.meta.theme.length > 0);
  assert.equal(g.meta.script_errors.length, 1, 'only this pane\'s script errors');
  assert.equal(g.meta.script_errors[0].stack.split('\n').length, 3, 'the stack head');
  assert.deepEqual(g.grab, { capture: `cap${capsBefore + 1}` }, 'the capture id reserved before the one version');
  assert.equal(srv.elements.versionsOf(g.id).length, 1);

  const cap = captureOf(srv, g.grab.capture);
  assert.equal(cap.kind, 'box-grab');
  assert.equal(cap.source, 'element:box-grab');
  assert.equal(cap.url, `element:${g.id}`);
  assert.equal(cap.raw_ref, path.join('captures', `${g.grab.capture}.html`));
  assert.equal(cap.distilled.element, g.id);
  assert.deepEqual(cap.distilled.rect, g.rect);
  assert.ok(!('html' in cap.distilled.meta), 'the html is the raw tier, not the distillate');
  assert.ok(cap.image && typeof cap.image.state === 'string');
  assert.equal(srv.state.store.tab_capture, undefined, 'a box grab bumps no tab_capture');
  await settled(srv, g.grab.capture);

  // Redaction: the writer's, then built from the stored version.
  const leaks = (what, hay) => assert.deepEqual(findLeaks(hay, [SECRET]), [], `${what} holds the fake secret`);
  leaks('the log bytes', fs.readFileSync(projectPaths(root).elementsLog, 'utf8'));
  leaks('the element', JSON.stringify(g));
  leaks('the capture record', JSON.stringify(cap));
  leaks('the raw sidecar', fs.readFileSync(path.join(path.join(root, '.web-chat'), cap.raw_ref), 'utf8'));
  leaks('GET /api/captures', (await api.get('/api/captures')).text);
  const raw = await api.get(`/api/captures/${cap.id}/raw`);
  assert.equal(raw.status, 200);
  leaks('GET /api/captures/:id/raw', raw.text);
  assert.ok(raw.json.raw.includes('class="lead"'), 'the raw is the clipped outerHTML');
  leaks('the queue', JSON.stringify(srv.state.queue));
});

test('a box grab is always shared: a private POST and PATCH {shared: false} answer 400 with the hint; any other edit is refused; {shared: true} changes nothing', async (t) => {
  const { api, srv } = await withServer(t);
  setSeams(srv.state, { findChrome: () => null });
  await render(api, 'm1');
  const priv = await api.post('/api/elements', { ...grabBody('m1'), payload: { ...grabBody('m1').payload, shared: false } });
  assert.equal(priv.status, 400);
  assert.equal(priv.json.hint, PRIVATE_HINT);
  const g = await postGrab(api, 'm1');
  const r = await api.patch(`/api/elements/${g.id}`, { shared: false });
  assert.equal(r.status, 400);
  assert.equal(r.json.hint, PRIVATE_HINT);
  for (const body of [{ rect: RECT('m1', { w: 99 }) }, { payload: { grab: { capture: 'cap999' } } }, { anchor: PAGE('m1') }]) {
    const e = await api.patch(`/api/elements/${g.id}`, body);
    assert.equal(e.status, 400, JSON.stringify(body));
  }
  const same = await ok(api.patch(`/api/elements/${g.id}`, { shared: true }));
  assert.equal(same.unchanged, true);
  assert.equal(srv.elements.versionsOf(g.id).length, 1, 'nothing appended');
  const other = await api.post('/api/elements', { ...grabBody('m1'), anchor: { v: 1, kind: 'element', mount: 'm1' } });
  assert.equal(other.status, 400, 'a box grab takes only a page anchor');
});

test('a page anchor never re-resolves: no resolver kind for it, the version stays as created across a re-render, and no anchors-runtime call is handed a page record', async (t) => {
  const anchors = require('../lib/core/anchors');
  const handed = [];
  const restore = [];
  for (const [k, fn] of Object.entries(anchors)) {
    if (typeof fn !== 'function') continue;
    anchors[k] = function spy(...args) {
      if (args.some((a) => a && typeof a === 'object' && a.kind === 'page')) handed.push(k);
      return fn.apply(this, args);
    };
    restore.push(() => { anchors[k] = fn; });
  }
  t.after(() => { for (const r of restore) r(); });
  const d = await withServer(t);
  const { api, srv } = d;
  // The render builds the live surface's export, which carries the grab's reference.
  const calls = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: stubCapture(calls) });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  await settled(srv, g.grab.capture);
  assert.equal(calls.length, 1);
  assert.deepEqual(kindsOf({ elements: [`${g.id}@1`] }, { kindOf: () => g.anchor.kind }), [], 'a page anchor adds no resolver kind');
  await render(api, 'm1', '<p class="lead">Changed</p><p>more</p>');
  const sock = d.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  const after = (await ok(api.get('/api/elements?type=box-grab'))).elements.find((e) => e.id === g.id);
  assert.deepEqual(after.anchor, g.anchor);
  assert.equal(after.v, 1);
  assert.equal(srv.elements.versionsOf(g.id).length, 1);
  assert.deepEqual(handed, [], 'no page record routed to the anchors runtime');
});

// ── the render and the one item ─────────────────────────────────────────────

test('with a stub captureClip: the PNG lands as captures/cap<n>.png, the image becomes ready with its sha256, and only then one element item {kind, type, element_id, v, image} is raised — no capture item; /grab serves those exact bytes', async (t) => {
  const { api, srv, root, baseUrl } = await withServer(t);
  const held = heldCapture();
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: held });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1', { mode: 'dark' });
  await waitUntil(() => held.held() === 1, { timeout: 5000, what: 'the render to start' });
  assert.equal(captureOf(srv, g.grab.capture).image.state, 'pending');
  assert.deepEqual(elementItems(srv), [], 'no item before the picture');
  const pending = await fetch(`${baseUrl}/api/elements/${g.id}/grab`);
  assert.equal(pending.status, 404);
  assert.equal((await pending.json()).image.state, 'pending');
  held.releaseAll();
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready');
  const file = path.join(path.join(root, '.web-chat'), 'captures', `${g.grab.capture}.png`);
  const png = fs.readFileSync(file);
  assert.equal(image.sha256, sha(png));
  assert.deepEqual(pngSize(png), { width: 32, height: 20 });
  await waitUntil(() => elementItems(srv).length === 1, { timeout: 5000, what: 'the element item' });
  const [item] = elementItems(srv);
  assert.equal(item.type, 'box-grab');
  assert.equal(item.element_id, g.id);
  assert.equal(item.v, 1);
  assert.deepEqual(item.image, { state: 'ready', capture: g.grab.capture, path: `captures/${g.grab.capture}.png`, sha256: sha(png), width: 32, height: 20, bytes: png.length });
  assert.match(item.summary, new RegExp(`${g.id}@1`));
  assert.ok(!item.summary.includes('Hello'), 'no payload text');
  assert.equal(srv.state.queue.filter((it) => it.kind === 'capture').length, 0, 'the grab\'s capture raises no capture item');

  const r = await fetch(`${baseUrl}/api/elements/${g.id}/grab`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(png), 'the bytes the user sees');
  const j = await ok(api.get(`/api/elements/${g.id}/grab?as=json`));
  assert.equal(sha(Buffer.from(j.data, 'base64')), sha(png));
  assert.equal(j.image.state, 'ready');
});

test('a grab deleted while its picture is drawing raises no item when the picture settles', async (t) => {
  const { api, srv } = await withServer(t);
  const held = heldCapture();
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: held });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  await waitUntil(() => held.held() === 1, { timeout: 5000, what: 'the render to start' });
  await ok(api.del(`/api/elements/${g.id}`));
  held.releaseAll();
  assert.equal((await settled(srv, g.grab.capture)).state, 'ready', 'the capture keeps its picture');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(elementItems(srv), [], 'no item for a grab that is gone');
});

test('the render: the live surface as the export draws it, at the viewer\'s viewport and mode, the item and the item-relative clip', async (t) => {
  const { api, srv } = await withServer(t);
  const calls = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: stubCapture(calls) });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1', { mode: 'dark' });
  await settled(srv, g.grab.capture);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.chromePath, '/fake/chrome');
  assert.deepEqual([c.width, c.height, c.mobile, c.colorScheme, c.item], [1024, 700, false, 'dark', 'm1']);
  assert.deepEqual(c.clip, { x: 4, y: 6, w: 32, h: 20 });
  assert.match(c.html, /^<!doctype html>/);
  assert.ok(c.html.includes('data-pane-id'), 'the export shell names each pane');
  assert.ok(c.signal && typeof c.signal.aborted === 'boolean');
});

test('with no Chrome: the image is chrome-not-found with its hint, and the item still enqueues', async (t) => {
  const { api, srv } = await withServer(t);
  setSeams(srv.state, { findChrome: () => null });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  const image = await settled(srv, g.grab.capture);
  assert.deepEqual(image, { state: 'chrome-not-found', hint: CHROME_HINT });
  await waitUntil(() => elementItems(srv).length === 1, { timeout: 5000, what: 'the element item' });
  assert.deepEqual(elementItems(srv)[0].image, { state: 'chrome-not-found', capture: g.grab.capture, hint: CHROME_HINT });
  const r = await api.get(`/api/elements/${g.id}/grab`);
  assert.equal(r.status, 404);
  assert.equal(r.json.image.state, 'chrome-not-found');
});

test('a render that hangs fails after the timeout, and its browser is torn down', async (t) => {
  const { api, srv } = await withServer(t);
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: hangingCapture(t), timeoutMs: 400 });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'failed');
  assert.match(image.error, /did not render within/);
  assert.ok(await waitUntil(() => liveBrowsers() === 0, { timeout: 10000, what: 'the browser closed' }));
  await waitUntil(() => elementItems(srv).length === 1, { timeout: 5000, what: 'the element item' });
  assert.equal(elementItems(srv)[0].image.state, 'failed');
});

test('one render at a time: a burst of five grabs — four admitted, the fifth 429 with the hint; each then settles in turn', async (t) => {
  const { api, srv } = await withServer(t);
  const held = heldCapture();
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: held });
  await render(api, 'm1');
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push(await api.post('/api/elements', grabBody('m1')));
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200, 200, 429]);
  assert.equal(RENDER_QUEUE_MAX, 4);
  assert.equal(answers[4].json.hint, BUSY_HINT);
  await waitUntil(() => held.held() === 1, { timeout: 5000, what: 'the first render' });
  assert.deepEqual(boxGrabFor({ state: srv.state }).stats(), { in_flight: 1, waiting: 3, reserved: 0, stopped: false });
  for (let i = 0; i < 4; i++) {
    await waitUntil(() => held.held() === 1, { timeout: 5000, what: `render ${i + 1}` });
    held.releaseAll();
    await waitUntil(() => elementItems(srv).length === i + 1, { timeout: 5000, what: `item ${i + 1}` });
  }
  assert.equal(new Set(elementItems(srv).map((it) => it.element_id)).size, 4);
});

test('a daemon stop with a render in flight tears its browser down (liveBrowsers() 0)', async (t) => {
  const d = await withServer(t);
  const { api, srv } = d;
  const launched = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: hangingCapture(t, launched) });
  await render(api, 'm1');
  await postGrab(api, 'm1');
  await waitUntil(() => launched.length === 1 && liveBrowsers() === 1, { timeout: 10000, what: 'the browser up' });
  await d.stop();
  assert.ok(await waitUntil(() => liveBrowsers() === 0, { timeout: 10000, what: 'the browser closed' }), 'the stop closed it');
});

// ── the picture's route ─────────────────────────────────────────────────────

test('/grab: a private element answers 404 to lib/client; the route sits under the floor row, reachable at read', async (t) => {
  const { srv, port, root } = await withServer(t);
  // Both grabs hold a picture on disk, so only the private gate can answer 404.
  const png = encodePng(solid(2, 2, [9, 9, 9]), 2, 2, { alpha: false });
  fs.writeFileSync(path.join(root, '.web-chat', 'captures', 'cap900.png'), png);
  const grabOf = (shared) => srv.elements.addElement({
    type: 'box-grab', schema: BOX_GRAB,
    payload: { anchor: null, shared, rect: RECT('m1'), meta: {}, grab: { capture: 'cap900' } },
  });
  const rec = grabOf(false);
  const twin = grabOf(true);
  const r = await client.request(port, 'GET', `/api/elements/${rec.id}/grab`, undefined, { timeout: 10000 });
  assert.equal(r.status, 404);
  assert.equal(r.body && r.body.image, undefined, 'the private gate answers, not the missing picture');
  const shown = await client.request(port, 'GET', `/api/elements/${twin.id}/grab?as=json`, undefined, { timeout: 10000 });
  assert.equal(shown.status, 200, 'the shared twin, same picture, is served');
  const v = remoteClassify('GET', `/api/elements/${rec.id}/grab`, { mirror: 'read' });
  assert.equal(v.allow, true);
  assert.equal(v.key, 'GET /api/elements/*');
  assert.equal(remoteClassify('GET', `/api/elements/${rec.id}/grab`, { mirror: 'off' }).allow, false);
  assert.equal((await client.request(port, 'GET', '/api/elements/h1/grab', undefined, { timeout: 10000 })).status, 404, 'not a box grab');
});

// ── the extension's captures, unchanged ─────────────────────────────────────

test('POST /api/capture after createCapture: the record, the tab_capture signal, the capture event and its capture item, as before', async (t) => {
  const { api, srv } = await withServer(t);
  const r = await ok(api.post('/api/capture', { url: 'https://example.com/a', title: 'A', html: '<html><body><p>x</p></body></html>', render: false }));
  const rec = captureOf(srv, r.capture_id);
  assert.deepEqual(Object.keys(rec), ['id', 'seq', 'ts', 'url', 'title', 'profile', 'distilled', 'raw_ref', 'bytes_raw', 'source']);
  assert.deepEqual(srv.state.store.tab_capture, { seq: rec.seq, capture_id: rec.id, url: 'https://example.com/a', title: 'A', profile: rec.profile });
  await waitUntil(() => srv.state.queue.some((it) => it.kind === 'capture' && it.capture_id === rec.id), { timeout: 5000, what: 'the capture item' });
  const ev = (await api.get('/api/events?since=0')).json.events.find((e) => e.kind === 'capture');
  assert.deepEqual(Object.keys(ev).filter((k) => k !== 'seq' && k !== 'ts'), ['kind', 'capture_id', 'url', 'profile', 'source']);
});

// ── the element item kind (K.2-10) ──────────────────────────────────────────

test('the policy: a waking type\'s shared add raises one element item, an edit refreshes it, a delete or un-share drops it; no wake, a private add, a comment or a pending picture raise none', () => {
  const ev = (op, extra = {}) => ({ kind: 'element', type: 'sticker', op, id: 's1', v: 1, shared: true, mount: 'm1', ...extra });
  const wakes = { sticker: { wake: true, label: 'Sticker', text: '' } };
  const add = classify(ev('add'), { elementTypes: wakes });
  assert.deepEqual(add, { action: 'enqueue', item: {
    kind: 'element', source: 'browser', type: 'sticker', element_id: 's1', v: 1,
    why_wake: 'Sticker sent to Claude', summary: 'Sticker · s1@1', origin_mount: 'm1',
  } });
  assert.deepEqual(classify(ev('edit', { v: 2 }), { elementTypes: wakes }).action, 'refresh');
  assert.deepEqual(classify(ev('delete'), { elementTypes: wakes }), { action: 'dequeue', element_id: 's1' });
  assert.deepEqual(classify(ev('edit', { shared: false }), { elementTypes: wakes }), { action: 'dequeue', element_id: 's1' });
  assert.equal(classify(ev('add', { shared: false }), { elementTypes: wakes }), null, 'a private add');
  assert.equal(classify(ev('add'), { elementTypes: { sticker: { wake: false } } }), null, 'no wake');
  assert.equal(classify(ev('add'), {}), null, 'an unlisted type');
  assert.equal(classify(ev('add', { pending: 'image' }), { elementTypes: wakes }), null, 'a picture still drawing');
  assert.equal(classify(ev('add', { type: 'comment' }), { elementTypes: { comment: { wake: true } } }), null, 'comments stay on their own items (K.2-22)');
  assert.equal(classify(ev('grab', { image: { state: 'ready' } }), { elementTypes: wakes }).item.image.state, 'ready');
  const withText = elementItem(ev('add'), { label: 'Sticker', text: 'look <here>\nnow' });
  assert.equal(withText.summary, 'Sticker · s1@1 · "look here now"', 'the summary_key text, sanitized');
  assert.equal(elementItem(ev('add'), { label: 'S', text: 'x'.repeat(500) }).summary.length, 200, 'truncated to the queue\'s cap');
});

test('the subscriber: a fixture type whose descriptor declares wake raises, refreshes and drops its one item; a type without wake raises none', async (t) => {
  const { srv } = await withServer(t);
  const reg = srv.elementTypes;
  const orig = reg.descriptor;
  reg.descriptor = (type) => (type === 'sticker' ? { type, toolbar: { wake: true, label: 'Sticker' } }
    : type === 'quiet' ? { type, toolbar: {} } : orig(type));
  t.after(() => { reg.descriptor = orig; });
  const emit = (event) => srv.bus.emit({ event: { kind: 'element', mount: null, shared: true, v: 1, ...event } });
  emit({ type: 'sticker', op: 'add', id: 's1' });
  emit({ type: 'quiet', op: 'add', id: 'q1' });
  emit({ type: 'sticker', op: 'add', id: 's2', shared: false });
  assert.deepEqual(elementItems(srv).map((it) => [it.element_id, it.v]), [['s1', 1]]);
  emit({ type: 'sticker', op: 'edit', id: 's1', v: 2 });
  assert.deepEqual(elementItems(srv).map((it) => [it.element_id, it.v, it.summary]), [['s1', 2, 'Sticker · s1@2']]);
  emit({ type: 'sticker', op: 'add', id: 's1', v: 2 });
  assert.equal(elementItems(srv).length, 1, 'never two items for one element');
  emit({ type: 'sticker', op: 'edit', id: 's1', v: 3, shared: false });
  assert.deepEqual(elementItems(srv), [], 'an un-share drops it');
  emit({ type: 'sticker', op: 'add', id: 's3' });
  emit({ type: 'sticker', op: 'delete', id: 's3' });
  assert.deepEqual(elementItems(srv), [], 'a delete drops it');
});

test('a highlight (U323\'s wake: true) raises one item through the API, its note as the summary text; a private one raises none; a comment raises only its comment item', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  const RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } };
  const h = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { color: 'gold', note: 'see this' } }))).element;
  await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: 'mine', shared: false } }));
  await waitUntil(() => elementItems(srv).length === 1, { timeout: 5000, what: 'the highlight item' });
  const [item] = elementItems(srv);
  assert.deepEqual([item.type, item.element_id, item.v], ['highlight', h.id, 1]);
  assert.match(item.summary, /"see this"/);
  await ok(api.patch(`/api/elements/${h.id}`, { note: 'see that' }));
  assert.match(elementItems(srv)[0].summary, /"see that"/);
  assert.equal(elementItems(srv)[0].v, 2);
  await ok(api.post('/api/elements', { type: 'comment', anchor: { mount: 'm1', selector: 'p', text: 'Hello', ordinal: 0 }, payload: { text: 'a pin', shared: true } }));
  assert.equal(elementItems(srv).length, 1, 'no element item for a comment (K.2-22)');
  assert.equal(srv.state.queue.filter((it) => it.kind === 'comment').length, 1);
  await ok(api.del(`/api/elements/${h.id}`));
  assert.deepEqual(elementItems(srv), []);
});

test('re-send (K.2-17, the queue domain): a delivered element item is raised again as a new pending item with the same element, version, type and image; a queued or unknown one is refused', async (t) => {
  const { api, srv } = await withServer(t);
  setSeams(srv.state, { findChrome: () => null });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  await waitUntil(() => elementItems(srv).length === 1, { timeout: 5000, what: 'the item' });
  const first = elementItems(srv)[0];
  assert.equal(queueDomain.resendElement(srv.state, srv.bus, first.id).status, 409, 'still queued');
  await ok(api.post('/api/queue/push', {}));
  assert.deepEqual(elementItems(srv), []);
  const again = queueDomain.resendElement(srv.state, srv.bus, first.id, { exists: (id) => id === g.id });
  assert.equal(again.ok, true);
  assert.notEqual(again.item.id, first.id);
  assert.deepEqual([again.item.element_id, again.item.v, again.item.type, again.item.image], [g.id, 1, 'box-grab', first.image]);
  assert.equal(again.item.resent_from, first.id);
  assert.equal(queueDomain.resendElement(srv.state, srv.bus, 'q99999').status, 404);
  assert.equal(queueDomain.resendElement(srv.state, srv.bus, again.item.id).status, 409);
});

// ── lib/replay/chrome captureClip, against the fake browser process ─────────

test('captureClip: the viewport, the emulated scheme and the document it was handed, loaded from the browser\'s own profile; torn down on failure and on its timeout', async (t) => {
  let logFile;
  const fake = fakeBin(t, { name: 'chrome', script: FAKE_CHROME, env: (dir) => ({ FAKE_CHROME_LOG: (logFile = path.join(dir, 'log.jsonl')) }) });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grab-tmp-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const grace = { closeMs: 500, termMs: 300, killMs: 500 };
  // The fake answers no page script, so the item is "not on the page": a page-error, after the load.
  await assert.rejects(captureClip({
    chromePath: fake.bin, html: '<!doctype html><p data-pane-id="m1">x</p>', width: 640, height: 480, colorScheme: 'dark',
    item: 'm1', clip: { x: 1, y: 2, w: 3, h: 4 }, tmpDir, timeoutMs: 10000, grace,
  }), (e) => e.code === 'page-error');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sent = (m) => log.find((l) => l.method === m);
  assert.deepEqual(sent('Emulation.setDeviceMetricsOverride').params, { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(sent('Emulation.setEmulatedMedia').params, { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.match(sent('Page.navigate').params.url, /^file:.*\/grab\.html$/);
  assert.equal(liveBrowsers(), 0);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'the profile, and the document in it, removed');
  await assert.rejects(captureClip({
    chromePath: fake.bin, html: '<p>x</p>', width: 200, height: 200, clip: { x: 0, y: 0, w: 1, h: 1 }, tmpDir, timeoutMs: 1, grace,
  }), (e) => e.code === 'timeout');
  assert.equal(liveBrowsers(), 0);
});

// ── Claude's one call (F4 (a)) ──────────────────────────────────────────────

async function launchMcp(t, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grab-mcp-'));
  fs.mkdirSync(path.join(cwd, '.web-chat'), { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grab-home-'));
  t.after(() => { for (const d of [cwd, home]) fs.rmSync(d, { recursive: true, force: true }); });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [MCP_BIN], cwd,
    env: { ...process.env, WEB_CHAT_CHANNEL: '0', ...env, HOME: home, USERPROFILE: home },
  });
  const mcp = new Client({ name: 'box-grab-test', version: '0.0.0' });
  await mcp.connect(transport);
  t.after(() => mcp.close());
  return mcp;
}

test('inspect_capture on a box-grab capture: the raw beside an MCP image block of the same PNG (sha256 equal), in one call', async (t) => {
  const { api, srv, root, port } = await withServer(t);
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: stubCapture() });
  await render(api, 'm1');
  const g = await postGrab(api, 'm1');
  await settled(srv, g.grab.capture);
  const png = fs.readFileSync(path.join(root, '.web-chat', 'captures', `${g.grab.capture}.png`));
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(port) });
  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: g.grab.capture } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image']);
  assert.equal(res.content[1].mimeType, 'image/png');
  assert.equal(sha(Buffer.from(res.content[1].data, 'base64')), sha(png));
  const meta = JSON.parse(res.content[0].text);
  assert.equal(meta.element, g.id);
  assert.equal(meta.image.sha256, sha(png));
});

test('the generic pass-through: a handler\'s {content} reaches the result as it is; every other tool\'s result is the one text item it always was', async (t) => {
  const app = express();
  const store = { a: 1, nested: { b: [1, 2] } };
  app.get('/api/store', (req, res) => res.json(store));
  app.get('/api/captures/cap1/raw', (req, res) => res.json({ id: 'cap1', url: 'element:g7', mode: 'full', raw: '<p>x</p>' }));
  app.get('/api/captures/cap2/raw', (req, res) => res.json({ id: 'cap2', url: 'https://example.com/', mode: 'full', raw: '<p>y</p>', content: [{ type: 'image' }] }));
  app.get('/api/elements/g7/grab', (req, res) => res.json({ ok: true, id: 'g7', v: 1, capture: 'cap1', image: { state: 'ready', sha256: 'abc' }, mimeType: 'image/png', data: 'iVBORw0K' }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });
  const mcp = await launchMcp(t, { WEB_CHAT_PORT: String(srv.address().port) });

  const own = await mcp.callTool({ name: 'get_store', arguments: {} });
  assert.deepEqual(own.content, [{ type: 'text', text: JSON.stringify(store, null, 2) }], 'byte-identical');
  const grab = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: 'cap1' } });
  assert.deepEqual(grab.content[1], { type: 'image', data: 'iVBORw0K', mimeType: 'image/png' });
  const page = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: 'cap2' } });
  assert.equal(page.content.length, 1, 'a daemon body with a `content` key is still wrapped');
  assert.equal(page.content[0].type, 'text');
  assert.deepEqual(JSON.parse(page.content[0].text).content, [{ type: 'image' }]);
});

// ── opt-in: a real Chrome ───────────────────────────────────────────────────

const e2e = e2eGate(['chrome']);
test('a real Chrome draws a grab of a fixture page whose PNG is the rect\'s size', { skip: e2e.skip }, async (t) => {
  const { api, srv, root } = await withServer(t);
  setSeams(srv.state, { findChrome: () => e2e.chrome });
  await render(api, 'm1', '<div style="height:300px;background:linear-gradient(red,blue)">grab me</div>');
  const g = (await ok(api.post('/api/elements', {
    type: 'box-grab', anchor: null,
    payload: { rect: { x: 10, y: 12, w: 120, h: 60, item: 'm1', viewport: { w: 1024, h: 768 } }, meta: { mode: 'light' } },
  }))).element;
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready', JSON.stringify(image));
  const png = fs.readFileSync(path.join(root, '.web-chat', 'captures', `${g.grab.capture}.png`));
  assert.deepEqual(pngSize(png), { width: 120, height: 60 });
  assert.equal(liveBrowsers(), 0);
});
