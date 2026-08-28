const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// ~/.web-chat (the registry + the global profiles tier) is redirected by
// test-support/sandbox, which helpers loads; withServer then mints a per-test
// home on top, so a registerInstance here and the hub reading it back are always
// looking at the same throwaway registry.
const { withServer, withHub } = require('../test-support/helpers');
const { registerInstance, deregisterInstance, instanceId } = require('../lib/util/registry');

// Write a profile bundle into a root's project tier. Called from withServer's
// `seed`, i.e. BEFORE the server boots and loads the profile registry.
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

const PR_MATCHERS = [
  { type: 'regex', value: 'github\\.com/.+/pull/\\d+' },
  { type: 'domain', value: 'github.com' },
];

test('profile-match: instance reports matched/unmatched with name + has_interaction', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ root }) => putProfile(root, 'github-pr', {
      matchers: PR_MATCHERS,
      description: 'GitHub PR',
      interact: { steps: [{ name: 'a', action: 'click', selector: 'x' }] },
    }),
  });

  const hit = await api.get('/api/profile-match?url=' + encodeURIComponent('https://github.com/a/b/pull/3'));
  assert.equal(hit.json.matched, true);
  assert.equal(hit.json.name, 'github-pr');
  assert.equal(hit.json.description, 'GitHub PR');
  assert.equal(hit.json.has_interaction, true);

  const miss = await api.get('/api/profile-match?url=' + encodeURIComponent('https://example.com/'));
  assert.equal(miss.json.matched, false);
});

test('profile-match: a table page with no user profile is NOT a match (Contract 7)', async (t) => {
  const { api } = await withServer(t);

  // URL-only match (no html), and even the builtin tables would not count.
  const r = await api.get('/api/profile-match?url=' + encodeURIComponent('https://anything.example/sheet'));
  assert.equal(r.json.matched, false);
});

test('profile-match: CORS preflight + token gate', async (t) => {
  const { api } = await withServer(t, {
    seed: ({ root, webChatDir }) => {
      fs.writeFileSync(path.join(webChatDir, 'capture-token'), 'sek\n');
      putProfile(root, 'p', { matchers: [{ type: 'domain', value: 'x.test' }] });
    },
  });

  const pre = await api.raw('/api/profile-match', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');

  const noTok = await api.get('/api/profile-match?url=https://x.test/');
  assert.equal(noTok.status, 401);

  const ok = await api.get('/api/profile-match?url=https://x.test/', { 'X-WC-Token': 'sek' });
  assert.equal(ok.json.matched, true);
});

test('profile-match: hub forwards to the instance and attaches instance info', async (t) => {
  const { port, root } = await withServer(t, {
    seed: ({ root: r }) => putProfile(r, 'github-pr', { matchers: PR_MATCHERS }),
  });
  registerInstance({ root, port, pid: process.pid, title: 'pmhub' });
  t.after(() => deregisterInstance(root));
  const H = await withHub(t);

  // lone instance → no ?instance needed
  const hit = await H.api.get('/api/profile-match?url=' + encodeURIComponent('https://github.com/a/b/pull/9'));
  assert.equal(hit.status, 200);
  assert.equal(hit.json.matched, true);
  assert.equal(hit.json.name, 'github-pr');
  assert.ok(hit.json.instance && hit.json.instance.id === instanceId(root), 'instance info attached');

  // no instances → 503
  deregisterInstance(root);
  const none = await H.api.get('/api/profile-match?url=https://github.com/a/b/pull/1');
  assert.equal(none.status, 503);
});
