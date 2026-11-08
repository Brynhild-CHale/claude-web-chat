'use strict';
// Tranche 5 end to end at the integration head (U690; PLAN.md §5's tranche-5
// note, PLAN-T5.md §2.3, DECISIONS.md N and O): 5A's spine re-read after 5B's
// overlay, queue and redactor changes, 5B's daemon halves and 5C's seams, on
// the real createServer (withServer). U627's test/elements-e2e-t5a.test.js is
// 5A's own end to end and stays as it is; this file does not copy its world.
// It is built through the helpers the tranche exported, each named where a
// step uses it:
//   test-support/element-packs (U641): stageStrokesFixture, strokeBodies,
//     STROKES_FIXTURE_DIR / _NAME / _TYPE;
//   test-support/element-type-fixture (U565): stageElementPack,
//     approveFromFrame;
//   scripts/soak/fixture.js (U641): stageStrokes (stageStrokesFixture + the
//     control row 'pack-approve', the soak's own path), PANES, paneHtml,
//     fixtureRecord; scripts/soak/drive.js (U641): createDrive().strokeStep;
//   lib/server/box-grab (U617/U618): setSeams' captureImpl (the fake Chrome),
//     hideStyle;
//   lib/core/redact (U634): the daemon's redactor through createServer's
//     getter, a known source added on it;
//   public/app/event-anchor.js (U642): createEventAnchors over a jsdom pane.
// No synthetic Claude Code tier is needed (no transcript is read: the chat
// tail's pinned reading is U634's own test, 200 seeds).
//
// The steps, one test each (subtests in order where a step needs the last
// one's state):
//   (1) the fixture strokes pack staged and approved twice — U641's
//       stageStrokesFixture + 'pack-approve', and U565's stageElementPack +
//       approveFromFrame (U511-U565@approveElementPack-twice a) — listed with
//       anchors element and page;
//   (2) 5A's spine: a pane-frame stroke, a margin stroke and an arrow from A to
//       B, private by default and absent below seesPrivate from the wake
//       envelope, the search, every document and both PNG entries of a capture
//       record; shared, the describe and the queue item name both items of the
//       arrow, a Push carries the describe as text and makes no picture, and
//       the picture pair is made on request only, in one capture call;
//   (3) U633/U633b/U633c: two stroke groups folded into one item, an older
//       member's edit refreshing only its own entry, a one-group result with
//       no element_ids, a member un-shared after delivery never re-raised;
//   (4) U634: GET /api/elements and its node branch under ONE known set;
//   (5) U632: the surface page's Report-Only header, no enforced policy, and a
//       pane's fetch and a theme's image still served;
//   (6) U642: the split cold counter;
//   (7) U641: the soak's strokeStep against this daemon;
//   (8) U623 over the integration head: render, use_component and clear answer
//       an arrow on both items, a Wipe keeps it while one item is left, the
//       undo takes it from either item;
//   (9) the constants at the head;
//   (10) THE AG-1 SHAPE CHECK (the in-suite half): world (2)'s files read as
//       alpha.5's reader reads them, against test/fixtures/alpha5-log-shape.json
//       (derived once from ae-alpha.5; the command is in U690's hand-off);
//       alpha.4's half is U627's step (11) in test/elements-e2e-t5a.test.js.
//
// Who is who: `anonApi` is a local browser (writer 'user', seesPrivate); `api`
// is Claude (the boot's writer token); lib/client (`call`) sends no fetch
// metadata (Claude's tools: below seesPrivate); a network peer is a request
// whose socket address is stubbed to 10.0.0.5 (always basic, Q9).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

// The pack pipeline never probes the gh program for the loopback forge.
process.env.WEB_CHAT_NO_GH = '1';
// A picture is drawn by headless Chrome; this file never launches one.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { stageElementPack, approveFromFrame } = require('../test-support/element-type-fixture');
const { stageStrokesFixture, strokeBodies, STROKES_FIXTURE_DIR, STROKES_FIXTURE_NAME, STROKES_FIXTURE_TYPE } = require('../test-support/element-packs');
const { encodePng, solid } = require('../test-support/png-encode');
const { findLeaks } = require('../test-support/fake-secrets');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { projectPaths, PUBLIC_DIR } = require('../lib/core/paths');
const { MASK } = require('../lib/core/redact');
const { SURFACE_CSP_REPORT_ONLY } = require('../lib/core/cors');
const versions = require('../lib/core/versions');
const anchors = require('../lib/core/anchors');
const strokes = require('../lib/core/strokes');
const { setSeams, hideStyle, PICTURE, WITHOUT_SUFFIX } = require('../lib/server/box-grab');
const fixture = require('../scripts/soak/fixture');
const drive = require('../scripts/soak/drive');
const client = require('../lib/client');

const REPO = path.join(__dirname, '..');
const TYPE = STROKES_FIXTURE_TYPE;
const PACK = STROKES_FIXTURE_NAME;
const A = 'e5a';
const B = 'e5b';
const MD = 'md-e5';
const PANE_A = '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path d="M0 0 L10 10"/></g></svg>'
  + '<p class="prose">wcu690 the paragraph a pen circles.</p></div>';
const PANE_B = '<div class="wrapb"><p class="prose">Pane B, where the arrow lands.</p></div>';
const FRAME = Object.freeze({ w: 1280, h: 2400 });
const ITEM_BOX = Object.freeze({ w: 600, h: 240 });
const PRIV = 'wcu690priv';   // every private stroke's text under carries it
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const DATA_EL = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/g;
const SHAPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alpha5-log-shape.json'), 'utf8'));

