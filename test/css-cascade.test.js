// test-support/css-cascade.js — the one app.css cascade engine the chrome tests
// read the stylesheet through (U111). Its branches are pinned here directly,
// because the chrome tests that use it never reach two of them (!important
// against a more specific rule, and an attribute selector's weight), so a
// break in either would leave every one of them green.
//
// The tripwire at the bottom holds it at one copy: no file under test/ or
// test-support/ but the helper defines its own specificity or parseRules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const {
  stripComments, parseRules, selectors, specificity, bySpec, beats, createCascade,
} = require('../test-support/css-cascade');

const REPO = path.resolve(__dirname, '..');
const HELPER = path.join(REPO, 'test-support', 'css-cascade.js');

// A jsdom window `width` wide whose matchMedia answers (min-width) and
// (max-width) conditions joined by `and`, counting the lists it hands out.
function windowOf(width, body = '<div id="host" class="host"><p id="x" class="y z" data-k="1">text</p></div>') {
  const { window } = new JSDOM(`<!doctype html><html><body>${body}</body></html>`);
  window.made = 0;
  window.matchMedia = (media) => {
    window.made += 1;
    const matches = String(media).split(/\s+and\s+/).every((c) => {
      const m = /\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)/.exec(c);
      if (!m) return false;
      return m[1] === 'min' ? width >= Number(m[2]) : width <= Number(m[2]);
    });
    return { media, matches };
  };
  return window;
}

test('parseRules keeps source offsets and nests @media; comments keep their offsets; other at-rules are skipped', () => {
  const css = [
    '/* a comment { with a brace } */',
    '.a { color: red; margin: 0 }',
    '@media (max-width: 600px) {',
    '  /* inside */ .b, #c { color: blue }',
    '}',
    '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }',
    '#d:hover { color: green !important; }',
  ].join('\n');
  const bare = stripComments(css);
  assert.equal(bare.length, css.length, 'blanking a comment keeps every offset');
  assert.equal(bare.split('\n').length, css.split('\n').length, 'and every newline');
  assert.doesNotMatch(bare, /comment|inside/);

  const rules = parseRules(bare);
  assert.deepEqual(rules.map((r) => r.selector), ['.a', '.b, #c', '#d:hover'], '@keyframes and its frames are not style rules');
  for (const r of rules) assert.ok(css.slice(r.at).startsWith(r.selector), `${r.selector}: its offset is its place in the source`);
  assert.deepEqual(rules.map((r) => r.media), [null, '(max-width: 600px)', null]);
  assert.deepEqual(rules[0].decls, [['color', 'red'], ['margin', '0']]);
  assert.deepEqual(rules[2].decls, [['color', 'green !important']], 'the raw value keeps its !important for the cascade to read');
  assert.deepEqual(selectors('.a, :is(.b, .c) d, [x=","]'), ['.a', ':is(.b, .c) d', '[x=","]'], 'a list splits at top-level commas only');
  assert.deepEqual(createCascade(css, { win: () => null }).rules, rules, 'createCascade parses the same rules');
});

test('specificity: ids, classes, elements; :is()/:not() take their most specific argument, :where() counts zero, ::before is an element', () => {
  assert.deepEqual(specificity('#a .b c'), [1, 1, 1]);
  assert.deepEqual(specificity('a:hover'), [0, 1, 1], 'a pseudo-class counts as a class');
  assert.deepEqual(specificity(':is(#a, .b) c'), [1, 0, 1]);
  assert.deepEqual(specificity('.x:not(.y, #z)'), [1, 1, 0]);
  assert.deepEqual(specificity(':where(#a .b) c'), [0, 0, 1]);
  assert.deepEqual(specificity('p::before'), [0, 0, 2]);
  assert.deepEqual(specificity('#chat-pull.kb .ct-bar'), [1, 2, 0], 'a hyphenated name is one word');
  assert.ok(bySpec([1, 0, 0], [0, 9, 9]) > 0, 'one id outweighs any number of classes');
  assert.equal(bySpec([0, 1, 2], [0, 1, 2]), 0);
});

test('an attribute selector counts as a class', () => {
  assert.deepEqual(specificity('[data-k]'), [0, 1, 0]);
  assert.deepEqual(specificity('p[data-k="1"].y'), [0, 2, 1]);
  const W = windowOf(1280);
  const css = createCascade('[data-k] { color: red }\np { color: blue }', { win: W });
  assert.equal(css.value(W.document.getElementById('x'), 'color'), 'red', '[data-k] outweighs the later p');
});

test('!important beats specificity; between two !important declarations, specificity decides', () => {
  const W = windowOf(1280);
  const p = W.document.getElementById('x');
  const css = createCascade('.y { color: blue !important }\n#x.y { color: red }', { win: W });
  const d = css.cascade(p, 'color');
  assert.equal(d.value, 'blue', 'the value without its !important');
  assert.equal(d.important, true);
  assert.equal(beats({ important: true, spec: [0, 0, 0], at: 0, pos: 0 }, { important: false, spec: [9, 9, 9], at: 9, pos: 9 }), true);
  assert.equal(beats({ important: false, spec: [9, 9, 9], at: 9, pos: 9 }, { important: true, spec: [0, 0, 0], at: 0, pos: 0 }), false);
  const both = createCascade('#x { color: red !important }\n.y { color: blue !important }', { win: W });
  assert.equal(both.value(p, 'color'), 'red', 'between two !important declarations, specificity decides');
});

