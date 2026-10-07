// test-support/helpers `e2eGate` — the one switch on the tests that drive a REAL
// headless Chrome or a real ffmpeg. They are opt-in: WEB_CHAT_E2E_CHROME=1 /
// WEB_CHAT_E2E_FFMPEG=1, never "whatever this machine has installed". The gate
// is described with an injected env and finder, so these cases say the same
// thing on a box with every browser as on a bare CI image.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { e2eGate } = require('../test-support/helpers');

// A machine that has everything — the case where the old gate ran real renders.
const everything = { chrome: () => '/x/chrome', ffmpeg: () => '/x/ffmpeg' };
const nothing = { chrome: () => null, ffmpeg: () => null };

test('e2eGate: not opted in → skips however much is installed, naming the env var, and probes nothing', () => {
  const probed = [];
  const spy = { chrome: () => { probed.push('chrome'); return '/x/chrome'; }, ffmpeg: () => { probed.push('ffmpeg'); return '/x/ffmpeg'; } };

  const c = e2eGate(['chrome'], { env: {}, find: spy });
  assert.match(c.skip, /WEB_CHAT_E2E_CHROME=1/);
  assert.equal(c.chrome, undefined);

  const f = e2eGate(['ffmpeg'], { env: {}, find: spy });
  assert.match(f.skip, /WEB_CHAT_E2E_FFMPEG=1/);

  const both = e2eGate(['chrome', 'ffmpeg'], { env: { WEB_CHAT_E2E_CHROME: '1' }, find: spy });
  assert.match(both.skip, /WEB_CHAT_E2E_FFMPEG=1/, 'half opted in is not opted in');
  assert.doesNotMatch(both.skip, /WEB_CHAT_E2E_CHROME/, 'and it names only the var still missing');

  assert.deepEqual(probed, [], 'nothing on the machine is looked at until the test is opted in');
});

test('e2eGate: only exactly "1" opts in', () => {
  for (const v of ['0', 'true', 'yes', '', ' 1']) {
    assert.ok(e2eGate(['chrome'], { env: { WEB_CHAT_E2E_CHROME: v }, find: everything }).skip, `WEB_CHAT_E2E_CHROME=${JSON.stringify(v)} does not opt in`);
  }
});

test('e2eGate: opted in → runs with the found binaries', () => {
  const g = e2eGate(['chrome', 'ffmpeg'], { env: { WEB_CHAT_E2E_CHROME: '1', WEB_CHAT_E2E_FFMPEG: '1' }, find: everything });
  assert.deepEqual(g, { skip: false, chrome: '/x/chrome', ffmpeg: '/x/ffmpeg' });
});

test('e2eGate: opted in with nothing found → still skips, naming the override that points at one', () => {
  const c = e2eGate(['chrome'], { env: { WEB_CHAT_E2E_CHROME: '1' }, find: nothing });
  assert.match(c.skip, /WEB_CHAT_E2E_CHROME=1, but no Chrome-family browser found .*WEB_CHAT_CHROME/);
  const f = e2eGate(['ffmpeg'], { env: { WEB_CHAT_E2E_FFMPEG: '1' }, find: nothing });
  assert.match(f.skip, /WEB_CHAT_E2E_FFMPEG=1, but no ffmpeg found .*WEB_CHAT_FFMPEG/);
});

// The control layer's gates (spec §10.1): a real pseudo-terminal for the Esc
// injector, a real Claude Code for the halt, fork and mod runs.
const ttyAndClaude = { tty: () => ({ perl: '/x/perl', python3: '/x/python3' }), claude: () => '/x/claude' };

