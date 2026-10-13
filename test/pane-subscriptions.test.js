// A pane's store subscriptions end with the pane (U97; the Safari report's item
// 1, design/tools/t567-inputs/safari-report.md). Through the real shell
// (test-support/chrome-shell.js): every path that takes a pane record down —
// a `reset` frame, a re-render of the same id, a `clear` by id, a clear-all, a
// preview step, the return from a preview, and a mount that fails partway —
// releases what the pane's script subscribed through its injected `store`.
//
// Measured on wc085/int 09e5f05 before the fix: 5 panes, then 50 `reset` frames
// carrying the same 5, and one store write ran 255 handlers, 250 of them into
// detached shadow roots. The subscriber count must stay what the live page
// holds, however often the page is re-mounted.
//
// Observed as behaviour, not as engine internals: each pane script counts its
// handler's calls in window.__calls, tagged with its mount id and its instance
// (one per script run), so "exactly one call per live pane, from its newest
// instance" is the whole assertion.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

let shell, W, store, topbar;

// A pane whose script subscribes to `k` and records each call.
const COUNTING = `<p>pane</p><script>
  const inst = (window.__inst = (window.__inst || 0) + 1);
  window.__latest[mountId] = inst;
  store.subscribe('k', (v) => window.__calls.push({ id: mountId, inst, v }));
</script>`;

const pane = (id, extra = {}) => ({ id, html: COUNTING, target: 'main', params: {}, pane_state: {}, ...extra });
const FIVE = ['sa', 'sb', 'sc', 'sd', 'se'].map((id) => pane(id));

let seq = 0;
// One server-originated store write; answers the calls it caused.
function write() {
  W.__calls = [];
  store.set({ k: ++seq }, { fromServer: true });
  return W.__calls;
}
const ids = (calls) => calls.map((c) => c.id).sort();
const receive = (msg) => shell.socket().receive(msg);
const reset = (mounts) => receive({ type: 'reset', mounts, store: {}, active: 'n1' });

before(async () => {
  shell = await bootShell({ open: true });
  W = shell.window;
  W.__calls = [];
  W.__latest = {};
  ({ store } = await shell.importApp('store.js'));
  topbar = await shell.importApp('topbar.js');
  await shell.frame(helloFrame({ mounts: FIVE.map((m) => ({ ...m })) }));
});
after(() => shell.restore());

beforeEach(async () => {
  // Every case starts from the same live surface: the five counting panes.
  shell.setRoutes({});
  reset(FIVE.map((m) => ({ ...m })));
  await shell.tick();
});

test('the hello mounts five panes, and one write runs five handlers', () => {
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se']);
});

test('50 reset frames of the same five panes leave five subscribers, not 255', async () => {
  for (let i = 0; i < 50; i++) reset(FIVE.map((m) => ({ ...m })));
  await shell.tick();
  const calls = write();
  assert.strictEqual(calls.length, 5, `one write ran ${calls.length} handlers`);
  assert.deepStrictEqual(ids(calls), ['sa', 'sb', 'sc', 'sd', 'se']);
  for (const c of calls) assert.strictEqual(c.inst, W.__latest[c.id], `${c.id}: a replaced instance ran`);
});

test('50 re-renders of one pane: its replaced instances never run', async () => {
  for (let i = 0; i < 50; i++) receive({ type: 'render', ...pane('sc') });
  await shell.tick();
  const calls = write();
  assert.strictEqual(calls.length, 5, `one write ran ${calls.length} handlers`);
  assert.deepStrictEqual(ids(calls), ['sa', 'sb', 'sc', 'sd', 'se']);
  for (const c of calls) assert.strictEqual(c.inst, W.__latest[c.id], `${c.id}: a replaced instance ran`);
});

test('a clear by id, then a clear-all that keeps a pinned pane: only the survivors run', async () => {
  reset([...FIVE.slice(0, 4).map((m) => ({ ...m })), pane('se', { pane_state: { pinned: true } })]);
  await shell.tick();
  receive({ type: 'clear', id: 'sb' });
  await shell.tick();
  assert.deepStrictEqual(ids(write()), ['sa', 'sc', 'sd', 'se']);

  receive({ type: 'clear' });
  await shell.tick();
  assert.ok(shell.document.querySelector('.pane[data-pane-id="se"]'), 'the pinned pane survives the clear-all');
  const calls = write();
  assert.deepStrictEqual(ids(calls), ['se'], 'the kept pinned pane keeps its one subscription');
  assert.strictEqual(calls[0].inst, W.__latest.se);
});

