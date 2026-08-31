const { resolveRoot, remove, inspect } = require('../../setup/registration');
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

function uninstall(args = [], opts = {}) {
  const self = Array.isArray(args) && (args.includes('--self') || args.includes('--all'));
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
  // above us, but our wiring here → uninstall this directory; neither → say so
  // and touch nothing.
  const cwd = opts.cwd || process.cwd();
  const root = resolveRoot(cwd, { mode: 'optional' }).root
    || (hasWiring(cwd) ? cwd : null);
  if (root) projectRows(root, opts);
  else console.log(`Nothing to uninstall in ${cwd} — no .web-chat/ here or in any parent, and no web-chat hooks or .mcp.json entry.`);

  if (self) {
    uninstallSelf((m = '') => console.log(m));
  } else {
    console.log('');
    console.log('  (this removed web-chat from THIS PROJECT only. `claude-web-chat uninstall --self`');
    console.log('   also removes the program: ~/.local/bin links + ~/.web-chat/versions/)');
  }
}

// Is web-chat wired into THIS directory even though it has no .web-chat/? Only
// the two things that make Claude Code run web-chat count — the hook entries and
// the .mcp.json server — because those are what an uninstall has to undo. A
// leftover managed file with neither is not an installation.
function hasWiring(dir) {
  try {
    const state = inspect(dir);
    return state.mcp.present || Object.values(state.hooks).some((h) => h !== 'missing');
  } catch {
    return false;
  }
}

// Un-register ONE project and report what moved, row by row.
function projectRows(root, opts) {
  const r = remove(root, { runClaude: opts.runClaude });

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
  if (r.localScope.status === 'removed') row('Claude Code (local scope)', 'web-chat registration removed');
  else if (r.localScope.status === 'not registered') row('Claude Code (local scope)', 'no local-scope registration');
  else console.log(`  ${'Claude Code (local scope)'.padEnd(pad)}   ${r.localScope.status} — run: claude ${r.localScope.argv.join(' ')}`);
  row('.web-chat/', 'preserved (delete manually if no longer needed)');
}

module.exports = uninstall;
