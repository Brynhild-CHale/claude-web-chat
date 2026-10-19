// lib/core/anchors.js, the range record's occurrence ordinal and the margin
// rule (annotation engine, PLAN.md 1C.2; RULED GT-02@identical-row-ordinal,
// DECISIONS.md I.5 F1 (a)): a range record of a quote with identical matches
// carries ordinal {index, of}; a context pick within CONFIG.margin of another
// occurrence is never exact; a usable ordinal (its count unchanged) decides a
// tie and overrides a clear context pick only as a re-resolved answer, how
// 'ordinal'. A stale ordinal (well-formed, its count not today's: a recorded
// twin deleted, or one added) names nothing, but a clear context pick or a
// quote unique today is then re-resolved, never exact (how 'context' or
// 'unique'; RULED GT-02@idrow-population, L1 (a)). An older record, or a
// malformed ordinal, resolves by the same rule without it, never refused.
//
// The identical-row oracle is the population of the 1C gate's GT-02a-idrow
// (its decidable ops, then all five ops), built here with the repo's jsdom: no
// design/ path, so the test runs where CI runs. The gate's own measurement
// stays the gate's.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const anchors = require('../lib/core/anchors');

const wire = (o) => JSON.parse(JSON.stringify(o));
const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;
test.after(() => dom.window.close());

function pane(html) {
  const root = doc.createElement('div');
  root.innerHTML = html;
  doc.body.appendChild(root);
  return root;
}
// A range over `needle` in the k-th text node holding it.
function rangeIn(root, needle, k = 0) {
  const w = doc.createTreeWalker(root, 4);
  let n;
  let seen = 0;
  while ((n = w.nextNode())) {
    const at = n.data.indexOf(needle);
    if (at >= 0 && seen++ === k) {
      const r = doc.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + needle.length);
      return r;
    }
  }
  throw new Error(`no text node ${k} holds ${needle}`);
}
const triple = (a) => [a.state, a.how, a.start];

// ── the record ────────────────────────────────────────────────────────────

test('recordRange: a quote occurring three times, recorded in its second -> ordinal {index: 1, of: 3}, after pos', () => {
  const root = pane('<p>one shared words here</p><p>two shared words here</p><p>three shared words here</p>');
  const rec = anchors.recordRange(root, rangeIn(root, 'shared words', 1));
  assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'mount', 'quote', 'pos', 'ordinal']);
  assert.deepStrictEqual(rec.ordinal, { index: 1, of: 3 });
});

test('recordRange: a unique quote records no ordinal (the five keys of before)', () => {
  const root = pane('<p>one shared words here</p><p>two other words here</p>');
  const rec = anchors.recordRange(root, rangeIn(root, 'shared words'));
  assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'mount', 'quote', 'pos']);
  assert.ok(!('ordinal' in rec));
});

test('recordRange: a count at the 400 cap records no ordinal', () => {
  const root = pane('<p>' + 'ab '.repeat(450) + '</p>');
  const rec = anchors.recordRange(root, rangeIn(root, 'ab'));
  assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'mount', 'quote', 'pos']);
});

test('recordRange: the JSON round trip of an ordinal record resolves identically', () => {
  const row = '<li>A repeated row that reads exactly the same every time.</li>';
  const root = pane(`<ul>${row.repeat(4)}</ul>`);
  const rec = anchors.recordRange(root, rangeIn(root, 'reads exactly', 2));
  assert.deepStrictEqual(rec.ordinal, { index: 2, of: 4 });
  const a = anchors.resolveRange(root, rec);
  const b = anchors.resolveRange(root, wire(rec));
  assert.deepStrictEqual({ ...a, range: null }, { ...b, range: null });
  assert.equal(a.range.toString(), b.range.toString());
  assert.deepStrictEqual([a.state, a.how], ['re-resolved', 'ordinal']);
  assert.strictEqual(a.range.startContainer, root.querySelectorAll('li')[2].firstChild);
});

// ── the identical-row oracle (GT-02a-idrow's decidable population) ────────
// 3 to 6 identical rows between a heading and a paragraph, a newline text
// node after each; every row k recorded, the quote its whole text or its first
// two words; the unchanged control, and a word-reversed row inserted first for
// every text but the self-reverse 'approve' (an identical twin: no truth).
// Scored by the row holding the answer's start.

