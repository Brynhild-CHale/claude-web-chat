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
const {
  projectPaths, claudePaths, userClaudePaths, findProjectRoot, realpath, redactHostPaths,
} = require('../core/paths');
const { readJson, writeJsonAtomic } = require('../core/fsjson');
const { stableKey } = require('../core/stable-json');
const { runClaude: runClaudeCli, claudeEnv } = require('../core/claude-cli');
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
  stripChannelEnv,
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

// The one shell-out to the Claude Code CLI: lib/core/claude-cli's runClaude,
// re-exported under the name every caller and test already injects against.
// Injectable everywhere it is used, so no test needs a real `claude` on PATH.
// `notFound` is reported separately from a command that ran and failed: on a
// machine without `claude`, `uninstall` must PRINT the command rather than
// claim a removal that did not happen.
//
// `--scope local` keys the registration to the directory `claude` runs in, so
// the cwd is part of the command, not an ambient detail: run from the shell's
// cwd it would register (or un-register) a DIFFERENT project than the one
// resolveRoot just picked. Every call site passes the resolved root — that is
// what makes this module the single answer to "which project", shell-out
// included. `cwd: undefined` would silently mean process.cwd(), so callers do
// not get to omit it by accident: every site in this tree passes it.
const defaultRunClaude = runClaudeCli;

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

// ── Claude Code's own config: the local scope (reads, no writes) ───────────
//
// Why web-chat registers its MCP server at Claude Code's LOCAL scope (design/
// mcp-approval-local-scope.md, measured on Claude Code 2.1.289): a server in a
// project's .mcp.json needs the user's approval, and in a non-git folder whose
// trust is inherited from a trusted parent that approval is never kept — the
// "New MCP server found" dialog comes back on every launch, its default answer
// is No, and a No is a permanent rejection (disabledMcpjsonServers) that hides
// every web-chat tool. A server added with `claude mcp add --scope local` has
// no approval state at all, and a local entry of the same name shadows a
// pending or rejected .mcp.json one. It lives in Claude Code's config file
// (userClaudePaths().claudeJson), under projects[<key>].mcpServers, where the
// key is the PHYSICAL path of the folder, or the main worktree's root inside a
// git repository (one entry covers the repository, every worktree and every
// subfolder).
//
// That file also holds the user's account and every project's trust state, so
// it is read here for exactly three things and nothing else: web-chat's own
// entry under the candidate keys, `disabledMcpServers` (/mcp's Disable) under
// the same keys, and the NAMES of project keys below the root. Nothing read
// from it is logged, sent to the daemon or to a browser, and web-chat NEVER
// writes it: the `claude` CLI does, run from the project root.

// The git facts the local scope depends on: the toplevel, the MAIN worktree's
// root (Claude Code keys a linked worktree's entry there), and whether
// .mcp.json and .claude/settings.local.json are tracked. A fixed argv, no
// shell, and the same `-c` pair Claude Code's own git probe uses (no hooks, no
// fsmonitor daemon). The child gets claudeEnv (no CLAUDE_CODE_*/WEB_CHAT_*)
// without the GIT_* variables that would aim it at another repository (a git
// hook's GIT_DIR, say).
const GIT_PREFIX = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor='];
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function gitEnv(env = process.env) {
  const out = claudeEnv(env);
  for (const k of GIT_ENV_DROP) delete out[k];
  return out;
}

// (argv, { cwd, env }) → { status, stdout }. `argv` is the WHOLE argument list,
// GIT_PREFIX included, so a test that injects this sees exactly what runs.
function defaultGit(argv, { cwd, env } = {}) {
  try {
    const stdout = execFileSync('git', argv, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, shell: false,
    });
    return { status: 0, stdout: stdout || '' };
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : null, stdout: String(e.stdout || '') };
  }
}

function canon(p) {
  return realpath(p) || path.resolve(p);
}

function gitFacts(root, { git = defaultGit } = {}) {
  const cwd = path.resolve(root);
  const env = gitEnv();
  const run = (args) => {
    try { return git([...GIT_PREFIX, ...args], { cwd, env }) || { status: null, stdout: '' }; } catch { return { status: null, stdout: '' }; }
  };
  const none = { git: false, toplevel: null, mainRoot: null, tracked: { mcpJson: false, settingsLocal: false } };
  const top = run(['rev-parse', '--show-toplevel']);
  const topPath = top.status === 0 ? top.stdout.trim() : '';
  if (!topPath) return none;
  const toplevel = canon(topPath);
  let mainRoot = toplevel;
  const common = run(['rev-parse', '--git-common-dir']);
  const commonPath = common.status === 0 ? common.stdout.trim() : '';
  if (commonPath) {
    const dir = path.resolve(cwd, commonPath);
    if (path.basename(dir) === '.git') mainRoot = canon(path.dirname(dir));
  }
  const tracked = (rel) => run(['ls-files', '--error-unmatch', '--', rel]).status === 0;
  return {
    git: true,
    toplevel,
    mainRoot,
    tracked: { mcpJson: tracked('.mcp.json'), settingsLocal: tracked(claudePaths('').rel('settings.local.json')) },
  };
}

