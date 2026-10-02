// What it MEANS for a project to be registered with Claude Code — as one model
// instead of eight opinions.
//
// The primitives live one layer down, in lib/update/managed-files: the managed
// file list, the 3-way reconcile, the hook merge, the .mcp.json writer, the
// stable bin decision. They are a bag of writers, and every read-only consumer
// (doctor, status, the MCP dispatcher) used to re-derive registration state by
// hand — which is how the tree came to hold:
//
//   * five different answers to "what root does this command operate on"
//     (install/uninstall/on/off on process.cwd(); doctor/status on
//     findProjectRoot; update skipping entirely when it returned null),
//   * two ways to COUNT the same hooks — doctor counted individual handlers,
//     status counted handler groups — neither of which compared what is
//     registered against templates/settings.hooks.json, so a project missing its
//     Stop hook reported "1 hook(s) registered and resolvable" while no turn
//     ever committed,
//   * two contradictory ${CLAUDE_PLUGIN_ROOT} policies (install rewrote the
//     committed stub to this machine's absolute path; doctor deliberately
//     preserved it and registered at Claude Code's local scope instead),
//   * a hand-built MCP argv in doctor that bypassed stableBin, writing the
//     version directory that pruneVersions deletes three updates later, and
//   * an `uninstall` that had never heard of the local-scope registration
//     doctor's repair writes, so "uninstall" was not reversible.
//
// This module sits ABOVE managed-files (which keeps every export — lib/packs
// depends on two of them) and exposes the model: resolveRoot / inspect / apply /
// remove, plus the small facts everyone needs (hookEvents and hookHandlers,
// mcpArgv, removeArgv), the hook roles doctor and status word their findings
// by (HOOK_ROLES, hookRole, roleEffect, hookProblems), and the MCP server's
// startup line (driftLine).
//
// Two deliberate non-symmetries, stated here because a reader will look for
// them:
//
//   * apply() is NOT the whole of `install`. Creating .web-chat/, running the
//     migrations and pre-warming a daemon stay in lib/cli/commands/install.js —
//     otherwise doctor's hook repair would start creating state directories and
//     forking background servers it has never forked.
//   * remove() is NOT the inverse of apply(). .web-chat/ is preserved by design
//     (it holds the graph) and the daemon is not stopped.
//
// The export surface is small and additive ON PURPOSE: `update` loads this
// module out of the NEWLY INSTALLED version directory (the same reason
// loadRestart exists), so a rename here is a cross-version break.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { projectPaths, claudePaths, findProjectRoot } = require('../core/paths');
const {
  MANAGED_FILES,
  baselinePath,
  hookTemplate,
  stableBin,
  reconcileManagedFiles,
  mergeHooks,
  ensureGitignore,
  ensureMcpRegistration,
  mcpEntryHasChannelEnv,
  parseHookCommand,
  isWebChatHookCommand,
  hookSubcommand,
  hookHandlerDrift,
  eachHandler,
} = require('../update/managed-files');

const MCP_KEY = 'web-chat';