const TEXTS = ['Wave 1 · 8 units', 'Tests · Node 26 green', 'approve', 'Alpha beta gamma delta'];
const reversed = (t) => t.split(' ').reverse().join(' ');
const runHtml = (lis) => '<h3>Run</h3>\n<ul class="run">\n' + lis.map((t) => `<li class="r">${t}</li>\n`).join('') + '</ul>\n<p>after</p>';

function idrowCases() {
  const out = [];
  for (const text of TEXTS) {
    for (let rows = 3; rows <= 6; rows++) {
      for (let k = 0; k < rows; k++) {
        for (const quote of ['whole', 'part']) {
          for (const op of ['none', 'ins-first']) {
            // The self-reverse 'approve' inserted first is a twin: no truth to read.
            if (op === 'ins-first' && reversed(text) === text) continue;
            out.push({ text, rows, k, quote, op });
          }
        }
      }
    }
  }
  return out;
}
function runIdrow() {
  const tally = { cases: 0, correct: 0, wrong: 0, exact: 0, exact_wrong: 0, orphaned: 0, hows: {} };
  for (const c of idrowCases()) {
    const ids = Array.from({ length: c.rows }, () => c.text);
    const from = pane(runHtml(ids));
    const words = c.text.split(' ');
    const q = c.quote === 'whole' ? c.text : words.slice(0, 2).join(' ');
    const li = from.querySelectorAll('li')[c.k].firstChild;
    const r = doc.createRange();
    r.setStart(li, 0);
    r.setEnd(li, q.length);
    const rec = wire(anchors.recordRange(from, r));
    const to = pane(runHtml(ids));
    const target = to.querySelectorAll('li')[c.k];
    if (c.op === 'ins-first') {
      // As the gate inserts it: a DOM insert before row 0, no newline after it.
      const li2 = doc.createElement('li');
      li2.className = 'r';
      li2.textContent = reversed(c.text);
      to.querySelector('ul').insertBefore(li2, to.querySelector('li'));
    }
    const ans = anchors.resolveRange(to, rec);
    tally.cases++;
    tally.hows[ans.how] = (tally.hows[ans.how] || 0) + 1;
    if (ans.state === 'exact') tally.exact++;
    if (ans.state === 'orphaned') tally.orphaned++;
    else if (target.contains(ans.range.startContainer)) tally.correct++;
    else {
      tally.wrong++;
      if (ans.state === 'exact') tally.exact_wrong++;
    }
    from.remove();
    to.remove();
  }
  return tally;
}

test('the identical-row oracle: 252 decidable cases, exact-wrong 0 and wrong <= 1 %', (ctx) => {
  const t = runIdrow();
  ctx.diagnostic(JSON.stringify(t));
  assert.equal(t.cases, 252);
  assert.equal(t.exact_wrong, 0, JSON.stringify(t));
  assert.ok(t.wrong <= 2, JSON.stringify(t));
  assert.equal(t.orphaned, 0, JSON.stringify(t));
  // The ordinal is what decides the shifted twins.
  assert.ok(t.hows.ordinal > 0, JSON.stringify(t.hows));
});

// ── the whole identical-row oracle (GT-02a-idrow, all five ops) ───────────
// As tests/F1/built.js --idrow builds it: 4 texts x 3-6 rows x every row k x
// {whole, part} x {none, del-first, del-middle, ins-first, ins-twin-first} =
// 720 cases. The recorded row's element in the edited pane is kept by
// reference; a case whose recorded row was deleted is counted apart, never
// scoreable (656 scoreable). The undecidable ops (del-first, del-middle,
// ins-twin-first, and ins-first of the self-reverse 'approve') have no truth a
// resolver could read, so an answer there must never be exact on the wrong
// row; the decidable rest keep the 252-case bar above. tied_context_exact is
// measured as the gate measures it: the oracle scores each occurrence's
// context of the edited text and counts an exact answer while another
// occurrence is within CONFIG.margin of the best.

