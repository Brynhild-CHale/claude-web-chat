// Tranche 2 of the annotation engine in the LIVE chrome (U340): the real
// public/index.html and public/app module graph (test-support/chrome-shell,
// booted once) wired to a REAL daemon (withServer, on a migrated v3 project,
// test-support/v3-graph.js). The chrome's element, graph, queue and toolbar
// requests are forwarded to the daemon (Node's own fetch, held before the shell
// replaces it: a local browser's request), and a bridge relays the daemon's
// socket frames into the chrome's socket and the chrome's frames back. So what
// the chrome draws is what the daemon serves, and what it sends lands there.
//
// Pinned here, one test per step, in order:
//   - the overlay draws a migrated comment at its converted anchor (an exact
//     hit), and the reports the chrome's resolver sends land in the daemon's
//     report holder (main.js starts the batching, U314; U340's wiring);
//   - a carried guess is drawn at the guess; its card's "Re-anchor here"
//     appends ONE version to the log and changes 0 node-file bytes (U306);
//   - a new comment, a highlight (the Custom Highlight path where jsdom has it,
//     else the geometry fallback; Safari is E3's) and a box grab made in the
//     chrome land in the daemon; the box grab's queue item — its type-managed
//     card in the rail, nothing drawn on the page (K.2-11, F6 a) — shows the
//     chrome-not-found metadata-only notice (B2's note; U328b, U328c);
//   - reset and hello refresh the markers with no poll (no REFRESH_MS, no
//     MARKER_MS); Set active and Branch keep them fresh;
//   - U338's bar renders every built-in type from the registry with its
//     element.json icon, the ✎ dock button retired onto it; C arms the comment
//     tool through the registry and the bar shows it active; at the phone
//     layout the bar sits in the bottom bar between the up/down arrows and the
//     graph button (C3's note);
//   - a previewed older node draws its pins read-only;
//   - a document (preview, export) of a comment-only node carries only the
//     resolver kinds U307 splices and draws no element (F-DOCS a);
//   - comments on markdown (F.3, RULED M3 (a)): a pin on a heading lands in the
//     daemon as a source anchor whose label and queue summary read `on section
//     "<heading>"`; the heading rewritten through a markdown frame, the pin is
//     still placed on the rewritten heading (GT-03's section rule, graded
//     under GT-07's twin); a pin on prose names its section; Show on page for
//     an md pin (with no marker, and from the rail card) reveals the item;
//   - no script-error reached the daemon's event log, and no interval was armed.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The daemon draws a box grab through the export path's headless Chrome; here
// there is none, so the grab settles chrome-not-found (metadata only).
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

// Node's own fetch, held before the shell replaces the global one.
const nodeFetch = globalThis.fetch;

