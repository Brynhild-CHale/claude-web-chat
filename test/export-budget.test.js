'use strict';
// The export cap and the budget readings (annotation engine tranche 4, U526;
// PLAN.md 4B.1; DECISIONS.md B3 "a per-export cap that refuses or strips with
// a hint; overlay code under 5% of a typical export"; X-21; GT-17's no-go row
// "an over-cap export written silently"). RULED U526@cap-scope-figure (a):
// the cap is on the element payload as serialised (the draw runtime, every
// type module, the data element) at EXPORT_ELEMENTS_MAX; over it the strip
// takes assets largest first, then hidden items oldest first, and refuses
// when that is not enough. RULED U526@over-cap-browser-download (a):
// format=file (the MCP tool, the CLI) refuses 413 by default and strips on
// strip=1 / --strip; the browser download strips by default and says so in
// #export-head. BUDGET@typical-export (a): the share is the 4B gate run's to
// grade; this file only REPORTS it (t.diagnostic), never asserts it.
//
// The cap is lowered for the routes through lib/server/routes/export.js
// capSeam (tests only) and for buildExportHtml through opts.cap; both narrow
// EXPORT_ELEMENTS_MAX, never widen it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

// A box grab is drawn by headless Chrome; this file never launches one.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const { resolvePaths } = require('../lib/server/paths');
const { encodePng } = require('../lib/core/png');
const { FILE_MAX } = require('../lib/core/element-assets');
const client = require('../lib/client');
const docRuntime = require('../lib/server/runtime/elements-doc-src');
const { documentElements, documentDeps, fileReader } = require('../lib/server/document-elements');
const exp = require('../lib/server/export');
const { capSeam } = require('../lib/server/routes/export');

const NOW = new Date('2026-11-03T12:00:00Z');
const DATA_EL = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/g;
const STRIPPED_LINE = /<span data-export-stripped="(\d+)">([^<]*)<\/span>/;

const HTML_A = '<p class="lead">Hello world</p><p class="body">The quick brown fox jumps</p>';
const LOCATOR = (mount, text = 'Hello world', selector = 'p.lead') => ({ mount, selector, text, ordinal: 0 });
const RANGE = (mount, exact = 'quick brown') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: 'The ', suffix: ' fox' } });
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0], sib: 0 }, fp: { tag: 'p', id: '', cls: ['lead'], head: 'Hello world', attrs: [], parent: '' }, rows: [] });

const DRAW = [
  '// xe-big: a glyph that shows its asset.',
  'export default function draw(group, ctx) {',
  "  if (group.container) group.container.setAttribute('data-xe-big', String(ctx.asset('big.png') ? 1 : 0));",
  '}',
  '',
].join('\n');
const BIG_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'] };

// A PNG of incompressible pixels (a fixed LCG), so its file is about w*h*4
// bytes: the asset ratio is read on bytes base64 cannot shrink.
function noisePng(w, h, seed) {
  const px = Buffer.alloc(w * h * 4);
  let x = seed >>> 0;
  for (let i = 0; i < px.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; px[i] = x >>> 24; }
  return encodePng(px, w, h);
}
const BIG_PNG = noisePng(224, 224, 7);     // about 200 KB
const SMALL_PNG = noisePng(72, 72, 11);    // about 20 KB

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function commit(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}
const post = async (api, body, what) => ok(api.post('/api/elements', body), what);
const answer = (id, v, mount, state, how) => ({
  id, v, mount, state, how, gen: 0, surface: 0, qual: { spec: 'x', store: 'y' }, source: { peer: 'local', device: null },
});

async function daemon(t) {
  const d = await withServer(t, { root: fs.realpathSync(tmpRoot('wc-u526-')) });
  d.call = (p, headers) => client.request(d.port, 'GET', p, null, { headers, timeout: 20000 });
  return d;
}
// The ctx members buildExportHtml reads, from a withServer context.
const ctxOf = (d) => ({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root, paths: resolvePaths(d.root) });
// The cap the routes use, lowered for one test.
function lowerCap(t, cap) {
  capSeam.cap = cap;
  t.after(() => { capSeam.cap = null; });
}

