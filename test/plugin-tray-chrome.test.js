// The plug-in tray host (annotation engine tranche 4, U514; plan 4A.2;
// TRAY@guard; PRIVATE@create a; M2 a): public/app/element-types.js ctx.tray,
// in the real chrome (test-support/chrome-shell, booted once), with a fixture
// plug-in module loaded the way test/element-loader-chrome.test.js loads one
// (the importer injected: jsdom runs no module fetched from a URL).
//
// Pinned here:
//   - a plug-in type's draw ctx (and its move's) carries `tray`, bound to its
//     type, frozen, the same object every draw; a built-in's ctx carries none;
//     every type's create ctx carries `tray` (the overlay's registerCreateCtx
//     seam, U516), whose add writes the armed type;
//   - tray.add, edit, remove, share and send each send exactly one request,
//     with the device claim, and answer the body ({ok, element?, hint?});
//     tray.add sends the payload as the type made it — no `shared` key the
//     type did not set, at either level of the body;
//   - while a committed node is previewed (contentReadOnly) every tray write
//     answers TRAY_REFUSAL with READONLY_HINT (the topbar's note shows it) and
//     sends nothing;
//   - one tap of a create that writes through ctx.tray is one request.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond, DEFAULT_ROUTES } = require('../test-support/chrome-shell');

const SHA = 'c'.repeat(64);
const BASE = DEFAULT_ROUTES['/api/elements/types'];
const plugRow = (type, extra = {}) => ({
  type, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: false, builtin: false, tier: 'local', pack: 'ink-pack',
  toolbar: { input: 'taps', payload: { keys: ['anchor', 'shared', 'tool'] } }, draw: { sha256: SHA }, ...extra,
});

let shell, W, ET, realOv, st, bus, topbar, deviceKind;
let listing = { ok: true, types: [...BASE.types], reserved: [...BASE.reserved] };

// The stub overlay: registerType keeps the spec the gate hands it.
const regs = new Map();
const stub = {
  registerType(type, spec) { regs.set(type, spec); return () => { if (regs.get(type) === spec) regs.delete(type); }; },
  onAnswers() { return () => {}; },
};

// The fixture plug-in module: its draw and move record the ctx they see; its
// create writes through ctx.tray on a click.
const seenDraw = [];
const seenMove = [];
const seenCreate = [];
const created = [];
const fixture = {
  default: function draw(group, ctx) { seenDraw.push(ctx); group.container.textContent = 'ink'; },
  move(group, ctx) { seenMove.push(ctx); },
  create(input, ctx) {
    seenCreate.push(ctx);
    if (input.phase === 'click') created.push(ctx.tray.add({ anchor: null, payload: { anchor: null, shared: false, tool: 'pen' } }));
  },
};
const modules = new Map();
function fakeImport(url) {
  const m = modules.get(url);
  return m ? Promise.resolve(m) : Promise.reject(new Error(`no module at ${url}`));
}

async function relist(types) {
  listing = { ok: true, types: [...BASE.types, ...types], reserved: [...BASE.reserved] };
  const r = await ET.loadTypes();
  assert.equal(r.ok, true);
  await ET.loadPluginTypes();
}

// The write routes: each answers what the test sets, and records nothing of
// its own (shell.calls is the record).
const answers = new Map();   // 'METHOD url' → a body or a respond()
function writeRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'GET') return { ok: true, elements: [], next_cursor: 0 };
  const a = answers.get(`${method} ${url}`);
  return a === undefined ? respond({ ok: false, error: 'no answer set', hint: 'no answer set' }, { status: 500 }) : a;
}
const writes = () => shell.calls.filter((c) => c.method !== 'GET' && c.url.startsWith('/api/elements') && !c.url.startsWith('/api/elements/types'));

const container = () => W.document.createElement('div');
const item = (type, id) => ({ id, v: 1, type, row: { id, v: 1, type } });
const group = (type, items) => ({ key: `${type}|hit|${items.map((i) => i.id).join(',')}`, type, kind: 'hit', items, container: container() });

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => listing,
      '/api/elements': writeRoute,
      '/api/elements/*': writeRoute,
    },
  });
  W = shell.window;
  ET = await shell.importApp('element-types.js');
  realOv = await shell.importApp('overlay.js');
  st = await shell.importApp('state.js');
  bus = (await shell.importApp('bus.js')).bus;
  topbar = await shell.importApp('topbar.js');
  ({ deviceKind } = await shell.importApp('viewport.js'));
  modules.set(ET.drawPath('ink', SHA), fixture);
});

