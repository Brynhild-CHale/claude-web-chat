// A pane's own DOM removal re-resolves its elements (annotation engine 2A.2,
// U303a; DECISIONS.md K.2-91 and K.2-93): public/app/overlay-hidden.js
// observes each watched pane's shadow root, and holds a service pane whose
// approval just cleared hidden through the service-start grace. The real
// chrome (test-support/chrome-shell, booted once), the overlay and the
// resolver on the shell's frames (its window requestAnimationFrame), driven
// the way test/overlay-hidden.test.js drives U303.
//
//   (a) a pane whose script removes an anchored element after its mount
//       settle (F4 c8-del: 150 ms after the mount; and after the mount grace)
//       reads orphaned at the next settle — why 'pane-dom' — and onAnswers
//       delivers it once;
//   (b) removing a node no anchor holds queues one settle and moves no answer;
//       a text node inside an anchored element settles, one outside does not,
//       nor does the chrome's own node (data-wc-chrome);
//   (c) ten removals in one frame give one settle; added nodes alone none;
//   (d) one observer per watched pane: none for an unwatched one, a re-render
//       re-attaches exactly once, a pane leaving the set (its rows gone, or
//       the pane taken off) is disconnected, zero when the panes are gone;
//   (e) the service-start grace: a service pane pending, then
//       service:trust:clear with its rows not drawn yet — every anchor reads
//       hidden 'service-pending' through the grace with 0 orphaned
//       deliveries; a store write inside the grace draws the rows → resolved;
//       with no write, the grace's end reads them orphaned.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

let shell, W, M, ov, oh, sp, anchors, mounts;

const N = 12;
// Rows as a real pane holds them, each its own words (rows that differ only by
// a counter are lookalikes the resolver may re-find at a neighbour: GT-01's
// question, not this one).
const WORDS = ['harbor', 'quartz', 'lantern', 'meadow', 'cobalt', 'tundra', 'violet', 'ember', 'saffron', 'glacier',
  'orchard', 'pylon', 'marble', 'thistle', 'canyon', 'falcon', 'juniper', 'magnet', 'nectar', 'obsidian',
  'pewter', 'quiver', 'russet', 'sable', 'timber', 'umber', 'vortex', 'willow', 'zephyr', 'basalt', 'cinder',
  'dahlia', 'estuary', 'fennel', 'garnet', 'heron', 'indigo', 'jasper', 'kestrel', 'lichen', 'mosaic'];
const rowText = (id, i) => `${id}: ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 11 + 3) % WORDS.length]} ${WORDS[(i * 13 + 5) % WORDS.length]} — entry ${i}`;
const itemsHtml = (id) => Array.from({ length: N }, (_, i) => `<div class="it">${rowText(id, i)}</div>`).join('');
// A pane: its rows, plus hooks its own script exposes, so a removal is the
// pane's own code acting on its own shadow root (no store write, no settle).
const PANE = (id, { script = '' } = {}) => ({
  id, target: 'main', params: {},
  html: `<div class="list">${itemsHtml(id)}</div><script>
    (window.__pd = window.__pd || {})[mountId] = {
      remove: function (i) { var el = root.querySelectorAll('.it')[i]; el.parentNode.removeChild(el); },
      removeMany: function (n) { for (var k = 0; k < n; k++) { var el = root.querySelector('.extra'); if (el) el.parentNode.removeChild(el); } },
      add: function (n) { var box = root.querySelector('.list'); for (var k = 0; k < n; k++) { var d = document.createElement('div'); d.className = 'extra'; d.textContent = 'extra ' + k; box.appendChild(d); } },
      dropText: function (i) { var el = root.querySelectorAll('.it')[i]; el.removeChild(el.firstChild); },
      chrome: function () { var s = document.createElement('style'); s.setAttribute('data-wc-chrome', 'test'); s.textContent = '.x{}'; root.appendChild(s); return s; },
    };
    ${script}
  </script>`,
});
// A service-backed pane: its rows come from the store its service fills.
const SVC = {
  id: 'sv', target: 'main', params: {}, component: 'sv-board',
  html: `<div class="rows"></div><script>
    function draw(rows) {
      var box = root.querySelector('.rows'); box.textContent = '';
      (rows || []).forEach(function (r) { var d = document.createElement('div'); d.className = 'row'; d.textContent = r; box.appendChild(d); });
    }
    draw(store.get('sv_rows'));
    store.subscribe('sv_rows', draw);
  </script>`,
};
const svRows = () => Array.from({ length: N }, (_, i) => rowText('sv', i));

