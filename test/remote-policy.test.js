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
//
//   4. THE ANNOTATION ENGINE (protocol 11, PLAN.md 1B.1-1B.3, 1D.4): the
//      comment routes at read and full, the element floor, the writer leases
//      and the answer host's report row; a portal on protocol 10 or 8 lets
//      through only the comment routes (and, on 8, the two queue writes); the
//      frame row kind (queue, element:<type>), PRIVATE_RULES and the
//      queue's comment-item text; and a census of every frame type sent under
//      lib/server/.
//
//   5. TRANCHE 2 (protocol 12, PLAN.md 2D.2, ruling PROTO@bump a): the
//      toolbar's rows, the transient marks' row, the queue's re-send row and
//      the one refusal protocol 11's three comment rows fold into (U332a;
//      DECISIONS.md K.4, H2 b) (T2_ROWS), each as written; RULES less those
//      rows, the refusal unfolded, is protocol 11's table byte for byte; a portal on protocol 11 refuses every new route by
//      its default deny, save the re-send, which its `/api/queue/*` row lets
//      through (the daemon's route refuses it itself). On the answer host, the
//      report frame's document and module (T2_ANSWER_ROWS, U312): ANSWER_RULES
//      less them is protocol 11's answer table byte for byte, and a protocol-11
//      portal refuses both by its default deny.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classify, classifier, keyOf, refusalBody, RULES,
  MIRROR_HINT, MIRROR_FULL_HINT, MIRROR_LEVELS, rankLevel, atLeast, fromOptIn,
  FRAME_RULES, SURFACE_FRAMES, projectFrame, projectValue,
  STATUS_SCHEMA, STATUS_ROW_SCHEMA, ASK_SCHEMA, ASK_FRAME_SCHEMA, RESET_SCHEMA,
  TEXT_RULES, stripText, stripItemText, PRIVATE_RULES, dropPrivate,
  ANSWER_RULES, ANSWER_HINT, classifyAnswer,
} = require('../lib/core/remote-policy');
const { withServer } = require('../test-support/helpers');
const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');

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

// ── the annotation engine's rows (protocol 11) ──────────────────────────────

const SPEC_UNKNOWN_HINT = 'this route is not available remotely — use it on the host';

// Every row protocol 11 adds or changes, as PLAN-T1's U211 brief writes them:
// the comment routes at the conversation's levels (in place of protocol 8's
// and 10's single `* /api/comments/*` allow), the element floor
// (lib/core/element-policy floorRules, worded here), and the writer leases.
// Protocol 12 folds the three comment rows into one refusal (COMMENTS_FOLD_ROW,
// in T2_ROWS; before12 unfolds it), so these are before12(RULES)'s rows.
const T1_ROWS = [
  { methods: '*', path: '/api/writers/*', allow: false, hint: SPEC_HOST_ONLY },
  { methods: ['GET'], path: '/api/comments', allow: true, mirror: 'read', hint: SPEC_MIRROR_HINT },
  { methods: ['POST', 'PATCH', 'DELETE'], path: '/api/comments/*', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: '*', path: '/api/comments/*', allow: false, hint: SPEC_UNKNOWN_HINT },
  { methods: ['GET'], path: '/api/elements/search', allow: true, mirror: 'read', hint: SPEC_MIRROR_HINT },
  { methods: ['GET'], path: '/api/elements/*', allow: true, mirror: 'read', hint: SPEC_MIRROR_HINT },
  { methods: ['POST', 'PATCH', 'DELETE'], path: '/api/elements/*', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: '*', path: '/api/elements/*', allow: false, hint: SPEC_UNKNOWN_HINT },
];
// The row protocols 8 and 10 have where protocol 11 has the comment rows.
const COMMENTS_BEFORE_11 = { methods: '*', path: '/api/comments/*', allow: true };
// The report row on the answer host (decision A3, ruling B1).
const T1_ANSWER_ROW = { methods: ['POST'], path: '/answer/api/elements/report', allow: true, mirror: 'full', hint: ANSWER_HINT };

// Every route protocol 11 decides with a new row, with a sample request and
// the least opt-in that lets it through (as ROUTES_085). The comment samples'
// levels are protocol 11's: protocol 12 refuses every one of them (the
// comment classify test).
const ROUTES_T1 = [
  ['GET', '/api/comments', 'read'], ['GET', '/api/comments?since=3&mount=m1&shared_only=1', 'read'],
  ['POST', '/api/comments', 'full'], ['PATCH', '/api/comments/c1', 'full'], ['POST', '/api/comments/c1/reply', 'full'],
  ['DELETE', '/api/comments/c1', 'full'], ['PUT', '/api/comments/c1', 'refused'], ['GET', '/api/comments/c1', 'refused'],
  ['GET', '/api/elements/search?q=x', 'read'], ['GET', '/api/elements', 'read'], ['GET', '/api/elements/el-1', 'read'],
  ['GET', '/api/elements/el-1/versions', 'read'], ['POST', '/api/elements', 'full'], ['POST', '/api/elements/el-1/reply', 'full'],
  ['PATCH', '/api/elements/el-1', 'full'], ['DELETE', '/api/elements/el-1', 'full'], ['PUT', '/api/elements/el-1', 'refused'],
  ['POST', '/api/writers/lease', 'refused'], ['GET', '/api/writers/lease', 'refused'], ['DELETE', '/api/writers/lease/l1', 'refused'],
];

// RULES as a portal older than protocol 11 enforces it: less the rows above,
// with the comment rows folded back into the one row they replaced, in place.
function before11(rules) {
  const t1 = new Set(T1_ROWS.map(keyOf));
  const out = [];
  for (const r of rules) {
    if (keyOf(r) === 'GET /api/comments') out.push({ ...COMMENTS_BEFORE_11 });
    else if (!t1.has(keyOf(r))) out.push(r);
  }
  return out;
}

test('protocol 11: every row the annotation engine adds or changes is in its table, exactly as written, the comment rows where their one row was', () => {
  // Protocol 11's table is before12(RULES): protocol 12 folded the three
  // comment rows into one refusal, which before12 unfolds in place.
  const p11 = before12(RULES);
  const byKey = new Map(p11.map((r) => [keyOf(r), r]));
  for (const want of T1_ROWS) assert.deepStrictEqual(byKey.get(keyOf(want)), want, keyOf(want));
  // Contiguous, first match wins: the comment rows above the element rows,
  // each narrower row above the refusal that follows it.
  const at11 = (k) => p11.findIndex((r) => keyOf(r) === k);
  const block = T1_ROWS.slice(1).map((r) => at11(keyOf(r)));
  assert.deepStrictEqual(block, block.map((_, i) => block[0] + i), 'the comment and element rows sit together, in this order');
  // In RULES (protocol 12) the one refusal holds the comment rows' place:
  // directly above the element rows, and the only row under /api/comments.
  const at = (k) => RULES.findIndex((r) => keyOf(r) === k);
  const elements = T1_ROWS.slice(4).map((r) => at(keyOf(r)));
  assert.deepStrictEqual(elements, elements.map((_, i) => at(keyOf(COMMENTS_FOLD_ROW)) + 1 + i), 'the comment refusal sits directly above the element rows, in this order');
  assert.ok(at('* /api/writers/*') < at('GET|POST /api/store'), 'the writer leases sit with the turn and hook internals');
  assert.ok(!RULES.some((r) => r.path === '/api/comments/*' && r.allow && !r.mirror), 'no comment row at every level');
});

