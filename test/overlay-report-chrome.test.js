// The chrome's report batching (annotation engine PLAN.md 2B.1; U314):
// public/app/overlay-report.js over the overlay's onAnswers seam, in the real
// chrome (test-support/chrome-shell, booted once), its timers live — the
// shell's requestAnimationFrame and setTimeout, never a setInterval.
//
// One chrome, a hello carrying a surface and two fixture panes, then a reset
// carrying their anchored elements (the overlay's live set comes from hello and
// reset). Every case reads the `report` frames the chrome sent:
//   - an answer change → exactly one report, echoing the frame's surface and
//     each pane's gen, batched across mounts; a second pass with nothing
//     changed → none; a flip and a flip back inside the quiet window → none;
//   - hidden (a minimized pane, a pending service pane, the phone sheet at its
//     full stop) is never sent; a removed element is sent orphaned, in ONE
//     report with the re-render's gen (C-8's two halves);
//   - previewing an older node sends nothing, and leaving it sends nothing for
//     unchanged answers;
//   - the gen echo follows the frames (a render frame's gen; a markdown
//     frame's gen for a source anchor);
//   - a confirm (items: []) after a store write whose pass moved nothing, once
//     per store change;
//   - the socket down: nothing sent, nothing queued in the outbox; the next
//     hello re-reports the current answers once;
//   - a reset with a new surface: the next report echoes it and re-sends every
//     watched mount's answers once; a payload carrying the previous surface is
//     dropped;
//   - the minted record: a converted pin-locator@1 element found by its
//     locator, and an exact find of a record whose rows lack the row head,
//     each send `record` once per id@v.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const N = 40;
// Rows as a real pane holds them: one shape, each its own words (a row that
// differs from its neighbours only by a counter is a lookalike the resolver may
// re-find at a neighbour, GT-01's question, not this one).
const WORDS = ['harbor', 'quartz', 'lantern', 'meadow', 'cobalt', 'tundra', 'violet', 'ember', 'saffron', 'glacier',
  'orchard', 'pylon', 'marble', 'thistle', 'canyon', 'falcon', 'juniper', 'magnet', 'nectar', 'obsidian',
  'pewter', 'quiver', 'russet', 'sable', 'timber', 'umber', 'vortex', 'willow', 'zephyr', 'basalt', 'cinder',
  'dahlia', 'estuary', 'fennel', 'garnet', 'heron', 'indigo', 'jasper', 'kestrel', 'lichen', 'mosaic'];
const rowText = (id, i) => `${id}: ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 11 + 3) % WORDS.length]} ${WORDS[(i * 13 + 5) % WORDS.length]} — entry ${i}`;
const itemsHtml = (id, skip = -1) => Array.from({ length: N }, (_, i) => (i === skip ? '' : `<div class="it">${rowText(id, i)}</div>`)).join('');
// Rows with an inner element, so an anchor on the inner one records a row
// (the .it it sits in) and that row's head.
const nestedHtml = (id) => `<div class="list">${Array.from({ length: 12 }, (_, i) => `<div class="it"><span class="w">${rowText(id, i)}</span><b>${i}</b></div>`).join('')}</div>`;
const FIX = (id, { skip = -1, gen = 0, script = '' } = {}) => ({
  id, target: 'main', params: {}, gen,
  html: `<div class="list">${itemsHtml(id, skip)}</div><script>${script}</script>`,
});
const SVC_N = 20;
const svcRows = (drop = -1) => Array.from({ length: SVC_N }, (_, i) => rowText('svc', i)).filter((_, i) => i !== drop);
const SVC = {
  id: 'svc', target: 'main', params: {}, component: 'svc-board', gen: 0,
  html: `<div class="rows"></div><script>
    function draw(rows) {
      var box = root.querySelector('.rows'); box.textContent = '';
      (rows || []).forEach(function (r) { var d = document.createElement('div'); d.className = 'row'; d.textContent = r; box.appendChild(d); });
    }
    draw(store.get('svc_rows'));
    store.subscribe('svc_rows', draw);
  </script>`,
};

