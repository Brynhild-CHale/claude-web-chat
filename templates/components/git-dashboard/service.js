// Host-side service for the git-dashboard component. Reads branches + commit
// history from the repo the daemon runs in and pushes them to the store key
// `git`. INTERACTIVE: the pane writes a control key `git_ctl { viewing, open }`
// (branch to list, commit to drill into); the service watches store events over
// SSE and re-reads git accordingly — no Claude round-trip. Also re-reads on any
// .git change (debounced) plus a slow poll. v1 contract: store writes only.
//
// PUBLISH ON CHANGE. Re-reading is cheap; writing is not: every `git` write is a
// frame to every viewer, and it makes the live store differ from the active
// node's, so the next turn commits a node instead of folding. So each rebuild is
// compared (contentKey, below) with the `git` the store holds at that moment and
// pushed only when it differs — so a respawn finds its own last publish there,
// and a node restore that swapped the store under us is republished over.
// Nothing in the payload may change by itself as time passes: commits carry the
// absolute commit time (`time`, seconds) and the pane writes "N minutes ago".

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

// The order-free identity of a payload: stable JSON of it without `seq` and
// `at`, which stamp a publish rather than describe the repo. The JSON round trip
// first drops what the store would drop (undefined fields), so a payload read
// back from the store keys the same as the one built here. Written out here, not
// required from lib/: a component's service.js stands alone.
function contentKey(g) {
  if (!g || typeof g !== 'object') return null;
  const rest = { ...g };
  delete rest.seq;
  delete rest.at;
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(rest))));
}

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
  // `%at` (seconds since the epoch), never git's relative `%ar`: a relative
  // date changes by itself, and the payload must change only when the repo does.
  const fmt = ['%h', '%H', '%s', '%an', '%at', '%D'].join(US);
  const args = ['log', '--pretty=format:' + fmt + RS, '-n', '50'];
  if (ref) args.push(...(await endOfOptions(cwd)), ref);
  args.push('--'); // disambiguate ref from a path (e.g. a `test` branch vs a test/ dir)
  const out = await git(args, cwd);
  return out.split(RS).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [short, hash, subject, author, at, refs] = line.split(US);
    return { short, hash, subject, author, time: Number(at) || null, refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : [] };
  });
}

async function readDetail(cwd, hash) {
  const hfmt = ['%H', '%h', '%s', '%an', '%ae', '%ad', '%at'].join(US);
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
    hash: head[0], short: head[1], subject: head[2], author: head[3], email: head[4], date: head[5], time: Number(head[6]) || null,
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
    return { repo, branch, viewing, branches, commits, detail };
  } catch (e) {
    return { repo, branch, viewing, error: String((e && e.message) || e) };
  }
}

module.exports = {
  async start(ctx) {
    const cwd = process.cwd();
    let seq = 0;
    let lastKey = null; // contentKey of the payload last published (or found in the store)
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

    // Compare before you push — with the `git` the store holds NOW, not only
    // with what this run last wrote: a node restore (Set active, Branch) swaps
    // the whole store under a running service, so the store can hold an older
    // node's `git` while our memory still says "published". A rebuild whose data
    // the store already holds writes nothing. `at` is when the data last
    // CHANGED, not when it was read. Rebuilds run one at a time and each awaits
    // its own write, so the next one reads the store after that write landed,
    // and a slow read can never land after a newer one and publish stale data.
    let chain = Promise.resolve();
    const rebuild = async (view) => {
      if (stopped) return;
      const g = await build(cwd, view);
      if (stopped) return;
      try {
        const got = await ctx.driver.getStore(['git']);
        const held = got && got.git;
        lastKey = contentKey(held);
        if (held && Number.isFinite(held.seq) && held.seq > seq) seq = held.seq;
      } catch {} // the store is unreachable: compare with what we last wrote
      if (stopped) return;
      const key = contentKey(g);
      if (key === lastKey) return;
      lastKey = key;
      // A lost write leaves the store differing, so the next rebuild retries it.
      try { await ctx.driver.setStore({ git: { seq: ++seq, ...g, at: Date.now() } }); } catch {}
    };
    const push = () => {
      const view = ctl; // the selection as it is when the rebuild is asked for
      const run = () => rebuild(view);
      return (chain = chain.then(run, run));
    };

    // A respawn (a socket flap, the pane returning to the active node) finds the
    // store still holding what the last run published: adopt it, so the same
    // repo data publishes nothing, and a change continues past its `seq`. Also
    // honor any selection the pane already made before we came up.
    try {
      const got = await ctx.driver.getStore(['git_ctl', 'git']);
      const prev = got && got.git;
      if (prev && typeof prev === 'object') {
        lastKey = contentKey(prev);
        if (Number.isFinite(prev.seq) && prev.seq > seq) seq = prev.seq;
      }
      applyCtl(got && got.git_ctl);
    } catch {}
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
