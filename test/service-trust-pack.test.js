// `claude-web-chat trust --pack <name>` — approving a pack's services ahead of
// time.
//
// The daemon mints the keys (GET /api/services/pack/:name, read-only, through
// the supervisor's packRequests) and the CLI writes them, as for every other
// grant. What must hold:
//   * the keys are the ones a pane passing only covered params will wait on —
//     minted by the same function, never re-derived;
//   * it never decides a pending EXACT-valued request (a param outside the
//     declaration, a path outside the project) — those keep their own keys;
//   * it asks once, and a pipe or CI answers No (there is no --yes);
//   * it names what it is about: the pack, each service's hash, what it covers;
//   * it approves only what THIS machine recorded installing — the user-tier
//     record of an install for all projects, or the ledger of a project install,
//     never the project's own .web-chat/packs.json (a repository can commit it);
//     an edited service.js or meta.json, a unit only that file names, a copy
//     shadowing another tier's, or two installs from different sources is left
//     out, with the reason;
//   * no daemon, an unknown pack, a pack with no services: each said plainly;
//   * through the portal, the listing names no host path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { withServer, withTempHome, tmpRoot, waitUntil: harnessWaitUntil } = require('../test-support/helpers');
const { packFixture } = require('../test-support/packs');
const { installFromStage, removePackByName } = require('../lib/packs/install');
const { upsertPack, sha256, findLedgerEntry, readLedger } = require('../lib/packs/store');
const { classify } = require('../lib/core/remote-policy');
const { homeDir, userPaths } = require('../lib/core/paths');
const { writePortfileAt, isPidAlive } = require('../lib/core/portfiles');
const trust = require('../lib/cli/commands/trust');

const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 4000, interval: 40, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Writes one store key per mount on start, so a test can see which panes run.
const SERVICE = `
module.exports = {
  async start(ctx) { ctx.driver.setStore({ ['svc_' + ctx.mountId]: { pid: process.pid, params: ctx.params } }); },
  async stop() {},
};`;
const LOG_SERVICE = `${SERVICE}\n// incident-log\n`;

const SOURCE = {
  url: 'https://github.com/acme/ops', ref: 'HEAD', sha: 'c'.repeat(40),
  via: 'archive', sums_verified: false, asset: null, transport: 'https',
};

const BOARD_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', 'x-trust': 'project-path' },
    title: { type: 'string', 'x-trust': 'display' },
    env: { type: 'string' },
  },
};

function installAcme(root, { tier = 'local', components } = {}) {
  const stageDir = packFixture({
    components: components || [
      { name: 'deploy-board', service: SERVICE, params_schema: BOARD_SCHEMA },
      { name: 'incident-log', service: LOG_SERVICE },
      { name: 'readme-view' },
    ],
  });
  return installFromStage({ stageDir, source: SOURCE, tier, root, actor: 'cli' });
}

function openViewer(t, ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    t.after(() => { try { sock.close(); } catch {} });
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg && msg.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}

const trustFile = (ctx) => path.join(ctx.userWebChat, 'services', 'trusted.json');
const readTrust = (ctx) => (fs.existsSync(trustFile(ctx)) ? JSON.parse(fs.readFileSync(trustFile(ctx), 'utf8')) : null);
const pendingOf = async (ctx) => (await ctx.api.get('/api/services/pending')).json.pending;
const packOf = async (ctx, name = 'acme-ops', headers) => (await ctx.api.get(`/api/services/pack/${name}`, headers)).json;

// The CLI in THIS process, so a test can hand it a prompt that answers — a
// child process has no terminal, and the prompt engine answers No without one.
// console and process.exit are captured for the duration.
async function runInProcess(fn) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  let exit = null;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (c) => { exit = c; throw new Error('__exit__'); };
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally {
    console.log = realLog; console.error = realErr; process.exit = realExit;
  }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

// A prompt engine that answers every confirmation with `answer`, and records
// what it was asked.
function answering(answer) {
  return {
    asked: [],
    async confirm(question, opts) { this.asked.push({ question, opts }); return answer; },
    close() { this.closed = true; },
  };
}

