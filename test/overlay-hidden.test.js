// Hidden versus gone (annotation engine 2A.2): the overlay's hidden-state probe
// (public/app/overlay-hidden.js), the mount-complete mark (public/app/
// mounts.js mountState), the one service-pending signal (public/app/
// service-pending.js) and the store-write re-resolve. The real chrome
// (test-support/chrome-shell, booted once), the overlay and the resolver on the
// shell's frames (its window requestAnimationFrame, U302's grant).
//
// A C-8-shaped run (F4's c8 clause: 0 false orphans, and every removed element
// reported orphaned): three fixture panes and one service-backed pane, an
// anchor on every 10th row of each.
//   - HIDDEN, nothing removed: live; a pane minimized (its DOM kept); the
//     service pending, the stubbed pending list changing mid-run; a pane still
//     mounting (drawing late); a phone with the sheet at its full stop;
//     previewing an older node — not one item onAnswers delivers reads
//     orphaned, and every anchor reads hidden or resolved.
//   - GONE, the positive control: a re-render without an anchored row, a pane
//     whose script deleted one, a service row dropped from the store, a pane
//     taken off the surface — each reads orphaned, minimized or not (a
//     minimized pane that keeps its DOM is resolved first).
//   - the mark: absent until the 'mount' settle, set with that settle's
//     generation, cleared on a re-mount and a removal; within MOUNT_GRACE_MS a
//     missing row is hidden (mounting), after it orphaned.
//   - service-pending.js: one GET at boot through http.js, one more per
//     service:trust and service:trust:clear frame and per hello (a request
//     cleared while the socket was down is dropped by the reconnect's hello),
//     onPendingChange on a change.
//   - the store trigger: a facade write from pane A settles A only; a
//     store:patch frame settles every watched, visible pane once; ten writes in
//     one frame give one settle per pane; the write is heard through store.js
//     onWrite, so a caller holding the store's own `set` from before the
//     overlay was installed still triggers it; a facade write by pane A also
//     settles pane B when B subscribed to a key A wrote (B redrawing without an
//     anchored row reads it orphaned).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

let shell, W, M, ov, oh, sp, anchors, mounts, sheet, topbar, view;
// The chrome store's own `set`, taken as store.js created the store — before
// main.js ran initOverlay (the runtime's createStore wrapped for the boot only).
let earlySet = null;

const N = 40;          // rows per fixture pane
const SVC_N = 30;      // rows the service draws
// Rows as a real pane holds them: one shape, each its own words (a row that
// differs from its neighbours only by a counter is a lookalike the resolver may
// re-find at a neighbour, which is GT-01's question, not this one).
const WORDS = ['harbor', 'quartz', 'lantern', 'meadow', 'cobalt', 'tundra', 'violet', 'ember', 'saffron', 'glacier',
  'orchard', 'pylon', 'marble', 'thistle', 'canyon', 'falcon', 'juniper', 'magnet', 'nectar', 'obsidian',
  'pewter', 'quiver', 'russet', 'sable', 'timber', 'umber', 'vortex', 'willow', 'zephyr', 'basalt', 'cinder',
  'dahlia', 'estuary', 'fennel', 'garnet', 'heron', 'indigo', 'jasper', 'kestrel', 'lichen', 'mosaic'];
const rowText = (id, i) => `${id}: ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 11 + 3) % WORDS.length]} ${WORDS[(i * 13 + 5) % WORDS.length]} — entry ${i}`;
const itemsHtml = (id, skip = -1) => Array.from({ length: N }, (_, i) => (i === skip ? '' : `<div class="it">${rowText(id, i)}</div>`)).join('');
// A fixture pane: its rows, and a hook the test calls to write through the
// pane's own injected store (its facade, which stamps the mount).
const FIX = (id, { skip = -1, script = '' } = {}) => ({
  id, target: 'main', params: {},
  html: `<div class="list">${itemsHtml(id, skip)}</div><script>
    (window.__w = window.__w || {})[mountId] = function (p) { store.set(p); };
    ${script}
  </script>`,
});
const svcRows = (drop = -1) => Array.from({ length: SVC_N }, (_, i) => rowText('svc', i)).filter((_, i) => i !== drop);
// The service-backed pane draws its rows from the store its service fills.
const SVC = {
  id: 'svc', target: 'main', params: {}, component: 'svc-board',
  html: `<div class="rows"></div><script>
    function draw(rows) {
      var box = root.querySelector('.rows'); box.textContent = '';
      (rows || []).forEach(function (r) { var d = document.createElement('div'); d.className = 'row'; d.textContent = r; box.appendChild(d); });
    }
    draw(store.get('svc_rows'));
    store.subscribe('svc_rows', draw);
  </script>`,
};
const FIXTURES = ['fx-a', 'fx-b', 'fx-c'];

