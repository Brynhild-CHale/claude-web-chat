// `claude-web-chat tunnel mirror on|off|status` (lib/cli/commands/tunnel, spec
// §5.2): the one host act that lets a project's remote viewers see Claude's
// conversation, and `tunnel status`'s mirror column (lib/tunnel/control).
//
// What must hold:
//   * on / on --read-only / off write exactly ONE key for the project (its
//     absolute root), replacing a grant under its instance id or another
//     spelling, keeping every unrelated and unknown key, and leaving 0600.
//   * the project is --project or the cwd through resolveRoot; `on` outside a
//     project is refused; `off --project` takes an absolute path that has no
//     .web-chat/ (a deleted project's grant can still go).
//   * no tunnel.json → the refusal, and no file is created; an unreadable or
//     invalid one is never rewritten (byte-identical), and the error names it.
//   * on prints the exposure warning with the allowlist's size; on and off say
//     the portal and the daemon pick the edit up with no restart.
//   * a running portal follows the CLI's edit: its own mirror refusal comes and
//     goes with the grant (the portal's verdict, not a daemon's answer).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tunnel = require('../lib/cli/commands/tunnel');
const control = require('../lib/tunnel/control');
const { withTempHome, withServer, withPortal, waitUntil, tmpRoot, freePort } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { userPaths } = require('../lib/core/paths');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { sessionHost, normalizeConfig } = require('../lib/tunnel/config');

function capture() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') };
}

function writeConfig(raw) {
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(raw));
  fs.chmodSync(userPaths().tunnelConfig, 0o644); // so the edit's 0600 is the edit's doing
}
const readConfig = () => JSON.parse(fs.readFileSync(userPaths().tunnelConfig, 'utf8'));
const mode = () => fs.statSync(userPaths().tunnelConfig).mode & 0o777;

function project(t) {
  const root = tmpRoot('wc-mirror-cli-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const run = (args, opts = {}) => {
  const c = capture();
  return tunnel(['mirror', ...args], { log: c.log, ...opts }).then((r) => ({ r, c }));
};

// ── the edit ────────────────────────────────────────────────────────────────

test('on, on --read-only and off write exactly one key for the project, keep every other key, and leave 0600', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const other = '/somewhere/else/project';
  const raw = access.config({
    showRoots: true,
    remote: { allowDestructive: true, mirror: { [other]: 'read' }, someFutureKey: { x: 1 } },
    expose: { exclude: ['0a1b2c3d'] },
    unknownTopLevel: ['kept', { as: 'written' }],
  });
  writeConfig(raw);

  const on = await run(['on', '--project', root]);
  assert.equal(on.r.level, 'full');
  assert.equal(on.r.changed, true);
  let file = readConfig();
  assert.deepEqual(file.remote.mirror, { [other]: 'read', [root]: 'full' });
  assert.equal(file.remote.allowDestructive, true);
  assert.deepEqual(file.remote.someFutureKey, { x: 1 });
  assert.deepEqual(file.unknownTopLevel, ['kept', { as: 'written' }]);
  assert.deepEqual(file.expose, raw.expose);
  assert.deepEqual(file.allow, raw.allow);
  assert.equal(file.showRoots, true);
  assert.equal(mode(), 0o600);

  const ro = await run(['on', '--read-only', '--project', root]);
  assert.equal(ro.r.level, 'read');
  assert.equal(ro.r.previous, 'full');
  file = readConfig();
  assert.deepEqual(file.remote.mirror, { [other]: 'read', [root]: 'read' }, 'one key, replaced in place');
  assert.match(ro.c.text(), /\(was full\)/);
  assert.equal(mode(), 0o600);

  const off = await run(['off', '--project', root]);
  assert.equal(off.r.previous, 'read');
  file = readConfig();
  assert.deepEqual(file.remote.mirror, { [other]: 'read' }, 'only this project\'s key goes');
  assert.deepEqual(file.unknownTopLevel, ['kept', { as: 'written' }]);
  assert.equal(mode(), 0o600);

  // off again: nothing to change, nothing written.
  const before = fs.readFileSync(userPaths().tunnelConfig);
  fs.chmodSync(userPaths().tunnelConfig, 0o640);
  const again = await run(['off', '--project', root]);
  assert.equal(again.r.changed, false);
  assert.match(again.c.text(), /has no mirror grant — nothing to change/);
  assert.ok(fs.readFileSync(userPaths().tunnelConfig).equals(before));
  assert.equal(mode(), 0o640, 'an edit that changes nothing touches nothing');
});