// The real CLI, as a child process with no terminal. ASYNC spawn: the daemon it
// talks to is in THIS process, so a spawnSync would block the loop that has to
// answer it.
function runCli(args, { cwd, home }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ── the listing and the grant ───────────────────────────────────────────────

test('--pack approves the pre-approval keys and leaves pending exact requests alone', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  installAcme(ctx.root);
  await openViewer(t, ctx);

  // Three panes before any approval: one passing only what deploy-board covers,
  // one passing an unmarked param, one passing a path outside the project.
  await api.post('/api/components/deploy-board/use', { id: 'covered', params: { target: 'src', title: 'Deploys' } });
  await api.post('/api/components/deploy-board/use', { id: 'exact', params: { target: 'src', env: 'prod' } });
  await api.post('/api/components/deploy-board/use', { id: 'outside', params: { target: '../elsewhere' } });
  const waiting = await waitUntil(async () => {
    const p = await pendingOf(ctx);
    return p.length === 3 ? p : false;
  });
  assert.ok(waiting, 'three requests are waiting');
  const coveredReq = waiting.find((p) => p.params.title === 'Deploys');
  const exactKeys = waiting.filter((p) => p !== coveredReq).map((p) => p.key).sort();

  const listing = await packOf(ctx);
  assert.equal(listing.ok, true);
  assert.equal(listing.root, ctx.root);
  assert.equal(listing.pack.name, 'acme-ops');
  assert.deepEqual(listing.pack.installs.map((i) => i.tier), ['local']);
  assert.equal(listing.pack.installs[0].recorded, true, 'this machine recorded the install (the ledger)');
  assert.equal(listing.pack.installs[0].source.sha, SOURCE.sha);
  assert.equal(listing.pack.installs[0].actor, 'cli');
  assert.deepEqual(listing.requests.map((r) => r.name).sort(), ['deploy-board', 'incident-log'],
    'every service component the pack installed, and only those (readme-view ships no service.js)');
  assert.deepEqual(listing.skipped, []);
  const board = listing.requests.find((r) => r.name === 'deploy-board');
  const log = listing.requests.find((r) => r.name === 'incident-log');
  assert.deepEqual(board.covers, { target: 'project-path', title: 'display' });
  assert.deepEqual(log.covers, {}, 'a component with no declaration is pre-approved for the no-params pane only');
  assert.deepEqual(board.params, {});
  assert.equal(board.decision, null);
  assert.equal(board.tier, 'local', 'each request says which install it is');
  assert.equal(board.source_url, SOURCE.url, 'and where that install came from');
  assert.equal(board.key, coveredReq.key, 'the pre-approval is exactly the key the covered pane is waiting on');
  assert.ok(!exactKeys.includes(board.key) && !exactKeys.includes(log.key), 'and never an exact-valued request\'s');

  const prompt = answering(true);
  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt }));
  assert.equal(r.exit, null, r.err);
  assert.equal(prompt.asked.length, 1, 'it asks once, for the whole pack');
  assert.equal(prompt.asked[0].opts.def, false, 'and the answer nobody gives is No');
  assert.match(prompt.asked[0].question, /Approve all 2\?/);
  assert.match(r.out, /Pack "acme-ops"\n {2}for this project: +1\.2\.0 · tarball @ ccccccc · https:\/\/github\.com\/acme\/ops · from a terminal\n/,
    'it names the pack, and where and how this machine installed it');
  assert.match(r.out, /deploy-board\n {4}from: +the install for this project \(https:\/\/github\.com\/acme\/ops\)\n/,
    'and which install each service is');
  // The sha256 shown is the FILE's — what `shasum service.js` prints — never
  // the code hash, which for deploy-board folds its declaration in.
  const boardFile = sha256(fs.readFileSync(path.join(ctx.root, '.web-chat', 'components', 'deploy-board', 'service.js')));
  assert.equal(board.source_hash, boardFile);
  assert.notEqual(board.hash, boardFile, 'deploy-board declares x-trust, so the two differ');
  assert.ok(r.out.includes(`\n    service.js sha256: ${boardFile.slice(0, 16)}…\n`), r.out);
  assert.ok(!r.out.includes(board.hash.slice(0, 16)), 'the code hash is never shown as the file\'s');
  assert.match(r.out, /deploy-board\n {4}from: [^\n]+\n {4}service\.js sha256: [0-9a-f]{16}…\n {4}covers: +target: any path inside this project · title: display only/);
  assert.match(r.out, /incident-log\n {4}from: [^\n]+\n {4}service\.js sha256: [0-9a-f]{16}…\n {4}covers: +a pane with no params only/);
  assert.match(r.out, /An approval lets any pane point deploy-board at any file inside this project, \.env files included/, 'the remaining risk is said before the answer');
  assert.match(r.out, /--params-fp/, 'and where a wider request goes instead');

  const trusted = readTrust(ctx);
  assert.deepEqual(Object.keys(trusted).sort(), [board.key, log.key].sort(), 'exactly the two pre-approval keys were written');
  assert.equal(trusted[board.key].approved, true);
  assert.equal(trusted[board.key].pack, 'acme-ops', 'the record names the pack it was approved for');
  assert.deepEqual(trusted[board.key].covers, board.covers, 'and what it covers');
  assert.equal(trusted[board.key].root, ctx.root);

  // The covered pane comes alive; the exact ones keep waiting, unstarted.
  assert.ok(await waitUntil(async () => Boolean((await api.get('/api/store')).json.svc_covered)), 'the covered pane runs');
  const left = await waitUntil(async () => {
    const p = await pendingOf(ctx);
    return p.length === 2 ? p : false;
  });
  assert.deepEqual(left.map((p) => p.key).sort(), exactKeys, 'the exact-valued requests are still pending');
  const store = (await api.get('/api/store')).json;
  assert.equal(store.svc_exact, undefined, 'and not running');
  assert.equal(store.svc_outside, undefined);

  // A pane mounted afterwards with only covered values needs nothing — no pane
  // had to be open for the approval, and none has to be for the next one.
  await api.post('/api/components/incident-log/use', { id: 'log' });
  assert.ok(await waitUntil(async () => Boolean((await api.get('/api/store')).json.svc_log)), 'incident-log with no params runs');

  // Run again: everything is already decided, so nothing is asked.
  const again = answering(true);
  const r2 = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: again }));
  assert.equal(again.asked.length, 0);
  assert.match(r2.out, /All 2 are already approved\. Nothing was changed\./);
  assert.match(r2.out, /already approved/);
});

