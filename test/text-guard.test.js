// The text guard: lib/core/text.js, the one control, bidi and invisible-
// character filter (spec §9.2). Every character of every forbidden range is
// found by hasForbidden and removed by stripControls; nothing outside the
// ranges is touched; keepNewlines keeps exactly `\n` and `\t`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const text = require('../lib/core/text');
const { CONTROL_RE, BIDI_RE, INVISIBLE_RE, stripControls, hasForbidden } = text;

// The ranges as the spec lists them, written out independently of the module.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const SETS = {
  control: [...range(0x00, 0x1f), 0x7f, ...range(0x80, 0x9f), 0x2028, 0x2029],
  bidi: [0x061c, 0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069)],
  invisible: [0x200b, 0xfeff],
};
const FORBIDDEN = new Set([...SETS.control, ...SETS.bidi, ...SETS.invisible]);
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

test('every forbidden code point is found, alone and inside other text', () => {
  for (const [set, cps] of Object.entries(SETS)) {
    for (const cp of cps) {
      const c = String.fromCodePoint(cp);
      assert.equal(hasForbidden(c), true, `${set} ${hex(cp)} alone`);
      assert.equal(hasForbidden(`Acme ${c} Web`), true, `${set} ${hex(cp)} inside text`);
      assert.equal(hasForbidden(`${c}Acme`), true, `${set} ${hex(cp)} leading`);
      assert.equal(hasForbidden(`Acme${c}`), true, `${set} ${hex(cp)} trailing`);
    }
  }
});

test('every forbidden code point is removed, and only it', () => {
  for (const cp of FORBIDDEN) {
    const c = String.fromCodePoint(cp);
    assert.equal(stripControls(`a${c}b${c}${c}c`), 'abc', hex(cp));
    assert.equal(hasForbidden(stripControls(`a${c}b`)), false, `${hex(cp)}: nothing forbidden is left`);
  }
});

test('the whole Basic Multilingual Plane: forbidden exactly where the spec says, nowhere else', () => {
  let all = '';
  let kept = '';
  let keptLines = '';
  for (let u = 0; u <= 0xffff; u++) {
    const c = String.fromCharCode(u);
    assert.equal(hasForbidden(c), FORBIDDEN.has(u), `${hex(u)}`);
    all += c;
    if (!FORBIDDEN.has(u)) kept += c;
    if (!FORBIDDEN.has(u) || c === '\n' || c === '\t') keptLines += c;
  }
  assert.equal(stripControls(all), kept, 'stripControls removes exactly the forbidden code units');
  assert.equal(stripControls(all, { keepNewlines: true }), keptLines, 'and with keepNewlines, exactly those but \\n and \\t');
});

test('each expression matches its own set and no other', () => {
  for (const [set, re] of [['control', CONTROL_RE], ['bidi', BIDI_RE], ['invisible', INVISIBLE_RE]]) {
    for (const [other, cps] of Object.entries(SETS)) {
      for (const cp of cps) {
        assert.equal(re.test(String.fromCodePoint(cp)), set === other, `${set} expression on ${other} ${hex(cp)}`);
      }
    }
  }
});

test('the neighbours of every range, and what emoji and scripts need, are left alone', () => {
  const allowed = [
    0x20, 0x7e, 0xa0, 0xad, // space, tilde, no-break space, soft hyphen
    0x061b, 0x061d, // around the Arabic letter mark
    0x200a, 0x200c, 0x200d, // hair space, ZWNJ, ZWJ (emoji sequences)
    0x2027, 0x202f, 0x2065, 0x206a, // around the separators and the isolates
    0xfe0e, 0xfe0f, 0xfefe, 0xff00, // variation selectors, around the BOM
    0x1f600, 0xe0100, 0xe0067, 0xe007f, // an emoji, a supplementary variation selector, tag characters
  ];
  for (const cp of allowed) {
    const s = `a${String.fromCodePoint(cp)}b`;
    assert.equal(hasForbidden(s), false, hex(cp));
    assert.equal(stripControls(s), s, hex(cp));
  }
  for (const s of [
    '\u{1F469}\u200D\u{1F4BB}', // a ZWJ sequence
    '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', // a family
    '\u2764\uFE0F', // a heart with VS16
    '\u{1F1EF}\u{1F1F5}', // a flag: regional indicators
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', // a tag sequence
    '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', // a ZWNJ in Persian
    '\u05E2\u05D1\u05E8\u05D9\u05EA and \u0627\u0644\u0639\u0631\u0628\u064A\u0629', // RTL scripts need no control characters
    'Caf\u00E9', 'Cafe\u0301', // both normalization forms
  ]) {
    assert.equal(hasForbidden(s), false, s);
    assert.equal(stripControls(s), s, s);
  }
});

test('keepNewlines keeps a newline and a tab, and nothing else of the sets', () => {
  const s = 'one\ntwo\tthree\r\nfour\vfive\fsix\u2028seven\u2029eight\u0085nine\u202eten\u200b\ufeff';
  assert.equal(stripControls(s, { keepNewlines: true }), 'one\ntwo\tthree\nfourfivesixseveneightnineten');
  assert.equal(stripControls(s), 'onetwothreefourfivesixseveneightnineten');
  assert.equal(stripControls('\n\t\n', { keepNewlines: true }), '\n\t\n');
  assert.equal(stripControls('\n\t\n'), '');
  assert.equal(stripControls('a\rb', { keepNewlines: true }), 'ab', 'a carriage return is not a kept line break');
});

test('the expressions are not global, so repeated tests are stateless', () => {
  for (const re of [CONTROL_RE, BIDI_RE, INVISIBLE_RE]) {
    assert.equal(re.global, false);
    assert.equal(re.sticky, false);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(hasForbidden('x\u202ey'), true, `call ${i}`);
    assert.equal(BIDI_RE.test('x\u202ey'), true, `call ${i}`);
  }
  assert.equal(BIDI_RE.lastIndex, 0);
  // and stripping twice gives the same answer as stripping once
  const s = '\u0000a\u202eb\u200bc';
  assert.equal(stripControls(stripControls(s)), stripControls(s));
});

test('a value that is not a string: stripControls gives empty text, hasForbidden false', () => {
  for (const v of [undefined, null, 42, true, {}, ['\u202e'], Buffer.from('\u0000')]) {
    assert.equal(stripControls(v), '', String(v));
    assert.equal(stripControls(v, { keepNewlines: true }), '', String(v));
    assert.equal(hasForbidden(v), false, String(v));
  }
  assert.equal(stripControls(''), '');
  assert.equal(hasForbidden(''), false);
});

test('the module is pure: it requires nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'text.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.deepEqual(Object.keys(text).sort(), ['BIDI_RE', 'CONTROL_RE', 'INVISIBLE_RE', 'hasForbidden', 'stripControls']);
});