test('a grant under the instance id or another spelling of the root is replaced, never left beside the new one', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const id = instanceId(root);

  writeConfig(access.config({ remote: { mirror: { [id.toUpperCase()]: 'read' } } }));
  await run(['on', '--project', root]);
  assert.deepEqual(readConfig().remote.mirror, { [root]: 'full' }, 'the id grant became the root grant');

  writeConfig(access.config({ remote: { mirror: { [`${root}/`]: 'full', [id]: 'full' } } }));
  await run(['on', '--read-only', '--project', root]);
  assert.deepEqual(readConfig().remote.mirror, { [root]: 'read' });

  writeConfig(access.config({ remote: { mirror: { [root.replace(/\//g, '//')]: 'read' } } }));
  const off = await run(['off', '--project', root]);
  assert.equal(off.r.changed, true);
  assert.deepEqual(readConfig().remote, {}, 'remote.mirror goes once it names nothing (the remote the file had stays)');
  normalizeConfig(readConfig());
});

// ── which project ───────────────────────────────────────────────────────────

test('the project is --project, else the installed project at or above the cwd (resolveRoot)', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  writeConfig(access.config());

  const fromCwd = await run(['on'], { cwd: sub });
  assert.equal(fromCwd.r.root, root, 'the cwd walks up to the installed root');
  assert.deepEqual(readConfig().remote.mirror, { [root]: 'full' });

  const relative = await run(['off', '--project', 'src'], { cwd: root });
  assert.equal(relative.r.root, root, 'a relative --project resolves through resolveRoot too');
  assert.equal(readConfig().remote.mirror, undefined);

  const viaSub = await run(['on', '--project', sub]);
  assert.equal(viaSub.r.root, root, '`on --project` names an installed project through resolveRoot');
});

test('an absolute --project names the same project for on, status and off (resolveRoot), unless that path holds its own grant', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  writeConfig(access.config());

  const on = await run(['on', '--project', src]);
  assert.equal(on.r.root, root);
  assert.deepEqual(readConfig().remote.mirror, { [root]: 'full' });

  const status = await run(['status', '--project', src]);
  assert.equal(status.r.project.root, root, 'status walks up to the same installed root on wrote');
  assert.equal(status.r.project.level, 'full');
  assert.ok(status.c.text().includes(`(${root}): the chat mirror is full`), status.c.text());

  const off = await run(['off', '--project', src]);
  assert.equal(off.r.root, root);
  assert.equal(off.r.previous, 'full');
  assert.equal(off.r.changed, true);
  assert.equal(readConfig().remote.mirror, undefined, 'off took away the grant on wrote, not nothing');

  // A deleted nested project under an installed parent: its own path carries
  // the grant, so its own path is what status reads and off removes.
  const nested = path.join(root, 'gone-nested');
  writeConfig(access.config({ remote: { mirror: { [nested]: 'read', [root]: 'full' } } }));
  const nestedStatus = await run(['status', '--project', nested]);
  assert.equal(nestedStatus.r.project.root, nested);
  assert.equal(nestedStatus.r.project.level, 'read');
  const nestedOff = await run(['off', '--project', nested]);
  assert.equal(nestedOff.r.root, nested);
  assert.deepEqual(readConfig().remote.mirror, { [root]: 'full' }, 'only the nested grant went');
});

test('`on` outside a project is a userFacing error; `off --project` takes an absolute path with no .web-chat/', async (t) => {
  const home = withTempHome(t);
  const access = createFakeAccess();
  const gone = path.join(path.dirname(home), 'a-deleted-project-that-never-was');
  writeConfig(access.config({ remote: { mirror: { [gone]: 'full' } } }));
  const bare = fs.mkdtempSync(path.join(path.dirname(home), 'wc-bare-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const before = fs.readFileSync(userPaths().tunnelConfig);

  await assert.rejects(run(['on'], { cwd: bare }), (e) => e.userFacing && /no \.web-chat\//.test(e.message));
  await assert.rejects(run(['on', '--project', gone]), (e) => e.userFacing && /no \.web-chat\//.test(e.message));
  assert.ok(fs.readFileSync(userPaths().tunnelConfig).equals(before), 'a refused on writes nothing');

  const off = await run(['off', '--project', gone]);
  assert.equal(off.r.root, gone);
  assert.equal(off.r.previous, 'full');
  assert.equal(readConfig().remote.mirror, undefined, 'the deleted project\'s grant is gone');
  await assert.rejects(run(['off', '--read-only', '--project', gone]), (e) => e.userFacing && /--read-only/.test(e.message));
});

// ── the file ────────────────────────────────────────────────────────────────

test('no tunnel.json → the refusal, and no file is created', async (t) => {
  withTempHome(t);
  const root = project(t);
  const refusal = 'remote access is not set up; the conversation is local-only — `claude-web-chat tunnel setup` first';
  for (const args of [['on'], ['on', '--read-only'], ['off']]) {
    await assert.rejects(run([...args, '--project', root]), (e) => e.userFacing && e.message === refusal, args.join(' '));
  }
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
  assert.equal(fs.existsSync(userPaths().tunnelDir), false, 'not even its directory');
  const st = await run(['status', '--project', root]);
  assert.equal(st.r.configured, false);
  assert.equal(st.c.text(), refusal);
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
});

test('an unparseable or invalid tunnel.json is left byte-identical, and the error names it', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const file = userPaths().tunnelConfig;
  const bodies = [
    '{ "hostname": "wc.example.test", ',                                                     // torn
    JSON.stringify(access.config({ allow: { emails: [] } })),                                 // empty allowlist
    JSON.stringify(access.config({ remote: { mirror: { [root]: 'everything' } } })),          // a bad level
    JSON.stringify(access.config({ remote: { mirror: 'full' } })),                            // not an object
    '[1, 2, 3]',
  ];
  for (const body of bodies) {
    fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o644);
    for (const args of [['on'], ['on', '--read-only'], ['off'], ['status']]) {
      await assert.rejects(run([...args, '--project', root]),
        (e) => e.userFacing && e.message.includes(file) && /left exactly as it is/.test(e.message), `${args.join(' ')} over ${body}`);
      assert.equal(fs.readFileSync(file, 'utf8'), body, 'byte-identical');
      assert.equal(mode(), 0o644, 'not even re-moded');
    }
  }
});

// ── what it says ────────────────────────────────────────────────────────────

test('on prints the exposure warning with the allowlist\'s size, and on and off say nothing restarts', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const name = path.basename(root);
  writeConfig(access.config({ allow: { emails: ['me@example.com', 'friend@example.com'], domains: [] } }));

  const on = await run(['on', '--project', root]);
  const text = on.c.text();
  assert.ok(text.includes(`Remote viewers of ${name} (2 allowlisted accounts) will see Claude's conversation — prompts, replies, file contents and command output.`), text);
  assert.ok(text.includes('Known secret formats are masked; not every secret has a known format.'), text);
  assert.match(text, /portal applies this within a couple of seconds/);
  assert.match(text, /daemon within about a second — no restart needed/);

  const off = await run(['off', '--project', root]);
  assert.match(off.c.text(), /portal applies this within a couple of seconds/);
  assert.match(off.c.text(), /no restart needed/);
  assert.doesNotMatch(off.c.text(), /Remote viewers of/);

  // One account, and a domain named as one.
  writeConfig(access.config({ allow: { emails: ['me@example.com'], domains: ['example.org'] } }));
  const one = await run(['on', '--read-only', '--project', root]);
  assert.ok(one.c.text().includes(`Remote viewers of ${name} (1 allowlisted account, plus every account at example.org) will see`), one.c.text());
  // It asks nothing: the run finished with no prompt handed in.
  assert.equal(one.r.level, 'read');
});

test('`tunnel mirror status` prints this project\'s level and every grant (and --json)', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const root = project(t);
  const elsewhere = project(t);
  registerInstance({ root: elsewhere, port: 40123, pid: process.pid });
  const eid = instanceId(elsewhere);
  writeConfig(access.config({ remote: { mirror: { [root]: 'read', [eid]: 'full', '/abs/third': 'read' } } }));

  const st = await run(['status'], { cwd: root });
  const text = st.c.text();
  assert.match(text, new RegExp(`\\(${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): the chat mirror is read`));
  assert.match(text, /grants in .*tunnel\.json \(3\):/);
  assert.match(text, new RegExp(`read  ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  \\(this project\\)`));
  assert.ok(text.includes(`full  ${eid}  (${elsewhere})`), text);
  assert.match(text, /read  \/abs\/third$/m);

  const js = await run(['status', '--json', '--project', elsewhere]);
  const parsed = JSON.parse(js.c.text());
  assert.equal(parsed.project.level, 'full');
  assert.equal(parsed.project.root, elsewhere);
  assert.deepEqual(parsed.grants, { [root]: 'read', [eid]: 'full', '/abs/third': 'read' });
  // A grant under the project's instance id is marked as this project's too.
  const byId = (await run(['status', '--project', elsewhere])).c.text();
  assert.ok(byId.includes(`full  ${eid}  (${elsewhere})  (this project)`), byId);
  assert.doesNotMatch(byId, new RegExp(`read  ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  \\(this project\\)`));

  // Outside any project: no level, every grant still listed.
  const bare = fs.mkdtempSync(path.join(path.dirname(userPaths().root), 'wc-bare-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const out = await run(['status'], { cwd: bare });
  assert.equal(out.r.project, null);
  assert.match(out.c.text(), /not in a project/);
  assert.match(out.c.text(), /\(3\):/);

  writeConfig(access.config());
  const none = await run(['status', '--project', root]);
  assert.match(none.c.text(), /the chat mirror is off/);
  assert.match(none.c.text(), /grants in .*: none/);
});

test('`tunnel mirror` with no or an unknown action is a userFacing error naming the three', async () => {
  await assert.rejects(tunnel(['mirror'], { log: () => {} }), (e) => e.userFacing && /needs on, off or status/.test(e.message));
  await assert.rejects(tunnel(['mirror', 'sideways'], { log: () => {} }), (e) => e.userFacing && /unknown tunnel mirror subcommand: sideways/.test(e.message));
  const c = capture();
  await tunnel(['help'], { log: c.log });
  assert.match(c.text(), /mirror on \[--read-only\] \[--project <dir>\]/);
  assert.match(c.text(), /mirror status \[--project <dir>\] \[--json\]/);
});

// ── tunnel status ───────────────────────────────────────────────────────────

test('`tunnel status` shows mirror off, read or full per exposed session, printed and --json', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const a = project(t);
  const b = project(t);
  const c = project(t);
  let port = 40201;
  for (const root of [a, b, c]) registerInstance({ root, port: port++, pid: process.pid });
  writeConfig(access.config({ remote: { mirror: { [b]: 'read', [instanceId(c)]: 'full' } } }));
  const env = { WEB_CHAT_PORTAL_PORT: String(await freePort()) };

  const s = await tunnel(['status', '--json'], { log: () => {}, env });
  const byId = Object.fromEntries(s.sessions.map((x) => [x.id, x.mirror]));
  assert.deepEqual(byId, { [instanceId(a)]: 'off', [instanceId(b)]: 'read', [instanceId(c)]: 'full' });
  const direct = await control.collectStatus({ env });
  assert.deepEqual(direct.sessions.map((x) => x.mirror).sort(), ['full', 'off', 'read']);

  const out = capture();
  await tunnel(['status'], { log: out.log, env });
  for (const [root, level] of [[a, 'off'], [b, 'read'], [c, 'full']]) {
    assert.match(out.text(), new RegExp(`${instanceId(root)} {2}${path.basename(root)} {2}→ {2}https://\\S+ {2}· {2}mirror: ${level}$`, 'm'));
  }
});

test('lib/tunnel/control asks lib/core/portfiles processCommand, not cloudflared\'s commandOf alias', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel', 'control.js'), 'utf8');
  assert.match(src, /\{[^}]*\bprocessCommand\b[^}]*\} = require\('\.\.\/core\/portfiles'\)/);
  assert.doesNotMatch(src, /\bcommandOf\b/);
});

// ── a running portal follows the CLI's edit ─────────────────────────────────

test('the portal follows `tunnel mirror on --read-only`, `on` and `off` within a poll (no directory watcher, 100 ms)', async (t) => {
  const srv = await withServer(t);
  // withServer gives this test its own HOME; the CLI and the portal share it.
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const id = instanceId(srv.root);
  const access = createFakeAccess();
  const raw = access.config();
  writeConfig(raw);
  const file = userPaths().tunnelConfig;
  const p = await withPortal(t, {
    config: raw, fetchJwks: access.fetchJwks, configFile: file,
    configDirWatch: false, configPollMs: 100, configDebounceMs: 10,
  });
  const host = sessionHost(p.config, id);
  const get = (pathStr) => p.request(pathStr, { host, headers: { 'cf-access-jwt-assertion': access.mint() } });
  // The PORTAL's mirror refusal (refusalBody: 403, remote:true, mirror = the
  // viewer's level) — or null when it let the request through to the daemon,
  // whatever the daemon then answered (a 404 for a route not mounted yet).
  const refusedAt = (res) => (res.status === 403 && res.json && res.json.remote === true && res.json.mirror) || null;
  const STREAM = '/api/mirror/conversations/x/stream'; // GET /api/mirror/*: read
  const FILES = '/api/files';                          // GET /api/files: full

  assert.equal(refusedAt(await get(STREAM)), 'basic');
  assert.equal(refusedAt(await get(FILES)), 'basic');
  assert.equal((await get('/api/health')).status, 200, 'the session itself is reachable');

  await tunnel(['mirror', 'on', '--read-only', '--project', srv.root], { log: () => {} });
  assert.ok(await waitUntil(async () => refusedAt(await get(STREAM)) === null, { timeout: 5000 }), 'read: the stream is forwarded');
  const fwd = await get(STREAM);
  assert.ok(!(fwd.status === 403 && fwd.json && 'mirror' in fwd.json), `forwarded, not refused by the portal: ${fwd.status} ${fwd.text}`);
  assert.equal(refusedAt(await get(FILES)), 'read', 'a full-only route stays refused at read');

  await tunnel(['mirror', 'on', '--project', srv.root], { log: () => {} });
  assert.ok(await waitUntil(async () => refusedAt(await get(FILES)) === null, { timeout: 5000 }), 'full: /api/files is forwarded');
  assert.equal(refusedAt(await get(STREAM)), null);

  await tunnel(['mirror', 'off', '--project', srv.root], { log: () => {} });
  assert.ok(await waitUntil(async () => refusedAt(await get(STREAM)) === 'basic', { timeout: 5000 }), 'off: the stream is refused again');
  assert.equal(refusedAt(await get(FILES)), 'basic');
});
