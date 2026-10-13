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
  // then be reporting nothing. The refused value falls back to the view already
  // published, and the service writes only on change (U99), so that rebuild
  // writes nothing; rebuilds run one at a time, so a following control write
  // naming a DIFFERENT view is published only once the refused one has been
  // fully handled. That write is the service saying it has finished.
  const live = path.join(repo.dir, 'pwned-live.txt');
  const before = h.writes.length;
  h.fire({ git_ctl: { seq: 2, viewing: '--output=' + live, open: null } });
  h.fire({ git_ctl: { seq: 3, viewing: 'feature', open: null } });
  assert.ok(await waitUntil(() => h.writes.length > before), 'the live control writes produced a rebuild');
  assert.equal(fs.existsSync(live), false, 'nor through a live control write');
  assert.equal(h.writes.length, before + 1,
    'the refused value rebuilt the trunk view already published, so only the later view was written');
  assert.equal(h.latest().viewing, 'feature');
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

// ── publish on change (U99) ─────────────────────────────────────────────────
// Every `git` write is a store frame to every viewer, and it makes the live
// surface differ from the active node's, so a chat-only turn commits a node
// instead of folding. The service used to push every 5 s whether or not
// anything changed; it now compares each rebuild with what it last published.

// A second run in the SAME cwd (startService already chdir'd and will restore):
// the respawn a socket flap or a return to the active node causes.
async function respawn(t, store) {
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  const h = makeCtx(store);
  await svc.start(h.ctx);
  return { svc, ...h, latest: () => store.git };
}

// The store hands a value back through JSON, as the daemon's does.
const viaStore = (v) => JSON.parse(JSON.stringify(v));

test('git-dashboard service: a respawn that finds the same repo data in the store writes nothing', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  const first = await startService(t, repo, {});
  assert.equal(first.writes.length, 1, 'a first start with an empty store publishes once');
  const published = first.latest();
  await first.svc.stop();

  const store = { git: viaStore(published) };
  const again = await respawn(t, store);
  assert.equal(again.writes.length, 0, 'the same data, found in the store, is not written again');
  assert.deepEqual(store.git, viaStore(published), 'and the stored payload (seq, at) is untouched');
});

test('git-dashboard service: after a quiet respawn, a repo change continues past the stored seq', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  const first = await startService(t, repo, {});
  await first.svc.stop();
  // A stored seq well past what one run of this service would reach by itself:
  // a respawn that restarted its counter at 0 would publish below it.
  const store = { git: { ...viaStore(first.latest()), seq: 41 } };
  const again = await respawn(t, store);
  assert.equal(again.writes.length, 0, 'precondition: the respawn was quiet');

  fs.writeFileSync(path.join(repo.dir, 'c.txt'), 'three\n');
  repo.run('add', '.');
  repo.run('commit', '-qm', 'third commit');
  again.fire({ git_ctl: { seq: Date.now(), viewing: repo.trunk, open: null } });
  assert.ok(await waitUntil(() => again.writes.length >= 1), 'the commit was published');
  assert.equal(again.writes[0].git.seq, 42, 'its seq continues from the stored one, never restarting below it');
});