test('--pack with no terminal lists, answers No, and writes nothing', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  const r = await runCli(['trust', '--pack', 'acme-ops'], { cwd: ctx.root, home: ctx.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pack "acme-ops"/);
  assert.match(r.stdout, /deploy-board/);
  assert.match(r.stdout, /incident-log/);
  assert.match(r.stdout, /covers: +target: any path inside this project · title: display only/);
  assert.match(r.stdout, /Approve all 2\? \[y\/N\]/);
  assert.match(r.stdout, /assuming no/, 'a pipe never grants host execution');
  assert.match(r.stdout, /\(no terminal — assuming no; run it in a terminal to answer\)/,
    'and it says how to answer: not with a --yes this command refuses');
  assert.doesNotMatch(r.stdout, /pass --yes/);
  assert.match(r.stdout, /Nothing was changed\./);
  assert.equal(readTrust(ctx), null, 'nothing written');
});

// There is deliberately no --yes: nothing non-interactive grants host
// execution. An unknown flag is ignored by the parser, so this is what keeps a
// "--yes for symmetry with pack install" from ever becoming one.
test('--yes is not a way past the question, for --pack or --all', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  await openViewer(t, ctx);
  await ctx.api.post('/api/components/deploy-board/use', { id: 'b', params: { env: 'prod' } });
  assert.ok(await waitUntil(async () => (await pendingOf(ctx)).length === 1), 'one request is waiting for --all');
  for (const args of [
    ['trust', '--pack', 'acme-ops', '--yes'],
    ['trust', '--pack', 'acme-ops', '-y'],
    ['trust', '--all', '--yes'],
    ['trust', '--all', '-y'],
  ]) {
    const r = await runCli(args, { cwd: ctx.root, home: ctx.home });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /\[y\/N\]/, `${args.join(' ')} still asks`);
    assert.match(r.stdout, /assuming no; run it in a terminal to answer/, `${args.join(' ')}`);
    assert.match(r.stdout, /Nothing was changed\./, `${args.join(' ')}`);
    assert.equal(readTrust(ctx), null, `${args.join(' ')} wrote nothing`);
  }
});

test('--pack --deny refuses every service the pack installed, and the panes stop asking', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  installAcme(ctx.root);
  const listing = await packOf(ctx);

  const prompt = answering(true);
  const r = await runInProcess(() => trust(['--pack', 'acme-ops', '--deny'], { cwd: ctx.root, prompt }));
  assert.equal(r.exit, null, r.err);
  assert.match(prompt.asked[0].question, /Deny all 2\?/);
  const trusted = readTrust(ctx);
  assert.deepEqual(Object.keys(trusted).sort(), listing.requests.map((p) => p.key).sort());
  assert.ok(Object.values(trusted).every((rec) => rec.approved === false && rec.denied_at), 'each recorded as a denial');

  await openViewer(t, ctx);
  await api.post('/api/components/deploy-board/use', { id: 'b', params: { title: 'x' } });
  await sleep(600);
  assert.deepEqual(await pendingOf(ctx), [], 'a denied request is not asked about');
  assert.equal((await api.get('/api/store')).json.svc_b, undefined, 'and does not run');
  assert.deepEqual((await packOf(ctx)).requests.map((p) => p.decision), ['denied', 'denied']);
});

