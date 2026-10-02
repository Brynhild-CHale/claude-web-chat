const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

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
    // Shaped like resolvePaths, which is what the real ctx carries — writeExport
    // reads EXPORTS_DIR from the path authority rather than joining 'exports'.
    EXPORTS_DIR: path.join(webChat, 'exports'),
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

// ?format=file is gated on "no browsers" (lib/core/cors isBrowserRequest), and
// Node's global `fetch` — which makeApi uses — sends `sec-fetch-mode`, so it is
// deliberately on the browser side of that gate. This is the request lib/client
// actually makes: raw http.request, no fetch metadata. Same helper shape as
// test/shutdown-route.test.js, the other file that lives on both sides of it.
function rawGet(port, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('route: ?format=file writes under .web-chat/exports and returns the path', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>filey</div>' });
  await api.post('/api/commit', { message: 'seed' });

  const r = (await rawGet(port, '/api/export/active?format=file')).json;
  assert.ok(r.ok);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.includes(path.join('.web-chat', 'exports')));
  assert.match(fs.readFileSync(r.path, 'utf8'), /filey/);
});

test('route: ?format=file refuses a browser, and writes nothing', async (t) => {
  const { api, port, webChatDir } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>filey</div>' });
  await api.post('/api/commit', { message: 'seed' });
  const exportsDir = path.join(webChatDir, 'exports');

  // Any page the user is browsing can fire this GET; it does not need to read
  // the reply for the disk write and the ring entry to have happened.
  for (const headers of [
    { origin: 'https://evil.example' },
    { 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-dest': 'image' },
  ]) {
    const res = await rawGet(port, '/api/export/active?format=file', headers);
    assert.equal(res.status, 403, `refused with ${JSON.stringify(headers)}`);
    assert.match(res.json.hint, /download button/);
    assert.ok(!fs.existsSync(exportsDir), 'no export directory was created');
  }

  // The download shape — same route, no format=file — is untouched: its callers
  // ARE browsers (the topbar and graph-view buttons).
  const dl = await api.get('/api/export/active');
  assert.equal(dl.status, 200);
  assert.match(dl.text, /filey/);
  assert.ok(!fs.existsSync(exportsDir), 'and it still writes nothing');
});

test('route: unknown ref → 404 with error', async (t) => {
  const { api } = await withServer(t);
  const res = await api.get('/api/export/n9.9');
  assert.equal(res.status, 404);
  const body = res.json;
  assert.ok(body.error);
});

// --- the MCP tool handler ----------------------------------------------------
//
// The tool carried `if (r && r.error) return { error: r.error }` after a
// client.get — a branch that could never run, because the one client engine
// turns any status >= 400 into a throw and the route answers an unknown ref only
// with a 404. So the tool's documented contract (a plain {error} result) was not
// the contract it had: an unknown label reached Claude as a raw transport error.
// These two pin the real one, end to end through the handler.

test('tool: an unknown ref returns the documented {error, ref}, not a transport error', async (t) => {
  const { port } = await withServer(t);
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });

  const tool = require('../lib/mcp/tools/export');
  const r = await tool.handler({ node: 'n9.9' });
  assert.equal(r.ok, undefined, 'not a success');
  assert.ok(r.error, 'the route\'s 404 body reaches the caller as {error}');
  assert.equal(r.ref, 'n9.9', 'and names the ref that was wrong');
});

test('tool: a known node still exports and reports its path', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>tooly</div>' });
  await api.post('/api/commit', { message: 'seed' });
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });

  const tool = require('../lib/mcp/tools/export');
  const r = await tool.handler({});
  assert.ok(r.ok, 'the happy path is untouched by the new catch');
  assert.ok(fs.existsSync(r.path));
  assert.match(fs.readFileSync(r.path, 'utf8'), /tooly/);
});

