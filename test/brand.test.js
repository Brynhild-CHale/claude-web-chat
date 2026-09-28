// Per-project brand image slots: the engine (lib/server/brand.js), its routes
// (lib/server/routes/brand.js), the export that inlines the lockup and seal,
// and the chrome's topbar logotype + Settings → Brand drop targets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const brand = require('../lib/server/brand');
const { projectPaths } = require('../lib/core/paths');
const { assembleExport, buildExportHtml } = require('../lib/server/export');
const { withServer } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');

// A real 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#041E42"/></svg>');

function tmpProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-brand-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// --- the engine ---------------------------------------------------------------

test('sniff: PNG by magic, SVG by its first element, anything else is neither', () => {
  assert.equal(brand.sniff(PNG), 'png');
  assert.equal(brand.sniff(SVG), 'svg');
  assert.equal(brand.sniff(Buffer.from('﻿<svg viewBox="0 0 1 1"/>')), 'svg');
  assert.equal(brand.sniff(Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>')), 'svg');
  assert.equal(brand.sniff(Buffer.from('<html><svg></svg></html>')), null, 'svg inside something else is not an svg');
  assert.equal(brand.sniff(Buffer.from('GIF89a....')), null);
  assert.equal(brand.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null, 'a JPEG is refused');
  assert.equal(brand.sniff(Buffer.alloc(0)), null);
});

test('write: type, size and active-SVG refusals, each with its status', (t) => {
  const root = tmpProject(t);
  const status = (fn) => { try { fn(); return 200; } catch (e) { assert.ok(e instanceof brand.BrandError, e.message); return e.status; } };

  assert.equal(status(() => brand.write(root, 'logotype', Buffer.from('GIF89a'))), 415);
  assert.equal(status(() => brand.write(root, 'logotype', Buffer.alloc(0))), 400);
  const big = Buffer.concat([PNG, Buffer.alloc(brand.MAX_BYTES)]);
  assert.equal(status(() => brand.write(root, 'logotype', big)), 413);
  assert.equal(status(() => brand.write(root, 'wordmark', PNG)), 404, 'not a slot');
  assert.equal(status(() => brand.write(root, '../server', PNG)), 404, 'a path is not a slot');

  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
  ]) {
    assert.equal(status(() => brand.write(root, 'seal', Buffer.from(bad))), 422, bad);
  }
  assert.deepEqual(fs.existsSync(projectPaths(root).brandDir) ? fs.readdirSync(projectPaths(root).brandDir) : [], [],
    'nothing refused was written');

  // exactly at the cap is fine
  const atCap = Buffer.concat([PNG, Buffer.alloc(brand.MAX_BYTES - PNG.length)]);
  assert.equal(status(() => brand.write(root, 'lockup', atCap)), 200);
});

// R4-5: the check is textual, and an XML parser reads what a plain regex does
// not — a namespace prefix makes `<x:script>` a script, and a character
// reference spells `javascript:` without the colon. Each probe below passed
// the old blocklist; each is refused now, on the upload path and the logo-file
// path alike (lib/core/brand-image is the one check both run).
test('the SVG check reads namespace prefixes, character references, SMIL targets and namespace bindings', (t) => {
  const root = tmpProject(t);
  const NS = 'xmlns="http://www.w3.org/2000/svg"';
  const probes = [
    [`<svg ${NS} xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(document.domain)</x:script></svg>`, /<script>/],
    [`<svg ${NS}><x:foreignObject xmlns:x="http://www.w3.org/2000/svg"><div/></x:foreignObject></svg>`, /<foreignObject>/],
    [`<svg ${NS}><a href="javascript&#58;alert(1)"><rect/></a></svg>`, /javascript: url/],
    [`<svg ${NS}><set attributeName="onmouseover" to="alert(1)"/></svg>`, /animation of an event handler or a link/],
    // …and their near relatives
    [`<svg ${NS}><a href="&#x6A;avascript:alert(1)"><rect/></a></svg>`, /javascript: url/],
    [`<svg ${NS}><a href="java&#9;script:alert(1)"><rect/></a></svg>`, /javascript: url/],
    [`<svg ${NS}><set attributeName="&#111;nclick" to="alert(1)"/></svg>`, /animation/],
    [`<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink"><animate attributeName="xlink:href" values="#a"/></svg>`, /animation/],
    [`<svg ${NS}><iframe src="https://example.com"/></svg>`, /<iframe>/],
    [`<svg ${NS}><h:object xmlns:h="http://www.w3.org/1999/xhtml"/></svg>`, /<object>/],
    [`<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:img src="x"/></svg>`, /namespace other than SVG and XLink/],
    [`<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"/></svg>`, /namespace other than SVG and XLink/],
  ];
  for (const [bad, why] of probes) {
    assert.match(String(brand.svgRefusal(Buffer.from(bad))), why, bad);
    assert.throws(() => brand.write(root, 'seal', Buffer.from(bad)), (e) => e.status === 422, bad);
    assert.throws(() => brand.validateLogoFile('seal.svg', Buffer.from(bad)), (e) => e.status === 422, bad);
  }

  // What a real logo carries stays accepted: the SVG and XLink bindings under
  // their own prefixes, an xlink:href to a fragment, an opacity animation,
  // character references in text, no namespace at all.
  for (const ok of [
    SVG,
    Buffer.from('<svg viewBox="0 0 1 1"/>'),
    Buffer.from(`<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="http://www.w3.org/2000/svg" xml:space="preserve">`
      + '<defs><linearGradient id="g" gradientUnits="objectBoundingBox"/></defs><use xlink:href="#g"/>'
      + '<animate attributeName="opacity" values="0;1" dur="1s"/><text>&#x2014; &amp; &lt;b&gt;</text>'
      + '<style>.a{fill:#041E42}</style></svg>'),
  ]) assert.equal(brand.svgRefusal(ok), null, ok.toString());
});

