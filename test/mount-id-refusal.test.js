// U763 — render and use_component refuse a NEW mount id outside the page
// record's grammar (lib/core/strokes PAGE_ITEM_RE, at most PAGE_ITEM_MAX), the
// gap U613b left: a pane under any other id can never be a margin stroke's or an
// arrow's end. The gate sits at the two ROUTES (lib/server/domain/mounts
// refusesNewId / badIdReject), not inside setMount, so every other creator — the
// capture route's 'tab-capture:<…>' ids, the pane history's restoreMount,
// spawnPane — keeps its own rule, and a pane already live under such an id keeps
// re-rendering by its own id.
const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const client = require('../lib/client');
const { createDriver } = require('../lib/driver');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const { PAGE_ITEM_MAX } = require('../lib/core/strokes');
const { setMount, restoreMount, refusesNewId, badIdReject, BAD_ID_HINT } = require('../lib/server/domain/mounts');
const { spawnPane } = require('../lib/server/domain/spawn');

const REFUSED = ['a.b', 'n1.7-x', 'a:b', 'a b', 'a/b', 'é', 'a\u0007b', 'a'.repeat(PAGE_ITEM_MAX + 1)];
const ACCEPTED = ['plan-form', 'A_9', 'a'.repeat(PAGE_ITEM_MAX)];
const BUILTIN = 'form-renderer';

// Claude's call: lib/client with the boot's writer token, as the MCP tools send.
function claude(ctx) {
  return (p, body) => client.post(p, body, { port: ctx.port, noSpawn: true, headers: { [WRITER_HEADER]: ctx.writerToken() } });
}

async function mountIds(ctx) {
  return (await ctx.api.get('/api/mounts')).json.mounts.map((m) => m.id);
}

async function renderEventIds(ctx) {
  const ev = (await ctx.api.get('/api/events?since=0')).json;
  return ev.events.filter((e) => e.kind === 'render').map((e) => e.id);
}

function assertBadId(r, id) {
  assert.equal(r.ok, false, `${JSON.stringify(id)} refused`);
  assert.equal(r.rejected, true);
  assert.equal(r.bad_id, true);
  assert.equal(r.id, id, 'the refused id rides the envelope as data');
  assert.equal(r.hint, BAD_ID_HINT);
  assert.equal(r.reserved, undefined);
}

test('the hint is the ruled text and never interpolates the refused id', () => {
  assert.equal(BAD_ID_HINT, "a new mount id may use letters, digits, '-' and '_' only, at most 256 characters (a stroke or an arrow can only anchor to such an id); pick another id");
  const r = badIdReject('x<script>');
  assert.deepEqual(r, { ok: false, rejected: true, bad_id: true, id: 'x<script>', hint: BAD_ID_HINT });
  assert.ok(!r.hint.includes('<'));
});

test('refusesNewId: the grammar for a new id, false for a live one', () => {
  const state = { mounts: new Map([['legacy.pane', {}]]) };
  for (const id of REFUSED) assert.equal(refusesNewId(state, id), true, JSON.stringify(id));
  for (const id of ACCEPTED) assert.equal(refusesNewId(state, id), false, id);
  for (const id of [42, null, undefined, {}, '']) assert.equal(refusesNewId(state, id), true, String(id));
  assert.equal(refusesNewId(state, 'legacy.pane'), false, 'a pane already live keeps its id');
});

test('POST /api/render refuses each new id outside the grammar and mounts nothing', async (t) => {
  const ctx = await withServer(t);
  const post = claude(ctx);
  for (const id of REFUSED) assertBadId(await post('/api/render', { id, html: '<p>x</p>' }), id);
  const ids = await mountIds(ctx);
  const evs = await renderEventIds(ctx);
  for (const id of REFUSED) {
    assert.ok(!ids.includes(id), `${JSON.stringify(id)} not mounted`);
    assert.ok(!evs.includes(id), `${JSON.stringify(id)} has no render event`);
  }
  const bad = await post('/api/render', { id: 'x<script>', html: '<p>x</p>' });
  assertBadId(bad, 'x<script>');
  assert.ok(!bad.hint.includes('<'));
});

test('POST /api/render accepts grammar ids and the generated default', async (t) => {
  const ctx = await withServer(t);
  const post = claude(ctx);
  for (const id of ACCEPTED) {
    const r = await post('/api/render', { id, html: '<p>ok</p>' });
    assert.equal(r.ok, true, id);
    assert.equal(r.id, id);
  }
  const dflt = await post('/api/render', { html: '<p>default</p>' });
  assert.equal(dflt.ok, true);
  assert.match(dflt.id, /^mount-\d+$/);
  const ids = await mountIds(ctx);
  for (const id of [...ACCEPTED, dflt.id]) assert.ok(ids.includes(id), id);
});

