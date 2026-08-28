const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
// `run()` below spawnSyncs the real CLI with no `env`, so the child inherits
// this process's HOME — which without this would be the developer's, and
// `profile list` would read their real ~/.web-chat/profiles. Required directly
// (not via helpers, which this file does not otherwise need) so the redirect
// holds even when the runner is invoked without the --import preload.
require('../test-support/sandbox');

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

// The offline check is only worth running if it calls the extractor the way the
// daemon does. `runProfile` spreads a helper kit — { esc, collapse, absolutize,
// safeHref } — onto the extract argument and onto the pane ctx, and every bundled
// profile plus the shape the /capture-profile skill documents destructures it. A
// dry-run that passed a bare { url, html, root } would throw "esc is not a
// function" on exactly those bundles: green online, red offline.
test('profile cli: dry-run hands extract and pane the same helper kit the daemon does', () => {
  const root = tmpProject();
  fs.writeFileSync(path.join(root, '.web-chat', 'captures', 'cap1.html'),
    '<html><body><h1>Tom &amp; Jerry</h1><a id="rel" href="c.html">rel</a>'
    + '<a id="js" href="javascript:alert(1)">js</a></body></html>');
  const dir = draftBundle(root, {
    matchers: [{ type: 'domain', value: 'demo.test' }],
    extractJs: 'module.exports = ({ url, root, esc, collapse, safeHref }) => ({\n'
      + '  kind: "demo",\n'
      + '  titleHtml: esc(collapse(root.querySelector("h1").text)),\n'
      + '  rel: safeHref(root.querySelector("#rel").getAttribute("href"), url),\n'
      + '  js: safeHref(root.querySelector("#js").getAttribute("href"), url),\n'
      + '});',
    paneJs: 'module.exports = { render: (d, { esc, reduced }) =>\n'
      + '  `<div data-wc-when="expanded">${d.titleHtml}</div>`\n'
      + '  + `<div data-wc-when="reduced">${esc(reduced.rel)}</div>` };',
  });
  const r = run(['dry-run', dir, '--capture', 'cap1', '--url', 'https://demo.test/a/b/page.html'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Tom &amp; Jerry/, 'the injected esc ran');
  assert.match(r.stdout, /https:\/\/demo\.test\/a\/b\/c\.html/, 'the injected safeHref resolved against the page URL');
  assert.match(r.stdout, /"js": ""/, 'the injected safeHref refused the javascript: scheme');
  assert.match(r.stdout, /data-wc-when/, 'the pane rendered with its own injected esc');
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
