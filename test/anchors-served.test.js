// The anchor resolver's delivery (annotation engine, PLAN.md 1C.1): the one
// factory in lib/core/anchors.js, served to the chrome as an ES module and
// spliced, compacted, into every node preview, replay frame and export, after
// the shared mount runtime, where it installs window.__wcMount.anchor. Pinned:
//   - GET /app/anchors.js serves browserModuleSource() verbatim, as JavaScript,
//     under the existing /app/* remote-policy row;
//   - lib/server/runtime/anchors-src: memoised, read on first use (never at
//     require time), free of whole-line comments and of any script, style or
//     HTML-comment opener, and answering exactly as the uncompacted copy does;
//   - the preview route, a replay frame and an export carry it once, after the
//     runtime, ONLY when their node carries element records (anchors-src
//     carriesElements, the one predicate — DECISIONS.md I.2 C-confirm (2),
//     I.5 G4), and resolve a record exact in their own document; a node without
//     records gets the document it had before the resolver was spliced in;
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
const { previewTemplate } = require('../lib/server/preview');
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

// ── the one predicate ────────────────────────────────────────────────────

test('carriesElements: true only for a node whose comments is a non-empty array', () => {
  const pin = { id: 'c1', text: 'x', anchor: { mount: 'm1' } };
  assert.equal(anchorsSrc.carriesElements({ comments: [pin] }), true);
  for (const [name, node] of [['comments: []', { comments: [] }], ['comments: null', { comments: null }],
    ['no comments field', { mounts: [] }], ['null', null], ['undefined', undefined],
    ['comments not an array', { comments: { 0: pin, length: 1 } }]]) {
    assert.equal(anchorsSrc.carriesElements(node), false, name);
  }
});

// Every lib/ file that reaches the resolver's document copy asks carriesElements
// and splices scriptElement(): none reads source() to spell its own <script>, and
// none decides on a `comments.length` of its own.
test('carriesElements is the only splice test: no lib/ file spells its own', () => {
  const LIB = path.join(__dirname, '..', 'lib');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) files.push(f);
  } };
  walk(LIB);
  const home = require.resolve('../lib/server/runtime/anchors-src');
  const users = [];
  for (const f of files) {
    if (f === home) continue;
    const src = fs.readFileSync(f, 'utf8');
    const req = src.match(/const \{([^}]*)\} = require\('[./]*(?:runtime\/)?anchors-src'\)/);
    if (!/anchors-src'\)/.test(src)) continue;
    const rel = path.relative(LIB, f);
    users.push(rel);
    assert.ok(req, `${rel}: destructures what it takes from anchors-src`);
    assert.doesNotMatch(req[1], /\bsource\b/, `${rel}: splices scriptElement(), never source() in a <script> of its own`);
    assert.match(req[1], /\bcarriesElements\b/, `${rel}: decides with carriesElements`);
    assert.doesNotMatch(src, /comments\.length/, `${rel}: no comments.length test of its own`);
  }
  assert.deepStrictEqual(users.sort(), ['server/export.js', 'server/preview.js', 'server/replay/document.js']);
});

// ── the documents ────────────────────────────────────────────────────────

// The factory spliced once, as its own script, right after the runtime's.
function assertSpliced(html, where) {
  assert.equal(count(html, anchorsSrc.source()), 1, `${where}: the compacted factory exactly once`);
  assert.equal(count(html, MARK), 1, `${where}: no second copy of the factory`);
  const rt = html.indexOf(`<script>${runtimeSource()}</script>\n<script>${anchorsSrc.source()}</script>`);
  assert.ok(rt >= 0, `${where}: its own <script>, immediately after the runtime's`);
}