// Every linked worktree of the repository `root` is in, as paths. [] outside
// git. Read for uninstall's shared-key check only.
function gitWorktrees(root, { git = defaultGit } = {}) {
  let r;
  try { r = git([...GIT_PREFIX, 'worktree', 'list', '--porcelain'], { cwd: path.resolve(root), env: gitEnv() }); } catch { return []; }
  if (!r || r.status !== 0) return [];
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => canon(l.slice('worktree '.length)));
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isUnder(parent, child) {
  return child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Two env objects with the same keys and values, in any order (stable-json's
// change-detection form; values compared as the strings an env holds).
function sameEnv(a, b) {
  const str = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v)]));
  return stableKey(str(a)) === stableKey(str(b));
}

// The shape of a local entry this module hands out: never an env VALUE.
function entryShape(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    command: typeof raw.command === 'string' ? raw.command : null,
    args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
    envKeys: isPlainObject(raw.env) ? Object.keys(raw.env) : [],
  };
}

// Is a project key below `root` covered by root's own entry? A subfolder of the
// same git repository is (Claude Code keys it by the repository's root); a
// folder in a nested repository, or any subfolder of a non-git root, is not.
function coveredByRoot(key, rootReal, facts) {
  if (!facts.git) return false;
  let dir = key;
  while (isUnder(rootReal, dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return false;
    dir = path.dirname(dir);
  }
  return true;
}

const NESTED_MAX = 20;

// What Claude Code's config says about web-chat for this root. Pure read.
//   { state: 'present'|'absent'|'unknown', key, keys, effectiveKey, realpath,
//     configFile, entry: {command, args, envKeys} | null, envMatches,
//     disabled, disabledKey, nested: [key], git }
// `state` 'unknown' is a config file that exists but cannot be read or parsed.
// `wantEnv` (an env object) asks whether the entry's env equals it: answered
// as `envMatches` (true/false, or null when not asked or absent), so a value
// is compared without leaving this function.
function inspectLocal(root, { configFile = userClaudePaths().claudeJson, git, facts, wantEnv } = {}) {
  const f = facts || gitFacts(root, { git });
  const real = canon(root);
  const keys = [...new Set([f.mainRoot, f.toplevel, real].filter(Boolean))];
  const out = {
    state: 'absent', key: null, keys, effectiveKey: f.mainRoot || real, realpath: real, configFile,
    entry: null, envMatches: null, disabled: false, disabledKey: null, nested: [], git: f,
  };
  const r = readJson(configFile, { validate: isPlainObject });
  if (r.absent) return out;
  if (!r.ok) return { ...out, state: 'unknown' };
  const projects = isPlainObject(r.value.projects) ? r.value.projects : {};
  for (const k of keys) {
    const p = isPlainObject(projects[k]) ? projects[k] : null;
    if (!p) continue;
    if (!out.disabled && Array.isArray(p.disabledMcpServers) && p.disabledMcpServers.includes(MCP_KEY)) {
      out.disabled = true;
      out.disabledKey = k;
    }
    const raw = isPlainObject(p.mcpServers) ? p.mcpServers[MCP_KEY] : null;
    if (out.state !== 'present' && isPlainObject(raw)) {
      out.state = 'present';
      out.key = k;
      out.entry = entryShape(raw);
      if (wantEnv) out.envMatches = sameEnv(isPlainObject(raw.env) ? raw.env : {}, wantEnv);
    }
  }
  for (const k of Object.keys(projects)) {
    if (out.nested.length >= NESTED_MAX) break;
    if (!path.isAbsolute(k) || !isUnder(real, k)) continue;
    const p = projects[k];
    if (isPlainObject(p) && isPlainObject(p.mcpServers) && p.mcpServers[MCP_KEY]) continue;
    if (coveredByRoot(k, real, f)) continue;
    if (!fs.existsSync(k)) continue;
    out.nested.push(k);
  }
  return out;
}

// The env values of the local entry under `key`, for a re-add that must keep
// them. Private: the values never leave this module.
function localEntryEnv(configFile, key) {
  const r = readJson(configFile, { validate: isPlainObject });
  if (!r.ok || !isPlainObject(r.value.projects)) return {};
  const p = r.value.projects[key];
  const raw = isPlainObject(p) && isPlainObject(p.mcpServers) ? p.mcpServers[MCP_KEY] : null;
  return isPlainObject(raw) && isPlainObject(raw.env) ? { ...raw.env } : {};
}

function readSettingsFile(file) {
  const r = readJson(file, { validate: isPlainObject });
  return r.ok ? r.value : null;
}

function listsWebChat(list) {
  return Array.isArray(list) && list.includes(MCP_KEY);
}

// Every directory below root (bounded: depth, count; dot-directories and
// node_modules skipped) for which `visit(dir)` is true.
function walkBelow(root, visit, { maxDepth = 3, maxDirs = 2000 } = {}) {
  const found = [];
  let seen = 0;
  let level = [path.resolve(root)];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (++seen > maxDirs) return found;
        const sub = path.join(dir, e.name);
        if (visit(sub)) found.push(sub);
        next.push(sub);
      }
    }
    level = next;
  }
  return found;
}

