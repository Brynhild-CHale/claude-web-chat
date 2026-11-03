// The chrome loader for an approved element type (annotation engine tranche
// 4, U512; PLAN.md 4A.2; DECISIONS.md B1 review-approve; DRAW@loader; ruling
// U512-U522@draw-module-contract a and U512-U522@asset-accessor a):
// public/app/element-types.js loadPluginTypes, in the real chrome
// (test-support/chrome-shell, booted once).
//
// jsdom runs no module fetched from a URL, so the loader's importer is
// injected (initElementTypes({importModule})); one case hands it a real ES
// module off the disk (test-support/fixtures/element-type/draw.js, written as
// a .mjs under a temp dir and imported by its file:// URL) to hold the
// contract over a real module.
//
// Pinned here:
//   - a listed plug-in row → one import of exactly
//     /api/elements/types/<type>/draw.js?d=<sha256>; the module's default
//     export (the function draw) and its named exports registered through
//     registerElementType as one spec; the listing row's toolbar input/place,
//     never the module's;
//   - an unlisted type, a built-in row, a chat-family row and a row with no
//     digest are never imported; the same digest twice imports once
//     (single-flight); a new digest imports the new URL; a type that leaves
//     the listing is unregistered;
//   - a rejected import, a module whose evaluation throws and a module with
//     no default draw → each element draw-failed with "did not load" and the
//     stand-in mark, nothing thrown out of the overlay, no new draw state;
//   - the reads gate parks before the module's draw runs; the liar control;
//   - ctx.record(id): the GET's record, then the element:<type> frame's (the
//     type re-registered); ctx.asset(rel): the same-origin assets URL with
//     ?d=, null for a rel lib/core/element-assets mediaOf refuses;
//   - while previewing no create runs and the type draws no write affordance.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
// The one tracked draw.js: the contract over a real ES module.
const FIXTURE_DRAW_JS = path.join(__dirname, '..', 'test-support', 'fixtures', 'element-type', 'draw.js');
const { mediaOf } = require('../lib/core/element-assets');

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const BASE = DEFAULT_ROUTES['/api/elements/types'];

const plugRow = (type, extra = {}) => ({
  type, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: false, builtin: false, tier: 'local', pack: 'sticker-pack',
  toolbar: { input: 'taps' }, draw: { sha256: SHA }, ...extra,
});

let shell, W, ET, realOv, anchors, st, bus;
let listing = { ok: true, types: [...BASE.types], reserved: [...BASE.reserved] };
let records = { elements: [], next_cursor: 0 };

// The stub overlay: registerType keeps the spec the gate hands it.
const regs = new Map();
const stub = {
  registerType(type, spec) { regs.set(type, spec); return () => { if (regs.get(type) === spec) regs.delete(type); }; },
  onAnswers() { return () => {}; },
};

// The injected importer: records each URL and answers from `modules`
// (url → a module object, a function returning a promise, or an Error).
const imported = [];
let modules = new Map();
function fakeImport(url) {
  imported.push(url);
  const m = modules.get(url);
  if (m instanceof Error) return Promise.reject(m);
  if (typeof m === 'function') return m();
  if (m) return Promise.resolve(m);
  return Promise.reject(new Error(`no module at ${url}`));
}

async function relist(types, reserved = BASE.reserved) {
  listing = { ok: true, types: [...BASE.types, ...types], reserved: [...reserved] };
  const r = await ET.loadTypes();
  assert.equal(r.ok, true);
  await ET.loadPluginTypes();
}

const container = () => W.document.createElement('div');
const item = (type, id, schema, v = 1) => ({ id, v, type, row: { id, v, type, ...(schema ? { schema } : {}) } });
const group = (type, items) => ({ key: `${type}|hit|${items.map((i) => i.id).join(',')}`, type, kind: 'hit', items, container: container() });
const quiet = async (fn) => {
  const real = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = real; }
};

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => listing,
      '/api/elements?type=sticker': () => records,
    },
  });
  W = shell.window;
  // The boot instance (main.js's box grab, highlight and comment register
  // through it): the importer injected before any plug-in row is listed.
  ET = await shell.importApp('element-types.js');
  ET.initElementTypes({ importModule: fakeImport, overlay: stub, mediaOf });
  realOv = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
  st = await shell.importApp('state.js');
  bus = (await shell.importApp('bus.js')).bus;
});

