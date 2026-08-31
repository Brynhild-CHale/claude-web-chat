// Service-trust IDENTITY — one triple, minted once, quoted everywhere.
//
// A consent is (project root, service.js hash, params shape). lib/server/services.js
// mints it in computeDesired and hands the same value to the trust file, the
// pending listing, the WS notice, the browser's card map, the CLI's selector and
// its own restart test. Everything here fails if a consumer starts re-projecting
// it — which is exactly what had happened:
//
//   * the service:trust / service:trust:clear frames carried the service.js hash
//     alone, so two params-variants of one component were ONE card in every
//     browser, and retiring either request cleared both (review-minor-2);
//   * the fingerprint hashed mount.params verbatim, so the shell's own
//     render-control keys joined the identity and `params.form_reset:true` on a
//     re-render restarted the child and re-asked for approval (review-minor-3);
//   * `trust <name>` recorded a decision for EVERY matching request, printing
//     none of their params and asking nothing (cli-ops-4).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { withServer, waitUntil: harnessWaitUntil } = require('../test-support/helpers');
const { paramsFingerprint, serviceParams, trustKey } = require('../lib/server/services');
const { RENDER_CONTROL_PARAMS } = require('../lib/server/domain/mounts');

// The harness poll with this file's budget bound in (forked children and a
// debounced reconcile), not a second implementation.
const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 4000, interval: 40, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reports its pid and params, so a test can see whether a re-render restarted
// the child or left it alone.
const PID_SERVICE = `
let timer = null;
module.exports = {
  async start(ctx) {
    const tick = () => ctx.driver.setStore({ clock: { seq: Date.now(), pid: process.pid, params: ctx.params } });
    tick();
    timer = setInterval(tick, 40);
  },
  async stop() { if (timer) clearInterval(timer); timer = null; },
};`;

function openViewer(ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    const frames = [];
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (!msg) return;
      frames.push(msg);
      if (msg.type === 'hello') resolve({ sock, frames });
    });
    sock.on('error', reject);
  });
}

const pending = async (ctx) => (await ctx.api.get('/api/services/pending')).json.pending;

// Approve exactly the way the CLI does: write the user-tier trust file under the
// key the SERVER reported, then nudge. Nothing in the browser can do this.
async function approve(ctx, req) {
  const file = path.join(ctx.userWebChat, 'services', 'trusted.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data[req.key] = { name: req.name, hash: req.hash, root: req.root, params: req.params, approved: true, approved_at: 1 };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await ctx.api.post('/api/services/refresh-trust', {});
}

// ── the identity itself ─────────────────────────────────────────────────────

test('the params fingerprint ignores the keys the SHELL reads', () => {
  const base = { root: 'src' };
  const fp = paramsFingerprint(base);
  // Each of these is a render-control key: it changes how the pane is put on
  // screen, never what the host process does. A service whose params fingerprint
  // moved when one appeared was a service the user had to re-consent to for a
  // UI-only reason.
  assert.equal(paramsFingerprint({ ...base, form_reset: true }), fp, 'form_reset is not part of the identity');
  assert.equal(paramsFingerprint({ ...base, routing: 'none' }), fp, 'nor routing');
  assert.equal(paramsFingerprint({ ...base, signals: [{ key: 'go', wake: 'queue' }] }), fp, 'nor declared signals');
  assert.equal(paramsFingerprint({ ...base, form_reset: true, routing: 'auto', signals: [] }), fp, 'nor all three at once');
  assert.equal(paramsFingerprint({ form_reset: true, routing: 'none' }), paramsFingerprint({}),
    'a params bag of nothing BUT control keys is the no-params request');

  // What it must still separate.
  assert.notEqual(paramsFingerprint({ ...base, unfenced: true }), fp,
    'a real param is the whole point — `unfenced:true` must never inherit the fenced grant');
  assert.notEqual(paramsFingerprint({ root: 'lib' }), fp, 'and a different value is a different request');
  assert.equal(paramsFingerprint({ root: 'src', a: 1 }), paramsFingerprint({ a: 1, root: 'src' }),
    'key order is not identity');
  assert.equal(paramsFingerprint(undefined), paramsFingerprint({}), 'no params is the empty bag');
  assert.equal(paramsFingerprint('nonsense'), paramsFingerprint({}), 'and so is a non-object');

  // serviceParams is what the child is actually spawned with.
  assert.deepEqual(serviceParams({ root: 'src', form_reset: true, signals: [], routing: 'none' }), { root: 'src' },
    'the service is handed the params it was consented on, and nothing the shell added');
});

test('the trust key separates project, source and params', () => {
  const k = trustKey('h1', '/a', 'fp1');
  assert.notEqual(trustKey('h2', '/a', 'fp1'), k, 'an edited service.js re-asks');
  assert.notEqual(trustKey('h1', '/b', 'fp1'), k, 'the same component in another project re-asks');
  assert.notEqual(trustKey('h1', '/a', 'fp2'), k, 'different params re-ask');
  assert.equal(trustKey('h1', '/a', 'fp1'), k, 'and the same request is the same key');
});

// The drift guard for the strip above. Two files interpret a mount's params on
// the shell's behalf; every key they read must be named in RENDER_CONTROL_PARAMS,
// or it silently rejoins the consent identity and a fourth control key becomes a
// fourth reason to re-ask the user about a service that never changed.
test('every params key the shell reads for itself is named in RENDER_CONTROL_PARAMS', () => {
  const REPO = path.resolve(__dirname, '..');
  for (const rel of ['lib/server/domain/mounts.js', 'lib/server/domain/signals.js']) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const m of src.matchAll(/params\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      assert.ok(RENDER_CONTROL_PARAMS.has(m[1]),
        `${rel} reads params.${m[1]} on the shell's behalf, but RENDER_CONTROL_PARAMS does not list it — `
        + 'it would become part of every service-backed pane’s trust identity');
    }
  }
});

