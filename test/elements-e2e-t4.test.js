'use strict';
// Tranche 4 of the annotation engine, end to end at the integration head
// (U590; PLAN.md §5 "Plug-in types, elements in documents, the ink, the boot,
// and the pencil" as amended, PLAN-T4.md, DECISIONS.md M and N). The real
// createServer through withServer, a synthetic Claude Code tier only through
// test-support/claude-home and test-support/claude-records, nothing
// hand-installed: a plug-in type takes the reviewed path.
//
// One world (a daemon whose remote viewers are opted in at `read`, with a
// value the redactor knows) carries steps (1)–(9) as subtests in order, each
// needing the last one's state; the AG-1 shape check reads that world's files
// as alpha.3 reads them; steps (10)–(13) boot their own daemons.
//   (1) the fixture strokes pack staged, reviewed and approved from the
//       confirm frame (U565's stageElementPack + approveFromFrame), listed,
//       its draw.js served with its recorded digest (U511);
//   (2) a stroke on an svg and on a data-fixed-aspect sheet: an element
//       anchor, normalised points, private (PRIVATE@create), absent from the
//       wake envelope, a search below seesPrivate and every document for a
//       reader without seesPrivate (preview, export, replay; AD5/J2);
//   (3) describe on shared strokes (U562), redacted by the log's one writer;
//       a delivered group re-sent after one member is un-shared re-raises
//       neither the stale describe nor the un-shared member (contract (h));
//   (4) Mod+Z's route over the plug-in type, another writer's newer version
//       named in the hint (U518, AF10);
//   (5) a re-render moving the svg: the stroke follows; the svg removed: the
//       stroke orphaned, never drawn at a stale position (AI8); render answers
//       the annotation counts (U563);
//   (6) the export draws shared elements, a comment, a highlight and a removed
//       type's generic mark within its cap (U524, U526); the remote export is
//       projected; the preview and a replay step draw; a replay step below
//       read carries no caption (DOCS@replay-text); a pack whose draw.js holds
//       '<!--' in a string exports 200 with its items as the generic mark
//       (contract (j));
//   (7) a point on an img and an element on a paragraph through the comment's
//       record path (U532), a range on a word (U588);
//   (8) the form-shift counter counts a moved field (U541); reportEvent's
//       anchor is stripped at basic (U542);
//   (9) the search finds by latest version only (SEARCH@latest);
//   (10) a boot over 300 nodes with the graph index faults no body before
//       the listen but the active and the unclean ones (U574); a preview and
//       an export of one node, its body faulted, draw as the whole node (F9);
//   (11) the registry after the listen: a chat pin answers indexing (never
//       unavailable), then placed (U571); PARSED_CONVERSATIONS_MAX 389 (U575);
//   (12) the park: the Push note masked at read (U581), a parked group's ×N
//       (U582), each wake's own note (U583), a node read with no private id@v
//       (U584);
//   (13) the MCP catalogue's constant holds at the head (U580): 1.0.0 and its
//       hash, no tool description or inputSchema changed in tranche 4.
// Helpers of test-support/element-type-fixture.js, named per step
// (U511-U565@approveElementPack-twice a): the strokes pack takes U565's
// stageElementPack + approveFromFrame (the quarantine and the confirm frame);
// the small one-off types of (6) take U511's approveElementPack
// (installFromStage via 'approve').
//
// Who is who: `anonApi` is a local browser (fetch metadata; the writer
// 'user'); `api` is Claude (the boot's writer token); lib/client sends no
// fetch metadata (Claude's tools, the CLI); a remote viewer is lib/client with
// the portal's X-WC-Remote at the project's `read` opt-in; a network peer is a
// request whose socket address is stubbed to 10.0.0.5 (always basic, Q9).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

// A box grab is drawn by headless Chrome; this file never launches one.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot, waitUntil, commentBody, openSSE } = require('../test-support/helpers');
const { stageElementPack, approveFromFrame, approveElementPack } = require('../test-support/element-type-fixture');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const packs = require('../lib/packs/install');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths, PUBLIC_DIR } = require('../lib/core/paths');
const { PANE_HEADER } = require('../lib/core/writer-token');
const { stableStringify } = require('../lib/core/stable-json');
const { CATALOGUE_VERSION, CATALOGUE_SHA256, packageVersion } = require('../lib/core/versions');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const { SHAPES } = require('../lib/core/ink-shape');
const { valueOf } = require('../lib/server/mirror/retention');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const exp = require('../lib/server/export');
const client = require('../lib/client');

const SHAPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alpha3-log-shape.json'), 'utf8'));

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const MOUNT = 'e4p';
const ART = '<svg class="art" viewBox="0 0 200 100"><g><path d="M0 0 L10 10"/></g></svg>';
const SHEET = '<div class="sheet" data-fixed-aspect>A sheet of figures</div>';
const PIC = '<img class="pic" alt="a chart of revenue" width="120" height="60">';
const PROSE = '<p class="prose">The quick brown fox jumps over the lazy dog.</p>';
const PANE = (before = '', art = ART) => `<div class="wrap">${before}${art}${SHEET}${PIC}${PROSE}</div>`;
const SECRET = `wcu590known${crypto.randomBytes(12).toString('hex')}`;
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const PANE_W = Object.freeze({ [PANE_HEADER]: MOUNT });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test', style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
});
const DATA_EL = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/g;

async function ok(p, what) {
  const r = await p;
  const body = r.json !== undefined ? r.json : r.body;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(body)}`);
  return body;
}
async function okText(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${String(r.text).slice(0, 300)}`);
  return r.text;
}
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

async function commit(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}

// ── the pane, as the chrome mounts it ───────────────────────────────────────
// mount-runtime's attachAndExtract in a jsdom window; jsdom does no layout, so
// every element gets a box (an img 120×60 at 20,300) for the point's frame.
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) { try { w.close(); } catch {} } });
function paneRoot(html, mount = MOUNT) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  WINDOWS.push(dom.window);
  const win = dom.window;
  const box = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t });
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.localName === 'img') return box(20, 300, 120, 60);
    if (this.localName === 'svg') return box(20, 100, 200, 100);
    return box(10, 10, 300, 20);
  };
  win.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
  const host = win.document.createElement('div');
  host.dataset.mountId = mount;
  win.document.body.appendChild(host);
  return { win, root: win.__wcMount.attachAndExtract(host, html).root };
}
const wire = (o) => JSON.parse(JSON.stringify(o));
const recordOn = (html, sel, mount = MOUNT) => { const { root } = paneRoot(html, mount); return wire(anchors.record(root, root.querySelector(sel), { mount })); };

