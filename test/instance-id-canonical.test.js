// One project, one instance id, however its path is spelled.
//
// instanceId(root) once hashed path.resolve(root), so a folder reached through
// a symlink (on macOS `/tmp/x` is `/private/tmp/x`, os.tmpdir()'s /var/folders
// is /private/var/folders) had a second id. A daemon hashes process.cwd(), the
// physical spelling; `init <folder>` typed through the link asked daemonFor
// with the logical one and found no daemon. lib/core/portfiles canonicalRoot
// now gives every spelling one: the longest existing ancestor's native real
// path, with the part that does not exist joined back on — so a DELETED folder
// keeps the id it had (the tunnel's grant of a since-deleted project, a daemon
// releasing its own entry after .web-chat/ went).
//
// Every case builds its own symlink inside a real-pathed tmp dir, so it means
// the same on Linux as on macOS. The one HTTP server is the test's own (port 0);
// nothing else is probed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { withTempHome } = require('../test-support/helpers');
const portfiles = require('../lib/core/portfiles');
const registry = require('../lib/util/registry');
const { PORTFILE_PROBE_MS } = require('../lib/cli/commands/stop');

// The formula instanceId had before canonicalRoot: sha1 of the resolved path,
// first 8 hex. Written out by hand so the no-change pin does not read the code
// under test.
const headId = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 8);

// A real-pathed base with `real/` and `link -> real`. Returns the physical and
// logical spellings of one folder.
function linked(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-iid-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const physical = path.join(base, 'real');
  const logical = path.join(base, 'link');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, logical, 'dir');
  return { base, physical, logical };
}

test('a symlinked spelling and its target share one instance id', (t) => {
  const { physical, logical } = linked(t);
  assert.notEqual(path.resolve(logical), path.resolve(physical), 'two spellings');
  assert.equal(portfiles.canonicalRoot(logical), physical);
  assert.equal(portfiles.instanceId(logical), portfiles.instanceId(physical));
  assert.equal(registry.instanceId(logical), registry.instanceId(physical), 'the registry re-export is the same function');
  // A folder below the link, and a trailing slash, are the same folder too.
  fs.mkdirSync(path.join(physical, 'proj'));
  assert.equal(portfiles.instanceId(path.join(logical, 'proj') + path.sep), portfiles.instanceId(path.join(physical, 'proj')));
  assert.equal(portfiles.sameRoot(logical, physical), true);
});

test('the platform\'s own two spellings: the tmp dir as os.tmpdir() names it, and the on-disk case', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-iid-tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = fs.realpathSync.native(dir);
  // macOS: /var/folders/… is /private/var/folders/…; elsewhere the two agree.
  assert.equal(portfiles.instanceId(dir), portfiles.instanceId(real));
  // A case-insensitive volume (APFS's default): another case is the same folder.
  const upper = path.join(path.dirname(real), path.basename(real).toUpperCase());
  if (upper !== real && fs.existsSync(upper)) {
    assert.equal(portfiles.canonicalRoot(upper), real);
    assert.equal(portfiles.instanceId(upper), portfiles.instanceId(real));
  }
});

test('a deleted folder under a symlinked parent keeps its id — the physical spelling\'s', (t) => {
  const { physical, logical } = linked(t);
  const folder = path.join(logical, 'proj');
  fs.mkdirSync(path.join(folder, '.web-chat'), { recursive: true });
  const before = portfiles.instanceId(folder);
  assert.equal(before, portfiles.instanceId(path.join(physical, 'proj')));
  fs.rmSync(folder, { recursive: true, force: true });
  assert.equal(fs.existsSync(folder), false);
  assert.equal(portfiles.instanceId(folder), before, 'deleted: the same id it had while it existed');
  assert.equal(portfiles.canonicalRoot(folder), path.join(physical, 'proj'));
  // Deeper missing remainders re-join as written, under the real anchor.
  assert.equal(portfiles.canonicalRoot(path.join(logical, 'a', 'b')), path.join(physical, 'a', 'b'));
});

