// Host-side service for the git-dashboard component. Reads branches + commit
// history from the repo the daemon runs in and pushes them to the store key
// `git`. INTERACTIVE: the pane writes a control key `git_ctl { viewing, open }`
// (branch to list, commit to drill into); the service watches store events over
// SSE and re-reads git accordingly — no Claude round-trip. Also re-reads on any
// .git change (debounced) plus a slow poll. v1 contract: store writes only.

const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const pexec = util.promisify(execFile);

const US = '\x1f'; // field separator
const RS = '\x1e'; // record separator

// An abbreviated-or-full object name, which is all the pane ever sends as `open`.
const OBJECT_NAME = /^[0-9a-f]{7,40}$/;

let watcher = null;
let pollTimer = null;
let stream = null;
let stopped = false;
let eooSupport = null; // tri-state: null = not probed yet

function git(args, cwd) {
  return pexec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
}

async function trim(args, cwd) {
  try { return (await git(args, cwd)).trim(); } catch { return ''; }
}

// `--end-of-options` (git >= 2.24) is the only thing that makes git stop reading
// argv as options; a trailing `--` separates revs from paths but comes too late
// to stop `--output=<file>` earlier in the line. Probed once per process; on
// older git the caller's allowlisting still stands on its own.
async function endOfOptions(cwd) {
  if (eooSupport === null) {
    const m = /(\d+)\.(\d+)/.exec(await trim(['--version'], cwd));
    eooSupport = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 24));
  }
  return eooSupport ? ['--end-of-options'] : [];
}

async function readBranches(cwd) {
  const fmt = ['%(HEAD)', '%(refname:short)', '%(objectname:short)', '%(contents:subject)'].join('%00');
  const out = await git(['branch', '--format=' + fmt], cwd);
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [head, name, hash, subject] = l.split('\0');
    return { current: head === '*', name, hash, subject };
  });
}

async function readCommits(cwd, ref) {
  const fmt = ['%h', '%H', '%s', '%an', '%ar', '%D'].join(US);
  const args = ['log', '--pretty=format:' + fmt + RS, '-n', '50'];
  if (ref) args.push(...(await endOfOptions(cwd)), ref);
  args.push('--'); // disambiguate ref from a path (e.g. a `test` branch vs a test/ dir)
  const out = await git(args, cwd);
  return out.split(RS).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [short, hash, subject, author, rel, refs] = line.split(US);
    return { short, hash, subject, author, rel, refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : [] };
  });
}

async function readDetail(cwd, hash) {
  const hfmt = ['%H', '%h', '%s', '%an', '%ae', '%ad', '%ar'].join(US);
  // Every option goes BEFORE the fence; `hash` is the first non-option word.
  const eoo = await endOfOptions(cwd);
  const head = (await git(['show', '-s', '--date=iso', '--format=' + hfmt, ...eoo, hash, '--'], cwd)).trim().split(US);
  const body = (await git(['log', '-1', '--format=%b', ...eoo, hash, '--'], cwd)).replace(/\s+$/, '');
  const numstat = (await git(['show', '--numstat', '--format=', ...eoo, hash, '--'], cwd)).split('\n').map((l) => l.trim()).filter(Boolean);
  let insertions = 0, deletions = 0;
  const stat = numstat.map((l) => {
    const parts = l.split('\t');
    const added = parts[0] === '-' ? null : parseInt(parts[0], 10);
    const removed = parts[1] === '-' ? null : parseInt(parts[1], 10);
    if (added) insertions += added;
    if (removed) deletions += removed;
    return { file: parts.slice(2).join('\t'), added, removed, binary: parts[0] === '-' };
  });
  return {
    hash: head[0], short: head[1], subject: head[2], author: head[3], email: head[4], date: head[5], rel: head[6],
    body, stat, files_changed: stat.length, insertions, deletions,
  };
}

// `ctl` comes from the `git_ctl` store key, which every pane script in the page
// — and any local process — can write. Nothing out of it is trusted as a git
// argument: `viewing` is accepted only if it is one of the branch names this
// function just read for itself, and `open` only if it looks like an object
// name. Anything else falls back to the checked-out branch / no detail, so an
// option-shaped value (`--output=<path>` makes git log write a host file) can
// never become a git option.
async function build(cwd, ctl) {
  const branch = await trim(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const repo = path.basename(await trim(['rev-parse', '--show-toplevel'], cwd)) || 'repository';
  const open = ctl && OBJECT_NAME.test(String(ctl.open || '')) ? String(ctl.open) : null;
  let viewing = branch;
  try {
    const branches = await readBranches(cwd);
    const wanted = ctl && ctl.viewing != null ? String(ctl.viewing) : '';
    if (wanted && branches.some((b) => b.name === wanted)) viewing = wanted;
    const commits = await readCommits(cwd, viewing);
    let detail = null;
    if (open) {
      try { detail = await readDetail(cwd, open); }
      catch (e) { detail = { hash: open, error: String((e && e.message) || e) }; }
    }
    return { repo, branch, viewing, at: Date.now(), branches, commits, detail };
  } catch (e) {
    return { repo, branch, viewing, at: Date.now(), error: String((e && e.message) || e) };
  }
}

module.exports = {
  async start(ctx) {
    const cwd = process.cwd();
    let seq = 0;
    let ctl = { viewing: null, open: null };
    let lastCtlSeq = 0;

    // Adopt a control write if it's newer than the last one applied. `seq` (a
    // timestamp the pane bumps) dedupes SSE vs poll and ignores replays.
    const applyCtl = (c) => {
      if (!c || !(c.seq > lastCtlSeq)) return false;
      lastCtlSeq = c.seq;
      ctl = { viewing: c.viewing || null, open: c.open || null };
      return true;
    };

    const push = async () => {
      if (stopped) return;
      const g = await build(cwd, ctl);
      ctx.driver.setStore({ git: { seq: ++seq, ...g } });
    };

    // Honor any selection the pane already made before we came up.
    try { applyCtl((await ctx.driver.getStore(['git_ctl'])).git_ctl); } catch {}
    await push();

    // React to the pane's control writes (branch select / commit drill-in) live.
    // A driver store write echoes back here too, but only git_ctl (pane-authored)
    // triggers a rebuild — the service never writes git_ctl, so no loop.
    try {
      stream = ctx.driver.streamEvents({
        kinds: ['store'],
        onEvent: (e) => { if (e && e.patch && applyCtl(e.patch.git_ctl)) push(); },
        onError: () => {},
        onClose: () => {},
      });
    } catch {}

    // Auto-refresh on repo changes (debounced). The slow poll doubles as a
    // fallback for control writes missed during startup or an SSE drop (the
    // driver stream has no auto-reconnect): re-read git_ctl, then rebuild.
    try {
      const gitDir = path.join(cwd, '.git');
      let deb = null;
      watcher = fs.watch(gitDir, { recursive: true }, () => {
        if (deb) clearTimeout(deb);
        deb = setTimeout(push, 350);
      });
    } catch {}
    pollTimer = setInterval(async () => {
      try { applyCtl((await ctx.driver.getStore(['git_ctl'])).git_ctl); } catch {}
      push();
    }, 5000);
    if (pollTimer.unref) pollTimer.unref();
  },

  async stop() {
    stopped = true;
    if (stream) { try { stream.close(); } catch {} stream = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  },
};