// A stroke's body as target-frame.js's commit builds it (lib/core/strokes
// decimate and roundPoints, in frame units).
function strokeBody(anchor, { shared = false, under = 'wcu590 the line under the stroke', y0 = 0.8, extra = {} } = {}) {
  const raw = [];
  for (let i = 0; i < 12; i++) raw.push(0.1 + i * 0.07, y0 - i * 0.05, 0.5, i * 8);
  const points = strokes.roundPoints(strokes.decimate(raw));
  return {
    type: TYPE, anchor,
    payload: { text_under: under, bbox: strokes.bboxOf(points), shared, tool: 'pen', width: 2 / 200, colour: 'accent', points, stride: strokes.STROKE_STRIDE, aspect: 2, ...extra },
  };
}
// A flat stroke under a line, for the describe (a horizontal run).
function lineBody(anchor, { y, x0 = 0.05, x1 = 0.45, under, shared = true }) {
  const points = [];
  for (let i = 0; i <= 10; i++) points.push(Math.round((x0 + ((x1 - x0) * i) / 10) * 1e4) / 1e4, y, 0.5, i * 8);
  return {
    type: TYPE, anchor,
    payload: { shared, tool: 'pen', width: 0.01, colour: 'accent', points, stride: 4, aspect: 2, bbox: [x0, y, x1 - x0, 0], text_under: under, text_box: [x0, y - 0.15, x1 - x0, 0.14] },
  };
}

// ── documents in jsdom ──────────────────────────────────────────────────────
const dataElements = (html) => [...html.matchAll(DATA_EL)].map((m) => JSON.parse(m[1]));
const itemIdsOf = (html) => new Set(dataElements(html).flatMap((p) => (p.items || []).map((it) => it.id)));
// A document loaded with scripts on and the network refused; every pane host
// and element gets a box. Its inline modules run by hand before the load
// event (jsdom runs no module), their exact text less the export keywords.
function openDoc(html) {
  const net = { calls: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      const refuse = (what) => function () { net.calls++; throw new Error(`no ${what} in a document`); };
      win.fetch = refuse('fetch');
      win.XMLHttpRequest = refuse('XMLHttpRequest');
      win.WebSocket = refuse('WebSocket');
      const box = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t });
      win.Element.prototype.getBoundingClientRect = function () {
        if (this.classList && this.classList.contains('mount-host')) return box(0, 0, 800, 600);
        if (this.localName === 'svg') return box(50, 100, 200, 100);
        if (this.localName === 'img') return box(50, 300, 120, 60);
        return box(20, 40, 300, 20);
      };
      win.Range.prototype.getClientRects = function () { return [box(60, 80, 120, 18)]; };
    },
  });
  WINDOWS.push(dom.window);
  const win = dom.window;
  for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    win.eval(`(function () {\n${m[1].replace(/^export default function /m, 'function ').replace(/^export (const|let|var|function) /gm, '$1 ')}\n})();`);
  }
  return { win, net };
}
const markersOf = (win) => [...win.document.querySelectorAll('.el-marker')];
const markerOf = (win, id) => markersOf(win).find((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id));
async function settled(win, what) {
  await waitUntil(() => win.document.readyState === 'complete' && win.__wcMount && win.__wcMount.elements
    && typeof win.__wcMount.elements.stats === 'function' && win.__wcMount.elements.stats().drawn > 0, { timeout: 8000, what });
  return win.__wcMount.elements.stats();
}

// The replay document's payload and one step's frame, as the player fills it.
function replayPayload(html) {
  const m = /<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the replay document holds its payload');
  return JSON.parse(m[1]);
}
function replayFrame(payload, i) {
  const s = payload.steps[i];
  const [a, b, c, d] = payload.frame;
  let el = '';
  if (s.elements && s.anchors) el = payload.elements_rt[s.elements.rt] + s.elements.types.map((k) => payload.element_types[k]).join('') + s.elements.data;
  return a + (payload.themes[s.theme] || '') + b + (s.anchors ? payload.anchors[s.anchors] : '') + el + c + s.node + d;
}

// ── a socket the test keeps (the chrome's frames) ──────────────────────────
function openSocket(t, d) {
  return new Promise((resolve, reject) => {
    const sock = d.ws();
    t.after(() => { try { sock.terminate(); } catch {} });
    sock.on('unexpected-response', (_q, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') resolve({ sock, send: (f) => sock.send(JSON.stringify(f)) });
    });
  });
}

// ═══ the world: steps (1)–(9) and the AG-1 shape check ═════════════════════

