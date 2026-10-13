const { resolveRoot, remove, isRegistered } = require('../../setup/registration');
const { describeInstall, listVersions, removeInstall } = require('../../update/install-layout');
const { installPaths } = require('../../core/paths');
const path = require('path');
const portfiles = require('../../core/portfiles');
const registry = require('../../util/registry');
const { readRoleEntry, mcpSessionsFor } = registry;
const { reap, stopRow } = require('../reap');
const stop = require('./stop');

// `--self` removes the PROGRAM as well as this project's wiring: the
// ~/.local/bin symlinks and every unpacked release under ~/.web-chat/versions/.
// It is opt-in because the common case is "stop using web-chat in this repo",
// not "get it off my machine" — and because the program removing itself while
// running deserves an explicit ask. Per-user state (~/.web-chat/themes,
// services/trusted.json, the update-check cache) and every project's .web-chat/
// graph data are left alone; the summary says where they are.
function uninstallSelf(log) {
  const paths = installPaths();
  const info = describeInstall({ paths });
  const versions = listVersions(paths);

  if (info.kind === 'dev') {
    log('');
    log(`Not removing ${info.packageRoot} — that is a git checkout, not a managed install.`);
    log('  Delete the checkout yourself if you want it gone.');
    // The bin links may still point into ~/.web-chat; removeInstall only ever
    // touches links that resolve inside it, so this is still safe to run.
  }

  const { bins } = removeInstall({ paths });
  log('');
  log('Removed the claude-web-chat install:');
  for (const b of bins) log(`  ${b.link}   ${b.action}`);
  log(`  ${paths.versions}   ${versions.length ? `${versions.length} version(s) removed (${versions.map((v) => `v${v}`).join(', ')})` : 'nothing to remove'}`);
  log(`  ${paths.current}   removed`);
  log('');
  log(`  ${paths.root}   preserved — per-user state (themes, approved services,`);
  log('                     update-check cache). Delete it manually if you want it gone.');
  log('  Every project\'s .web-chat/ graph data is untouched.');
}

// A running tunnel portal is stopped BEFORE the program removes itself, with
// this build's `tunnel down` — the last moment a command that can stop it is
// on PATH. Left running, the portal and its cloudflared went on serving remote
// sign-ins from a deleted install until the next reboot, with no `claude-web-
// chat tunnel down` left to stop them. The same gate `update` runs before a
// rollback to a build with no tunnel command (stopPortalTargetLacks), and the
// same refusal: a portal that will not stop leaves EVERYTHING in place, so the
// user still has the command that can bring it down. Returns null (none
// registered), { stopped: false } (registered, not answering as a portal —
// nothing to stop) or { stopped: true }; throws userFacing on a failed stop.
async function stopPortal({ log, opts }) {
  const entry = (opts.readPortal || (() => readRoleEntry('portal')))();
  if (!entry) return null;
  const env = { ...(opts.env || process.env), ...(entry.port ? { WEB_CHAT_PORTAL_PORT: String(entry.port) } : {}) };
  try {
    const down = opts.tunnelDown || ((o) => require('./tunnel')(['down'], o));
    const r = await down({ log: () => {}, env });
    if (r && r.stopped === false) return { stopped: false };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    const err = new Error([
      `⚠ The tunnel portal (pid ${entry.pid}) could not be stopped: ${error}`,
      '  Nothing was removed. Stop it with `claude-web-chat tunnel down`, then run `uninstall --self` again —',
      '  once the program is gone, no command is left that can stop it.',
    ].join('\n'));
    err.userFacing = true;
    throw err;
  }
  log(`Stopped the tunnel portal (pid ${entry.pid}) and its cloudflared — remote access is off.`);
  return { stopped: true };
}

