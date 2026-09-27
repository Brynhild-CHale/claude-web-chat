// Theme packs through the pack pipeline (lib/packs/themes.js, plan, tree,
// install) and the active theme's logos filling empty brand slots
// (lib/server/brand.js fillSource).
//
// A pack may ship `themes/<name>/theme.json` plus `logos/` and `fonts/` beside
// it. It installs through the SAME source → fetch → manifest → plan → tree →
// install transaction as a component pack, into the theme library of its tier,
// with provenance — so list / verify / remove cover it. What it may not carry
// is raw CSS (THEME_CSS_POLICY), a builtin theme name, an active or mis-named
// logo, or a font that is neither bundled nor a licensed WOFF2.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packs = require('../lib/packs/install');
const { validateManifest, parseManifest } = require('../lib/packs/manifest');
const { THEME_CSS_POLICY, inspectPackTheme } = require('../lib/packs/themes');
const { listPacks } = require('../lib/packs/store');
const brand = require('../lib/server/brand');
const { PACKS, ALIASES } = require('../lib/server/theme-packs');
const { BUILTIN_THEME_NAMES, isBuiltinThemeName } = require('../lib/core/names');
const { classify } = require('../lib/core/remote-policy');
const { REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../lib/core/cors');
const { projectPaths, userPaths, PUBLIC_DIR } = require('../lib/core/paths');
const { tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome, withServer } = require('../test-support/helpers');

const SHA = 'b'.repeat(40);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const WOFF2 = fs.readFileSync(path.join(PUBLIC_DIR, 'fonts', 'GeistMono-Variable.woff2'));
const OFL = fs.readFileSync(path.join(PUBLIC_DIR, 'fonts', 'Geist-OFL.txt'));

const THEME = {
  tokens: { '--wc-font': "'Harbor Sans', sans-serif" },
  modes: {
    light: { tokens: { '--wc-bg': '#f4f1ea', '--wc-panel-bg': '#ffffff', '--wc-fg': '#1d2a3a', '--wc-accent': '#0b5cad', '--wc-green': '#2f7d4f', '--wc-gold': '#b8860b' } },
    dark: { tokens: { '--wc-bg': '#0e1622', '--wc-panel-bg': '#152033', '--wc-fg': '#e8eef6', '--wc-accent': '#5aa2f0', '--wc-green': '#5fbf85', '--wc-gold': '#e0b64a' } },
  },
  fonts: ['Geist Mono', { family: 'Harbor Sans', file: 'HarborSans.woff2', weight: '100 900' }],
};

// A theme pack repository. `themes` maps a name to { theme, logos, fonts, extra }.
function themePack({ name = 'harbor-themes', themes = { harbor: {} }, components = null, skill = false, manifest = null } = {}) {
  const dir = tmpDir();
  write(path.join(dir, 'web-chat-pack.json'), JSON.stringify(manifest || {
    name, version: '1.0.0', description: 'Harbor — a navy-and-sand theme.',
    ...(components ? { components } : {}),
    themes: Object.keys(themes),
  }, null, 2));
  for (const [th, spec] of Object.entries(themes)) {
    const tdir = path.join(dir, 'themes', th);
    write(path.join(tdir, 'theme.json'), JSON.stringify(spec.theme || THEME, null, 2));
    const logos = spec.logos || { 'logotype.svg': svg('#0b5cad'), 'logotype-reversed.svg': svg('#ffffff'), 'seal.png': PNG };
    for (const [f, bytes] of Object.entries(logos)) write(path.join(tdir, 'logos', f), bytes);
    const fonts = spec.fonts === undefined ? { 'HarborSans.woff2': WOFF2, 'OFL.txt': OFL } : spec.fonts;
    for (const [f, bytes] of Object.entries(fonts || {})) write(path.join(tdir, 'fonts', f), bytes);
    for (const [f, bytes] of Object.entries(spec.extra || {})) write(path.join(tdir, f), bytes);
  }
  if (skill) write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A theme.\n---\n`);
  return dir;
}

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

async function forgeFor(t, dir) {
  return fakeForge(t, { repos: { 'acme/harbor': repoWithArchive(dir, { sha: SHA }) } });
}

const planErrors = (dir, name = 'harbor') => inspectPackTheme(dir, name).errors.join('\n');

// ── the reserved names ──────────────────────────────────────────────────────

test('the builtin theme names in core are exactly the packs plus their aliases', () => {
  const expected = [...PACKS.map((p) => p.name), ...Object.keys(ALIASES)].sort();
  assert.deepEqual([...BUILTIN_THEME_NAMES].sort(), expected);
  assert.equal(isBuiltinThemeName('Paper'), true, 'case-insensitive, like the library');
  assert.equal(isBuiltinThemeName('harbor'), false);
});

test('a builtin theme name is refused, every one of them, with no override', async (t) => {
  const root = project(t);
  for (const name of BUILTIN_THEME_NAMES) {
    const dir = themePack({ themes: { [name]: {} } });
    const v = validateManifest(parseManifest(dir), { stageDir: dir });
    assert.equal(v.ok, false, `${name} refused by the manifest`);
    assert.match(v.errors.join('\n'), /built-in theme name/);
  }
  // …and through the whole install, with replace:true (the terminal's override) too
  const forge = await forgeFor(t, themePack({ themes: { 'georgetown-blue': {} } }));
  await assert.rejects(
    packs.installPack({ url: forge.url('acme', 'harbor'), root, replace: true }),
    /built-in theme name/,
  );
  assert.equal(fs.existsSync(path.join(projectPaths(root).themesDir, 'georgetown-blue.json')), false);
});

// ── the manifest: a themes-only pack ────────────────────────────────────────

test('a themes-only pack needs no components and no skill, and is not warned about the skill', () => {
  const dir = themePack();
  const v = validateManifest(parseManifest(dir), { stageDir: dir });
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(v.themes.map((x) => x.name), ['harbor']);
  assert.equal(v.warnings.some((w) => /SKILL\.md|lists no components/.test(w)), false, v.warnings.join('\n'));
  // A pack that lists neither is still not a pack.
  const none = themePack({ manifest: { name: 'empty-pack', version: '1.0.0' } });
  assert.equal(validateManifest(parseManifest(none), { stageDir: none }).ok, false);
});

// ── install → list → apply → logos fill → remove ────────────────────────────

test('a theme pack installs its theme, logos and fonts into the project library, with provenance', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack({ themes: { harbor: { extra: { 'README.md': '# notes' } } } }));
  const out = await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  assert.equal(out.ok, true);

  const lib = projectPaths(root).themesDir;
  assert.ok(fs.existsSync(path.join(lib, 'harbor.json')), 'the theme lands in the library, where apply finds it');
  for (const f of ['logos/logotype.svg', 'logos/logotype-reversed.svg', 'logos/seal.png', 'fonts/HarborSans.woff2', 'fonts/OFL.txt']) {
    assert.ok(fs.existsSync(path.join(lib, 'harbor', f)), `${f} lands beside it`);
  }
  assert.equal(fs.existsSync(path.join(lib, 'harbor', 'README.md')), false, 'an unclaimed file is not installed');
  assert.ok(out.warnings.some((w) => /README\.md is not installed/.test(w)), 'and the warning says so');

  const [rec] = listPacks(root);
  assert.deepEqual(rec.themes, ['harbor']);
  assert.equal(rec.units.length, 1);
  assert.equal(rec.units[0].kind, 'theme');
  const listed = packs.listInstalled({ root, verify: true });
  assert.deepEqual(listed.packs[0].themes, ['harbor']);
  assert.equal(listed.packs[0].drift, false, 'every installed file verifies');
});

test('an installed theme applied globally fills EMPTY brand slots with its logos; the project upload still wins', async (t) => {
  withTempHome(t);
  await withServer(t, async ({ root, baseUrl }) => {
    const forge = await forgeFor(t, themePack());
    await packs.installPack({ url: forge.url('acme', 'harbor'), root });

    const listed = await (await fetch(`${baseUrl}/api/themes`)).json();
    assert.ok(listed.themes.some((x) => x.name === 'harbor' && x.location === 'local'), 'it lists like a saved theme');
    assert.equal(listed.themes.some((x) => x.name === 'logos' || x.name === 'harbor/logos'), false, 'its folder is not a theme');

    const applied = await (await fetch(`${baseUrl}/api/theme/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'harbor', scope: 'global' }),
    })).json();
    assert.equal(applied.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(projectPaths(root).theme, 'utf8')).name, 'harbor',
      'a theme.json with no "name" is stored under its library name');

    assert.deepEqual(brand.fillSource(root), { name: 'harbor', dir: projectPaths(root).themeLogosDir('harbor') });
    const f = brand.fills(root);
    assert.equal(f.logotype.light.type, 'image/svg+xml');
    assert.equal(brand.effective(root, 'logotype', { mode: 'dark' }).bytes.toString(), svg('#ffffff'), 'dark uses the reversed mark');
    assert.equal(brand.effective(root, 'seal').type, 'image/png');
    assert.equal(f.lockup, null, 'a slot the theme has no logo for stays empty');
    const api = await (await fetch(`${baseUrl}/api/brand`)).json();
    assert.ok(api.fill && api.fill.logotype, 'the chrome is told');

    brand.write(root, 'logotype', PNG);
    assert.equal(brand.effective(root, 'logotype').type, 'image/png', 'the project\'s own image wins');
    assert.equal(brand.fills(root).logotype, null);
  });
});

