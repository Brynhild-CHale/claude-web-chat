// Page layout (lib/server/domain/page, the layout half): `place:{col,span,rows}`
// on render / use_component, Claude's-layout baseline + ↺ reset per grid run,
// the per-run `stacks` flag, the user's drag-reorder, and the lock refusing a
// move or resize. Pinned here: clamping, the rows ↔ heightPx reading of old
// panes, what the baseline records (and what a user move does NOT touch), run
// scoping, and that the layout state travels with nodes and drafts exactly when
// it is off its defaults.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const page = require('../lib/server/domain/page');

const render = (api, id, extra = {}) => api.post('/api/render', { id, html: `<p>${id}</p>`, ...extra });
const md = (api, body) => api.post('/api/markdown', body);
const mounts = async (api) => (await api.get('/api/mounts')).json;
const paneOf = async (api, id) => (await mounts(api)).mounts.find((m) => m.id === id);
async function turn(api, message = 't') {
  await api.post('/api/turn-begin', { message });
  return (await api.post('/api/turn-end', {})).json;
}
const readNode = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'graph', `${id}.json`), 'utf8'));

// A browser socket that has received its hello, with every frame collected.
async function browser(ctx) {
  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'));
  return { sock, frames, send: (f) => sock.send(JSON.stringify(f)) };
}

// Send a pane:state patch and wait for the server to have applied it.
async function paneState(ctx, id, patch, done) {
  const b = await browser(ctx);
  b.send({ type: 'pane:state', id, pane_state: patch });
  await waitUntil(async () => done(await paneOf(ctx.api, id)));
  b.sock.close();
}

// ── place ──────────────────────────────────────────────────────────────────

test('layout: normalizePlace clamps into the 12-column grid', () => {
  const n = page.normalizePlace;
  assert.deepEqual(n({ col: 1, span: 6, rows: 5 }), { col: 1, span: 6, rows: 5 });
  assert.deepEqual(n({}), { col: null, span: 12, rows: null }, 'nothing given = full-width auto');
  assert.deepEqual(n({ col: 10, span: 6 }), { col: 10, span: 3, rows: null }, 'span shrinks to fit');
  assert.deepEqual(n({ col: 7 }), { col: 7, span: 6, rows: null }, 'omitted span = the rest of the row');
  assert.deepEqual(n({ col: 12, span: 4 }), { col: 11, span: 2, rows: null }, 'col moves left only when SPAN_MIN cannot fit');
  assert.deepEqual(n({ col: 0, span: 1, rows: 1 }), { col: 1, span: 2, rows: 2 });
  assert.deepEqual(n({ col: 99, span: 99, rows: 99 }), { col: 11, span: 2, rows: 24 });
  assert.deepEqual(n({ span: '4', rows: 3.4 }), { col: null, span: 4, rows: 3 });
  assert.equal(n('wide'), null);
  assert.equal(n([1, 2]), null);
});

