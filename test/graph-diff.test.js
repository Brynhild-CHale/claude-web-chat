const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { lineDiff, diffNodes, stableStringify } = require('../lib/server/diff');

async function render(api, id, html) { return api.post('/api/render', { id, html }); }
async function turn(api) {
  await api.post('/api/turn-begin', {});
  return api.post('/api/turn-end', { author: 'claude', summary: 't' });
}

// ---- unit: lineDiff ------------------------------------------------------

test('lineDiff: identical strings → null', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nb\nc'), null);
});

test('lineDiff: one changed line → counts + hunk with -/+ lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.hunks.length >= 1);
  const lines = d.hunks.flatMap((h) => h.lines);
  assert.ok(lines.includes('-b'), 'has removed line');
  assert.ok(lines.includes('+B'), 'has added line');
  assert.ok(lines.includes(' a'), 'has context line');
});

test('lineDiff: oversized input is summarized, not diffed', () => {
  const big = Array.from({ length: 1000 }, (_, i) => 'line ' + i).join('\n');
  const d = lineDiff(big, big + '\nextra', { maxLines: 800 });
  assert.equal(d.too_large, true);
  assert.equal(d.hunks, undefined);
  assert.ok(d.a_bytes > 0 && d.b_bytes > d.a_bytes);
});

test('lineDiff: hunk count is capped with truncated flag', () => {
  const a = Array.from({ length: 100 }, (_, i) => 'x' + i).join('\n');
  const b = Array.from({ length: 100 }, (_, i) => 'y' + i).join('\n');
  const d = lineDiff(a, b, { context: 0, maxHunkLines: 10 });
  assert.equal(d.truncated, true);
  assert.ok(d.hunks.flatMap((h) => h.lines).length <= 10);
});

// ---- unit: diffNodes -----------------------------------------------------

test('diffNodes: store add/remove/change/unchanged classified', () => {
  const a = { mounts: [], store: { keep: 1, drop: 2, mut: 'old' } };
  const b = { mounts: [], store: { keep: 1, mut: 'new', fresh: 3 } };
  const d = diffNodes(a, b);
  assert.deepEqual(d.store.added, { fresh: 3 });
  assert.deepEqual(d.store.removed, { drop: 2 });
  assert.deepEqual(d.store.changed, { mut: { from: 'old', to: 'new' } });
  assert.deepEqual(d.store.unchanged, ['keep']);
});

test('diffNodes: node-level theme token diff', () => {
  const a = { mounts: [], store: {}, theme: { tokens: { '--wc-bg': '#fff', '--wc-fg': '#000' } } };
  const b = { mounts: [], store: {}, theme: { tokens: { '--wc-bg': '#111', '--wc-accent': '#0af' } } };
  const d = diffNodes(a, b);
  assert.deepEqual(d.theme.tokens.changed, { '--wc-bg': { from: '#fff', to: '#111' } });
  assert.deepEqual(d.theme.tokens.added, { '--wc-accent': '#0af' });
  assert.deepEqual(d.theme.tokens.removed, { '--wc-fg': '#000' });
});

test('stableStringify: key order does not matter; undefined ≠ null', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify(undefined), stableStringify(null));
});

// ---- integration: /api/graph/diff ----------------------------------------

test('diff route: added / changed mounts and added store between two nodes', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>one</div>'); await turn(api);            // n1.0
  await render(api, 'p1', '<div>ONE changed</div>');                       // change p1
  await render(api, 'p2', '<div>two</div>');                              // add p2
  await api.post('/api/store', { patch: { x: 1 } });
  await turn(api);                                                         // n1.1

  const d = (await api.get('/api/graph/diff?a=n1.0&b=n1.1')).json;
  assert.equal(d.a.label, 'n1.0');
  assert.equal(d.b.label, 'n1.1');

  assert.deepEqual(d.mounts.added.map((m) => m.id), ['p2']);
  assert.deepEqual(d.mounts.removed, []);
  assert.deepEqual(d.mounts.changed.map((m) => m.id), ['p1']);
  assert.ok(d.mounts.changed[0].fields.html, 'p1 html field changed');
  assert.ok(d.mounts.changed[0].fields.html.hunks.length >= 1);

  assert.deepEqual(d.store.added, { x: 1 });
});