// --- the page layout: runs and placement, as the node preview draws them -----
//
// The export used to lay every pane out as a full-width card in one flex column
// and carried no pane_state, while the node preview drew the same node in the
// live page's grid runs. Both documents now splice ONE layout function
// (lib/server/preview drawPage), so these compare the two documents' DOM for the
// same node rather than restating the placement rules.

const { JSDOM } = require('jsdom');
const { drawPage, renderNodePreview, renderPreviewHtml } = require('../lib/server/preview');
const { source: pageCssSource } = require('../lib/server/runtime/page-css-src');

// Every style rule a parsed document's stylesheets hold, with the @media it
// sits in ('' at the top level) and a key from the CSSOM's own text — so two
// sheets compare by the rules a browser would apply, not by their bytes.
function styleRules(doc) {
  const out = [];
  (function walk(list, media) {
    for (const r of list) {
      if (r.media && r.cssRules) walk(r.cssRules, r.media.mediaText);
      else if (r.selectorText) out.push({ media, selector: r.selectorText, style: r.style, key: `${media} ${r.cssText}` });
    }
  })([...doc.styleSheets].flatMap((s) => [...s.cssRules]), '');
  return out;
}

// The drawn page, as data: each markdown block, and each run with its panes'
// placement. `mainId` is the document's page container.
function layoutOf(html, mainId) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const main = dom.window.document.getElementById(mainId);
  const out = [...main.children].map((el) => (el.classList.contains('md-block')
    ? { md: el.getAttribute('data-md-id'), html: el.innerHTML }
    : {
      run: el.getAttribute('data-anchor'),
      cls: el.className,
      grid: el.firstElementChild.className,
      panes: [...el.firstElementChild.children].map((p) => ({
        id: p.querySelector('.mount-host').id,
        cls: p.className,
        col: p.style.getPropertyValue('--col'),
        span: p.style.getPropertyValue('--span'),
        rows: p.style.getPropertyValue('--rows'),
        minHeight: p.style.minHeight,
      })),
    }));
  dom.window.close();
  return out;
}

// A page: a title, two span-6 panes side by side, a caption, then a full-width
// pane in a run the user set not to stack.
const LAID_OUT = {
  id: 'n9',
  mounts: [
    { id: 'left', html: '<p>left</p>', target: 'main', params: { title: 'Left' }, pane_state: { colSpan: 6 } },
    { id: 'right', html: '<p>right</p>', target: 'main', params: {}, pane_state: { col: 7, colSpan: 6, rows: 4 } },
    { id: 'wide', html: '<p>wide</p>', target: 'main', params: {} },
  ],
  markdown: [{ id: 'md-title', text: '# The page' }, { id: 'md-cap', text: 'Below the pair.' }],
  order: ['md-title', 'left', 'right', 'md-cap', 'wide'],
  runs: { 'md-cap': { stacks: false } },
  store: {},
};

function exportOf(node) {
  return assembleExport({
    mounts: node.mounts, markdown: node.markdown, order: node.order, runs: node.runs,
    store: node.store, meta: { label: 'n1.9' },
  });
}

test('layout: two span-6 panes share one run, placed exactly as the node preview places them', () => {
  const exported = layoutOf(exportOf(LAID_OUT), 'export-main');
  const previewed = layoutOf(renderPreviewHtml(LAID_OUT, { tokens: {} }), 'main');
  assert.deepEqual(exported, previewed, 'the export draws the preview\'s runs and placement');

  const pair = exported[1];
  assert.equal(pair.run, 'md-title');
  assert.equal(pair.cls, 'page-run stacks');
  assert.equal(pair.grid, 'run-grid');
  assert.deepEqual(pair.panes.map((p) => [p.id, p.col, p.span, p.rows]), [
    ['left', 'auto', '6', ''],
    ['right', '7', '6', '4'],
  ], 'both halves of the pair in ONE run, side by side');
  assert.equal(pair.panes[1].cls, 'pane has-rows', 'a pane with rows is that tall');
});