test('the world: an approved strokes pack, its private strokes, describe, undo, documents, points and ranges, the form counter, the search; then the AG-1 shape check', async (t) => {
  const root = tmpRoot('wc-u590-');
  const seed = () => {
    writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } });
    fs.writeFileSync(projectPaths(root).captureToken, `${SECRET}\n`);
  };
  const d = await withServer(t, { root, seed });
  t.after(stubPeers(d.server));
  const call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 15000 });
  const W = {};   // what the steps hand on

  await ok(d.api.post('/api/render', { id: MOUNT, html: PANE() }), 'render the pane');

  await t.test('(1) stageElementPack + approveFromFrame: the strokes type is listed and its draw.js served at the recorded digest', async () => {
    const staged = await stageElementPack(t, d, { dir: PACK_DIR, owner: 'acme', repo: 'strokes-u590' });
    assert.equal(staged.res.json.ok, true, staged.res.text);
    assert.ok(!(await ok(d.api.get('/api/elements/types'), 'types')).types.some((r) => r.type === TYPE), 'quarantined: listed nowhere');
    const out = await approveFromFrame(d.srv, { name: PACK, tier: 'local' });
    assert.equal(out.res.status, 200, JSON.stringify(out.res.body));
    assert.deepEqual(out.res.body, { ok: true, said: `Installed ${PACK}: ${TYPE}` });
    const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
    assert.ok(row, 'listed once approved');
    assert.deepEqual([row.builtin, row.private, row.toolbar.input, row.toolbar.place], [false, true, 'strokes', 'box']);
    const bytes = fs.readFileSync(path.join(PACK_DIR, 'elements', TYPE, 'draw.js'));
    assert.equal(row.draw.sha256, sha256(bytes), 'the listing names the installed draw.js digest');
    const served = await d.anonApi.get(`/api/elements/types/${TYPE}/draw.js?d=${row.draw.sha256}`);
    assert.equal(served.status, 200);
    assert.equal(served.text, bytes.toString('utf8'), 'byte-equal');
    assert.equal(served.headers.get('etag'), `"${row.draw.sha256}"`, 'the ETag is the recorded digest');
    assert.match(served.headers.get('content-type'), /^text\/javascript/);
    const again = await d.anonApi.get(`/api/elements/types/${TYPE}/draw.js`, { 'if-none-match': `"${row.draw.sha256}"` });
    assert.equal(again.status, 304, 'the digest validates');
    W.row = row;
  });

  await t.test('(2) strokes on an svg and on a data-fixed-aspect sheet: element anchors, normalised points, private; absent from the wake, a search below seesPrivate and every document a reader without seesPrivate gets', async () => {
    const onSvg = recordOn(PANE(), 'svg.art');
    const onSheet = recordOn(PANE(), '[data-fixed-aspect]');
    for (const a of [onSvg, onSheet]) assert.deepEqual([a.kind, a.mount], ['element', MOUNT]);
    assert.equal(onSvg.fp.tag, 'svg');
    assert.equal(onSheet.fp.tag, 'div');
    const UNDER = 'wcu590-private-line';
    const a = (await ok(d.anonApi.post('/api/elements', strokeBody(onSvg, { under: UNDER })), 'stroke on the svg')).element;
    const b = (await ok(d.anonApi.post('/api/elements', strokeBody(onSheet, { under: UNDER })), 'stroke on the sheet')).element;
    for (const e of [a, b]) {
      assert.match(e.id, /^p\d+$/, 'one letter p for a plug-in type (AI2)');
      assert.equal(e.type, TYPE);
      assert.equal(e.shared, false, 'private by default (PRIVATE@create)');
      assert.ok(e.points.length && e.points.every((n, i) => (i % 4 === 3) || (n >= 0 && n <= 1)), 'normalised points');
    }
    assert.deepEqual(d.srv.state.queue.filter((it) => it.kind === 'element'), [], 'no queue item for a private stroke');
    // A Push carries nothing of them (a shared comment rides so there is a batch).
    await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wcu590 the batch', shared: true, anchor: { mount: MOUNT, selector: 'p.prose', text: 'The quick', ordinal: 0 } })), 'a shared comment');
    const pushed = await ok(d.api.post('/api/queue/push', { note: 'wcu590 a push' }), 'push');
    const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(pending, 'parked (no channel)');
    for (const e of [a, b]) assert.ok(!has(pushed, e.id) && !has(pending, e.id), `${e.id} is in no envelope`);
    assert.ok(!has(pending, UNDER));
    await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');
    // The search: refused at basic, 0 hits for read and lib/client, the host's browser sees them.
    const q = `/api/elements/search?q=${encodeURIComponent(UNDER)}`;
    const peer = await call('GET', q, null, PEER);
    assert.equal(peer.status, 403, 'basic: refused');
    assert.ok(!has(peer.body, UNDER));
    assert.deepEqual((await call('GET', q, null, REMOTE)).body, { hits: [], truncated: false }, 'the remote read viewer: none');
    assert.deepEqual((await call('GET', q)).body, { hits: [], truncated: false }, 'lib/client: none');
    assert.deepEqual((await ok(d.anonApi.get(q), 'browser')).hits.map((h) => h.id).sort(), [a.id, b.id].sort(), 'the host\'s browser: both');
    // Every document, for a reader without seesPrivate.
    const node = await commit(d.api, 'the private strokes');
    const prev = (headers) => call('GET', `/preview/node/${node}`, null, headers);
    const docs = {
      'preview, lib/client': (await prev()).body,
      'preview, remote read': (await prev(REMOTE)).body,
      'export, the local browser\'s download': (await okText(d.anonApi.get(`/api/export/${node}`), 'export')),
      'export, remote read': (await call('GET', `/api/export/${node}`, null, REMOTE)).body,
      'replay, lib/client': (await call('GET', `/replay?from=${node}&to=${node}`)).body,
      'replay download, the local browser': (await okText(d.anonApi.get(`/api/replay/html?from=${node}&to=${node}`), 'replay html')),
    };
    for (const [what, html] of Object.entries(docs)) {
      assert.equal(typeof html, 'string', what);
      const ids = what.startsWith('replay') ? new Set(replayPayload(html).steps.flatMap((s) => (s.elements ? dataElements(s.elements.data).flatMap((p) => p.items.map((it) => it.id)) : []))) : itemIdsOf(html);
      for (const e of [a, b]) assert.ok(!ids.has(e.id) && !has(html, `"${e.id}"`), `${what}: no ${e.id}`);
      assert.ok(!has(html, UNDER), `${what}: no text of it`);
    }
    // The local browser viewing the preview in place sees its own (AI9 a).
    const own = await okText(d.anonApi.get(`/preview/node/${node}`), 'the local browser\'s preview');
    assert.ok([a.id, b.id].every((id) => itemIdsOf(own).has(id)), 'the preview in place draws the private strokes for the local browser');
    Object.assign(W, { onSvg, onSheet, privA: a, privB: b, node1: node });
  });

  await t.test('(3) describe on shared strokes, redacted by the log\'s one writer; a re-send after an un-share carries neither the stale describe nor the un-shared member', async () => {
    const before = d.srv.state.queue.length;
    const s1 = (await ok(d.anonApi.post('/api/elements', lineBody(W.onSvg, { y: 0.3, under: `the key is ${SECRET} here` })), 's1')).element;
    const s2 = (await ok(d.anonApi.post('/api/elements', lineBody(W.onSvg, { y: 0.5, x0: 0.1, x1: 0.6, under: 'wcu590 by four per cent' })), 's2')).element;
    const s3 = (await ok(d.anonApi.post('/api/elements', lineBody(W.onSvg, { y: 0.7, under: 'wcu590 the third line' })), 's3')).element;
    const log = fs.readFileSync(projectPaths(d.root).elementsLog, 'utf8');
    assert.ok(log.includes('the key is'), 'the text under is stored');
    assert.ok(!log.includes(SECRET), 'a value the redactor knows is masked before the bytes land');
    const items = d.srv.state.queue.slice(before).filter((it) => it.kind === 'element' && it.type === TYPE);
    assert.equal(items.length, 1, 'one group');
    const it = items[0];
    assert.deepEqual(it.element_ids, [s1.id, s2.id, s3.id]);
    assert.deepStrictEqual(Object.keys(it.describe).sort(), ['bbox', 'confidence', 'count', 'shape']);
    assert.ok(SHAPES.includes(it.describe.shape));
    assert.equal(it.describe.count, 3);
    assert.deepStrictEqual(it.describe.bbox, [0.05, 0.3, 0.55, 0.4], 'the union of the three');
    assert.ok(!has(it, SECRET), 'masked in the item and its excerpt');
    // Delivered (no channel: parked), then s2 un-shared, then re-sent.
    await ok(d.api.post('/api/queue/push', {}), 'push the group');
    const pend = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    await ok(d.api.post('/api/queue/pending/consume', { id: pend.id }), 'consume');
    await ok(d.anonApi.patch(`/api/elements/${s2.id}`, { shared: false }), 'un-share s2');
    const r = await call('POST', `/api/queue/items/${it.id}/resend`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = r.body.item;
    assert.deepEqual(again.element_ids, [s1.id, s3.id], 'the un-shared member is never raised again');
    assert.equal(again.count, 2);
    assert.ok(!again.describe || again.describe.count !== 3, `no stale describe: ${JSON.stringify(again.describe)}`);
    assert.ok(!has(again, s2.id) && !has(again, 'by four per cent'), 'neither the un-shared stroke\'s id nor its words');
    assert.ok(!has(again, '0.55'), 'nor the extent it made');
    // Take it out of the queue again.
    await ok(d.api.del(`/api/queue/${again.id}`), 'remove the re-sent item');
    W.shared = [s1, s3];
  });

  await t.test('(4) POST /api/elements/undo over the plug-in type: the caller\'s newest live version goes; another writer\'s newer one is named in the hint (AF10)', async () => {
    const mine = (await ok(d.anonApi.post('/api/elements', strokeBody(W.onSheet, { under: 'wcu590 mine to undo' })), 'mine')).element;
    const theirs = (await ok(d.anonApi.post('/api/elements', strokeBody(W.onSheet, { under: 'wcu590 the pane\'s' }), PANE_W), 'the pane\'s')).element;
    assert.equal(theirs.writer.owner, `pane:${MOUNT}`);
    const r = await ok(d.anonApi.post('/api/elements/undo', { item: MOUNT }), 'undo');
    assert.deepEqual(r.undone, { id: mine.id, type: TYPE, v: 1, item: MOUNT, how: 'removed' });
    assert.deepEqual(r.newer, [{ id: theirs.id, type: TYPE, writer_class: 'pane' }]);
    assert.match(r.hint, new RegExp(`a newer annotation on this pane is ${TYPE} by pane; it was left as it is`));
    const refs = d.srv.state.elements;
    assert.ok(!refs.includes(`${mine.id}@1`) && refs.includes(`${theirs.id}@1`), 'mine retracted, theirs left');
    // The pane's own undo takes its own.
    assert.equal((await ok(d.anonApi.post('/api/elements/undo', { item: MOUNT }, PANE_W), 'the pane\'s undo')).undone.id, theirs.id);
  });

  await t.test('(5) a re-render that moves the svg: the stroke follows; the svg removed: orphaned, drawn faded at a guess or listed, never at a stale position; render answers the annotation counts', async () => {
    const moved = PANE('<p class="intro">A new paragraph above the chart.</p>');
    const r1 = await ok(d.api.post('/api/render', { id: MOUNT, html: moved }), 're-render');
    assert.equal(r1.annotations.item, MOUNT);
    assert.ok(r1.annotations.total >= 4, JSON.stringify(r1.annotations));
    assert.ok(r1.annotations.by_type[TYPE] >= 4, 'the strokes counted by type');
    assert.ok(r1.annotations.private >= 2, 'a local caller (Claude\'s tools) is told the private count (AI7)');
    const rowOf = async (headers) => ((await call('GET', '/api/mounts', null, headers)).body.mounts || []).find((m) => m.id === MOUNT);
    assert.ok((await rowOf()).annotations.private >= 2, 'list_mounts\' row: local');
    const far = (await rowOf(REMOTE)).annotations;
    assert.ok(far && !('private' in far), `a remote request is never told the private count: ${JSON.stringify(far)}`);
    assert.ok(far.total < r1.annotations.total, 'nor counts them');
    // The resolver over the new DOM: the stroke's anchor finds the moved svg.
    const { root } = paneRoot(moved);
    const ans = anchors.resolve(root, W.privA.anchor);
    assert.notEqual(ans.state, 'orphaned', JSON.stringify(wire({ state: ans.state, how: ans.how })));
    assert.equal(ans.el, root.querySelector('svg.art'), 'the stroke follows its svg');
    // The svg removed: the anchor orphans (no guess at a stale path).
    const gone = PANE('<p class="intro">A new paragraph above the chart.</p>', '');
    await ok(d.api.post('/api/render', { id: MOUNT, html: gone }), 'the svg removed');
    const g = paneRoot(gone).root;
    const orphan = anchors.resolve(g, W.privA.anchor);
    assert.equal(orphan.state, 'orphaned', 'orphaned once its target is gone');
    assert.ok(!orphan.el || orphan.el.localName !== 'svg', 'never placed on a stale svg');
    // DRAW_RULES (the one table, held equal by U522): orphaned faded at a
    // guess, else none (listed in the orphans card) — never at a stale box.
    const { DRAW_RULES } = require('../lib/server/runtime/elements-doc-src');
    const rows = DRAW_RULES.filter((row) => row.state === 'orphaned');
    assert.ok(rows.length, 'an orphaned row');
    assert.ok(rows.every((row) => row.draw === 'none' || row.draw === 'guess'), JSON.stringify(rows));
    assert.ok(rows.some((row) => row.draw === 'guess') && rows.some((row) => row.draw === 'none'), 'faded at its guess when one exists, listed otherwise');
    await ok(d.api.post('/api/render', { id: MOUNT, html: PANE() }), 'the pane put back');
  });

  await t.test('(6) documents: the export draws shared elements, a comment, a highlight and a removed type\'s generic mark within its cap; the remote export projected; the preview and a replay step draw; below read a replay step has no caption; a \'<!--\' module exports with the generic mark', async () => {
    approveElementPack(d, { name: 'e4-gone-pack', type: 'e4-gone', json: { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'] } });
    approveElementPack(d, {
      name: 'e4-cmt-pack', type: 'e4-cmt', json: { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element'] },
      draw: 'export default function draw(group, ctx) { group.container.title = "<!-- not a splice -->"; }\n',
    });
    const hl = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { v: 1, kind: 'range', mount: MOUNT, quote: { exact: 'quick brown', prefix: 'The ', suffix: ' fox' } }, payload: { color: 'gold', note: 'wcu590-highlight' } }), 'highlight')).element;
    const cm = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wcu590-comment', shared: true, anchor: { mount: MOUNT, selector: 'p.prose', text: 'The quick', ordinal: 0 } })), 'comment')).pin;
    const goneEl = (await ok(d.anonApi.post('/api/elements', { type: 'e4-gone', anchor: W.onSheet, payload: { label: 'wcu590-gone', shared: true } }), 'e4-gone')).element;
    const cmtEl = (await ok(d.anonApi.post('/api/elements', { type: 'e4-cmt', anchor: W.onSheet, payload: { label: 'wcu590-cmt', shared: true } }), 'e4-cmt')).element;
    const node = await commit(d.api, 'the documents');
    packs.removePackByName({ name: 'e4-gone-pack', root: d.root });
    d.srv.elementTypes.invalidate();
    assert.equal(d.srv.elementTypes.listed('e4-gone'), false, 'removed after the commit');

    const html = (await okText(d.anonApi.get(`/api/export/${node}`), 'the export'));
    const [p, ...more] = dataElements(html);
    assert.equal(more.length, 0, 'one data element');
    const ids = new Set(p.items.map((it) => it.id));
    for (const e of [...W.shared, { id: hl.id }, { id: cm.id }, goneEl, cmtEl]) assert.ok(ids.has(e.id), `the export carries ${e.id}`);
    assert.ok(![W.privA.id, W.privB.id].some((id) => ids.has(id)), 'never a private stroke (AI9)');
    assert.deepStrictEqual(p.removed, ['e4-gone']);
    const cmtRow = p.types.find((r) => r.type === 'e4-cmt');
    assert.ok(cmtRow && cmtRow.skipped.some((s) => s.rel === 'draw.js' && s.reason === 'unsafe-splice'), `'<!--' rides as no module: ${JSON.stringify(cmtRow)}`);
    const { win, net } = openDoc(html);
    const st = await settled(win, 'the export draws');
    assert.equal(net.calls, 0, 'no network');
    assert.ok(st.drawn >= 3, JSON.stringify(st));
    for (const id of [goneEl.id, cmtEl.id]) {
      const m = markerOf(win, id);
      assert.ok(m && m.classList.contains('el-generic'), `${id}: the generic mark (${m ? m.className : 'none'})`);
    }
    assert.ok(markerOf(win, cm.id), 'the comment drawn');
    assert.ok(markerOf(win, W.shared[0].id), 'the shared stroke drawn by its module');
    // The cap (U526): the element payload's own bytes within EXPORT_ELEMENTS_MAX.
    const built = exp.buildExportHtml({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root, paths: resolvePaths(d.root) }, node, new Date());
    assert.ok(built.html && built.budget, JSON.stringify(Object.keys(built)));
    assert.ok(built.budget.runtime_bytes + built.budget.payload_bytes <= exp.EXPORT_ELEMENTS_MAX, JSON.stringify(built.budget));
    t.diagnostic(`BUDGET@typical-export reading (this scenario, not the census): bytes ${built.budget.bytes}, runtime ${built.budget.runtime_bytes}, payload ${built.budget.payload_bytes}`);
    // ?format=file writes it (the '<!--' type included), never a private element.
    const file = await call('GET', `/api/export/${node}?format=file`);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    const written = fs.readFileSync(file.body.path, 'utf8');
    assert.ok(itemIdsOf(written).has(cmtEl.id) && !itemIdsOf(written).has(W.privA.id));
    // The remote export: projected (read sees the shared ones, never a private one).
    const far = (await call('GET', `/api/export/${node}`, null, REMOTE)).body;
    const farIds = itemIdsOf(far);
    assert.ok(farIds.has(cm.id) && farIds.has(W.shared[0].id), 'read: the shared ones');
    assert.ok(!farIds.has(W.privA.id) && !has(far, 'wcu590-private-line'), 'read: no private one');
    // The preview draws them.
    const prev = (await okText(d.anonApi.get(`/preview/node/${node}`), 'preview'));
    const pv = openDoc(prev);
    await settled(pv.win, 'the preview draws');
    assert.ok(markerOf(pv.win, cm.id) && markerOf(pv.win, W.shared[0].id), 'the preview draws the comment and the stroke');
    // One replay step draws; below read a step carries no caption.
    const rp = replayPayload((await call('GET', `/replay?from=${W.node1}&to=${node}`)).body);
    const last = rp.steps.length - 1;
    assert.ok(rp.steps[last].elements, 'the step carries its elements');
    assert.ok(rp.steps.some((s) => s.caption), 'a local reader gets captions');
    const fr = openDoc(replayFrame(rp, last));
    await settled(fr.win, 'the replay step draws');
    assert.ok(markerOf(fr.win, cm.id), 'the replay step draws the comment');
    const basic = await call('GET', `/replay?from=${W.node1}&to=${node}&level=basic`);
    assert.equal(basic.status, 200);
    const bp = replayPayload(basic.body);
    assert.ok(bp.steps.every((s) => !('caption' in s) && !('elements' in s)), 'below read: no caption, no element (DOCS@replay-text)');
    Object.assign(W, { node2: node, cm, hl });
  });

  await t.test('(7) a point on an img and an element on a paragraph through the comment\'s record path; a range on a word', async () => {
    const { root } = paneRoot(PANE());
    const img = root.querySelector('img.pic');
    const point = anchors.recordPoint(root, img, 20 + 30, 300 + 15, { mount: MOUNT });
    assert.equal(point.kind, 'point', JSON.stringify(point));
    assert.deepEqual([point.x, point.y], [0.25, 0.25], 'normalised inside the img\'s box');
    assert.equal(point.aspect, 2);
    const refused = anchors.recordPoint(root, root.querySelector('p.prose'), 15, 15, { mount: MOUNT });
    assert.equal(refused.refused, 'not-fixed-aspect', 'prose is no point target');
    const pt = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: wire(point), payload: { text: 'wcu590 on the picture', shared: true } }), 'a point comment')).pin;
    assert.equal(pt.anchor.kind, 'point');
    assert.deepEqual([pt.anchor.x, pt.anchor.y, pt.anchor.aspect], [0.25, 0.25, 2], 'stored as an engine record (U532: ENGINE_KINDS point)');
    const back = anchors.resolve(root, pt.anchor);
    assert.notEqual(back.state, 'orphaned');
    assert.equal(back.el, img);
    assert.deepEqual(anchors.pointAt(back, { left: 20, top: 300, width: 120, height: 60 }), { x: 50, y: 315, aspect: 2 });
    const para = wire(anchors.record(root, root.querySelector('p.prose'), { mount: MOUNT }));
    const el = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: para, payload: { text: 'wcu590 on the paragraph', shared: true } }), 'an element comment')).pin;
    assert.equal(el.anchor.kind, 'element');
    const text = root.querySelector('p.prose').firstChild;
    const range = root.ownerDocument.createRange();
    range.setStart(text, 4); range.setEnd(text, 9);
    assert.equal(range.toString(), 'quick');
    const rec = wire(anchors.recordRange(root, range, { mount: MOUNT }));
    assert.equal(rec.kind, 'range');
    assert.equal(rec.quote.exact, 'quick');
    const rg = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: rec, payload: { text: 'wcu590 on a word', shared: true } }), 'a range comment')).pin;
    assert.equal(rg.anchor.kind, 'range');
    const node = await commit(d.api, 'points and ranges');
    const kinds = require('../lib/server/runtime/anchors-src').kindsOf(d.srv.graph.nodes.get(node));
    assert.ok(['element', 'point', 'range'].every((k) => kinds.includes(k)), `the node's resolver cut: ${kinds}`);
    Object.assign(W, { point: pt, node3: node });
  });

  await t.test('(8) the form-shift counter counts a moved field; reportEvent\'s anchor is kept for the host and read, stripped at basic', async () => {
    const BEFORE = '<input name="who"><input name="what">';
    const AFTER = '<input name="extra"><input name="who"><input name="what">';
    const { win, root } = paneRoot(BEFORE, 'e4f');
    root.querySelector('[name="who"]').value = 'ada';
    const fsState = wire(win.__wcMount.captureFormState(root));
    const later = paneRoot(AFTER, 'e4f');
    const tally = wire(later.win.__wcMount.applyFormState(later.root, fsState));
    assert.ok(tally.shifted >= 1, `a moved field is shifted: ${JSON.stringify(tally)}`);
    await ok(d.api.post('/api/render', { id: 'e4f', html: AFTER }), 'render the form');
    const s = await openSocket(t, d);
    s.send({ type: 'pane:form', id: 'e4f', shifts: tally });
    const cur = async () => ((await call('GET', '/api/forms/shifts')).body.releases || {})[packageVersion()];
    await waitUntil(async () => (await cur()) && (await cur()).shifted >= tally.shifted, { timeout: 8000, what: 'the counter' });
    assert.equal((await call('GET', '/api/forms/shifts', null, REMOTE)).status >= 400, true, '/api/forms/* is host-only');
    // The event's anchor: the element record of the clicked button.
    const btnHtml = '<ul><li class="row"><b>first</b><button class="go" id="go">wcu590-run</button></li></ul>';
    await ok(d.api.post('/api/render', { id: 'e4e', html: btnHtml }), 'render the button');
    const pe = paneRoot(btnHtml, 'e4e');
    const anchor = wire(anchors.record(pe.root, pe.root.querySelector('button'), { mount: 'e4e' }));
    s.send({ type: 'event', payload: { type: 'click', mountId: 'e4e', tag: 'BUTTON', id: 'go', name: null, value: null, dataset: null, anchor } });
    const domOf = async (headers) => ((await call('GET', '/api/events?since=0', null, headers)).body.events || []).filter((e) => e.kind === 'dom' && e.mountId === 'e4e');
    await waitUntil(async () => (await domOf()).length === 1, { timeout: 8000, what: 'the event in the ring' });
    assert.deepStrictEqual((await domOf())[0].anchor, anchor, 'the host reads the anchor whole');
    assert.deepStrictEqual((await domOf(REMOTE))[0].anchor, anchor, 'read keeps it');
    const basic = await call('GET', '/api/events?since=0', null, PEER);
    if (basic.status === 200) {
      const ev = (basic.body.events || []).filter((e) => e.kind === 'dom' && e.mountId === 'e4e');
      assert.ok(ev.length && ev.every((e) => !('anchor' in e)), 'basic: no anchor');
      assert.ok(!has(basic.body, 'wcu590-run'), 'basic: no pane text');
    }
  });

  await t.test('(9) the search reads each element\'s latest version only', async () => {
    const h = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { v: 1, kind: 'range', mount: MOUNT, quote: { exact: 'lazy dog', prefix: 'the ', suffix: '.' } }, payload: { color: 'green', note: 'wcu590-search-old' } }), 'h')).element;
    await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { note: 'wcu590-search-new' } }), 'edit');
    const find = async (q) => (await ok(d.anonApi.get(`/api/elements/search?q=${encodeURIComponent(q)}`), q)).hits;
    assert.deepEqual(await find('wcu590-search-old'), [], 'the earlier version is not searched');
    const hits = await find('wcu590-search-new');
    assert.deepEqual(hits.map((x) => [x.id, x.v, x.field]), [[h.id, 2, 'note']]);
    const r = await d.anonApi.get(`/api/elements/search?q=x&versions=all`);
    assert.equal(r.status, 400, 'no version filter (SEARCH@latest)');
  });

  await t.test('AG-1: every node file and log record read as alpha.3 reads them, against test/fixtures/alpha3-log-shape.json; the residuals named', async () => {
    await d.graceful();
    const logFile = projectPaths(d.root).elementsLog;
    const bytes = fs.readFileSync(logFile, 'utf8');
    const recs = bytes.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const known = new Set(SHAPE.record_types);
    const residual = { plugin_versions: 0, point_anchors: 0, display_siblings: 0 };
    for (const r of recs) {
      assert.ok(known.has(r.t), `alpha.3's index knows every record type: ${r.t}`);
      if (r.t === 'el' || r.t === 'ver' || r.t === 'commit') {
        const allowed = new Set([...SHAPE.record_keys[r.t], ...(r.t === 'ver' ? ['display'] : [])]);
        for (const k of Object.keys(r)) assert.ok(allowed.has(k), `${r.t} ${r.id || r.node}: ${k} is a key alpha.3 writes (display: the named residual)`);
        for (const k of SHAPE.record_keys[r.t]) assert.ok(k in r, `${r.t} carries ${k}`);
      }
      if (r.t === 'ver') {
        const letter = r.id[0];
        if (letter === 'p') {
          residual.plugin_versions++;
          assert.equal(SHAPE.schemas[r.schema], undefined, 'a p id\'s schema is one alpha.3 has no row for: parked, drawn by nothing');
        } else {
          assert.ok(SHAPE.id_letters.includes(letter), `${r.id}: an alpha.3 letter`);
          const row = SHAPE.schemas[r.schema];
          assert.ok(row, `${r.id}: ${r.schema} is an alpha.3 schema`);
          for (const k of Object.keys(r.payload || {})) assert.ok(row.keys.includes(k), `${r.id}: payload key ${k} is one alpha.3 reads`);
          const kind = r.payload && r.payload.anchor && r.payload.anchor.kind;
          if (kind === 'point') residual.point_anchors++;
          else if (kind) assert.ok(SHAPE.engine_kinds.includes(kind), `${r.id}: anchor kind ${kind} is an alpha.3 engine kind`);
        }
        if (r.display != null) residual.display_siblings++;
      }
      if (r.t === 'commit') assert.ok(new RegExp(SHAPE.node_id).test(r.node), r.node);
    }
    assert.ok(residual.plugin_versions > 0, 'the world wrote p-id versions (the named residual)');
    assert.ok(residual.point_anchors > 0, 'and a point record (the named residual)');
    // Node files: the ids and the comment counts alpha.3 reads.
    const gdir = projectPaths(d.root).graphDir;
    const files = fs.readdirSync(gdir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 3);
    const counts = {};
    for (const f of files) {
      const n = JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8'));
      if (!/^n\d+$/.test(f.slice(0, -5))) continue;
      assert.ok(new RegExp(SHAPE.node_id).test(n.id) && Number.isFinite(n.created_at), `${f}: isGraphNode at alpha.3`);
      counts[n.id] = Array.isArray(n.comments) ? n.comments.length : 0;
      for (const c of n.comments || []) assert.ok(SHAPE.id_letters.includes(String(c.id)[0]), `${n.id}: a comment copy alpha.3 reads (${c.id})`);
    }
    // The derived files alpha.3 never reads.
    assert.ok(fs.existsSync(projectPaths(d.root).graphIndex), 'graph-index.json (derived; unread by alpha.3)');
    assert.ok(fs.existsSync(projectPaths(d.root).formShifts), 'form-shifts.json (unread by alpha.3)');
    // The built-in comment manifest: the version alpha.3 pinned, the point kind and the glyph flag added.
    const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'elements', 'web-chat-builtins', 'elements', 'comment', 'element.json'), 'utf8'));
    const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'elements', 'web-chat-builtins', 'web-chat-pack.json'), 'utf8'));
    assert.equal(pk.version, SHAPE.comment_manifest.version, 'the built-in pack is unbumped (AJ9): \'shipped-change\' reinstalls it');
    assert.deepEqual([man.schema, man.reads], [SHAPE.comment_manifest.schema, SHAPE.comment_manifest.reads], 'the comment reads what alpha.3 reads');
    assert.deepEqual(man.anchors.filter((k) => !SHAPE.comment_manifest.anchors.includes(k)), ['point'], 'the one new anchor kind');
    assert.equal(valueOf('parsed-conversations-max') > SHAPE.parsed_conversations_max, true, 'alpha.3\'s own cap is lower (160): a rollback holds fewer');
    // A second life over the same files: the log's prefix unchanged, the node
    // ids and comment counts the same.
    const again = await withServer(t, { root: d.root });
    const after = fs.readFileSync(logFile, 'utf8');
    assert.ok(after.startsWith(bytes), 'the log is append-only: its prefix unchanged');
    for (const [id, n] of Object.entries(counts)) {
      const node = again.srv.graph.nodes.get(id);
      assert.ok(node, `${id} still a node`);
      assert.equal((node.comments || []).length, n, `${id}: the same comment count`);
    }
    t.diagnostic(`AG-1 residuals in this world: ${JSON.stringify(residual)}`);
    await again.stop();   // before the world's own teardown removes the root
  });
});