// `--pack --deny` is the one CLI path that turns an approval a child is RUNNING
// under into a denial — and it says "It will not run". Starting was gated on
// the trust file; running has to be too.
test('--pack --deny stops a service it had approved, and it does not come back', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  installAcme(ctx.root);
  await openViewer(t, ctx);

  const approved = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(approved.exit, null, approved.err);
  await api.post('/api/components/deploy-board/use', { id: 'b', params: { title: 'x' } });
  const running = await waitUntil(async () => (await api.get('/api/store')).json.svc_b || false);
  assert.ok(running, 'the approved service runs');
  assert.equal(isPidAlive(running.pid), true);

  const denied = await runInProcess(() => trust(['--pack', 'acme-ops', '--deny'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(denied.exit, null, denied.err);
  assert.match(denied.out, /approved earlier — denying changes that/);
  assert.match(denied.out, /It will not run/);
  assert.ok(await waitUntil(() => !isPidAlive(running.pid)), 'the denial stops the child that was running');
  assert.equal(ctx.srv.services._children.size, 0);

  // Any later pass leaves it stopped, and quiet: a denial is a decision.
  ctx.srv.services.scheduleReconcile('test');
  await sleep(600);
  assert.equal(ctx.srv.services._children.size, 0, 'and it is not respawned');
  assert.deepEqual(await pendingOf(ctx), [], 'nor asked about again');
});

// ── what it will not approve ────────────────────────────────────────────────

test('--pack leaves out a component whose identity files changed since the install, or that is shadowed', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  const comp = (name) => path.join(ctx.root, '.web-chat', 'components', name);

  fs.appendFileSync(path.join(comp('deploy-board'), 'service.js'), '\n// edited after install\n');
  const meta = JSON.parse(fs.readFileSync(path.join(comp('incident-log'), 'meta.json'), 'utf8'));
  meta.params_schema = { type: 'object', properties: { anything: { type: 'string', 'x-trust': 'display' } } };
  fs.writeFileSync(path.join(comp('incident-log'), 'meta.json'), JSON.stringify(meta));

  const listing = await packOf(ctx);
  assert.deepEqual(listing.requests, [], 'neither is what the pack shipped any more');
  assert.deepEqual(listing.skipped.map((s) => s.name).sort(), ['deploy-board', 'incident-log']);
  assert.match(listing.skipped.find((s) => s.name === 'deploy-board').reason, /service\.js changed since the pack installed it/);
  assert.match(listing.skipped.find((s) => s.name === 'incident-log').reason, /meta\.json changed since the pack installed it/,
    'a widened declaration is a changed identity too');

  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(true) }));
  assert.match(r.out, /Not included:\n {2}deploy-board — service\.js changed since the pack installed it\. Decide it per pane: claude-web-chat trust deploy-board/);
  assert.match(r.out, /Nothing was changed\./);
  assert.equal(readTrust(ctx), null);

  // A pack installed for all projects, shadowed here by a project component of
  // the same name: what would run is not the pack's.
  const ctx2 = await withServer(t, { writePortfile: true });
  installAcme(ctx2.root, { tier: 'system', components: [{ name: 'shadowed-board', service: SERVICE }] });
  assert.deepEqual((await packOf(ctx2)).requests.map((p) => p.name), ['shadowed-board'], 'the user-tier install lists');
  await ctx2.api.post('/api/components', { name: 'shadowed-board', source: '<p>mine</p>', description: 'mine', service: SERVICE });
  const shadowed = await packOf(ctx2);
  assert.deepEqual(shadowed.requests, []);
  assert.match(shadowed.skipped[0].reason, /a copy in this project shadows the one installed for all projects/);
  assert.deepEqual(shadowed.pack.installs.map((i) => i.tier), ['system']);
});

// ── a record a repository wrote ─────────────────────────────────────────────
// `.web-chat/packs.json` is project-tier: a repository can commit one, naming
// whatever it likes — any pack, any source, any digests (it ships the files
// too, so they agree with themselves). `--pack` takes a project install's
// provenance from the ledger this machine's install pipeline keeps, never from
// that file; what only that file names is listed as not included.

// What a repository can ship: the component files...
function commitComponent(root, name, service, { meta = null } = {}) {
  const dir = path.join(root, '.web-chat', 'components', name);
  const metaText = meta || JSON.stringify({ name, description: `${name}.`, params_schema: {} });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'component.html'), `<p>${name}</p>`);
  fs.writeFileSync(path.join(dir, 'meta.json'), metaText);
  fs.writeFileSync(path.join(dir, 'service.js'), service);
  return {
    kind: 'component', name, files: [
      { path: 'component.html', sha256: sha256(`<p>${name}</p>`) },
      { path: 'meta.json', sha256: sha256(metaText) },
      { path: 'service.js', sha256: sha256(service) },
    ],
  };
}

// ...and a record naming them, written as a file in the tree, which is all a
// repository can do (upsertPack is this machine's code, not a repository's).
function commitRecord(root, record) {
  fs.writeFileSync(path.join(root, '.web-chat', 'packs.json'), JSON.stringify({ version: 1, packs: [record] }, null, 2));
}

const RELEASE = {
  url: 'https://github.com/someone/wc-jupyter', ref: 'v1.4.0', sha: 'abcdef1'.padEnd(40, '0'),
  via: 'release', sums_verified: true, asset: 'wc-jupyter-1.4.0.tar.gz', transport: 'https',
};

