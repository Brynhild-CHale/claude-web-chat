// The render-impact answer (annotation engine PLAN.md 4F.2; INK@render-impact;
// IMPACT@counts; rulings U563@private-count (a), U563-U580@catalogue-tool-edits
// (a)): POST /api/render, POST /api/components/:name/use and POST /api/clear
// answer how many annotations sit on the item they wrote or removed — counts
// only, present only when non-zero — and GET /api/mounts carries each annotated
// pane's counts and, after a viewer's resolution report, the post-resolve
// verdict by_state. lib/server/domain/annotation-impact is the engine.
//
// Who is who: lib/client (client.request: no fetch metadata) is Claude's tools,
// a local caller that gets the `private` count; a remote viewer is a loopback
// request carrying the portal's X-WC-Remote: 1, at the project's `full` opt-in
// in the sandbox's tunnel.json, which never counts a private element.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, waitUntil, wsConnect, tmpRoot } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const client = require('../lib/client');
const { annotationsOn, byState } = require('../lib/server/domain/annotation-impact');

const T = 20000;
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const PRIVATE_NOTE = 'wc-u563-private-note-mark';
const SHARED_NOTE = 'wc-u563-shared-note-mark';

const RANGE = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const LOCATOR = (mount) => ({ mount, selector: 'p', text: 'Hello', ordinal: 0 });

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// A daemon whose project is opted in at `full` for remote viewers, with
// `call` (lib/client: Claude's tools) and `remote` (lib/client + X-WC-Remote).
async function boot(t) {
  const root = tmpRoot('wc-u563-');
  const d = await withServer(t, {
    root,
    seed: () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'full' } } }),
  });
  d.call = async (method, p, body, headers = {}) => {
    const r = await client.request(d.port, method, p, body, { headers, timeout: 10000 });
    return { status: r.status, json: r.body, text: JSON.stringify(r.body) };
  };
  d.remote = (method, p, body) => d.call(method, p, body, REMOTE);
  return d;
}

// A pane a local driver owns (lib/driver leases its owner).
const driverRender = (d, id) => require('../lib/driver').createDriver({ owner: 'x', port: d.port }).render({ id, html: '<p>Hello driver</p>' });
const render = (d, id, html = '<p>Hello world</p>') => ok(d.call('POST', '/api/render', { id, html }), `render ${id}`);
const highlight = async (d, mount, payload = {}) => (await ok(d.anonApi.post('/api/elements', {
  type: 'highlight', anchor: RANGE(mount), payload: { color: 'gold', note: SHARED_NOTE, ...payload },
}), `highlight on ${mount}`)).element;
const comment = async (d, mount, payload = {}) => (await ok(d.anonApi.post('/api/elements', {
  type: 'comment', anchor: LOCATOR(mount), payload: { text: SHARED_NOTE, shared: true, ...payload },
}), `comment on ${mount}`)).element;

// m1: three highlights (one private) and one shared comment.
async function annotate(d, mount) {
  const h1 = await highlight(d, mount);
  const h2 = await highlight(d, mount);
  const hp = await highlight(d, mount, { note: PRIVATE_NOTE, shared: false });
  const c = await comment(d, mount);
  return { h1, h2, hp, c };
}

const noLeak = (answer, els) => {
  const s = JSON.stringify(answer);
  assert.ok(!s.includes(PRIVATE_NOTE) && !s.includes(SHARED_NOTE), 'no note text in the answer');
  for (const e of els) assert.ok(!s.includes(e.id), `no element id (${e.id}) in the answer`);
  assert.ok(!s.includes('"anchor"') && !s.includes('quote') && !s.includes('selector'), 'no anchor in the answer');
};