// The scenario: one pane; a plug-in type xe-big shipping a 200 KB and a 20 KB
// PNG, one element of it (placed); a placed comment; two comments the side
// table records orphaned with no guess (h-old, then h-new: hidden, never drawn
// by the overlay); one recorded orphaned WITH a carried guess (drawn at its
// guess: never hidden). Each hidden comment carries a long text, so stripping
// one is a step the cap can see.
const LONG = (w) => `${w} ${'lorem ipsum dolor sit amet '.repeat(52)}`.trim();
async function scenario(d) {
  const { api } = d;
  approveElementPack(d, { name: 'xb-pack', type: 'xe-big', json: BIG_JSON, draw: DRAW, files: { 'assets/big.png': BIG_PNG, 'assets/small.png': SMALL_PNG } });
  assert.ok(d.srv.elementTypes.listed('xe-big'), 'the fixture type lists');
  await ok(api.post('/api/render', { id: 'pa', html: HTML_A }), 'render pa');
  const big = (await post(api, { type: 'xe-big', anchor: ELEMENT('pa'), payload: { label: 'wc-u526-big' } }, 'xe-big')).element;
  const placed = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: 'wc-u526-placed', shared: true } }, 'placed')).pin;
  const hOld = (await post(api, { type: 'comment', anchor: LOCATOR('pa', 'gone one', 'p.gone1'), payload: { text: LONG('wc-u526-h-old'), shared: true } }, 'h-old')).pin;
  const hNew = (await post(api, { type: 'comment', anchor: LOCATOR('pa', 'gone two', 'p.gone2'), payload: { text: LONG('wc-u526-h-new'), shared: true } }, 'h-new')).pin;
  const guess = (await post(api, { type: 'comment', anchor: LOCATOR('pa', 'near one', 'p.near'), payload: { text: 'wc-u526-guess', shared: true } }, 'guess')).pin;
  const node = await commit(api, 'the scenario');
  d.srv.elements.log.appendAnswers({ node, items: [
    answer(placed.id, placed.v, 'pa', 'exact', 'path'),
    answer(hOld.id, hOld.v, 'pa', 'orphaned', 'score-low'),
    answer(hNew.id, hNew.v, 'pa', 'orphaned', 'score-low'),
    answer(guess.id, guess.v, 'pa', 'orphaned', 'locator-guess'),
  ] });
  return { node, ids: { big: big.id, placed: placed.id, hOld: hOld.id, hNew: hNew.id, guess: guess.id } };
}

// The element payload U524's export builds for the node (the file reader).
const payloadOf = (d, node) => documentElements(documentDeps(ctxOf(d)), d.srv.graph.nodes.get(node), { reader: fileReader('local'), route: exp.EXPORT_ROUTE });
// The export as U524 built it: the same pipeline, no cap.
function exportU524(d, node) {
  const ctx = ctxOf(d);
  const resolved = exp.nodeForExport(ctx, node);
  const theme = exp.resolveExportTheme(ctx, resolved, null);
  return exp.assembleExport({
    mounts: theme.mounts, markdown: resolved.markdown, order: resolved.order, runs: resolved.runs,
    store: resolved.store, page: theme.page, elements: resolved.elements, docElements: payloadOf(d, node),
    meta: { label: resolved.label, title: `web-chat — ${resolved.label}`, exportedAt: NOW.toISOString().replace('T', ' ').slice(0, 19), brand: {} },
  });
}
const labelOf = (d, node) => exp.nodeForExport(ctxOf(d), node).label;
const dataElements = (html) => [...html.matchAll(DATA_EL)].map((m) => JSON.parse(m[1]));
const jbytes = (v) => Buffer.byteLength(exp.jsonForScript(v));
// The cap at which, after both assets, h-old goes and h-new stays: the size
// with every strippable thing gone, plus h-new's own bytes.
function capKeepingNew(d, node, ids) {
  const p = payloadOf(d, node);
  const all = exp.fitElements(p, d.srv.graph.nodes.get(node), 0);
  return all.fitted + jbytes(p.items.find((it) => it.id === ids.hNew));
}
const EXPECTED = (ids) => [
  { kind: 'asset', type: 'xe-big', rel: 'big.png' },
  { kind: 'asset', type: 'xe-big', rel: 'small.png' },
  { kind: 'item', type: 'comment', id: ids.hOld },
];
const shape = (list) => list.map(({ kind, type, rel, id }) => ({ kind, type, ...(rel ? { rel } : {}), ...(id ? { id } : {}) }));

// ── the tests ───────────────────────────────────────────────────────────────

