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
// (the spawn lock, the ring's resend rule).

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

test('the pending list the docs name is test/remote-policy.test.js\'s CONNECTED_PENDING, and anchor-stats waits in it', () => {
  const src = read('test/remote-policy.test.js');
  assert.match(src, /const CONNECTED_PENDING = Object\.freeze\(\[/);
  assert.match(src, /route: 'GET \/api\/elements\/anchor-stats'/);
  assert.ok(read('docs/extending.md').includes('in the pending list (CONNECTED_PENDING in test/remote-policy.test.js), and a hub viewer is refused one until its row is agreed in table_version 2'));
  assert.ok(flat(unreleased()).includes('a route added since its table_version 1 waits in the pending list, refused for a hub viewer, until its row is agreed'));
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
  assert.doesNotMatch(sec, /--manual|pair-only|A-06\.4/, 'no pair-only mode is promised');
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
