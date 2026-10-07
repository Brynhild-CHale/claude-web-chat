// The answer surface (lib/server/answer-surface, spec §4.4, §15.5): the
// loopback listener the answer frames live on. What is pinned:
//   * the ask document: the fixture page with a fresh nonce minted per load
//     and per ask (8 live per ask), the mode and the kind substituted, nothing
//     of the ask inlined, a bad layout refused;
//   * the headers: §4.4's CSP with frame-ancestors at the main port, no
//     X-Frame-Options, no-referrer, nosniff, no-store, COOP for the page
//     layout, CORP on JSON;
//   * the decide gate: only a same-origin JSON POST carrying this ask's nonce
//     reaches asks.decide; every other shape is refused 403 before it, and the
//     refusal is noted on the ask;
//   * the display long-poll, and close() ending one that waits;
//   * palette.css (ruling A6 (b)): a built-in pack's values from PACKS, an
//     installed pack's only when the terminal installed it and its bytes are
//     the ones installed, and Earthy for everything else, a palette failing the
//     contrast check included; contrastRatio's one home;
//   * the static routes, by name, and the fonts;
//   * register(): a kind's document and API behind the same gate, the meta slot;
//   * the keep-alive and the lifecycle; nothing answered remotely; no handle
//     left after close().
//
// The page's real documents are U56's (lib/server/answer-surface/public), so
// every case here serves a FIXTURE publicDir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { waitUntil } = require('../test-support/helpers');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const palette = require('../lib/server/answer-surface/palette');
const { PACKS } = require('../lib/server/theme-packs');
const { flattenTheme } = require('../lib/server/theme');
const { projectPaths } = require('../lib/core/paths');
const { sha256 } = require('../lib/packs/store');

const MAIN = 54321;
const FONTS = path.join(__dirname, '..', 'public', 'fonts');
const ASK = 'ask_0123456789ab';
const OTHER = 'ask_ba9876543210';

// ── fixtures ────────────────────────────────────────────────────────────────
const tmp = (p = 'wc-answer-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

const PAGE = [
  '<!doctype html>',
  '<html data-mode="{{MODE}}" data-kind="{{KIND}}">',
  '<head>',
  '<meta name="wc-answer-nonce" content="{{NONCE}}">',
  '<!--meta-->{{META}}<!--/meta-->',
  '<link rel="stylesheet" href="/answer/palette.css">',
  '<script type="module" src="/answer/answer.js"></script>',
  '</head><body></body></html>',
].join('\n');

const PUB = (() => {
  const dir = tmp('wc-answer-pub-');
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.writeFileSync(path.join(dir, 'answer.js'), 'export const runtime = 1;\n');
  fs.writeFileSync(path.join(dir, 'answer.css'), 'body { margin: 0; }\n');
  fs.writeFileSync(path.join(dir, 'stop-frame.js'), 'export const stop = 1;\n');
  fs.writeFileSync(path.join(dir, 'x.html'), '<p>no</p>\n');
  fs.writeFileSync(path.join(dir, 'A.js'), 'export {};\n');
  return dir;
})();

// A fake ctx.asks: records decide and noteRefusal calls, answers decide from a
// queue, and long-polls with timers it clears on stop().
function fakeAsks() {
  const views = new Map();
  const waiters = new Set();
  const timers = new Set();
  const out = {
    decides: [],
    refusals: [],
    results: [],
    pendingCount: 0,
    hang: false,
    put(id, version = 1) { views.set(id, { id, version, state: 'pending' }); },
    bump(id) {
      const v = views.get(id);
      v.version++;
      for (const w of [...waiters]) w(id);
    },
    pending() { return Array.from({ length: out.pendingCount }, (_, i) => ({ id: `p${i}` })); },
    decide(id, decision, meta) {
      out.decides.push({ id, decision, meta });
      return out.results.shift() || { ok: true, state: 'decided', outcome: 'allowed', version: 2 };
    },
    noteRefusal(id, info) { out.refusals.push({ id, ...info }); },
    displayView(id) { const v = views.get(id); return v ? { ...v } : null; },
    waitView(id, version, wait) {
      const v = views.get(id);
      if (!v) return Promise.resolve(null);
      if (out.hang) return new Promise(() => {});
      if (v.version !== version || !wait) return Promise.resolve({ ...v });
      return new Promise((resolve) => {
        const done = () => { clearTimeout(t); timers.delete(t); waiters.delete(w); resolve({ ...views.get(id) }); };
        const w = (changed) => { if (changed === id) done(); };
        const t = setTimeout(done, wait);
        timers.add(t);
        waiters.add(w);
      });
    },
    stop() { for (const t of timers) clearTimeout(t); timers.clear(); waiters.clear(); },
  };
  return out;
}

async function boot(t, opts = {}) {
  const asks = opts.asks || fakeAsks();
  asks.put(ASK, 3);
  asks.put(OTHER, 1);
  const s = createAnswerSurface({
    asks,
    mainPort: () => MAIN,
    audience: { levelOf: () => 'full' },
    root: opts.root || null,
    publicDir: PUB,
    fontsDir: FONTS,
    idleMs: opts.idleMs || 60_000,
  });
  t.after(async () => { await s.close(); asks.stop(); });
  const { origin, port } = await s.ensure();
  return { s, asks, origin, port };
}

// One raw request, so the test controls Host, Origin and Sec-Fetch-*.
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const nonceOf = (r) => /name="wc-answer-nonce" content="([^"]*)"/.exec(r.text)[1];
const metaSlot = (r) => /<!--meta-->([\s\S]*?)<!--\/meta-->/.exec(r.text)[1];

