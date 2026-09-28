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
const { spawn } = require('child_process');

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
const { withTempHome, withServer, wsConnect, waitUntil } = require('../test-support/helpers');

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

// R6-6: the fence above covers the logos DIRECTORY. One level down, a logo
// FILE symlinked to a readable image anywhere on the host was followed —
// shown in the topbar, served at /brand/<slot>, inlined into every export.
test('no fill from a logo FILE symlinked out of .web-chat — only a regular file is read', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  const logos = projectPaths(root).themeLogosDir('harbor');
  assert.deepEqual(brand.fillSource(root), { name: 'harbor', dir: logos }, 'the directory itself is inside .web-chat');

  const outside = tmpDir('wc-outside-');
  const secret = Buffer.concat([PNG, Buffer.from('private')]);
  write(path.join(outside, 'private.png'), secret);
  fs.symlinkSync(path.join(outside, 'private.png'), path.join(logos, 'lockup.png'));

  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(brand.effective(root, 'lockup'), null, 'the linked file is not read');
    assert.equal(brand.dataUri(root, 'lockup'), null, 'so no export inlines it');
    assert.equal(brand.fills(root).lockup, null, 'and the chrome is told of no fill');
  } finally { console.error = orig; }
  assert.equal(lines.filter((l) => l.includes('lockup.png') && /symlink/.test(l)).length, 1, 'one log line says why');
  assert.ok(brand.effective(root, 'logotype'), 'the regular files beside it still fill');
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

// ── update: a version that drops the ACTIVE theme ───────────────────────────
//
// R6-3: re-installing a pack is the advertised update, and it prunes the whole
// units the new version no longer ships — but only `pack remove` reset the
// active theme. An update that dropped the applied theme left theme.json naming
// a theme nothing could apply again, its logos gone, and no frame to tell open
// surfaces.

const SHA2 = 'c'.repeat(40);
// v1 ships acme and acme-two; v2 only acme-two.
async function acmeForges(t) {
  const v1 = themePack({ name: 'acme-themes', themes: { acme: {}, 'acme-two': {} } });
  const v2 = themePack({ name: 'acme-themes', themes: { 'acme-two': {} } });
  const f1 = await fakeForge(t, { repos: { 'acme/themes': repoWithArchive(v1, { sha: SHA }) } });
  const f2 = await fakeForge(t, { repos: { 'acme/themes': repoWithArchive(v2, { sha: SHA2 }) } });
  return { v1: f1.url('acme', 'themes'), v2: f2.url('acme', 'themes') };
}

// A socket that records every frame the daemon broadcasts.
async function listen(t, port) {
  const frames = [];
  const sock = wsConnect(port);
  sock.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  t.after(() => { try { sock.terminate(); } catch {} });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { what: 'hello' });
  return frames;
}

