// The anchor resolver's delivery (annotation engine, PLAN.md 1C.1): the one
// factory in lib/core/anchors.js, served to the chrome as an ES module and
// spliced, compacted, into every node preview, replay frame and export, after
// the shared mount runtime, where it installs window.__wcMount.anchor. Pinned:
//   - GET /app/anchors.js serves browserModuleSource() verbatim, as JavaScript,
//     under the existing /app/* remote-policy row;
//   - lib/server/runtime/anchors-src: memoised, read on first use (never at
//     require time), free of whole-line comments and of any script, style or
//     HTML-comment opener, and answering exactly as the uncompacted copy does;
//   - the preview route, a replay and an export each carry it once, after the
//     runtime, and resolve a record exact in their own document;
//   - its size, logged (the 1C gate measures B3's 5% share), under a tripwire.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { classify } = require('../lib/core/remote-policy');
const { PREVIEW_CSP } = require('../lib/core/cors');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const { source: runtimeSource } = require('../lib/server/runtime/mount-runtime-src');
const { assembleExport } = require('../lib/server/export');
const { assembleReplay, normalizeReplayOpts } = require('../lib/server/replay/document');
const { getBuiltin } = require('../lib/server/theme');
const { inlineFontCss } = require('../lib/server/fonts');
const { withServer } = require('../test-support/helpers');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'element-cases.json'), 'utf8'));
const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const FLAGS = ['gate', 'tiebreak', 'head_floor', 'ordinal'];
// The text the factory's IIFE opens its factory with — one per copy in a document.
const MARK = 'var createAnchors = function createAnchors(';
const count = (s, sub) => s.split(sub).length - 1;
const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
const wire = (o) => JSON.parse(JSON.stringify(o));

const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });
function scripted(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  WINDOWS.push(dom.window);
  return dom.window;
}

// ── the served module ─────────────────────────────────────────────────────

