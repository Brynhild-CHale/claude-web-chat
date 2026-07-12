const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  assembleExport, nodeForExport, resolveExportTheme, buildExportHtml, writeExport,
  jsonForScript, slugLabel,
} = require('../lib/server/export');

// --- assembleExport (pure) ---------------------------------------------------

const TWO_PANE = {
  mounts: [
    { id: 'chart', html: '<div>Chart A</div><script>store.subscribe("k", v => {});</script>', target: 'main', params: { title: 'Chart' } },
    { id: 'form', html: '<form><input name="x"></form>', target: 'main', params: {} },
  ],
  store: { k: 42, label: 'hello' },
  page: { tokens: { '--wc-accent': '#ff0066' }, css: '' },
  meta: { label: 'n1.7', title: 'web-chat — n1.7', exportedAt: '2026-06-19 12:00:00' },
};

test('assembleExport: contains both panes, baked store, and tokens', () => {
  const html = assembleExport(TWO_PANE);
  assert.match(html, /<!doctype html>/i);
  // store baked into the JSON payload
  assert.match(html, /"k":42/);
  assert.match(html, /hello/);
  // pane html present (json-encoded, < is escaped to <)
  assert.match(html, /Chart A/);
  assert.match(html, /\\u003cform\\u003e/);
  // resolved token baked as a :root override
  assert.match(html, /--wc-accent: #ff0066/);
  // label in the caption + title
  assert.match(html, /n1\.7/);
});

test('assembleExport: self-contained — no server/network references', () => {
  const html = assembleExport(TWO_PANE);
  assert.ok(!/ws:\/\//.test(html), 'no websocket url');
  assert.ok(!/localhost/.test(html), 'no localhost');
  assert.ok(!/\/api\//.test(html), 'no api calls');
  assert.ok(!/<script\s+src=/i.test(html), 'no external script src');
  assert.ok(!/<link\s/i.test(html), 'no external stylesheet link');
});

test('assembleExport: injection-safe — </script> in html and store cannot break out', () => {
  const evil = {
    mounts: [{ id: 'x', html: '<div></script><script>window.__pwned=1</script></div>', target: 'main', params: {} }],
    store: { note: 'a</script><img src=x onerror=alert(1)>', html: '<!--' },
    page: {},
    meta: { label: 'n2' },
  };
  const html = assembleExport(evil);
  // The data payload is one <script type="application/json"> followed by the
  // shared runtime <script> and the export-shell <script> (Phase 4). Both are
  // trusted tag-free static source, so a payload breakout would add a fourth.
  const opens = (html.match(/<script/gi) || []).length;
  assert.equal(opens, 3, 'exactly three <script> tags — no breakout');
  // The literal breakout sequence must not appear raw in the document.
  assert.ok(!/<\/script><script>window\.__pwned/.test(html), 'breakout neutralized');
  // And the JSON still round-trips: extract the payload and parse it.
  const m = html.match(/<script id="wc-export-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'payload script present');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.store.note, 'a</script><img src=x onerror=alert(1)>');
  assert.equal(parsed.mounts[0].html, '<div></script><script>window.__pwned=1</script></div>');
});

test('assembleExport: raw theme css cannot break out of the head <style>', () => {
  const html = assembleExport({
    mounts: [],
    store: {},
    page: { tokens: {}, css: '</style><script>window.__cssPwned=1</script>' },
    meta: { label: 'n3' },
  });
  // The dangerous </style><script> concatenation must not survive.
  assert.ok(!html.includes('</style><script>'), 'style breakout neutralized');
  // The injected payload stays trapped inside the head <style> (inert CSS text):
  // it must appear BEFORE the first genuine </style> closer, not loose in <body>.
  const firstClose = html.indexOf('</style>');
  assert.ok(firstClose > -1, 'head style closes');
  assert.ok(html.slice(0, firstClose).includes('__cssPwned'), 'payload trapped in style block');
  assert.ok(!html.slice(firstClose).includes('__cssPwned'), 'nothing escaped into body');
});

test('assembleExport: empty node still produces a valid document', () => {
  const html = assembleExport({ mounts: [], store: {}, page: {}, meta: { label: 'n0' } });
  assert.match(html, /export-empty/);
  assert.match(html, /<!doctype html>/i);
});

test('jsonForScript: escapes < > & and line separators', () => {
  const s = jsonForScript({ a: '<b>&  ' });
  assert.ok(!s.includes('<'));
  assert.ok(!s.includes('>'));
  assert.ok(s.includes('\\u003c'));
  assert.ok(s.includes('\\u2028'));
  assert.equal(JSON.parse(s).a, '<b>&  ');
});

test('slugLabel: dots to dashes, unsafe chars stripped', () => {
  assert.equal(slugLabel('n1.7'), 'n1-7');
  assert.equal(slugLabel('live'), 'live');
  assert.equal(slugLabel('n1.1.0'), 'n1-1-0');
});

// --- ctx-dependent resolution ------------------------------------------------
// Minimal fake ctx: a graph with two nodes + a snapshotLive, and paths for theme.

const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');

function fakeCtx() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-export-')));
  const webChat = path.join(tmp, '.web-chat');
  fs.mkdirSync(path.join(webChat, 'graph'), { recursive: true });
  const paths = {
    WEB_CHAT_DIR: webChat,
    GRAPH_DIR: path.join(webChat, 'graph'),
    META_PATH: path.join(webChat, 'graph', '_meta.json'),
    THEME_PATH: path.join(webChat, 'theme.json'),
    SYSTEM_THEME_PATH: path.join(webChat, 'system-theme.json'),
  };
  const state = createState();
  const graph = createGraph({ paths, state });
  // parent before child so the child registers into the parent's children list
  graph.registerNode({ id: 'n0', parent_id: null, created_at: 1, mounts: [{ id: 'a', html: '<p>root</p>', target: 'main', params: {} }], store: { root: true } });
  graph.registerNode({ id: 'n1', parent_id: 'n0', created_at: 2, mounts: [{ id: 'b', html: '<p>child</p>', target: 'main', params: {}, theme: { tokens: { '--wc-accent': '#0f0' } } }], store: { child: 1 }, theme: { tokens: { '--wc-bg': '#000' } } });
  graph.active = 'n1';
  // seed live state for the 'live' ref
  state.mounts.set('live', { html: '<p>live</p>', target: 'main', params: {} });
  state.store.live = true;
  return { graph, state, paths, _tmp: tmp };
}

test('nodeForExport: active (default) resolves graph.active', () => {
  const ctx = fakeCtx();
  const r = nodeForExport(ctx, undefined);
  assert.equal(r.nodeId, 'n1');
  assert.equal(r.label, 'n1.1');
  assert.equal(r.mounts[0].id, 'b');
  assert.deepEqual(r.store, { child: 1 });
});

test('nodeForExport: resolves a hierarchical label', () => {
  const ctx = fakeCtx();
  const r = nodeForExport(ctx, 'n1.0'); // n0 is the first top-level tree → label n1.0
  assert.equal(r.nodeId, 'n0');
});

test('nodeForExport: resolves a raw stored id', () => {
  const ctx = fakeCtx();
  const r = nodeForExport(ctx, 'n0');
  assert.equal(r.nodeId, 'n0');
  assert.equal(r.mounts[0].id, 'a');
});

test('nodeForExport: live snapshot', () => {
  const ctx = fakeCtx();
  const r = nodeForExport(ctx, 'live');
  assert.equal(r.label, 'live');
  assert.equal(r.mounts[0].id, 'live');
  assert.deepEqual(r.store, { live: true });
});

test('nodeForExport: live bakes the active node theme (button default path)', () => {
  const ctx = fakeCtx(); // active = n1, themed --wc-bg:#000
  const resolved = nodeForExport(ctx, 'live');
  assert.equal(resolved.label, 'live');
  assert.equal(resolved.mounts[0].id, 'live');
  const theme = resolveExportTheme(ctx, resolved);
  assert.equal(theme.page.tokens['--wc-bg'], '#000', 'active node theme baked into live export');
});

test('nodeForExport: unknown ref returns an error object (no throw)', () => {
  const ctx = fakeCtx();
  const r = nodeForExport(ctx, 'nope');
  assert.ok(r.error);
});

test('resolveExportTheme: bakes node tokens at page scope and pane tokens at pane scope', () => {
  const ctx = fakeCtx();
  const resolved = nodeForExport(ctx, 'n1');
  const theme = resolveExportTheme(ctx, resolved);
  assert.equal(theme.page.tokens['--wc-bg'], '#000');            // node theme → page
  assert.equal(theme.mounts[0].tokens['--wc-bg'], '#000');       // node falls through to pane
  assert.equal(theme.mounts[0].tokens['--wc-accent'], '#0f0');   // pane's own token
});

test('buildExportHtml: full pipeline for the active node', () => {
  const ctx = fakeCtx();
  const built = buildExportHtml(ctx, undefined, new Date('2026-06-19T12:00:00Z'));
  assert.ok(built.html);
  assert.equal(built.label, 'n1.1');
  assert.match(built.html, /child/);
  assert.match(built.html, /--wc-bg: #000/);
});

test('writeExport: lands a stamped file under .web-chat/exports and returns its path', () => {
  const ctx = fakeCtx();
  const r = writeExport(ctx, undefined, new Date('2026-06-19T12:34:56Z'));
  assert.ok(fs.existsSync(r.path));
  assert.match(path.basename(r.path), /^n1-1-\d{8}-\d{6}\.html$/);
  assert.ok(r.path.includes(path.join('.web-chat', 'exports')));
  const html = fs.readFileSync(r.path, 'utf8');
  assert.match(html, /child/);
});

test('writeExport: unknown ref returns error, writes nothing', () => {
  const ctx = fakeCtx();
  const r = writeExport(ctx, 'nope');
  assert.ok(r.error);
  assert.ok(!fs.existsSync(path.join(ctx.paths.WEB_CHAT_DIR, 'exports')));
});

// --- route: GET /api/export/:ref --------------------------------------------

const { withServer } = require('../test-support/helpers');

test('route: GET /api/export/active streams an attachment', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>hello export</div>' });
  await api.post('/api/commit', { message: 'seed' });

  const res = await api.get('/api/export/active');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
  const html = res.text;
  assert.match(html, /hello export/);
  assert.ok(!/ws:\/\//.test(html));
});

test('route: ?format=file writes under .web-chat/exports and returns the path', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>filey</div>' });
  await api.post('/api/commit', { message: 'seed' });

  const r = (await api.get('/api/export/active?format=file')).json;
  assert.ok(r.ok);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.includes(path.join('.web-chat', 'exports')));
  assert.match(fs.readFileSync(r.path, 'utf8'), /filey/);
});

test('route: unknown ref → 404 with error', async (t) => {
  const { api } = await withServer(t);
  const res = await api.get('/api/export/n9.9');
  assert.equal(res.status, 404);
  const body = res.json;
  assert.ok(body.error);
});
