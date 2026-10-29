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
//   - the per-kind splice (U307, PLAN.md 2A.7): a document carries only the
//     factory sections its node's records need (anchors-src kindsOf over the
//     comment copies and id@v refs; lib/core/anchors.js KIND_SECTIONS), each
//     cut copy answering as the whole one, and the whole copies keeping every
//     section and every frozen answer;
//   - its size, logged (the 1C gate measures B3's 5% share, per kind-set), under
//     a tripwire on the whole factory.
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
const { previewTemplate, renderPreviewHtml } = require('../lib/server/preview');
const crypto = require('crypto');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');
const { renderMarkdown, sourceMap } = require('../lib/core/markdown');
const { getBuiltin } = require('../lib/server/theme');
const { inlineFontCss } = require('../lib/server/fonts');
const { withServer, commentBody } = require('../test-support/helpers');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'element-cases.json'), 'utf8'));
const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'step2-answers.json'), 'utf8'));
// The kind-sets a document copy can be cut to, closed under KIND_SECTIONS.
const KIND_SETS = [['element'], ['element', 'range'], ['element', 'range', 'source']];
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
    'resolveAll', 'invalidate', 'watch', 'recordRange', 'resolveRange', 'recordSource', 'resolveSource',
    'quoteText', 'quoteOf']) {
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
  assert.strictEqual(anchorsSrc.source(), anchorsSrc.source({ kinds: ['element', 'range', 'source'] }), 'no argument: every kind');
  for (const kinds of [undefined, ...KIND_SETS]) {
    const src = anchorsSrc.source(kinds && { kinds });
    assert.ok(src.length < anchors.documentSource(kinds && { kinds }).length, 'smaller than the full copy');
    for (const line of src.split('\n')) {
      assert.notEqual(line, '', 'no blank line');
      assert.ok(!/^\s*\/\//.test(line), `no whole-line comment: ${line}`);
      assert.ok(!/^\s/.test(line), `no leading indentation: ${line}`);
    }
    for (const bad of [/<script/i, /<\/script/i, /<style/i, /<\/style/i, /<!--/]) assert.doesNotMatch(src, bad);
    assert.equal(count(src, MARK), 1);
  }
});

// One window, its runtime, and each copy installed in turn on the same runtime,
// so their answers name the same DOM nodes and compare deep-equal directly.
function copiesIn(...srcs) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  WINDOWS.push(dom.window);
  const w = dom.window;
  w.eval(RUNTIME);
  const apis = srcs.map((src) => {
    w.eval(src);
    return w.__wcMount.anchor;
  });
  return { w, apis };
}
function bothCopies() {
  const { w, apis: [full, compact] } = copiesIn(anchors.documentSource(), anchorsSrc.source());
  return { w, full, compact };
}
function mountInto(w, html, id = 'm') {
  const host = w.document.createElement('div');
  host.dataset.mountId = id;
  w.document.body.appendChild(host);
  return w.__wcMount.attachAndExtract(host, html).root;
}
const CFGS = [{}];
for (let m = 0; m < 1 << FLAGS.length; m++) {
  const cfg = {};
  FLAGS.forEach((f, k) => { cfg[f] = !!(m & (1 << k)); });
  CFGS.push(cfg);
}
// Every element fixture (element-cases.json), recorded and resolved by `copy`
// and by `full`, under every flag combination: the count of answers compared.
function sameOnElementFixtures(w, full, copy, label) {
  let n = 0;
  for (const c of FIX.cases) {
    const from = mountInto(w, c.from);
    const to = mountInto(w, c.to);
    const el = from.querySelector(c.target);
    const rec = full.record(from, el);
    assert.deepStrictEqual(copy.record(from, el), rec, `${label}: ${c.name}`);
    if (!rec) continue;
    const w1 = wire(rec);
    if (c.strip_heads) for (const r of w1.rows) delete r.head;
    for (const cfg of CFGS) {
      const a = full.resolve(to, w1, cfg);
      assert.deepStrictEqual(copy.resolve(to, w1, cfg), a, `${label}: ${c.name} ${JSON.stringify(cfg)}`);
      assert.deepStrictEqual(copy.restamp(w1, a), full.restamp(w1, a), `${label}: ${c.name}: restamp`);
      n++;
    }
  }
  for (const loc of FIX.locator) {
    const root = mountInto(w, loc.html);
    assert.deepStrictEqual(copy.resolve(root, loc.rec), full.resolve(root, loc.rec), `${label}: locator`);
    n++;
  }
  return n;
}

test('anchors-src: installs window.__wcMount.anchor after the runtime, and answers as the uncompacted copy on every element fixture', () => {
  const { w, full, compact } = bothCopies();
  assert.equal(typeof compact.resolve, 'function');
  assert.notStrictEqual(compact, full, 'the compacted copy installed its own api');
  assert.deepStrictEqual({ ...compact.CONFIG }, { ...full.CONFIG });
  assert.deepStrictEqual({ ...compact.LIMITS }, { ...full.LIMITS });
  const n = sameOnElementFixtures(w, full, compact, 'compacted');
  assert.ok(n > FIX.cases.length, `compared ${n} answers`);
});