test('assets inline at most 1.4x raw and decode byte-equal; under the cap the export carries no stripped field and is byte-equal to U524\'s; the budget\'s parts sum to the file\'s bytes', async (t) => {
  assert.ok(BIG_PNG.length > 190 * 1024 && BIG_PNG.length < FILE_MAX, `the big asset is about 200 KB, under U511's per-file cap: ${BIG_PNG.length}`);
  const d = await daemon(t);
  const { node } = await scenario(d);
  const built = exp.buildExportHtml(ctxOf(d), node, NOW);
  assert.ok(!built.error, JSON.stringify(built));
  const { html, budget } = built;
  assert.equal(built.stripped, undefined, 'no stripped list');
  assert.strictEqual(html, exportU524(d, node), 'byte-equal to U524\'s export');
  const [p] = dataElements(html);
  assert.ok(p && !('stripped' in p), 'the data element carries no stripped field');
  assert.ok(!STRIPPED_LINE.test(html), 'and #export-head no stripped line');
  // exportU524 runs the same assembleExport this unit touched, so it cannot
  // see a byte the cap's work adds to every export: hold U524's shape from
  // its own parts too — the head is the label and the stamp and nothing else,
  // and the element splice (scripts()) follows the resolver directly, the
  // shell right after it.
  const label = labelOf(d, node);
  const stampText = NOW.toISOString().replace('T', ' ').slice(0, 19);
  assert.ok(html.includes(`<div id="export-head"><span class="label">${exp.htmlEscape(label)}</span><span>exported ${stampText}</span></div>\n`),
    '#export-head is U524\'s: the label and the stamp alone');
  const kinds = exp.nodeForExport(ctxOf(d), node).elements;
  const resolverEl = require('../lib/server/runtime/anchors-src').scriptElement({ kinds });
  assert.ok(html.includes(`</script>\n${resolverEl}${docRuntime.scripts(payloadOf(d, node))}<script>`),
    'the resolver, then the element splice, then the shell, back to back');

  // The assets: each one's ratio, the total's, and its bytes in the file.
  assert.equal(budget.assets.length, 2);
  for (const [rel, file] of [['big.png', BIG_PNG], ['small.png', SMALL_PNG]]) {
    const a = budget.assets.find((x) => x.rel === rel);
    assert.equal(a.raw, file.length, `${rel}: raw is the file's bytes`);
    assert.ok(a.inlined / a.raw <= 1.4, `${rel}: inlined ${a.inlined} / raw ${a.raw} <= 1.4`);
    const uri = payloadOf(d, node).types[0].assets[rel];
    assert.ok(html.includes(JSON.stringify(uri)), `${rel}: the data URI rides in the file as JSON writes it`);
    assert.strictEqual(exp.jsonForScript(uri), JSON.stringify(uri), `${rel}: jsonForScript's escaping adds nothing (base64 holds no < > &)`);
    assert.ok(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').equals(file), `${rel}: the data URI decodes byte-equal to the file`);
    assert.equal(a.inlined, uri.length);
  }
  assert.equal(budget.assets_raw, BIG_PNG.length + SMALL_PNG.length);
  assert.ok(budget.assets_inlined / budget.assets_raw <= 1.4, `total ${budget.assets_inlined} / ${budget.assets_raw}`);

  // The parts.
  assert.equal(budget.bytes, Buffer.byteLength(html));
  assert.equal(budget.page_bytes + budget.resolver_bytes + budget.runtime_bytes + budget.payload_bytes, budget.bytes, 'the parts sum to the file');
  assert.ok(budget.resolver_bytes > 0 && budget.runtime_bytes > 0 && budget.payload_bytes > budget.assets_inlined);
  assert.equal(budget.runtime_bytes + budget.payload_bytes, Buffer.byteLength(docRuntime.scripts(payloadOf(d, node))), 'the cap\'s figure is the element splice');
  assert.equal(exp.fitElements(payloadOf(d, node), d.srv.graph.nodes.get(node)).bytes, budget.runtime_bytes + budget.payload_bytes);
  t.diagnostic(`scenario export ${budget.bytes} B: page ${budget.page_bytes}, resolver ${budget.resolver_bytes}, runtime ${budget.runtime_bytes}, payload ${budget.payload_bytes}; assets ${budget.assets_inlined} / ${budget.assets_raw} raw = ${(budget.assets_inlined / budget.assets_raw).toFixed(4)}`);
});

test('over the cap, GET ?format=file answers 413 {error, code, hint, bytes, cap, would_strip} and writes no file; the MCP tool returns {error, code, hint, bytes, cap}; the CLI exits 1 printing the hint', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  const cap = capKeepingNew(d, node, ids);
  lowerCap(t, cap);
  const exportsDir = path.join(d.webChatDir, 'exports');

  const r = await d.call(`/api/export/${node}?format=file`);
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['bytes', 'cap', 'code', 'error', 'hint', 'would_strip']);
  assert.equal(r.body.code, 'export-over-cap');
  assert.equal(r.body.cap, cap);
  assert.equal(r.body.bytes, Buffer.byteLength(docRuntime.scripts(payloadOf(d, node))));
  assert.ok(r.body.bytes > cap);
  assert.match(r.body.hint, /--strip/);
  assert.match(r.body.hint, new RegExp(`claude-web-chat export ${labelOf(d, node).replace(/\./g, '\\.')} --strip`));
  assert.deepStrictEqual(shape(r.body.would_strip), EXPECTED(ids), 'what a strip would leave out');
  assert.ok(!fs.existsSync(exportsDir), 'no file written');

  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(d.port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });
  const tool = await require('../lib/mcp/tools/export').handler({ node });
  assert.deepStrictEqual(Object.keys(tool).sort(), ['bytes', 'cap', 'code', 'error', 'hint']);
  assert.equal(tool.code, 'export-over-cap');
  assert.equal(tool.hint, r.body.hint);
  assert.ok(!fs.existsSync(exportsDir), 'the tool wrote nothing');

  // The CLI, as test/replay-script.test.js runs it: its own process, this
  // daemon found through the portfile.
  require('../lib/core/portfiles').writePortfile('server', { root: d.root, pid: process.pid, port: d.port });
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), 'export', ...args], { cwd: d.root, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  const cli = await run([labelOf(d, node)]);
  assert.equal(cli.code, 1, cli.out + cli.err);
  assert.match(cli.err, /export failed: the export is over the cap/);
  assert.ok(cli.err.includes(r.body.hint), 'the daemon\'s hint printed');
  assert.ok(!fs.existsSync(exportsDir), 'the CLI wrote nothing');

  const stripped = await run([labelOf(d, node), '--strip']);
  assert.equal(stripped.code, 0, stripped.out + stripped.err);
  assert.match(stripped.out, /^exported .* → .*\.html$/m);
  assert.match(stripped.out, /left out to fit the export cap \(3\):/);
  assert.match(stripped.out, /asset big\.png of xe-big \(\d+ bytes\)\n {4}asset small\.png of xe-big/);
  assert.ok(stripped.out.includes(`hidden comment ${ids.hOld}`));
});