test('no fill when the installed theme is not the global one, or its logos dir is a symlink out of .web-chat', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  assert.equal(brand.fillSource(root), null, 'installed but not applied: nothing fills');

  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  assert.ok(brand.fillSource(root), 'applied: it fills');

  const outside = tmpDir('wc-outside-');
  write(path.join(outside, 'logotype.svg'), svg('#ff0000'));
  const logos = projectPaths(root).themeLogosDir('harbor');
  fs.rmSync(logos, { recursive: true });
  fs.symlinkSync(outside, logos);
  assert.equal(brand.fillSource(root), null, 'a committed symlink cannot aim the fill elsewhere');
  assert.equal(brand.effective(root, 'logotype'), null);
});

test('a --global theme pack lands in ~/.web-chat/themes and fills from there', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  const out = await packs.installPack({ url: forge.url('acme', 'harbor'), root, tier: 'system' });
  assert.equal(out.tier, 'system');
  assert.ok(fs.existsSync(path.join(userPaths().themesDir, 'harbor.json')));
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  assert.deepEqual(brand.fillSource(root), { name: 'harbor', dir: userPaths().themeLogosDir('harbor') });
  assert.ok(brand.effective(root, 'logotype'));
});

test('removing a theme pack removes its theme, logos and fonts and their folders — never the shared themes dir', async (t) => {
  const root = project(t);
  const lib = projectPaths(root).themesDir;
  write(path.join(lib, 'mine.json'), '{"tokens":{}}');
  const forge = await forgeFor(t, themePack());
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));

  const out = packs.removePackByName({ name: 'harbor-themes', root });
  assert.equal(out.removedAll, true);
  assert.equal(fs.existsSync(path.join(lib, 'harbor.json')), false);
  assert.equal(fs.existsSync(path.join(lib, 'harbor')), false, 'the emptied <name>/ folder goes too');
  assert.ok(fs.existsSync(path.join(lib, 'mine.json')), 'my own theme is not collateral');
  assert.equal(listPacks(root).length, 0);
  assert.equal(brand.fillSource(root), null, 'nothing left to fill from');
});