// ── two variants, end to end ────────────────────────────────────────────────

test('two params-variants of one service are two requests, two keys and two notices', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'scoped', source: '<p>s</p>', description: 's', service: PID_SERVICE });
  const { sock, frames } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/scoped/use', { id: 'm1' });
  await api.post('/api/components/scoped/use', { id: 'm2', params: { unfenced: true } });

  const two = await waitUntil(async () => {
    const p = await pending(ctx);
    return p.length === 2 ? p : false;
  });
  assert.ok(two, 'the same service.js under two params shapes is two decisions');
  assert.equal(new Set(two.map((p) => p.key)).size, 2, 'and two distinct trust keys');
  assert.equal(two[0].hash, two[1].hash, 'even though the service.js hash is identical — the hash cannot tell them apart');

  const notices = await waitUntil(() => {
    const n = frames.filter((f) => f.type === 'service:trust');
    return n.length >= 2 ? n : false;
  });
  assert.equal(new Set(notices.map((f) => f.key)).size, 2,
    'the browser is told about both, addressed by key — under the hash they were one card');
  assert.ok(notices.every((f) => f.key), 'every notice carries the key the daemon minted');
  const unfenced = notices.find((f) => f.params && f.params.unfenced === true);
  assert.ok(unfenced, 'and each notice names the params it is about');

  // Retiring ONE request must leave the other's card standing. prune() clears by
  // key now; by hash it cleared both from every connected browser while the
  // survivor was still pending on the server.
  const survivor = two.find((p) => p.params && p.params.unfenced === true);
  const retired = two.find((p) => p !== survivor);
  frames.length = 0;
  await api.post('/api/clear', { id: 'm1' });

  const cleared = await waitUntil(() => frames.find((f) => f.type === 'service:trust:clear') || false);
  assert.ok(cleared, 'the cleared pane retires its request');
  assert.equal(cleared.key, retired.key, 'the clear names the request that went away');
  assert.notEqual(cleared.key, survivor.key, 'and never the one still waiting');
  await sleep(300);
  assert.deepEqual((await pending(ctx)).map((p) => p.key), [survivor.key],
    'the surviving request is still pending — the browser and the server agree');
});

test('a render-control key on a re-use neither restarts the child nor re-asks', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'scoped', source: '<p>s</p>', description: 's', service: PID_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/scoped/use', { id: 'm1', params: { root: 'src' } });
  const req = await waitUntil(async () => (await pending(ctx))[0] || false);
  await approve(ctx, req);
  const pid = await waitUntil(async () => (await api.get('/api/store')).json.clock?.pid);
  assert.ok(pid, 'the approved service is running');
  assert.deepEqual((await api.get('/api/store')).json.clock.params, { root: 'src' },
    'and was handed the params it was consented on');

  // The SAME service, the same params — plus the three keys the shell reads for
  // itself. Nothing about the host process changed, so nothing may happen to it.
  await api.post('/api/components/scoped/use', {
    id: 'm1',
    params: { root: 'src', form_reset: true, routing: 'none', signals: [{ key: 'go', wake: 'queue' }] },
  });
  await sleep(700);
  assert.deepEqual(await pending(ctx), [], 'no new approval is asked for');
  assert.equal((await api.get('/api/store')).json.clock.pid, pid,
    'and the child was never restarted — a UI-only re-render is not a new consent');
  assert.equal(ctx.srv.services._children.get('m1').params.root, 'src', 'still the params it was approved with');
});