test('strip=1: the largest asset first, then a hidden item before a placed one, oldest first; the file\'s data element lists each in stripped and #export-head names them; the stripped payload validates and fits', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  const cap = capKeepingNew(d, node, ids);
  lowerCap(t, cap);

  const r = await d.call(`/api/export/${node}?format=file&strip=1`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(shape(r.body.stripped), EXPECTED(ids), 'the route answers the list');
  for (const s of r.body.stripped) {
    assert.equal(s.reason, 'export-cap');
    assert.ok(Number.isSafeInteger(s.bytes) && s.bytes > 0);
  }
  const html = fs.readFileSync(r.body.path, 'utf8');
  const [p] = dataElements(html);
  assert.deepStrictEqual(p.stripped, r.body.stripped, 'the data element names each');
  assert.deepStrictEqual(p.items.map((it) => it.id).sort(), [ids.big, ids.placed, ids.hNew, ids.guess].sort(),
    'h-old went; h-new (newer), the placed comment, the carried guess and the plug-in element stayed');
  assert.deepStrictEqual(p.types[0].skipped, [{ rel: 'big.png', reason: 'export-cap' }, { rel: 'small.png', reason: 'export-cap' }]);
  assert.ok(!html.includes('data:image/png;base64,'), 'no asset rides');
  assert.ok(!html.includes('wc-u526-h-old') && html.includes('wc-u526-h-new'));
  const whole = { ...p, types: p.types.map((row) => ({ ...row, module: DRAW, assets: {} })) };
  assert.equal(docRuntime.validatePayload(whole), null, 'the stripped payload is contract v1');
  assert.ok(Buffer.byteLength(docRuntime.scripts(whole)) <= cap, 'and fits the cap');

  const head = new JSDOM(html).window.document.getElementById('export-head');
  const line = head.querySelector('[data-export-stripped]');
  assert.ok(line, 'the stripped line in #export-head');
  assert.equal(line.getAttribute('data-export-stripped'), '3');
  assert.equal(line.textContent, `stripped to fit the export cap: xe-big asset big.png, xe-big asset small.png, hidden comment ${ids.hOld}`);
  assert.equal(line.textContent, exp.strippedLine(r.body.stripped));

  // A lower cap takes h-new too, never the placed ones.
  lowerCap(t, cap - jbytes(payloadOf(d, node).items.find((it) => it.id === ids.hNew)));
  const lower = await d.call(`/api/export/${node}?format=file&strip=1`);
  assert.equal(lower.status, 200, JSON.stringify(lower.body));
  assert.deepStrictEqual(shape(lower.body.stripped).slice(3), [{ kind: 'item', type: 'comment', id: ids.hNew }]);
  assert.equal(lower.body.stripped.length, 4);
});