const rootOf = (id) => { const it = M.itemEl(W.document, id); return it && it.el ? it.el.shadowRoot : null; };
const itemsOf = (id) => [...rootOf(id).querySelectorAll(id === 'sv' ? '.row' : '.it')];

const delivered = [];        // every onAnswers message, with when it came
const last = new Map();      // element id → newest state
const reasons = new Map();   // element id → the probe's reason at its newest reading
const settles = [];          // {mountId, why, t}

const stateOf = (id) => (last.get(id) || {}).state;
const itemsSince = (from) => delivered.slice(from).flatMap((m) => m.items.map((i) => ({ ...i, mount: m.mount, t: m.t })));
const settlesSince = (from, mount, why) => settles.slice(from).filter((s) => s.mountId === mount && (!why || s.why === why));
const frames = (n = 3) => shell.tick(20 * n);

// Anchors on rows `at` of pane `id`, set live (upserted).
function anchorRows(id, at) {
  const els = itemsOf(id);
  const rows = at.map((i) => ({ id: `${id}:${i}`, v: 1, type: 'comment', anchor: anchors.record(rootOf(id), els[i], { mount: id }), shared: true, replies: 0 }));
  ov.upsertElements('live', rows);
  return rows;
}
const watchedMounts = () => {
  const out = new Set();
  for (const r of ov.elementsOf('live')) if (r.anchor && r.anchor.mount != null && mounts.panes.has(r.anchor.mount)) out.add(r.anchor.mount);
  return out;
};
const sorted = (xs) => [...xs].sort();

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 0 }], active: 'n1' },
      '/api/services/pending': { ok: true, pending: [] },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  oh = await shell.importApp('overlay-hidden.js');
  sp = await shell.importApp('service-pending.js');
  anchors = (await shell.importApp('anchors.js')).default;
  mounts = await shell.importApp('mounts.js');
  M.onSettle((root, mountId, gen, why) => settles.push({ mountId, why, t: Date.now() }));
  ov.onAnswers((m) => {
    delivered.push({ ...m, t: Date.now() });
    for (const i of m.items) last.set(i.id, { state: i.state, how: i.how });
  });
  ov.setHiddenProbe((q) => {
    const r = oh.hiddenProbe(q);
    reasons.set(q.row.id, r);
    return r;
  });
  await shell.frame(helloFrame({ mounts: [PANE('pa'), PANE('pb'), PANE('free')], store: { sv_rows: svRows() } }));
  anchorRows('pa', [0, 4, 8]);
  anchorRows('pb', [2, 6]);
  // Past every pane's mount grace, then every anchor resolves.
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
  await waitUntil(() => ['pa:0', 'pa:4', 'pa:8', 'pb:2', 'pb:6'].every((id) => stateOf(id) === 'exact'), { timeout: 4000, what: 'every anchor exact' });
});

after(async () => { if (shell) await shell.restore(); });

test('the reasons: RESETTLE_WHY gains pane-dom; the probe reads the service-start grace through its injected input', () => {
  assert.equal(oh.RESETTLE_WHY.PANE_DOM, 'pane-dom');
  assert.deepEqual(Object.values(oh.RESETTLE_WHY).sort(), ['hidden-state', 'pane-dom', 'store']);
  const rec = (component) => ({ pane_state: { minimized: false }, root: { childElementCount: 3 }, spec: { component } });
  const base = { previewing: () => false, mountState: () => ({ complete: true, at: 0 }), pending: () => new Set(), covered: () => false, now: () => 10000 };
  const q = (answer) => ({ row: { id: 'x', anchor: { kind: 'element', mount: 'm' } }, answer, mount: 'm', scope: 'live' });
  const gone = { state: 'orphaned', how: 'locator-none' };
  const P = (over) => oh.createHiddenProbe({ ...base, ...over });
  assert.equal(P({ pane: () => rec('c'), serviceGrace: (id) => id === 'm' })(q(gone)), 'service-pending', 'inside the grace');
  assert.equal(P({ pane: () => rec('c'), serviceGrace: () => false })(q(gone)), null, 'the grace over: gone');
  assert.equal(P({ pane: () => rec(null), serviceGrace: () => true })(q(gone)), null, 'no component, no grace');
  assert.equal(P({ pane: () => rec('c'), serviceGrace: () => true })(q({ state: 'exact' })), null, 'a resolved element reads as answered');
});