// opts (test seams, beside stopDaemons' and stopPortal's): scanPorts — the
// ports the one --self scan probes (default registry.SCAN_PORTS); rows — the
// registry inventory (default registry.rows); hubStop — the hub stop (default
// `hub stop`); removeProgram(log) — the removal (default uninstallSelf).
// Inside the test sandbox --self refuses to run without scanPorts and hubStop.
//
// Returns {portal?, daemon?} for a plain uninstall; --self adds
// {others: {stopped, cleared, skipped} | null, hub | null, unverified: [{pid,
// port, root, reason, hint}]} (null where --keep-running skipped the stop).
async function uninstall(args = [], opts = {}) {
  const self = Array.isArray(args) && (args.includes('--self') || args.includes('--all'));
  const keep = Array.isArray(args) && args.includes('--keep-running');
  const log = (m = '') => console.log(m);
  if (self) requireTestSeams(opts);
  // --self stops a running portal first, and refuses (removing nothing, this
  // project's wiring included, and asking no daemon to stop) when it will not
  // stop — see stopPortal.
  const portal = self ? await stopPortal({ log, opts }) : null;
  // The enclosing project root, like every other command. From a subdirectory
  // this used to print "web-chat uninstalled from <subdir>" with every row "not
  // present" — a no-op reported as success.
  //
  // 'optional', and then a WIRING check — never the old tolerant fallback to
  // cwd. `remove()` un-registers the LOCAL-scope entry by running `claude mcp
  // remove web-chat --scope local` in that directory, so falling back made
  // "uninstall typed somewhere random" a write to Claude Code's own config for
  // a directory web-chat was never installed in. But refusing outright on a
  // missing .web-chat/ would strand the case uninstall is most needed for: a
  // project whose .web-chat/ was deleted by hand, whose hooks and .mcp.json
  // entry still make Claude Code spawn the MCP server. So: no state directory
  // above us, but our wiring here (registration's isRegistered — the hook
  // entries or the .mcp.json server, which are what an uninstall has to undo)
  // → uninstall this directory; neither → say so and touch nothing.
  const cwd = opts.cwd || process.cwd();
  const root = resolveRoot(cwd, { mode: 'optional' }).root
    || (isRegistered(cwd, { git: opts.git, configFile: opts.configFile }) ? cwd : null);
  let daemon = null;
  if (root) {
    projectRows(root, opts);
    daemon = await stopDaemons(root, args, opts, { self });
  } else console.log(`Nothing to uninstall in ${cwd} — no .web-chat/ here or in any parent, and no web-chat hooks or .mcp.json entry.`);

  if (!self) {
    console.log('');
    console.log('  (this removed web-chat from THIS PROJECT only. `claude-web-chat uninstall --self`');
    console.log('   also removes the program: ~/.local/bin links + ~/.web-chat/versions/)');
    return { ...(portal ? { portal } : {}), ...(daemon ? { daemon } : {}) };
  }

  // --self (U113@self-stops, ruled (a) 2026-10-13): the program is going away
  // for EVERY project, and with it every `claude-web-chat stop` and `hub stop`
  // on the machine. So every other web-chat server it can verify, then the
  // capture hub, are stopped first (an instance boot calls ensureHub, so the
  // hub goes after the daemons); what it saw but could not verify is listed with
  // a kill hint and never signalled; then the program is removed. A server that
  // will not stop does not hold the removal (unlike the portal, which holds a
  // public tunnel): it is listed, and the result says so.
  let others = null;
  let hub = null;
  let unverified;
  if (keep) {
    unverified = await stillRunning({ root, opts });
  } else {
    const swept = await stopOthers({ root, opts, log });
    others = swept.others;
    unverified = swept.unverified;
    hub = await stopHub({ opts, log });
  }
  nameOpenSessions(root, log);
  reportUnverified(unverified, { keep, log });
  (opts.removeProgram || uninstallSelf)(log);
  if (unverified.length && !keep) {
    log('');
    log(`  ${unverified.length} process${unverified.length === 1 ? '' : 'es'} listed above ${unverified.length === 1 ? 'was' : 'were'} not stopped; the program was removed anyway — use the kill hints.`);
  }
  return { ...(portal ? { portal } : {}), ...(daemon ? { daemon } : {}), others, hub, unverified };
}

// `uninstall --self` inside the test sandbox must be handed the port scan and
// the hub stop: the default scan probes 5173..5272 and the default hub stop
// signals whatever answers as the hub on hubPort() — on a developer's machine,
// their own daemons and hub. npm test sandboxes HOME (so the registry and the
// known list are the sandbox's), but no sandbox reaches a port. Fails loudly
// rather than quietly reaching past the test.
function requireTestSeams(opts) {
  if (!process.env.WEB_CHAT_TEST_SANDBOX) return;
  const missing = [];
  if (!Array.isArray(opts.scanPorts)) missing.push('scanPorts (the ports the test opened)');
  if (typeof opts.hubStop !== 'function') missing.push('hubStop');
  if (missing.length) {
    throw new Error(`uninstall --self called inside the test sandbox without ${missing.join(' and ')} — the defaults reach the real machine's daemons and capture hub`);
  }
}

