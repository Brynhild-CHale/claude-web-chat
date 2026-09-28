// `claude-web-chat update` — take the latest GitHub Release, or roll back to a
// version still on disk.
//
// There is NO npm here, deliberately. A global npm prefix is a shared mutable
// directory: an unrelated `npm i -g` replaced a maintainer's `npm link` with a
// copied build from 16 days earlier, so the command on their PATH was ancient
// while every test in their checkout passed. Nothing said so, for two weeks.
// Updates now rewrite ~/.web-chat/versions/, a directory this program alone
// owns, and this command REFUSES to run at all unless the code it is running
// from lives there — see the guard below, which is the whole point of the
// change. Rollback is a symlink swap (`--to <version>`), because the previous
// versions are still unpacked.
//
// `--from <tarball>` installs a build that is already on disk — a
// `scripts/build-release.js --dev` build, for dogfooding an unreleased version
// as the managed install users get — through the same verify → unpack → flip →
// relink → sync → restart as a GitHub update, with GitHub never asked.
//
// Order matters: download → verify checksum → unpack to staging → move into
// versions/<v> → flip `current` atomically → relink bins. Nothing before the
// flip can leave you with a broken install.

const fs = require('fs');
const path = require('path');
const { clearCache, compareVersions } = require('../../update/check');
const { fetchLatestRelease, fetchAndUnpack, unpackLocal, SUMS_ASSET } = require('../../update/release');
const { describeInstall, listVersions, activate, linkBins, pruneVersions, onPath, readInstallRecord } = require('../../update/install-layout');
const { INSTALL_SH_URL, releaseTagUrl, isDevVersion } = require('../../core/versions');
const { installPaths } = require('../../core/paths');
const { printResults, conflictAdvice } = require('../../update/managed-files');
const { resolveRoot } = require('../../setup/registration');
const { readRoleEntry, readInstances } = require('../../util/registry');
const { runningBuild } = require('../stale-daemon');
const client = require('../../client');

function parseArgs(args = []) {
  const out = { to: null, from: null, list: false, force: false, yes: false, restartAll: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--to' || a === '--to-version') out.to = args[++i] || null;
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a === '--from') out.from = args[++i] || '';
    else if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--list' || a === '--versions') out.list = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--restart-all') out.restartAll = true;
  }
  if (out.to) out.to = String(out.to).replace(/^v/, '');
  return out;
}

// The guard. Loud on purpose: a silent no-op here is exactly how the failure
// this whole layout exists to prevent went unnoticed for two weeks.
function refuse(info, log) {
  const bar = '─'.repeat(72);
  log('');
  log(bar);
  log('  REFUSING TO UPDATE — this is not a managed install.');
  log(bar);
  log('');
  log(`  Running from: ${info.packageRoot}`);
  log(`  Version:      v${info.version || '?'}`);
  log('');
  if (info.kind === 'dev') {
    log('  That is a GIT CHECKOUT, not a release unpacked under ~/.web-chat/versions/.');
    log(`  Its working copy is ${info.gitRoot}.`);
    log('');
    log('  Update a checkout with git, not with this command:');
    log('');
    log(`    cd ${info.gitRoot} && git pull && npm install`);
    log('');
    log('  (Overwriting a checkout with a release tarball would throw away your work,');
    log('   and updating ~/.web-chat/versions/ instead would change nothing you run.)');
  } else {
    log('  It is neither a release under ~/.web-chat/versions/ nor a git checkout —');
    log('  most likely a leftover global npm install, which this program no longer');
    log('  uses or maintains. npm\'s global prefix is shared and gets clobbered by');
    log('  unrelated installs; that is why distribution moved off it.');
    log('');
    log('  Install the managed version, then use that one:');
    log('');
    log('    npm rm -g claude-web-chat        # if npm still has one');
    log(`    curl -fsSL ${INSTALL_SH_URL} | sh`);
  }
  log('');
  if (info.linkTarget) {
    log(`  For reference, the \`claude-web-chat\` on your PATH is:`);
    log(`    ${info.linkPath} -> ${info.linkTarget}  (v${info.linkVersion || '?'})`);
    log('');
  }
  log(bar);
  log('');
}