test('a payload that cannot fit even stripped is refused with the hint, on format=file with strip=1 and on the download; nothing is written', async (t) => {
  const d = await daemon(t);
  const { node } = await scenario(d);
  const all = exp.fitElements(payloadOf(d, node), d.srv.graph.nodes.get(node), 0);
  lowerCap(t, all.fitted - 1);
  const r = await d.call(`/api/export/${node}?format=file&strip=1`);
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.code, 'export-over-cap');
  assert.match(r.body.hint, /even `claude-web-chat export \S+ --strip` cannot fit them/);
  assert.match(r.body.hint, new RegExp(`they are ${all.fitted} bytes`));
  assert.equal(r.body.would_strip.length, 4, 'both assets and both hidden comments, and it still does not fit');
  const dl = await d.api.get(`/api/export/${node}`);
  assert.equal(dl.status, 413);
  assert.equal(dl.json.code, 'export-over-cap');
  assert.ok(!fs.existsSync(path.join(d.webChatDir, 'exports')), 'nothing written');
  // buildExportHtml's own seam says the same.
  const built = exp.buildExportHtml(ctxOf(d), node, NOW, { strip: true, cap: all.fitted - 1 });
  assert.equal(built.code, 'export-over-cap');
  assert.equal(built.html, undefined);
  // And a cap a caller hands in never widens the constant.
  assert.equal(exp.buildExportHtml(ctxOf(d), node, NOW, { cap: exp.EXPORT_ELEMENTS_MAX * 2 }).stripped, undefined);
});

test('a browser download over the cap is stripped by default, the list visible in #export-head', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  lowerCap(t, capKeepingNew(d, node, ids));
  const r = await d.api.get(`/api/export/${node}`);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
  const m = r.text.match(STRIPPED_LINE);
  assert.ok(m, 'the stripped line');
  assert.equal(m[1], '3');
  assert.ok(m[2].includes(`hidden comment ${ids.hOld}`) && m[2].includes('xe-big asset big.png'));
  assert.deepStrictEqual(shape(dataElements(r.text)[0].stripped), EXPECTED(ids));
  assert.ok(!fs.existsSync(path.join(d.webChatDir, 'exports')), 'a download writes nothing');
});

test('fitElements: an item on a pane the node minimizes is hidden; a row served masked never is; the handed payload is never changed; under the cap it is returned as it is', () => {
  const item = (id, seq, mount, extra = {}) => ({
    id, v: 1, type: 'comment', schema: 'comment@1', seq, anchor: { v: 1, kind: 'element', mount, at: { path: [0], sib: 0 } },
    shared: true, answer: null, payload: { text: `text of ${id} ${'x'.repeat(400)}`, replies: [] }, ...extra,
  });
  const payload = {
    v: 1, builtins: ['comment'], types: [], removed: [],
    items: [item('c1', 9, 'pm'), item('c2', 3, 'pm'), item('c3', 1, 'pa'),
      item('c4', 0, 'pa', { answer: { state: 'orphaned', how: 'score-low' }, state: 'masked', visible: null, explain: null })],
  };
  assert.equal(docRuntime.validatePayload(payload), null);
  const node = { mounts: [{ id: 'pa', html: '' }, { id: 'pm', html: '', pane_state: { minimized: true } }] };
  const before = JSON.stringify(payload);
  const size = exp.fitElements(payload, node).bytes;
  const under = exp.fitElements(payload, node, size);
  assert.strictEqual(under.payload, payload, 'within the cap: the same object');
  assert.deepStrictEqual(under.stripped, []);
  const fit = exp.fitElements(payload, node, size - 1);
  assert.ok(fit.fits);
  assert.deepStrictEqual(shape(fit.stripped), [{ kind: 'item', type: 'comment', id: 'c2' }], 'the minimized pane\'s oldest item');
  const none = exp.fitElements(payload, node, 0);
  assert.deepStrictEqual(none.stripped.map((s) => s.id), ['c2', 'c1'], 'never the placed c3, never the masked c4');
  assert.equal(none.fits, false);
  assert.equal(JSON.stringify(payload), before, 'the payload handed in is unchanged');
  // Every item hidden: the payload empties, so nothing is spliced, and it fits.
  const allHidden = { ...payload, items: payload.items.slice(0, 2) };
  const gone = exp.fitElements(allHidden, node, 0);
  assert.ok(gone.fits && gone.fitted === 0 && gone.payload.items.length === 0);
  assert.equal(docRuntime.scripts(gone.payload), '');
});

