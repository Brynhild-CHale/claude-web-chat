const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withTempHome, waitUntil: harnessWaitUntil } = require('../test-support/helpers');

// Smoke test for the git-dashboard builtin's host-side service.js, driven
// against a throwaway git repo through a faithful `ctx` stub (the same shape
// lib/server/service-runner.js hands a service: driver.setStore / getStore /
// streamEvents). The service reads process.cwd(), so each test chdir's into its
// repo and restores afterwards — the pattern several CLI tests already use.
//
// The point of the file is the security case: `git_ctl` is a STORE key, and the
// store is writable by every pane script in the page and by any local process.
// Whatever the pane puts in `viewing` / `open` used to land in git's argv ahead
// of the `--`, and git parses any argv element starting with `-` as an option —
// so `--output=<path>` made `git log` write a host file. Values the service did
// not itself produce must never reach git.

const SERVICE = path.join(__dirname, '..', 'templates', 'components', 'git-dashboard', 'service.js');

// The harness poll with this file's budget bound in — every wait here is on a
// `git` subprocess, not an in-process assertion.
const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 4000, interval: 25, ...opts });

// A git repo with two branches and a couple of commits, isolated from the dev
// machine's global config by the temp HOME the caller has already installed.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gitdash-'));
  const run = (...args) => execFileSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  run('init', '-q', '.');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-qm', 'first commit');
  const trunk = run('rev-parse', '--abbrev-ref', 'HEAD').trim();
  run('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  run('add', '.');
  run('commit', '-qm', 'second commit on feature');
  const featureHead = run('rev-parse', 'HEAD').trim();
  run('checkout', '-q', trunk);
  return { dir, trunk, featureHead, run };
}

// The ctx a service actually receives, minus the parts git-dashboard never uses.
// `writes` collects every driver.setStore patch; `fire` replays a store event the
// way the SSE stream would.
function makeCtx(store) {
  const writes = [];
  let handler = null;
  const ctx = {
    mountId: 'm1',
    name: 'git-dashboard',
    params: {},
    log() {},
    webChatDir: null,
    diff: () => '',
    driver: {
      async setStore(patch) { writes.push(patch); Object.assign(store, patch); },
      async getStore(keys) {
        const out = {};
        for (const k of keys || Object.keys(store)) if (k in store) out[k] = store[k];
        return out;
      },
      streamEvents({ onEvent }) { handler = onEvent; return { close() { handler = null; } }; },
    },
  };
  return { ctx, writes, fire: (patch) => handler && handler({ patch }) };
}

// Fresh module instance per test: service.js keeps `stopped`/`watcher`/`stream`
// at module scope, so a second start() on a cached copy would come up stopped.
function loadService() {
  delete require.cache[require.resolve(SERVICE)];
  return require(SERVICE);
}

// Boot the real service against `repo` with `store` already seeded, and hand back
// the last `git` payload it pushed.
async function startService(t, repo, store) {
  const prevCwd = process.cwd();
  process.chdir(repo.dir);
  t.after(() => { try { process.chdir(prevCwd); } catch {} });
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  const h = makeCtx(store);
  await svc.start(h.ctx);
  return { svc, ...h, latest: () => store.git };
}

test('git-dashboard service: reports branches and commits for the checked-out branch', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  const h = await startService(t, repo, {});
  const g = h.latest();
  assert.ok(g, 'the service pushed a `git` payload');
  assert.equal(g.error, undefined, 'no error on a plain repo');
  assert.equal(g.branch, repo.trunk);
  assert.equal(g.viewing, repo.trunk, 'defaults to the checked-out branch');
  assert.deepEqual(g.branches.map((b) => b.name).sort(), ['feature', repo.trunk].sort());
  assert.equal(g.commits.length, 1, 'trunk has the one commit');
  assert.equal(g.commits[0].subject, 'first commit');
});

test('git-dashboard service: a control write selects a branch and drills into a commit', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  // Seeded before start: the service adopts a selection the pane made earlier.
  const store = { git_ctl: { seq: 1, viewing: 'feature', open: null } };
  const h = await startService(t, repo, store);
  assert.equal(h.latest().viewing, 'feature');
  assert.equal(h.latest().commits.length, 2, 'feature carries both commits');

  // Live control write over the stream, as a pane click would deliver it.
  h.fire({ git_ctl: { seq: 2, viewing: 'feature', open: repo.featureHead } });
  const detail = await waitUntil(() => (store.git && store.git.detail) || false);
  assert.ok(detail, 'the drill-in produced a detail payload');
  assert.equal(detail.hash, repo.featureHead);
  assert.equal(detail.subject, 'second commit on feature');
  assert.equal(detail.files_changed, 1);
});

test('git-dashboard service: an option-shaped `viewing` never reaches git argv', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(repo.dir, 'pwned.txt');

  // `git log --pretty=… -n 50 --output=<path> --` writes <path> and prints
  // nothing: git parses the option even though a `--` follows it.
  const store = { git_ctl: { seq: 1, viewing: '--output=' + target, open: null } };
  const h = await startService(t, repo, store);

  assert.equal(fs.existsSync(target), false, 'a store-supplied option wrote no host file');
  const g = h.latest();
  assert.equal(g.viewing, repo.trunk, 'the refused value fell back to the checked-out branch');
  assert.ok(Array.isArray(g.commits) && g.commits.length >= 1, 'the pane still gets a usable payload');

  // Same again through the live path — a pane can write the key at any moment.
  //
  // Wait for the rebuild the control write TRIGGERS, not for a fixed timer: a
  // negative assertion behind `sleep(300)` passes vacuously whenever the box is
  // slower than the guess, and this is the half of the security case that would
  // then be reporting nothing. One new driver.setStore is the service saying it
  // has finished handling the write.
  const live = path.join(repo.dir, 'pwned-live.txt');
  const before = h.writes.length;
  h.fire({ git_ctl: { seq: 2, viewing: '--output=' + live, open: null } });
  assert.ok(await waitUntil(() => h.writes.length > before), 'the live control write produced a rebuild');
  assert.equal(fs.existsSync(live), false, 'nor through a live control write');
  assert.equal(h.latest().viewing, repo.trunk);
});

test('git-dashboard service: an option-shaped `open` never reaches git argv', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });
  const target = path.join(repo.dir, 'pwned-open.txt');

  const store = { git_ctl: { seq: 1, viewing: null, open: '--output=' + target } };
  const h = await startService(t, repo, store);

  assert.equal(fs.existsSync(target), false, '`git show` wrote no host file');
  assert.equal(h.latest().detail, null, 'a non-object-name `open` is simply not opened');
});

test('git-dashboard service: `viewing` must be a branch the service itself read', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  // Not option-shaped, but not a branch either: a ref the pane invented.
  const store = { git_ctl: { seq: 1, viewing: 'refs/heads/feature', open: null } };
  const h = await startService(t, repo, store);
  assert.equal(h.latest().viewing, repo.trunk, 'unknown refs fall back rather than being passed through');
  assert.equal(h.latest().error, undefined);
});
