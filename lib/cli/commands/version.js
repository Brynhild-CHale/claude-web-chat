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

const { describeInstall, listVersions, onPath, devBuildBehind } = require('../../update/install-layout');
const { installPaths } = require('../../core/paths');
const { INSTALL_SH_URL, isDevVersion } = require('../../core/versions');

const KIND_LABEL = {
  managed: 'managed install (a GitHub release unpacked by install.sh / update)',
  dev: 'development checkout (git working copy — update with `git pull`)',
  unmanaged: 'UNMANAGED copy (not a release, not a checkout — likely a leftover npm global install)',
};

// The one line `version` and `status` print for whoever builds web-chat, when
// the installed dev build was cut from a commit other than the HEAD of the
// checkout they are in (install-layout's devBuildBehind) — or null, which is
// every other case. Never throws: it is a hint, and the commands it rides on
// must print the rest regardless.
function devBuildWarning({ cwd, paths, behind = devBuildBehind } = {}) {
  let b = null;
  try { b = behind({ cwd, paths }); } catch {}
  if (!b) return null;
  const head = b.head.slice(0, Math.max(7, b.commit.length));
  return `⚠ The installed dev build is from ${b.commit}; this checkout is at ${head}. Rebuild it: `
    + 'node scripts/build-release.js --dev, then run the `claude-web-chat update --from` line it prints.';
}

function version(args = [], deps = {}) {
  const log = deps.log || ((m = '') => console.log(m));
  const paths = deps.paths || installPaths();
  const info = (deps.describeInstall || describeInstall)({ paths });
  const short = args.includes('--short');

  // First line stays terse and stable — scripts read it.
  log(`claude-web-chat v${info.version || '?'}`);
  if (short) return info;

  // A managed version installed by `update --from` is not a GitHub release, and
  // "which build is this?" is the whole question here — so it says so, and
  // names the digest of the tarball it came from (a dev build's version stamp
  // carries the commit; the digest pins the exact file).
  const rec = info.kind === 'managed' ? info.installRecord : null;
  if (rec) {
    const what = isDevVersion(info.version) ? 'dev build' : 'local build';
    log(`  kind      managed install — ${what} (installed from a local file)`);
    log(`  sha256    ${rec.sha256 || '?'}${rec.verified === false ? '  (installed with --yes: no SHA256SUMS to check it against)' : ''}`);
    if (rec.tarball) log(`  from      ${rec.tarball}`);
  } else {
    log(`  kind      ${KIND_LABEL[info.kind]}`);
  }
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
  const behind = devBuildWarning({ cwd: deps.cwd, paths, behind: deps.devBuildBehind });
  if (behind) log(`  ${behind}`);
  if (info.linkMismatch) {
    log('');
    log('  ⚠ MISMATCH: the `claude-web-chat` on your PATH is not the tree this ran from.');
    log(`    Typing \`claude-web-chat\` gets v${info.linkVersion || '?'} from ${info.linkPackageRoot}.`);
    log(`    Reinstall to repair: curl -fsSL ${INSTALL_SH_URL} | sh`);
  }
  return info;
}

module.exports = version;
module.exports.devBuildWarning = devBuildWarning;