test('render over a pane holding 3 highlights (one private) and 1 comment answers the counts only — the private one in `private`, its note, id and anchor nowhere', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  const els = await annotate(d, 'm1');
  const r = await ok(d.call('POST', '/api/render', { id: 'm1', html: '<p>Hello again</p>' }), 're-render m1');
  assert.deepStrictEqual(r.annotations, {
    item: 'm1', total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'm1');
  noLeak(r, Object.values(els));
  // The answer's other fields are setMount's, unchanged.
  const { annotations, ...rest } = r;
  assert.deepStrictEqual(Object.keys(rest).sort(), ['id', 'ok', 'owner']);
});

test('render over an unannotated pane answers exactly {ok, id, owner}; an annotation on ANOTHER pane is not counted', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  await render(d, 'm2');
  await annotate(d, 'm2');
  const r = await ok(d.call('POST', '/api/render', { id: 'm1', html: '<p>Hello there</p>' }), 're-render m1');
  assert.deepStrictEqual(r, { ok: true, id: 'm1', owner: 'claude' });
  assert.ok(!('annotations' in r));
  // A refused render (an owned pane, no force) carries no field.
  await driverRender(d, 'svc');
  await highlight(d, 'svc');
  const refused = (await d.call('POST', '/api/render', { id: 'svc', html: '<p>mine</p>' })).json;
  assert.equal(refused.ok, false);
  assert.ok(!('annotations' in refused), 'a refused render carries none');
});

test('use_component over an annotated pane answers the same field; over an unannotated one, setMount\'s answer as it was', async (t) => {
  const d = await boot(t);
  await ok(d.call('POST', '/api/components', { name: 'w-impact', source: '<p>Hello W</p>' }), 'save');
  await render(d, 'm1');
  const els = await annotate(d, 'm1');
  const r = await ok(d.call('POST', '/api/components/w-impact/use', { id: 'm1' }), 'use over m1');
  assert.deepStrictEqual(r.annotations, { item: 'm1', total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1 });
  noLeak(r, Object.values(els));
  const plain = await ok(d.call('POST', '/api/components/w-impact/use', { id: 'm9' }), 'use over m9');
  assert.deepStrictEqual(plain, { ok: true, id: 'm9', owner: 'claude' });
});

test('clear by id answers what went (read before the removal), a markdown item\'s included; a foreign-owned refusal carries no field', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  await annotate(d, 'm1');
  const r = await ok(d.call('POST', '/api/clear', { id: 'm1' }), 'clear m1');
  assert.deepStrictEqual(r, { ok: true, annotations: { item: 'm1', total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1 } });
  assert.ok(!d.srv.state.mounts.has('m1'), 'the pane went');
  // A repeat clear of the removed pane: nothing went, though its references
  // and pin stay in the log (only a Wipe drops them).
  assert.deepStrictEqual(await ok(d.call('POST', '/api/clear', { id: 'm1' }), 'repeat clear m1'), { ok: true });

  // A markdown item (one id space): a highlight anchored by md.
  await ok(d.call('POST', '/api/markdown', { id: 'md-a', text: '## Hello' }), 'markdown');
  const hm = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { ...RANGE('md-a'), mount: 'md-a' }, payload: {} }), 'md highlight')).element;
  assert.ok(hm.id);
  const md = await ok(d.call('POST', '/api/clear', { id: 'md-a' }), 'clear md-a');
  assert.deepStrictEqual(md.annotations, { item: 'md-a', total: 1, by_type: { highlight: 1 }, shared: 1, private: 0 });

  // An unannotated clear answers {ok: true} exactly.
  await render(d, 'm2');
  assert.deepStrictEqual(await ok(d.call('POST', '/api/clear', { id: 'm2' }), 'clear m2'), { ok: true });

  // A foreign-owned pane: the soft refusal, no field.
  await driverRender(d, 'svc');
  await highlight(d, 'svc');
  const refused = (await d.call('POST', '/api/clear', { id: 'svc' })).json;
  assert.equal(refused.ok, false);
  assert.equal(refused.owned, true);
  assert.ok(!('annotations' in refused));
  assert.ok(d.srv.state.mounts.has('svc'), 'the refused pane stays');
});