const rootOf = (id) => { const it = M.itemEl(W.document, id); return it && it.el ? it.el.shadowRoot : null; };
const rowEls = (id) => [...rootOf(id).querySelectorAll(id === 'svc' ? '.row' : '.it')];

// Every onAnswers message, and the newest state per element id.
const delivered = [];
const last = new Map();      // id → {state, how, scope}
const reasons = new Map();   // id → the probe's reason at its newest delivery
const settles = [];          // {mountId, why}

// The rows: an anchor on every 10th row of each pane.
let ROWS = [];
const rowIds = (mount) => ROWS.filter((r) => r.anchor.mount === mount).map((r) => r.id);
function buildRows() {
  ROWS = [];
  for (const id of [...FIXTURES, 'svc']) {
    rowEls(id).forEach((el, i) => {
      if (i % 10 !== 0) return;
      ROWS.push({ id: `${id}:${i}`, v: 1, type: 'comment', anchor: anchors.record(rootOf(id), el, { mount: id }), shared: true, replies: 0 });
    });
  }
}

const stateOf = (id) => (last.get(id) || {}).state;
const RESOLVED = ['exact', 're-resolved'];
const resolvedAll = (ids) => ids.every((id) => RESOLVED.includes(stateOf(id)));
const statesOf = (ids) => ids.map(stateOf);
// Wait for every anchor of `mount` to read `state` (or a function of the id).
async function mountReads(mount, want, what) {
  const ids = rowIds(mount);
  const f = typeof want === 'function' ? want : () => want;
  await waitUntil(() => ids.every((id) => stateOf(id) === f(id)), { timeout: 4000, what: what || `${mount} to read ${typeof want === 'function' ? 'its states' : want}` });
}
async function allExact(what = 'every anchor exact') {
  await waitUntil(() => ROWS.every((r) => stateOf(r.id) === 'exact'), { timeout: 4000, what: what });
}
// The items delivered since `from`, for a hidden case's tally.
const since = (from) => delivered.slice(from).flatMap((m) => m.items.map((i) => ({ ...i, scope: m.scope, mount: m.mount })));
const orphanedIn = (items) => items.filter((i) => i.state === 'orphaned');

before(async () => {
  const RT = require('../public/mount-runtime.js');
  const ownCreate = RT.createStore;
  RT.createStore = function createStore(seed, publish) {
    const st = ownCreate(seed, publish);
    if (!earlySet && typeof publish === 'function') earlySet = st.set;
    return st;
  };
  try {
    shell = await bootShell({
      routes: {
        '/api/graph': { nodes: [{ id: 'n0', label: 'n0', parent_id: null, created_at: 0 }, { id: 'n1', label: 'n1', parent_id: 'n0', created_at: 1 }], active: 'n1' },
      },
    });
  } finally { RT.createStore = ownCreate; }
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  oh = await shell.importApp('overlay-hidden.js');
  sp = await shell.importApp('service-pending.js');
  anchors = (await shell.importApp('anchors.js')).default;
  mounts = await shell.importApp('mounts.js');
  sheet = await shell.importApp('chat-sheet.js');
  topbar = await shell.importApp('topbar.js');
  ({ view } = await shell.importApp('state.js'));
  M.onSettle((root, mountId, gen, why) => settles.push({ mountId, gen, why }));
  ov.onAnswers((m) => {
    delivered.push(m);
    for (const i of m.items) last.set(i.id, { state: i.state, how: i.how, scope: m.scope });
  });
  // The chrome's own probe, recorded: the same function, its reasons kept.
  ov.setHiddenProbe((q) => {
    const r = oh.hiddenProbe(q);
    reasons.set(q.row.id, r);
    return r;
  });
  await shell.frame(helloFrame({ mounts: FIXTURES.map((id) => FIX(id)).concat([SVC]), store: { svc_rows: svcRows() } }));
  buildRows();
  ov.setElements('live', ROWS);
  // Past every pane's mount grace, then every anchor resolves.
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
  await allExact('the first pass to resolve every anchor');
});

after(async () => { if (shell) await shell.restore(); });

test('the fixture is C-8-shaped: four panes, an anchor on every 10th row, all resolved', () => {
  assert.equal(ROWS.length, 3 * (N / 10) + SVC_N / 10);
  assert.deepEqual(new Set(ROWS.map((r) => r.anchor.mount)), new Set([...FIXTURES, 'svc']));
  assert.equal(oh.MOUNT_GRACE_MS, 500, 'F4\'s settleMs');
  assert.deepEqual(Object.values(oh.HIDDEN_REASONS).sort(), ['minimized', 'mounting', 'preview', 'service-pending', 'sheet']);
  assert.deepEqual(ov.orphans(), []);
});

