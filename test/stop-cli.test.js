// `claude-web-chat stop` / `restart` against REAL processes.
//
// The bug being fixed: stop fired SIGTERM and polled for the portfile. It could
// not tell "gracefulShutdown drained, snapshotted the surface to draft.json and
// exited" from "died", and said so in its own failure text. These tests exercise
// all three paths against actual daemons — the acknowledged request, the SIGTERM
// fallback when the route is unreachable, and the escalation when a daemon acks
// and then wedges — and prove the draft survives the clean path.
//
// Daemons are spawned as child processes (a real gracefulShutdown calls
// process.exit, so it cannot run in the test runner). The real one is booted
// through createServer + start({writePortfile:false}) so it skips ensureHub and
// the cross-project registry: no hub on the machine's fixed port, no writes
// outside the sandbox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('node:events');
const { withServer } = require('../test-support/helpers');
const portfiles = require('../lib/core/portfiles');
const client = require('../lib/client');

const REPO = path.resolve(__dirname, '..');
const stop = require('../lib/cli/commands/stop');
const restart = require('../lib/cli/commands/restart');

// A real daemon: the production server, minus the portfile side-effects that
// reach outside the sandbox (hub spawn, ~/.web-chat instance registry).
// WC_TEST_REGISTER=1 adds the OTHER half of the daemon's claim — the
// ~/.web-chat instance registry entry that start() writes one line after the
// portfile and that release() drops one line after it — into the per-test HOME,
// so a test can assert that BOTH records were released.
const REAL_DAEMON = `
const path = require('path');
const { createServer } = require(${JSON.stringify(path.join(REPO, 'lib/server'))});
const { writePortfile } = require(${JSON.stringify(path.join(REPO, 'lib/core/portfiles'))});
const { registerInstance } = require(${JSON.stringify(path.join(REPO, 'lib/util/registry'))});
const root = process.env.WC_TEST_ROOT;
const srv = createServer({ root, port: 0 });
srv.start({ writePortfile: false }).then(() => {
  writePortfile('server', { root, pid: process.pid, port: srv.port });
  if (process.env.WC_TEST_REGISTER) {
    registerInstance({ root, port: srv.port, pid: process.pid, url: 'http://localhost:' + srv.port, title: 'stop-cli-test' });
  }
  srv.installSignalHandlers();
});
`;

// A stand-in daemon that is NOT the real server, used to force the fallback
// paths. WC_TEST_MODE:
//   deaf       — 404s /api/shutdown (an old daemon, or a broken one); SIGTERM works
//   ack        — acks /api/shutdown and then does nothing at all; SIGTERM works
//   unkillable — 404s, and ignores SIGTERM entirely
//   orphan     — 404s, and exits on SIGTERM WITHOUT dropping its portfile (the
//                shape a daemon leaves behind when it dies abruptly)
const STUB_DAEMON = `
const http = require('http');
const { writePortfileAt, deletePortfileAt } = require(${JSON.stringify(path.join(REPO, 'lib/core/portfiles'))});
const path = require('path');
const root = process.env.WC_TEST_ROOT;
const mode = process.env.WC_TEST_MODE;
const dir = path.join(root, '.web-chat');
const srv = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    // Alive and probe-able — this stands in for a daemon that is running fine
    // but cannot honour a shutdown REQUEST.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, role: 'instance', pid: process.pid }));
    return;
  }
  if (req.url === '/api/shutdown' && mode === 'ack') {
    res.setHeader('Connection', 'close');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, shutting_down: true, pid: process.pid }));
    return; // …and then wedge: never actually exit.
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'no such route' }));
});
srv.listen(0, '127.0.0.1', () => {
  writePortfileAt(dir, { pid: process.pid, port: srv.address().port });
});
if (mode === 'unkillable') process.on('SIGTERM', () => {});
else if (mode === 'orphan') process.on('SIGTERM', () => { process.exit(0); });
else process.on('SIGTERM', () => { deletePortfileAt(dir); process.exit(0); });
setInterval(() => {}, 1000);
`;

const kids = [];
function reapAll() {
  for (const c of kids.splice(0)) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
}
process.on('exit', reapAll);

// Boot a child daemon into a fresh sandboxed project root and wait until its
// portfile is present and its port answers.
async function bootDaemon(t, source, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stopcli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stopcli-home-'));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const script = path.join(root, 'daemon.js');
  fs.writeFileSync(script, source);

  const child = spawn(process.execPath, [script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, WC_TEST_ROOT: root, ...env },
  });
  kids.push(child);
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => {});

  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  const info = await portfiles.waitUntilReachable({ role: 'server', root, maxMs: 10_000 });
  assert.ok(info, `daemon never came up. stderr:\n${stderr}`);
  return { root, home, child, info, portfile: portfiles.portfilePathFor('server', root) };
}