after(async () => { if (shell) await shell.restore(); });

// The tray the fixture's draw saw, through the stub overlay.
async function drawTray() {
  ET.initElementTypes({ importModule: fakeImport, overlay: stub });
  await relist([plugRow('ink')]);
  const spec = regs.get('ink');
  assert.ok(spec, 'the plug-in type is registered');
  seenDraw.length = 0;
  spec.draw(group('ink', [item('ink', 'p1')]), { previewing: false });
  assert.equal(seenDraw.length, 1, 'its draw ran');
  return { spec, tray: seenDraw[0].tray };
}

test('a plug-in type\'s draw ctx (and its move\'s) carries tray, frozen, bound to its type; a built-in\'s draw ctx does not', async () => {
  assert.deepStrictEqual([...ET.TRAY_MEMBERS], ['add', 'edit', 'remove', 'share', 'send']);
  const { spec, tray } = await drawTray();
  assert.ok(tray && typeof tray === 'object', 'the draw ctx carries tray');
  assert.ok(Object.isFrozen(tray), 'frozen: a draw cannot swap a member');
  assert.deepStrictEqual(Object.keys(tray), [...ET.TRAY_MEMBERS]);
  for (const k of ET.TRAY_MEMBERS) assert.equal(typeof tray[k], 'function', k);
  assert.equal(typeof seenDraw[0].record, 'function', 'beside U512\'s record');
  // The same object on every draw (nothing allocated per draw), and on the move.
  const g = group('ink', [item('ink', 'p1')]);
  spec.draw(g, {});
  assert.strictEqual(seenDraw[1].tray, tray);
  spec.move(g, {});
  assert.strictEqual(seenMove[0].tray, tray, 'the move ctx carries the same tray');
  // A built-in (no loaded module) keeps the overlay's ctx, untouched.
  let plainCtx = null;
  const off = ET.registerElementType('plain-probe', { draw: (grp, ctx) => { plainCtx = ctx; } });
  try {
    await relist([plugRow('ink'), { ...plugRow('plain-probe'), draw: undefined }]);
    const given = { previewing: false };
    regs.get('plain-probe').draw(group('plain-probe', [item('plain-probe', 'x1')]), given);
    assert.strictEqual(plainCtx, given, 'the overlay\'s ctx, untouched');
    assert.equal('tray' in plainCtx, false);
  } finally {
    off();
  }
  await relist([]);
});

// ── the real overlay: the create ctx's tray, and one tap = one request ───────
const queue = [];
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  return n;
}
const rectOf = () => ({ left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 });
const tap = (el, id) => {
  el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true, buttons: 1 }));
  el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true }));
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: id }));
};

test('the create ctx carries tray (the armed type\'s add); one tap of a create writing through it is one request', async () => {
  const M = W.__wcMount;
  await shell.frame(helloFrame({ active: 'n1', mounts: [{ id: 'q1', target: 'main', params: {}, html: '<p class="lead">lead of q1</p>' }] }));
  realOv.initOverlay({ rectOf, raf: fakeRaf });
  ET.initElementTypes({ importModule: fakeImport, overlay: realOv });
  await relist([plugRow('ink')]);
  const lead = M.itemEl(W.document, 'q1').el.shadowRoot.querySelector('p.lead');
  const element = { id: 'p7', v: 1, type: 'ink', shared: false };
  answers.set('POST /api/elements', { ok: true, element });
  seenCreate.length = 0;
  created.length = 0;
  try {
    realOv.setArmed('ink');
    const n0 = writes().length;
    tap(lead, 81);
    assert.ok(seenCreate.length >= 1, 'the create ran');
    const tray = seenCreate[0].tray;
    assert.ok(tray && Object.isFrozen(tray), 'the create ctx carries tray');
    assert.deepStrictEqual(Object.keys(tray), [...ET.TRAY_MEMBERS]);
    assert.equal(created.length, 1, 'the click wrote once');
    const r = await created[0];
    assert.deepStrictEqual(r, { ok: true, element }, 'the answer\'s element');
    const sent = writes().slice(n0);
    assert.equal(sent.length, 1, 'one tap, one request');
    assert.deepStrictEqual([sent[0].method, sent[0].url], ['POST', '/api/elements']);
    assert.deepStrictEqual(sent[0].body, {
      type: 'ink', anchor: null, payload: { anchor: null, shared: false, tool: 'pen' }, device: deviceKind(),
    }, 'the armed type bound in, the payload as made, the device claim');
    // The create ctx's tray answers the armed type at the call: none armed, no request.
    realOv.setArmed(null);
    const n1 = writes().length;
    const none = await tray.add({ payload: { anchor: null, shared: false } });
    assert.equal(none.ok, false);
    assert.match(none.hint, /armed/);
    assert.equal(writes().length, n1, 'no request without an armed type');
  } finally {
    realOv.setArmed(null);
    answers.clear();
    ET.initElementTypes({ overlay: stub });
    await relist([]);
  }
});

