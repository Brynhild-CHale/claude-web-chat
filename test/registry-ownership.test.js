// The per-user registry entry's ownership rule — the twin of test/portfile.test.js.
//
// `~/.web-chat/instances.json` and `<root>/.web-chat/server.json` record the same
// fact ("which daemon serves this root") and are released one line apart in
// gracefulShutdown. The portfile learned a tri-state `pid` contract; the registry
// entry had none, so an orphaned daemon's exit correctly left the live daemon's
// portfile alone and then deleted its registry entry — `ls`, `doctor` and the
// capture hub's routing all lost the running server.
//
// These pin the same five arms on the registry half, plus release()'s two-record
// shape. HOME is redirected before the modules read it, so nothing here touches
// the developer's real registry.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-reghome-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const registry = require('../lib/util/registry');
const portfiles = require('../lib/core/portfiles');

// A pid that cannot be alive: above the platform maximum on every supported OS.
const DEAD_PID = 2 ** 30;

// Everything made under os.tmpdir() goes away with the process, fake HOME first.
const MADE = [FAKE_HOME];
process.on('exit', () => {
  for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-reg-${name}-`));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  MADE.push(dir);
  return dir;
}

function reset() {
  try { fs.rmSync(path.join(FAKE_HOME, '.web-chat', 'instances.json'), { force: true }); } catch {}
}

test('registry: a departing daemon may not remove an entry a different live process owns', () => {
  reset();
  const root = project('foreign');
  // B took the entry over; A (a made-up pid that is NOT the entry's) departs.
  registry.registerInstance({ root, port: 5199, pid: process.pid, title: 'B' });
  const removed = registry.deregisterInstance(root, { pid: DEAD_PID });
  assert.equal(removed, false, 'refused: the entry names a different, still-live process');
  assert.equal(registry.readInstances().length, 1, "B's entry survives");
  assert.equal(registry.readInstances()[0].pid, process.pid);
});

test('registry: the owner still removes its own entry', () => {
  reset();
  const root = project('mine');
  registry.registerInstance({ root, port: 5199, pid: process.pid, title: 'mine' });
  assert.equal(registry.deregisterInstance(root, { pid: process.pid }), true);
  assert.equal(registry.readAllEntries().length, 0);
});

test('registry: pid:null reaps an entry whose process is gone, and spares a live one', () => {
  reset();
  const dead = project('dead');
  const live = project('live');
  // Live first: registerInstance drops dead-pid others as it writes, so the
  // ghost has to be the last one in.
  registry.registerInstance({ root: live, port: 5202, pid: process.pid, title: 'live' });
  registry.registerInstance({ root: dead, port: 5201, pid: DEAD_PID, title: 'dead' });

  // pid:null — "I own nothing; reap only what names a dead process" (doctor's
  // case, and the case `ls --reap`/`init` use on another project's ghost).
  assert.equal(registry.deregisterInstance(dead, { pid: null }), true, 'ghost entry reaped');
  assert.equal(registry.deregisterInstance(live, { pid: null }), false, 'live entry spared');
  assert.equal(registry.readAllEntries().length, 1);
  assert.equal(registry.readAllEntries()[0].pid, process.pid);
});

test('registry: an omitted pid stays unconditional (the legacy callers)', () => {
  reset();
  const root = project('legacy');
  registry.registerInstance({ root, port: 5203, pid: process.pid, title: 'legacy' });
  assert.equal(registry.deregisterInstance(root), true, 'no pid => no guard');
  assert.equal(registry.readAllEntries().length, 0);
});

test('registry: removing an entry that is not there is false, not an error', () => {
  reset();
  assert.equal(registry.deregisterInstance(project('absent'), { pid: process.pid }), false);
});

test('registry: the hub entry carries the same guard', () => {
  reset();
  registry.registerHub({ port: 5170, pid: process.pid });
  assert.equal(registry.deregisterHub({ pid: DEAD_PID }), false, 'a foreign live hub entry is left alone');
  assert.ok(registry.readHubEntry(), 'still there');
  assert.equal(registry.deregisterHub({ pid: process.pid }), true, 'its owner removes it');
  assert.equal(registry.readHubEntry(), null);
});

test('registry: a singleton role (the tunnel portal) is its own entry, beside the hub and instances', () => {
  reset();
  const root = project('beside');
  registry.registerInstance({ root, port: 5206, pid: process.pid, title: 'inst' });
  registry.registerHub({ port: 5170, pid: process.pid });
  const e = registry.registerRole('portal', { port: 5171, pid: process.pid });
  assert.equal(e.id, 'portal');
  assert.equal(e.role, 'portal');
  assert.equal(e.root, null);
  assert.equal(e.url, 'http://localhost:5171');

  assert.equal(registry.readRoleEntry('portal').port, 5171);
  assert.equal(registry.readRoleEntry('hub').port, 5170, 'the hub entry is untouched');
  assert.equal(registry.readHubEntry().port, 5170, 'the hub wrapper reads the same entry');
  assert.deepEqual(registry.readInstances().map((i) => i.title), ['inst'],
    'neither singleton reads as an instance — the hub and resolveTarget must never route to the portal');

  // Re-registering upserts: one entry per role, never two.
  registry.registerRole('portal', { port: 5271, pid: process.pid });
  assert.equal(registry.readAllEntries().filter((x) => x.role === 'portal').length, 1);
  assert.equal(registry.readRoleEntry('portal').port, 5271);
});

test('registry: a singleton role carries the same removal guard, and drops a dead predecessor', () => {
  reset();
  registry.registerRole('portal', { port: 5171, pid: DEAD_PID });
  assert.equal(registry.readRoleEntry('portal'), null, 'a dead-pid portal entry reads as absent');

  registry.registerRole('portal', { port: 5171, pid: process.pid });
  assert.equal(registry.deregisterRole('portal', { pid: DEAD_PID }), false, 'a foreign live portal entry is left alone');
  assert.ok(registry.readRoleEntry('portal'));
  assert.equal(registry.deregisterRole('hub', { pid: process.pid }), false, 'a role that is not there is false');
  assert.equal(registry.deregisterRole('portal', { pid: process.pid }), true, 'its owner removes it');
  assert.equal(registry.readRoleEntry('portal'), null);
});

test('registry: registerRole refuses the per-project role (instances are keyed by root, not by role)', () => {
  reset();
  assert.throws(() => registry.registerRole('instance', { port: 1, pid: process.pid }), /not a singleton role/);
  assert.throws(() => registry.registerRole('', { port: 1, pid: process.pid }), /not a singleton role/);
  assert.equal(registry.readAllEntries().length, 0);
});

test('registry: release() applies one rule to BOTH records and reports what it removed', () => {
  reset();
  const root = project('release');
  registry.registerInstance({ root, port: 5204, pid: process.pid, title: 'r' });
  portfiles.writePortfile('server', { root, pid: process.pid, port: 5204 });

  // A foreign departing pid touches neither half.
  let out = registry.release({ root, pid: DEAD_PID });
  assert.deepEqual(out, { portfile: false, registry: false });
  assert.ok(portfiles.readPortfile('server', { root, checkLiveness: false }));
  assert.equal(registry.readAllEntries().length, 1);

  // The owner clears both.
  out = registry.release({ root, pid: process.pid });
  assert.deepEqual(out, { portfile: true, registry: true });
  assert.equal(portfiles.readPortfile('server', { root, checkLiveness: false }), null);
  assert.equal(registry.readAllEntries().length, 0);
});

test('registry: readAllEntries sees the ghost readInstances prunes away', () => {
  reset();
  const dead = project('ghost');
  registry.registerInstance({ root: dead, port: 5205, pid: DEAD_PID, title: 'ghost' });
  assert.equal(registry.readAllEntries().length, 1, 'the raw view keeps the evidence');
  assert.equal(registry.readInstances().length, 0, 'the routing view still prunes on read');
  // …and the prune persisted, which the hub's idle monitor depends on.
  assert.equal(registry.readAllEntries().length, 0);
});
