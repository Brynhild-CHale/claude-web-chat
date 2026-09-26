// The page sequence (lib/server/domain/page): one ordered list of panes and
// markdown items, written by write_markdown and positioned by `after` on
// render / use_component / write_markdown. Pinned here: the order invariants,
// markdown's put/replace/remove and refusals, and that markdown + order travel
// with the surface everywhere a pane does — commit, restore, draft, branch-here,
// wipe, the no-change check, the diff, the preview, the export and the WS
// snapshot frames.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const page = require('../lib/server/domain/page');

const render = (api, id, extra = {}) => api.post('/api/render', { id, html: `<p>${id}</p>`, ...extra });
const md = (api, body) => api.post('/api/markdown', body);
const order = async (api) => (await api.get('/api/mounts')).json.order;
async function turn(api, message = 't') {
  await api.post('/api/turn-begin', { message });
  return (await api.post('/api/turn-end', {})).json;
}

async function pin(ctx, id) {
  const sock = ctx.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  await waitUntil(async () => {
    const m = (await ctx.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
    return m && m.pane_state && m.pane_state.pinned;
  });
  sock.close();
}

// ── order invariants ───────────────────────────────────────────────────────

test('page: new items append; after places; "start" goes first; a re-render keeps its place', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  const r = await md(api, { text: '## Between', after: 'a' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, 'md-1', 'a server-assigned markdown id');
  assert.deepEqual(await order(api), ['a', 'md-1', 'b']);

  await render(api, 'c', { after: 'start' });
  assert.deepEqual(await order(api), ['c', 'a', 'md-1', 'b']);

  await render(api, 'b', { html: '<p>b2</p>' });
  assert.deepEqual(await order(api), ['c', 'a', 'md-1', 'b'], 'same-id re-render without after keeps its position');
  await md(api, { id: 'md-1', text: '## Between, rewritten' });
  assert.deepEqual(await order(api), ['c', 'a', 'md-1', 'b'], 'same-id markdown rewrite keeps its position');

  await render(api, 'b', { after: 'c' });
  assert.deepEqual(await order(api), ['c', 'b', 'a', 'md-1']);
  await md(api, { id: 'md-1', text: 'x', after: 'start' });
  assert.deepEqual(await order(api), ['md-1', 'c', 'b', 'a']);

  // Panes are listed in page order too, so a reader of `mounts` alone sees it.
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.mounts.map((m) => m.id), ['c', 'b', 'a']);
});

test('page: an unknown after still writes — appended, with a warning', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  const p = await render(api, 'b', { after: 'nope' });
  assert.equal(p.json.ok, true);
  assert.match(p.json.warning, /'nope' is not on the page; appended/);
  const m = await md(api, { id: 'intro', text: 'hi', after: 'ghost' });
  assert.equal(m.json.ok, true);
  assert.match(m.json.warning, /appended/);
  // An existing item with a bad anchor keeps its place rather than jumping.
  const k = await render(api, 'a', { after: 'ghost' });
  assert.match(k.json.warning, /kept its position/);
  assert.deepEqual(await order(api), ['a', 'b', 'intro']);
  // No warning key at all on an ordinary write.
  assert.equal('warning' in (await render(api, 'c')).json, false);
});

test('page: removing a pane or a markdown item drops it from the order', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await md(api, { id: 'm', text: 'x' });
  await render(api, 'b');
  await api.post('/api/clear', { id: 'a' });
  assert.deepEqual(await order(api), ['m', 'b']);
  await api.post('/api/clear', { id: 'm' });
  assert.deepEqual(await order(api), ['b']);
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.markdown, []);
  // The explicit remove verb too.
  await md(api, { id: 'm2', text: 'y' });
  const r = await md(api, { id: 'm2', remove: true });
  assert.deepEqual(r.json, { ok: true, removed: true, id: 'm2' });
  assert.deepEqual(await order(api), ['b']);
  assert.equal((await md(api, { id: 'm2', remove: true })).json.removed, false);
});

