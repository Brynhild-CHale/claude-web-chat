// lib/core/redact.js markAt / marksIn / matchMasked (PLAN 3A.3, DECISIONS D4
// mask-tolerant, readiness R4 seam d, GT-13, M-7).
//
// A pin's quote is taken from served text, which is always the masked view.
// Once the redactor learns a value (addKnown, a known source), the served text
// holds a mark where the quote held words, and the quote no longer matches
// literally (M-7 measured 4/32 anchors still exact). matchMasked reads a
// well-formed mark of the served text as a wildcard: it maps the quote to its
// true span, and a quote that crosses, ends inside or lies inside a learned
// value answers masked, never as a literal match.
//
// The fixture is M-7's six teachings (16 anchors) learned two ways, 32 anchors
// in all. The true span is computed here WITHOUT the matcher: every learned
// value's occurrence in the old text, and every mark the old text already
// held, are paired in order with the marks of the new text, found by their
// own spellings (MASK(label) and the old mark's text), not by marksIn.
//
// Values come from test-support/fake-secrets.js; masks are built with MASK()
// (the mask's opening is spelled in lib/core/redact.js alone).

const test = require('node:test');
const assert = require('node:assert');

const { MASK, WITHHELD, PARTIAL_LINE, markAt, marksIn, matchMasked, createRedactor } = require('../lib/core/redact');
const { fakeSecrets } = require('../test-support/fake-secrets');

const FAKES = fakeSecrets();
const secretOf = (id) => {
  const f = FAKES.find((x) => x.id === id);
  assert.ok(f, `fake-secrets has no ${id}`);
  return f.secrets[0];
};
const E = secretOf('known-email'); // masked only once known
const O = secretOf('known-org'); // masked only once known
const G = secretOf('github-ghp'); // masked from the start

const CTX_N = 32;
const ANSWER_KEYS = ['end', 'how', 'masked', 'occ', 'start'];

