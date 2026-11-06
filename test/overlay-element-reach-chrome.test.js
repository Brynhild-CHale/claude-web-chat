// An element module's reach in the real chrome (annotation engine tranche 5,
// U632; plan.json tranches[4] 5B.2, CHROME@element-module-reach's engine half,
// DECISIONS.md K.2-245; RULED CHROME@csp C3 = a, U632@allowlist-elements H8 =
// a, U632@post-draw-writes H7 = a, U632@doc-ctx-layer H9 = a,
// U624-U626@composite-granularity H4 = b): test-support/chrome-shell booted
// once; plug-in types loaded through the one loader (public/app/element-types.js
// loadPluginTypes, its importModule seam, as test/overlay-blend-chrome.test.js
// stages them) from listing rows — `reachy` (a glyph type whose draw and move
// write what the marker allowlist refuses), `blendy` (a box type declaring
// composite, writing into group.blend), `broken` (a module whose draw throws:
// the gate's stand-in) and the strokes fixture's `scribble`
// (test-support/element-packs/strokes-fixture, its own draw.js) — beside the
// built-in markers (a comment pin, a highlight handle, a box grab, a chat pin,
// the overlay's generic mark of an unknown type). jsdom does no layout: boxes
// are stubbed per element (shell.scrollMetrics).
//
// Pinned here:
//   - after a draw, only MARKER_ALLOWLIST's elements (svg, g, path, line,
//     polyline, circle, rect in the SVG namespace; div, span in XHTML) remain
//     in a marker, an href/src/srcset/on* attribute is gone, a url( /
//     image-set( / javascript: (ASCII whitespace taken out) / backslash value
//     is gone — on every attribute but the inert text ones (a title keeps the
//     user's words) — and a container style the type made refused is put back
//     to the overlay's placement; what passed stays drawn (never draw-failed);
//     stats().dom_refused counts every node and attribute removed; the type is
//     named once per page load on the console;
//   - the draw ctx and the move ctx carry no `layer` key;
//   - a move that writes a refused node has it removed after the move;
//   - a composite type's group.blend is walked with group.container, its
//     removals counted with the container's;
//   - every built-in marker and the strokes fixture's scribble pass the walk
//     with 0 removals; the walk's time over the scribble's marker is printed
//     (GT-22's per-sample cost row, beside).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { readElementJson, validateElement, elementSrcDir } = require('../lib/packs/elements');
const { ROW_KEYS } = require('../lib/server/element-types');

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const SHA_R = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_X = 'd'.repeat(64);
const SHA_S = 'e'.repeat(64);
const rowOf = (type, sha, toolbar) => ({
  type, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: true, builtin: false, tier: 'local', pack: 'reach-fixture',
  toolbar: { label: type, input: 'taps', ...toolbar }, draw: { sha256: sha },
});
const REACHY_ROW = rowOf('reachy', SHA_R, {});
const BLENDY_ROW = rowOf('blendy', SHA_B, { input: 'strokes', place: 'box', composite: 'multiply' });
const BROKEN_ROW = rowOf('broken', SHA_X, {});

// The strokes fixture's listing row, as the daemon builds it for an approved
// pack type (test/strokes-pack-e2e-chrome.test.js's reading).
const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const SCRIBBLE_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, 'scribble'), 'draw.js'), 'utf8');
function scribbleRow() {
  const read = readElementJson(elementSrcDir(PACK_DIR, 'scribble'));
  assert.ok(read.ok, read.error);
  const checked = validateElement(read.raw, { stageDir: PACK_DIR, name: 'scribble' });
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  const row = { type: 'scribble' };
  const toolbar = {};
  for (const k of Object.keys(checked.descriptor)) {
    if (ROW_KEYS.includes(k)) { if (k !== 'type') row[k] = checked.descriptor[k]; } else toolbar[k] = checked.descriptor[k];
  }
  return { ...row, builtin: false, tier: 'local', pack: 'strokes-fixture', toolbar, draw: { sha256: SHA_S } };
}
const SCRIBBLE_ROW = scribbleRow();