test('equal specificity falls to source order, then declaration order; several properties at once', () => {
  const W = windowOf(1280);
  const p = W.document.getElementById('x');
  const css = createCascade('.y { color: red; left: 1px }\n.z { color: blue; color: green }\np.y { top: 0 }', { win: W });
  assert.equal(css.value(p, 'color'), 'green', 'the later rule, and within it the later declaration');
  assert.equal(css.value(p, 'right'), null, 'nothing declares it');
  const d = css.cascade(p, ['left', 'color']);
  assert.equal(d.prop, 'color', 'among several properties, the winning declaration names its own');
  assert.equal(d.value, 'green');
  assert.equal(css.cascade(p, ['left']).value, '1px');
  const first = createCascade('.y { color: red; color: blue }\n.z { color: green }', { win: W });
  assert.equal(first.cascade(p, 'color').pos, 0, 'the later rule\'s declaration, at its own position');
  assert.equal(first.value(p, 'color'), 'green');
  // A selector jsdom cannot parse matches nothing instead of throwing.
  assert.equal(createCascade('p:unknown-thing(( { color: red }\n.y { color: blue }', { win: W }).value(p, 'color'), 'blue');
});

test('inherited walks up to the nearest ancestor that declares the property', () => {
  const W = windowOf(1280);
  const css = createCascade('.host { --pulse: 1.2s }\n#x { --other: 1 }', { win: W });
  const p = W.document.getElementById('x');
  assert.equal(css.inherited(p, '--pulse'), '1.2s');
  assert.equal(css.value(p, '--pulse'), null, 'value() reads the element alone');
  assert.equal(css.inherited(p, '--absent'), null);
});

test('a rule under a media query that does not hold is skipped, and the cache is per window', () => {
  const STYLES = '.y { display: block }\n@media (max-width: 600px) { .y { display: none } }\n@media (min-width: 400px) and (max-width: 900px) { #x { order: 2 } }';
  const phone = windowOf(390);
  const desktop = windowOf(1280);
  let current = phone;
  const css = createCascade(STYLES, { win: () => current });
  const at = (W) => W.document.getElementById('x');

  assert.equal(css.value(at(phone), 'display'), 'none', 'at 390 the narrow rule holds');
  assert.equal(css.value(at(phone), 'order'), null, '390 is below the band');
  current = desktop;
  assert.equal(css.value(at(desktop), 'display'), 'block', 'the window current at the call answers, not the first one asked');
  current = phone;
  assert.equal(css.value(at(phone), 'display'), 'none', 'and back');
  assert.equal(phone.made, 2, 'one list per query per window, reused');
  assert.equal(desktop.made, 2);

  // A list's `matches` is read on every call: a viewport flip the window
  // reports through the same list is seen.
  const flips = windowOf(390);
  const lists = [];
  const ask = flips.matchMedia;
  flips.matchMedia = (m) => { const l = ask(m); lists.push(l); return l; };
  const live = createCascade(STYLES, { win: flips });
  assert.equal(live.value(at(flips), 'display'), 'none', 'a Window passed as itself');
  for (const l of lists) l.matches = !l.matches;
  assert.equal(live.value(at(flips), 'display'), 'block');
  assert.equal(lists.length, 2, 'no list is asked for twice');

  assert.throws(() => createCascade(STYLES, { win: () => null }).value(at(phone), 'display'), /no window/,
    'a media query with no window to ask is an error, not a silent miss');
});

// ── the tripwire: one copy ───────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('tripwire: no test file but test-support/css-cascade.js defines its own specificity or parseRules', () => {
  const DEFINES = /(?:\bfunction\s+(specificity|parseRules)\s*\(|\b(?:const|let|var)\s+(specificity|parseRules)\s*=)/g;
  const copies = [];
  for (const f of [...walk(path.join(REPO, 'test')), ...walk(path.join(REPO, 'test-support'))]) {
    if (path.resolve(f) === HELPER) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(DEFINES)) {
      const line = src.slice(0, m.index).split('\n').length;
      copies.push(`${path.relative(REPO, f).split(path.sep).join('/')}:${line} (${m[1] || m[2]})`);
    }
  }
  assert.deepEqual(copies, [],
    `a private copy of the app.css cascade engine: ${copies.join(', ')}. Read the stylesheet through test-support/css-cascade.js — \`createCascade(CSS, { win: () => W })\` gives value/cascade/inherited — and fix the engine there, once.`);
  assert.match(fs.readFileSync(HELPER, 'utf8'), /\nfunction specificity\(/, 'the helper is still the home');
});