test('classify: the comment routes — protocol 12 refuses every one at every level with the element-API hint; protocol 11 had GET at read, writes at full, the rest refused', () => {
  // Protocol 12 (U332a; DECISIONS.md K.4, H2 b): one refusal, whatever the
  // method, the path under /api/comments and the level.
  for (const u of ['/api/comments', '/api/comments?since=4', '/api/comments/c1', '/api/comments/c1/reply']) {
    for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS']) {
      for (const optIn of [undefined, 'bogus', ...OPT_INS]) {
        const v = classify(m, u, { mirror: optIn });
        assert.deepStrictEqual([v.allow, v.reason, v.key, v.hint], [false, 'refused', '* /api/comments/*', SPEC_COMMENTS_FOLD_HINT], `${m} ${u} at ${optIn}`);
        assert.deepStrictEqual(refusalBody(v), { ok: false, remote: true, hint: SPEC_COMMENTS_FOLD_HINT }, `${m} ${u} at ${optIn}`);
      }
    }
  }
  // Protocol 11's decisions, as its portal (before12(RULES)) still makes them.
  const p11 = classifier(before12(RULES));
  for (const optIn of [undefined, 'off', 'bogus']) {
    const v = p11('GET', '/api/comments', { mirror: optIn });
    assert.deepStrictEqual([v.allow, v.reason, v.hint, v.level, v.need], [false, 'mirror', SPEC_MIRROR_HINT, 'basic', 'read'], String(optIn));
    assert.deepStrictEqual(refusalBody(v), { ok: false, remote: true, hint: SPEC_MIRROR_HINT, mirror: 'basic' });
  }
  for (const optIn of ['read', 'full']) assert.equal(p11('GET', '/api/comments?since=4', { mirror: optIn }).allow, true, optIn);
  for (const [m, u] of [['POST', '/api/comments'], ['PATCH', '/api/comments/c1'], ['POST', '/api/comments/c1/reply'], ['DELETE', '/api/comments/c1']]) {
    assert.equal(p11(m, u, { mirror: 'full' }).allow, true, `${m} ${u} at full`);
    for (const optIn of [undefined, 'off', 'read']) {
      const v = p11(m, u, { mirror: optIn });
      assert.deepStrictEqual([v.allow, v.reason, v.hint, v.need], [false, 'mirror', SPEC_MIRROR_FULL_HINT, 'full'], `${m} ${u} at ${optIn}`);
    }
  }
  for (const [m, u] of [['PUT', '/api/comments/c1'], ['GET', '/api/comments/c1'], ['OPTIONS', '/api/comments'], ['HEAD', '/api/comments/c1']]) {
    const v = p11(m, u, { mirror: 'full' });
    assert.deepStrictEqual([v.allow, v.reason, v.key, v.hint], [false, 'refused', '* /api/comments/*', SPEC_UNKNOWN_HINT], `${m} ${u}`);
  }
});

test('classify: the element floor (search and reads at read, writes at full, the rest refused) and the writer leases (host only)', () => {
  const at = (m, u, o) => classify(m, u, { mirror: o });
  assert.equal(at('GET', '/api/elements/search?q=x', 'read').key, 'GET /api/elements/search', 'the search row decides the search');
  for (const [m, u, need] of ROUTES_T1.filter(([, u]) => u.startsWith('/api/elements'))) {
    for (const optIn of OPT_INS) {
      const v = at(m, u, optIn);
      if (need === 'refused') { assert.deepStrictEqual([v.allow, v.reason, v.hint], [false, 'refused', SPEC_UNKNOWN_HINT], `${m} ${u}`); continue; }
      const ok = atLeast(fromOptIn(optIn), need);
      assert.equal(v.allow, ok, `${m} ${u} at ${optIn} (needs ${need})`);
      if (!ok) assert.equal(v.reason, 'mirror', `${m} ${u} at ${optIn}`);
    }
  }
  for (const [m, u] of [['POST', '/api/writers/lease'], ['GET', '/api/writers/lease'], ['DELETE', '/api/writers/lease/l1'], ['POST', '/api/writers']]) {
    const v = classify(m, u, { mirror: 'full' });
    assert.deepStrictEqual([v.allow, v.reason, v.hint], [false, 'refused', SPEC_HOST_ONLY], `${m} ${u}`);
  }
});

test('classifyAnswer: POST /answer/api/elements/report is allowed at full only (ruling B1)', () => {
  const byKey = new Map(ANSWER_RULES.map((r) => [keyOf(r), r]));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(byKey.get(keyOf(T1_ANSWER_ROW)))), T1_ANSWER_ROW);
  assert.equal(classifyAnswer('POST', '/answer/api/elements/report', { mirror: 'full' }).allow, true);
  for (const optIn of [undefined, 'off', 'read']) {
    const v = classifyAnswer('POST', '/answer/api/elements/report', { mirror: optIn });
    assert.deepStrictEqual([v.allow, v.reason, v.need], [false, 'mirror', 'full'], String(optIn));
  }
  assert.equal(classifyAnswer('GET', '/answer/api/elements/report', { mirror: 'full' }).reason, 'unknown', 'a POST only');
  assert.equal(classify('POST', '/api/elements/report', { mirror: 'full' }).allow, true,
    'the session host decides its own /api/elements/* by the floor; the report is the answer host\'s');
});

test('protocol 11: the surface\'s other rows are 0.8.5\'s — the queue, capture and store (signal) rows byte for byte', () => {
  // Pinned on their own (RULES at f3c4a7f, measured 2026-10-17 with digest()),
  // not against before11(RULES), which holds these very rows unchanged. Read
  // through before12: protocol 12 adds one queue row, the re-send (T2_ROWS),
  // and changes none of these.
  const re = /^\/api\/(queue|capture|captures|store|profile-match)\b/;
  const rows = before12(RULES).filter((r) => re.test(r.path));
  assert.deepStrictEqual(RULES.filter((r) => re.test(r.path) && !rows.includes(r)).map(keyOf),
    ['* /api/queue/items/:id/resend'], 'protocol 12 adds the re-send row and no other queue, capture or store row');
  assert.deepStrictEqual(rows.map(keyOf), [
    'GET|POST /api/store', 'POST /api/queue/message', 'POST /api/queue/task-stop', '* /api/queue/*',
    '* /api/capture/*', '* /api/captures/*', '* /api/profile-match',
  ]);
  assert.equal(digest(rows), '3f8e0214e337b9b3', 'a queue, capture or store row changed: GT-16 holds them as 0.8.5 has them');
});

