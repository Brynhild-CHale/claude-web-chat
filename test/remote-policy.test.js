// The remote route policy (lib/core/remote-policy.js) — the table the tunnel
// portal consults before proxying a remote request to a loopback daemon.
//
// Three parts:
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
//
//   3. THE CHAT MIRROR (0.8.5, spec §5.3): every row of the release is in the
//      table already, routes that land in later units included, each at the
//      level its row names; a portal still on the protocol-8 table refuses them
//      all; and the daemon's two data tables — FRAME_RULES (which `mirror:*`
//      frames a socket gets, and the typed `basic` projection) and TEXT_RULES
//      (the conversation text a viewer below `read` must not get) — are pinned
//      to the code that sends those frames and bodies. TEXT_RULES is also
//      proved by a probe: a daemon holding marked prompts, summaries and
//      replies serves none of them, once each entry is stripped, from any
//      route the table lets a `basic` viewer GET — save the replay documents,
//      the one carrier still waiting on the maintainer's decision.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classify, classifier, keyOf, refusalBody, RULES,
  MIRROR_HINT, MIRROR_FULL_HINT, MIRROR_LEVELS, rankLevel, atLeast, fromOptIn,
  FRAME_RULES, projectFrame, projectValue,
  STATUS_SCHEMA, STATUS_ROW_SCHEMA, ASK_SCHEMA, ASK_FRAME_SCHEMA, RESET_SCHEMA,
  TEXT_RULES, stripText,
} = require('../lib/core/remote-policy');
const { withServer } = require('../test-support/helpers');

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
  ['GET', '/api/services/pending'], ['GET', '/api/version'], ['GET', '/api/health'], ['GET', '/api/embed-check?url=x'],
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
  ['POST', '/api/components'], ['POST', '/api/services/refresh-trust'], ['POST', '/api/brand/logo'],
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

// ── the chat mirror (0.8.5) ─────────────────────────────────────────────────

// The spec's own words (§5.3), as literals: a test that read them back from the
// module would only prove the module agrees with itself.
const SPEC_HOST_ONLY = 'this is the Claude Code harness\'s endpoint — it is driven from the host, never from a browser';
const SPEC_MIRROR_HINT = 'the conversation is not shared with remote viewers of this project — on the host: claude-web-chat tunnel mirror on';
const SPEC_MIRROR_FULL_HINT = 'this needs full mirror access — on the host: claude-web-chat tunnel mirror on (without --read-only)';
const SPEC_IDENTITY_HINT = 'the project identity is set on the host: claude-web-chat identity';