// ── (a) the defect ──────────────────────────────────────────────────────────

test('(a) a script removing an anchored element 150 ms after its mount settle (F4 c8-del): hidden (mounting), then orphaned at the grace\'s settle, delivered once', async () => {
  const from = delivered.length;
  const s0 = settles.length;
  // pa re-rendered with a script that deletes row 4 on a timer, writing nothing.
  await shell.frame({ type: 'render', ...PANE('pa', { script: 'setTimeout(function () { var el = root.querySelectorAll(\'.it\')[4]; el.parentNode.removeChild(el); }, 150);' }) });
  assert.equal(itemsOf('pa').length, N, 'nothing removed at the mount settle');
  await waitUntil(() => itemsOf('pa').length === N - 1, { timeout: 4000, what: 'the script to remove the row' });
  await waitUntil(() => settlesSince(s0, 'pa', 'pane-dom').length >= 1, { timeout: 4000, what: 'a pane-dom settle' });
  await waitUntil(() => stateOf('pa:4') === 'orphaned', { timeout: 4000, what: 'the removed row orphaned after the grace' });
  await shell.tick(200);
  const mine = itemsSince(from).filter((i) => i.id === 'pa:4');
  assert.equal(mine.filter((i) => i.state === 'orphaned').length, 1, 'onAnswers delivered it orphaned once');
  assert.ok(mine.some((i) => i.state === 'hidden'), 'inside the mount grace it read hidden first');
  assert.equal(settlesSince(s0, 'pa', 'pane-dom').length, 1, 'one pane-dom settle');
  assert.equal(stateOf('pa:0'), 'exact');
  assert.ok(['exact', 're-resolved'].includes(stateOf('pa:8')), `the row below the gap still resolves: ${stateOf('pa:8')}`);
  // Put it back.
  await shell.frame({ type: 'render', ...PANE('pa') });
  await waitUntil(() => stateOf('pa:4') === 'exact', { timeout: 4000, what: 'pa whole again' });
});

test('(a) a script removing an anchored element after the mount grace: orphaned at the next frame\'s settle (why pane-dom), delivered once', async () => {
  await shell.frame({ type: 'render', ...PANE('pa', { script: `setTimeout(function () { var el = root.querySelectorAll('.it')[8]; el.parentNode.removeChild(el); }, ${oh.MOUNT_GRACE_MS + 150});` }) });
  await waitUntil(() => stateOf('pa:8') === 'exact', { timeout: 4000, what: 'the re-mounted row exact' });
  const from = delivered.length;
  const s0 = settles.length;
  await waitUntil(() => itemsOf('pa').length === N - 1, { timeout: 4000, what: 'the script to remove the row after the grace' });
  const removedAt = Date.now();
  await waitUntil(() => stateOf('pa:8') === 'orphaned', { timeout: 4000, what: 'the removed row orphaned' });
  const firstSettle = settlesSince(s0, 'pa')[0];
  assert.ok(firstSettle, 'the pane was settled');
  assert.equal(firstSettle.why, 'pane-dom', 'by its own DOM change');
  assert.ok(firstSettle.t - removedAt < 1000, `at the next frame, not at a later trigger (${firstSettle.t - removedAt} ms)`);
  await shell.tick(200);
  const mine = itemsSince(from).filter((i) => i.id === 'pa:8');
  assert.deepEqual(mine.map((i) => i.state), ['orphaned'], 'delivered once, orphaned, never hidden first (past the grace)');
  assert.equal(stateOf('pa:0'), 'exact');
  assert.ok(ov.orphans().some((o) => o.id === 'pa:8'));
  await shell.frame({ type: 'render', ...PANE('pa') });
  await waitUntil(() => stateOf('pa:8') === 'exact', { timeout: 4000, what: 'pa whole again' });
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
});

