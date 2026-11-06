'use strict';
// Tranche 5, stream 5A, end to end at the integration head (U627; PLAN.md §5
// as amended, PLAN-T5.md §2.3, DECISIONS.md N.1 and O; RULED REQ@ink-scope-v2
// (b+): any pane is a stroke's frame, the page is a frame too — its margins
// and an arrow from one pane to the next — and what Claude receives for such
// a stroke is a pair of screenshots, with and without the ink). The real
// createServer through withServer; the fixture strokes pack (test-support/
// element-packs/strokes-fixture, its page kind U625's) staged, reviewed and
// approved through test-support/element-type-fixture's stageElementPack and
// approveFromFrame; the stroke bodies test-support/element-packs
// strokeBodies' (target-frame.js's commit shape); nothing hand-installed. No
// synthetic Claude Code tier is needed here (no turn of a transcript is read).
// The chrome half is the twin, test/elements-e2e-t5a-chrome.test.js.
//
// One world (remote viewers opted in at `read`, a network peer stubbed)
// carries the steps in order, each needing the last one's state:
//   (1) the four frames' records, as the chrome's commit builds them: a pen
//       stroke over a paragraph → the element record of the pane's OUTERMOST
//       block (FRAME@pane-element (c), U611); a margin stroke → a page record
//       'beside' its nearest item; an arrow from pane A to pane B → a page
//       record from A to B (U612, U613); a stroke on an svg → the svg's own
//       record (the fixed-aspect frame wins) — each kept as given, private;
//       the pen-down on a button that posts nothing is the chrome's (the
//       twin's step (1));
//   (2) private by default (AD5, PRIVATE@create) and absent, for every reader
//       below seesPrivate, from the envelope, the search, every file document
//       (the export file, the replay file), both PNG routes and GET
//       /api/captures?node= (J2, U620);
//   (3) shared: the arrow's queue item names both items (describe.items,
//       frame 'page') and its summary says 'from A to B' (U622); folded with
//       a pane stroke, delivered, a member un-shared and the item re-sent, the
//       un-shared member is never raised again (U633);
//   (5) Mod+Z's route undoes the arrow from either item (UNDO@either-end,
//       U623); a Wipe drops it only when neither item is left (WIPE@either-
//       end); a render over pane B, and over pane A, answers the arrow
//       (IMPACT@both-items);
//   (6) the preview, the export and a replay step draw the pane and the page
//       strokes (U621);
//   (7) the picture pair through a fake Chrome (box-grab's captureImpl seam):
//       one call, the hide style as `second`, both files, a source document
//       with 0 private strokes (U617, U618); inspect_capture's [text, image,
//       image] and its which-is-which line (U619); a Send renders at the
//       viewer's viewport (PICTURE@viewer-viewport); un-shared, both PNGs are
//       refused below seesPrivate;
//   (10) the soak driver's per-minute stroke writer (U641) against this
//       daemon: one element-, one pane- and one page-anchored stroke, all
//       accepted;
//   (11) THE AG-1 SHAPE CHECK against alpha.4 (627c5f53, ae-alpha.4): its own
//       tree (git archive of that commit, unpacked by lib/update/archive)
//       boots this world's .web-chat, its daemon stopped (a rollback) — node
//       ids, comment counts and the log's prefix unchanged, and this build
//       boots it again after (the roll forward); the page stroke kept in its log, never
//       drawn by its overlay (placeOf), dropped from its documents; the second
//       PNG and image_without ignored; a 0.2.0-style manifest (composite,
//       page) as its validateElement reads it — each named as alpha.4's
//       residual. Where the clone has no 627c5f53 (a shallow checkout) the
//       alpha.4 half is skipped with that reason and this build's half runs.
// Step (4) (the follow, the phone, the controls), (5)'s Mod+Z key, (8) (the
// wet layer, the input rule) and (9) (the blend) are the chrome twin's.
//
// Who is who: `anonApi` is a local browser (fetch metadata; the writer
// 'user', seesPrivate); `api` is Claude (the boot's writer token); lib/client
// sends no fetch metadata (Claude's tools, the CLI: below seesPrivate); a
// remote viewer is lib/client with the portal's X-WC-Remote at the project's
// `read` opt-in; a network peer is a request whose socket address is stubbed
// to 10.0.0.5 (always basic, Q9).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

// The pack pipeline never probes the gh program for the loopback forge.
process.env.WEB_CHAT_NO_GH = '1';
// A picture is drawn by headless Chrome; this file never launches one (the
// box grab's seams stand in for it).
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { stageElementPack, approveFromFrame } = require('../test-support/element-type-fixture');
const { strokeBodies, STROKES_FIXTURE_DIR, STROKES_FIXTURE_NAME, STROKES_FIXTURE_TYPE } = require('../test-support/element-packs');
const { encodePng, solid } = require('../test-support/png-encode');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths, PUBLIC_DIR } = require('../lib/core/paths');
const { extractTarGz } = require('../lib/update/archive');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const { SHAPES } = require('../lib/core/ink-shape');
const { readElementJson, validateElement, elementSrcDir } = require('../lib/packs/elements');
const { setSeams, hideStyle, PICTURE } = require('../lib/server/box-grab');
const inspectCapture = require('../lib/mcp/tools/inspect_capture');
const fixture = require('../scripts/soak/fixture');
const drive = require('../scripts/soak/drive');
const client = require('../lib/client');

const REPO = path.join(__dirname, '..');
const TYPE = STROKES_FIXTURE_TYPE;
const PACK = STROKES_FIXTURE_NAME;
const A = 't5a';
const B = 't5b';
const MD = 'md-t5';
const PANE_A = '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg>'
  + '<p class="prose">wcu627 the paragraph a pen circles.</p><button class="go" type="button">Go</button></div>';
