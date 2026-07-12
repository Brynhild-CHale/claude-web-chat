const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectPaths } = require('../core/paths');
const { CHANNEL_ENV, CHANNEL_ENV_VALUE } = require('../core/channels');

// The per-project template files that `install` copies verbatim (not the
// JSON-merge ones — .mcp.json and settings.json are reconciled structurally by
// ensureMcpRegistration/ensureHooks below). These are the files a shipped
// package update changes, that an existing install would otherwise never see.
const MANAGED_FILES = [
  { tpl: 'rules/web-chat.md', dest: '.claude/rules/web-chat.md' },
  { tpl: 'commands/web-chat.md', dest: '.claude/commands/web-chat.md' },
  { tpl: 'skills/capture-profile/SKILL.md', dest: '.claude/skills/capture-profile/SKILL.md' },
];

function templatesDir() {
  return path.join(__dirname, '..', '..', 'templates');
}

function hashContent(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Baseline store: maps each managed dest (repo-relative) to the sha256 of the
// template content we last wrote there. Lets the 3-way reconcile distinguish
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

// 3-way reconcile of managed template files. Compares shipped (template),
// local (on-disk), and baseline (what we last wrote) to decide, per file,
// whether to auto-apply a safe update, preserve a user edit, or flag a conflict.
// Returns one result per file: { dest, tpl, action, sidecar? }.
// Actions: created | up-to-date | updated | conflict | kept-edited | differs | overwritten.
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
      // Both diverged from baseline → conflict. Non-destructive: write a sidecar.
      action = 'conflict';
      writeSidecar = true;
    } else if (baseline != null && local !== baseline && shipped === baseline) {
      // User edited; template unchanged → respect the edit.
      action = 'kept-edited';
    } else {
      // baseline == null && local !== shipped → bootstrap drift. No shipped
      // historical hashes, so we can't tell an edit from an old version. Leave
      // it, warn, suggest --force to adopt.
      action = 'differs';
    }

    if (!dryRun) {
      if (writeFile) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(tplPath, destPath);
      }
      if (writeSidecar) {
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
        fs.copyFileSync(tplPath, sidecarPath);
      } else if (action !== 'differs' && fs.existsSync(sidecarPath)) {
        // Clear a stale sidecar once the file has reconciled to a known state.
        // Skip on `differs` (bootstrap with no baseline): the file still
        // diverges from shipped, so a conflict sidecar is still a useful
        // reference and must not be discarded just because the baseline was
        // lost or never recorded.
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
      ...(writeSidecar ? { sidecar: dest + '.new' } : {}),
    });
  }

  if (!dryRun && baselinesDirty) writeBaselines(root, baselines);
  return results;
}

// --- Idempotent install/update shared helpers (extracted from install.js) ---

// Merge the hook template into .claude/settings.json. Idempotent: only adds
// handlers whose command references claude-web-chat-hook if not already present.
// Returns the number of hooks added.
function ensureHooks(root) {
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hookTemplate = JSON.parse(fs.readFileSync(path.join(templatesDir(), 'settings.hooks.json'), 'utf8'));

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
  for (const [event, handlers] of Object.entries(hookTemplate.hooks)) {
    settings.hooks[event] = settings.hooks[event] || [];
    const alreadyHas = settings.hooks[event].some(h =>
      h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-web-chat-hook'))
    );
    if (alreadyHas) continue;
    settings.hooks[event].push(...handlers);
    addedHooks += handlers.length;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return addedHooks;
}

// Merge the channels opt-in (WEB_CHAT_CHANNEL=1) into an existing env object,
// preserving any unrelated keys a user hand-added (idempotent, no
// clobber). Always returns a fresh object.
function channelEnv(existingEnv) {
  const base = existingEnv && typeof existingEnv === 'object' && !Array.isArray(existingEnv) ? existingEnv : {};
  return { ...base, [CHANNEL_ENV]: CHANNEL_ENV_VALUE };
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
  // Register an absolute path to the MCP bin, not the bare `claude-web-chat-mcp`
  // command. The bare command depends on the package being on PATH (an `npm
  // link`/global install), which silently fails to spawn after `/exit` + reopen
  // in checkouts where it isn't — the exact failure that motivated this. The
  // resolved path always spawns.
  const mcpBin = path.join(__dirname, '..', '..', 'bin', 'claude-web-chat-mcp.js');
  // Turn channels on by wiring WEB_CHAT_CHANNEL=1 into the entry's env, so
  // this project's MCP subprocess (lib/mcp/index.js) declares the channel
  // capability. Merge (don't replace) the env so a re-run is idempotent and any
  // unrelated env keys the user added survive.
  mcp.mcpServers['web-chat'] = {
    command: 'node',
    args: [mcpBin],
    env: channelEnv(existing && existing.env),
  };
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  return hadEntry ? 'already up to date' : 'web-chat server registered';
}

// Shared per-file status output for the reconcile results.
function printResults(results) {
  const labels = {
    created: 'created',
    'up-to-date': 'up to date',
    updated: 'updated (template changed)',
    conflict: 'CONFLICT — wrote .new sidecar, kept your edits',
    'kept-edited': 'kept (locally edited)',
    differs: 'differs from shipped — run with --force to adopt',
    overwritten: 'overwritten',
  };
  let pad = 0;
  for (const r of results) if (r.dest.length > pad) pad = r.dest.length;
  for (const r of results) {
    console.log(`  ${r.dest.padEnd(pad)}   ${labels[r.action] || r.action}`);
  }
}

module.exports = {
  MANAGED_FILES,
  templatesDir,
  hashContent,
  baselinePath,
  readBaselines,
  writeBaselines,
  reconcileManagedFiles,
  ensureHooks,
  ensureMcpRegistration,
  channelEnv,
  mcpEntryHasChannelEnv,
  printResults,
};