test('an update that no longer ships the ACTIVE theme resets it, and the install route repaints every surface', async (t) => {
  withTempHome(t);
  const { root, baseUrl, port, api } = await withServer(t);
  const urls = await acmeForges(t);
  const lib = projectPaths(root).themesDir;
  await packs.installPack({ url: urls.v1, root });
  assert.equal((await api.post('/api/theme/apply', { name: 'acme', scope: 'global' })).json.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(projectPaths(root).theme, 'utf8')).name, 'acme');
  const frames = await listen(t, port);
  const { cursor } = (await api.get('/api/events?since=0')).json;

  const out = await (await fetch(`${baseUrl}/api/packs/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: urls.v2 }),
  })).json();
  assert.equal(out.ok, true, out.hint);
  assert.ok(out.results.some((r) => r.kind === 'theme' && r.name === 'acme' && r.action === 'pruned'), 'the update pruned acme');
  assert.deepEqual(out.theme_reset, { name: 'acme', scopes: ['project'] }, 'and says it reset the active theme');
  assert.equal(fs.existsSync(path.join(lib, 'acme.json')), false);
  assert.ok(fs.existsSync(path.join(lib, 'acme-two.json')), 'the theme v2 still ships is kept');
  assert.equal(fs.existsSync(projectPaths(root).theme), false, 'theme.json no longer names a theme nothing can apply');
  assert.notEqual((await api.get('/api/theme?scope=global')).json.name, 'acme');
  assert.notEqual((brand.fillSource(root) || {}).name, 'acme', 'no fill from a theme that is gone');

  const frame = await waitUntil(() => frames.find((f) => f.type === 'theme' && f.scope === 'global'), { what: 'a global theme frame' });
  assert.notEqual(frame.resolved.name, 'acme', 'the frame carries what the project resolves to now');
  const { events } = (await api.get(`/api/events?since=${cursor || 0}`)).json;
  assert.ok(events.some((e) => e.kind === 'theme' && e.op === 'reset' && e.name === 'acme' && e.scope === 'global' && e.reason === 'pack-updated'),
    'the event log names the reset and why');
});

test('an update resets nothing when the active theme is one it still ships, or another theme entirely', async (t) => {
  for (const active of ['acme-two', 'mine']) {
    const root = project(t);
    const urls = await acmeForges(t);
    await packs.installPack({ url: urls.v1, root });
    fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: active, tokens: {} }));
    const out = await packs.installPack({ url: urls.v2, root });
    assert.ok(out.results.some((r) => r.name === 'acme' && r.action === 'pruned'), active);
    assert.equal(out.theme_reset, undefined, active);
    assert.equal(JSON.parse(fs.readFileSync(projectPaths(root).theme, 'utf8')).name, active, `${active} stays applied`);
  }
});

// ASYNC: the fake forge answers from THIS process. WEB_CHAT_PORT is dropped so
// the CLI's announce can never reach a daemon outside the test.
function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' };
    delete env.WEB_CHAT_PORT;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack install` of such an update prints the line `pack remove` prints for a reset', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const urls = await acmeForges(t);
  const first = await runCli(['pack', 'install', urls.v1, '--yes'], { home, cwd: proj });
  assert.equal(first.status, 0, first.stderr);
  fs.writeFileSync(projectPaths(proj).theme, JSON.stringify({ name: 'acme', tokens: {} }));
  const upd = await runCli(['pack', 'install', urls.v2, '--yes'], { home, cwd: proj });
  assert.equal(upd.status, 0, upd.stderr);
  assert.match(upd.stdout, /acme was the active theme — this project is back on the default theme/);
  assert.equal(fs.existsSync(projectPaths(proj).theme), false);
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

// security-theme-pack-token-url: a token is one declaration value, but one value
// can still make the browser fetch — and the chrome paints tokens with no CSP,
// and an export inlines them. An installed theme's token values may not load
// anything, top-level or per mode; an escape is refused with them (`\75rl(` IS
// `url(` to CSS).
test('a token value that would load something is refused at plan time, in every token map', async (t) => {
  const { refusedTokenValue } = require('../lib/core/theme-values');
  for (const bad of [
    'url(https://tracker.example/p.png)', 'URL( "x" )', 'linear-gradient(red, blue), url(x)',
    'image-set("a.png" 1x)', '-webkit-image-set(x 1x)', 'image(x)', 'cross-fade(a, b)', 'src("x")',
    'expression(alert(1))', '@import "x"', 'javascript:alert(1)', '\\75rl(x)', 'u\\rl(x)',
    // Painted, not shipped: the strip deletes `{ } < > ;`, which assembles these.
    'ur;l(https://tracker.example/p.png)', 'u{}rl(https://tracker.example/p.png)',
    'image-s<>et("https://x.example/a.png" 1x)', '@im;port "https://x.example/t.css"',
  ]) assert.ok(refusedTokenValue(bad), bad);
  for (const ok of [
    '#0b5cad', 'rgb(1 2 3 / 50%)', 'radial-gradient(circle at 20% 10%, #fff 0, transparent 60%)',
    "'Harbor Sans', sans-serif", '0 1px 2px rgba(0,0,0,.2)', '8px', 280, 'color-mix(in srgb, red 20%, blue)',
    'curly', 'imagery', 'sourced',
  ]) assert.equal(refusedTokenValue(ok), null, String(ok));

  const top = themePack({ themes: { harbor: { theme: { ...THEME, tokens: { ...THEME.tokens, '--wc-depth-radial': 'url(https://tracker.example/p.png)' } } } } });
  assert.match(planErrors(top), /tokens --wc-depth-radial carries url\(…\)/);
  const mode = themePack({ themes: { harbor: { theme: { ...THEME, modes: { ...THEME.modes, dark: { tokens: { ...THEME.modes.dark.tokens, '--wc-bg': 'image-set("https://x.example/a.png" 1x)' } } } } } } });
  assert.match(planErrors(mode), /modes\.dark\.tokens --wc-bg carries image-set\(…\)/);
  assert.equal(planErrors(themePack()), '', 'the plain theme still plans clean');

  const root = project(t);
  const forge = await forgeFor(t, top);
  const q = await packs.quarantinePack({ url: forge.url('acme', 'harbor'), root });
  assert.ok(q.record.errors.some((e) => /--wc-depth-radial carries url/.test(e)), 'the review card shows the refusal');
  assert.throws(() => packs.approvePack({ name: 'harbor-themes', root }), /may not load anything/);
  assert.equal(fs.existsSync(path.join(projectPaths(root).themesDir, 'harbor.json')), false);
});

// R6-1: the refusal judged the value as SHIPPED, but every consumer reads a
// token through the strip (sanitizeTokens deletes `{ } < > ;`), and deleting
// characters can assemble a refused name: `ur;l(` passed review and was painted
// as `url(` into the chrome and every export. The strip and the refusal are one
// module now, and the refusal judges the painted value too.
test('theme values: the refusal judges the value the strip paints — a deleted { } < > ; cannot assemble a refused name', () => {
  const { sanitizeTokenValue, refusedTokenValue, refusedTokens, alteredTokens } = require('../lib/core/theme-values');
  const { sanitizeTokens } = require('../lib/server/theme');
  const probes = [
    ['ur;l(https://tracker.example/p.png)', 'url(https://tracker.example/p.png)', 'url(…)'],
    ['u{}rl(https://tracker.example/p.png)', 'url(https://tracker.example/p.png)', 'url(…)'],
    ['image-s<>et("https://x.example/a.png" 1x)', 'image-set("https://x.example/a.png" 1x)', 'image-set(…)'],
    ['@im;port "https://x.example/t.css"', '@import "https://x.example/t.css"', '@import'],
  ];
  for (const [shipped, painted, what] of probes) {
    assert.equal(sanitizeTokenValue(shipped), painted, `${shipped} is painted as ${painted}`);
    assert.equal(sanitizeTokens({ '--wc-bg': shipped })['--wc-bg'], painted, 'the theme engine paints through the same strip');
    assert.equal(refusedTokenValue(shipped), what, shipped);
  }
  // The shipped form is still judged: `a{}url(` is painted as the harmless
  // `aurl(`, but a value that spells url( as shipped is refused regardless.
  assert.equal(refusedTokenValue('a{}url(x)'), 'url(…)');
  assert.deepEqual(refusedTokens({ '--wc-bg': 'ur;l(x)', '--wc-fg': '#fff' }), [{ token: '--wc-bg', what: 'url(…)' }]);

  // The strip's own contract, unchanged by the move into core.
  assert.equal(sanitizeTokenValue('0 1px\n2px rgba(0,0,0,.2)'), '0 1px 2px rgba(0,0,0,.2)');
  assert.equal(sanitizeTokenValue('#fff;}\r\n<b>'), '#fff b');
  assert.equal(sanitizeTokenValue(280), '280');

  // What the strip would change — surrounding whitespace aside.
  assert.deepEqual(alteredTokens({
    '--wc-bg': '#fff;', '--wc-shadow': '0 1px\n2px red', '--wc-gold': 'a{b}',
    '--wc-fg': '  #000\n', '--wc-radius': 8, '--wc-accent': '#0b5cad', '--wc-x': {},
  }), [
    { token: '--wc-bg', painted: '#fff' },
    { token: '--wc-shadow', painted: '0 1px 2px red' },
    { token: '--wc-gold', painted: 'ab' },
  ]);
  assert.deepEqual(alteredTokens(null), []);
});

test('a pack token the strip would change is refused at plan time, and the url( it assembles is named', async (t) => {
  const withTop = (v) => themePack({ themes: { harbor: { theme: { ...THEME, tokens: { ...THEME.tokens, '--wc-depth-radial': v } } } } });
  for (const [shipped, what] of [
    ['ur;l(https://tracker.example/p.png)', /tokens --wc-depth-radial carries url\(…\)/],
    ['u{}rl(https://tracker.example/p.png)', /tokens --wc-depth-radial carries url\(…\)/],
    ['image-s<>et("https://x.example/a.png" 1x)', /tokens --wc-depth-radial carries image-set\(…\)/],
    ['@im;port "https://x.example/t.css"', /tokens --wc-depth-radial carries @import/],
  ]) {
    const errs = planErrors(withTop(shipped));
    assert.match(errs, what, shipped);
    assert.match(errs, /tokens --wc-depth-radial carries \{ \} < > ; or a line break/, shipped);
  }
  // Structural characters alone, with nothing to assemble, are refused too — top-level and per mode.
  const semi = planErrors(withTop('#0b5cad;'));
  assert.match(semi, /tokens --wc-depth-radial carries \{ \} < > ; or a line break/);
  assert.doesNotMatch(semi, /may not load anything/);
  const nl = themePack({ themes: { harbor: { theme: { ...THEME, modes: { ...THEME.modes, light: { tokens: { ...THEME.modes.light.tokens, '--wc-shadow': '0 1px\n2px red' } } } } } } });
  assert.match(planErrors(nl), /modes\.light\.tokens --wc-shadow carries \{ \} < > ; or a line break/);

  // Through review: the card shows it and approval refuses it, so nothing lands.
  const root = project(t);
  const forge = await forgeFor(t, withTop('ur;l(https://tracker.example/p.png)'));
  const q = await packs.quarantinePack({ url: forge.url('acme', 'harbor'), root });
  assert.ok(q.record.errors.some((e) => /--wc-depth-radial carries url/.test(e)), 'the review card shows the refusal');
  assert.throws(() => packs.approvePack({ name: 'harbor-themes', root }), /may not load anything/);
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