// Every row the release adds — spec §5.3's block, as it is written there.
const SPEC_ROWS = [
  { methods: '*', path: '/api/hooks/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: ['GET'], path: '/api/mirror/access', allow: true, mirror: 'basic', hint: SPEC_MIRROR_HINT },
  { methods: ['GET'], path: '/api/mirror/status', allow: true, mirror: 'basic', hint: SPEC_MIRROR_HINT },
  { methods: ['GET'], path: '/api/mirror', allow: true, mirror: 'basic', hint: SPEC_MIRROR_HINT, note: 'route-level: below read the body is status rows only' },
  { methods: ['GET'], path: '/api/mirror/*', allow: true, mirror: 'read', hint: SPEC_MIRROR_HINT },
  { methods: '*', path: '/api/mirror/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: ['GET'], path: '/api/asks', allow: true, mirror: 'basic', hint: SPEC_MIRROR_HINT, note: 'route-level: below read, the typed projection' },
  { methods: '*', path: '/api/asks/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: ['POST'], path: '/api/queue/message', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: ['POST'], path: '/api/queue/task-stop', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: ['GET'], path: '/api/files', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: ['GET'], path: '/api/skills', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: ['GET'], path: '/api/project', allow: true },
  { methods: ['GET'], path: '/project/*', allow: true },
  { methods: '*', path: '/api/project/*', allow: false, hint: SPEC_IDENTITY_HINT },
  { methods: ['GET'], path: '/favicon.png', allow: true },
  { methods: ['GET'], path: '/favicon-dark.png', allow: true },
  { methods: ['GET'], path: '/apple-touch-icon.png', allow: true },
  { methods: ['GET'], path: '/api/code/preview', allow: true, mirror: 'read', hint: SPEC_MIRROR_HINT },
  { methods: '*', path: '/api/code/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: '*', path: '/api/control/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: '*', path: '/api/bridge/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: ['POST'], path: '/api/attachments', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
];

// Every route of the release (the spec's route table, Architecture → "The wire
// at a glance", and §§2.10, 4.3, 6.2-6.3, 9.3, 9.7, 15.3, 15.7), with a sample
// request and the least opt-in that lets it through: 'basic' (every remote
// viewer), 'read', 'full', 'open' (no mirror level — the surface's own), or
// 'refused' (a row refuses it at every level). Most of these routes land in
// later units; their rows are here now, so this is the release's ratchet ahead
// of the route-literal scan above.
const ROUTES_085 = [
  // the hook intake and the turn routes (§1.4, §3.1)
  ['POST', '/api/hooks/event', 'refused'], ['POST', '/api/turn-begin', 'refused'], ['POST', '/api/turn-end', 'refused'],
  // the graph, whose text TEXT_RULES strips below read
  ['GET', '/api/graph', 'open'], ['GET', '/api/graph/node/n1', 'open'],
  // the channel (§5.7)
  ['POST', '/api/channel/heartbeat', 'refused'], ['POST', '/api/channel/ack', 'refused'],
  // state (§2.10)
  ['GET', '/api/mirror', 'basic'], ['GET', '/api/mirror?since=1700000000000', 'basic'],
  ['GET', '/api/mirror/status', 'basic'], ['GET', '/api/mirror/access', 'basic'],
  // the project's identity (§9.3) and the favicons (§9.7)
  ['GET', '/api/project', 'open'], ['GET', '/project/logo?mode=dark', 'open'], ['GET', '/project/mark?mode=light&v=3', 'open'],
  ['PUT', '/api/project/name', 'refused'], ['DELETE', '/api/project/name', 'refused'], ['PUT', '/api/project/show-name', 'refused'],
  ['PUT', '/api/project/logo', 'refused'], ['DELETE', '/api/project/logo', 'refused'],
  ['PUT', '/api/project/logo-dark', 'refused'], ['DELETE', '/api/project/logo-dark', 'refused'],
  ['PUT', '/api/project/favicon', 'refused'], ['DELETE', '/api/project/favicon', 'refused'],
  ['PUT', '/api/project/favicon-dark', 'refused'], ['DELETE', '/api/project/favicon-dark', 'refused'],
  ['GET', '/project/touch-icon?v=2', 'open'], ['PUT', '/api/project/touch-icon', 'refused'], ['DELETE', '/api/project/touch-icon', 'refused'],
  ['GET', '/favicon.png', 'open'], ['GET', '/favicon-dark.png', 'open'], ['GET', '/apple-touch-icon.png', 'open'],
  // content (§2.10, tranche 2)
  ['GET', '/api/mirror/conversations/c1/turns?before=4&limit=20&items=summary', 'read'], ['GET', '/api/mirror/turns/t1', 'read'],
  ['GET', '/api/mirror/items/i1?field=result&from=0&max=262144', 'read'], ['GET', '/api/mirror/items/i1/attachments/0', 'read'],
  // work and code (§2.10, tranche 3)
  ['GET', '/api/mirror/tasks', 'read'], ['GET', '/api/mirror/tasks/bdz1n2/output?tail=4096', 'read'],
  ['GET', '/api/mirror/agents/a1?before=3&limit=5', 'read'], ['GET', '/api/mirror/workflows/w1', 'read'],
  ['GET', '/api/mirror/diff?turn=t1', 'read'], ['GET', '/api/mirror/diff?node=n1.2&context=3', 'read'],
  ['GET', '/api/mirror/node/n1.2', 'read'], ['GET', '/api/mirror/node/live', 'read'], ['GET', '/api/mirror/nodes', 'read'],
  // asks (§4.3): the hook's routes, and the chrome's read
  ['POST', '/api/asks', 'refused'], ['GET', '/api/asks/ask_0123456789ab/decision?wait=25000', 'refused'],
  ['POST', '/api/asks/ask_0123456789ab/withdraw', 'refused'], ['POST', '/api/asks/ask_0123456789ab/handed', 'refused'],
  ['GET', '/api/asks', 'basic'],
  // the composer (§6.3); the queue's other writes check the level in the route
  ['POST', '/api/queue/message', 'full'], ['POST', '/api/queue/task-stop', 'full'],
  ['PATCH', '/api/queue/q1', 'open'], ['DELETE', '/api/queue/q1', 'open'], ['POST', '/api/queue/push', 'open'],
  ['POST', '/api/queue/pending/recall', 'open'], ['GET', '/api/queue/pending?pid=4242', 'open'],
  ['GET', '/api/files?q=bus&limit=20', 'full'], ['GET', '/api/skills?conversation=c1', 'full'],
  // the control layer (§15.3) and the mod (§15.7)
  ['GET', '/api/code/preview?turn=t1&point=before', 'read'], ['GET', '/api/code/preview?node=n1.2&point=after', 'read'],
  ['POST', '/api/code/restore', 'refused'], ['POST', '/api/control/notices/claim', 'refused'],
  ['POST', '/api/bridge/hello', 'refused'], ['GET', '/api/bridge/ops?wait=20000', 'refused'],
  ['POST', '/api/bridge/result', 'refused'], ['POST', '/api/bridge/events', 'refused'],
  ['POST', '/api/attachments', 'full'],
];
const OPT_INS = ['off', 'read', 'full'];

test('mirror: every row of the 0.8.5 block is in RULES, exactly as the spec writes it', () => {
  assert.equal(MIRROR_HINT, SPEC_MIRROR_HINT);
  assert.equal(MIRROR_FULL_HINT, SPEC_MIRROR_FULL_HINT);
  const byKey = new Map(RULES.map((r) => [keyOf(r), r]));
  assert.equal(byKey.size, RULES.length, 'two rows share a key — first match wins, so one of them is dead');
  for (const want of SPEC_ROWS) {
    const got = byKey.get(keyOf(want));
    assert.ok(got, `no row ${keyOf(want)}`);
    assert.deepStrictEqual(got, want, keyOf(want));
  }
});

test('mirror: every 0.8.5 route is decided by a row, at the level the spec names', () => {
  const wrong = [];
  for (const [m, u, need] of ROUTES_085) {
    for (const optIn of OPT_INS) {
      const v = classify(m, u, { mirror: optIn });
      const say = (what) => wrong.push(`${m} ${u} at ${optIn}: ${what} — ${JSON.stringify(v)}`);
      if (v.key === null) { say('no row (the default deny)'); continue; }
      if (need === 'refused') { if (v.allow || v.reason !== 'refused') say('should be refused by its row'); continue; }
      if (need === 'open') { if (!v.allow) say('should be allowed at every level'); continue; }
      const ok = atLeast(fromOptIn(optIn), need);
      if (ok && !v.allow) say(`should be allowed (it needs ${need})`);
      if (!ok && (v.allow || v.reason !== 'mirror')) say(`should be refused for the mirror level (it needs ${need})`);
    }
  }
  assert.deepStrictEqual(wrong, []);
  // The answer origin is its own listener (§4.4), never this table's: through
  // the session's hostname it is unknown.
  assert.equal(classify('GET', '/answer/ask/ask_0123456789ab?layout=bar', { mirror: 'full' }).reason, 'unknown');
});

test('mirror: a refusal names the host command — the mirror hint, the full hint, the identity hint, host-only', () => {
  const read = classify('GET', '/api/mirror/turns/t1');
  assert.equal(read.reason, 'mirror');
  assert.equal(read.hint, SPEC_MIRROR_HINT);
  assert.equal(read.level, 'basic');
  assert.equal(read.need, 'read');
  assert.equal(read.key, 'GET /api/mirror/*');
  assert.deepStrictEqual(refusalBody(read), { ok: false, remote: true, hint: SPEC_MIRROR_HINT, mirror: 'basic' },
    'the 403 says which level the viewer has, as the daemon\'s own gate does');
  const full = classify('POST', '/api/queue/message', { mirror: 'read' });
  assert.equal(full.reason, 'mirror');
  assert.equal(full.hint, SPEC_MIRROR_FULL_HINT);
  assert.deepStrictEqual(refusalBody(full), { ok: false, remote: true, hint: SPEC_MIRROR_FULL_HINT, mirror: 'read' });
  assert.equal(classify('PUT', '/api/project/logo', { mirror: 'full' }).hint, SPEC_IDENTITY_HINT);
  for (const [m, u] of [['POST', '/api/hooks/event'], ['POST', '/api/asks'], ['POST', '/api/control/notices/claim'],
    ['POST', '/api/bridge/hello'], ['POST', '/api/code/restore'], ['POST', '/api/mirror/turns/t1'], ['POST', '/api/mirror']]) {
    const v = classify(m, u, { mirror: 'full' });
    assert.equal(v.reason, 'refused', `${m} ${u}`);
    assert.equal(v.hint, SPEC_HOST_ONLY, `${m} ${u}`);
    assert.deepStrictEqual(refusalBody(v), { ok: false, remote: true, hint: SPEC_HOST_ONLY }, 'no level on a plain refusal');
  }
});

test('ratchet: every mirror row is well-formed (a level, a hint naming the command, only on an allow)', () => {
  let n = 0;
  for (const r of RULES) {
    if (!('mirror' in r)) continue;
    n += 1;
    assert.ok(['basic', 'read', 'full'].includes(r.mirror), `mirror is basic|read|full: ${keyOf(r)}`);
    assert.equal(r.allow, true, `mirror only on an allow:true row (a refusal needs no level): ${keyOf(r)}`);
    assert.ok(typeof r.hint === 'string' && r.hint, `a mirror row says how to raise the level: ${keyOf(r)}`);
    assert.match(r.hint, /claude-web-chat tunnel mirror on/, `the hint names the host command: ${keyOf(r)}`);
  }
  assert.ok(n >= 11, `only ${n} mirror rows`);
});

test('mirror: classify reads the opt-in — off, read, full; anything else is basic; no other row cares', () => {
  assert.deepStrictEqual([...MIRROR_LEVELS], ['basic', 'read', 'full', 'local']);
  assert.ok(Object.isFrozen(MIRROR_LEVELS));
  for (const [optIn, level] of [['off', 'basic'], ['read', 'read'], ['full', 'full'], [undefined, 'basic'], [null, 'basic'],
    ['basic', 'basic'], ['local', 'basic'], ['FULL', 'basic'], ['on', 'basic'], [true, 'basic']]) {
    assert.equal(fromOptIn(optIn), level, String(optIn));
  }
  // Spec §5.4 gives the name remoteLevel() to the audience gate, where it
  // answers the opt-in ('off' | 'read' | 'full'); the opt-in → level mapping is
  // fromOptIn. One name, one meaning, so this module never exports the other.
  assert.equal(require('../lib/core/remote-policy').remoteLevel, undefined);
  assert.equal(atLeast('full', 'read'), true);
  assert.equal(atLeast('read', 'full'), false);
  assert.equal(atLeast('local', 'full'), true);
  assert.equal(atLeast('nonsense', 'basic'), false, 'an unknown level meets nothing');
  assert.equal(atLeast('full', 'nonsense'), false, 'nor does anything meet an unknown need');
  assert.equal(rankLevel('local'), 3);
  assert.equal(rankLevel('x'), -1);
  // Absent is off; the portal never grants local.
  assert.equal(classify('GET', '/api/mirror/tasks').reason, 'mirror');
  assert.equal(classify('GET', '/api/mirror/tasks', {}).reason, 'mirror');
  assert.equal(classify('GET', '/api/mirror/tasks', { mirror: 'local' }).reason, 'mirror');
  // A basic row is met by any opt-in at all.
  for (const o of [undefined, 'off', 'read', 'full', 'bogus']) assert.equal(classify('GET', '/api/mirror/status', { mirror: o }).allow, true, String(o));
  // The opt-in widens mirror rows and nothing else.
  for (const o of OPT_INS) {
    assert.equal(classify('POST', '/api/packs/install', { mirror: o }).reason, 'refused', o);
    assert.equal(classify('POST', '/api/graph/wipe', { mirror: o }).reason, 'destructive', o);
    assert.equal(classify('GET', '/api/export/n1?format=file', { mirror: o }).reason, 'query', o);
    assert.equal(classify('GET', '/api/graph', { mirror: o }).allow, true, o);
  }
  // Matching is Express's for a mirror row too.
  assert.equal(classify('HEAD', '/api/mirror/tasks', { mirror: 'read' }).allow, true);
  assert.equal(classify('GET', '/API/Mirror/Tasks/', { mirror: 'off' }).reason, 'mirror');
  assert.equal(classify('GET', '/api/mirror/%2e%2e/graph', { mirror: 'full' }).reason, 'malformed');
});

function digest(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

test('mirror: a portal still on the protocol-8 table refuses every new route by the default deny (a rollback fails safe)', () => {
  const added = new Set(SPEC_ROWS.map(keyOf));
  const older = RULES.filter((r) => !added.has(keyOf(r)));
  // That is protocol 8's table, byte for byte (`wc085/int` before this unit):
  // the release added rows and changed none, so an older portal enforces
  // exactly this.
  assert.equal(older.length, 76);
  assert.equal(digest(older), 'd5878f2b94237a22',
    'a row a protocol-8 portal also has has changed — that is a portal protocol change: bump PORTAL_PROTOCOL_VERSION (lib/core/versions) and update this pin');
  const old = classifier(older);
  let checked = 0;
  const letThrough = new Set();
  for (const [m, u] of ROUTES_085) {
    if (!added.has(classify(m, u, { mirror: 'full' }).key)) continue; // decided by a row protocol 8 already has
    checked += 1;
    for (const optIn of [undefined, ...OPT_INS]) {
      const v = old(m, u, { mirror: optIn });
      if (v.allow) letThrough.add(`${m} ${u} → ${v.key}`);
      else assert.equal(v.reason, 'unknown', `${m} ${u}: refused by the default deny, with no row of its own`);
    }
  }
  assert.ok(checked >= 45, `only ${checked} new routes checked`);
  // The one exception, deliberate: protocol 8's `/api/queue/*` lets the two
  // queue writes through, and the daemon's own level check (requireMirror
  // 'full', spec §5.4) refuses them below full — a rolled-back portal over a
  // 0.8.5 daemon still sends no message for a viewer without the opt-in.
  assert.deepStrictEqual([...letThrough].sort(), [
    'POST /api/queue/message → * /api/queue/*',
    'POST /api/queue/task-stop → * /api/queue/*',
  ]);
});

// ── frames ────────────────────────────────────────────────────────────────

const SERVER_DIR = path.join(REPO_ROOT, 'lib/server');

function serverFiles(dir = SERVER_DIR) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...serverFiles(abs));
    else if (ent.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

const FRAME_TYPE_RE = /\btype\s*:\s*(['"`])(mirror:[^'"`]*)\1/g;

test('ratchet: every `type: \'mirror:<x>\'` sent under lib/server/ has a FRAME_RULES row', () => {
  // The scan is live: each quote style is found, and an interpolated type is
  // read as itself (so it matches no row — frame types are literals).
  assert.deepStrictEqual([...'{ type: \'mirror:a\' } {type:"mirror:b"} { type: `mirror:c` } { type: `mirror:${k}` }'
    .matchAll(FRAME_TYPE_RE)].map((m) => m[2]), ['mirror:a', 'mirror:b', 'mirror:c', 'mirror:${k}']);
  const known = new Set(FRAME_RULES.map((r) => r.type));
  const missing = [];
  for (const file of serverFiles()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(FRAME_TYPE_RE)) {
      if (!known.has(m[2])) missing.push(`${m[2]}   (${path.relative(REPO_ROOT, file)})`);
    }
  }
  assert.deepStrictEqual(missing, [],
    'a mirror frame with no FRAME_RULES row reaches local sockets only (projectFrame default-denies it). Add a row to '
    + 'FRAME_RULES in lib/core/remote-policy.js — its least level, and a typed `basic` schema if a basic viewer gets it');
});

test('FRAME_RULES: the spec\'s table; one row a type; the schemas exported by name; frozen all the way down', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(FRAME_RULES)), [
    { type: 'mirror:status', level: 'basic', basic: { rev: 'number', now: 'number', aggregate: { state: 'word' },
      conversations: { rows: { id: 'id', state: 'word', since: 'number', quiet: 'boolean', step_kind: 'word',
        waiting_kind: 'word', last_activity_at: 'number', ended_reason: 'word', counts: 'counts' } } } },
    { type: 'mirror:reset', level: 'basic', basic: { reason: 'word', conversation_id: 'id' } },
    { type: 'mirror:access', level: 'basic' },
    { type: 'mirror:ask', level: 'basic', basic: { op: 'word', ask: { id: 'id', conversation_id: 'id', kind: 'word', tool_kind: 'word', state: 'word' } } },
    { type: 'mirror:update', level: 'read' },
    { type: 'mirror:stream', level: 'read', posture: 'full' },
  ]);
  const types = FRAME_RULES.map((r) => r.type);
  assert.equal(new Set(types).size, types.length);
  // Exported by name — the same objects the frames use, so an HTTP body
  // projected with them cannot drift from the socket's.
  const rule = (t) => FRAME_RULES.find((r) => r.type === t);
  assert.equal(rule('mirror:status').basic, STATUS_SCHEMA);
  assert.equal(STATUS_SCHEMA.conversations.rows, STATUS_ROW_SCHEMA);
  assert.equal(rule('mirror:ask').basic, ASK_FRAME_SCHEMA);
  assert.equal(ASK_FRAME_SCHEMA.ask, ASK_SCHEMA);
  assert.equal(rule('mirror:reset').basic, RESET_SCHEMA);
  // Frozen: a consumer cannot widen the projection for every other consumer.
  const frozenDeep = (o) => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(frozenDeep));
  assert.ok(frozenDeep(FRAME_RULES));
  assert.ok(frozenDeep(TEXT_RULES));
});

test('projectFrame: a non-mirror frame passes at every level, untouched; a mirror type with no row reaches only local', () => {
  const lock = { type: 'lock', lock: { message: 'the prompt' } };
  for (const level of ['basic', 'read', 'full', 'local', 'nonsense', undefined]) {
    assert.equal(projectFrame(lock, level), lock, `${level}: the frame itself (TEXT_RULES is a separate pass)`);
  }
  assert.equal(projectFrame(null, 'basic'), null);
  const future = { type: 'mirror:future', text: 'anything' };
  assert.equal(projectFrame(future, 'local'), future);
  for (const level of ['basic', 'read', 'full']) assert.equal(projectFrame(future, level, 'full'), null, level);
});

test('projectFrame: posture gates the stream (even locally); levels gate the rest; an unknown level meets nothing', () => {
  const stream = { type: 'mirror:stream', turns: [{ id: 't1', preview: 'text' }] };
  assert.equal(projectFrame(stream, 'local'), null, 'the default posture is status');
  assert.equal(projectFrame(stream, 'local', 'status'), null);
  assert.equal(projectFrame(stream, 'local', 'full'), stream);
  assert.equal(projectFrame(stream, 'read', 'full'), stream);
  assert.equal(projectFrame(stream, 'basic', 'full'), null, 'a basic socket never gets the stream');
  assert.equal(projectFrame(stream, 'full', 'nonsense'), null, 'an unknown posture is status');
  const update = { type: 'mirror:update', conversation_id: 'c1', live: { step: { label: 'Edit · lib/x.js' } } };
  assert.equal(projectFrame(update, 'basic'), null);
  assert.equal(projectFrame(update, 'read'), update);
  assert.equal(projectFrame(update, 'full', 'status'), update, 'update needs no posture');
  const access = { type: 'mirror:access', level: 'basic', remote: true };
  assert.equal(projectFrame(access, 'basic'), access, 'access goes whole to every level');
  for (const f of [stream, update, access, { type: 'mirror:status' }, { type: 'mirror:ask' }, { type: 'mirror:reset' }]) {
    assert.equal(projectFrame(f, 'nonsense', 'full'), null, `${f.type}: an unknown level`);
    assert.equal(projectFrame(f, undefined, 'full'), null, `${f.type}: no level`);
  }
});

test('projectFrame: a basic socket gets the typed projection — a mistyped or unlisted field is dropped, never sent', () => {
  const status = {
    type: 'mirror:status', rev: 7, now: 1000, extra: 'not in the schema',
    aggregate: { state: 'working', label: 'Edit · lib/x.js' },
    conversations: [
      { id: 'f3c1a2b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b', state: 'working', since: 900, quiet: false, step_kind: 'Edit',
        waiting_kind: null, last_activity_at: 990, counts: { shells: 2, agents: 1, workflows: 0, monitors: 1 },
        label: 'Edit · lib/x.js', title: 'Fix the bug' },
      { id: 'b2', state: 'waiting', since: 'yesterday', quiet: 'no', step_kind: 'mcp__github__create_issue',
        waiting_kind: 'permission', last_activity_at: Infinity, ended_reason: 'rm -rf /', counts: { shells: -1 } },
      'not a row',
    ],
  };
  assert.deepStrictEqual(projectFrame(status, 'basic'), {
    type: 'mirror:status', rev: 7, now: 1000, aggregate: { state: 'working' },
    conversations: [
      { id: 'f3c1a2b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b', state: 'working', since: 900, quiet: false, step_kind: 'Edit',
        waiting_kind: null, last_activity_at: 990, counts: { shells: 2, agents: 1, workflows: 0, monitors: 1 } },
      { id: 'b2', state: 'waiting', waiting_kind: 'permission' },
    ],
  });
  assert.equal(status.conversations[0].label, 'Edit · lib/x.js', 'the source frame is never touched');
  assert.equal(projectFrame(status, 'read'), status, 'read and above get the frame itself');
  assert.equal(projectFrame(status, 'local'), status);

  const ask = { type: 'mirror:ask', op: 'open', answer: { port: 5199 }, ask: { id: 'ask_0123456789ab', conversation_id: 'c1',
    kind: 'permission', tool_name: 'Bash', tool_kind: 'Bash', state: 'pending', subject: 'rm -rf dist', answerable: true } };
  assert.deepStrictEqual(projectFrame(ask, 'basic'), { type: 'mirror:ask', op: 'open',
    ask: { id: 'ask_0123456789ab', conversation_id: 'c1', kind: 'permission', tool_kind: 'Bash', state: 'pending' } });
  assert.equal(projectFrame(ask, 'full'), ask);
  const mcpAsk = { type: 'mirror:ask', op: 'update', ask: { id: 'ask_1', kind: 'permission', tool_kind: 'mcp__github__merge' } };
  assert.deepStrictEqual(projectFrame(mcpAsk, 'basic'), { type: 'mirror:ask', op: 'update', ask: { id: 'ask_1', kind: 'permission' } },
    'an MCP tool\'s name is never a basic word');

  const reset = { type: 'mirror:reset', reason: 'backpressure', conversation_id: 'c1', detail: 'x' };
  assert.deepStrictEqual(projectFrame(reset, 'basic'), { type: 'mirror:reset', reason: 'backpressure', conversation_id: 'c1' });
});

test('projectValue: the types are narrow — word (never `__`), id, number, boolean, counts; rows bounded; null kept', () => {
  const v = projectValue;
  for (const ok of ['Edit', 'Bash', 'MCP', 'Reply', 'Compacting', 'permission', 'prompt_input_exit', 'web-fetch', 'a', 'A'.padEnd(24, 'x')]) {
    assert.equal(v('word', ok), ok, ok);
  }
  for (const bad of ['mcp__x__y', 'mcp__github__create_issue', 'a__b', 'A'.padEnd(25, 'x'), '1abc', '_x', '-x', '', 'Edit · x',
    'Bash(rm -rf dist)', 'a b', 'lib/x.js', '~/x', 'x.js', 7, true, {}, ['Edit'], undefined]) {
    assert.equal(v('word', bad), undefined, JSON.stringify(bad));
  }
  for (const ok of ['f3c1a2b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'ask_0123456789ab', 'n1', 'x'.repeat(64)]) assert.equal(v('id', ok), ok);
  for (const bad of ['x'.repeat(65), '', 'a/b', 'a.b', 'a b', '../x', 12, {}]) assert.equal(v('id', bad), undefined, JSON.stringify(bad));
  for (const ok of [0, -1, 1.5, 1e12]) assert.equal(v('number', ok), ok);
  for (const bad of [NaN, Infinity, -Infinity, '1', true, {}]) assert.equal(v('number', bad), undefined, String(bad));
  assert.equal(v('boolean', true), true);
  assert.equal(v('boolean', false), false);
  for (const bad of ['true', 0, 1, {}]) assert.equal(v('boolean', bad), undefined, JSON.stringify(bad));

  const counts = { shells: 1, agents: 0, workflows: 9999, monitors: 2 };
  assert.deepStrictEqual(v('counts', counts), counts);
  assert.notEqual(v('counts', counts), counts, 'a copy, never the engine\'s own object');
  const eight = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 1]));
  assert.deepStrictEqual(v('counts', eight), eight, 'eight keys is the most');
  for (const bad of [{ shells: -1 }, { shells: 10000 }, { shells: 1.5 }, { shells: '1' }, { mcp__x: 1 }, { 'a b': 1 },
    { ...eight, i: 1 }, [1, 2], 'x', 3]) {
    assert.equal(v('counts', bad), undefined, JSON.stringify(bad));
  }

  // null carries nothing, and keeps a basic row the shape of a full one.
  for (const t of ['word', 'id', 'number', 'boolean', 'counts']) assert.equal(v(t, null), null, t);
  assert.equal(v(STATUS_ROW_SCHEMA, null), null);
  assert.equal(v({ rows: STATUS_ROW_SCHEMA }, null), null);

  // rows: objects only, each projected, at most 32 — a bound, never "send nothing"
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, state: 'idle', title: 'a title' }));
  const out = v({ rows: STATUS_ROW_SCHEMA }, [7, null, ...rows]);
  assert.equal(out.length, 32);
  assert.deepStrictEqual(out[0], { id: 'c0', state: 'idle' });
  assert.deepStrictEqual(out[31], { id: 'c31', state: 'idle' });
  assert.equal(v({ rows: STATUS_ROW_SCHEMA }, { id: 'c1' }), undefined, 'a list or nothing');
  assert.deepStrictEqual(v({ rows: 'number' }, { rows: 3, x: 1 }), { rows: 3 }, 'a typed field called rows is just a field');
  assert.equal(v(STATUS_ROW_SCHEMA, 'a string'), undefined);

  // A malformed SCHEMA throws — a programmer's error, never data's.
  assert.throws(() => v('text', 'x'), TypeError);
  assert.throws(() => v('toString', 'x'), TypeError, 'no prototype names');
  assert.throws(() => v({ a: 'nonsense' }, { a: 1 }), TypeError);
  assert.throws(() => v(7, 1), TypeError);

  // The HTTP bodies' projection is the frames' (spec §5.3: exported by name).
  assert.deepStrictEqual(v(STATUS_ROW_SCHEMA, { id: 'c1', state: 'working', step_kind: 'mcp__x__y', label: 'secret' }),
    { id: 'c1', state: 'working' });
  assert.deepStrictEqual(v({ rows: ASK_SCHEMA }, [{ id: 'ask_1', kind: 'question', tool_name: 'AskUserQuestion', questions: ['Which?'] }]),
    [{ id: 'ask_1', kind: 'question' }]);
});