test('rollback: portals on protocol 10 and 8 refuse every new route by the default deny, save the comment routes (and the queue writes on 8), which the daemon checks again', () => {
  const PIN = 'a row an older portal also has has changed — that is a portal protocol change: bump PORTAL_PROTOCOL_VERSION (lib/core/versions) and update this pin';
  // Protocol 10's table as 0.8.5 ships it, byte for byte (RULES at f3c4a7f,
  // measured 2026-10-17): protocol 11 added rows and changed only the comment
  // row, which before11 folds back; protocol 12's rows (before12) go first.
  const p10 = before11(before12(RULES));
  assert.equal(p10.length, 100);
  assert.equal(digest(p10), 'b23087d38123db27', PIN);
  // Protocol 8's: 0.8.5 added rows (SPEC_ROWS) and changed none.
  // Protocol 8 has two tables in the wild. 0.8.2 added one row, `trust
  // --pack`'s read-only listing, without a protocol bump, so a 0.8.0 portal
  // enforces this table less that row (and refuses the listing by the default
  // deny). A rollback can land on either, so both are checked.
  const added085 = new Set(SPEC_ROWS.map(keyOf));
  const older = p10.filter((r) => !added085.has(keyOf(r)));
  assert.equal(older.length, 77);
  assert.equal(digest(older), 'c1e44e5df5393ba7', PIN);
  const PACK_LISTING = 'GET /api/services/pack/:name';
  const v080 = older.filter((r) => keyOf(r) !== PACK_LISTING);
  assert.equal(v080.length, 76, `0.8.2's one added row is ${PACK_LISTING}`);
  assert.equal(digest(v080), 'd5878f2b94237a22', PIN);
  // ANSWER_RULES as protocol 10 has it: protocol 12's answer rows (before12)
  // and the report row gone.
  const answer10 = before12(ANSWER_RULES).filter((r) => keyOf(r) !== keyOf(T1_ANSWER_ROW));
  assert.equal(answer10.length, 16);
  assert.equal(digest(answer10), '60bdf33013a658c1', PIN);
  assert.equal(classifier(answer10)('POST', '/answer/api/elements/report', { mirror: 'full' }).reason, 'unknown',
    'a protocol-10 portal refuses the report by its default deny');

  const comments = ROUTES_T1.filter(([, u]) => u.startsWith('/api/comments')).map(([m, u]) => `${m} ${u} → * /api/comments/*`);
  const queue = ['POST /api/queue/message → * /api/queue/*', 'POST /api/queue/task-stop → * /api/queue/*'];
  for (const [release, table, routes, through, least] of [
    ['0.8.5', p10, ROUTES_T1, comments, ROUTES_T1.length],
    ['0.8.2', older, [...ROUTES_085, ...ROUTES_T1], [...comments, ...queue], 45 + ROUTES_T1.length],
    ['0.8.0', v080, [...ROUTES_085, ...ROUTES_T1], [...comments, ...queue], 45 + ROUTES_T1.length],
  ]) {
    const old = classifier(table);
    const has = new Set(table.map((r) => JSON.stringify(r)));
    const deciding = new Map(RULES.map((r) => [keyOf(r), r]));
    let checked = 0;
    const letThrough = new Set();
    for (const [m, u] of routes) {
      const now = classify(m, u, { mirror: 'full' });
      if (now.key && has.has(JSON.stringify(deciding.get(now.key)))) continue; // decided by a row the older portal has, unchanged
      checked += 1;
      for (const optIn of [undefined, ...OPT_INS]) {
        const v = old(m, u, { mirror: optIn });
        if (v.allow) letThrough.add(`${m} ${u} → ${v.key}`);
        else assert.equal(v.reason, 'unknown', `${release}'s portal, ${m} ${u}: refused by the default deny, with no row of its own`);
      }
    }
    assert.ok(checked >= least, `${release}: only ${checked} new routes checked`);
    // The exceptions, deliberate: the old `* /api/comments/*` (and, on 8,
    // `/api/queue/*`) lets these through. The daemon answers every comment
    // route with its 410 refusal (routes/comments.js, U327a: the comment's
    // routes are the element API's), and its own level check (requireMirror
    // in routes/queue.js) refuses the queue writes below their level — a
    // rolled-back portal over this daemon shows no pin to, and takes none
    // from, a viewer without the opt-in.
    assert.deepStrictEqual([...letThrough].sort(), [...through].sort(), `${release}'s portal`);
  }
});

// ── tranche 2's rows (protocol 12; PLAN.md 2D.2, PROTO@bump a) ────────────

const SPEC_TOOLBAR_USER_HINT = 'hotkeys and settings for every project are set on the host';

// Every row protocol 12 adds, as U332's brief writes them (and U313's for the
// marks and U328b's for the queue's re-send, DECISIONS.md K.2-17, declared
// here so neither needs a second bump). Protocol 12 changes one row an older
// portal has, the comment refusal (COMMENTS_FOLD_ROW, below).
const RESEND_ROW = { methods: '*', path: '/api/queue/items/:id/resend', allow: false, hint: SPEC_HOST_ONLY };
// The one row protocol 12 CHANGES (U332a; DECISIONS.md K.4, I2-confirm c under
// H2 b): protocol 11's three /api/comments rows (T1_ROWS) fold into one
// refusal for the dead route, its hint naming the element API. `*` covers the
// bare /api/comments too. before12 unfolds it back in place.
const SPEC_COMMENTS_FOLD_HINT = 'comments moved to the element API (/api/elements) — this page predates the upgrade: reload it';
const COMMENTS_FOLD_ROW = { methods: '*', path: '/api/comments/*', allow: false, hint: SPEC_COMMENTS_FOLD_HINT };
const T2_ROWS = [
  { methods: '*', path: '/api/marks', allow: false, hint: SPEC_HOST_ONLY },
  RESEND_ROW,
  COMMENTS_FOLD_ROW,
  { methods: ['GET'], path: '/api/toolbar', allow: true },
  { methods: ['GET'], path: '/api/toolbar/icon/:type', allow: true },
  { methods: ['PATCH'], path: '/api/toolbar', allow: true, mirror: 'full', hint: SPEC_MIRROR_FULL_HINT },
  { methods: '*', path: '/api/toolbar/*', allow: false, hint: SPEC_TOOLBAR_USER_HINT },
];

// Every route protocol 12 decides with a new row, with a sample request and
// the least opt-in that lets it through ('basic': every level).
const ROUTES_T2 = [
  ['GET', '/api/toolbar', 'basic'], ['HEAD', '/api/toolbar', 'basic'],
  ['GET', '/api/toolbar/icon/comment', 'basic'], ['GET', '/api/toolbar/icon/box-grab?mode=dark', 'basic'],
  ['PATCH', '/api/toolbar', 'full'],
  ['PATCH', '/api/toolbar/user', 'refused'], ['GET', '/api/toolbar/user', 'refused'], ['DELETE', '/api/toolbar/user', 'refused'],
  ['POST', '/api/toolbar', 'refused'], ['PUT', '/api/toolbar', 'refused'], ['DELETE', '/api/toolbar', 'refused'],
  ['POST', '/api/toolbar/icon/comment', 'refused'],
  ['POST', '/api/marks', 'refused'], ['GET', '/api/marks', 'refused'],
  ['POST', '/api/queue/items/q-1/resend', 'refused'],
];
// The one ROUTES_T2 route an older portal does not refuse by its default
// deny: its `/api/queue/*` row lets the re-send through (so U328b's route
// refuses a request that is not the host's own itself).
const RESEND = ['POST', '/api/queue/items/q-1/resend'];
const isResend = (m, u) => m === RESEND[0] && u === RESEND[1];