test('GET /app/anchors.js serves browserModuleSource() as JavaScript', async (t) => {
  const { port } = await withServer(t);
  const res = await fetch(`http://localhost:${port}/app/anchors.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
  assert.strictEqual(await res.text(), anchors.browserModuleSource());
});

test('the served module exposes the api: record, resolve, restamp, index, install and the later sections\' names', async () => {
  const mod = await importSource(anchors.browserModuleSource());
  for (const n of ['record', 'resolve', 'restamp', 'index', 'install',
    'resolveAll', 'invalidate', 'watch', 'recordRange', 'resolveRange', 'recordSource', 'resolveSource']) {
    assert.equal(typeof mod[n], 'function', n);
  }
  assert.equal(typeof mod.default.resolve, 'function');
});

test('/app/anchors.js is reachable under the existing /app/* remote-policy row', () => {
  assert.equal(classify('GET', '/app/anchors.js').allow, true);
});

// ── the document source: memo and compaction ─────────────────────────────

test('anchors-src: no work at require time, then memoised', () => {
  const key = require.resolve('../lib/server/runtime/anchors-src');
  const saved = require.cache[key];
  const real = anchors.documentSource;
  let calls = 0;
  anchors.documentSource = function () { calls++; return real.apply(this, arguments); };
  try {
    delete require.cache[key];
    const fresh = require('../lib/server/runtime/anchors-src');
    assert.equal(calls, 0, 'requiring it reads nothing');
    const a = fresh.source();
    assert.equal(calls, 1, 'read on first use');
    assert.strictEqual(fresh.source(), a, 'the identical string twice');
    assert.equal(calls, 1, 'memoised');
    assert.strictEqual(a, anchorsSrc.source());
  } finally {
    anchors.documentSource = real;
    require.cache[key] = saved;
  }
});

test('anchors-src: compacted — no whole-line comment, blank line or indentation; no script, style or comment opener', () => {
  const src = anchorsSrc.source();
  assert.ok(src.length < anchors.documentSource().length, 'smaller than the full copy');
  for (const line of src.split('\n')) {
    assert.notEqual(line, '', 'no blank line');
    assert.ok(!/^\s*\/\//.test(line), `no whole-line comment: ${line}`);
    assert.ok(!/^\s/.test(line), `no leading indentation: ${line}`);
  }
  for (const bad of [/<script/i, /<\/script/i, /<style/i, /<\/style/i, /<!--/]) assert.doesNotMatch(src, bad);
  assert.equal(count(src, MARK), 1);
});

// One window holding both copies, each installed in turn on the same runtime, so
// their answers name the same DOM nodes and compare deep-equal directly.
function bothCopies() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  WINDOWS.push(dom.window);
  const w = dom.window;
  w.eval(RUNTIME);
  w.eval(anchors.documentSource());
  const full = w.__wcMount.anchor;
  w.eval(anchorsSrc.source());
  const compact = w.__wcMount.anchor;
  return { w, full, compact };
}

test('anchors-src: installs window.__wcMount.anchor after the runtime, and answers as the uncompacted copy on every element fixture', () => {
  const { w, full, compact } = bothCopies();
  assert.equal(typeof compact.resolve, 'function');
  assert.notStrictEqual(compact, full, 'the compacted copy installed its own api');
  assert.deepStrictEqual({ ...compact.CONFIG }, { ...full.CONFIG });
  assert.deepStrictEqual({ ...compact.LIMITS }, { ...full.LIMITS });
  let n = 0;
  const mountIn = (html, id) => {
    const host = w.document.createElement('div');
    host.dataset.mountId = id;
    w.document.body.appendChild(host);
    return w.__wcMount.attachAndExtract(host, html).root;
  };
  const cfgs = [{}];
  for (let m = 0; m < 1 << FLAGS.length; m++) {
    const cfg = {};
    FLAGS.forEach((f, k) => { cfg[f] = !!(m & (1 << k)); });
    cfgs.push(cfg);
  }
  for (const c of FIX.cases) {
    const from = mountIn(c.from, 'm');
    const to = mountIn(c.to, 'm');
    const el = from.querySelector(c.target);
    const rec = full.record(from, el);
    assert.deepStrictEqual(compact.record(from, el), rec, c.name);
    if (!rec) continue;
    const w1 = wire(rec);
    if (c.strip_heads) for (const r of w1.rows) delete r.head;
    for (const cfg of cfgs) {
      const a = full.resolve(to, w1, cfg);
      assert.deepStrictEqual(compact.resolve(to, w1, cfg), a, `${c.name} ${JSON.stringify(cfg)}`);
      assert.deepStrictEqual(compact.restamp(w1, a), full.restamp(w1, a), `${c.name}: restamp`);
      n++;
    }
  }
  for (const loc of FIX.locator) {
    const root = mountIn(loc.html, 'm');
    assert.deepStrictEqual(compact.resolve(root, loc.rec), full.resolve(root, loc.rec));
    n++;
  }
  assert.ok(n > FIX.cases.length, `compared ${n} answers`);
});

// ── the documents ────────────────────────────────────────────────────────

// The factory spliced once, as its own script, right after the runtime's.
function assertSpliced(html, where) {
  assert.equal(count(html, anchorsSrc.source()), 1, `${where}: the compacted factory exactly once`);
  assert.equal(count(html, MARK), 1, `${where}: no second copy of the factory`);
  const rt = html.indexOf(`<script>${runtimeSource()}</script>\n<script>${anchorsSrc.source()}</script>`);
  assert.ok(rt >= 0, `${where}: its own <script>, immediately after the runtime's`);
}

// Record an element of `id`'s pane and resolve it in the same document.
function resolvesExact(w, id, sel, where) {
  const A = w.__wcMount && w.__wcMount.anchor;
  assert.ok(A && typeof A.resolve === 'function', `${where}: window.__wcMount.anchor is installed`);
  const it = w.__wcMount.itemEl(w.document, id);
  assert.ok(it && it.el.shadowRoot, `${where}: pane ${id} drawn`);
  const root = it.el.shadowRoot;
  const el = root.querySelector(sel);
  assert.ok(el, `${where}: ${sel} in ${id}`);
  const rec = A.record(root, el, { mount: id });
  assert.ok(rec, `${where}: recorded`);
  const ans = A.resolve(root, wire(rec));
  assert.equal(ans.state, 'exact', `${where}: resolves exact`);
  assert.strictEqual(ans.el, el, `${where}: the same element`);
}

const TWO = [
  { id: 'm1', html: '<ul class="list"><li class="row"><b>Alpha</b><span class="act">edit</span></li><li class="row"><b>Beta</b><span class="act">edit</span></li></ul>' },
  { id: 'm2', html: '<p class="note">The second pane</p>' },
];

test('preview: /preview/node/n0 carries the factory once after the runtime, under PREVIEW_CSP unchanged, and resolves exact', async (t) => {
  const { api, port } = await withServer(t);
  for (const m of TWO) await api.post('/api/render', { id: m.id, html: m.html });
  await api.post('/api/commit', { message: 'seed' });
  const res = await fetch(`http://localhost:${port}/preview/node/n0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP);
  const html = await res.text();
  assertSpliced(html, 'preview');
  const w = scripted(html);
  await new Promise((r) => setTimeout(r, 50));
  resolvesExact(w, 'm1', 'li:nth-child(2) > span.act', 'preview');
  resolvesExact(w, 'm2', 'p.note', 'preview');
});

test('replay: two steps carry the preview template (and so the factory) once; a frame built from it installs the api', () => {
  const step = (id, mounts) => ({
    id, label: `${id}.0`, author: 'claude', kind: 'turn', prompt: 'p', summary: 's', reply: null,
    folded_count: 0, created_at: 1000, dt_from_prev: null, theme: 0, node: { id, mounts, store: {} },
  });
  const steps = [step('n1', TWO.slice(0, 1)), step('n2', TWO)];
  const html = assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts({}) });
  assert.equal(count(html, MARK), 1, 'the factory once in the whole replay');
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  const [a, b, c] = payload.frame;
  assertSpliced(a + b + c, 'replay template');
  for (const s of payload.steps) assert.equal(count(s.node, MARK), 0, 'no step carries its own copy');
  const s = payload.steps[1];
  const w = scripted(a + payload.themes[s.theme] + b + s.node + c);
  resolvesExact(w, 'm1', 'li:nth-child(1) > b', 'replay frame');
  resolvesExact(w, 'm2', 'p.note', 'replay frame');
});

// test/export.test.js's three-pane page (its LAID_OUT).
const LAID_OUT = {
  mounts: [
    { id: 'left', html: '<p>left</p>', target: 'main', params: { title: 'Left' }, pane_state: { colSpan: 6 } },
    { id: 'right', html: '<p>right</p>', target: 'main', params: {}, pane_state: { col: 7, colSpan: 6, rows: 4 } },
    { id: 'wide', html: '<p>wide</p>', target: 'main', params: {} },
  ],
  markdown: [{ id: 'md-title', text: '# The page' }, { id: 'md-cap', text: 'Below the pair.' }],
  order: ['md-title', 'left', 'right', 'md-cap', 'wide'],
  runs: { 'md-cap': { stacks: false } },
  store: {},
  meta: { label: 'n1.9' },
};

test('export: four <script> tags, the factory once after the runtime; offline in jsdom the api resolves exact', () => {
  const html = assembleExport({ mounts: TWO.map((m) => ({ ...m, target: 'main', params: {} })), store: {}, meta: { label: 'n1.0' } });
  assert.equal(count(html, '<script'), 4, 'the payload, the runtime, the resolver, the shell');
  assertSpliced(html, 'export');
  const w = scripted(html);
  resolvesExact(w, 'm1', 'li:nth-child(2) > b', 'export');
  resolvesExact(w, 'm2', 'p.note', 'export');
});

test('size (reported, not gated): the compacted factory and its share of a reference export', (t) => {
  const len = Buffer.byteLength(anchorsSrc.source());
  const full = Buffer.byteLength(anchors.documentSource());
  const pct = (n) => `${(100 * len / n).toFixed(2)}%`;
  const bare = Buffer.byteLength(assembleExport(LAID_OUT));
  // The same page drawn in the stock theme, its bundled fonts inlined as
  // resolveExportTheme inlines them for a real export.
  const stock = getBuiltin('earthy');
  const tokens = { ...stock.tokens, ...((stock.modes && stock.modes.light && stock.modes.light.tokens) || {}) };
  const themed = Buffer.byteLength(assembleExport({ ...LAID_OUT, page: { tokens, fonts: inlineFontCss(Object.values(tokens)) } }));
  t.diagnostic(`anchors-src: ${len} bytes compacted (${full} uncompacted)`);
  t.diagnostic(`reference export (three panes, no theme): ${bare} bytes, resolver share ${pct(bare)}`);
  t.diagnostic(`reference export (three panes, stock theme + its fonts): ${themed} bytes, resolver share ${pct(themed)}`);
  // 32,768 at U225 (the factory then 18 KB, before U224's chunker and U222a's
  // range and source sections); raised to 36,864 by U222a, whose planned
  // sections took it to about 33 KB. Still a tripwire against an accidental
  // large addition; B3's 5% share is the 1C gate's measurement.
  assert.ok(len < 36864, `the compacted factory is ${len} bytes — under the 36,864-byte tripwire`);
});