// Every occurrence of `needle` in `hay` as [start, end].
function spansOf(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

// The true location of old span [s, e) in the new text (F7's trueSpan): old
// regions (learned values, old marks) paired in order with new marks; a start
// inside a region maps to its mark's start, an end inside one to its end.
function trueSpan(regions, masks, s, e) {
  assert.equal(regions.length, masks.length, 'old regions and new marks pair one to one');
  const map = (x, end) => {
    let delta = 0;
    for (let k = 0; k < regions.length; k++) {
      const [os, oe] = regions[k];
      const [ns, ne] = masks[k];
      if (end ? x > os && x <= oe : x >= os && x < oe) return end ? ne : ns;
      if (x < os || (end && x === os)) break;
      delta += (ne - ns) - (oe - os);
    }
    return x + delta;
  };
  return { start: map(s, false), end: map(e, true) };
}

// M-7's six teachings: the reply text and its anchors (name, quote) over the
// text as served BEFORE learning.
const TEACHINGS = [
  { name: 'one value', text: `Before the value, a quote. Contact ${E} for access; after the value, another quote that we anchor on.`,
    anchors: () => [['before-value', 'Before the value, a quote.'], ['spanning-value', `Contact ${E} for access`], ['after-value', 'another quote that we anchor on.']] },
  { name: 'the value twice', text: `First ${E} here, then the same ${E} again, and a closing line we anchor on.`,
    anchors: () => [['between-the-two', ' here, then the same '], ['spanning-both', `First ${E} here, then the same ${E} again`], ['after-both', 'a closing line we anchor on.']] },
  { name: 'two values learned at once', text: `Mail ${E} or ask ${O} directly; the trailing anchor sits here.`,
    anchors: () => [['spanning-both-values', `Mail ${E} or ask ${O} directly`], ['between-values', ' or ask '], ['trailing', 'the trailing anchor sits here.']] },
  { name: 'a quote ending inside the value', text: `Reach out: write to ${E} before noon, please.`,
    anchors: () => [['ends-inside', `write to ${E.slice(0, 10)}`], ['after', 'before noon, please.']] },
  { name: 'a quote entirely inside the value', text: `Owner address is ${E} as listed.`,
    anchors: () => [['inside', E.slice(3, 15)], ['after', 'as listed.']] },
  { name: 'old text already holds a mask', text: `Token ${G} was rotated; then contact ${E} next; the end anchor is here.`,
    anchors: (b) => [['spans-old-mask', b.slice(b.indexOf('Token'), b.indexOf(' was rotated') + ' was rotated'.length)], ['spans-new-mask', `contact ${E} next`], ['after-both', 'the end anchor is here.']] },
];

const LEARNINGS = [
  ['addKnown for both values', (r) => { r.addKnown(E, 'email'); r.addKnown(O, 'org'); }],
  ['the email through a known source, the org through addKnown', (r) => { r.addKnownSource(() => E, 'email', { maxAgeMs: 0 }); r.addKnown(O, 'org'); }],
];

function runTeachings(learn) {
  const r = createRedactor();
  const before = TEACHINGS.map((c) => r.text(c.text));
  const oldMark = r.text(G);
  assert.ok(markAt(oldMark, 0) === oldMark.length, 'the github token is masked from the start, as one mark');
  learn(r);
  const after = TEACHINGS.map((c) => r.text(c.text));
  const rows = [];
  TEACHINGS.forEach((c, i) => {
    const b = before[i];
    const a = after[i];
    assert.ok(b.includes(E) && !a.includes(E) && !a.includes(O), `${c.name}: the values are served before learning and masked after`);
    const learned = [...spansOf(b, E), ...spansOf(b, O)];
    const regions = [...learned, ...spansOf(b, oldMark)].sort((x, y) => x[0] - y[0]);
    const masks = [...spansOf(a, MASK('email')), ...spansOf(a, MASK('org')), ...spansOf(a, oldMark)].sort((x, y) => x[0] - y[0]);
    for (const [name, exact] of c.anchors(b)) {
      const s = b.indexOf(exact);
      assert.ok(s >= 0, `${c.name}/${name}: the quote is in the text served before learning`);
      const e = s + exact.length;
      const quote = { exact, prefix: b.slice(Math.max(0, s - CTX_N), s), suffix: b.slice(e, e + CTX_N) };
      const got = matchMasked(a, quote, { pos: { start: s, end: e } });
      const touches = learned.some(([os, oe]) => os < e && oe > s);
      rows.push({ name: `${c.name}/${name}`, got, want: trueSpan(regions, masks, s, e), touches, literalAfter: a.includes(exact), stillExact: a.indexOf(exact) === s });
    }
  });
  return rows;
}

for (const [how, learn] of LEARNINGS) {
  test(`M-7, learned by ${how}: 16/16 anchors map to their true spans; every quote touching a learned value answers masked`, (t) => {
    const rows = runTeachings(learn);
    assert.equal(rows.length, 16);
    let recovered = 0;
    for (const row of rows) {
      assert.ok(row.got, `${row.name}: an answer`);
      assert.deepEqual(Object.keys(row.got).sort(), ANSWER_KEYS, `${row.name}: offsets and flags only`);
      assert.deepEqual({ start: row.got.start, end: row.got.end }, row.want, `${row.name}: the true span`);
      assert.equal(row.got.masked, row.touches, `${row.name}: masked exactly when the quote touches a learned value`);
      assert.equal(row.got.how, row.touches ? 'mask' : 'literal', `${row.name}: how`);
      if (row.touches) assert.ok(!row.literalAfter, `${row.name}: a masked quote is no longer served literally`);
      recovered += 1;
    }
    const masked = rows.filter((r) => r.touches).length;
    t.diagnostic(`recovered ${recovered}/16; masked ${masked}, literal ${16 - masked}; a literal quote at its old offset (no matcher) ${rows.filter((r) => r.stillExact).length}/16`);
  });
}

test('M-7 in all: 32/32 recovered; the spans-old-mask anchor is literal at its true span (its mark was there at create)', () => {
  const rows = LEARNINGS.flatMap(([, learn]) => runTeachings(learn));
  assert.equal(rows.length, 32);
  const ok = rows.filter((r) => r.got && r.got.start === r.want.start && r.got.end === r.want.end && r.got.masked === r.touches);
  assert.equal(ok.length, 32);
  for (const r of rows.filter((x) => x.name.endsWith('/spans-old-mask'))) {
    assert.equal(r.got.masked, false);
    assert.equal(r.got.how, 'literal');
  }
  assert.ok(rows.filter((r) => r.touches).every((r) => r.got.masked && r.got.how === 'mask'), 'never exact inside a learned value');
});

test('null when the served text holds no mark at all: the caller\'s quote rule decides alone', () => {
  assert.equal(matchMasked('plain text, nothing masked here', { exact: 'nothing masked' }), null);
  assert.equal(matchMasked('opens one ‹redacted:\nand never closes', { exact: 'never closes' }), null, 'an opener is no mark');
  assert.equal(matchMasked('', { exact: 'x' }), null);
  for (const bad of [null, undefined, 42, {}, { exact: '' }, { exact: 7 }]) assert.equal(matchMasked(`a ${MASK('email')} b`, bad), null);
  assert.equal(matchMasked(42, { exact: 'x' }), null);
});

test('a mark the quote already spelled is matched literally, not as a wildcard', () => {
  const m = MASK('github-token');
  const served = `rotate: Token ${m} was rotated; mail ${MASK('email')} today`;
  const exact = `Token ${m} was rotated`;
  const got = matchMasked(served, { exact, prefix: 'rotate: ', suffix: '; mail' });
  assert.deepEqual(got, { start: served.indexOf(exact), end: served.indexOf(exact) + exact.length, masked: false, how: 'literal', occ: 1 });
  // The same place, with a different mark spelled in the quote: now a wildcard.
  const other = matchMasked(served, { exact: `Token ${MASK('org')} was rotated`, prefix: 'rotate: ', suffix: '' });
  assert.equal(other.masked, true);
  assert.equal(other.start, served.indexOf('Token'));
});

test('a window ending inside a mark it spells: that mark stays literal, after a wildcard too', () => {
  // The quote was made over text that already held the token's mark, and the
  // selection ends partway into it; its context then changed (exact alone is
  // tried) and the email was learned. The email's mark is a wildcard; the old
  // mark, which W ends inside, is still literal, so the end stays inside it.
  const r = createRedactor();
  const text = `Mail ${E} first. Rotate now, please: ${G} is the token we lost.`;
  const before = r.text(text);
  const s = before.indexOf(E);
  const e = before.indexOf(MASK('github-token')) + 5;
  const exact = before.slice(s, e);
  r.addKnown(E, 'email');
  const served = r.text(text);
  const shift = MASK('email').length - E.length;
  const got = matchMasked(served, { exact, prefix: 'A rewritten opening: ', suffix: '' }, { pos: { start: s, end: e } });
  assert.deepEqual(got, { start: s, end: e + shift, masked: true, how: 'mask', occ: 1 });
});

test('several alignments: the one nearest pos.start (ties and no pos: the first); occ counted, capped at 400', () => {
  const unit = `see ${MASK('email')} tail. `;
  const served = unit.repeat(3);
  const quote = { exact: `see ${E} tail.`, prefix: '', suffix: '' };
  const first = matchMasked(served, quote);
  assert.deepEqual(first, { start: 0, end: unit.length - 1, masked: true, how: 'mask', occ: 3 });
  const third = matchMasked(served, quote, { pos: { start: 2 * unit.length + 5, end: 0 } });
  assert.equal(third.start, 2 * unit.length);
  assert.equal(third.occ, 3);
  // Equidistant from the first and second: the first.
  const tie = matchMasked(served, quote, { pos: { start: unit.length / 2 } });
  assert.equal(tie.start, 0);
  const many = matchMasked(unit.repeat(450), quote, { pos: { start: 449 * unit.length } });
  assert.equal(many.occ, 400, 'capped as the factory\'s occurrencesOf is');
});

test('a quote that aligns nowhere: null', () => {
  const served = `Contact ${MASK('email')} for access.`;
  assert.equal(matchMasked(served, { exact: 'nothing like this sentence', prefix: 'a', suffix: 'b' }), null);
  // Wholly inside a mask, context too: no literal character locates it.
  assert.equal(matchMasked(MASK('email'), { exact: E.slice(3, 9), prefix: E.slice(0, 3), suffix: E.slice(9) }), null);
  // Wholly inside a mask at both edges of the text (its context empty): the
  // edges hold, and still no literal character locates it.
  assert.equal(matchMasked(MASK('email'), { exact: E, prefix: '', suffix: '' }), null);
  // Two literal characters between two marks, with a full context on both
  // sides (no edge is named): a mark followed by a matching space is no place.
  const between = `alpha ${MASK('email')} o${MASK('org')} omega`;
  assert.equal(matchMasked(between, { exact: `${'q'.repeat(20)} o`, prefix: 'P'.repeat(CTX_N), suffix: 'R'.repeat(CTX_N) }), null);
});

test('a short window anchored at its text\'s edges that crosses a learned value: masked at its true span', () => {
  // The quote is the whole item (its context is empty: it reached both
  // edges), and fewer than MATCH_LITERAL_MIN (8) of its characters stay
  // literal once the values are learned. The edges place it.
  const cases = [
    ['a lead word and the value', `To ${E}`],
    ['the value twice between short words', `a ${E} b ${E} c`],
    ['two values with one space between', `${E} ${O}`],
  ];
  for (const [name, text] of cases) {
    const r = createRedactor();
    const before = r.text(text);
    assert.equal(before, text, `${name}: served whole before learning`);
    r.addKnown(E, 'email');
    r.addKnown(O, 'org');
    const served = r.text(text);
    assert.ok(!served.includes(E) && !served.includes(O), `${name}: masked after learning`);
    const got = matchMasked(served, { exact: before, prefix: '', suffix: '' }, { pos: { start: 0, end: before.length } });
    assert.deepEqual(got, { start: 0, end: served.length, masked: true, how: 'mask', occ: 1 }, name);
  }
  // One edge is enough when the context names one: a short prefix (the item's
  // start) with a full suffix; a full prefix with a short suffix (its end).
  const tail = ' and then a sentence long enough to fill the suffix.';
  const head = 'An opening sentence long enough to fill the prefix. ';
  const r = createRedactor();
  r.addKnown(E, 'email');
  r.addKnown(O, 'org');
  const startServed = r.text(`To ${E}${tail}`);
  const atStart = matchMasked(startServed, { exact: `To ${E}`, prefix: '', suffix: tail.slice(0, CTX_N) }, { pos: { start: 0, end: 3 + E.length } });
  assert.deepEqual(atStart, { start: 0, end: 3 + MASK('email').length, masked: true, how: 'mask', occ: 1 }, 'a short prefix: the start edge');
  const endServed = r.text(`${head}${E} ${O}`);
  const atEnd = matchMasked(endServed, { exact: `${E} ${O}`, prefix: head.slice(-CTX_N), suffix: '' });
  assert.deepEqual(atEnd, { start: head.length, end: endServed.length, masked: true, how: 'mask', occ: 1 }, 'a short suffix: the end edge');
});

test('the edge exception is held to the edges its context names, and to the context length anchors.js records', () => {
  const { CONFIG } = require('../lib/core/anchors');
  assert.equal(CONFIG.ctx_n, CTX_N, 'the matcher reads a context shorter than anchors.js records as an edge');
  const M = MASK('email');
  // The quote reached the item's start and end; the text now reads with more
  // on either side of the only place it aligns: the edges do not hold, and
  // its two literal characters are no evidence of a place.
  const quote = { exact: `${E} x`, prefix: '', suffix: '' };
  assert.equal(matchMasked(`lead ${M} x`, quote), null, 'the start edge does not hold');
  assert.equal(matchMasked(`${M} x tail`, quote), null, 'the end edge does not hold');
  // One character off an edge is off it: an edge is exactly 0 and exactly
  // served.length, never near them.
  assert.equal(matchMasked(` ${M} x`, quote), null, 'one character past the start edge');
  assert.equal(matchMasked(`${M} x `, quote), null, 'one character short of the end edge');
  assert.deepEqual(matchMasked(`${M} x`, quote), { start: 0, end: M.length + 2, masked: true, how: 'mask', occ: 1 }, 'both hold');
  // A full suffix names no edge; a prefix one short of the context length
  // names the start, a full one does not (and exact alone keeps three literal
  // characters of 34: no answer either).
  const served = `${M} x ${MASK('org')}`;
  const exact = `${E} x ${O.slice(0, 4)}`;
  const suffix = O.slice(4);
  assert.equal(suffix.length, CTX_N, 'the fixture: a full suffix');
  assert.deepEqual(matchMasked(served, { exact, prefix: 'z'.repeat(CTX_N - 1), suffix }), { start: 0, end: served.length, masked: true, how: 'mask', occ: 1 }, 'a prefix one short of the context length: the start edge');
  assert.equal(matchMasked(served, { exact, prefix: 'z'.repeat(CTX_N), suffix }), null, 'a full prefix and a full suffix: the floor holds');
});

test('the window is retried with exact alone when its context changed', () => {
  const served = `A rewritten opening. Contact ${MASK('email')} for access. A rewritten close.`;
  const exact = `Contact ${E} for access`;
  const got = matchMasked(served, { exact, prefix: 'The old opening said: ', suffix: '; the old close.' });
  assert.deepEqual(got, { start: served.indexOf('Contact'), end: served.indexOf(' for access') + ' for access'.length, masked: true, how: 'mask', occ: 1 });
});

test('a quote ending at the text\'s end, whose trailing run also occurs inside the learned value: the end is the text\'s end', () => {
  // The served run after the mark ('.') reaches the end of the text and also
  // occurs inside the email, so the first place W holds it is inside the
  // value; the candidate where W ends with it must still be tried.
  assert.ok(E.includes('.'), 'the fixture: the trailing run occurs inside the value');
  const cases = [
    ['the whole text', 'Write to ', (b) => ({ exact: b, prefix: '', suffix: '' })],
    ['with a prefix', 'Please write to ', (b) => ({ exact: b.slice('Please '.length), prefix: 'Please ', suffix: '' })],
    ['exact alone (the context changed)', 'Please write to ', (b) => ({ exact: b.slice('Please '.length), prefix: 'Kindly ', suffix: '' })],
  ];
  for (const [name, lead, quoteOf] of cases) {
    const r = createRedactor();
    const before = r.text(`${lead}${E}.`);
    assert.ok(before.endsWith(`${E}.`), `${name}: the value is served before learning`);
    const quote = quoteOf(before);
    const s = before.length - quote.exact.length;
    r.addKnown(E, 'email');
    const served = r.text(`${lead}${E}.`);
    assert.equal(served, `${lead}${MASK('email')}.`, `${name}: the value is masked after learning`);
    const got = matchMasked(served, quote, { pos: { start: s, end: before.length } });
    assert.deepEqual(got, { start: s, end: served.length, masked: true, how: 'mask', occ: 1 }, name);
  }
});

test('a window starting and ending inside marks; context consumed by wildcards is not masked', () => {
  const served = `${MASK('email')} said hello to ${MASK('org')}`;
  const got = matchMasked(served, { exact: 'said hello', prefix: E.slice(-6) + ' ', suffix: ' to ' + O.slice(0, 5) });
  assert.deepEqual(got, { start: served.indexOf('said'), end: served.indexOf('said') + 'said hello'.length, masked: false, how: 'literal', occ: 1 });
});

test('marksIn finds MASK, WITHHELD and PARTIAL_LINE marks in order, and nothing that merely opens one', () => {
  const parts = ['head ', MASK('email'), ' mid ', WITHHELD('ssh'), '\n', PARTIAL_LINE, ' tail ‹redacted:', '\n', '‹withheld: sensitive file (ssh', ' ‹redacted:Bad Label› ‹'];
  const text = parts.join('');
  const want = [MASK('email'), WITHHELD('ssh'), PARTIAL_LINE].map((m) => ({ start: text.indexOf(m), end: text.indexOf(m) + m.length }));
  assert.deepEqual(marksIn(text), want);
  assert.deepEqual(marksIn('no marks'), []);
  assert.deepEqual(marksIn(''), []);
  assert.deepEqual(marksIn(null), []);
  assert.deepEqual(marksIn(`${MASK('a')}${MASK('b')}`), [{ start: 0, end: MASK('a').length }, { start: MASK('a').length, end: MASK('a').length + MASK('b').length }], 'adjacent marks');
});

test('markAt is exported and unchanged: the length of the well-formed mark at text[o], else 0', () => {
  for (const m of [MASK('secret'), MASK('github-token'), WITHHELD('ssh'), WITHHELD('other'), PARTIAL_LINE]) {
    assert.equal(markAt(m, 0), m.length);
    assert.equal(markAt(`xy${m}z`, 2), m.length);
    assert.equal(markAt(`xy${m}z`, 1), 0);
  }
  assert.equal(markAt('‹redacted:', 0), 0, 'an opener at a line end');
  assert.equal(markAt('‹redacted:\nx›', 0), 0);
  assert.equal(markAt('‹redacted:Upper›', 0), 0, 'a label MASK never writes');
  assert.equal(markAt('‹withheld: sensitive file (ssh›', 0), 0, 'WITHHELD without its parenthesis');
  assert.equal(markAt('plain', 0), 0);
});

test('bounds: a 256 KB served text with 500 marks and a 2,064-character window', (t) => {
  // Deterministic words, a mark every ~520 characters.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
  let served = '';
  let marks = 0;
  while (served.length < 256 * 1024) {
    served += `${words[Math.floor(rnd() * words.length)]} `;
    if (served.length > (marks + 1) * 520 && marks < 500) { served += `${MASK(marks % 2 ? 'email' : 'org')} `; marks += 1; }
  }
  assert.equal(marksIn(served).length, 500);
  // A window around the 250th mark, as it was before the value was learned.
  const m = marksIn(served)[250];
  const before = `${served.slice(m.start - 1000, m.start)}${E}${served.slice(m.end, m.end + 1000 + 64 - E.length)}`;
  const exact = before.slice(32, before.length - 32);
  const quote = { exact, prefix: before.slice(0, 32), suffix: before.slice(-32) };
  assert.equal(before.length, 2064);
  let t0 = process.hrtime.bigint();
  const hit = matchMasked(served, quote, { pos: { start: m.start - 968 } });
  const hitMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepEqual(hit, { start: m.start - 968, end: m.end + 968 + 64 - E.length, masked: true, how: 'mask', occ: 1 });
  t0 = process.hrtime.bigint();
  const miss = matchMasked(served, { exact: 'zulu '.repeat(400), prefix: 'x'.repeat(32), suffix: 'y'.repeat(32) });
  const missMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(miss, null);
  t.diagnostic(`256 KB, 500 marks, 2,064-character window: found in ${hitMs.toFixed(1)} ms, a miss in ${missMs.toFixed(1)} ms (budget 50 ms; reported, not gated)`);
});

test('bounds: pathological texts answer within the work and depth budgets, never a stack overflow', (t) => {
  const m = MASK('email');
  const cases = [
    ['runs of one character', ('a'.repeat(300) + m).repeat(500), { exact: `${'a'.repeat(1000)}b${'a'.repeat(1000)}`, prefix: 'a'.repeat(32), suffix: 'a'.repeat(32) }],
    ['2,000 adjacent marks', `${m.repeat(2000)}x`, { exact: 'q'.repeat(2000), prefix: 'r'.repeat(32), suffix: 's'.repeat(32) }],
    ['a two-character period', (`${'ab'.repeat(200)}${m}`).repeat(300), { exact: `${'ab'.repeat(1000)}c`, prefix: 'ab'.repeat(16), suffix: 'ab'.repeat(16) }],
    ['a literal run longer than the window', (`${'a'.repeat(3000)}${m}`).repeat(20), { exact: 'a'.repeat(2000), prefix: 'b'.repeat(32), suffix: 'a'.repeat(32) }],
  ];
  const times = [];
  for (const [name, served, quote] of cases) {
    const t0 = process.hrtime.bigint();
    const got = matchMasked(served, quote);
    times.push(`${name} ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms`);
    assert.ok(got === null || Object.keys(got).sort().join() === ANSWER_KEYS.join(), `${name}: null or an answer`);
  }
  t.diagnostic(times.join('; '));
});
