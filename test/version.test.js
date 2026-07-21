// The version / self-update surface. resolveLatest (the one "is an update
// available" decision, shared by the stderr check and the route) plus the two
// HTTP endpoints. The update spawn is exercised through WEB_CHAT_UPDATE_CMD so the
// suite never shells out to npm or bounces the in-process test server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, withTempHome } = require('../test-support/helpers');
const { resolveLatest, cachePath } = require('../lib/update/check');
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
  assert.equal(json.updating, false);
});

// ── POST /api/update ─────────────────────────────────────────────────────────

test('POST /api/update spawns the (overridden) updater and debounces a repeat', async (t) => {
  withTempHome(t);
  const { api, root } = await withServer(t);
  const marker = path.join(root, 'updater-ran');
  const prev = process.env.WEB_CHAT_UPDATE_CMD;
  // A harmless stand-in for `claude-web-chat update`: it just drops a marker so we
  // can prove the detached spawn fired, without touching npm or the daemon.
  process.env.WEB_CHAT_UPDATE_CMD = JSON.stringify(['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`]);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_UPDATE_CMD; else process.env.WEB_CHAT_UPDATE_CMD = prev; });

  const first = await api.post('/api/update', {});
  assert.equal(first.json.ok, true);
  assert.equal(first.json.started, true);
  assert.ok(await waitFor(() => fs.existsSync(marker)), 'the detached updater actually ran');

  // A second click while an update is in flight is debounced, not double-spawned.
  const second = await api.post('/api/update', {});
  assert.equal(second.json.started, false);
  assert.equal(second.json.updating, true);

  // GET reflects the in-progress flag so the banner can hold its "Updating…" state.
  const v = await api.get('/api/version');
  assert.equal(v.json.updating, true);
});