test('a slot is one file: switching format drops the other; remove clears it', (t) => {
  const root = tmpProject(t);
  const dir = projectPaths(root).brandDir;
  brand.write(root, 'logotype', PNG);
  assert.deepEqual(fs.readdirSync(dir), ['logotype.png']);
  brand.write(root, 'logotype', SVG);
  assert.deepEqual(fs.readdirSync(dir), ['logotype.svg']);
  assert.equal(brand.read(root, 'logotype').type, 'image/svg+xml');
  assert.equal(brand.list(root).logotype.type, 'image/svg+xml');
  assert.equal(brand.list(root).seal, null);
  assert.equal(brand.remove(root, 'logotype'), true);
  assert.equal(brand.read(root, 'logotype'), null);
  assert.equal(brand.remove(root, 'logotype'), false);
});

test('fence: a slot file symlinked out of .web-chat is never read', (t) => {
  const root = tmpProject(t);
  const outside = path.join(tmpProject(t), 'secret.png');
  fs.writeFileSync(outside, PNG);
  const dir = projectPaths(root).brandDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'seal.png'));
  assert.equal(brand.read(root, 'seal'), null);
  assert.equal(brand.dataUri(root, 'seal'), null);
  assert.equal(brand.list(root).seal, null);
});

test('read: a file that is not what its extension says is not served', (t) => {
  const root = tmpProject(t);
  const dir = projectPaths(root).brandDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logotype.png'), '<html><script>1</script></html>');
  assert.equal(brand.read(root, 'logotype'), null);
});

// --- the routes -----------------------------------------------------------------

const put = (baseUrl, slot, body, type) => fetch(`${baseUrl}/api/brand/${slot}`, {
  method: 'PUT', headers: type ? { 'Content-Type': type } : {}, body,
});