const OPS = ['none', 'del-first', 'del-middle', 'ins-first', 'ins-twin-first'];
const UNDECIDABLE_OPS = new Set(['del-first', 'del-middle', 'ins-twin-first']);
function commonLen(a, b, back) {
  let n = 0;
  while (n < a.length && n < b.length && a.charAt(back ? a.length - 1 - n : n) === b.charAt(back ? b.length - 1 - n : n)) n++;
  return n;
}
// The gate's measure(): how many occurrences tie with the best context.
function tiedCount(s, rec) {
  const q = rec.quote;
  const L = q.exact.length;
  const n = anchors.CONFIG.ctx_n;
  const pre = String(q.prefix || '');
  const suf = String(q.suffix || '');
  const occ = [];
  for (let i = s.indexOf(q.exact); i >= 0 && occ.length < 400; i = s.indexOf(q.exact, i + 1)) occ.push(i);
  const D = pre.length + suf.length;
  const sc = occ.map((at) => commonLen(pre, s.slice(Math.max(0, at - n), at), true) + commonLen(suf, s.slice(at + L, at + L + n)));
  const top = sc.length ? Math.max(...sc) : -1;
  return occ.filter((at, k) => sc[k] === top || (top - sc[k]) / D < anchors.CONFIG.margin).length;
}
function runIdrowAll() {
  const tally = () => ({ cases: 0, scoreable: 0, correct: 0, wrong: 0, orphaned: 0, exact: 0, exact_wrong: 0, tied_context_exact: 0, states: {}, hows: {} });
  const all = tally();
  const scored = tally();
  const dec = tally();
  const gone = tally();
  const byOp = Object.fromEntries(OPS.map((o) => [o, tally()]));
  for (const text of TEXTS) {
    for (let rows = 3; rows <= 6; rows++) {
      for (let k = 0; k < rows; k++) {
        for (const quote of ['whole', 'part']) {
          for (const op of OPS) {
            const ids = Array.from({ length: rows }, () => text);
            const from = pane(runHtml(ids));
            const q = quote === 'whole' ? text : text.split(' ').slice(0, 2).join(' ');
            const li = from.querySelectorAll('li')[k].firstChild;
            const r = doc.createRange();
            r.setStart(li, 0);
            r.setEnd(li, q.length);
            const rec = wire(anchors.recordRange(from, r));
            const to = pane(runHtml(ids));
            const ul = to.querySelector('ul');
            const lis = () => Array.from(to.querySelectorAll('li'));
            const target = lis()[k];
            const mk = (t) => {
              const el = doc.createElement('li');
              el.className = 'r';
              el.textContent = t;
              return el;
            };
            // As the gate edits: a removed row leaves its newline; an inserted
            // row goes before row 0 with no newline after it.
            if (op === 'del-first') lis()[0].remove();
            if (op === 'del-middle') lis()[Math.floor(rows / 2)].remove();
            if (op === 'ins-first') ul.insertBefore(mk(reversed(text)), lis()[0]);
            if (op === 'ins-twin-first') ul.insertBefore(mk(text), lis()[0]);
            const ans = anchors.resolveRange(to, rec);
            const tce = ans.state === 'exact' && tiedCount(to.textContent, rec) > 1;
            const kept = to.contains(target);
            const und = UNDECIDABLE_OPS.has(op) || (op === 'ins-first' && reversed(text) === text);
            const into = kept ? [all, scored, byOp[op], ...(und ? [] : [dec])] : [all, gone];
            for (const t of into) {
              t.cases++;
              t.states[ans.state] = (t.states[ans.state] || 0) + 1;
              t.hows[ans.how] = (t.hows[ans.how] || 0) + 1;
              if (ans.state === 'exact') t.exact++;
              if (tce) t.tied_context_exact++;
              if (!kept) continue;
              t.scoreable++;
              if (ans.state === 'orphaned') t.orphaned++;
              else if (target.contains(ans.range.startContainer)) t.correct++;
              else {
                t.wrong++;
                if (ans.state === 'exact') t.exact_wrong++;
              }
            }
            from.remove();
            to.remove();
          }
        }
      }
    }
  }
  return { all, scored, dec, gone, byOp };
}