// ── the per-kind cut (U307, PLAN.md 2A.7) ────────────────────────────────

// The factory's text by section, cut at its banners as documentSource cuts it.
const SECTIONS = ['element', 'resolveAll', 'range', 'source'];
function factorySections() {
  const src = anchors.createAnchors.toString();
  const at = SECTIONS.map((n) => src.indexOf(`  // ── ${n} ──\n`));
  at.push(src.indexOf('\n  var api = {'));
  const out = { tail: src.slice(at[4]) };
  SECTIONS.forEach((n, k) => { out[n] = src.slice(at[k], at[k + 1]); });
  return out;
}
// Code only: whole-line comments and string literals blanked.
const codeOf = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
const declsOf = (text) => [...text.matchAll(/^ {2}(?:function|var) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
// The one arm that names another section's functions without a typeof of its
// own: resolveAll's range arm reaches rangeIn and textTable only through
// isRange, which asks `typeof rangeIn === 'function'` (both are the range
// section's, so they are present or absent together).
const RANGE_ARM = { section: 'resolveAll', from: 'range', names: ['rangeIn', 'textTable'], guard: "function isRange(rec) { return !!rec && rec.kind === 'range' && typeof rangeIn === 'function'; }" };

test('KIND_SECTIONS: frozen, and the closure of the factory\'s cross-section references', () => {
  assert.ok(Object.isFrozen(anchors.KIND_SECTIONS));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(anchors.KIND_SECTIONS)), {
    element: ['element', 'resolveAll'],
    range: ['element', 'resolveAll', 'range'],
    source: ['element', 'resolveAll', 'range', 'source'],
  });
  for (const k of Object.keys(anchors.KIND_SECTIONS)) assert.ok(Object.isFrozen(anchors.KIND_SECTIONS[k]), k);
  assert.deepStrictEqual(anchorsSrc.RESOLVER_KINDS, [...anchorsSrc.RESOLVER_KINDS].sort(), 'the table\'s kinds are in sorted order (kindsOf answers in it)');
  // Each kept section (and the api tail) names an omitted section's declaration
  // only under `typeof`: nothing in a cut copy reaches a name it does not hold.
  const sec = factorySections();
  assert.ok(sec.resolveAll.includes(RANGE_ARM.guard), 'the range arm asks for its section');
  for (const n of RANGE_ARM.names) assert.ok(declsOf(sec.range).includes(n), `${n} is the range section's`);
  for (const [kind, kept] of Object.entries(anchors.KIND_SECTIONS)) {
    const omitted = SECTIONS.filter((n) => !kept.includes(n));
    const names = omitted.flatMap((n) => declsOf(sec[n]));
    for (const part of [...kept, 'tail']) {
      const code = codeOf(sec[part]);
      for (const name of names) {
        if (part === RANGE_ARM.section && RANGE_ARM.names.includes(name)) continue;
        // Allowed: `typeof name === 'function' ? name : undefined`, a bare
        // `typeof name`, and `name:` as an object key; nothing else.
        const rest = code
          .replace(new RegExp(`typeof ${name} === '' \\? ${name} : undefined`, 'g'), '')
          .replace(new RegExp(`typeof ${name}(?![\\w$])`, 'g'), '')
          .replace(new RegExp(`^\\s+${name}:`, 'gm'), '');
        assert.doesNotMatch(rest, new RegExp(`(^|[^\\w$.])${name}(?![\\w$])`),
          `${kind}: the ${part} section names ${name} (cut with ${omitted.join(', ')}) outside a typeof guard`);
      }
    }
  }
});

test('documentSource({kinds}): each kind-set evaluates in jsdom and installs; an omitted section\'s api entries are undefined', () => {
  assert.strictEqual(anchors.documentSource(), anchors.documentSource({ kinds: ['source', 'element', 'range'] }), 'every kind is the whole copy');
  assert.strictEqual(anchors.documentSource({ kinds: ['range'] }), anchors.documentSource({ kinds: ['element', 'range'] }), 'range closes over element');
  assert.strictEqual(anchors.documentSource({ kinds: [] }), '', 'no kind: nothing');
  assert.throws(() => anchors.documentSource({ kinds: ['page'] }), /no resolver kind page/);
  const want = {
    element: { recordRange: false, resolveRange: false, recordSource: false, resolveSource: false, quoteText: false, quoteOf: false },
    range: { recordRange: true, resolveRange: true, recordSource: false, resolveSource: false, quoteText: true, quoteOf: true },
    source: { recordRange: true, resolveRange: true, recordSource: true, resolveSource: true, quoteText: true, quoteOf: true },
  };
  for (const kinds of KIND_SETS) {
    const top = kinds[kinds.length - 1];
    for (const src of [anchors.documentSource({ kinds }), anchorsSrc.source({ kinds })]) {
      const { apis: [A] } = copiesIn(src);
      assert.equal(typeof A.resolve, 'function', `${kinds}: installed`);
      for (const n of ['index', 'record', 'resolve', 'restamp', 'install', 'resolveAll', 'invalidate', 'watch']) {
        assert.equal(typeof A[n], 'function', `${kinds}: ${n}`);
      }
      for (const [n, has] of Object.entries(want[top])) {
        if (has) assert.equal(typeof A[n], 'function', `${kinds}: ${n}`);
        else assert.ok(n in A && A[n] === undefined, `${kinds}: ${n} is undefined`);
      }
      // Sections are whole or absent: a cut copy holds only its kinds' bodies.
      assert.equal(src.includes('function rangeIn('), kinds.includes('range'), `${kinds}: the range section`);
      assert.equal(src.includes('function resolveSource('), kinds.includes('source'), `${kinds}: the source section`);
    }
  }
});