const PANE_B = '<div class="wrapb"><p class="prose">Pane B\'s prose, where the arrow lands.</p></div>';
const FRAME = Object.freeze({ w: 1280, h: 2400 });   // the page box at pen-down
const ITEM_BOX = Object.freeze({ w: 600, h: 240 });
const PRIV = 'wcu627priv';                           // every private stroke's text under carries it
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test', style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
});
const ALPHA4 = '627c5f53a053e7d2b5dbd2768b3c2ed31ea9e21d';   // ae-alpha.4 = ae-t4-done
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
const wire = (o) => JSON.parse(JSON.stringify(o));

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

// ── the pane, as the chrome mounts it (mount-runtime attachAndExtract) ──────
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) { try { w.close(); } catch {} } });
function paneRoot(html, mount) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  WINDOWS.push(dom.window);
  dom.window.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
  const host = dom.window.document.createElement('div');
  host.dataset.mountId = mount;
  dom.window.document.body.appendChild(host);
  return dom.window.__wcMount.attachAndExtract(host, html).root;
}
// The outermost element above `el` in its pane root (FRAME@pane-element (c)).
function outermost(root, el) {
  let n = el;
  while (n.parentNode && n.parentNode !== root) n = n.parentNode;
  return n;
}

// The stroke bodies (target-frame.js's commit shape), each with its own text
// under. `tag` marks a body's text so a search and a document can find it.
function bodies({ arrowFrom = A, arrowTo = B, marginItem = B } = {}) {
  const b = strokeBodies({ type: TYPE, mount: A, html: PANE_A, arrowFrom, arrowTo, marginItem, frame: FRAME, itemBox: ITEM_BOX });
  const tag = (body, under, extra = {}) => ({ ...body, payload: { ...body.payload, text_under: under, ...extra } });
  return { raw: b, tag };
}

// ── documents in jsdom ──────────────────────────────────────────────────────
const dataElements = (html) => [...html.matchAll(DATA_EL)].map((m) => JSON.parse(m[1]));
const itemIdsOf = (html) => new Set(dataElements(html).flatMap((p) => (p.items || []).map((it) => it.id)));
// Each item gets its own box (jsdom lays nothing out): pane A left, pane B
// right of it, the markdown item under both; a pane's blocks inside its host.
const DOC_BOXES = Object.freeze({
  [A]: { left: 40, top: 120, width: 600, height: 240 },
  [B]: { left: 660, top: 120, width: 600, height: 240 },
  [MD]: { left: 40, top: 400, width: 1220, height: 40 },
});
function openDoc(html) {
  const net = { calls: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      const refuse = (what) => function () { net.calls++; throw new Error(`no ${what} in a document`); };
      win.fetch = refuse('fetch');
      win.XMLHttpRequest = refuse('XMLHttpRequest');
      win.WebSocket = refuse('WebSocket');
      const box = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top });
      win.Element.prototype.getBoundingClientRect = function () {
        const key = this.classList && this.classList.contains('mount-host') ? ((this.dataset && this.dataset.mountId) || this.id)
          : this.getAttribute && this.getAttribute('data-md-id');
        if (key && DOC_BOXES[key]) return box(DOC_BOXES[key]);
        const root = this.getRootNode && this.getRootNode();
        const host = root && root.host;
        const hk = host && ((host.dataset && host.dataset.mountId) || host.id);
        if (hk && DOC_BOXES[hk]) {
          const h = DOC_BOXES[hk];
          if (this.localName === 'svg') return box({ left: h.left + 10, top: h.top + 10, width: 200, height: 100 });
          return box({ left: h.left + 4, top: h.top + 4, width: h.width - 8, height: h.height - 8 });
        }
        return box({ left: 0, top: 0, width: 1280, height: 2400 });
      };
      win.Range.prototype.getClientRects = function () { return [box({ left: 60, top: 140, width: 120, height: 18 })]; };
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
const replayIds = (html) => new Set(replayPayload(html).steps.flatMap((s) => (s.elements ? dataElements(s.elements.data).flatMap((p) => p.items.map((it) => it.id)) : [])));

// ── the fake Chrome: box-grab's captureImpl seam ────────────────────────────
// Both shots of one call: the first 40×30, the second (without the line)
// 44×32 — a different size only so each record provably reads its own file.
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
const pictures = (srv) => srv.state.captures.filter((c) => c && c.kind === PICTURE);
const captureOf = (srv, id) => srv.state.captures.find((c) => c && c.id === id) || null;