// ── TEXT_RULES ──────────────────────────────────────────────────────────────

const LOCK_PATHS = ['lock.message', 'lock.session_id', 'lock.claude_pid', 'lock.prompt_id'];
const NODE_PATHS = ['trigger.message', 'trigger.summary', 'trigger.reply', 'trigger.error',
  'folded[].message', 'folded[].summary', 'folded[].reply', 'folded[].error', 'mirror'];

test('TEXT_RULES: the spec\'s table, and the carriers ruling Q2 adds to it', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(TEXT_RULES)), {
    frames: { hello: LOCK_PATHS, reset: LOCK_PATHS, lock: LOCK_PATHS, 'node-added': ['node.trigger_summary'] },
    routes: {
      'GET /api/graph': ['nodes[].trigger_summary', 'nodes[].absorbed[].trigger_summary', ...LOCK_PATHS],
      // Spec §5.3's, plus `folded[].error`: §3.2 gives folded turns the error
      // text the spec already strips from the trigger.
      'GET /api/graph/node/:id': NODE_PATHS,
      // The routes the spec's list missed, each a carrier the U05 review found
      // (ruling Q2: no conversation text below `read`): the preview document
      // embeds the whole node, a pane's history names each version's prompt,
      // the replay path captions every step, and /api/health reports the raw
      // lock.
      'GET /preview/node/:id': NODE_PATHS,
      'GET /api/mounts/:id/history': ['versions[].trigger_summary'],
      'GET /api/replay/path': ['steps[].prompt', 'steps[].reply', 'steps[].summary',
        'steps[].folded[].prompt', 'steps[].folded[].reply', 'steps[].folded[].summary'],
      'GET /api/health': LOCK_PATHS,
    },
  });
});