test('a copy cut without a section: resolveAll answers that kind\'s record orphaned \'invalid-record\'', async () => {
  const { w, apis: [el, rg] } = copiesIn(anchorsSrc.source({ kinds: ['element'] }), anchorsSrc.source({ kinds: ['element', 'range'] }));
  const root = mountInto(w, '<p>alpha beta gamma</p><ul><li class="r">one</li></ul>');
  const tn = root.querySelector('p').firstChild;
  const sel = w.document.createRange();
  sel.setStart(tn, 6);
  sel.setEnd(tn, 10);
  const range = wire(rg.recordRange(root, sel));
  const element = wire(el.record(root, root.querySelector('li.r')));
  const source = { v: 1, kind: 'source', md: 'md-1', slug: null, quote: { exact: 'beta', prefix: '', suffix: '' }, pos: { start: 6, end: 10 } };
  const run = (A) => new Promise((resolve) => {
    A.resolveAll(root, [element, range, source], { schedule: (fn) => fn(), now: () => 0 }, (answers, report) => resolve({ answers, report }));
  });
  const cut = await run(el);
  assert.equal(cut.answers[0].state, 'exact', 'the element record');
  assert.deepStrictEqual(Array.from(cut.answers).slice(1).map((a) => [a.state, a.how]), [['orphaned', 'invalid-record'], ['orphaned', 'invalid-record']]);
  assert.equal(cut.report.ranges, 0, 'no range record was served by a range rule the copy does not hold');
  const ranged = await run(rg);
  assert.deepStrictEqual([ranged.answers[1].state, ranged.answers[1].how, ranged.answers[1].range.toString()], ['exact', 'unique', 'beta']);
  assert.deepStrictEqual([ranged.answers[2].state, ranged.answers[2].how], ['orphaned', 'invalid-record'], 'a source record: the overlay routes it, as in the whole copy');
  assert.equal(ranged.report.ranges, 1);
});

test('the element kind\'s copy answers as the whole copy on every element fixture', () => {
  const { w, apis: [full, cut] } = copiesIn(anchors.documentSource(), anchorsSrc.source({ kinds: ['element'] }));
  const n = sameOnElementFixtures(w, full, cut, 'element kind');
  assert.ok(n > FIX.cases.length, `compared ${n} answers`);
});

// test/anchors-range.test.js's range cases (resolveRange: unique, context,
// position, fuzzy, rewritten, malformed) and test/anchors-source-section.test.js's
// source cases, answered by a cut copy and by the whole one.
const plainRange = (a) => ({ state: a.state, start: a.start, end: a.end, how: a.how, occ: a.occ, dice: a.dice, text: a.range ? a.range.toString() : null });
function rangeCases(w, A) {
  const out = [];
  const pane = '<p>one shared</p><p>two shared</p><p>three shared</p><p>The quick brown fox jumps.</p>';
  const from = mountInto(w, pane);
  const recs = [];
  for (const [needle, k] of [['shared', 1], ['quick brown fox', 0], ['three', 0]]) {
    const ps = [...from.querySelectorAll('p')].map((p) => p.firstChild).filter((t) => t.data.includes(needle));
    const t = ps[k];
    const r = w.document.createRange();
    const at = t.data.indexOf(needle);
    r.setStart(t, at);
    r.setEnd(t, at + needle.length);
    recs.push(wire(A.recordRange(from, r)));
  }
  recs.push({ v: 1, kind: 'range', mount: 'm', quote: { exact: '' }, pos: { start: 0, end: 0 } });
  for (const html of [pane, '<p>zero shared</p>' + pane, pane.replace('brown', 'brawn'), pane.replace('quick brown fox', 'slow red hen'),
    '<p>x shared</p><p>x shared</p><p>x shared</p>', '<p>x shared</p><p>x shared</p><p>x shared</p><p>x shared</p>']) {
    const to = mountInto(w, html);
    for (const rec of recs) out.push(plainRange(A.resolveRange(to, rec)));
  }
  return { recs, out };
}
const SRC_BEFORE = '# Notes\n\nOpening words of the page.\n\n## Plan\n\nWe agreed on the following point: ship the release on Friday morning. Then we celebrate together.\n\n## Next\n\nAfter that, the retro.\n';
const SRC_AFTER = [
  SRC_BEFORE,
  SRC_BEFORE.replace('## Plan\n\n', '## Plan\n\nA new paragraph went in above.\n\n'),
  SRC_BEFORE.replace('Friday', 'Monday'),
  '# Notes\n\nOpening words of the page.\n\n## Plan\n\nA different opening now: hold everything until QA signs off. Then we celebrate together.\n\n## Next\n\nAfter that, the retro.\n',
  '# Notes\n\nNothing of it is left.\n',
];
function sourceCases(w, A) {
  const block = (text) => {
    const el = w.document.createElement('div');
    el.className = 'md-block';
    el.setAttribute('data-md-id', 'md-1');
    el.innerHTML = renderMarkdown(text);
    w.document.body.appendChild(el);
    return { el, src: text, map: sourceMap(text) };
  };
  const a = block(SRC_BEFORE);
  const t = [...a.el.querySelectorAll('p')].map((p) => p.firstChild).find((n) => n.data.includes('Friday'));
  const sel = w.document.createRange();
  const at = t.data.indexOf('ship the release');
  sel.setStart(t, at);
  sel.setEnd(t, at + 'ship the release on Friday morning'.length);
  const rec = wire(A.recordSource(a.el, sel, a.map, a.src));
  const out = [rec];
  for (const text of SRC_AFTER) {
    const b = block(text);
    out.push(plainRange(A.resolveSource(b.el, b.src, b.map, rec)));
    out.push(plainRange(A.resolveSource(b.el, b.src, b.map, { ...rec, quote: null })));
  }
  return out;
}