// ── (b) what a removal settles ──────────────────────────────────────────────

test('(b) removing a node no anchor holds queues one settle and moves no answer', async () => {
  await frames();
  const s0 = settles.length;
  const before = ['pb:2', 'pb:6'].map(stateOf);
  const orphansBefore = ov.orphans().map((o) => o.id);
  W.__pd.pb.remove(9);
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 1, 'one settle');
  assert.deepEqual(['pb:2', 'pb:6'].map(stateOf), before, 'no answer moved');
  assert.deepEqual(ov.orphans().map((o) => o.id), orphansBefore);
});

test('(b) a text node removed inside an anchored element settles; one outside every anchored element, or the chrome\'s own node, does not', async () => {
  await frames();
  let s0 = settles.length;
  W.__pd.pb.dropText(3);           // row 3 carries no anchor
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 0, 'outside every anchored element: nothing');

  s0 = settles.length;
  const style = W.__pd.pb.chrome();
  await frames();
  style.textContent = '.y{}';      // its text node replaced
  style.remove();                  // and the node itself
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 0, 'the chrome\'s own node: nothing');

  s0 = settles.length;
  W.__pd.pb.dropText(2);           // row 2's text, anchored
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 1, 'inside an anchored element: one settle');
  await waitUntil(() => stateOf('pb:2') !== 'exact', { timeout: 4000, what: 'the emptied row to stop reading exact' });
  await shell.frame({ type: 'render', ...PANE('pb') });
  await waitUntil(() => ['pb:2', 'pb:6'].every((id) => stateOf(id) === 'exact'), { timeout: 4000, what: 'pb whole again' });
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
});

// ── (c) coalescing ──────────────────────────────────────────────────────────

test('(c) ten removals in one frame give one settle; added nodes alone give none', async () => {
  await frames();
  let s0 = settles.length;
  W.__pd.pb.add(10);
  await frames();
  assert.equal(settlesSince(s0, 'pb').length, 0, 'added nodes only: no settle');
  s0 = settles.length;
  W.__pd.pb.removeMany(10);
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 1, 'ten removals, one settle');
  assert.equal(settlesSince(s0, 'pb').length, 1);
  assert.deepEqual(['pb:2', 'pb:6'].map(stateOf), ['exact', 'exact']);

  // Ten removals in one frame, each its own observer delivery (a microtask
  // apart, so the MutationObserver cannot batch them): the coalescing on the
  // frame is what leaves one settle.
  W.__pd.pb.add(10);
  await frames();
  s0 = settles.length;
  for (let k = 0; k < 10; k++) {
    W.__pd.pb.removeMany(1);
    await Promise.resolve();
  }
  assert.equal(settlesSince(s0, 'pb').length, 0, 'nothing settled inside the frame');
  await frames();
  assert.equal(settlesSince(s0, 'pb', 'pane-dom').length, 1, 'ten observer deliveries in one frame, one settle');
  assert.equal(settlesSince(s0, 'pb').length, 1);
  assert.deepEqual(['pb:2', 'pb:6'].map(stateOf), ['exact', 'exact']);
});

// ── (d) observer lifetime ───────────────────────────────────────────────────