after(async () => { if (shell) await shell.restore(); });

test('a listed plug-in row: one import of exactly its draw.js URL; default draw plus named create as one spec; the listing\'s input, never the module\'s', async () => {
  const url = `/api/elements/types/sticker/draw.js?d=${SHA}`;
  assert.equal(ET.drawPath('sticker', SHA), url);
  let drew = 0;
  const create = () => {};
  const draw = (g, ctx) => {
    drew++;
    assert.equal(typeof ctx.record, 'function', 'the plug-in ctx carries record');
    assert.equal(typeof ctx.asset, 'function', 'and asset');
    g.container.textContent = g.items.map((it) => it.id).join(' ');
  };
  modules.set(url, { default: draw, create, input: 'selection', place: 'box', host: 'chat', tool: 'comment', extra: 1 });
  await relist([plugRow('sticker')]);
  assert.deepStrictEqual(imported, [url], 'one import, of exactly the route');
  const spec = regs.get('sticker');
  assert.ok(spec, 'registered with the overlay');
  assert.equal(spec.create, create, 'the named create');
  assert.equal(spec.input, 'taps', 'the listing row\'s toolbar input, not the module\'s');
  assert.equal(spec.place, undefined, 'the listing names no place: the module\'s is ignored');
  assert.equal(spec.host, undefined, 'any other export is ignored');
  assert.equal(spec.tool, undefined);
  assert.equal(ET.targetsOf('sticker'), 'items');
  const g = group('sticker', [item('sticker', 'p1')]);
  spec.draw(g, { previewing: false });
  assert.equal(drew, 1, 'the module\'s draw drew the group');
  assert.equal(g.container.textContent, 'p1');
  assert.deepStrictEqual(ET.drawStates().filter((s) => s.type === 'sticker'), []);
  // A second listing at the same digest imports nothing; so does a hello.
  await relist([plugRow('sticker')]);
  await shell.frame(helloFrame({ active: 'n1', mounts: [] }));
  await ET.loadPluginTypes();
  assert.deepStrictEqual(imported, [url]);
  // A new digest imports the new URL; a place the listing names wins too.
  modules.set(ET.drawPath('sticker', SHA2), { default: draw, create, input: 'taps', place: 'glyph' });
  await relist([plugRow('sticker', { toolbar: { input: 'strokes', place: 'box' }, draw: { sha256: SHA2 } })]);
  assert.deepStrictEqual(imported, [url, ET.drawPath('sticker', SHA2)]);
  assert.equal(regs.get('sticker').place, 'box');
  assert.equal(regs.get('sticker').input, 'strokes');
  await relist([]);
});

test('a real ES module off the disk: `export default function draw` plus a named `export function create` loads and draws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-loader-'));
  try {
    // The tracked fixture draw.js, written as a .mjs so Node reads it as an
    // ES module without a package type.
    const file = path.join(dir, 'draw.mjs');
    fs.writeFileSync(file, fs.readFileSync(FIXTURE_DRAW_JS, 'utf8'));
    const real = (url) => import(pathToFileURL(file).href + `?u=${encodeURIComponent(url)}`);
    ET.initElementTypes({ importModule: real });
    await relist([plugRow('disk', { draw: { sha256: SHA } })]);
    await waitUntil(() => regs.get('disk'), { what: 'the module off the disk' });
    const spec = regs.get('disk');
    assert.equal(typeof spec.create, 'function');
    assert.equal(spec.create(), 'made');
    assert.deepStrictEqual({ ...spec.glyph }, { dx: -8, dy: -8, w: 16, h: 16 });
    const g = group('disk', [item('disk', 'd1')]);
    spec.draw(g, {});
    assert.equal(g.container.textContent, 'x', 'the fixture draw.js drew');
  } finally {
    ET.initElementTypes({ importModule: fakeImport });
    fs.rmSync(dir, { recursive: true, force: true });
    await relist([]);
  }
});

