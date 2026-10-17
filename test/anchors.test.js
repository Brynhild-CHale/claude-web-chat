// lib/core/anchors.js (annotation engine, PLAN.md 1C.1) and lib/core/anchor-states.js
// (1C.5): the anchor record, the element resolver and the one state vocabulary.
//
// The fixture runner reads test/fixtures/anchors/element-cases.json: hand-made
// panes (the redacted corpus is not in the repo), each mounted into a shadow
// root of a jsdom document through public/mount-runtime.js attachAndExtract
// (scripts not run). The target is recorded in `from`, the record goes through
// JSON (the wire), and is resolved in `to`, at the default CONFIG and at the v4
// parity flags {gate: false, tiebreak: false, ordinal: false}. The rule itself
// is the F1 harness v5 port; the gate's corpus driver checks it against the
// harness, so nothing here requires the design folder.
//
// Speed is measured, never asserted: the timing test runs only under
// WEB_CHAT_PERF=1 and logs p50/p95 with t.diagnostic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES, isAnchorState } = require('../lib/core/anchor-states');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'element-cases.json'), 'utf8'));
const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const ANCHORS_FILE = path.join(__dirname, '..', 'lib', 'core', 'anchors.js');
const PERF = process.env.WEB_CHAT_PERF === '1';
const V4 = { gate: false, tiebreak: false, ordinal: false };
const FLAGS = ['gate', 'tiebreak', 'head_floor', 'ordinal'];
const ANSWER_KEYS = ['state', 'el', 'i', 'why', 'how', 'via_head', 'tie', 'guess'];
const TIE_KEYS = ['depth', 'n', 'keys_identical', 'heads_identical', 'head_lead', 'winner', 'winner_under_row_tol', 'winner_under_head_floor'];

const WINDOWS = [];
function newWindow(withRuntime = true) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  if (withRuntime) dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
test.after(() => { for (const w of WINDOWS) w.close(); });
const W = newWindow();

function mount(html, win = W, id = 'm') {
  const host = win.document.createElement('div');
  host.dataset.mountId = id;
  win.document.body.appendChild(host);
  return win.__wcMount.attachAndExtract(host, html).root;
}
const wire = (o) => JSON.parse(JSON.stringify(o));
const caseNamed = (prefix) => {
  const c = FIX.cases.find((x) => x.name.startsWith(prefix));
  assert.ok(c, `no fixture case starts with ${prefix}`);
  return c;
};
const combos = () => {
  const out = [];
  for (let m = 0; m < 1 << FLAGS.length; m++) {
    const cfg = {};
    FLAGS.forEach((f, k) => { cfg[f] = !!(m & (1 << k)); });
    out.push(cfg);
  }
  return out;
};
// The harness's anchorable: not skipped, and own text or an affordance.
const INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);
function anchorable(e) {
  if (e.skip) return false;
  const n = e.node;
  const own = [...n.childNodes].filter((x) => x.nodeType === 3).map((x) => x.data).join(' ').replace(/\s+/g, ' ').trim();
  return own.length > 0 || INTERACTIVE.has(n.tagName) || n.hasAttribute('onclick') || n.hasAttribute('contenteditable')
    || n.getAttribute('role') === 'button' || n.hasAttribute('tabindex');
}

// Every state and every why/how any answer produced, for the vocabulary and coverage tests.
const SEEN = new Set();
const BRANCHES = { why: new Set(), how: new Set() };
function noted(ans, atDefault) {
  SEEN.add(ans.state);
  if (atDefault) {
    if (ans.why) BRANCHES.why.add(ans.why);
    if (ans.how) BRANCHES.how.add(ans.how);
  }
  return ans;
}

function expectAnswer(ans, exp, to, label) {
  assert.equal(ans.state, exp.state, `${label}: state`);
  const want = exp.target ? to.querySelector(exp.target) : null;
  if (exp.target) assert.ok(want, `${label}: the expected target ${exp.target} is in \`to\``);
  assert.strictEqual(ans.el, want, `${label}: the answered element`);
  const ix = anchors.index(to);
  assert.equal(ans.i, want ? ix.els.findIndex((e) => e.node === want) : -1, `${label}: i`);
  assert.equal(ans.why ?? null, exp.why ?? null, `${label}: why`);
  assert.equal(ans.how ?? null, exp.how ?? null, `${label}: how`);
  if ('via_head' in exp) assert.equal(!!ans.via_head, exp.via_head, `${label}: via_head`);
  if (exp.tie) for (const k of Object.keys(exp.tie)) assert.equal(ans.tie && ans.tie[k], exp.tie[k], `${label}: tie.${k}`);
  for (const k of Object.keys(ans)) assert.ok(ANSWER_KEYS.includes(k), `${label}: answer key ${k} is in the brief's shape`);
  if (ans.tie) assert.deepEqual(Object.keys(ans.tie), TIE_KEYS, `${label}: the tie's shape`);
}