test('page: markdown refusals — shared id space, reserved ids, size cap, owner gate, malformed', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'pane-1');
  const clash = await md(api, { id: 'pane-1', text: 'x' });
  assert.equal(clash.json.ok, false);
  assert.equal(clash.json.conflict, 'pane');

  await md(api, { id: 'prose', text: 'x' });
  const back = await render(api, 'prose');
  assert.equal(back.json.ok, false);
  assert.equal(back.json.conflict, 'markdown', 'a pane cannot take a markdown item\'s id');

  const reserved = await md(api, { id: 'topbar', text: 'x' });
  assert.equal(reserved.json.reserved, true);

  const big = await md(api, { id: 'big', text: 'x'.repeat(page.MARKDOWN_MAX_CHARS + 1) });
  assert.equal(big.json.ok, false);
  assert.equal(big.json.too_large, true);
  assert.equal(big.json.limit, page.MARKDOWN_MAX_CHARS);
  assert.equal((await md(api, { id: 'big', text: 'x'.repeat(page.MARKDOWN_MAX_CHARS) })).json.ok, true);

  const svc = await md(api, { id: 'svc', text: 'mine', owner: 'service:x' });
  assert.equal(svc.json.owner, 'service:x');
  const steal = await md(api, { id: 'svc', text: 'claude' });
  assert.equal(steal.json.owned, true);
  assert.equal((await md(api, { id: 'svc', text: 'claude', force: true })).json.ok, true);

  assert.equal((await md(api, { id: 'x' })).status, 400, 'text is required');
  assert.equal((await md(api, { remove: true })).status, 400, 'remove needs an id');
});

test('page: list_mounts summarises markdown by its headings, never echoing the text', async (t) => {
  const { api } = await withServer(t);
  await md(api, { id: 'intro', text: '# Plan\n\nsome prose\n\n## Risks' });
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.markdown, [{
    id: 'intro', owner: 'claude', chars: 28,
    headings: [{ level: 1, text: 'Plan' }, { level: 2, text: 'Risks' }],
  }]);
  assert.deepEqual(json.order, ['intro']);
});

// ── clear / wipe ───────────────────────────────────────────────────────────

test('page: a page-wide clear takes markdown too; pinned panes survive; a slot clear leaves prose', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'keep');
  await md(api, { id: 'm1', text: '## a' });
  await render(api, 'go');
  await md(api, { id: 'm2', text: '## b' });
  await pin(ctx, 'keep');

  await api.post('/api/clear', { target: 'dock' });
  assert.deepEqual(await order(api), ['keep', 'm1', 'go', 'm2'], 'a non-page target clear leaves markdown alone');

  const r = await api.post('/api/clear', {});
  assert.deepEqual(r.json.kept, ['keep']);
  assert.deepEqual(await order(api), ['keep']);
  const { json: ev } = await api.get('/api/events');
  const clear = ev.events.filter((e) => e.kind === 'clear').pop();
  assert.equal(clear.markdown, 2, 'the ring entry counts the prose it took');
});

test('page: a foreign markdown item blocks a bulk clear whole, like a foreign pane', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'mine');
  await md(api, { id: 'theirs', text: 'x', owner: 'service:y' });
  const r = await api.post('/api/clear', {});
  assert.equal(r.json.ok, false);
  assert.equal(r.json.owned, true);
  assert.deepEqual(await order(api), ['mine', 'theirs'], 'rejected whole, not half-applied');
  assert.equal((await api.post('/api/clear', { id: 'theirs' })).json.owned, true);
});

test('page: wipe clears markdown and keeps pinned panes', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'keep');
  await md(api, { id: 'm', text: '# gone' });
  await render(api, 'go');
  await pin(ctx, 'keep');
  await api.post('/api/graph/wipe', {});
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.mounts.map((m) => m.id), ['keep']);
  assert.deepEqual(json.markdown, []);
  assert.deepEqual(json.order, ['keep']);
});

// ── graph travel ───────────────────────────────────────────────────────────

