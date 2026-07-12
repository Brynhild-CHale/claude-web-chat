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