test('the whole identical-row oracle: 720 cases, 656 scoreable, exact-wrong 0 over every scoreable case', (ctx) => {
  const t = runIdrowAll();
  ctx.diagnostic(JSON.stringify({ scored: t.scored, dec: t.dec, gone: t.gone }));
  assert.equal(t.all.cases, 720);
  assert.equal(t.scored.scoreable, 656);
  assert.equal(t.gone.cases, 64);
  // GT-02 under L1: exact-wrong 0 over every scoreable case (45 at 8a889f8:
  // del-first 19, del-middle 26, each a stale ordinal's clear context pick).
  assert.equal(t.scored.exact_wrong, 0, JSON.stringify(t.byOp));
  // The decidable 252 keep their bar.
  assert.equal(t.dec.cases, 252);
  assert.equal(t.dec.exact_wrong, 0, JSON.stringify(t.dec));
  assert.ok(t.dec.wrong <= 2, JSON.stringify(t.dec));
  // No exact answer while another occurrence ties with the best context.
  assert.equal(t.all.tied_context_exact, 0, JSON.stringify(t.all));
});

// ── the margin ────────────────────────────────────────────────────────────

// One pane text with exactly two occurrences of 'QQ': A QQ B C QQ E, each of
// A, B and C 32 characters (CONFIG.ctx_n) and E `eLen` characters at the end,
// B starting with E. The record is taken on the second occurrence (start 98):
// its context is C (32) + E (eLen). The first occurrence's suffix shares all of
// E, and its prefix A shares C's last 32 - m characters, so it trails the
// recorded one by m characters of 32 + eLen.
const BASE = 'abcdefghijklmnopqrstuvwxyzABCDEF';
function leadPane(m, eLen) {
  const E = 'GHIJKLMNOPRSTUVWXYZ#$%!()*+,-./:'.slice(0, eLen);
  const A = '9'.repeat(m) + BASE.slice(m);
  const B = (E + '_'.repeat(32)).slice(0, 32);
  return { root: pane(`<p>${A}QQ${B}${BASE}QQ${E}</p>`) };
}
// The record of the second occurrence.
function recordSecond(root) {
  const n = root.querySelector('p').firstChild;
  const at = n.data.indexOf('QQ', n.data.indexOf('QQ') + 1);
  const r = doc.createRange();
  r.setStart(n, at);
  r.setEnd(n, at + 2);
  return wire(anchors.recordRange(root, r));
}

test('margin: a lead within CONFIG.margin is never exact; a lead of CONFIG.margin or more is exact/context', () => {
  // A context of 32 + 8 = 40: leads 0/40 and 1/40 are within 0.05, 2/40 = 0.05 and 3/40 are not.
  for (const [m, tied] of [[0, true], [1, true], [2, false], [3, false]]) {
    const { root } = leadPane(m, 8);
    const rec = recordSecond(root);
    assert.equal(rec.pos.start, 98);
    assert.equal(rec.quote.prefix.length + rec.quote.suffix.length, 40);
    assert.deepStrictEqual(rec.ordinal, { index: 1, of: 2 });
    const { ordinal, ...older } = rec;
    if (tied) {
      assert.deepStrictEqual(triple(anchors.resolveRange(root, rec)), ['re-resolved', 'ordinal', 98], `lead ${m}/40`);
      assert.deepStrictEqual(triple(anchors.resolveRange(root, older)), ['re-resolved', 'position', 98], `lead ${m}/40, no ordinal`);
    } else {
      assert.deepStrictEqual(triple(anchors.resolveRange(root, rec)), ['exact', 'context', 98], `lead ${m}/40`);
      assert.deepStrictEqual(triple(anchors.resolveRange(root, older)), ['exact', 'context', 98], `lead ${m}/40, no ordinal`);
    }
  }
  // margin is a cfg key: a lead of 3/40 is within 0.1, so never exact there.
  const { root } = leadPane(3, 8);
  const wide = anchors.resolveRange(root, recordSecond(root), { margin: 0.1 });
  assert.deepStrictEqual(triple(wide), ['re-resolved', 'ordinal', 98]);
});

