// Queue ⟲ Revert, end to end through a real daemon and a real browser socket:
// a Revert must never delete a pane Claude (or a driver) rendered.
//
// The reported defect: one "Apply" click in a pane with a declared signal puts
// TWO rows on the rail — an `activity` row from the shell's delegated click
// listener and a `signal` row from the pane's own store.set. Reverting the
// signal row routed to the pane-removal path, so the user's Revert deleted
// Claude's pane. Worse, the signal item was attributed to the LAST pane that
// declared the key, not the pane that wrote it, so the pane deleted could be one
// the user never touched. These tests drive the exact frames a browser sends.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');

const HTML = '<form><input id="a"><button id="go">Apply</button></form>';
const SIG = { signals: [{ key: 'form_submit', wake: 'queue' }] };

async function browser(t, port) {
  const ws = wsConnect(port);
  await new Promise((resolve, reject) => {
    ws.on('message', (d) => { if (JSON.parse(d).type === 'hello') resolve(); });
    ws.on('error', reject);
  });
  t.after(() => ws.close());
  return { send: (frame) => ws.send(JSON.stringify(frame)) };
}

// What one "Apply" click after typing produces in the browser: the debounced
// form snapshot, the shell's delegated click, and the pane script's
// gesture-stamped, mount-attributed store.set of its declared signal key.
function applyClick(b, mount, { typed = 'typed', seq = 1 } = {}) {
  b.send({ type: 'pane:form', id: mount, form_state: { '#a:0': { value: typed } } });
  b.send({ type: 'event', payload: { type: 'click', mountId: mount, tag: 'BUTTON' } });
  b.send({ type: 'store:set', patch: { form_submit: { seq, payload: { a: typed } } }, mount, gesture: true });
}

async function queueItems(api, n) {
  let items;
  await waitUntil(async () => (items = (await api.get('/api/queue')).json.items).length >= n);
  return items;
}

async function mountsById(api) {
  const { json } = await api.get('/api/mounts');
  return new Map(json.mounts.map((m) => [m.id, m]));
}

test('Apply in a declared pane: reverting EITHER row keeps the pane and undoes the interaction', async (t) => {
  for (const kind of ['signal', 'activity']) {
    await t.test(`revert the ${kind} row`, async (t) => {
      const { api, port } = await withServer(t);
      await api.post('/api/render', { id: 'fresh', html: HTML, params: SIG });
      const b = await browser(t, port);
      applyClick(b, 'fresh');
      const items = await queueItems(api, 2);
      assert.deepEqual(items.map((x) => x.kind).sort(), ['activity', 'signal'], 'one click, two rows');

      const it = items.find((x) => x.kind === kind);
      const del = await api.del('/api/queue/' + it.id + '?revert=1');
      assert.equal(del.json.reverted, true);

      const m = (await mountsById(api)).get('fresh');
      assert.ok(m, 'the pane Claude rendered survives the Revert');
      assert.equal(m.form_state, null, 'the typed value is undone — the pane had none before the run');
      const store = (await api.get('/api/store')).json;
      if (kind === 'signal') {
        assert.equal(Object.hasOwn(store, 'form_submit'), false, 'the signal write is taken back out of the store');
      }
      const left = (await api.get('/api/queue')).json.items;
      assert.equal(left.length, 1, 'the revert\'s own store write enqueued nothing');
    });
  }
});

test('a signal Revert puts an earlier value of the key back', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'fresh', html: HTML, params: SIG });
  const b = await browser(t, port);
  applyClick(b, 'fresh', { typed: 'one', seq: 1 });
  const first = await queueItems(api, 2);
  // Push — the first submission is handed to Claude.
  await api.post('/api/queue/push', {});
  await waitUntil(async () => (await api.get('/api/queue')).json.items.length === 0);
  assert.equal(first.length, 2);

  applyClick(b, 'fresh', { typed: 'one two', seq: 2 });
  const items = await queueItems(api, 2);
  const sig = items.find((x) => x.kind === 'signal');
  await api.del('/api/queue/' + sig.id + '?revert=1');

  const store = (await api.get('/api/store')).json;
  assert.deepEqual(store.form_submit, { seq: 1, payload: { a: 'one' } }, 'the handed-off submission is back');
  const m = (await mountsById(api)).get('fresh');
  assert.deepEqual(m.form_state, { '#a:0': { value: 'one' } },
    'the baseline is the value at the Push, not the value typed since');
});

