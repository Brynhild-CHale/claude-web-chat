// Host-side service for the git-dashboard component. Reads commit history +
// branches from the repo the daemon is running in and pushes them into the shared
// store under the `git` key. Re-reads on any .git change (debounced) plus a slow
// poll fallback. v1: store writes only — the pane reacts.

const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const pexec = util.promisify(execFile);

const US = '\x1f'; // unit separator (between fields)
const RS = '\x1e'; // record separator (between commits)

let watcher = null;
let pollTimer = null;
let stopped = false;

function git(args, cwd) {
  return pexec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
}

async function collect(cwd) {
  const fmt = ['%h', '%H', '%s', '%an', '%ar', '%D'].join(US);
  const logOut = await git(['log', '--pretty=format:' + fmt + RS, '-n', '50'], cwd);
  const commits = logOut.split(RS).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [short, hash, subject, author, rel, refs] = line.split(US);
    return {
      short, hash, subject, author, rel,
      refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : [],
    };
  });

  const brFmt = ['%(HEAD)', '%(refname:short)', '%(objectname:short)', '%(contents:subject)'].join('%00');
  const brOut = await git(['branch', '--format=' + brFmt], cwd);
  const branches = brOut.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [head, name, hash, subject] = l.split('\0');
    return { current: head === '*', name, hash, subject };
  });

  let branch = '';
  try { branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim(); } catch {}
  let repo = '';
  try { repo = path.basename((await git(['rev-parse', '--show-toplevel'], cwd)).trim()); } catch {}

  return { branch, repo, branches, commits };
}

module.exports = {
  async start(ctx) {
    const cwd = process.cwd();
    let seq = 0;
    const push = async () => {
      if (stopped) return;
      try {
        const data = await collect(cwd);
        ctx.driver.setStore({ git: { seq: ++seq, at: Date.now(), ...data } });
      } catch (e) {
        ctx.driver.setStore({ git: { seq: ++seq, at: Date.now(), error: String((e && e.message) || e) } });
      }
    };

    await push();

    // Watch .git for HEAD/ref/index changes (debounced); recursive is supported on
    // macOS. A slow poll covers anything the watcher misses (and non-recursive OSes).
    try {
      const gitDir = path.join(cwd, '.git');
      let deb = null;
      watcher = fs.watch(gitDir, { recursive: true }, () => {
        if (deb) clearTimeout(deb);
        deb = setTimeout(push, 350);
      });
    } catch {}
    pollTimer = setInterval(push, 5000);
    if (pollTimer.unref) pollTimer.unref();
  },

  async stop() {
    stopped = true;
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  },
};