// ── the mount-complete mark ─────────────────────────────────────────────────

test('the mark: absent until the \'mount\' settle, set with its generation, cleared on a re-mount and a removal', async () => {
  const at = mounts.mountState('fx-a');
  assert.equal(at.complete, true);
  assert.equal(typeof at.at, 'number');
  assert.equal(mounts.mountState('no-such-pane').complete, false);

  const seenAtSettle = [];
  const off = M.onSettle((root, mountId, gen, why) => {
    if (mountId === 'mark' && why === 'mount') seenAtSettle.push({ state: mounts.mountState('mark'), gen });
  });
  try {
    await shell.frame({ type: 'render', ...FIX('mark') });
    assert.equal(seenAtSettle.length, 1);
    assert.equal(seenAtSettle[0].state.complete, false, 'absent while the settle runs: the mark follows it');
    const s1 = mounts.mountState('mark');
    assert.equal(s1.complete, true);
    assert.equal(s1.gen, seenAtSettle[0].gen, 'the settle\'s generation');
    assert.equal(s1.gen, M.generation(rootOf('mark')));
    const firstRec = mounts.panes.get('mark');
    assert.deepEqual(firstRec.mounted, { at: s1.at, gen: s1.gen });

    // A re-mount: the old instance's mark goes, the new one is absent until its own settle.
    await shell.frame({ type: 'render', ...FIX('mark', { skip: 3 }) });
    assert.equal(firstRec.mounted, null, 'the replaced instance carries no mark');
    assert.equal(seenAtSettle.length, 2);
    assert.equal(seenAtSettle[1].state.complete, false, 'the re-mount is incomplete until its settle');
    const s2 = mounts.mountState('mark');
    assert.equal(s2.complete, true);
    assert.equal(s2.gen, seenAtSettle[1].gen);

    // A removal.
    const rec = mounts.panes.get('mark');
    await shell.frame({ type: 'clear', id: 'mark' });
    assert.equal(rec.mounted, null);
    assert.deepEqual(mounts.mountState('mark'), { complete: false, at: null, gen: null });
  } finally { off(); }
});

// ── the rules, alone ────────────────────────────────────────────────────────

test('the rules in F4\'s v2 order, over injected inputs', () => {
  const rec = (extra = {}) => ({ pane_state: { minimized: false }, root: { childElementCount: 3 }, spec: { component: null }, ...extra });
  const base = {
    previewing: () => false, pane: () => rec(), mountState: () => ({ complete: true, at: 0 }),
    pending: () => new Set(), covered: () => false, now: () => 10000,
  };
  const P = (over) => oh.createHiddenProbe({ ...base, ...over });
  const ex = { state: 'exact' };
  const gone = { state: 'orphaned', how: 'locator-none' };
  const q = (answer, scope = 'live', row = { id: 'x', anchor: { kind: 'element', mount: 'm' } }) => ({ row, answer, mount: 'm', scope });
  // 1. the live scope while previewing; the preview scope is not.
  assert.equal(P({ previewing: () => true })(q(gone)), 'preview');
  assert.equal(P({ previewing: () => true })(q(gone, 'preview')), null, 'the preview scope: as answered');
  // 2. no pane record: gone, whatever else holds.
  assert.equal(P({ pane: () => undefined, pending: () => new Set(['c']) })(q(gone)), null);
  // 3. resolves: minimized, then the sheet, else as answered.
  assert.equal(P({ pane: () => rec({ pane_state: { minimized: true } }) })(q(ex)), 'minimized');
  assert.equal(P({ covered: () => true })(q({ state: 're-resolved' })), 'sheet');
  assert.equal(P({})(q(ex)), null);
  // 4. does not resolve.
  assert.equal(P({ pane: () => rec({ pane_state: { minimized: true }, root: { childElementCount: 0 } }) })(q(gone)), 'minimized',
    'a minimize that unmounts');
  assert.equal(P({ pane: () => rec({ pane_state: { minimized: true } }) })(q(gone)), null,
    'a minimized pane that keeps its DOM: the missing element is gone');
  assert.equal(P({ pane: () => rec({ spec: { component: 'c' } }), pending: () => new Set(['c']) })(q(gone)), 'service-pending');
  assert.equal(P({ mountState: () => ({ complete: false, at: null }) })(q(gone)), 'mounting');
  assert.equal(P({ mountState: () => ({ complete: true, at: 9600 }) })(q(gone)), 'mounting', 'inside the grace');
  assert.equal(P({ mountState: () => ({ complete: true, at: 9500 }) })(q(gone)), null, 'the grace is over');
  assert.equal(P({ covered: () => true })(q(gone)), null, 'the sheet hides only what resolves');
  // A source anchor: only the preview rule and the sheet.
  const src = { id: 's', anchor: { kind: 'source', md: 'md-1' } };
  assert.equal(P({ covered: () => true })(q(ex, 'live', src)), 'sheet');
  assert.equal(P({ pane: () => undefined })(q(gone, 'live', src)), null);
  assert.equal(P({ previewing: () => true })(q(gone, 'live', src)), 'preview');
});