async function ok(p, what) {
  const r = await p;
  const body = r.json !== undefined ? r.json : r.body;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(body)}`);
  return body;
}
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const callOf = (d) => (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 15000 });

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

// The fixture staged and approved the soak's way (U641): stageStrokesFixture
// into the daemon's quarantine, then the control row 'pack-approve'.
async function approveSoakWay(d) {
  const staged = await stageStrokesFixture(d.root, { srv: d.srv });
  assert.equal(staged.name, PACK);
  await d.srv.controlStarted;
  const a = await d.srv.control.invoke('pack-approve', { name: staged.name, tier: 'local' }, { remote: false });
  assert.ok(a && a.ok, `pack-approve: ${JSON.stringify(a)}`);
  return staged;
}

// The bodies (U641 strokeBodies: target-frame.js's commit shape), each with
// its own text under.
function bodies({ arrowFrom = A, arrowTo = B, marginItem = B } = {}) {
  const raw = strokeBodies({ type: TYPE, mount: A, html: PANE_A, arrowFrom, arrowTo, marginItem, frame: FRAME, itemBox: ITEM_BOX });
  const tag = (body, under, extra = {}) => ({ ...body, payload: { ...body.payload, text_under: under, ...extra } });
  return { raw, tag };
}

// The fake Chrome: box-grab's captureImpl seam (U617's two shots in one call).
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
const dataElements = (html) => [...String(html).matchAll(DATA_EL)].map((m) => JSON.parse(m[1]));
const itemIdsOf = (html) => new Set(dataElements(html).flatMap((p) => (p.items || []).map((it) => it.id)));
function replayIds(html) {
  const m = /<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(String(html));
  assert.ok(m, 'the replay document holds its payload');
  return new Set(JSON.parse(m[1]).steps.flatMap((s) => (s.elements ? dataElements(s.elements.data).flatMap((p) => p.items.map((it) => it.id)) : [])));
}
const elementItems = (srv) => srv.state.queue.filter((it) => it.kind === 'element' && it.type === TYPE);

async function pinPane(d, id, pinned) {
  const sock = d.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  try {
    sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned } }));
    await waitUntil(async () => {
      const m = (await d.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
      return !!m && !!(m.pane_state && m.pane_state.pinned) === pinned;
    }, { timeout: 5000, what: `pane ${id} pinned ${pinned}` });
  } finally { sock.close(); }
}

// ═══ (1) – (3), (10): the strokes world ════════════════════════════════════

test('the strokes world: (1) the pack approved twice, (2) 5A\'s spine at the integration head, (3) a folded group refreshed per entry, (10) the AG-1 shape check', { timeout: 240000 }, async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u690-') });
  t.after(stubPeers(d.server));
  const call = callOf(d);
  const capture = pairCapture();
  setSeams(d.srv.state, { findChrome: () => '/fake/chrome', captureImpl: capture });
  const W = {};

  await ok(d.api.post('/api/render', { id: A, html: PANE_A }), 'render pane A');
  await ok(d.api.post('/api/render', { id: B, html: PANE_B }), 'render pane B');
  await ok(d.api.post('/api/markdown', { id: MD, text: '## Ink across the page\n\nA line of framing under both panes.' }), 'markdown');
  W.comment = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wcu690 the shared comment', shared: true,
    anchor: { mount: B, selector: 'p.prose', text: 'Pane B', ordinal: 0 } })), 'a shared comment')).pin;

  await t.test('(1) staged and approved through U641\'s stageStrokesFixture + the control row \'pack-approve\', and through U565\'s stageElementPack + approveFromFrame: listed with anchors element and page', async () => {
    assert.ok(!(await ok(d.api.get('/api/elements/types'), 'types')).types.some((r) => r.type === TYPE), 'not listed before');
    await approveSoakWay(d);
    const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
    assert.ok(row, 'listed once approved the soak\'s way');
    assert.deepStrictEqual([row.pack, row.builtin, row.private, row.toolbar.input, row.toolbar.place, row.anchors], [PACK, false, true, 'strokes', 'box', ['element', 'page']]);

    const e = await withServer(t, { root: tmpRoot('wc-u690-frame-') });
    const staged = await stageElementPack(t, e, { dir: STROKES_FIXTURE_DIR, owner: 'acme', repo: 'strokes-u690' });
    assert.equal(staged.res.json.ok, true, staged.res.text);
    const out = await approveFromFrame(e.srv, { name: PACK, tier: 'local' });
    assert.equal(out.res.status, 200, JSON.stringify(out.res.body));
    assert.ok(out.desc.lines.some((l) => l.startsWith(`Element type ${TYPE} — schema ${TYPE}@1 · anchors element, page`)), JSON.stringify(out.desc.lines));
    const row2 = (await ok(e.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
    assert.deepStrictEqual(row2 && row2.anchors, ['element', 'page'], 'listed through the confirm frame too');
  });

  await t.test('(2) 5A\'s spine: pane, margin and arrow strokes private by default and absent below seesPrivate; shared, both items named, a Push carries text and no picture, the pair on request in one call', async () => {
    const { raw, tag } = bodies();
    assert.equal(strokes.frameKindOf(raw.pane.anchor), 'pane');
    assert.equal(strokes.pageShape(raw.margin.anchor), 'beside');
    assert.equal(strokes.pageShape(raw.arrow.anchor), 'between');
    const post = async (body, what) => (await ok(d.anonApi.post('/api/elements', body), what)).element;
    W.pane = await post(tag(raw.pane, `${PRIV} the paragraph`), 'the pane-frame stroke');
    W.margin = await post(tag(raw.margin, `${PRIV} beside B`), 'the margin stroke');
    W.arrow = await post(tag(raw.arrow, `${PRIV} from A to B`), 'the arrow');
    W.keep = await post(tag(raw.element, `${PRIV} kept private`), 'a private stroke on the svg, kept private throughout');
    W.priv = [W.pane, W.margin, W.arrow, W.keep];
    for (const e of W.priv) assert.equal(e.shared, false, `${e.id}: private by default (PRIVATE@create)`);
    const ids = W.priv.map((e) => e.id);

    // The wake envelope: no item, nothing in a Push.
    assert.deepStrictEqual(elementItems(d.srv), [], 'no queue item for a private stroke');
    const pushed = await ok(d.api.post('/api/queue/push', { note: 'wcu690 a push' }), 'push');
    const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    for (const id of ids) assert.ok(!has(pushed, id) && !has(pending, id), `${id} is in no envelope`);
    assert.ok(!has(pending, PRIV), 'nor its text');
    if (pending) await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');

    // The search at basic (a network peer) and for lib/client.
    const q = `/api/elements/search?q=${encodeURIComponent(PRIV)}`;
    const peer = await call('GET', q, null, PEER);
    assert.equal(peer.status, 403, 'basic: refused before anything is read');
    assert.ok(!has(peer.body, PRIV));
    assert.deepStrictEqual((await call('GET', q)).body, { hits: [], truncated: false }, 'lib/client: 0 hits');
    assert.deepStrictEqual((await ok(d.anonApi.get(q), 'browser search')).hits.map((h) => h.id).sort(), [...ids].sort(), 'the host\'s browser: all four');

    // Every document a reader without seesPrivate gets.
    W.node1 = await commit(d.api, 'the private strokes');
    const file = await call('GET', `/api/export/${W.node1}?format=file`);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    const replay = await call('POST', '/api/replay/render', { format: 'replay', from: W.node1, to: W.node1 });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    const docs = {
      'the preview (lib/client)': [(await call('GET', `/preview/node/${W.node1}`)).body, itemIdsOf],
      'the export file': [fs.readFileSync(file.body.path, 'utf8'), itemIdsOf],
      'the replay file': [fs.readFileSync(replay.body.path, 'utf8'), replayIds],
    };
    for (const [what, [html, idsIn]] of Object.entries(docs)) {
      assert.equal(typeof html, 'string', what);
      const got = idsIn(html);
      for (const id of ids) assert.ok(!got.has(id) && !has(html, `"${id}"`), `${what}: no ${id}`);
      assert.ok(!has(html, PRIV), `${what}: no text of them`);
    }

    // Shared, the arrow alone first: the toggle raises its item (K.2-63), the
    // describe names both items (DESCRIBE@arrow-ids), and a Push carries that
    // describe as text and makes no picture (REQ@picture-delivery a).
    const n0 = capture.calls.length;
    assert.equal((await ok(d.anonApi.patch(`/api/elements/${W.arrow.id}`, { shared: true }), 'share the arrow')).element.shared, true);
    const [item] = await waitUntil(() => { const its = elementItems(d.srv); return its.length ? its : null; }, { timeout: 5000, what: 'the arrow\'s item' });
    assert.deepStrictEqual(item.element_ids, [W.arrow.id]);
    assert.deepStrictEqual([item.describe.frame, item.describe.items], ['page', [A, B]], 'the describe names both items, from-item first');
    assert.match(item.summary, new RegExp(`· from ${A} to ${B} · `), item.summary);
    await ok(d.api.post('/api/queue/push', {}), 'push the item');
    const pend = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(pend && has(pend.envelope.content, W.arrow.id), 'the arrow delivered as text');
    assert.match(pend.envelope.content, new RegExp(`from ${A} to ${B}`), 'its describe, in words, names both items');
    assert.ok(!has(pend.envelope.content, W.keep.id) && !has(pend.envelope.content, `${PRIV} kept private`), 'never the private stroke');
    await ok(d.api.post('/api/queue/pending/consume', { id: pend.id }), 'consume');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(capture.calls.length, n0, 'no capture: a wake carries no picture');
    assert.equal(pictures(d.srv).length, 0, 'and no picture record');

    // The pane stroke and the margin stroke shared too (the svg stroke stays
    // private): the queue folds per origin item, so the pane stroke (from A)
    // and the margin stroke (beside B) each raise their own; flushed.
    for (const e of [W.pane, W.margin]) await ok(d.anonApi.patch(`/api/elements/${e.id}`, { shared: true }), `share ${e.id}`);
    await waitUntil(() => elementItems(d.srv).length === 2, { timeout: 5000, what: 'two more items' });
    const marginItem = elementItems(d.srv).find((x) => x.element_ids.includes(W.margin.id));
    assert.match(marginItem.summary, new RegExp(`· beside ${B} · `), marginItem.summary);
    for (const x of elementItems(d.srv)) assert.ok(!has(x, W.keep.id) && !has(x, `${PRIV} kept private`), 'the private stroke stays out');
    await ok(d.api.post('/api/queue/push', {}), 'push them');
    const pend2 = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    await ok(d.api.post('/api/queue/pending/consume', { id: pend2.id }), 'consume');
    assert.equal(capture.calls.length, n0, 'still no capture');

    // On request (Claude's POST /picture): ONE capture call, two shots, the hide style between.
    const pr = await call('POST', `/api/elements/${W.arrow.id}/picture`, {});
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.equal(capture.calls.length, n0 + 1, 'one capture call (PICTURE@one-session)');
    const callN = capture.calls[n0];
    assert.equal(callN.second && callN.second.style, hideStyle([W.arrow.id]), 'the second shot hides this group only (REQ@picture-without a)');
    assert.ok(!callN.second.style.includes(W.pane.id) && !callN.second.style.includes(W.margin.id), 'never another group');
    assert.ok(!callN.html.includes('visibility: hidden'), 'the first shot\'s document holds no hide style');
    const src = itemIdsOf(callN.html);
    assert.ok(!src.has(W.keep.id) && !has(callN.html, `"${W.keep.id}"`) && !has(callN.html, `${PRIV} kept private`), 'the source document: 0 private strokes, none of their text');
    assert.ok(src.has(W.arrow.id), 'the group itself is on the page');
    const cap = pictures(d.srv).at(-1);
    await waitUntil(() => { const c = captureOf(d.srv, cap.id); return c && c.image.state !== 'pending' && c.image_without.state !== 'pending'; }, { timeout: 10000, what: 'both images settle' });
    const dir = path.join(d.root, '.web-chat', 'captures');
    const withPng = fs.readFileSync(path.join(dir, `${cap.id}.png`));
    const withoutPng = fs.readFileSync(path.join(dir, `${cap.id}${WITHOUT_SUFFIX}`));
    const rec = captureOf(d.srv, cap.id);
    assert.deepStrictEqual([rec.image.state, rec.image.sha256, rec.image_without.state, rec.image_without.sha256], ['ready', sha256(withPng), 'ready', sha256(withoutPng)], 'both files, each its own');
    W.cap = cap.id;
    W.node2 = await commit(d.api, 'the picture pair');

    // Un-shared: both PNG entries of the capture record gone for every reader below seesPrivate.
    await ok(d.anonApi.patch(`/api/elements/${W.arrow.id}`, { shared: false }), 'un-share the arrow');
    for (const [who, headers] of [['lib/client', undefined], ['a network peer', PEER]]) {
      for (const q2 of ['', '?which=without', '?as=json', '?which=without&as=json']) {
        const r = await call('GET', `/api/elements/${W.arrow.id}/picture${q2}`, null, headers);
        assert.notEqual(r.status, 200, `${who}: picture${q2} refused once private`);
        assert.ok(!Buffer.isBuffer(r.body) || r.body.length === 0, `${who}: no PNG bytes`);
      }
    }
    const live = await call('GET', '/api/captures');
    assert.equal(live.status, 200);
    assert.ok(!has(live.body, `${W.arrow.id}@`) && !has(live.body, `element:${W.arrow.id}`), 'the live captures name no private member');
    const node = await call('GET', `/api/captures?node=${W.node2}`);
    assert.equal(node.status, 200, JSON.stringify(node.body));
    assert.ok(!has(node.body, `${W.arrow.id}@`) && !has(node.body, `element:${W.arrow.id}`), 'nor the committed node\'s, for lib/client');
    const nodeRead = await call('GET', `/api/graph/node/${W.node2}`);
    assert.equal(nodeRead.status, 200);
    assert.ok(!has(nodeRead.body, `${W.arrow.id}@`), 'nor the node read (U620b, U620c)');
    assert.ok(!fs.existsSync(path.join(dir, `${W.cap}.png`)) && !fs.existsSync(path.join(dir, `${W.cap}${WITHOUT_SUFFIX}`)), 'both files withdrawn together');

    // A picture that stays: the margin group's (still shared), on request; the
    // pane stroke back to private, so (3) starts from its own strokes alone.
    const mp = await call('POST', `/api/elements/${W.margin.id}/picture`, {});
    assert.equal(mp.status, 200, JSON.stringify(mp.body));
    W.capKeep = mp.body.capture || pictures(d.srv).at(-1).id;
    await waitUntil(() => { const c = captureOf(d.srv, W.capKeep); return c && c.image.state === 'ready' && c.image_without.state === 'ready'; }, { timeout: 10000, what: 'the margin picture' });
    await ok(d.anonApi.patch(`/api/elements/${W.pane.id}`, { shared: false }), 'the pane stroke private again');
    W.node3 = await commit(d.api, 'the kept picture');
  });

  await t.test('(3) U633: two stroke groups folded into one item; an older member\'s edit refreshes only its entry; delivered, a member un-shared after delivery is never re-raised by the re-send, which carries the describe as delivered (U633c) and, one group left, no element_ids', async () => {
    const { raw, tag } = bodies();
    const post = async (body, what) => (await ok(d.anonApi.post('/api/elements', body), what)).element;
    assert.deepStrictEqual(elementItems(d.srv), [], 'the queue holds no item of the type');
    const arrow2 = await post(tag(raw.arrow, 'wcu690 the folded arrow'), 'arrow 2');
    const ps = await post(tag(raw.pane, 'wcu690 the folded pane stroke'), 'a pane stroke');
    await ok(d.anonApi.patch(`/api/elements/${arrow2.id}`, { shared: true }), 'share arrow 2');
    await ok(d.anonApi.patch(`/api/elements/${ps.id}`, { shared: true }), 'share the pane stroke');
    await waitUntil(() => elementItems(d.srv).length === 1 && (elementItems(d.srv)[0].describe || {}).groups, { timeout: 5000, what: 'one item, two groups' });
    const it0 = structuredClone(elementItems(d.srv)[0]);
    assert.deepStrictEqual(it0.describe.groups.map((g) => [g.element_ids, g.frame, g.items]),
      [[[arrow2.id], 'page', [A, B]], [[ps.id], 'pane', undefined]], 'the arrow group (older), then the pane stroke\'s');

    // The OLDER member's edit: its entry refreshed, the other byte-equal, the top level re-derived.
    const moved = raw.arrow.payload.points.map((v, i) => (i % 4 === 1 ? Math.min(1, v + 0.05) : v));
    await ok(d.anonApi.patch(`/api/elements/${arrow2.id}`, { points: moved }), 'edit arrow 2\'s points');
    const it1 = await waitUntil(() => {
      const x = elementItems(d.srv)[0];
      return x && JSON.stringify(x.describe.groups[0]) !== JSON.stringify(it0.describe.groups[0]) ? structuredClone(x) : null;
    }, { timeout: 5000, what: 'the arrow\'s entry refreshed' });
    assert.deepStrictEqual(it1.describe.groups[1], it0.describe.groups[1], 'the pane stroke\'s entry untouched');
    assert.deepStrictEqual([it1.describe.groups[0].element_ids, it1.describe.groups[0].frame, it1.describe.groups[0].items], [[arrow2.id], 'page', [A, B]]);
    assert.equal(it1.describe.count, it1.describe.groups.reduce((n, g) => n + g.count, 0), 'the top-level count re-derived over the entries');
    assert.equal(it1.describe.shape, it1.describe.groups[1].shape, 'the top-level shape is the newest entry\'s');

    // Delivered, the pane stroke un-shared, the item re-sent.
    await ok(d.api.post('/api/queue/push', {}), 'push');
    const pend = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
    assert.ok(has(pend.envelope.content, ps.id), 'the pane stroke delivered while shared');
    await ok(d.api.post('/api/queue/pending/consume', { id: pend.id }), 'consume');
    await ok(d.anonApi.patch(`/api/elements/${ps.id}`, { shared: false }), 'un-share the pane stroke after delivery');
    const r = await callOf(d)('POST', `/api/queue/items/${it1.id}/resend`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = r.body.item;
    assert.deepStrictEqual(again.element_ids, [arrow2.id], 'the un-shared member is never raised again');
    assert.ok(!has(again, ps.id) && !has(again, 'wcu690 the folded pane stroke'), 'neither its id nor its words');
    assert.ok(!('groups' in again.describe) && !('element_ids' in again.describe), 'one group left: no groups and no element_ids at the top');
    const delivered = it1.describe.groups[0];
    assert.deepStrictEqual([again.describe.shape, again.describe.count, again.describe.bbox, again.describe.frame, again.describe.items],
      [delivered.shape, delivered.count, delivered.bbox, 'page', [A, B]], 'the arrow\'s entry as delivered, its refresh included (U633c)');
    await ok(d.api.del(`/api/queue/${again.id}`), 'take the re-sent item out');
    W.arrow2 = arrow2;
  });

  await t.test('(10) THE AG-1 SHAPE CHECK: every log record and node file of this world read as alpha.5 reads them, against test/fixtures/alpha5-log-shape.json; node ids, comment counts and the log\'s prefix unchanged by a second life; the residuals named', async () => {
    await d.graceful();
    const logFile = projectPaths(d.root).elementsLog;
    const bytes = fs.readFileSync(logFile, 'utf8');
    const recs = bytes.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const known = new Set(SHAPE.record_types);
    const itemRe = new RegExp(SHAPE.page_record.item_re);
    const seen = { plugin_versions: 0, page_records: 0, comment_versions: 0 };
    for (const r of recs) {
      assert.ok(known.has(r.t), `alpha.5's index knows every record type: ${r.t}`);
      if (r.t === 'el' || r.t === 'commit') {
        assert.deepStrictEqual(Object.keys(r).filter((k) => !SHAPE.record_keys[r.t].includes(k)), [], `${r.t} ${r.id || r.node}: only keys alpha.5 writes`);
      }
      if (r.t === 'commit') assert.ok(new RegExp(SHAPE.node_id).test(r.node), r.node);
      if (r.t !== 'ver') continue;
      const allowed = r.id[0] === 'p' ? SHAPE.plugin_ver_keys : SHAPE.record_keys.ver;
      assert.deepStrictEqual(Object.keys(r).filter((k) => !allowed.includes(k)), [], `${r.id}@${r.v}: only keys alpha.5 writes`);
      assert.ok(SHAPE.id_letters.includes(r.id[0]), `${r.id}: an alpha.5 id letter`);
      const anchor = r.payload && r.payload.anchor;
      if (r.id[0] === 'p') {
        seen.plugin_versions++;
        assert.equal(SHAPE.schemas[r.schema], undefined, `${r.id}: a plug-in schema (alpha.5 registers its row at list time)`);
        for (const k of Object.keys(r.payload)) assert.ok([...SHAPE.stroke_keys, ...SHAPE.describe_keys].includes(k), `${r.id}: payload key ${k} is one alpha.5's fixture row declares`);
        if (anchor && anchor.kind === SHAPE.page_record.kind) {
          seen.page_records++;
          assert.deepStrictEqual(Object.keys(anchor), SHAPE.page_record.keys, `${r.id}: the page record alpha.5 writes`);
          for (const end of [anchor.from, anchor.to]) {
            assert.deepStrictEqual(Object.keys(end), SHAPE.page_record.end_keys);
            assert.ok(itemRe.test(end.item) && end.item.length <= SHAPE.page_record.item_max, `${r.id}: an item id alpha.5's grammar takes`);
            assert.ok(Math.abs(end.x) <= SHAPE.page_record.end_max && Math.abs(end.y) <= SHAPE.page_record.end_max);
          }
        } else if (anchor) {
          assert.ok(SHAPE.engine_kinds.includes(anchor.kind), `${r.id}: anchor kind ${anchor.kind} is an alpha.5 engine kind`);
        }
      } else {
        const row = SHAPE.schemas[r.schema];
        assert.ok(row, `${r.id}: ${r.schema} is an alpha.5 schema`);
        for (const k of Object.keys(r.payload || {})) assert.ok(row.keys.includes(k), `${r.id}: payload key ${k} is one alpha.5 reads`);
        if (row.type === 'comment') seen.comment_versions++;
      }
    }
    assert.ok(SHAPE.page_record.plugin_admitted, 'alpha.5 admits a stroke\'s page record on a plug-in row');
    assert.ok(seen.page_records >= 3 && seen.plugin_versions >= 6 && seen.comment_versions >= 1, JSON.stringify(seen));
    // The node files: ids, comment counts, the picture entries' two images.
    const gdir = projectPaths(d.root).graphDir;
    const counts = {};
    for (const f of fs.readdirSync(gdir).filter((x) => /^n\d+\.json$/.test(x))) {
      const n = JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8'));
      assert.ok(new RegExp(SHAPE.node_id).test(n.id) && Number.isFinite(n.created_at), `${f}: a node alpha.5 reads`);
      counts[n.id] = Array.isArray(n.comments) ? n.comments.length : 0;
      for (const c of n.comments || []) assert.ok(SHAPE.id_letters.includes(String(c.id)[0]), `${n.id}: a comment copy alpha.5 reads`);
      for (const c of n.captures || []) {
        if (c.kind !== SHAPE.picture.profile) continue;
        for (const k of ['image', 'image_without']) assert.ok(c[k] && typeof c[k].state === 'string', `${n.id} ${c.id}: ${k} as alpha.5 writes it`);
      }
    }
    assert.ok(Object.values(counts).some((x) => x > 0), 'a node carries the comment');
    const capDir = path.join(d.root, '.web-chat', 'captures');
    assert.ok(fs.existsSync(path.join(capDir, `${W.capKeep}.png`)) && fs.existsSync(path.join(capDir, `${W.capKeep}${SHAPE.picture.without_suffix}`)),
      `the pair's files as alpha.5 names them (<capture>.png, <capture>${SHAPE.picture.without_suffix})`);
    assert.equal(WITHOUT_SUFFIX, SHAPE.picture.without_suffix, 'the suffix unchanged since alpha.5');
    // A second life over the same files: the log's prefix unchanged, node ids and comment counts the same.
    const again = await withServer(t, { root: d.root });
    try {
      assert.ok(fs.readFileSync(logFile, 'utf8').startsWith(bytes), 'append-only: the log\'s prefix unchanged');
      for (const [id, n] of Object.entries(counts)) {
        const node = again.srv.graph.nodes.get(id);
        assert.ok(node, `${id} still a node`);
        assert.equal((node.comments || []).length, n, `${id}: the same comment count`);
      }
    } finally { await again.stop(); }
    t.diagnostic(`AG-1 (alpha.5 reader) in this world: ${JSON.stringify(seen)}; rollback residuals from alpha.6: none in the files (no record kind, field or file added after ae-alpha.5); in memory: U633c's write-through is lost (alpha.5 re-sends a folded item's last-raise describe), U629's phone pin is alpha.6's (alpha.5 keeps the faded guess), U635's interval and U642's counters are chrome-only; U690's PATCH re-anchor check and the either-end reads are absent at alpha.5`);
  });
});