function userFacing(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

// ── the root ────────────────────────────────────────────────────────────────

// The ONE answer to "which project does this command operate on".
//
//   'existing' — there must be an installed root at or above cwd. `on`/`off`
//                use it: flipping a disable marker in a directory that has no
//                install is not a no-op worth reporting as success.
//   'install'  — the enclosing installed root if there is one, else this
//                directory. `install` from a subdirectory therefore ADOPTS the
//                parent rather than creating a second, nested surface that
//                Claude Code (which reads the project root) never loads.
//   'optional' — the enclosing root or null, for a caller that legitimately has
//                nothing to do outside a project (`update`'s managed-file sync).
//
// findProjectRoot's $HOME refusal is inherited on purpose: it never auto-detects
// the home directory as a project root, so `source: 'cwd'` in $HOME still
// reaches init's homeMarkerCollision question.
function resolveRoot(cwd = process.cwd(), { mode = 'existing' } = {}) {
  const from = path.resolve(cwd);
  const found = findProjectRoot(from);
  if (found) return { root: found, from, source: 'detected', movedUp: found !== from };
  if (mode === 'existing') {
    throw userFacing(`no .web-chat/ in ${from} (or any parent) — run \`claude-web-chat init\` first`);
  }
  if (mode === 'optional') return { root: null, from, source: 'none', movedUp: false };
  return { root: from, from, source: 'cwd', movedUp: false };
}

// ── the facts ───────────────────────────────────────────────────────────────

// Which hook events registration MEANS — read from the template that defines
// them, never from whatever happens to be on disk. A project missing one of
// them is broken in a way that used to report as healthy (no Stop hook: no
// turn ever commits). The template itself has ONE reader — managed-files'
// hookTemplate(), which mergeHooks merges from — so the event list and the
// handlers can never disagree about which file defines them.
function hookEvents() {
  return Object.keys(hookTemplate().hooks || {});
}

// What each web-chat handler is FOR, so doctor and status can say what a
// missing one costs instead of one sentence for every hook. Per handler, not
// per event: PreToolUse and PostToolUse each carry two, the mirror's and the
// halt's. `effect` is what the user loses while the role's handlers are missing
// or cannot run; `byEvent` narrows it for an event whose absence costs less
// than the role's whole effect (StopFailure only stands in for Stop when a
// turn ends on an API error, so a 0.8.0 project missing just that one still
// begins and commits every other turn).
const HOOK_ROLES = {
  lifecycle: {
    subcommands: ['turn-begin', 'turn-end'],
    effect: 'turns never begin or never commit',
    byEvent: { StopFailure: 'a turn that ends on an API error holds the turn lock until it times out' },
  },
  mirror: {
    subcommands: ['mirror'],
    effect: 'the chat mirror shows no live tool status',
  },
  bridge: {
    subcommands: ['ask'],
    effect: 'prompts cannot be answered from the browser',
  },
  halt: {
    subcommands: ['halt'],
    effect: '"Stop after this step" from the browser does nothing',
  },
};

// The role of one handler (an object with a `command`, or the command itself),
// or null for a handler that is not web-chat's or has no role.
function hookRole(handler) {
  const sub = hookSubcommand(typeof handler === 'string' ? handler : handler && handler.command);
  if (sub === null) return null;
  for (const [role, r] of Object.entries(HOOK_ROLES)) if (r.subcommands.includes(sub)) return role;
  return null;
}

// What losing `role` on `events` costs, in words. The role's own effect, unless
// every event named has a narrower one.
function roleEffect(role, events = []) {
  const r = HOOK_ROLES[role];
  if (!r) return '';
  const by = r.byEvent || {};
  if (events.length && events.every((e) => by[e])) return [...new Set(events.map((e) => by[e]))].join('; ');
  return r.effect;
}

// Every handler the template registers, in the template's order:
// [{ event, sub, args, role, handler }].
function hookHandlers() {
  const out = [];
  for (const [event, groups] of Object.entries(hookTemplate().hooks || {})) {
    for (const g of groups || []) {
      for (const handler of (g && g.hooks) || []) {
        const p = parseHookCommand(handler.command);
        out.push({ event, sub: p ? p.sub : null, args: p ? p.args : '', role: hookRole(handler), handler });
      }
    }
  }
  return out;
}

// How every line that asks for a hook upgrade ends. Whether a Claude Code
// session that is already running picks up hooks `install` just registered has
// not been tested (validation gate V24 (c)); until it has, the honest advice
// includes the restart.
const HOOK_RESTART_NOTE = 'then restart Claude Code (or open /hooks to review them)';

// The one MCP registration argv — `claude mcp add … --scope local`. Built off
// stableBin so a managed install registers ~/.web-chat/current/bin/… and never
// the version directory this process happens to be running from (pruneVersions
// deletes that three updates later, and local scope overrides .mcp.json, so the
// breakage is both silent and permanent).
// `opts` is stableBin's injection seam ({packageRoot, paths}): a test cannot move
// the tree it is running from, so the managed-vs-checkout decision has to be
// exercisable against a fabricated layout.
function mcpArgv(opts) {
  return ['mcp', 'add', MCP_KEY, '--scope', 'local', '--', 'node', stableBin('claude-web-chat-mcp', opts)];
}

function removeArgv() {
  return ['mcp', 'remove', MCP_KEY, '--scope', 'local'];
}

// The one shell-out to the Claude Code CLI. Injectable everywhere it is used, so
// no test needs a real `claude` on PATH. `notFound` is reported separately from
// a command that ran and failed: on a machine without `claude`, `uninstall` must
// PRINT the command rather than claim a removal that did not happen.
//
// `--scope local` keys the registration to the directory `claude` runs in, so
// the cwd is part of the command, not an ambient detail: run from the shell's
// cwd it would register (or un-register) a DIFFERENT project than the one
// resolveRoot just picked. Every call site passes the resolved root — that is
// what makes this module the single answer to "which project", shell-out
// included. `cwd: undefined` would silently mean process.cwd(), so callers do
// not get to omit it by accident: the three sites in this tree all pass it.
function defaultRunClaude(argv, { cwd } = {}) {
  try {
    const stdout = execFileSync('claude', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: stdout || '' };
  } catch (e) {
    return { ok: false, stderr: (e.stderr || e.message || '').toString(), notFound: e.code === 'ENOENT' };
  }
}

// ── classification (reads, no writes) ───────────────────────────────────────

// Is the .mcp.json web-chat entry something Claude Code can actually spawn from
// this checkout? Bare PATH-dependent commands and unexpanded ${CLAUDE_PLUGIN_ROOT}
// (a plugin stub running outside a plugin install — the dogfooding case) are not.
function classifyMcpEntry(entry) {
  if (!entry) return { kind: 'none', resolvable: false, reason: 'no web-chat entry' };
  const blob = JSON.stringify(entry);
  if (blob.includes('${CLAUDE_PLUGIN_ROOT}')) {
    // Plugin stub. The plugin host expands the placeholder at spawn time, so it
    // resolves iff CLAUDE_PLUGIN_ROOT is set; otherwise it's the dogfooding case
    // doctor is here to repair. (Checked before the path tests below, which can't
    // see through an unexpanded `${...}`.)
    return process.env.CLAUDE_PLUGIN_ROOT
      ? { kind: 'stub', resolvable: true }
      : { kind: 'stub', resolvable: false, reason: 'uses ${CLAUDE_PLUGIN_ROOT} but it is not set (plugin stub outside a plugin install)' };
  }
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  // `node <abs path>` or a direct absolute path to an existing file is resolvable.
  if (cmd === 'node' && args[0] && path.isAbsolute(args[0]) && fs.existsSync(args[0])) {
    return { kind: 'absolute', resolvable: true };
  }
  if (cmd && path.isAbsolute(cmd) && fs.existsSync(cmd)) {
    return { kind: 'absolute', resolvable: true };
  }
  // A bare command (e.g. `claude-web-chat-mcp`) only resolves if it happens to be
  // on PATH at spawn time — fragile, and the failure that motivated `doctor`.
  return { kind: 'bare', resolvable: false, reason: `bare/PATH-dependent command '${cmd}'` };
}

// classifyMcpEntry's rule, applied to a hook's shell command string: it must
// invoke an existing absolute path to the hook bin, or to the halt script. A
// bare `claude-web-chat-hook` runs only if the package happens to be on PATH at
// hook time.
function hookCommandResolvable(cmd) {
  const p = parseHookCommand(cmd);
  if (!p || p.kind === 'bare') return false;
  if (p.file.startsWith('${CLAUDE_PLUGIN_ROOT}')) return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
  return path.isAbsolute(p.file) && fs.existsSync(p.file);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { state: 'absent', value: null };
  try {
    return { state: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { state: 'unparseable', value: null, error: e.message };
  }
}

// The hooks of one project, against the template: per EVENT (`hooks`) and per
// template HANDLER (`handlers`, the rows doctor and status word by role).
//
// A handler row is
//   'missing'  no web-chat handler with its subcommand on its event,
//   'bare'     one is there, but its command does not resolve (a PATH lookup),
//   'stale'    it resolves, but differs from the template's (`differs` names
//              the managed fields, or 'command' for a different shape),
//   'ok'.
// An event is 'missing' when it holds no web-chat handler at all, 'bare' when
// one of them cannot run, 'stale' when a row is anything but ok (one of its
// template handlers missing included), and 'ok' otherwise. applyHooks repairs
// every state but 'ok'.
function inspectHooks(root) {
  const events = hookEvents();
  const hooks = {};
  for (const e of events) hooks[e] = 'missing';
  const handlers = hookHandlers().map(({ event, sub, role, handler }) => ({ event, sub, role, state: 'missing', template: handler }));
  const rows = () => handlers.map(({ template, ...row }) => row);
  const { state, value } = readJsonFile(claudePaths(root).settings);
  if (state !== 'ok') return { file: state, hooks, handlers: rows() };
  const on = (value && typeof value.hooks === 'object' && value.hooks) || {};
  for (const event of events) {
    const mine = [];
    eachHandler(on[event], (hh) => { if (isWebChatHookCommand(hh.command)) mine.push(hh); });
    const eventRows = handlers.filter((r) => r.event === event);
    for (const r of eventRows) {
      const same = mine.filter((hh) => hookSubcommand(hh.command) === r.sub);
      if (!same.length) continue;
      if (same.some((hh) => !hookCommandResolvable(hh.command))) { r.state = 'bare'; continue; }
      const differs = [...new Set(same.flatMap((hh) => hookHandlerDrift(hh, r.template)))];
      if (differs.length) { r.state = 'stale'; r.differs = differs; continue; }
      r.state = 'ok';
    }
    hooks[event] = !mine.length ? 'missing'
      : mine.some((hh) => !hookCommandResolvable(hh.command)) ? 'bare'
        : eventRows.some((r) => r.state !== 'ok') ? 'stale'
          : 'ok';
  }
  return { file: state, hooks, handlers: rows() };
}

// The handler rows of inspect() that need a repair, grouped by role and state,
// in the template's order: [{ role, state, events, differs, effect }]. One
// shape for doctor, status and the MCP startup line, which each word it their
// own way.
function hookProblems(state) {
  const out = [];
  for (const role of Object.keys(HOOK_ROLES)) {
    for (const st of ['missing', 'bare', 'stale']) {
      const rows = ((state && state.handlers) || []).filter((r) => r.role === role && r.state === st);
      if (!rows.length) continue;
      const events = [...new Set(rows.map((r) => r.event))];
      const differs = [...new Set(rows.flatMap((r) => r.differs || []))];
      out.push({ role, state: st, events, differs, effect: roleEffect(role, events) });
    }
  }
  return out;
}

// Name the handlers in `rows` (inspect handler rows) the way a person reads
// them: the event alone when every template handler of that event is listed,
// `Event (sub)` when only some are.
function handlerLabels(rows, all) {
  const out = [];
  for (const event of [...new Set(rows.map((r) => r.event))]) {
    const here = rows.filter((r) => r.event === event);
    const total = all.filter((r) => r.event === event).length;
    out.push(here.length === total ? event : `${event} (${here.map((r) => r.sub).join(', ')})`);
  }
  return out;
}

// The once-per-session nudge the MCP server writes to stderr at startup
// (lib/mcp/index.js), from one inspect() read, or null when nothing drifted:
//
//   * managed files: a shipped update not yet synced, or a conflict to announce
//     (`updated` / `conflict` / `differs`). A `pending` row — an unmerged `.new`
//     the user has already been told about — deliberately does not count: the
//     line says "run install", and install cannot merge for them;
//   * hooks: every template handler that is missing, cannot run or differs from
//     the template, named — the projects an update reached before anyone ran
//     `install` in them.
function driftLine(state) {
  if (!state) return null;
  const parts = [];
  const managed = state.managed || [];
  if (managed.some((r) => r.action === 'updated' || r.action === 'conflict' || r.action === 'differs')) {
    parts.push('managed files out of date');
  }
  // An unparseable settings.json is left to doctor and status, which say so:
  // "run install" cannot repair a file that does not parse.
  const all = (state.hooksFile === 'unparseable' ? [] : state.handlers) || [];
  const named = [];
  for (const st of ['missing', 'bare', 'stale']) {
    const rows = all.filter((r) => r.state === st);
    if (rows.length) named.push(`${st}: ${handlerLabels(rows, all).join(', ')}`);
  }
  if (named.length) parts.push(`Claude Code hooks out of date (${named.join('; ')})`);
  if (!parts.length) return null;
  return `${parts.join('; ')} — run \`claude-web-chat install\`${named.length ? `, ${HOOK_RESTART_NOTE}` : ''}`;
}

function mcpPathFor(root) {
  return path.join(root, '.mcp.json');
}

function inspectMcp(root) {
  const { state, value } = readJsonFile(mcpPathFor(root));
  const entry = (state === 'ok' && value.mcpServers && value.mcpServers[MCP_KEY]) || null;
  const cls = classifyMcpEntry(entry);
  return {
    file: state,
    present: Boolean(entry),
    kind: cls.kind,
    resolvable: cls.resolvable,
    reason: cls.reason || null,
    channelEnv: mcpEntryHasChannelEnv(entry),
    entry,
  };
}

// "Is web-chat installed in this project at all?" — the one cheap question, kept
// separate from inspect() because the MCP dispatcher asks it on EVERY one of the
// 24 tools' calls in a disabled or uninstalled project, and inspect() would read
// every managed template plus its baselines, dry-run the .gitignore rule and
// build the MCP argv to answer an fs.existsSync. Same definition either way —
// inspect().installed is this function.
function isInstalled(root) {
  return fs.existsSync(projectPaths(root).dir);
}

// The whole registration state of a project, as data. Pure read — no writes, no
// network, no spawn. (It does stat paths OUTSIDE the project: deciding whether a
// hook command or an MCP entry actually RESOLVES means asking the filesystem
// about the bin it names.)
function inspect(root) {
  const paths = projectPaths(root);
  const { file: hooksFile, hooks, handlers: hookRows } = inspectHooks(root);
  const mcp = inspectMcp(root);

  let managed = [];
  let managedError = null;
  try {
    managed = reconcileManagedFiles(root, { dryRun: true });
  } catch (e) {
    managedError = e.message;
  }

  // ensureGitignore's own detection, run in dry mode rather than re-implemented:
  // 'added' means it WOULD have written the rule, i.e. the rule is absent.
  let gitignore;
  try {
    const would = ensureGitignore(root, { dryRun: true });
    gitignore = would === 'already-present' ? 'covered' : would === 'added' ? 'absent' : 'no-gitignore';
  } catch {
    gitignore = 'no-gitignore';
  }

  return {
    root,
    stateDir: paths.dir,
    installed: isInstalled(root),
    hooksFile,
    hooks,
    handlers: hookRows,
    mcp: { ...mcp, argv: mcpArgv() },
    managed,
    managedError,
    gitignore,
  };
}

// ── apply ───────────────────────────────────────────────────────────────────

// The ONE ${CLAUDE_PLUGIN_ROOT} policy, and it is doctor's: a committed plugin
// stub is never rewritten (that is what put an absolute /Users/… path into a
// tracked .mcp.json once), and when the placeholder cannot resolve here we
// register at Claude Code's LOCAL scope instead, which overrides .mcp.json for
// this project only and leaves the portable file alone.
//
// Everything else — a bare command, a stale absolute path, no entry at all — is
// rewritten in .mcp.json by ensureMcpRegistration, and needs no shell-out.
function applyMcp(root, { dryRun = false, runClaude = defaultRunClaude } = {}) {
  if (dryRun) {
    const before = inspectMcp(root);
    return {
      status: before.present ? 'already up to date' : 'web-chat server registered',
      dry: true,
      localScope: before.resolvable ? null : { status: 'would register', argv: mcpArgv() },
    };
  }
  const status = ensureMcpRegistration(root);
  const after = inspectMcp(root);
  if (after.resolvable) return { status, localScope: null };

  const argv = mcpArgv();
  // From the root, not the shell's cwd: `--scope local` is per-directory.
  const r = runClaude(argv, { cwd: root });
  if (r && r.ok) return { status, localScope: { status: 'registered', argv } };
  if (r && /already exists/i.test(r.stderr || '')) return { status, localScope: { status: 'already registered', argv } };
  return { status, localScope: { status: r && r.notFound ? 'claude not on PATH' : 'failed', argv } };
}

// Make this project registered: hooks, managed files, .gitignore, MCP entry.
// dryRun is threaded all the way down, because `doctor --dryRun` and
// `init --report` promise the caller they change nothing on disk.
//
// Deliberately EXCLUDED (they stay in lib/cli/commands/install.js): creating
// .web-chat/, running the migrations, and pre-warming the daemon.
//
// `hooks` is applyHooks' answer: { added, updated, events }.
function apply(root, { force = false, dryRun = false, runClaude = defaultRunClaude } = {}) {
  const hooks = applyHooks(root, { dryRun });
  const managed = reconcileManagedFiles(root, { force, dryRun });
  const gitignore = ensureGitignore(root, { dryRun });
  const mcp = applyMcp(root, { dryRun, runClaude });
  return { hooks, managed, gitignore, mcp };
}

// The hook half on its own — doctor repairs hooks without touching managed
// files, .gitignore or the MCP registration. It repairs every handler state
// inspect() reports: missing, bare and stale. `added` counts the handlers it
// added, `updated` the web-chat handlers already there that it changed (a
// repair, or a command pointed at this tree), so a caller can tell "rewrote
// three handlers" from "nothing to do".
function applyHooks(root, { dryRun = false } = {}) {
  const { added, updated } = mergeHooks(root, { dryRun });
  return { added, updated, events: hookEvents() };
}

// ── remove ──────────────────────────────────────────────────────────────────

function pruneEmptyDirs(from, stopAt) {
  let dir = path.dirname(from);
  while (dir.startsWith(stopAt + path.sep)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

function rm(p) {
  if (fs.existsSync(p)) { fs.unlinkSync(p); return 'removed'; }
  return 'not present';
}

// Un-register this project. NOT the inverse of apply(): .web-chat/ is preserved
// (it holds the graph) and the daemon is not stopped — both by design.
//
// Hooks are stripped for the events the TEMPLATE defines, not by a substring
// scan over whatever events happen to be in settings.json. The scan was the only
// place in the tree whose notion of "our hooks" was not template-derived.
// And per HANDLER, not per group: a group that also holds another tool's
// handler keeps it, and only a group left empty is dropped (then an event left
// empty, then `hooks` itself). `removed` counts the handlers taken.
function remove(root, { runClaude = defaultRunClaude } = {}) {
  const events = hookEvents();
  const claude = claudePaths(root);

  // 1. hooks
  let removedHooks = 0;
  const settingsPath = claude.settings;
  if (fs.existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      throw userFacing(`error parsing ${settingsPath}: ${e.message}`);
    }
    if (settings.hooks) {
      for (const event of events) {
        const groups = settings.hooks[event];
        if (!Array.isArray(groups)) continue;
        const kept = [];
        for (const g of groups) {
          if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
          const rest = g.hooks.filter((hh) => !(hh && isWebChatHookCommand(hh.command)));
          removedHooks += g.hooks.length - rest.length;
          if (rest.length === g.hooks.length) kept.push(g);
          else if (rest.length) kept.push({ ...g, hooks: rest });
        }
        if (kept.length) settings.hooks[event] = kept;
        else delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }

  // 2. managed files, their conflict sidecars, and the baselines describing them
  const managed = [];
  for (const { dest } of MANAGED_FILES) {
    const p = path.join(root, dest);
    const status = rm(p);
    rm(p + '.new');
    pruneEmptyDirs(p, claude.dir);
    managed.push({ dest, status });
  }
  const baselines = rm(baselinePath(root));

  // 3. the project .mcp.json entry
  let mcpStatus = 'not present';
  const mcpPath = mcpPathFor(root);
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcp.mcpServers && mcp.mcpServers[MCP_KEY]) {
        delete mcp.mcpServers[MCP_KEY];
        if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers;
        if (Object.keys(mcp).length === 0) {
          fs.unlinkSync(mcpPath);
          mcpStatus = 'removed (file empty)';
        } else {
          fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
          mcpStatus = 'web-chat entry removed';
        }
      } else {
        mcpStatus = 'no web-chat entry';
      }
    } catch (e) {
      mcpStatus = `error parsing (${e.message})`;
    }
  }

  // 4. the LOCAL-scope registration in Claude Code's own config — the one
  // doctor's repair writes, and the reason "uninstall" used to leave the MCP
  // server still spawning for this project. Tolerates "not found"; on a machine
  // with no `claude`, reports the command instead of claiming a removal.
  const argv = removeArgv();
  // From the root, for the same reason apply() registers from it: run in a
  // subdirectory this un-registered nothing and reported a removal.
  const r = runClaude(argv, { cwd: root });
  let localScope;
  if (r && r.ok) localScope = { status: 'removed', argv };
  else if (r && r.notFound) localScope = { status: 'claude not on PATH', argv };
  else if (r && /no .*server|not found|does not exist/i.test(r.stderr || '')) localScope = { status: 'not registered', argv };
  else localScope = { status: 'could not remove', argv };

  return {
    hooks: { removed: removedHooks, events },
    managed,
    baselines,
    mcp: { status: mcpStatus },
    localScope,
  };
}

module.exports = {
  resolveRoot,
  hookEvents,
  hookHandlers,
  HOOK_ROLES,
  hookRole,
  roleEffect,
  HOOK_RESTART_NOTE,
  hookProblems,
  driftLine,
  mcpArgv,
  removeArgv,
  defaultRunClaude,
  classifyMcpEntry,
  hookCommandResolvable,
  isInstalled,
  inspect,
  apply,
  applyHooks,
  remove,
};