// The other half of the same failure: something on PATH claims to be this
// program and resolves somewhere else. Worth a shout even when we CAN proceed.
function warnMismatch(info, log) {
  if (!info.linkMismatch) return;
  log('');
  log('  ⚠ The `claude-web-chat` on your PATH is NOT the tree this command is running from:');
  log(`      on PATH:  ${info.linkPath} -> ${info.linkTarget}  (v${info.linkVersion || '?'})`);
  log(`      running:  ${info.packageRoot}  (v${info.version || '?'})`);
  log('    Whatever this update does, your next `claude-web-chat` may not be it.');
  log('');
}

async function update(args = [], deps = {}) {
  const log = deps.log || ((m = '') => console.log(m));
  const errlog = deps.errlog || ((m = '') => console.error(m));
  const exit = deps.exit || ((c) => process.exit(c));
  const paths = deps.paths || installPaths();
  const info = (deps.describeInstall || describeInstall)({ paths });
  const flags = parseArgs(args);

  // `--list` works from anywhere — it is a read-only "what do I have?".
  if (flags.list) {
    const versions = listVersions(paths);
    log(`claude-web-chat versions under ${paths.versions}:`);
    if (!versions.length) log('  (none — this is not a managed install)');
    for (const v of versions) {
      const marker = info.currentVersion === v ? '  ← current' : '';
      log(`  v${v}${provenance(v, paths)}${marker}`);
    }
    log('');
    log('Roll back with: claude-web-chat update --to <version>');
    return { listed: versions };
  }

  if (info.kind !== 'managed') {
    refuse(info, errlog);
    exit(1);
    return { refused: true, kind: info.kind };
  }
  warnMismatch(info, log);

  const before = info.version;
  let target;

  if (flags.from !== null && flags.to) {
    errlog('--from and --to are two different installs — pass one of them.');
    exit(1);
    return { refused: true, reason: 'conflicting-flags' };
  }

  // ── a local tarball: the same install, from a file instead of GitHub.
  if (flags.from !== null) {
    const r = await installFromFile({ flags, paths, info, before, log, errlog, exit, deps });
    if (!r.version) return r;
    target = r.version;
  } else if (flags.to) {
    // ── rollback: any version still unpacked on disk, no network involved.
    const versions = listVersions(paths);
    if (!versions.includes(flags.to)) {
      errlog(`v${flags.to} is not unpacked under ${paths.versions}.`);
      errlog(`Available: ${versions.length ? versions.map((v) => `v${v}`).join(', ') : '(none)'}`);
      errlog('Only versions still on disk can be rolled back to — an older one has to be reinstalled.');
      exit(1);
      return { refused: true, reason: 'unknown-version' };
    }
    target = flags.to;
    log(`Rolling back to v${target} (already on disk — no download needed).`);
  } else {
    // ── the normal path: ask GitHub what the latest release is.
    log(`Current version: v${before}`);
    log('Checking GitHub Releases...');
    const release = await (deps.fetchLatestRelease || fetchLatestRelease)();
    if (!release) {
      errlog('No published release found (or GitHub is unreachable). Nothing to do.');
      exit(1);
      return { refused: true, reason: 'no-release' };
    }
    const cmp = compareVersions(release.version, before);
    if (cmp <= 0 && !flags.force) {
      log(cmp === 0
        ? `Already on the latest release (v${before}).`
        : `Your build (v${before}) is newer than the latest release (v${release.version}); not downgrading.`);
      log('Use --force to install it anyway, or --to <version> to roll back to a version on disk.');
      clearCache();
      // Nothing to install — but the projects an EARLIER update left on an
      // older build are still worth naming, and `--restart-all` is how they
      // get bounced after the fact (the 0.7.6 updater that performs the hop to
      // 0.8 knows nothing of them).
      const others = await otherProjects({ target: before, restartFn: deps.restart || require('./restart'), restartAll: flags.restartAll, offerFlag: true, log, deps });
      return others ? { unchanged: true, latest: release.version, others } : { unchanged: true, latest: release.version };
    }
    log(`Latest release: v${release.version}`);
    // Stage in ~/.web-chat/staging — a SIBLING of the version store, so the
    // final move into place is still a rename on the same filesystem, but a
    // download killed halfway (Ctrl-C: there is no SIGINT handler, so the
    // `finally` that cleans up never runs) leaves its debris somewhere that is
    // not the version list. Staging under versions/ meant `update --list`
    // printed `vwc-release-XXXXXX` and the comparator sorted it above every
    // real release.
    fs.mkdirSync(paths.versions, { recursive: true });
    fs.mkdirSync(paths.staging, { recursive: true });
    try {
      await (deps.fetchAndUnpack || fetchAndUnpack)({
        release,
        versionDir: paths.versionDir(release.version),
        tmpDir: paths.staging,
        log,
      });
    } catch (e) {
      // A failed or tampered download is an ordinary outcome, not a crash. Say
      // what happened in one readable block and stop — `current` has not moved,
      // so the install the user has is exactly the one they had a moment ago.
      errlog('');
      errlog(`Update failed: ${e.message}`);
      errlog('');
      errlog(`Nothing was changed — you are still on v${before} (${paths.current} -> versions/${info.currentVersion || before}).`);
      errlog('Try again later, or download the release by hand from');
      errlog(`  ${releaseTagUrl(release.tag)}`);
      exit(1);
      return { failed: true, error: e.message };
    }
    target = release.version;
  }

  // A running tunnel portal the target could not manage is stopped BEFORE the
  // flip, with this build's `tunnel down` — the last moment a command that can
  // stop it is on PATH. A stop that fails refuses the whole install: nothing
  // has moved yet, and the alternative is a portal exposing the machine that
  // no installed command can bring down.
  const portalGate = await stopPortalTargetLacks({ paths, target, log, errlog, deps });
  if (portalGate && portalGate.refused) {
    exit(1);
    return { refused: true, reason: 'portal-running', error: portalGate.error };
  }

  // ── flip. Atomic: `current` never briefly points at nothing.
  (deps.activate || activate)(target, paths);
  const rows = (deps.linkBins || linkBins)(paths);
  log(`Activated v${target}  (${paths.current} -> versions/${target})`);
  for (const r of rows) {
    if (r.action !== 'ok') log(`  ${r.action} ${r.link}`);
  }
  if (!onPath(paths.binDir)) {
    log('');
    log(`  ⚠ ${paths.binDir} is not on your PATH. Add to your shell profile:`);
    log(`      export PATH="${paths.binDir}:$PATH"`);
    log('');
  }

  const removed = (deps.pruneVersions || pruneVersions)({ paths });
  if (removed.length) log(`Pruned old versions: ${removed.map((v) => `v${v}`).join(', ')}`);

  log(before === target ? `Reinstalled v${target}.` : `Updated: v${before} → v${target}.`);
  clearCache();
  // The target build's per-user theme folders (lib/setup/theme-logos.js) —
  // idempotent, and silent on purpose. Nothing when the target has none.
  const seed = deps.seedThemeLogos || loadThemeLogos(paths, target);
  if (seed) { try { seed(); } catch {} }

  // Auto-propagate safe template changes to the existing install. Edit-
  // preserving: safe updates apply, local edits are kept, conflicts surface as
  // .new sidecars (see lib/update/managed-files.js). An update is the single
  // most likely moment for a template to have moved, so a `pending` sidecar
  // still outstanding from a PREVIOUS offer is reported here as well — via the
  // same conflictAdvice helper, which distinguishes the two.
  // The root walk is this build's (it is just findProjectRoot); the SYNC is the
  // new build's, loaded out of versions/<target> the way loadRestart loads
  // restart. This process started from the version being replaced, and
  // templatesDir() is __dirname-relative — so the sync used to compare the
  // project against the OLD templates and report every file 'up-to-date'. The
  // new rules, skills and hook template only landed on some later `install`.
  const root = resolveRoot(process.cwd(), { mode: 'optional' }).root;
  // A rollback to a build predating the engine gets no sync at all — see
  // loadRegistration. Resolved before the heading so it is not printed above a
  // sync that is not going to happen.
  const registration = root
    ? (deps.registration || loadRegistration(paths, target, errlog, { from: before }))
    : null;
  if (root && !registration) {
    log('');
    log(`Managed files left alone — v${target} has no templates of its own here, and this build's are newer.`);
    log(`  To sync them with v${target}'s templates: claude-web-chat install`);
  }
  if (root && registration) {
    log('');
    log('Syncing managed files...');
    // The sync stays inside the PROJECT. apply() completes a `.mcp.json` entry
    // that cannot resolve here by shelling out to `claude mcp add … --scope
    // local` — that is `install`'s and `doctor`'s job, and it writes Claude
    // Code's own config, outside this project. Doing it silently in the middle
    // of an upgrade is not something `update` has ever done, so the engine gets
    // a runClaude that RECORDS the command instead of running it and we print
    // it for the user to run deliberately.
    let localScope = null;
    const recordClaude = (argv) => { localScope = argv; return { ok: false, stderr: 'not attempted by update' }; };
    try {
      const applied = registration.apply(root, { force: false, runClaude: recordClaude });
      const results = (applied && applied.managed) || [];
      printResults(results);
      for (const line of conflictAdvice(results)) log(line);
      if (localScope) {
        log(`  ⚠ this project's .mcp.json entry cannot resolve here (a plugin stub outside a plugin install).`);
        log(`    To let Claude Code spawn web-chat anyway, run: claude ${localScope.join(' ')}`);
      }
    } catch (e) {
      errlog(`  managed-file sync skipped: ${e.message}`);
    }
  }

  // Only a project gets a daemon. Outside one there is nothing here to
  // restart, and restarting anyway booted a daemon rooted at the cwd (~, or
  // ~/Downloads) — which 0.8 then remembers as a project the portal can start.
  // The target's own restart would say so itself from 0.8 on; an older target
  // (a rollback) would not, so the guard is here.
  const restartFn = deps.restart || loadRestart(paths, target);
  log('');
  if (root) {
    log('Restarting bg server...');
    await restartFn(args);
  } else {
    log(`No web-chat project here (${process.cwd()}) — no server restarted here.`);
  }
  // A rollback's `--restart-all` could be the only chance: an older target may
  // not have the flag, so it is offered only going forward.
  const others = await otherProjects({ target, restartFn, restartAll: flags.restartAll, offerFlag: compareVersions(target, before) >= 0, log, deps });
  const portal = portalGate
    ? (portalGate.stopped ? { restarted: false, stopped: true } : null)
    : await bouncePortal({ paths, target, log, errlog, deps });
  const out = { before, after: target };
  if (others) out.others = others;
  if (portal) out.portal = portal;
  return out;
}