test('a bulk clear answers the total over the removed panes only — a pinned kept pane\'s annotations are not counted', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  await render(d, 'm2');
  await render(d, 'm3');
  await annotate(d, 'm1');
  await highlight(d, 'm2');
  await highlight(d, 'm2');
  // m2 pinned by the user: the browser owns pane chrome (pane:state over the WS).
  const sock = wsConnect(d.port, '/ws');
  t.after(() => { try { sock.terminate(); } catch {} });
  await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
  sock.send(JSON.stringify({ type: 'pane:state', id: 'm2', pane_state: { pinned: true } }));
  await waitUntil(() => d.srv.state.mounts.get('m2').pane_state?.pinned === true, { timeout: T, what: 'm2 pinned' });

  // Markdown in a page-wide clear: the caption directly above the pinned m2
  // stays (page.markdownAbove) and is not counted; one at the bottom goes and is.
  await ok(d.call('POST', '/api/markdown', { id: 'md-cap', text: '## Kept caption', after: 'm1' }), 'md-cap');
  await ok(d.call('POST', '/api/markdown', { id: 'md-end', text: '## Hello end' }), 'md-end');
  const mdHighlight = (id) => ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: { ...RANGE(id), mount: id }, payload: {} }), `highlight on ${id}`);
  await mdHighlight('md-cap');
  await mdHighlight('md-end');

  const r = await ok(d.call('POST', '/api/clear', {}), 'bulk clear');
  assert.deepStrictEqual(r.kept, ['m2']);
  assert.ok(d.srv.state.markdown.has('md-cap') && !d.srv.state.markdown.has('md-end'), 'the caption above the pinned pane stays, the bottom item goes');
  assert.deepStrictEqual(r.annotations, { items: ['m1', 'md-end'], total: 5, by_type: { comment: 1, highlight: 4 }, shared: 4, private: 1 });
  assert.ok(d.srv.state.mounts.has('m2') && !d.srv.state.mounts.has('m1') && !d.srv.state.mounts.has('m3'));

  // force takes the pinned m2 and the caption above it, both counted.
  await render(d, 'm4');
  assert.deepStrictEqual(await ok(d.call('POST', '/api/clear', { force: true }), 'forced bulk clear'), {
    ok: true, annotations: { items: ['m2', 'md-cap'], total: 3, by_type: { highlight: 3 }, shared: 3, private: 0 },
  });
  await render(d, 'm5');
  assert.deepStrictEqual(await ok(d.call('POST', '/api/clear', {}), 'plain bulk clear'), { ok: true });

  // A bulk clear refused whole for a foreign pane carries no field.
  await render(d, 'm6');
  await highlight(d, 'm6');
  await driverRender(d, 'svc');
  const refused = (await d.call('POST', '/api/clear', {})).json;
  assert.equal(refused.ok, false);
  assert.ok(!('annotations' in refused));
});

test('a remote request (X-WC-Remote) to /api/clear and /api/components/:name/use counts no private element and carries no private key', async (t) => {
  const d = await boot(t);
  await ok(d.call('POST', '/api/components', { name: 'w-impact', source: '<p>Hello W</p>' }), 'save');
  await render(d, 'm1');
  const els = await annotate(d, 'm1');
  const used = await ok(d.remote('POST', '/api/components/w-impact/use', { id: 'm1' }), 'remote use');
  assert.deepStrictEqual(used.annotations, { item: 'm1', total: 3, by_type: { comment: 1, highlight: 2 }, shared: 3 });
  assert.ok(!('private' in used.annotations));
  noLeak(used, Object.values(els));

  // A pane holding only a private highlight: nothing a remote viewer may count.
  await render(d, 'm2');
  await highlight(d, 'm2', { note: PRIVATE_NOTE, shared: false });
  const onlyPrivate = await ok(d.remote('POST', '/api/clear', { id: 'm2', force: true }), 'remote clear m2');
  assert.deepStrictEqual(onlyPrivate, { ok: true });

  const cleared = await ok(d.remote('POST', '/api/clear', { id: 'm1', force: true }), 'remote clear m1');
  assert.deepStrictEqual(cleared, { ok: true, annotations: { item: 'm1', total: 3, by_type: { comment: 1, highlight: 2 }, shared: 3 } });
  noLeak(cleared, Object.values(els));
});