// No factory at all, and the runtime's script followed directly by the next.
function assertAbsent(html, where) {
  assert.equal(count(html, anchorsSrc.source()), 0, `${where}: no factory`);
  assert.equal(count(html, MARK), 0, `${where}: no copy of the factory`);
  assert.equal(count(html, 'createAnchors'), 0, `${where}: nothing of it`);
  assert.ok(html.includes(`<script>${runtimeSource()}</script>\n<script>`), `${where}: the runtime's script, then the next`);
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
const PIN = { id: 'c1', seq: 1, text: 'a note', shared: true, anchor: { mount: 'm1', selector: 'li', text: 'Alpha', ordinal: 0 } };

// n0: the two panes, no pins; n1: the same page with one pin on m1.
async function twoNodes(t) {
  const srv = await withServer(t);
  const { api } = srv;
  for (const m of TWO) await api.post('/api/render', { id: m.id, html: m.html });
  assert.equal((await api.post('/api/commit', { message: 'seed' })).status, 200);
  const add = await api.post('/api/comments', { text: 'a note', shared: true, anchor: PIN.anchor });
  assert.equal(add.status, 200, add.text);
  assert.equal((await api.post('/api/commit', { message: 'pinned' })).status, 200);
  return srv;
}

test('preview: /preview/node/:id carries the factory only for a node with pins — a pinless node keeps its pre-splice bytes', async (t) => {
  const { port } = await twoNodes(t);
  const get = async (id) => {
    const res = await fetch(`http://localhost:${port}/preview/node/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP, `${id}: PREVIEW_CSP unchanged`);
    return res.text();
  };
  const bare = await get('n0');
  const pinned = await get('n1');
  // Without records: the four template pieces around an EMPTY anchors hole.
  assertAbsent(bare, 'pinless preview');
  const [a, b, c, d] = previewTemplate();
  assert.ok(bare.startsWith(a), 'pinless: the template\'s first piece');
  assert.ok(bare.includes(b + c), 'pinless: the anchors hole is empty');
  assert.ok(bare.endsWith(d), 'pinless: the template\'s last piece');
  assert.equal(count(bare, '<script'), count(pinned, '<script') - 1, 'one <script> fewer than the pinned node\'s');
  // With one pin: the factory once, after the runtime, and it resolves.
  assertSpliced(pinned, 'pinned preview');
  assert.ok(pinned.includes(b + anchorsSrc.scriptElement() + c), 'pinned: the hole holds the resolver\'s script');
  const w = scripted(pinned);
  await new Promise((r) => setTimeout(r, 50));
  resolvesExact(w, 'm1', 'li:nth-child(2) > span.act', 'preview');
  resolvesExact(w, 'm2', 'p.note', 'preview');
});

test('export: buildExportHtml splices the factory for a pinned node and not for a pinless one', async (t) => {
  const { port } = await twoNodes(t);
  const get = async (ref) => {
    const res = await fetch(`http://localhost:${port}/api/export/${ref}`);
    assert.equal(res.status, 200);
    return res.text();
  };
  const bare = await get('n0');
  assertAbsent(bare, 'pinless export');
  assert.equal(count(bare, '<script'), 3, 'the payload, the runtime, the shell');
  const pinned = await get('n1');
  assertSpliced(pinned, 'pinned export');
  assert.equal(count(pinned, '<script'), 4, 'the payload, the runtime, the resolver, the shell');
});

test('replay: the factory rides once as payload data; the player splices it only into the frame of a step with pins', async () => {
  const step = (id, mounts, comments) => ({
    id, label: `${id}.0`, author: 'claude', kind: 'turn', prompt: 'p', summary: 's', reply: null,
    folded_count: 0, created_at: 1000, dt_from_prev: null, theme: 0,
    node: { id, mounts, store: {}, ...(comments ? { comments } : {}) },
  });
  const steps = [step('n1', TWO.slice(0, 1)), step('n2', TWO, [PIN])];
  const html = assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts({}) });
  assert.equal(count(html, MARK), 1, 'the factory once in the whole replay');
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  assert.equal(payload.frame.length, 4, 'the template\'s four pieces');
  for (const piece of payload.frame) assert.equal(count(piece, MARK), 0, 'no template piece carries the factory');
  assert.strictEqual(payload.anchors, anchorsSrc.scriptElement(), 'the resolver\'s <script>, as data');
  assert.deepStrictEqual(payload.steps.map((s) => s.elements), [false, true]);
  for (const s of payload.steps) {
    assert.equal(count(s.node, MARK), 0, 'no step carries its own copy');
    assert.equal(JSON.parse(s.node).comments, undefined, 'the frame node carries no pin');
  }
  // A replay with no pinned step carries none of it.
  const none = assembleReplay({ steps: steps.slice(0, 1), themes: [{}], opts: normalizeReplayOpts({}) });
  assertAbsent(JSON.parse(new JSDOM(none).window.document.getElementById('wc-replay-data').textContent).frame.join(''), 'pinless replay');
  assert.equal(count(none, 'createAnchors'), 0, 'a replay with no pinned step carries no factory');

  // The frames the player itself builds (its iframe factory, srcdoc).
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const frames = [...dom.window.document.querySelectorAll('#rp-stage iframe')].map((f) => f.srcdoc);
  dom.window.close(); // the player's seek and its timers end here
  const of = (id) => frames.find((f) => f.includes(`"id":"${id}"`));
  assert.ok(of('n1') && of('n2'), 'the player built both frames');
  assertAbsent(of('n1'), 'the pinless step\'s frame');
  assertSpliced(of('n2'), 'the pinned step\'s frame');
  const w = scripted(of('n2'));
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

test('assembleExport: three <script> tags and no factory by default; with elements, four and the factory once after the runtime, resolving exact offline', () => {
  const input = { mounts: TWO.map((m) => ({ ...m, target: 'main', params: {} })), store: {}, meta: { label: 'n1.0' } };
  const bare = assembleExport(input);
  assert.equal(count(bare, '<script'), 3, 'the payload, the runtime, the shell');
  assertAbsent(bare, 'export without elements');
  const html = assembleExport({ ...input, elements: true });
  assert.equal(count(html, '<script'), 4, 'the payload, the runtime, the resolver, the shell');
  assertSpliced(html, 'export');
  assert.strictEqual(html.replace(anchorsSrc.scriptElement(), ''), bare, 'the one script element is the only difference');
  const w = scripted(html);
  resolvesExact(w, 'm1', 'li:nth-child(2) > b', 'export');
  resolvesExact(w, 'm2', 'p.note', 'export');
});

test('size (reported, not gated): the compacted factory and its share of a reference export', (t) => {
  const len = Buffer.byteLength(anchorsSrc.source());
  const full = Buffer.byteLength(anchors.documentSource());
  const pct = (n) => `${(100 * len / n).toFixed(2)}%`;
  const bare = Buffer.byteLength(assembleExport({ ...LAID_OUT, elements: true }));
  // The same page drawn in the stock theme, its bundled fonts inlined as
  // resolveExportTheme inlines them for a real export.
  const stock = getBuiltin('earthy');
  const tokens = { ...stock.tokens, ...((stock.modes && stock.modes.light && stock.modes.light.tokens) || {}) };
  const themedPage = { ...LAID_OUT, page: { tokens, fonts: inlineFontCss(Object.values(tokens)) } };
  const themed = Buffer.byteLength(assembleExport({ ...themedPage, elements: true }));
  const themedPinless = assembleExport(themedPage);
  t.diagnostic(`anchors-src: ${len} bytes compacted (${full} uncompacted)`);
  t.diagnostic(`reference export (three panes, no theme, with pins): ${bare} bytes, resolver share ${pct(bare)}`);
  // The typical export (DECISIONS.md I.5 G4): themed, its fonts inlined.
  t.diagnostic(`reference export (three panes, stock theme + its fonts, no pins): ${Buffer.byteLength(themedPinless)} bytes, resolver share ${(100 * count(themedPinless, anchorsSrc.source()) * len / Buffer.byteLength(themedPinless)).toFixed(2)}%`);
  t.diagnostic(`reference export (three panes, stock theme + its fonts, with pins): ${themed} bytes, resolver share ${pct(themed)}`);
  // 32,768 at U225 (the factory then 18 KB, before U224's chunker and U222a's
  // range and source sections); raised to 36,864 by U222a, whose planned
  // sections took it to about 33 KB. Still a tripwire against an accidental
  // large addition; B3's 5% share is the 1C gate's measurement.
  assert.ok(len < 36864, `the compacted factory is ${len} bytes — under the 36,864-byte tripwire`);
});