function runCase(c, cfg, exp, label, atDefault) {
  const from = mount(c.from);
  const to = mount(c.to);
  const el = from.querySelector(c.target);
  assert.ok(el, `${label}: the target ${c.target} is in \`from\``);
  const rec = anchors.record(from, el);
  assert.ok(rec, `${label}: recorded`);
  const w = wire(rec);
  if (c.strip_heads) for (const r of w.rows) delete r.head;
  const ans = noted(anchors.resolve(to, w, cfg), atDefault);
  expectAnswer(ans, exp, to, label);
  if (!c.strip_heads) assert.deepStrictEqual(anchors.resolve(to, rec, cfg), ans, `${label}: the JSON round trip resolves identically`);
  return { from, to, rec: w, ans };
}

// ── the vocabulary ─────────────────────────────────────────────────────────

test('ANCHOR_STATES: frozen, in PLAN.md 1C.5 order, and the one the factory was handed', () => {
  assert.ok(Object.isFrozen(ANCHOR_STATES));
  assert.deepEqual([...ANCHOR_STATES], ['exact', 're-resolved', 'orphaned', 'hidden', 'masked', 'provisional', 'superseded', 'expired', 'draw-failed']);
  assert.strictEqual(anchors.ANCHOR_STATES, ANCHOR_STATES);
  assert.strictEqual(anchors.STATES, ANCHOR_STATES);
  for (const s of ANCHOR_STATES) assert.ok(isAnchorState(s));
  for (const s of ['', 'gone', 'Exact', null, undefined, 3]) assert.equal(isAnchorState(s), false);
  assert.throws(() => anchors.createAnchors(['re-resolved', 'orphaned']), /no exact/, 'a vocabulary without exact cannot build the resolver');
});

test('the factory spells a state only to take it from the vocabulary', () => {
  const src = anchors.createAnchors.toString();
  for (const s of ANCHOR_STATES) {
    const all = src.split(`'${s}'`).length - 1;
    const taken = src.split(`stateOf('${s}')`).length - 1;
    assert.equal(all, taken, `'${s}' appears outside stateOf()`);
  }
});

// ── the record ─────────────────────────────────────────────────────────────

test('record: the wire shape, exactly', () => {
  const root = mount(caseNamed('exact:').from);
  const rec = anchors.record(root, root.querySelector('li:nth-child(2) > span.act'));
  assert.deepStrictEqual(rec, {
    v: 1,
    kind: 'element',
    mount: 'm',
    at: { path: [0, 1, 1], sib: 0 },
    fp: { tag: 'span', id: '', cls: ['act'], head: 'edit', attrs: [], parent: 'li.row' },
    rows: [{ depth: 2, shape: 'li||row', sigs: { b: 1, 'span.act': 1 }, key: 'Beta', head: 'Betaedit' }],
  });
  assert.deepStrictEqual(wire(rec), rec);
});

test('record: the fingerprint sorts classes and attribute names, cuts the head at 64 and a row head at 128', () => {
  const long = 'word '.repeat(60);
  const root = mount(`<ul class="l"><li class="z a" title="t" data-q="1" style="x:y" id="k"><b>${long}</b></li><li class="z a"><b>other</b></li></ul>`);
  const rec = anchors.record(root, root.querySelector('b'), { mount: 'given' });
  assert.equal(rec.mount, 'given');
  const li = anchors.record(root, root.querySelector('#k'));
  assert.deepEqual(li.fp.cls, ['a', 'z']);
  assert.deepEqual(li.fp.attrs, ['data-q', 'title']);
  assert.equal(li.fp.head.length, anchors.LIMITS.fp_head);
  assert.equal(rec.rows[0].head.length, anchors.LIMITS.row_head);
  assert.equal(rec.rows[0].key.length, anchors.LIMITS.key);
  assert.equal(rec.rows[0].shape, 'li|k|a.z');
});