test('margin: {margin: 0} gives back the integer-lead pick, exact on any lead', () => {
  // A context of 32 + 32 = 64: a lead of 1/64 = 0.016 is tied under CONFIG.margin.
  const { root } = leadPane(1, 32);
  const rec = recordSecond(root);
  assert.equal(rec.quote.prefix.length + rec.quote.suffix.length, 64);
  const { ordinal, ...older } = rec;
  assert.deepStrictEqual(triple(anchors.resolveRange(root, rec)), ['re-resolved', 'ordinal', 98]);
  assert.deepStrictEqual(triple(anchors.resolveRange(root, older)), ['re-resolved', 'position', 98]);
  assert.deepStrictEqual(triple(anchors.resolveRange(root, rec, { margin: 0 })), ['exact', 'context', 98]);
  assert.deepStrictEqual(triple(anchors.resolveRange(root, older, { margin: 0 })), ['exact', 'context', 98]);
  // An exact tie stays a tie at margin 0.
  const { root: r0 } = leadPane(0, 32);
  const { ordinal: o0, ...older0 } = recordSecond(r0);
  assert.deepStrictEqual(triple(anchors.resolveRange(r0, older0, { margin: 0 })), ['re-resolved', 'position', 98]);
});

// ── the ordinal ───────────────────────────────────────────────────────────

test('ordinal: the count unchanged and a clear context winner elsewhere -> re-resolved at the ordinal\'s occurrence, how ordinal', () => {
  // Recorded on the second occurrence (context C + E); the edit gives the
  // FIRST occurrence that whole context and the second a foreign one.
  const { root } = leadPane(5, 32);
  const rec = recordSecond(root);
  assert.deepStrictEqual(rec.ordinal, { index: 1, of: 2 });
  const E = rec.quote.suffix;
  const to = pane(`<p>${BASE}QQ${E}${'0123456789'.repeat(4)}QQ${'~'.repeat(40)}</p>`);
  const { ordinal, ...older } = rec;
  const ctxOnly = anchors.resolveRange(to, older);
  assert.deepStrictEqual(triple(ctxOnly), ['exact', 'context', 32]);
  const ans = anchors.resolveRange(to, rec);
  assert.deepStrictEqual([ans.state, ans.how, ans.start, ans.occ], ['re-resolved', 'ordinal', 32 + 2 + 32 + 40, 2]);
  assert.equal(ans.range.toString(), 'QQ');
});

test('ordinal: several tied and the ordinal\'s occurrence outside the tie -> the ordinal is passed over, position among the tied', () => {
  // Recorded on the third of three occurrences (context BASE + E); the edit
  // gives the first two that whole context and the third a foreign one, the
  // count unchanged: the ordinal names an occurrence the context rules out.
  const E = 'GHIJKLMNOPRSTUVWXYZ#$%!()*+,-./:';
  const from = pane(`<p>${'0'.repeat(32)}QQ${'1'.repeat(32)}${'2'.repeat(32)}QQ${'3'.repeat(32)}${BASE}QQ${E}</p>`);
  const n = from.querySelector('p').firstChild;
  const r = doc.createRange();
  r.setStart(n, n.data.lastIndexOf('QQ'));
  r.setEnd(n, n.data.lastIndexOf('QQ') + 2);
  const rec = wire(anchors.recordRange(from, r));
  assert.deepStrictEqual([rec.pos.start, rec.ordinal], [164, { index: 2, of: 3 }]);
  const to = pane(`<p>${BASE}QQ${E}${BASE}QQ${E}${'0'.repeat(32)}QQ${'~'.repeat(32)}</p>`);
  const ans = anchors.resolveRange(to, rec);
  assert.deepStrictEqual([ans.state, ans.how, ans.start, ans.occ], ['re-resolved', 'position', 98, 3]);
});