let shell, W, M, ov, rep, inst, anchors, view, topbar, sheet, md;
let captured = null;          // the module's onAnswers listener (a payload can be handed to it)
let SURFACE = 0;
let ROWS = [];
let MOUNTS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rootOf = (id) => { const it = M.itemEl(W.document, id); return it && it.el ? it.el.shadowRoot : null; };
const reports = () => shell.sockets.flatMap((s) => s.frames('report'));
const itemsOf = (frames) => frames.flatMap((f) => f.mounts.flatMap((m) => m.items.map((i) => ({ ...i, mount: m.mount, gen: m.gen, surface: f.surface }))));
const rowIds = (mount) => ROWS.filter((r) => r.anchor.mount === mount).map((r) => r.id);

// Quiet: the module has nothing gathered, armed or held, and no delivery for 150 ms.
async function quiet(min = 200) {
  await sleep(min);
  await waitUntil(() => {
    const s = inst.stats();
    return !s.armed && s.holding === 0 && Date.now() - s.last_delivery_at >= 150;
  }, { timeout: 6000, what: 'the report module to go quiet' });
}
// The report frames sent while fn ran (and the module went quiet after it).
async function during(fn, min) {
  const from = reports().length;
  await fn();
  await quiet(min);
  return reports().slice(from);
}

function buildRows() {
  ROWS = [];
  for (const id of ['pa', 'pb', 'svc']) {
    const els = [...rootOf(id).querySelectorAll(id === 'svc' ? '.row' : '.it')];
    els.forEach((el, i) => {
      if (i % 10 !== 0) return;
      ROWS.push({ id: `${id}:${i}`, v: 1, type: 'comment', anchor: anchors.record(rootOf(id), el, { mount: id }), shared: true, replies: 0 });
    });
  }
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: [{ id: 'n0', label: 'n0', parent_id: null, created_at: 0 }, { id: 'n1', label: 'n1', parent_id: 'n0', created_at: 1 }], active: 'n1' },
    },
    init: async (sh) => {
      rep = await sh.importApp('overlay-report.js');
      ov = await sh.importApp('overlay.js');
      // The overlay as it is, its onAnswers listener kept so a test can hand it
      // a payload a pass begun before a reset would carry.
      const wrapped = { ...ov, onAnswers: (fn) => { captured = fn; return ov.onAnswers(fn); } };
      inst = rep.initOverlayReport({ overlay: wrapped });
    },
  });
  W = shell.window;
  M = W.__wcMount;
  anchors = (await shell.importApp('anchors.js')).default;
  ({ view } = await shell.importApp('state.js'));
  topbar = await shell.importApp('topbar.js');
  sheet = await shell.importApp('chat-sheet.js');
  md = await shell.importApp('markdown.js');
  MOUNTS = [FIX('pa'), FIX('pb'), SVC];
  SURFACE = 1000;
  await shell.frame(helloFrame({ mounts: MOUNTS, store: { svc_rows: svcRows() }, surface: SURFACE, elements: [] }));
  buildRows();
  assert.ok(ROWS.every((r) => r.anchor && r.anchor.kind === 'element'));
});

after(async () => { if (inst) inst.stop(); if (shell) await shell.restore(); });

test('the first answers: exactly one report, batched across mounts, echoing the reset\'s surface and each pane\'s gen; all exact, none hidden', async () => {
  SURFACE = 1001;
  const sent = await during(() => shell.frame({ type: 'reset', mounts: MOUNTS, store: { svc_rows: svcRows() }, active: 'n1', lock: null,
    elements: ROWS, surface: SURFACE }), 700);
  assert.equal(sent.length, 1, `one report frame (${sent.length})`);
  const [f] = sent;
  assert.equal(f.type, 'report');
  assert.equal(f.surface, SURFACE, 'the reset\'s surface');
  assert.deepEqual(f.mounts.map((m) => m.mount).sort(), ['pa', 'pb', 'svc'], 'batched across the mounts');
  assert.ok(f.mounts.every((m) => m.gen === 0), 'each pane\'s gen');
  const items = itemsOf(sent);
  assert.deepEqual(items.map((i) => i.id).sort(), ROWS.map((r) => r.id).sort());
  assert.ok(items.every((i) => i.state === 'exact'), JSON.stringify(items.map((i) => i.state)));
  assert.ok(items.every((i) => i.v === 1 && !('el' in i) && !('type' in i)), 'only the report fields');
  assert.ok(items.every((i) => i.tie === undefined || Number.isFinite(i.tie)), 'a tie only as a number');
  assert.equal(shell.intervals().filter((iv) => /report/i.test(String(iv.fn))).length, 0, 'no interval');
});