test('routes: upload, list, serve locked down, delete', async (t) => {
  const { baseUrl: b0, root, api } = await withServer(t);
  const baseUrl = b0.replace('localhost', '127.0.0.1');

  let r = await (await fetch(`${baseUrl}/api/brand`)).json();
  assert.deepEqual(r.slots, { logotype: null, lockup: null, seal: null });
  assert.equal(r.max_bytes, brand.MAX_BYTES);

  const up = await put(baseUrl, 'logotype', SVG, 'image/svg+xml');
  assert.equal(up.status, 200);
  const upBody = await up.json();
  assert.equal(upBody.type, 'image/svg+xml');
  assert.ok(upBody.slots.logotype.version);
  assert.ok(fs.existsSync(path.join(projectPaths(root).brandDir, 'logotype.svg')));

  const img = await fetch(`${baseUrl}/brand/logotype`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/svg+xml');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), SVG);

  // the change reaches the event ring (and the WS frame beside it)
  const ev = await api.get('/api/events');
  assert.ok((ev.json.events || []).some((e) => e.kind === 'brand' && e.op === 'set' && e.slot === 'logotype'));

  const del = await fetch(`${baseUrl}/api/brand/logotype`, { method: 'DELETE' });
  assert.equal((await del.json()).removed, true);
  assert.equal((await fetch(`${baseUrl}/brand/logotype`)).status, 404);
});

test('routes: refusals — wrong type, oversize, active svg, not-a-slot, traversal', async (t) => {
  const { baseUrl: b0, root } = await withServer(t);
  const baseUrl = b0.replace('localhost', '127.0.0.1');

  assert.equal((await put(baseUrl, 'seal', Buffer.from('GIF89a'), 'image/gif')).status, 415, 'unaccepted content-type');
  assert.equal((await put(baseUrl, 'seal', Buffer.from('GIF89a'), 'image/png')).status, 415, 'bytes decide, not the header');
  const big = await put(baseUrl, 'seal', Buffer.concat([PNG, Buffer.alloc(brand.MAX_BYTES + 10)]), 'image/png');
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /exceeds|limit/);
  assert.equal((await put(baseUrl, 'seal', Buffer.from('<svg onload="x()"/>'), 'image/svg+xml')).status, 422);
  assert.equal((await put(baseUrl, 'favicon', PNG, 'image/png')).status, 404);

  for (const slot of ['..%2Fserver.json', '..%2F..%2Fetc%2Fpasswd', 'logotype%2F..%2F..%2Fserver.json']) {
    const w = await put(baseUrl, slot, PNG, 'image/png');
    assert.equal(w.status, 404, `PUT ${slot}`);
    assert.equal((await fetch(`${baseUrl}/brand/${slot}`)).status, 404, `GET ${slot}`);
    assert.equal((await fetch(`${baseUrl}/api/brand/${slot}`, { method: 'DELETE' })).status, 404, `DELETE ${slot}`);
  }
  assert.ok(!fs.existsSync(projectPaths(root).brandDir), 'no refusal wrote anything');
});

// --- the export -------------------------------------------------------------------

test('export: lockup and seal are inlined as data URIs; absent slots draw nothing', async (t) => {
  const { api, root, srv } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>body</div>' });
  await api.post('/api/commit', { message: 'seed' });

  const bare = (await api.get('/api/export/active')).text;
  assert.doesNotMatch(bare, /class="brand-lockup"/);
  assert.doesNotMatch(bare, /id="export-foot"/);
  assert.doesNotMatch(bare, /class="has-lockup"/);

  brand.write(root, 'lockup', PNG);
  let html = (await api.get('/api/export/active')).text;
  assert.ok(html.includes(`<img class="brand-lockup" alt="lockup" src="data:image/png;base64,${PNG.toString('base64')}">`));
  assert.doesNotMatch(html, /id="export-foot"/, 'no seal → no footer');
  assert.doesNotMatch(html, /\/brand\//, 'the export never points back at the server');

  brand.write(root, 'seal', SVG);
  html = (await api.get('/api/export/active')).text;
  assert.ok(html.includes(`<img class="brand-seal" alt="seal" src="data:image/svg+xml;base64,${SVG.toString('base64')}">`));
  assert.match(html, /<div id="export-foot"><span>made with web-chat<\/span><img class="brand-seal"/);
  void srv;
});

test('assembleExport: only a base64 image data: URI reaches the markup', () => {
  const html = assembleExport({ meta: { brand: {
    lockup: 'https://evil.example/x.png',
    seal: 'data:image/png;base64,AAA="><script>1</script>',
  } } });
  assert.doesNotMatch(html, /brand-lockup"|brand-seal"/);
  assert.doesNotMatch(html, /evil\.example/);
});

test('buildExportHtml: a ctx with no root exports without brand, no throw', () => {
  const ctx = {
    paths: { PUBLIC_DIR: path.join(REPO, 'public') },
    graph: { active: null, nodes: new Map(), snapshotLive: () => ({ mounts: [], store: {} }) },
  };
  const r = buildExportHtml(ctx, 'live');
  assert.ok(r.html);
  assert.doesNotMatch(r.html, /class="brand-lockup"/);
});

// --- the chrome -------------------------------------------------------------------

// ONE boot for the file: the app's modules are singletons, so a second import
// of main.js would re-run it against the first boot's module state.
let chrome = null;
let restoreChrome = () => {};
test.after(() => restoreChrome());
let serverSlots = { logotype: null, lockup: { type: 'image/svg+xml', bytes: 5, version: 'a' }, seal: null };
async function bootChrome() {
  if (chrome) return chrome;
  chrome = await bootOnce();
  return chrome;
}

async function bootOnce() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (u === '/api/brand') return json({ slots: serverSlots });
    if (u.startsWith('/api/brand/') && opts.method === 'PUT') {
      serverSlots = { ...serverSlots, [u.split('/').pop()]: { type: 'image/png', bytes: 10, version: 'v2' } };
      return json({ ok: true, slots: serverSlots });
    }
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };
  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));
  // A fresh module graph per boot: the query string makes every import new.
  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  restoreChrome = (() => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  });
  await new Promise((r) => setTimeout(r, 40));
  return { window, calls, ws: () => wsInstances[0] };
}