// The /api/health probe of the one scan (the injected seam, else lib/core/portfiles).
async function askHealth(probe, port, ms) {
  try { return await probe(port, ms); } catch { return null; }
}

function validPorts(ports) {
  return (Array.isArray(ports) ? ports : registry.SCAN_PORTS).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

// instance id → root, for every project this machine knows (a live record or
// the known list), and this one.
function knownInstances(root) {
  const ids = new Map();
  let list = [];
  try { list = registry.sessions({ inactive: true }); } catch { list = []; }
  for (const s of list) if (s && s.root) ids.set(registry.instanceId(s.root), s.root);
  if (root) ids.set(registry.instanceId(root), path.resolve(root));
  return ids;
}

// One scan of the port range: every web-chat instance answering on a port, not
// already named by a pid in `seen`.
async function scanInstances(opts, seen) {
  const probe = opts.probeHealth || portfiles.probeHealth;
  const answers = await Promise.all(validPorts(opts.scanPorts).map(async (port) => ({ port, h: await askHealth(probe, port, 300) })));
  const out = [];
  for (const { port, h } of answers) {
    if (!h || h.ok === false || h.role !== 'instance' || !Number.isInteger(h.pid) || seen.has(h.pid)) continue;
    seen.add(h.pid);
    out.push({ port, pid: h.pid, instance: typeof h.instance === 'string' ? h.instance : null });
  }
  return out;
}

// Steps (3) and (4) of the ruling, the daemons half: every registry row through
// lib/cli/reap (here: null — this root's daemons were already stopped by
// stopDaemons, so its rows are dead and only cleared), then ONE scan for the
// instances no record names: one naming a project this machine knows is
// stopped through stopRow, which re-verifies before it asks or signals; one
// naming an unknown project, or none (a build before 0.8.5), is listed with a
// kill hint and never signalled.
async function stopOthers({ root, opts, log }) {
  const say = (m) => log(`  ${m}`);
  const waits = { ackWaitMs: opts.ackWaitMs, signalWaitMs: opts.signalWaitMs };
  log('');
  log('Stopping every other web-chat server on this machine:');
  let list = [];
  try { list = await (opts.rows || registry.rows)({ probe: true }); } catch { list = []; }
  const reaped = await reap(list, { here: null, log: say, ...waits });
  const unverified = reaped.skipped.map(({ row, reason }) => ({
    pid: row.pid, port: row.port || null, root: row.root || null, reason, hint: `kill ${row.pid}`,
  }));
  let stopped = reaped.stopped;
  const seen = new Set(list.map((r) => r.pid).filter(Number.isInteger));
  const ids = knownInstances(root);
  for (const f of await scanInstances(opts, seen)) {
    const owner = f.instance ? ids.get(f.instance) : null;
    if (!owner) {
      unverified.push({ pid: f.pid, port: f.port, root: null, reason: f.instance ? 'unknown-instance' : 'older-build', hint: `kill ${f.pid}` });
      continue;
    }
    const r = await stopRow({ root: owner, pid: f.pid, port: f.port, reachable: true }, { log: say, ...waits });
    if (r.ok && r.path !== 'none') { stopped++; continue; }
    if (r.ok) continue; // already gone
    unverified.push({ pid: f.pid, port: f.port, root: owner, reason: r.reason || 'failed', hint: `kill ${f.pid}` });
  }
  if (!stopped && !reaped.cleared && !unverified.length) say('(no other server running)');
  // Only what is still running is worth a hint.
  const still = unverified.filter((u) => portfiles.isPidAlive(u.pid));
  return { others: { stopped, cleared: reaped.cleared, skipped: reaped.skipped }, unverified: still };
}

// Step (4), the hub: the existing `hub stop` (it signals only a pid that
// answered /api/health as role 'hub' on hubPort()), or the test's seam.
async function stopHub({ opts, log }) {
  log('');
  log('Stopping the capture hub:');
  const hubStop = opts.hubStop || (() => require('./hub')(['stop']));
  try {
    const r = await hubStop({ log: (m) => log(`  ${m}`) });
    return r || { asked: true };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    log(`  the capture hub could not be stopped: ${error}`);
    return { asked: true, error };
  }
}

// --self --keep-running: nothing is stopped (the portal still is, as before),
// so say what is still running instead — every registry row whose pid is
// alive, every instance the one scan finds, and the hub's record — each with
// the kill hint that is all that will be left once the program is gone.
async function stillRunning({ root, opts }) {
  const out = [];
  let list = [];
  try { list = await (opts.rows || registry.rows)({ probe: true }); } catch { list = []; }
  const probe = opts.probeHealth || portfiles.probeHealth;
  const seen = new Set();
  for (const r of list) {
    if (!r.pid_alive || !Number.isInteger(r.pid)) continue;
    seen.add(r.pid);
    let reason = 'unreachable';
    if (r.reachable) {
      const h = await askHealth(probe, r.port, 400);
      reason = h && h.pid === r.pid ? 'running' : 'identity';
    }
    out.push({ pid: r.pid, port: r.port || null, root: r.root || null, reason, hint: `kill ${r.pid}` });
  }
  const ids = knownInstances(root);
  for (const f of await scanInstances(opts, seen)) {
    const owner = f.instance ? ids.get(f.instance) : null;
    out.push({ pid: f.pid, port: f.port, root: owner || null, reason: owner ? 'running' : (f.instance ? 'unknown-instance' : 'older-build'), hint: `kill ${f.pid}` });
  }
  let hubEntry = null;
  try { hubEntry = registry.readHubEntry(); } catch { hubEntry = null; }
  if (hubEntry && Number.isInteger(hubEntry.pid)) {
    out.push({ pid: hubEntry.pid, port: hubEntry.port || null, root: null, role: 'hub', reason: 'running', hint: `kill ${hubEntry.pid}` });
  }
  return out;
}

const REASONS = {
  running: 'running',
  unreachable: 'its pid is alive but nothing answers on its port — it may be an unrelated process now',
  identity: 'its port answers, but not as that pid — the record is out of date',
  draining: 'acknowledged the shutdown and is still draining — it should exit on its own',
  'older-build': 'a web-chat server of a build before 0.8.5 — it cannot say which project it serves',
  'unknown-instance': 'a web-chat server of a project this machine does not know',
  'no-root': 'a registry entry that names no project',
  'no-portfile': 'answers on its port as itself, but has no portfile to ask through',
  failed: 'answered as itself, but did not stop when asked',
};

function reportUnverified(list, { keep, log }) {
  if (!list.length) return;
  log('');
  log(keep
    ? 'Left running (--keep-running) — once the program is removed, no claude-web-chat command is left to stop these:'
    : 'Found but not stopped — each with why, and the kill to run if it is web-chat\'s (only a server that answered as itself was ever asked or signalled):');
  for (const u of list) {
    const what = u.role === 'hub' ? 'the capture hub' : (u.root || 'web-chat server');
    const where = u.port ? ` on port ${u.port}` : '';
    log(`  ${what} (pid ${u.pid}${where}) — ${REASONS[u.reason] || u.reason}. If it is web-chat's: ${u.hint}`);
  }
}

// Every Claude Code session still open in another project (this one's were
// named by stopDaemons): its web-chat MCP server can no longer start a server
// once the program is gone, but every web-chat tool call in it will fail.
function nameOpenSessions(root, log) {
  let list = [];
  try { list = registry.sessions({ inactive: false }); } catch { list = []; }
  const here = root ? path.resolve(root) : null;
  const open = list.filter((s) => s && s.claude && s.claude.sessions > 0 && s.root !== here);
  if (!open.length) return;
  log('');
  log('Claude Code sessions still open elsewhere — exit them (/exit); their web-chat tools stop working once the program is gone:');
  for (const s of open) log(`  ${s.root}   ${s.claude.sessions} session${s.claude.sessions === 1 ? '' : 's'} (web-chat MCP pid ${s.claude.pids.join(', ')})`);
}

// Removing the wiring is not stopping the process (registration remove() says
// so, and stays wiring-only): a daemon left running after an uninstall went on
// writing .web-chat/ — the user deleted the folder and watched it come back
// (lifecycle-bugs.md bug 1). So uninstall stops every daemon rooted here, the
// way `claude-web-chat stop` does (the port scan included: an orphan from a
// deleted portfile is in no record), unless --keep-running. Then the one thing
// it cannot stop: a Claude Code session still open here keeps its web-chat MCP
// server, which starts the daemon again on its next tool call.
//
// opts: scanPorts / probeHealth / ackWaitMs / signalWaitMs (stop's seams — a
// test passes only ports it opened), mcpSessionsFor.
async function stopDaemons(root, args, opts, { self = false } = {}) {
  const keep = Array.isArray(args) && args.includes('--keep-running');
  console.log('');
  let res = null;
  if (keep && self) {
    // `claude-web-chat stop` is about to go with the program: its kill hint is
    // in the list --self prints.
    console.log("  --keep-running: this project's web-chat daemon, if one is running, was left up (its kill hint is listed below).");
  } else if (keep) {
    console.log(`  --keep-running: this project's web-chat daemon, if one is running, was left up. Stop it with \`claude-web-chat stop\` in ${root}`);
  } else {
    console.log("Stopping this project's web-chat daemon:");
    res = await stop([], {
      root,
      scan: true,
      log: (m) => console.log(`  ${m}`),
      ...(opts.scanPorts !== undefined ? { scanPorts: opts.scanPorts } : {}),
      ...(opts.probeHealth ? { probeHealth: opts.probeHealth } : {}),
      ...(opts.ackWaitMs != null ? { ackWaitMs: opts.ackWaitMs } : {}),
      ...(opts.signalWaitMs != null ? { signalWaitMs: opts.signalWaitMs } : {}),
    });
  }
  let live = [];
  try { live = (opts.mcpSessionsFor || mcpSessionsFor)(root); } catch { live = []; }
  if (live.length) {
    const pids = live.map((e) => (Number.isInteger(e.ppid) && e.ppid > 1 ? e.ppid : e.pid)).join(', ');
    console.log(`  ${live.length} Claude Code session${live.length === 1 ? ' is' : 's are'} still open in this project (pid ${pids}): their web-chat MCP servers can start the daemon again until those sessions exit — exit them (/exit).`);
  }
  return res;
}

// Un-register ONE project and report what moved, row by row.
function projectRows(root, opts) {
  const r = remove(root, { runClaude: opts.runClaude, git: opts.git, configFile: opts.configFile, knownRoots: opts.knownRoots });

  let pad = '.claude/settings.json'.length;
  for (const { dest } of r.managed) if (dest.length > pad) pad = dest.length;
  const row = (label, value) => console.log(`  ${label.padEnd(pad)}   ${value}`);
  console.log(`web-chat uninstalled from ${root}`);
  row('.claude/settings.json', `${r.hooks.removed} hook entrie${r.hooks.removed === 1 ? '' : 's'} removed (${r.hooks.events.join(', ')})`);
  for (const { dest, status } of r.managed) row(dest, status);
  row('.web-chat/managed.json', r.baselines);
  row('.mcp.json', r.mcp.status);
  // The LOCAL-scope registration doctor's repair writes lives in Claude Code's
  // own config, not in this project — nothing here used to remove it, so after
  // an "uninstall" Claude Code kept spawning the MCP server for this project and
  // the first tool call re-created .web-chat/. On a machine with no `claude`, we
  // print the command rather than claim a removal that did not happen.
  //
  // Inside a git repository that entry is keyed by the repository's root and
  // shared by every web-chat root of the repository and its worktrees: when
  // another one exists, removing it would take the tools from that project
  // too, so the command is printed instead of run (registration remove()).
  if (r.localScope.status === 'removed') row('Claude Code (local scope)', 'web-chat registration removed');
  else if (r.localScope.status === 'not registered') row('Claude Code (local scope)', 'no local-scope registration');
  else if (r.localScope.status === 'shared') {
    row('Claude Code (local scope)', `kept — it is shared (key ${r.localScope.key}) with ${r.localScope.others.join(', ')}`);
    console.log(`  ${''.padEnd(pad)}   to remove it anyway, run in ${r.localScope.key}: claude ${r.localScope.argv.join(' ')}`);
  } else console.log(`  ${'Claude Code (local scope)'.padEnd(pad)}   ${r.localScope.status} — run: claude ${r.localScope.argv.join(' ')}`);
  // The mod (ruling C2 (a): uninstall also takes it off). remove() answers
  // `mod` only for a project that had it on. When it could not be taken off,
  // the plugin stays installed at local scope: say so and name the commands —
  // run from the project root, which the local scope keys on.
  if (r.mod) {
    if (r.mod.status === 'removed') row('Claude Code (the mod)', 'web-chat mod removed (plugin and marketplace, local scope)');
    else {
      const why = r.mod.error ? `${r.mod.status} (${r.mod.error})` : r.mod.status;
      const cmds = (r.mod.commands || []).map((argv) => `claude ${argv.join(' ')}`).join('; ');
      row('Claude Code (the mod)', `${why} — run in ${root}: ${cmds}`);
    }
  }
  row('.web-chat/', 'preserved (delete manually if no longer needed)');
}

module.exports = uninstall;
