// The `pack` CLI's argument parsing.
//
// A parser that lets any `--flag` swallow the next non-`--` token turns
// `pack remove --force mypack` into { force: 'mypack' } with no positional at
// all — so the command dies with "needs a pack name" while the name is sitting
// right there, and `pack install --yes <url>` silently loses both the flag and
// the URL. Only flags-last worked, and nothing said so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The parser is a module-private helper; read it out of the source rather than
// exporting a seam that exists only for a test.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli', 'commands', 'pack.js'), 'utf8');
const flags = (() => {
  const valueFlags = SRC.match(/const VALUE_FLAGS = new Set\(\[[^\]]*\]\);/)[0];
  const body = SRC.match(/function flags\(args\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  return new Function(`${valueFlags}\n${body}\nreturn flags;`)();
})();

test('a boolean flag before the positional does not eat it', () => {
  assert.deepEqual(flags(['--force', 'mypack']), { _: ['mypack'], force: true });
  assert.deepEqual(flags(['mypack', '--force']), { _: ['mypack'], force: true });
  assert.deepEqual(flags(['--yes', 'https://github.com/a/b']), { _: ['https://github.com/a/b'], yes: true });
  assert.deepEqual(flags(['--global', '--yes', 'pk']), { _: ['pk'], global: true, yes: true });
});

test('a value flag still takes its value, in either position', () => {
  assert.deepEqual(flags(['https://x/y', '--ref', 'v1.2.0', '--global']),
    { _: ['https://x/y'], ref: 'v1.2.0', global: true });
  assert.deepEqual(flags(['--ref', 'v1.2.0', 'https://x/y']),
    { _: ['https://x/y'], ref: 'v1.2.0' });
  assert.deepEqual(flags(['--file', 'SKILL.md', 'acme-ops']),
    { _: ['acme-ops'], file: 'SKILL.md' });
});

test('--flag=value works for both kinds', () => {
  assert.deepEqual(flags(['--asset=ops.tar.gz', 'pk']), { _: ['pk'], asset: 'ops.tar.gz' });
  assert.deepEqual(flags(['--global=true', 'pk']), { _: ['pk'], global: 'true' });
});

test('a value flag with nothing after it is a boolean, not a swallowed positional', () => {
  assert.deepEqual(flags(['pk', '--ref']), { _: ['pk'], ref: true });
});

test('every flag the usage text advertises is either a known value flag or a boolean', () => {
  const usage = SRC.match(/const USAGE = `([\s\S]*?)`;/)[1];
  const advertised = [...usage.matchAll(/--([a-z-]+)(\s+<[^>]+>)?/g)];
  const valueFlags = new Set(SRC.match(/const VALUE_FLAGS = new Set\(\[([^\]]*)\]\)/)[1]
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean));
  for (const [, name, takesValue] of advertised) {
    if (takesValue) {
      assert.ok(valueFlags.has(name),
        `usage advertises \`--${name} <value>\` but VALUE_FLAGS does not list it — it would parse as a boolean and eat the positional`);
    } else {
      assert.ok(!valueFlags.has(name),
        `usage advertises \`--${name}\` as a boolean but VALUE_FLAGS lists it — it would swallow the next argument`);
    }
  }
});

// ── --yes must INSTALL ──────────────────────────────────────────────────────
// The shared prompt engine deliberately resolves a non-interactive question to
// its printed DEFAULT — which for this gate is No. That semantic is load-bearing
// (init has gates that must never be taken by --yes, and test/init.test.js pins
// it), so `pack install --yes` has to override at the call site. Without that it
// printed "(--yes — assuming no)", installed nothing, and exited 0 — while its
// own usage line advertised the flag.

const { spawn } = require('child_process');
const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { projectPaths } = require('../lib/core/paths');

// ASYNC, deliberately. The fake forge these tests fetch from is an HTTP server
// in THIS process, so a spawnSync would block the event loop that has to answer
// the child's request — a deadlock, not a slow test.
function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack install --yes` installs instead of silently declining', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await fakeForge(t, {
    repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: 'a'.repeat(40) }) },
  });

  const r = await runCli(['pack', 'install', forge.url('acme', 'ops'), '--yes'], { home, cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /assuming no/, 'the flag is honoured, not resolved to the printed default');
  assert.match(r.stdout, /--yes — installing/);
  assert.ok(fs.existsSync(path.join(projectPaths(proj).components, 'deploy-board', 'component.html')),
    '--yes actually installed the pack');
});

test('without --yes and with no terminal, it still declines and installs nothing', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await fakeForge(t, {
    repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: 'a'.repeat(40) }) },
  });

  const r = await runCli(['pack', 'install', forge.url('acme', 'ops')], { home, cwd: proj });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing installed/, 'a pipe or a hook must never install a pack by default');
  assert.equal(fs.existsSync(path.join(projectPaths(proj).components, 'deploy-board')), false);
});

test('`pack get` never prompts — it is the scripted path', async (t) => {
  const home = tmpDir('wc-home-');
  const proj = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await fakeForge(t, {
    repos: { 'acme/ops': repoWithArchive(packFixture(), { sha: 'a'.repeat(40) }) },
  });

  const r = await runCli(['pack', 'get', forge.url('acme', 'ops')], { home, cwd: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /downloaded, NOT installed/);
  assert.doesNotMatch(r.stdout, /\[y\/N\]/, 'no question is asked, so none can be answered wrongly');
});
