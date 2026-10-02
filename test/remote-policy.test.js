// The remote route policy (lib/core/remote-policy.js) — the table the tunnel
// portal consults before proxying a remote request to a loopback daemon.
//
// Two halves:
//
//   1. THE RATCHET. Every `app.<verb>(` in lib/server/routes/ (and
//      lib/server/index.js) must be named by an explicit rule — allow or refuse,
//      but decided on purpose. The table is default-deny, so an unclassified
//      route is not an exposure; it is a feature that silently does not work
//      remotely, found by a user at a coffee shop instead of by this test. When
//      this fails because you added a route: add a row to RULES, and think about
//      whether a REMOTE, allowlisted viewer should be able to call it (read the
//      header of remote-policy.js — the daemon cannot tell them apart from the
//      developer).
//
//   2. THE VERDICTS that matter: every pack write, the turn internals, shutdown,
//      format=file, captures and the extensions are refused; the surface the SPA
//      needs is allowed; and the path forms Express and the table could read
//      differently are refused rather than guessed at.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { classify, refusalBody, RULES } = require('../lib/core/remote-policy');

const REPO_ROOT = path.resolve(__dirname, '..');

// Every route the daemon mounts, as {method, path, file}. `app.use('/x', …)`
// with a path mounts every method; a `${…}` template segment stands for one
// value. Scans the source like test/conventions.test.js does, so it cannot be
// fooled by a route mounted conditionally at runtime.
function daemonRoutes() {
  const files = fs.readdirSync(path.join(REPO_ROOT, 'lib/server/routes'))
    .filter((f) => f.endsWith('.js')).map((f) => `lib/server/routes/${f}`);
  files.push('lib/server/index.js');
  const out = [];
  const re = /\bapp\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]*)\2/g;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const m of src.matchAll(re)) {
      const verb = m[1];
      out.push({ method: verb === 'use' || verb === 'all' ? '*' : verb.toUpperCase(), path: m[3], file: rel });
    }
  }
  return out;
}

// A concrete request target for a route pattern.
function sample(p) {
  return p.replace(/\$\{[^}]*\}/g, 'sample').replace(/:[A-Za-z_]+/g, 'sample1');
}

test('ratchet: the route scan is live (it found the daemon\'s routes)', () => {
  const routes = daemonRoutes();
  assert.ok(routes.length >= 60, `found only ${routes.length} routes — the scan regex has drifted from the code`);
  assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/packs/install'));
  assert.ok(routes.some((r) => r.method === '*' && r.path.startsWith('/extensions/')), 'app.use mounts are scanned');
});

test('ratchet: every daemon route is classified by an explicit rule (none falls to the default deny)', () => {
  const missing = [];
  for (const r of daemonRoutes()) {
    const methods = r.method === '*' ? ['GET', 'POST', 'DELETE'] : [r.method];
    for (const m of methods) {
      const v = classify(m, sample(r.path));
      if (v.key === null) missing.push(`${m} ${r.path}   (${r.file})`);
    }
  }
  assert.deepEqual(missing, [],
    'these daemon routes have no row in lib/core/remote-policy.js RULES. Add one — allow or refuse — '
    + 'and decide on purpose whether an allowlisted REMOTE viewer (through the tunnel portal) may call it:\n  '
    + missing.join('\n  '));
});

test('ratchet: the SPA\'s every static file is reachable remotely', () => {
  const pub = path.join(REPO_ROOT, 'public');
  const refused = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      const url = '/' + path.relative(pub, abs).split(path.sep).join('/');
      if (url.endsWith('.txt')) continue; // font licence text — not something the page loads
      if (!classify('GET', url).allow) refused.push(url);
    }
  };
  walk(pub);
  assert.deepEqual(refused, [], 'a new top-level file in public/ needs a static row, or the remote SPA breaks');
  assert.equal(classify('GET', '/').allow, true);
  assert.equal(classify('GET', '/ws').allow, true, 'the live surface socket');
});

