const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectPaths, claudePaths, installPaths, PACKAGE_ROOT, isInside } = require('../core/paths');
const { CHANNEL_ENV, CHANNEL_ENV_VALUE } = require('../core/channels');

// The per-project template files that `install` copies verbatim (not the
// JSON-merge ones — .mcp.json and settings.json are reconciled structurally by
// ensureMcpRegistration/ensureHooks below). These are the files a shipped
// package update changes, that an existing install would otherwise never see.
// `dest` is repo-relative POSIX (it is stored as a baseline key and printed in
// status/init output), minted through claudePaths().rel so the '.claude' literal
// stays in lib/core/paths.js — the same rule '.web-chat' has always had.
const CLAUDE_REL = claudePaths('').rel;
const MANAGED_FILES = [
  { tpl: 'rules/web-chat.md', dest: CLAUDE_REL('rules', 'web-chat.md') },
  { tpl: 'commands/web-chat.md', dest: CLAUDE_REL('commands', 'web-chat.md') },
  { tpl: 'skills/capture-profile/SKILL.md', dest: CLAUDE_REL('skills', 'capture-profile', 'SKILL.md') },
  { tpl: 'skills/respond-to-comment/SKILL.md', dest: CLAUDE_REL('skills', 'respond-to-comment', 'SKILL.md') },
];

// The skill names web-chat itself owns, derived from MANAGED_FILES rather than
// re-listed. A component pack may not install a skill under one of these names:
// it would be silently reverted by the next `install`/`update` reconcile, which
// is a worse outcome than a refusal.
function managedSkillNames() {
  const out = [];
  for (const { dest } of MANAGED_FILES) {
    const m = dest.split('/');
    if (m.length === 4 && m[1] === 'skills') out.push(m[2]);
  }
  return out;
}

function templatesDir() {
  return path.join(__dirname, '..', '..', 'templates');
}