test('two panes declare the same key: the item names the WRITER and a Revert never touches the other', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'clicked', html: HTML, params: SIG });
  await api.post('/api/render', { id: 'bystander', html: HTML, params: SIG }); // the last declarer
  const b = await browser(t, port);
  b.send({ type: 'pane:form', id: 'bystander', form_state: { '#a:0': { value: 'mine' } } });
  b.send({ type: 'store:set', patch: { form_submit: { seq: 1 } }, mount: 'clicked', gesture: true });
  const items = await queueItems(api, 1);
  const sig = items.find((x) => x.kind === 'signal');
  assert.equal(sig.origin_mount, 'clicked', 'attributed to the pane that wrote, not the last declarer');

  await api.del('/api/queue/' + sig.id + '?revert=1');
  const mounts = await mountsById(api);
  assert.ok(mounts.has('clicked') && mounts.has('bystander'), 'both panes survive');
  assert.deepEqual(mounts.get('bystander').form_state, { '#a:0': { value: 'mine' } },
    'the bystander\'s typed values are untouched');
});

test('typed, paused, then clicked: Revert restores the value from BEFORE the typing', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: HTML });
  const b = await browser(t, port);
  b.send({ type: 'pane:form', id: 'p', form_state: { '#a:0': { value: 'before' } } });
  b.send({ type: 'event', payload: { type: 'change', mountId: 'p', tag: 'INPUT' } });
  const [first] = await queueItems(api, 1);
  await api.post('/api/queue/push', {});
  await waitUntil(async () => (await api.get('/api/queue')).json.items.length === 0);
  assert.equal(first.kind, 'activity');

  // The debounced snapshot of the new typing lands well before the change event
  // that opens the next activity item.
  b.send({ type: 'pane:form', id: 'p', form_state: { '#a:0': { value: 'before + typed' } } });
  await waitUntil(async () => ((await mountsById(api)).get('p').form_state || {})['#a:0']?.value === 'before + typed');
  b.send({ type: 'event', payload: { type: 'change', mountId: 'p', tag: 'INPUT' } });
  const [it] = await queueItems(api, 1);
  await api.del('/api/queue/' + it.id + '?revert=1');
  assert.deepEqual((await mountsById(api)).get('p').form_state, { '#a:0': { value: 'before' } });
});

// data-2: a dismiss (× without Revert) keeps what the user typed during that
// run, so it ends the run. The pane's baseline used to outlive the dismissed
// item, the next item inherited it, and ITS Revert wiped the kept values too.
test('dismiss keeps the typed values: a later Revert goes back to them, not past them', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: HTML });
  const b = await browser(t, port);
  b.send({ type: 'pane:form', id: 'p', form_state: { '#a:0': { value: 'abc' } } });
  b.send({ type: 'event', payload: { type: 'click', mountId: 'p', tag: 'BUTTON' } });
  const [q1] = await queueItems(api, 1);
  assert.equal((await api.del('/api/queue/' + q1.id)).status, 200);
  await waitUntil(async () => (await api.get('/api/queue')).json.items.length === 0);
  assert.deepEqual((await mountsById(api)).get('p').form_state, { '#a:0': { value: 'abc' } }, 'the dismiss kept them');

  b.send({ type: 'pane:form', id: 'p', form_state: { '#a:0': { value: 'abcdef' } } });
  await waitUntil(async () => ((await mountsById(api)).get('p').form_state || {})['#a:0']?.value === 'abcdef');
  b.send({ type: 'event', payload: { type: 'click', mountId: 'p', tag: 'BUTTON' } });
  const [q2] = await queueItems(api, 1);
  assert.deepEqual(q2.origin_form_state, { '#a:0': { value: 'abc' } }, 'the new run starts from the kept values');
  await api.del('/api/queue/' + q2.id + '?revert=1');
  assert.deepEqual((await mountsById(api)).get('p').form_state, { '#a:0': { value: 'abc' } },
    "Revert undoes only this run's typing");
});