test('ratchet: every rule is well-formed (methods, path, and a hint on every refusal)', () => {
  const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  for (const r of RULES) {
    assert.ok(r.methods === '*' || (Array.isArray(r.methods) && r.methods.every((m) => METHODS.has(m))), JSON.stringify(r));
    assert.match(r.path, /^\/[a-z0-9/:*._-]*$/, `lowercase literal path: ${r.path}`);
    if (r.path.includes('*')) assert.ok(r.path.endsWith('/*'), `* only as the final segment: ${r.path}`);
    if (!r.allow || r.destructive) assert.ok(r.hint, `a refusal says what to do instead: ${r.path}`);
    if ('note' in r) assert.ok(typeof r.note === 'string' && r.note, `a note is prose: ${r.path}`);
  }
});

test('verdicts: remote-access setup is refused remotely, and the hint names where to do it', () => {
  for (const [m, u] of [['GET', '/tunnel/setup'], ['POST', '/setup/tunnel/apply'], ['GET', '/setup/tunnel']]) {
    const v = classify(m, u);
    assert.equal(v.allow, false, `${m} ${u}`);
    assert.equal(v.reason, 'refused', `${m} ${u} is refused by a row, not by the default deny`);
    assert.match(v.hint, /host/);
    assert.match(v.hint, /tunnel setup/);
  }
});

test('verdicts: the machine-wide sessions feed is refused with the ls hint; pane spawn carries its body-level note', () => {
  const v = classify('GET', '/api/machine/sessions');
  assert.equal(v.reason, 'refused');
  assert.match(v.hint, /claude-web-chat ls/);
  const spawn = RULES.find((r) => r.path === '/api/pane/spawn');
  assert.ok(spawn && spawn.allow, 'the path is allowed');
  assert.match(spawn.note, /html/, 'the raw-html refusal is recorded on the row (the route enforces it)');
  assert.match(classify('POST', '/api/markdown').hint, /harness/);
});

// ── verdicts ────────────────────────────────────────────────────────────────

const ALLOWED = [
  ['GET', '/'], ['GET', '/index.html'], ['GET', '/app.css'], ['GET', '/app/main.js'],
  ['GET', '/fonts/Geist-Variable.woff2'], ['GET', '/mount-runtime.js'], ['GET', '/brand/logo.png'],
  ['HEAD', '/app/main.js'],
  ['GET', '/ws'],
  ['GET', '/api/graph'], ['GET', '/api/graph/node/abc'], ['GET', '/api/graph/diff?a=1&b=2'],
  ['GET', '/preview/node/abc'],
  ['POST', '/api/graph/active'], ['POST', '/api/graph/bookmark'],
  ['GET', '/api/store'], ['POST', '/api/store'], ['GET', '/api/mounts'], ['POST', '/api/clear'],
  ['GET', '/api/comments'], ['POST', '/api/comments'], ['PATCH', '/api/comments/c1'],
  ['POST', '/api/comments/c1/reply'], ['DELETE', '/api/comments/c1'],
  ['GET', '/api/queue'], ['GET', '/api/queue/policy'], ['POST', '/api/queue/push'], ['POST', '/api/queue/repush'],
  ['GET', '/api/queue/pending'], ['POST', '/api/queue/pending/consume'], ['PATCH', '/api/queue/q1'],
  ['DELETE', '/api/queue/q1'],
  ['GET', '/api/theme?scope=global'], ['GET', '/api/themes'], ['POST', '/api/theme/apply'],
  ['GET', '/api/components'], ['GET', '/api/components/git-dashboard'], ['GET', '/api/components/x/seed'],
  ['POST', '/api/components/git-dashboard/use'],
  ['GET', '/api/services/pending'], ['GET', '/api/services/pack/acme-ops'],
  ['GET', '/api/version'], ['GET', '/api/health'], ['GET', '/api/embed-check?url=x'],
  ['GET', '/api/export/n1.4'], ['GET', '/api/export/active?format=html'],
  ['GET', '/api/packs'], ['GET', '/api/packs/audit'], ['GET', '/api/packs/quarantine/p/review?file=a'],
  ['GET', '/replay'], ['GET', '/api/replay/n1'],
  ['GET', '/api/brand'], ['GET', '/preview/pane/n1/m1'],
  ['GET', '/api/mounts/m1/history'], ['POST', '/api/mounts/m1/restore'],
  ['POST', '/api/page/reset-layout'], ['POST', '/api/page/run'], ['POST', '/api/page/move'],
  ['POST', '/api/pane/spawn'], ['POST', '/api/pane/close'],
];