// ═══ (10) the boot over 300 nodes ══════════════════════════════════════════

const NODES = 300;
const scratch = [];
test.after(() => { for (const dir of scratch) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
function copyRoot(from) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u590-boot-'));
  scratch.push(to);
  fs.cpSync(path.join(from, '.web-chat'), path.join(to, '.web-chat'), { recursive: true, preserveTimestamps: true });
  return to;
}

test('(10) a boot over 300 nodes with the graph index faults no body before the listen but the unclean one\'s and the active one\'s; a preview and an export of one node draw as the whole node does (F9)', { timeout: 240000 }, async (t) => {
  const s = await withServer(t);
  const { api } = s;
  let q = null;
  let qNode = null;
  for (let i = 1; i <= NODES; i++) {
    await ok(api.post('/api/turn-begin', { message: `turn ${i}` }), 'turn-begin');
    const mount = `b${i % 7}`;
    await ok(api.post('/api/render', { id: mount, html: `<p class="lead">${mount} at turn ${i}</p>` }), 'render');
    if (i % 25 === 0) await ok(api.post('/api/elements', commentBody({ text: `note ${i}`, shared: true, anchor: { mount, selector: 'p.lead', text: mount, ordinal: 0 } })), 'pin');
    if (i === 150) {
      q = (await ok(api.post('/api/elements', commentBody({ text: 'wcu590 short-lived', shared: true, anchor: { mount, selector: 'p.lead', text: mount, ordinal: 0 } })), 'q')).pin.id;
      await ok(api.post(`/api/elements/${q}/reply`, { text: 'and gone' }), 'reply');
    }
    if (i === 151) await ok(api.del(`/api/elements/${q}`), 'delete q');
    const end = await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
    if (i === 150) qNode = end.node_id;
  }
  await s.graceful();
  // The index as a boot's after-listen flush writes it.
  const g = createGraph({ paths: resolvePaths(s.root), state: createState() });
  g.load();
  g.flushIndex();
  const fixture = copyRoot(s.root);
  // The unclean node: the log loses the version its record pins.
  const logFile = projectPaths(fixture).elementsLog;
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => { const r = JSON.parse(l); return !(r.t === 'ver' && r.id === q && r.v === 2); });
  assert.equal(kept.length, lines.length - 1, 'one version line dropped');
  fs.writeFileSync(logFile, kept.join('\n') + '\n');
  const meta = JSON.parse(fs.readFileSync(projectPaths(fixture).meta, 'utf8'));

  const lazyRoot = copyRoot(fixture);
  const wholeRoot = copyRoot(fixture);
  fs.rmSync(projectPaths(wholeRoot).graphIndex);
  const L = await withServer(t, { root: lazyRoot });
  const atListen = L.srv.graph.lazyStats();
  assert.equal(atListen.headers, NODES, 'every node built from its header');
  assert.deepEqual(atListen.faulted_ids, [qNode, meta.active], 'the unclean node\'s body and the active one\'s, nothing else');
  await L.srv.mirror.ready;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(L.srv.graph.lazyStats().faulted_ids, [qNode, meta.active], 'the after-listen work reads no body');

  // F9: one node previewed, one exported — each faults exactly its own body,
  // and each document equals the one a whole read draws.
  const ids = [...L.srv.graph.nodes.keys()];
  const pinned = ids.filter((id) => id !== qNode && id !== meta.active && (JSON.parse(fs.readFileSync(path.join(projectPaths(lazyRoot).graphDir, `${id}.json`), 'utf8')).comments || []).length);
  const [pa, pb] = [pinned[0], pinned[1]];
  assert.ok(pa && pb, 'two pinned, unfaulted nodes');
  const Wd = await withServer(t, { root: wholeRoot });
  assert.equal(Wd.srv.graph.lazyStats().headers, 0, 'the index-less boot read every node whole');
  const prevL = await okText(L.anonApi.get(`/preview/node/${pa}`), 'preview, lazy');
  assert.deepEqual(L.srv.graph.lazyStats().faulted_ids, [qNode, meta.active, pa], 'the preview faulted its one node');
  const prevW = await okText(Wd.anonApi.get(`/preview/node/${pa}`), 'preview, whole');
  assert.equal(prevL, prevW, 'the preview of a lazy node is the whole node\'s');
  const stamp = (h) => h.replace(/<span>exported [^<]*<\/span>/, '<span>exported -</span>');
  const expL = (await okText(L.anonApi.get(`/api/export/${pb}`), 'export, lazy'));
  assert.deepEqual(L.srv.graph.lazyStats().faulted_ids, [qNode, meta.active, pa, pb], 'the export faulted its one node');
  const expW = (await okText(Wd.anonApi.get(`/api/export/${pb}`), 'export, whole'));
  assert.equal(stamp(expL), stamp(expW), 'the export of a lazy node is the whole node\'s');
  assert.ok(itemIdsOf(expL).size >= 1, 'and it draws its elements');
});

