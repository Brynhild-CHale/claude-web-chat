// The version surface. resolveLatest is the one "is an update available"
// decision, shared by the stderr check and GET /api/version.
//
// There is no POST /api/update any more: a one-click self-update is a deployment
// action masquerading as a page interaction, and it could destroy an `npm link`
// dev install or install a downgrade. The surface informs; the user updates.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, withTempHome } = require('../test-support/helpers');
const { resolveLatest, cachePath, compareVersions } = require('../lib/update/check');
const pkg = require('../package.json');

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await pred()) return true; await settle(20); }
  return await pred();
}

// Seed the update-check cache with a FRESH timestamp so resolveLatest returns it
// straight from cache — no network fetch. (HOME is sandboxed by withTempHome, so
// cachePath() points into the throwaway home.)
function seedCache(latest) {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify({ last_check: Date.now(), latest }));
}

// ── resolveLatest: the shared decision ───────────────────────────────────────

test('resolveLatest: a newer cached version reports updateAvailable', async (t) => {
  withTempHome(t);
  seedCache('999.0.0');
  const info = await resolveLatest({ currentVersion: '0.4.0' });
  assert.equal(info.current, '0.4.0');
  assert.equal(info.latest, '999.0.0');
  assert.equal(info.updateAvailable, true);
});

test('resolveLatest: the same version reports no update', async (t) => {
  withTempHome(t);
  seedCache('0.4.0');
  const info = await resolveLatest({ currentVersion: '0.4.0' });
  assert.equal(info.updateAvailable, false);
  assert.equal(info.latest, '0.4.0');
});

// ── GET /api/version ─────────────────────────────────────────────────────────

test('GET /api/version reports current vs latest from the seeded cache', async (t) => {
  withTempHome(t);
  seedCache('999.0.0');
  const { api } = await withServer(t);
  const { json } = await api.get('/api/version');
  assert.equal(json.ok, true);
  assert.equal(json.current, pkg.version);
  assert.equal(json.latest, '999.0.0');
  assert.equal(json.updateAvailable, true);
  assert.equal(json.releaseUrl, 'https://github.com/Brynhild-CHale/claude-web-chat/releases/latest',
    'the bar links somewhere the user can read what changed');
});

test('GET /api/update is gone — updating is not a page interaction', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t);
  const res = await api.post('/api/update', {});
  assert.equal(res.status, 404, 'the self-update endpoint no longer exists');
});

// ── "newer", not "different" ─────────────────────────────────────────────────

test('resolveLatest: a release OLDER than the running build is not an update', async (t) => {
  withTempHome(t);
  // The maintainer's own machine, running a build ahead of the last release.
  seedCache('0.4.0');
  const info = await resolveLatest({ currentVersion: '0.5.0' });
  assert.equal(info.latest, '0.4.0');
  assert.equal(info.updateAvailable, false,
    'string inequality used to count here, so this offered a DOWNGRADE');
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 is newer than 0.9.0');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('v0.4.0', '0.4.0'), 0, 'a leading v is just tag syntax');
  assert.ok(compareVersions('0.5.0-rc.1', '0.5.0') < 0, 'a prerelease never beats its final release');
  assert.ok(compareVersions('0.5.0-rc.1', '0.4.0') > 0);
});
