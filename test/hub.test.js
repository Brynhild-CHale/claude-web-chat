const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

// ~/.web-chat (the registry + the hub portfile) is redirected by
// test-support/sandbox, which helpers loads before any lib module resolves
// homedir; the registry tests below take a per-test home on top so they cannot
// see each other's entries.
const { withServer, withHub, withTempHome, waitUntil } = require('../test-support/helpers');
const { registerInstance, deregisterInstance, readInstances, instanceId, registerHub, deregisterHub, readHubEntry, readAllLive } = require('../lib/util/registry');
const { HUB_PROTOCOL_VERSION, probeHub, probeHubHealth, ensureHub } = require('../lib/util/hub');

const HTML = '<html><head><title>T</title></head><body><p>SECRET-MARKER hello</p></body></html>';

test('registry: register, prune dead pids, deregister', async (t) => {
  withTempHome(t);
  const rootLive = path.join(os.tmpdir(), 'wc-live');
  const rootDead = path.join(os.tmpdir(), 'wc-dead');
  registerInstance({ root: rootLive, port: 1, pid: process.pid, title: 'live' });
  registerInstance({ root: rootDead, port: 2, pid: 2 ** 30, title: 'dead' }); // pid that can't be alive

  const live = readInstances();
  assert.equal(live.length, 1, 'dead-pid entry pruned on read');
  assert.equal(live[0].id, instanceId(rootLive));

  deregisterInstance(rootLive);
  assert.equal(readInstances().length, 0);
});

test('registry: hub entry registers/reads/deregisters and never shows as an instance', async (t) => {
  withTempHome(t);
  const rootI = path.join(os.tmpdir(), 'wc-withhub');
  registerInstance({ root: rootI, port: 7, pid: process.pid, title: 'inst' });
  registerHub({ port: 5170, pid: process.pid });

  // The hub is its own role — invisible to the instance view, visible via readHubEntry.
  assert.equal(readInstances().length, 1, 'hub not counted as an instance');
  assert.equal(readInstances()[0].id, instanceId(rootI));
  const hub = readHubEntry();
  assert.ok(hub && hub.id === 'hub' && hub.role === 'hub');
  assert.equal(hub.root, null);
  assert.equal(hub.port, 5170);
  // Both live entries are in the full view.
  assert.equal(readAllLive().length, 2);

  // Re-registering the hub upserts (still exactly one hub entry).
  registerHub({ port: 5170, pid: process.pid });
  assert.equal(readAllLive().filter((e) => e.role === 'hub').length, 1);

  deregisterHub();
  assert.equal(readHubEntry(), null);
  assert.equal(readInstances().length, 1, 'deregistering the hub leaves instances intact');

  deregisterInstance(rootI);
  assert.equal(readAllLive().length, 0);
});

test('registry: tolerant read — a legacy entry with no role is an instance, never a hub', async (t) => {
  // Simulate an entry written by a build predating the role/version fields — the
  // sole cross-version safety for this user-scope file (no migration runner). It
  // must read back as an instance (role || 'instance') and never as the hub.
  const home = withTempHome(t);
  const root = path.join(home, 'legacy-proj');
  const id = instanceId(root);
  const regPath = path.join(home, '.web-chat', 'instances.json');
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify({ instances: [
    { id, root, title: 'legacy', port: 9, pid: process.pid, url: 'http://localhost:9', started_at: 1 },
  ] }));

  const insts = readInstances();
  assert.equal(insts.length, 1, 'roleless entry counted as an instance');
  assert.equal(insts[0].id, id);
  assert.equal(readHubEntry(), null, 'a roleless entry is never surfaced as the hub');

  deregisterInstance(root);
  assert.equal(readAllLive().length, 0);
});

test('hub: lists instances and routes a capture to the chosen one', async (t) => {
  // Two instances in ONE home: the first withServer mints the per-test home and
  // the second joins it, so both registrations and the hub's read of them are the
  // same throwaway registry.
  const A = await withServer(t);
  const B = await withServer(t);
  // Register manually (tests bypass start(), which is what normally registers).
  registerInstance({ root: A.root, port: A.port, pid: process.pid, title: 'projA' });
  registerInstance({ root: B.root, port: B.port, pid: process.pid, title: 'projB' });

  const H = (await withHub(t)).api;

  // list
  const list = await H.get('/api/instances');
  assert.equal(list.status, 200);
  assert.equal(list.json.instances.length, 2);
  assert.ok(list.json.instances.every((i) => i.pid === undefined), 'pid not leaked to browser');
  const idA = instanceId(A.root);

  // ambiguous → 409
  const amb = await H.post('/api/capture', { url: 'http://x', title: 'X', html: HTML });
  assert.equal(amb.status, 409);

  // routed to A
  const routed = await H.post('/api/capture', { instance: idA, url: 'http://a', title: 'A', html: HTML });
  assert.equal(routed.status, 200);
  assert.equal(routed.json.ok, true);
  assert.equal(routed.json.instance.id, idA);

  // landed in A, not B
  const capsA = await A.api.get('/api/captures');
  const capsB = await B.api.get('/api/captures');
  assert.equal(capsA.json.captures.length, 1);
  assert.equal(capsB.json.captures.length, 0);
  assert.equal(capsA.json.captures[0].source, 'ext:tab-stream');

  // bad id → 404
  const bad = await H.post('/api/capture', { instance: 'nope', url: 'http://x', title: 'X', html: HTML });
  assert.equal(bad.status, 404);

  // lone instance: deregister B, omit instance → routes to A implicitly
  deregisterInstance(B.root);
  const lone = await H.post('/api/capture', { url: 'http://a2', title: 'A2', html: HTML });
  assert.equal(lone.status, 200);
  assert.equal(lone.json.instance.id, idA);
});