// ═══ (11) the registry after the listen ════════════════════════════════════

const S1 = '11111111-1111-4111-8111-1111111590aa';
test('(11) the registry loads after the listen: at the body\'s first line a chat pin reads indexing, every read after reads indexing or exact, never unavailable, then placed; PARSED_CONVERSATIONS_MAX reads 389', { timeout: 120000 }, async (t) => {
  assert.equal(valueOf('parsed-conversations-max'), 389, 'PARSED_CONVERSATIONS_MAX (U575)');
  const repo = treesnapRepo(t, { files: { 'README.md': 'u590\n' } });
  const ch = claudeHome(t, { root: repo.root, isolate: true });
  let L = null;
  t.after(async () => { if (L) await L.stop(); });
  const life = async () => {
    const d = await withServer(t, { root: repo.root, writePortfile: true });
    const call = { port: d.port, noSpawn: true, timeout: 15000 };
    let clock = Date.now();
    const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
    const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra },
      env, { now: (clock = Math.max(clock + 1, Date.now())) });
    return { ...d, call, envelope };
  };
  L = await life();
  ch.writeTranscript(S1, []);
  assert.equal((await client.post('/api/hooks/event', L.envelope('SessionStart', { source: 'startup', model: 'claude-test' }), L.call)).ok, true);
  const r = createRecords({ seed: 5901, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const snaps = async () => { const m = await client.get('/api/mirror', L.call); return (m.diagnostics && m.diagnostics.git && m.diagnostics.git.snapshots) || 0; };
  const seen = await snaps();
  const begin = L.envelope('UserPromptSubmit', { prompt: 'say something', prompt_id: 'u590-1' });
  assert.equal((await client.post('/api/turn-begin', { message: 'say something', author: 'user', ...sessionFields(begin), prompt: begin.prompt }, L.call)).ok, true);
  await waitUntil(async () => (await snaps()) > seen, { timeout: 15000, what: 'the before-snapshot' });
  r.prompt('say something', { promptId: 'u590-1' });
  r.assistant(['A reply worth pinning, at the integration head.']);
  r.turnDuration({ durationMs: 200, messageCount: 4 });
  ch.writeTranscript(S1, r.records);
  const stop = L.envelope('Stop', { last_assistant_message: 'A reply worth pinning, at the integration head.' });
  await client.post('/api/turn-end', { author: 'claude', reply: 'A reply worth pinning, at the integration head.', ended: 'stop', ...sessionFields(stop), last_assistant_message: stop.stop.last_assistant_message }, L.call);
  const reply = await waitUntil(async () => {
    const tv = await L.srv.mirror.turn('u590-1');
    return tv && (tv.items || []).find((it) => it.kind === 'reply' && it.source === 'transcript');
  }, { timeout: 15000, what: 'the transcript\'s reply' });
  const pin = (await ok(L.anonApi.post('/api/elements', { type: 'chat-comment', anchor: { kind: 'item', item_id: reply.id }, payload: { text: 'on the reply', shared: true } }), 'the chat pin')).element;
  assert.equal(pin.state, 'exact');
  await L.stop();

  L = await life();
  // The body's first line: the listen has answered, the after-listen
  // immediate (mirror.start) has not run. The registry is not loaded, so the
  // facade's own resolver answers indexing for the pin, never unavailable.
  const early = L.srv.mirror.resolveAnchors([{ id: pin.id, v: pin.v, anchor: pin.anchor }]);
  const pending = await Promise.race([L.srv.mirror.ready.then(() => 'settled'), Promise.resolve().then(() => 'pending')]);
  assert.equal(pending, 'pending', 'the registry loads after the listen (U571)');
  const [first] = await early;
  assert.equal(first.state, 'indexing', `before the registry, the pin reads indexing: ${JSON.stringify(first)}`);
  const states = [];
  const placed = await waitUntil(async () => {
    const e = (await ok(L.anonApi.get('/api/elements?type=chat-comment'), 'GET')).elements.find((x) => x.id === pin.id);
    assert.ok(e, 'listed');
    states.push(e.state);
    assert.notEqual(e.state, 'unavailable', `read ${states.length}: never unavailable (${states.join(', ')})`);
    if (e.state === 'indexing') assert.equal(e.explain, EXPLAIN.indexing);
    return e.state === 'exact' ? e : null;
  }, { timeout: 15000, interval: 1, what: 'the pin places' });
  assert.equal(placed.visible, VISIBLE.exact);
  t.diagnostic(`ready at the body's first line: ${pending}; states read: ${[...new Set(states)].join(' → ')} over ${states.length} reads`);
});

