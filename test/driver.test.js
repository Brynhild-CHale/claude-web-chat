const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { createDriver } = require('../lib/driver');

test('createDriver round-trips render + store + events; owner is tagged', async (t) => {
  const { port, api } = await withServer(t);
  const wc = createDriver({ owner: 'test-runner', port });
  assert.equal(wc.owner, 'service:test-runner');

  const r = await wc.render({ id: 'tr', html: '<p>hi</p>' });
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'service:test-runner');

  // list_mounts (/api/mounts) surfaces the owner.
  const mounts = (await api.get('/api/mounts')).json;
  const m = mounts.mounts.find((x) => x.id === 'tr');
  assert.equal(m.owner, 'service:test-runner');

  await wc.setStore({ test_run: { seq: 1, status: 'pass' } });
  const store = await wc.getStore(['test_run']);
  assert.equal(store.test_run.status, 'pass');

  const ev = await wc.getEvents({ since: 0 });
  const renderEv = ev.events.find((e) => e.kind === 'render' && e.id === 'tr');
  assert.equal(renderEv.source, 'service:test-runner');
});

test('cross-owner overwrite is rejected; force overrides; same owner is fine', async (t) => {
  const { port, api } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });
  await driver.render({ id: 'p', html: '<p>driver</p>' });

  // Same owner re-render: allowed.
  const same = await driver.render({ id: 'p', html: '<p>driver v2</p>' });
  assert.equal(same.ok, true);

  // Claude (no owner) rendering over a driver-owned pane: rejected.
  const claude = (await api.post('/api/render', { id: 'p', html: '<p>claude</p>' })).json;
  assert.equal(claude.ok, false);
  assert.equal(claude.owned, true);
  assert.equal(claude.owner, 'service:svc');

  // force:true takes it over.
  const forced = (await api.post('/api/render', { id: 'p', html: '<p>claude</p>', force: true })).json;
  assert.equal(forced.ok, true);
  assert.equal(forced.owner, 'claude');
});

test('clear honours the SAME ownership guard render does', async (t) => {
  const { port, api } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });
  await driver.render({ id: 'p', html: '<p>driver</p>' });
  await api.post('/api/render', { id: 'mine', html: '<p>claude</p>' });

  // render refused this exact clobber; clear was the unguarded back door to it.
  const rejected = (await api.post('/api/clear', { id: 'p' })).json;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.owned, true);
  assert.equal(rejected.owner, 'service:svc');
  let mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.ok(mounts.includes('p'), 'the driver-owned pane survives');

  // A blanket clear must not sweep a foreign pane away either.
  const blanket = (await api.post('/api/clear', {})).json;
  assert.equal(blanket.ok, false, 'clear-all refuses whole rather than partially wiping');
  mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.ok(mounts.includes('p') && mounts.includes('mine'), 'both panes survive');

  // Claude clearing its OWN pane is unaffected.
  assert.equal((await api.post('/api/clear', { id: 'mine' })).json.ok, true);

  // And force:true is the deliberate takeover, matching render.
  assert.equal((await api.post('/api/clear', { id: 'p', force: true })).json.ok, true);
  mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.equal(mounts.includes('p'), false, 'force actually clears it');
});

// ── the page: where a pane goes, and the prose between panes ────────────────
// POST /api/render took `after` and `place` before render() sent them, and a
// driver had no way to write a heading at all — only Claude's write_markdown.

test('render passes `after` and `place` through: the pane lands where asked, placed as asked', async (t) => {
  const { port, api } = await withServer(t);
  const wc = createDriver({ owner: 'svc', port });
  await wc.render({ id: 'a', html: '<p>a</p>' });
  await wc.render({ id: 'b', html: '<p>b</p>' });

  const c = await wc.render({ id: 'c', html: '<p>c</p>', after: 'a', place: { span: 6, rows: 4 } });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.place, { col: null, span: 6, rows: 4 }, 'the applied placement comes back');
  let page = (await api.get('/api/mounts')).json;
  assert.deepEqual(page.order, ['a', 'c', 'b'], 'after:"a" puts it right after a, not at the bottom');
  assert.deepEqual(page.mounts.find((m) => m.id === 'c').place, { col: null, span: 6, rows: 4 });

  // Left out, a re-render keeps both — the place and what the user made of it.
  assert.equal((await wc.render({ id: 'c', html: '<p>c2</p>' })).ok, true);
  page = (await api.get('/api/mounts')).json;
  assert.deepEqual(page.order, ['a', 'c', 'b']);
  assert.deepEqual(page.mounts.find((m) => m.id === 'c').place, { col: null, span: 6, rows: 4 });

  assert.equal((await wc.render({ id: 'b', html: '<p>b</p>', after: 'start' })).ok, true);
  assert.deepEqual((await api.get('/api/mounts')).json.order, ['b', 'a', 'c'], '"start" is the top of the page');
});