test('record: null for a skip element, a chrome-owned element and an element outside the root', () => {
  const root = mount('<p>text</p><style>p{}</style><template><b>t</b></template>');
  const chrome = W.document.createElement('div');
  chrome.setAttribute('data-wc-chrome', 'theme');
  chrome.innerHTML = '<span>chrome text</span>';
  root.appendChild(chrome);
  assert.equal(anchors.record(root, root.querySelector('style')), null);
  assert.equal(anchors.record(root, root.querySelector('template')), null);
  assert.equal(anchors.record(root, chrome), null);
  assert.equal(anchors.record(root, chrome.firstChild), null);
  assert.equal(anchors.record(root, W.document.body), null);
  assert.ok(anchors.record(root, root.querySelector('p')));
});

// ── the fixture runner ─────────────────────────────────────────────────────

for (const c of FIX.cases) {
  test(`case: ${c.name}`, () => {
    const cfgs = c.every_flag ? combos() : [c.cfg || {}];
    for (const cfg of cfgs) runCase(c, cfg, c.expect, `${c.name} @ ${JSON.stringify(cfg)}`, !c.cfg && !c.every_flag);
    if (!c.every_flag) {
      const cfg4 = { ...(c.cfg || {}), ...V4 };
      runCase(c, cfg4, c.v4 || c.expect, `${c.name} @ v4 ${JSON.stringify(cfg4)}`, false);
    }
  });
}

test('every why and how branch has a case at the default config', () => {
  for (const why of ['sibling-lookalike', 'row-context', 'row-lookalike', 'row-unrecorded']) assert.ok(BRANCHES.why.has(why), why);
  for (const how of ['row-search', 'row-ambiguous', 'row-gone', 'not-in-recorded-row', 'score', 'score-margin', 'score-low']) assert.ok(BRANCHES.how.has(how), how);
});

test('v4 parity: the answers differ from v5 only on the cases built to show the gate, the tie-break and the two rulings', () => {
  const differs = FIX.cases.filter((c) => c.v4).map((c) => c.name);
  for (const n of differs) assert.match(n, /key gate|tie:|RULING/, `${n} differs at v4 but is not one of the built cases`);
  assert.ok(differs.length >= 6);
});

test('the two rulings each flip with their flag', () => {
  const floor = caseNamed('RULING H1@head-floor:');
  const floorOn = runCase(floor, {}, floor.expect, 'floor on', false).ans;
  const floorOff = runCase(floor, { head_floor: false }, caseNamed('RULING H1@head-floor off').expect, 'floor off', false).ans;
  assert.equal(floorOn.state, 'orphaned');
  assert.equal(floorOn.tie.winner_under_head_floor, true);
  assert.equal(floorOff.state, 'exact');
  assert.equal(floorOff.via_head, true);
  for (const [on, off] of [['RULING H1@ordinal-tail: Wave 1 deleted', 'RULING H1@ordinal-tail off ({ordinal: false}): Wave 1'],
    ['RULING H1@ordinal-tail: Tests Node 26', 'RULING H1@ordinal-tail off ({ordinal: false}): Tests Node 26']]) {
    const c = caseNamed(on);
    const ordOn = runCase(c, {}, c.expect, `${on}: ordinal on`, false).ans;
    const ordOff = runCase(c, { ordinal: false }, caseNamed(off).expect, `${on}: ordinal off`, false).ans;
    assert.equal(ordOn.state, 'orphaned');
    assert.equal(ordOff.state, 'exact');
  }
});

test('C-8 wave rows: every anchorable element of each row reads exact under every flag combination', () => {
  const c = caseNamed('C-8 wave rows');
  const from = mount(c.from);
  const to = mount(c.to);
  const ixF = anchors.index(from);
  const ixT = anchors.index(to);
  const els = ixF.els.filter(anchorable);
  assert.ok(els.length >= 9);
  for (const e of els) {
    const rec = wire(anchors.record(from, e.node, { ix: ixF }));
    for (const cfg of combos()) {
      const ans = noted(anchors.resolve(to, rec, cfg, ixT), false);
      assert.equal(ans.state, 'exact', `${e.tag} ${e.path} @ ${JSON.stringify(cfg)}`);
      assert.equal(ans.i, e.i);
    }
  }
});

// ── the chrome skip ────────────────────────────────────────────────────────