// web-chat in the approval lists Claude Code merges for a .mcp.json server:
// the user's, the project's and the project's local settings. A rejection
// (disabledMcpjsonServers) in ANY of them wins over every approval — Claude
// Code merges those lists ungated and checks them first — so `rejected` is the
// verdict, and `rejections` names the files. `nested` lists the folders below
// the root whose own .claude/settings.local.json approves web-chat: sessions
// there reach this root's .mcp.json entry by walking up, so it is kept for them.
// Pure read.
function inspectApprovals(root) {
  const files = [
    { scope: 'user', file: userClaudePaths().claudeSettings },
    { scope: 'project', file: claudePaths(root).settings },
    { scope: 'local', file: claudePaths(root).settingsLocal },
  ];
  const rejections = [];
  const approvals = [];
  for (const f of files) {
    const v = readSettingsFile(f.file);
    if (!v) continue;
    if (listsWebChat(v.disabledMcpjsonServers)) rejections.push(f);
    if (listsWebChat(v.enabledMcpjsonServers)) approvals.push(f);
  }
  const nested = walkBelow(root, (dir) => {
    const v = readSettingsFile(claudePaths(dir).settingsLocal);
    return Boolean(v && listsWebChat(v.enabledMcpjsonServers));
  });
  return { rejected: rejections.length > 0, rejections, approvals, nested };
}

// ── the local entry web-chat wants ──────────────────────────────────────────

const PACKAGE_NAME = (() => { try { return require('../../package.json').name; } catch { return 'claude-web-chat'; } })();
const MCP_BIN = 'claude-web-chat-mcp';

// Is `bin` the MCP bin inside a git checkout of claude-web-chat? Such an entry
// is somebody developing web-chat (the dogfood entry points the repository's
// sessions at the checkout's own MCP server), and it is never "repaired".
function isCheckoutBin(bin) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin) || path.basename(bin) !== `${MCP_BIN}.js`) return false;
  if (!fs.existsSync(bin)) return false;
  const dir = path.dirname(path.dirname(bin));
  if (path.basename(path.dirname(bin)) !== 'bin') return false;
  try {
    if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== PACKAGE_NAME) return false;
  } catch { return false; }
  return fs.existsSync(path.join(dir, '.git'));
}

function localBinOf(entry) {
  if (!entry) return null;
  if (entry.command === 'node' && entry.args.length) return entry.args[0];
  return entry.command;
}

// A present local entry web-chat accepts AS IT IS: `node <bin>` where <bin> is
// this install's stableBin or the MCP bin of a git checkout of web-chat. Any
// other copy — a version directory pruning will delete, an old global install
// — is repointed, so the tools never run old code against a newer daemon.
function localAcceptable(entry, binOpts) {
  if (!entry || entry.command !== 'node' || entry.args.length !== 1) return false;
  const bin = entry.args[0];
  return bin === stableBin(MCP_BIN, binOpts) || isCheckoutBin(bin);
}

// `claude mcp add web-chat --scope local [-e KEY=VALUE …] -- node <stableBin>`.
// The env is what web-chat's .mcp.json entry carried (minus the channel opt-in,
// which belongs on the launch line): WEB_CHAT_PORT, say, which a hand-edited
// entry may pin and a migration must not drop.
function localAddArgv({ env = {}, binOpts } = {}) {
  const e = [];
  for (const [k, v] of Object.entries(env || {})) e.push('-e', `${k}=${v}`);
  return ['mcp', 'add', MCP_KEY, '--scope', 'local', ...e, '--', 'node', stableBin(MCP_BIN, binOpts)];
}

// An argv with every env VALUE taken out: `-e KEY=VALUE` becomes `-e KEY` in
// the record (`record: true`) and `-e KEY=…` for a line printed to a person.
function redactArgv(argv, { record = false } = {}) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (argv[i] === '-e' && i + 1 < argv.length) {
      const kv = String(argv[++i]);
      const k = kv.split('=')[0];
      out.push(record ? k : `${k}=…`);
    }
  }
  return out;
}

// Would Claude Code keep an approval of a .mcp.json server here? It honours an
// approval in the user's own settings everywhere, and one in an untracked
// .claude/settings.local.json of a git repository (which gets a trust entry of
// its own); in a non-git folder whose trust is inherited it keeps none.
function approvalSticks(approvals, facts) {
  if (approvals.approvals.some((a) => a.scope === 'user')) return true;
  return facts.git && !facts.tracked.settingsLocal && approvals.approvals.some((a) => a.scope === 'local');
}

// The whole MCP registration of a project, as data — what status, doctor, open
// and `init --report` word. Pure read (git is asked, `claude` never is):
//   kind: 'disabled' | 'local' | 'rejected' | 'mcpjson' | 'none'
//     disabled  web-chat is in disabledMcpServers (/mcp → Disable) for the key
//     local     a local-scope entry covers this root
//     rejected  only a .mcp.json entry, and web-chat is in disabledMcpjsonServers
//     mcpjson   only a .mcp.json entry: Claude Code asks for approval
//     none      nothing registers web-chat here
//   dialog: a local entry beside a .mcp.json entry whose approval cannot stick
//     — Claude Code's startup dialog ignores other scopes, so it still asks.
function mcpState(root, { configFile, git, binOpts } = {}) {
  const facts = gitFacts(root, { git });
  const mcp = inspectMcp(root);
  const wantEnv = mcp.entry ? (stripChannelEnv(mcp.entry.env) || {}) : undefined;
  const local = inspectLocal(root, { configFile, facts, wantEnv });
  const approvals = inspectApprovals(root);
  let kind;
  if (local.disabled) kind = 'disabled';
  else if (local.state === 'present') kind = 'local';
  else if (mcp.present && approvals.rejected) kind = 'rejected';
  else if (mcp.present) kind = 'mcpjson';
  else kind = 'none';
  const stable = stableBin(MCP_BIN, binOpts);
  const bin = localBinOf(local.entry);
  return {
    kind,
    local,
    approvals,
    mcp,
    facts,
    nested: [...local.nested, ...approvals.nested.filter((d) => !local.nested.includes(canon(d)))],
    bin,
    stableBin: stable,
    binDiffers: Boolean(bin) && bin !== stable,
    acceptable: local.state === 'present' && localAcceptable(local.entry, binOpts),
    coversRepo: Boolean(local.key) && local.key !== local.realpath,
    dialog: kind === 'local' && mcp.present && !approvals.rejected && !approvalSticks(approvals, facts),
  };
}

