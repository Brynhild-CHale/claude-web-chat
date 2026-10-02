const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userPaths, projectPaths, isHomeDir } = require('../core/paths');
const { writeJsonAtomic, readJsonOr } = require('../core/fsjson');
const { isPidAlive, deletePortfile, probeReachable } = require('../core/portfiles');
const { PROTOCOL_VERSION, packageVersion, compareVersions } = require('../core/versions');

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
// Concurrency: every change is a read-modify-write over lib/core/fsjson's atomic
// write, and the atomic write makes each WRITE whole, not the sequence — so each
// sequence runs under the registry's write lock (withRegistryLock below). The
// file has a writer per daemon, the hub, the portal, one per Claude Code session
// and any reader that prunes; unlocked, two that read before either wrote each
// wrote back a list without the other's row.
//
// Roles: 'instance' (a daemon, one per project root), 'hub' (one per machine) and
// 'mcp' (one per live Claude Code session — see "MCP presence" below). All three
// live in the file's one `instances` array; every reader projects the role it
// wants, so readInstances() and rows() still see daemons only.

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

// ── the write lock ──────────────────────────────────────────────────────────
// instances.json.lock, beside the file: created O_EXCL ('wx') holding the
// holder's pid, unlinked the moment the write is done. Every read-modify-write
// of instances.json — and of projects.json, which registerInstance writes in the
// same breath — runs inside withRegistryLock, re-reading the file there, so no
// writer can write back a list read before another writer's change.
//
// It must never be how a daemon boot, a CLI command or a Claude Code session
// start hangs, so both ends are bounded:
//   * a lock whose holder's pid is gone, or older than LOCK_STALE_MS (a write
//     holds it for well under a millisecond), is stale: it is broken — one
//     waiter at a time, under a claim (breakIfStale below) — and the break is
//     said on stderr (the daemon's and hub's logs, Claude Code's MCP log, a
//     CLI's terminal);
//   * a writer still waiting after LOCK_WAIT_MS writes WITHOUT the lock — the
//     unlocked behaviour this replaced — and says so there too.
// The wait sleeps with Atomics.wait, because every writer here is synchronous
// (presence's exit handler included), and that same synchrony makes a depth
// count the whole of the in-process part: registerInstance holds the lock
// across both files and rememberProjects takes it again underneath.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 5000;
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
let lockDepth = 0;

function lockNote(msg) {
  try { process.stderr.write(`web-chat registry: ${msg}\n`); } catch {}
}

// What a lockfile is, as far as telling two of them apart goes: a stale lock
// broken and a new one created in its place can reuse the inode number.
function lockPrint(file) {
  const st = fs.statSync(file);
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch {}
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, body };
}

function samePrint(a, b) {
  return !!(a && b) && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.body === b.body;
}

// Why the lock (or break claim) printed as `print` is stale, or null while it
// is live: its holder's pid is gone, or it is older than LOCK_STALE_MS.
function staleness(print) {
  const pid = Number.parseInt(print.body, 10);
  if (pid > 0 && !isPidAlive(pid)) return `its holder, pid ${pid}, is gone`;
  const age = Date.now() - print.mtimeMs;
  if (age > LOCK_STALE_MS) return `it is ${Math.round(age / 1000)}s old`;
  return null;
}