const REFUSED = [
  // every pack write
  ['POST', '/api/packs/install'], ['POST', '/api/packs/quarantine'], ['POST', '/api/packs/quarantine/p/approve'],
  ['DELETE', '/api/packs/quarantine/p'], ['DELETE', '/api/packs/p'], ['POST', '/api/packs/announce'],
  // components / services / brand
  ['POST', '/api/components'], ['POST', '/api/services/refresh-trust'], ['POST', '/api/services/pack/acme-ops'],
  ['POST', '/api/brand/logo'],
  ['DELETE', '/api/brand/logo'], ['PUT', '/api/brand/logo'], ['POST', '/api/theme'], ['POST', '/api/themes'],
  // Claude's markdown write path, and the machine-wide sessions feed
  ['POST', '/api/markdown'], ['GET', '/api/machine/sessions'], ['GET', '/api/machine/anything'],
  // turn / hook / channel internals and the event log
  ['POST', '/api/turn-begin'], ['POST', '/api/turn-end'], ['POST', '/api/commit'], ['POST', '/api/unlock'],
  ['POST', '/api/wait'], ['POST', '/api/render'], ['POST', '/api/channel/heartbeat'], ['POST', '/api/channel/ack'],
  ['GET', '/api/events'], ['GET', '/api/events/stream'],
  // host process / disk
  ['POST', '/api/shutdown'], ['GET', '/api/export/n1?format=file'], ['POST', '/api/profiles/reload'],
  ['POST', '/api/replay/render'],
  // remote-access setup: the daemon's launcher, and the setup page's own routes
  ['GET', '/tunnel/setup'], ['GET', '/setup/tunnel'], ['POST', '/setup/tunnel/plan'], ['POST', '/setup/tunnel/apply'],
  ['POST', '/setup/tunnel/up'], ['POST', '/setup/tunnel/status'],
  // captures and the extensions
  ['POST', '/api/capture'], ['GET', '/api/captures'], ['GET', '/api/captures/c1/raw'],
  ['GET', '/api/captures/c1/simplified'], ['GET', '/api/profile-match?url=x'], ['GET', '/api/profiles'],
  ['GET', '/extensions'], ['GET', '/extensions/tab-stream/download'], ['GET', '/extensions/tab-stream/files/x.js'],
  ['GET', '/embed-helper'], ['GET', '/embed-helper/files/x.js'],
  // destructive, by default
  ['POST', '/api/graph/wipe'], ['POST', '/api/graph/new'],
  // unknown
  ['GET', '/favicon.ico'], ['GET', '/api/nope'], ['DELETE', '/api/store'], ['PUT', '/api/graph/active'],
  ['OPTIONS', '/api/store'],
];

test('verdicts: the surface the SPA needs is allowed', () => {
  const wrong = ALLOWED.filter(([m, u]) => !classify(m, u).allow).map((x) => x.join(' '));
  assert.deepEqual(wrong, []);
});