test('a ref whose kindOf answers range: kindsOf [element, range], and that copy answers as the whole one on the range cases', () => {
  const kinds = anchorsSrc.kindsOf({ elements: ['h3@1'] }, { kindOf: () => 'range' });
  assert.deepStrictEqual(kinds, ['element', 'range']);
  const { w, apis: [full, cut] } = copiesIn(anchors.documentSource(), anchorsSrc.source({ kinds }));
  const want = rangeCases(w, full);
  const got = rangeCases(w, cut);
  assert.deepStrictEqual(got.recs, want.recs, 'the same records');
  assert.deepStrictEqual(got.out, want.out, 'the same answers');
  assert.deepStrictEqual([...new Set(want.out.map((a) => a.how))].sort(), ['context', 'fuzzy', 'invalid-record', 'none', 'ordinal', 'position', 'unique'],
    'the cases reach every range answer');
  sameOnElementFixtures(w, full, cut, 'range kind');
});

test('a source-kind record: kindsOf adds range and source, and that copy answers as the whole one on the source cases', () => {
  const kinds = anchorsSrc.kindsOf({ comments: [{ id: 'c1', anchor: { v: 1, kind: 'source', md: 'md-1' } }] });
  assert.deepStrictEqual(kinds, ['element', 'range', 'source']);
  const { w, apis: [full, cut] } = copiesIn(anchors.documentSource(), anchorsSrc.source({ kinds }));
  const want = sourceCases(w, full);
  assert.deepStrictEqual(sourceCases(w, cut), want);
  assert.deepStrictEqual([...new Set(want.slice(1).map((a) => a.how))].sort(), ['fuzzy', 'invalid-record', 'none', 'section', 'unique'],
    'the cases reach the quote rule, the section fallback, orphaned and invalid');
  assert.deepStrictEqual(rangeCases(w, cut).out, rangeCases(w, full).out);
});

// ── the whole copies: every section, every frozen answer ─────────────────