// ═══ (4) U634: one known set per response ═══════════════════════════════════

const SEEDS = 24;
const LABEL = 'u690-known';
const learned = (value) => [{ id: 'learned', rule: 'known', secrets: [value] }];
function reading(body, value) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const plain = findLeaks(raw, learned(value)).length > 0;
  const masked = raw.includes(MASK(LABEL));
  return { plain, masked, straddled: plain && masked };
}
// Off (null) for `k` consults after arm(k), then the value.
function armedSource(value) {
  let mode = 'never';
  let left = 0;
  let calls = 0;
  const fn = () => {
    calls++;
    if (mode === 'on') return value;
    if (mode === 'never') return null;
    if (left > 0) { left--; return null; }
    return value;
  };
  return { fn, arm(k) { mode = 'armed'; left = k; calls = 0; }, never() { mode = 'never'; calls = 0; }, on() { mode = 'on'; calls = 0; }, count: () => calls };
}

test('(4) U634: GET /api/elements while a redactor source learns a value mid-composition is served under ONE known set (0 straddled bodies over 24 seeds), and its node branch the same', { timeout: 120000 }, async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u690-pin-') });
  const value = `wcpinned${crypto.randomBytes(12).toString('hex')}`;
  const src = armedSource(value);
  assert.equal(d.srv.redactor.addKnownSource(src.fn, LABEL, { maxAgeMs: 0 }), true, 'createServer\'s redactor getter (U634)');
  const text = 'The staging host takes a token for access now.';
  await ok(d.api.post('/api/render', { id: 'm-pin', html: `<p>${text}</p>` }), 'render');
  const at = text.indexOf('takes a token');
  const anchor = { v: 1, kind: 'range', mount: 'm-pin', quote: { exact: 'takes a token', prefix: text.slice(0, at), suffix: text.slice(at + 13) }, pos: { start: at, end: at + 13 } };
  for (let i = 0; i < 3; i++) await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: `pin ${i} ${value}`, shared: true } }), `comment ${i}`);
  for (let i = 0; i < 3; i++) await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor, payload: { note: `note ${i} ${value}` } }), `highlight ${i}`);
  const node = await commit(d.api, 'the pins');
  src.never();
  assert.equal(JSON.stringify((await ok(d.anonApi.get('/api/elements'), 'GET')).elements).split(value).length - 1, 6, 'stored plain: six texts serve it while unknown');

  for (const [what, url] of [['GET /api/elements', '/api/elements'], ['the node branch', `/api/elements?node=${encodeURIComponent(node)}`]]) {
    const get = async () => (await ok(d.anonApi.get(url), what)).elements;
    src.never();
    await get();
    const K = Math.max(src.count(), 16);
    const straddled = [];
    for (let s = 0; s < SEEDS; s++) {
      src.arm(1 + (s % K));
      if (reading(await get(), value).straddled) straddled.push(s);
      src.on();
      const next = reading(await get(), value);
      assert.ok(next.masked && !next.plain, `${what}, seed ${s}: the next one masks all`);
    }
    t.diagnostic(`${what}: K=${K}, straddled ${straddled.length}/${SEEDS}`);
    assert.deepStrictEqual(straddled, [], `${what}: no body mixes the value masked and plain`);
  }
});