test('writeMarkdown puts an owned markdown item on the page, by id and after, under the owner gate', async (t) => {
  const { port, api } = await withServer(t);
  const wc = createDriver({ owner: 'svc', port });
  await wc.render({ id: 'p1', html: '<p>one</p>' });

  assert.deepEqual(await wc.writeMarkdown({ id: 'svc-h', text: '## Tests', after: 'start' }),
    { ok: true, id: 'svc-h', owner: 'service:svc' });
  const cap = await wc.writeMarkdown({ text: 'All green.' });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  assert.match(cap.id, /^md-\d+$/, 'no id: the server assigns md-<n>');
  let page = (await api.get('/api/mounts')).json;
  assert.deepEqual(page.order, ['svc-h', 'p1', cap.id], 'after:"start" heads the page; no after appends');
  const head = page.markdown.find((m) => m.id === 'svc-h');
  assert.equal(head.owner, 'service:svc');
  assert.deepEqual(head.headings, [{ level: 2, text: 'Tests' }]);

  assert.equal((await wc.writeMarkdown({ id: 'svc-h', text: '## Tests: 3 failing' })).ok, true);
  page = (await api.get('/api/mounts')).json;
  assert.deepEqual(page.order, ['svc-h', 'p1', cap.id], 'a rewrite by id keeps its place');
  assert.deepEqual(page.markdown.find((m) => m.id === 'svc-h').headings, [{ level: 2, text: 'Tests: 3 failing' }]);

  const ev = (await wc.getEvents({ since: 0 })).events.filter((e) => e.kind === 'markdown' && e.id === 'svc-h');
  assert.deepEqual(ev.map((e) => [e.op, e.source]), [['put', 'service:svc'], ['put', 'service:svc']], 'attributed to the driver');

  // The owner gate, both ways, as for panes: Claude (no owner) cannot rewrite
  // the driver's heading, nor the driver Claude's, without force.
  const claude = (await api.post('/api/markdown', { id: 'svc-h', text: '# Mine' })).json;
  assert.deepEqual([claude.ok, claude.owned, claude.owner], [false, true, 'service:svc']);
  await api.post('/api/markdown', { id: 'c-h', text: '# Claude' });
  const over = await wc.writeMarkdown({ id: 'c-h', text: '# Driver' });
  assert.deepEqual([over.ok, over.owned, over.owner], [false, true, 'claude']);
  assert.equal((await wc.writeMarkdown({ id: 'c-h', text: '# Driver', force: true })).owner, 'service:svc', 'force takes it over');

  const clash = await wc.writeMarkdown({ id: 'p1', text: 'not a pane' });
  assert.deepEqual([clash.ok, clash.conflict], [false, 'pane'], 'panes and markdown share one id space');
});

test('removeMarkdown takes one markdown item off, never a pane, under the owner gate', async (t) => {
  const { port, api } = await withServer(t);
  const wc = createDriver({ owner: 'svc', port });
  await wc.render({ id: 'p1', html: '<p>one</p>' });
  await wc.writeMarkdown({ id: 'svc-h', text: '## Tests' });
  await api.post('/api/markdown', { id: 'c-h', text: '# Claude' });

  assert.deepEqual(await wc.removeMarkdown({ id: 'p1' }), { ok: true, removed: false, id: 'p1' }, 'a pane is not markdown');
  assert.deepEqual(await wc.removeMarkdown({ id: 'nope' }), { ok: true, removed: false, id: 'nope' });
  const foreign = await wc.removeMarkdown({ id: 'c-h' });
  assert.deepEqual([foreign.ok, foreign.owned, foreign.owner], [false, true, 'claude'], 'Claude\'s heading is not the driver\'s to take');
  assert.deepEqual(await wc.removeMarkdown({ id: 'svc-h' }), { ok: true, removed: true, id: 'svc-h' });
  assert.deepEqual(await wc.removeMarkdown({ id: 'c-h', force: true }), { ok: true, removed: true, id: 'c-h' });
  assert.deepEqual((await api.get('/api/mounts')).json.order, ['p1'], 'the pane stays; both items are gone');

  const gone = (await wc.getEvents({ since: 0 })).events.find((e) => e.kind === 'markdown' && e.op === 'remove' && e.id === 'svc-h');
  assert.equal(gone.source, 'service:svc');
  await assert.rejects(() => wc.removeMarkdown({}), (e) => e.status === 400, 'no id is the route\'s 400, thrown like any other');
});

