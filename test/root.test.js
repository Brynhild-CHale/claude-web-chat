const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findProjectRoot, resolveWebChatDir } = require('../lib/util/root');

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-root-'));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const nested = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  return { root: fs.realpathSync(root), nested: fs.realpathSync(nested) };
}

test('findProjectRoot walks up to the nearest .web-chat', () => {
  const { root, nested } = tmpTree();
  assert.equal(findProjectRoot(nested), root);
  assert.equal(findProjectRoot(root), root);
});

test('findProjectRoot returns null when no .web-chat up-tree', () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bare-')));
  assert.equal(findProjectRoot(bare), null);
});

test('findProjectRoot prefers the closest .web-chat (nested install wins)', () => {
  const { root } = tmpTree();
  const inner = path.join(root, 'a', 'inner');
  fs.mkdirSync(path.join(inner, '.web-chat'), { recursive: true });
  const deeper = path.join(inner, 'x');
  fs.mkdirSync(deeper, { recursive: true });
  assert.equal(findProjectRoot(fs.realpathSync(deeper)), fs.realpathSync(inner));
});

test('resolveWebChatDir falls back to startDir when uninstalled', () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bare2-')));
  assert.equal(resolveWebChatDir(bare), path.join(bare, '.web-chat'));
});

// ── $HOME/.web-chat is the USER tier, not a project ─────────────────────────
// install.sh creates ~/.web-chat on every machine (versions/, current, the
// instance registry, service trust). Before this guard the upward walk found
// that directory and returned $HOME for EVERY uninitialised directory beneath
// it — so `claude-web-chat init` in a fresh ~/code/my-app resolved its root to
// the home directory, took the existing-install branch, skipped the first-run
// consent, and configured the whole machine: hooks in ~/.claude/settings.json
// firing in every project, a ~/.mcp.json, and a daemon rooted at $HOME.

const { withTempHome } = require('../test-support/helpers');

test('findProjectRoot never auto-detects $HOME as a project root', (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat', 'versions'), { recursive: true });   // what install.sh leaves
  const fresh = path.join(home, 'code', 'my-app');
  fs.mkdirSync(fresh, { recursive: true });

  assert.equal(findProjectRoot(fresh), null,
    'a fresh directory under $HOME has no project root — init must fall back to the cwd the user is standing in');
  assert.equal(findProjectRoot(home), null, 'nor is $HOME itself one');
});

test('…even when the user tier carries the same markers a project would', (t) => {
  const home = withTempHome(t);
  // Exactly the state a previous misfire leaves behind: project-tier artifacts
  // sitting in the user tier. It must not make $HOME look like a project.
  fs.mkdirSync(path.join(home, '.web-chat', 'graph'), { recursive: true });
  fs.mkdirSync(path.join(home, '.web-chat', 'captures'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', '_version.json'), '{"version":2}');
  const fresh = path.join(home, 'scratch');
  fs.mkdirSync(fresh, { recursive: true });

  assert.equal(findProjectRoot(fresh), null);
});

test('a real project under $HOME is still found, and still walks up', (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat', 'versions'), { recursive: true });
  const proj = path.join(home, 'code', 'real-project');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const deep = path.join(proj, 'src', 'lib');
  fs.mkdirSync(deep, { recursive: true });

  assert.equal(findProjectRoot(proj), proj, 'the project itself');
  assert.equal(findProjectRoot(deep), proj, 'and from a subdirectory of it');
});