test('GET /api/mounts: an annotated pane carries its counts; after a resolution report, by_state {exact, re_resolved, orphaned}; a remote read leaves private out', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  await render(d, 'm2');
  const els = await annotate(d, 'm1');

  const before = await ok(d.call('GET', '/api/mounts'), 'mounts');
  const row = (j, id) => j.mounts.find((m) => m.id === id);
  assert.deepStrictEqual(row(before, 'm1').annotations, { total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1 });
  assert.ok(!('by_state' in row(before, 'm1').annotations), 'no by_state before any report');
  assert.ok(!('annotations' in row(before, 'm2')), 'an unannotated pane row is as it was');

  // The socket's report message, as test/reports-local.test.js sends it.
  const frames = [];
  const sock = wsConnect(d.port, '/ws');
  t.after(() => { try { sock.terminate(); } catch {} });
  sock.on('message', (m) => { try { frames.push(JSON.parse(m.toString())); } catch {} });
  await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: T, what: 'hello' });
  const hello = frames.find((f) => f.type === 'hello');
  const gen = hello.mounts.find((m) => m.id === 'm1').gen;
  const pinV = d.srv.state.comments.find((c) => c.id === els.c.id).v;
  sock.send(JSON.stringify({
    type: 'report', surface: hello.surface, mounts: [{
      mount: 'm1', gen, items: [
        { id: els.h1.id, v: els.h1.v, state: 'exact' },
        { id: els.h2.id, v: els.h2.v, state: 're-resolved' },
        { id: els.hp.id, v: els.hp.v, state: 'orphaned' },
        { id: els.c.id, v: pinV, state: 'exact' },
      ],
    }],
  }));
  await waitUntil(() => d.srv.reports.stats().accepted === 4, { timeout: T, what: 'the report accepted' });

  const after = await ok(d.call('GET', '/api/mounts'), 'mounts after');
  assert.deepStrictEqual(row(after, 'm1').annotations, {
    total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1,
    by_state: { exact: 2, re_resolved: 1, orphaned: 1 },
  });
  noLeak(row(after, 'm1').annotations, Object.values(els));

  const remote = await ok(d.remote('GET', '/api/mounts'), 'remote mounts');
  assert.deepStrictEqual(row(remote, 'm1').annotations, {
    total: 3, by_type: { comment: 1, highlight: 2 }, shared: 3,
    by_state: { exact: 2, re_resolved: 1, orphaned: 0 },
  });
});

test('GET /api/mounts: a re-render leaves the old content\'s verdict out — no by_state until a viewer reports at the new gen', async (t) => {
  const d = await boot(t);
  await render(d, 'm1');
  const els = await annotate(d, 'm1');
  const row = (j, id) => j.mounts.find((m) => m.id === id);
  const counts = { total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1 };

  const frames = [];
  const sock = wsConnect(d.port, '/ws');
  t.after(() => { try { sock.terminate(); } catch {} });
  sock.on('message', (m) => { try { frames.push(JSON.parse(m.toString())); } catch {} });
  await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: T, what: 'hello' });
  const hello = frames.find((f) => f.type === 'hello');
  const report = (gen, state) => sock.send(JSON.stringify({
    type: 'report', surface: hello.surface, mounts: [{ mount: 'm1', gen, items: [{ id: els.h1.id, v: els.h1.v, state }] }],
  }));

  const gen0 = hello.mounts.find((m) => m.id === 'm1').gen;
  report(gen0, 'exact');
  await waitUntil(() => d.srv.reports.stats().accepted === 1, { timeout: T, what: 'the first report accepted' });
  assert.deepStrictEqual(row(await ok(d.call('GET', '/api/mounts'), 'mounts'), 'm1').annotations, { ...counts, by_state: { exact: 1, re_resolved: 0, orphaned: 0 } });

  // Claude re-renders m1: the held answer is the old content's.
  await render(d, 'm1', '<p>Hello again</p>');
  const gen1 = d.srv.state.mounts.get('m1').gen;
  assert.notStrictEqual(gen1, gen0);
  assert.deepStrictEqual(row(await ok(d.call('GET', '/api/mounts'), 'mounts after the render'), 'm1').annotations, counts,
    'the counts, and no by_state until a report at the new gen');

  report(gen1, 'orphaned');
  await waitUntil(() => d.srv.reports.stats().accepted === 2, { timeout: T, what: 'the report at the new gen accepted' });
  assert.deepStrictEqual(row(await ok(d.call('GET', '/api/mounts'), 'mounts after the new report'), 'm1').annotations, { ...counts, by_state: { exact: 0, re_resolved: 0, orphaned: 1 } });
});