test('a file the user added beside the logos keeps its folder on remove', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  const logos = projectPaths(root).themeLogosDir('harbor');
  write(path.join(logos, 'notes.txt'), 'mine');
  packs.removePackByName({ name: 'harbor-themes', root });
  assert.ok(fs.existsSync(path.join(logos, 'notes.txt')));
  assert.equal(fs.existsSync(path.join(logos, 'logotype.svg')), false);
});

// ── review (quarantine) ─────────────────────────────────────────────────────

test('quarantine stages a theme pack for review with its palette, logos and fonts; approve installs it', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  const q = await packs.quarantinePack({ url: forge.url('acme', 'harbor'), root });
  const [th] = q.record.themes;
  assert.equal(th.name, 'harbor');
  assert.deepEqual(th.modes, ['light', 'dark']);
  assert.deepEqual(th.palette.light, { bg: '#f4f1ea', panel: '#ffffff', fg: '#1d2a3a', accent: '#0b5cad', green: '#2f7d4f', gold: '#b8860b' });
  assert.equal(th.palette.dark.accent, '#5aa2f0');
  assert.deepEqual(th.logos.sort(), ['logotype', 'logotype-reversed', 'seal']);
  assert.deepEqual(th.fonts.map((f) => f.family), ['Geist Mono', 'Harbor Sans']);
  assert.equal(th.css, false);
  assert.deepEqual(q.record.errors, []);
  assert.equal(fs.existsSync(path.join(projectPaths(root).themesDir, 'harbor.json')), false, 'review installs nothing');

  const listed = packs.listInstalled({ root });
  assert.equal(listed.quarantined[0].themes[0].name, 'harbor', 'the drawer reads themes off the listing');

  const out = packs.approvePack({ name: 'harbor-themes', root });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(projectPaths(root).themesDir, 'harbor', 'logos', 'seal.png')));
});