async function askDoc(port, id = ASK, query = 'layout=card&mode=dark') {
  return req(port, { path: `/answer/ask/${id}?${query}` });
}

function decideReq(port, origin, nonce, { id = ASK, headers = {}, body } = {}) {
  return req(port, {
    method: 'POST',
    path: `/answer/api/asks/${id}/decide`,
    headers: {
      origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      ...(nonce != null ? { 'x-wc-answer': nonce } : {}),
      ...headers,
    },
    body: body || { decision: { behavior: 'allow' }, version: 3, device: 'desktop' },
  });
}

const EXACT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; "
  + `frame-ancestors http://localhost:${MAIN} http://127.0.0.1:${MAIN}`;

// ── the document ────────────────────────────────────────────────────────────
test('the ask document: the fixture page, a fresh nonce per load, the mode and the kind', async (t) => {
  const { port } = await boot(t);
  const a = await askDoc(port);
  assert.equal(a.status, 200);
  assert.match(a.headers['content-type'], /^text\/html/);
  assert.match(a.text, /<html data-mode="dark" data-kind="ask">/);
  const n1 = nonceOf(a);
  assert.match(n1, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(metaSlot(a), '', 'an ask document has an empty meta slot');
  assert.doesNotMatch(a.text, /\{\{/, 'every placeholder is substituted');
  assert.doesNotMatch(a.text, new RegExp(ASK), 'nothing of the ask is inlined');
  const b = await askDoc(port);
  assert.notEqual(nonceOf(b), n1, 'two loads mint two nonces');

  // An invalid mode is light; a bad layout is refused.
  assert.match((await askDoc(port, ASK, 'layout=bar&mode=sepia')).text, /data-mode="light"/);
  assert.match((await askDoc(port, ASK, 'mode=dark')).text, /data-mode="dark"/, 'no layout is the card');
  assert.equal((await askDoc(port, ASK, 'layout=popup')).status, 400);
  // An unknown id still gets the page (the runtime says it is no longer waiting).
  const u = await askDoc(port, 'ask_ffffffffffff', 'layout=bar');
  assert.equal(u.status, 200);
  assert.match(u.text, /data-kind="ask"/);
});

test('the ninth document for one ask evicts the first nonce', async (t) => {
  const { port, origin, asks } = await boot(t);
  const nonces = [];
  for (let i = 0; i < 9; i++) nonces.push(nonceOf(await askDoc(port)));
  assert.equal(new Set(nonces).size, 9);
  const first = await decideReq(port, origin, nonces[0]);
  assert.equal(first.status, 403);
  assert.deepEqual(first.json, { ok: false, refused: 'nonce' });
  const second = await decideReq(port, origin, nonces[1]);
  assert.equal(second.status, 200);
  assert.equal(asks.decides.length, 1);
});

test('the headers: the exact CSP, no X-Frame-Options, the common three, COOP for page, CORP on JSON', async (t) => {
  const { port, origin } = await boot(t);
  const d = await askDoc(port);
  assert.equal(d.headers['content-security-policy'], EXACT_CSP);
  assert.equal(d.headers['x-frame-options'], undefined);
  assert.equal(d.headers['referrer-policy'], 'no-referrer');
  assert.equal(d.headers['x-content-type-options'], 'nosniff');
  assert.equal(d.headers['cache-control'], 'no-store');
  assert.equal(d.headers['cross-origin-opener-policy'], undefined, 'only the page layout opts into COOP');
  const page = await askDoc(port, ASK, 'layout=page');
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(page.headers['content-security-policy'], EXACT_CSP);

  const nonce = nonceOf(d);
  const view = await req(port, { path: `/answer/api/asks/${ASK}?v=0`, headers: { 'x-wc-answer': nonce } });
  assert.equal(view.status, 200);
  assert.match(view.headers['content-type'], /^application\/json/);
  assert.equal(view.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(view.headers['cache-control'], 'no-store');
  const refused = await decideReq(port, `http://localhost:${MAIN}`, nonce);
  assert.equal(refused.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(refused.headers['referrer-policy'], 'no-referrer');
  assert.equal(origin, `http://127.0.0.1:${port}`);
});

// ── the decide gate ─────────────────────────────────────────────────────────
test('decide through the gate reaches asks.decide with via web and the version', async (t) => {
  const { port, origin, asks } = await boot(t);
  const nonce = nonceOf(await askDoc(port));
  const r = await decideReq(port, origin, nonce, { headers: { 'user-agent': 'TestAgent/1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, state: 'decided', outcome: 'allowed', version: 2 });
  assert.equal(asks.decides.length, 1);
  const call = asks.decides[0];
  assert.equal(call.id, ASK);
  assert.deepEqual(call.decision, { behavior: 'allow' });
  assert.deepEqual(call.meta, { via: 'web', remote: false, device: 'desktop', ua: 'TestAgent/1', version: 3 });
  assert.equal(asks.refusals.length, 0);

  // The domain's refusals map through: 409 (lost to the terminal, stale) and 400.
  asks.results.push({ ok: false, status: 409, state: 'resolved', outcome: 'terminal', decision: { behavior: 'terminal' } });
  const lost = await decideReq(port, origin, nonce);
  assert.equal(lost.status, 409);
  assert.deepEqual(lost.json, { ok: false, state: 'resolved', outcome: 'terminal', decision: { behavior: 'terminal' } });
  asks.results.push({ ok: false, status: 409, stale: true, version: 4 });
  const stale = await decideReq(port, origin, nonce);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, { ok: false, stale: true, version: 4 });
  asks.results.push({ ok: false, status: 400, invalid: 'picks' });
  const bad = await decideReq(port, origin, nonce);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { ok: false, invalid: 'picks' });
  asks.results.push({ ok: false, status: 404, error: 'unknown ask' });
  assert.equal((await decideReq(port, origin, nonce)).status, 404);
  assert.equal(asks.decides.length, 5);
});

test('decide refused before asks.decide: each shape answers 403 and is noted on the ask', async (t) => {
  const { port, origin, asks } = await boot(t);
  const nonce = nonceOf(await askDoc(port));
  const otherNonce = nonceOf(await askDoc(port, OTHER));
  const cases = [
    ['the chrome\'s origin', { headers: { origin: `http://localhost:${MAIN}` } }, 'origin'],
    ['the chrome\'s other loopback name', { headers: { origin: `http://127.0.0.1:${MAIN}` } }, 'origin'],
    ['no Origin', { headers: { origin: undefined } }, 'origin'],
    ['Sec-Fetch-Site cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 'site'],
    ['form-encoded', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' }, 'type'],
    ['no nonce', { nonce: null }, 'nonce'],
    ['a nonce minted for another ask', { nonce: otherNonce }, 'nonce'],
    ['a forged nonce', { nonce: 'A'.repeat(43) }, 'nonce'],
  ];
  for (const [what, c, code] of cases) {
    const headers = { ...c.headers };
    const before = asks.refusals.length;
    // An undefined header is dropped by building the request without it.
    const r = await req(port, {
      method: 'POST',
      path: `/answer/api/asks/${ASK}/decide`,
      headers: Object.fromEntries(Object.entries({
        origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        ...('nonce' in c ? (c.nonce == null ? {} : { 'x-wc-answer': c.nonce }) : { 'x-wc-answer': nonce }),
        ...headers,
      }).filter(([, v]) => v !== undefined)),
      body: c.body || { decision: { behavior: 'allow' }, version: 3 },
    });
    assert.equal(r.status, 403, what);
    assert.deepEqual(r.json, { ok: false, refused: code }, what);
    assert.equal(asks.refusals.length, before + 1, `${what}: noted`);
    assert.equal(asks.refusals.at(-1).id, ASK, what);
    assert.equal(asks.refusals.at(-1).reason, code, what);
    assert.equal(asks.refusals.at(-1).origin, 'local', what);
  }

  // X-WC-Remote: the engine refuses it (tranche 4 answers nothing remotely),
  // and the surface notes it on the ask.
  const before = asks.refusals.length;
  const remote = await decideReq(port, origin, nonce, { headers: { 'x-wc-remote': '1' } });
  assert.equal(remote.status, 403);
  assert.equal(remote.json.remote, true);
  assert.match(remote.json.error, /host/);
  assert.equal(asks.refusals.length, before + 1);
  assert.deepEqual({ id: asks.refusals.at(-1).id, reason: asks.refusals.at(-1).reason }, { id: ASK, reason: 'remote' });

  // A Host that is not 127.0.0.1:<port> (DNS rebinding) and a preflight. The
  // engine answers both before the surface's handler runs and offers it no
  // hook, so these two are not noted (U55's hand-off, open issue 1).
  const host = await decideReq(port, origin, nonce, { headers: { host: `localhost:${port}` } });
  assert.equal(host.status, 421);
  const pre = await req(port, {
    method: 'OPTIONS',
    path: `/answer/api/asks/${ASK}/decide`,
    headers: { origin: `http://localhost:${MAIN}`, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-wc-answer, content-type' },
  });
  assert.equal(pre.status, 403);
  assert.deepEqual(Object.keys(pre.headers).filter((h) => h.startsWith('access-control-')), []);

  assert.equal(asks.decides.length, 0, 'asks.decide never ran');
});

test('the API needs the nonce for reads too, and refuses a foreign Origin or fetch site', async (t) => {
  const { port, asks } = await boot(t);
  const nonce = nonceOf(await askDoc(port));
  assert.deepEqual((await req(port, { path: `/answer/api/asks/${ASK}?v=0` })).json, { ok: false, refused: 'nonce' });
  const foreign = await req(port, { path: `/answer/api/asks/${ASK}?v=0`, headers: { 'x-wc-answer': nonce, origin: `http://localhost:${MAIN}` } });
  assert.deepEqual(foreign.json, { ok: false, refused: 'origin' });
  const site = await req(port, { path: `/answer/api/asks/${ASK}?v=0`, headers: { 'x-wc-answer': nonce, 'sec-fetch-site': 'same-site' } });
  assert.deepEqual(site.json, { ok: false, refused: 'site' });
  const unknown = await req(port, { path: '/answer/api/asks/ask_ffffffffffff?v=0', headers: { 'x-wc-answer': nonceOf(await askDoc(port, 'ask_ffffffffffff')) } });
  assert.equal(unknown.status, 404);
  assert.equal((await req(port, { path: '/answer/api/asks/..%2Fx?v=0', headers: { 'x-wc-answer': nonce } })).status, 404);
  assert.equal((await req(port, { method: 'GET', path: `/answer/api/asks/${ASK}/decide`, headers: { 'x-wc-answer': nonce } })).status, 405);
  assert.equal(asks.decides.length, 0);
});

// ── the display long-poll ───────────────────────────────────────────────────
test('the display long-poll: at once on a new version, on a move, and at its wait', async (t) => {
  const { port, asks } = await boot(t);
  const nonce = nonceOf(await askDoc(port));
  const h = { 'x-wc-answer': nonce };
  const at = Date.now();
  const now = await req(port, { path: `/answer/api/asks/${ASK}?v=1&wait=20000`, headers: h });
  assert.equal(now.status, 200);
  assert.equal(now.json.version, 3);
  assert.ok(Date.now() - at < 1000, 'a different version answers at once');

  const moving = req(port, { path: `/answer/api/asks/${ASK}?v=3&wait=20000`, headers: h });
  await new Promise((r) => setTimeout(r, 100));
  asks.bump(ASK);
  const moved = await moving;
  assert.equal(moved.json.version, 4);

  const t0 = Date.now();
  const same = await req(port, { path: `/answer/api/asks/${ASK}?v=4&wait=150`, headers: h });
  assert.equal(same.json.version, 4);
  assert.ok(Date.now() - t0 >= 140, 'the same version answers at its wait');

  // The wait is capped at 20 s: a larger one still answers the view.
  asks.bump(ASK);
  assert.equal((await req(port, { path: `/answer/api/asks/${ASK}?v=4&wait=999999`, headers: h })).json.version, 5);
});

test('close() ends a waiting poll and leaves no handle', async (t) => {
  const { s, port, asks } = await boot(t);
  const nonce = nonceOf(await askDoc(port));
  asks.hang = true;
  const waiting = req(port, { path: `/answer/api/asks/${ASK}?v=3&wait=20000`, headers: { 'x-wc-answer': nonce } })
    .then((r) => r, (e) => ({ error: e }));
  await new Promise((r) => setTimeout(r, 100));
  await s.close();
  const r = await waiting;
  assert.ok(r.error || r.status === 503, `the poll ended: ${JSON.stringify(r.status || r.error.code)}`);
  assert.equal(s.info(), null);
  await s.close(); // idempotent
});

// ── palette.css ─────────────────────────────────────────────────────────────
function paletteRoot() {
  const root = tmp('wc-answer-root-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}
const pack = (name) => PACKS.find((p) => p.name === name);
const tok = (theme, mode, name) => flattenTheme(theme, mode).tokens[name];
// The value a palette.css block carries for one token, per mode.
function block(css, mode, name) {
  const m = new RegExp(`:root\\[data-mode=${mode}\\] \\{([\\s\\S]*?)\\n\\}`).exec(css);
  assert.ok(m, `a ${mode} block`);
  const d = new RegExp(`\\n\\s*${name}: ([^;]*);`).exec(`\n${m[1]}`);
  return d ? d[1] : undefined;
}
function assertPack(css, theme, what) {
  for (const mode of ['light', 'dark']) {
    for (const name of ['--wc-bg', '--wc-fg', '--wc-panel-bg', '--wc-accent']) {
      assert.equal(block(css, mode, name), tok(theme, mode, name), `${what}: ${mode} ${name}`);
    }
  }
}
function writeTheme(root, record) {
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify(record));
}
// A pack's theme as the install pipeline leaves it: the library file, the
// record with its digest, and an audit line for the actor.
function installPackTheme(root, { theme = 'ocean', packName = 'ocean-pack', tokens, modes, actor = 'cli', op = 'install', edit = null } = {}) {
  const pp = projectPaths(root);
  fs.mkdirSync(pp.themesDir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ name: theme, tokens: tokens || {}, modes }, null, 2));
  fs.writeFileSync(path.join(pp.themesDir, `${theme}.json`), bytes);
  fs.writeFileSync(pp.packs, JSON.stringify({
    version: 1,
    packs: [{ name: packName, units: [{ kind: 'theme', name: theme, files: [{ path: `${theme}.json`, sha256: sha256(bytes) }] }] }],
  }));
  fs.mkdirSync(path.dirname(pp.packsAudit), { recursive: true });
  fs.appendFileSync(pp.packsAudit, `${JSON.stringify({ ts: new Date().toISOString(), op, actor, pack: packName, tier: 'local' })}\n`);
  if (edit) fs.writeFileSync(path.join(pp.themesDir, `${theme}.json`), JSON.stringify(edit));
}
// An installable palette distinct from every builtin, passing the check.
function oceanModes() {
  const p = pack('paper');
  const light = { ...flattenTheme(p, 'light').tokens, '--wc-bg': '#f0f4f8', '--wc-panel-bg': '#ffffff', '--wc-fg': '#102030' };
  const dark = { ...flattenTheme(p, 'dark').tokens, '--wc-bg': '#0a1420', '--wc-panel-bg': '#0e1a28', '--wc-fg': '#e8f0f8' };
  return { light: { tokens: light }, dark: { tokens: dark } };
}

async function paletteOf(t, root) {
  const { port } = await boot(t, { root });
  const r = await req(port, { path: '/answer/palette.css' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/css/);
  return r.text;
}

test('palette.css: Earthy with no theme or Earthy applied, Paper with Paper applied', async (t) => {
  const earthy = pack('earthy');
  assertPack(await paletteOf(t, paletteRoot()), earthy, 'no theme');
  const r1 = paletteRoot();
  writeTheme(r1, { name: 'earthy', builtin: true });
  const css = await paletteOf(t, r1);
  assert.equal(block(css, 'light', '--wc-bg'), '#e4dccb');
  assert.equal(block(css, 'dark', '--wc-bg'), tok(earthy, 'dark', '--wc-bg'));
  assert.equal(block(css, 'light', '--wc-fg'), tok(earthy, 'light', '--wc-fg'));
  assert.equal(block(css, 'dark', '--wc-fg'), tok(earthy, 'dark', '--wc-fg'));
  const r2 = paletteRoot();
  writeTheme(r2, { name: 'paper', builtin: true });
  assertPack(await paletteOf(t, r2), pack('paper'), 'paper');
  // No root at all: Earthy.
  assertPack(palette.renderPalette({}), earthy, 'no root');
});

test('palette.css: a pane-written theme never reaches the palette, even under a builtin\'s name', async (t) => {
  const evil = { '--wc-bg': '#123456', '--wc-fg': '#123457', '--wc-panel-bg': '#123456' };
  const r1 = paletteRoot();
  writeTheme(r1, { tokens: evil }); // POST /api/theme {scope:'global', tokens}
  const c1 = await paletteOf(t, r1);
  assertPack(c1, pack('earthy'), 'unnamed theme');
  assert.doesNotMatch(c1, /#12345/);
  const r2 = paletteRoot();
  writeTheme(r2, { name: 'paper', tokens: evil }); // a saved copy under a builtin's name
  const c2 = await paletteOf(t, r2);
  assert.doesNotMatch(c2, /#12345/);
  assertPack(c2, pack('earthy'), 'a flagless copy is not the pack');
  // Re-applying a builtin with builtin:true and other values: the pack's own.
  const r3 = paletteRoot();
  writeTheme(r3, { name: 'paper', builtin: true, tokens: evil, modes: { light: { tokens: evil }, dark: { tokens: evil } } });
  const c3 = await paletteOf(t, r3);
  assert.doesNotMatch(c3, /#12345/);
  assertPack(c3, pack('paper'), 'builtin:true re-application');
  // A theme saved to the library under any other name, then applied.
  const r4 = paletteRoot();
  fs.mkdirSync(projectPaths(r4).themesDir, { recursive: true });
  fs.writeFileSync(path.join(projectPaths(r4).themesDir, 'mine.json'), JSON.stringify({ name: 'mine', tokens: evil }));
  writeTheme(r4, { name: 'mine', tokens: evil });
  const c4 = await paletteOf(t, r4);
  assert.doesNotMatch(c4, /#12345/);
  assertPack(c4, pack('earthy'), 'a library theme no pack installed');
});

test('palette.css: an installed pack is followed only when the terminal installed or approved it', async (t) => {
  const modes = oceanModes();
  const ocean = { modes };
  const r1 = paletteRoot();
  installPackTheme(r1, { modes });
  writeTheme(r1, { name: 'ocean', tokens: { '--wc-bg': '#123456' } });
  const c1 = await paletteOf(t, r1);
  assertPack(c1, ocean, 'cli install');
  assert.equal(block(c1, 'light', '--wc-bg'), '#f0f4f8');
  assert.equal(block(c1, 'dark', '--wc-fg'), '#e8f0f8');

  const r2 = paletteRoot();
  installPackTheme(r2, { modes, op: 'approve' });
  writeTheme(r2, { name: 'ocean' });
  assertPack(await paletteOf(t, r2), ocean, 'cli approve');

  const r3 = paletteRoot();
  installPackTheme(r3, { modes, actor: 'http' });
  writeTheme(r3, { name: 'ocean' });
  assertPack(await paletteOf(t, r3), pack('earthy'), 'http install');

  // A terminal install a pane then re-installed over HTTP: the latest counts.
  const r4 = paletteRoot();
  installPackTheme(r4, { modes });
  fs.appendFileSync(projectPaths(r4).packsAudit, `${JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), op: 'install', actor: 'http', pack: 'ocean-pack', tier: 'local' })}\n`);
  writeTheme(r4, { name: 'ocean' });
  assertPack(await paletteOf(t, r4), pack('earthy'), 'a later http install');

  // A pane's save_theme over the installed file's name changes its bytes.
  const r5 = paletteRoot();
  installPackTheme(r5, { modes, edit: { name: 'ocean', tokens: { '--wc-bg': '#123456' } } });
  writeTheme(r5, { name: 'ocean' });
  const c5 = await paletteOf(t, r5);
  assert.doesNotMatch(c5, /#123456/);
  assertPack(c5, pack('earthy'), 'an edited install');

  // No audit line at all.
  const r6 = paletteRoot();
  installPackTheme(r6, { modes });
  fs.writeFileSync(projectPaths(r6).packsAudit, '');
  writeTheme(r6, { name: 'ocean' });
  assertPack(await paletteOf(t, r6), pack('earthy'), 'no audit');
});

test('palette.css: a vetted pack failing the contrast check falls back to Earthy', async (t) => {
  const base = oceanModes();
  const text = { light: { tokens: { ...base.light.tokens, '--wc-fg': '#eeeeee' } }, dark: base.dark };
  const r1 = paletteRoot();
  installPackTheme(r1, { modes: text });
  writeTheme(r1, { name: 'ocean' });
  assertPack(await paletteOf(t, r1), pack('earthy'), 'text under 4.5:1');

  const ui = { light: base.light, dark: { tokens: { ...base.dark.tokens, '--wc-accent': '#1a2836' } } };
  assert.ok(palette.contrastRatio(ui.dark.tokens['--wc-fg'], ui.dark.tokens['--wc-panel-bg']) >= 4.5);
  const r2 = paletteRoot();
  installPackTheme(r2, { modes: ui });
  writeTheme(r2, { name: 'ocean' });
  assertPack(await paletteOf(t, r2), pack('earthy'), 'a control under 3:1');

  // An unmeasurable ink fails too.
  assert.equal(palette.checkTokens({ ...base.light.tokens, '--wc-fg': 'var(--x)' }).ok, false);
});

test('contrastRatio is exported from palette.js and is the WCAG ratio', () => {
  assert.equal(typeof palette.contrastRatio, 'function');
  assert.equal(Math.round(palette.contrastRatio('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(palette.contrastRatio('#ffffff', '#000'), palette.contrastRatio('#000', '#ffffff'));
  assert.equal(palette.contrastRatio('#777', '#777'), 1);
  // #767676 on white is the classic 4.54:1.
  assert.equal(Math.round(palette.contrastRatio('#767676', '#fff') * 100) / 100, 4.54);
  assert.equal(Math.round(palette.contrastRatio('rgb(118, 118, 118)', '#ffffff') * 100) / 100, 4.54);
  assert.ok(Number.isNaN(palette.contrastRatio('#000', 'rgba(255,255,255,0.5)')), 'a translucent fill is unmeasured');
  // A translucent ink is measured as it lands: composited over the fill first.
  assert.equal(palette.contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff'), palette.contrastRatio('rgb(127.5, 127.5, 127.5)', '#ffffff'));
  assert.ok(palette.contrastRatio('#00000080', '#ffffff') < 4.5, 'half-transparent black on white is not body text');
  assert.ok(Number.isNaN(palette.contrastRatio('red', '#fff')));
  // Every builtin pack passes the frame's check in both modes.
  for (const p of PACKS) assert.equal(palette.checkTheme(p).ok, true, p.name);
});

// ── static ──────────────────────────────────────────────────────────────────
test('static: modules and stylesheets by name, fonts as woff2, nothing else', async (t) => {
  const { port } = await boot(t);
  const js = await req(port, { path: '/answer/answer.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(js.headers['content-security-policy'], EXACT_CSP);
  const css = await req(port, { path: '/answer/answer.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  const stop = await req(port, { path: '/answer/stop-frame.js' });
  assert.equal(stop.status, 200, 'a new module is served without an edit');
  assert.equal(stop.text, 'export const stop = 1;\n');
  for (const p of ['/answer/../x.js', '/answer/%2E%2E%2Fx.js', '/answer/A.js', '/answer/x.html', '/answer/index.html', '/answer/missing.js']) {
    assert.equal((await req(port, { path: p })).status, 404, p);
  }
  const font = await req(port, { path: '/answer/fonts/Geist-Variable.woff2' });
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.deepEqual(font.buf.subarray(0, 4), Buffer.from('wOF2', 'latin1'));
  for (const p of ['/answer/fonts/fonts.css', '/answer/fonts.css', '/fonts/fonts.css', '/answer/fonts/Geist-OFL.txt', '/answer/fonts/..%2F..%2Fpackage.json']) {
    assert.equal((await req(port, { path: p })).status, 404, p);
  }
});

// ── register ────────────────────────────────────────────────────────────────
test('register: a kind\'s document mints a nonce for its key, and the meta slot', async (t) => {
  const { s, port, origin } = await boot(t);
  const seen = [];
  const refused = [];
  let posted = null;
  const off = s.register('control', {
    document(rq, rs, kit, { rest, query }) {
      seen.push({ rest, query });
      const meta = query.meta ? { 'wc-control': 'Restore "src/a.js" <before> & \'after\'' } : undefined;
      return kit.document(rs, { key: `control:${rest}:${query.target}`, mode: query.mode, meta });
    },
    api(rq, rs, kit, { rest, body }) { posted = { rest, body }; return kit.json(rs, 200, { ok: true, rest }); },
    nonceKey(rq, { rest, query, body }) {
      if (rest === 'none') return null;
      return `control:${(body && body.action) || query.action}:${(body && body.target) || query.target}`;
    },
    onRefused(info) { refused.push(info); },
  });
  assert.equal(typeof off, 'function');

  const doc = await req(port, { path: '/answer/control/restore?target=t1&mode=dark&meta=1' });
  assert.equal(doc.status, 200);
  assert.equal(doc.headers['content-security-policy'], EXACT_CSP);
  assert.match(doc.text, /data-mode="dark" data-kind="control"/);
  assert.deepEqual(seen[0], { rest: 'restore', query: { target: 't1', mode: 'dark', meta: '1' } });
  const slot = metaSlot(doc);
  const tags = slot.match(/<meta [^>]*>/g);
  assert.equal(tags.length, 1);
  const m = /^<meta name="wc-control" content="([^"]*)">$/.exec(tags[0]);
  assert.ok(m, tags[0]);
  assert.doesNotMatch(m[1], /[<>"]/);
  const unescaped = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
  assert.equal(unescaped, 'Restore "src/a.js" <before> & \'after\'', 'the value round-trips');
  const plain = await req(port, { path: '/answer/control/restore?target=t1' });
  assert.equal(metaSlot(plain), '', 'no meta, an empty slot');
  assert.match(plain.text, /data-mode="light"/);

  const nonce = nonceOf(doc);
  const post = (n, body, extra = {}) => req(port, {
    method: 'POST', path: '/answer/api/control/run',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(n ? { 'x-wc-answer': n } : {}), ...extra },
    body,
  });
  const ok = await post(nonce, { action: 'restore', target: 't1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, rest: 'run' });
  assert.deepEqual(posted, { rest: 'run', body: { action: 'restore', target: 't1' } });
  posted = null;

  // Another target's key, the ask's nonce, no nonce, a foreign origin: refused
  // before the kind's api runs, and each one reaches onRefused.
  const askNonce = nonceOf(await askDoc(port));
  const cases = [
    [nonce, { action: 'restore', target: 't2' }, {}, 'nonce'],
    [askNonce, { action: 'restore', target: 't1' }, {}, 'nonce'],
    [null, { action: 'restore', target: 't1' }, {}, 'nonce'],
    [nonce, { action: 'restore', target: 't1' }, { origin: `http://localhost:${MAIN}` }, 'origin'],
    [nonce, { action: 'restore', target: 't1' }, { 'content-type': 'text/plain' }, 'type'],
  ];
  for (const [n, body, extra, code] of cases) {
    const before = refused.length;
    const r = await post(n, body, extra);
    assert.equal(r.status, 403, code);
    assert.deepEqual(r.json, { ok: false, refused: code });
    assert.equal(refused.length, before + 1);
    assert.equal(refused.at(-1).code, code);
  }
  assert.equal(posted, null, 'the kind\'s api never ran');

  // A read through the gate: GET with the nonce for the query's key.
  const get = await req(port, { path: '/answer/api/control/state?action=restore&target=t1', headers: { 'x-wc-answer': nonce } });
  assert.equal(get.status, 200);
  assert.equal((await req(port, { path: '/answer/api/control/state?action=restore&target=t1' })).status, 403);

  // nonceKey answering null → 403.
  const none = await req(port, {
    method: 'POST', path: '/answer/api/control/none',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': nonce },
    body: {},
  });
  assert.equal(none.status, 403);
  assert.deepEqual(none.json, { ok: false, refused: 'nonce' });

  // Unregistered: its routes are gone.
  off();
  assert.equal((await req(port, { path: '/answer/control/restore?target=t1' })).status, 404);
  assert.equal((await post(nonce, { action: 'restore', target: 't1' })).status, 404);
});

test('register: reserved, malformed and duplicate kinds throw', async (t) => {
  const { s } = await boot(t);
  const spec = { document() {}, api() {}, nonceKey() { return null; } };
  for (const k of ['ask', 'asks', 'api', 'fonts', 'Control', 'x', '1abc', 'a/b', '']) {
    assert.throws(() => s.register(k, spec), /kind/, k);
  }
  assert.throws(() => s.register('control', { document() {}, api() {} }), /nonceKey/);
  const off = s.register('control', spec);
  assert.throws(() => s.register('control', spec), /already registered/);
  off();
  s.register('control', spec)(); // registers again once the first is gone
});

// ── keep-alive and lifecycle ────────────────────────────────────────────────
test('keep-alive: a pending ask or a kind\'s keepAlive holds the listener; idle close after both stop', async (t) => {
  const asks = fakeAsks();
  const { s, port } = await boot(t, { asks, idleMs: 50 });
  let kindAlive = false;
  s.register('control', { document() {}, api() {}, nonceKey() { return null; }, keepAlive: () => kindAlive });
  asks.pendingCount = 1;
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(s.info(), { port }, 'up while an ask is pending');
  asks.pendingCount = 0;
  kindAlive = true;
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(s.info(), { port }, 'up while a kind keeps it');
  kindAlive = false;
  await waitUntil(() => s.info() === null, { timeout: 1000, what: 'the idle close' });
  assert.equal(s.port, null);
  assert.equal(s.origin, null);
  const again = await s.ensure();
  assert.notEqual(again.port, port, 'ensure() reopens on a new port');
  assert.deepEqual(s.info(), { port: again.port });
  assert.equal((await req(again.port, { path: '/answer/answer.css' })).status, 200);
});

test('every request re-arms the idle timer', async (t) => {
  const { s, port } = await boot(t, { idleMs: 150 });
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await req(port, { path: '/answer/answer.css' })).status, 200);
  }
  assert.deepEqual(s.info(), { port });
  await waitUntil(() => s.info() === null, { timeout: 2000, what: 'the idle close' });
});

test('remote: remoteAnswering() is false and an X-WC-Remote document or API request is refused', async (t) => {
  const { s, port, origin } = await boot(t);
  assert.equal(s.remoteAnswering(), false);
  const nonce = nonceOf(await askDoc(port));
  const doc = await req(port, { path: `/answer/ask/${ASK}?layout=card`, headers: { 'x-wc-remote': '1' } });
  assert.equal(doc.status, 403);
  assert.equal(doc.json.remote, true);
  const view = await req(port, { path: `/answer/api/asks/${ASK}?v=0`, headers: { 'x-wc-remote': '1', 'x-wc-answer': nonce } });
  assert.equal(view.status, 403);
  const decide = await decideReq(port, origin, nonce, { headers: { 'x-wc-remote': '1' } });
  assert.equal(decide.status, 403);
});

test('frame-ancestors follows the main port, and is none while it is unknown', async (t) => {
  const asks = fakeAsks();
  asks.put(ASK, 1);
  let main = null;
  const s = createAnswerSurface({ asks, mainPort: () => main, publicDir: PUB, fontsDir: FONTS });
  t.after(async () => { await s.close(); asks.stop(); });
  const { port } = await s.ensure();
  assert.match((await askDoc(port)).headers['content-security-policy'], /frame-ancestors 'none'$/);
  main = 6001;
  assert.match((await askDoc(port)).headers['content-security-policy'], /frame-ancestors http:\/\/localhost:6001 http:\/\/127\.0\.0\.1:6001$/);
});

test('info() is null before ensure() and after close()', async (t) => {
  const asks = fakeAsks();
  const s = createAnswerSurface({ asks, mainPort: () => MAIN, publicDir: PUB, fontsDir: FONTS });
  t.after(() => s.close());
  assert.equal(s.info(), null);
  const { port, origin } = await s.ensure();
  assert.deepEqual(s.info(), { port });
  assert.equal(s.origin, origin);
  await s.close();
  assert.equal(s.info(), null);
});