const tilde = (p) => redactHostPaths(String(p));

// The words for mcpState: one `line` per kind (exactly one of the five), plus
// the `notes` that ride beside it. status, doctor and open print these.
function describeMcp(state, { installed = true } = {}) {
  const s = state;
  const notes = [];
  let line;
  if (s.kind === 'disabled') {
    line = 'disabled in Claude Code for this project (/mcp) — re-enable it there, or run `claude-web-chat off`';
  } else if (s.kind === 'local') {
    line = `registered for you (local scope) in ${tilde(s.local.configFile)}`;
    if (s.coversRepo) line += `, for the whole repository at ${s.local.key}`;
    if (s.binDiffers) line += ` — its server is ${s.bin}, not this install's ${s.stableBin}`;
  } else if (s.kind === 'rejected') {
    line = `REJECTED — web-chat is in disabledMcpjsonServers (${s.approvals.rejections.map((r) => tilde(r.file)).join(', ')}), `
      + 'so web-chat\'s MCP tools are hidden: run `claude-web-chat doctor`, or `claude-web-chat off` if you meant it';
  } else if (s.kind === 'mcpjson') {
    line = 'only in .mcp.json — Claude Code asks every launch here; run `claude-web-chat doctor`';
    if (!s.mcp.resolvable) line += ` (and the entry is not resolvable: ${s.mcp.reason})`;
  } else {
    line = `not registered — run \`claude-web-chat ${installed ? 'doctor' : 'init'}\``;
  }
  if (s.dialog) notes.push('Claude Code still shows its approval dialog at launch here; answering No once is now harmless');
  if (s.nested.length) {
    notes.push(`Claude Code sessions below this folder that do not see the local registration: ${s.nested.join(', ')} — web-chat's .mcp.json entry is kept for them`);
  }
  if (s.local.state === 'unknown') notes.push(`could not read Claude Code's config (${tilde(s.local.configFile)}), so a local-scope registration is unknown`);
  return { kind: s.kind, line, notes };
}

// The live Claude Code processes in this root that run WITHOUT web-chat's MCP
// server: a sessions file (lib/core/claude-sessions) whose cwd is the root or
// below, whose process is alive and is the one that wrote it, and which has no
// role:'mcp' presence row (lib/util/registry mcpSessionsFor) naming it as the
// parent. Pure read; `deps` replace the three sources in tests.
async function sessionsWithoutTools(root, deps = {}) {
  const rootReal = canon(root);
  let states;
  let rows;
  try { states = deps.states || require('../core/claude-sessions').readAllSessionStates(); } catch { states = []; }
  try { rows = deps.mcpRows || require('../util/registry').mcpSessionsFor(root); } catch { rows = []; }
  const here = (states || []).filter((st) => st && typeof st.cwd === 'string' && Number.isInteger(st.pid)
    && (st.cwd === rootReal || isUnder(rootReal, st.cwd)));
  if (!here.length) return [];
  const portfiles = require('../core/portfiles');
  let sample = null;
  if (deps.alive === undefined) {
    try { sample = await portfiles.sampleProcs(here.map((st) => st.pid)); } catch { sample = null; }
  }
  const parents = new Set((rows || []).map((r) => r && r.ppid).filter(Number.isInteger));
  const out = [];
  for (const st of here) {
    const alive = deps.alive
      ? deps.alive(st)
      : (st.procStart ? portfiles.isPidAlive(st.pid, { startedAt: st.procStart, sample: sample || new Map() }) : portfiles.isPidAlive(st.pid));
    if (alive === false || alive === null) continue;
    if (!parents.has(st.pid)) out.push({ pid: st.pid, cwd: st.cwd });
  }
  return out;
}

const WITHOUT_TOOLS_LINE = 'a Claude Code session here is running without web-chat\'s tools';

// "Is web-chat installed in this project at all?" — the one cheap question, kept
// separate from inspect() because the MCP dispatcher asks it on EVERY one of the
// 24 tools' calls in a disabled or uninstalled project, and inspect() would read
// every managed template plus its baselines, dry-run the .gitignore rule and
// build the MCP argv to answer an fs.existsSync. Same definition either way —
// inspect().installed is this function.
function isInstalled(root) {
  return fs.existsSync(projectPaths(root).dir);
}