// ═══ (5) U632: the Report-Only header ═══════════════════════════════════════

test('(5) U632: the surface page answers Content-Security-Policy-Report-Only and no enforced policy; a pane\'s fetch and a theme\'s image are still served (Report-Only breaks nothing)', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u690-csp-') });
  const page = await d.anonApi.get('/');
  assert.equal(page.status, 200);
  assert.strictEqual(page.headers.get('content-security-policy-report-only'), SURFACE_CSP_REPORT_ONLY);
  assert.equal(page.headers.get('content-security-policy'), null, 'no enforced policy on the surface page (CHROME@csp a)');
  // A pane script's fetch (same origin, the store) and a theme's image (a
  // builtin theme pack's logo from the daemon) answer as they did.
  await ok(d.api.post('/api/store', { patch: { wcu690: 1 } }), 'a store write');
  const store = await ok(d.anonApi.get('/api/store?keys=wcu690'), 'a pane\'s fetch of the store');
  assert.deepStrictEqual(store, { wcu690: 1 });
  const themes = await ok(d.anonApi.get('/api/themes'), 'themes');
  const logo = JSON.stringify(themes).match(/"(\/api\/[^"]*?\.(?:svg|png|webp))"/);
  if (logo) {
    const img = await d.anonApi.raw(logo[1]);
    assert.equal(img.status, 200, `the theme image ${logo[1]}`);
    assert.equal(img.headers.get('content-security-policy-report-only'), null, 'an image carries no policy');
  } else {
    t.diagnostic('no theme image URL listed by /api/themes in a fresh project: the policy\'s img-src covers \'self\'');
  }
  const img = /img-src ([^;]*)/.exec(SURFACE_CSP_REPORT_ONLY)[1].split(/\s+/);
  const connect = /connect-src ([^;]*)/.exec(SURFACE_CSP_REPORT_ONLY)[1].split(/\s+/);
  assert.ok(img.includes("'self'") && connect.includes("'self'"), 'even enforced, the policy would allow both');
});