const PANES = [
  { id: 'rp', target: 'main', params: {}, html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"></svg>'
    + '<p class="t">Some prose to highlight here.</p><div class="box">a box</div>' },
  { id: 'bp', target: 'main', params: {}, html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"></svg>' },
  { id: 'sp', target: 'main', params: {}, html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"></svg>' },
];

let shell, W, M, ov, ET, anchors;
let listed = false;
let scribbles = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u632-'));
const TOP = 48;
const wellRect = () => ({ left: 0, top: TOP, width: W.innerWidth, height: W.innerHeight - TOP });
const hostRect = (i) => ({ left: 16, top: TOP + 20 + i * 240, width: 432, height: 230 });
const svgRect = (i) => { const h = hostRect(i); return { left: h.left + 8, top: h.top + 8, width: 400, height: 200 }; };

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const q = (id, sel) => rootOf(id).querySelector(sel);
const byIds = (sel, id) => [...W.document.querySelectorAll(sel)].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const markerOf = (id) => byIds('.el-marker', id)[0] || null;
const blendOf = (id) => byIds('#el-layer-blend .el-blend', id)[0] || null;
const refused = () => ov.stats().dom_refused;

// What each fixture draw and move saw, and the writes the tests switch on.
const seen = { reachy: [], reachyMoves: [], blendy: [], blendyMoves: [] };
const writes = { blendBad: false, moveBad: false };
const el = (ns, name, attrs = {}) => {
  const e = W.document.createElementNS(ns, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
// The reachy draw: one kept svg with a kept path, and everything the
// allowlist refuses — 10 removals: the image, the use, the a, the
// foreignObject, the animate (5 nodes); the onclick, the javascript: fill,
// the url() style, the backslash style, and the container's url() style (5
// attributes).
function reachyModule() {
  return {
    default(g, ctx) {
      seen.reachy.push({ g, ctx });
      const svg = el(SVG_NS, 'svg', { viewBox: '0 0 26 26', class: 'kept' });
      const keep = el(SVG_NS, 'path', { d: 'M0 0 L26 26', class: 'keep', stroke: 'currentColor', 'stroke-width': '2' });
      keep.appendChild(el(SVG_NS, 'animate', { attributeName: 'd', to: 'M0 0 L1 1', dur: '1s' }));
      const onc = el(SVG_NS, 'path', { d: 'M0 26 L26 0', class: 'onc', onclick: 'fetch("http://127.0.0.1:1/z")' });
      const js = el(SVG_NS, 'path', { d: 'M0 13 L26 13', class: 'js', fill: ' java\tscript:void(0)' });
      const img = el(SVG_NS, 'image', { href: 'http://127.0.0.1:1/x?p=private-text', width: '1', height: '1' });
      const use = el(SVG_NS, 'use');
      use.setAttributeNS(XLINK_NS, 'xlink:href', 'http://127.0.0.1:1/u#a');
      const a = el(SVG_NS, 'a', { href: 'javascript:alert(1)' });
      a.appendChild(el(SVG_NS, 'path', { d: 'M1 1' }));
      const fo = el(SVG_NS, 'foreignObject', { width: '10', height: '10' });
      fo.appendChild(el(XHTML_NS, 'img', { src: 'http://127.0.0.1:1/fo' }));
      svg.append(keep, onc, js, img, use, a, fo);
      const bg = el(XHTML_NS, 'span', { class: 'bg', style: 'background:url(http://127.0.0.1:1/y)' });
      bg.textContent = 'x';
      const esc = el(XHTML_NS, 'span', { class: 'esc', style: 'background:\\75 rl(http://127.0.0.1:1/e)' });
      const said = el(XHTML_NS, 'span', { class: 'said', title: 'the user wrote url(x) and javascript: here', 'aria-label': 'see url(y)' });
      g.container.replaceChildren(svg, bg, esc, said);
      g.container.style.backgroundImage = 'url(http://127.0.0.1:1/c)';
    },
    move(g, ctx) {
      seen.reachyMoves.push({ g, ctx });
      if (!writes.moveBad) return;
      writes.moveBad = false;
      g.container.appendChild(el(SVG_NS, 'image', { href: 'http://127.0.0.1:1/m' }));
    },
  };
}
const REACHY_REMOVED = 10;
// The blendy draw: a blending path into group.blend (and, while blendBad, an
// image and an onclick path there too: 2 removals), the rest into the
// container.
function blendyModule() {
  return {
    default(g, ctx) {
      seen.blendy.push({ g, ctx });
      const svgIn = (parent, cls, bad) => {
        const s = el(SVG_NS, 'svg', { viewBox: '0 0 1 1', preserveAspectRatio: 'none' });
        s.appendChild(el(SVG_NS, 'path', { class: cls, d: 'M0 0.5 L1 0.5' }));
        if (bad) {
          s.appendChild(el(SVG_NS, 'image', { href: 'http://127.0.0.1:1/b' }));
          s.appendChild(el(SVG_NS, 'path', { class: 'bonc', d: 'M0 0 L1 1', onclick: 'x()' }));
        }
        parent.replaceChildren(s);
      };
      svgIn(ctx.blend, 'hl', writes.blendBad);
      svgIn(g.container, 'pen', false);
    },
    move(g, ctx) { seen.blendyMoves.push({ g, ctx }); },
  };
}
function brokenModule() {
  return { default() { throw new Error('this fixture draw always fails'); } };
}
async function importFixture(url) {
  if (url.includes(SHA_R)) return reachyModule();
  if (url.includes(SHA_B)) return blendyModule();
  if (url.includes(SHA_X)) return brokenModule();
  if (url.includes(SHA_S)) {
    const file = path.join(tmp, 'scribble-draw.mjs');
    fs.writeFileSync(file, SCRIBBLE_SRC);
    return import(pathToFileURL(file).href);
  }
  throw new Error(`no fixture module for ${url}`);
}

const warned = [];
const realWarn = console.warn;
const realError = console.error;
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const MIRROR = {
  v: 1, enabled: true, now: T0, rev: 2, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: 'cZ', aggregate: { state: 'idle' },
  conversations: [{ id: 'cZ', rev: 1, headless: false, counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
    live: { state: 'idle', since: T0, last_activity_at: T0 } }],
  tasks: [], asks: [],
};
// jsdom has no IntersectionObserver (the chat stream's sentinel).
class StubIO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

before(async () => {
  console.warn = (...a) => { warned.push(a.map(String).join(' ')); };
  // The broken fixture's draw fails on purpose (the gate's stand-in): its line
  // is expected; every other error still reaches the console.
  console.error = (...a) => { if (!/element type 'broken'/.test(String(a[0]))) realError(...a); };
  globalThis.IntersectionObserver = StubIO;
  const base = DEFAULT_ROUTES['/api/elements/types'];
  shell = await bootShell({
    viewport: { width: 1280, height: 800 },
    routes: {
      '/api/elements/types': () => (listed
        ? { ...base, types: [...base.types, REACHY_ROW, BLENDY_ROW, BROKEN_ROW, SCRIBBLE_ROW] } : base),
      // The chat's mirror: one conversation, cZ, with no turns (the chat pin
      // is listed at the stream), as test/chat-pins-chrome.test.js serves it.
      '/api/mirror': () => MIRROR,
      '/api/mirror/conversations/*': () => ({ conversation_id: 'cZ', turns: [], next_before: null, total: 0, rev: 3 }),
      '/api/elements': (url) => {
        if (url.includes('type=scribble')) return { elements: scribbles, next_cursor: 9 };
        return { elements: [], next_cursor: 0 };
      },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ET.initElementTypes({ importModule: importFixture });
  await shell.frame(helloFrame({ mounts: PANES }));
  await shell.tick();
  shell.scrollMetrics(W.document.querySelector('.well-wrap'), { rect: wellRect() });
  shell.scrollMetrics(W.document.getElementById('main'), { rect: { ...wellRect(), height: 3000 } });
  PANES.forEach((p, i) => {
    const host = M.itemEl(W.document, p.id).el;
    host.style.overflow = 'auto';
    shell.scrollMetrics(host, { rect: hostRect(i) });
    shell.scrollMetrics(q(p.id, 'svg.sheet'), { rect: svgRect(i) });
  });
  shell.scrollMetrics(q('rp', 'p.t'), { rect: { left: 30, top: TOP + 236, width: 300, height: 18 } });
  shell.scrollMetrics(q('rp', 'div.box'), { rect: { left: 30, top: TOP + 200, width: 120, height: 20 } });
  // The scribble's one stroke on its pane's svg, served as GET
  // /api/elements?type=scribble answers (flat: the payload's keys beside id).
  scribbles = [{
    id: 's1', type: 'scribble', v: 1, schema: 'scribble@1', seq: 1, shared: true,
    anchor: anchors.record(rootOf('sp'), q('sp', 'svg.sheet'), { mount: 'sp' }),
    tool: 'pen', width: 0.01, colour: 'accent', stride: 4,
    points: [0.1, 0.9, 0.5, 0, 0.3, 0.5, 0.5, 8, 0.6, 0.3, 0.5, 16, 0.9, 0.1, 0.5, 24],
  }];
  listed = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ['reachy', 'blendy', 'broken', 'scribble'].every((t) => ET.typeOf(t)), { timeout: 5000, what: 'the fixture rows' });
  await ET.loadPluginTypes();
  await waitUntil(() => markerOf('s1') && markerOf('s1').querySelector('path[data-el-id="s1"]'),
    { timeout: 5000, what: 'the scribble drawn from its record' });
});

after(async () => {
  console.warn = realWarn;
  console.error = realError;
  delete globalThis.IntersectionObserver;
  try { if (ov) ov.setElements('live', []); } catch {}
  if (shell) await shell.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settle(n = 3) {
  ov.requestDraw();
  for (let i = 0; i < n; i++) await shell.tick();
}
const elAnchor = (mount, sel) => anchors.record(rootOf(mount), q(mount, sel), { mount });

test('every built-in marker and the strokes fixture\'s scribble pass the walk with 0 removals; the walk\'s time over the scribble\'s marker', async (t) => {
  assert.equal(refused(), 0, 'nothing refused before any row');
  const range = W.document.createRange();
  const text = q('rp', 'p.t').firstChild;
  range.setStart(text, 5);
  range.setEnd(text, 10);
  ov.upsertElements('live', [
    { id: 'c1', v: 1, type: 'comment', schema: 'comment@1', shared: true, replies: 0, anchor: elAnchor('rp', 'div.box') },
    { id: 'h1', v: 1, type: 'highlight', schema: 'highlight@1', shared: true, anchor: anchors.recordRange(rootOf('rp'), range, { mount: 'rp' }) },
    { id: 'g1', v: 1, type: 'box-grab', schema: 'box-grab@1', shared: true, anchor: elAnchor('rp', 'p.t') },
    { id: 'u1', v: 1, type: 'not-a-type', schema: 'not-a-type@1', shared: true, anchor: elAnchor('rp', 'p.t') },
    { id: 'x1', v: 1, type: 'broken', schema: 'broken@1', shared: true, anchor: elAnchor('rp', 'p.t') },
    { id: 'b1', v: 1, type: 'blendy', schema: 'blendy@1', shared: true, anchor: elAnchor('bp', 'svg.sheet') },
  ]);
  await waitUntil(() => ['c1', 'h1', 'g1', 'u1', 'x1', 'b1', 's1'].every((id) => markerOf(id)) && seen.blendy.length,
    { timeout: 5000, what: 'every marker drawn' });
  await settle();
  // A chat pin in the chat host's layer (chat-pins.js draw): the followed
  // conversation's, unavailable, so it is listed at the stream.
  const CP = await shell.importApp('chat-pins.js');
  const S = await shell.importApp('chat-state.js');
  const { bus } = await shell.importApp('bus.js');
  const dock = await shell.importApp('chat-dock.js');
  await waitUntil(() => S.mirror.availability === 'ok', { timeout: 5000, what: 'the mirror snapshot' });
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
  S.followConversation('cZ');
  await waitUntil(() => S.followed() === 'cZ' && ov.hosts().some((h) => h.name === 'chat'), { timeout: 5000, what: 'cZ followed, the chat host' });
  CP.applyChatPin({
    id: 'k1', v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [], text: 'a chat pin',
    anchor: { v: 1, kind: 'turn', conversation_id: 'cZ', session_id: 's1', turn_id: 't1', quote: { exact: 'q', prefix: '', suffix: '' } },
    state: 'unavailable',
  });
  await waitUntil(() => byIds('#el-layer-chat .el-marker', 'k1').length === 1, { timeout: 5000, what: 'the chat pin drawn' });
  await settle();
  assert.equal(refused(), 0, 'stats().dom_refused: no built-in, stand-in or fixture draw was refused anything');
  assert.deepStrictEqual(warned.filter((w) => /marker allowlist/.test(w)), [], 'and nothing named on the console');
  const marks = {
    comment: markerOf('c1'), highlight: markerOf('h1'), 'box grab': markerOf('g1'),
    'the generic mark of an unknown type': markerOf('u1'), 'the gate\'s stand-in': markerOf('x1'),
    'chat pin': byIds('#el-layer-chat .el-marker', 'k1')[0], scribble: markerOf('s1'), 'blendy (container)': markerOf('b1'),
    'blendy (group.blend)': blendOf('b1'),
  };
  assert.ok(marks.comment.querySelector('svg path') && marks.comment.querySelector('svg circle'), 'the comment pin\'s svg drawn');
  assert.ok(marks['chat pin'].querySelector('svg path'), 'the chat pin\'s svg drawn');
  assert.ok(marks['the generic mark of an unknown type'].classList.contains('el-generic'));
  assert.ok(marks['the gate\'s stand-in'].classList.contains(ET.STANDIN_CLASS), 'the broken draw\'s stand-in, drawn through the gate');
  for (const [name, m] of Object.entries(marks)) {
    assert.ok(m, `${name}: drawn`);
    const html = m.outerHTML;
    assert.equal(ov.allowlistWalk(m, m.getAttribute('style') || ''), 0, `${name}: 0 removals`);
    assert.equal(m.outerHTML, html, `${name}: the walk changed nothing`);
  }
  // The scribble's marker: its svg and its one path, from the record.
  const s = marks.scribble;
  assert.equal(s.dataset.place, 'box');
  assert.equal(s.querySelectorAll('svg > path[data-el-id="s1"]').length, 1);
  // GT-22 beside: the walk's cost over the fixture's marker.
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) ov.allowlistWalk(s, s.getAttribute('style') || '');
  const per = (performance.now() - t0) / N;
  t.diagnostic(`GT-22 beside: the marker allowlist walk over the scribble's marker (${s.querySelectorAll('*').length + 1} elements): `
    + `${(per * 1000).toFixed(1)} µs per walk (jsdom, ${N} walks); one walk per draw and per move, never per pointer sample`);
  assert.equal(refused(), 0);
});

test('a draw\'s refused nodes and attributes are removed before the frame paints; the kept path stays drawn; counted in stats().dom_refused; the type named once', async () => {
  const n0 = refused();
  const d0 = seen.reachy.length;
  ov.upsertElements('live', [{ id: 'r1', v: 1, type: 'reachy', schema: 'reachy@1', shared: true, anchor: elAnchor('rp', 'svg.sheet') }]);
  await waitUntil(() => markerOf('r1') && seen.reachy.length > d0, { timeout: 5000, what: 'the reachy marker drawn' });
  await settle();
  const m = markerOf('r1');
  const draws = seen.reachy.length - d0;
  assert.equal(refused() - n0, REACHY_REMOVED * draws, `every refused node and attribute counted (${draws} draw(s))`);
  // Only the allowlist's elements remain, in their namespaces.
  for (const e of m.querySelectorAll('*')) {
    const ok = e.namespaceURI === SVG_NS ? ov.MARKER_ALLOWLIST.svg : e.namespaceURI === XHTML_NS ? ov.MARKER_ALLOWLIST.html : [];
    assert.ok(ok.includes(e.localName), `${e.namespaceURI} ${e.localName} is allowed`);
    for (const a of e.attributes) {
      assert.ok(!/^(href|src|srcset)$/i.test(a.localName) && !/^on/i.test(a.localName), `${e.localName}: no ${a.name}`);
    }
  }
  for (const sel of ['image', 'use', 'a', 'foreignObject', 'animate', 'img']) {
    assert.equal(m.getElementsByTagName(sel).length, 0, `no <${sel}>`);
  }
  const keep = m.querySelector('path.keep');
  assert.ok(keep, 'the kept path is drawn');
  assert.equal(keep.getAttribute('d'), 'M0 0 L26 26');
  assert.equal(keep.getAttribute('stroke'), 'currentColor', 'its harmless attributes kept');
  const onc = m.querySelector('path.onc');
  assert.ok(onc, 'the onclick path kept');
  assert.equal(onc.hasAttribute('onclick'), false, 'its onclick removed');
  const js = m.querySelector('path.js');
  assert.ok(js && !js.hasAttribute('fill'), 'a javascript: value split by ASCII whitespace removed');
  const bg = m.querySelector('span.bg');
  assert.ok(bg && bg.textContent === 'x', 'the url() span kept');
  assert.equal(bg.hasAttribute('style'), false, 'its url() style removed');
  assert.equal(m.querySelector('span.esc').hasAttribute('style'), false, 'a style holding a CSS escape removed whole');
  const said = m.querySelector('span.said');
  assert.equal(said.getAttribute('title'), 'the user wrote url(x) and javascript: here', 'an inert title keeps its text');
  assert.equal(said.getAttribute('aria-label'), 'see url(y)');
  // The container: the type's url() put back to the overlay's placement.
  assert.doesNotMatch(m.getAttribute('style') || '', /url\(/i, 'no url() on the container');
  assert.match(m.style.transform, /^translate\(/, 'the container keeps the overlay\'s placement');
  assert.notEqual(m.style.display, 'none', 'the marker stays drawn');
  assert.ok(!m.classList.contains(ET.STANDIN_CLASS), 'never draw-failed');
  assert.deepStrictEqual(ov.failedDraws().filter((f) => f.type === 'reachy'), []);
  assert.deepStrictEqual(ET.drawStates().filter((s) => s.type === 'reachy'), [], 'no draw state');
  // Named once per page load, whatever the redraws.
  ov.upsertElements('live', [{ id: 'r1', v: 2, type: 'reachy', schema: 'reachy@1', shared: true, anchor: elAnchor('rp', 'svg.sheet') }]);
  await waitUntil(() => seen.reachy.length > d0 + draws, { timeout: 5000, what: 'a second draw' });
  await settle();
  assert.ok(refused() - n0 >= REACHY_REMOVED * 2, 'the redraw counted too');
  const lines = warned.filter((w) => /marker allowlist/.test(w));
  assert.deepStrictEqual(lines, ['[web-chat] overlay: the \'reachy\' draw wrote what the marker allowlist refuses; removed'],
    'the type named once');
});

test('the ctx a draw and a move receive carries no layer', async () => {
  await settle();
  assert.ok(seen.reachy.length && seen.reachyMoves.length, 'reachy drawn and moved');
  for (const { ctx } of [...seen.reachy, ...seen.reachyMoves, ...seen.blendy, ...seen.blendyMoves]) {
    assert.equal('layer' in ctx, false, 'no layer key, own or inherited');
    assert.equal(typeof ctx.record, 'function', 'the plug-in ctx otherwise as it was');
  }
  assert.ok(seen.blendy.every(({ ctx }) => ctx.blend), 'ctx.blend as U624 left it');
});

test('a move that writes a refused node has it removed after the move', async () => {
  const m = markerOf('r1');
  assert.ok(m);
  const n0 = refused();
  const mv0 = seen.reachyMoves.length;
  writes.moveBad = true;
  ov.requestDraw();
  await waitUntil(() => !writes.moveBad && seen.reachyMoves.length > mv0, { timeout: 5000, what: 'the move that writes' });
  await settle(1);
  assert.equal(markerOf('r1').getElementsByTagName('image').length, 0, 'the move\'s <image> removed');
  assert.equal(refused() - n0, 1, 'counted');
  assert.ok(markerOf('r1').querySelector('path.keep'), 'the draw\'s kept path still drawn');
  assert.equal(warned.filter((w) => /marker allowlist/.test(w)).length, 1, 'the type was named already: not again');
});

test('a composite type\'s group.blend is walked with group.container: its image and onclick removed, its paths kept, counted together', async () => {
  const n0 = refused();
  const d0 = seen.blendy.length;
  const r0 = seen.reachy.length;   // the page host's rebuild redraws reachy's glyph too
  writes.blendBad = true;
  try {
    ov.upsertElements('live', [{ id: 'b1', v: 2, type: 'blendy', schema: 'blendy@1', shared: true, anchor: elAnchor('bp', 'svg.sheet') }]);
    await waitUntil(() => seen.blendy.length > d0, { timeout: 5000, what: 'blendy redrawn' });
    await settle();
  } finally { writes.blendBad = false; }
  const draws = seen.blendy.length - d0;
  const reachyDraws = seen.reachy.length - r0;
  const b = blendOf('b1');
  const m = markerOf('b1');
  assert.ok(b && m);
  assert.equal(b.getElementsByTagName('image').length, 0, 'group.blend\'s <image> removed');
  const bonc = b.querySelector('path.bonc');
  assert.ok(bonc && !bonc.hasAttribute('onclick'), 'its onclick path kept, the attribute removed');
  assert.ok(b.querySelector('path.hl'), 'its allowed path in group.blend kept');
  assert.ok(m.querySelector('path.pen'), 'group.container\'s path kept');
  assert.equal(refused() - n0, 2 * draws + REACHY_REMOVED * reachyDraws, 'group.blend\'s removals counted with group.container\'s');
  assert.ok(warned.some((w) => w === '[web-chat] overlay: the \'blendy\' draw wrote what the marker allowlist refuses; removed'),
    'the type named');
  assert.equal(ov.stats('page').dom_refused, refused(), 'the page\'s stats');
});