test('annotationsOn (the engine): a version the log cannot place is skipped; a legacy locator pin counts on its mount; counts only', () => {
  const store = {
    version: (id, v) => (id === 'h1' && v === 1 ? { payload: { anchor: { mount: 'm1' }, shared: true } } : null),
    typeOf: () => 'highlight',
  };
  const state = {
    elements: ['h1@1', 'h9@1', 'junk'],
    comments: [{ id: 'c1', locator: { mount: 'm1' }, shared: false, text: 'secret' }, { id: 'c2', anchor: { mount: 'm2' } }],
    mounts: new Map(), markdown: new Map(),
  };
  assert.deepStrictEqual(annotationsOn(state, store, 'm1'), { item: 'm1', total: 2, by_type: { comment: 1, highlight: 1 }, shared: 1, private: 1 });
  assert.deepStrictEqual(annotationsOn(state, store, 'm1', { remote: true }), { item: 'm1', total: 1, by_type: { highlight: 1 }, shared: 1 });
  assert.deepStrictEqual(annotationsOn(state, store, ['m1', 'm2', 'm3']), { items: ['m1', 'm2'], total: 3, by_type: { comment: 2, highlight: 1 }, shared: 2, private: 1 });
  assert.equal(annotationsOn(state, store, 'm3'), null);
  assert.equal(annotationsOn(state, null, 'm2', { remote: true }) && annotationsOn(state, null, 'm2', { remote: true }).total, 1, 'with no store, the pins still count');
  assert.equal(annotationsOn(state, store, []), null);
  // byState: the held answers at the pane's live gen and each element's live
  // v, over the ids given only.
  const ids = new Map([['a', { v: 2 }], ['b', { v: 1 }]]);
  assert.deepStrictEqual(byState([
    { id: 'a', v: 1, state: 'orphaned', gen: 1 },
    { id: 'a', v: 2, state: 'exact', gen: 1 },
    { id: 'b', v: 1, state: 're-resolved', gen: 1 },
    { id: 'b', v: 1, state: 'orphaned', gen: 0 },
    { id: 'z', v: 1, state: 'exact', gen: 1 },
  ], ids, 1), { exact: 1, re_resolved: 1, orphaned: 0 });
  assert.equal(byState([{ id: 'a', v: 2, state: 'exact', gen: 0 }], ids, 1), null, 'an answer at an older gen is not the verdict');
  assert.equal(byState([{ id: 'a', v: 1, state: 'exact', gen: 1 }], ids, 1), null, 'an answer for an older version is not the verdict');
  assert.equal(byState([], ids, 1), null);
  assert.equal(byState([{ id: 'z', v: 1, state: 'exact', gen: 1 }], ids, 1), null);
});