test('page: a commit carries markdown + order; set-active restores them', async (t) => {
  const { api, webChatDir } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  await md(api, { id: 'h', text: '## Mid', after: 'a' });
  const first = await turn(api);
  const node = JSON.parse(fs.readFileSync(path.join(webChatDir, 'graph', `${first.node_id}.json`), 'utf8'));
  assert.deepEqual(node.markdown, [{ id: 'h', text: '## Mid', owner: 'claude' }]);
  assert.deepEqual(node.order, ['a', 'h', 'b']);
  assert.deepEqual(node.mounts.map((m) => m.id), ['a', 'b']);

  await api.post('/api/clear', {});
  await render(api, 'z');
  const second = await turn(api);
  assert.ok(second.node_id);

  await api.post('/api/graph/active', { id: first.node_id });
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.order, ['a', 'h', 'b']);
  assert.deepEqual(json.markdown.map((m) => m.id), ['h']);
});

test('page: a node without markdown carries neither field (old-node shape), and restores in mounts order', async (t) => {
  const { api, webChatDir } = await withServer(t);
  await render(api, 'b');
  await render(api, 'a');
  const r = await turn(api);
  const node = JSON.parse(fs.readFileSync(path.join(webChatDir, 'graph', `${r.node_id}.json`), 'utf8'));
  assert.equal('markdown' in node, false);
  assert.equal('order' in node, false);
  assert.deepEqual(node.mounts.map((m) => m.id), ['b', 'a']);
  // Restoring it (a node exactly like every pre-page node) is not dirt.
  await render(api, 'c');
  await api.post('/api/graph/active', { id: r.node_id });
  assert.deepEqual(await order(api), ['b', 'a']);
  assert.equal((await turn(api)).skipped, 'no-change');
});

test('page: no-change detection — a markdown edit and a reorder ARE changes; an identical rewrite is not', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  await md(api, { id: 'h', text: 'one' });
  assert.ok((await turn(api)).node_id);

  await md(api, { id: 'h', text: 'one' });
  assert.equal((await turn(api)).skipped, 'no-change', 'rewriting identical text changes nothing');

  await md(api, { id: 'h', text: 'two' });
  assert.ok((await turn(api)).node_id, 'a markdown edit commits');

  await render(api, 'b', { after: 'start' });
  assert.ok((await turn(api)).node_id, 'moving a pane commits');

  await api.post('/api/clear', { id: 'h' });
  assert.ok((await turn(api)).node_id, 'removing prose commits');
});

test('page: graceful shutdown drafts markdown + order and the next boot restores them', async (t) => {
  const { api, root, webChatDir, graceful } = await withServer(t);
  await render(api, 'a');
  await md(api, { id: 'h', text: '# Draft', after: 'start' });
  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.deepEqual(draft.markdown, [{ id: 'h', text: '# Draft', owner: 'claude' }]);
  assert.deepEqual(draft.order, ['h', 'a']);

  const { api: api2 } = await withServer(t, { root });
  const { json } = await api2.get('/api/mounts');
  assert.deepEqual(json.order, ['h', 'a']);
  assert.equal(json.markdown[0].headings[0].text, 'Draft');
});

test('page: a markdown-only surface still drafts', async (t) => {
  const { api, webChatDir, graceful } = await withServer(t);
  await md(api, { text: 'only prose' });
  await graceful();
  assert.ok(fs.existsSync(path.join(webChatDir, 'draft.json')));
});

test('page: branch-here preserves uncommitted markdown into the preserve node', async (t) => {
  const { api, webChatDir } = await withServer(t);
  await render(api, 'a');
  const base = await turn(api);
  await md(api, { id: 'wip', text: 'unsent prose' });
  const r = await api.post('/api/graph/branch-here', { id: base.node_id });
  assert.ok(r.json.preserved, 'dirty markdown forced a preserve node');
  const node = JSON.parse(fs.readFileSync(path.join(webChatDir, 'graph', `${r.json.preserved}.json`), 'utf8'));
  assert.deepEqual(node.markdown.map((m) => m.id), ['wip']);
  assert.deepEqual((await api.get('/api/mounts')).json.markdown, [], 'the re-aimed surface is the base node');
});

