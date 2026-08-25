const fs = require('fs');
const path = require('path');
const { MANAGED_FILES, baselinePath } = require('../../update/managed-files');
const { describeInstall, listVersions, removeInstall } = require('../../update/install-layout');
const { installPaths } = require('../../core/paths');

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

function uninstall(args = []) {
  const self = Array.isArray(args) && (args.includes('--self') || args.includes('--all'));
  const root = process.cwd();
  const claudeDir = path.join(root, '.claude');

  // 1. Strip hook entries
  const settingsPath = path.join(claudeDir, 'settings.json');
  let removedHooks = 0;
  if (fs.existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error(`error parsing ${settingsPath}: ${e.message}`);
      process.exit(1);
    }
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(h => {
          const isOurs = h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-web-chat-hook'));
          return !isOurs;
        });
        removedHooks += before - settings.hooks[event].length;
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }

  // 2. Remove every managed template file install wrote (rules, slash command,
  // skills) plus any .new conflict sidecars, pruning directories left empty —
  // driven off MANAGED_FILES so a newly-shipped asset can't be left behind.
  function rm(p) {
    if (fs.existsSync(p)) { fs.unlinkSync(p); return 'removed'; }
    return 'not present';
  }
  function pruneEmptyDirs(from) {
    let dir = path.dirname(from);
    while (dir.startsWith(claudeDir + path.sep)) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  const fileStatuses = [];
  for (const { dest } of MANAGED_FILES) {
    const p = path.join(root, dest);
    const status = rm(p);
    rm(p + '.new');
    pruneEmptyDirs(p);
    fileStatuses.push({ dest, status });
  }
  // The baselines describe files that no longer exist — drop them too.
  const baselineStatus = rm(baselinePath(root));

  // 3. Strip web-chat entry from .mcp.json
  const mcpPath = path.join(root, '.mcp.json');
  let mcpStatus = 'not present';
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcp.mcpServers && mcp.mcpServers['web-chat']) {
        delete mcp.mcpServers['web-chat'];
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

  let pad = '.claude/settings.json'.length;
  for (const { dest } of fileStatuses) if (dest.length > pad) pad = dest.length;
  console.log(`web-chat uninstalled from ${root}`);
  console.log(`  ${'.claude/settings.json'.padEnd(pad)}   ${removedHooks} hook entrie${removedHooks === 1 ? '' : 's'} removed`);
  for (const { dest, status } of fileStatuses) {
    console.log(`  ${dest.padEnd(pad)}   ${status}`);
  }
  console.log(`  ${'.web-chat/managed.json'.padEnd(pad)}   ${baselineStatus}`);
  console.log(`  ${'.mcp.json'.padEnd(pad)}   ${mcpStatus}`);
  console.log(`  ${'.web-chat/'.padEnd(pad)}   preserved (delete manually if no longer needed)`);

  if (self) {
    uninstallSelf((m = '') => console.log(m));
  } else {
    console.log('');
    console.log('  (this removed web-chat from THIS PROJECT only. `claude-web-chat uninstall --self`');
    console.log('   also removes the program: ~/.local/bin links + ~/.web-chat/versions/)');
  }
}

module.exports = uninstall;