// ── a stroke's page record: counted on both items (tranche 5, U623) ─────────
// IMPACT@both-items: an arrow from A to B is an annotation on A and on B
// (element-refs anchorItems); a write over either answers it, and a bulk
// clear of both lists it under both and counts it ONCE in the total.
const strokes = require('../lib/core/strokes');
const { approveElementPack } = require('../test-support/element-type-fixture');
const PAGE_ARROW = (a, b) => strokes.pageRecord({
  frame: { w: 1200, h: 2400 },
  from: { item: a, x: 0.5, y: 0.5, w: 600, h: 200 },
  to: { item: b, x: 0.25, y: 0.5, w: 600, h: 200 },
});
const INK = 'tq-impact-ink';
const arrowOn = async (d, a, b, shared = true) => (await ok(d.anonApi.post('/api/elements', {
  type: INK, anchor: PAGE_ARROW(a, b), payload: { tool: 'pen', shared },
}), `arrow ${a} → ${b}`)).element;

test('IMPACT@both-items (U623): render over pane B answers the arrow from A to B on B; list_mounts counts it on A and on B; a bulk clear of A and B lists it under both and counts it once in the total', async (t) => {
  const d = await boot(t);
  approveElementPack(d, { name: 'tq-impact-ink-pack', type: INK, json: { anchors: ['element', 'page'], payload: { keys: ['anchor', 'shared', 'tool'] } } });
  await render(d, 'pa');
  await render(d, 'pb');
  await render(d, 'pc');
  const arrow = await arrowOn(d, 'pa', 'pb');
  const h = await highlight(d, 'pa');

  const rb = await ok(d.call('POST', '/api/render', { id: 'pb', html: '<p>Hello B</p>' }), 're-render pb');
  assert.deepStrictEqual(rb.annotations, { item: 'pb', total: 1, by_type: { [INK]: 1 }, shared: 1, private: 0 }, 'the arrow, on its end item');
  noLeak(rb, [arrow]);
  const ra = await ok(d.call('POST', '/api/render', { id: 'pa', html: '<p>Hello A</p>' }), 're-render pa');
  assert.deepStrictEqual(ra.annotations, { item: 'pa', total: 2, by_type: { highlight: 1, [INK]: 1 }, shared: 2, private: 0 });
  const rc = await ok(d.call('POST', '/api/render', { id: 'pc', html: '<p>Hello C</p>' }), 're-render pc');
  assert.ok(!('annotations' in rc), 'an item the arrow does not touch');

  const mounts = await ok(d.call('GET', '/api/mounts'), 'mounts');
  const row = (id) => mounts.mounts.find((m) => m.id === id);
  assert.deepStrictEqual(row('pa').annotations, { total: 2, by_type: { highlight: 1, [INK]: 1 }, shared: 2, private: 0 });
  assert.deepStrictEqual(row('pb').annotations, { total: 1, by_type: { [INK]: 1 }, shared: 1, private: 0 });

  // A private arrow from pc to pb: counted for Claude's tools as `private` only, never for a remote read.
  await arrowOn(d, 'pc', 'pb', false);
  const engine = annotationsOn(d.srv.state, d.srv.elements, ['pa', 'pb', 'pc']);
  assert.deepStrictEqual(engine, { items: ['pa', 'pb', 'pc'], total: 3, by_type: { highlight: 1, [INK]: 2 }, shared: 2, private: 1 },
    'listed under every item it touches, counted once each');
  assert.deepStrictEqual(annotationsOn(d.srv.state, d.srv.elements, ['pa', 'pb', 'pc'], { remote: true }),
    { items: ['pa', 'pb'], total: 2, by_type: { highlight: 1, [INK]: 1 }, shared: 2 }, 'a remote reading leaves the private arrow out, and its item pc');

  const cleared = await ok(d.call('POST', '/api/clear', {}), 'bulk clear');
  assert.deepStrictEqual(cleared.annotations, { items: ['pa', 'pb', 'pc'], total: 3, by_type: { highlight: 1, [INK]: 2 }, shared: 2, private: 1 },
    'the arrow from pa to pb listed under both, counted once');
  noLeak(cleared, [arrow, h]);
});