test('a record the repository committed vouches for nothing, even with matching digests', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const unit = commitComponent(ctx.root, 'jpy-notebook', SERVICE);
  commitRecord(ctx.root, { name: 'wc-jupyter', version: '1.4.0', source: RELEASE, units: [unit], services: ['jpy-notebook'] });

  const listing = await packOf(ctx, 'wc-jupyter');
  assert.deepEqual(listing.pack.installs, [{ tier: 'local', recorded: false }],
    'the record is named for what it is, and nothing it claims is repeated');
  assert.deepEqual(listing.requests, [], 'its code is not offered as the pack\'s');
  assert.deepEqual(listing.skipped.map((x) => x.name), ['jpy-notebook']);
  assert.match(listing.skipped[0].reason, /only this project's \.web-chat\/packs\.json names it, and no install on this machine recorded it/);

  const prompt = answering(true);
  const r = await runInProcess(() => trust(['--pack', 'wc-jupyter'], { cwd: ctx.root, prompt }));
  assert.equal(r.exit, null, r.err);
  assert.equal(prompt.asked.length, 0, 'there is nothing to ask about');
  assert.match(r.out, /for this project: +not recorded on this machine/);
  assert.doesNotMatch(r.out, /sha256 verified|1\.4\.0|release v1\.4\.0|abcdef1/, 'none of the record\'s claims reaches the terminal');
  assert.match(r.out, /Not included:\n {2}jpy-notebook — only this project's \.web-chat\/packs\.json names it/);
  assert.match(r.out, /Nothing was changed\./);
  assert.equal(readTrust(ctx), null);

  // `pack list` does not send the user to `trust --pack` for it either.
  const listed = await runCli(['pack', 'list'], { cwd: ctx.root, home: ctx.home });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /trust --pack wc-jupyter/);
  assert.match(listed.stdout, /not recorded on this machine/);
});

test('a committed record cannot shadow an install for all projects, or add a unit to it', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root, { tier: 'system', components: [{ name: 'deploy-board', service: SERVICE, params_schema: BOARD_SCHEMA }] });
  assert.deepEqual((await packOf(ctx)).requests.map((p) => p.name), ['deploy-board'], 'the user\'s own install is offered');

  // The repository ships its own deploy-board and an extra helper, and a
  // record that names both under the pack's name, with matching digests.
  const EVIL = `${SERVICE}\n// the repository's own\n`;
  commitRecord(ctx.root, {
    name: 'acme-ops', version: '1.4.0', source: { ...SOURCE, via: 'release', ref: 'v1.4.0', sums_verified: true },
    units: [commitComponent(ctx.root, 'deploy-board', EVIL), commitComponent(ctx.root, 'deploy-helper', EVIL)],
  });

  const listing = await packOf(ctx);
  assert.deepEqual(listing.pack.installs.map((i) => [i.tier, i.recorded]), [['local', false], ['system', true]]);
  assert.deepEqual(listing.requests, [], 'neither the shadowing copy nor the extra unit is offered');
  const reasons = Object.fromEntries(listing.skipped.map((x) => [x.name, x.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), ['deploy-board', 'deploy-helper'], 'and neither is dropped without a word');
  assert.match(reasons['deploy-board'], /a copy in this project shadows the one installed for all projects/);
  assert.match(reasons['deploy-helper'], /only this project's \.web-chat\/packs\.json names it/);

  const prompt = answering(true);
  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt }));
  assert.equal(r.exit, null, r.err);
  assert.equal(prompt.asked.length, 0);
  assert.match(r.out, /for this project: +not recorded on this machine/);
  assert.match(r.out, /for all projects: +1\.2\.0 · tarball @ ccccccc · https:\/\/github\.com\/acme\/ops · from a terminal/);
  assert.doesNotMatch(r.out, /sha256 verified|1\.4\.0/);
  assert.match(r.out, /Not included:\n(?: {2}.+\n)*? {2}deploy-board — a copy in this project shadows/);
  assert.equal(readTrust(ctx), null, 'nothing was approved');
});

test('an install made under the same name from another source approves nothing of either', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root, { tier: 'system', components: [{ name: 'deploy-board', service: SERVICE }] });
  // The drawer's install route, which a pane's script can call too: a real
  // install, through the pipeline, of a different repository that names
  // itself after the user's pack.
  installFromStage({
    stageDir: packFixture({ components: [{ name: 'deploy-helper', service: LOG_SERVICE }] }),
    source: { ...SOURCE, url: 'https://github.com/mallory/not-ops', sha: 'b'.repeat(40) },
    tier: 'local', root: ctx.root, actor: 'http',
  });
  const listing = await packOf(ctx);
  assert.deepEqual(listing.pack.installs.map((i) => [i.tier, i.recorded, i.actor]), [['local', true, 'http'], ['system', true, 'cli']]);
  assert.deepEqual(listing.requests, []);
  assert.deepEqual(listing.skipped.map((x) => x.name).sort(), ['deploy-board', 'deploy-helper']);
  for (const x of listing.skipped) assert.match(x.reason, /from different sources/);
  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(true) }));
  assert.match(r.out, /https:\/\/github\.com\/mallory\/not-ops · through the surface/, 'both sources are named');
  assert.match(r.out, /https:\/\/github\.com\/acme\/ops · from a terminal/);
  assert.equal(readTrust(ctx), null);
});