// ═══ (6) U642: the split cold counter ═══════════════════════════════════════

test('(6) U642: createEventAnchors over a jsdom pane — a first visit counts cold_missing, a mutation then an event cold_dirty, cold their sum', async () => {
  const { createEventAnchors } = await import(pathToFileURL(path.join(PUBLIC_DIR, 'app', 'event-anchor.js')).href);
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  try {
    const win = dom.window;
    win.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
    const host = win.document.createElement('div');
    host.dataset.mountId = 'p1';
    win.document.body.appendChild(host);
    const root = win.__wcMount.attachAndExtract(host, '<section><ul><li><b>first</b><button id="b1">Run</button></li></ul></section>').root;
    let now = 1000;
    const ea = createEventAnchors({ anchors, MutationObserver: win.MutationObserver, schedule: () => {}, now: () => now, setTimer: () => 0, clearTimer: () => {} });
    const btn = root.getElementById('b1');
    const cold = () => { const s = ea.stats(); return [s.cold_missing, s.cold_dirty, s.cold]; };
    assert.deepStrictEqual(cold(), [0, 0, 0]);
    ea.anchorAt(root, btn, 'p1');
    assert.deepStrictEqual(cold(), [1, 0, 1], 'a first visit: cold_missing');
    ea.anchorAt(root, btn, 'p1');
    assert.deepStrictEqual(cold(), [1, 0, 1], 'warm: neither moves');
    btn.setAttribute('data-x', '1');
    ea.anchorAt(root, btn, 'p1');
    assert.deepStrictEqual(cold(), [1, 1, 2], 'a mutation then an event: cold_dirty');
    const s = ea.stats();
    assert.equal(s.cold, s.cold_missing + s.cold_dirty, 'cold is their sum');
    now += 1;
  } finally { dom.window.close(); }
});