test('git-dashboard service: rebuilds with no repo change write nothing; a new commit writes once, with a higher seq', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  const store = {};
  const h = await startService(t, repo, store);
  assert.equal(h.writes.length, 1);
  const seq0 = h.latest().seq;
  const at0 = h.latest().at;

  // Two rebuilds naming the view already shown. Rebuilds run one at a time, so
  // the write a THIRD, different view produces lands only after both have
  // finished: if either had written, it would be ahead of that one.
  h.fire({ git_ctl: { seq: 2, viewing: repo.trunk, open: null } });
  h.fire({ git_ctl: { seq: 3, viewing: repo.trunk, open: null } });
  h.fire({ git_ctl: { seq: 4, viewing: 'feature', open: null } });
  assert.ok(await waitUntil(() => h.writes.length >= 2), 'the view change was published');
  assert.equal(h.writes.length, 2, 'the two unchanged rebuilds wrote nothing');
  assert.equal(h.writes[1].git.viewing, 'feature');
  assert.equal(h.writes[1].git.seq, seq0 + 1);

  // A rebuild of the same view again: nothing.
  h.fire({ git_ctl: { seq: 5, viewing: 'feature', open: null } });

  // A new commit on the trunk moves its branch chip: one write. The .git watcher
  // and the forced rebuild below both see it; only the first of them writes.
  fs.writeFileSync(path.join(repo.dir, 'c.txt'), 'three\n');
  repo.run('add', '.');
  repo.run('commit', '-qm', 'third commit');
  h.fire({ git_ctl: { seq: 6, viewing: 'feature', open: null } });
  assert.ok(await waitUntil(() => h.writes.length >= 3), 'the commit was published');
  // A later, different view flushes every rebuild queued before it.
  h.fire({ git_ctl: { seq: 7, viewing: repo.trunk, open: null } });
  assert.ok(await waitUntil(() => h.writes.length >= 4));
  assert.equal(h.writes.length, 4, 'the commit was written exactly once');
  const commitWrite = h.writes[2].git;
  assert.ok(commitWrite.seq > seq0 + 1, 'with a higher seq');
  assert.ok(commitWrite.at >= at0, '`at` is when the data changed');
  assert.equal(h.writes[3].git.viewing, repo.trunk);
  assert.equal(h.writes[3].git.commits[0].subject, 'third commit');
});

test('git-dashboard service: commits and the detail carry an absolute time, never a relative date', async (t) => {
  withTempHome(t);
  const repo = makeRepo();
  t.after(() => { try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch {} });

  assert.ok(!/['"]%ar['"]/.test(fs.readFileSync(SERVICE, 'utf8')), "the service asks git for no relative date ('%ar')");

  const store = { git_ctl: { seq: 1, viewing: 'feature', open: repo.featureHead } };
  const h = await startService(t, repo, store);
  const g = h.latest();
  const nowSec = Date.now() / 1000;
  for (const c of g.commits) {
    assert.equal(typeof c.time, 'number', 'a commit row carries its time as a number');
    assert.ok(c.time > nowSec - 3600 && c.time <= nowSec + 5, 'in seconds since the epoch');
    assert.equal('rel' in c, false, 'and no relative-date text');
  }
  assert.ok(g.detail && g.detail.hash === repo.featureHead);
  assert.equal(typeof g.detail.time, 'number', 'so does the detail');
  assert.equal('rel' in g.detail, false);
});

// ── the pane writes "N minutes ago" itself ──────────────────────────────────

const { JSDOM } = require('jsdom');
const mountRuntime = require('../public/mount-runtime.js');
const PANE_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'components', 'git-dashboard', 'component.html'), 'utf8');

test('git-dashboard pane: renders a relative label from the commit time and refreshes it every 60 s', (t) => {
  const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => Object.assign(global, saved));
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);

  const t59m = NOW / 1000 - 59 * 60 - 30;
  const store = mountRuntime.createStore({
    git: {
      seq: 1, at: NOW, repo: 'r', branch: 'main', viewing: 'main',
      branches: [{ current: true, name: 'main', hash: 'abc1234', subject: 's' }],
      commits: [{ short: 'abc1234', hash: 'abc1234'.padEnd(40, '0'), subject: 'a commit', author: 'T', time: t59m, refs: [] }],
      detail: null,
    },
  });
  const { root: shadow, scripts } = mountRuntime.attachAndExtract(host, PANE_HTML);
  const life = { timers: new Set(), signal: new dom.window.AbortController().signal, onUnmount() {} };
  const errors = [];
  mountRuntime.runScripts(shadow, scripts, store, {}, 'm1', (e) => errors.push(e), null, life);
  assert.deepEqual(errors, [], 'the pane script threw at mount');

  const label = () => shadow.querySelector('.c .meta .ago').textContent;
  assert.equal(label(), '59 minutes ago', 'the pane wrote the relative date from the absolute time');
  assert.ok([...life.timers].some((x) => x.kind === 'interval'),
    'through a bare setInterval, which the pane runtime clears with the pane');

  t.mock.timers.tick(60000);
  assert.equal(label(), '1 hour ago', 'a minute later the label has aged with no store write');
  assert.equal(store.get('git').seq, 1);
});