// Create `file` O_EXCL holding this process's pid: { file, print } for
// releaseLock. Throws what openSync throws — EEXIST while someone holds it.
function createLockFile(file) {
  const fd = fs.openSync(file, 'wx');
  let print = null;
  try {
    fs.writeSync(fd, `${process.pid}\n`);
    const st = fs.fstatSync(fd);
    print = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {} finally {
    try { fs.closeSync(fd); } catch {}
  }
  return { file, print };
}

// Break the lock at `file` if it is stale. true: it is gone (broken here, or
// released or broken by someone else meanwhile) — try again at once; false: it
// is live, or another waiter is breaking it — wait.
//
// A file is removed by NAME, and the name may by then hold a different lock
// from the one judged: two waiters that both judge one dead lock is the
// ordinary case, and the first breaks it and takes the lock before the second
// acts. The second used to move that FRESH lock aside to check it, which left
// the path empty for a moment — a third writer took the lock there, the fresh
// one could not go back, and it was deleted: two writers inside the lock at
// once. So a break is claimed first, with `<lock>.break` created O_EXCL
// like the lock itself: one waiter at a time breaks. Under the claim the lock
// is looked at again, and only the very lock that was judged — same inode,
// mtime and holder — is moved. No other waiter can move it meanwhile (that
// takes the claim), and a dead holder cannot release it, so what is moved is
// the stale lock.
function breakIfStale(file) {
  let seen;
  try { seen = lockPrint(file); } catch (e) { return !!(e && e.code === 'ENOENT'); }
  const why = staleness(seen);
  if (!why) return false;
  const claim = takeClaim(file);
  if (!claim) return false;
  try {
    return removeIfUnchanged(file, seen, why);
  } finally {
    releaseLock(claim);
  }
}

// The break claim, or null: another waiter holds it (wait), or it had been
// abandoned and was just cleared (the next turn claims it).
function takeClaim(file) {
  const claimFile = `${file}.break`;
  try {
    return createLockFile(claimFile);
  } catch (e) {
    if (e && e.code === 'EEXIST') clearAbandonedClaim(claimFile);
    return null;
  }
}

// A claim whose breaker died mid-break would block every break after it, so a
// claim goes stale by the lock's own rule and is removed the same way — but
// unclaimed, since claiming it would recurse. Two waiters clearing one
// abandoned claim while a third takes a fresh one is the race above again, one
// level down, and it needs a breaker to have died inside its microseconds first.
function clearAbandonedClaim(claimFile) {
  let seen;
  try { seen = lockPrint(claimFile); } catch { return; }
  const why = staleness(seen);
  if (why) removeIfUnchanged(claimFile, seen, why);
}

// Remove `file` if it is still exactly what `seen` printed. true: it is gone;
// false: it is someone else's now. It is moved aside before it is deleted and
// what moved is checked. Under the claim that check cannot fail for a dead
// holder; it can for a LIVE one judged stale by age alone, which may release
// its lock in the instant between the look and the move, letting a writer take
// a new one. What moved is then that writer's: it is put back (link refuses if
// yet another lock is there by then), and if it cannot go back it is KEPT
// aside, and said — it is a live writer's lock, never ours to delete.
function removeIfUnchanged(file, seen, why) {
  let now;
  try { now = lockPrint(file); } catch (e) { return !!(e && e.code === 'ENOENT'); }
  if (!samePrint(now, seen)) return false;
  const aside = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(file, aside); } catch (e) { return !!(e && e.code === 'ENOENT'); }
  let moved = null;
  try { moved = lockPrint(aside); } catch {}
  if (samePrint(moved, seen)) {
    try { fs.unlinkSync(aside); } catch {}
    lockNote(`broke a stale ${path.basename(file)} (${why})`);
    return true;
  }
  try {
    fs.linkSync(aside, file);
  } catch {
    lockNote(`moved a live ${path.basename(file)} aside and another writer took the lock before it could go back; kept it as ${path.basename(aside)}`);
    return false;
  }
  try { fs.unlinkSync(aside); } catch {}
  return false;
}

// Take the lock, or return null after saying why the write goes ahead without it.
function acquireLock() {
  const file = userPaths().instancesLock;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let madeDir = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return createLockFile(file);
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT' && !madeDir) {
        madeDir = true;
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
        continue;
      }
      if (code !== 'EEXIST') {
        lockNote(`cannot create ${path.basename(file)} (${code || e}); writing without it`);
        return null;
      }
      if (breakIfStale(file)) continue;
      const left = deadline - Date.now();
      if (left <= 0) {
        lockNote(`${path.basename(file)} still held after ${LOCK_WAIT_MS}ms; writing without it`);
        return null;
      }
      const backoff = Math.min(50, 2 ** Math.min(attempt, 6)) * (0.5 + Math.random());
      Atomics.wait(SLEEPER, 0, 0, Math.max(1, Math.min(left, backoff)));
    }
  }
}