// ═══ (7) U641: the soak's strokeStep ═══════════════════════════════════════

test('(7) U641: createDrive(...).strokeStep against this daemon writes the element-anchored, pane-frame and page-frame strokes with stroke_failures 0 and nothing left live', { timeout: 120000 }, async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u690-soak-') });
  for (const id of fixture.PANES) await ok(d.api.post('/api/render', { id, html: fixture.paneHtml(id, 'd0') }), `render ${id}`);
  const lines = [];
  const name = await fixture.stageStrokes({ project: d.root }, d.srv, { intDir: REPO, log: (l) => lines.push(l) });
  assert.equal(name, PACK, lines.join('\n'));
  const soakRoot = tmpRoot('wc-u690-soakout-');
  const cfg = { root: soakRoot, out: soakRoot, port: d.port, project: d.root };
  writeJsonAtomic(fixture.fixtureRecord(cfg), { v: 1, pack: name });
  const before = (d.srv.state.elements || []).slice();
  const log = [];
  const dr = drive.createDrive(cfg, { log: (l) => log.push(l) });
  await dr.strokeStep();   // the arrow
  await dr.strokeStep();   // the margin stroke
  const c = dr.counts;
  assert.deepStrictEqual([c.stroke_writes_element, c.stroke_writes_pane, c.stroke_writes_page, c.stroke_failures], [2, 2, 2, 0], log.join('\n'));
  assert.equal(c.stroke_writes, 6, 'the total (K.2-255)');
  assert.deepStrictEqual(log, [], 'nothing refused');
  assert.deepStrictEqual(d.srv.state.elements || [], before, 'every stroke undone: no reference left');
  assert.deepStrictEqual((await ok(d.anonApi.get(`/api/elements?type=${TYPE}`), 'GET')).elements, [], 'nothing of the type left live');
});

