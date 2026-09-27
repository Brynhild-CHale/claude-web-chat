// Theme packs, the part a person touches (s3c-2): the review card's logo
// thumbnails (a quarantine-served, sandboxed image route), Settings' "Installed"
// group (/api/themes names the pack), `pack list` / `review` / `remove` in the
// terminal, and removing the ACTIVE theme putting the project back on the
// default — with a message, and a theme frame to every open surface.
//
// The install pipeline itself (what a theme may carry, where it lands, the logo
// fill) is test/theme-pack-install.test.js; the drawer and Settings DOM are in
// test/components-panel.test.js and test/theme-mode-chrome.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const packs = require('../lib/packs/install');
const { BRAND_CSP } = require('../lib/server/brand');
const { classify } = require('../lib/core/remote-policy');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { tmpDir, write, packFixture, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome, withServer } = require('../test-support/helpers');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0b5cad"/></svg>';
const THEME = {
  modes: {
    light: { tokens: { '--wc-bg': '#f4f1ea', '--wc-accent': '#0b5cad' } },
    dark: { tokens: { '--wc-bg': '#0e1622', '--wc-accent': '#5aa2f0' } },
  },
};

// A themes-only pack repository, built with the shared fixture engine.
function themePack({ theme = THEME, logos = { 'logotype.svg': SVG, 'seal.png': PNG }, extra = {} } = {}) {
  const files = { 'themes/harbor/theme.json': JSON.stringify(theme), ...extra };
  for (const [f, bytes] of Object.entries(logos)) files[`themes/harbor/logos/${f}`] = bytes;
  return packFixture({
    components: [], skill: false,
    manifest: { name: 'harbor-themes', version: '1.0.0', description: 'Harbor.', themes: ['harbor'] },
    extraFiles: files,
  });
}

const forgeFor = (t, dir) => fakeForge(t, { repos: { 'acme/harbor': repoWithArchive(dir, { sha: 'c'.repeat(40) }) } });

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

const post = (baseUrl, p, body) => fetch(`${baseUrl}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

// ── the review card's logo route ────────────────────────────────────────────

test('a staged logo is served as an image, sandboxed; anything else is a bare 404', async (t) => {
  withTempHome(t);
  await withServer(t, async ({ baseUrl }) => {
    const forge = await forgeFor(t, themePack({ extra: { 'themes/harbor/notes.svg': SVG } }));
    const q = await (await post(baseUrl, '/api/packs/quarantine', { url: forge.url('acme', 'harbor') })).json();
    assert.equal(q.ok, true, q.hint);
    const logo = (theme, file) => fetch(`${baseUrl}/api/packs/quarantine/harbor-themes/logo?theme=${encodeURIComponent(theme)}&file=${encodeURIComponent(file)}`);

    const svg = await logo('harbor', 'logotype.svg');
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(svg.headers.get('content-security-policy'), BRAND_CSP, 'the /brand/<slot> policy: no script, sandboxed');
    assert.equal(await svg.text(), SVG);
    const png = await logo('harbor', 'seal.png');
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);

    assert.equal((await logo('harbor', 'lockup.svg')).status, 404, 'a slot the pack did not ship');
    assert.equal((await logo('harbor', 'notes.svg')).status, 404, 'a staged file that is not a logo name');
    assert.equal((await logo('..', 'logotype.svg')).status, 404, 'a theme name that is not a name');
    assert.equal((await logo('harbor', '../theme.json')).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/packs/quarantine/nope/logo?theme=harbor&file=seal.png`)).status, 404);
  });
});

test('a logo the plan refused is never served — the card shows the refusal instead', async (t) => {
  const root = project(t);
  const active = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const forge = await forgeFor(t, themePack({ logos: { 'logotype.svg': active } }));
  const q = await packs.quarantinePack({ url: forge.url('acme', 'harbor'), root });
  assert.ok(q.record.errors.some((e) => /logotype\.svg refused/.test(e)));
  assert.throws(() => packs.quarantineLogo({ name: 'harbor-themes', root, theme: 'harbor', file: 'logotype.svg' }), /refused/);
});