// ── HIDDEN: nothing removed ─────────────────────────────────────────────────

test('HIDDEN, a minimized pane: its anchors read hidden (minimized), its DOM kept, nothing orphaned; restored, exact', async () => {
  const from = delivered.length;
  const before = rootOf('fx-a').querySelectorAll('.it').length;
  await shell.frame({ type: 'pane:state', id: 'fx-a', pane_state: { minimized: true } });
  await mountReads('fx-a', 'hidden');
  assert.ok(rowIds('fx-a').every((id) => reasons.get(id) === 'minimized'));
  assert.equal(rootOf('fx-a').querySelectorAll('.it').length, before, 'minimizing keeps the DOM');
  assert.ok(rowIds('fx-b').every((id) => stateOf(id) === 'exact'), 'the other panes untouched');
  await shell.frame({ type: 'pane:state', id: 'fx-a', pane_state: { minimized: false } });
  await mountReads('fx-a', 'exact');
  assert.deepEqual(orphanedIn(since(from)), [], 'no item reads orphaned');
});

test('HIDDEN, the service pending (the list changing mid-run): hidden (service-pending), never orphaned; approved, exact', async () => {
  const from = delivered.length;
  // A trust request appears and the pane loses what its service drew.
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'svc-board' }] } });
  await shell.frame({ type: 'service:trust', key: 'k1', name: 'svc-board' });
  await waitUntil(() => sp.pendingServices().has('svc-board'), { timeout: 4000, what: 'the pending list to name svc-board' });
  await shell.frame({ type: 'store:patch', patch: { svc_rows: [] } });
  await mountReads('svc', 'hidden');
  assert.ok(rowIds('svc').every((id) => reasons.get(id) === 'service-pending'));
  // Mid-run the list changes again: another component, svc-board still waiting.
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ component: 'svc-board' }, { name: 'other' }] } });
  await shell.frame({ type: 'service:trust', key: 'k2', name: 'other' });
  await waitUntil(() => sp.pendingServices().has('other'), { timeout: 4000, what: 'the list to change' });
  // Approved: the service fills the store, then the request clears.
  await shell.frame({ type: 'store:patch', patch: { svc_rows: svcRows() } });
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
  await shell.frame({ type: 'service:trust:clear', key: 'k1' });
  await waitUntil(() => sp.pendingServices().size === 0, { timeout: 4000, what: 'the list to empty' });
  await mountReads('svc', 'exact');
  shell.setRoutes({});
  assert.deepEqual(orphanedIn(since(from)), [], 'no item reads orphaned');
});

test('HIDDEN, still mounting: a pane that draws late reads hidden (mounting) inside the grace, then resolves', async () => {
  const from = delivered.length;
  // fx-b re-rendered empty; its script draws the rows 200 ms later (no settle of its own).
  const late = FIX('fx-b', { script: `setTimeout(function () { root.querySelector('.list').innerHTML = ${JSON.stringify(itemsHtml('fx-b'))}; }, 200);` });
  late.html = late.html.replace(/<div class="list">[\s\S]*?<\/div><script>/, '<div class="list"></div><script>');
  await shell.frame({ type: 'render', ...late });
  assert.equal(rootOf('fx-b').querySelectorAll('.it').length, 0, 'nothing drawn at the mount');
  await mountReads('fx-b', 'hidden');
  assert.ok(rowIds('fx-b').every((id) => reasons.get(id) === 'mounting'));
  // The grace's end settles the pane once more: the late rows are found.
  await mountReads('fx-b', 'exact', 'the late rows to resolve after the grace');
  assert.deepEqual(orphanedIn(since(from)), [], 'no item reads orphaned');
});