// ═══ (12) the park ═════════════════════════════════════════════════════════

test('(12) the park: the Push note served masked, a parked group\'s ×N, each wake\'s own note, a node read with no private id@v', { timeout: 60000 }, async (t) => {
  const d = await withServer(t, { seed: ({ root }) => fs.writeFileSync(projectPaths(root).captureToken, `${SECRET}\n`) });
  const host = { port: d.port, noSpawn: true, timeout: 10000 };
  await ok(d.api.post('/api/render', { id: 'pk', html: '<p class="lead">Hello parked group</p>' }), 'render');
  const pinOn = (text, shared = true) => ok(d.api.post('/api/elements', commentBody({ text, shared, anchor: { mount: 'pk', selector: 'p.lead', text: 'Hello', ordinal: 0 } })), text);
  const five = [];
  for (let i = 0; i < 5; i++) five.push((await pinOn(`wcu590 pin ${i}`)).pin.id);
  const priv = (await pinOn('wcu590-private-pin', false)).pin.id;
  const pushed = await ok(d.api.post('/api/queue/push', { note: `wcu590 the note ${SECRET}` }), 'push');
  assert.equal(pushed.mode, 'parked', 'no channel: parked');
  const pend = (await client.request(d.port, 'GET', '/api/queue/pending', null, { timeout: 10000 })).body.pending;
  assert.ok(pend.note.startsWith('wcu590 the note '), pend.note);
  assert.ok(!pend.note.includes(SECRET) && !has(pend, SECRET), 'the note served masked (U581)');
  const row = pend.items.find((it) => it.kind === 'element');
  assert.equal(row.count, 5, 'the parked group reads ×5 (U582)');
  assert.deepEqual(row.element_ids, five);
  assert.equal(row.respond, true);
  assert.ok(!has(pend, priv) && !has(pend, 'wcu590-private-pin'), 'the private pin nowhere');
  await ok(d.api.post('/api/queue/pending/consume', { id: pend.id }), 'consume');

  // Each wake carries its own push's note (U583).
  const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
  t.after(() => channel.close());
  const one = async (n, note) => {
    await ok(d.api.post('/api/render', { id: `wk${n}`, html: `<p class="lead">Wake ${n}</p>` }), 'render');
    await ok(d.api.post('/api/elements', commentBody({ text: `wake ${n}`, shared: true, anchor: { mount: `wk${n}`, selector: 'p.lead', text: 'Wake', ordinal: 0 } })), `pin ${n}`);
    const item = (await ok(d.api.get('/api/queue'), 'queue')).items[0].id;
    const p = await ok(d.api.post('/api/queue/push', { note }), `push ${n}`);
    assert.equal(p.mode, 'wake', JSON.stringify(p));
    await waitUntil(() => channel.events.filter((e) => e.kind === 'wake').length >= n, { timeout: 5000, what: `wake ${n}` });
    return item;
  };
  const i1 = await one(1, 'wcu590-n1');
  assert.equal((await client.post('/api/channel/heartbeat', {}, host)).ok, true);
  const i2 = await one(2, 'wcu590-n2');
  const live = channel.events.filter((e) => e.kind === 'wake');
  assert.deepStrictEqual(live.map((e) => [e.batch.map((it) => it.id), e.note]), [[[i1], 'wcu590-n1'], [[i2], 'wcu590-n2']], 'each wake its own batch and note');

  // A node read carries no private id@v (U584).
  const hp = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { v: 1, kind: 'range', mount: 'pk', quote: { exact: 'parked', prefix: 'Hello ', suffix: ' group' } }, payload: { color: 'gold', note: 'mine', shared: false } }), 'private highlight')).element;
  const hs = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { v: 1, kind: 'range', mount: 'pk', quote: { exact: 'group', prefix: 'parked ', suffix: '' } }, payload: { color: 'gold', note: 'ours', shared: true } }), 'shared highlight')).element;
  const node = await commit(d.api, 'the node read');
  const read = (await client.request(d.port, 'GET', `/api/graph/node/${node}`, null, { timeout: 10000 })).body;
  const els = (read.node || read).elements || [];
  assert.ok(els.includes(`${hs.id}@1`), 'the shared one is listed');
  assert.ok(!els.some((r) => r.startsWith(`${hp.id}@`)) && !has(read, `"${hp.id}@`), 'no private id@v for lib/client');
});

// ═══ (13) the MCP catalogue ════════════════════════════════════════════════

test('(13) the MCP catalogue at the head: CATALOGUE_VERSION 1.0.0 and 9626f1c6…3855, the hash of the 24 tools\' names, descriptions and inputSchemas (no edit in tranche 4)', () => {
  const repo = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(repo, 'lib', 'mcp', 'index.js'), 'utf8');
  const block = src.match(/\nconst tools = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'the tools array');
  const names = [...block[1].matchAll(/require\('\.\/tools\/([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]);
  const cat = names.map((n) => {
    const tool = require(path.join(repo, 'lib', 'mcp', 'tools', `${n}.js`));
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  });
  assert.equal(CATALOGUE_VERSION, '1.0.0');
  assert.ok(CATALOGUE_SHA256.startsWith('9626f1c6') && CATALOGUE_SHA256.endsWith('3855'), CATALOGUE_SHA256);
  assert.equal(sha256(stableStringify(cat)), CATALOGUE_SHA256, 'no tool description or inputSchema moved (U563-U580@catalogue-tool-edits a)');
});