test('a second pass with nothing changed sends nothing', async () => {
  const sent = await during(async () => {
    M.settle(rootOf('pa'), 'pa', 'test');
    M.settle(rootOf('pb'), 'pb', 'test');
    await shell.tick();
  });
  assert.deepEqual(sent, []);
});

test('an answer that flips and flips back inside the quiet window is never sent', async () => {
  const id = 'pa:10';
  let flips = 0;
  const off = ov.onAnswers((m) => {
    // The module's listener ran first and gathered the orphan; put the row
    // back at once, so the next pass (the next frame) answers exact again.
    if (flips || m.mount !== 'pa' || !m.items.some((i) => i.id === id && i.state === 'orphaned')) return;
    flips += 1;
    setTimeout(() => {
      const list = rootOf('pa').querySelector('.list');
      list.insertBefore(hold, list.children[10]);
      M.settle(rootOf('pa'), 'pa', 'test');
    }, 0);
  });
  const hold = rootOf('pa').querySelectorAll('.it')[10];
  try {
    const sent = await during(async () => {
      hold.remove();
      M.settle(rootOf('pa'), 'pa', 'test');
      await waitUntil(() => flips === 1, { timeout: 4000, what: 'the orphan delivered' });
    });
    assert.deepEqual(sent, [], 'held, never sent');
  } finally { off(); }
});

test('hidden is never sent: a minimized pane, a pending service pane, the phone sheet at its full stop', async () => {
  const from = reports().length;
  // What the overlay delivered meanwhile: each case did read hidden.
  const hiddenFor = new Map();
  const off = ov.onAnswers((m) => {
    if (m.scope !== 'live') return;
    for (const i of m.items) if (i.state === 'hidden') hiddenFor.set(m.mount, (hiddenFor.get(m.mount) || 0) + 1);
  });
  const hiddenAll = async (mounts, what) => {
    await waitUntil(() => mounts.every((id) => (hiddenFor.get(id) || 0) >= rowIds(id).length), { timeout: 4000, what });
  };
  // Minimized (its DOM kept): every anchor reads hidden; restored, exact as sent.
  await shell.frame({ type: 'pane:state', id: 'pa', pane_state: { minimized: true } });
  await hiddenAll(['pa'], 'the minimized pane read hidden');
  await quiet();
  await shell.frame({ type: 'pane:state', id: 'pa', pane_state: { minimized: false } });
  await quiet();
  // The service pending, its rows gone.
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'svc-board' }] } });
  await shell.frame({ type: 'service:trust', key: 'k1', name: 'svc-board' });
  await sleep(100);
  await shell.frame({ type: 'store:patch', patch: { svc_rows: [] } });
  await hiddenAll(['svc'], 'the pending service pane read hidden');
  await quiet();
  await shell.frame({ type: 'store:patch', patch: { svc_rows: svcRows() } });
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
  await shell.frame({ type: 'service:trust:clear', key: 'k1' });
  await quiet();
  shell.setRoutes({});
  // The phone, the sheet at its full stop.
  shell.setViewport(PHONE);
  await shell.tick();
  shell.scrollMetrics(shell.$('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics(shell.$('bottombar'), { rect: { top: 44 + 644, height: 60, width: 390 } });
  try {
    sheet.openSheet();
    sheet.setStop(sheet.sheetState().stops.full);
    hiddenFor.clear();
    await hiddenAll(['pa', 'pb', 'svc'], 'every pane read hidden under the sheet');
    await quiet();
    sheet.setStop(0);
    await quiet();
  } finally {
    sheet.closeSheet({ returnFocus: false });
    shell.setViewport(DESKTOP);
    await shell.tick();
    off();
  }
  await quiet();
  const items = itemsOf(reports().slice(from));
  assert.ok(items.every((i) => i.state !== 'hidden'), 'no hidden item');
  assert.deepEqual(items.filter((i) => i.state === 'orphaned'), [], 'nothing hidden was sent orphaned');
  assert.ok(items.every((i) => i.state === 'exact'), 'only what the confirms and re-stamps carry');
});