test('layout: markdown lands between the runs, in page order', () => {
  const exported = layoutOf(exportOf(LAID_OUT), 'export-main');
  assert.deepEqual(exported.map((it) => (it.md ? `md:${it.md}` : `run:${it.run}[${it.panes.map((p) => p.id)}]`)),
    ['md:md-title', 'run:md-title[left,right]', 'md:md-cap', 'run:md-cap[wide]']);
  assert.equal(exported[0].html, '<h1 data-slug="the-page">The page</h1>', 'rendered and escaped on the host');
  assert.equal(exported[3].cls, 'page-run fixed', 'the run the user set not to stack keeps its grid on a narrow screen');
});

test('layout: a pane with no placement is full width', () => {
  const [run] = layoutOf(assembleExport({ mounts: [{ id: 'solo', html: '<p>x</p>' }] }), 'export-main');
  assert.equal(run.run, 'start', 'a page with no markdown is one run from the top');
  assert.deepEqual(run.panes, [{ id: 'solo', cls: 'pane', col: 'auto', span: '12', rows: '', minHeight: '' }]);
});

test('layout: the old single-column markup is gone', () => {
  const html = exportOf(LAID_OUT);
  assert.ok(!html.includes('display: flex; flex-direction: column; gap: 14px'), 'no flex column of cards');
  assert.match(html, /<main id="export-main" class="page"><\/main>/, 'the page container is a .page, as the preview\'s is');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('#export-main > .pane').length, 0, 'no pane card directly in the page');
  const panes = [...doc.querySelectorAll('.pane')];
  assert.equal(panes.length, 3);
  for (const p of panes) assert.ok(p.parentElement.classList.contains('run-grid'), `${p.dataset.paneId} sits in a run's grid`);

  // public/page.css is what places them — the stylesheet the preview inlines
  // too. It is read here from its one accessor, never copied, so restyling the
  // page cannot break this test while dropping or breaking the sheet in the
  // file still does: the whole sheet is inlined, every rule of it is live in
  // the parsed document, and among them are the two this markup needs.
  const pageCss = pageCssSource();
  assert.ok(html.includes(pageCss), 'public/page.css is inlined whole');
  const sheet = new JSDOM(`<style>${pageCss}</style>`);
  const own = styleRules(sheet.window.document);
  const live = new Set(styleRules(doc).map((r) => r.key));
  for (const r of own) {
    assert.ok(live.has(r.key), `page.css's \`${r.selector}\`${r.media ? ` (@media ${r.media})` : ''} is a live rule in the export`);
  }
  const pane = doc.querySelector('.run-grid > .pane');
  assert.ok(own.some((r) => !r.media && pane.matches(r.selector) && /var\(--col\b.*var\(--span\b/.test(r.style.getPropertyValue('grid-column'))),
    'a page.css rule puts each pane on its run\'s grid from the --col / --span its card carries');
  const stacking = doc.querySelector('.page-run.stacks .run-grid');
  assert.ok(own.some((r) => /max-width/.test(r.media) && stacking.matches(r.selector) && r.style.getPropertyValue('grid-template-columns')),
    'and a narrow-screen page.css rule re-lays a stacking run\'s grid');
  sheet.window.close();
  dom.window.close();
});

test('layout: a minimized pane stays out of the grid, as it does on the page', () => {
  const html = assembleExport({ mounts: [
    { id: 'shown', html: '<p>x</p>' },
    { id: 'tucked', html: '<p>y</p>', pane_state: { colSpan: 6, minimized: true } },
  ] });
  const [run] = layoutOf(html, 'export-main');
  assert.equal(run.panes[1].cls, 'pane minimized');
  assert.ok(html.includes('.pane.minimized { display: none; }'));
});

test('layout: a markdown-free page rides in page order and carries no page list', () => {
  const html = assembleExport({
    mounts: [{ id: 'b', html: '<p>b</p>' }, { id: 'a', html: '<p>a</p>' }],
    order: ['a', 'b'],
  });
  const payload = JSON.parse(html.match(/<script id="wc-export-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal('page' in payload, false, 'the mounts ARE the page');
  assert.equal('runs' in payload, false, 'no run flags off their default');
  assert.deepEqual(payload.mounts.map((m) => m.id), ['a', 'b'], 'in the order the page shows them');
  assert.deepEqual(layoutOf(html, 'export-main')[0].panes.map((p) => p.id), ['a', 'b']);
});

test('layout: pane scripts still mount and run inside the placed cards, and api.spawn answers {ok:false}', async () => {
  const html = assembleExport({
    mounts: [
      {
        id: 'live',
        html: '<input id="q"><output id="o"></output><script>'
          + 'root.getElementById("o").textContent = "RAN:" + mountId;'
          + 'api.spawn({ html: "<p>child</p>" }).then(function (r) { store.set({ spawned: r }); });'
          + '</script>',
        params: { title: 'Live' },
        tokens: { '--wc-accent': '#123456' },
        pane_state: { colSpan: 6 },
        form_state: { '#q:0': { value: 'typed' } },
      },
      { id: 'other', html: '<p>other</p>', pane_state: { colSpan: 6 } },
    ],
    store: { seed: 1 },
  });
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  await new Promise((r) => setTimeout(r, 30));
  const doc = dom.window.document;
  const host = doc.getElementById('live');
  const pane = host.parentElement;
  assert.equal(host.shadowRoot.getElementById('o').textContent, 'RAN:live', 'the pane script ran');
  assert.equal(host.shadowRoot.getElementById('q').value, 'typed', 'typed form values rehydrated');
  assert.equal(dom.window.store.get('seed'), 1, 'the store snapshot is baked');
  const spawned = dom.window.store.get('spawned');
  assert.equal(spawned.ok, false, 'a frozen page spawns nothing');
  assert.equal(doc.querySelectorAll('.pane').length, 2, 'and no pane was added');
  assert.equal(pane.style.getPropertyValue('--wc-accent'), '#123456', 'per-pane token on the card');
  assert.equal(pane.style.getPropertyValue('--span'), '6', 'beside its placement');
  assert.equal(pane.querySelector('.pane-title').textContent, 'Live');
  dom.window.close();
});

test('drawPage: one layout, spliced into both documents, safe inside an inline script', () => {
  const src = drawPage.toString();
  assert.ok(!/<\/script/i.test(src), 'no script end tag in the spliced source');
  assert.ok(!src.includes('<!--'), 'no comment opener to push the parser into script-data-escaped');
  assert.ok(exportOf(LAID_OUT).includes(src), 'the export carries the function verbatim');
  assert.ok(renderPreviewHtml(LAID_OUT, {}).includes(src), 'and so does the node preview');
});

test('buildExportHtml: a committed node keeps its layout — pane_state and run flags ride in the file', () => {
  const ctx = fakeCtx();
  ctx.graph.registerNode({
    id: 'n2', parent_id: 'n1', created_at: 3,
    mounts: LAID_OUT.mounts.map((m) => ({ ...m })),
    markdown: LAID_OUT.markdown.map((m) => ({ ...m })),
    order: LAID_OUT.order.slice(),
    runs: { ...LAID_OUT.runs },
    store: {},
  });
  const built = buildExportHtml(ctx, 'n2', new Date('2026-06-19T12:00:00Z'));
  const payload = JSON.parse(built.html.match(/<script id="wc-export-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(payload.mounts.map((m) => m.pane_state), [{ colSpan: 6 }, { col: 7, colSpan: 6, rows: 4 }, undefined]);
  assert.deepEqual(payload.runs, { 'md-cap': { stacks: false } });
  // The same node through the graph's own preview route builder.
  assert.deepEqual(layoutOf(built.html, 'export-main'),
    layoutOf(renderNodePreview(ctx.paths, ctx.graph.nodes.get('n2')), 'main'));
});
