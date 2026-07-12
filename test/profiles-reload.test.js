const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate ~/.web-chat (global profiles tier) before modules read homedir, so the
// dogfood global profiles don't leak into these assertions.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-reloadhome-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const { withServer } = require('../test-support/helpers');

function profileDir(root, name) { return path.join(root, '.web-chat', 'profiles', name); }
function writeProfile(root, name, { matchers, extractJs }) {
  const dir = profileDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name, description: `${name} desc`, matchers }));
  fs.writeFileSync(path.join(dir, 'extract.js'), extractJs);
  return dir;
}
const enc = encodeURIComponent;

test('reload: a profile written AFTER boot is picked up; the extractor cache is busted on edit', async (t) => {
  const { api, root } = await withServer(t); // boots with no user profiles
  const { get, post } = api;

  // Before reload: the URL does not match anything.
  const before = await get('/api/profile-match?url=' + enc('https://reload.test/x'));
  assert.equal(before.json.matched, false);

  // Write a profile bundle after boot, then reload.
  writeProfile(root, 'reloadable', {
    matchers: [{ type: 'domain', value: 'reload.test' }],
    extractJs: 'module.exports = () => ({ kind: "v1" });',
  });
  const rl = await post('/api/profiles/reload');
  assert.equal(rl.json.ok, true);
  assert.ok(rl.json.count >= 1, 'reload reports the loaded count');
  assert.ok(rl.json.profiles.some((p) => p.name === 'reloadable'));

  // Now it matches and runs — no restart.
  const after = await get('/api/profile-match?url=' + enc('https://reload.test/x'));
  assert.equal(after.json.matched, true);
  assert.equal(after.json.name, 'reloadable');

  const cap1 = await post('/api/capture', { url: 'https://reload.test/x', html: '<p>x</p>' });
  assert.equal(cap1.json.profile, 'reloadable');
  assert.equal(cap1.json.distilled.kind, 'v1');

  // Edit the extractor and reload again — must bust the require cache (v2, not stale v1).
  fs.writeFileSync(path.join(profileDir(root, 'reloadable'), 'extract.js'), 'module.exports = () => ({ kind: "v2" });');
  const rl2 = await post('/api/profiles/reload');
  assert.equal(rl2.json.ok, true);

  const cap2 = await post('/api/capture', { url: 'https://reload.test/x', html: '<p>x</p>' });
  assert.equal(cap2.json.distilled.kind, 'v2', 'edited extractor takes effect — module cache busted');
});

test('reload: GET /api/profiles lists the loaded profiles (incl. builtins)', async (t) => {
  const { api } = await withServer(t, {
    seed: async ({ root }) => {
      writeProfile(root, 'listme', {
        matchers: [{ type: 'domain', value: 'listme.test' }],
        extractJs: 'module.exports = () => ({ kind: "listme" });',
      });
    },
  });
  const { get } = api;

  const r = await get('/api/profiles');
  assert.equal(r.status, 200);
  const names = r.json.profiles.map((p) => p.name);
  assert.ok(names.includes('listme'), 'user profile listed');
  assert.ok(names.includes('default'), 'builtins listed too');
  const listme = r.json.profiles.find((p) => p.name === 'listme');
  assert.equal(listme.scope, 'project');
});