test('page: diff reports markdown and reorders; additions alone are not a reorder', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  await md(api, { id: 'h', text: 'one\ntwo' });
  await turn(api);

  await md(api, { id: 'h', text: 'one\nTWO' });
  await md(api, { id: 'h2', text: 'new' });
  let d = (await api.get('/api/graph/diff?a=active&b=live')).json;
  assert.deepEqual(d.markdown.added, [{ id: 'h2', chars: 3 }]);
  assert.equal(d.markdown.changed[0].id, 'h');
  assert.equal(d.markdown.changed[0].fields.text.added, 1);
  assert.equal(d.order, null, 'an appended item is an addition, not a reorder');

  await render(api, 'b', { after: 'start' });
  d = (await api.get('/api/graph/diff?a=active&b=live')).json;
  assert.deepEqual(d.order, { from: ['a', 'b', 'h'], to: ['b', 'a', 'h', 'h2'] });
});

// ── wire ───────────────────────────────────────────────────────────────────

test('page: hello carries markdown + order; markdown frames carry the order; render carries it only with after', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(ctx.api, 'a');
  await md(api, { id: 'h', text: '# hi', after: 'start' });
  const hello = await ctx.wsHello();
  assert.deepEqual(hello.order, ['h', 'a']);
  assert.deepEqual(hello.markdown, [{ id: 'h', text: '# hi', owner: 'claude' }]);

  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'));
  await render(api, 'b');
  await render(api, 'c', { after: 'h' });
  await md(api, { id: 'h2', text: 'x', after: 'a' });
  await api.post('/api/clear', { id: 'h' });
  await waitUntil(() => frames.some((f) => f.type === 'markdown:remove'));
  sock.close();

  const rb = frames.find((f) => f.type === 'render' && f.id === 'b');
  assert.equal('order' in rb, false, 'a plain append puts the frame it always did');
  const rc = frames.find((f) => f.type === 'render' && f.id === 'c');
  assert.deepEqual(rc.order, ['h', 'c', 'a', 'b']);
  const mf = frames.find((f) => f.type === 'markdown');
  assert.deepEqual(mf, { type: 'markdown', id: 'h2', text: 'x', owner: 'claude', order: ['h', 'c', 'a', 'h2', 'b'] });
  assert.deepEqual(frames.find((f) => f.type === 'markdown:remove'), { type: 'markdown:remove', id: 'h' });

  const { json } = await api.get('/api/events');
  const kinds = json.events.filter((e) => e.kind === 'markdown').map((e) => [e.op, e.id, e.source]);
  assert.deepEqual(kinds, [['put', 'h', 'claude'], ['put', 'h2', 'claude'], ['remove', 'h', 'claude']]);
});

test('page: use_component takes after', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'b');
  const r = await api.post('/api/components/git-dashboard/use', { id: 'g', after: 'a' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(await order(api), ['a', 'g', 'b']);
});

// ── preview / export fidelity ──────────────────────────────────────────────

test('page: the glance preview renders markdown in page order, escaped', async (t) => {
  const { api, baseUrl } = await withServer(t);
  await render(api, 'a');
  await md(api, { id: 'h', text: '## Hello <b>there</b>', after: 'start' });
  const r = await turn(api);
  const html = await (await fetch(`${baseUrl}/preview/node/${r.node_id}`)).text();
  const m = html.match(/const PAGE = (\[.*?\]);\n/);
  assert.ok(m, 'the preview carries its page sequence');
  const items = JSON.parse(m[1]);
  assert.deepEqual(items.map((i) => i.md || i.pane), ['h', 'a']);
  assert.equal(items[0].html, '<h2 data-slug="hello-b-there-b">Hello &lt;b&gt;there&lt;/b&gt;</h2>');
});

