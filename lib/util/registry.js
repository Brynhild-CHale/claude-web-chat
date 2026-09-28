const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userPaths, projectPaths } = require('../core/paths');
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
// Concurrency: registration is a read-modify-write over lib/core/fsjson's atomic
// write (each write is whole; the read-modify-write around it is not). Two
// daemons starting in the same millisecond could in theory clobber each other;
// for local single-user dogfood that race is acceptable, and prune-on-read keeps
// the file from drifting for long.
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
function readAllLive() {
  const all = readRaw();
  const live = all.filter(isLive);
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
  const others = readRaw().filter((e) => e && e.id !== id && isLive(e));
  try { writeRaw([...others, entry]); } catch {}
  // A daemon booting is also what makes a project KNOWN (below) — one call
  // site, so a surface can never be live without being remembered.
  try { rememberProject({ root: entry.root, title: entry.title, now: entry.started_at, package_version: entry.package_version }); } catch {}
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
// Upserted on every daemon boot (registerInstance). An entry whose root is gone,
// or no longer has a .web-chat/ (uninstalled), is pruned on read and the file
// rewritten. sessions() is the only reader; everything else asks it.

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

function rememberProject({ root, title, now = Date.now(), package_version }) {
  const abs = path.resolve(root);
  const id = instanceId(abs);
  const entry = { id, root: abs, title: title || path.basename(abs), last_seen_at: now };
  if (isVersionString(package_version)) entry.package_version = package_version;
  const others = readKnownRaw().filter((e) => e.id !== id && e.root !== abs);
  writeJsonAtomic(knownPath(), { projects: [...others, entry] });
  return entry;
}

// The pruning read. Private: sessions() is its one caller.
function readKnown() {
  let all = [];
  try { all = readKnownRaw(); } catch { return []; }
  const kept = all.filter((e) => hasProjectDir(e.root));
  if (kept.length !== all.length) {
    try { writeJsonAtomic(knownPath(), { projects: kept }); } catch {}
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
  const all = readRaw();
  const rec = all.find((e) => e && matches(e));
  if (!rec) return false;
  if (pid !== undefined && rec.pid !== pid && isPidAlive(rec.pid)) return false;
  const remaining = all.filter((e) => !(e && matches(e)));
  try { writeRaw(remaining); } catch { return false; }
  return true;
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
  const others = readRaw().filter((e) => e && e.id !== role && isLive(e));
  try { writeRaw([...others, entry]); } catch {}
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
  const others = readRaw().filter((e) => e && e.id !== entry.id && isLive(e));
  try { writeRaw([...others, entry]); } catch {}
  return entry;
}

// Merge `patch` into this pid's presence row. Only the fields the writer owns
// move; a row that is not there (never registered, or already deregistered on
// the way out) is left absent rather than resurrected half-filled.
function updateMcp(pid, patch = {}) {
  const id = mcpId(pid);
  const all = readRaw();
  const i = all.findIndex((e) => e && e.id === id);
  if (i < 0) return false;
  const next = { ...all[i] };
  if ('channel' in patch) next.channel = Boolean(patch.channel);
  if (Number.isFinite(patch.last_tool_at)) next.last_tool_at = patch.last_tool_at;
  all[i] = next;
  try { writeRaw(all.filter(Boolean)); } catch { return false; }
  return true;
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

// Does a Claude session on this row run a different web-chat release than the
// surface it talks to? The common case is an `update`: the daemon restarts onto
// the new release, while every Claude Code session started before it keeps the
// MCP server it loaded at startup. Returns null when there is nothing to say
// (no surface version, no Claude version, or they all agree), else
//   { surface, sessions, stale: [{ version, sessions, restart }] }
// where `restart` names the side that is BEHIND — 'claude' (restart Claude Code)
// or 'surface' (restart the daemon) — and a tie in ordering (two dev builds of
// one release) reads as Claude's, the cheaper thing to restart.
function versionSkew(row) {
  const sv = row && row.surface && row.surface.package_version;
  const list = row && row.claude && row.claude.package_versions;
  if (!isVersionString(sv) || !Array.isArray(list)) return null;
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
  const sv = `v${skew.surface}`;
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
// and recompute version_skew from it. An unreachable daemon is reported, never
// dropped: reachable:false and the rest absent. Returns new row objects; the
// input is not mutated.
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
  rememberProject,
  knownPath,
};