test('layout: render place sets col/colSpan/rows/heightPx, records the baseline, and echoes what it applied', async (t) => {
  const { api } = await withServer(t);
  const r = await render(api, 'a', { place: { col: 10, span: 6, rows: 5 } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.place, { col: 10, span: 3, rows: 5 });
  assert.equal('warning' in r.json, false);
  const a = await paneOf(api, 'a');
  assert.deepEqual(a.pane_state, {
    col: 10, colSpan: 3, rows: 5, heightPx: 200,
    claude_place: { col: 10, span: 3, rows: 5 },
  });
  assert.deepEqual(a.place, { col: 10, span: 3, rows: 5 });

  // No place: no pane_state at all, as before; the reading is the default.
  const b = await render(api, 'b');
  assert.equal('place' in b.json, false);
  const pb = await paneOf(api, 'b');
  assert.equal(pb.pane_state, null);
  assert.deepEqual(pb.place, { col: null, span: 12, rows: null });

  const bad = await render(api, 'c', { place: 'wide' });
  assert.equal(bad.json.ok, true, 'a malformed place still renders');
  assert.match(bad.json.warning, /place ignored/);
  const both = await render(api, 'd', { place: 7, after: 'ghost' });
  assert.match(both.json.warning, /'ghost' is not on the page.*; place ignored/);
});

test('layout: use_component takes place', async (t) => {
  const { api } = await withServer(t);
  const r = await api.post('/api/components/git-dashboard/use', { id: 'g', place: { col: 1, span: 4, rows: 6 } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.place, { col: 1, span: 4, rows: 6 });
  assert.deepEqual((await paneOf(api, 'g')).place, { col: 1, span: 4, rows: 6 });
});

test('layout: a re-render without place keeps the user\'s layout and the baseline; with place, Claude re-proposes', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a', { place: { col: 1, span: 6, rows: 4 } });
  await paneState(ctx, 'a', { colSpan: 8, heightPx: 400 }, (m) => m.pane_state.colSpan === 8);
  let a = await paneOf(api, 'a');
  assert.equal(a.pane_state.rows, 10, 'a heightPx resize re-derives rows on a pane that carries them');
  assert.deepEqual(a.pane_state.claude_place, { col: 1, span: 6, rows: 4 }, 'a user resize never moves the baseline');

  await render(api, 'a', { html: '<p>again</p>' });
  a = await paneOf(api, 'a');
  assert.deepEqual(a.place, { col: 1, span: 8, rows: 10 }, 'a plain re-render keeps the user layout');
  assert.deepEqual(a.pane_state.claude_place, { col: 1, span: 6, rows: 4 });

  await render(api, 'a', { place: { span: 12 } });
  a = await paneOf(api, 'a');
  assert.deepEqual(a.place, { col: null, span: 12, rows: null });
  assert.equal('heightPx' in a.pane_state, false, 'an auto-height placement drops the old height');
  assert.deepEqual(a.pane_state.claude_place, { col: null, span: 12, rows: null });
});

test('layout: placeOf reads an old pane\'s heightPx (and legacy rowSpan) as rows, without rewriting it', () => {
  assert.deepEqual(page.placeOf({ colSpan: 6, heightPx: 200 }), { col: null, span: 6, rows: 5 });
  assert.deepEqual(page.placeOf({ heightPx: 30 }), { col: null, span: 12, rows: 2 });
  assert.deepEqual(page.placeOf({ heightPx: 5000 }), { col: null, span: 12, rows: 24 });
  assert.deepEqual(page.placeOf({ rowSpan: 4 }), { col: null, span: 12, rows: 6 });
  assert.deepEqual(page.placeOf({ col: 'auto', colSpan: 4 }), { col: null, span: 4, rows: null });
  assert.deepEqual(page.placeOf(undefined), { col: null, span: 12, rows: null });
  // rows wins over heightPx when both are there.
  assert.deepEqual(page.placeOf({ rows: 3, heightPx: 400 }), { col: null, span: 12, rows: 3 });
});

test('layout: patchPaneState keeps rows and heightPx in step without rewriting old panes', () => {
  const p = page.patchPaneState;
  assert.deepEqual(p({ colSpan: 6 }, { heightPx: 400 }).pane_state, { colSpan: 6, heightPx: 400 },
    'an old pane with no rows gains none');
  assert.deepEqual(p({ rows: 4, heightPx: 160 }, { heightPx: 240 }).pane_state, { rows: 6, heightPx: 240 });
  assert.deepEqual(p({ heightPx: 160 }, { rows: 30 }).pane_state, { rows: 24, heightPx: 960 });
  assert.deepEqual(p({ rows: 4, heightPx: 160 }, { rows: null }).pane_state, { heightPx: null });
  assert.deepEqual(p({ rows: 4, heightPx: 160 }, { heightPx: null }).pane_state, { heightPx: null });
});

// ── the lock ───────────────────────────────────────────────────────────────

test('layout: patchPaneState — a locked pane refuses a move or resize; everything else, unlock included, applies', () => {
  const p = page.patchPaneState;
  const locked = { locked: true, col: 1, colSpan: 6, heightPx: 200 };
  const r = p(locked, { colSpan: 12, heightPx: 400, minimized: true, mode: 'expanded' });
  assert.deepEqual(r.refused.sort(), ['colSpan', 'heightPx']);
  assert.deepEqual(r.pane_state, { locked: true, col: 1, colSpan: 6, heightPx: 200, minimized: true, mode: 'expanded' });
  // The chrome sends its full normalised record (col:'auto' where none is
  // stored): layout keys that describe the SAME place are not a move.
  const same = p({ locked: true, colSpan: 12 }, { col: 'auto', colSpan: 12, heightPx: null, pinned: true });
  assert.deepEqual(same.refused, []);
  assert.equal(same.pane_state.pinned, true);
  // Unlock applies; the lock is judged on the state BEFORE the patch, so a move
  // riding the unlock frame itself is still refused — the next one lands.
  const un = p(locked, { locked: false, colSpan: 3 });
  assert.equal(un.pane_state.locked, false);
  assert.equal(un.pane_state.colSpan, 6);
  assert.deepEqual(un.refused, ['colSpan']);
  assert.equal(p(un.pane_state, { colSpan: 3 }).pane_state.colSpan, 3);
  // Locking and resizing in one frame from an unlocked pane is allowed.
  assert.equal(p({ colSpan: 6 }, { locked: true, colSpan: 4 }).pane_state.colSpan, 4);
});

test('layout: over the wire, a locked pane\'s resize is refused and the sender is sent the authoritative state', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a', { place: { col: 1, span: 6, rows: 4 } });
  await paneState(ctx, 'a', { locked: true }, (m) => m.pane_state.locked);

  const b = await browser(ctx);
  b.send({ type: 'pane:state', id: 'a', pane_state: { colSpan: 12, heightPx: 600, minimized: true } });
  await waitUntil(() => b.frames.some((f) => f.type === 'pane:state' && f.id === 'a'));
  b.sock.close();
  const back = b.frames.find((f) => f.type === 'pane:state' && f.id === 'a');
  assert.equal(back.pane_state.colSpan, 6, 'the dragging client is told where the pane really is');
  const a = await paneOf(api, 'a');
  assert.deepEqual(a.place, { col: 1, span: 6, rows: 4 });
  assert.equal(a.pane_state.minimized, true, 'minimize is not a move');
  const ev = (await api.get('/api/events')).json.events.filter((e) => e.kind === 'pane' && e.refused);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].refused.sort(), ['colSpan', 'heightPx']);

  // An unlocked pane's patch is NOT echoed to its sender (unchanged behaviour).
  await paneState(ctx, 'a', { locked: false }, (m) => !m.pane_state.locked);
  const c = await browser(ctx);
  const other = await browser(ctx);
  c.send({ type: 'pane:state', id: 'a', pane_state: { colSpan: 12 } });
  await waitUntil(() => other.frames.some((f) => f.type === 'pane:state' && f.id === 'a'));
  c.sock.close(); other.sock.close();
  assert.equal(c.frames.some((f) => f.type === 'pane:state'), false);
  assert.equal((await paneOf(api, 'a')).place.span, 12);
});

