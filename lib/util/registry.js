const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userPaths } = require('../core/paths');
const { isPidAlive, deletePortfile, probeReachable } = require('../core/portfiles');
const { PROTOCOL_VERSION } = require('../core/versions');

// Cross-project registry of running web-chat instances. Each daemon upserts its
// own entry on start (keyed by project root) and removes it on graceful
// shutdown; reads prune any entry whose pid is no longer alive, so a crashed
// daemon self-heals out of the list. This is the source of truth the hub reads
// to enumerate instances and resolve a forward target — decoupling the hub's
// lifecycle from the instances' (the hub can restart and immediately see them).
//
// Ownership: an entry is REMOVED under the same tri-state `pid` rule the portfile
// uses (see removeEntry below) — two daemons can share one root, and the one that
// leaves must not tear down the record of the one that stayed. release({root,pid})
// applies that rule to both records at once; it is the only thing gracefulShutdown
// should call.
//
// Concurrency: registration is a read-modify-write with an atomic rename. Two
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

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(data.instances) ? data.instances : [];
  } catch {
    return [];
  }
}

function writeRaw(instances) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ instances }, null, 2));
  fs.renameSync(tmp, p);
}

// The RAW, unpruned view — every entry the file holds, including ones whose pid
// is gone. readAllLive below is the pruning reader every routing consumer wants;
// this one exists because a classification cannot report "dead" about a record
// the read already deleted. Only rows() and the reap paths should want it.
function readAllEntries() {
  return readRaw().filter(Boolean);
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

// THE ownership rule for a registry entry — the same tri-state `pid` contract
// lib/core/portfiles.deletePortfileFile applies to the portfile, because the two
// records describe the same fact ("which daemon serves this root") and are
// released one line apart in gracefulShutdown. `pid` says whose record the
// caller believes this is:
//   undefined  unguarded (legacy callers, and the tests that pin them)
//   <number>   mine — remove it, unless a different, still-live process has
//              since taken the entry over
//   null       I own nothing — reap only if the process it names is gone
// A missing entry is not an error; it points at nobody. Returns whether an entry
// was actually removed.
function removeEntry(matches, pid) {
  const all = readRaw();
  const rec = all.find((e) => e && matches(e));
  if (!rec) return false;
  if (pid !== undefined && rec.pid !== pid && isPidAlive(rec.pid)) return false;
  const remaining = all.filter((e) => !(e && matches(e)));
  try { writeRaw(remaining); } catch { return false; }
  return true;
}

function deregisterInstance(root, { pid } = {}) {
  const id = instanceId(root);
  return removeEntry((e) => e.id === id, pid);
}

// Both records for one project root, removed under ONE rule. The portfile
// (<root>/.web-chat/server.json) and the registry entry (~/.web-chat/instances.json)
// are two halves of the same claim; releasing them through two functions with two
// different ownership rules is how an orphaned daemon's exit used to delete the
// live daemon's entry while correctly leaving its portfile alone. Reports what it
// actually removed.
function release({ root, pid } = {}) {
  let portfile = false;
  try { portfile = deletePortfile('server', { root, pid }); } catch {}
  let registry = false;
  try { registry = deregisterInstance(root, { pid }); } catch {}
  return { portfile, registry };
}

// One honest classification of every instance the registry holds, read RAW so a
// dead-pid record can be reported as dead instead of silently vanishing. This is
// the machine inventory `ls` prints and `init` renders inside its orientation
// report — answered in exactly one place. `pid_alive` says a process with that
// pid exists (not that it is ours); `reachable` says a web-chat daemon answered
// on the port the entry names, which is the only fact worth acting on.
async function rows({ probe = true, timeoutMs = 400, role = 'instance' } = {}) {
  let entries = [];
  try { entries = readAllEntries().filter((e) => (e.role || 'instance') === role); } catch {}
  const out = [];
  for (const e of entries) {
    const pidAlive = isPidAlive(e.pid);
    let reachable = false;
    if (pidAlive && probe && e.port) {
      try { reachable = await probeReachable(e.port, timeoutMs); } catch {}
    }
    out.push({ ...e, pid_alive: pidAlive, reachable });
  }
  return out;
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

// Same rule as deregisterInstance, on the single id:'hub' entry. The hub has no
// portfile (Phase 6 folded hub.json into this registry) and no root, so it gets
// the guard but not release()'s two-record shape.
function deregisterHub({ pid } = {}) {
  return removeEntry((e) => e.id === 'hub', pid);
}

module.exports = {
  registryPath,
  instanceId,
  readAllEntries,
  readAllLive,
  readInstances,
  rows,
  readHubEntry,
  registerInstance,
  deregisterInstance,
  registerHub,
  deregisterHub,
  release,
};
