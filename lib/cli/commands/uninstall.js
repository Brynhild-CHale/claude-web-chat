const { resolveRoot, remove } = require('../../setup/registration');
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
  const { root } = resolveRoot(opts.cwd || process.cwd(), { mode: 'install' });

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

  if (self) {
    uninstallSelf((m = '') => console.log(m));
  } else {
    console.log('');
    console.log('  (this removed web-chat from THIS PROJECT only. `claude-web-chat uninstall --self`');
    console.log('   also removes the program: ~/.local/bin links + ~/.web-chat/versions/)');
  }
}

module.exports = uninstall;