// test/anchors-resolve-cost.test.js's frozen page (step2-answers.json, 46e6f24).
function frozenPageHtml(secs) {
  let out = '';
  for (const sec of secs) {
    let rows = '';
    for (const row of sec.rows) {
      let sub = '';
      if (row.subs) sub = `<ul class="subs">${row.subs.map((x) => `<li class="sub"><i>${x.step}</i><b class="go">${x.act}</b></li>`).join('')}</ul>`;
      rows += `<div class="row" data-n="${row.n}"><span class="k">${row.key}</span><span class="v">${row.val}</span><span class="n">${row.n}</span><a class="go" href="#">open</a>${sub}</div>`;
    }
    out += `<section class="sec"><h3>${sec.title}</h3><div class="grid">${rows}</div></section>`;
  }
  return out;
}
function frozenMutation(secs, ops) {
  const out = JSON.parse(JSON.stringify(secs));
  for (const [s, k] of ops.edited) out[s].rows[k].val += ' edited';
  for (const [s, k] of ops.replaced) out[s].rows[k].val = 'quite different words now';
  const gone = new Set(ops.removed.map(([s, k]) => `${s}.${k}`));
  out.forEach((sec, s) => { sec.rows = sec.rows.filter((_, k) => !gone.has(`${s}.${k}`)); });
  out[0].rows.unshift({ key: 'Inserted', val: 'a new row at the top', n: 1, subs: null });
  return out;
}
function frozenRow(a) {
  const keys = Object.keys(a).join(',');
  const tie = a.tie ? FROZEN.tie_keys.map((k) => a.tie[k]) : (a.tie === undefined ? 0 : null);
  return [FROZEN.shapes.indexOf(keys), a.state, a.i, a.how === undefined ? 0 : a.how, a.why === undefined ? 0 : a.why, a.via_head === undefined ? 0 : a.via_head, tie];
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const staleOf = (rec) => ({ ...rec, at: { ...rec.at, path: [9999].concat(rec.at.path) } });

test('the whole document copy, its compacted copy, the element kind\'s and the browser module answer step2-answers.json (default config) as frozen', async () => {
  const mod = await importSource(anchors.browserModuleSource());
  const { w, apis: [whole, compacted, element] } = copiesIn(anchors.documentSource(), anchorsSrc.source(), anchorsSrc.source({ kinds: ['element'] }));
  const html = frozenPageHtml(FROZEN.model);
  const mutated = frozenPageHtml(frozenMutation(FROZEN.model, FROZEN.mutation));
  assert.equal(sha(html), FROZEN.html_sha256);
  assert.equal(sha(mutated), FROZEN.mutated_sha256);
  const roots = { same: mountInto(w, html), mutated: mountInto(w, mutated) };
  const from = mountInto(w, html);
  const st = new Set(FROZEN.stale25);
  for (const [label, A] of [['whole', whole], ['compacted', compacted], ['element kind', element], ['browser module', mod]]) {
    const ix = A.index(from);
    const records = FROZEN.picks.map((i) => wire(A.record(from, ix.els[i].node, { ix })));
    assert.equal(sha(JSON.stringify(records)), FROZEN.records_sha256, `${label}: the frozen records`);
    for (const [name, dom] of [['stale25', 'same'], ['stale100', 'same'], ['mutated-stale25', 'mutated']]) {
      const recs = records.map((r, k) => (name === 'stale100' || st.has(k) ? staleOf(r) : r));
      const want = FROZEN.answers[`${name}|default`];
      // One index per variant, as a resolveAll pass holds one.
      const vix = A.index(roots[dom]);
      const got = recs.map((r) => frozenRow(A.resolve(roots[dom], r, FROZEN.cfgs.default, vix)));
      assert.deepStrictEqual(got, want, `${label}: ${name}`);
    }
  }
});

// The factory's text with the api object and resolveAll's range arm (and the
// whole-line comments above each) masked: what U307 may change; and U403b's
// heading rule (RULED U2 (a), 2026-10-28) masked too: the CONFIG.source_heading
// line, the source section's header comment (up to its bare '//' line, so
// alignBlock's own comment stays held), headingAt and resolveSource (each
// with the whole-line comments above it). Everything else is byte-identical to
// ae/int 39b52f8's createAnchors.toString(): the same masks over 39b52f8's
// text give this digest (4633fc65… was the digest with U307's masks alone).
const UNCHANGED_SHA256 = 'e0701d341e8ffd9e0898b6b501d5d132ba6b6043f16dbd35bc74d1b0b030569b';
const maskEdits = (t) => t
  .replace(/(\n {2}\/\/[^\n]*)*\n {2}var api = \{[\s\S]*?\n {2}\};/, '\n  /* api */')
  .replace(/(\n {2}\/\/[^\n]*)*\n {2}function isRange\(rec\) \{[^\n]*/, '\n  /* isRange */')
  .replace(/\n {4}source_heading: true,/, '')
  .replace(/(\n {2}\/\/ ── source ──)(\n {2}\/\/ [^\n]*)*/, '$1\n  /* source header */')
  .replace(/(\n {2}\/\/[^\n]*)*\n {2}function headingAt\([\s\S]*?\n {2}\}/, '')
  .replace(/(\n {2}\/\/[^\n]*)*\n {2}function resolveSource\([\s\S]*?\n {2}\}/, '\n  /* resolveSource */');

test('the whole copies keep every section; outside the api object and resolveAll\'s range arm the factory is 39b52f8\'s byte for byte', async () => {
  const src = anchors.createAnchors.toString();
  assert.equal(sha(maskEdits(src)), UNCHANGED_SHA256, 'the factory outside the granted edits is unchanged');
  for (const [label, text] of [['documentSource()', anchors.documentSource()], ['browserModuleSource()', anchors.browserModuleSource()]]) {
    assert.ok(text.includes(src), `${label}: the whole factory`);
    for (const n of SECTIONS) assert.equal(count(text, `  // ── ${n} ──\n`), 1, `${label}: the ${n} section`);
  }
  const mod = await importSource(anchors.browserModuleSource());
  for (const n of ['recordRange', 'resolveRange', 'recordSource', 'resolveSource']) assert.equal(typeof mod[n], 'function', n);
});

// ── kindsOf and the one predicate ────────────────────────────────────────

const LEGACY = { id: 'c1', text: 'x', anchor: { mount: 'm1', selector: 'li', text: 'Alpha', ordinal: 0 } };
const CONVERTED = { id: 'c2', text: 'y', anchor: { v: 1, kind: 'element', form: 'pin-locator@1', mount: 'm1', path: { selector: 'li' }, fingerprint: { tag: 'li', classes: [], text: 'Alpha' }, ordinal: 0 } };
const KIND_FIXTURES = [
  ['a 0.8.5 locator copy', { comments: [LEGACY] }, {}, ['element']],
  ['a converted pin-locator@1 copy', { comments: [CONVERTED] }, {}, ['element']],
  ['comment copies only', { comments: [LEGACY, CONVERTED, { ...LEGACY, id: 'c3' }] }, {}, ['element']],
  ['a page note (no anchor)', { comments: [{ id: 'c4', text: 'note', anchor: null }] }, {}, []],
  ['pinless', { mounts: [] }, {}, []],
  ['comments: []', { comments: [] }, {}, []],
  ['comments: null', { comments: null }, {}, []],
  ['comments not an array', { comments: { 0: LEGACY, length: 1 } }, {}, []],
  ['null', null, {}, []],
  ['undefined', undefined, {}, []],
  ['a ref, kindOf range', { elements: ['h3@1'] }, { kindOf: () => 'range' }, ['element', 'range']],
  ['a ref, kindOf element', { elements: ['c1@2'] }, { kindOf: () => 'element' }, ['element']],
  ['a ref, kindOf source', { elements: ['h3@1'] }, { kindOf: () => 'source' }, ['element', 'range', 'source']],
  ['a source-kind copy', { comments: [{ id: 'c5', anchor: { v: 1, kind: 'source', md: 'md-1' } }] }, {}, ['element', 'range', 'source']],
  ['a range-kind copy', { comments: [{ id: 'c6', anchor: { v: 1, kind: 'range', mount: 'm1' } }] }, {}, ['element', 'range']],
  ['refs with no kindOf', { elements: ['h3@1', 'c1@1'] }, {}, ['element', 'range', 'source']],
  ['a ref kindOf cannot answer', { elements: ['h3@1'] }, { kindOf: () => null }, ['element', 'range', 'source']],
  ['a box grab only (page anchor)', { elements: ['g2@1'] }, { kindOf: () => 'page' }, []],
  ['a point anchor', { elements: ['g2@1'] }, { kindOf: () => 'point' }, []],
  ['a box grab beside a comment', { comments: [LEGACY], elements: ['g2@1'] }, { kindOf: () => 'page' }, ['element']],
  ['elements: []', { elements: [] }, {}, []],
];

test('kindsOf: the sorted resolver kinds a node\'s comment copies and id@v refs need, closed under KIND_SECTIONS', () => {
  for (const [name, node, opts, want] of KIND_FIXTURES) assert.deepStrictEqual(anchorsSrc.kindsOf(node, opts), want, name);
  assert.deepStrictEqual(anchorsSrc.kindsOf({ elements: ['a@1', 'b@1'] }, { kindOf: (r) => (r === 'a@1' ? 'source' : 'element') }), ['element', 'range', 'source']);
});

test('carriesElements: equal to kindsOf(node).length > 0 on every fixture; true for a node with a pin', () => {
  const pin = { id: 'c1', text: 'x', anchor: { mount: 'm1' } };
  assert.equal(anchorsSrc.carriesElements({ comments: [pin] }), true);
  for (const [name, node, opts] of KIND_FIXTURES) {
    assert.equal(anchorsSrc.carriesElements(node, opts), anchorsSrc.kindsOf(node, opts).length > 0, name);
  }
  for (const [name, node] of [['comments: []', { comments: [] }], ['comments: null', { comments: null }],
    ['no comments field', { mounts: [] }], ['null', null], ['undefined', undefined],
    ['comments not an array', { comments: { 0: pin, length: 1 } }]]) {
    assert.equal(anchorsSrc.carriesElements(node), false, name);
  }
});

test('scriptElement({kinds}): memoised per kind-set, \'\' for none; an unknown kind refused', () => {
  assert.strictEqual(anchorsSrc.scriptElement(), `<script>${anchorsSrc.source()}</script>\n`);
  assert.strictEqual(anchorsSrc.scriptElement({ kinds: [] }), '');
  assert.strictEqual(anchorsSrc.source({ kinds: [] }), '');
  assert.strictEqual(anchorsSrc.source({ kinds: ['range'] }), anchorsSrc.source({ kinds: ['range', 'element'] }));
  assert.strictEqual(anchorsSrc.kindKey(['range']), 'element+range');
  assert.strictEqual(anchorsSrc.kindKey([]), '');
  assert.throws(() => anchorsSrc.source({ kinds: ['page'] }), /no resolver kind page/);
});

// Every lib/ file that reaches the resolver's document copy asks carriesElements
// and splices scriptElement({kinds: kindsOf(node)}): none reads source() to
// spell its own <script>, and none decides on a `comments.length` of its own.
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
    assert.match(req[1], /\bkindsOf\b/, `${rel}: cuts the copy with kindsOf`);
    assert.doesNotMatch(src, /comments\.length/, `${rel}: no comments.length test of its own`);
  }
  assert.deepStrictEqual(users.sort(), ['server/export.js', 'server/preview.js', 'server/replay/document.js']);
});