// ── alpha.4's own tree (step 11) ────────────────────────────────────────────
// `git archive` of 627c5f53 (lib, public, templates, package.json), unpacked
// by lib/update/archive extractTarGz, node_modules linked to this checkout's.
// null with a reason when this clone cannot give it (no git, a shallow
// checkout, a tarball).
const scratch = [];
test.after(() => { for (const dir of scratch) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
function alpha4Tree() {
  try {
    execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${ALPHA4}^{commit}`], { stdio: 'ignore' });
  } catch {
    return { tree: null, why: `${ALPHA4.slice(0, 8)} (ae-alpha.4) is not in this clone (a shallow checkout or no git): the alpha.4 half of AG-1 runs where the history is` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u627-alpha4-'));
  scratch.push(dir);
  const tgz = path.join(dir, 'alpha4.tar.gz');
  execFileSync('git', ['-C', REPO, 'archive', '--format=tar.gz', '-o', tgz, ALPHA4, 'lib', 'public', 'templates', 'package.json'], { stdio: 'ignore' });
  const tree = path.join(dir, 'tree');
  extractTarGz(tgz, tree);
  fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(tree, 'node_modules'), 'dir');
  return { tree, why: null };
}

// ═══ the world ═════════════════════════════════════════════════════════════

test('5A end to end: pane, margin and arrow strokes through the fixture strokes pack — private by default, shared and described, undone from either end, documented, pictured with and without the ink, the soak\'s writer; then the AG-1 shape check against alpha.4', { timeout: 240000 }, async (t) => {
  const root = tmpRoot('wc-u627-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } });
  const d = await withServer(t, { root, seed });
  t.after(stubPeers(d.server));
  const call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 15000 });
  const capture = pairCapture();
  setSeams(d.srv.state, { findChrome: () => '/fake/chrome', captureImpl: capture });
  const W = {};   // what the steps hand on

  await ok(d.api.post('/api/render', { id: A, html: PANE_A }), 'render pane A');
  await ok(d.api.post('/api/render', { id: B, html: PANE_B }), 'render pane B');
  await ok(d.api.post('/api/markdown', { id: MD, text: '## Ink across the page\n\nA line of framing under the two panes.' }), 'the markdown item');
  // A shared comment, so the AG-1 check has a comment count to keep.
  W.comment = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wcu627 the shared comment', shared: true,
    anchor: { mount: B, selector: 'p.prose', text: 'Pane B', ordinal: 0 } })), 'a shared comment')).pin;

  await t.test('(0) the fixture strokes pack staged, reviewed naming both kinds, approved from the confirm frame: listed with anchors element and page', async () => {
    const staged = await stageElementPack(t, d, { dir: STROKES_FIXTURE_DIR, owner: 'acme', repo: 'strokes-u627' });
    assert.equal(staged.res.json.ok, true, staged.res.text);
    assert.ok(!(await ok(d.api.get('/api/elements/types'), 'types')).types.some((r) => r.type === TYPE), 'quarantined: listed nowhere');
    const out = await approveFromFrame(d.srv, { name: PACK, tier: 'local' });
    assert.equal(out.doc.status, 200);
    assert.ok(out.desc.lines.some((l) => l.startsWith(`Element type ${TYPE} — schema ${TYPE}@1 · anchors element, page`)), JSON.stringify(out.desc.lines));
    assert.deepEqual(out.res.body, { ok: true, said: `Installed ${PACK}: ${TYPE}` });
    const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
    assert.ok(row, 'listed once approved');
    assert.deepEqual([row.private, row.toolbar.input, row.toolbar.place, row.anchors], [true, 'strokes', 'box', ['element', 'page']]);
  });

  await t.test('(1) the four frames\' records: a paragraph → the pane\'s outermost block (the pane frame); a margin stroke → \'beside\' its item; an arrow → from A to B; an svg → its own record; each kept as given, private', async () => {
    const rootA = paneRoot(PANE_A, A);
    const para = rootA.querySelector('p.prose');
    const outer = outermost(rootA, para);
    assert.equal(outer.localName, 'div', 'the paragraph\'s outermost block is div.wrap');
    const { raw, tag } = bodies();
    // The pane frame: the outermost block's element record (FRAME@pane-element (c)).
    assert.deepStrictEqual(raw.pane.anchor, wire(anchors.record(rootA, outer, { mount: A })), 'the outermost block\'s record');
    assert.equal(strokes.frameKindOf(raw.pane.anchor), 'pane');
    // The fixed-aspect frame wins on the svg.
    assert.deepStrictEqual(raw.element.anchor, wire(anchors.record(rootA, rootA.querySelector('svg.art'), { mount: A })));
    assert.equal(raw.element.anchor.fp.tag, 'svg');
    assert.equal(strokes.frameKindOf(raw.element.anchor), 'target');
    // The page frame: a margin stroke beside B, an arrow from A to B.
    assert.equal(strokes.pageShape(raw.margin.anchor), 'beside');
    assert.equal(strokes.pageLabel(raw.margin.anchor), `beside ${B}`);
    assert.equal(strokes.pageShape(raw.arrow.anchor), 'between');
    assert.equal(strokes.pageLabel(raw.arrow.anchor), `from ${A} to ${B}`);
    for (const k of ['margin', 'arrow']) assert.equal(strokes.frameKindOf(raw[k].anchor), 'page', k);

    const post = async (body, what) => (await ok(d.anonApi.post('/api/elements', body), what)).element;
    W.pane = await post(tag(raw.pane, `${PRIV} the paragraph under the pen`), 'the pane-frame stroke');
    W.margin = await post(tag(raw.margin, `${PRIV} beside pane B`), 'the margin stroke');
    W.arrow = await post(tag(raw.arrow, `${PRIV} from A to B`), 'the arrow');
    W.svg = await post(tag(raw.element, `${PRIV} on the chart`), 'the svg stroke');
    W.priv = [W.pane, W.margin, W.arrow, W.svg];
    for (const [e, body] of [[W.pane, raw.pane], [W.margin, raw.margin], [W.arrow, raw.arrow], [W.svg, raw.element]]) {
      assert.match(e.id, /^p\d+$/, 'a plug-in id');
      assert.equal(e.type, TYPE);
      assert.deepStrictEqual(e.anchor, body.anchor, `${e.id}: the anchor kept as given`);
      assert.equal(e.shared, false, `${e.id}: private by default (PRIVATE@create)`);
      assert.deepStrictEqual(e.writer, { class: 'user', owner: 'user', verified: false });
      assert.ok(strokes.isStrokePayload(e), `${e.id}: a stroke payload`);
    }
    assert.deepEqual(d.srv.state.elements.filter((r) => W.priv.some((e) => r === `${e.id}@1`)).length, 4, 'every reference on the surface');
  });

  await t.test('(2) private: no queue item, nothing in the envelope, 0 hits below seesPrivate, absent from the export file, the replay file, both PNG routes and GET /api/captures?node= for a reader without seesPrivate', async () => {
    const ids = W.priv.map((e) => e.id);
    assert.deepEqual(d.srv.state.queue.filter((it) => it.kind === 'element' && it.type === TYPE), [], 'no queue item (J2: never clogs the queue)');
    const pushed = await ok(d.api.post('/api/queue/push', { note: 'wcu627 a push' }), 'push (the comment rides)');
    const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(pending, 'parked (no channel)');
    for (const id of ids) assert.ok(!has(pushed, id) && !has(pending, id), `${id} is in no envelope`);
    assert.ok(!has(pending, PRIV), 'nor its text');
    await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');

    const q = `/api/elements/search?q=${encodeURIComponent(PRIV)}`;
    const peer = await call('GET', q, null, PEER);
    assert.equal(peer.status, 403, 'basic: refused before anything is read');
    assert.ok(!has(peer.body, PRIV));
    assert.deepEqual((await call('GET', q, null, REMOTE)).body, { hits: [], truncated: false }, 'the remote read viewer: 0 hits');
    assert.deepEqual((await call('GET', q)).body, { hits: [], truncated: false }, 'lib/client (Claude\'s tools): 0 hits');
    assert.deepEqual((await ok(d.anonApi.get(q), 'the host\'s browser')).hits.map((h) => h.id).sort(), [...ids].sort(), 'the host\'s own browser: all four');

    const node = await commit(d.api, 'the private strokes');
    W.node1 = node;
    // The file documents, as Claude's tools and the CLI write them.
    const file = await call('GET', `/api/export/${node}?format=file`);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    const replay = await call('POST', '/api/replay/render', { format: 'replay', from: node, to: node });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    const docs = {
      'the export file': fs.readFileSync(file.body.path, 'utf8'),
      'the replay file': fs.readFileSync(replay.body.path, 'utf8'),
      'the preview, lib/client': (await call('GET', `/preview/node/${node}`)).body,
      'the export, remote read': (await call('GET', `/api/export/${node}`, null, REMOTE)).body,
    };
    for (const [what, html] of Object.entries(docs)) {
      assert.equal(typeof html, 'string', what);
      const got = what === 'the replay file' ? replayIds(html) : itemIdsOf(html);
      for (const id of ids) assert.ok(!got.has(id) && !has(html, `"${id}"`), `${what}: no ${id}`);
      assert.ok(!has(html, PRIV), `${what}: no text of them`);
    }
    // Both PNG routes refuse a private member for every reader below seesPrivate.
    for (const id of ids) {
      for (const which of ['with', 'without']) {
        for (const [who, headers] of [['lib/client', undefined], ['remote read', REMOTE], ['a network peer', PEER]]) {
          const r = await call('GET', `/api/elements/${id}/picture?which=${which}`, null, headers);
          assert.notEqual(r.status, 200, `${who}: ${id} ?which=${which} refused`);
          assert.ok(!Buffer.isBuffer(r.body) || r.body.length === 0, `${who}: no PNG bytes`);
        }
      }
    }
    assert.equal(pictures(d.srv).length, 0, 'and no picture was made of them');
    // GET /api/captures?node= below seesPrivate names none of them.
    for (const [who, headers] of [['lib/client', undefined], ['remote read', REMOTE]]) {
      const r = await call('GET', `/api/captures?node=${node}`, null, headers);
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
      for (const id of ids) assert.ok(!has(r.body, id), `${who}: no ${id} in the node's captures`);
    }
  });

  await t.test('(3) shared: the arrow\'s item names both items (describe.items, frame \'page\') and says \'from A to B\'; folded with a pane stroke, delivered, a member un-shared and re-sent → never raised again', async () => {
    const { raw, tag } = bodies();
    const post = async (body, what) => (await ok(d.anonApi.post('/api/elements', body), what)).element;
    const a1 = await post(tag(raw.arrow, 'wcu627 the first shared arrow'), 'arrow 1');
    const a2 = await post(tag(raw.arrow, 'wcu627unshared the second arrow', {
      points: raw.arrow.payload.points.map((v, i) => (i % 4 === 0 ? Math.min(1, v + 0.01) : v)),
    }), 'arrow 2');
    for (const e of [a1, a2]) {
      assert.equal((await ok(d.anonApi.patch(`/api/elements/${e.id}`, { shared: true }), `share ${e.id}`)).element.shared, true);
    }
    const sent = await ok(d.anonApi.post(`/api/elements/${a2.id}/send`, {}), 'send the arrow group');
    const items = () => d.srv.state.queue.filter((it) => it.kind === 'element' && it.type === TYPE);
    assert.equal(items().length, 1, JSON.stringify(items()));
    const [it] = items();
    assert.equal(sent.item.id, it.id);
    assert.deepStrictEqual(it.element_ids, [a1.id, a2.id], 'one group: two strokes between the same items');
    assert.equal(it.describe.frame, 'page');
    assert.deepStrictEqual(it.describe.items, [A, B], 'both items, from-item first');
    assert.ok(SHAPES.includes(it.describe.shape));
    assert.match(it.summary, new RegExp(`· from ${A} to ${B} · `), it.summary);
    assert.ok(!has(it.describe, 'wcu627'), 'no page text in the describe');
    assert.ok(!has(it, PRIV), 'no private stroke\'s text in the item');
    for (const e of W.priv) assert.ok(!has(it, e.id), `the private ${e.id} is not in the shared item`);

    // A pane stroke on A, shared and sent: folded into the same item.
    const ps = await post(tag(raw.pane, 'wcu627 the shared pane stroke'), 'a pane stroke');
    await ok(d.anonApi.patch(`/api/elements/${ps.id}`, { shared: true }), 'share it');
    await ok(d.anonApi.post(`/api/elements/${ps.id}/send`, {}), 'send it');
    assert.equal(items().length, 1, 'folded into the one item');
    const [folded] = items();
    assert.deepStrictEqual(folded.describe.groups.map((g) => [g.element_ids, g.frame, g.items]),
      [[[a1.id, a2.id], 'page', [A, B]], [[ps.id], 'pane', undefined]], 'per group: the arrow\'s frame and items, the pane stroke\'s frame');

    // Delivered (parked), arrow 2 un-shared, the item re-sent.
    await ok(d.api.post('/api/queue/push', {}), 'push the item');
    const pend = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(pend.envelope.content.includes(a2.id), 'arrow 2 delivered while shared');
    await ok(d.api.post('/api/queue/pending/consume', { id: pend.id }), 'consume');
    await ok(d.anonApi.patch(`/api/elements/${a2.id}`, { shared: false }), 'un-share arrow 2');
    const r = await call('POST', `/api/queue/items/${folded.id}/resend`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = r.body.item;
    assert.deepStrictEqual(again.element_ids, [a1.id, ps.id], 'the un-shared member is never raised again (U633)');
    assert.ok(!has(again, a2.id) && !has(again, 'wcu627unshared'), 'neither its id nor its words');
    for (const g of (again.describe && again.describe.groups) || []) assert.ok(!(g.element_ids || []).includes(a2.id), 'no group entry names it');
    await ok(d.api.del(`/api/queue/${again.id}`), 'take the re-sent item out');
    Object.assign(W, { a1, a2, ps });
  });

  await t.test('(5) Mod+Z\'s route undoes the arrow from either item; render over pane B, and over pane A, answers the arrow (IMPACT@both-items); a Wipe drops an arrow only when neither item is left', async () => {
    const { raw, tag } = bodies();
    const count = async (id, html) => (await ok(d.api.post('/api/render', { id, html }), `render ${id}`)).annotations;
    const before = { a: await count(A, PANE_A), b: await count(B, PANE_B) };
    const arrow = (await ok(d.anonApi.post('/api/elements', tag(raw.arrow, 'wcu627 an arrow to undo from B')), 'an arrow')).element;
    const after = { a: await count(A, PANE_A), b: await count(B, PANE_B) };
    assert.equal(after.b.total, before.b.total + 1, 'render over B answers the new arrow');
    assert.equal(after.a.total, before.a.total + 1, 'and render over A answers it too');
    assert.equal(after.b.by_type[TYPE], (before.b.by_type[TYPE] || 0) + 1);
    // UNDO@either-end: the arrow's newest version is undone from its to item…
    const fromB = await ok(d.anonApi.post('/api/elements/undo', { item: B }), 'undo from B');
    assert.deepEqual([fromB.undone.id, fromB.undone.type, fromB.undone.item, fromB.undone.how], [arrow.id, TYPE, B, 'removed']);
    assert.ok(!d.srv.state.elements.includes(`${arrow.id}@1`), 'its reference dropped');
    // …and another from its from item.
    const arrow2 = (await ok(d.anonApi.post('/api/elements', tag(raw.arrow, 'wcu627 an arrow to undo from A')), 'another arrow')).element;
    const fromA = await ok(d.anonApi.post('/api/elements/undo', { item: A }), 'undo from A');
    assert.deepEqual([fromA.undone.id, fromA.undone.item], [arrow2.id, A]);
    assert.ok(!d.srv.state.elements.includes(`${arrow2.id}@1`));

    // WIPE@either-end, on a second surface (this world keeps its panes).
    const e = await withServer(t, { root: tmpRoot('wc-u627-wipe-') });
    const staged = await stageElementPack(t, e, { dir: STROKES_FIXTURE_DIR, owner: 'acme', repo: 'strokes-u627-wipe' });
    assert.equal(staged.res.json.ok, true, staged.res.text);
    assert.equal((await approveFromFrame(e.srv, { name: PACK, tier: 'local' })).res.status, 200);
    await ok(e.api.post('/api/render', { id: A, html: PANE_A }), 'A');
    await ok(e.api.post('/api/render', { id: B, html: PANE_B }), 'B');
    const sock = e.ws();
    await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
    try {
      sock.send(JSON.stringify({ type: 'pane:state', id: A, pane_state: { pinned: true } }));
      await waitUntil(async () => {
        const m = (await e.api.get('/api/mounts')).json.mounts.find((x) => x.id === A);
        return !!(m && m.pane_state && m.pane_state.pinned);
      }, { timeout: 5000, what: 'pane A pinned' });
    } finally { sock.close(); }
    const w = bodies();
    const kept = (await ok(e.anonApi.post('/api/elements', w.tag(w.raw.arrow, 'wcu627 kept while A stays')), 'an arrow')).element;
    const beside = (await ok(e.anonApi.post('/api/elements', w.tag(w.raw.margin, 'wcu627 beside B')), 'a margin stroke beside B')).element;
    await ok(e.api.post('/api/graph/wipe', {}), 'wipe B (A is pinned)');
    const live = () => (e.srv.state.elements || []).map((r) => String(r).split('@')[0]);
    assert.ok(live().includes(kept.id), 'the arrow stays while A does');
    assert.ok(!live().includes(beside.id), 'the margin stroke beside B goes with B');
    const sock2 = e.ws();
    await new Promise((resolve, reject) => { sock2.on('open', resolve); sock2.on('error', reject); });
    try {
      sock2.send(JSON.stringify({ type: 'pane:state', id: A, pane_state: { pinned: false } }));
      await waitUntil(async () => {
        const m = (await e.api.get('/api/mounts')).json.mounts.find((x) => x.id === A);
        return !!(m && !(m.pane_state && m.pane_state.pinned));
      }, { timeout: 5000, what: 'pane A unpinned' });
    } finally { sock2.close(); }
    await ok(e.api.post('/api/graph/wipe', {}), 'wipe A too');
    assert.ok(!live().includes(kept.id), 'neither item left: the arrow dropped');
  });

  await t.test('(6) the preview, the export and a replay step draw the pane and the page strokes (U621)', async () => {
    // The margin stroke beside B, shared, beside the shared arrow and pane stroke of (3).
    await ok(d.anonApi.patch(`/api/elements/${W.margin.id}`, { shared: true }), 'share the margin stroke');
    const node = await commit(d.api, 'the shared strokes');
    W.node2 = node;
    const want = [W.a1.id, W.ps.id, W.margin.id];
    const docs = {
      'the preview': await okText(d.anonApi.get(`/preview/node/${node}`), 'preview'),
      'the export': await okText(d.anonApi.get(`/api/export/${node}`), 'export'),
    };
    const rp = replayPayload((await call('GET', `/replay?from=${W.node1}&to=${node}`)).body);
    docs['a replay step'] = replayFrame(rp, rp.steps.length - 1);
    for (const [what, html] of Object.entries(docs)) {
      const ids = itemIdsOf(html);
      for (const id of want) assert.ok(ids.has(id), `${what} carries ${id}`);
      // The local browser's preview in place draws its own private strokes
      // (AI9 a); a document that leaves the host (the export, a replay) never.
      if (what !== 'the preview') assert.ok(!ids.has(W.a2.id), `${what}: never the un-shared arrow`);
      const { win, net } = openDoc(html);
      await settled(win, `${what} draws`);
      assert.equal(net.calls, 0, `${what}: no network`);
      for (const id of want) {
        const m = await waitUntil(() => markerOf(win, id), { timeout: 8000, what: `${what}: ${id}'s marker` });
        assert.notEqual(m.style.display, 'none', `${what}: ${id} displayed`);
      }
      const page = markerOf(win, W.a1.id);
      assert.equal(page.getAttribute('data-place'), 'box', `${what}: the arrow's group is a box marker`);
      assert.notEqual(markerOf(win, W.ps.id), page, `${what}: the pane stroke is its own group`);
    }
  });

  await t.test('(7) the picture pair through the fake Chrome: one call, the hide style between, both files, a source with 0 private strokes; inspect_capture\'s two images and its which-is-which line; a Send renders at the viewer\'s viewport; un-shared, both PNGs refused', async () => {
    const n0 = capture.calls.length;
    await ok(d.anonApi.post(`/api/elements/${W.a1.id}/send`, { viewport: { w: 900, h: 700, mobile: false } }), 'Send the arrow group');
    await waitUntil(() => capture.calls.length === n0 + 1 && pictures(d.srv).length >= 1, { timeout: 10000, what: 'the picture' });
    const cap = pictures(d.srv).at(-1);
    await waitUntil(() => { const c = captureOf(d.srv, cap.id); return c && c.image && c.image.state !== 'pending' && c.image_without && c.image_without.state !== 'pending'; },
      { timeout: 10000, what: 'both images settle' });
    const callN = capture.calls[n0];
    assert.deepEqual([callN.width, callN.height], [900, 700], 'a Send renders at the viewer\'s viewport');
    assert.ok(callN.second && typeof callN.second.style === 'string', 'ONE call carries the second shot');
    assert.equal(callN.second.style, hideStyle([W.a1.id]), 'the hide style over this group\'s shared members only');
    assert.ok(!callN.second.style.includes(W.a2.id), 'never the un-shared member');
    assert.ok(!callN.second.style.includes(W.ps.id) && !callN.second.style.includes(W.margin.id), 'never another group (REQ@picture-without a)');
    assert.ok(!callN.html.includes('visibility: hidden'), 'the hide style is not in the first shot\'s document');
    const srcIds = itemIdsOf(callN.html);
    for (const e of [...W.priv.filter((x) => x.id !== W.margin.id), W.a2]) assert.ok(!srcIds.has(e.id) && !has(callN.html, `"${e.id}"`), `the source carries no private ${e.id}`);
    for (const e of [W.pane, W.arrow, W.svg]) assert.ok(!has(callN.html, e.text_under), `nor ${e.id}'s private text`);
    assert.ok(!has(callN.html, 'wcu627unshared'), 'nor the un-shared arrow\'s');
    assert.ok(srcIds.has(W.ps.id), 'another group stays on the page');
    const dir = path.join(d.root, '.web-chat', 'captures');
    const withPng = fs.readFileSync(path.join(dir, `${cap.id}.png`));
    const withoutPng = fs.readFileSync(path.join(dir, `${cap.id}.without.png`));
    const rec = captureOf(d.srv, cap.id);
    assert.deepEqual([rec.image.state, rec.image.sha256], ['ready', sha256(withPng)]);
    assert.deepEqual([rec.image_without.state, rec.image_without.sha256], ['ready', sha256(withoutPng)]);
    assert.notEqual(rec.image.sha256, rec.image_without.sha256, 'two files, each its own');

    // inspect_capture, the MCP tool's own handler through lib/mcp/client.
    const saved = { port: process.env.WEB_CHAT_PORT, mcp: process.env.WEB_CHAT_MCP_SERVER };
    try {
      process.env.WEB_CHAT_PORT = String(d.port);
      delete process.env.WEB_CHAT_MCP_SERVER;
      const res = await inspectCapture.handler({ capture_id: cap.id });
      assert.deepEqual(res.content.map((c) => c.type), ['text', 'image', 'image'], 'text, with the ink, without it');
      assert.equal(res.content[1].data, withPng.toString('base64'), 'the first image is the picture with the ink');
      assert.equal(res.content[2].data, withoutPng.toString('base64'), 'the second without it');
      assert.equal(res.content[0].text.split(inspectCapture.PAIR_LINE).length - 1, 1, 'the which-is-which line, once');
      assert.ok(!res.content[0].text.includes('wcu627'), 'no stroke text in the text');
    } finally {
      for (const [k, v] of [['WEB_CHAT_PORT', saved.port], ['WEB_CHAT_MCP_SERVER', saved.mcp]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    assert.equal(capture.calls.length, n0 + 1, 'the request reused the pair: no second render (PICTURE@when)');
    const node = await commit(d.api, 'the picture pair');
    W.node3 = node;
    W.cap = cap.id;

    // The margin stroke's own picture (Claude's request), then un-shared:
    // both PNGs refused for every reader below seesPrivate.
    const rail = d.srv.state.queue.map((it) => it.id);
    const m = await call('POST', `/api/elements/${W.margin.id}/picture`, {});
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.image_without.state, 'ready');
    assert.deepEqual(d.srv.state.queue.map((it) => it.id), rail,
      'a request of Claude\'s puts no row on the rail (U564@request-path-grab-event)');
    await ok(d.anonApi.patch(`/api/elements/${W.margin.id}`, { shared: false }), 'un-share the margin stroke');
    for (const which of ['with', 'without']) {
      for (const [who, headers] of [['lib/client', undefined], ['remote read', REMOTE]]) {
        const r = await call('GET', `/api/elements/${W.margin.id}/picture?which=${which}`, null, headers);
        assert.notEqual(r.status, 200, `${who}: ?which=${which} refused once private`);
      }
    }
    const listed = await call('GET', `/api/captures?node=${W.node2}`);
    assert.ok(!has(listed.body, `${W.margin.id}@`), 'the node\'s captures name no private member for lib/client');
  });

  await t.test('(10) the soak driver\'s per-minute stroke writer (U641) against this daemon: one element-, one pane- and one page-anchored stroke, all accepted', async () => {
    for (const id of fixture.PANES) await ok(d.api.post('/api/render', { id, html: fixture.paneHtml(id, 'd0') }), `render ${id}`);
    const soakRoot = tmpRoot('wc-u627-soak-');
    const cfg = { root: soakRoot, out: soakRoot, port: d.port, project: d.root };
    writeJsonAtomic(fixture.fixtureRecord(cfg), { v: 1, pack: PACK });
    const log = [];
    const dr = drive.createDrive(cfg, { log: (l) => log.push(l) });
    assert.equal(typeof dr.strokeStep, 'function', 'the seam');
    const answers = [];
    const post = client.post;
    client.post = async (p, body, o) => {
      try {
        const r = await post(p, body, o);
        if (p === '/api/elements') answers.push({ status: 200, kind: strokes.frameKindOf(body.anchor), id: r.element && r.element.id, shared: body.payload.shared });
        return r;
      } catch (e) {
        if (p === '/api/elements') answers.push({ status: e.status, kind: strokes.frameKindOf(body.anchor) });
        throw e;
      }
    };
    try { await dr.strokeStep(); } finally { client.post = post; }
    assert.deepEqual(log, [], 'nothing refused');
    assert.deepEqual(answers.map((a) => [a.status, a.kind, a.shared]), [[200, 'target', false], [200, 'pane', false], [200, 'page', false]],
      'an element-, a pane- and a page-anchored stroke, each accepted, private (U641@private-only)');
    const c = dr.counts;
    assert.deepEqual([c.stroke_writes, c.stroke_writes_element, c.stroke_writes_pane, c.stroke_writes_page, c.stroke_failures], [3, 1, 1, 1, 0]);
    for (const id of fixture.PANES) await ok(d.api.post('/api/clear', { id }), `clear ${id}`);
  });

  await t.test('(11) AG-1 against alpha.4 (627c5f53): its own tree boots this world\'s .web-chat — node ids, comment counts and the log\'s prefix unchanged; a page stroke kept in its log, never drawn by its overlay, dropped from its documents; image_without and the second PNG ignored; a 0.2.0-style manifest as its validateElement reads it', async (t2) => {
    await d.graceful();
    const logFile = projectPaths(d.root).elementsLog;
    const bytes = fs.readFileSync(logFile, 'utf8');
    const recs = bytes.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pageVers = recs.filter((r) => r.t === 'ver' && r.payload && strokes.isPageRecord(r.payload.anchor));
    assert.ok(pageVers.length >= 4, 'the world wrote page-anchored versions (the residual\'s subject)');
    assert.ok(pageVers.every((r) => r.id[0] === 'p'), 'each on a plug-in row (U613\'s one granted hunk)');
    const gdir = projectPaths(d.root).graphDir;
    const counts = {};
    for (const f of fs.readdirSync(gdir).filter((x) => /^n\d+\.json$/.test(x))) {
      const n = JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8'));
      counts[n.id] = Array.isArray(n.comments) ? n.comments.length : 0;
    }
    assert.ok(Object.keys(counts).length >= 3, JSON.stringify(counts));
    assert.ok(Object.values(counts).some((n) => n > 0), 'a node carries the comment');
    const capRec = (JSON.parse(fs.readFileSync(path.join(gdir, `${W.node3}.json`), 'utf8')).captures || []).find((c) => c.id === W.cap);
    assert.ok(capRec && capRec.image_without && capRec.image_without.state === 'ready', 'the committed picture carries image_without');
    const residuals = [];

    const { tree, why } = alpha4Tree();
    if (!tree) {
      t2.diagnostic(why);
      t2.skip(why);
      return;
    }
    // alpha.4's reader of the manifest: a 0.2.0-style element.json (composite,
    // page) is accepted, composite kept as an unchecked key and warned about.
    const a4Elements = require(path.join(tree, 'lib', 'packs', 'elements.js'));
    const read = readElementJson(elementSrcDir(STROKES_FIXTURE_DIR, TYPE));
    const manifest020 = { ...read.raw, anchors: ['element', 'page'], composite: 'multiply' };
    const here = validateElement(manifest020, { stageDir: STROKES_FIXTURE_DIR, name: TYPE });
    assert.ok(here.ok, `this build takes it: ${JSON.stringify(here.errors)}`);
    const a4 = a4Elements.validateElement(manifest020, { stageDir: STROKES_FIXTURE_DIR, name: TYPE });
    assert.ok(a4.ok, `alpha.4 accepts it: ${JSON.stringify(a4.errors)}`);
    assert.ok(a4.warnings.some((w) => /carries composite, which this build does not check/.test(w)), JSON.stringify(a4.warnings));
    assert.equal(a4.descriptor.composite, 'multiply', 'kept as written');
    assert.deepEqual(a4.descriptor.anchors, ['element', 'page']);
    assert.ok(!a4Elements.TOOLBAR_KEYS.includes('composite'), 'not one of alpha.4\'s toolbar keys');
    const a4Types = fs.readFileSync(path.join(tree, 'public', 'app', 'element-types.js'), 'utf8');
    assert.match(a4Types, /if \(overlayModule\.PLACE_MODES\.includes\(tb\.place\)\) spec\.place = tb\.place;\n  return \{ spec \};/,
      'alpha.4\'s specOf reads input and place only: composite reaches no draw (no group.blend)');
    residuals.push('manifest: a 0.2.0 element.json validates at alpha.4 with a warning naming composite; composite is kept and never acted on (no group.blend: a highlighter draws unblended into group.container)');
    // alpha.4's overlay: placeOf answers null for a 'page' record.
    const a4Overlay = fs.readFileSync(path.join(tree, 'public', 'app', 'overlay.js'), 'utf8');
    const placeOf = /\nfunction placeOf\(row\) \{\n([\s\S]*?)\n\}\n/.exec(a4Overlay);
    assert.ok(placeOf, 'alpha.4\'s placeOf');
    assert.match(placeOf[1], /if \(a\.kind === 'page'\) return null;/, 'a page record is placed nowhere: never drawn');
    assert.doesNotMatch(a4Overlay, /isPageRecord|buildPageArm/, 'alpha.4 has no page arm');
    residuals.push('overlay: a page stroke is kept in the log and never drawn (placeOf null at overlay.js :443)');

    // alpha.4 boots this world's own root (the world's daemon is stopped): the
    // same project on the same machine, its pack ledger entry included — a
    // rollback, as `claude-web-chat update --to 0.9.0-alpha.4` makes one.
    const a4root = d.root;
    const { createServer } = require(path.join(tree, 'lib', 'server'));
    const old = await withServer(t2, { root: a4root, createServer });
    try {
      for (const [id, n] of Object.entries(counts)) {
        const node = old.srv.graph.nodes.get(id);
        assert.ok(node, `${id} still a node at alpha.4`);
        assert.equal((node.comments || []).length, n, `${id}: the same comment count`);
      }
      // The page strokes are kept in alpha.4's log (listed for the host's browser).
      const listed = await ok(old.anonApi.get(`/api/elements?type=${TYPE}`), 'alpha.4 lists the type\'s elements');
      const byId = new Map(listed.elements.map((e) => [e.id, e]));
      for (const e of [W.arrow, W.margin, W.a1]) {
        assert.ok(byId.has(e.id), `alpha.4 keeps ${e.id}`);
        assert.equal(byId.get(e.id).anchor.kind, 'page', `${e.id}: its page anchor kept`);
      }
      // alpha.4's documents drop the page strokes and keep the pane stroke.
      const exp = await okText(old.anonApi.get(`/api/export/${W.node2}`), 'alpha.4\'s export');
      const ids = itemIdsOf(exp);
      assert.ok(ids.has(W.ps.id), 'alpha.4 draws the pane-frame stroke (an element record)');
      assert.ok(!ids.has(W.a1.id) && !ids.has(W.margin.id), 'and drops the page strokes from its documents (document-elements.js :318)');
      residuals.push('documents: a page stroke is dropped from alpha.4\'s preview, export and replay (rawItems at document-elements.js :318)');
      // The picture: alpha.4 reads image only; ?which= is not its parameter.
      const capturesDir = path.join(a4root, '.web-chat', 'captures');
      const withPng = fs.readFileSync(path.join(capturesDir, `${W.cap}.png`));
      assert.ok(fs.existsSync(path.join(capturesDir, `${W.cap}.without.png`)), 'the second PNG lies on disk, untouched');
      const r = await old.anonApi.raw(`/api/elements/${W.a1.id}/picture?which=without`, { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 200, `alpha.4 answers ?which=without: ${r.status}`);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(withPng), 'with the with-ink PNG: ?which= is not alpha.4\'s parameter');
      const asJson = await ok(old.anonApi.get(`/api/elements/${W.a1.id}/picture?as=json`), 'alpha.4\'s picture as json');
      assert.equal(asJson.data_without, undefined, 'alpha.4 sends no second image');
      residuals.push('pictures: alpha.4 serves the with-ink PNG whatever ?which says, never data_without; image_without rides its capture records unread and <capture>.without.png stays on disk');
      // alpha.4's inspect_capture: one image, no which-is-which line.
      const a4Inspect = require(path.join(tree, 'lib', 'mcp', 'tools', 'inspect_capture.js'));
      const saved = { port: process.env.WEB_CHAT_PORT, mcp: process.env.WEB_CHAT_MCP_SERVER };
      try {
        process.env.WEB_CHAT_PORT = String(old.port);
        delete process.env.WEB_CHAT_MCP_SERVER;
        const res = await a4Inspect.handler({ capture_id: W.cap });
        assert.deepEqual(res.content.map((c) => c.type), ['text', 'image'], 'alpha.4 hands one image');
        assert.equal(res.content[1].data, withPng.toString('base64'), 'the picture with the ink');
        assert.ok(!res.content[0].text.includes(inspectCapture.PAIR_LINE));
      } finally {
        for (const [k, v] of [['WEB_CHAT_PORT', saved.port], ['WEB_CHAT_MCP_SERVER', saved.mcp]]) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
      residuals.push('inspect_capture: alpha.4 answers [text, image] (the with-ink picture alone)');
    } finally { await old.stop(); }
    const after = fs.readFileSync(logFile, 'utf8');
    assert.ok(after.startsWith(bytes), 'alpha.4 appends only: the log\'s prefix unchanged');
    for (const f of Object.keys(counts)) {
      const n = JSON.parse(fs.readFileSync(path.join(gdir, `${f}.json`), 'utf8'));
      assert.equal(n.id, f, `${f}: the node id unchanged by alpha.4`);
    }
    // And forward again: this build over the files alpha.4 left — the prefix
    // still unchanged, the page strokes listed and drawn in its documents.
    const again = await withServer(t2, { root: d.root });
    try {
      assert.ok(fs.readFileSync(logFile, 'utf8').startsWith(bytes), 'this build appends only');
      const back = await ok(again.anonApi.get(`/api/elements?type=${TYPE}`), 'this build lists them again');
      assert.ok([W.arrow, W.margin, W.a1].every((e) => back.elements.some((x) => x.id === e.id)), 'the page strokes, kept');
      assert.ok(itemIdsOf(await okText(again.anonApi.get(`/api/export/${W.node2}`), 'the export')).has(W.a1.id), 'drawn in this build\'s export');
    } finally { await again.stop(); }
    t2.diagnostic(`AG-1 residuals at alpha.4 (${ALPHA4.slice(0, 8)}): ${residuals.join(' | ')}`);
  });
});