test('ordinal: the count changed (a row deleted, a twin inserted) -> silent in a tie; the margin rule alone answers', () => {
  const row = '<li>A repeated row that reads exactly the same every time.</li>';
  const from = pane(`<ul>${row.repeat(5)}</ul>`);
  const rec = wire(anchors.recordRange(from, rangeIn(from, 'reads exactly', 3)));
  assert.deepStrictEqual(rec.ordinal, { index: 3, of: 5 });
  for (const n of [4, 6]) {
    const to = pane(`<ul>${row.repeat(n)}</ul>`);
    const ans = anchors.resolveRange(to, rec);
    const { ordinal, ...older } = rec;
    const ref = anchors.resolveRange(to, older);
    assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['re-resolved', 'position', n], `${n} rows`);
    assert.deepStrictEqual({ ...ans, range: null }, { ...ref, range: null }, `${n} rows: the ordinal is silent`);
  }
});

// ── older and malformed records ───────────────────────────────────────────

test('an older record (no ordinal) and malformed ordinals resolve by the margin rule alone, never refused', () => {
  const row = '<li>A repeated row that reads exactly the same every time.</li>';
  // Rows 1, 2 and 3 of five share their whole 64-character context: a tie.
  const root = pane(`<ul>${row.repeat(5)}</ul>`);
  const rec = wire(anchors.recordRange(root, rangeIn(root, 'reads exactly', 2)));
  assert.deepStrictEqual(rec.ordinal, { index: 2, of: 5 });
  const { ordinal, ...older } = rec;
  const ref = anchors.resolveRange(root, older);
  assert.deepStrictEqual([ref.state, ref.how], ['re-resolved', 'position']);
  for (const bad of [{ index: 9, of: 3 }, { index: '1', of: 3 }, null, [1, 3], { index: -1, of: 3 }, { index: 1.5, of: 3 }, { index: 1, of: '3' }, 'x', 7]) {
    const ans = anchors.resolveRange(root, { ...older, ordinal: bad });
    assert.deepStrictEqual({ ...ans, range: null }, { ...ref, range: null }, JSON.stringify(bad));
  }
  // A unique quote stays how 'unique' whatever its record carries; re-resolved
  // when its record's ordinal counts more than one (see the stale cases below).
  const u = pane('<p>only once here</p><p>and something else</p>');
  const ur = wire(anchors.recordRange(u, rangeIn(u, 'only once')));
  assert.deepStrictEqual([anchors.resolveRange(u, ur).state, anchors.resolveRange(u, ur).how], ['exact', 'unique']);
  assert.deepStrictEqual([anchors.resolveRange(u, { ...ur, ordinal: { index: 0, of: 2 } }).how], ['unique']);
});

// ── a stale ordinal (its count not today's) ───────────────────────────────
// Rows of one quote, each after a distinct 31-character tag and '|': an
// occurrence's context is its own tag (prefix) and the next row's tag
// (suffix), so a row whose neighbours match the record's wins clearly.

const QUOTE = 'same quote here';
const TAG = (ch) => ch.repeat(31) + '|';
const tagRows = (tags) => `<p>${'y'.repeat(40)}</p><ul>${tags.map((ch) => `<li>${TAG(ch)}${QUOTE}</li>`).join('')}</ul><p>${'z'.repeat(40)}</p>`;
// The record of the row tagged `ch`.
function recordTag(tags, ch) {
  const root = pane(tagRows(tags));
  const li = root.querySelectorAll('li')[tags.indexOf(ch)].firstChild;
  const r = doc.createRange();
  r.setStart(li, 32);
  r.setEnd(li, 32 + QUOTE.length);
  const rec = wire(anchors.recordRange(root, r));
  root.remove();
  return rec;
}
// The state, the how and the tag of the row the answer starts in.
function answerTag(tags, rec) {
  const root = pane(tagRows(tags));
  const a = anchors.resolveRange(root, rec);
  const row = a.range && a.range.startContainer.parentNode;
  root.remove();
  return [a.state, a.how, row && row.tagName === 'LI' ? row.textContent.charAt(0) : null];
}
const FIVE = ['A', 'B', 'C', 'D', 'E'];
const strip = ({ ordinal, ...older }) => older;