test('tray.add, edit, remove, share and send: each exactly one request with the device claim, answering the body', async () => {
  const { tray } = await drawTray();
  const dev = deviceKind();
  const rec = (v, extra = {}) => ({ id: 'p3', v, type: 'ink', shared: false, ...extra });
  answers.set('POST /api/elements', { ok: true, element: rec(1) });
  answers.set('PATCH /api/elements/p3', { ok: true, element: rec(2) });
  answers.set('DELETE /api/elements/p3', { ok: true, removed: 'p3' });
  answers.set('POST /api/elements/p3/send', { ok: true, element: rec(3, { shared: true }), item: { id: 'q9' } });
  const one = async (fn, want) => {
    const n0 = writes().length;
    const r = await fn();
    const sent = writes().slice(n0);
    assert.equal(sent.length, 1, `${want.method} ${want.url}: exactly one request`);
    assert.deepStrictEqual([sent[0].method, sent[0].url], [want.method, want.url]);
    assert.deepStrictEqual(sent[0].body, { ...want.body, device: dev }, `${want.method} ${want.url}: the body, with the device claim`);
    return r;
  };
  try {
    const anchor = { kind: 'element', mount: 'q1', path: [0] };
    let r = await one(() => tray.add({ anchor, payload: { anchor: null, shared: false, tool: 'pen' } }),
      { method: 'POST', url: '/api/elements', body: { type: 'ink', anchor, payload: { anchor: null, shared: false, tool: 'pen' } } });
    assert.deepStrictEqual(r, { ok: true, element: rec(1) });
    // No `shared` the type did not set: not in the payload, not at the top.
    r = await one(() => tray.add({ payload: { anchor: null, tool: 'pencil' } }),
      { method: 'POST', url: '/api/elements', body: { type: 'ink', payload: { anchor: null, tool: 'pencil' } } });
    const last = writes().at(-1).body;
    assert.equal('shared' in last, false);
    assert.equal('shared' in last.payload, false);
    r = await one(() => tray.edit('p3', { tool: 'marker' }, { base_v: 1 }),
      { method: 'PATCH', url: '/api/elements/p3', body: { payload: { tool: 'marker' }, base_v: 1 } });
    assert.deepStrictEqual(r, { ok: true, element: rec(2) });
    await one(() => tray.edit('p3', { tool: 'pen' }), { method: 'PATCH', url: '/api/elements/p3', body: { payload: { tool: 'pen' } } });
    r = await one(() => tray.remove('p3'), { method: 'DELETE', url: '/api/elements/p3', body: {} });
    assert.deepStrictEqual(r, { ok: true, element: null });
    r = await one(() => tray.share('p3', true), { method: 'PATCH', url: '/api/elements/p3', body: { shared: true } });
    assert.equal(r.ok, true);
    await one(() => tray.share('p3', false), { method: 'PATCH', url: '/api/elements/p3', body: { shared: false } });
    // Send to Claude carries the viewer's viewport beside the device claim (U618, PICTURE@viewer-viewport).
    const viewport = { w: Math.round(W.innerWidth || 0), h: Math.round(W.innerHeight || 0), mobile: dev === 'mobile' };
    r = await one(() => tray.send('p3'), { method: 'POST', url: '/api/elements/p3/send', body: { viewport } });
    assert.equal(r.ok, true);
    assert.deepStrictEqual(r.element, rec(3, { shared: true }), 'sendToClaude\'s answer: its element');
    // A refusal answers its status and hint.
    answers.set('PATCH /api/elements/p3', respond({ ok: false, error: 'stale version', hint: 'Someone changed it: reload.' }, { status: 409 }));
    r = await one(() => tray.edit('p3', { tool: 'pen' }, { base_v: 1 }), { method: 'PATCH', url: '/api/elements/p3', body: { payload: { tool: 'pen' }, base_v: 1 } });
    assert.deepStrictEqual(r, { ok: false, status: 409, hint: 'Someone changed it: reload.' });
    // A malformed call sends nothing and answers a hint.
    const n0 = writes().length;
    for (const bad of [
      () => tray.add({ payload: ['pen'] }), () => tray.add(), () => tray.edit('', { tool: 'pen' }), () => tray.edit('p3', null),
      () => tray.remove(null), () => tray.share('p3', 'yes'), () => tray.share(undefined, true),
    ]) {
      const b = await bad();
      assert.equal(b.ok, false);
      assert.equal(typeof b.hint, 'string');
    }
    assert.equal(writes().length, n0, 'no request for a malformed call');
  } finally {
    answers.clear();
    await relist([]);
  }
});