// ── the user's move ────────────────────────────────────────────────────────

test('layout: /api/page/move reorders for the user; locked panes and bad anchors refuse', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a');
  await render(api, 'b');
  await md(api, { id: 'h', text: '## H' });
  await render(api, 'c');

  const b = await browser(ctx);
  let r = await api.post('/api/page/move', { id: 'c', after: 'start' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.order, ['c', 'a', 'b', 'h']);
  await waitUntil(() => b.frames.some((f) => f.type === 'page:order'));
  assert.deepEqual(b.frames.find((f) => f.type === 'page:order').order, ['c', 'a', 'b', 'h']);
  b.sock.close();
  r = await api.post('/api/page/move', { id: 'h', after: 'a' });
  assert.deepEqual(r.json.order, ['c', 'a', 'h', 'b'], 'markdown moves too');

  await paneState(ctx, 'b', { locked: true }, (m) => m.pane_state.locked);
  r = await api.post('/api/page/move', { id: 'b', after: 'start' });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.locked, true);
  assert.deepEqual((await mounts(api)).order, ['c', 'a', 'h', 'b']);

  assert.equal((await api.post('/api/page/move', { id: 'a', after: 'ghost' })).json.unknown_anchor, true);
  assert.equal((await api.post('/api/page/move', { id: 'a', after: 'a' })).json.unknown_anchor, true);
  assert.equal((await api.post('/api/page/move', { id: 'nope', after: 'start' })).json.unknown, true);
  assert.equal((await api.post('/api/page/move', { after: 'start' })).status, 400);
  assert.equal((await api.post('/api/page/move', { id: 'a' })).status, 400);

  const ev = (await api.get('/api/events')).json.events.filter((e) => e.kind === 'page' && e.op === 'move');
  assert.deepEqual(ev.map((e) => [e.id, e.after, e.source]), [['c', 'start', 'browser'], ['h', 'a', 'browser']]);
});

