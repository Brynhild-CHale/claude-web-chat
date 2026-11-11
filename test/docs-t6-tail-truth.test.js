'use strict';
// Tranche 6's tail documentation (U791): the connector and the daemon halves,
// each claim held to the code it describes (test/docs-t5-tail-truth.test.js's
// method: docs read as text; ES modules in public/app are never imported).
//
// The rulings this text carries: MOUNT@id-grammar (a) — render and
// use_component refuse a new id outside [A-Za-z0-9_-]; C-03.23a's by=;
// HINTS@words (U745's strings, quoted from lib/core/remote-policy.js, never
// re-worded); REQ@connector-mode (A3, a) — manual mode, connector mode not in
// alpha.7; REQ@prerelease-tag (A8, a) — no version or dated heading;
// REQ@csp-alpha8 (A9, a); ROUTES@table-version (B3, a) — the pending list;
// S4's two widenings (U742@reports-remote-relayed (b) at full;
// U725@tool-names-scope (b)); PAGE@hygiene-rules-text (a); hand fold 12's C8
// (the spawn lock, the ring's resend rule). U792 (hand fold 15, form 4): the
// corrective wave's words (--pair-only, the loopback hosts, the revoked hint,
// the spawn lock's callers, the tool class) and ROUTES@as-built (a), D1: the
// routes added since table_version 1 as the build serves them. U793: the build
// ships table_version 2 (A-04.2), and the pending list is empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { read, mcpTools } = require('../test-support/doc-truth');
const { PORTAL_PROTOCOL_VERSION, SCHEMA_VERSION } = require('../lib/core/versions');
const { PAGE_ITEM_RE, PAGE_ITEM_MAX } = require('../lib/core/strokes');
const { badIdReject, BAD_ID_HINT, refusesNewId } = require('../lib/server/domain/mounts');
const policy = require('../lib/core/remote-policy');
const envelope = require('../lib/channel/envelope');
const { ROWS } = require('../lib/connector/cli');
const setup = require('../lib/setup/connector');
const { LINGER_HINT } = require('../lib/connector/install');
const { claudeToolNames } = require('../lib/setup/registration');

const RULES = ['.claude/rules/web-chat.md', 'templates/rules/web-chat.md'];
const flat = (s) => s.replace(/\s+/g, ' ');

function unreleased() {
  const text = read('CHANGELOG.md');
  const start = text.indexOf('## [Unreleased]');
  assert.ok(start >= 0, 'CHANGELOG.md has an [Unreleased] section');
  const next = text.indexOf('\n## [', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function section(rel, heading) {
  const text = read(rel);
  const at = text.indexOf(`\n${heading}\n`);
  assert.ok(at >= 0, `${rel} has the section ${heading}`);
  const next = text.indexOf('\n## ', at + heading.length + 1);
  return text.slice(at, next < 0 ? undefined : next);
}

// ── the rules ──────────────────────────────────────────────────────────────

test('the two rules files are byte-identical and still name 24 tools', () => {
  assert.equal(read(RULES[0]), read(RULES[1]));
  assert.equal(mcpTools().length, 24);
  for (const rel of RULES) assert.match(read(rel), /the 24 tools above are unchanged/);
});

test('the mount id sentence matches the grammar, the length, the envelope and the hint U763 refuses with', () => {
  assert.equal(PAGE_ITEM_RE.source, '^[A-Za-z0-9_-]+$', 'letters, digits, - and _');
  assert.equal(PAGE_ITEM_MAX, 256);
  const r = badIdReject('a b');
  assert.deepEqual(Object.keys(r).sort(), ['bad_id', 'hint', 'id', 'ok', 'rejected']);
  assert.equal(r.ok, false);
  assert.equal(r.bad_id, true);
  assert.equal(r.hint, BAD_ID_HINT);
  assert.equal(refusesNewId({ mounts: new Map() }, 'a.b'), true, 'a new id outside the grammar');
  assert.equal(refusesNewId({ mounts: new Map() }, 'x'.repeat(PAGE_ITEM_MAX + 1)), true, 'a new id too long');
  assert.equal(refusesNewId({ mounts: new Map([['a.b', {}]]) }, 'a.b'), false, 'a live id keeps its pane');
  // The gate sits on render and use_component, and only there.
  assert.match(read('lib/server/routes/render.js'), /refusesNewId\(state, id\)\) return res\.json\(badIdReject\(id\)\)/);
  assert.match(read('lib/server/routes/components.js'), /refusesNewId\(state, id\)\) return res\.json\(badIdReject\(id\)\)/);
  for (const rel of RULES) {
    const body = read(rel);
    assert.ok(body.includes(`A new id outside letters, digits, \`-\` and \`_\`, or longer than ${PAGE_ITEM_MAX} characters, is refused there too, with \`{ok:false, bad_id:true, hint}\``), `${rel}: the refusal`);
    assert.ok(body.includes(`the hint "${BAD_ID_HINT}"`), `${rel}: the hint, quoted as the code words it`);
    assert.ok(body.includes('a pane already live under such an id keeps it.'), `${rel}: the grandfather`);
    const at = body.indexOf('**The shell\'s own element ids are reserved.**');
    assert.ok(at >= 0 && body.indexOf('bad_id:true', at) > at && body.indexOf('bad_id:true', at) < body.indexOf('\n', at), `${rel}: the sentence rides the reserved-ids bullet`);
  }
});