test('(d) one observer per watched pane; a re-render re-attaches once; a pane leaving the set, or the surface, is disconnected', async () => {
  await frames();
  let o = oh.paneObservers();
  assert.deepEqual(sorted(o.mounts), sorted(watchedMounts()), 'observers equal the watched panes');
  assert.deepEqual(sorted(o.mounts), ['pa', 'pb']);
  assert.equal(o.mounts.includes('free'), false, 'an unwatched pane has none');

  // A re-render: the old instance's observer goes, the new one's comes, once.
  const a0 = o.attached, d0 = o.detached;
  await shell.frame({ type: 'render', ...PANE('pb') });
  await frames();
  o = oh.paneObservers();
  assert.equal(o.attached - a0, 1, 're-attached exactly once');
  assert.equal(o.detached - d0, 1, 'the old one disconnected');
  assert.deepEqual(sorted(o.mounts), ['pa', 'pb']);
  await waitUntil(() => ['pb:2', 'pb:6'].every((id) => stateOf(id) === 'exact'), { timeout: 4000, what: 'pb exact' });

  // A pane entering the set without a settle of its own: an anchor placed on the
  // already-mounted 'free' pane is observed by the time it is answered.
  const freeRows = anchorRows('free', [5]);
  await waitUntil(() => stateOf('free:5') === 'exact', { timeout: 4000, what: 'free:5 exact' });
  await frames(1);
  assert.deepEqual(sorted(oh.paneObservers().mounts), ['free', 'pa', 'pb']);
  await new Promise((r) => setTimeout(r, 50));
  const s0 = settles.length;
  W.__pd.free.remove(5);
  await waitUntil(() => stateOf('free:5') === 'orphaned', { timeout: 4000, what: 'free:5 orphaned' });
  assert.equal(settlesSince(s0, 'free', 'pane-dom').length, 1);

  // Its rows gone: it leaves the set, and its observer goes at the next settle.
  ov.removeElements('live', freeRows.map((r) => r.id));
  await shell.frame({ type: 'store:patch', patch: { pd_k: 1 } });
  await frames();
  assert.deepEqual(sorted(oh.paneObservers().mounts), ['pa', 'pb'], 'a pane that left the watched set is not observed');

  // Panes taken off the surface: their observers go with them.
  const d1 = oh.paneObservers().detached;
  await shell.frame({ type: 'clear', id: 'pb' });
  await frames();
  assert.deepEqual(oh.paneObservers().mounts, ['pa']);
  assert.equal(oh.paneObservers().detached - d1, 1);
  await shell.frame({ type: 'render', ...PANE('pb') });
  await frames();
  assert.deepEqual(sorted(oh.paneObservers().mounts), ['pa', 'pb'], 'back on the surface, observed again');
  await waitUntil(() => ['pb:2', 'pb:6'].every((id) => stateOf(id) === 'exact'), { timeout: 4000, what: 'pb exact' });
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
});

// ── (e) the service-start grace ─────────────────────────────────────────────

async function serviceUp() {
  await shell.frame({ type: 'render', ...SVC });
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 50));
  return anchorRows('sv', [0, 5, 10]);
}
// The service waits on approval and its pane loses its rows; then the approval
// clears with nothing drawn yet. → the clear's time.
async function approvedNothingDrawn(rows) {
  await waitUntil(() => rows.every((r) => stateOf(r.id) === 'exact'), { timeout: 4000, what: 'the service rows exact' });
  shell.setRoutes({ '/api/services/pending': { ok: true, pending: [{ name: 'sv-board' }] } });
  await shell.frame({ type: 'service:trust', key: 'k', name: 'sv-board' });
  await waitUntil(() => sp.pendingServices().has('sv-board'), { timeout: 4000, what: 'sv-board pending' });
  await shell.frame({ type: 'store:patch', patch: { sv_rows: [] } });
  await waitUntil(() => rows.every((r) => stateOf(r.id) === 'hidden'), { timeout: 4000, what: 'hidden while pending' });
  assert.ok(rows.every((r) => reasons.get(r.id) === 'service-pending'));
  // The clear's time: when the pending list dropped the component (the grace
  // starts in the listener overlay-hidden registered before this one).
  let clearedAt = null;
  const off = sp.onPendingChange((m) => { if (m.removed.includes('sv-board') && clearedAt == null) clearedAt = Date.now(); });
  try {
    shell.setRoutes({ '/api/services/pending': { ok: true, pending: [] } });
    await shell.frame({ type: 'service:trust:clear', key: 'k' });
    await waitUntil(() => clearedAt != null, { timeout: 4000, what: 'the approval to clear' });
  } finally { off(); }
  return clearedAt;
}
// The clear's own settle answered (a delivery for `ids` after the clear).
async function clearAnswered(from, ids, clearedAt) {
  await waitUntil(() => itemsSince(from).some((i) => ids.includes(i.id) && i.t >= clearedAt), { timeout: 4000, what: 'the clear\'s settle to answer' });
}