test('a rejected import, a module whose evaluation throws, and a module with no default draw: draw-failed with "did not load" and the stand-in, nothing thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-loader-'));
  const states0 = new Set(ET.DRAW_STATES);
  try {
    const file = path.join(dir, 'throws.mjs');
    fs.writeFileSync(file, 'export default function draw() {}\nthrow new Error(\'boom at evaluation\');\n');
    modules.set(ET.drawPath('gone404', SHA), new Error('404 not found'));
    modules.set(ET.drawPath('evalthrow', SHA), () => import(pathToFileURL(file).href));
    modules.set(ET.drawPath('nodefault', SHA), { draw() {}, create() {} });
    await quiet(() => relist([plugRow('gone404'), plugRow('evalthrow'), plugRow('nodefault')]));
    for (const [type, why] of [['gone404', '404 not found'], ['evalthrow', 'boom at evaluation'], ['nodefault', 'default export']]) {
      const spec = regs.get(type);
      assert.ok(spec, `${type}: a stand-in spec is registered`);
      assert.equal(spec.create, undefined, `${type}: nothing creates`);
      const g = group(type, [item(type, `${type}-1`), item(type, `${type}-2`)]);
      await quiet(() => { assert.doesNotThrow(() => spec.draw(g, {})); });
      assert.ok(g.container.classList.contains(ET.STANDIN_CLASS) && g.container.classList.contains('el-generic'), `${type}: the stand-in mark`);
      const s = ET.drawStates().filter((x) => x.type === type);
      assert.equal(s.length, 2, `${type}: each element has a state`);
      for (const x of s) {
        assert.equal(x.state, 'draw-failed');
        assert.ok(x.error.includes('did not load') && x.error.includes(why), `${type}: ${x.error}`);
      }
    }
    assert.deepStrictEqual(new Set(ET.DRAW_STATES), states0, 'no new draw state');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await relist([]);
  }
});

test('never imported: an unlisted type, a built-in row, a chat-family row, a row with no digest; one import in flight per digest; a removed type is unregistered', async () => {
  imported.length = 0;
  const n0 = imported.length;
  await relist([
    plugRow('sticky-builtin', { builtin: true }),
    plugRow('chat-plug', { family: 'chat', anchors: ['message'] }),
    plugRow('nodigest', { draw: undefined }),
    plugRow('nulldigest', { draw: { sha256: null } }),
    plugRow('comment', { builtin: false }), // a reserved name
  ]);
  assert.equal(imported.length, n0, 'nothing imported');
  assert.equal(regs.get('chat-plug'), undefined);
  // Single-flight: a slow import, listed again while on its way.
  let release;
  const slow = new Promise((r) => { release = r; });
  const url = ET.drawPath('slow', SHA);
  modules.set(url, () => slow);
  listing = { ok: true, types: [...BASE.types, plugRow('slow')], reserved: BASE.reserved };
  await ET.loadTypes();
  await ET.loadTypes();
  ET.loadPluginTypes();
  assert.deepStrictEqual(imported.filter((u) => u === url), [url], 'one import while it is on its way');
  release({ default: (g) => { g.container.textContent = 'slow'; } });
  await ET.loadPluginTypes();
  assert.ok(regs.get('slow'));
  // A new digest: the new URL. A digest superseded while on its way is dropped.
  let releaseOld;
  const urlB = ET.drawPath('slow', SHA2);
  modules.set(urlB, () => new Promise((r) => { releaseOld = r; }));
  listing = { ok: true, types: [...BASE.types, plugRow('slow', { draw: { sha256: SHA2 } })], reserved: BASE.reserved };
  await ET.loadTypes();
  const urlC = ET.drawPath('slow', 'c'.repeat(64));
  modules.set(urlC, { default: (g) => { g.container.textContent = 'C'; } });
  listing = { ok: true, types: [...BASE.types, plugRow('slow', { draw: { sha256: 'c'.repeat(64) } })], reserved: BASE.reserved };
  await ET.loadTypes();
  await waitUntil(() => imported.includes(urlC), { what: 'the newest digest' });
  await ET.loadPluginTypes();
  releaseOld({ default: (g) => { g.container.textContent = 'B'; } });
  await new Promise((r) => setTimeout(r, 0));
  const g = group('slow', [item('slow', 's1')]);
  regs.get('slow').draw(g, {});
  assert.equal(g.container.textContent, 'C', 'the superseded digest\'s answer is dropped');
  assert.ok(imported.includes(urlB));
  // An unlisted type's URL is never built: removed from the listing, the
  // type is unregistered and nothing is imported for it.
  const before = imported.length;
  await relist([]);
  assert.equal(regs.get('slow'), undefined, 'unregistered');
  assert.equal(imported.length, before);
  assert.ok(imported.every((u) => /^\/api\/elements\/types\/[a-z0-9-]+\/draw\.js\?d=[0-9a-f]{64}$/.test(u)), 'only the route, ever');
});

