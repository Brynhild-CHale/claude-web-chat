// Two REAL daemons on one project root, and who is allowed to remove the
// portfile when they exit.
//
// `.web-chat/server.json` is the only thing mapping a project to its running
// daemon — the CLI, the browser and the MCP tools all resolve through it. It is
// a single shared record, so a second daemon on the same root overwrites it and
// the first is orphaned. The bug: gracefulShutdown then unlinked that file
// unconditionally, so when the ORPHAN eventually exited it tore down the LIVE
// daemon's record. What is left is the worst kind of running server — status
// says "not running", doctor reports no problems, stop has nothing to stop, and
// the daemon keeps serving and keeps writing the graph.
//
// Daemons are child processes because a real gracefulShutdown calls
// process.exit. They are booted the way test/stop-cli.test.js boots one — the
// production server on port 0 with start({writePortfile:false}), so the
// machine-wide side effects of the real boot (ensureHub on its fixed port, the
// ~/.web-chat instance registry, the 5173+ port walk) never run. The portfile is
// then written exactly as start() would have written it. The DELETE path under
// test is the production one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('node:events');
const portfiles = require('../lib/core/portfiles');

const REPO = path.resolve(__dirname, '..');

const REAL_DAEMON = `
const { createServer } = require(${JSON.stringify(path.join(REPO, 'lib/server'))});
const { writePortfile } = require(${JSON.stringify(path.join(REPO, 'lib/core/portfiles'))});
const root = process.env.WC_TEST_ROOT;
const srv = createServer({ root, port: 0 });
srv.start({ writePortfile: false }).then(() => {
  // Claim the record, exactly as start()'s own writePortfile call would. This is
  // the overwrite a second daemon on one root performs.
  writePortfile('server', { root, pid: process.pid, port: srv.port });
  srv.installSignalHandlers();
  if (process.send) process.send({ ready: true, port: srv.port });
});
`;

const kids = [];
function reapAll() {
  for (const c of kids.splice(0)) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
}
process.on('exit', reapAll);

const deadline = (ms) => Date.now() + ms;
async function until(pred, ms, what) {
  const by = deadline(ms);
  while (Date.now() < by) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Boot a production daemon into an EXISTING root, so two of them can share one.
async function bootInto(t, root, home) {
  const script = path.join(root, `daemon-${kids.length}.js`);
  fs.writeFileSync(script, REAL_DAEMON);
  const child = spawn(process.execPath, [script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, HOME: home, USERPROFILE: home, WC_TEST_ROOT: root },
  });
  kids.push(child);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });

  const msg = await Promise.race([
    once(child, 'message').then(([m]) => m),
    once(child, 'exit').then(() => { throw new Error(`daemon exited during boot: ${err}`); }),
  ]);
  // The record must name this daemon before the test proceeds.
  await until(
    () => { const r = portfiles.readPortfile('server', { root }); return r && r.pid === child.pid; },
    5000, `daemon ${child.pid} to claim the portfile`,
  );
  return { child, port: msg.port };
}

async function shutdown(child) {
  process.kill(child.pid, 'SIGTERM');
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('daemon did not exit within 8s')), 8000)),
  ]);
  return code;
}

test('an orphaned daemon does not delete the live daemon\'s portfile', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-own-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-own-'));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  t.after(() => {
    for (const d of [home, root]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  // Daemon A comes up and owns the record.
  const a = await bootInto(t, root, home);
  assert.equal(portfiles.readPortfile('server', { root }).pid, a.child.pid);

  // Daemon B comes up on the SAME root and takes the record over. A is now
  // orphaned: still serving, still writing this graph, but nothing points at it.
  const b = await bootInto(t, root, home);
  assert.notEqual(b.port, a.port, 'the two daemons hold different ports');
  const claimed = portfiles.readPortfile('server', { root });
  assert.equal(claimed.pid, b.child.pid, 'B owns the record');
  assert.equal(claimed.port, b.port);

  // The orphan exits. Its gracefulShutdown must leave B's record alone.
  assert.equal(await shutdown(a.child), 0, 'the orphan shut down cleanly');

  const after = portfiles.readPortfile('server', { root });
  assert.ok(after, 'the portfile survives the orphan (this is the regression)');
  assert.equal(after.pid, b.child.pid, 'and still names the live daemon');
  assert.equal(after.port, b.port);

  // The payoff: the live daemon is still discoverable the way every CLI command
  // and MCP tool discovers it — readPortfile, then a probe of the port it names.
  assert.equal(await portfiles.probeReachable(after.port, 1000), true,
    'the surviving daemon still answers on the port its record names');

  // …and the guard has not simply disabled deletion: the owner still clears up.
  assert.equal(await shutdown(b.child), 0, 'the live daemon shut down cleanly');
  assert.equal(portfiles.readPortfile('server', { root }), null,
    'the owner removes its own record on the way out');
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), false);
});