test('page: an export interleaves rendered markdown with the panes; a markdown-free export has no page list', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  const plain = await turn(api);
  const readPayload = async (ref) => {
    const html = (await api.get(`/api/export/${ref}`)).text || '';
    const m = html.match(/<script id="wc-export-data" type="application\/json">([\s\S]*?)<\/script>/);
    return JSON.parse(m[1]);
  };
  assert.equal('page' in await readPayload(plain.node_id), false);

  await md(api, { id: 'h', text: '# Title', after: 'start' });
  await render(api, 'b');
  const withMd = await turn(api);
  const payload = await readPayload(withMd.node_id);
  assert.deepEqual(payload.page, [
    { md: 'h', html: '<h1 data-slug="title">Title</h1>' },
    { pane: 'a' },
    { pane: 'b' },
  ]);
});

// ── the tool ───────────────────────────────────────────────────────────────

test('write_markdown tool: requires text, forwards id/after/force to /api/markdown', async () => {
  const client = require('../lib/mcp/client');
  const tool = require('../lib/mcp/tools/write_markdown');
  assert.equal(tool.name, 'write_markdown');
  assert.deepEqual(tool.inputSchema.required, ['text']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['after', 'force', 'id', 'text']);
  assert.match(tool.description, /Contents nav/i, 'says headings build the contents nav');
  assert.match(tool.description, /escaped/i, 'says raw HTML is escaped');
  const seen = [];
  const orig = client.post;
  client.post = async (p, body) => { seen.push([p, body]); return { ok: true }; };
  try {
    await tool.handler({ text: '# x', id: 'h', after: 'start', force: true, stray: 1 });
  } finally {
    client.post = orig;
  }
  assert.deepEqual(seen, [['/api/markdown', { text: '# x', id: 'h', after: 'start', force: true }]]);
});

test('render / use_component tools forward after', async () => {
  const client = require('../lib/mcp/client');
  const seen = [];
  const orig = client.post;
  client.post = async (p, body) => { seen.push([p, body]); return { ok: true }; };
  try {
    await require('../lib/mcp/tools/render').handler({ html: '<p/>', id: 'a', after: 'h' });
    await require('../lib/mcp/tools/use_component').handler({ name: 'x', id: 'b', after: 'start' });
  } finally {
    client.post = orig;
  }
  assert.equal(seen[0][1].after, 'h');
  assert.equal(seen[1][1].after, 'start');
});

// ── the engine, directly ───────────────────────────────────────────────────

test('pageOrder: honours order, drops dangling/duplicate ids, appends the unnamed', () => {
  assert.deepEqual(page.pageOrder({ mounts: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(page.pageOrder({
    mounts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    markdown: [{ id: 'm' }],
    order: ['m', 'ghost', 'b', 'm', 'a'],
  }), ['m', 'b', 'a', 'c']);
  assert.deepEqual(page.pageOrder({}), []);
});

test('page engine tolerates a hand-built state with no page fields', () => {
  const { setMount, removeMount } = require('../lib/server/domain/mounts');
  const bus = { emit() {} };
  const state = { mounts: new Map(), store: {} };
  assert.equal(setMount(state, bus, { id: 'a', html: 'x' }).ok, true);
  assert.deepEqual(state.order, ['a']);
  removeMount(state, bus, { id: 'a' });
  assert.deepEqual(state.order, []);
});

test('page.place: exact order maintenance, no reliance on read-time healing', () => {
  const state = { mounts: new Map(), store: {} };
  page.place(state, 'a');
  page.place(state, 'b');
  page.place(state, 'a');
  assert.deepEqual(state.order, ['a', 'b'], 'placing an existing id with no anchor is a no-op');
  assert.deepEqual(page.place(state, 'c', 'a'), { warning: null, moved: true });
  assert.deepEqual(state.order, ['a', 'c', 'b']);
  page.place(state, 'b', 'start');
  assert.deepEqual(state.order, ['b', 'a', 'c']);
  assert.match(page.place(state, 'c', 'c').warning, /names the item itself; kept its position/);
  assert.deepEqual(state.order, ['b', 'a', 'c']);
  page.drop(state, 'a');
  assert.deepEqual(state.order, ['b', 'c']);
});