// The driver's contract is written down twice: docs/driving-the-surface.md
// (the method table, and the SSE section for streamEvents) and the "whole
// surface" list docs/component-packs.md gives a service author. Both have to
// name every method createDriver returns, and the table none it lacks.
test('the driver docs name every method a driver has, and none it lacks', () => {
  const { read, flatten } = require('../test-support/doc-truth');
  const wc = createDriver({ owner: 'svc', port: 1 }); // nothing is requested
  const methods = Object.keys(wc).filter((k) => typeof wc[k] === 'function').sort();

  const driving = read('docs/driving-the-surface.md');
  for (const m of methods) assert.ok(driving.includes(`${m}(`), `docs/driving-the-surface.md never shows \`${m}(…)\``);
  for (const [, row] of driving.matchAll(/^\| `(\w+)\(/gm)) {
    assert.ok(methods.includes(row), `docs/driving-the-surface.md's method table lists \`${row}\`, which the driver does not have`);
  }

  const surface = /The driver's whole surface is (.*?) — see `lib\/driver\.js`/.exec(flatten(read('docs/component-packs.md')));
  assert.ok(surface, 'docs/component-packs.md lost its "whole surface" sentence — re-point this check');
  assert.deepEqual([...surface[1].matchAll(/`(\w+)`/g)].map((m) => m[1]).sort(), methods,
    'docs/component-packs.md\'s "whole surface" list');
});

test('owner survives a turn-end commit and restore', async (t) => {
  const { root, port, api, stop } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });

  await api.post('/api/turn-begin', { message: 'turn' });
  await driver.render({ id: 'owned', html: '<p>x</p>' });
  const te = (await api.post('/api/turn-end', { author: 'claude' })).json;
  assert.equal(te.ok, true);

  // The committed node records the owner.
  const node = (await api.get(`/api/graph/node/${te.node_id}`)).json;
  const om = node.mounts.find((m) => m.id === 'owned');
  assert.equal(om.owner, 'service:svc');
  await stop();

  // And it restores into live state on a fresh boot at that node.
  const { api: api2 } = await withServer(t, { root });
  const mounts = (await api2.get('/api/mounts')).json;
  const rm = mounts.mounts.find((m) => m.id === 'owned');
  assert.equal(rm.owner, 'service:svc');
});

// ── guardDriver: a fire-and-forget rejection never kills the process ────────
// The client contract rejects where it used to hang (dead socket, non-2xx), so
// a service child's unawaited store push would become an unhandled rejection —
// fatal in Node — and the supervisor would crash-block that service version.
test('guardDriver: an unawaited rejection is contained, an awaited one still throws', async () => {
  const { guardDriver } = require('../lib/driver');
  const reported = [];
  const fake = {
    owner: 'svc:fake',
    setStore: () => Promise.reject(new Error('boom')),
    getStore: () => Promise.resolve({ ok: true }),
  };
  const guarded = guardDriver(fake, (method, e) => reported.push(`${method}:${e.message}`));

  // Unawaited: without the guard this rejection is unhandled and Node exits 1.
  let unhandled = null;
  const trap = (e) => { unhandled = e; };
  process.once('unhandledRejection', trap);
  guarded.setStore({ k: 1 }); // fire-and-forget, the service-child idiom
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  process.removeListener('unhandledRejection', trap);
  assert.equal(unhandled, null, 'the guard consumed the rejection');
  assert.deepEqual(reported, ['setStore:boom'], 'and reported it once, naming the method');

  // Awaited: the caller's own handling still sees the rejection unchanged.
  await assert.rejects(() => guarded.setStore({ k: 2 }), /boom/, 'await still rejects');
  assert.deepEqual(await guarded.getStore(), { ok: true }, 'resolving calls pass through');
  assert.equal(guarded.owner, 'svc:fake', 'non-function properties are copied');
});
