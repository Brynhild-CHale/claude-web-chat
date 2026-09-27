// The canonical token table, the builtin theme packs, and light/dark as a mode
// inside a theme (lib/server/theme-packs.js + lib/server/theme.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const {
  CANONICAL_TOKENS, BUILTIN_THEMES, TOKEN_RE, normalizeTheme, flattenTheme, mergeTokens, mergeCss, themeModes,
} = require('../lib/server/theme');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const NAMES = CANONICAL_TOKENS.map(t => t.name);
const CORE = CANONICAL_TOKENS.filter(t => t.group === 'core').map(t => t.name);
const tokensIn = (text) => new Set(text.match(/--wc-[\w-]*\w/g) || []);

// One declaration block of public/app.css, comments dropped, whitespace folded.
function cssBlock(selector) {
  const css = read('public/app.css');
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `app.css has a ${selector} block`);
  const body = css.slice(at, css.indexOf('\n}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const m of body.matchAll(/(--wc-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}
const EARTHY_DARK_CSS = cssBlock('/* ===================== Earthy Dark (stock) ===================== */\n:root');
const EARTHY_LIGHT_CSS = { ...EARTHY_DARK_CSS, ...cssBlock(':root[data-theme="light"]') };

test('the canonical table: unique, well-formed names in known groups', () => {
  assert.equal(new Set(NAMES).size, NAMES.length, 'no token is listed twice');
  for (const t of CANONICAL_TOKENS) {
    assert.ok(TOKEN_RE.test(t.name), `${t.name} is a --wc- token`);
    assert.ok(['core', 'text', 'depth', 'elevation', 'chrome'].includes(t.group), `${t.name} has a known group`);
    assert.ok(t.role, `${t.name} says what it paints`);
  }
  for (const n of ['--wc-display', '--wc-reading', '--wc-gold-bg', '--wc-edge', '--wc-scrim', '--wc-panel-92', '--wc-border-soft']) {
    assert.ok(NAMES.includes(n), `${n} (from the design's token sets) is canonical`);
  }
  assert.ok(!NAMES.includes('--wc-r'), "the design's --wc-r maps onto --wc-radius, it is not a fourth radius");
});

test('every pack defines every canonical token — and nothing else — in every mode it declares', () => {
  assert.deepEqual(BUILTIN_THEMES.map(t => t.name), ['earthy', 'paper', 'georgetown-blue']);
  assert.deepEqual(BUILTIN_THEMES.map(t => t.title), ['Earthy', 'Paper', 'Georgetown Blue'], 'each pack has a display name');
  for (const pack of BUILTIN_THEMES) {
    const modes = themeModes(pack);
    assert.ok(modes.length >= 1, `${pack.name} declares a mode`);
    for (const mode of modes) {
      const flat = flattenTheme(normalizeTheme(pack), mode).tokens;
      const missing = NAMES.filter(n => !(n in flat));
      const extra = Object.keys(flat).filter(n => !NAMES.includes(n));
      assert.deepEqual(missing, [], `${pack.name}/${mode} leaves canonical tokens unset`);
      assert.deepEqual(extra, [], `${pack.name}/${mode} sets tokens outside the canonical table`);
      for (const [k, v] of Object.entries(flat)) assert.ok(String(v).length, `${pack.name}/${mode} ${k} is empty`);
    }
  }
  assert.deepEqual(themeModes(BUILTIN_THEMES[0]), ['light', 'dark'], 'Earthy is the light/dark pair');
  assert.deepEqual(themeModes(BUILTIN_THEMES[1]), ['light', 'dark'], 'Paper is a light/dark pair');
  assert.deepEqual(themeModes(BUILTIN_THEMES[2]), ['light', 'dark'], 'Georgetown Blue is a light/dark pair');
});

test("Earthy is public/app.css verbatim, and app.css defines the whole canonical table", () => {
  const earthy = normalizeTheme({ name: 'earthy', builtin: true });
  assert.deepEqual(flattenTheme(earthy, 'dark').tokens, EARTHY_DARK_CSS, "Earthy dark = app.css :root");
  assert.deepEqual(flattenTheme(earthy, 'light').tokens, EARTHY_LIGHT_CSS, 'Earthy light = :root ⊕ [data-theme="light"]');
  assert.deepEqual(Object.keys(EARTHY_DARK_CSS).sort(), [...NAMES].sort(),
    "app.css :root declares exactly the canonical tokens — the stylesheet's fallbacks are a full pack");
});

test('the design facts the packs carry', () => {
  const at = (name) => flattenTheme(normalizeTheme({ name, builtin: true }), 'light');
  const paper = at('paper');
  assert.equal(paper.tokens['--wc-bg'], '#f3eee4');
  assert.equal(paper.tokens['--wc-panel-bg'], '#fbf8f2');
  assert.equal(paper.tokens['--wc-radius'], '4px');
  for (const k of ['--wc-ambient', '--wc-fog', '--wc-vignette']) assert.equal(paper.tokens[k], 'none', `Paper ${k} off`);
  for (const k of ['--wc-grid-line', '--wc-scanline']) assert.equal(paper.tokens[k], 'transparent', `Paper ${k} off`);
  const gt = at('georgetown-blue');
  assert.equal(gt.tokens['--wc-fg-bright'], '#041E42');
  assert.equal(gt.tokens['--wc-topbar-border'], '#041E42');
  assert.equal(gt.tokens['--wc-accent'], '#003DA5');
  assert.equal(gt.tokens['--wc-gold'], '#862633');
  assert.equal(gt.tokens['--wc-gold-bg'], '#F8E08E');
  assert.equal(gt.tokens['--wc-comment'], '#D50032');
  assert.equal(gt.tokens['--wc-edge'], '#BBBCBC');
  assert.equal(gt.tokens['--wc-green'], '#3d7c2b');
  assert.match(gt.tokens['--wc-display'], /^'Libre Caslon Text'/);
  assert.match(gt.tokens['--wc-depth-radial'], /repeating-linear-gradient\(35deg, rgba\(4,30,66,\.155\)/, 'the 3c hatch at 80%');
  assert.equal(gt.tokens['--wc-topbar-rule-width'], '2px', 'the 2px blue topbar rule — a token, not raw CSS');
  assert.equal(paper.tokens['--wc-topbar-rule-width'], '1px', 'every other pack keeps the 1px hairline');
});

// c17: the topbar rule's width is a token, so no builtin needs raw CSS — the
// rule an installable pack is held to (lib/packs/themes.js THEME_CSS_POLICY
// refuses a `css`), and what lets a private Georgetown pack install.
test('no builtin pack carries raw CSS, in any mode; the topbar rule width is a token', () => {
  for (const pack of BUILTIN_THEMES) {
    assert.ok(!pack.css, `${pack.name} carries top-level css`);
    for (const mode of themeModes(pack)) {
      assert.ok(!(pack.modes[mode] && pack.modes[mode].css), `${pack.name}/${mode} carries css`);
      assert.equal(flattenTheme(normalizeTheme(pack), mode).css, '', `${pack.name}/${mode} flattens to no css`);
    }
  }
  const css = read('public/app.css');
  const at = css.indexOf('\n#topbar {\n');
  const topbar = css.slice(at, css.indexOf('\n}', at));
  assert.match(topbar, /border-bottom:\s*var\(--wc-topbar-rule-width\) solid var\(--wc-topbar-border\);/,
    'the chrome draws the rule at the token\'s width');
  assert.equal(EARTHY_DARK_CSS['--wc-topbar-rule-width'], '1px', 'the stylesheet default is the 1px hairline');
});

// s2-2: the dark modes keep each pack's identity (drafts, pending the
// maintainer's review of the screenshots — see s2-holds.md).
test('the dark modes keep each pack\'s identity', () => {
  const at = (name) => flattenTheme(normalizeTheme({ name, builtin: true }), 'dark');
  const paper = at('paper');
  for (const k of ['--wc-ambient', '--wc-fog', '--wc-vignette', '--wc-depth-radial', '--wc-elev-stage', '--wc-well-inset']) {
    assert.equal(paper.tokens[k], 'none', `Paper dark is flat: ${k} off`);
  }
  for (const k of ['--wc-grid-line', '--wc-scanline']) assert.equal(paper.tokens[k], 'transparent', `Paper dark ${k} off`);
  assert.equal(paper.tokens['--wc-radius'], '4px', 'the same sheet, only darker');
  const gt = at('georgetown-blue');
  assert.equal(gt.tokens['--wc-panel-bg'], '#041E42', 'Georgetown Blue itself is the dark panel');
  assert.equal(gt.tokens['--wc-topbar-top'], '#041E42');
  assert.equal(gt.tokens['--wc-gold'], '#F8E08E', 'bookmarks: 1205 ink…');
  assert.equal(gt.tokens['--wc-gold-bg'], '#5b1f2b', '…on a deep burgundy fill');
  assert.match(gt.tokens['--wc-display'], /^'Libre Caslon Text'/, 'Caslon stays');
  assert.match(gt.tokens['--wc-depth-radial'], /repeating-linear-gradient\(35deg, rgba\(143,181,245,\.07\)/, 'the hatch, pale and faint');
  assert.match(gt.tokens['--wc-depth-radial'], /repeating-linear-gradient\(-35deg/);
  assert.equal(gt.tokens['--wc-topbar-rule-width'], '2px', 'the 2px rule in both modes');
});

test('theme format: a flat (pre-mode) theme normalises and flattens unchanged', () => {
  const old = { name: 'violet', tokens: { '--wc-accent': '#7c3aed' }, css: 'x{}' };
  const n = normalizeTheme(old);
  assert.deepEqual(n, old, 'no modes key is invented');
  assert.deepEqual(flattenTheme(n, 'light'), flattenTheme(n, 'dark'), 'a mode-agnostic theme is the same in both modes');
  assert.deepEqual(flattenTheme(n, 'dark').tokens, old.tokens);
});

test('theme format: modes are sanitised like tokens, and only light/dark survive', () => {
  const n = normalizeTheme({ tokens: {}, modes: {
    light: { tokens: { '--wc-bg': '#fff; } body {', color: 'red' }, css: 'a{}' },
    sepia: { tokens: { '--wc-bg': '#f0e0c0' } },
    dark: 'nope',
  } });
  assert.deepEqual(Object.keys(n.modes), ['light']);
  assert.deepEqual(n.modes.light.tokens, { '--wc-bg': '#fff  body' });
  assert.equal(n.modes.light.css, 'a{}');
});

test('the cascade flattens every layer at the GLOBAL layer\'s mode', () => {
  const global = { tokens: {}, modes: { dark: { tokens: { '--wc-bg': 'g-dark' } } } }; // dark-only global
  const node = { tokens: {}, modes: { light: { tokens: { '--wc-fg': 'n-light' } }, dark: { tokens: { '--wc-fg': 'n-dark' } } } };
  assert.deepEqual(mergeTokens(global, node), { '--wc-bg': 'g-dark', '--wc-fg': 'n-dark' },
    "a dark-only global puts the node in dark too, though the server's default mode is light");
  const css = mergeCss({ css: 'a{}', modes: { light: { tokens: {}, css: 'b{}' } } }, { css: 'c{}' });
  assert.equal(css, 'a{}\nb{}\nc{}', 'mode css follows its theme\'s own css, least specific first');
});

test('set_theme / save_theme / get_theme / list_themes carry modes end to end', async (t) => {
  const { api } = await withServer(t);
  const modes = { light: { tokens: { '--wc-bg': '#eeeeee' } }, dark: { tokens: { '--wc-bg': '#111111' }, css: '.d{}' } };
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#123456' }, modes });

  let g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.mode, 'light', 'the server resolves light by default');
  assert.deepEqual(g.modes, ['light', 'dark']);
  assert.deepEqual(g.tokens, { '--wc-accent': '#123456', '--wc-bg': '#eeeeee' });
  g = (await api.get('/api/theme?scope=global&mode=dark')).json;
  assert.deepEqual(g.tokens, { '--wc-accent': '#123456', '--wc-bg': '#111111' });
  assert.equal(g.css, '.d{}');
  assert.equal((await api.get('/api/theme?scope=global&mode=sepia')).status, 400);

  await api.post('/api/themes', { name: 'night', tokens: {}, modes: { dark: { tokens: { '--wc-bg': '#000000' } } } });
  const listed = (await api.get('/api/themes')).json.themes.find(x => x.name === 'night');
  assert.deepEqual(listed.modes, ['dark'], 'the listing names a saved theme\'s modes');
  assert.equal(listed.location, 'local');

  await api.post('/api/theme/apply', { name: 'night', scope: 'global' });
  g = (await api.get('/api/theme?scope=global&mode=light')).json;
  assert.equal(g.mode, 'dark', 'a single-mode theme resolves to its own mode whatever is asked');
  assert.equal(g.tokens['--wc-bg'], '#000000');
});

test('applying a builtin stores a reference: the pack\'s current values win over the stored copy', async (t) => {
  const { root, api } = await withServer(t);
  await api.post('/api/theme/apply', { name: 'Georgetown', scope: 'global' });
  const file = path.join(root, '.web-chat', 'theme.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.builtin, true);
  assert.equal(stored.name, 'georgetown-blue', 'the alias is stored as the id it resolves to');
  stored.modes.light.tokens['--wc-accent'] = '#badbad'; // a stale copy from an older release
  fs.writeFileSync(file, JSON.stringify(stored));
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.tokens['--wc-accent'], '#003DA5');
  assert.equal(g.name, 'georgetown-blue');
  assert.equal(g.title, 'Georgetown Blue');
});

// s2-1: the pack was `georgetown` before it was Georgetown Blue. Everything that
// stored the old id — a project's theme.json, a node's theme, a saved call —
// must keep resolving, and the old id is never listed or saveable.
test('georgetown is an unlisted alias of georgetown-blue: stored references keep resolving', async (t) => {
  const { root, api } = await withServer(t);
  const file = path.join(root, '.web-chat', 'theme.json');
  // a theme.json written by apply_theme before the rename
  fs.writeFileSync(file, JSON.stringify({ name: 'georgetown', builtin: true, tokens: {} }));
  let g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.name, 'georgetown-blue', 'reports as the pack under its new id');
  assert.equal(g.title, 'Georgetown Blue');
  assert.equal(g.tokens['--wc-fg-bright'], '#041E42', "and resolves the pack's tokens");

  // a node theme (or any stored layer) naming the old id: every reader goes
  // through normalizeTheme, which re-reads a builtin reference from the pack
  const nt = normalizeTheme({ name: 'georgetown', builtin: true, tokens: {} });
  assert.equal(nt.name, 'georgetown-blue');
  assert.equal(flattenTheme(nt, 'light').tokens['--wc-accent'], '#003DA5');

  // apply_theme with the old id, any case
  const r = await api.post('/api/theme/apply', { name: 'GEORGETOWN', scope: 'global' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'georgetown-blue');

  // never listed, never saveable
  const { themes } = (await api.get('/api/themes')).json;
  assert.ok(!themes.some((x) => x.name === 'georgetown'), 'the old id is not listed');
  const row = themes.find((x) => x.name === 'georgetown-blue');
  assert.equal(row.title, 'Georgetown Blue', 'list_themes carries the display name');
  for (const name of ['georgetown', 'georgetown-blue']) {
    const save = await api.post('/api/themes', { name, location: 'local', tokens: { '--wc-bg': '#000' } });
    assert.equal(save.status, 400, `saving over '${name}' is refused`);
  }
});

test('a pre-pack theme.json naming the retired builtin reports as earthy and keeps its (empty) tokens', async (t) => {
  const { root, api } = await withServer(t);
  fs.writeFileSync(path.join(root, '.web-chat', 'theme.json'), JSON.stringify({ name: 'web-chat', tokens: {} }));
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.name, 'earthy', 'the Settings picker selects the pack that replaced it');
  assert.deepEqual(g.tokens, {}, 'nothing about the stored theme changed');
  assert.equal(g.modes, undefined, 'a mode-agnostic theme reports no modes');
});

test('an export bakes the light mode of a two-mode pack', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/theme/apply', { name: 'earthy', scope: 'global' });
  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  const r = await api.get('/api/export/live');
  assert.equal(r.status, 200);
  const body = typeof r.json === 'object' && r.json ? JSON.stringify(r.json) : r.text;
  assert.ok(body.includes('#e4dccb'), 'Earthy light --wc-bg is baked');
  assert.ok(!body.includes('#151109'), 'Earthy dark is not');
});

// --- the vocabulary, as the docs and tool descriptions state it ---

test('docs/themes.md lists the whole canonical table, and names only canonical tokens', () => {
  const doc = read('docs/themes.md');
  for (const t of CANONICAL_TOKENS) {
    assert.ok(doc.includes(`| \`${t.name}\` | ${t.group} |`), `docs/themes.md has a row for ${t.name}`);
  }
  for (const n of tokensIn(doc)) {
    if (n === '--wc-r') continue; // the design's name, cited to say what it maps onto
    assert.ok(NAMES.includes(n), `docs/themes.md names ${n}, which is not canonical`);
  }
});

test('the rules file and set_theme spell out the whole core vocabulary, and nothing stale', () => {
  const setTheme = require('../lib/mcp/tools/set_theme');
  const sources = {
    'templates/rules/web-chat.md': read('templates/rules/web-chat.md'),
    '.claude/rules/web-chat.md': read('.claude/rules/web-chat.md'),
    'set_theme description': setTheme.description,
  };
  for (const [where, text] of Object.entries(sources)) {
    const named = tokensIn(text);
    for (const n of CORE) assert.ok(named.has(n), `${where} omits core token ${n}`);
    for (const n of named) assert.ok(NAMES.includes(n), `${where} names ${n}, which is not canonical`);
  }
  for (const rel of ['docs/component-packs.md', 'docs/guide.md', 'lib/mcp/tools/save_theme.js']) {
    for (const n of tokensIn(read(rel))) assert.ok(NAMES.includes(n), `${rel} names ${n}, which is not canonical`);
  }
  assert.ok(setTheme.inputSchema.properties.modes, 'set_theme accepts modes');
  assert.ok(require('../lib/mcp/tools/save_theme').inputSchema.properties.modes, 'save_theme accepts modes');
  assert.deepEqual(require('../lib/mcp/tools/get_theme').inputSchema.properties.mode.enum, ['light', 'dark']);
});

test('the Settings theme hint names the stock pack as listed, never a retired alias', () => {
  const { ALIASES } = require('../lib/server/theme-packs');
  const hint = read('public/index.html').match(/<select id="settings-theme"[\s\S]*?<div class="hint">([\s\S]*?)<\/div>/);
  assert.ok(hint, 'the Settings theme row has a hint');
  const named = [...hint[1].matchAll(/<span class="mono">([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(named, [BUILTIN_THEMES[0].name], 'the hint names the stock pack, earthy');
  for (const alias of Object.keys(ALIASES)) assert.ok(!named.includes(alias), `the hint names retired ${alias}`);
});
