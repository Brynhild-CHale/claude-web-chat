const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat.js');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pcli-'));
  fs.mkdirSync(path.join(root, '.web-chat', 'captures'), { recursive: true });
  return root;
}

// A bundle dir (the throwaway "draft" the skill builds before saving).
function draftBundle(base, { matchers, extractJs, paneJs }) {
  const dir = path.join(base, 'draft');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name: 'demo', description: 'd', matchers }));
  fs.writeFileSync(path.join(dir, 'extract.js'), extractJs);
  if (paneJs) fs.writeFileSync(path.join(dir, 'pane.js'), paneJs);
  return dir;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, 'profile', ...args], { cwd, encoding: 'utf8' });
}

test('profile cli: validate passes for a well-formed bundle', () => {
  const root = tmpProject();
  const dir = draftBundle(root, {
    matchers: [{ type: 'domain', value: 'demo.test' }, { type: 'regex', value: 'demo\\.test/x' }],
    extractJs: 'module.exports = ({ url }) => ({ kind: "demo", url });',
  });
  const r = run(['validate', dir], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /valid/);
});

test('profile cli: validate fails on a bad regex matcher', () => {
  const root = tmpProject();
  const dir = draftBundle(root, {
    matchers: [{ type: 'regex', value: '(' }],
    extractJs: 'module.exports = () => ({});',
  });
  const r = run(['validate', dir], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad regex/);
});

test('profile cli: dry-run runs extract + pane render/reduce over a capture sidecar', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, '.web-chat', 'captures', 'cap1.html'),
    '<html><body><h1>Hi</h1><p>body text</p></body></html>');
  const dir = draftBundle(root, {
    matchers: [{ type: 'domain', value: 'demo.test' }],
    extractJs: 'module.exports = ({ root }) => ({ kind: "demo", h1: root.querySelector("h1").text });',
    paneJs: 'module.exports = { render: (d, ctx) => `<div data-wc-when="expanded">${d.h1}</div><div data-wc-when="reduced">${ctx.reduced.h1}</div>`, reduce: (d) => ({ h1: d.h1 }) };',
  });
  const r = run(['dry-run', dir, '--capture', 'cap1', '--url', 'https://demo.test/x', '--mode', 'expanded'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"h1": "Hi"/);   // distilled
  assert.match(r.stdout, /--- reduce ---/);
  assert.match(r.stdout, /render \(mode: expanded\)/);
  assert.match(r.stdout, /data-wc-when/);
});

test('profile cli: dry-run errors clearly when the capture sidecar is missing', () => {
  const root = tmpProject();
  const dir = draftBundle(root, {
    matchers: [{ type: 'domain', value: 'demo.test' }],
    extractJs: 'module.exports = () => ({});',
  });
  const r = run(['dry-run', dir, '--capture', 'nope'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sidecar not found/);
});