test('a data-wc-chrome element changes no path, no index entry, no record and no answer', () => {
  const c = caseNamed('row-context:');
  // The pane carries its own <style> elements (as rendered panes do), so a chrome
  // style that leaked into the same-tag sibling count would shift their `sib`.
  const themed = (html, where) => {
    const root = mount(`<style>.row { color: red }</style>${html}<style>b { font-weight: 700 }</style>`);
    const style = W.document.createElement('style');
    style.setAttribute('data-wc-chrome', 'theme');
    style.textContent = ':host { --wc-bg: #101010 }';
    if (where === 'first') root.insertBefore(style, root.firstChild);
    else if (where === 'last') root.appendChild(style);
    return root;
  };
  const shape = (ix) => ix.els.map((e) => [e.i, e.tag, e.path.join('.'), e.sib, e.skip, e.head, e.rkey, e.parent]);
  const variants = ['none', 'first', 'last'];
  const froms = variants.map((v) => themed(c.from, v));
  const tos = variants.map((v) => themed(c.to, v));
  const base = anchors.index(froms[0]);
  for (let k = 1; k < variants.length; k++) {
    assert.deepStrictEqual(shape(anchors.index(froms[k])), shape(base), `index of from, chrome ${variants[k]}`);
    assert.deepStrictEqual(shape(anchors.index(tos[k])), shape(anchors.index(tos[0])), `index of to, chrome ${variants[k]}`);
  }
  for (const e of base.els.filter(anchorable)) {
    const recs = froms.map((root, k) => anchors.record(root, anchors.index(root).els[e.i].node));
    for (let k = 1; k < variants.length; k++) assert.deepStrictEqual(recs[k], recs[0], `record of ${e.path}, chrome ${variants[k]}`);
    const answers = tos.map((root) => noted(anchors.resolve(root, wire(recs[0])), false));
    for (let k = 1; k < variants.length; k++) {
      const strip = (a) => ({ ...a, el: undefined, guess: undefined });
      assert.deepStrictEqual(strip(answers[k]), strip(answers[0]), `answer for ${e.path}, chrome ${variants[k]}`);
    }
  }
});

// ── the positive control for gone ──────────────────────────────────────────

test('positive control: an anchored element removed (no twin left) never reads exact or re-resolved', () => {
  let tried = 0;
  for (const p of FIX.controls) {
    const from = mount(p.html);
    const ix = anchors.index(from);
    for (const e of ix.els.filter(anchorable)) {
      if (ix.fpList[e.fp].length > 1) continue;
      const rec = wire(anchors.record(from, e.node, { ix }));
      const to = mount(p.html);
      anchors.index(to).els[e.i].node.remove();
      const ans = noted(anchors.resolve(to, rec), false);
      assert.equal(ans.state, 'orphaned', `${p.name}: ${e.tag} at ${e.path} answered ${ans.state} (${ans.how})`);
      assert.equal(ans.el, null);
      tried++;
    }
  }
  assert.ok(tried >= 25, `only ${tried} anchorable elements across the three controls`);
});

// ── the re-stamp ───────────────────────────────────────────────────────────

test('restamp: an exact answer re-stamps only `at`; a re-resolved or orphaned answer returns the same record', () => {
  const c = caseNamed('re-stamp:');
  const from = mount(c.from);
  const to = mount(c.to);
  const rec = wire(anchors.record(from, from.querySelector(c.target)));
  const ix = anchors.index(to);
  const ans = anchors.resolve(to, rec, undefined, ix);
  assert.equal(ans.state, 'exact');
  const next = anchors.restamp(rec, ans, ix);
  assert.notStrictEqual(next, rec);
  assert.deepStrictEqual(next.at, c.restamp);
  assert.deepStrictEqual(Object.keys(next), Object.keys(rec));
  for (const k of Object.keys(rec)) if (k !== 'at') assert.strictEqual(next[k], rec[k], k);
  assert.deepStrictEqual(rec.at, { path: [0, 1], sib: 0 }, 'the input record is untouched');
  assert.deepStrictEqual(anchors.restamp(rec, ans), next, 'without an index the root is found from the answer');
  for (const prefix of ['row-context:', 'row-gone:', 'no path hit: step 2 re-resolves']) {
    const r = runCase(caseNamed(prefix), {}, caseNamed(prefix).expect, prefix, false);
    assert.strictEqual(anchors.restamp(r.rec, r.ans), r.rec, prefix);
  }
});

// ── migrated pins: pin-locator@1 ───────────────────────────────────────────