test('a project install made through the surface is offered, and says so', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installFromStage({
    stageDir: packFixture({ components: [{ name: 'deploy-board', service: SERVICE }] }),
    source: SOURCE, tier: 'local', root: ctx.root, actor: 'http',
  });
  const listing = await packOf(ctx);
  assert.deepEqual(listing.requests.map((p) => [p.name, p.tier, p.actor]), [['deploy-board', 'local', 'http']]);
  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(false) }));
  assert.match(r.out, /for this project: +1\.2\.0 · tarball @ ccccccc · https:\/\/github\.com\/acme\/ops · through the surface\n/);
  assert.match(r.out, /An install "through the surface" is a request any pane's script can\n +make too: approve only a pack you chose to install\./);
});

test('the ledger follows the record: written by a project install, trimmed and dropped by remove', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  const entry = findLedgerEntry(ctx.root, 'acme-ops');
  assert.ok(entry, 'a project install is recorded in the user tier');
  assert.equal(entry.actor, 'cli');
  assert.deepEqual(entry.units.map((u) => u.name).sort(), ['acme-ops', 'deploy-board', 'incident-log', 'readme-view']);
  installAcme(ctx.root, { tier: 'system', components: [{ name: 'other-board', service: SERVICE }] });
  assert.deepEqual(readLedger().map((e) => e.name), ['acme-ops'], 'an install for all projects needs none: its record is user-tier');

  // An edited unit is kept by remove; the ledger keeps it with the digests
  // this machine installed, so it still reads as edited.
  fs.appendFileSync(path.join(ctx.root, '.web-chat', 'components', 'deploy-board', 'service.js'), '\n// mine now\n');
  removePackByName({ name: 'acme-ops', root: ctx.root, tier: 'local' });
  const trimmed = findLedgerEntry(ctx.root, 'acme-ops');
  assert.deepEqual(trimmed.units.map((u) => u.name), ['deploy-board']);
  assert.match((await packOf(ctx)).skipped.find((x) => x.name === 'deploy-board').reason, /service\.js changed since the pack installed it/);
  removePackByName({ name: 'acme-ops', root: ctx.root, tier: 'local', force: true });
  assert.equal(findLedgerEntry(ctx.root, 'acme-ops'), null, 'and dropped with the record');
});

// The tier check on its own: a copy whose service.js AND meta.json are the
// pack's bytes, in the other tier. The identity files cannot tell it apart; the
// module it requires can differ.
test('a byte-identical copy in the project is still not the copy the pack installed', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const TWIN = "const impl = require('./impl.js');\nmodule.exports = { async start(ctx) { ctx.driver.setStore({ ['svc_' + ctx.mountId]: impl() }); }, async stop() {} };\n";
  installFromStage({ stageDir: packFixture({ components: [{ name: 'twin', service: TWIN }] }), source: SOURCE, tier: 'system', root: ctx.root, actor: 'cli' });
  const sys = path.join(userPaths().components, 'twin');
  fs.writeFileSync(path.join(sys, 'impl.js'), "module.exports = () => 'the pack';\n");
  assert.deepEqual((await packOf(ctx)).requests.map((p) => p.name), ['twin'], 'the install for all projects is offered');

  const local = path.join(ctx.root, '.web-chat', 'components', 'twin');
  fs.cpSync(sys, local, { recursive: true });
  fs.writeFileSync(path.join(local, 'impl.js'), "module.exports = () => 'the repository';\n");
  for (const f of ['service.js', 'meta.json']) {
    assert.equal(sha256(fs.readFileSync(path.join(local, f))), sha256(fs.readFileSync(path.join(sys, f))), `${f} is byte-identical`);
  }
  const listing = await packOf(ctx);
  assert.deepEqual(listing.requests, [], 'what would run here is not what the pack installed');
  assert.deepEqual(listing.skipped.map((x) => x.name), ['twin']);
  assert.match(listing.skipped[0].reason, /shadows/);
});

// A pack component may ship no meta.json (the manifest only warns). One written
// afterwards — by save_component over it, a pane's file-editor, a checkout — is
// a declaration the pack never shipped.
test('--pack leaves out a component whose meta.json the pack never shipped', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installFromStage({
    stageDir: packFixture({ components: [{ name: 'runner', service: SERVICE, meta: null }] }),
    source: SOURCE, tier: 'local', root: ctx.root, actor: 'cli',
  });
  const before = await packOf(ctx);
  assert.deepEqual(before.requests.map((p) => [p.name, p.covers]), [['runner', {}]], 'as shipped: no meta.json, no declaration');
  fs.writeFileSync(path.join(ctx.root, '.web-chat', 'components', 'runner', 'meta.json'), JSON.stringify({
    name: 'runner', params_schema: { type: 'object', properties: { cmd: { type: 'string', 'x-trust': 'display' } } },
  }));
  const after = await packOf(ctx);
  assert.deepEqual(after.requests, [], 'a widened declaration is not approved as the pack\'s');
  assert.match(after.skipped[0].reason, /meta\.json changed since the pack installed it/);
});