// ── the CLI decides ONE request at a time ───────────────────────────────────
// `trust <name>` used to write a decision for every pending request under that
// name — both `file-editor` variants at once, printing neither params set and
// asking nothing, while the `--all` path it bypassed printed each request and
// confirmed. A pane can mount a component a second time with any params it likes
// before the user reaches the terminal, so the by-name path had to stop being a
// blanket approval.
//
// ASYNC spawn, deliberately: the daemon the child talks to is in THIS process, so
// a spawnSync would block the event loop that has to answer it.
function runCli(args, ctx) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd: ctx.root,
      env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`trust <name>` refuses an ambiguous name and approves only the variant it is given', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  const trustFile = path.join(ctx.userWebChat, 'services', 'trusted.json');
  await api.post('/api/components', { name: 'scoped', source: '<p>s</p>', description: 's', service: PID_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/scoped/use', { id: 'm1', params: { root: 'src' } });
  await api.post('/api/components/scoped/use', { id: 'm2', params: { unfenced: true } });
  const two = await waitUntil(async () => {
    const p = await pending(ctx);
    return p.length === 2 ? p : false;
  });
  assert.ok(two, 'two variants are waiting');
  const fenced = two.find((p) => p.params && p.params.root === 'src');
  const unfenced = two.find((p) => p.params && p.params.unfenced === true);

  const ambiguous = await runCli(['trust', 'scoped'], ctx);
  assert.equal(ambiguous.status, 1, 'an ambiguous name is a refusal, not a batch approval');
  assert.match(ambiguous.stderr, /2 requests waiting/, 'it says how many decisions the name covers');
  assert.match(ambiguous.stderr, /root="src"/, 'and prints the params of each');
  assert.match(ambiguous.stderr, /unfenced=true/);
  assert.ok(ambiguous.stderr.includes(fenced.params_fp) && ambiguous.stderr.includes(unfenced.params_fp),
    'including the fingerprint the user has to pass back');
  assert.match(ambiguous.stderr, /--params-fp <fingerprint>/, 'and the selector to pass it with');
  assert.match(ambiguous.stderr, /--all/, 'or the flag that decides them all deliberately');
  assert.equal(fs.existsSync(trustFile), false, 'nothing was written — a refusal grants nothing by halves');

  const one = await runCli(['trust', 'scoped', '--params-fp', fenced.params_fp], ctx);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /root="src"/, 'the grant names the params it just approved');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(trustFile, 'utf8'))), [fenced.key],
    'exactly one decision, under the key the daemon minted');

  assert.ok(await waitUntil(async () => {
    const p = await pending(ctx);
    return p.length === 1 && p[0].key === unfenced.key;
  }), 'the variant nobody decided is still waiting');

  // Unambiguous again — the ordinary path still works, and still says what it did.
  const rest = await runCli(['trust', 'scoped'], ctx);
  assert.equal(rest.status, 0, rest.stderr);
  assert.match(rest.stdout, /unfenced=true/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(trustFile, 'utf8'))).sort(), [fenced.key, unfenced.key].sort(),
    'and now both decisions exist — each one made on purpose');
});

test('`trust <name> --all` decides that name’s variants and no others', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  const trustFile = path.join(ctx.userWebChat, 'services', 'trusted.json');
  await api.post('/api/components', { name: 'scoped', source: '<p>s</p>', description: 's', service: PID_SERVICE });
  await api.post('/api/components', { name: 'other', source: '<p>o</p>', description: 'o', service: PID_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/scoped/use', { id: 'm1', params: { root: 'src' } });
  await api.post('/api/components/scoped/use', { id: 'm2', params: { unfenced: true } });
  await api.post('/api/components/other/use', { id: 'm3' });
  const three = await waitUntil(async () => {
    const p = await pending(ctx);
    return p.length === 3 ? p : false;
  });
  assert.ok(three, 'three requests, two components');

  // No TTY: the shared prompt engine resolves the confirmation to its printed
  // default, which for host execution is No. There is deliberately no --yes.
  const declined = await runCli(['trust', 'scoped', '--all'], ctx);
  assert.equal(declined.status, 0, declined.stderr);
  assert.match(declined.stdout, /Nothing was changed/, 'a pipe never grants host execution');
  assert.match(declined.stdout, /2 services waiting/, 'and --all with a name covers that name only');
  assert.doesNotMatch(declined.stdout, /\bother\b/, 'the other component is not in the scope it offered to decide');
  assert.equal(fs.existsSync(trustFile), false, 'nothing written');
});