// The answer-host rows protocol 12 adds (U312, decision A3): the report
// frame's document and its module, each an answerRow at full.
const T2_ANSWER_ROWS = [
  { methods: ['GET'], path: '/answer/elements-report.js', allow: true, mirror: 'full', hint: ANSWER_HINT },
  { methods: ['GET'], path: '/answer/elements/:layout', allow: true, mirror: 'full', hint: ANSWER_HINT },
];
// What they decide, at full only.
const ROUTES_T2_ANSWER = [
  ['GET', '/answer/elements/report?layout=report&mode=light&device=mobile&viewer=0123456789abcdef'],
  ['HEAD', '/answer/elements/report?layout=report'],
  ['GET', '/answer/elements-report.js'],
];

// RULES (or ANSWER_RULES) as a portal on protocol 11 enforces it: less the
// rows above, with the comment refusal unfolded back into protocol 11's three
// comment rows, in place (as before11 folds those into protocol 10's one).
function before12(rules) {
  const t2 = new Set([...T2_ROWS, ...T2_ANSWER_ROWS].map(keyOf));
  const out = [];
  for (const r of rules) {
    if (JSON.stringify(r) === JSON.stringify(COMMENTS_FOLD_ROW)) out.push(...T1_ROWS.slice(1, 4).map((row) => ({ ...row })));
    else if (!t2.has(keyOf(r))) out.push(r);
  }
  return out;
}

test('protocol 12: PORTAL_PROTOCOL_VERSION is 12, and every row tranche 2 adds is in RULES exactly as written, where it belongs', () => {
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
  const byKey = new Map(RULES.map((r) => [keyOf(r), r]));
  for (const want of T2_ROWS) assert.deepStrictEqual(byKey.get(keyOf(want)), want, keyOf(want));
  const at = (k) => RULES.findIndex((r) => keyOf(r) === k);
  // The toolbar's four, in first-match order, directly after the theme block.
  const toolbar = T2_ROWS.filter((r) => r.path.startsWith('/api/toolbar')).map((r) => at(keyOf(r)));
  assert.equal(toolbar.length, 4);
  assert.deepStrictEqual(toolbar, toolbar.map((_, i) => at('POST /api/theme') + 1 + i), 'the toolbar rows follow the theme rows, in this order');
  // The marks row with the host-only internals, after the writer leases.
  assert.equal(at('* /api/marks'), at('* /api/writers/*') + 1);
  // The re-send directly before the queue's own row, which would otherwise
  // take it (first match wins), after the queue's two message rows.
  assert.equal(at(keyOf(RESEND_ROW)), at('* /api/queue/*') - 1);
  assert.equal(at(keyOf(RESEND_ROW)), at('POST /api/queue/task-stop') + 1);
});

test('protocol 12: RULES less T2_ROWS is protocol 11\'s table byte for byte', () => {
  // Measured at ae/int 39b52f8 (tranche 1's exit) on 2026-10-23, before this
  // bump, with digest() over RULES; ae/int 33859ea's RULES measured the same.
  const p11 = before12(RULES);
  assert.equal(p11.length, 107);
  assert.equal(digest(p11), '63e5b38de47f48c8',
    'a row a protocol-11 portal also has has changed — that is a portal protocol change: bump PORTAL_PROTOCOL_VERSION (lib/core/versions) and update this pin');
});

test('classify: the toolbar — GET and the icon route at every level, PATCH at full only (reason mirror below), the user record and the rest refused with the host hint; the marks host only', () => {
  for (const [m, u, need] of ROUTES_T2) {
    for (const optIn of [undefined, 'bogus', ...OPT_INS]) {
      const v = classify(m, u, { mirror: optIn });
      if (need === 'refused') {
        const hint = u.startsWith('/api/toolbar') ? SPEC_TOOLBAR_USER_HINT : SPEC_HOST_ONLY;
        assert.deepStrictEqual([v.allow, v.reason, v.hint], [false, 'refused', hint], `${m} ${u} at ${optIn}`);
        assert.equal(refusalBody(v).remote, true);
        continue;
      }
      const ok = atLeast(fromOptIn(optIn), need);
      assert.equal(v.allow, ok, `${m} ${u} at ${optIn} (needs ${need})`);
      if (!ok) assert.deepStrictEqual([v.reason, v.hint, v.need], ['mirror', SPEC_MIRROR_FULL_HINT, 'full'], `${m} ${u} at ${optIn}`);
    }
  }
  assert.equal(classify('PATCH', '/api/toolbar/user', { mirror: 'full' }).key, '* /api/toolbar/*');
  for (const optIn of [undefined, 'read', 'full']) {
    assert.equal(classify(...RESEND, { mirror: optIn }).key, keyOf(RESEND_ROW), `the re-send at ${optIn}: its own row, not the queue's`);
  }
});

test('rollback: a portal on protocol 11 refuses every route tranche 2 adds by its default deny, save the re-send, which its queue row lets through', () => {
  const p11 = classifier(before12(RULES));
  for (const [m, u] of ROUTES_T2) {
    for (const optIn of [undefined, ...OPT_INS]) {
      const v = p11(m, u, { mirror: optIn });
      if (isResend(m, u)) {
        // The exception, deliberate: the daemon's route refuses a request that
        // is not the host's own, whatever the portal let through.
        assert.deepStrictEqual([v.allow, v.key], [true, '* /api/queue/*'], `protocol 11, ${m} ${u} at ${optIn}`);
        continue;
      }
      assert.deepStrictEqual([v.allow, v.reason], [false, 'unknown'], `protocol 11, ${m} ${u} at ${optIn}`);
    }
  }
  // And every daemon route a T2 row decides (later units' included) is refused
  // by that portal the same way.
  const t2 = new Set(T2_ROWS.map(keyOf));
  const decided = [];
  for (const r of daemonRoutes()) {
    const m = r.method === '*' ? 'GET' : r.method;
    const v = classify(m, sample(r.path), { mirror: 'full' });
    if (!v.key || !t2.has(v.key)) continue;
    decided.push(`${r.method} ${r.path}`);
    if (v.key === keyOf(COMMENTS_FOLD_ROW)) {
      // The changed row, not a new one: protocol 11's comment rows decide it
      // (U327a's 410 answers behind them, whatever they let through).
      assert.ok(p11(m, sample(r.path), { mirror: 'full' }).key.includes('/api/comments'), `protocol 11, ${m} ${r.path}`);
      continue;
    }
    if (v.key === keyOf(RESEND_ROW)) {
      assert.equal(p11(m, sample(r.path), { mirror: 'full' }).key, '* /api/queue/*', `protocol 11, ${m} ${r.path}`);
      continue;
    }
    assert.equal(p11(m, sample(r.path), { mirror: 'full' }).reason, 'unknown', `protocol 11, ${m} ${r.path}`);
  }
  for (const want of ['GET /api/toolbar', 'PATCH /api/toolbar', 'PATCH /api/toolbar/user']) assert.ok(decided.includes(want), want);
});

