const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate ~/.web-chat (registry + global profiles) before modules read homedir.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pmhome-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const { createServer } = require('../lib/server');
const { createHub } = require('../lib/hub');
const { registerInstance, deregisterInstance, instanceId } = require('../lib/util/registry');

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-${name}-`));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}
function putProfile(root, name, opts = {}) {
  const dir = path.join(root, '.web-chat', 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, description: opts.description || `${name} desc`, matchers: opts.matchers || [] };
  if (opts.interact) meta.interact = opts.interact;
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(dir, 'extract.js'),
    opts.extractJs || `module.exports = ({ url }) => ({ kind: ${JSON.stringify(name)}, url });`,
  );
}
async function listen(srv) { await new Promise((r) => srv.server.listen(0, r)); return srv.server.address().port; }

const PR_MATCHERS = [
  { type: 'regex', value: 'github\\.com/.+/pull/\\d+' },
  { type: 'domain', value: 'github.com' },
];

test('profile-match: instance reports matched/unmatched with name + has_interaction', async () => {
  const root = tmpRoot('pm');
  putProfile(root, 'github-pr', {
    matchers: PR_MATCHERS,
    description: 'GitHub PR',
    interact: { steps: [{ name: 'a', action: 'click', selector: 'x' }] },
  });
  const srv = createServer({ root, port: 0 });
  const port = await listen(srv);
  const get = (p) => fetch(`http://localhost:${port}${p}`).then(async (r) => ({ status: r.status, json: await r.json() }));

  const hit = await get('/api/profile-match?url=' + encodeURIComponent('https://github.com/a/b/pull/3'));
  assert.equal(hit.json.matched, true);
  assert.equal(hit.json.name, 'github-pr');
  assert.equal(hit.json.description, 'GitHub PR');
  assert.equal(hit.json.has_interaction, true);

  const miss = await get('/api/profile-match?url=' + encodeURIComponent('https://example.com/'));
  assert.equal(miss.json.matched, false);

  await srv.stop();
});

test('profile-match: a table page with no user profile is NOT a match (Contract 7)', async () => {
  const root = tmpRoot('pm7');
  const srv = createServer({ root, port: 0 });
  const port = await listen(srv);
  const get = (p) => fetch(`http://localhost:${port}${p}`).then((r) => r.json());

  // URL-only match (no html), and even the builtin tables would not count.
  const r = await get('/api/profile-match?url=' + encodeURIComponent('https://anything.example/sheet'));
  assert.equal(r.matched, false);

  await srv.stop();
});

test('profile-match: CORS preflight + token gate', async () => {
  const root = tmpRoot('pmtok');
  fs.writeFileSync(path.join(root, '.web-chat', 'capture-token'), 'sek\n');
  putProfile(root, 'p', { matchers: [{ type: 'domain', value: 'x.test' }] });
  const srv = createServer({ root, port: 0 });
  const port = await listen(srv);
  const base = `http://localhost:${port}`;

  const pre = await fetch(base + '/api/profile-match', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');

  const noTok = await fetch(base + '/api/profile-match?url=https://x.test/');
  assert.equal(noTok.status, 401);

  const ok = await fetch(base + '/api/profile-match?url=https://x.test/', { headers: { 'X-WC-Token': 'sek' } }).then((r) => r.json());
  assert.equal(ok.matched, true);

  await srv.stop();
});

test('profile-match: hub forwards to the instance and attaches instance info', async () => {
  const root = tmpRoot('pmhub');
  putProfile(root, 'github-pr', { matchers: PR_MATCHERS });
  const srv = createServer({ root, port: 0 });
  const port = await listen(srv);
  registerInstance({ root, port, pid: process.pid, title: 'pmhub' });

  const hub = createHub({ port: 0 });
  const hubPort = await listen(hub);
  const H = (p) => fetch(`http://localhost:${hubPort}${p}`).then(async (r) => ({ status: r.status, json: await r.json() }));

  // lone instance → no ?instance needed
  const hit = await H('/api/profile-match?url=' + encodeURIComponent('https://github.com/a/b/pull/9'));
  assert.equal(hit.status, 200);
  assert.equal(hit.json.matched, true);
  assert.equal(hit.json.name, 'github-pr');
  assert.ok(hit.json.instance && hit.json.instance.id === instanceId(root), 'instance info attached');

  // no instances → 503
  deregisterInstance(root);
  const none = await H('/api/profile-match?url=https://github.com/a/b/pull/1');
  assert.equal(none.status, 503);

  await srv.gracefulShutdown();
  await hub.stop();
});