test('a removed element is sent orphaned: one report, carrying the re-render\'s gen, the rest re-sent under it', async () => {
  const sent = await during(() => shell.frame({ type: 'render', ...FIX('pb', { skip: 20, gen: 1 }) }), 900);
  assert.equal(sent.length, 1, `one report for the change (${sent.length})`);
  const [f] = sent;
  assert.deepEqual(f.mounts.map((m) => [m.mount, m.gen]), [['pb', 1]], 'the render frame\'s gen');
  const by = new Map(itemsOf(sent).map((i) => [i.id, i]));
  assert.equal(by.get('pb:20').state, 'orphaned', 'the removed row');
  assert.ok(['pb:0', 'pb:10'].every((id) => ['exact', 're-resolved'].includes(by.get(id).state)), 'the rest, under the new gen');
  // Put it back (gen 2).
  const back = await during(() => shell.frame({ type: 'render', ...FIX('pb', { gen: 2 }) }), 300);
  assert.equal(back.length, 1);
  assert.equal(back[0].mounts[0].gen, 2);
  assert.ok(itemsOf(back).every((i) => i.state === 'exact'));
  MOUNTS = [FIX('pa'), FIX('pb', { gen: 2 }), SVC];
});

test('the gen echo follows a markdown frame: a source anchor\'s report carries the item\'s gen', async () => {
  const text = 'A paragraph about harbor quartz lantern and the meadow.';
  await shell.frame({ type: 'markdown', id: 'md-1', text, owner: 'claude', gen: 3, order: ['pa', 'pb', 'svc', 'md-1'], claude_order: ['pa', 'pb', 'svc', 'md-1'] });
  const block = M.itemEl(W.document, 'md-1').el;
  const walker = W.document.createTreeWalker(block, 4);
  let node = null;
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('lantern')) { node = walker.currentNode; break; }
  assert.ok(node, 'the rendered text');
  const range = W.document.createRange();
  const at = node.nodeValue.indexOf('lantern');
  range.setStart(node, at);
  range.setEnd(node, at + 'lantern'.length);
  const rec = anchors.recordSource(block, range, md.sourceMap(text), text, { md: 'md-1' });
  assert.ok(rec && rec.kind === 'source', 'a source record');
  const sent = await during(() => { ov.upsertElements('live', [{ id: 'hl-1', v: 1, type: 'highlight', anchor: rec, shared: true }]); });
  assert.equal(sent.length, 1);
  const m = sent[0].mounts.find((x) => x.mount === 'md-1');
  assert.ok(m, 'the markdown item reported');
  assert.equal(m.gen, 3, 'the markdown frame\'s gen');
  assert.equal(m.items[0].id, 'hl-1');
  assert.equal(m.items[0].state, 'exact');
  ov.removeElements('live', ['hl-1']);
  await shell.frame({ type: 'markdown:remove', id: 'md-1', order: ['pa', 'pb', 'svc'], claude_order: ['pa', 'pb', 'svc'] });
  await quiet();
});