// ── ↺ Claude's layout ──────────────────────────────────────────────────────

test('layout: reset-layout restores a run\'s sizes, order and un-minimizes — only that run', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a', { place: { col: 1, span: 6, rows: 4 } });
  await render(api, 'b', { place: { col: 7, span: 6 } });
  await render(api, 'c');
  await md(api, { id: 'h', text: '## Second run' });
  await render(api, 'd', { place: { span: 4 } });
  await render(api, 'e');

  // The user rearranges both runs.
  await paneState(ctx, 'a', { colSpan: 12, heightPx: 600, minimized: true }, (m) => m.pane_state.minimized);
  await paneState(ctx, 'c', { colSpan: 3 }, (m) => m.pane_state && m.pane_state.colSpan === 3);
  await paneState(ctx, 'd', { colSpan: 9 }, (m) => m.pane_state.colSpan === 9);
  await api.post('/api/page/move', { id: 'c', after: 'start' });
  await api.post('/api/page/move', { id: 'e', after: 'h' });
  assert.deepEqual((await mounts(api)).order, ['c', 'a', 'b', 'h', 'e', 'd']);

  const b = await browser(ctx);
  const r = await api.post('/api/page/reset-layout', { run_anchor: 'start' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.reset.sort(), ['a', 'c']);
  assert.equal(r.json.reordered, true);
  assert.deepEqual(r.json.skipped_locked, []);
  const m = await mounts(api);
  assert.deepEqual(m.order, ['a', 'b', 'c', 'h', 'e', 'd'], 'the start run is back in Claude\'s order; run h untouched');
  const by = Object.fromEntries(m.mounts.map((x) => [x.id, x]));
  assert.deepEqual(by.a.place, { col: 1, span: 6, rows: 4 });
  assert.equal(by.a.pane_state.minimized, undefined, 'un-minimized');
  assert.deepEqual(by.c.pane_state, {}, 'a never-placed pane goes back to the default (no layout keys)');
  assert.equal(by.d.place.span, 9, 'another run is not reset');

  // The browser is told every layout key explicitly (its pane:state is a merge).
  await waitUntil(() => b.frames.some((f) => f.type === 'page:order'));
  b.sock.close();
  const fc = b.frames.find((f) => f.type === 'pane:state' && f.id === 'c');
  assert.deepEqual(fc.pane_state, { col: null, colSpan: 12, rows: null, heightPx: null, minimized: false });
  assert.deepEqual(b.frames.find((f) => f.type === 'page:order').order, m.order);

  const r2 = await api.post('/api/page/reset-layout', { run_anchor: 'h' });
  assert.deepEqual(r2.json.reset, ['d']);
  const m2 = await mounts(api);
  assert.deepEqual(m2.order, ['a', 'b', 'c', 'h', 'd', 'e']);
  assert.equal(m2.mounts.find((x) => x.id === 'd').place.span, 4);

  // Nothing left to do: no frames, no event.
  const before = (await api.get('/api/events')).json.events.length;
  const r3 = await api.post('/api/page/reset-layout', { run_anchor: 'h' });
  assert.deepEqual([r3.json.reset, r3.json.reordered], [[], false]);
  assert.equal((await api.get('/api/events')).json.events.length, before);

  assert.equal((await api.post('/api/page/reset-layout', { run_anchor: 'a' })).json.unknown_anchor, true,
    'a pane is not a run anchor');
  assert.equal((await api.post('/api/page/reset-layout', {})).status, 400);
});