// Every OTHER running project whose daemon serves a build other than `target`.
// `update` restarts one daemon — the cwd project's — and a daemon with a tab
// attached never exits on its own, so every other project with a surface open
// went on serving the old build to a Claude Code session that, reopened, runs
// the new MCP against it (0.8.0's write_markdown 404s on 0.7.6). Listed, with
// the command that fixes each; or, with --restart-all, restarted here — on the
// TARGET build's restart, one at a time — and summarised. Nothing running on
// another build prints nothing (unless --restart-all asked). Returns the
// summary, or null when there was nothing to say.
async function otherProjects({ target, restartFn, restartAll, offerFlag, log, deps }) {
  let live = [];
  try { live = (deps.readInstances || readInstances)(); } catch {}
  const buildOf = deps.runningBuild || runningBuild;
  const probed = await Promise.all(live.filter((e) => e && e.root).map(async (e) => ({
    root: e.root, port: e.port, url: e.url, build: await buildOf(e.port, { root: e.root }),
  })));
  const stale = probed.filter((p) => p.build && p.build !== target);
  if (!stale.length) {
    if (restartAll) { log(''); log(`--restart-all: no other project is running a build other than v${target}.`); }
    return restartAll ? { stale: [], restarted: [] } : null;
  }
  log('');
  if (!restartAll) {
    log(`${stale.length} other project(s) still run an older build — each keeps serving it until its server restarts:`);
    for (const p of stale) log(`  ${p.root}  v${p.build}${p.url ? `  ${p.url}` : ''}`);
    log('  Restart each where it lives:  cd <project> && claude-web-chat restart');
    if (offerFlag) log('  Or all of them at once:       claude-web-chat update --restart-all');
    return { stale: stale.map((p) => p.root), restarted: [] };
  }
  log(`Restarting ${stale.length} project(s) on v${target}, one at a time...`);
  const restarted = [];
  const failed = [];
  for (const p of stale) {
    // `root` is passed; the chdir is for a target whose restart predates it
    // and still reads the project off the cwd. Sequential on purpose: chdir is
    // process-wide, and a burst of daemons booting at once only races the
    // port walk.
    const prev = process.cwd();
    let ok = false;
    let why = '';
    try {
      process.chdir(p.root);
      const r = await restartFn([], { root: p.root, log: () => {} });
      ok = !(r && r.ok === false);
      if (!ok) why = 'the old daemon did not stop';
    } catch (e) {
      why = e && e.message ? e.message : String(e);
    } finally {
      try { process.chdir(prev); } catch {}
    }
    (ok ? restarted : failed).push(p.root);
    log(`  ${ok ? '✓' : '✗'} ${p.root}  v${p.build} → v${target}${why ? `  (${why})` : ''}`);
  }
  log(`Restarted ${restarted.length} of ${stale.length}.${failed.length ? ' For the rest: cd <project> && claude-web-chat restart' : ''}`);
  return { stale: stale.map((p) => p.root), restarted, failed };
}