test('previewing an older node sends nothing; leaving it sends nothing for unchanged answers', async () => {
  shell.setRoutes({ '/api/graph/node/n0': { id: 'n0', mounts: [FIX('pa', { skip: 10 })], store: {}, created_at: 0, lean_elements: [] } });
  const sent = await during(async () => {
    await topbar.previewNode('n0');
    await shell.tick();
    assert.equal(view.previewing, true);
    // Something live changes meanwhile: it folds aside, nothing goes — not
    // even a live answer that reached the module while the preview is up.
    await shell.frame({ type: 'store:patch', patch: { unrelated: 1 } });
    captured({ mount: 'pa', scope: 'live', surface: SURFACE, gen: null,
      items: [{ id: 'pa:0', v: 1, type: 'comment', state: 'orphaned', how: 'row-gone', el: null }], report: null });
    await quiet(600);
    topbar.returnToActive();
    await shell.tick();
  }, 700);
  shell.setRoutes({});
  assert.equal(view.previewing, false);
  assert.ok(itemsOf(sent).every((i) => i.state === 'exact'), 'nothing but confirms of what was sent');
  assert.ok(itemsOf(sent).length === 0, `no item re-sent for unchanged answers: ${JSON.stringify(itemsOf(sent))}`);
});

test('a confirm: a store write whose pass moved nothing → one items: [] per reported mount, in one message; none again without a store change', async () => {
  const sent = await during(() => shell.frame({ type: 'store:patch', patch: { unrelated: 2 } }));
  assert.equal(sent.length, 1, 'one message');
  assert.deepEqual(sent[0].mounts.map((m) => m.mount).sort(), ['pa', 'pb', 'svc']);
  assert.ok(sent[0].mounts.every((m) => m.items.length === 0), 'each a confirm');
  assert.equal(sent[0].mounts.find((m) => m.mount === 'pb').gen, 2, 'under the pane\'s gen');
  const again = await during(async () => { M.settle(rootOf('pa'), 'pa', 'test'); M.settle(rootOf('pb'), 'pb', 'test'); await shell.tick(); });
  assert.deepEqual(again, [], 'no second confirm until the next store change');
});

test('a payload carrying the previous surface is dropped, never sent with the current counter', async () => {
  const before = inst.stats().dropped_surface;
  const sent = await during(() => {
    captured({ mount: 'pa', scope: 'live', surface: SURFACE - 1, gen: 1,
      items: [{ id: 'pa:0', v: 1, type: 'comment', state: 'orphaned', how: 'row-gone', tie: null, why: null, el: null }], report: null });
  });
  assert.deepEqual(sent, []);
  assert.equal(inst.stats().dropped_surface, before + 1);
  // A preview scope's payload is never read either.
  const p = await during(() => {
    captured({ mount: 'pa', scope: 'preview', surface: SURFACE, gen: 1,
      items: [{ id: 'pa:0', v: 1, type: 'comment', state: 'orphaned', how: 'row-gone', el: null }], report: null });
  });
  assert.deepEqual(p, []);
});

test('the socket down: nothing is sent and nothing queued in the outbox; the next hello re-sends the current answers once', async () => {
  const sock = shell.socket();
  sock.drop();
  await waitUntil(() => view.conn === 'reconnecting', { timeout: 2000, what: 'conn reconnecting' });
  // The pane loses a row while the socket is down: the pass delivers, nothing goes.
  const gone = rootOf('pa').querySelectorAll('.it')[20];
  gone.remove();
  M.settle(rootOf('pa'), 'pa', 'test');
  await quiet(400);
  assert.equal(inst.stats().awaiting_hello, true);
  await waitUntil(() => shell.socket() !== sock && shell.socket().readyState === 1, { timeout: 4000, what: 'the reconnect' });
  const fresh = shell.socket();
  await shell.frame(helloFrame({ mounts: MOUNTS, store: shell.window.store.get(), surface: SURFACE, elements: ROWS }));
  await quiet(300);
  const sent = fresh.frames('report');
  assert.equal(sent.length, 1, `one report on the new socket, none from the outbox (${sent.length})`);
  const items = itemsOf(sent);
  assert.equal(items.find((i) => i.id === 'pa:20').state, 'orphaned', 'the change made while down');
  assert.deepEqual(new Set(items.map((i) => i.mount)), new Set(['pa', 'pb', 'svc']), 'every watched mount once');
  assert.ok(sock.frames('report').length >= 1);
  // Put the row back with a re-render (gen 1).
  await shell.frame({ type: 'render', ...FIX('pa', { gen: 1 }) });
  await quiet(300);
  MOUNTS = [FIX('pa', { gen: 1 }), FIX('pb', { gen: 2 }), SVC];
});