test('diff route: resolves opaque ids and is symmetric in direction', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>'); await turn(api);
  await render(api, 'p2', '<div>b</div>'); await turn(api);

  const g = (await api.get('/api/graph')).json;
  const byLabel = Object.fromEntries(g.nodes.map((n) => [n.label, n.id]));
  const fwd = (await api.get(`/api/graph/diff?a=${byLabel['n1.0']}&b=${byLabel['n1.1']}`)).json;
  assert.deepEqual(fwd.mounts.added.map((m) => m.id), ['p2']);

  // reverse direction: p2 is now a removal
  const rev = (await api.get('/api/graph/diff?a=n1.1&b=n1.0')).json;
  assert.deepEqual(rev.mounts.removed.map((m) => m.id), ['p2']);
});

test('diff route: same node yields no changes, only unchanged lists', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>'); await turn(api);
  const d = (await api.get('/api/graph/diff?a=n1.0&b=n1.0')).json;
  assert.deepEqual(d.mounts.added, []);
  assert.deepEqual(d.mounts.removed, []);
  assert.deepEqual(d.mounts.changed, []);
  assert.deepEqual(d.mounts.unchanged, ['p1']);
  assert.equal(d.theme, null);
});

test('diff route: `live` compares the uncommitted surface against a node', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>'); await turn(api);  // n1.0, active
  // after the commit the live surface still mirrors n1.0
  let d = (await api.get('/api/graph/diff?a=active&b=live')).json;
  assert.deepEqual(d.mounts.changed, []);
  assert.deepEqual(d.mounts.added, []);

  // now mutate the live surface without committing
  await render(api, 'p2', '<div>live only</div>');
  d = (await api.get('/api/graph/diff?a=n1.0&b=live')).json;
  assert.deepEqual(d.mounts.added.map((m) => m.id), ['p2']);
  assert.equal(d.b.label, 'live');
});

test('diff route: missing params → 400, unknown ref → 404', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>'); await turn(api);

  assert.equal((await api.get('/api/graph/diff?a=n1.0')).status, 400);
  const r404 = await api.get('/api/graph/diff?a=n1.0&b=n9.9');
  assert.equal(r404.status, 404);
  assert.equal(r404.json.which, 'b');
});

// ---- unit: edge cases surfaced by review ---------------------------------

test('lineDiff: a lone trailing-newline difference is treated as equal', () => {
  assert.equal(lineDiff('<div>x</div>', '<div>x</div>\n'), null);
});

test('lineDiff: trailing newline does not inflate line counts or hunk headers', () => {
  const d = lineDiff('L1\nL2\nL3\nL4\nL5\n', 'L1\nL2\nX\nL4\nL5\n');
  assert.equal(d.a_lines, 5);
  assert.equal(d.b_lines, 5);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks[0].header, '@@ -1,5 +1,5 @@');
});

test('lineDiff: exact hunk headers and split into two hunks when changes are far apart', () => {
  const a = 'l1\nl2\nl3\nl4\nl5\nl6';
  const b = 'l1\nL2\nl3\nl4\nl5\nL6';
  const d = lineDiff(a, b, { context: 1 });
  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[0].header, '@@ -1,3 +1,3 @@');
  assert.equal(d.hunks[1].header, '@@ -5,2 +5,2 @@');
  const lines = d.hunks.flatMap((h) => h.lines);
  for (const l of ['-l2', '+L2', '-l6', '+L6']) assert.ok(lines.includes(l), `expected ${l}`);
});

test('lineDiff: truncated hunk header counts match the lines actually emitted', () => {
  // one big hunk, then cap it: the header must describe the kept body, not the full hunk
  const a = Array.from({ length: 20 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 20 }, (_, i) => 'b' + i).join('\n');
  const d = lineDiff(a, b, { context: 0, maxHunkLines: 5 });
  assert.equal(d.truncated, true);
  for (const h of d.hunks) {
    const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(h.header);
    const aCount = h.lines.filter((l) => l[0] !== '+').length;
    const bCount = h.lines.filter((l) => l[0] !== '-').length;
    assert.equal(Number(m[1]), aCount, 'header -count matches body');
    assert.equal(Number(m[2]), bCount, 'header +count matches body');
  }
});