test('chrome: Settings → Brand has three drop targets that PUT the raw file', async () => {
  const { window, calls } = await bootChrome();
  const doc = window.document;
  // the boot GET: only the lockup is set, so the topbar has no logotype
  assert.equal(doc.getElementById('brand-logotype'), null, 'absent → no element');
  assert.equal(doc.querySelector('.brand-logo-div'), null);
  const rows = [...doc.querySelectorAll('#settings-panel .brand-slot')];
  assert.deepEqual(rows.map((r) => r.dataset.slot), ['logotype', 'lockup', 'seal']);
  const lockupImg = rows[1].querySelector('.brand-drop img');
  assert.ok(lockupImg && lockupImg.getAttribute('src') === '/brand/lockup?v=a', 'a set slot previews via <img>');
  assert.equal(rows[0].querySelector('.brand-remove').disabled, true, 'nothing to remove when unset');

  const file = new window.File([Buffer.from(PNG)], 'logo.png', { type: 'image/png' });
  const drop = rows[0].querySelector('.brand-drop');
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [file] };
  drop.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 30));
  const putCall = calls.find((c) => c.method === 'PUT');
  assert.ok(putCall, 'a drop uploads');
  assert.equal(putCall.url, '/api/brand/logotype');
  assert.equal(putCall.headers['Content-Type'], 'image/png');
  assert.equal(putCall.body, file, 'the raw file is the body');
  assert.equal(doc.getElementById('brand-logotype').getAttribute('src'), '/brand/logotype?v=v2', 'the reply lands in the topbar');

  // a non-image is refused before it is sent
  const txt = new window.File(['hi'], 'notes.txt', { type: 'text/plain' });
  const ev2 = new window.Event('drop', { bubbles: true, cancelable: true });
  ev2.dataTransfer = { files: [txt] };
  rows[2].querySelector('.brand-drop').dispatchEvent(ev2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  assert.match(doc.getElementById('brand-msg').textContent, /not an SVG or PNG/);
});

test('chrome: the topbar shows the logotype left of the wordmark only when set, and follows `brand` frames', async () => {
  const { window, ws } = await bootChrome();
  const doc = window.document;
  // start from unset (the previous test uploaded one)
  ws().onmessage({ data: JSON.stringify({ type: 'brand', slots: { logotype: null } }) });
  assert.equal(doc.getElementById('brand-logotype'), null, 'absent → no element');
  assert.equal(doc.querySelector('.brand-logo-div'), null);

  ws().onmessage({ data: JSON.stringify({ type: 'brand', slots: { logotype: { type: 'image/png', bytes: 9, version: 'v1' } } }) });
  const logo = doc.getElementById('brand-logotype');
  assert.ok(logo, 'set → shown');
  assert.equal(logo.tagName, 'IMG', 'an <img>, never inlined svg markup');
  assert.equal(logo.getAttribute('src'), '/brand/logotype?v=v1');
  const bar = doc.getElementById('topbar');
  const kids = [...bar.children];
  assert.ok(kids.indexOf(logo) < kids.indexOf(bar.querySelector('.brand')), 'left of the wordmark');

  ws().onmessage({ data: JSON.stringify({ type: 'brand', slots: { logotype: null } }) });
  assert.equal(doc.getElementById('brand-logotype'), null, 'cleared → removed');
  assert.equal(doc.querySelector('.brand-logo-div'), null);
});

test('chrome: a native file chooser taking focus does not dismiss Settings', async () => {
  const { window } = await bootChrome();
  const doc = window.document;
  const panel = doc.getElementById('settings-panel');
  panel.classList.remove('hidden');
  doc.querySelector('#brand-slots .brand-slot[data-slot="seal"] .brand-drop').click(); // opens the chooser
  // The shell's blur dismissal runs a tick late (it first looks at where focus
  // went — the replay player's frame keeps its panel), so every assert waits it out.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  window.dispatchEvent(new window.Event('blur'));
  await tick();
  assert.ok(!panel.classList.contains('hidden'), 'the pick keeps the panel open');
  // the chooser closes: focus comes back, and an ordinary blur dismisses again
  window.dispatchEvent(new window.Event('focus'));
  await new Promise((r) => setTimeout(r, 350));
  window.dispatchEvent(new window.Event('blur'));
  await tick();
  assert.ok(panel.classList.contains('hidden'), 'after the pick, blur dismisses as before');
});
