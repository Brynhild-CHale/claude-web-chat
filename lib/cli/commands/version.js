// `claude-web-chat version` (also `--version` / `-v`) — the version, and WHERE
// IT CAME FROM.
//
// The second half is the point. A stale binary on PATH is invisible until
// something you just built is missing: an unrelated `npm i -g` once replaced a
// maintainer's `npm link` with a copy of a 16-day-old build, and the first
// symptom was `unknown command` for a command they had written that morning.
// This prints the running tree, what ~/.web-chat/current points at, and what the
// `claude-web-chat` on PATH resolves to — and says so out loud when they
// disagree.

const { describeInstall, listVersions, onPath } = require('../../update/install-layout');
const { installPaths } = require('../../core/paths');
const { INSTALL_SH_URL } = require('../../core/versions');

const KIND_LABEL = {
  managed: 'managed install (a GitHub release unpacked by install.sh / update)',
  dev: 'development checkout (git working copy — update with `git pull`)',
  unmanaged: 'UNMANAGED copy (not a release, not a checkout — likely a leftover npm global install)',
};

function version(args = [], deps = {}) {
  const log = deps.log || ((m = '') => console.log(m));
  const paths = deps.paths || installPaths();
  const info = (deps.describeInstall || describeInstall)({ paths });
  const short = args.includes('--short');

  // First line stays terse and stable — scripts read it.
  log(`claude-web-chat v${info.version || '?'}`);
  if (short) return info;

  log(`  kind      ${KIND_LABEL[info.kind]}`);
  log(`  running   ${info.packageRoot}`);
  log(`  invoked   ${process.argv[1] || '(unknown)'}`);
  if (info.current) log(`  current   ${paths.current} -> ${info.current}  (v${info.currentVersion || '?'})`);
  if (info.linkTarget) {
    log(`  on PATH   ${info.linkPath} -> ${info.linkTarget}  (v${info.linkVersion || '?'})`);
  } else {
    log(`  on PATH   ${info.linkPath}  (not linked)`);
  }
  const versions = listVersions(paths);
  if (versions.length) log(`  installed ${versions.map((v) => `v${v}`).join(', ')}`);
  if (!onPath(paths.binDir)) {
    log(`  ⚠ ${paths.binDir} is not on your PATH — add: export PATH="${paths.binDir}:$PATH"`);
  }
  if (info.linkMismatch) {
    log('');
    log('  ⚠ MISMATCH: the `claude-web-chat` on your PATH is not the tree this ran from.');
    log(`    Typing \`claude-web-chat\` gets v${info.linkVersion || '?'} from ${info.linkPackageRoot}.`);
    log(`    Reinstall to repair: curl -fsSL ${INSTALL_SH_URL} | sh`);
  }
  return info;
}

module.exports = version;