// ── the share (BUDGET@typical-export a): reported, never graded ─────────────
//
// The typical export: a themed node of six panes and two markdown items, with
// two comments, one highlight and one element of a fixture plug-in type; the
// comment-only share beside (the same page with its two comments alone).
const PANE = (i) => `<section class="card"><h3>Panel ${i}</h3><p class="lead">Hello world</p><p class="body">The quick brown fox jumps</p>`
  + `<ul>${Array.from({ length: 8 }, (_, k) => `<li>row ${i}.${k} — a value, a note and a figure ${k * 17}</li>`).join('')}</ul>`
  + `<style>.card{padding:8px;border:1px solid var(--wc-border)} .card li{font:13px var(--wc-font)}</style>`
  + `<script>root.querySelector('h3').dataset.ready = '${i}';</script></section>`;
async function typical(t, { commentsOnly }) {
  const d = await daemon(t);
  const { api } = d;
  if (!commentsOnly) approveElementPack(d, { name: 'xt-pack', type: 'xe-tick', json: BIG_JSON, draw: DRAW.replace(/xe-big/g, 'xe-tick') });
  await ok(api.post('/api/theme/apply', { name: 'paper', scope: 'global' }), 'theme');
  await ok(api.post('/api/markdown', { id: 'md-title', text: '# The typical export\n\nA page of six panels.' }), 'md-title');
  for (let i = 1; i <= 6; i++) await ok(api.post('/api/render', { id: `p${i}`, html: PANE(i) }), `render p${i}`);
  await ok(api.post('/api/markdown', { id: 'md-notes', text: '## Notes\n\nWhat the panels show, in a sentence or two.' }), 'md-notes');
  await post(api, { type: 'comment', anchor: LOCATOR('p1'), payload: { text: 'a first comment', shared: true } }, 'comment 1');
  await post(api, { type: 'comment', anchor: LOCATOR('p4'), payload: { text: 'a second comment', shared: true } }, 'comment 2');
  if (!commentsOnly) {
    await post(api, { type: 'highlight', anchor: RANGE('p2'), payload: { color: 'gold', note: 'a highlight' } }, 'highlight');
    await post(api, { type: 'xe-tick', anchor: ELEMENT('p3'), payload: { label: 'a tick' } }, 'xe-tick');
  }
  const node = await commit(api, 'the typical page');
  return exp.buildExportHtml(ctxOf(d), node, NOW);
}

test('the share on the fixture typical export, and the comment-only share beside (reported through t.diagnostic, not graded: the 4B gate run grades it)', async (t) => {
  const share = (b) => (b.resolver_bytes + b.runtime_bytes) / b.bytes;
  const full = await typical(t, { commentsOnly: false });
  const only = await typical(t, { commentsOnly: true });
  for (const b of [full, only]) {
    assert.ok(!b.error, JSON.stringify(b));
    assert.equal(b.budget.page_bytes + b.budget.resolver_bytes + b.budget.runtime_bytes + b.budget.payload_bytes, b.budget.bytes);
    assert.ok(b.budget.runtime_bytes > 0 && b.budget.resolver_bytes > 0, 'both draw elements');
  }
  const fmt = (b) => `${b.budget.bytes} B (page ${b.budget.page_bytes}, resolver ${b.budget.resolver_bytes}, runtime ${b.budget.runtime_bytes}, payload ${b.budget.payload_bytes})`;
  t.diagnostic(`typical export ${fmt(full)}: overlay share (resolver + runtime) / bytes = ${(share(full.budget) * 100).toFixed(2)}%`);
  t.diagnostic(`comment-only export ${fmt(only)}: share = ${(share(only.budget) * 100).toFixed(2)}%`);
});