// ── the documents ────────────────────────────────────────────────────────

// The factory cut to `kinds` spliced once, as its own script, right after the
// runtime's; a cut copy holds no section its kinds do not need.
function assertSpliced(html, where, kinds = ['element']) {
  const src = anchorsSrc.source({ kinds });
  assert.equal(count(html, src), 1, `${where}: the compacted factory (${kinds}) exactly once`);
  assert.equal(count(html, MARK), 1, `${where}: no second copy of the factory`);
  const rt = html.indexOf(`<script>${runtimeSource()}</script>\n<script>${src}</script>`);
  assert.ok(rt >= 0, `${where}: its own <script>, immediately after the runtime's`);
  assert.equal(html.includes('function rangeIn('), kinds.includes('range'), `${where}: the range section only for the range kind`);
  assert.equal(html.includes('function resolveSource('), kinds.includes('source'), `${where}: the source section only for the source kind`);
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
  const add = await api.post('/api/elements', commentBody({ text: 'a note', shared: true, anchor: PIN.anchor }));
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
  // A comment-only node: the element kind alone (kindsOf ['element']).
  assertSpliced(pinned, 'pinned preview', ['element']);
  assert.ok(pinned.includes(b + anchorsSrc.scriptElement({ kinds: ['element'] }) + c), 'pinned: the hole holds the element kind\'s script');
  const w = scripted(pinned);
  await new Promise((r) => setTimeout(r, 50));
  resolvesExact(w, 'm1', 'li:nth-child(2) > span.act', 'preview');
  resolvesExact(w, 'm2', 'p.note', 'preview');
  assert.equal(w.__wcMount.anchor.resolveRange, undefined, 'no range section in a comment-only preview');
  // The element kind's copy in a preview document answers as the full factory.
  // (assertSpliced proved the document carries exactly these bytes.)
  const { w: w2, apis: [full, cut] } = copiesIn(anchors.documentSource(), anchorsSrc.source({ kinds: ['element'] }));
  sameOnElementFixtures(w2, full, cut, 'the preview\'s copy');
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
  assertSpliced(pinned, 'pinned export', ['element']);
  assert.equal(count(pinned, '<script'), 4, 'the payload, the runtime, the resolver, the shell');
});