function collector() {
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  log.lines = lines;
  log.text = () => lines.join('\n');
  return log;
}

// ── the clean path ─────────────────────────────────────────────────────────

test('stop: asks the daemon, gets an ack, and the draft survives the reboot', async (t) => {
  const { root, info, portfile } = await bootDaemon(t, REAL_DAEMON);

  // Uncommitted surface state — exactly what gracefulShutdown exists to save.
  await client.post('/api/render', { id: 'p1', html: '<div>unsaved work</div>' }, {
    port: info.port, root, noSpawn: true, timeout: 5_000,
  });

  const log = collector();
  const res = await stop([], { root, log });

  assert.equal(res.path, 'request', 'the acknowledged request path, not the signal');
  assert.equal(res.ok, true);
  assert.equal(res.pid, info.pid);
  assert.match(log.text(), /stopped cleanly/);
  assert.match(log.text(), /acknowledged/);
  assert.equal(fs.existsSync(portfile), false, 'a clean shutdown removes its own portfile');

  // The receipt has to be true, not just printed.
  const draftFile = path.join(root, '.web-chat', 'draft.json');
  assert.ok(fs.existsSync(draftFile), 'gracefulShutdown must have snapshotted the surface');
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  assert.equal(draft.mounts.length, 1);
  assert.equal(draft.mounts[0].id, 'p1');

  // And the next boot restores it.
  const { api } = await withServer(t, { root });
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.mounts.map((m) => m.id), ['p1']);
});

test('stop: does not resurrect a daemon it just stopped, and reports nothing to stop', async (t) => {
  const { root } = await bootDaemon(t, REAL_DAEMON);
  await stop([], { root, log: collector() });

  const log = collector();
  const res = await stop([], { root, log });
  assert.equal(res.path, 'none');
  assert.match(log.text(), /no server running/);
  // `stop` must never spawn: lib/client's auto-spawn is opt-in and this path
  // never opts in. A resurrected daemon would leave a live portfile behind.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(portfiles.readPortfile('server', { root }), null);
});

// ── the fallback paths ─────────────────────────────────────────────────────

test('stop: falls back to SIGTERM when the shutdown route is unreachable', async (t) => {
  const { root, info, portfile } = await bootDaemon(t, STUB_DAEMON, { WC_TEST_MODE: 'deaf' });

  const log = collector();
  const res = await stop([], { root, log });

  assert.equal(res.path, 'signal');
  assert.equal(res.ok, true);
  assert.equal(res.pid, info.pid);
  assert.match(log.text(), /shutdown request failed/);
  assert.match(log.text(), /falling back to SIGTERM/);
  // The honesty requirement: a signal stop must NOT claim a clean snapshot.
  assert.doesNotMatch(log.text(), /stopped cleanly/);
  assert.match(log.text(), /not guaranteed/);
  assert.equal(fs.existsSync(portfile), false);
});

test('stop: escalates to SIGTERM when a daemon acks and then wedges', async (t) => {
  const { root, portfile } = await bootDaemon(t, STUB_DAEMON, { WC_TEST_MODE: 'ack' });

  const log = collector();
  // Short ack window: the real one is 40s, sized to outlast the daemon's own
  // 30s turn-lock drain so a healthy shutdown is never interrupted.
  const res = await stop([], { root, log, ackWaitMs: 600 });

  assert.equal(res.path, 'signal');
  assert.equal(res.ok, true);
  assert.match(log.text(), /acknowledged the shutdown but is still running/);
  assert.match(log.text(), /escalating to SIGTERM/);
  assert.equal(fs.existsSync(portfile), false);
});

test('stop: a daemon that survives both is reported as a failure, not a success', async (t) => {
  const { root, info, portfile } = await bootDaemon(t, STUB_DAEMON, { WC_TEST_MODE: 'unkillable' });

  const log = collector();
  const res = await stop([], { root, log, signalWaitMs: 600 });

  assert.equal(res.ok, false, 'the old code printed a maybe; this returns a definite no');
  assert.match(log.text(), /survived both a shutdown request and SIGTERM/);
  assert.match(log.text(), new RegExp(`kill -9 ${info.pid}`));
  assert.equal(fs.existsSync(portfile), true, 'and the portfile is still there, as reported');
});

// ── restart reuses the same engine ─────────────────────────────────────────

test('restart: stops via the acknowledged request, then starts', async (t) => {
  const { root } = await bootDaemon(t, REAL_DAEMON);

  let started = 0;
  const log = collector();
  const res = await restart([], { root, log, start: async () => { started++; } });

  assert.equal(res.ok, true);
  assert.equal(res.stopped.path, 'request', 'restart must not re-implement stopping');
  assert.equal(started, 1);
});