test('while previewing every tray write answers TRAY_REFUSAL with READONLY_HINT and sends nothing', async () => {
  const { tray } = await drawTray();
  answers.set('POST /api/elements', { ok: true, element: { id: 'p4', v: 1, type: 'ink' } });
  st.view.previewing = true;
  try {
    const n0 = shell.calls.length;
    const calls = {
      add: () => tray.add({ payload: { anchor: null, shared: false, tool: 'pen' } }),
      edit: () => tray.edit('p4', { tool: 'pen' }, { base_v: 1 }),
      remove: () => tray.remove('p4'),
      share: () => tray.share('p4', true),
      send: () => tray.send('p4'),
    };
    assert.deepStrictEqual(Object.keys(calls), [...ET.TRAY_MEMBERS]);
    for (const [k, fn] of Object.entries(calls)) {
      // Cleared first, so each member's own note is what the assertion reads.
      const noteText = W.document.querySelector('#reaim-note .reaim-note-text');
      if (noteText) noteText.textContent = '';
      const p = fn();
      assert.ok(p && typeof p.then === 'function', `${k}: a promise`);
      const r = await p;
      assert.strictEqual(r, ET.TRAY_REFUSAL, `${k}: the guard's refusal`);
      assert.deepStrictEqual([r.ok, r.refused, r.hint], [false, 'read-only', topbar.READONLY_HINT]);
      assert.equal(W.document.querySelector('#reaim-note .reaim-note-text').textContent, topbar.READONLY_HINT, `${k}: the one hint shown`);
    }
    assert.equal(shell.calls.length, n0, 'no request at all');
  } finally {
    st.view.previewing = false;
    bus.emit('preview:node', { id: null, node: null });
    answers.clear();
    await relist([]);
  }
  // Live again, the same tray writes.
  answers.set('PATCH /api/elements/p4', { ok: true, element: { id: 'p4', v: 2, type: 'ink' } });
  try {
    await relist([plugRow('ink')]);
    const n0 = writes().length;
    const r = await tray.share('p4', true);
    assert.equal(r.ok, true);
    assert.equal(writes().length, n0 + 1);
  } finally {
    answers.clear();
    await relist([]);
  }
});

// The guard is element-types.js's one rule: the tray never reads the preview
// itself (test/conventions.test.js holds contentReadOnly( to its homes).
test('every tray member goes through trayAction: the source names no contentReadOnly( of its own', async () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'element-types.js'), 'utf8');
  const host = src.slice(src.indexOf('// ── the plug-in tray host'));
  assert.ok(host.length > 0 && host.includes('trayAction(run)'), 'the host runs through trayAction');
  assert.equal(/contentReadOnly\(/.test(host), false, 'no second preview check');
  assert.equal(/\bfetch\(/.test(host), false, 'every write through http.js request');
});