for (const c of FIX.locator) {
  test(`locator: ${c.name}`, () => {
    const root = mount(c.html);
    const ans = noted(anchors.resolve(root, wire(c.rec)), false);
    assert.notEqual(ans.state, 'exact');
    assert.equal(ans.state, c.expect.state);
    const want = c.expect.target ? root.querySelector(c.expect.target) : null;
    assert.strictEqual(ans.el, want);
    const guess = c.expect.guess ? root.querySelector(c.expect.guess) : null;
    assert.strictEqual(ans.guess ?? null, guess);
    if (want) assert.equal(ans.i, anchors.index(root).els.findIndex((e) => e.node === want));
    assert.strictEqual(anchors.restamp(c.rec, ans), c.rec, 'a converted record is never re-stamped');
  });
}

test('locator: the base record is the literal U202 convertAnchor writes', () => {
  assert.deepStrictEqual(FIX.locator[0].rec, {
    v: 1, kind: 'element', form: 'pin-locator@1', mount: 'm', path: { selector: 'div.a.b' }, fingerprint: { tag: 'div', classes: ['a', 'b'], text: 'T' }, ordinal: 2,
  });
});

// ── stubs, the factory contract, the browser copies ────────────────────────

test('the later sections are named stubs that throw "not built"', () => {
  // resolveAll, invalidate and watch are built (U224; test/anchors-chunk.test.js).
  for (const name of ['recordRange', 'resolveRange', 'recordSource', 'resolveSource']) {
    assert.equal(typeof anchors[name], 'function', name);
    assert.throws(() => anchors[name](), new RegExp(`anchors: ${name} is not built`), name);
  }
  const src = fs.readFileSync(ANCHORS_FILE, 'utf8');
  for (const banner of ['element', 'resolveAll', 'range', 'source']) {
    assert.equal(src.split(`  // ── ${banner} ──\n`).length - 1, 1, `the ${banner} banner`);
  }
});

test('install: puts the api on the runtime as M.anchor', () => {
  const M = {};
  assert.strictEqual(anchors.install(M), M.anchor);
  assert.equal(typeof M.anchor.resolve, 'function');
});

test('CONFIG and LIMITS: the pinned values, frozen', () => {
  assert.ok(Object.isFrozen(anchors.CONFIG) && Object.isFrozen(anchors.LIMITS));
  assert.deepStrictEqual({ ...anchors.CONFIG }, {
    tol: 0.8, margin: 0.05, row_tol: 0.6, row_margin: 0.05, key_w: 0.7, gate: true, tiebreak: true, head_n: 128, head_floor: true, ordinal: true,
  });
  assert.deepStrictEqual({ ...anchors.LIMITS }, { fp_head: 64, row_head: 128, key: 32 });
});