test('stripText: the listed paths off a copy; a missing path is fine; nothing listed, nothing copied', () => {
  const lockRec = { base: 'n4', started_at: 1, message: 'fix the token leak in .env', author: 'user',
    session_id: 's1', claude_pid: 42, prompt_id: 'p1', stale: false };
  const bare = { base: 'n4', started_at: 1, author: 'user', stale: false };
  const frame = { type: 'lock', lock: lockRec };
  assert.deepStrictEqual(stripText('frames', 'lock', frame), { type: 'lock', lock: bare });
  assert.equal(frame.lock.message, 'fix the token leak in .env', 'the original is untouched');
  for (const t of ['hello', 'reset']) {
    const f = { type: t, store: { a: 1 }, mounts: [], lock: lockRec };
    const s = stripText('frames', t, f);
    assert.deepStrictEqual(s.lock, bare, t);
    assert.equal(s.store, f.store, `${t}: what no path reaches is shared, not copied`);
  }
  const unlocked = { type: 'lock', lock: null };
  assert.equal(stripText('frames', 'lock', unlocked), unlocked, 'no lock: nothing to strip');
  const noLock = { type: 'hello', store: {} };
  assert.equal(stripText('frame', 'hello', noLock), noLock);
  const added = { type: 'node-added', node: { id: 'n5', author: 'claude', trigger_summary: 'the prompt', label: 'n1.5' }, active: 'n5' };
  assert.deepStrictEqual(stripText('frames', 'node-added', added),
    { type: 'node-added', node: { id: 'n5', author: 'claude', label: 'n1.5' }, active: 'n5' });

  const graph = {
    nodes: [{ id: 'n1', trigger_summary: 'a', absorbed: [{ id: 'n0', trigger_summary: 'b', author: 'claude' }], absorbed_count: 1 },
      { id: 'n2', trigger_summary: 'c' }, { id: 'n3' }],
    lock: lockRec, active: 'n2', pending_folded: 0,
  };
  assert.deepStrictEqual(stripText('routes', 'GET /api/graph', graph), {
    nodes: [{ id: 'n1', absorbed: [{ id: 'n0', author: 'claude' }], absorbed_count: 1 }, { id: 'n2' }, { id: 'n3' }],
    lock: bare, active: 'n2', pending_folded: 0,
  });
  assert.equal(graph.nodes[0].absorbed[0].trigger_summary, 'b');
  const node = {
    id: 'n7', label: 'n1.7', author: 'claude', mounts: [{ id: 'p1' }],
    trigger: { kind: 'turn', message: 'm', summary: 's', reply: 'r', error: 'e', ended: 'failed' },
    folded: [{ at: 1, author: 'claude', kind: 'turn', message: 'm2', summary: 's2', reply: 'r2', error: 'e2', ended: 'failed' }],
    folded_count: 1,
    mirror: { v: 1, turns: [{ conversation_id: 'c1', turn_id: 't1' }] },
  };
  const bareNode = {
    id: 'n7', label: 'n1.7', author: 'claude', mounts: [{ id: 'p1' }],
    trigger: { kind: 'turn', ended: 'failed' }, folded: [{ at: 1, author: 'claude', kind: 'turn', ended: 'failed' }], folded_count: 1,
  };
  assert.deepStrictEqual(stripText('route', 'GET /api/graph/node/:id', node), bareNode);
  // The preview document embeds the node it is handed: the route hands it
  // the node with the same paths gone.
  assert.deepStrictEqual(stripText('routes', 'GET /preview/node/:id', node), bareNode);
  assert.equal(node.trigger.message, 'm', 'the original is untouched');

  const history = { ok: true, id: 'p1', from: 'n7', versions: [
    { node_id: 'live', label: 'live', trigger_summary: 'the live surface (not yet committed)', spec_hash: 'h0', current: true },
    { node_id: 'n7', label: 'n1.7', author: 'claude', owner: 'claude', trigger_summary: 'the prompt', spec_hash: 'h1' },
  ] };
  assert.deepStrictEqual(stripText('routes', 'GET /api/mounts/:id/history', history), { ok: true, id: 'p1', from: 'n7', versions: [
    { node_id: 'live', label: 'live', spec_hash: 'h0', current: true },
    { node_id: 'n7', label: 'n1.7', author: 'claude', owner: 'claude', spec_hash: 'h1' },
  ] });

  // A replay step and its folded turns, in caption shape
  // (lib/server/domain/replay-path); a hidden node's folded entry keeps its
  // label and id — the surface's, not the conversation's.
  const replayPath = { ok: true, from: { id: 'n6', label: 'n1.6' }, to: { id: 'n7', label: 'n1.7' }, steps: [
    { id: 'n7', label: 'n1.7', author: 'claude', kind: 'turn', prompt: 'p', reply: 'r', summary: 's', folded_count: 2,
      folded: [{ at: 1, author: 'claude', kind: 'turn', prompt: 'p2', reply: null, summary: 's2' },
        { at: 2, author: 'claude', kind: 'turn', prompt: 'p3', reply: 'r3', summary: 's3', id: 'n6', label: 'n1.6', collapsed: true }],
      created_at: 3, dt_from_prev: null },
  ], skipped: 1, truncated: false, total_steps: 1 };
  assert.deepStrictEqual(stripText('routes', 'GET /api/replay/path', replayPath).steps, [
    { id: 'n7', label: 'n1.7', author: 'claude', kind: 'turn', folded_count: 2,
      folded: [{ at: 1, author: 'claude', kind: 'turn' }, { at: 2, author: 'claude', kind: 'turn', id: 'n6', label: 'n1.6', collapsed: true }],
      created_at: 3, dt_from_prev: null },
  ]);

  const health = { ok: true, role: 'instance', active: 'n4', nodes: 4, lock: lockRec, lock_stale: false, remote: false };
  assert.deepStrictEqual(stripText('routes', 'GET /api/health', health), { ...health, lock: bare });

  const store = { type: 'store', patch: { a: 1 } };
  assert.equal(stripText('frames', 'store', store), store, 'a key with no entry: the value itself');
  assert.equal(stripText('routes', 'GET /api/nope', graph), graph);
  assert.throws(() => stripText('bodies', 'GET /api/graph', graph), TypeError);
});