test('HIDDEN, a phone with the sheet at its full stop: hidden (sheet); the sheet down, exact', async () => {
  const from = delivered.length;
  shell.setViewport(PHONE);
  await shell.tick();
  shell.scrollMetrics(shell.$('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics(shell.$('bottombar'), { rect: { top: 44 + 644, height: 60, width: 390 } });
  try {
    sheet.openSheet();
    sheet.setStop(sheet.sheetState().stops.full);
    assert.equal(sheet.sheetState().stop, 'full');
    await waitUntil(() => ROWS.every((r) => stateOf(r.id) === 'hidden'), { timeout: 4000, what: 'every anchor hidden under the sheet' });
    assert.ok(ROWS.every((r) => reasons.get(r.id) === 'sheet'));
    sheet.setStop(0);
    await allExact('every anchor exact with the sheet down');
  } finally {
    sheet.closeSheet({ returnFocus: false });
    shell.setViewport(DESKTOP);
    await shell.tick();
  }
  await allExact();
  assert.deepEqual(orphanedIn(since(from)), [], 'no item reads orphaned');
});

test('HIDDEN, previewing an older node: the live scope reads hidden (preview) and nothing live is orphaned; the preview scope follows the rules less that one', async () => {
  const from = delivered.length;
  // The older node shows fx-a without row 20; its lean rows: a present row, and the missing one.
  const kept = ROWS.find((r) => r.id === 'fx-a:10');
  const missing = ROWS.find((r) => r.id === 'fx-a:20');
  shell.setRoutes({
    '/api/graph/node/n0': {
      id: 'n0', mounts: [FIX('fx-a', { skip: 20 })], store: {}, created_at: 0,
      lean_elements: [{ ...kept, id: 'p-kept' }, { ...missing, id: 'p-missing' }],
    },
  });
  try {
    await topbar.previewNode('n0');
    await shell.tick();
    assert.equal(view.previewing, true);
    assert.equal(ov.drawnScopeOf(), 'preview');
    // The probe on a live answer while previewing.
    assert.equal(oh.hiddenProbe({ row: kept, answer: { state: 'orphaned' }, mount: 'fx-a', scope: 'live' }), 'preview');
    await waitUntil(() => stateOf('p-kept') === 'exact', { timeout: 4000, what: 'the preview\'s present row' });
    assert.equal(last.get('p-kept').scope, 'preview');
    await waitUntil(() => stateOf('p-missing') === 'hidden', { timeout: 4000, what: 'the preview\'s missing row, inside the grace' });
    assert.equal(reasons.get('p-missing'), 'mounting');
    await waitUntil(() => stateOf('p-missing') === 'orphaned', { timeout: 4000, what: 'the preview\'s missing row, after the grace' });
    assert.equal(last.get('p-missing').scope, 'preview');
    assert.deepEqual(since(from).filter((i) => i.scope === 'live' && i.state === 'orphaned'), [], 'nothing live is orphaned');
    assert.deepEqual(ov.orphans().map((o) => o.id), ['p-missing'], 'only the preview\'s own gone row');
  } finally {
    topbar.returnToActive();
    await shell.tick();
    shell.setRoutes({});
  }
  assert.equal(ov.drawnScopeOf(), 'live');
  await allExact('the live set back, exact');
});

test('the C-8 tally: across every hidden case, onAnswers never carried orphaned for a live anchor and every anchor is hidden or resolved', () => {
  const live = delivered.flatMap((m) => (m.scope === 'live' ? m.items : []));
  assert.ok(live.length > ROWS.length, 'the cases delivered');
  assert.deepEqual(orphanedIn(live), [], '0 false orphans');
  assert.ok(live.every((i) => ['exact', 're-resolved', 'hidden'].includes(i.state)));
});

// ── GONE: the positive control ──────────────────────────────────────────────

test('GONE, a re-render without an anchored row: hidden (mounting) inside the grace, then orphaned; the rest exact', async () => {
  await shell.frame({ type: 'render', ...FIX('fx-b', { skip: 20 }) });
  await waitUntil(() => stateOf('fx-b:20') === 'hidden', { timeout: 4000, what: 'the gone row inside the grace' });
  assert.equal(reasons.get('fx-b:20'), 'mounting');
  await waitUntil(() => stateOf('fx-b:20') === 'orphaned', { timeout: 4000, what: 'the gone row orphaned after the grace' });
  assert.ok(resolvedAll(['fx-b:0', 'fx-b:10', 'fx-b:30']), `the rest resolved (a row below the gap moved up: re-resolved): ${statesOf(['fx-b:0', 'fx-b:10', 'fx-b:30'])}`);
  assert.ok(ov.orphans().some((o) => o.id === 'fx-b:20'));
  // Put it back.
  await shell.frame({ type: 'render', ...FIX('fx-b') });
  await mountReads('fx-b', 'exact');
});

test('GONE, minimized: a pane whose script deleted a row reads orphaned for that row, hidden (minimized) for the rest', async () => {
  const deleter = FIX('fx-c', { script: 'var gone = root.querySelectorAll(\'.it\')[10]; gone.parentNode.removeChild(gone);' });
  await shell.frame({ type: 'render', ...deleter, pane_state: { minimized: true } });
  assert.ok(rootOf('fx-c').querySelectorAll('.it').length === N - 1, 'the script took the row; the minimized pane keeps its DOM');
  await waitUntil(() => stateOf('fx-c:10') === 'orphaned', { timeout: 5000, what: 'the deleted row orphaned after the grace' });
  assert.deepEqual(statesOf(['fx-c:0', 'fx-c:20', 'fx-c:30']), ['hidden', 'hidden', 'hidden']);
  assert.ok(['fx-c:0', 'fx-c:20', 'fx-c:30'].every((id) => reasons.get(id) === 'minimized'));
  await shell.frame({ type: 'render', ...FIX('fx-c') });
  await mountReads('fx-c', 'exact');
});

test('GONE, a service row dropped from the store: orphaned, minimized or not', async () => {
  await shell.frame({ type: 'store:patch', patch: { svc_rows: svcRows(10) } });
  await waitUntil(() => stateOf('svc:10') === 'orphaned', { timeout: 4000, what: 'the dropped service row' });
  assert.ok(resolvedAll(['svc:0', 'svc:20']), `the rest resolved: ${statesOf(['svc:0', 'svc:20'])}`);
  // Minimized, and another row dropped.
  await shell.frame({ type: 'pane:state', id: 'svc', pane_state: { minimized: true } });
  await waitUntil(() => stateOf('svc:0') === 'hidden', { timeout: 4000, what: 'the minimized pane\'s rows hidden' });
  await shell.frame({ type: 'store:patch', patch: { svc_rows: svcRows(20).filter((r) => r !== rowText('svc', 10)) } });
  await waitUntil(() => stateOf('svc:20') === 'orphaned', { timeout: 4000, what: 'the row dropped from the minimized pane' });
  assert.equal(stateOf('svc:0'), 'hidden');
  assert.equal(stateOf('svc:10'), 'orphaned');
  await shell.frame({ type: 'pane:state', id: 'svc', pane_state: { minimized: false } });
  await shell.frame({ type: 'store:patch', patch: { svc_rows: svcRows() } });
  await mountReads('svc', 'exact');
});

test('GONE, a pane taken off the surface (no live record): its anchors read orphaned', async () => {
  await shell.frame({ type: 'clear', id: 'fx-a' });
  assert.equal(mounts.panes.has('fx-a'), false);
  await mountReads('fx-a', 'orphaned');
  assert.ok(rowIds('fx-a').every((id) => last.get(id).how === 'mount-absent'));
  await shell.frame({ type: 'render', ...FIX('fx-a') });
  await mountReads('fx-a', 'exact');
});

// ── the store trigger ───────────────────────────────────────────────────────

const storeSettles = (from) => settles.slice(from).filter((s) => s.why === 'store').map((s) => s.mountId);
const tally = (ids) => ids.reduce((o, id) => ({ ...o, [id]: (o[id] || 0) + 1 }), {});

test('store trigger: a facade write from pane A settles A only — ten writes in one frame, one settle', async () => {
  await shell.tick(50);
  const from = settles.length;
  for (let i = 0; i < 10; i++) W.__w['fx-a']({ a_key: i });
  await shell.tick(50);
  assert.deepEqual(tally(storeSettles(from)), { 'fx-a': 1 });
});

test('store trigger: a store:patch frame settles every watched visible pane once; ten in one frame, once each; a minimized pane too', async () => {
  await shell.tick(50);
  let from = settles.length;
  await shell.frame({ type: 'store:patch', patch: { k: 1 } });
  await shell.tick(50);
  assert.deepEqual(tally(storeSettles(from)), { 'fx-a': 1, 'fx-b': 1, 'fx-c': 1, svc: 1 });

  from = settles.length;
  for (let i = 0; i < 10; i++) shell.socket().receive({ type: 'store:patch', patch: { k: i } });
  await shell.tick(50);
  assert.deepEqual(tally(storeSettles(from)), { 'fx-a': 1, 'fx-b': 1, 'fx-c': 1, svc: 1 }, 'coalesced per mount per frame');

  // A minimized pane keeps its DOM, so it is still drawn into the document: a
  // store write that took an element from it must read orphaned now.
  await shell.frame({ type: 'pane:state', id: 'fx-c', pane_state: { minimized: true } });
  await shell.tick(50);
  from = settles.length;
  await shell.frame({ type: 'store:patch', patch: { k: 'x' } });
  await shell.tick(50);
  assert.deepEqual(tally(storeSettles(from)), { 'fx-a': 1, 'fx-b': 1, 'fx-c': 1, svc: 1 });
  await shell.frame({ type: 'pane:state', id: 'fx-c', pane_state: { minimized: false } });
  await mountReads('fx-c', 'exact');

  // An unwatched pane is never settled.
  await shell.frame({ type: 'render', ...FIX('fx-free') });
  from = settles.length;
  await shell.frame({ type: 'store:patch', patch: { k: 'y' } });
  W.__w['fx-free']({ b_key: 1 });
  await shell.tick(50);
  assert.equal(storeSettles(from).includes('fx-free'), false);
  await shell.frame({ type: 'clear', id: 'fx-free' });
});

test('store trigger: heard through store.js onWrite — a caller holding the store\'s own set from before initOverlay still settles every watched pane', async () => {
  assert.equal(typeof earlySet, 'function', 'the store\'s set, taken as store.js created it');
  await shell.tick(50);
  const from = settles.length;
  for (let i = 0; i < 10; i++) earlySet.call(W.store, { early_key: i });
  await shell.tick(50);
  assert.deepEqual(tally(storeSettles(from)), { 'fx-a': 1, 'fx-b': 1, 'fx-c': 1, svc: 1 }, 'an unattributed write: every watched pane, once a frame');
  assert.equal(W.store.set, earlySet, 'nothing replaced the store\'s set');
  const src = fs.readFileSync(path.join(REPO, 'public/app/overlay-hidden.js'), 'utf8');
  assert.equal(/wrapStore|__wcHiddenState/.test(src), false, 'no wrap of the store left');
  assert.match(src, /onWrite\(/);
});

// Pane B draws its rows from a key pane A's facade writes: A's write redraws
// B, so B is settled too (K.2-35), coalesced as every store settle is.
const SHARED_N = 12;
const sharedRows = (drop = -1) => Array.from({ length: SHARED_N }, (_, i) => rowText('skb', i)).filter((_, i) => i !== drop);
const SK_B = {
  id: 'sk-b', target: 'main', params: {},
  html: `<div class="rows"></div><script>
    function draw(rows) {
      var box = root.querySelector('.rows'); box.textContent = '';
      (rows || []).forEach(function (r) { var d = document.createElement('div'); d.className = 'row'; d.textContent = r; box.appendChild(d); });
    }
    draw(store.get('shared_rows'));
    store.subscribe('shared_rows', draw);
  </script>`,
};

test('store trigger: a facade write by pane A to a key pane B subscribes to settles B too — B dropping an anchored row reads it orphaned; ten writes, one settle each', async () => {
  const skRows = [];
  try {
    await shell.frame({ type: 'store:patch', patch: { shared_rows: sharedRows() } });
    await shell.frame({ type: 'render', ...FIX('sk-a') });
    await shell.frame({ type: 'render', ...SK_B });
    // Past both panes' mount grace, so a missing row reads gone, not mounting.
    await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
    const bEls = [...rootOf('sk-b').querySelectorAll('.row')];
    assert.equal(bEls.length, SHARED_N);
    for (const i of [2, 5]) skRows.push({ id: `skb:${i}`, v: 1, type: 'comment', anchor: anchors.record(rootOf('sk-b'), bEls[i], { mount: 'sk-b' }), shared: true, replies: 0 });
    const aEl = rootOf('sk-a').querySelector('.it');
    skRows.push({ id: 'ska:0', v: 1, type: 'comment', anchor: anchors.record(rootOf('sk-a'), aEl, { mount: 'sk-a' }), shared: true, replies: 0 });
    ov.upsertElements('live', skRows);
    await waitUntil(() => skRows.every((r) => stateOf(r.id) === 'exact'), { timeout: 4000, what: 'the shared-key rows exact' });
    await shell.tick(50);
    const from = settles.length;
    // Ten facade writes by A in one frame, the last without B's row 5.
    for (let i = 0; i < 9; i++) W.__w['sk-a']({ shared_rows: sharedRows() });
    W.__w['sk-a']({ shared_rows: sharedRows(5) });
    assert.equal(rootOf('sk-b').querySelectorAll('.row').length, SHARED_N - 1, 'B redrew without the row');
    await waitUntil(() => stateOf('skb:5') === 'orphaned', { timeout: 4000, what: 'B\'s dropped row to read orphaned' });
    assert.equal(stateOf('skb:2'), 'exact', 'B\'s other row still exact');
    assert.equal(stateOf('ska:0'), 'exact');
    await shell.tick(50);
    assert.deepEqual(tally(storeSettles(from)), { 'sk-a': 1, 'sk-b': 1 }, 'A\'s own settle, and B\'s, once each for ten writes; no other pane');
    // A write to a key B does not subscribe to settles A alone.
    const from2 = settles.length;
    W.__w['sk-a']({ other_key: 1 });
    await shell.tick(50);
    assert.deepEqual(tally(storeSettles(from2)), { 'sk-a': 1 });
    assert.deepEqual(mounts.subscribedKeys('sk-b'), { keys: new Set(['shared_rows']), all: false }, 'B\'s subscription, read off its facade');
    assert.equal(mounts.subscribedKeys('nobody'), null);
  } finally {
    ov.removeElements('live', skRows.map((r) => r.id));
    await shell.frame({ type: 'clear', id: 'sk-a' });
    await shell.frame({ type: 'clear', id: 'sk-b' });
  }
});

// ── service-pending.js ──────────────────────────────────────────────────────

test('service-pending: one GET at boot through http.js, one more per hello and per trust frame; onPendingChange only on a change', async () => {
  const gets = () => shell.calls.filter((c) => c.url === '/api/services/pending');
  // The boot read the list once (the C-8 run's frames since read it again, one each).
  const src = fs.readFileSync(path.join(REPO, 'public/app/service-pending.js'), 'utf8');
  assert.equal(/\bfetch\(/.test(src), false, 'never a raw fetch');
  assert.match(src, /import \{ request \} from '\.\/http\.js'/);
  const reads = 5;   // boot, before()'s hello (a hello re-reads), the service case's two service:trust and one service:trust:clear
  assert.equal(gets().length, reads, 'one at boot, one per hello and one per trust frame so far');

  const changes = [];
  const off = sp.onPendingChange((m) => changes.push({ pending: [...m.pending].sort(), added: m.added, removed: m.removed }));
  try {
    const n0 = gets().length;
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'alpha' }] } });
    await shell.frame({ type: 'service:trust', key: 'a', name: 'alpha' });
    await waitUntil(() => changes.length === 1, { timeout: 4000, what: 'the change' });
    assert.equal(gets().length, n0 + 1);
    assert.deepEqual(changes[0], { pending: ['alpha'], added: ['alpha'], removed: [] });
    // The same list again: a GET, no change.
    await shell.frame({ type: 'service:trust', key: 'a', name: 'alpha' });
    await waitUntil(() => gets().length === n0 + 2, { timeout: 4000, what: 'the second GET' });
    await shell.tick(20);
    assert.equal(changes.length, 1, 'an unchanged list tells nobody');
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await shell.frame({ type: 'service:trust:clear', key: 'a' });
    await waitUntil(() => changes.length === 2, { timeout: 4000, what: 'the clear' });
    assert.equal(gets().length, n0 + 3);
    assert.deepEqual(changes[1], { pending: [], added: [], removed: ['alpha'] });
    assert.deepEqual([...sp.pendingServices()], []);
    // A read the daemon refuses leaves the list as it was.
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'beta' }] } });
    await sp.refreshPending();
    shell.setRoutes({ '/api/services/pending': () => { throw new TypeError('Failed to fetch'); } });
    assert.equal(await sp.refreshPending(), null);
    assert.deepEqual([...sp.pendingServices()], ['beta']);
  } finally {
    off();
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await sp.refreshPending();
    shell.setRoutes({});
  }
});