// A rollback (or any install) to a build with NO tunnel command, while a
// portal is running. The post-flip bounce cannot restart it on that build, and
// the fix it used to print — `tunnel up` — is a command the build just
// activated does not have: the portal went on exposing the machine from the
// newer build's code, starting newer daemons on request, with nothing on PATH
// able to stop it. So stop it now, with THIS build's `tunnel down`, and say
// remote access is off until a build that has one is back. Returns null (no
// portal, or the target can manage it — the post-flip bounce's job), { stopped }
// (true, or false when the registered one was not answering), or
// { refused, error }.
async function stopPortalTargetLacks({ paths, target, log, errlog, deps }) {
  const entry = (deps.readPortal || (() => readRoleEntry('portal')))();
  if (!entry) return null;
  // An injected restartPortal stands in for the target's own (tests).
  if (deps.restartPortal) return null;
  if (fs.existsSync(path.join(paths.versionDir(target), 'lib', 'cli', 'commands', 'tunnel.js'))) return null;
  const env = { ...(deps.env || process.env), ...(entry.port ? { WEB_CHAT_PORTAL_PORT: String(entry.port) } : {}) };
  log('');
  try {
    const down = deps.tunnelDown || ((o) => require('./tunnel')(['down'], o));
    const r = await down({ log: () => {}, env });
    // Registered, but not answering as a portal: `down` found nothing to
    // stop — and there is nothing for the post-flip bounce to do either.
    if (r && r.stopped === false) return { stopped: false };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    errlog(`⚠ v${target} has no tunnel command, and the tunnel portal (pid ${entry.pid}) could not be stopped: ${error}`);
    errlog('  Nothing was changed. Stop it with `claude-web-chat tunnel down`, then run this again.');
    return { refused: true, error };
  }
  log(`Stopped the tunnel portal (pid ${entry.pid}): v${target} has no tunnel command to run it with, so remote access is off`);
  log('  until you are back on a build that has one (`claude-web-chat update`).');
  return { stopped: true };
}