test('the reads gate refuses before the module\'s draw runs; the liar control (a module that throws on a schema it claimed) is draw-failed', async () => {
  let ran = 0;
  const seen = [];
  modules.set(ET.drawPath('gated', SHA), {
    default: (g) => {
      ran++;
      for (const it of g.items) {
        seen.push(it.id);
        if (it.row.schema === 'gated@1') throw new Error('cannot read gated@1');
      }
    },
  });
  await relist([plugRow('gated', { schema: 'gated@2', reads: ['gated@2'] })]);
  const parked = group('gated', [item('gated', 'g1', 'gated@1')]);
  regs.get('gated').draw(parked, {});
  assert.equal(ran, 0, 'the module\'s draw is never called for a parked record');
  assert.equal(ET.drawStates().find((s) => s.id === 'g1').state, 'parked');
  assert.ok(parked.container.classList.contains(ET.STANDIN_CLASS));
  // The liar: the listing claims gated@1 too; the module throws on it.
  await relist([plugRow('gated', { schema: 'gated@2', reads: ['gated@1', 'gated@2'] })]);
  const liar = group('gated', [item('gated', 'g1', 'gated@1')]);
  await quiet(() => { assert.doesNotThrow(() => regs.get('gated').draw(liar, {})); });
  assert.equal(ran, 1);
  const s = ET.drawStates().find((x) => x.id === 'g1');
  assert.equal(s.state, 'draw-failed');
  assert.match(s.error, /cannot read gated@1/);
  assert.ok(liar.container.classList.contains(ET.STANDIN_CLASS));
  await relist([]);
});

test('ctx.record(id): the GET\'s record for this viewer, then the element:<type> frame\'s, the type re-registered', async () => {
  records = { elements: [{ id: 'p1', v: 1, type: 'sticker', shared: true, payload: { text: 'hello' } }], next_cursor: 1 };
  const read = [];
  modules.set(ET.drawPath('sticker', SHA), {
    default: (g, ctx) => { for (const it of g.items) { const r = ctx.record(it.id); read.push(r ? r.payload.text : null); } },
  });
  imported.length = 0;
  await relist([plugRow('sticker')]);
  const gets = () => shell.calls.filter((c) => c.url === '/api/elements?type=sticker').length;
  assert.ok(gets() >= 1, 'the type\'s records are read');
  const first = regs.get('sticker');
  first.draw(group('sticker', [item('sticker', 'p1'), item('sticker', 'p9')]), {});
  assert.deepStrictEqual(read, ['hello', null], 'the record, and null for an id it does not hold');
  assert.equal(ET.recordOf('sticker', 'p1').payload.text, 'hello');
  assert.ok(Object.isFrozen(ET.recordOf('sticker', 'p1').payload), 'a draw cannot edit what it reads');
  // The type's frame: the records change, the type is registered again.
  await shell.frame({ type: 'element:sticker', elements: [{ id: 'p1', v: 2, type: 'sticker', shared: true, payload: { text: 'changed' } }] });
  const second = regs.get('sticker');
  assert.notEqual(second, first, 're-registered, so the overlay redraws');
  read.length = 0;
  second.draw(group('sticker', [item('sticker', 'p1', null, 2)]), {});
  assert.deepStrictEqual(read, ['changed']);
  // The same records again redraw nothing.
  await shell.frame({ type: 'element:sticker', elements: [{ id: 'p1', v: 2, type: 'sticker', shared: true, payload: { text: 'changed' } }] });
  assert.equal(regs.get('sticker'), second);
  // A hello re-reads them (the GET answers the daemon's view again).
  const n = gets();
  await shell.frame(helloFrame({ active: 'n1', mounts: [] }));
  await waitUntil(() => gets() > n, { what: 'the hello\'s read' });
  await ET.loadPluginTypes();
  assert.equal(ET.recordOf('sticker', 'p1').payload.text, 'hello');
  assert.equal(imported.length, 1, 'the records move; the module is imported once');
  await relist([]);
  assert.equal(ET.recordOf('sticker', 'p1'), null, 'a type that leaves the listing keeps no records');
});