test('restart: refuses to start on top of a daemon it could not stop', async (t) => {
  const { root } = await bootDaemon(t, STUB_DAEMON, { WC_TEST_MODE: 'unkillable' });

  let started = 0;
  const log = collector();
  const res = await restart([], { root, log, signalWaitMs: 600, start: async () => { started++; } });

  assert.equal(res.ok, false);
  assert.equal(started, 0, 'starting here would race the survivor for the port and the portfile');
  assert.match(log.text(), /restart aborted/);
});

// ── a signal landing on a shutdown that is already running ─────────────────
//
// The escalation path above has a trap of its own. `stop` waits out the
// daemon's worst case and then SIGTERMs — and the signal handler ran the same
// gracefulShutdown the ack had already started. A boolean re-entrancy guard made
// that second entry resolve INSTANTLY, and every caller follows its await with
// process.exit(), so the signal exited the daemon mid-shutdown: `release()` at
// the end of gracefulShutdown never ran, and the daemon left a stale portfile
// and a stale registry entry behind. `stop` then found the portfile still there
// and reported a shutdown that had in fact succeeded as "survived both a
// shutdown request and SIGTERM", advising `kill -9` on a pid that no longer
// existed — and, if that pid had been recycled, on a stranger's process.
//
// Reproducing it needs the shutdown to still be in flight when the signal lands.
// In the wild that is the 30 s turn-lock drain (a stop issued from inside a live
// Claude turn, which is exactly when a developer swaps builds); here it is a
// browser that never answers the close frame, which pins the final
// server.close() — the same "still working" state, reachable in a second.

// A tab that has gone deaf: a raw socket that completes the WebSocket upgrade
// and then ignores everything, close frame included.
function deafBrowser(t, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on('data', (d) => { if (/101/.test(d.toString().slice(0, 16))) resolve(sock); });
    sock.on('error', reject);
    t.after(() => { try { sock.destroy(); } catch {} });
  });
}

function instancesIn(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.web-chat', 'instances.json'), 'utf8')).instances || [];
  } catch { return []; }
}

test('stop: a SIGTERM landing mid-shutdown must not truncate it — no stale records', async (t) => {
  const { root, home, info, child, portfile } = await bootDaemon(t, REAL_DAEMON, { WC_TEST_REGISTER: '1' });
  assert.ok(instancesIn(home).some((e) => e.pid === child.pid), 'the daemon claimed its registry entry');

  // Uncommitted surface state: the thing gracefulShutdown exists to save, and
  // the thing a truncated shutdown is at risk of losing.
  await client.post('/api/render', { id: 'p1', html: '<div>unsaved work</div>' }, {
    port: info.port, root, noSpawn: true, timeout: 5_000,
  });
  await deafBrowser(t, info.port);

  const exited = once(child, 'exit');
  const log = collector();
  // A deliberately short ack budget so the escalation fires while the daemon is
  // still legitimately working. `stop`'s real budget is 40s for the same reason
  // in reverse: it outlasts the daemon's worst case.
  const res = await stop([], { root, log, ackWaitMs: 300, signalWaitMs: 8_000 });
  await exited;

  assert.equal(fs.existsSync(portfile), false, 'the daemon released its portfile on the way out');
  assert.equal(instancesIn(home).some((e) => e.pid === child.pid), false, 'and its registry entry');
  assert.ok(fs.existsSync(path.join(root, '.web-chat', 'draft.json')), 'and still wrote the draft snapshot');
  assert.equal(res.ok, true, 'a shutdown that worked is not reported as a failure');
  assert.doesNotMatch(log.text(), /survived both/);
  assert.doesNotMatch(log.text(), /kill -9/, 'never advise killing a pid that is already gone');
});

// `stop`'s reporting, against a daemon that dies without releasing. "Portfile
// present" is not the same fact as "daemon running", and conflating them is how
// a correct shutdown got reported as a wedge — with advice (`kill -9 <pid>`)
// that is noise at best and, once the OS has recycled that pid, aimed at
// somebody else's process.
test('stop: a daemon that exits without releasing is reaped, not called a survivor', async (t) => {
  const { root, info, child, portfile } = await bootDaemon(t, STUB_DAEMON, { WC_TEST_MODE: 'orphan' });
  const exited = once(child, 'exit');

  const log = collector();
  const res = await stop([], { root, log, signalWaitMs: 1_200 });
  await exited;

  assert.equal(portfiles.isPidAlive(info.pid), false, 'the daemon really is gone');
  assert.equal(fs.existsSync(portfile), false, 'stop reaps the record its dead owner left behind');
  assert.equal(res.ok, true, 'the server is stopped — reporting that as a failure breaks restart');
  assert.doesNotMatch(log.text(), /survived both/);
  assert.doesNotMatch(log.text(), /kill -9/, 'never advise killing a pid that is not running');
  assert.match(log.text(), /not guaranteed/, 'and still say the draft snapshot is not guaranteed');
});