test('a root spelled physically keeps today\'s id byte for byte (no stored id changes)', (t) => {
  const { physical } = linked(t);
  const proj = path.join(physical, 'proj');
  fs.mkdirSync(proj);
  for (const p of [physical, proj, fs.realpathSync.native(os.tmpdir()), '/']) {
    assert.equal(portfiles.canonicalRoot(p), path.resolve(p), p);
    assert.equal(portfiles.instanceId(p), headId(p), p);
  }
  // A physical root that does not exist (nothing to follow) hashes as before too.
  const gone = path.join(physical, 'never', 'made');
  assert.equal(portfiles.instanceId(gone), headId(gone));
  // A daemon's own record: the instance it stamps is HEAD's formula of its root.
  const rec = portfiles.writePortfileAt(path.join(proj, '.web-chat'), { pid: 999999, port: 5173 });
  assert.equal(rec.instance, headId(proj));
});

// A stand-in daemon on a port this test opened: /api/health answers as the
// daemon booted INSIDE the folder would — this pid, and the instance a daemon
// computes from process.cwd(), the physical spelling (HEAD's formula, by hand).
// Every other request is recorded and answered from `replies`.
async function standIn(t, physical, replies = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/health') {
      send({ ok: true, role: 'instance', pid: process.pid, instance: headId(physical), viewers: 0 });
      return;
    }
    const key = `${req.method} ${req.url.split('?')[0]}`;
    seen.push(key);
    send(replies[key] || { ok: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, seen };
}

test('daemonFor(the logical spelling) finds the daemon rooted at the physical one', async (t) => {
  for (const via of ['portfile', 'registry']) {
    await t.test(via, async (t) => {
      withTempHome(t);
      const { physical, logical } = linked(t);
      const { port } = await standIn(t, physical);
      // What the daemon itself writes, at its own (physical) root.
      if (via === 'portfile') portfiles.writePortfileAt(path.join(physical, '.web-chat'), { pid: process.pid, port });
      else registry.registerInstance({ root: physical, port, pid: process.pid });
      const found = await registry.daemonFor(logical, { timeoutMs: PORTFILE_PROBE_MS });
      assert.ok(found, `no daemon found through ${via}`);
      assert.deepEqual([found.pid, found.port, found.source], [process.pid, port, via]);
      // And the physical spelling finds the same one (the control).
      const direct = await registry.daemonFor(physical, { timeoutMs: PORTFILE_PROBE_MS });
      assert.deepEqual([direct.pid, direct.port], [process.pid, port]);
    });
  }
});

test('init (existing), pointed at the folder through the symlink, reports the daemon running and lists its approvals', async (t) => {
  withTempHome(t);
  const { physical, logical } = linked(t);
  const replies = {
    'GET /api/services/pending': { ok: true, pending: [{ name: 'deploy-board' }] },
    'GET /api/queue/policy': { channel_connected: false },
  };
  const { port, seen } = await standIn(t, physical, replies);
  portfiles.writePortfileAt(path.join(physical, '.web-chat'), { pid: process.pid, port });

  // init's report state, asked with the logical spelling.
  const { gatherState } = require('../lib/cli/init/state');
  const state = await gatherState({ root: logical, mode: 'test', deps: { collectRows: async () => [] } });
  assert.deepEqual(state.daemon, { running: true, port, url: `http://localhost:${port}` });

  // init itself, cwd the logical spelling (its seams, as portfile-consumers drives them).
  const init = require('../lib/cli/commands/init');
  const lines = [];
  const doctor = async () => ({ ok: 1, repaired: 0, problems: 0, checks: [] });
  await init([], {
    cwd: logical, log: (s) => lines.push(String(s)), doctor, hasClaude: () => false,
    collectRows: async () => [], reap: async () => ({ stopped: 0, cleared: 0, skipped: [] }),
    viewerWaitMs: 0, latest: null,
  });
  const text = lines.join('\n');
  assert.match(text, /1 service approval waiting:\n {2}claude-web-chat trust deploy-board/);
  assert.ok(seen.includes('GET /api/services/pending'), seen.join(', '));
});