test('ctx.asset(rel): the same-origin assets URL with ?d=<sha> for an allowed asset; null for a rel mediaOf refuses', async () => {
  let ctxSeen = null;
  modules.set(ET.drawPath('sticker', SHA), { default: (g, ctx) => { ctxSeen = ctx; } });
  await relist([plugRow('sticker')]);
  regs.get('sticker').draw(group('sticker', [item('sticker', 'p1')]), {});
  const asset = ctxSeen.asset;
  assert.equal(asset('mark.png'), `/api/elements/types/sticker/assets/mark.png?d=${SHA}`);
  assert.equal(asset('fonts/hand.woff2'), `/api/elements/types/sticker/assets/fonts/hand.woff2?d=${SHA}`);
  assert.equal(asset('my mark.svg'), `/api/elements/types/sticker/assets/my%20mark.svg?d=${SHA}`);
  for (const bad of ['x.js', 'lib/inline.js', '../draw.js', 'fonts/../x.png', '/mark.png', 'assets/mark.png', 'draw.js', 'page.html', '', null, 7]) {
    assert.equal(asset(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  // No grammar handed in: null (fails closed).
  ET.initElementTypes({ mediaOf: null });
  try {
    assert.equal(asset('mark.png'), null);
  } finally {
    ET.initElementTypes({ mediaOf });
  }
  // A built-in's ctx is the overlay's, untouched.
  let builtinCtx = null;
  const off = ET.registerElementType('comment', { draw: (g, ctx) => { builtinCtx = ctx; } });
  const given = { previewing: false };
  regs.get('comment').draw(group('comment', [item('comment', 'c1')]), given);
  assert.equal(builtinCtx, given);
  off();
  await relist([]);
});

// ── the real overlay: no create and no write affordance while previewing ────
const queue = [];
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  return n;
}
const rectOf = () => ({ left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 });

test('while previewing no create runs and no write affordance is drawn', async () => {
  const M = W.__wcMount;
  await shell.frame(helloFrame({ active: 'n1', mounts: [{ id: 'p1', target: 'main', params: {}, html: '<p class="lead">lead of p1</p>' }] }));
  realOv.initOverlay({ rectOf, raf: fakeRaf });
  ET.initElementTypes({ overlay: realOv });
  const made = [];
  const drawn = [];
  modules.set(ET.drawPath('sticker', SHA), {
    default: (g, ctx) => {
      drawn.push(ctx.previewing);
      g.container.textContent = '';
      const b = W.document.createElement(ctx.previewing ? 'span' : 'button');
      b.className = ctx.previewing ? 'sticker-view' : 'sticker-write';
      g.container.appendChild(b);
    },
    create: (input) => { if (input.phase === 'click') made.push(input.mount); },
  });
  await relist([plugRow('sticker')]);
  const root = M.itemEl(W.document, 'p1').el.shadowRoot;
  const lead = root.querySelector('p.lead');
  const rows = [{ id: 'k1', v: 1, type: 'sticker', anchor: anchors.record(root, lead, { mount: 'p1' }), shared: true, replies: 0 }];
  const tap = (el, id) => {
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true }));
    el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: id }));
  };
  const marker = () => [...W.document.querySelectorAll('#el-layer .el-marker')].find((m) => (m.dataset.elIds || '').split(' ').includes('k1'));
  try {
    // Live: the tool creates, and the type draws its write control.
    realOv.setElements('live', rows);
    await waitUntil(() => { flush(); return marker(); }, { what: 'the live marker' });
    assert.ok(marker().querySelector('button.sticker-write'));
    realOv.setArmed('sticker');
    tap(lead, 71);
    assert.deepStrictEqual(made, ['p1'], 'live, a press creates');
    made.length = 0;
    // Previewing: nothing creates, and the draw is told so.
    st.view.previewing = true;
    bus.emit('preview:node', { id: 'n0', node: { lean_elements: rows } });
    await waitUntil(() => { flush(); return drawn.includes(true) && marker(); }, { what: 'the preview marker' });
    tap(lead, 72);
    assert.deepStrictEqual(made, [], 'no create while previewing');
    assert.equal(marker().querySelector('button'), null, 'no write affordance in a preview');
    assert.ok(marker().querySelector('.sticker-view'));
  } finally {
    realOv.setArmed(null);
    st.view.previewing = false;
    bus.emit('preview:node', { id: null, node: null });
    realOv.setElements('live', []);
    flush();
    ET.initElementTypes({ overlay: stub });
    await relist([]);
  }
});