test('layout: reset-layout leaves a locked pane in its slot and at its size', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a', { place: { span: 6 } });
  await render(api, 'b', { place: { span: 6 } });
  await render(api, 'c', { place: { span: 6 } });
  await api.post('/api/page/move', { id: 'c', after: 'start' });   // c a b
  await api.post('/api/page/move', { id: 'b', after: 'c' });       // c b a
  await paneState(ctx, 'b', { colSpan: 12 }, (m) => m.pane_state.colSpan === 12);
  await paneState(ctx, 'b', { locked: true }, (m) => m.pane_state.locked);
  await paneState(ctx, 'c', { colSpan: 3 }, (m) => m.pane_state.colSpan === 3);
  const r = await api.post('/api/page/reset-layout', { run_anchor: 'start' });
  assert.deepEqual(r.json.skipped_locked, ['b']);
  const m = await mounts(api);
  assert.deepEqual(m.order, ['a', 'b', 'c'], 'b keeps slot 2; a and c are sorted around it');
  assert.equal(m.mounts.find((x) => x.id === 'b').place.span, 12);
  assert.equal(m.mounts.find((x) => x.id === 'c').place.span, 6);
});

test('layout: Claude\'s own after moves the baseline; a user move does not', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  await render(api, 'c');
  await api.post('/api/page/move', { id: 'a', after: 'c' });          // user: b c a
  await render(api, 'c', { after: 'start' });                          // Claude: c first (baseline c a b)
  assert.deepEqual((await mounts(api)).order, ['c', 'b', 'a']);
  await api.post('/api/page/reset-layout', { run_anchor: 'start' });
  assert.deepEqual((await mounts(api)).order, ['c', 'a', 'b']);
});

// ── run flags ──────────────────────────────────────────────────────────────

test('layout: /api/page/run sets and clears a run\'s stacks flag; a removed anchor takes its flag', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a');
  await md(api, { id: 'h', text: '## H' });
  await render(api, 'b');
  const b = await browser(ctx);
  let r = await api.post('/api/page/run', { anchor: 'h', stacks: false });
  assert.deepEqual(r.json, { ok: true, anchor: 'h', stacks: false });
  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  assert.deepEqual((await mounts(api)).runs, { h: { stacks: false }, start: { stacks: false } });
  await waitUntil(() => b.frames.filter((f) => f.type === 'page:run').length === 2);
  assert.deepEqual(b.frames.find((f) => f.type === 'page:run'), { type: 'page:run', anchor: 'h', stacks: false });
  b.sock.close();
  const hello = await ctx.wsHello();
  assert.deepEqual(hello.runs, { h: { stacks: false }, start: { stacks: false } });

  r = await api.post('/api/page/run', { anchor: 'start', stacks: true });
  assert.equal(r.json.stacks, true);
  assert.deepEqual((await mounts(api)).runs, { h: { stacks: false } }, 'the default is stored as nothing');

  await api.post('/api/clear', { id: 'h' });
  assert.deepEqual((await mounts(api)).runs, {}, 'the flag goes with its anchor');

  assert.equal((await api.post('/api/page/run', { anchor: 'a', stacks: false })).json.unknown_anchor, true);
  assert.equal((await api.post('/api/page/run', { anchor: 'start' })).status, 400);
  assert.equal((await api.post('/api/page/run', { anchor: 'start', stacks: 'no' })).status, 400);
});

test('layout: Wipe of the whole page drops the run flags', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  await api.post('/api/graph/wipe', {});
  assert.deepEqual((await mounts(api)).runs, {});
});

// ── graph travel ───────────────────────────────────────────────────────────

test('layout: a node carries runs and claude_order only off their defaults, and restoring brings ↺ back', async (t) => {
  const ctx = await withServer(t);
  const { api, webChatDir } = ctx;
  await render(api, 'a', { place: { span: 6 } });
  await render(api, 'b');
  const plain = await turn(api);
  const n0 = readNode(webChatDir, plain.node_id);
  assert.equal('claude_order' in n0, false);
  assert.equal('runs' in n0, false);
  assert.deepEqual(n0.mounts[0].pane_state.claude_place, { col: null, span: 6, rows: null });

  await api.post('/api/page/move', { id: 'b', after: 'start' });
  await paneState(ctx, 'a', { colSpan: 12 }, (m) => m.pane_state.colSpan === 12);
  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  const moved = await turn(api);
  assert.ok(moved.node_id, 'a user rearrangement is a surface change');
  const n1 = readNode(webChatDir, moved.node_id);
  assert.deepEqual(n1.claude_order, ['a', 'b']);
  assert.deepEqual(n1.runs, { start: { stacks: false } });
  assert.deepEqual(n1.mounts.map((m) => m.id), ['b', 'a']);

  // Away and back: the baseline and the flag are restored with the node.
  await api.post('/api/graph/active', { id: plain.node_id });
  assert.deepEqual((await mounts(api)).runs, {});
  await api.post('/api/graph/active', { id: moved.node_id });
  const m = await mounts(api);
  assert.deepEqual(m.order, ['b', 'a']);
  assert.deepEqual(m.runs, { start: { stacks: false } });
  await api.post('/api/page/reset-layout', { run_anchor: 'start' });
  const back = await mounts(api);
  assert.deepEqual(back.order, ['a', 'b']);
  assert.equal(back.mounts.find((x) => x.id === 'a').place.span, 6);
});