const { bootShell, respond } = require('../test-support/chrome-shell');
const { v3Graph } = require('../test-support/v3-graph');
const { withServer, waitUntil, wsConnect, commentBody } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const { ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');

const REPO = path.join(__dirname, '..');
const WAIT = { timeout: 8000, interval: 20 };
const GUESS_TEXT = 'the lead line before its edit';

let d = null;              // the daemon (withServer's ctx)
let paths = null;
let dws = null;            // the bridge's socket to the daemon
const cleanups = [];
let shell, W, M, ov, bus, topbar, gv, comments, HL, BG;
let intervalsAtBoot = 0;
const fixture = {};

// ── the daemon, from Node ───────────────────────────────────────────────────

async function daemon(method, p, body) {
  const r = await nodeFetch(d.baseUrl + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, type: r.headers.get('content-type') || '' };
}
async function claude(method, p, body) {
  const r = await nodeFetch(d.baseUrl + p, {
    method, headers: { 'Content-Type': 'application/json', 'X-WC-Writer': d.writerToken() }, body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(r.status < 300, `${method} ${p}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}
const logRecords = () => fs.readFileSync(paths.elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function nodeDigests() {
  const out = {};
  for (const f of fs.readdirSync(paths.graphDir).filter((x) => /^n\d+\.json$/.test(x)).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(paths.graphDir, f))).digest('hex');
  }
  return out;
}

// The chrome's request, answered by the daemon.
async function forward(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;
  const r = await nodeFetch(d.baseUrl + url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : init.body });
  const type = r.headers.get('content-type') || 'text/plain';
  const text = await r.text();
  let body = text;
  if (/json/.test(type)) { try { body = JSON.parse(text); } catch {} }
  return respond(body, { status: r.status, headers: { 'content-type': type } });
}
const FORWARDED = {};
for (const p of ['/api/elements', '/api/elements/*', '/api/graph', '/api/graph/*', '/api/queue', '/api/queue/*', '/api/toolbar', '/api/toolbar/*']) {
  FORWARDED[p] = forward;
}

// The bridge: the chrome's socket frames go to the daemon, the daemon's come in.
const inbound = [];
function attach(sock) {
  const send = sock.send.bind(sock);
  sock.send = (data) => {
    send(data);
    if (dws && dws.readyState === 1) dws.send(typeof data === 'string' ? data : JSON.stringify(data));
  };
}
function deliver(text) {
  const s = shell && shell.socket();
  if (s && s.readyState === 1) s.receive(text); else inbound.push(text);
}

// ── the page's geometry (jsdom does no layout) ──────────────────────────────

const VIEW = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0 };
const rectOf = () => VIEW;

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const layer = () => W.document.getElementById('el-layer');
const markers = () => [...layer().querySelectorAll('.el-marker')];
const markersFor = (id) => markers().filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const markedIds = () => [...new Set(markers().flatMap((m) => (m.dataset.elIds || '').split(' ').filter(Boolean)))].sort();
const armedType = () => { const a = ov.armed(); return a ? a.type : null; };
async function settle(ms = 120) { for (let i = 0; i < ms / 20; i++) await shell.tick(20); }
async function eventually(pred, what, timeout = WAIT.timeout) {
  await waitUntil(async () => { await settle(40); return pred(); }, { timeout, interval: 0, what });
}
function pe(el, type, pointerType, x, y, extra = {}) {
  el.dispatchEvent(new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId: extra.pointerId || 1, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  }));
}
function gesture(el, pointerType, pointerId) {
  pe(el, 'pointerdown', pointerType, 100, 100, { pointerId });
  pe(el, 'pointerup', pointerType, 100, 100, { pointerId });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId, clientX: 100, clientY: 100 }));
}
// The anchored pins the page holds a pane for (a ghost draws no marker).
const anchoredIds = (pins, mounts) => pins.filter((p) => p.anchor && mounts.some((m) => m.id === p.anchor.mount)).map((p) => p.id).sort();

// ── boot ─────────────────────────────────────────────────────────────────────

before(async () => {
  const owner = { after: (fn) => { cleanups.push(fn); } };
  d = await withServer(owner, { seed: ({ root }) => { v3Graph(root); } });
  paths = projectPaths(d.root);
  // The live surface the chrome meets: the migrated draft's pane, a pane whose
  // lead line was edited after a pin was dropped on it (a carried guess), and a
  // pane for the tools; one turn commits them.
  await claude('POST', '/api/turn-begin', { message: 'e2e-t2 chrome setup' });
  await claude('POST', '/api/render', { id: 'e2e-g', html: `<p class="lead">${GUESS_TEXT}</p><p class="other">another line</p>` });
  const guess = await daemon('POST', '/api/elements', commentBody({
    text: 'a pin on the lead line', shared: true, device: 'desktop',
    anchor: { mount: 'e2e-g', selector: 'p.lead', text: GUESS_TEXT, ordinal: 0 },
  }));
  assert.equal(guess.status, 200, guess.text);
  fixture.guess = guess.json.pin;
  await claude('POST', '/api/render', { id: 'e2e-g', html: '<p class="lead">the lead line, reworded since</p><p class="other">another line</p>' });
  await claude('POST', '/api/render', { id: 'e2e-p', html: '<div class="card"><p class="lead">Tools work here</p><p class="more">a second line of text</p></div>' });
  const end = await claude('POST', '/api/turn-end', { author: 'claude', summary: 'setup' });
  assert.ok(end.node_id, JSON.stringify(end));
  fixture.setupNode = end.node_id;
  fixture.n4 = (await daemon('GET', '/api/graph/node/n4')).json;
  fixture.n2 = (await daemon('GET', '/api/graph/node/n2')).json;

  shell = await bootShell({
    open: false,
    routes: FORWARDED,
    onSocket: attach,
    init: async (sh) => {
      const o = await sh.importApp('overlay.js');
      o.initOverlay({ rectOf, clips: () => false });
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  ({ bus } = await shell.importApp('bus.js'));
  topbar = await shell.importApp('topbar.js');
  gv = await shell.importApp('graph-view.js');
  comments = await shell.importApp('comments.js');
  HL = await shell.importApp('highlight.js');
  BG = await shell.importApp('box-grab.js');
  // The boot census counts the chrome's standing intervals once they have all
  // armed. The queue rail's refreshPending poll arms only after initQueue's
  // own awaits (hydrateQueue, refreshPending) settle, which may be after the
  // shell's boot resolves (Node 22.23.3 saw 4 against 3): wait for it by its
  // function, then count, so the later "no interval armed since boot" checks
  // measure what the exercised paths armed, never when the poll did.
  const { refreshPending } = await shell.importApp('queue.js');
  await eventually(() => shell.intervals().some((i) => i.fn === refreshPending), 'the queue rail\'s refreshPending interval armed');
  intervalsAtBoot = shell.intervals().length;

  dws = wsConnect(d.port, '/ws');
  dws.on('message', (data) => deliver(data.toString()));
  await new Promise((resolve, reject) => { dws.once('open', resolve); dws.once('error', reject); });
  shell.socket().open();
  for (const text of inbound.splice(0)) shell.socket().receive(text);
  await eventually(() => !!W.document.querySelector('#main .pane[data-pane-id="e2e-p"]'), 'the hello\'s panes mounted');
});

after(async () => {
  try { if (ov) ov.setArmed(null); } catch {}
  try { if (dws) dws.terminate(); } catch {}
  // The daemon first, while the shell's timers still run; then the shell.
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  if (shell) await shell.restore();
});

// ── the steps ────────────────────────────────────────────────────────────────

test('the overlay draws a migrated comment at its converted anchor; the chrome\'s reports land in the daemon', async () => {
  const live = (await daemon('GET', '/api/elements?type=comment')).json.elements;
  const c1 = live.find((c) => c.id === 'c1');
  assert.ok(c1 && c1.record && c1.record.form === 'pin-locator@1', 'c1 is a migrated pin, served with its converted record');
  await eventually(() => markersFor('c1').length === 1, 'the migrated pin drawn');
  assert.ok(markersFor('c1')[0].classList.contains('el-hit'), 'its converted anchor resolves to its element');
  assert.ok(markersFor('c1')[0].classList.contains('pin-marker'), 'drawn by the comment type');
  // The resolver's answers, reported by the live chrome (main.js starts the
  // batching before connect) and held by the daemon, stamped local.
  await eventually(() => d.srv.reports.answers({ mount: 'm-a' }).some((a) => a.id === 'c1'), 'the chrome\'s report on m-a', 12000);
  const a = d.srv.reports.answers({ mount: 'm-a' }).find((x) => x.id === 'c1');
  // A converted pin-locator@1 found by its locator reads re-resolved, how
  // 'locator' (the minted record path); either way the element was found.
  assert.ok(['exact', 're-resolved'].includes(a.state), `found: ${a.state} ${a.how}`);
  assert.equal(a.source.peer, 'local');
  assert.equal(a.surface, d.srv.reports.surface(), 'echoing the hello\'s counter');
});

test('a carried guess is drawn at the guess; "Re-anchor here" appends one version and changes 0 node-file bytes', async () => {
  const id = fixture.guess.id;
  await eventually(() => markersFor(id).some((m) => m.classList.contains('el-guess')), 'the carried guess drawn');
  const before = nodeDigests();
  const versions = () => logRecords().filter((r) => r.t === 'ver' && r.id === id).length;
  const v0 = versions();
  const records0 = logRecords().length;
  const seen = [];
  const off = bus.on('overlay:guess', (x) => seen.push(x));
  try {
    shell.click(markersFor(id).find((m) => m.classList.contains('el-guess')));
    await shell.tick();
  } finally { off(); }
  assert.deepEqual(seen.map((x) => x.id), [id], 'the click is the re-anchor seam');
  const card = W.document.querySelector('.wc-reanchor-card');
  assert.ok(card && card.dataset.elId === id, 'the card is open');
  const here = card.querySelector('.wc-reanchor-here');
  assert.ok(here, '"Re-anchor here"');
  shell.click(here);
  await eventually(() => versions() === v0 + 1, 'one version appended');
  await eventually(() => /Re-anchored/.test((W.document.querySelector('.wc-reanchor-card .wc-reanchor-note') || {}).textContent || ''), 'the card says so');
  const added = logRecords().slice(records0);
  assert.deepEqual(added.map((r) => r.t), ['ver'], `one record, a version: ${JSON.stringify(added.map((r) => r.t))}`);
  assert.deepEqual(nodeDigests(), before, '0 node-file bytes changed');
  shell.key('Escape');
  await shell.tick();
});

test('a new comment, a highlight and a box grab made in the chrome land in the daemon; the grab\'s card shows the metadata-only notice and nothing is drawn on the page', async () => {
  const p = rootOf('e2e-p');
  const lead = p.querySelector('p.lead');
  // The comment: C arms it, a mouse press opens the composer, Pin posts.
  shell.key('c');
  assert.equal(armedType(), 'comment');
  gesture(lead, 'mouse', 11);
  const pop = W.document.querySelector('.pin-pop');
  assert.ok(pop && pop.querySelector('.pin-text'), 'the composer opened');
  pop.querySelector('.pin-text').value = 'e2e-t2 chrome comment';
  shell.click(pop.querySelector('.pin-save'));
  let made = null;
  await eventually(async () => {
    made = ((await daemon('GET', '/api/elements?type=comment')).json.elements || []).find((c) => c.text === 'e2e-t2 chrome comment');
    return !!made;
  }, 'the comment in the daemon');
  assert.equal(made.writer.class, 'user', 'a local browser\'s write');
  await eventually(() => markersFor(made.id).length === 1, 'the new comment drawn');

  // The highlight: jsdom has no CSS.highlights, so the geometry fallback.
  assert.equal(HL.paintMode(), W.CSS && W.CSS.highlights ? 'custom-highlight' : 'geometry');
  const r = W.document.createRange();
  r.setStart(lead.firstChild, 0);
  r.setEnd(lead.firstChild, 10);
  p.getSelection = () => ({ rangeCount: 1, getRangeAt: () => r, removeAllRanges() {} });
  W.Range.prototype.getClientRects = function getClientRects() { return [{ left: 200, top: 200, width: 80, height: 16, right: 280, bottom: 216, x: 200, y: 200 }]; };
  let hl = null;
  try {
    ov.setArmed('highlight');
    pe(lead, 'pointerdown', 'mouse', 210, 205, { pointerId: 12 });
    pe(lead, 'pointerup', 'mouse', 270, 205, { pointerId: 12 });
    await eventually(async () => {
      hl = ((await daemon('GET', '/api/elements?type=highlight')).json.elements || [])[0];
      return !!hl;
    }, 'the highlight in the daemon');
    assert.equal(hl.anchor.kind, 'range');
    assert.equal(hl.anchor.quote.exact, 'Tools work', 'snapped to whole words');
    await eventually(() => markersFor(hl.id).length === 1, 'the highlight drawn');
    if (HL.paintMode() === 'geometry') {
      await eventually(() => markersFor(hl.id)[0].querySelectorAll('.hl-rect').length === 1, 'its rectangle (the fallback)');
    }
  } finally {
    ov.setArmed(null);
    delete p.getSelection;
  }

  // The box grab: the item's content box and the element under the drag.
  const wrapper = W.document.querySelector('.pane[data-pane-id="e2e-p"]');
  shell.scrollMetrics(wrapper, { rect: { left: 100, top: 100, width: 600, height: 300 } });
  shell.scrollMetrics(wrapper.querySelector('.mount-host'), { rect: { left: 100, top: 130, width: 600, height: 270 } });
  shell.scrollMetrics(p.querySelector('.card'), { rect: { left: 120, top: 150, width: 400, height: 120 } });
  shell.scrollMetrics(lead, { rect: { left: 130, top: 160, width: 300, height: 30 } });
  shell.scrollMetrics(p.querySelector('p.more'), { rect: { left: 130, top: 200, width: 300, height: 30 } });
  ov.setArmed('box-grab');
  pe(lead, 'pointerdown', 'mouse', 140, 165, { pointerId: 13 });
  pe(lead, 'pointermove', 'mouse', 200, 175, { pointerId: 13 });
  pe(lead, 'pointermove', 'mouse', 250, 180, { pointerId: 13 });
  pe(lead, 'pointerup', 'mouse', 250, 180, { pointerId: 13 });
  lead.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 13, clientX: 250, clientY: 180 }));
  let grab = null;
  await eventually(async () => {
    grab = ((await daemon('GET', '/api/elements?type=box-grab')).json.elements || [])[0];
    return !!grab;
  }, 'the grab in the daemon');
  ov.setArmed(null);
  // The daemon draws it (no Chrome here: chrome-not-found), raises its queue
  // item with the image's state, and the rail draws the grab's own card.
  const card = () => W.document.querySelector(`#queue-rail .qi-card[data-type="box-grab"]`);
  await eventually(() => !!card(), 'the grab\'s card in the rail', 15000);
  const queued = (await daemon('GET', '/api/queue')).json.items.find((it) => it.kind === 'element' && it.element_id === grab.id);
  assert.ok(queued, 'one element queue item for the grab');
  assert.equal(queued.image.state, 'chrome-not-found');
  assert.equal(card().querySelector('img'), null, 'no picture');
  assert.ok(card().textContent.includes(queued.image.hint), 'the card names chrome-not-found\'s hint');
  const look = W.document.querySelector('.popover.bg-look');
  assert.ok(look, 'the look opened for the settled grab');
  assert.ok(look.textContent.includes(BG.METADATA_ONLY), 'Claude gets the metadata only');
  assert.equal(markersFor(grab.id).length, 0, 'nothing is drawn on the page for the grab (F6 a)');
  assert.equal(layer().querySelector('.bg-band'), null, 'and no band is left');
  shell.key('Escape');
  await shell.tick();
});

test('reset and hello refresh the markers with no poll; Set active and Branch keep them fresh', async () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/comments.js'), 'utf8');
  assert.ok(!/REFRESH_MS|MARKER_MS|setInterval\(/.test(src), 'comments.js holds no 30 s refresh, no 500 ms marker timer, no interval');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
  // Set active through the chrome's own graph screen action: the daemon's
  // reset re-draws n4's pins.
  await gv.setActive('n4');
  const n4 = anchoredIds(fixture.n4.comments, fixture.n4.mounts);
  await eventually(() => JSON.stringify(markedIds().filter((x) => /^c/.test(x))) === JSON.stringify(n4), `n4's pins (${n4})`);
  // Branch from n2 (it has children: the next commit forks).
  await gv.branchFrom('n2');
  const n2 = anchoredIds(fixture.n2.comments, fixture.n2.mounts);
  await eventually(() => JSON.stringify(markedIds().filter((x) => /^c/.test(x))) === JSON.stringify(n2), `n2's pins (${n2})`);
  // A hello (a reconnect) re-draws from its own lean rows.
  const before = markedIds();
  const sockets = shell.sockets.length;
  dws.terminate();
  shell.socket().drop();
  // The chrome retries on its backoff (ws.js reconnectDelay); this shell opens
  // no socket by itself (open: false), so the bridge opens the new one.
  await eventually(() => shell.sockets.length > sockets, 'the chrome\'s reconnect', 15000);
  dws = wsConnect(d.port, '/ws');
  dws.on('message', (data) => deliver(data.toString()));
  await new Promise((resolve, reject) => { dws.once('open', resolve); dws.once('error', reject); });
  shell.socket().open();
  for (const text of inbound.splice(0)) shell.socket().receive(text);
  await eventually(() => JSON.stringify(markedIds()) === JSON.stringify(before), 'the same markers after the hello');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'still no interval');
});

test('U338\'s bar renders every built-in type from the registry with its element.json icon; ✎ is retired; C arms the comment tool and the bar shows it', async () => {
  const bar = shell.$('toolbar');
  assert.ok(bar, '#toolbar');
  assert.equal(shell.$('btn-pin-mode'), null, 'the ✎ dock button is retired onto the bar');
  const listed = (await daemon('GET', '/api/elements/types')).json.types.map((x) => x.type);
  const slots = [...bar.querySelectorAll('.tb-slot')];
  assert.deepEqual(slots.map((s) => s.dataset.type), ['comment', 'highlight', 'box-grab'], 'one slot per built-in type');
  for (const t of ['comment', 'highlight', 'box-grab']) assert.ok(listed.includes(t), `the registry lists ${t}`);
  for (const s of slots) {
    const src = s.querySelector('img').getAttribute('src');
    assert.equal(src.split('?')[0], `/api/toolbar/icon/${s.dataset.type}`);
    const icon = await daemon('GET', `/api/toolbar/icon/${s.dataset.type}`);
    assert.equal(icon.status, 200, `${s.dataset.type}'s icon: ${icon.text.slice(0, 80)}`);
    const json = JSON.parse(fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', s.dataset.type, 'element.json'), 'utf8'));
    const want = fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', s.dataset.type, json.icons.light), 'utf8');
    assert.equal(icon.text, want, `${s.dataset.type}: the icon its element.json names`);
  }
  ov.setArmed(null);
  shell.key('c');
  assert.equal(armedType(), 'comment', 'C arms the comment tool');
  const slot = bar.querySelector('.tb-slot[data-type="comment"]');
  assert.ok(slot.classList.contains('armed') && slot.getAttribute('aria-pressed') === 'true', 'the bar shows it active');
  shell.key('c');
  assert.equal(armedType(), null);
});

test('at the phone layout the bar sits in the bottom bar between the up/down arrows and the graph button', async () => {
  shell.setViewport({ width: 390, height: 844, coarse: true });
  await shell.tick();
  try {
    const bb = shell.$('bb-tools');
    assert.equal(bb.parentElement, shell.$('bottombar'));
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(follows(shell.$('bb-down'), bb), 'after the up/down arrows');
    assert.ok(follows(bb, shell.$('bb-graph')), 'before the graph button');
    await eventually(() => !!bb.querySelector('.tb-slot[data-type="comment"]'), 'the comment slot on the phone bar');
  } finally {
    shell.setViewport({ width: 1280, height: 800, coarse: false });
    await shell.tick();
  }
});

test('a previewed older node draws its pins read-only', async () => {
  const n4 = anchoredIds(fixture.n4.comments, fixture.n4.mounts);
  await topbar.previewNode('n4');
  try {
    await eventually(() => W.document.getElementById('main').classList.contains('preview-readonly'), 'previewing n4');
    await eventually(() => n4.every((id) => markersFor(id).length === 1), 'the preview\'s pins');
    comments.setPinMode(true);
    assert.equal(armedType(), null, 'no tool arms on a preview');
    markersFor(n4[0])[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
    // Pins drawn at one place share a marker: its chooser lists each thread.
    const chooser = W.document.querySelector('.pin-pop.pin-chooser');
    if (chooser) shell.click(chooser.querySelector(`.pin-thread-row[data-id="${n4[0]}"]`));
    const thread = W.document.querySelector('.pin-pop');
    assert.ok(thread && thread.classList.contains('pin-readonly'), 'the thread opens read-only');
    assert.equal(thread.querySelector('.pin-reply-text, .pin-del, .pin-share-cb'), null, 'no reply, share or delete');
    comments.closePinPop();
  } finally {
    topbar.returnToActive();
    await shell.tick();
  }
});

test('a document of a comment-only node (preview, export) carries only the resolver kinds U307 splices and draws no element', async () => {
  const node = JSON.parse(fs.readFileSync(path.join(paths.graphDir, 'n1.json'), 'utf8'));
  assert.ok(node.comments.length > 0 && !node.elements, 'n1 is comment-only');
  const kinds = anchorsSrc.kindsOf(node);
  assert.ok(kinds.length > 0 && kinds.length < anchorsSrc.RESOLVER_KINDS.length, `a cut, not the whole resolver: ${kinds}`);
  for (const [what, p] of [['preview', '/preview/node/n1'], ['export', '/api/export/n1']]) {
    const r = await daemon('GET', p);
    assert.equal(r.status, 200, `${what}: ${r.status}`);
    assert.ok(r.text.includes(anchorsSrc.source({ kinds })), `${what}: the resolver cut to ${anchorsSrc.kindKey(kinds)}`);
    assert.ok(!r.text.includes(anchorsSrc.source()), `${what}: never the whole resolver`);
    assert.ok(!/el-layer|pin-marker|el-marker/.test(r.text), `${what}: no element is drawn`);
  }
});

// F.3: comments on markdown, made in the chrome and held by the daemon.
test('comments on markdown: a heading pin reads on section "…" and follows the rewritten heading; a prose pin names its section; Show on page reveals the item', async () => {
  const intro = 'Intro line for the section test.';
  const body = 'Body paragraph text follows here.';
  await claude('POST', '/api/markdown', { id: 'md-sec', text: `${intro}\n\n## Old heading words\n\n${body}` });
  const item = () => W.document.querySelector('[data-md-id="md-sec"]');
  await eventually(() => !!(item() && item().querySelector('h2')), 'the markdown item drawn');
  // jsdom does no layout: the item and its lines get boxes inside the well.
  const MD_BOX = { left: 100, top: 180, width: 600, height: 120, right: 700, bottom: 300, x: 100, y: 180 };
  const LINE = { left: 120, top: 200, width: 300, height: 16, right: 420, bottom: 216, x: 120, y: 200 };
  // A pane's content (inside its shadow root) lies elsewhere on the page, away
  // from the tap: the comment's chain pick (F.6, U406: overlay.js elementsAt)
  // reads these boxes, and the earlier tests' pane pins are not under it.
  const PANE_EL = { left: 900, top: 600, width: 200, height: 40, right: 1100, bottom: 640, x: 900, y: 600 };
  const inPane = (x) => !!(x && x.nodeType === 1 && x.getRootNode && x.getRootNode() !== W.document);
  ov.initOverlay({ rectOf: (x) => (x && x.nodeType === 1 && x.matches && x.matches('[data-md-id]') ? MD_BOX : x && x.startContainer ? LINE : inPane(x) ? PANE_EL : VIEW) });
  const pinOn = async (el, text, pointerId) => {
    ov.setArmed(null);
    shell.key('c');
    assert.equal(armedType(), 'comment');
    gesture(el, 'mouse', pointerId);
    const pop = W.document.querySelector('.pin-pop');
    assert.ok(pop && pop.querySelector('.pin-text'), 'the composer opened');
    pop.querySelector('.pin-text').value = text;
    shell.click(pop.querySelector('.pin-save'));
    let made = null;
    await eventually(async () => {
      made = ((await daemon('GET', '/api/elements?type=comment')).json.elements || []).find((c) => c.text === text);
      return !!made;
    }, `${text} in the daemon`);
    return made;
  };
  try {
    const head = await pinOn(item().querySelector('h2'), 'e2e md heading pin', 71);
    assert.equal(head.record.kind, 'source', 'a source anchor');
    assert.equal(head.record.md, 'md-sec');
    assert.equal(head.record.quote.exact, 'Old heading words');
    assert.deepEqual(head.anchor, { mount: 'md-sec', selector: 'h2', text: 'Old heading words', ordinal: 0, section: 'Old heading words' },
      'the served anchor is the locator, section included');
    assert.equal(head.anchor_label, 'md-sec: on section "Old heading words"');
    const queued = (await daemon('GET', '/api/queue')).json.items.find((it) => it.kind === 'comment' && it.comment_id === head.id);
    assert.ok(queued, 'the shared pin queued');
    assert.equal(queued.origin_mount, 'md-sec');
    assert.match(queued.summary, /^md-sec · on section "Old heading words" · /);
    const onHeading = (id, words) => {
      const m = markersFor(id)[0];
      const g = m && m._group;
      const sc = g && g.range && g.range.startContainer;
      const at = sc && (sc.nodeType === 1 ? sc : sc.parentNode);
      const h = at && at.closest && at.closest('h2');
      return !!(h && h.textContent === words && m.classList.contains('el-hit') && m.style.display === '');
    };
    await eventually(() => onHeading(head.id, 'Old heading words'), 'the heading pin drawn on its heading');
    assert.equal(markersFor(head.id)[0].style.left, `${MD_BOX.left}px`, 'in the item\'s margin');
    // The heading rewritten through a markdown frame: the pin follows it.
    await claude('POST', '/api/markdown', { id: 'md-sec', text: `${intro}\n\n## Brand new title\n\n${body}` });
    await eventually(() => onHeading(head.id, 'Brand new title'), 'the pin placed on the rewritten heading');
    // A pin on prose under it names its section.
    const prose = await pinOn(item().querySelectorAll('p')[1], 'e2e md prose pin', 72);
    assert.equal(prose.record.quote.exact, body);
    assert.equal(prose.anchor.section, 'Brand new title');
    assert.equal(prose.anchor_label, `md-sec: "${body}" — on section "Brand new title"`);
    // Show on page: with no marker for the pin, its item; from the rail card,
    // the pin's place in the item.
    const scrolls = shell.scrolls.length;
    assert.equal(comments.showOnPage('no-such-pin', 'md-sec'), true);
    assert.equal(shell.scrolls.length, scrolls + 1);
    assert.equal(shell.scrolls.at(-1).el, item(), 'the item revealed');
    const show = () => [...W.document.querySelectorAll('#queue-rail .cm-card-show')]
      .find((b) => { const slot = b.closest('.qi-card'); return slot && slot._commentItem && slot._commentItem.comment_id === head.id; });
    await eventually(() => !!show(), 'the heading pin\'s card in the rail', 15000);
    const before = shell.scrolls.length;
    show().click();
    assert.equal(shell.scrolls.length, before + 1, 'the card\'s Show on page scrolled');
    assert.ok(item().contains(shell.scrolls.at(-1).el), 'to the pin, in the markdown item');
  } finally {
    ov.setArmed(null);
    comments.closePinPop();
    ov.initOverlay({ rectOf });
    await claude('POST', '/api/markdown', { id: 'md-sec', remove: true });
  }
});

test('no script-error reached the daemon\'s event log; no interval was armed', () => {
  const errors = d.srv.bus.read({ since: 0, kinds: ['script-error'] }).events;
  assert.deepEqual(errors, [], JSON.stringify(errors).slice(0, 400));
  assert.equal(shell.intervals().length, intervalsAtBoot);
});