test('the logo route is readable remotely, like the review it illustrates; writes stay refused', () => {
  assert.equal(classify('GET', '/api/packs/quarantine/harbor-themes/logo').allow, true);
  assert.equal(classify('POST', '/api/packs/quarantine/harbor-themes/logo').allow, false);
});

// ── Settings: which themes a pack installed ─────────────────────────────────

test('/api/themes names the pack that installed a theme — and only for that theme', async (t) => {
  withTempHome(t);
  await withServer(t, async ({ root, baseUrl }) => {
    const forge = await forgeFor(t, themePack());
    await packs.installPack({ url: forge.url('acme', 'harbor'), root });
    await post(baseUrl, '/api/themes', { name: 'mine', tokens: { '--wc-accent': '#123456' } });
    const { themes } = await (await fetch(`${baseUrl}/api/themes`)).json();
    const row = (n) => themes.find((x) => x.name === n);
    assert.equal(row('harbor').pack, 'harbor-themes');
    assert.equal(row('harbor').location, 'local');
    assert.equal(row('mine').pack, undefined, 'a theme I saved came from no pack');
    assert.equal(row('earthy').pack, undefined);
  });
});

// ── remove: the active theme goes back to the default ───────────────────────

test('removing the pack whose theme is active puts the project back on the default, over HTTP, and repaints', async (t) => {
  withTempHome(t);
  await withServer(t, async ({ root, baseUrl }) => {
    const forge = await forgeFor(t, themePack());
    await packs.installPack({ url: forge.url('acme', 'harbor'), root });
    assert.equal((await (await post(baseUrl, '/api/theme/apply', { name: 'harbor', scope: 'global' })).json()).ok, true);
    assert.equal((await (await fetch(`${baseUrl}/api/theme?scope=global`)).json()).name, 'harbor');
    const { cursor } = await (await fetch(`${baseUrl}/api/events?since=0`)).json();

    const out = await (await fetch(`${baseUrl}/api/packs/harbor-themes`, { method: 'DELETE' })).json();
    assert.equal(out.ok, true, out.hint);
    assert.deepEqual(out.theme_reset, { name: 'harbor', scopes: ['project'] });
    assert.equal(fs.existsSync(projectPaths(root).theme), false, 'the copy that named a theme nothing can apply is gone');
    assert.notEqual((await (await fetch(`${baseUrl}/api/theme?scope=global`)).json()).name, 'harbor');

    const { events } = await (await fetch(`${baseUrl}/api/events?since=${cursor || 0}`)).json();
    assert.ok(events.some((e) => e.kind === 'theme' && e.op === 'reset' && e.name === 'harbor'),
      'every open surface is told — the same theme frame an apply sends');
  });
});

test('no reset when the removed theme was not active, or a theme of that name still exists', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());

  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'mine', tokens: {} }));
  assert.equal(packs.removePackByName({ name: 'harbor-themes', root }).theme_reset, undefined);
  assert.ok(fs.existsSync(projectPaths(root).theme), 'someone else\'s theme is left alone');

  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  write(path.join(userPaths().themesDir, 'harbor.json'), JSON.stringify({ tokens: { '--wc-accent': '#abcdef' } }));
  assert.equal(packs.removePackByName({ name: 'harbor-themes', root }).theme_reset, undefined,
    'a harbor the user saved system-wide still resolves — it is still a theme');
  assert.ok(fs.existsSync(projectPaths(root).theme));
});

test('a dry run reports the reset and resets nothing', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  const out = packs.removePackByName({ name: 'harbor-themes', root, dryRun: true });
  assert.deepEqual(out.theme_reset, { name: 'harbor', scopes: ['project'] });
  assert.ok(fs.existsSync(projectPaths(root).theme));
});