test('stale ordinal: the recorded row deleted (of = count + 1) and a clear context winner -> re-resolved, how context, at the winner', () => {
  const rec = recordTag(FIVE, 'C');
  assert.deepStrictEqual(rec.ordinal, { index: 2, of: 5 });
  // Row B now precedes D, the recorded suffix: it wins the context clearly, and is the wrong row.
  assert.deepStrictEqual(answerTag(['A', 'B', 'D', 'E'], rec), ['re-resolved', 'context', 'B']);
  // An older record (no ordinal) keeps today's rule.
  assert.deepStrictEqual(answerTag(['A', 'B', 'D', 'E'], strip(rec)), ['exact', 'context', 'B']);
});

test('stale ordinal: a twin inserted (of = count - 1) and a clear context winner -> re-resolved, how context, at the winner', () => {
  const rec = recordTag(FIVE, 'C');
  assert.deepStrictEqual(answerTag(['A', 'B', 'C', 'D', 'E', 'C'], rec), ['re-resolved', 'context', 'C']);
  assert.deepStrictEqual(answerTag(['C', 'A', 'B', 'C', 'D', 'E'], rec), ['re-resolved', 'context', 'C']);
  assert.deepStrictEqual(answerTag(['A', 'B', 'C', 'D', 'E', 'C'], strip(rec)), ['exact', 'context', 'C']);
});

test('ordinal: of equal to today\'s count -> unchanged (exact/context on the same occurrence, re-resolved/ordinal on another)', () => {
  const rec = recordTag(FIVE, 'C');
  assert.deepStrictEqual(answerTag(FIVE, rec), ['exact', 'context', 'C']);
  // Reordered, the count unchanged: C wins the context at index 3; the ordinal names index 2 (B).
  assert.deepStrictEqual(answerTag(['E', 'A', 'B', 'C', 'D'], rec), ['re-resolved', 'ordinal', 'B']);
  assert.deepStrictEqual(answerTag(['E', 'A', 'B', 'C', 'D'], strip(rec)), ['exact', 'context', 'C']);
});

test('stale ordinal: a malformed ordinal reads as absent (exact/context on a clear winner)', () => {
  const older = strip(recordTag(FIVE, 'C'));
  const edited = ['A', 'B', 'D', 'E'];
  const ref = answerTag(edited, older);
  assert.deepStrictEqual(ref, ['exact', 'context', 'B']);
  for (const bad of [{ index: 9, of: 3 }, { index: '1', of: 3 }, null, [1, 3], { index: -1, of: 3 }, { index: 1.5, of: 3 }, { index: 1, of: '3' }, 'x', 7, { index: 0, of: 400 }]) {
    assert.deepStrictEqual(answerTag(edited, { ...older, ordinal: bad }), ref, JSON.stringify(bad));
  }
});

test('stale ordinal: a quote unique today on a record of two -> re-resolved, how unique; no ordinal or of 1 -> exact/unique', () => {
  const rec = recordTag(['A', 'B'], 'A');
  assert.deepStrictEqual(rec.ordinal, { index: 0, of: 2 });
  // Row A deleted: B's quote is the one occurrence, and the wrong row.
  assert.deepStrictEqual(answerTag(['B'], rec), ['re-resolved', 'unique', 'B']);
  assert.deepStrictEqual(answerTag(['A'], rec), ['re-resolved', 'unique', 'A']);
  assert.deepStrictEqual(answerTag(['B'], strip(rec)), ['exact', 'unique', 'B']);
  assert.deepStrictEqual(answerTag(['B'], { ...strip(rec), ordinal: { index: 0, of: 1 } }), ['exact', 'unique', 'B']);
});

// ── unchanged elsewhere ───────────────────────────────────────────────────

test('a fuzzy hit is re-resolved, never exact, whatever ordinal the record carries', () => {
  const from = pane('<p>Intro.</p><p>The quick brown fox jumps over the lazy dog near the river bank.</p>');
  const rec = wire(anchors.recordRange(from, rangeIn(from, 'quick brown fox jumps over the lazy dog')));
  const to = pane('<p>Intro.</p><p>The quick brawn fox jumps over the lazy dog near the river bank.</p>');
  for (const r of [rec, { ...rec, ordinal: { index: 0, of: 1 } }, { ...rec, ordinal: { index: 0, of: 0 } }]) {
    const ans = anchors.resolveRange(to, r);
    assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'fuzzy']);
  }
});