function hashContent(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Baseline store: maps each managed dest (repo-relative) to the sha256 of the
// shipped template content this file was last RECONCILED AGAINST — applied or
// merely offered. (It used to mean "what we last wrote"; see the
// conflict→resolution note above conflictAdvice for why the wider meaning is
// what makes the state machine terminate.) Lets the 3-way reconcile distinguish
// "user edited it" from "we shipped a new version". Separate from _version.json
// (which migrations rewrite via writeVersion and would clobber).
function baselinePath(root) {
  return projectPaths(root).managed;
}

function readBaselines(root) {
  try {
    const data = JSON.parse(fs.readFileSync(baselinePath(root), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    // Missing or malformed — treat as no baselines. Reconcile falls back to the
    // bootstrap path, which is non-destructive.
    return {};
  }
}

function writeBaselines(root, baselines) {
  const f = baselinePath(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(baselines, null, 2) + '\n');
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// The actions after which the file on disk IS the shipped template — the only
// states in which a leftover `<dest>.new` is stale rather than outstanding.
const REACHED_SHIPPED = new Set(['created', 'up-to-date', 'updated', 'overwritten']);

// 3-way reconcile of managed template files. Compares shipped (template),
// local (on-disk), and baseline (the shipped bytes this file was last
// reconciled against) to decide, per file, whether to auto-apply a safe update,
// preserve a user edit, or flag a conflict.
// Returns one result per file: { dest, tpl, action, sidecar?, pending? }.
// Actions: created | up-to-date | updated | conflict | kept-edited | differs | overwritten.
// `pending` means a `<dest>.new` sidecar is sitting beside a file that still
// differs from shipped: an offer the user has neither merged nor dismissed. It
// is derived from the filesystem on every call, never persisted — deleting the
// sidecar is how the user ends the reminder.
// With { dryRun: true } it computes actions and writes nothing.
function reconcileManagedFiles(root, { force = false, dryRun = false } = {}) {
  const baselines = readBaselines(root);
  const results = [];
  let baselinesDirty = false;

  for (const { tpl, dest } of MANAGED_FILES) {
    const tplPath = path.join(templatesDir(), tpl);
    const destPath = path.join(root, dest);
    const sidecarPath = destPath + '.new';

    const shipped = hashContent(fs.readFileSync(tplPath, 'utf8'));
    const localContent = readFileOrNull(destPath);
    const local = localContent == null ? null : hashContent(localContent);
    const baseline = Object.prototype.hasOwnProperty.call(baselines, dest) ? baselines[dest] : null;
    const sidecarBefore = fs.existsSync(sidecarPath);

    let action;
    let writeFile = false;     // write template -> destPath
    let writeSidecar = false;  // write template -> sidecarPath
    let setBaseline = null;    // value to record in baselines[dest]

    if (force) {
      action = 'overwritten';
      writeFile = true;
      setBaseline = shipped;
    } else if (local == null) {
      action = 'created';
      writeFile = true;
      setBaseline = shipped;
    } else if (local === shipped) {
      action = 'up-to-date';
      // Record baseline if absent so future template bumps reconcile cleanly.
      if (baseline !== shipped) setBaseline = shipped;
    } else if (baseline != null && local === baseline && shipped !== baseline) {
      // Local matches what we last wrote; only the template moved → safe to apply.
      action = 'updated';
      writeFile = true;
      setBaseline = shipped;
    } else if (baseline != null && local !== baseline && shipped !== baseline) {
      // Both diverged from baseline → conflict. Non-destructive: write a sidecar
      // and RECORD the offer. Recording is what lets the machine converge: the
      // next run sees shipped === baseline, so a hand merge lands on
      // `kept-edited` instead of re-announcing the same offer forever. A real
      // template change moves `shipped` off this baseline and re-fires here.
      action = 'conflict';
      writeSidecar = true;
      setBaseline = shipped;
    } else if (baseline != null && local !== baseline && shipped === baseline) {
      // User edited; template unchanged → respect the edit.
      action = 'kept-edited';
    } else {
      // baseline == null && local !== shipped → bootstrap drift. No shipped
      // historical hashes, so we can't tell an edit from an old version. Leave
      // it, warn, suggest --force to adopt.
      action = 'differs';
    }

    // A sidecar is cleared only once the file has actually REACHED the shipped
    // bytes. Anywhere else it is both the merge material and the only reminder
    // that an offer is outstanding — including on `kept-edited` (the state a
    // hand merge settles into) and on `differs` (bootstrap with no baseline,
    // where the file still diverges and the reference must survive the baseline
    // having been lost).
    const removeSidecar = !writeSidecar && sidecarBefore && REACHED_SHIPPED.has(action);
    // What the filesystem will hold when this call is done — which under dryRun
    // is exactly what it holds now, since dryRun writes nothing.
    const sidecarAfter = dryRun ? sidecarBefore : (writeSidecar || (sidecarBefore && !removeSidecar));
    const pending = sidecarAfter && local !== shipped;

    if (!dryRun) {
      if (writeFile) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(tplPath, destPath);
      }
      if (writeSidecar) {
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
        fs.copyFileSync(tplPath, sidecarPath);
      } else if (removeSidecar) {
        fs.unlinkSync(sidecarPath);
      }
      if (setBaseline != null && baselines[dest] !== setBaseline) {
        baselines[dest] = setBaseline;
        baselinesDirty = true;
      }
    }

    results.push({
      dest,
      tpl,
      action,
      ...(writeSidecar || pending ? { sidecar: dest + '.new' } : {}),
      ...(pending ? { pending: true } : {}),
    });
  }

  if (!dryRun && baselinesDirty) writeBaselines(root, baselines);
  return results;
}

// --- Idempotent install/update shared helpers (extracted from install.js) ---

// Add `.web-chat/` to the project's .gitignore.
//
// CLAUDE.md, docs/export-pages.md and docs/capture-profiles-and-panes.md all
// state that `.web-chat/` IS gitignored, and nothing ever wrote the line — so
// unless the user happened to add it themselves, every project was one
// `git add -A` away from committing its graph, its portfile, its captures and
// its draft. Idempotent, append-only, and it never rewrites an existing rule:
// if any line already covers `.web-chat`, this is a no-op.
// Returns 'added' | 'already-present' | 'no-gitignore'.
//
// With { dryRun: true } it decides and returns the same value while writing
// nothing — 'added' then means "would add". That mode is what
// registration.inspect() reads, so "is the rule there?" has one implementation
// rather than a writer plus a read-only copy of its test.
function ensureGitignore(root, { dryRun = false } = {}) {
  const f = path.join(root, '.gitignore');
  let body;
  try { body = fs.readFileSync(f, 'utf8'); }
  catch {
    // No .gitignore at all. Only create one in a git repo — writing it into a
    // plain directory would be litter.
    if (!fs.existsSync(path.join(root, '.git'))) return 'no-gitignore';
    body = '';
  }
  const covered = body.split('\n').some((l) => {
    const t = l.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return t === '.web-chat';
  });
  if (covered) return 'already-present';
  const sep = body === '' ? '' : (body.endsWith('\n') ? '' : '\n');
  if (!dryRun) {
    fs.writeFileSync(f, `${body}${sep}\n# claude-web-chat per-project state (graph, components, portfile, drafts)\n.web-chat/\n`);
  }
  return 'added';
}

// The bin path to write into a project's .mcp.json / .claude/settings.json.
//
// Two things are true at once, and this reconciles them:
//
//   * A BARE `claude-web-chat-hook` resolves only when the package is on PATH.
//     In a plain checkout, or a session whose PATH lacks it, the hook exits 127
//     and the turn lifecycle silently never runs — no lock, no commit, an empty
//     graph. So an absolute path it must be.
//   * But a MANAGED install must NOT be pinned to the version directory this
//     process happens to be running from. `pruneVersions` deletes all but the
//     newest KEEP_VERSIONS, so `versions/0.6.0/bin/...` becomes a dangling
//     reference three updates later: the MCP server stops spawning and every
//     hook exits non-zero, silently, in every project. A rollback has the same
//     effect immediately.
//
// `~/.web-chat/current` is a symlink this program owns and repoints on every
// activate, so it survives updates AND rollbacks. A dev checkout or an
// unmanaged copy has no `current` pointing at it, and keeps its own absolute
// path — which is exactly why that path exists.
// `packageRoot`/`paths` are injectable for the same reason describeInstall's are:
// a test cannot move the tree it is running from, so the decision has to be
// exercisable against a fabricated one.
function stableBin(name, { packageRoot = PACKAGE_ROOT, paths = installPaths() } = {}) {
  return isInside(paths.versions, packageRoot)
    ? paths.currentBin(name)
    : path.join(packageRoot, 'bin', `${name}.js`);
}

// Point a hook command at the stable bin, whatever shape it is in now.
//
// Handles the bare PATH-dependent token, AND an absolute path left behind by an
// older install — including one pinned to a version directory that has since
// been pruned. Without the second case the B3 fix would only ever help NEW
// projects: `ensureHooks` skips an event that already has a web-chat handler, so
// a stale entry would stay stale forever. Idempotent — a correct command
// rewrites to itself.
function resolveHookCommand(cmd) {
  const s = String(cmd);
  if (!s.includes('claude-web-chat-hook')) return s;
  const bin = stableBin('claude-web-chat-hook');
  // Everything after the bin is the subcommand and its arguments.
  const m = s.match(/claude-web-chat-hook(?:\.js)?["']?\s*(.*)$/);
  const tail = m && m[1] ? ` ${m[1].trim()}` : '';
  return `node "${bin}"${tail}`;
}

// The hook template — templates/settings.hooks.json — read from ONE place.
// It is the single source of truth for which hook events "registered" means
// (UserPromptSubmit takes the turn lock, Stop commits the node), so it gets one
// reader: ensureHooks below merges its handlers, and lib/setup/registration's
// hookEvents() takes Object.keys off this accessor for doctor, status and
// uninstall. Kept here, below the engine, because ensureHooks is here.
function hookTemplate() {
  return JSON.parse(fs.readFileSync(path.join(templatesDir(), 'settings.hooks.json'), 'utf8'));
}

// Merge the hook template into .claude/settings.json. Idempotent: only adds
// handlers whose command references claude-web-chat-hook if not already present,
// and upgrades an older bare registration in place.
// Returns the number of hooks added.
//
// With { dryRun: true } it computes that number and writes nothing — the mode
// `doctor --dryRun` and `init --report` need, both of which promise the caller
// they touch no file.
function ensureHooks(root, { dryRun = false } = {}) {
  const claude = claudePaths(root);
  if (!dryRun) fs.mkdirSync(claude.dir, { recursive: true });
  const settingsPath = claude.settings;
  const template = hookTemplate();

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      const err = new Error(`error parsing ${settingsPath}: ${e.message}`);
      err.userFacing = true;
      throw err;
    }
  }
  settings.hooks = settings.hooks || {};
  let addedHooks = 0;
  for (const [event, handlers] of Object.entries(template.hooks)) {
    settings.hooks[event] = settings.hooks[event] || [];
    let alreadyHas = false;
    for (const h of settings.hooks[event]) {
      for (const hh of (h && h.hooks) || []) {
        if (!hh.command || !hh.command.includes('claude-web-chat-hook')) continue;
        alreadyHas = true;
        // Upgrade an older bare registration in place (no-op once resolved).
        hh.command = resolveHookCommand(hh.command);
      }
    }
    if (alreadyHas) continue;
    for (const handler of handlers) {
      settings.hooks[event].push({
        ...handler,
        hooks: (handler.hooks || []).map(hh => ({ ...hh, command: resolveHookCommand(hh.command) })),
      });
    }
    addedHooks += handlers.length;
  }
  if (!dryRun) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return addedHooks;
}

// Merge the channels opt-in (WEB_CHAT_CHANNEL=1) into an existing env object,
// preserving any unrelated keys a user hand-added (idempotent, no
// clobber). Always returns a fresh object.
function channelEnv(existingEnv) {
  const base = existingEnv && typeof existingEnv === 'object' && !Array.isArray(existingEnv) ? existingEnv : {};
  return { ...base, [CHANNEL_ENV]: CHANNEL_ENV_VALUE };
}

// The inverse, and what install/update/doctor now actually write.
//
// Wiring WEB_CHAT_CHANNEL=1 into .mcp.json made it a permanent property of the
// PROJECT, but the channel capability is a property of the SESSION — it exists
// only when Claude Code was launched with `--dangerously-load-development-channels
// server:web-chat`. With the env always on, the MCP server started its channel
// bridge in every session, including ones with no channel behind it: a Push was
// written to stdout, self-acked, and reported "Delivered to Claude ✓" while
// being dropped, and the parked-delivery fallback — the path nearly every user
// is on — never ran at all.
//
// The env now comes only from the launch line that also carries the flag (see
// LAUNCH_COMMAND in lib/core/channels.js), so the two can no longer disagree.
// Returns undefined when nothing is left, so no empty `env: {}` is written.
function stripChannelEnv(existingEnv) {
  if (!existingEnv || typeof existingEnv !== 'object' || Array.isArray(existingEnv)) return undefined;
  const { [CHANNEL_ENV]: _dropped, ...rest } = existingEnv;
  return Object.keys(rest).length ? rest : undefined;
}

// Does a .mcp.json web-chat entry carry the channels opt-in? (Shared by status +
// doctor to report / repair the channels-env wiring.)
function mcpEntryHasChannelEnv(entry) {
  return Boolean(entry && entry.env && entry.env[CHANNEL_ENV] === CHANNEL_ENV_VALUE);
}

// Register the MCP server in .mcp.json (project-scoped, checked into repo).
// Rewrites the web-chat entry with an absolute path to the MCP bin. Returns
// 'web-chat server registered' or 'already up to date'.
function ensureMcpRegistration(root) {
  const mcpPath = path.join(root, '.mcp.json');
  let mcp = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch (e) {
      const err = new Error(`error parsing ${mcpPath}: ${e.message}`);
      err.userFacing = true;
      throw err;
    }
  }
  mcp.mcpServers = mcp.mcpServers || {};
  const existing = mcp.mcpServers['web-chat'];
  const hadEntry = Boolean(existing);
  // A plugin-packaged install registers the portable form
  // `${CLAUDE_PLUGIN_ROOT}/bin/...` (see .claude-plugin/plugin.json). That entry
  // is PRESERVED, whether or not this process happens to be running under plugin
  // packaging — the one ${CLAUDE_PLUGIN_ROOT} policy in the tree, and it is
  // doctor's.
  //
  // It used to be conditional on the env var being set, so with it unset (every
  // dogfooding session in this repo) `install` replaced the committed
  // placeholder with THIS MACHINE's absolute path — how a /Users/<someone>/…
  // path got into a tracked .mcp.json once already. Meanwhile `doctor`, facing
  // the identical entry, deliberately left the file alone and registered at
  // Claude Code's local scope instead. Two commands, one file, two policies.
  //
  // Preserving it here is only half the fix: a stub that cannot resolve spawns
  // nothing. lib/setup/registration.apply() completes it by running
  // `claude mcp add --scope local`, exactly as doctor's repair does — a
  // registration that overrides .mcp.json for this project without touching it.
  const portable = hadEntry && JSON.stringify(existing.args || []).includes('${CLAUDE_PLUGIN_ROOT}');
  if (portable) {
    const kept = { ...existing };
    const env = stripChannelEnv(existing.env);
    if (env) kept.env = env; else delete kept.env;
    mcp.mcpServers['web-chat'] = kept;
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
    return 'kept plugin registration';
  }
  // Register an absolute path to the MCP bin, not the bare `claude-web-chat-mcp`
  // command. The bare command depends on the package being on PATH (an `npm
  // link`/global install), which silently fails to spawn after `/exit` + reopen
  // in checkouts where it isn't — the exact failure that motivated this. The
  // resolved path always spawns.
  const mcpBin = stableBin('claude-web-chat-mcp');
  // Deliberately NO WEB_CHAT_CHANNEL here — see stripChannelEnv above. Any
  // unrelated env keys the user hand-added survive; a stale channel opt-in
  // written by an older install is cleaned up on this pass.
  const entry = { command: 'node', args: [mcpBin] };
  const env = stripChannelEnv(existing && existing.env);
  if (env) entry.env = env;
  mcp.mcpServers['web-chat'] = entry;
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  return hadEntry ? 'already up to date' : 'web-chat server registered';
}

// Everything the tree says about a managed-file CONFLICT, in one place.
//
// It was said four different ways — install ("Review and merge, then re-run
// install"), update ("review and merge"), init ("Review and merge those by
// hand") and status ("see .new sidecars") — and the two that gave a next step
// gave one that could not work, because the reconcile above had no
// conflict→resolution transition. It has one now, and this is the machine the
// wording describes:
//
//   1. local, shipped and baseline all differ → CONFLICT. The shipped bytes go
//      into `<dest>.new`, the file is untouched, and the baseline advances to
//      the bytes we just offered. That is why the baseline means "the shipped
//      bytes this file was last reconciled against — applied OR offered": it is
//      the record of the offer, and without it the same offer is announced
//      again on every install and every update, forever.
//   2. the user merges by hand. `shipped` now equals the baseline, so the next
//      run is `kept-edited` — settled, the merge respected, nothing rewritten.
//   3. `<dest>.new` is still there, so the row is `pending` and every consumer
//      can remind. Deleting the sidecar is the whole resolution ritual; there is
//      no new state to persist and no flag to pass.
//   4. the template genuinely moves. `shipped` leaves the recorded baseline
//      behind, so step 1 fires again with a fresh sidecar. Only the SAME offer
//      goes quiet.
//
// So: one helper, one wording, and the step it names is one that terminates.
// `--force` is still the shortcut that adopts the shipped bytes wholesale, and
// still discards the edits — it is an alternative to merging, not the only exit.
function conflictAdvice(results) {
  const rows = results || [];
  const conflicts = rows.filter((r) => r.action === 'conflict');
  // A pending row that is ALSO a conflict is announced once, above, not twice.
  const pending = rows.filter((r) => r.action !== 'conflict' && r.pending);
  const lines = [];
  if (conflicts.length) {
    lines.push(
      `  ⚠ ${conflicts.length} conflict(s): the shipped update is beside your edited file:`,
      ...conflicts.map((r) => `      ${r.sidecar || r.dest + '.new'}`),
      '    Merge what you want by hand, then delete the .new — that settles it: your file is',
      '    kept as-is and this stops being reported until the template changes again.',
      '    `claude-web-chat install --force` instead adopts the shipped version and discards',
      '    your edits.',
    );
  }
  if (pending.length) {
    lines.push(
      `  ⚠ ${pending.length} unmerged .new sidecar(s) still beside your edited file(s):`,
      ...pending.map((r) => `      ${r.sidecar || r.dest + '.new'}`),
      '    Your file is being kept as-is. Merge what you still want from the .new, then',
      '    delete it to clear this reminder.',
    );
  }
  return lines;
}

// The same facts as one line, for `status`, which reports state rather than
// advising. Same words for the resolution step, same home.
function conflictSummary(results) {
  const rows = results || [];
  const conflicts = rows.filter((r) => r.action === 'conflict');
  const pending = rows.filter((r) => r.action !== 'conflict' && r.pending);
  const parts = [];
  if (conflicts.length) {
    parts.push(`conflicts: ${conflicts.map((r) => r.dest).join(', ')} — merge the .new beside each, then delete it (\`install --force\` adopts the shipped version and discards your edits)`);
  }
  if (pending.length) {
    parts.push(`unmerged: ${pending.map((r) => r.sidecar || r.dest + '.new').join(', ')} — merge what you want, then delete to clear`);
  }
  return parts.join('; ');
}

// Shared per-file status output for the reconcile results.
function printResults(results) {
  const labels = {
    created: 'created',
    'up-to-date': 'up to date',
    updated: 'updated (template changed)',
    conflict: 'CONFLICT — wrote .new sidecar, kept your edits',
    // (see conflictAdvice for the step that ends it: merge, then delete the .new)
    'kept-edited': 'kept (locally edited)',
    // A pack unit whose installed record did not survive validation. Nothing
    // was touched; the record needs a human, and the one thing that human needs
    // is WHICH path was refused — so `reason` prints, not just the label.
    refused: 'REFUSED — the installed record did not validate',
    differs: 'differs from shipped — run with --force to adopt',
    overwritten: 'overwritten',
    // A same-pack update's deletions: what the PREVIOUS version installed and
    // this one no longer ships. Its own word, because "removed" beside an
    // "overwritten" row for the same component reads as a contradiction, and
    // because deletions made by an update are not a removal anyone asked for.
    pruned: 'removed (this version no longer ships it)',
  };
  let pad = 0;
  for (const r of results) if (r.dest.length > pad) pad = r.dest.length;
  for (const r of results) {
    // A settled row with an outstanding offer beside it. The `conflict` label
    // already says the sidecar is there, so it does not get the suffix twice.
    const reminder = r.pending && r.action !== 'conflict' ? '  (.new still unmerged)' : '';
    console.log(`  ${r.dest.padEnd(pad)}   ${labels[r.action] || r.action}${reminder}`);
    if (r.action === 'refused' && r.reason) console.log(`  ${' '.repeat(pad)}   ↳ ${r.reason}`);
  }
}

module.exports = {
  MANAGED_FILES,
  conflictAdvice,
  conflictSummary,
  managedSkillNames,
  hookTemplate,
  stableBin,
  resolveHookCommand,
  ensureGitignore,
  templatesDir,
  hashContent,
  baselinePath,
  readBaselines,
  writeBaselines,
  reconcileManagedFiles,
  ensureHooks,
  ensureMcpRegistration,
  channelEnv,
  stripChannelEnv,
  mcpEntryHasChannelEnv,
  printResults,
};