test('--pack never resolves a unit name that is not a component name', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  // A service.js beside .web-chat, and a record naming it by a relative path.
  const evil = path.join(ctx.root, 'evil');
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'component.html'), '<p>e</p>');
  fs.writeFileSync(path.join(evil, 'meta.json'), '{"name":"evil"}');
  fs.writeFileSync(path.join(evil, 'service.js'), SERVICE);
  upsertPack(ctx.root, 'local', {
    name: 'acme-ops', version: '1.0.0', source: SOURCE,
    units: [
      { kind: 'component', name: '../../evil', files: [
        { path: 'service.js', sha256: sha256(SERVICE) },
        { path: 'meta.json', sha256: sha256('{"name":"evil"}') },
      ] },
      { kind: 'component', name: 'esc\u001b[2Kape', files: [{ path: 'service.js', sha256: sha256(SERVICE) }] },
    ],
  });
  const listing = await packOf(ctx);
  assert.ok(listing.pack, 'the record is read');
  assert.deepEqual(listing.requests, [], 'nothing outside the components directory is offered for approval');
  assert.deepEqual(listing.skipped, [], 'and a name that is not a component name is not echoed back');
});

test('the consent listing prints no control character it was handed', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const stageDir = packFixture({
    version: '1.2.0\u001b[2K\rforged',
    components: [{
      name: 'deploy-board', service: SERVICE,
      params_schema: { type: 'object', properties: { ['ti\u001btle']: { type: 'string', 'x-trust': 'display' } } },
    }],
  });
  installFromStage({ stageDir, source: SOURCE, tier: 'local', root: ctx.root, actor: 'cli' });

  const pack = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(false) }));
  assert.match(pack.out, /deploy-board/);
  assert.ok(!/[\u001b\r]/.test(pack.out), `a pack record's version or a schema's param name reached the terminal raw: ${JSON.stringify(pack.out)}`);
  assert.match(pack.out, /1\.2\.0\?\[2K\?forged/, 'shown, with its control characters as ?');
  assert.match(pack.out, /ti\?tle: display only/);

  // A pane's param NAME (values are JSON-escaped already) on the pending listing.
  await openViewer(t, ctx);
  await ctx.api.post('/api/components/deploy-board/use', { id: 'b', params: { ['x\u001b[31m']: 1 } });
  assert.ok(await waitUntil(async () => (await pendingOf(ctx)).length === 1));
  const listing = await runCli(['trust'], { cwd: ctx.root, home: ctx.home });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /x\?\[31m=1/);
  assert.ok(!listing.stdout.includes('\u001b'), 'a pane cannot write escape sequences into the listing');
});

// ── the trust file itself ───────────────────────────────────────────────────
// Every decision is a read-modify-write of ~/.web-chat/services/trusted.json.
// A read that took a torn file for an empty one made the next grant drop every
// earlier decision; `[]` printed "Recorded in…" over a file that recorded
// nothing; `null` threw.

test('a trust file the CLI cannot use is kept aside, and the decision really is recorded', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  const file = trustFile(ctx);
  const dir = path.dirname(file);
  const keys = (await packOf(ctx)).requests.map((p) => p.key).sort();
  for (const [label, bytes] of [
    ['torn', '{"older-key": {"name": "older", "approved": tru'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(true) }));
    assert.equal(r.exit, null, `${label}: ${r.err}`);
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(now && !Array.isArray(now) && typeof now === 'object', `${label}: the file is a map of decisions again`);
    assert.deepEqual(Object.keys(now).sort(), keys, `${label}: and holds the decision just made`);
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith('trusted.json.unreadable-'));
    assert.equal(aside.length, 1, `${label}: the unusable file was kept, not overwritten`);
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), bytes, `${label}: byte for byte`);
    assert.ok(r.out.includes(path.join(dir, aside[0])), `${label}: and the output says where: ${r.out}`);
    assert.match(r.out, /no decision in it was in effect/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], `${label}: no temp file left behind`);
  }

  // A readable file keeps every decision already in it.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ 'older-key': { name: 'older', approved: true, approved_at: 1 } }));
  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(r.exit, null, r.err);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['older-key', ...keys].sort());
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('trusted.json.unreadable-')), []);
  assert.doesNotMatch(r.out, /kept as/);
});