test('verdicts: host-only routes are refused, with a hint and remote:true', () => {
  const wrong = REFUSED.filter(([m, u]) => classify(m, u).allow).map((x) => x.join(' '));
  assert.deepEqual(wrong, []);
  const v = classify('POST', '/api/packs/install');
  assert.equal(v.reason, 'refused');
  assert.deepEqual(refusalBody(v), { ok: false, remote: true, hint: v.hint });
  assert.match(v.hint, /run on the host: claude-web-chat pack/);
  assert.match(classify('POST', '/api/shutdown').hint, /claude-web-chat stop/);
  assert.match(classify('GET', '/api/export/n1?format=file').hint, /claude-web-chat export/);
  assert.equal(classify('GET', '/nope').reason, 'unknown');
});

test('verdicts: format=file is refused however the query spells it', () => {
  for (const q of ['format=file', 'x=1&format=file', 'format=FILE', 'format[]=file', 'format%5B0%5D=file',
    'format=html&format=file']) {
    const v = classify('GET', `/api/export/n1?${q}`);
    assert.equal(v.allow, false, q);
    assert.equal(v.reason, 'query', q);
  }
});

test('verdicts: a wipe is allowed only when the operator opted into remote.allowDestructive', () => {
  assert.equal(classify('POST', '/api/graph/wipe').reason, 'destructive');
  assert.equal(classify('POST', '/api/graph/wipe', { allowDestructive: true }).allow, true);
  // A new graph takes more than a wipe (pinned panes, markdown, active): the
  // same opt-in, the same hint.
  assert.equal(classify('POST', '/api/graph/new').reason, 'destructive');
  assert.equal(classify('POST', '/api/graph/new').hint, classify('POST', '/api/graph/wipe').hint);
  assert.match(classify('POST', '/api/graph/new').hint, /remote\.allowDestructive/);
  assert.equal(classify('POST', '/api/graph/new', { allowDestructive: true }).allow, true);
  // A bulk clear is as destructive, but the path is shared with closing one
  // pane, so the rule is the route's (test/remote-clear.test.js) and the row
  // records it.
  const clear = RULES.find((r) => r.path === '/api/clear');
  assert.ok(clear && clear.allow && !clear.destructive, 'the path stays allowed: the × closes one pane by id');
  assert.match(clear.note, /no `id`/);
  // The opt-in widens exactly that one rule.
  assert.equal(classify('POST', '/api/packs/install', { allowDestructive: true }).allow, false);
  assert.equal(classify('POST', '/api/shutdown', { allowDestructive: true }).allow, false);
});

test('matching mirrors Express: case-insensitive, one trailing slash, HEAD is GET', () => {
  // Express would route every one of these to the pack installer.
  for (const u of ['/API/PACKS/INSTALL', '/api/packs/install/', '/Api/Packs/Install/']) {
    assert.equal(classify('POST', u).allow, false, u);
    assert.equal(classify('POST', u).reason, 'refused', u);
  }
  assert.equal(classify('post', '/api/store').allow, true, 'method case');
  assert.equal(classify('HEAD', '/api/graph').allow, true);
  assert.equal(classify('GET', '/api/graph/').allow, true);
});

test('paths Express and the table could read differently are refused, not guessed at', () => {
  for (const u of [
    '/app/../api/packs/install', '/app/%2e%2e/api/packs/install', '/app/%2E%2E/api/shutdown',
    '/app/./main.js', '/api//store', '/app%2fmain.js', '/api/packs%2Finstall', '/app\\main.js',
    '/app/%5cmain.js', '/api/store%00', '/app/%zz', '/api/store\n', '', 'api/store', null, undefined,
    'http://evil/api/store',
  ]) {
    const v = classify('GET', u);
    assert.equal(v.allow, false, String(u));
    assert.equal(v.reason, 'malformed', String(u));
  }
  // A percent-encoded ordinary character is just that character.
  assert.equal(classify('GET', '/app/m%61in.js').allow, true);
  assert.equal(classify('POST', '/api/p%61cks/install').allow, false);
});