// Unlink the lock (or a break claim) only while it is still the one this
// writer created: one broken as stale (a writer stopped for longer than
// LOCK_STALE_MS) belongs to whoever holds its replacement now.
function releaseLock(held) {
  if (!held) return;
  try {
    const st = fs.statSync(held.file);
    const p = held.print;
    if (p && (st.dev !== p.dev || st.ino !== p.ino || st.mtimeMs !== p.mtimeMs)) return;
    fs.unlinkSync(held.file);
  } catch {}
}

// Run `fn` holding the registry's write lock (reentrant). `fn` must re-read
// what it changes: a read taken before the lock is exactly the lost update.
function withRegistryLock(fn) {
  if (lockDepth > 0) {
    lockDepth++;
    try { return fn(); } finally { lockDepth--; }
  }
  const held = acquireLock();
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    releaseLock(held);
  }
}

// A read-modify-write of instances.json under the lock. `plan(all)` gets a
// fresh read and returns the list to write, or null to leave the file alone.
// Returns whether it wrote; a failed write throws, for the caller to swallow.
// Callers that may have nothing to change run `plan` once on an unlocked read
// first, so a no-op (a prune with nothing dead, a removal of an absent row)
// neither takes the lock nor creates ~/.web-chat to hold it.
function rewriteRegistry(plan) {
  return withRegistryLock(() => {
    const next = plan(readRaw());
    if (!next) return false;
    writeRaw(next);
    return true;
  });
}

// The RAW, unpruned view — every entry the file holds, including ones whose pid
// is gone. readAllLive below is the pruning reader every routing consumer wants;
// this one exists because a classification cannot report "dead" about a record
// the read already deleted. Only rows() and the reap paths should want it.
function readAllEntries() {
  return readRaw().filter(Boolean);
}

// Is the process an entry names still there? A daemon or hub is alive while its
// pid is. An MCP presence row (role:'mcp', below) also records the Claude Code
// process that spawned it (`ppid`): when that parent is gone the session is over
// even if the child has not noticed yet — and after an unclean exit the child's
// pid is the one the OS recycles first. ppid <= 1 means "already orphaned when it
// registered", which says nothing about a session, so it is not consulted.
function isLive(e) {
  if (!e || !isPidAlive(e.pid)) return false;
  if (e.role === 'mcp' && Number.isInteger(e.ppid) && e.ppid > 1 && !isPidAlive(e.ppid)) return false;
  return true;
}