// Is web-chat wired into this directory — its hook entries, its .mcp.json
// server, or its local-scope entry in Claude Code's config, the things that
// make Claude Code run it? A leftover managed file is not a registration, and
// neither is a .web-chat/ on its own: `uninstall` keeps the graph there, and a
// daemon's own boot creates the directory. So `uninstall` asks this of a
// directory with no .web-chat/ (anything to undo here?), and `update
// --restart-all` asks it before refreshing another project (never register
// web-chat where no `install` did). Never throws.
//
// A local entry counts only when its key IS this directory's physical path.
// Inside a git repository Claude Code keys it by the repository's root, so an
// entry a subfolder's install wrote is found from every folder of the
// repository — and counting it there would let `uninstall` typed in any of
// them remove the registration the real root uses.
function isRegistered(root, opts = {}) {
  try {
    if (inspectMcp(root).present) return true;
    if (Object.values(inspectHooks(root).hooks).some((h) => h !== 'missing')) return true;
    const local = inspectLocal(root, opts);
    return local.state === 'present' && local.key === local.realpath;
  } catch {
    return false;
  }
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
// Two modes, and the default is 0.8.2's ON PURPOSE:
//
//   default       Everything but the stub — a bare command, a stale absolute
//                 path, no entry at all — is rewritten in .mcp.json by
//                 ensureMcpRegistration, and needs no shell-out; `claude` runs
//                 only for an entry that cannot resolve. `update` syncs every
//                 project through this, loading THIS module out of the newly
//                 installed version — including the previous build's `update
//                 --from`, whose syncProject hands apply() a runClaude that
//                 records the argv and prints "cannot resolve" whenever it is
//                 called. Calling it for a resolvable entry would print that
//                 false diagnosis for every project. One addition: a project
//                 already registered at local scope with no .mcp.json entry
//                 left is not given one back (that would re-arm the approval
//                 dialog the local entry exists to end), and its stub is not
//                 re-registered (the local entry already resolves).
//   mcp: 'local'  The registration install, init and doctor make
//                 (applyMcpLocal below). update never asks for it: it does not
//                 write Claude Code's config.
function applyMcp(root, opts = {}) {
  if (opts.mcp === 'local') return applyMcpLocal(root, opts);
  const { dryRun = false, runClaude = defaultRunClaude } = opts;
  if (dryRun) {
    const before = inspectMcp(root);
    return {
      status: before.present ? 'already up to date' : 'web-chat server registered',
      dry: true,
      localScope: before.resolvable ? null : { status: 'would register', argv: mcpArgv() },
    };
  }
  const before = inspectMcp(root);
  const local = (() => { try { return inspectLocal(root, opts); } catch { return { state: 'unknown' }; } })();
  if (!before.present && local.state === 'present') return { status: 'registered at local scope', localScope: null };
  const status = ensureMcpRegistration(root);
  const after = inspectMcp(root);
  if (after.resolvable || local.state === 'present') return { status, localScope: null };

  const argv = mcpArgv();
  // From the root, not the shell's cwd: `--scope local` is per-directory.
  const r = runClaude(argv, { cwd: root });
  if (r && r.ok) return { status, localScope: { status: 'registered', argv } };
  if (r && /already exists/i.test(r.stderr || '')) return { status, localScope: { status: 'already registered', argv } };
  return { status, localScope: { status: r && r.notFound ? 'claude not on PATH' : 'failed', argv } };
}

// What Claude Code says when `claude` cannot run here, in three parts.
const NO_CLAUDE_LINES = [
  'Claude Code\'s `claude` command was not found (not on PATH, in ~/.local/bin or in ~/.claude/local), so web-chat is registered in .mcp.json instead.',
  'Claude Code will ask you to approve it at launch, and may not keep that approval in this folder (a non-git folder inside a trusted one).',
  '`claude-web-chat doctor` finishes the registration once `claude` is available.',
];

// Is this .mcp.json entry exactly the one web-chat would write on this
// machine — `node <stableBin>`, nothing else, env equal to `env`? Only such an
// entry is ever deleted by the migration: one that differs (a teammate's
// path in a shared file, a hand-added key) is reported and kept.
function isOwnMcpEntry(entry, env, binOpts) {
  if (!isPlainObject(entry)) return false;
  const extra = Object.keys(entry).filter((k) => !['command', 'args', 'env', 'type'].includes(k));
  if (extra.length) return false;
  if (entry.type !== undefined && entry.type !== 'stdio') return false;
  if (entry.command !== 'node' || !Array.isArray(entry.args) || entry.args.length !== 1) return false;
  if (entry.args[0] !== stableBin(MCP_BIN, binOpts)) return false;
  return sameEnv(stripChannelEnv(entry.env) || {}, env || {});
}

// Take web-chat's entry out of .mcp.json, and the file with it when nothing
// else is left. 'removed' | 'removed (file empty)' | 'no web-chat entry'.
// Throws userFacing on a file that does not parse.
function dropMcpEntry(root) {
  const mcpPath = mcpPathFor(root);
  let mcp;
  try {
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'no web-chat entry';
    throw userFacing(`error parsing ${mcpPath}: ${e.message}`);
  }
  if (!isPlainObject(mcp) || !isPlainObject(mcp.mcpServers) || !mcp.mcpServers[MCP_KEY]) return 'no web-chat entry';
  delete mcp.mcpServers[MCP_KEY];
  if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers;
  if (Object.keys(mcp).length === 0) {
    fs.unlinkSync(mcpPath);
    return 'removed (file empty)';
  }
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  return 'removed';
}

// The questions a local registration may need a person for, worked out
// BEFORE it runs, so the engine stays synchronous and the asking stays in the
// command (through lib/cli/prompt):
//   rejection  web-chat is in disabledMcpjsonServers — a No someone gave
//              Claude Code — and there is no local entry. Only an install
//              that is CREATING .web-chat/ in this run registers over it
//              unasked: it is the user's own first-time "set this up here".
//   tracked    the migration would edit a .mcp.json git tracks (and the
//              user's teammates share).
// Each is { … } or absent. Pure read.
function mcpQuestions(root, { creating = false, configFile, git, binOpts } = {}) {
  const st = mcpState(root, { configFile, git, binOpts });
  const q = {};
  if (st.kind === 'disabled') return q;
  if (st.local.state !== 'present' && st.approvals.rejected && !creating) {
    q.rejection = { files: st.approvals.rejections.map((r) => r.file) };
  }
  const env = st.mcp.entry ? (stripChannelEnv(st.mcp.entry.env) || {}) : {};
  if (st.mcp.present && st.mcp.kind !== 'stub' && st.facts.tracked.mcpJson && !st.nested.length
    && isOwnMcpEntry(st.mcp.entry, env, binOpts)) {
    q.tracked = { file: mcpPathFor(root) };
  }
  return q;
}

// Ask the mcpQuestions, each defaulting to No. `--register-mcp` (registerMcp)
// is the yes a non-interactive run can give; without it, a run with no
// terminal, or with --yes, answers No and says which flag would change that —
// --yes accepts the printed defaults, and these defaults are No. `decisions`
// carries answers across the commands of one run (init runs doctor, then
// install), so nothing is asked twice. Returns { overRejection, editTracked }.
async function mcpConsent(q, { prompt, registerMcp = false, decisions = {}, log = () => {} } = {}) {
  const consent = {};
  const ask = async (key, lines, question) => {
    if (key in decisions) return decisions[key];
    for (const l of lines) log(l);
    let yes;
    if (registerMcp) {
      log('    --register-mcp given: yes.');
      yes = true;
    } else if (!prompt || !prompt.interactive) {
      log('    (not asked: no terminal, or --yes — pass --register-mcp to do it)');
      yes = false;
    } else {
      yes = await prompt.confirm(question, { def: false });
    }
    decisions[key] = yes;
    return yes;
  };
  if (q && q.rejection) {
    consent.overRejection = await ask('overRejection', [
      `  ⚠ web-chat is in disabledMcpjsonServers (${q.rejection.files.map(tilde).join(', ')}): someone answered No`,
      '    to Claude Code\'s approval dialog for it here, so its MCP tools are hidden. Registering it at',
      '    local scope overrides that No. If the No was deliberate, `claude-web-chat off` (or',
      '    `claude-web-chat uninstall`) is web-chat\'s own off switch, and stops the hooks as well.',
    ], 'Register web-chat\'s MCP server for this folder at local scope anyway?');
  }
  if (q && q.tracked && (!q.rejection || consent.overRejection)) {
    consent.editTracked = await ask('editTracked', [
      `  • ${tilde(q.tracked.file)} is tracked by git. Once web-chat is registered at local scope, its entry`,
      '    there is no longer needed — but removing it is a change to commit, and teammates who still',
      '    rely on it should run `claude-web-chat doctor` in their own copies first.',
    ], 'Remove web-chat\'s entry from the tracked .mcp.json?');
  }
  return consent;
}

// The registration install, init and doctor make: web-chat's MCP server at
// Claude Code's local scope, then web-chat's own .mcp.json entry out of the
// project — never the other way round. Synchronous; the consents come in
// (mcpConsent). Returns
//   { mode: 'local', status, argv, key, configFile, coversRepo, mcpJson,
//     rejection, disabled, nested, legacy, warnings, needs }
// status: 'kept' | 'registered' | 'repointed' | 'disabled' | 'rejected' |
//         'no-claude' | 'failed' | 'unverified' | 'would register' |
//         'would repoint'
// mcpJson.action: 'none' | 'removed' | 'removed (file empty)' | 'kept' |
//         'would remove'  (with `reason` when kept: 'plugin-stub', 'differs',
//         'nested', 'tracked'; `commit: true` after editing a tracked file)
function applyMcpLocal(root, {
  dryRun = false, runClaude = defaultRunClaude, consent = {}, creating = false,
  fallback = 'mcp-json', git, configFile, binOpts, now = Date.now,
} = {}) {
  const facts = gitFacts(root, { git });
  const before = inspectMcp(root);
  const ownEnv = before.entry ? (stripChannelEnv(before.entry.env) || {}) : null;
  const local = inspectLocal(root, { configFile, facts, wantEnv: ownEnv || undefined });
  const approvals = inspectApprovals(root);
  const nested = [...local.nested, ...approvals.nested];
  const out = {
    mode: 'local', status: null, argv: null, key: local.key, configFile: local.configFile, coversRepo: false,
    mcpJson: { action: before.present ? 'kept' : 'none', reason: before.present ? 'unchanged' : undefined },
    rejection: approvals.rejected ? approvals.rejections.map((r) => r.file) : null,
    disabled: local.disabled, nested, legacy: null, warnings: [], needs: [],
    // The 0.8.2 shape, for a caller that still reads it.
    localScope: null,
  };
  const fallBack = (status, warnings) => {
    out.status = status;
    out.warnings.push(...warnings);
    if (fallback === 'mcp-json' && !dryRun) out.legacy = ensureMcpRegistration(root);
    return out;
  };

  // /mcp → Disable is the user's No inside Claude Code: reported, never undone.
  if (local.disabled) { out.status = 'disabled'; return out; }

  let env = ownEnv || {};
  let repoint = false;
  if (local.state === 'present') {
    if (localAcceptable(local.entry, binOpts) && local.envMatches !== false) {
      out.status = 'kept';
    } else {
      repoint = true;
      // No .mcp.json entry to take the env from: keep the one the entry has.
      if (!ownEnv) env = localEntryEnv(local.configFile, local.key);
    }
  } else if (approvals.rejected && !creating && !consent.overRejection) {
    out.status = 'rejected';
    out.needs.push('rejection');
    return out;
  }

  if (out.status !== 'kept') {
    const argv = localAddArgv({ env, binOpts });
    out.argv = redactArgv(argv);
    if (dryRun) {
      out.status = repoint ? 'would repoint' : 'would register';
      out.mcpJson = planMcpJson(root, { before, env, facts, nested, consent, binOpts, dry: true });
      return out;
    }
    if (repoint) runClaude(removeArgv(), { cwd: root });
    const r = runClaude(argv, { cwd: root }) || { ok: false };
    if (!r.ok && r.notFound) return fallBack('no-claude', NO_CLAUDE_LINES);
    if (!r.ok && !/already exists/i.test(r.stderr || '')) {
      const why = String(r.stderr || '').split('\n').find((l) => l.trim()) || 'it failed';
      return fallBack('failed', [`\`claude ${out.argv.join(' ')}\` did not register web-chat: ${why.trim()}`]);
    }
    // Verify: other Claude Code sessions read-modify-write that file, and a
    // `claude` that answered ok proves nothing about what is there now.
    const v = inspectLocal(root, { configFile, facts });
    if (v.state !== 'present') {
      return fallBack('unverified', [
        `\`claude ${out.argv.join(' ')}\` ran, but Claude Code's config (${tilde(v.configFile)}) does not show the entry — another`,
        'Claude Code session may have rewritten the file. Run `claude-web-chat doctor` again to re-add it.',
      ]);
    }
    out.status = repoint ? 'repointed' : 'registered';
    out.key = v.key;
    out.localScope = { status: 'registered', argv: out.argv };
    if (fs.existsSync(projectPaths(root).dir)) {
      writeJsonAtomic(projectPaths(root).mcpRegistration, {
        scope: 'local', at: now(), argv: redactArgv(argv, { record: true }), config_file: v.configFile, key: v.key,
      }, { newline: true });
    }
  }
  out.coversRepo = Boolean(out.key) && out.key !== local.realpath;

  // Only now, with a verified local entry, does web-chat's own .mcp.json
  // entry go — and only the exact entry this machine would write.
  out.mcpJson = planMcpJson(root, { before, env, facts, nested, consent, binOpts, dry: dryRun });
  if (out.mcpJson.action === 'remove') {
    const done = dropMcpEntry(root);
    out.mcpJson = { action: done === 'no web-chat entry' ? 'none' : done, commit: facts.tracked.mcpJson };
  }
  if (out.mcpJson.reason === 'tracked') out.needs.push('tracked');
  return out;
}

// What the migration would do with web-chat's .mcp.json entry.
function planMcpJson(root, { before, env, facts, nested, consent, binOpts, dry }) {
  if (!before.present) return { action: 'none' };
  if (before.kind === 'stub') return { action: 'kept', reason: 'plugin-stub' };
  if (!isOwnMcpEntry(before.entry, env, binOpts)) {
    const arg = Array.isArray(before.entry.args) && before.entry.args[0];
    return { action: 'kept', reason: 'differs', detail: arg || before.entry.command || null };
  }
  if (nested.length) return { action: 'kept', reason: 'nested' };
  if (facts.tracked.mcpJson && !consent.editTracked) return { action: 'kept', reason: 'tracked' };
  return { action: dry ? 'would remove' : 'remove', commit: facts.tracked.mcpJson };
}

// What one local registration result means, in the lines install and doctor
// print under it (the status word itself is theirs). [] when nothing more.
function mcpResultLines(m) {
  if (!m || m.mode !== 'local') return [];
  const lines = [...(m.warnings || [])];
  if (m.coversRepo && (m.status === 'registered' || m.status === 'repointed')) {
    lines.push(`It covers the whole repository at ${m.key} — every folder and worktree of it — not only this one.`);
  }
  const j = m.mcpJson || {};
  if (j.action === 'removed' || j.action === 'removed (file empty)') {
    lines.push(j.commit
      ? 'web-chat\'s entry was removed from .mcp.json, which git tracks — commit this change.'
      : 'web-chat\'s entry was removed from .mcp.json: the local-scope registration replaces it.');
  } else if (j.action === 'kept') {
    if (j.reason === 'differs') lines.push(`.mcp.json's web-chat entry (${j.detail}) differs from what was registered, so it is kept — remove it by hand once nobody needs it.`);
    else if (j.reason === 'nested') lines.push('.mcp.json\'s web-chat entry is kept: Claude Code sessions below this folder reach it and do not see the local registration.');
    else if (j.reason === 'tracked') lines.push('.mcp.json (tracked by git) still has web-chat\'s entry — `claude-web-chat doctor --register-mcp` removes it; commit that change.');
  }
  if (m.nested && m.nested.length) lines.push(`Sessions below this folder that do not see the local registration: ${m.nested.join(', ')}`);
  return lines;
}

// Make this project registered: hooks, managed files, .gitignore, MCP entry.
// dryRun is threaded all the way down, because `doctor --dryRun` and
// `init --report` promise the caller they change nothing on disk.
//
// Deliberately EXCLUDED (they stay in lib/cli/commands/install.js): creating
// .web-chat/, running the migrations, and pre-warming the daemon.
//
// `hooks` is applyHooks' answer: { added, updated, events }. `mcp: 'local'`
// (with `creating`, `consent`, `fallback`) asks for the local-scope
// registration — see applyMcp.
function apply(root, opts = {}) {
  const { force = false, dryRun = false } = opts;
  const hooks = applyHooks(root, { dryRun });
  const managed = reconcileManagedFiles(root, { force, dryRun });
  const gitignore = ensureGitignore(root, { dryRun });
  const mcp = applyMcp(root, { ...opts, dryRun });
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

// The other web-chat roots that share this root's local-scope key — the key
// Claude Code would file (or has filed) its entry under. Outside git the key is
// the folder's own physical path, which nothing else shares. Inside a
// repository it is the main worktree's root, so the candidates are every
// project the registry knows (lib/util/registry sessions(): live and known
// roots), every linked worktree, and every .web-chat/ below the repository's
// root or a worktree (a bounded walk) — each kept when it has a .web-chat/ and
// its own key is the same. Pure read. { key, others: [root] }
function sharedKeyRoots(root, { git, configFile, knownRoots } = {}) {
  const facts = gitFacts(root, { git });
  const local = inspectLocal(root, { configFile, facts });
  const key = local.state === 'present' ? local.key : local.effectiveKey;
  const self = canon(root);
  if (!facts.git) return { key, others: [] };
  const bases = [...new Set([facts.mainRoot, facts.toplevel, ...gitWorktrees(root, { git })].filter(Boolean))];
  const candidates = new Set();
  let known = knownRoots;
  if (!known) {
    try { known = require('../util/registry').sessions().map((r) => r.root); } catch { known = []; }
  }
  for (const r of known || []) {
    const c = canon(r);
    if (bases.some((b) => c === b || isUnder(b, c))) candidates.add(c);
  }
  for (const b of bases) {
    candidates.add(b);
    for (const d of walkBelow(b, (dir) => fs.existsSync(projectPaths(dir).dir), { maxDepth: 4 })) candidates.add(canon(d));
  }
  const others = [];
  for (const c of candidates) {
    if (c === self || !fs.existsSync(projectPaths(c).dir)) continue;
    const f = gitFacts(c, { git });
    if ((f.mainRoot || c) === key) others.push(c);
  }
  return { key, others: others.sort() };
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
function remove(root, { runClaude = defaultRunClaude, git, configFile, knownRoots } = {}) {
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
  if (fs.existsSync(mcpPathFor(root))) {
    try {
      const done = dropMcpEntry(root);
      mcpStatus = done === 'removed' ? 'web-chat entry removed' : done;
    } catch (e) {
      mcpStatus = `error parsing (${e.message.replace(/^error parsing [^:]*: /, '')})`;
    }
  }

  // 4. the LOCAL-scope registration in Claude Code's own config — the one
  // install and doctor write, and the reason "uninstall" used to leave the MCP
  // server still spawning for this project. Tolerates "not found"; on a machine
  // with no `claude`, reports the command instead of claiming a removal.
  //
  // Inside a git repository that entry is keyed by the repository's root, so it
  // is SHARED by every web-chat root in the repository and its worktrees. When
  // another one exists (a known project, or a .web-chat/ under the same root or
  // a sibling worktree), removing it would take the tools from that project
  // too: the command is printed instead, and nothing is removed.
  const argv = removeArgv();
  let localScope;
  const shared = sharedKeyRoots(root, { git, configFile, knownRoots });
  if (shared.others.length) {
    localScope = { status: 'shared', argv, key: shared.key, others: shared.others };
  } else {
    // From the root, for the same reason apply() registers from it: run in a
    // subdirectory this un-registered nothing and reported a removal.
    const r = runClaude(argv, { cwd: root });
    if (r && r.ok) localScope = { status: 'removed', argv };
    else if (r && r.notFound) localScope = { status: 'claude not on PATH', argv };
    else if (r && /no .*server|not found|does not exist/i.test(r.stderr || '')) localScope = { status: 'not registered', argv };
    else localScope = { status: 'could not remove', argv };
    if (localScope.status === 'removed' || localScope.status === 'not registered') rm(projectPaths(root).mcpRegistration);
  }

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
  isRegistered,
  inspect,
  apply,
  applyHooks,
  applyMcp,
  remove,
  // ── the local scope (0.8.5) ──
  MCP_KEY,
  inspectLocal,
  inspectApprovals,
  mcpState,
  describeMcp,
  mcpQuestions,
  mcpConsent,
  mcpResultLines,
  localAddArgv,
  redactArgv,
  sharedKeyRoots,
  sessionsWithoutTools,
  WITHOUT_TOOLS_LINE,
  NO_CLAUDE_LINES,
};