test('hub: health reports role hub + protocol version; probes read it', async (t) => {
  const { api, port } = await withHub(t);
  const h = await api.get('/api/health');
  assert.equal(h.json.role, 'hub');
  assert.equal(h.json.ok, true);
  // The version drives ensureHub's self-heal: a hub older than this gets bounced.
  assert.equal(h.json.version, HUB_PROTOCOL_VERSION);
  assert.ok(HUB_PROTOCOL_VERSION >= 2, 'profile-match landed in v2');

  // probeHub stays a boolean; probeHubHealth exposes the parsed health (incl. version).
  assert.equal(await probeHub(port), true);
  const health = await probeHubHealth(port);
  assert.equal(health.role, 'hub');
  assert.equal(health.version, HUB_PROTOCOL_VERSION);

  // A non-hub / dead port → false / null.
  assert.equal(await probeHub(1), false);
  assert.equal(await probeHubHealth(1), null);
});

// Deliberately NOT withHub: this asks the OS for a port NUMBER that nothing is
// listening on, then gives it back — there is no server to own.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

test('hub: self-closes when the registry stays empty past the grace window', async (t) => {
  // Fresh HOME → empty registry. Tiny grace/poll so the test is quick. The hub
  // under test is a SUBPROCESS (start() calls process.exit, so it cannot be
  // exercised in-process), which is why this one does not use withHub.
  const home = withTempHome(t);
  const port = await freePort();
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat.js');
  const child = spawn(process.execPath, [bin, 'hub', 'run'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_HUB_PORT: String(port), WEB_CHAT_HUB_IDLE_MS: '200', WEB_CHAT_HUB_POLL_MS: '80' },
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  if (result === 'timeout') { child.kill(); assert.fail('hub did not self-close on empty registry'); }
  assert.equal(result, 0, 'hub exited cleanly');
  // The hub self-registers into the registry (not a hub.json) and must deregister
  // on self-close. Read the subprocess's own HOME registry raw.
  const regPath = path.join(home, '.web-chat', 'instances.json');
  const entries = fs.existsSync(regPath) ? (JSON.parse(fs.readFileSync(regPath, 'utf8')).instances || []) : [];
  assert.equal(entries.find((e) => e.role === 'hub'), undefined, 'hub deregistered from the registry on self-close');
  assert.ok(!fs.existsSync(path.join(home, '.web-chat', 'hub.json')), 'no legacy hub.json written');
});

// A minimal fake hub that reports an OLD protocol version (1) and writes the
// portfile — stands in for a long-running daemon from before a protocol bump.
const FAKE_V1_HUB = `
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const port=+process.env.WEB_CHAT_HUB_PORT;
const dir=path.join(os.homedir(),'.web-chat');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'hub.json'),JSON.stringify({pid:process.pid,port,url:'http://localhost:'+port}));
const s=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,role:'hub',version:1,pid:process.pid,port}));});
s.listen(port);
process.on('SIGTERM',()=>{try{fs.unlinkSync(path.join(dir,'hub.json'));}catch(e){} s.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),300);});
`;

test('hub: ensureHub bounces a stale (old-protocol) hub; a current one takes over', async (t) => {
  const home = withTempHome(t);
  const port = await freePort();
  assert.notEqual(port, 5170, 'must never touch the real default-port hub');

  // Bring up a fake v1 hub on the fixed port (writes its own portfile in `home`).
  const fake = spawn(process.execPath, ['-e', FAKE_V1_HUB], {
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_HUB_PORT: String(port) },
    stdio: 'ignore',
  });
  const fakeExited = new Promise((r) => fake.on('exit', () => r()));
  try {
    const h = await waitUntil(async () => {
      const probed = await probeHubHealth(port);
      return probed && probed.version === 1 ? probed : false;
    }, { timeout: 4000, interval: 50 });
    assert.ok(h, 'fake v1 hub answering');

    // ensureHub sees the stale version, SIGTERMs it, waits for the port, respawns.
    const prevPort = process.env.WEB_CHAT_HUB_PORT;
    const prevIdle = process.env.WEB_CHAT_HUB_IDLE_MS;
    process.env.WEB_CHAT_HUB_PORT = String(port);
    process.env.WEB_CHAT_HUB_IDLE_MS = '30000'; // keep the freshly-spawned real hub alive through the test
    let info;
    try {
      info = await ensureHub({ maxMs: 8000 });
    } finally {
      if (prevPort === undefined) delete process.env.WEB_CHAT_HUB_PORT; else process.env.WEB_CHAT_HUB_PORT = prevPort;
      if (prevIdle === undefined) delete process.env.WEB_CHAT_HUB_IDLE_MS; else process.env.WEB_CHAT_HUB_IDLE_MS = prevIdle;
    }
    assert.ok(info, 'ensureHub brought up a hub');

    // Same port now answers as a CURRENT-protocol hub → the stale one was replaced.
    const after = await probeHubHealth(port);
    assert.ok(after && after.version === HUB_PROTOCOL_VERSION, 'a current-protocol hub now answers on the fixed port');
    await Promise.race([fakeExited, new Promise((r) => setTimeout(r, 2000))]); // the stale hub was bounced

    // Cleanup: kill the real hub ensureHub spawned and wait for the port to free.
    // Its pid comes from the registry now (ensureHub spawns it under this
    // process's HOME, so readHubEntry reads the registry it self-registered in).
    const real = readHubEntry();
    if (real && real.pid) { try { process.kill(real.pid, 'SIGTERM'); } catch {} }
    await waitUntil(async () => !(await probeHub(port)), { timeout: 4000, interval: 50 });
  } finally {
    try { fake.kill('SIGKILL'); } catch {}
  }
});