// `--from <tarball>`. Returns { version } on success, or the refusal/failure
// result for update() to hand back (it has already said why and exited).
//
// The checksum gate is the GitHub path's, with one allowance: a hand-built
// tarball may have no SHA256SUMS beside it (a build copied without its sums),
// and then there is nothing to verify against — said out loud, and allowed only
// with --yes. A SHA256SUMS that IS there and disagrees is always a refusal.
async function installFromFile({ flags, paths, info, before, log, errlog, exit, deps }) {
  const file = flags.from ? path.resolve(flags.from) : '';
  let isFile = false;
  try { isFile = Boolean(file) && fs.statSync(file).isFile(); } catch {}
  if (!isFile) {
    errlog(flags.from ? `No such file: ${file}` : '--from needs the path of a claude-web-chat-<version>.tar.gz');
    exit(1);
    return { refused: true, reason: 'no-file' };
  }
  const sumsPath = path.join(path.dirname(file), SUMS_ASSET);
  let sumsText = null;
  try { sumsText = fs.readFileSync(sumsPath, 'utf8'); } catch {}

  log(`Current version: v${before}`);
  log(`Installing from ${file} — a local file; GitHub is not asked.`);
  if (sumsText == null) {
    errlog(`⚠ No ${SUMS_ASSET} beside it (${sumsPath}), so its checksum cannot be verified.`);
    if (!flags.yes) {
      errlog('  Nothing was changed. Install it anyway with --yes, or keep the SHA256SUMS the build wrote next to the tarball.');
      exit(1);
      return { refused: true, reason: 'unverified' };
    }
    errlog('  --yes given: installing it unverified.');
  }

  fs.mkdirSync(paths.versions, { recursive: true });
  fs.mkdirSync(paths.staging, { recursive: true });
  let res;
  try {
    res = (deps.unpackLocal || unpackLocal)({
      tarball: file,
      sumsText,
      paths,
      tmpDir: paths.staging,
      replace: flags.force,
      log,
    });
  } catch (e) {
    errlog('');
    if (e.code === 'EEXIST') {
      errlog(`v${e.version} is already unpacked under ${paths.versions} — not replacing it with a local file.`);
      errlog(`Switch to what is there with --to ${e.version}, or pass --force to replace it with this file.`);
      errlog('(A `node scripts/build-release.js --dev` build carries its own version, so it never collides with a release.)');
    } else {
      errlog(`Install failed: ${e.message}`);
    }
    errlog('');
    errlog(`Nothing was changed — you are still on v${before} (${paths.current} -> versions/${info.currentVersion || before}).`);
    exit(1);
    return { failed: true, error: e.message };
  }
  log(`  unpacked v${res.version}  (sha256 ${res.sha256})`);
  return { version: res.version };
}