test('the by= sentence names the "Pushed from:" line and the marker as lib/channel/envelope.js writes them', () => {
  const wake = JSON.stringify(envelope.wakeEnvelope([{ kind: 'signal', summary: 'x', id: 'q1' }], { origin: 'remote', by: 'Ann' }));
  assert.ok(wake.includes('Pushed from: origin=remote by=Ann'), 'the push line carries by=<name>');
  const block = envelope.messageBlock({ kind: 'message', msg_id: 'm-0123abcd', text: 'hi', by: 'Ann' });
  assert.match(block, /^Message from the user \[web-chat message m-0123abcd\] by=Ann:\n/, 'after the message marker');
  for (const rel of RULES) {
    assert.ok(read(rel).includes('A push or a message relayed from the hub may carry `by=<name>`, the display name the hub account chose, in the `Pushed from:` line and after the message marker: attribution only, never an approval.'), `${rel}: the by= sentence`);
  }
});

test('the hints line matches U745\'s three connected strings: the sharing and the ceiling, or not through the hub, never a host command', () => {
  for (const hint of [policy.CONNECTED_MIRROR_HINT, policy.CONNECTED_MIRROR_FULL_HINT]) {
    assert.match(hint, /on the hub, and this machine's ceiling must allow it$/);
  }
  assert.match(policy.CONNECTED_DESTRUCTIVE_HINT, /not available through the hub$/);
  for (const hint of [policy.CONNECTED_MIRROR_HINT, policy.CONNECTED_MIRROR_FULL_HINT, policy.CONNECTED_DESTRUCTIVE_HINT]) {
    assert.doesNotMatch(hint, /claude-web-chat|`/, 'a connected hint names no host command');
  }
  assert.equal(policy.hintFor('read', { connected: true }), policy.CONNECTED_MIRROR_HINT);
  assert.equal(policy.hintFor('full', { connected: true }), policy.CONNECTED_MIRROR_FULL_HINT);
  const line = 'a refusal a hub viewer meets names the hub\'s sharing and this machine\'s ceiling, or says the action is not available through the hub, never a host command.';
  for (const rel of RULES) assert.ok(read(rel).includes(line), `${rel}: the hints line`);
  assert.ok(flat(read('docs/guide.md')).includes('Through the hub, a refusal names the hub\'s sharing and this machine\'s ceiling, or says the action is not available through the hub, never a host command.'));
});

test('S4: a relayed viewer at full may report where its elements resolved, as reports-remote.js checks', () => {
  const src = read('lib/server/domain/reports-remote.js');
  assert.ok(src.includes('if (peer !== \'remote\' && peer !== \'relayed\') return refuse(kit, res, 403, \'local\', LOCAL_HINT);'), 'the peer check admits relayed beside remote');
  assert.ok(src.includes('if (level !== \'full\') return refuse(kit, res, 403, \'mirror\', ANSWER_HINT);'), 'at full only');
  for (const rel of RULES) {
    assert.ok(read(rel).includes('A viewer the hub relays at full reports where its annotations resolved, as a remote viewer at full through the tunnel does.'), `${rel}: the relayed report`);
  }
  assert.ok(flat(read('docs/guide.md')).includes('A viewer the hub relays at full may report where its annotations resolved, as a remote viewer at full through the tunnel may; a relayed request stamped read, or not stamped, is refused.'));
});

test('S4: machine facts carry the enabled plugins\' MCP server and skill names, names only, as claudeToolNames reads them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u791-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  w('.claude.json', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'never-a-name-1234' } } } }));
  w('skills/my-skill/SKILL.md', '---\nname: my-skill\n---\n');
  w('settings.json', JSON.stringify({ enabledPlugins: { 'acme@market': true, 'quiet@market': false } }));
  const acme = path.join(dir, 'plugins', 'cache', 'acme');
  const quiet = path.join(dir, 'plugins', 'cache', 'quiet');
  w('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'acme@market': [{ scope: 'user', installPath: acme }], 'quiet@market': [{ scope: 'user', installPath: quiet }] } }));
  w('plugins/cache/acme/.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }));
  w('plugins/cache/acme/skills/lint/SKILL.md', '---\nname: lint\n---\n');
  w('plugins/cache/quiet/.mcp.json', JSON.stringify({ mcpServers: { hidden: { command: 'x' } } }));
  const tier = {
    claudeJson: path.join(dir, '.claude.json'),
    claudeSkillsDir: path.join(dir, 'skills'),
    claudeSettings: path.join(dir, 'settings.json'),
    installedPlugins: path.join(dir, 'plugins', 'installed_plugins.json'),
    pluginsDir: path.join(dir, 'plugins'),
  };
  const names = claudeToolNames({ claudePaths: tier });
  assert.deepEqual(names, { mcp_servers: ['github', 'plugin:acme:db'], skills: ['acme:lint', 'my-skill'] }, 'the user scope and the ENABLED plugins, names only');
  assert.doesNotMatch(JSON.stringify(names), /gh-mcp|db-mcp|never-a-name|hidden/);
  for (const rel of RULES) {
    assert.ok(read(rel).includes('The machine\'s facts tell the hub the enabled plugins\' MCP server and skill names, names only.'), `${rel}: the plugin names line`);
  }
  assert.ok(flat(read('docs/guide.md')).includes('The machine\'s facts tell the hub the MCP server and skill names Claude Code has at user scope and those of the enabled plugins: names only, never a server\'s command or settings.'));
});

test('the page-hygiene paragraph is under Render etiquette, after the stale-mounts bullet, word for word in both rules files', () => {
  const para = '- **The page is the working surface, not the archive** — the graph and `export` are the archive. Clear a decision pane the moment its answer is recorded, replace a status row when its subject closes, and keep the page to current work and open asks. A turn that adds to a page already carrying content starts with `list_mounts` and clears what is stale before it adds; if the page is the only record of something, `export` the node first.';
  for (const rel of RULES) {
    const body = read(rel);
    const stale = '- `clear` mounts that are stale — but only after capturing anything the user provided.\n';
    assert.ok(body.includes(stale + para + '\n'), `${rel}: the paragraph right after the stale-mounts bullet`);
    assert.ok(body.indexOf(para) > body.indexOf('## Render etiquette'), `${rel}: under Render etiquette`);
  }
  assert.ok(flat(unreleased()).includes('one paragraph under Render etiquette saying the page is the working surface, not the archive'), 'the changelog names it');
});

// ── extending.md and CLAUDE.md ─────────────────────────────────────────────

function dependencyDirection() {
  const src = read('test/dependency-direction.test.js');
  const set = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
    assert.ok(m, `dependency-direction.test.js no longer declares ${name} — re-point this check`);
    return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  };
  return { src, ENTRY: set('ENTRY'), SHARED: set('SHARED') };
}

test('the connector is ENTRY and the relay SHARED, as dependency-direction declares, and the docs say so with its three baseline rows', () => {
  const { src, ENTRY, SHARED } = dependencyDirection();
  assert.ok(ENTRY.includes('connector'));
  assert.ok(SHARED.includes('relay'));
  const ext = read('docs/extending.md');
  const diagram = ext.slice(ext.indexOf('entry points       cli/*'), ext.indexOf('lib/client/        the one daemon HTTP client'));
  assert.match(diagram.slice(0, diagram.indexOf('import ↓ only')), /connector\/\*/, 'the diagram puts connector/* among the entry points');
  assert.match(diagram.slice(diagram.indexOf('shared libraries')), /relay\/\*/, 'and relay/* among the shared libraries');
  const claude = read('CLAUDE.md');
  assert.ok(claude.includes('The hub connector, `lib/connector`, is an ENTRY point and `lib/relay` (the relay code it shares with the portal) is SHARED'));
  for (const edge of [
    'lib/cli/commands/connect.js => lib/connector/index.js',
    'lib/cli/commands/connect.js => lib/connector/local-socket.js',
    'lib/connector/chats.js => lib/server/git-run.js',
  ]) {
    assert.ok(src.includes(`'${edge}':`), `${edge} is a BASELINE row`);
    assert.ok(ext.includes(`\`${edge}\``), `extending.md names ${edge}`);
    assert.ok(claude.includes(`\`${edge}\``), `CLAUDE.md names ${edge}`);
  }
  assert.ok(src.includes('\'connect run is the CLI face of the connector process\''), 'the reason as the file holds it');
  assert.ok(claude.includes('("connect run is the CLI face of the connector process")'));
  assert.match(src, /'lib\/server\/git-run\.js': \{\s*importer: 'lib\/connector\/chats\.js',\s*process: 'the hub connector',\s*bare: \['child_process', 'fs'\],\s*files: \[\],/, 'the pin');
  for (const doc of [ext, claude]) assert.ok(doc.includes('`{bare: [\'child_process\', \'fs\'], files: []}`'), 'the pin as the docs write it');
});

test('every tranche-6 engine has its row in extending.md and CLAUDE.md', () => {
  const ext = read('docs/extending.md');
  const claude = read('CLAUDE.md');
  for (const mod of [
    'lib/relay', 'lib/connector', 'lib/connector/cli.js', 'lib/setup/connector.js', 'lib/connector/local-socket.js',
    'lib/connector/exec.js', 'lib/core/claude-cli.js', 'lib/core/connected-policy.js', 'lib/server/relay-credential.js',
    'lib/server/host-mask.js', 'lib/server/domain/mounts.js', 'lib/server/ws.js', 'lib/connector/ring.js',
  ]) {
    assert.ok(ext.includes(`| \`${mod}\``) || ext.includes(`· \`${mod}\``), `extending.md has a row for ${mod}`);
    assert.ok(claude.includes(`\`${mod}\``), `CLAUDE.md names ${mod}`);
  }
  for (const name of ['sessionCommand', 'refusesNewId', 'badIdReject', 'hostMaskBelowLocal', 'WEB_CHAT_FIRST_PORT', 'takeRelaySecret', 'askConnector', 'anchorStats', 'classifySession']) {
    assert.ok(ext.includes(name), `extending.md names ${name}`);
    assert.ok(claude.includes(name), `CLAUDE.md names ${name}`);
  }
});

test('the walk seam\'s reserved ports and its one reader are what the docs say', () => {
  const src = read('lib/server/index.js');
  assert.ok(src.includes('const isReservedWalkPort = (p) => p === 5170 || p === 5171 || (p >= 5173 && p <= 5272);'));
  assert.ok(src.includes('process.env.WEB_CHAT_FIRST_PORT'));
  assert.ok(read('docs/extending.md').includes('a set walk never lands on 5170, 5171 or 5173–5272'));
});

// ROUTES@as-built (a), form 4 D1 (U792), moved by U793: the build ships
// table_version 2 (A-04.2). Its three host_only rows are refused by the
// connector; the other seven routes added since version 1 fall under its
// wildcard rows and reach the daemon at the level the daemon checks; the
// pending list is empty, and the ratchet holds it empty.
function pendingBody() {
  const src = read('test/remote-policy.test.js');
  const at = src.indexOf('const CONNECTED_PENDING = Object.freeze([');
  assert.ok(at >= 0, 'remote-policy.test.js declares CONNECTED_PENDING');
  return src.slice(at, src.indexOf(']);', at) + 3);
}

test('the routes added since table_version 1 are served as version 2 decides: three refused host only by the connector, seven admitted by a version 1 wildcard row; the pending list is empty (D1 a, A-04.2)', () => {
  const connected = require('../lib/core/connected-policy');
  assert.equal(connected.TABLE_VERSION, 2, 'the shipped table is version 2');
  assert.equal(connected.TABLE_SHA256, 'f822fdb2a1392bfc1fa0c86b53fef32b15f4905b58eadec7e4b17917e7e8f028');
  assert.equal(pendingBody(), 'const CONNECTED_PENDING = Object.freeze([]);', 'the pending list is empty');
  for (const [m, u, key] of [
    ['GET', '/api/forms/shifts', '* /api/forms/*'],
    ['GET', '/api/elements/anchor-stats', 'GET /api/elements/anchor-stats'],
    ['POST', '/api/elements/x1/picture', 'POST /api/elements/:id/picture'],
  ]) {
    const c = connected.classifySession(m, u);
    assert.deepEqual([c.allow, c.key, c.row.level], [false, key, 'host_only'], `${m} ${u}`);
  }
  const seven = [
    ['GET /api/elements/types/x1/draw.js', 'GET /api/elements/*'], ['GET /api/elements/types/x1/assets/a.png', 'GET /api/elements/*'],
    ['POST /api/elements/x1/glyph', 'POST|PATCH|DELETE /api/elements/*'], ['GET /api/elements/x1/picture', 'GET /api/elements/*'],
    ['POST /api/elements/undo', 'POST|PATCH|DELETE /api/elements/*'], ['GET /app/strokes.js', 'GET /app/*'], ['GET /app/element-assets.js', 'GET /app/*'],
  ];
  for (const [route, row] of seven) {
    const [m, p] = route.split(' ');
    const c = connected.classifySession(m, p);
    assert.deepEqual([c.allow, c.key], [true, row], route);
  }
  // The daemon's own gate still holds the three host only.
  assert.ok(read('lib/server/routes/elements.js').includes('app.get(\'/api/elements/anchor-stats\', audience.requireHost(),'));
  assert.ok(read('lib/server/routes/element-picture.js').includes('app.post(\'/api/elements/:id/picture\', audience.requireHost(),'));
  assert.ok(flat(read('docs/extending.md')).includes('the shipped table is table_version 2 (A-04.2): its three host_only rows (every forms route, GET /api/elements/anchor-stats, POST /api/elements/:id/picture) are refused by the connector before any daemon is reached, and the other seven routes added since table_version 1 are admitted by version 1\'s wildcard rows at the level the daemon checks, its own gate deciding each. The pending list (CONNECTED_PENDING in test/remote-policy.test.js) is empty, and the ratchet holds it empty against the route set pinned at version 2, so a route added later fails until a table version names or admits it'));
  assert.ok(read('CLAUDE.md').includes('the shipped table is table_version 2, whose three host_only rows (every forms route, GET /api/elements/anchor-stats, POST /api/elements/:id/picture) the connector refuses, while the other seven routes added since version 1 reach the daemon under a version 1 wildcard row, the daemon deciding; the pending list is empty and the ratchet holds it empty'));
  const notes = flat(unreleased());
  assert.ok(notes.includes('A hub viewer reaches a route only through the connected route table, and this build ships its table_version 2. Its three host-only rows, `GET /api/elements/anchor-stats`, `POST /api/elements/:id/picture` and every request under `/api/forms/`, are refused by the connector before any daemon is reached; the other seven routes added since table_version 1 fall under version 1\'s wildcard rows and reach the daemon at the level it checks.'));
  for (const doc of [flat(read('docs/extending.md')), flat(read('CLAUDE.md')), notes]) {
    assert.doesNotMatch(doc, /refused one until its row is agreed|refused for a hub viewer, until its row is agreed/, 'the old wording is gone');
    assert.doesNotMatch(doc, /until (?:their rows are agreed in )?table_version 2(?: is agreed)?|nine of the ten|nine fall under/, 'version 1\'s pending wording is gone');
  }
});

test('the spawn lock and the ring\'s resend rule are the code\'s (hand fold 12 C8)', () => {
  const daemon = read('lib/util/daemon.js');
  const spawn = daemon.slice(daemon.indexOf('async function spawnDaemon('));
  const spawnBody = spawn.slice(0, spawn.indexOf('\n}\n'));
  assert.ok(spawnBody.includes('const first = () => adoptOrSpawn(') && spawnBody.includes('registry.withHeldLockFile(lock, first,'), 'spawnDaemon runs the adopt-or-spawn under the root\'s lock');
  assert.ok(spawnBody.includes('const lock = spawnLockFor(root);'), 'the lock is spawnLockFor(root)');
  const under = daemon.slice(daemon.indexOf('async function adoptOrSpawn('));
  const underBody = under.slice(0, under.indexOf('\n}\n'));
  const askAt = underBody.indexOf('await find(root)');
  const waitAt = underBody.indexOf('waitForDaemon(');
  assert.ok(askAt >= 0 && waitAt > askAt, 'under the lock: daemonFor first, then the spawn and its wait');
  const registry = require('../lib/util/registry');
  assert.equal(typeof registry.withHeldLockFile, 'function');
  assert.ok(Number.isInteger(registry.HELD_LOCK_MAX_MS));
  for (const rel of ['docs/extending.md', 'CLAUDE.md']) {
    const doc = flat(read(rel));
    assert.ok(doc.includes('of concurrent first spawns one child binds and'), `${rel}: the lock's sentence`);
    assert.ok(doc.includes('`lib/util/registry` `withHeldLockFile`'), `${rel}: the lock's home`);
  }
  const ring = read('lib/connector/ring.js');
  assert.ok(ring.includes('const held = (st) => linkGen > 0 && st.cursorLink !== linkGen;'), 'held after every ready until the cursor');
  assert.ok(ring.includes('st.cursorLink = linkGen;'), 'setCursor releases the hold');
  assert.ok(flat(read('docs/extending.md')).includes('after every link `ready` each chat\'s ring is held — it sends and re-reads nothing — until that chat\'s `chat.assign` hands its cursor back'));
  assert.ok(flat(read('CLAUDE.md')).includes('held after every link ready until the chat\'s cursor comes back'));
});

// ── the guide ──────────────────────────────────────────────────────────────

test('the guide\'s connect section names exactly the subcommands lib/connector/cli.js registers', () => {
  const sec = section('docs/guide.md', '## Connect this machine to a hub');
  const named = new Set([...sec.matchAll(/`(?:claude-web-chat )?connect ([a-z<][a-z-]*>?)/g)].map((m) => m[1]));
  const want = new Set([...ROWS.map((r) => (r.name === 'pair' ? '<hub-url>' : r.name)), 'help']);
  assert.ok(named.has('install') && sec.includes('There is no `connect install`.'), 'install is named only as the command that does not exist');
  named.delete('install');
  assert.deepEqual([...named].sort(), [...want].sort());
  assert.ok(!ROWS.some((r) => r.name === 'install' || r.name === 'pause'), 'no install or pause row');
  assert.ok(sec.includes('Pause is the hub\'s setting for this machine, not a subcommand'));
  assert.ok(sec.includes('`Connector: not paired`'));
  assert.equal(require('../lib/connector/cli').usageText().includes('connect help'), true);
  // U754's update line names the same `connect <hub-url>`.
  const update = read('lib/cli/commands/update.js');
  assert.ok(update.includes('run `claude-web-chat connect <hub-url>` there'));
  assert.doesNotMatch(update, /connect install/);
});

test('the guide says manual mode, the managed-install rule, the exit after bound and the per-invocation loopback flag', () => {
  const sec = flat(section('docs/guide.md', '## Connect this machine to a hub'));
  assert.ok(sec.includes('Connector mode, where the connector starts a chat\'s session itself under tmux, is not in 0.9.0-alpha.7.'));
  assert.match(read('lib/connector/attach.js'), /connector mode, the tmux launcher,\n\/\/ is alpha\.8's/);
  const install = read('lib/connector/install.js');
  assert.match(install, /describeInstall\(\)\.kind !== 'managed'|kind !== 'managed'/, 'managed installs only');
  assert.ok(sec.includes('It runs only from the managed install'));
  assert.ok(install.includes('d.err(`connect: the service manager did not start the connector (') && /return EXIT\.FAIL;\s*\}\s*io\.event\(\{ event: 'service', kind, unit_path/.test(install), 'a service start that fails exits FAIL after pairing');
  assert.equal(require('../lib/connector/install').EXIT.FAIL, 1);
  assert.ok(sec.includes('`connect <hub-url>` exits 1 after the `bound` line, with the key saved and the record paired'));
  assert.ok(install.includes('It is per invocation and never\n// written anywhere'));
  assert.ok(sec.includes('It holds for that one command and is written nowhere, so the unit it writes cannot run that record: run `claude-web-chat connect run --insecure-loopback` in a terminal.'));
  assert.match(read('lib/connector/run.js'), /the connector reaches it only with --insecure-loopback/);
  assert.equal(require('../lib/connector/install').WAIT_MS, 15000);
  assert.ok(sec.includes('waits up to 15 seconds'));
  assert.doesNotMatch(sec, /--manual|A-06\.4/, 'no other mode is promised');
});

// ── the corrective wave's words (U792: U726b, U718c, U729b, U723e) ─────────

test('--pair-only: the usage, the help row, the closing line and event, as install.js builds them (U726b, C-06.5)', () => {
  const inst = require('../lib/connector/install');
  assert.ok(inst.USAGE.endsWith(' [--pair-only]'));
  assert.equal(inst.parseArgs(['https://hub.example', '--pair-only']).pairOnly, true);
  const src = read('lib/connector/install.js');
  assert.ok(src.includes('Paired; no service installed: run `claude-web-chat connect run` to run the connector in the foreground, '));
  assert.ok(src.includes('+ `or \\`claude-web-chat connect ${origin}\\` to install the start-at-login service later.`;'), 'and connect <hub-url> without the flag');
  assert.ok(src.includes('Paired; no service installed: run `claude-web-chat connect run --insecure-loopback` to run the connector in the foreground.'));
  // A record whose service an earlier run set: the service left as it is, connect status, no foreground connect run (U793).
  const kept = 'Paired; this run installed and changed no service: the start-at-login service installed earlier was left as it is '
    + '(run `claude-web-chat connect status` to see it).';
  assert.ok(src.includes("'Paired; this run installed and changed no service: the start-at-login service installed earlier was left as it is '"));
  assert.ok(src.includes("+ '(run `claude-web-chat connect status` to see it).';"));
  assert.match(src, /if \(record\.service\) \{\s*return 'Paired; this run installed and changed no service/, 'the service case comes first');
  assert.doesNotMatch(kept, /connect run/);
  assert.match(src, /event: 'service',\s*kind: null,\s*pair_only: true,/);
  assert.match(src, /if \(parsed\.pairOnly\) \{\s*pairOnlyClose\(read\.value, io\);\s*return EXIT\.OK;\s*\}\s*\/\/ \(3\) the unit/, 'it stops before step (3)');
  const sec = flat(section('docs/guide.md', '## Connect this machine to a hub'));
  assert.ok(sec.includes('`claude-web-chat connect <hub-url> --pair-only` pairs this machine and stops there. It writes no unit, starts no service and waits for nothing.'));
  assert.ok(sec.includes('With `--json` that line is one `service` event with `kind` null and `pair_only` true.'));
  assert.ok(sec.includes('With `--pair-only` too, the closing line names only that command.'));
  assert.ok(sec.includes('On a machine already paired it pairs nothing and prints that line (with `--workdir`, after the note that the workdir its record names is kept).'));
  assert.ok(src.includes('connect: --workdir is used on the first pairing only; this machine keeps the workdir its record names'), 'the note a paired record\'s --workdir prints before the closing line');
  assert.match(src, /if \(parsed\.workdir\) \{\s*if \(existing\) \{\s*io\.say\(/, 'and it prints before step (2) and the close');
  const help = read('lib/cli/index.js');
  assert.ok(help.slice(help.indexOf('function showHelp()')).includes('(--pair-only: pair, install no service, then use connect run)'));
  assert.ok(flat(unreleased()).includes('`connect <hub-url> --pair-only` pairs and stops there: no unit, no service, and one closing line naming `connect run`'));
  assert.ok(flat(unreleased()).includes('when an earlier run installed the service, the line says it was left as it is and names `connect status` instead.'));
  assert.ok(sec.includes('When an earlier `connect <hub-url>` installed the start-at-login service, the line says instead that this run installed and changed no service and the one installed earlier was left as it is, and names `claude-web-chat connect status`: that service already runs the connector, so it never suggests a second one with `connect run`.'));
});

test('--insecure-loopback admits 127.0.0.1 or localhost only, and no doc names ::1 for it (U726b, F3 a)', () => {
  for (const h of ['http://127.0.0.1:8477', 'http://localhost:8477']) assert.equal(setup.hubOrigin(h, { insecureLoopback: true }), h);
  assert.throws(() => setup.hubOrigin('http://[::1]:8477', { insecureLoopback: true }), (e) => e.code === 'EHUBORIGIN');
  assert.ok(read('lib/connector/install.js').includes('loopback (127.0.0.1 or localhost) only'));
  const sec = flat(section('docs/guide.md', '## Connect this machine to a hub'));
  assert.ok(sec.includes('admits a plain-http hub on this machine\'s loopback (127.0.0.1 or localhost), for development only, and refuses any other host, an IPv6 address among them.'));
  assert.doesNotMatch(sec, /::1/);
  assert.ok(flat(unreleased()).includes('`--insecure-loopback` admits a plain-http hub on 127.0.0.1 or localhost only.'));
  for (const rel of ['CLAUDE.md', 'docs/extending.md', 'docs/platform-support.md', ...RULES]) {
    assert.doesNotMatch(flat(read(rel)), /insecure-loopback[^.]*::1/, `${rel} names ::1 for the loopback flag`);
  }
});

test('the hub\'s revoked hint: `connect run` prints it once, `connect status` says where it is (U726b, F1 a)', () => {
  const run = read('lib/connector/run.js');
  assert.ok(run.includes('d.out(`connect run: the hub says: ${clean(hint)}`);'));
  assert.match(run, /if \(hint && !hintSaid\) \{\s*hintSaid = true;/, 'once');
  assert.match(read('lib/connector/link.js'), /holdsSecret/, 'a hint holding a known secret is withheld');
  const cli = read('lib/connector/cli.js');
  assert.ok(cli.includes('return `  revoked: ${at}; the hub\'s message, if it sent one, is in the connector\'s log (${userPaths().connectorLog}, `'));
  assert.ok(cli.includes('or the terminal of a foreground \\`connect run\\`); pair again with'));
  const sec = flat(section('docs/guide.md', '## Connect this machine to a hub'));
  assert.ok(sec.includes('When the hub revokes this machine with a message for you, `connect run` prints it once as `connect run: the hub says: <message>` (the start-at-login service writes it to the connector\'s log), then releases its holds and stops. A message holding a secret this machine knows is not shown.'));
  assert.ok(sec.includes('For a revoked pairing it adds one `revoked:` line: when the hub revoked it, where the hub\'s message is (the connector\'s log, or the terminal of a foreground `connect run`), and the command that pairs again.'));
  assert.ok(flat(unreleased()).includes('`connect run` prints it once as `connect run: the hub says: <message>`'));
});

test('`open` and `start --daemon` start through the root\'s spawn lock, and the docs name every caller (U718c, D3 a)', () => {
  const start = read('lib/cli/commands/start.js');
  const fn = start.slice(start.indexOf('async function startThroughLock('));
  assert.ok(fn.slice(0, fn.indexOf('\n}\n')).includes('await spawnDaemon(root, {'), 'startThroughLock is spawnDaemon');
  assert.match(start, /await startThroughLock\(root, \{/, 'start --daemon uses it');
  const open = read('lib/cli/commands/open.js');
  assert.ok(open.includes('const { startThroughLock } = require(\'./start\');') && /await startThroughLock\(root, \{/.test(open), 'open uses it');
  assert.match(read('lib/client/index.js'), /daemon\.spawnDaemon\(r\)/);
  assert.match(read('lib/portal/start.js'), /require\('\.\.\/util\/daemon'\)\.spawnDaemon\(/);
  assert.match(read('lib/connector/supervisor.js'), /d\.spawnDaemon\(root, \{/);
  assert.ok(read('docs/extending.md').includes('(the MCP client\'s auto-start, the portal\'s start, the connector\'s supervisor, and `open` and `start --daemon` through `lib/cli/commands/start` `startThroughLock`)'));
  assert.ok(read('docs/extending.md').includes('`spawnDaemon` waits through it, and so do `open` and `start --daemon`, which start through `spawnDaemon`'));
  assert.ok(read('CLAUDE.md').includes('(spawn it once, or adopt the one that won: the MCP client\'s auto-start, the portal\'s start, the connector\'s supervisor, `open` and `start --daemon`)'));
  assert.ok(open.includes('adopted the web-chat server another caller started at'));
  assert.ok(flat(unreleased()).includes('**Two starts of one project\'s server at once start one.** `open` and `start --daemon` now take the project\'s spawn lock'));
});

test('an ask\'s tool_kind is the tool\'s class at the daemon, and a step crosses as a word (U729b, F1 a)', () => {
  const { toolClass, TOOL_KINDS } = require('../lib/core/tool-input');
  assert.equal(toolClass('Bash'), 'Bash');
  assert.equal(toolClass('LSP'), 'Tool', 'a tool the table does not know is Tool');
  assert.ok(TOOL_KINDS.includes('Edit') && TOOL_KINDS.includes('MCP') && TOOL_KINDS.includes('Tool'));
  assert.ok(read('lib/server/domain/asks.js').includes('tool_kind: toolClass(name),'));
  const { cutAsk } = require('../lib/connector/signals');
  const ask = (tool_kind) => cutAsk({ id: 'a1', kind: 'permission', state: 'pending', answerable: true, version: 1, created_at: 1, tool_kind }).tool_kind;
  assert.equal(ask('Bash'), 'bash');
  assert.equal(ask('LSP'), 'tool');
  assert.equal(ask('elicitation'), 'elicitation');
  const sig = read('lib/connector/signals.js');
  assert.ok(sig.includes('const STEP_WORDS = new Set([\'reply\', \'compacting\']);') && sig.includes('out.step_kind = stepWord(row.step_kind);'));
  const notes = flat(unreleased());
  assert.ok(notes.includes('**An ask names the tool\'s class, never its name.** An ask\'s `tool_kind` is now the tool\'s class (`Bash`, `Edit`, `MCP` and the rest), or `Tool` for a tool the table does not know, for every reader'));
  assert.ok(notes.includes('(`elicitation` for an MCP server\'s form), and a chat\'s current step as one too (`bash`, `mcp`, `tool`, `reply`, `compacting`).'));
});

test('a reconciled capture record is sent once: the notes describe no connector resend, so U723e needs no line there (U723e, D5 a)', () => {
  const ring = read('lib/connector/ring.js');
  assert.match(ring, /function queueReconciled\(/, 'the one rule\'s home');
  const notes = flat(unreleased());
  assert.doesNotMatch(notes, /reconciled|after a reconnect|resent after/i, 'if the notes ever describe the connector\'s resend, say a reconciled capture record is sent once');
});

// ── platform-support ───────────────────────────────────────────────────────

test('platform-support\'s unit paths and linger hint are lib/setup/connector.js\'s and install.js\'s', () => {
  const doc = read('docs/platform-support.md');
  const home = os.homedir();
  const paths = setup.unitPaths();
  for (const kind of ['launchd', 'systemd-user']) {
    const tilde = `~/${path.relative(home, paths[kind])}`;
    assert.ok(doc.includes(`\`${tilde}\``), `platform-support names ${tilde}`);
  }
  assert.ok(LINGER_HINT.endsWith('loginctl enable-linger $USER'));
  assert.ok(doc.includes('`loginctl enable-linger $USER`'));
  assert.equal(setup.platformKind('darwin'), 'launchd');
  assert.equal(setup.platformKind('linux', { exists: () => false }), null, 'Linux without systemd: no unit');
  assert.equal(setup.platformKind('win32'), null);
  assert.ok(flat(doc).includes('None: start at login is unavailable, and `claude-web-chat connect run` runs the connector in the foreground'));
  assert.ok(flat(doc).includes('Connector mode, the connector starting sessions itself under tmux, is not in 0.9.0-alpha.7.'));
  assert.ok(flat(doc).includes('(validation gate V34)'));
  assert.match(setup.plistText({ binLink: '/u/.local/bin/claude-web-chat', pathEnv: '/usr/bin:/bin', logFile: '/u/.web-chat/connector/connector.log' }), /\/u\/\.local\/bin\/claude-web-chat/, 'the unit launches through the ~/.local/bin link');
});

// ── the changelog and the versions ─────────────────────────────────────────

test('the Upgrading paragraphs name claude-web-chat/driver, the map holds ./driver, and the driving doc requires it', () => {
  const notes = flat(unreleased());
  assert.ok(notes.includes('`require(\'claude-web-chat/driver\')` is the driver'));
  assert.ok(notes.includes('`require(\'claude-web-chat/lib/driver\')`'));
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.exports && pkg.exports['./driver'], 'the exports map holds ./driver');
  assert.ok(!('./lib/driver' in pkg.exports), 'and not the deep path');
  const driving = read('docs/driving-the-surface.md');
  assert.ok(driving.includes('require(\'claude-web-chat/driver\')'));
  assert.doesNotMatch(driving, /claude-web-chat\/lib\/driver/);
});

test('[Unreleased] carries alpha.7\'s upgrading lines: /exit, the rollback, the kept records, no bump, no migration, 24 tools', () => {
  const notes = flat(unreleased());
  assert.ok(notes.includes('**`/exit` and reopen Claude Code once after installing 0.9.0-alpha.7.**'));
  assert.ok(read('lib/mcp/client.js').includes('WEB_CHAT_SUPERVISED'), 'the knob the line names');
  assert.ok(notes.includes('**Rolling back with a connector paired.**'));
  assert.ok(notes.includes('until `update` removes it or `claude-web-chat connect disconnect` runs'));
  assert.ok(notes.includes('**What 0.9.0-alpha.6 and 0.9.0-alpha.5 keep and ignore.**'));
  assert.ok(notes.includes('The tunnel portal stays on 12'));
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
  assert.ok(notes.includes('the project schema stays 4'));
  assert.equal(SCHEMA_VERSION, 4);
  assert.ok(notes.includes('No MCP tool was added or removed (still 24)'));
  assert.equal(mcpTools().length, 24);
  assert.ok(notes.includes('The surface page\'s Content-Security-Policy stays report-only: the enforced policy waits for 0.9.0-alpha.8.'));
  assert.ok(notes.includes('**`GET /api/elements/anchor-stats`, host only.**'));
  assert.ok(notes.includes('**The relay credential, and the daemon as the second lock (0.9.0-alpha.7).**'));
  const relay = read('lib/server/relay-credential.js');
  assert.ok(relay.includes('const SECRET_FD_VAR = \'WEB_CHAT_RELAY_SECRET_FD\';') && relay.includes('const SECRET_ENV_VAR = \'WEB_CHAT_RELAY_SECRET\';'));
  assert.ok(notes.includes('at the lesser of the stamp and this machine\'s ceiling'));
});

test('REQ@prerelease-tag (a): no version moved and no dated alpha.7 heading', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.8.5');
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, '0.8.5');
  assert.doesNotMatch(read('CHANGELOG.md'), /^## \[0\.9\.0-alpha\.7\]/m);
});