test('protocol 12: the answer host — the report frame\'s document and module are in ANSWER_RULES as written; ANSWER_RULES less them is protocol 11\'s byte for byte', () => {
  const byKey = new Map(ANSWER_RULES.map((r) => [keyOf(r), r]));
  for (const want of T2_ANSWER_ROWS) assert.deepStrictEqual(JSON.parse(JSON.stringify(byKey.get(keyOf(want)))), want, keyOf(want));
  // Measured at ae/int 2b47c66 on 2026-10-23, before these rows, with digest()
  // over ANSWER_RULES.
  const p11 = before12(ANSWER_RULES);
  assert.equal(p11.length, 17);
  assert.equal(digest(p11), 'ff5f082c9e802049',
    'an answer row a protocol-11 portal also has has changed — that is a portal protocol change: bump PORTAL_PROTOCOL_VERSION (lib/core/versions) and update this pin');
});

test('classifyAnswer: the report frame\'s document and module at full only; a protocol-11 portal refuses both by its default deny (and so no remote page holds a report nonce)', () => {
  const p11 = classifier(before12(ANSWER_RULES));
  for (const [m, u] of ROUTES_T2_ANSWER) {
    assert.equal(classifyAnswer(m, u, { mirror: 'full' }).allow, true, `${m} ${u} at full`);
    for (const optIn of [undefined, 'off', 'read', 'bogus']) {
      const v = classifyAnswer(m, u, { mirror: optIn });
      assert.deepStrictEqual([v.allow, v.reason, v.hint, v.need], [false, 'mirror', ANSWER_HINT, 'full'], `${m} ${u} at ${optIn}`);
    }
    for (const optIn of [undefined, ...OPT_INS]) {
      assert.deepStrictEqual([p11(m, u, { mirror: optIn }).allow, p11(m, u, { mirror: optIn }).reason], [false, 'unknown'], `protocol 11, ${m} ${u} at ${optIn}`);
    }
  }
  assert.equal(classifyAnswer('POST', '/answer/elements/report', { mirror: 'full' }).reason, 'unknown', 'the document is a GET');
  assert.equal(classifyAnswer('GET', '/answer/elements', { mirror: 'full' }).reason, 'unknown', 'no kind root document');
  assert.equal(classifyAnswer('GET', '/answer/elements/report/x', { mirror: 'full' }).reason, 'unknown', 'one segment');
});

test('frames: the toolbar frame is a SURFACE_FRAMES frame, sent whole at every level', () => {
  assert.ok(SURFACE_FRAMES.includes('toolbar'));
  const frame = { type: 'toolbar', v: 1, project: { pinned: ['comment'] }, user: {}, merged: { bindings: {}, settings: {} } };
  for (const level of MIRROR_LEVELS) assert.equal(projectFrame(frame, level), frame, level);
});

// ── the answer host: ANSWER_RULES (U74; spec §4.6, §15.5) ──────────────────

const ANSWER_PUBLIC = path.join(REPO_ROOT, 'lib/server/answer-surface/public');
// The two stylesheets the surface generates rather than serves from publicDir.
const GENERATED_ASSETS = ['palette.css', 'fonts.css'];
const literalAssetRows = () => ANSWER_RULES
  .map((r) => /^\/answer\/([a-z0-9][a-z0-9-]*\.(?:js|css))$/.exec(r.path))
  .filter(Boolean).map((m) => m[1]);

test('ANSWER_RULES: well-formed — frozen, every row an allow at full with ANSWER_HINT, GET or POST only', () => {
  assert.ok(Object.isFrozen(ANSWER_RULES));
  for (const r of ANSWER_RULES) {
    assert.ok(Object.isFrozen(r), keyOf(r));
    assert.equal(r.allow, true, keyOf(r));
    assert.equal(r.mirror, 'full', `${keyOf(r)}: every allow row needs full`);
    assert.equal(r.hint, ANSWER_HINT, keyOf(r));
    assert.ok(Array.isArray(r.methods) && r.methods.every((m) => m === 'GET' || m === 'POST'), keyOf(r));
    assert.ok(r.path.startsWith('/answer/'), `${keyOf(r)}: nothing outside /answer/`);
    assert.ok(!r.path.endsWith('*'), `${keyOf(r)}: no wildcard`);
    assert.ok(!/^\/answer\/:[a-z]+$/.test(r.path), `${keyOf(r)}: never /answer/:asset (it would match a kind's root document)`);
  }
  assert.match(ANSWER_HINT, /claude-web-chat tunnel mirror on/);
  assert.equal(new Set(ANSWER_RULES.map(keyOf)).size, ANSWER_RULES.length, 'no row twice');
  assert.deepEqual(ANSWER_RULES.filter((r) => !literalAssetRows().includes(r.path.slice('/answer/'.length))).map(keyOf), [
    'GET /answer/ask/:id',
    'GET /answer/api/asks/:id',
    'POST /answer/api/asks/:id/decide',
    'GET /answer/control/:action',
    'GET /answer/api/control/state',
    'POST /answer/api/control/:action',
    'GET /answer/fonts/:file',
    'POST /answer/api/elements/report',
    'GET /answer/elements/:layout',
  ]);
});

test('ANSWER_RULES ratchet: every .js and .css file the answer surface serves has a literal row, and every literal row a file', () => {
  const files = fs.readdirSync(ANSWER_PUBLIC).filter((f) => /\.(js|css)$/.test(f)).sort();
  assert.ok(files.includes('elicitation-form.js'), 'tranche 6\'s layout file is among them');
  assert.ok(files.length >= 7, files.join(', '));
  const rows = literalAssetRows();
  for (const f of files) {
    assert.ok(rows.includes(f), `lib/server/answer-surface/public/${f} has no ANSWER_RULES row: add a literal GET /answer/${f} row (a remote frame cannot load it otherwise)`);
  }
  for (const f of rows) {
    assert.ok(files.includes(f) || GENERATED_ASSETS.includes(f), `ANSWER_RULES names /answer/${f}, which the surface does not serve`);
  }
  for (const f of GENERATED_ASSETS) assert.ok(rows.includes(f), f);
});