// The ` (dev build, local file)` note `--list` puts beside a version: where it
// came from, when that was not a GitHub release.
function provenance(v, paths) {
  const rec = readInstallRecord(v, paths);
  if (isDevVersion(v)) return rec ? '  (dev build, from a local file)' : '  (dev build)';
  return rec ? '  (from a local file)' : '';
}

// A running tunnel portal is restarted onto the new build as well, so the
// remote policy that build enforces is in force now — not whenever someone next
// runs `tunnel up` (it used to be a line in the docs, and a portal from the old
// build kept admitting by the old rules until then). The bounce is `tunnel up`'s
// own, run out of the TARGET build's copy of the tunnel command (see
// loadPortalRestart), on the port the portal is registered on. None running is
// nothing to do. A restart that fails is reported with the command that fixes
// it, and never fails the update: the new build is already activated.
async function bouncePortal({ paths, target, log, errlog, deps }) {
  const entry = (deps.readPortal || (() => readRoleEntry('portal')))();
  if (!entry) return null;
  const env = { ...(deps.env || process.env), ...(entry.port ? { WEB_CHAT_PORTAL_PORT: String(entry.port) } : {}) };
  log('');
  try {
    const restartPortal = deps.restartPortal || loadPortalRestart(paths, target);
    if (!restartPortal) throw new Error(`v${target} has no tunnel command to restart it with`);
    const r = await restartPortal({ env });
    if (!r || !r.restarted) throw new Error(`it did not answer on 127.0.0.1:${entry.port}`);
    log(`Restarted the tunnel portal on v${target} (pid ${r.before.pid} → ${r.health.pid}) so its remote policy applies now — remote viewers will reconnect.`);
    return { restarted: true, pid: r.health.pid };
  } catch (e) {
    const still = entry.port ? await client.probeHealth(entry.port) : null;
    errlog(`⚠ Could not restart the tunnel portal (pid ${entry.pid}) on v${target}: ${e.message}`);
    errlog(still && still.role === 'portal'
      ? '  It is still running, on the previous build\'s code and remote policy.'
      : '  Remote access is down until the portal is started again.');
    errlog('  The update itself succeeded. To restart it: claude-web-chat tunnel up');
    return { restarted: false, error: e.message };
  }
}

// Restart the daemon using the NEWLY INSTALLED build's own `restart`.
//
// This process started from the OLD version, and `restart` spawns the daemon
// from a path derived from its own module location — so calling the copy already
// loaded into this process would start the daemon on the code we just replaced,
// and the update would look like it worked while changing nothing that runs.
// Requiring the new version's module instead gets the new daemon, while still
// being the same exported `restart(args)` the CLI itself calls: no
// reimplementation, no shelling out.
//
// Resolve through versions/<target>, NOT through ~/.web-chat/current — even
// though we just pointed `current` at the same place. Node's module loader keeps
// a realpath cache, and this process resolved `current` at startup (the bin on
// PATH points through it), back when it meant the OLD version. Requiring
// `current/...` therefore hands back the old file from cache, silently. That is
// the same class of bug as the stale global install this whole layout exists to
// prevent, so it is worth the extra argument to sidestep.
function loadRestart(paths, version) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'cli', 'commands', 'restart.js');
  try {
    if (fs.existsSync(fresh)) {
      const fn = require(fresh);
      if (typeof fn === 'function') return fn;
    }
  } catch (e) {
    console.error(`  (could not load v${version}'s restart: ${e.message} — using this build's)`);
  }
  return require('./restart');
}

