// WCAG AA contrast of every builtin pack, in every mode it declares.
//
// The packs are colour tables; nothing else stops a new dark mode (or a tweak
// to an old one) from putting grey text on a grey panel. Each pair below is a
// real "this ink is painted on that fill" relationship in public/app.css, and
// the ratio is the WCAG 2.x one: (L1 + 0.05) / (L2 + 0.05) over relative
// luminance. TEXT pairs carry running or small text and must reach 4.5; UI
// pairs are labels on fills, glyphs, badges and large text, and must reach 3.
//
// A translucent fill (a hover wash, the active row's color-mix) is composited
// over the surface it sits on before it is measured.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { BUILTIN_THEMES, themeModes, flattenTheme, normalizeTheme } = require('../lib/server/theme');

// [ink, fill, what it is] — fill may be `a over b` for a translucent layer.
const TEXT = [
  ['fg', 'bg', 'body text on the stage'],
  ['fg', 'panel-bg', 'body text in a pane / panel'],
  ['fg', 'header-bg', 'header text'],
  ['fg', 'hover-bg over panel-bg', 'a hovered row'],
  ['fg', 'row-active-bg over panel-bg', 'the active row'],
  ['fg-bright', 'bg', 'headings on the stage'],
  ['fg-bright', 'panel-bg', 'headings in a panel'],
  ['text-1', 'panel-bg', 'primary panel text'],
  ['text-2', 'panel-bg', 'secondary panel text'],
  ['text-3', 'panel-bg', 'tertiary panel text'],
  ['muted', 'panel-bg', 'secondary text in a panel'],
  ['muted', 'bg', 'secondary text on the stage'],
  ['content-fg', 'content-bg', 'text in a content well'],
];
const UI = [
  ['accent-text', 'bg', 'accent labels / links on the stage'],
  ['accent-text', 'panel-bg', 'accent labels in a panel'],
  ['accent', 'panel-bg', 'the active / selection colour'],
  ['accent-fg', 'accent', 'a primary button label'],
  ['content-accent', 'content-bg', 'accent inside a content well'],
  ['muted-dim', 'panel-bg', 'tertiary glyphs'],
  ['muted-dim', 'bg', 'tertiary glyphs and graph labels on the stage'],
  ['gold', 'panel-bg', 'viewing / lock / warning ink'],
  ['gold', 'gold-bg', 'a bookmark label on its fill'],
  ['gold-fg', 'gold', 'a count badge on the gold fill'],
  ['panel-bg', 'gold', 'the update banner button'],
  ['green', 'panel-bg', 'live / success ink'],
  ['green-fg', 'green', 'a commit button label'],
  ['comment', 'panel-bg', 'pins and errors'],
  ['comment', 'bg', 'comment pins on the stage'],
  ['rust', 'panel-bg', 'capture ink'],
  ['key-fg', 'key-bg', 'a keycap'],
];

// There are no exceptions. Earthy light carried four shortfalls from before
// the packs existed (accent labels and keycaps on the stage and panels, muted
// text on the stage), named in a KNOWN_SHORTFALLS list that could only shrink;
// those inks were darkened just past AA and the list is gone, so a new miss in
// ANY pack fails below. The two stage pairs (muted-dim and comment on --wc-bg)
// went unmeasured until the 0.8.0 review, which found Earthy light drawing them
// at 2.85 and 2.99: both inks were darkened a shade, and the tertiary TEXT on
// the stage (the graph legend, the empty log) moved up to --wc-muted.