test('the drawer reads the one signal: drawer.js has no read of its own', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/drawer.js'), 'utf8');
  assert.equal(src.includes('/api/services/pending'), false, 'drawer.js no longer names the route');
  assert.match(src, /from '\.\/service-pending\.js'/);
});

test('service-pending: of two overlapping reads, the one started later wins, whichever answers last', async () => {
  // The first read is held until the second has answered; its older answer
  // must not overwrite the newer list (a burst of trust frames on a reconnect).
  let releaseFirst;
  const held = new Promise((r) => { releaseFirst = r; });
  let n = 0;
  shell.setRoutes({
    '/api/services/pending': async () => {
      n += 1;
      if (n === 1) { await held; return { ok: true, pending: [{ name: 'older' }] }; }
      return { ok: true, pending: [{ name: 'newer' }] };
    },
  });
  try {
    const first = sp.refreshPending();
    const second = sp.refreshPending();
    await second;
    assert.deepEqual([...sp.pendingServices()], ['newer']);
    releaseFirst();
    await first;
    assert.deepEqual([...sp.pendingServices()], ['newer'], 'the older read, answering last, does not overwrite the newer list');
  } finally {
    releaseFirst();
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await sp.refreshPending();
    shell.setRoutes({});
  }
});

test('service-pending: a request cleared while the socket was down (no clear frame) is dropped by the reconnect\'s hello', async () => {
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'svc-board' }] } });
  try {
    await sp.refreshPending();
    assert.deepEqual([...sp.pendingServices()], ['svc-board']);
    // Approved while the socket was down: the list empties, and no frame says so.
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await shell.tick(20);
    assert.deepEqual([...sp.pendingServices()], ['svc-board'], 'nothing re-read it yet');
    await shell.frame(helloFrame({ mounts: FIXTURES.map((id) => FIX(id)).concat([SVC]), store: { svc_rows: svcRows() } }));
    await waitUntil(() => sp.pendingServices().size === 0, { timeout: 4000, what: 'the hello\'s read to empty the list' });
  } finally {
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await sp.refreshPending();
    shell.setRoutes({});
  }
});