// ═══ (8) U623 at the integration head ═══════════════════════════════════════

test('(8) render, use_component and clear answer an arrow on both items (IMPACT@both-items); a Wipe keeps an arrow while one item is left (WIPE@either-end); the undo takes it from either item (UNDO@either-end)', { timeout: 120000 }, async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u690-impact-') });
  const call = callOf(d);
  await approveSoakWay(d);
  await ok(d.api.post('/api/render', { id: A, html: PANE_A }), 'A');
  await ok(d.api.post('/api/render', { id: B, html: PANE_B }), 'B');
  await ok(call('POST', '/api/components', { name: 'w-u690', source: '<p>A component</p>' }), 'save a component');
  const { raw, tag } = bodies();
  const arrow = (await ok(d.anonApi.post('/api/elements', tag(raw.arrow, 'wcu690 impact', { shared: true })), 'a shared arrow')).element;
  const one = { item: B, total: 1, by_type: { [TYPE]: 1 }, shared: 1, private: 0 };
  assert.deepStrictEqual((await ok(call('POST', '/api/render', { id: B, html: PANE_B }), 'render B')).annotations, one, 'render over B');
  assert.deepStrictEqual((await ok(call('POST', '/api/render', { id: A, html: PANE_A }), 'render A')).annotations, { ...one, item: A }, 'render over A');
  assert.deepStrictEqual((await ok(call('POST', '/api/components/w-u690/use', { id: B }), 'use over B')).annotations, one, 'use_component over B');
  const cleared = await ok(call('POST', '/api/clear', { id: B }), 'clear B');
  assert.deepStrictEqual(cleared.annotations, one, 'clear of B answers the arrow');

  // UNDO@either-end, over fresh arrows (pane B back first).
  await ok(d.api.post('/api/render', { id: B, html: PANE_B }), 'B again');
  const live = () => (d.srv.state.elements || []).map((r) => String(r).split('@')[0]);
  for (const item of [B, A]) {
    const a = (await ok(d.anonApi.post('/api/elements', tag(raw.arrow, `wcu690 undo from ${item}`)), 'an arrow')).element;
    const u = await ok(d.anonApi.post('/api/elements/undo', { item }), `undo from ${item}`);
    assert.deepStrictEqual([u.undone.id, u.undone.item], [a.id, item], `the arrow undone from ${item}`);
    assert.ok(!live().includes(a.id));
  }

  // WIPE@either-end: A pinned, a Wipe keeps the arrow (A is left), drops the margin stroke beside B.
  const kept = arrow.id;
  const beside = (await ok(d.anonApi.post('/api/elements', tag(raw.margin, 'wcu690 beside B')), 'a margin stroke beside B')).element;
  assert.ok(live().includes(kept));
  await pinPane(d, A, true);
  await ok(d.api.post('/api/graph/wipe', {}), 'wipe (A pinned)');
  assert.ok(live().includes(kept), 'the arrow stays while A does');
  assert.ok(!live().includes(beside.id), 'the margin stroke beside B goes with B');
  await pinPane(d, A, false);
  await ok(d.api.post('/api/graph/wipe', {}), 'wipe A too');
  assert.ok(!live().includes(kept), 'neither item left: the arrow dropped');
});

// ═══ (9) the constants ══════════════════════════════════════════════════════

test('(9) the constants at the head: SCHEMA_VERSION 4, PORTAL_PROTOCOL_VERSION 12, CATALOGUE_VERSION 1.0.0 with its hash (PROTO@none, SCHEMA@4, CATALOGUE@result-minor)', () => {
  assert.equal(versions.SCHEMA_VERSION, 4);
  assert.equal(versions.PORTAL_PROTOCOL_VERSION, 12);
  assert.equal(versions.CATALOGUE_VERSION, '1.0.0');
  assert.equal(versions.CATALOGUE_SHA256, '9626f1c67a15e78266c7c1624bbefce36267c77673d38880c6fe08eb52323855');
});