// The TARGET build's portal restart, for the reason loadRestart exists:
// `tunnel up` spawns `portal run` from its own package root, so this build's
// copy would start the portal on the code being replaced (or, on a rollback, on
// code newer than the build just activated). There is deliberately no fallback
// to this build. A target from before restartPortal still has the tunnel
// command, whose down + up is the same bounce; a target with no tunnel command
// at all returns null and the caller says so. A throw (the target's module will
// not load) is the caller's to report.
function loadPortalRestart(paths, version) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'cli', 'commands', 'tunnel.js');
  if (!fs.existsSync(fresh)) return null;
  const mod = require(fresh);
  if (typeof mod.restartPortal === 'function') return mod.restartPortal;
  if (typeof mod !== 'function') return null;
  return async ({ env }) => {
    const down = await mod(['down'], { log: () => {}, env });
    if (!down || !down.stopped) return { restarted: false };
    const up = await mod(['up'], { log: () => {}, env });
    return { restarted: true, before: down.health, health: up.health };
  };
}

// The TARGET build's seedThemeLogos, for loadRestart's reason: this process is
// the build being replaced, and the folders (and what their README says) are
// the new build's to decide. No fallback to this build: a rollback to a build
// that has no such module gets nothing, which is what that build would do. A
// module that will not load is the same nothing — the update has succeeded.
function loadThemeLogos(paths, version) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'setup', 'theme-logos.js');
  try {
    if (!fs.existsSync(fresh)) return null;
    const mod = require(fresh);
    return mod && typeof mod.seedThemeLogos === 'function' ? mod.seedThemeLogos : null;
  } catch {
    return null;
  }
}

// Sync managed files with the NEWLY INSTALLED build's registration engine, for
// the same reason loadRestart loads the new build's restart: this process was
// started from the version being replaced, and every template path in it is
// __dirname-relative. Requiring versions/<target> (never ~/.web-chat/current —
// Node's realpath cache resolved that to the OLD version at startup) is what
// makes "sync managed files" propagate anything at all.
//
// The fallback is deliberately LOUD. The call site is inside a try/catch that
// degrades to "managed-file sync skipped", so a silent fallback would look
// exactly like a successful no-op sync — the failure mode this fix exists to
// remove. The engine's export surface is small and additive for the same
// reason: an old `update` loading a new engine must still find apply().
//
// `from` is the version being replaced (i.e. the build running this code), and
// it decides whether falling back is honest. Going FORWARD it is: this build's
// templates are at worst older than the target's, which is what the message
// says. Going BACKWARD — `update --to <older>`, whose whole point is to put an
// older build back — they are NEWER, so the fallback would sync the project
// forward to files the version just activated does not ship, while announcing
// the opposite. There is nothing right to sync with in that direction, so
// nothing is: return null and let the call site say so. `claude-web-chat
// install`, which is now the rolled-back build, syncs with its own templates.
function loadRegistration(paths, version, errlog = (m) => console.error(m), { from = null } = {}) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'setup', 'registration.js');
  let why = null;
  try {
    if (!fs.existsSync(fresh)) {
      why = `v${version} ships no registration engine`;
    } else {
      const mod = require(fresh);
      if (mod && typeof mod.apply === 'function') return mod;
      why = `v${version}'s registration engine has no apply()`;
    }
  } catch (e) {
    why = `could not load v${version}'s registration engine: ${e.message}`;
  }
  if (from && compareVersions(version, from) < 0) {
    errlog(`  (${why} — and THIS build's templates are NEWER than v${version}, so managed files are left alone rather than synced forward)`);
    return null;
  }
  errlog(`  (${why} — syncing with THIS build's templates, which may be older)`);
  return require('../../setup/registration');
}

module.exports = update;
module.exports.parseArgs = parseArgs;
module.exports.loadRestart = loadRestart;
module.exports.loadRegistration = loadRegistration;
module.exports.loadPortalRestart = loadPortalRestart;
module.exports.loadThemeLogos = loadThemeLogos;