// lib/server source with its comments and the contents of its string and
// template literals blanked to spaces (offsets kept), so a brace or a
// `lockView(` inside either never counts.
function blank(src) {
  const out = src.split('');
  const n = src.length;
  const wipe = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const stop = e === -1 ? n : e;
      wipe(i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e === -1 ? n : e + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      wipe(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

// What carries the code at offset `at` of a lib/server file to a viewer: the
// frame whose object literal holds it (that literal's own `type:`), else the
// route whose handler it sits in (the nearest `app.<verb>('<path>'` above
// it, as 'VERB /path'). `b` is the file blanked.
function carrierAt(src, b, at) {
  // The object literal around it: its unmatched `{` above, and the `}` that
  // closes it below.
  let open = -1;
  for (let k = at - 1, d = 0; k >= 0; k--) {
    if (b[k] === '}') d++;
    else if (b[k] === '{') { if (d === 0) { open = k; break; } d--; }
  }
  let frame = null;
  if (open !== -1) {
    let top = '';
    for (let k = open + 1, d = 0; k < b.length; k++) {
      if (b[k] === '{') d++;
      else if (b[k] === '}') { if (d === 0) break; d--; }
      top += d === 0 ? src[k] : ' ';
    }
    const t = /\btype\s*:\s*(['"`])([^'"`]+)\1/.exec(top);
    if (t) frame = t[2];
  }
  let route = null;
  if (!frame) {
    let last = null;
    for (const r of b.slice(0, at).matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(['"`])/g)) last = r;
    if (last) {
      const q = last.index + last[0].length;
      route = `${last[1].toUpperCase()} ${src.slice(q, src.indexOf(last[2], q))}`;
    }
  }
  return { frame, route };
}

// Every match of `re` in the blanked `files`, with where it is and what
// carries it.
function matchesIn(files, re) {
  const out = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const b = blank(src);
    for (const m of b.matchAll(re)) {
      const where = `${path.relative(REPO_ROOT, file)}:${src.slice(0, m.index).split('\n').length}`;
      out.push({ m, b, where, ...carrierAt(src, b, m.index) });
    }
  }
  return out;
}

const routeFiles = () => serverFiles(path.join(SERVER_DIR, 'routes'));

// Every `lockView(` CALL under lib/server/ (not its definition), what carries
// it, and the key it is stored under.
function lockViewCarriers() {
  return matchesIn(serverFiles(), /\blockView\(/g)
    .filter(({ m, b }) => !/function\s+$/.test(b.slice(Math.max(0, m.index - 20), m.index)))
    .map(({ m, b, where, frame, route }) => {
      const propM = /(\w+)\s*:\s*$/.exec(b.slice(Math.max(0, m.index - 60), m.index));
      return { where, prop: propM ? propM[1] : null, frame, route };
    });
}

// The raw lock record (`graph.lock` itself, not lockView's copy) put into a
// body or frame under lib/server/routes/ — GET /api/health reports it so.
// Only a value that is the whole record counts: `graph.lock ? …` and
// `graph.lock.base` read it, they do not send it.
function rawLockCarriers() {
  return matchesIn(routeFiles(), /(\w+)\s*:\s*graph\.lock\s*(?=[,}\n])/g)
    .map(({ m, where, frame, route }) => ({ where, prop: m[1], frame, route }));
}

// A read of a committed node's conversation text — its `trigger`, its
// `folded` turns, or the `trigger_summary` the topology copies from it — in
// a route under lib/server/routes/.
function nodeTextReaders() {
  return matchesIn(routeFiles(), /\.(?:trigger|folded)\b|\btrigger_summary\b/g)
    .map(({ m, where, frame, route }) => ({ where, what: m[0].replace(/^\./, ''), frame, route }));
}

// Does the table let a remote viewer with no opt-in (`basic`) reach this
// route, on one of the surface's own rows? A mirror row (one with a level)
// is not TEXT_RULES' to decide: its route answers by level itself
// (requireMirror, and the projection its row's note names).
const RULE_BY_KEY = new Map(RULES.map((r) => [keyOf(r), r]));
function basicSurfaceRoute(method, url) {
  const v = classify(method, url, { mirror: 'off' });
  return v.allow && !RULE_BY_KEY.get(v.key).mirror;
}

test('TEXT_RULES: every lockView( under lib/server/ sits in a frame or body whose entry strips the lock\'s text', () => {
  const carriers = lockViewCarriers();
  assert.ok(carriers.length >= 7, `found ${carriers.length} lockView( calls — the scan has drifted from the code`);
  const missing = [];
  for (const c of carriers) {
    if (!c.frame && !c.route) { missing.push(`${c.where}: found no frame type or route around it`); continue; }
    if (!c.prop) { missing.push(`${c.where}: not stored under a key`); continue; }
    const name = c.frame ? `frame '${c.frame}'` : c.route;
    const have = c.frame ? TEXT_RULES.frames[c.frame] : TEXT_RULES.routes[c.route];
    if (!have) { missing.push(`${c.where}: ${name} has no TEXT_RULES entry`); continue; }
    for (const p of LOCK_PATHS.map((x) => x.replace(/^lock\./, `${c.prop}.`))) {
      if (!have.includes(p)) missing.push(`${c.where}: ${name} does not strip ${p}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    'a lock reaches a frame or body TEXT_RULES does not strip, so a remote viewer below `read` would get the prompt. '
    + 'Add it to TEXT_RULES in lib/core/remote-policy.js, and strip it where it is sent');
  // Today's carriers (spec §5.3: ws.js hello and reset, the lock frames in
  // turns.js, GET /api/graph) are all found.
  const kinds = new Set(carriers.map((c) => c.frame || c.route));
  for (const k of ['hello', 'reset', 'lock', 'GET /api/graph']) assert.ok(kinds.has(k), `the scan found no lockView( in ${k}`);
});

test('TEXT_RULES: a raw lock, or a read of a node\'s trigger, folded turns or trigger_summary, in a route a basic viewer reaches has an entry', () => {
  // The scans are live: each pattern is found, and only where it means one.
  const re = /\.(?:trigger|folded)\b|\btrigger_summary\b/g;
  assert.deepStrictEqual([...'n.trigger.message n.trigger?.reply n.folded t.trigger_summary n.folded_count graph.pendingFolded triggerKind wake_trigger'
    .matchAll(re)].map((m) => m[0]), ['.trigger', '.trigger', '.folded', 'trigger_summary']);
  const raw = /(\w+)\s*:\s*graph\.lock\s*(?=[,}\n])/g;
  assert.deepStrictEqual([...'{ lock: graph.lock, lock_stale: graph.lock ? x : y, base: graph.lock.base }'.matchAll(raw)].map((m) => m[1]), ['lock']);

  const missing = [];
  const need = (c, kind) => {
    if (!c.frame && !c.route) { missing.push(`${c.where}: ${kind}, but found no frame type or route around it`); return null; }
    if (c.route) {
      const [method, p] = c.route.split(' ');
      if (!basicSurfaceRoute(method, sample(p))) return null; // host-only, or the mirror's own
    }
    const name = c.frame ? `frame '${c.frame}'` : c.route;
    const have = c.frame ? TEXT_RULES.frames[c.frame] : TEXT_RULES.routes[c.route];
    if (!have) missing.push(`${c.where}: ${kind} in ${name}, which has no TEXT_RULES entry`);
    return have ? { name, have } : null;
  };
  const locks = rawLockCarriers();
  for (const c of locks) {
    const e = need(c, 'the raw lock record');
    if (!e) continue;
    for (const p of LOCK_PATHS.map((x) => x.replace(/^lock\./, `${c.prop}.`))) {
      if (!e.have.includes(p)) missing.push(`${c.where}: ${e.name} does not strip ${p}`);
    }
  }
  const readers = nodeTextReaders();
  for (const c of readers) need(c, `a read of a node's ${c.what}`);
  assert.deepStrictEqual(missing, [],
    'conversation text reaches a frame or body a remote viewer below `read` may get, and TEXT_RULES does not strip it. '
    + 'Add the carrier to TEXT_RULES in lib/core/remote-policy.js, and strip it where it is sent');
  // Today's: /api/health's raw lock (spec §5.3's list missed it) and the
  // graph topology's trigger_summary.
  assert.ok(locks.some((c) => c.route === 'GET /api/health'), 'the scan found no raw lock in GET /api/health');
  assert.ok(readers.some((c) => c.route === 'GET /api/graph' && c.what === 'trigger_summary'),
    'the scan found no trigger_summary read in GET /api/graph');
});

test('TEXT_RULES: every key names a frame sent, or a route mounted, under lib/server/', () => {
  const routes = new Set(daemonRoutes().map((r) => `${r.method} ${r.path}`));
  for (const k of Object.keys(TEXT_RULES.routes)) assert.ok(routes.has(k), `${k} is not a route in lib/server/routes/`);
  const sent = new Set();
  for (const file of serverFiles()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\btype\s*:\s*'([a-z:-]+)'/g)) sent.add(m[1]);
  }
  for (const t of Object.keys(TEXT_RULES.frames)) assert.ok(sent.has(t), `no '${t}' frame is sent under lib/server/`);
});

// ── the probe: what a basic viewer could GET ────────────────────────────────

// The routes a remote viewer below `read` may GET that serve conversation
// text the table does not decide yet. The replay documents caption each step
// with Claude's reply summary (and with the prompt, when include_prompts asks
// for it); whether such a viewer gets them with no captions or not at all is
// the maintainer's call, open since the U05 review. They are named here, each
// with what it is, so the probe below still fails on any NEW carrier.
const TEXT_UNDECIDED = new Map([
  ['GET /replay', 'the replay document the player frames'],
  ['GET /api/replay/html', 'the same document, as a download'],
  ['GET /api/replay/file/:name', 'a replay POST /api/replay/render wrote: its captions are drawn into a GIF\'s or a '
    + 'video\'s frames, or held in a .html payload, so no text probe sees them'],
]);

test('TEXT_RULES: the replay documents are the one undecided carrier, and still routes a basic viewer may GET', () => {
  const routes = new Set(daemonRoutes().map((r) => `${r.method} ${r.path}`));
  for (const key of TEXT_UNDECIDED.keys()) {
    const p = key.slice('GET '.length);
    assert.ok(routes.has(key), `${key} is not a route in lib/server/routes/`);
    assert.ok(basicSurfaceRoute('GET', sample(p)),
      `${key} is no longer one a basic viewer may GET — if the maintainer's decision refused it there, drop it from TEXT_UNDECIDED`);
    assert.equal(TEXT_RULES.routes[key], undefined, `${key} has a TEXT_RULES entry now — drop it from TEXT_UNDECIDED`);
  }
});

// A daemon with marked conversation text in every place a turn writes it —
// the lock's prompt, a node's prompt, summary and reply, a turn folded onto
// the next node — then every route the table lets a `basic` viewer GET on
// one of the surface's own rows, fetched as the host would (a local request
// is never projected). A body that carries the mark needs a TEXT_RULES entry
// that, applied to that body, leaves none: that is what a remote request below
// `read` gets once the route strips its entry. A document (HTML) is drawn
// from data, so its entry is proved on that data, drawn as the route draws it.
test('TEXT_RULES: no route a basic viewer may GET serves conversation text its entry leaves in', async (t) => {
  const { request } = require('../lib/client');
  const { renderPreviewHtml } = require('../lib/server/preview');
  const { port } = await withServer(t);
  const MARK = 'wc-text-mark';
  const MOUNT = 'tx-pane';
  const get = (p) => request(port, 'GET', p, null, { timeout: 30000 });
  // Through lib/client, as the hooks post: a host request, no Origin.
  const must = async (method, p, body) => {
    const r = await request(port, method, p, body, { timeout: 30000 });
    assert.ok(r.status < 400, `${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const turn = async (n, { summary, work } = {}) => {
    await must('POST', '/api/turn-begin', { message: `${MARK} prompt ${n}` });
    if (work) await must('POST', '/api/render', { id: MOUNT, html: `<p>${n}</p>` });
    return must('POST', '/api/turn-end', { ...(summary ? { summary: `${MARK} summary ${n}` } : {}), reply: `${MARK} reply ${n}` });
  };
  await turn('one', { summary: true, work: true });
  assert.equal((await turn('two')).skipped, 'no-change', 'a chat-only turn folds onto the next node');
  await turn('three', { work: true });
  await must('POST', '/api/turn-begin', { message: `${MARK} prompt four` }); // a turn still running: the lock holds it

  const graph = await must('GET', '/api/graph');
  const [first, last] = [...graph.nodes].sort((a, b) => a.created_at - b.created_at).map((n) => n.id);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.active, last);
  const node = await must('GET', `/api/graph/node/${last}`);
  assert.equal(node.folded.length, 1, 'the chat-only turn rode onto the last node');

  // A route pattern as a request this daemon answers with its data.
  const concrete = (p) => (p.startsWith('/api/mounts/') ? p.replace(':id', MOUNT) : p)
    .replace(/:(?:id|node|ref)\b/g, last).replace(/:mount\b/g, MOUNT)
    .replace(/\$\{[^}]*\}/g, 'sample').replace(/:[A-Za-z_]+/g, 'sample1');
  const QUERY = { '/api/graph/diff': `?a=${first}&b=${last}` };
  // What each document route draws from: the preview, the node it is handed.
  const DRAWN = {
    'GET /preview/node/:id': () => renderPreviewHtml(stripText('routes', 'GET /preview/node/:id', node), {}),
  };

  const near = (text) => { const i = text.indexOf(MARK); return text.slice(Math.max(0, i - 80), i + 40); };
  const seen = new Set();
  const carriers = new Set();
  const wrong = [];
  for (const r of daemonRoutes()) {
    if (r.method !== 'GET' && r.method !== '*') continue;
    const url = concrete(r.path) + (QUERY[r.path] || '');
    if (seen.has(url)) continue;
    seen.add(url);
    if (!basicSurfaceRoute('GET', url)) continue;
    const key = `GET ${r.path}`;
    const { status, body } = await get(url);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (!text || !text.includes(MARK)) continue;
    carriers.add(key);
    if (TEXT_UNDECIDED.has(key)) continue;
    if (!TEXT_RULES.routes[key]) {
      wrong.push(`${key} (GET ${url} → ${status}) serves conversation text and has no TEXT_RULES entry: …${near(text)}…`);
    } else if (typeof body === 'string') {
      const draw = DRAWN[key];
      if (!draw) wrong.push(`${key} serves a document with conversation text, and this test does not know what it is drawn from`);
      else if (draw().includes(MARK)) wrong.push(`${key}: drawn from its stripped data, the document still carries …${near(draw())}…`);
    } else {
      const left = JSON.stringify(stripText('routes', key, body));
      if (left.includes(MARK)) wrong.push(`${key}: its entry leaves conversation text in: …${near(left)}…`);
    }
  }
  assert.deepStrictEqual(wrong, [],
    'a remote viewer below `read` would get conversation text from these. Give each a TEXT_RULES entry (lib/core/remote-policy.js) '
    + 'that strips all of it, and strip it in the route');
  // The probe is live: it reached the graph and found the text there.
  for (const k of ['GET /api/graph', 'GET /api/graph/node/:id']) {
    assert.ok(carriers.has(k), `the probe found no conversation text in ${k} (found: ${[...carriers].join(', ')})`);
  }
});