// A highlight's node: one id@v ref (E-STORE (a)); no kindOf is bound yet, so
// every resolver kind (never under-spliced).
const HIGHLIGHT_KINDS = ['element', 'range', 'source'];

test('replay: one script per distinct kind-set rides as payload data; each step names its key and its filled frame is its node\'s preview', async () => {
  const step = (id, mounts, extra) => ({
    id, label: `${id}.0`, author: 'claude', kind: 'turn', prompt: 'p', summary: 's', reply: null,
    folded_count: 0, created_at: 1000, dt_from_prev: null, theme: 0,
    node: { id, mounts, store: {}, ...extra },
  });
  // pinless, comment-only, highlight (an id@v ref).
  const steps = [step('n1', TWO.slice(0, 1)), step('n2', TWO, { comments: [PIN] }), step('n3', TWO, { elements: ['h3@1'] })];
  const themes = [{}];
  const html = assembleReplay({ steps, themes, opts: normalizeReplayOpts({}) });
  assert.equal(count(html, MARK), 2, 'two distinct kind-sets: two copies of the factory in the whole replay');
  // A second comment-only step shares the element kind's script.
  const four = assembleReplay({ steps: [...steps, step('n4', TWO.slice(1), { comments: [PIN] })], themes, opts: normalizeReplayOpts({}) });
  assert.equal(count(four, MARK), 2, 'a repeated kind-set adds no copy');
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  assert.equal(payload.frame.length, 4, 'the template\'s four pieces');
  for (const piece of payload.frame) assert.equal(count(piece, MARK), 0, 'no template piece carries the factory');
  assert.deepStrictEqual(payload.anchors, {
    element: anchorsSrc.scriptElement({ kinds: ['element'] }),
    'element+range+source': anchorsSrc.scriptElement({ kinds: HIGHLIGHT_KINDS }),
  }, 'each distinct kind-set\'s <script> once, as data, keyed by its sorted kinds');
  assert.deepStrictEqual(payload.steps.map((s) => s.anchors), ['', 'element', 'element+range+source']);
  for (const s of payload.steps) {
    assert.equal(count(s.node, MARK), 0, 'no step carries its own copy');
    assert.equal(JSON.parse(s.node).comments, undefined, 'the frame node carries no pin');
    assert.equal(JSON.parse(s.node).elements, undefined, 'nor an element ref');
  }
  // A replay with no step carrying records carries none of it.
  const none = assembleReplay({ steps: steps.slice(0, 1), themes, opts: normalizeReplayOpts({}) });
  const nonePayload = JSON.parse(new JSDOM(none).window.document.getElementById('wc-replay-data').textContent);
  assertAbsent(nonePayload.frame.join(''), 'pinless replay');
  assert.deepStrictEqual(nonePayload.anchors, {});
  assert.equal(count(none, 'createAnchors'), 0, 'a replay with no pinned step carries no factory');

  // The frames the player itself builds (its iframe factory, srcdoc): each is
  // its node's preview — the same bytes up to the node JSON, which is the
  // step's (the pins and refs dropped) — so a filled frame stays byte-equal to
  // what /preview/node draws for it.
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const frames = [];
  const collect = () => { for (const f of dom.window.document.querySelectorAll('#rp-stage iframe')) frames.push(f.srcdoc); };
  collect();
  // The player builds a step's frame when a seek reaches it (synchronously,
  // before the seek's promise waits on the frame's load); the last step's here.
  const R = dom.window.__wcReplay;
  R.seek(R.stepTime(steps.length - 1));
  collect();
  dom.window.close(); // the player's seek and its timers end here
  const of = (id) => frames.find((f) => f.includes(`"id":"${id}"`));
  steps.forEach((s, i) => {
    const frame = of(s.id);
    assert.ok(frame, `the player built ${s.id}'s frame`);
    const preview = renderPreviewHtml(s.node, themes[0]);
    const [, , c] = payload.frame;
    assert.strictEqual(frame.slice(0, frame.indexOf(c)), preview.slice(0, preview.indexOf(c)), `${s.id}: the frame is its node's preview up to the node`);
    assert.strictEqual(frame, a4(payload, i), `${s.id}: the four pieces, the theme, the step's script and its node`);
  });
  assertAbsent(of('n1'), 'the pinless step\'s frame');
  assertSpliced(of('n2'), 'the comment-only step\'s frame', ['element']);
  assertSpliced(of('n3'), 'the highlight step\'s frame', HIGHLIGHT_KINDS);
  const w = scripted(of('n2'));
  resolvesExact(w, 'm1', 'li:nth-child(1) > b', 'replay frame');
  resolvesExact(w, 'm2', 'p.note', 'replay frame');
  const w3 = scripted(of('n3'));
  resolvesExact(w3, 'm1', 'li:nth-child(2) > b', 'highlight frame');
  assert.equal(typeof w3.__wcMount.anchor.resolveRange, 'function', 'the highlight frame holds the range section');
});
// The frame the player fills for step i, from the payload alone.
function a4(payload, i) {
  const [a, b, c, d] = payload.frame;
  const s = payload.steps[i];
  return a + (payload.themes[s.theme] || '') + b + (s.anchors ? payload.anchors[s.anchors] : '') + c + s.node + d;
}