// ── refusals ────────────────────────────────────────────────────────────────

test('raw CSS in an installed theme is refused at plan time — top-level and per mode — and shown in review', async (t) => {
  assert.equal(THEME_CSS_POLICY, 'refuse', 'the conservative default is in force');
  const top = themePack({ themes: { harbor: { theme: { ...THEME, css: 'body{background:red}' } } } });
  assert.match(planErrors(top), /carries raw CSS \(css\)/);
  const mode = themePack({ themes: { harbor: { theme: { ...THEME, modes: { ...THEME.modes, dark: { ...THEME.modes.dark, css: '.x{}' } } } } } });
  assert.match(planErrors(mode), /carries raw CSS \(modes\.dark\.css\)/);
  const blank = themePack({ themes: { harbor: { theme: { ...THEME, css: '   ' } } } });
  assert.equal(planErrors(blank), '', 'an empty css string is not CSS');

  const root = project(t);
  const forge = await forgeFor(t, top);
  const q = await packs.quarantinePack({ url: forge.url('acme', 'harbor'), root });
  assert.ok(q.record.errors.some((e) => /raw CSS/.test(e)), 'the review card shows the refusal');
  assert.equal(q.record.themes[0].css, true);
  assert.throws(() => packs.approvePack({ name: 'harbor-themes', root }), /raw CSS/);
  assert.equal(fs.existsSync(path.join(projectPaths(root).themesDir, 'harbor.json')), false);
});

test('a bad logo fails the plan: active SVG, wrong format for its name, too large', () => {
  const script = themePack({ themes: { harbor: { logos: { 'logotype.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' } } } });
  assert.match(planErrors(script), /logo logos\/logotype\.svg refused: SVG refused: it contains a <script> element/);
  const lying = themePack({ themes: { harbor: { logos: { 'seal.png': svg('#000') } } } });
  assert.match(planErrors(lying), /logo logos\/seal\.png refused: it is not a PNG/);
  const huge = themePack({ themes: { harbor: { logos: { 'lockup.svg': svg('#000') + ' '.repeat(brand.MAX_BYTES) } } } });
  assert.match(planErrors(huge), /logo logos\/lockup\.svg refused: image is \d+ bytes/);
  // A file whose NAME is not a slot is not refused — it is just not installed.
  const odd = themePack({ themes: { harbor: { logos: { 'banner.svg': svg('#000') } } } });
  const r = inspectPackTheme(odd, 'harbor');
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /logos\/banner\.svg is not installed/.test(w)));
  assert.equal(r.files.some((f) => /banner/.test(f.path)), false);
});