test('e2eGate tty / claude: not opted in → skips naming WEB_CHAT_E2E_TTY / WEB_CHAT_E2E_CLAUDE, and probes nothing', () => {
  const probed = [];
  const spy = {
    tty: () => { probed.push('tty'); return { perl: '/x/perl', python3: '/x/python3' }; },
    claude: () => { probed.push('claude'); return '/x/claude'; },
  };
  const t1 = e2eGate(['tty'], { env: {}, find: spy });
  assert.match(t1.skip, /opt-in: drives a real pseudo-terminal — set WEB_CHAT_E2E_TTY=1/);
  assert.equal(t1.tty, undefined);
  const c = e2eGate(['claude'], { env: { WEB_CHAT_E2E_CLAUDE_CONFIG_DIR: '/x/profile' }, find: spy });
  assert.match(c.skip, /opt-in: drives a real Claude Code — set WEB_CHAT_E2E_CLAUDE=1/);
  assert.equal(c.claudeConfigDir, undefined, 'the config directory is not handed out to a test that is not opted in');
  for (const v of ['0', 'true', '']) {
    assert.ok(e2eGate(['tty'], { env: { WEB_CHAT_E2E_TTY: v }, find: spy }).skip);
    assert.ok(e2eGate(['claude'], { env: { WEB_CHAT_E2E_CLAUDE: v }, find: spy }).skip);
  }
  assert.deepEqual(probed, [], 'nothing on the machine is looked at until the test is opted in');
});

test('e2eGate tty / claude: opted in with the program missing → skips naming it', () => {
  const none = { tty: () => null, claude: () => null };
  const t1 = e2eGate(['tty'], { env: { WEB_CHAT_E2E_TTY: '1' }, find: none });
  assert.match(t1.skip, /WEB_CHAT_E2E_TTY=1, but perl and python3 were not both found/);
  const c = e2eGate(['claude'], { env: { WEB_CHAT_E2E_CLAUDE: '1' }, find: none });
  assert.match(c.skip, /WEB_CHAT_E2E_CLAUDE=1, but no `claude` found/);
});

test('e2eGate tty: the real finder wants perl AND python3 on the gate\'s PATH', (t) => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-e2e-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };
  const perl = exe('perl');
  const onlyPerl = e2eGate(['tty'], { env: { WEB_CHAT_E2E_TTY: '1', PATH: dir } });
  assert.match(onlyPerl.skip, /perl and python3/, 'python3 missing still skips');
  const python3 = exe('python3');
  const both = e2eGate(['tty'], { env: { WEB_CHAT_E2E_TTY: '1', PATH: dir } });
  assert.deepEqual(both, { skip: false, tty: { perl, python3 } });
});

test('e2eGate claude: opted in → the claude found, and claudeConfigDir from WEB_CHAT_E2E_CLAUDE_CONFIG_DIR, or null without skipping', () => {
  const g = e2eGate(['claude'], { env: { WEB_CHAT_E2E_CLAUDE: '1', WEB_CHAT_E2E_CLAUDE_CONFIG_DIR: '/x/profile' }, find: ttyAndClaude });
  assert.deepEqual(g, { skip: false, claude: '/x/claude', claudeConfigDir: '/x/profile' });
  const unset = e2eGate(['claude'], { env: { WEB_CHAT_E2E_CLAUDE: '1' }, find: ttyAndClaude });
  assert.deepEqual(unset, { skip: false, claude: '/x/claude', claudeConfigDir: null });
  const tty = e2eGate(['tty'], { env: { WEB_CHAT_E2E_TTY: '1', WEB_CHAT_E2E_CLAUDE_CONFIG_DIR: '/x/profile' }, find: ttyAndClaude });
  assert.deepEqual(tty, { skip: false, tty: { perl: '/x/perl', python3: '/x/python3' } }, 'only the claude entry carries the config directory');
});

test('test/mcp-local-scope-e2e.test.js gates through e2eGate([\'claude\']) and keeps its four cases', () => {
  const src = fs.readFileSync(path.join(__dirname, 'mcp-local-scope-e2e.test.js'), 'utf8');
  assert.match(src, /e2eGate\(\['claude'\]\)/);
  assert.doesNotMatch(src, /process\.env\.WEB_CHAT_E2E_/, 'it reads no opt-in variable itself');
  assert.equal((src.match(/^test\('a real claude: /gm) || []).length, 4);
  assert.equal((src.match(/\{ skip \}/g) || []).length, 5, 'one gate, four cases under it');
});

// CI's contract is the fakes: a workflow that opted in would make CI's result
// depend on what the runner image ships, which is exactly what the gate exists
// to stop.
test('no CI workflow opts into the real-program tests', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'the workflows directory was read');
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /WEB_CHAT_E2E_/, `${f} sets a WEB_CHAT_E2E_ var`);
  }
});