test('POST /api/components/<builtin>/use refuses and accepts by the same grammar', async (t) => {
  const ctx = await withServer(t);
  const post = claude(ctx);
  for (const id of REFUSED) assertBadId(await post(`/api/components/${BUILTIN}/use`, { id, params: {} }), id);
  for (const id of ACCEPTED) {
    const r = await post(`/api/components/${BUILTIN}/use`, { id, params: {} });
    assert.equal(r.ok, true, id);
  }
  const dflt = await post(`/api/components/${BUILTIN}/use`, { params: {} });
  assert.equal(dflt.ok, true);
  assert.match(dflt.id, /^mount-\d+$/);
  const ids = await mountIds(ctx);
  const evs = await renderEventIds(ctx);
  for (const id of REFUSED) {
    assert.ok(!ids.includes(id), `${JSON.stringify(id)} not mounted`);
    assert.ok(!evs.includes(id), `${JSON.stringify(id)} has no render event`);
  }
  for (const id of ACCEPTED) assert.ok(ids.includes(id), id);
});

test("lib/driver's render meets the same gate (owner service:<name>)", async (t) => {
  const ctx = await withServer(t);
  const wc = createDriver({ owner: 'u763', port: ctx.port });
  for (const id of REFUSED) assertBadId(await wc.render({ id, html: '<p>d</p>' }), id);
  for (const id of ACCEPTED) {
    const r = await wc.render({ id, html: '<p>d</p>' });
    assert.equal(r.ok, true, id);
    assert.equal(r.owner, 'service:u763');
  }
  const ids = await mountIds(ctx);
  for (const id of REFUSED) assert.ok(!ids.includes(id), JSON.stringify(id));
});

test('reserved before bad_id: a reserved id keeps its own refusal', async (t) => {
  const ctx = await withServer(t);
  const post = claude(ctx);
  for (const p of ['/api/render', `/api/components/${BUILTIN}/use`]) {
    const r = await post(p, { id: 'main', html: '<p>x</p>', params: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reserved, true, p);
    assert.equal(r.bad_id, undefined, p);
  }
});

test('grandfather, history, spawn and capture: the paths outside the two routes are unchanged', async (t) => {
  const ctx = await withServer(t);
  const { state, bus } = ctx.srv;
  const post = claude(ctx);

  // A pane live under a refused id, as a restored draft or an older node puts it.
  const seeded = setMount(state, bus, { id: 'legacy.pane', html: '<p>v0</p>', owner: 'claude' });
  assert.equal(seeded.ok, true);

  // It re-renders through both routes by its own id.
  const rr = await post('/api/render', { id: 'legacy.pane', html: '<p>v1</p>' });
  assert.equal(rr.ok, true, JSON.stringify(rr));
  const ru = await post(`/api/components/${BUILTIN}/use`, { id: 'legacy.pane', params: {} });
  assert.equal(ru.ok, true, JSON.stringify(ru));

  // The pane history's Make current.
  const hist = restoreMount(state, bus, { id: 'legacy.pane', version: { html: '<p>v0</p>', owner: 'claude' } });
  assert.equal(hist.ok, true, JSON.stringify(hist));
  assert.equal(state.mounts.get('legacy.pane').html, '<p>v0</p>');

  // A default child inherits its parent's characters.
  const kid = spawnPane(state, bus, { parent: 'legacy.pane', html: '<p>child</p>' });
  assert.equal(kid.ok, true, JSON.stringify(kid));
  assert.equal(kid.id, 'legacy.pane-1');

  // An explicit spawn id is judged by spawn.js's own rule (any string of at most 200).
  const explicit = spawnPane(state, bus, { parent: 'legacy.pane', id: 'kid.x', html: '<p>k</p>' });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  const tooLong = spawnPane(state, bus, { parent: 'legacy.pane', id: 'k'.repeat(201), html: '<p>k</p>' });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.invalid, true);
  assert.equal(tooLong.bad_id, undefined);

  // The capture route's ids carry colons; setMount still takes them.
  const cap = setMount(state, bus, { id: 'tab-capture:x:y', html: '<p>cap</p>', policy: 'capture' });
  assert.equal(cap.ok, true, JSON.stringify(cap));

  const ids = await mountIds(ctx);
  for (const id of ['legacy.pane', 'legacy.pane-1', 'kid.x', 'tab-capture:x:y']) assert.ok(ids.includes(id), id);
});