// --- colour maths --------------------------------------------------------------
function parseColor(v, tokens) {
  const s = String(v).trim();
  let m = s.match(/^var\((--wc-[\w-]+)\)$/);
  if (m) return parseColor(tokens[m[1]], tokens);
  if ((m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  if ((m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  }
  // color-mix(in srgb, <colour> N%, transparent) — a colour at N% alpha
  if ((m = s.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/))) {
    const c = parseColor(m[1], tokens);
    return c && { rgb: c.rgb, a: c.a * (+m[2] / 100) };
  }
  if (s === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  return null;
}
const over = (top, under) => ({
  rgb: top.rgb.map((c, i) => c * top.a + under.rgb[i] * (1 - top.a)), a: 1,
});
function fill(spec, tokens) {
  const [top, , under] = spec.split(' ');
  const c = parseColor(tokens[`--wc-${top}`], tokens);
  if (!c) return null;
  return under ? over(c, fill(under, tokens)) : c;
}
const lum = ({ rgb }) => rgb
  .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every pack × mode × pair, measured once.
const MEASURED = [];
for (const pack of BUILTIN_THEMES) {
  for (const mode of themeModes(pack)) {
    const tokens = flattenTheme(normalizeTheme(pack), mode).tokens;
    for (const [pairs, min] of [[TEXT, 4.5], [UI, 3]]) {
      for (const [ink, fillSpec, what] of pairs) {
        const i = parseColor(tokens[`--wc-${ink}`], tokens);
        const f = fill(fillSpec, tokens);
        const key = `${pack.name}/${mode} ${ink} on ${fillSpec.split(' ')[0]}`;
        MEASURED.push({ key, what, min, i, f, r: i && f ? ratio(over(i, f), f) : null });
      }
    }
  }
}

test('the contrast maths matches WCAG', () => {
  const c = (s) => parseColor(s, {});
  assert.equal(ratio(c('#000000'), c('#ffffff')).toFixed(2), '21.00');
  assert.equal(ratio(c('#777777'), c('#ffffff')).toFixed(2), '4.48', 'the classic just-misses-AA grey');
  assert.equal(ratio(c('#ffffff'), c('#ffffff')).toFixed(2), '1.00');
  const half = over(c('rgba(0,0,0,.5)'), c('#ffffff'));
  assert.deepEqual(half.rgb, [127.5, 127.5, 127.5], 'a translucent fill composites over its surface');
  assert.deepEqual(parseColor('color-mix(in srgb, var(--wc-a) 16%, transparent)', { '--wc-a': '#5f7d33' }),
    { rgb: [95, 125, 51], a: 0.16 });
});

test('every pair is measurable: the pack colours are ones the test can read', () => {
  const blind = MEASURED.filter((m) => m.r === null).map((m) => m.key);
  assert.deepEqual(blind, [], 'a pair whose colour this test cannot parse is a pair nobody is checking');
  assert.ok(BUILTIN_THEMES.every((p) => themeModes(p).length), 'every pack is measured in at least one mode');
});

test('every pack × mode reaches WCAG AA: 4.5 for text, 3 for UI and large text', () => {
  const fails = MEASURED
    .filter((m) => m.r !== null && m.r < m.min)
    .map((m) => `${m.key} (${m.what}) = ${m.r.toFixed(2)} < ${m.min}`);
  assert.deepEqual(fails, []);
});

test('the tertiary TEXT on the stage reads in --wc-muted, the ink the TEXT group measures on bg', () => {
  // muted-dim on bg is held to the 3:1 line (glyphs, graph labels); running
  // text on the stage ground must reach 4.5, so it may not be painted in it.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/app.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.gv-legend', '.gv-log-empty']) {
    const m = new RegExp(`(?:^|\\})\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `app.css has a ${sel} rule`);
    assert.match(m[1], /(?:^|;)\s*color:\s*var\(--wc-muted\)/, `${sel} text is --wc-muted`);
  }
});

test('Paper and Georgetown Blue both have a dark mode, so ◑ works under them', () => {
  for (const name of ['paper', 'georgetown-blue']) {
    const pack = BUILTIN_THEMES.find((p) => p.name === name);
    assert.deepEqual(themeModes(pack), ['light', 'dark'], `${name} is a light/dark pair`);
  }
});