test('a --global pack reaches the all-projects default too; a project pack never does', async (t) => {
  const root = project(t);
  const forge = await forgeFor(t, themePack());
  const sys = userPaths().theme;

  await packs.installPack({ url: forge.url('acme', 'harbor'), root });
  write(sys, JSON.stringify({ name: 'harbor', tokens: {} }));
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  assert.deepEqual(packs.removePackByName({ name: 'harbor-themes', root }).theme_reset.scopes, ['project']);
  assert.ok(fs.existsSync(sys), 'a project removal leaves every other project\'s default alone');

  await packs.installPack({ url: forge.url('acme', 'harbor'), root, tier: 'system' });
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  const out = packs.removePackByName({ name: 'harbor-themes', root, tier: 'system' });
  assert.deepEqual(out.theme_reset, { name: 'harbor', scopes: ['project', 'system'] });
  assert.equal(fs.existsSync(sys), false);
  assert.equal(fs.existsSync(projectPaths(root).theme), false);
});

test('the CLI\'s announce carries the reset to a running daemon', async (t) => {
  withTempHome(t);
  await withServer(t, async ({ baseUrl }) => {
    const { cursor } = await (await fetch(`${baseUrl}/api/events?since=0`)).json();
    await post(baseUrl, '/api/packs/announce', { pack: 'harbor-themes', theme_reset: { name: 'harbor' } });
    await post(baseUrl, '/api/packs/announce', { pack: 'other' });
    const { events } = await (await fetch(`${baseUrl}/api/events?since=${cursor || 0}`)).json();
    assert.equal(events.filter((e) => e.kind === 'theme' && e.op === 'reset').length, 1);
  });
});

// ── the terminal ────────────────────────────────────────────────────────────

// ASYNC: the fake forge answers from THIS process (see test/pack-cli.test.js).
function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack install` / `list` / `review` / `remove` speak about themes', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await forgeFor(t, themePack());
  const url = forge.url('acme', 'harbor');

  const got = await runCli(['pack', 'get', url], { home, cwd: proj });
  assert.equal(got.status, 0, got.stderr);
  const rev = await runCli(['pack', 'review', 'harbor-themes'], { home, cwd: proj });
  assert.equal(rev.status, 0, rev.stderr);
  assert.match(rev.stdout, /themes\n\s+harbor\s+\[light\/dark · logos: /);
  assert.doesNotMatch(rev.stdout, /\n\s+components\n/, 'a themes-only pack has no components heading');
  assert.match(rev.stdout, /no SKILL\.md — none needed/);
  await runCli(['pack', 'discard', 'harbor-themes'], { home, cwd: proj });

  const inst = await runCli(['pack', 'install', url, '--yes'], { home, cwd: proj });
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /theme\s+harbor — pick it in Settings → Theme/);

  const list = await runCli(['pack', 'list'], { home, cwd: proj });
  assert.match(list.stdout, /themes:\s+harbor/);
  assert.doesNotMatch(list.stdout, /components: —/, 'no empty components line for a themes-only pack');

  fs.writeFileSync(projectPaths(proj).theme, JSON.stringify({ name: 'harbor', tokens: {} }));
  const rm = await runCli(['pack', 'remove', 'harbor-themes'], { home, cwd: proj });
  assert.equal(rm.status, 0, rm.stderr);
  assert.match(rm.stdout, /harbor was the active theme — this project is back on the default theme/);
  assert.equal(fs.existsSync(projectPaths(proj).theme), false);
});

test('`pack review` prints a theme\'s plan-time refusal (raw CSS), not just the manifest\'s', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await forgeFor(t, themePack({ theme: { ...THEME, css: 'body{color:red}' } }));
  assert.equal((await runCli(['pack', 'get', forge.url('acme', 'harbor')], { home, cwd: proj })).status, 0);
  const rev = await runCli(['pack', 'review', 'harbor-themes'], { home, cwd: proj });
  assert.match(rev.stdout, /✗ theme "harbor": carries raw CSS/);
  assert.match(rev.stdout, /raw CSS — refused/);
});