test('20 preview steps and the return to active: only the live panes run', async () => {
  const before = { ...W.__latest };
  for (let i = 1; i <= 20; i++) {
    const node = { id: `pv${i}`, label: `n1.${i}`, parent_id: 'n1', created_at: 1 + i, store: {},
      mounts: [pane(`pv-a${i}`), pane(`pv-b${i}`)] };
    shell.setRoutes({ '/api/graph/node/*': node });
    await topbar.previewNode(`pv${i}`);
  }
  // While previewing, the previewed node's panes are the ones on the page.
  assert.deepStrictEqual(ids(write()), ['pv-a20', 'pv-b20']);
  topbar.returnToActive();
  await shell.tick();
  const calls = write();
  assert.deepStrictEqual(ids(calls), ['sa', 'sb', 'sc', 'sd', 'se'], 'no preview pane survived the return');
  for (const c of calls) {
    assert.strictEqual(c.inst, W.__latest[c.id], `${c.id}: a replaced instance ran`);
    assert.notStrictEqual(c.inst, before[c.id], `${c.id}: the pre-preview instance still runs`);
  }
});

test('a subscribe made after the pane was removed subscribes nothing and answers a no-op', async () => {
  W.__late = undefined;
  receive({ type: 'render', id: 'late', target: 'main', params: {}, pane_state: {}, html: `<script>
    (async () => {
      await Promise.resolve();
      window.__late = store.subscribe('k', () => window.__calls.push({ id: 'late' }));
    })();
  </script>` });
  receive({ type: 'clear', id: 'late' });   // gone before the script's await resolves
  await shell.tick();
  assert.strictEqual(typeof W.__late, 'function', 'the late subscribe still answers an unsubscribe');
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se'], 'the late handler subscribed to the store');
  assert.doesNotThrow(() => { W.__late(); W.__late(); });
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se']);
});

test('a pane that unsubscribes itself, then is removed: idempotent, no throw, no double delete', async () => {
  // The script subscribes one function, unsubscribes it, subscribes the SAME
  // function again and calls the first unsubscribe once more. The shared store
  // keys a subscription by its function, so a second call of the raw
  // unsubscribe would take the re-subscription with it; the facade's is
  // idempotent.
  receive({ type: 'render', id: 'self', target: 'main', params: {}, pane_state: {}, html: `<script>
    const fn = () => window.__calls.push({ id: 'self' });
    const off1 = store.subscribe('k', fn);
    off1();
    window.__selfOff = store.subscribe('k', fn);
    off1();
  </script>` });
  await shell.tick();
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se', 'self']);
  W.__selfOff();
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se']);
  receive({ type: 'render', id: 'self', target: 'main', params: {}, pane_state: {}, html: `<script>
    window.__selfOff = store.subscribe('k', () => window.__calls.push({ id: 'self2' }));
  </script>` });
  await shell.tick();
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se', 'self2']);
  W.__selfOff();
  assert.doesNotThrow(() => receive({ type: 'clear', id: 'self' }));
  await shell.tick();
  assert.doesNotThrow(() => W.__selfOff());
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se']);
});

test('a mount that fails after its script subscribed leaves no live handler', async () => {
  // runScripts isolates a throwing inline script, so the failure is forced
  // after it: the baseline form capture that ends mountPane.
  const rt = W.__wcMount;
  const capture = rt.captureFormState;
  rt.captureFormState = (root) => {
    if (root.host && root.host.dataset.mountId === 'boom') throw new Error('forced mount failure');
    return capture(root);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    receive({ type: 'render', ...pane('boom') });
    await shell.tick();
  } finally {
    rt.captureFormState = capture;
    console.error = quiet;
  }
  assert.ok(W.__latest.boom, 'the failing pane\'s script ran and subscribed');
  assert.strictEqual(shell.document.querySelector('.pane[data-pane-id="boom"]'), null, 'the failed pane was unwound');
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'sd', 'se']);
});

test('a re-render whose new content fails to attach releases the old instance too', async () => {
  const rt = W.__wcMount;
  const attach = rt.attachAndExtract;
  rt.attachAndExtract = (host, html) => {
    if (host.dataset.mountId === 'sd') throw new Error('forced attach failure');
    return attach(host, html);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    receive({ type: 'render', ...pane('sd') });
    await shell.tick();
  } finally {
    rt.attachAndExtract = attach;
    console.error = quiet;
  }
  assert.deepStrictEqual(ids(write()), ['sa', 'sb', 'sc', 'se']);
});

test('a reconnect hello keeps unchanged panes and their one subscription each', async () => {
  const before = { ...W.__latest };
  shell.socket().drop();
  await shell.tick(1100);   // ws.js reconnects after 1 s
  await shell.frame(helloFrame({ mounts: FIVE.map((m) => ({ ...m })) }));
  const calls = write();
  assert.deepStrictEqual(ids(calls), ['sa', 'sb', 'sc', 'sd', 'se']);
  for (const c of calls) assert.strictEqual(c.inst, before[c.id], `${c.id} was re-mounted by a reconciling hello`);
});