test('diffNodes: a changed non-html mount field is reported as {from,to}', () => {
  const a = { mounts: [{ id: 'm', html: '<x>', params: { title: 'A' } }], store: {} };
  const b = { mounts: [{ id: 'm', html: '<x>', params: { title: 'B' } }], store: {} };
  const d = diffNodes(a, b);
  assert.equal(d.mounts.changed.length, 1);
  assert.equal(d.mounts.changed[0].fields.html, undefined, 'html unchanged');
  assert.deepEqual(d.mounts.changed[0].fields.params, { from: { title: 'A' }, to: { title: 'B' } });
});

test('diffNodes: theme css change is a line-diff; equal css with differing tokens → null css', () => {
  const a = { mounts: [], store: {}, theme: { tokens: { '--wc-bg': '#fff' }, css: 'a{color:red}' } };
  const b = { mounts: [], store: {}, theme: { tokens: { '--wc-bg': '#000' }, css: 'a{color:blue}' } };
  const d = diffNodes(a, b);
  assert.ok(d.theme.css && d.theme.css.added === 1 && d.theme.css.removed === 1);

  const c = { mounts: [], store: {}, theme: { tokens: { '--wc-bg': '#abc' }, css: 'a{color:red}' } };
  const d2 = diffNodes(a, c);
  assert.equal(d2.theme.css, null, 'identical css diffs to null even when tokens differ');
  assert.deepEqual(d2.theme.tokens.changed, { '--wc-bg': { from: '#fff', to: '#abc' } });
});

// ---- integration: edge cases ---------------------------------------------

test('diff route: oversized mount html is summarized (too_large), not dumped', async (t) => {
  const { api } = await withServer(t);

  const big = Array.from({ length: 820 }, (_, i) => `<p>${i}</p>`).join('\n');
  await render(api, 'big', big); await turn(api);              // n1.0
  await render(api, 'big', big + '\n<p>extra</p>'); await turn(api); // n1.1

  const d = (await api.get('/api/graph/diff?a=n1.0&b=n1.1')).json;
  const html = d.mounts.changed.find((m) => m.id === 'big').fields.html;
  assert.equal(html.too_large, true);
  assert.equal(html.hunks, undefined, 'no hunks dumped for oversized html');
  assert.ok(html.a_bytes > 0 && html.b_bytes > html.a_bytes);
});

test('diff route: store changed key reported end-to-end through the surface', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>');
  await api.post('/api/store', { patch: { k: 'v1' } });
  await turn(api);                                              // n1.0: {k:v1}
  await api.post('/api/store', { patch: { k: 'v2' } });
  await turn(api);                                              // n1.1: {k:v2}

  const d = (await api.get('/api/graph/diff?a=n1.0&b=n1.1')).json;
  assert.deepEqual(d.store.changed, { k: { from: 'v1', to: 'v2' } });
  assert.deepEqual(d.mounts.unchanged, ['p1']);
});

test('diff route: nodes in different top-level trees diff cleanly', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<a/>'); await turn(api);           // n1.0
  await api.post('/api/graph/new', {});                        // new top-level tree (active → null)
  await render(api, 'p2', '<b/>'); await turn(api);           // n2.0

  const d = (await api.get('/api/graph/diff?a=n1.0&b=n2.0')).json;
  assert.deepEqual(d.mounts.removed.map((m) => m.id), ['p1']);
  assert.deepEqual(d.mounts.added.map((m) => m.id), ['p2']);
});

test('diff route: `active` with no active node → 404 with a clear message', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1', '<div>a</div>'); await turn(api);
  await api.post('/api/graph/new', {}); // active → null (new graph)

  const r = await api.get('/api/graph/diff?a=active&b=live');
  assert.equal(r.status, 404);
  assert.equal(r.json.which, 'a');
  assert.match(r.json.error, /no active node/);
});

test('diff_nodes tool: forwards context=0 but omits context when undefined', async () => {
  const client = require('../lib/mcp/client');
  const tool = require('../lib/mcp/tools/diff_nodes');
  const seen = [];
  const orig = client.get;
  client.get = async (p) => { seen.push(p); return {}; };
  try {
    await tool.handler({ a: 'n1.0', b: 'live', context: 0 });
    await tool.handler({ a: 'n1.0', b: 'live' });
  } finally {
    client.get = orig;
  }
  assert.match(seen[0], /a=n1.0/);
  assert.match(seen[0], /b=live/);
  assert.match(seen[0], /[?&]context=0(&|$)/, 'context=0 is forwarded (0 != null)');
  assert.ok(!/context=/.test(seen[1]), 'context omitted when undefined');
});