// The served replay asks each step's own graph node (resolveReplay hands its
// pins as far as assembleReplay's carriesElements) — not only a hand-built step.
test('replay: /replay over the graph flags the pinned node\'s step and carries the factory once; no step node carries a pin', async (t) => {
  const { port } = await twoNodes(t);
  const res = await fetch(`http://localhost:${port}/replay?from=n0&to=n1&chrome=0`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(count(html, MARK), 1, 'the factory once in the whole replay');
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  assert.deepStrictEqual(payload.steps.map((s) => [s.id, s.anchors]), [['n0', ''], ['n1', 'element']]);
  assert.deepStrictEqual(payload.anchors, { element: anchorsSrc.scriptElement({ kinds: ['element'] }) }, 'the element kind\'s <script>, as data');
  for (const s of payload.steps) assert.equal(JSON.parse(s.node).comments, undefined, `${s.id}: the frame node carries no pin`);
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
  assert.strictEqual(assembleExport({ ...input, elements: [] }), bare, 'an empty kind list splices nothing');
  assert.strictEqual(assembleExport({ ...input, elements: false }), bare, 'false splices nothing');
  // true: every kind (the whole factory, as before the per-kind splice).
  const html = assembleExport({ ...input, elements: true });
  assert.equal(count(html, '<script'), 4, 'the payload, the runtime, the resolver, the shell');
  assertSpliced(html, 'export', ['element', 'range', 'source']);
  assert.strictEqual(html.replace(anchorsSrc.scriptElement(), ''), bare, 'the one script element is the only difference');
  const w = scripted(html);
  resolvesExact(w, 'm1', 'li:nth-child(2) > b', 'export');
  resolvesExact(w, 'm2', 'p.note', 'export');
  // A kind list (nodeForExport's kindsOf): that kind-set's script alone.
  const cut = assembleExport({ ...input, elements: ['element'] });
  assert.equal(count(cut, '<script'), 4);
  assertSpliced(cut, 'export (element kind)', ['element']);
  assert.strictEqual(cut.replace(anchorsSrc.scriptElement({ kinds: ['element'] }), ''), bare);
  resolvesExact(scripted(cut), 'm1', 'li:nth-child(2) > b', 'export (element kind)');
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
  // Per kind-set (U307, PLAN.md 2A.7): what a node of that kind carries, and its
  // share of the typical export (themed, fonts inlined) — read by the gate for
  // C-05-1 and GT-17 (tests/F3/inline.js --built), never gated here.
  for (const kinds of KIND_SETS) {
    const n = Buffer.byteLength(anchorsSrc.source({ kinds }));
    const doc = Buffer.byteLength(assembleExport({ ...themedPage, elements: kinds }));
    t.diagnostic(`kind-set ${kinds.join('+')}: ${n} bytes compacted; themed reference export ${doc} bytes, resolver share ${(100 * n / doc).toFixed(2)}%`);
  }
  // 32,768 at U225 (the factory then 18 KB, before U224's chunker and U222a's
  // range and source sections); raised to 36,864 by U222a, whose planned
  // sections took it to about 33 KB; raised to 37,486 by U403b (RULED U2 (a),
  // 2026-10-28) by exactly the heading rule's measured cost: the compacted
  // factory 36,781 bytes before, 37,403 after, 622 bytes. Still a tripwire
  // against an accidental large addition, on the WHOLE factory (every kind);
  // B3's 5% share is the gate's measurement.
  assert.ok(len < 37486, `the compacted factory is ${len} bytes — under the 37,486-byte tripwire`);
});