test('(e) the service-start grace: hidden (service-pending) through it with 0 orphaned deliveries; a store write inside it draws the rows → resolved', async () => {
  const rows = await serviceUp();
  const ids = rows.map((r) => r.id);
  try {
    const from = delivered.length;
    const clearedAt = await approvedNothingDrawn(rows);
    await clearAnswered(from, ids, clearedAt);
    assert.ok(ids.every((id) => stateOf(id) === 'hidden' && reasons.get(id) === 'service-pending'), `inside the grace: ${ids.map((id) => `${stateOf(id)}/${reasons.get(id)}`)}`);
    // The service's first write, inside the grace.
    await shell.frame({ type: 'store:patch', patch: { sv_rows: svRows() } });
    await waitUntil(() => ids.every((id) => stateOf(id) === 'exact'), { timeout: 4000, what: 'the drawn rows to resolve' });
    await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 100));
    assert.deepEqual(itemsSince(from).filter((i) => ids.includes(i.id) && i.state === 'orphaned'), [], '0 orphaned deliveries');
    assert.ok(ids.every((id) => stateOf(id) === 'exact'), 'still exact after the grace would have run out');
  } finally {
    ov.removeElements('live', ids);
    shell.setRoutes({});
    await shell.frame({ type: 'store:patch', patch: { sv_rows: svRows() } });
    await shell.frame({ type: 'clear', id: 'sv' });
  }
});

test('(e) the service-start grace: with no store write, the grace\'s end reads the undrawn rows orphaned — not before it', async () => {
  const rows = await serviceUp();
  const ids = rows.map((r) => r.id);
  try {
    const from = delivered.length;
    const clearedAt = await approvedNothingDrawn(rows);
    await clearAnswered(from, ids, clearedAt);
    assert.ok(ids.every((id) => stateOf(id) === 'hidden' && reasons.get(id) === 'service-pending'), 'hidden at the clear\'s settle');
    await waitUntil(() => ids.every((id) => stateOf(id) === 'orphaned'), { timeout: 4000, what: 'the grace\'s end to read them orphaned' });
    const firstOrphan = itemsSince(from).find((i) => ids.includes(i.id) && i.state === 'orphaned');
    assert.ok(firstOrphan.t - clearedAt >= oh.MOUNT_GRACE_MS, `no orphan inside the grace (${firstOrphan.t - clearedAt} ms after the clear)`);
    await shell.tick(100);
    for (const id of ids) {
      assert.equal(itemsSince(from).filter((i) => i.id === id && i.state === 'orphaned').length, 1, `${id} delivered orphaned once`);
    }
  } finally {
    ov.removeElements('live', ids);
    shell.setRoutes({});
    await shell.frame({ type: 'store:patch', patch: { sv_rows: svRows() } });
    await shell.frame({ type: 'clear', id: 'sv' });
  }
});

test('(e) the service-start grace: a store write the pane hears ends it early — a write that draws nothing reads orphaned at its settle, not at the grace\'s end', async () => {
  const rows = await serviceUp();
  const ids = rows.map((r) => r.id);
  try {
    const from = delivered.length;
    const clearedAt = await approvedNothingDrawn(rows);
    await clearAnswered(from, ids, clearedAt);
    assert.ok(ids.every((id) => stateOf(id) === 'hidden' && reasons.get(id) === 'service-pending'), 'hidden at the clear\'s settle');
    // The service's first write, inside the grace, draws no row.
    const at = delivered.length;
    await shell.frame({ type: 'store:patch', patch: { sv_rows: [] } });
    await waitUntil(() => ids.every((id) => delivered.slice(at).some((m) => m.items.some((i) => i.id === id))), { timeout: 4000, what: 'the write\'s settle to answer' });
    const first = ids.map((id) => itemsSince(at).find((i) => i.id === id));
    assert.deepEqual(first.map((i) => i.state), ids.map(() => 'orphaned'), 'the write ended the grace: its own settle reads the undrawn rows orphaned');
  } finally {
    ov.removeElements('live', ids);
    shell.setRoutes({});
    await shell.frame({ type: 'store:patch', patch: { sv_rows: svRows() } });
    await shell.frame({ type: 'clear', id: 'sv' });
  }
});

test('(d) every pane gone: no observer left', async () => {
  for (const id of ['pa', 'pb', 'free']) await shell.frame({ type: 'clear', id });
  await frames();
  assert.deepEqual(oh.paneObservers().mounts, []);
  const o = oh.paneObservers();
  assert.equal(o.attached - o.detached, 0, 'every observer attached was disconnected');
});