// Live entries of EVERY role (instances, the hub, MCP presence rows). Prunes
// dead entries and persists the pruned list when it actually shrank, so the file
// converges without a dedicated reaper. The full registry view;
// readInstances/readHubEntry/readMcpEntries project the role each consumer wants.
// The prune is a write like any other: under the lock, from a fresh read, so it
// cannot drop a row registered since the read that noticed the dead one.
function readAllLive() {
  const all = readRaw();
  const live = all.filter(isLive);
  if (live.length !== all.length) {
    try {
      rewriteRegistry((cur) => {
        const kept = cur.filter(isLive);
        return kept.length !== cur.length ? kept : null;
      });
    } catch {}
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

function registerInstance({ root, port, pid, url, title }) {
  const id = instanceId(root);
  const entry = {
    id,
    role: 'instance',
    version: PROTOCOL_VERSION,
    // `version` above is the WIRE protocol (the hub/portal self-heal keys on
    // it); this is the web-chat release the daemon runs, the one a person reads.
    package_version: packageVersion(),
    root: path.resolve(root),
    title: title || path.basename(path.resolve(root)),
    port,
    pid,
    url: url || `http://localhost:${port}`,
    started_at: Date.now(),
  };
  // One lock across both files: a daemon booting beside another must neither
  // drop its row from instances.json nor its project from projects.json.
  withRegistryLock(() => {
    const others = readRaw().filter((e) => e && e.id !== id && isLive(e));
    try { writeRaw([...others, entry]); } catch {}
    // A daemon booting is also what makes a project KNOWN (below) — one call
    // site, so a surface can never be live without being remembered. The other
    // daemons running beside it are remembered too: a build predating the known
    // list (0.7.x) registers here but never calls rememberProject, so without
    // this backfill a project whose old daemon is still up would drop off every
    // list the moment it stopped.
    const peers = others.filter((e) => (e.role || 'instance') === 'instance' && typeof e.root === 'string');
    try { rememberProjects([...peers, entry], entry.started_at); } catch {}
  });
  return entry;
}

// ── known projects ──────────────────────────────────────────────────────────
// The registry above holds only what is RUNNING: a daemon's entry leaves with
// it. ~/.web-chat/projects.json remembers every project whose daemon has ever
// booted here, so a stopped one can still be listed (ls --all, the Sessions
// panel's Inactive group, the portal picker) — and the portal can start one,
// by id, from this list only: it is the allowlist that keeps "start a project"
// from ever meaning "start a path a request named".
//
//   { projects: [{ id, root, title, last_seen_at, package_version? }] }   id = instanceId(root)
//
// `package_version` is the web-chat release that project's daemon last booted
// under — what an inactive row can still say about it.
//
// Upserted on every daemon boot (registerInstance), for the booting project and
// every other daemon then running. An entry whose root is gone, no longer has a
// .web-chat/ (uninstalled), or is $HOME (isKnowable) is pruned on read and the
// file rewritten. sessions() is the only reader; everything else asks it.

function knownPath() {
  return userPaths().projects;
}

function readKnownRaw() {
  const list = readJsonOr(knownPath(), { projects: [] }, { validate: (d) => d && Array.isArray(d.projects) }).projects;
  return list.filter((e) => e && typeof e.root === 'string' && path.isAbsolute(e.root));
}

function hasProjectDir(root) {
  try { return fs.statSync(projectPaths(root).dir).isDirectory(); } catch { return false; }
}

// May this directory be a known project? It must hold an initialised
// .web-chat/, and it must not be $HOME — whose .web-chat/ is the USER tier
// (versions/, this registry), present on every machine, so "has a .web-chat/"
// proves nothing there. A daemon an old `update` booted in ~ used to land on
// this list for good: the directory check could never prune it, and the portal
// would start a surface rooted at the home directory for a remote viewer.
function isKnowable(root) {
  return !isHomeDir(root) && hasProjectDir(root);
}

// Upsert several projects in one write. Anything isKnowable refuses is
// skipped, never recorded. Returns the entries written.
function rememberProjects(list, now = Date.now()) {
  const fresh = new Map();
  for (const p of list || []) {
    if (!p || typeof p.root !== 'string') continue;
    const abs = path.resolve(p.root);
    if (!isKnowable(abs)) continue;
    const id = instanceId(abs);
    const e = { id, root: abs, title: p.title || path.basename(abs), last_seen_at: now };
    if (isVersionString(p.package_version)) e.package_version = p.package_version;
    fresh.set(id, e);
  }
  if (!fresh.size) return [];
  const roots = new Set([...fresh.values()].map((e) => e.root));
  withRegistryLock(() => {
    const others = readKnownRaw().filter((e) => !fresh.has(e.id) && !roots.has(e.root));
    writeJsonAtomic(knownPath(), { projects: [...others, ...fresh.values()] });
  });
  return [...fresh.values()];
}

function rememberProject({ root, title, now = Date.now(), package_version }) {
  return rememberProjects([{ root, title, package_version }], now)[0] || null;
}

// The pruning read. Private: sessions() is its one caller.
function readKnown() {
  let all = [];
  try { all = readKnownRaw(); } catch { return []; }
  const kept = all.filter((e) => isKnowable(e.root));
  if (kept.length !== all.length) {
    // Rewritten from a fresh read under the lock, so the prune cannot drop a
    // project a booting daemon remembered since the read above.
    try {
      withRegistryLock(() => {
        const cur = readKnownRaw();
        const next = cur.filter((e) => isKnowable(e.root));
        if (next.length !== cur.length) writeJsonAtomic(knownPath(), { projects: next });
      });
    } catch {}
  }
  return kept;
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
  const plan = (all) => {
    const rec = all.find((e) => e && matches(e));
    if (!rec) return null;
    if (pid !== undefined && rec.pid !== pid && isPidAlive(rec.pid)) return null;
    return all.filter((e) => !(e && matches(e)));
  };
  if (!plan(readRaw())) return false;
  try { return rewriteRegistry(plan); } catch { return false; }
}

// Remove the entry carrying this id, under removeEntry's rule. Every entry has
// one — it is what the writer keyed the record by — so this is the removal that
// still works when the entry's `root` is missing (a hand-edited or legacy
// record), where re-deriving the id from the root cannot.
function deregisterById(id, { pid } = {}) {
  if (!id) return false;
  return removeEntry((e) => e.id === id, pid);
}

function deregisterInstance(root, { pid } = {}) {
  return deregisterById(instanceId(root), { pid });
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

// A SINGLETON role — one per machine, with no project root — is a registry entry
// like any instance, distinguished by its `role` and a fixed `id` equal to it
// (root:null). The hub was the first; the tunnel portal (lib/portal) is the
// second, and it is the same record with a different name, so both go through
// these three instead of a pasted copy each. Registering upserts the single
// entry for that role, dropping any dead-pid predecessor.
function registerRole(role, { port, pid, url }) {
  if (!role || role === 'instance') throw new Error(`registerRole: '${role}' is not a singleton role`);
  const entry = {
    id: role,
    role,
    version: PROTOCOL_VERSION,
    root: null,
    port,
    pid,
    url: url || `http://localhost:${port}`,
    started_at: Date.now(),
  };
  try { rewriteRegistry((all) => [...all.filter((e) => e && e.id !== role && isLive(e)), entry]); } catch {}
  return entry;
}

// The single live entry for a singleton role, or null.
function readRoleEntry(role) {
  return readAllLive().find((e) => e.role === role) || null;
}

// ── MCP presence ────────────────────────────────────────────────────────────
// Claude Code spawns ONE web-chat MCP server per session, at session start, and
// kills it at exit — so that process's life IS the session's presence. It says
// so here (role:'mcp', one row per MCP pid, keyed `mcp:<pid>` so it can never
// collide with an 8-hex instance id or the hub) without spawning or even
// needing a daemon: a session that never called a tool is still a session.
// Written by lib/mcp/presence.js; read by sessions() below. `channel` is whether
// that session's channel bridge currently holds a wake stream open;
// `last_tool_at` is best-effort (throttled by the writer).

function mcpId(pid) {
  return `mcp:${pid}`;
}

function registerMcp({ root, pid = process.pid, ppid = process.ppid, channel = false, package_version = packageVersion() }) {
  const entry = {
    id: mcpId(pid),
    role: 'mcp',
    version: PROTOCOL_VERSION,
    // The release THIS MCP server process loaded at session start. It is fixed
    // for the process's life: a session started before an `update` keeps
    // running the old one until Claude Code restarts it — which is exactly what
    // versionSkew() below exists to say.
    package_version,
    root: path.resolve(root),
    pid,
    ppid,
    started_at: Date.now(),
    channel: Boolean(channel),
  };
  try { rewriteRegistry((all) => [...all.filter((e) => e && e.id !== entry.id && isLive(e)), entry]); } catch {}
  return entry;
}

// Merge `patch` into this pid's presence row. Only the fields the writer owns
// move; a row that is not there (never registered, or already deregistered on
// the way out) is left absent rather than resurrected half-filled.
function updateMcp(pid, patch = {}) {
  const id = mcpId(pid);
  const plan = (all) => {
    const i = all.findIndex((e) => e && e.id === id);
    if (i < 0) return null;
    const next = { ...all[i] };
    if ('channel' in patch) next.channel = Boolean(patch.channel);
    if (Number.isFinite(patch.last_tool_at)) next.last_tool_at = patch.last_tool_at;
    const out = all.slice();
    out[i] = next;
    return out.filter(Boolean);
  };
  if (!plan(readRaw())) return false;
  try { return rewriteRegistry(plan); } catch { return false; }
}

// Same ownership rule as every other removal: a pid-keyed row is its own.
function deregisterMcp({ pid = process.pid } = {}) {
  return deregisterById(mcpId(pid), { pid });
}

function readMcpEntries() {
  return readAllLive().filter((e) => e.role === 'mcp');
}

// ── sessions: the machine-wide "who is here" classifier ─────────────────────
// One row per project root that has a live daemon OR a live Claude Code session
// (an MCP presence row), answered from the registry alone — no probing, so it
// is cheap and synchronous and works with every daemon down:
//
//   { root, title,
//     surface: { running, port, url, pid, started_at, package_version } | null,   // null: no daemon
//     claude:  { sessions, channel, pids, started_at, last_tool_at, package_versions } | null,
//     version_skew }
//
// Versions are the web-chat RELEASE (package.json), never the protocol number
// the entries' `version` carries: `surface.package_version` is the daemon's (as
// the registry recorded it; enrichSessions replaces it with what the daemon
// says), `claude.package_versions` is `[{version, sessions}]` over the sessions
// that recorded one, and `version_skew` (versionSkew below) is non-null when a
// Claude session runs a different release than the surface it talks to.
//
// `claude.started_at` is the OLDEST live session's start (how long this project
// has had Claude attached); `last_tool_at` the newest tool call any of them made.
// What only the daemon knows (viewers, the turn lock, the active node) is a
// separate async step, enrichSessions, so a caller that wants the fast answer
// never pays for a probe.
//
// `entries` lets a caller classify a list it already read (ls reads the file RAW
// once, so it can still report dead records — this reader would prune them).
//
// Known projects (above) join the same way: every row carries `known` (its
// root is on the known list, so the portal may start it), and a known project
// with neither a daemon nor a Claude session is a row of its own — INACTIVE,
// `surface: null, claude: null, known: true` — unless `inactive: false`.
// isInactive() names that shape for the readers that group or hide it.
function sessions({ entries, inactive = true } = {}) {
  let live = entries;
  if (!live) { try { live = readAllLive(); } catch { live = []; } }
  const known = readKnown();
  const knownRoots = new Set(known.map((k) => k.root));
  const byRoot = new Map();
  const rowFor = (root) => {
    const key = path.resolve(root);
    if (!byRoot.has(key)) byRoot.set(key, { root: key, title: path.basename(key), surface: null, claude: null, known: knownRoots.has(key) });
    return byRoot.get(key);
  };
  for (const e of live) {
    if (!e || !e.root) continue;
    const role = e.role || 'instance';
    if (role === 'instance') {
      const row = rowFor(e.root);
      if (e.title) row.title = e.title;
      row.surface = { running: true, port: e.port, url: e.url || `http://localhost:${e.port}`, pid: e.pid, started_at: e.started_at || null,
        package_version: isVersionString(e.package_version) ? e.package_version : null };
    } else if (role === 'mcp') {
      const row = rowFor(e.root);
      const c = row.claude || (row.claude = { sessions: 0, channel: false, pids: [], started_at: null, last_tool_at: null, package_versions: [] });
      c.sessions++;
      c.pids.push(e.pid);
      if (isVersionString(e.package_version)) {
        const seen = c.package_versions.find((x) => x.version === e.package_version);
        if (seen) seen.sessions++; else c.package_versions.push({ version: e.package_version, sessions: 1 });
      }
      if (e.channel) c.channel = true;
      if (Number.isFinite(e.started_at) && (c.started_at == null || e.started_at < c.started_at)) c.started_at = e.started_at;
      if (Number.isFinite(e.last_tool_at) && (c.last_tool_at == null || e.last_tool_at > c.last_tool_at)) c.last_tool_at = e.last_tool_at;
    }
  }
  if (inactive) {
    for (const k of known) {
      if (byRoot.has(k.root)) continue;
      const row = rowFor(k.root);
      if (k.title) row.title = k.title;
      row.last_seen_at = Number.isFinite(k.last_seen_at) ? k.last_seen_at : null;
      row.last_package_version = isVersionString(k.package_version) ? k.package_version : null;
    }
  }
  for (const row of byRoot.values()) {
    if (row.claude) row.claude.package_versions.sort((a, b) => compareVersions(b.version, a.version));
    row.version_skew = versionSkew(row);
  }
  return [...byRoot.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)) || a.root.localeCompare(b.root));
}

// A known project with nothing running: no daemon, no Claude session.
function isInactive(row) {
  return !!(row && !row.surface && !row.claude && row.known);
}

// A release string worth showing: non-empty, short, printable. The registry is
// a user-writable file, so a field is checked before any listing repeats it.
function isVersionString(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[\x21-\x7e]+$/.test(v);
}

// What a daemon too old to name its release is reported as: `surface` in a
// version skew, and ls's VERSION cell. 0.8.0 added `package_version` to both
// the registry row and GET /api/health; a daemon with neither is a 0.7.x one.
const LEGACY_BUILD = '<0.8';

// Does a Claude session on this row run a different web-chat release than the
// surface it talks to? The common case is an `update`: the daemon restarts onto
// the new release, while every Claude Code session started before it keeps the
// MCP server it loaded at startup. Returns null when there is nothing to say
// (no surface version, no Claude version, or they all agree), else
//   { surface, sessions, stale: [{ version, sessions, restart }] }
// where `restart` names the side that is BEHIND — 'claude' (restart Claude Code)
// or 'surface' (restart the daemon) — and a tie in ordering (two dev builds of
// one release) reads as Claude's, the cheaper thing to restart.
//
// A surface enrichSessions found to be a pre-0.8 build (`legacy_build`) is the
// post-upgrade case exactly: every other project's 0.7.x daemon, with a
// reopened 0.8 Claude session whose write_markdown 404s there. It has no
// release to compare, but every Claude version recorded is newer (only 0.8+
// MCP servers write one), so the skew is the same shape with `surface` set to
// LEGACY_BUILD and every stale entry naming the surface as the side behind.
function versionSkew(row) {
  const sv = row && row.surface && row.surface.package_version;
  const list = row && row.claude && row.claude.package_versions;
  if (!Array.isArray(list)) return null;
  if (!isVersionString(sv) && row.surface && row.surface.legacy_build) {
    const stale = list.filter((x) => x && isVersionString(x.version))
      .map((x) => ({ version: x.version, sessions: x.sessions, restart: 'surface' }));
    return stale.length ? { surface: LEGACY_BUILD, sessions: row.claude.sessions, stale } : null;
  }
  if (!isVersionString(sv)) return null;
  const stale = list.filter((x) => x && x.version !== sv).map((x) => ({
    version: x.version,
    sessions: x.sessions,
    restart: compareVersions(x.version, sv) > 0 ? 'surface' : 'claude',
  }));
  return stale.length ? { surface: sv, sessions: row.claude.sessions, stale } : null;
}

// versionSkew as one sentence — THE wording, so `ls`, the Sessions panel and
// the tunnel picker say the same thing. null when there is no skew.
function versionNote(skew) {
  if (!skew || !Array.isArray(skew.stale) || !skew.stale.length) return null;
  const sv = skew.surface === LEGACY_BUILD ? 'a build older than 0.8' : `v${skew.surface}`;
  return skew.stale.map((x) => {
    const cv = `v${x.version}`;
    if (x.restart === 'surface') {
      return `the surface is on ${sv}, Claude on ${cv} — run \`claude-web-chat restart\` in this project to pick up ${cv}`;
    }
    if (x.sessions >= skew.sessions) return `Claude is on ${cv} — restart Claude Code to pick up ${sv}`;
    return `${x.sessions} of ${skew.sessions} Claude sessions ${x.sessions === 1 ? 'is' : 'are'} on ${cv} — restart ${x.sessions === 1 ? 'it' : 'them'} to pick up ${sv}`;
  }).join('; ');
}

// What a running daemon knows that the registry cannot: probe each row's
// surface on GET /api/health (never spawning, short timeout) and fold in
//   surface.reachable     a web-chat daemon answered AS the pid the registry names
//   surface.viewers       connected browsers
//   surface.turn          'mid-turn' (a prompt's lock) | 'wake' (a channel wake's) | null
//   surface.turn_started_at
//   surface.active_label  the active node's hierarchical label (n1.7)
//   surface.last_commit_at newest node's created_at
//   surface.package_version the release the daemon says it runs (a daemon
//                         predating the field keeps what the registry recorded)
//   surface.legacy_build  true when neither says: a daemon that answers but
//                         names no release anywhere is a pre-0.8 build
// and recompute version_skew from it. An unreachable daemon is reported, never
// dropped: reachable:false and the rest absent. Returns new row objects; the
// input is not mutated.
//
// Deliberately NOT a fallback to GET /api/version (which stale-daemon's
// runningBuild uses to name the exact 0.7.x release): that route may refresh
// the GitHub release cache first, and this runs on every Sessions-panel poll
// and every portal picker load. "Older than 0.8" is all a listing needs to say
// which side to restart.
async function enrichSessions(list, { timeoutMs = 600, get } = {}) {
  const fetchHealth = get || require('../client').get;
  return Promise.all((list || []).map(async (row) => {
    if (!row.surface) return row;
    const surface = { ...row.surface, reachable: false };
    try {
      const h = await fetchHealth('/api/health', { port: row.surface.port, root: row.root, noSpawn: true, timeout: timeoutMs });
      if (h && h.ok && (h.pid == null || h.pid === row.surface.pid)) {
        surface.reachable = true;
        surface.viewers = Number.isFinite(h.viewers) ? h.viewers : null;
        const lock = h.lock && !h.lock_stale ? h.lock : null;
        surface.turn = lock ? (lock.author === 'wake' ? 'wake' : 'mid-turn') : null;
        surface.turn_started_at = lock && Number.isFinite(lock.started_at) ? lock.started_at : null;
        surface.active_label = h.active_label || null;
        surface.last_commit_at = Number.isFinite(h.last_commit_at) ? h.last_commit_at : null;
        if (isVersionString(h.package_version)) surface.package_version = h.package_version;
        else if (h.package_version == null && !isVersionString(surface.package_version)) surface.legacy_build = true;
      }
    } catch {}
    const next = { ...row, surface };
    next.version_skew = versionSkew(next);
    return next;
  }));
}

// Same rule as deregisterInstance, on the single id:<role> entry. A singleton
// has no portfile and no root, so it gets the guard but not release()'s
// two-record shape.
function deregisterRole(role, { pid } = {}) {
  return deregisterById(role, { pid });
}

// The hub's names, kept: every caller and test that speaks them still means
// exactly this. (Phase 6 folded hub.json into this registry.)
function registerHub(opts) { return registerRole('hub', opts); }
function readHubEntry() { return readRoleEntry('hub'); }
function deregisterHub(opts) { return deregisterRole('hub', opts); }


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
  deregisterById,
  registerHub,
  deregisterHub,
  registerRole,
  readRoleEntry,
  deregisterRole,
  release,
  isLive,
  mcpId,
  registerMcp,
  updateMcp,
  deregisterMcp,
  readMcpEntries,
  sessions,
  enrichSessions,
  isInactive,
  versionSkew,
  versionNote,
  LEGACY_BUILD,
  rememberProject,
  knownPath,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  // Exported for test/registry-lock.test.js, which drives a break step by step.
  breakIfStale,
};