test('fonts: a bundled family or a licensed WOFF2 only', () => {
  const unknown = themePack({ themes: { harbor: { theme: { ...THEME, fonts: ['Comic Sans MS'] }, fonts: null } } });
  assert.match(planErrors(unknown), /font "Comic Sans MS" is not one web-chat bundles/);
  const unlicensed = themePack({ themes: { harbor: { fonts: { 'HarborSans.woff2': WOFF2 } } } });
  assert.match(planErrors(unlicensed), /no OFL licence/);
  const notOfl = themePack({ themes: { harbor: { fonts: { 'HarborSans.woff2': WOFF2, 'LICENSE': 'All rights reserved.' } } } });
  assert.match(planErrors(notOfl), /no OFL licence/);
  const fake = themePack({ themes: { harbor: { fonts: { 'HarborSans.woff2': Buffer.from('not a font at all'), 'OFL.txt': OFL } } } });
  assert.match(planErrors(fake), /fonts\/HarborSans\.woff2 is not a WOFF2 file/);
  const missing = themePack({ themes: { harbor: { fonts: { 'OFL.txt': OFL } } } });
  assert.match(planErrors(missing), /fonts\/HarborSans\.woff2 is missing/);
  const bundledOnly = themePack({ themes: { harbor: { theme: { ...THEME, fonts: ['libre caslon text'] }, fonts: null } } });
  const ok = inspectPackTheme(bundledOnly, 'harbor');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.summary.fonts, [{ family: 'Libre Caslon Text', bundled: true }]);
});

test('theme.json: its name must match its directory, and it may not claim to be built in', () => {
  const renamed = themePack({ themes: { harbor: { theme: { ...THEME, name: 'other' } } } });
  assert.match(planErrors(renamed), /says name "other"/);
  const builtin = themePack({ themes: { harbor: { theme: { ...THEME, builtin: true } } } });
  assert.match(planErrors(builtin), /"builtin"/);
});

test('a bare themes/<name>.json (the layout before logos) still installs', async (t) => {
  const root = project(t);
  const dir = tmpDir();
  write(path.join(dir, 'web-chat-pack.json'), JSON.stringify({ name: 'bare-theme', version: '1.0.0', themes: ['bare'] }));
  write(path.join(dir, 'themes', 'bare.json'), JSON.stringify({ tokens: { '--wc-accent': '#123456' } }));
  const forge = await forgeFor(t, dir);
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  assert.ok(fs.existsSync(path.join(projectPaths(root).themesDir, 'bare.json')));
});

// ── remote policy ───────────────────────────────────────────────────────────

test('theme-pack installs are pack writes: refused remotely by the portal policy, even with allowDestructive', () => {
  for (const [m, url] of [
    ['POST', '/api/packs/install'], ['POST', '/api/packs/quarantine'],
    ['POST', '/api/packs/quarantine/harbor-themes/approve'], ['DELETE', '/api/packs/harbor-themes'],
  ]) {
    assert.equal(classify(m, url).allow, false, `${m} ${url}`);
    assert.equal(classify(m, url, { allowDestructive: true }).allow, false, `${m} ${url} (allowDestructive)`);
  }
  assert.equal(classify('GET', '/api/packs').allow, true, 'reading the list stays open');
});

test('…and refused by the daemon itself when the request carries the remote header', async (t) => {
  await withServer(t, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/api/packs/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [REMOTE_HEADER]: REMOTE_HEADER_VALUE },
      body: JSON.stringify({ url: 'https://github.com/acme/harbor' }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).remote, true);
    const list = await fetch(`${baseUrl}/api/packs`, { headers: { [REMOTE_HEADER]: REMOTE_HEADER_VALUE } });
    assert.equal(list.status, 200, 'a remote GET is still answered');
  });
});