test('a reset with a new surface: the next report echoes it and re-sends every watched mount\'s answers once', async () => {
  SURFACE += 7;
  const restored = MOUNTS.map((m) => { const { gen, ...rest } = m; return rest; });   // a restored record carries no gen (D18)
  const sent = await during(() => shell.frame({ type: 'reset', mounts: restored, store: shell.window.store.get(), active: 'n1', lock: null,
    elements: ROWS, surface: SURFACE }), 700);
  assert.equal(sent.length, 1, `one report (${sent.length})`);
  assert.equal(sent[0].surface, SURFACE);
  assert.ok(sent[0].mounts.every((m) => m.gen === 0), 'absent gen reads 0');
  const items = itemsOf(sent);
  assert.deepEqual(items.map((i) => i.id).sort(), ROWS.map((r) => r.id).sort(), 'each answer once');
  MOUNTS = restored.map((m) => ({ ...m, gen: 0 }));
});

test('the minted record: a converted pin-locator@1 found by its locator, and an exact find of a record without row heads, each send `record` once per id@v', async () => {
  const el = rootOf('pa').querySelectorAll('.it')[5];
  const locator = { v: 1, kind: 'element', form: 'pin-locator@1', mount: 'pa', path: { selector: 'div.it' },
    fingerprint: { tag: 'div', classes: ['it'], text: el.textContent.trim().slice(0, 120) }, ordinal: 5 };
  await shell.frame({ type: 'render', id: 'pn', target: 'main', params: {}, gen: 0, html: nestedHtml('pn') });
  await quiet();
  const span = rootOf('pn').querySelectorAll('.it')[7].querySelector('.w');
  const full = anchors.record(rootOf('pn'), span, { mount: 'pn' });
  assert.ok(full.rows.length > 0 && full.rows.every((r) => typeof r.head === 'string'), 'the record has row heads');
  const headless = { ...full, rows: full.rows.map(({ head, ...r }) => r) };
  const sent = await during(() => ov.upsertElements('live', [
    { id: 'c-loc', v: 1, type: 'comment', anchor: locator, shared: true },
    { id: 'c-nohead', v: 2, type: 'comment', anchor: headless, shared: true },
  ]));
  assert.equal(sent.length, 1);
  const by = new Map(itemsOf(sent).map((i) => [i.id, i]));
  const loc = by.get('c-loc');
  assert.equal(loc.state, 're-resolved');
  assert.equal(loc.how, 'locator');
  assert.ok(loc.record && loc.record.kind === 'element' && loc.record.mount === 'pa' && !loc.record.form, 'the full record, minted');
  assert.ok(loc.record.fp && loc.record.at, 'an engine record');
  const nh = by.get('c-nohead');
  assert.equal(nh.state, 'exact');
  assert.ok(nh.record && nh.record.rows.every((r) => typeof r.head === 'string'), 'minted with its row heads');
  // A re-render (new gen) re-sends both answers, without a record.
  const again = await during(() => shell.frame({ type: 'render', ...FIX('pa', { gen: 1 }) }), 300);
  const loc2 = itemsOf(again).find((i) => i.id === 'c-loc');
  assert.ok(loc2, 'the answer re-sent under the new gen');
  assert.equal(loc2.record, undefined, 'once per id@v');
  ov.removeElements('live', ['c-loc', 'c-nohead']);
  await shell.frame({ type: 'clear', id: 'pn' });
  await quiet();
});

test('the splitter keeps a message under the caps (200 mounts, 500 items)', async () => {
  assert.equal(rep.MAX_MOUNTS, 200);
  assert.equal(rep.MAX_ITEMS, 500);
  assert.deepEqual(rep.REPORTED_STATES, ['exact', 're-resolved', 'orphaned']);
});
