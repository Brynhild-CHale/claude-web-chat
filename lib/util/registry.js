const path = require('path');
const crypto = require('crypto');
const { userPaths } = require('../core/paths');
const { writeJsonAtomic, readJsonOr } = require('../core/fsjson');
const { isPidAlive } = require('../core/portfiles');
const { PROTOCOL_VERSION } = require('../core/versions');

// Cross-project registry of running web-chat instances. Each daemon upserts its
// own entry on start (keyed by project root) and removes it on graceful
// shutdown; reads prune any entry whose pid is no longer alive, so a crashed
// daemon self-heals out of the list. This is the source of truth the hub reads
// to enumerate instances and resolve a forward target — decoupling the hub's
// lifecycle from the instances' (the hub can restart and immediately see them).
//
// Concurrency: registration is a read-modify-write over lib/core/fsjson's atomic
// write (each write is whole; the read-modify-write around it is not). Two
// daemons starting in the same millisecond could in theory clobber each other;
// for local single-user dogfood that race is acceptable, and prune-on-read keeps
// the file from drifting for long.

function registryPath() {
  return userPaths().instances;
}

// Stable per-project id: short hash of the absolute root. Survives restarts (the
// port may change, the id does not) and can't collide on basename the way a
// bare directory name would.
function instanceId(root) {
  return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
}

// Absent and corrupt both read as "no instances registered": a daemon that
// cannot read the registry must still boot, and prune-on-write reconverges the
// file. The shape check is the `validate` predicate, so an `instances` key that
// is not an array is rejected here rather than being spread into a caller.
function readRaw() {
  return readJsonOr(registryPath(), { instances: [] }, { validate: (d) => d && Array.isArray(d.instances) }).instances;
}

function writeRaw(instances) {
  return writeJsonAtomic(registryPath(), { instances });
}

// Live entries of EVERY role (instances + the hub). Prunes dead-pid entries and
// persists the pruned list when it actually shrank, so the file converges without
// a dedicated reaper. The full registry view; readInstances/readHubEntry project
// the role each consumer wants.
function readAllLive() {
  const all = readRaw();
  const live = all.filter((e) => e && isPidAlive(e.pid));
  if (live.length !== all.length) {
    try { writeRaw(live); } catch {}
  }
  return live;
}

// Live instances only. `role` defaults to 'instance' for entries written by a
// build predating the field (tolerant reading — the only cross-version safety for
// this user-scope file, which can't use the project-scope migration runner). This
// is the default view every existing caller uses: the hub's listing,
// resolveTarget, and the idle monitor.
function readInstances() {
  return readAllLive().filter((e) => (e.role || 'instance') === 'instance');
}

// The single live hub entry (id:'hub', role:'hub'), or null.
function readHubEntry() {
  return readAllLive().find((e) => e.role === 'hub') || null;
}

function registerInstance({ root, port, pid, url, title }) {
  const id = instanceId(root);
  const entry = {
    id,
    role: 'instance',
    version: PROTOCOL_VERSION,
    root: path.resolve(root),
    title: title || path.basename(path.resolve(root)),
    port,
    pid,
    url: url || `http://localhost:${port}`,
    started_at: Date.now(),
  };
  const others = readRaw().filter((e) => e && e.id !== id && isPidAlive(e.pid));
  try { writeRaw([...others, entry]); } catch {}
  return entry;
}

function deregisterInstance(root) {
  const id = instanceId(root);
  const remaining = readRaw().filter((e) => e && e.id !== id);
  try { writeRaw(remaining); } catch {}
}

// The hub is a registry entry like any instance, distinguished by role:'hub' and
// the fixed id:'hub' (it has no project root, so root:null). One per machine, so
// registering upserts the single 'hub' entry, dropping any dead-pid predecessor.
function registerHub({ port, pid, url }) {
  const entry = {
    id: 'hub',
    role: 'hub',
    version: PROTOCOL_VERSION,
    root: null,
    port,
    pid,
    url: url || `http://localhost:${port}`,
    started_at: Date.now(),
  };
  const others = readRaw().filter((e) => e && e.id !== 'hub' && isPidAlive(e.pid));
  try { writeRaw([...others, entry]); } catch {}
  return entry;
}

function deregisterHub() {
  const remaining = readRaw().filter((e) => e && e.id !== 'hub');
  try { writeRaw(remaining); } catch {}
}

module.exports = {
  registryPath,
  instanceId,
  readAllLive,
  readInstances,
  readHubEntry,
  registerInstance,
  deregisterInstance,
  registerHub,
  deregisterHub,
};