test('classifyAnswer: first match wins, default deny; every row refused below full with reason mirror and the hint', () => {
  const allowed = [
    ['GET', '/answer/ask/ask_0123456789ab?layout=bar'],
    ['GET', '/answer/api/asks/ask_0123456789ab?v=3&wait=20000'],
    ['POST', '/answer/api/asks/ask_0123456789ab/decide'],
    ['GET', '/answer/control/interrupt?conversation_id=c&layout=stop'],
    ['GET', '/answer/control/task-stop?task_id=b1&layout=confirm'],
    ['GET', '/answer/api/control/state?action=interrupt&conversation_id=c'],
    ['POST', '/answer/api/control/interrupt'],
    ['POST', '/answer/api/control/session-compact'],
    ['GET', '/answer/fonts/inter.woff2'],
    ['HEAD', '/answer/answer.js'],
    ['GET', '/answer/elicitation-form.js'],
    ['GET', '/answer/palette.css'],
    ['GET', '/answer/elements/report?layout=report'],
    ['GET', '/answer/elements-report.js'],
    ['POST', '/answer/api/elements/report'],
  ];
  for (const [m, u] of allowed) {
    assert.equal(classifyAnswer(m, u, { mirror: 'full' }).allow, true, `${m} ${u} at full`);
    for (const optIn of [undefined, 'off', 'read', 'bogus']) {
      const v = classifyAnswer(m, u, { mirror: optIn });
      assert.deepEqual([v.allow, v.reason, v.hint, v.need], [false, 'mirror', ANSWER_HINT, 'full'], `${m} ${u} at ${optIn}`);
      assert.deepEqual(refusalBody(v), { ok: false, remote: true, hint: ANSWER_HINT, mirror: optIn === 'read' ? 'read' : 'basic' });
    }
  }
  for (const [m, u, reason] of [
    ['GET', '/api/graph', 'unknown'],
    ['GET', '/api/health', 'unknown'],
    ['GET', '/api/bridge/status', 'unknown'],
    ['POST', '/api/bridge/hello', 'unknown'],
    ['GET', '/', 'unknown'],
    ['GET', '/answer/index.html', 'unknown'],
    ['GET', '/answer/bridge', 'unknown'],
    ['GET', '/answer/control', 'unknown'],
    ['POST', '/answer/api/asks/x/withdraw', 'unknown'],
    ['POST', '/answer/ask/x', 'unknown'],
    ['GET', '/answer/api/asks/x/decide', 'unknown'],
    ['DELETE', '/answer/api/control/interrupt', 'unknown'],
    ['GET', '/answer/other.js', 'unknown'],
    ['GET', '/answer/api/asks%2fx', 'malformed'],
    ['GET', '/answer/ask/..', 'malformed'],
    ['GET', '/answer/%2e%2e/api/graph', 'malformed'],
  ]) {
    const v = classifyAnswer(m, u, { mirror: 'full' });
    assert.deepEqual([v.allow, v.reason], [false, reason], `${m} ${u}`);
    assert.notEqual(v.hint, ANSWER_HINT, `${m} ${u}`);
  }
  // The session host's table names no answer route: /answer/* is its default deny.
  assert.deepEqual([classify('GET', '/answer/ask/x', { mirror: 'full' }).allow, classify('GET', '/answer/ask/x', { mirror: 'full' }).reason], [false, 'unknown']);
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

// ── the frame census ────────────────────────────────────────────────────────
// Every `type: '<x>'` literal under lib/server/ is a frame type — FRAME_RULES,
// TEXT_RULES.frames or SURFACE_FRAMES — or one of these, each reviewed as not
// a frame the sockets get: the mirror's record and item kinds, the
// supervisor's IPC with a service child, the answer frames' postMessage, two
// hint keys and a type the scan reads off a ternary.
const NOT_FRAMES = new Map([
  ['', 'lib/server/mirror/tasks.js: `entry.type : \'\'`, a ternary the scan reads as a key'],
  ['<no-type>', 'lib/server/mirror/records.js: a record kind'],
  ['text', 'lib/server/mirror/normalize.js: a content block'],
  ['record', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['item', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['opener', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['interrupt', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['compact', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['compact-summary', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['turn-duration', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['permission-decision', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['rewind-evidence', 'the mirror\'s normalize/turn-machine entry kinds'],
  ['rekey', 'turn-machine.js: the re-key change it appends to a batch for the other sources (U413), never a frame'],
  ['start', 'the supervisor\'s IPC to a service child (services.js, service-runner.js)'],
  ['started', 'the supervisor\'s IPC from a service child'],
  ['stop', 'the supervisor\'s IPC to a service child'],
  ['wc-answer:size', 'an answer frame\'s postMessage to the chrome (answer-surface/public/answer.js)'],
  ['wc-answer:done', 'an answer frame\'s postMessage to the chrome'],
  ['wc-answer:open-chat', 'an answer frame\'s postMessage to the chrome'],
  ['add a PNG, JPEG, GIF or WebP image', 'routes/attachments.js: the `type` hint of its HINTS'],
  ['expected application/json', 'tunnel-setup/index.js: a refusal\'s `type` field'],
]);
const ANY_TYPE_RE = /\btype\s*:\s*(['"`])([^'"`]*)\1/g;
const isFrameKnown = (t) => FRAME_RULES.some((r) => r.type === t) || Object.hasOwn(TEXT_RULES.frames, t) || SURFACE_FRAMES.includes(t);

// The literals in `files` that are neither a known frame nor reviewed as not one.
function frameCensus(files) {
  const missing = [];
  const found = new Set();
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(ANY_TYPE_RE)) {
      found.add(m[2]);
      if (!isFrameKnown(m[2]) && !NOT_FRAMES.has(m[2])) missing.push(`${m[2]}   (${path.relative(REPO_ROOT, file)})`);
    }
  }
  return { missing, found };
}

test('ratchet: every `type: \'<x>\'` literal under lib/server/ is a rowed frame, a text-stripped frame, a SURFACE_FRAMES frame, or reviewed as not a frame', (t) => {
  const { missing, found } = frameCensus(serverFiles());
  assert.deepStrictEqual(missing, [],
    'a frame type no table names goes whole to every socket, remote ones included. Add it to FRAME_RULES (a level; '
    + 'PRIVATE_RULES if it carries private records), TEXT_RULES.frames, or SURFACE_FRAMES in lib/core/remote-policy.js '
    + '— or, if it is not a frame at all, to NOT_FRAMES here with why');
  for (const k of NOT_FRAMES.keys()) assert.ok(found.has(k), `NOT_FRAMES names ${JSON.stringify(k)}, which lib/server/ no longer has — drop it`);
  // Every SURFACE_FRAMES entry is still sent somewhere under lib/.
  const lib = serverFiles(path.join(REPO_ROOT, 'lib'));
  const sent = new Set();
  for (const file of lib) for (const m of fs.readFileSync(file, 'utf8').matchAll(ANY_TYPE_RE)) sent.add(m[2]);
  for (const f of SURFACE_FRAMES) assert.ok(sent.has(f), `SURFACE_FRAMES names '${f}', which nothing under lib/ sends`);
  assert.ok(Object.isFrozen(SURFACE_FRAMES));
  for (const f of SURFACE_FRAMES) {
    assert.ok(!f.startsWith('mirror:') && !f.startsWith('element:'), `${f}: a mirror or element frame is never sent whole`);
    assert.ok(!FRAME_RULES.some((r) => r.type === f) && !Object.hasOwn(TEXT_RULES.frames, f), `${f}: in one table only`);
  }
  // The scan is live: a planted element frame in a scratch copy is reported.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-frame-census-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'planted.js');
  fs.writeFileSync(planted, "bus.emit({ ws: { type: 'element:x', elements: [] } });\nbus.emit({ ws: { type: 'render' } });\n");
  assert.deepStrictEqual(frameCensus([planted]).missing.map((l) => l.split(' ')[0]), ['element:x']);
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
    // The surface's frames that carry pins, elements or a pin's text (the
    // annotation engine's row kind): a level, and on the queue's the item key
    // TEXT_RULES.items strips below read.
    { type: 'queue', level: 'basic', item: 'item' },
    // The transient marks (U313; ruling E3 a): from read up, like the comments.
    { type: 'marks', level: 'read' },
    // One per built-in element type (lib/core/element-policy), at its `see`:
    // the comment's pins ride element:comment (U327a).
    { type: 'element:box-grab', level: 'read' },
    { type: 'element:comment', level: 'read' },
    { type: 'element:highlight', level: 'read' },
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

// The transient marks (U313; ruling U313@marks-remote-level = a): the frame
// from `read` up, whole; hello and reset carry the sets only from `read` up.
test('marks: the frame reaches local, read and full whole and basic not at all; hello and reset lose `marks` below read', () => {
  const { projectSnapshot } = require('../lib/core/remote-policy');
  const marks = [{ mount: 'p1', kind: 'failing', label: 'row 3 fails', anchor: { selector: 'tr', text: 'row 3' } }];
  const frame = Object.freeze({ type: 'marks', owner: 'service:t', marks });
  assert.equal(projectFrame(frame, 'local'), frame);
  for (const level of ['read', 'full']) assert.deepStrictEqual(projectFrame(frame, level), frame, level);
  for (const level of ['basic', 'nonsense']) assert.equal(projectFrame(frame, level), null, level);
  for (const type of ['hello', 'reset']) {
    const snap = { type, lock: null, elements: [], surface: 1, marks: [{ owner: 'service:t', marks }] };
    assert.equal(projectSnapshot(snap, 'local'), snap, `${type}: local`);
    assert.ok(!('marks' in projectSnapshot(snap, 'basic')), `${type}: no marks below read`);
    for (const level of ['read', 'full']) assert.deepStrictEqual(projectSnapshot(snap, level).marks, snap.marks, `${type}: ${level}`);
  }
});

test('projectFrame: a surface frame with no row passes at every level, untouched; a mirror or element type with no row reaches only local', () => {
  const lock = { type: 'lock', lock: { message: 'the prompt' } };
  const render = { type: 'render', id: 'p1', html: '<p>x</p>' };
  for (const level of ['basic', 'read', 'full', 'local', 'nonsense', undefined]) {
    assert.equal(projectFrame(lock, level), lock, `${level}: the frame itself (TEXT_RULES is a separate pass)`);
    assert.equal(projectFrame(render, level), render, `${level}: a surface frame`);
  }
  assert.equal(projectFrame(null, 'basic'), null);
  const future = { type: 'mirror:future', text: 'anything' };
  assert.equal(projectFrame(future, 'local'), future);
  for (const level of ['basic', 'read', 'full']) assert.equal(projectFrame(future, level, 'full'), null, level);
  // 1B.2: an element frame no row names goes to local sockets only.
  const unknown = { type: 'element:unknown', elements: [{ id: 'e1', shared: true, text: 'a note' }] };
  assert.equal(projectFrame(unknown, 'local'), unknown);
  for (const level of ['basic', 'read', 'full', 'nonsense']) assert.equal(projectFrame(unknown, level), null, level);
});

// Deep-frozen fixtures: a projection that mutated its input would throw.
const frozen = (o) => {
  if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(frozen); }
  return o;
};
const SHARED_PIN = { id: 'c1', seq: 1, shared: true, text: 'a shared note', anchor: { mount: 'm1' } };
const PRIVATE_PIN = { id: 'c2', seq: 2, shared: false, text: 'wc-private-mark', anchor: { mount: 'm1' }, replies: [{ author: 'user', text: 'wc-private-mark too' }] };

test('projectFrame: the comment frame (element:comment, U327a) — local whole (the same object), read and full without private pins, basic nothing', () => {
  const frame = frozen({ type: 'element:comment', elements: [SHARED_PIN, PRIVATE_PIN] });
  assert.equal(projectFrame(frame, 'local'), frame, 'a local socket: the frame itself');
  for (const level of ['read', 'full']) {
    const out = projectFrame(frame, level);
    assert.deepStrictEqual(out, { type: 'element:comment', elements: [SHARED_PIN] }, level);
    assert.notEqual(out, frame, `${level}: a copy`);
    assert.equal(out.elements[0], SHARED_PIN, `${level}: what is kept is shared, not copied`);
  }
  for (const level of ['basic', 'nonsense', undefined]) assert.equal(projectFrame(frame, level), null, String(level));
  const allShared = frozen({ type: 'element:comment', elements: [SHARED_PIN] });
  assert.equal(projectFrame(allShared, 'read'), allShared, 'nothing private: the frame itself');
  const empty = frozen({ type: 'element:comment', elements: [] });
  assert.equal(projectFrame(empty, 'full'), empty);
});

const COMMENT_ITEM = { id: 'q1', kind: 'comment', source: 'browser', comment_id: 'c1', why_wake: 'comment pinned for Claude',
  summary: 'm1 · "a shared note"', origin_mount: 'm1', seq: 1, staged: true };
const CAPTURE_ITEM = { id: 'q2', kind: 'capture', source: 'extension', capture_id: 'cap1', summary: 'example.test · a page', staged: true };

test('projectFrame: a queue frame — a comment item\'s text is a label below read; every other item, and read and up, the frame itself', () => {
  const add = frozen({ type: 'queue', op: 'add', item: COMMENT_ITEM, count: 1 });
  for (const level of ['local', 'read', 'full']) assert.equal(projectFrame(add, level), add, level);
  const basic = projectFrame(add, 'basic');
  assert.deepStrictEqual(basic, { type: 'queue', op: 'add', count: 1,
    item: { ...COMMENT_ITEM, summary: 'm1 · comment', text_hidden: true } });
  assert.ok(!JSON.stringify(basic).includes('a shared note'));
  const update = frozen({ type: 'queue', op: 'update', id: 'q1', item: COMMENT_ITEM, staged: true, count: 1 });
  assert.equal(projectFrame(update, 'basic').item.summary, 'm1 · comment');
  const capture = frozen({ type: 'queue', op: 'add', item: CAPTURE_ITEM, count: 2 });
  for (const level of ['local', 'full', 'read', 'basic']) assert.equal(projectFrame(capture, level), capture, `${level}: a capture item`);
  const remove = frozen({ type: 'queue', op: 'remove', ids: ['q1'], reason: 'removed', count: 0 });
  assert.equal(projectFrame(remove, 'basic'), remove, 'no item: nothing to strip');
  assert.equal(projectFrame(add, 'nonsense'), null, 'an unknown level meets nothing');
});

test('projectFrame: an element frame — its row\'s level, private records only to local', () => {
  const frame = frozen({ type: 'element:comment', op: 'add',
    elements: [{ id: 'e1', shared: true, text: 'kept' }, { id: 'e2', shared: false, text: 'wc-private-mark' }] });
  assert.equal(projectFrame(frame, 'local'), frame);
  for (const level of ['read', 'full']) {
    assert.deepStrictEqual(projectFrame(frame, level), { type: 'element:comment', op: 'add', elements: [{ id: 'e1', shared: true, text: 'kept' }] }, level);
  }
  assert.equal(projectFrame(frame, 'basic'), null);
  const plain = frozen({ type: 'element:highlight', op: 'add', elements: [{ id: 'h1', shared: true }] });
  assert.equal(projectFrame(plain, 'read'), plain, 'nothing private: the frame itself');
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
    // hello and reset: their lean element rows too (U304), and the transient
    // marks (U313), whole below read.
    frames: { hello: [...LOCK_PATHS, 'elements', 'marks'], reset: [...LOCK_PATHS, 'elements', 'marks'], lock: LOCK_PATHS, 'node-added': ['node.trigger_summary'] },
    routes: {
      'GET /api/graph': ['nodes[].trigger_summary', 'nodes[].absorbed[].trigger_summary', ...LOCK_PATHS],
      // Spec §5.3's, plus `folded[].error`: §3.2 gives folded turns the error
      // text the spec already strips from the trigger.
      // And the node's element rows, whole (K.2-117): every anchor carries
      // pane text, as hello's and reset's `elements` do.
      'GET /api/graph/node/:id': [...NODE_PATHS, 'comments', 'lean_elements'],
      // The routes the spec's list missed, each a carrier the U05 review found
      // (ruling Q2: no conversation text below `read`): the preview document
      // embeds the whole node, a pane's history names each version's prompt,
      // the replay path captions every step, and /api/health reports the raw
      // lock.
      'GET /preview/node/:id': [...NODE_PATHS, 'comments'],
      'GET /api/mounts/:id/history': ['versions[].trigger_summary'],
      'GET /api/replay/path': ['steps[].prompt', 'steps[].reply', 'steps[].summary',
        'steps[].folded[].prompt', 'steps[].folded[].reply', 'steps[].folded[].summary'],
      'GET /api/health': LOCK_PATHS,
      // The ring (K.2-117): a comment entry's whole pin, for the network peer
      // a WEB_CHAT_HOST bind lets reach the daemon at basic.
      'GET /api/events': ['events[].pin'],
    },
    // A queue item's own text by kind (the annotation engine, finding 3): a
    // comment item quotes its pin.
    items: { comment: ['summary'], element: ['summary'] },
  });
});

test('stripItemText: below read a comment item is a text-free label with text_hidden; anything else, or read and up, the item itself', () => {
  const item = frozen({ ...COMMENT_ITEM });
  for (const level of ['read', 'full', 'local']) assert.equal(stripItemText(item, level), item, level);
  for (const level of ['basic', 'nonsense', undefined]) {
    assert.deepStrictEqual(stripItemText(item, level), { ...COMMENT_ITEM, summary: 'm1 · comment', text_hidden: true }, String(level));
  }
  const noMount = frozen({ ...COMMENT_ITEM, origin_mount: null, summary: '"a page-level note"' });
  assert.deepStrictEqual(stripItemText(noMount, 'basic'), { ...noMount, summary: 'comment', text_hidden: true });
  const capture = frozen({ ...CAPTURE_ITEM });
  assert.equal(stripItemText(capture, 'basic'), capture, 'a capture item names a page, not the conversation');
  for (const v of [null, undefined, 'x', 3, frozen({ summary: 'no kind' })]) assert.equal(stripItemText(v, 'basic'), v);
  assert.equal(item.summary, COMMENT_ITEM.summary, 'never mutated');
});

test('PRIVATE_RULES: the one table of where private records ride — frames and routes; frozen; every key a rowed frame or a mounted route', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(PRIVATE_RULES)), {
    frames: {
      'element:box-grab': ['elements[]'],
      'element:comment': ['elements[]'],
      'element:highlight': ['elements[]'],
      // The full-surface frames' lean rows (U304), applied by projectSnapshot.
      hello: ['elements[]'],
      reset: ['elements[]'],
    },
    routes: {
      'GET /api/elements': ['elements[]'],
      'GET /api/graph/node/:id': ['comments[]', 'lean_elements[]'],
      'GET /preview/node/:id': ['comments[]'],
      'GET /api/graph/diff': ['elements.added[]', 'elements.removed[]', 'elements.changed[]', 'elements.orphaned[]'],
    },
  });
  const frozenDeep = (o) => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(frozenDeep));
  assert.ok(frozenDeep(PRIVATE_RULES));
  const rowed = new Set(FRAME_RULES.map((r) => r.type));
  const { SNAPSHOT_FRAMES } = require('../lib/core/remote-policy');
  for (const t of Object.keys(PRIVATE_RULES.frames)) {
    assert.ok(rowed.has(t) || SNAPSHOT_FRAMES.includes(t),
      `${t}: a frame PRIVATE_RULES filters has a FRAME_RULES row (projectFrame applies it there) or is a full-surface frame (projectSnapshot applies it)`);
  }
  const routes = new Set(daemonRoutes().map((r) => `${r.method} ${r.path}`));
  for (const k of Object.keys(PRIVATE_RULES.routes)) assert.ok(routes.has(k), `${k} is not a route in lib/server/routes/`);
});

test('dropPrivate: every shared:false element off the listed lists, copy-on-write; nothing to drop, the value itself', () => {
  const body = frozen({ elements: [SHARED_PIN, PRIVATE_PIN], next_cursor: 2, respond_hint: 'h' });
  const out = dropPrivate('routes', 'GET /api/elements', body);
  assert.deepStrictEqual(out, { elements: [SHARED_PIN], next_cursor: 2, respond_hint: 'h' });
  assert.equal(out.elements[0], SHARED_PIN);
  const node = frozen({ id: 'n1', mounts: [], comments: [PRIVATE_PIN, { ...SHARED_PIN, shared: undefined }] });
  assert.deepStrictEqual(dropPrivate('route', 'GET /api/graph/node/:id', node).comments, [{ ...SHARED_PIN, shared: undefined }],
    'only shared === false is private');
  const none = frozen({ id: 'n1', mounts: [] });
  assert.equal(dropPrivate('routes', 'GET /preview/node/:id', none), none, 'no `comments`: the same object');
  const notList = frozen({ elements: 'x' });
  assert.equal(dropPrivate('routes', 'GET /api/elements', notList), notList);
  const shared = frozen({ type: 'element:comment', elements: [SHARED_PIN] });
  assert.equal(dropPrivate('frames', 'element:comment', shared), shared);
  assert.deepStrictEqual(dropPrivate('frame', 'element:comment', frozen({ type: 'element:comment', elements: [PRIVATE_PIN, 7, null] })),
    { type: 'element:comment', elements: [7, null] }, 'a non-object element is never private');
  const other = frozen({ type: 'render', comments: [PRIVATE_PIN] });
  assert.equal(dropPrivate('frames', 'render', other), other, 'a key with no entry: the value itself');
  assert.throws(() => dropPrivate('bodies', 'GET /api/elements', body), TypeError);
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
  // The node's element rows (K.2-117): the node read's comments and lean
  // rows, the preview's comments, whole (test/remote-policy-text-routes).
  const pinned = { ...node, comments: [{ id: 'c1', text: 't', anchor: { v: 1 } }], lean_elements: [{ id: 'c1', anchor: { v: 1 } }] };
  assert.deepStrictEqual(stripText('route', 'GET /api/graph/node/:id', pinned), bareNode);
  assert.deepStrictEqual(stripText('routes', 'GET /preview/node/:id', pinned), { ...bareNode, lean_elements: pinned.lean_elements },
    'the preview route builds no lean rows: it names none');
  // The ring: a comment entry's pin; nothing else of any entry.
  const ring = { events: [{ seq: 1, kind: 'comment', op: 'add', pin: { id: 'c1', text: 't' } }, { seq: 2, kind: 'element', id: 'h1', v: 1 }], gap: false };
  assert.deepStrictEqual(stripText('routes', 'GET /api/events', ring),
    { events: [{ seq: 1, kind: 'comment', op: 'add' }, ring.events[1]], gap: false });

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