test('layout: the no-change check sees a run flag, and a reset back to Claude\'s layout reads as the original node', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'a', { place: { span: 6 } });
  await render(api, 'b');
  assert.ok((await turn(api)).node_id);

  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  assert.ok((await turn(api)).node_id, 'flipping a run flag commits');
  await api.post('/api/page/run', { anchor: 'start', stacks: true });
  assert.ok((await turn(api)).node_id, 'and flipping it back commits');

  await api.post('/api/page/move', { id: 'b', after: 'start' });
  await paneState(ctx, 'a', { colSpan: 12, minimized: true }, (m) => m.pane_state.minimized);
  await api.post('/api/page/reset-layout', { run_anchor: 'start' });
  assert.equal((await turn(api)).skipped, 'no-change', '↺ lands byte-identical to the surface Claude left');
});

test('layout: graceful shutdown drafts claude_order + runs and the next boot restores them', async (t) => {
  const { api, root, webChatDir, graceful } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  await api.post('/api/page/move', { id: 'b', after: 'start' });
  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.deepEqual(draft.claude_order, ['a', 'b']);
  assert.deepEqual(draft.runs, { start: { stacks: false } });

  const { api: api2 } = await withServer(t, { root });
  const m = await mounts(api2);
  assert.deepEqual(m.order, ['b', 'a']);
  assert.deepEqual(m.runs, { start: { stacks: false } });
  await api2.post('/api/page/reset-layout', { run_anchor: 'start' });
  assert.deepEqual((await mounts(api2)).order, ['a', 'b']);
});

test('layout: diff reports run flags', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await turn(api);
  let d = (await api.get('/api/graph/diff?a=active&b=live')).json;
  assert.equal(d.runs, null);
  await api.post('/api/page/run', { anchor: 'start', stacks: false });
  d = (await api.get('/api/graph/diff?a=active&b=live')).json;
  assert.deepEqual(d.runs, { from: {}, to: { start: { stacks: false } } });
});

test('layout: layoutFields is default-free and drops dangling anchors', () => {
  const s = { mounts: [{ id: 'a' }, { id: 'b' }], markdown: [{ id: 'h' }] };
  assert.deepEqual(page.layoutFields({ ...s, claude_order: ['a', 'b', 'h'], runs: {} }), {});
  assert.deepEqual(page.layoutFields({ ...s, claude_order: ['b', 'a', 'h'] }), { claude_order: ['b', 'a', 'h'] });
  assert.deepEqual(page.layoutFields({ ...s, runs: { h: { stacks: false }, gone: { stacks: false }, start: { stacks: true } } }),
    { runs: { h: { stacks: false } } });
});

// ── the tools ──────────────────────────────────────────────────────────────

test('render / use_component tools declare and forward place', async () => {
  const client = require('../lib/mcp/client');
  for (const t of ['render', 'use_component']) {
    const tool = require(`../lib/mcp/tools/${t}`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties.place.properties).sort(), ['col', 'rows', 'span']);
    assert.match(tool.inputSchema.properties.place.description, /baseline/);
  }
  const seen = [];
  const orig = client.post;
  client.post = async (p, body) => { seen.push([p, body]); return { ok: true }; };
  try {
    await require('../lib/mcp/tools/render').handler({ html: '<p/>', id: 'a', place: { span: 6 } });
    await require('../lib/mcp/tools/use_component').handler({ name: 'x', id: 'b', place: { col: 2 } });
  } finally {
    client.post = orig;
  }
  assert.deepEqual(seen[0][1].place, { span: 6 });
  assert.deepEqual(seen[1][1].place, { col: 2 });
});
