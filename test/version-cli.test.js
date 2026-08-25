// `claude-web-chat version` / `--version`, and `uninstall --self`.
//
// `version` is not decoration: it is the answer to "which copy am I running?",
// which nobody could answer when a stale global install sat on a maintainer's
// PATH for 16 days. It has to print the running tree, `current`, and the PATH
// link — and say so out loud when the last two disagree.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const versionCmd = require('../lib/cli/commands/version');
const uninstall = require('../lib/cli/commands/uninstall');
const { installPaths } = require('../lib/core/paths');
const { describeInstall, activate, linkBins } = require('../lib/update/install-layout');
const { withTempHome } = require('../test-support/helpers');

function fakeVersion(paths, version) {
  const dir = paths.versionDir(version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  return dir;
}

function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

test('version prints the running tree, current, and the PATH link', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const dir = fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: dir, paths }) });
  const text = log.text();
  assert.match(text.split('\n')[0], /^claude-web-chat v0\.5\.0$/, 'the first line stays terse — scripts read it');
  assert.match(text, /managed install/);
  assert.ok(text.includes(dir), 'it must name the tree it is running from');
  assert.ok(text.includes(paths.current), 'and what current points at');
  assert.ok(text.includes(paths.binLink('claude-web-chat')), 'and what is on PATH');
});

test('version SHOUTS when the command on PATH is a different tree', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const running = fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.1.0');
  activate('0.1.0', paths); // PATH resolves into 0.1.0...
  linkBins(paths);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: running, paths }) });
  const text = log.text();
  assert.match(text, /MISMATCH/, 'the stale-binary case must be impossible to miss');
  assert.match(text, /v0\.1\.0/, 'it must name the version PATH actually gets');
});

test('version --short prints one line and nothing else', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const dir = fakeVersion(paths, '0.5.0');
  const log = sink();
  versionCmd(['--short'], { log, paths, describeInstall: () => describeInstall({ packageRoot: dir, paths }) });
  assert.deepEqual(log.text().split('\n'), ['claude-web-chat v0.5.0']);
});

test('--version is routed to the version command, not "unknown command"', () => {
  const { main } = require('../lib/cli');
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    main(['--version', '--short']);
  } finally {
    console.log = orig;
  }
  assert.match(lines.join('\n'), /^claude-web-chat v/);
});

test('uninstall --self removes the program; plain uninstall only touches the project', (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-proj-')));
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  const prev = process.cwd();
  const logs = [];
  const origLog = console.log;
  console.log = (m = '') => logs.push(String(m));
  process.chdir(project);
  try {
    uninstall([]);
    assert.ok(fs.existsSync(paths.binLink('claude-web-chat')), 'a plain uninstall must not remove the program');
    assert.match(logs.join('\n'), /uninstall --self/, 'and it should say how to remove the program too');

    uninstall(['--self']);
  } finally {
    process.chdir(prev);
    console.log = origLog;
  }
  assert.ok(!fs.existsSync(paths.binLink('claude-web-chat')), '--self removes the PATH links');
  assert.ok(!fs.existsSync(paths.versions), '--self removes every unpacked version');
  assert.ok(fs.existsSync(paths.root), 'per-user state under ~/.web-chat survives');
  assert.ok(fs.existsSync(path.join(project, '.web-chat')), 'the project graph is never deleted');
});