// test/mount-runtime.test.js's comment/string stripper, applied to the factory's
// own text; it also refuses a comment after code and a block comment.
test('createAnchors source stays ES5: no arrow, let/const, class, template, spread, ** or async; comments only on whole lines', () => {
  const s = anchors.createAnchors.toString();
  let code = '';
  let lineStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === '\n') lineStart = code.length + 1;
    if (c === '/' && n === '/') {
      assert.match(code.slice(lineStart), /^\s*$/, `a comment shares a line with code: ${s.slice(i, s.indexOf('\n', i))}`);
      while (i < s.length && s[i] !== '\n') i++;
      code += '\n';
      lineStart = code.length;
      continue;
    }
    assert.ok(!(c === '/' && n === '*'), 'a block comment in the factory');
    if (c === '\'' || c === '"') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      code += '""';
      continue;
    }
    code += c;
  }
  for (const [re, what] of [[/=>/, 'an arrow function'], [/\b(let|const|class)\s/, 'let/const/class'], [/`/, 'a template literal'],
    [/\.\.\./, 'spread/rest'], [/\*\*/, 'exponentiation'], [/\b(async|await)\b/, 'async/await'], [/\binstanceof\b/, 'instanceof'],
    [/\b(window|document|globalThis|self)\b/, 'a global']]) {
    assert.doesNotMatch(code, re, `createAnchors uses ${what}`);
  }
  for (const line of s.split('\n')) {
    if (/[^\x00-\x7f]/.test(line)) assert.match(line, /^\s*\/\//, `non-ASCII outside a whole-line comment: ${line}`);
  }
});

test('lib/core/anchors.js spells no script, style or comment opener, no shadow attach, no instanceof, no esc, no Function constructor', () => {
  const src = fs.readFileSync(ANCHORS_FILE, 'utf8');
  for (const bad of ['<script', '</script', '<style', '</style', '<!--', 'attachShadow(', ' instanceof ', 'new Function(']) {
    assert.ok(!src.toLowerCase().includes(bad.toLowerCase()), bad);
  }
  assert.doesNotMatch(src, /(?:var|let|const)\s+esc\b|function\s+esc\s*\(/);
});

const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));

test('browserModuleSource: the same function names and the same answers as the required module', async () => {
  const mod = await importSource(anchors.browserModuleSource());
  assert.strictEqual(anchors.browserModuleSource(), anchors.browserModuleSource(), 'memoised');
  const OWN = new Set(['createAnchors', 'browserModuleSource', 'documentSource']);
  const fromNode = Object.keys(anchors).filter((k) => typeof anchors[k] === 'function' && !OWN.has(k)).sort();
  const fromModule = Object.keys(mod).filter((k) => k !== 'default' && typeof mod[k] === 'function').sort();
  assert.deepStrictEqual(fromModule, fromNode);
  assert.deepStrictEqual({ ...mod.CONFIG }, { ...anchors.CONFIG });
  for (const prefix of ['row-lookalike:', 'tie: identical keys, distinct heads', 'RULING H1@ordinal-tail: Wave 1 deleted']) {
    const c = caseNamed(prefix);
    const from = mount(c.from);
    const to = mount(c.to);
    const el = from.querySelector(c.target);
    const rec = anchors.record(from, el);
    assert.deepStrictEqual(mod.record(from, el), rec, prefix);
    for (const cfg of [{}, V4]) assert.deepStrictEqual(mod.resolve(to, wire(rec), cfg), anchors.resolve(to, wire(rec), cfg), prefix);
  }
  const loc = FIX.locator[3];
  const root = mount(loc.html);
  assert.deepStrictEqual(mod.resolve(root, loc.rec), anchors.resolve(root, loc.rec));
});

test('documentSource: installs window.__wcMount.anchor beside the mount runtime, and resolves there', () => {
  assert.strictEqual(anchors.documentSource(), anchors.documentSource(), 'memoised');
  const w = newWindow();
  w.eval(anchors.documentSource());
  const A = w.__wcMount.anchor;
  assert.equal(typeof A.resolve, 'function');
  const c = caseNamed('row-context:');
  const from = mount(c.from, w);
  const to = mount(c.to, w);
  const ans = A.resolve(to, A.record(from, from.querySelector(c.target)));
  assert.equal(ans.state, 're-resolved');
  assert.strictEqual(ans.el, to.querySelector(c.expect.target));
  const bare = newWindow(false);
  assert.doesNotThrow(() => bare.eval(anchors.documentSource()), 'no runtime: nothing to install, no error');
  assert.equal(bare.__wcMount, undefined);
});

test('only exact, re-resolved and orphaned were ever answered, all from ANCHOR_STATES', () => {
  assert.ok(SEEN.size > 0);
  for (const s of SEEN) assert.ok(ANCHOR_STATES.includes(s), s);
  assert.deepStrictEqual([...SEEN].sort(), ['exact', 'orphaned', 're-resolved']);
});

// ── timing (measured under WEB_CHAT_PERF=1, never asserted) ────────────────

test('timing: a cold pass over 481 records (index + every record), p50/p95 over 20 runs', { skip: !PERF && 'WEB_CHAT_PERF=1 only' }, (t) => {
  const sec = (s) => {
    let rows = '';
    for (let r = 0; r < 12; r++) {
      let sub = '';
      for (let k = 0; k < 3; k++) sub += `<li class="sub"><i>step ${s}.${r}.${k}</i><button class="go">Run</button></li>`;
      rows += `<li class="row"><b>Section ${s} row ${r}</b><span class="d">detail text for row ${r} of ${s}</span><ul class="subs">${sub}</ul></li>`;
    }
    return `<section class="sec"><h3>Section ${s}</h3><ul class="rows">${rows}</ul></section>`;
  };
  let html = '';
  for (let s = 0; s < 6; s++) html += sec(s);
  const from = mount(html);
  const ixF = anchors.index(from);
  const recs = ixF.els.filter(anchorable).slice(0, 481).map((e) => wire(anchors.record(from, e.node, { ix: ixF })));
  assert.equal(recs.length, 481);
  const to = mount(html);
  to.querySelector('ul.rows > li').remove();
  const runs = [];
  for (let k = 0; k < 20; k++) {
    const t0 = process.hrtime.bigint();
    const ix = anchors.index(to);
    for (const r of recs) anchors.resolve(to, r, undefined, ix);
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  t.diagnostic(`cold pass, 481 records: p50 ${runs[9].toFixed(1)} ms, p95 ${runs[18].toFixed(1)} ms (jsdom, node ${process.version})`);
});