// The daemon reads the same file fail-closed (readJsonOr plus a shape check):
// anything but a map of decisions approves nothing — and must not throw, since
// reconcile runs on a timer with no handler above it.
test('the daemon reads a trust file that is not a map of decisions as nothing decided', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  installAcme(ctx.root);
  await openViewer(t, ctx);
  const file = trustFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bytes of ['null', '[]', '"x"', '7']) {
    fs.writeFileSync(file, bytes);
    await api.post('/api/components/deploy-board/use', { id: 'b', params: { title: 'x' } });
    await api.post('/api/services/refresh-trust', {});
    const waiting = await waitUntil(async () => {
      const p = await pendingOf(ctx);
      return p.length === 1 ? p : false;
    });
    assert.ok(waiting, `${bytes}: the pane waits for a decision`);
    await sleep(300);
    assert.equal(ctx.srv.services._children.size, 0, `${bytes}: and nothing runs`);
    assert.equal((await api.get('/api/health')).status, 200, `${bytes}: the daemon still answers`);
    const pack = await api.get('/api/services/pack/acme-ops');
    assert.equal(pack.status, 200, `${bytes}: the pack listing too`);
    assert.deepEqual(pack.json.requests.map((p) => p.decision), [null, null]);
  }
});

// ── refusals ────────────────────────────────────────────────────────────────

test('--pack refuses with no daemon, and writes nothing', async (t) => {
  const root = tmpRoot('wc-nodaemon-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const r = await runCli(['trust', '--pack', 'acme-ops'], { cwd: root, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no running web-chat server for this project/);
  assert.match(r.stderr, /claude-web-chat open/);
  assert.match(r.stderr, /No pane needs to be open/);
  assert.equal(fs.existsSync(path.join(home, '.web-chat', 'services', 'trusted.json')), false);
});

test('--pack against a server that predates it says to restart it, and writes nothing', async (t) => {
  withTempHome(t);
  // What a 0.8.0 daemon answers for a route it does not have: Express's 404.
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><p>Cannot GET</p>');
  });
  t.after(() => new Promise((r) => server.close(r)));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const root = tmpRoot('wc-old-daemon-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });

  const r = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: root, prompt: answering(true) }));
  assert.equal(r.exit, 1);
  assert.match(r.err, /predates `trust --pack`/);
  assert.match(r.err, /claude-web-chat restart/);
  assert.equal(fs.existsSync(userPaths().trustedServices), false);
});

test('--pack names an unknown pack, a pack with no services, and a malformed call', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });

  const none = await runInProcess(() => trust(['--pack', 'nope'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(none.exit, 1);
  assert.match(none.err, /no pack named "nope" is installed in this project or for all projects/);
  assert.match(none.err, /pack list/);
  assert.deepEqual(await packOf(ctx, 'nope'), { ok: true, root: ctx.root, pack: null, requests: [], skipped: [] });
  assert.equal((await packOf(ctx, '..%2f..%2fetc')).pack, null, 'a name that is not a pack name is not installed');

  installAcme(ctx.root, { components: [{ name: 'readme-view' }] });
  const quiet = answering(true);
  const empty = await runInProcess(() => trust(['--pack', 'acme-ops'], { cwd: ctx.root, prompt: quiet }));
  assert.equal(empty.exit, null);
  assert.match(empty.out, /installs no service components\. There is nothing to approve\./);
  assert.equal(quiet.asked.length, 0);

  const bare = await runInProcess(() => trust(['--pack'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(bare.exit, 1);
  assert.match(bare.err, /--pack needs the name of an installed pack/);
  const flagged = await runInProcess(() => trust(['--pack', '--deny'], { cwd: ctx.root, prompt: answering(true) }));
  assert.equal(flagged.exit, 1, '`--pack --deny` is a missing name, not a pack called --deny');
  assert.match(flagged.err, /--pack needs the name of an installed pack/);
  assert.doesNotMatch(flagged.err, /no pack named/);
  for (const extra of [['--all'], ['deploy-board'], ['--params-fp', 'abc']]) {
    const mixed = await runInProcess(() => trust(['--pack', 'acme-ops', ...extra], { cwd: ctx.root, prompt: answering(true) }));
    assert.equal(mixed.exit, 1, `--pack with ${extra.join(' ')}`);
    assert.match(mixed.err, /does not combine/);
  }
  assert.equal(readTrust(ctx), null, 'none of it wrote anything');
});

// ── remote ──────────────────────────────────────────────────────────────────

test('the pack listing is remote-readable, and a remote-labelled request gets no host path', async (t) => {
  assert.equal(classify('GET', '/api/services/pack/acme-ops').allow, true, 'listing is allowed remotely, like /pending');
  assert.equal(classify('POST', '/api/services/pack/acme-ops').allow, false, 'nothing else on it is');
  assert.equal(classify('POST', '/api/services/refresh-trust').allow, false);

  const ctx = await withServer(t, { writePortfile: true });
  installAcme(ctx.root);
  const remote = await ctx.api.get('/api/services/pack/acme-ops', { 'x-wc-remote': '1' });
  assert.equal(remote.status, 200);
  assert.equal(remote.json.root, '<project>');
  assert.ok(remote.json.requests.length && remote.json.requests.every((r) => r.root === '<project>'));
  for (const leak of [ctx.root, fs.realpathSync(ctx.root), homeDir()]) {
    assert.ok(!remote.text.includes(leak), `the remote listing names ${leak}`);
  }
  assert.equal((await packOf(ctx)).root, ctx.root, 'the host still sees its own paths');
});
