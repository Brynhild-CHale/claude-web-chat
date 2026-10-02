// The chat mirror's remote opt-in in tunnel.json (`remote.mirror`, spec §5.2):
// lib/tunnel/config reads it (normalizeConfig, failing closed on anything it
// does not understand), answers it per project (mirrorLevelFor: exact match,
// never spread to a sub-project), and edits it for the CLI (withMirrorLevel:
// pure, every unrelated key kept); and the tunnel portal applies an edit of it
// live, through the same watcher as the rest of the file.
//
// The fingerprints pinned below were taken from the 0.8.0 normaliser before
// the mirror existed: a file without `remote.mirror` must normalise, and so
// fingerprint, exactly as it did, or `tunnel up` would restart every portal
// over a config that did not change.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, withPortal, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const {
  normalizeConfig, configFingerprint, mirrorLevelFor, withMirrorLevel, sessionHost, MIRROR_VALUES,
} = require('../lib/tunnel/config');
const { MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');

const BASE = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
// Every other section filled in, so the pin covers them all.
const FULL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'nested',
  access: { team: 'testteam', aud: 'aud-1' },
  allow: { emails: ['Me@Example.com', 'friend@example.com'], domains: ['example.org'] },
  showRoots: true,
  remote: { allowDestructive: true },
  expose: { exclude: ['0A1B2C3D', '/abs/hidden/project'] },
  tunnel: { kind: 'token', name: 'wc-tunnel', metricsPort: 5172 },
  signin: 'pin',
});

const fp = (raw) => configFingerprint(normalizeConfig(raw));
const refusal = (raw) => {
  try {
    normalizeConfig(raw);
  } catch (e) {
    return e;
  }
  return null;
};

test('an existing tunnel.json — no remote.mirror — normalises and fingerprints exactly as before the mirror', () => {
  // Pinned from the 0.8.0 normaliser (wc085/int before this unit).
  assert.equal(fp(BASE), 'b8730e80a61a6c90');
  assert.equal(fp(FULL), 'aeff672c543fb404');
  for (const remote of [undefined, {}, { allowDestructive: false }, { mirror: {} }, { mirror: null }, 'yes', true, []]) {
    const raw = remote === undefined ? BASE : { ...BASE, remote };
    assert.equal(fp(raw), 'b8730e80a61a6c90', `remote: ${JSON.stringify(remote)}`);
    assert.deepStrictEqual(normalizeConfig(raw).remote, { allowDestructive: false }, 'no mirror key at all');
  }
  assert.deepStrictEqual(normalizeConfig(FULL).remote, { allowDestructive: true });
  // A grant is part of what the portal enforces, so it moves the fingerprint
  // (`tunnel up` and `tunnel status` notice an edit of it), and only it does.
  const granted = { ...BASE, remote: { mirror: { '/Users/me/Dev/web-chat-dev': 'full' } } };
  assert.notEqual(fp(granted), fp(BASE));
  assert.notEqual(fp({ ...BASE, remote: { mirror: { '/Users/me/Dev/web-chat-dev': 'read' } } }), fp(granted));
});

test('normalizeConfig reads remote.mirror: an absolute root or an 8-hex id, each read or full', () => {
  const c = normalizeConfig({ ...BASE, remote: { allowDestructive: true, mirror: {
    '/Users/me/Dev/web-chat-dev': 'full',
    '0A1B2C3D': 'read',
    '/Users/me/Dev/other/': 'read',
    '/Users/me//Dev/./third': 'full',
  } } });
  assert.deepStrictEqual(c.remote, {
    allowDestructive: true,
    mirror: {
      '/Users/me/Dev/web-chat-dev': 'full',
      '0a1b2c3d': 'read',
      '/Users/me/Dev/other': 'read',
      '/Users/me/Dev/third': 'full',
    },
  }, 'ids lowercased, roots resolved, in the file\'s order');
  assert.deepStrictEqual([...MIRROR_VALUES], ['read', 'full']);
  // One project spelt twice with ONE level is the same grant.
  assert.deepStrictEqual(normalizeConfig({ ...BASE, remote: { mirror: { '/p': 'read', '/p/': 'read' } } }).remote.mirror, { '/p': 'read' });
});

test('normalizeConfig refuses every other remote.mirror shape — the portal then fails closed', () => {
  const cases = [
    [[], /remote\.mirror must be an object/],
    ['full', /remote\.mirror must be an object/],
    [true, /remote\.mirror must be an object/],
    [7, /remote\.mirror must be an object/],
    [{ 'relative/project': 'full' }, /neither an instance id \(8 hex\) nor an absolute project path/],
    [{ '': 'full' }, /neither an instance id/],
    [{ ' /p': 'full' }, /neither an instance id/],
    [{ '0a1b2c3': 'full' }, /neither an instance id/],
    [{ '0a1b2c3d9': 'full' }, /neither an instance id/],
    [{ '~/Dev/x': 'full' }, /neither an instance id/],
    [{ '/p': 'off' }, /must be "read" or "full" \(got "off"\)/],
    [{ '/p': 'basic' }, /must be "read" or "full"/],
    [{ '/p': 'local' }, /must be "read" or "full"/],
    [{ '/p': 'FULL' }, /must be "read" or "full"/],
    [{ '/p': true }, /must be "read" or "full"/],
    [{ '/p': null }, /must be "read" or "full"/],
    [{ '/p': '' }, /must be "read" or "full"/],
    [{ '/p': ['full'] }, /must be "read" or "full"/],
    [{ '/p': { level: 'full' } }, /must be "read" or "full"/],
    [{ '/p/': 'read', '/p': 'full' }, /names \/p twice, as "read" and "full"/],
    [{ '0a1b2c3d': 'read', '0A1B2C3D': 'full' }, /names 0a1b2c3d twice/],
  ];
  for (const [mirror, why] of cases) {
    const e = refusal({ ...BASE, remote: { mirror } });
    assert.ok(e, `accepted remote.mirror ${JSON.stringify(mirror)}`);
    assert.equal(e.userFacing, true, 'a message for the operator, like every other field');
    assert.match(e.message, /^tunnel config: /);
    assert.match(e.message, why, JSON.stringify(mirror));
  }
});

test('mirrorLevelFor matches exactly: the root or the instance id, never a directory above or below', () => {
  const c = normalizeConfig({ ...BASE, remote: { mirror: { '/Users/me/Dev/app': 'full', 'abcdef12': 'read' } } });
  const at = (root, id = '00000000') => mirrorLevelFor(c, { root, id });
  assert.equal(at('/Users/me/Dev/app'), 'full');
  assert.equal(at('/Users/me/Dev/app/'), 'full', 'the session root resolved like the key');
  assert.equal(at('/Users/me/Dev/app/packages/web'), 'off', 'no spread to a sub-project (expose.exclude does spread; a grant does not)');
  assert.equal(at('/Users/me/Dev'), 'off', 'nor to the directory above');
  assert.equal(at('/Users/me/Dev/app2'), 'off', 'not a string prefix');
  assert.equal(at('/Users/me/Dev/App'), 'off', 'exact: case is not folded');
  assert.equal(at('/Users/me/Dev/x', 'abcdef12'), 'read', 'by instance id');
  assert.equal(at('/Users/me/Dev/x', 'ABCDEF12'), 'read');
  assert.equal(at('relative/app', 'nothex!!'), 'off', 'a root that is not absolute and an id that is not one match nothing');
  // One project granted twice, under each spelling: the narrower wins.
  assert.equal(at('/Users/me/Dev/app', 'abcdef12'), 'read');
  // Nothing to match.
  assert.equal(mirrorLevelFor(normalizeConfig(BASE), { root: '/Users/me/Dev/app', id: 'abcdef12' }), 'off');
  assert.equal(mirrorLevelFor(c, null), 'off');
  assert.equal(mirrorLevelFor(c, {}), 'off');
  assert.equal(mirrorLevelFor(null, { root: '/Users/me/Dev/app' }), 'off');
  assert.equal(mirrorLevelFor({}, { root: '/Users/me/Dev/app' }), 'off');
  // A registry entry is what the portal hands it.
  assert.equal(mirrorLevelFor(c, { id: 'abcdef12', root: '/elsewhere', port: 5173, pid: 4242 }), 'read');
});

test('withMirrorLevel edits one project\'s grant and keeps every unrelated key as written; the input is untouched', () => {
  const raw = {
    ...BASE,
    custom: { kept: ['as', 'is'] },
    remote: { allowDestructive: true, note: 'unknown keys survive', mirror: { '/other': 'full', '/Users/me/app/': 'read', 'abcdef12': 'full' } },
    expose: { exclude: ['0a1b2c3d'] },
  };
  const before = JSON.stringify(raw);

  // on: the project's first key is replaced where it stood; its other
  // spellings (the id, when given) go.
  const on = withMirrorLevel(raw, { root: '/Users/me/app', id: 'ABCDEF12' }, 'full');
  assert.equal(JSON.stringify(raw), before, 'pure: the input is not touched');
  assert.notEqual(on, raw);
  assert.deepStrictEqual(Object.keys(on), Object.keys(raw), 'top-level keys and their order kept');
  assert.equal(on.custom, raw.custom, 'an unrelated section is the same, unchanged');
  assert.deepStrictEqual(on.remote, { allowDestructive: true, note: 'unknown keys survive', mirror: { '/other': 'full', '/Users/me/app': 'full' } });
  assert.equal(mirrorLevelFor(normalizeConfig(on), { root: '/Users/me/app', id: 'abcdef12' }), 'full', 'and the portal reads it back');

  // read-only, then off: the key goes; the others stay; an emptied mirror goes.
  const ro = withMirrorLevel(on, { root: '/Users/me/app/' }, 'read');
  assert.deepStrictEqual(ro.remote.mirror, { '/other': 'full', '/Users/me/app': 'read' });
  const off = withMirrorLevel(ro, { root: '/Users/me/app' }, 'off');
  assert.deepStrictEqual(off.remote, { allowDestructive: true, note: 'unknown keys survive', mirror: { '/other': 'full' } });
  const none = withMirrorLevel(off, { root: '/other' }, 'off');
  assert.deepStrictEqual(none.remote, { allowDestructive: true, note: 'unknown keys survive' }, 'no empty mirror left behind');
  assert.equal(fp(none), fp({ ...raw, remote: { allowDestructive: true } }));

  // A file with no remote section: on adds one; off adds nothing.
  const bare = { ...BASE };
  assert.deepStrictEqual(withMirrorLevel(bare, { root: '/p' }, 'read'), { ...BASE, remote: { mirror: { '/p': 'read' } } });
  assert.deepStrictEqual(withMirrorLevel(bare, { root: '/p' }, 'off'), bare, 'nothing to remove, nothing created');
  assert.deepStrictEqual(withMirrorLevel({ ...BASE, remote: {} }, { root: '/p' }, 'off'), { ...BASE, remote: {} }, 'a remote the user wrote stays');
  // Every result is a valid file.
  for (const r of [on, ro, off, none]) normalizeConfig(r);
});

test('withMirrorLevel refuses what it cannot edit honestly, and never overwrites what the user wrote', () => {
  const cases = [
    [() => withMirrorLevel(null, { root: '/p' }, 'full'), /not a JSON object/],
    [() => withMirrorLevel([], { root: '/p' }, 'full'), /not a JSON object/],
    [() => withMirrorLevel(BASE, { root: 'relative/p' }, 'full'), /absolute root/],
    [() => withMirrorLevel(BASE, {}, 'full'), /absolute root/],
    [() => withMirrorLevel(BASE, undefined, 'full'), /absolute root/],
    [() => withMirrorLevel(BASE, { root: '/p', id: 'nothex!!' }, 'full'), /not an instance id/],
    [() => withMirrorLevel(BASE, { root: '/p' }, 'on'), /read, full or off/],
    [() => withMirrorLevel(BASE, { root: '/p' }, 'basic'), /read, full or off/],
    [() => withMirrorLevel(BASE, { root: '/p' }), /read, full or off/],
    [() => withMirrorLevel({ ...BASE, remote: 'yes' }, { root: '/p' }, 'full'), /remote must be an object/],
    [() => withMirrorLevel({ ...BASE, remote: { mirror: 'full' } }, { root: '/p' }, 'full'), /remote\.mirror must be an object/],
  ];
  for (const [fn, why] of cases) {
    assert.throws(fn, (e) => e.userFacing === true && why.test(e.message), String(why));
  }
});

// ── the portal applies an edit live ─────────────────────────────────────────

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mirror-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the portal follows a remote.mirror edit within a poll (no directory watcher, a 100 ms poll)', async (t) => {
  // Watch what the portal's watchers open: with configDirWatch:false there
  // must be no watch on tunnel.json's directory (closing one can block the
  // event loop for seconds under load).
  const watched = [];
  const realWatch = fs.watch;
  fs.watch = function spy(target, ...rest) {
    watched.push(path.resolve(String(target)));
    return realWatch.call(this, target, ...rest);
  };
  t.after(() => { fs.watch = realWatch; });

  const srv = await withServer(t);
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const id = instanceId(srv.root);
  const access = createFakeAccess();
  const dir = tmpDir(t);
  const file = path.join(dir, 'tunnel.json');
  const raw = access.config();
  writeJsonAtomic(file, raw);
  const lines = [];
  const p = await withPortal(t, {
    config: raw, fetchJwks: access.fetchJwks, configFile: file,
    configDirWatch: false, configPollMs: 100, configDebounceMs: 10, log: (l) => lines.push(l),
  });
  const host = sessionHost(p.config, id);
  const origin = `https://${host}`;
  const req = (pathStr, { method = 'GET', body } = {}) => p.request(pathStr, {
    host, method, body,
    headers: {
      'cf-access-jwt-assertion': access.mint(),
      ...(method !== 'GET' ? { 'content-type': 'application/json', origin } : {}),
    },
  });
  // The portal's own refusal for the mirror level — not the daemon's answer.
  const refusedFor = (res) => (res.status === 403 && res.json && res.json.remote === true && res.json.mirror) || null;
  const health = async () => (await p.request('/api/health', { host: `127.0.0.1:${p.port}` })).json;

  // Off (no key): the heartbeat routes pass the portal; the conversation is refused with the host command.
  assert.equal(refusedFor(await req('/api/mirror/status')), null, 'a basic row reaches the daemon');
  const before = await req('/api/mirror/turns/t1');
  assert.equal(refusedFor(before), 'basic');
  assert.equal(before.json.hint, MIRROR_HINT);
  assert.equal((await req('/api/graph')).status, 200, 'the surface is unaffected');

  // `tunnel mirror on --read-only`, by the project's root: applied within a poll.
  writeJsonAtomic(file, withMirrorLevel(raw, { root: srv.root }, 'read'));
  assert.ok(await waitUntil(async () => refusedFor(await req('/api/mirror/turns/t1')) === null, { timeout: 5000 }),
    'the read grant is in force');
  const send = await req('/api/queue/message', { method: 'POST', body: { text: 'hi' } });
  assert.equal(refusedFor(send), 'read', 'read-only: the composer is still refused');
  assert.equal(send.json.hint, MIRROR_FULL_HINT);

  // A grant by the instance id this time (a hand edit; the CLI writes roots): full.
  writeJsonAtomic(file, { ...raw, remote: { mirror: { [id]: 'full' } } });
  assert.ok(await waitUntil(async () => refusedFor(await req('/api/queue/message', { method: 'POST', body: { text: 'hi' } })) === null,
    { timeout: 5000 }), 'the full grant is in force');

  // What the portal enforces is exactly the file (so `tunnel up` restarts nothing).
  assert.equal((await health()).config_fp, configFingerprint(normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))));

  // A value it cannot read fails the whole file closed, like any other field.
  writeJsonAtomic(file, { ...raw, remote: { mirror: { [id]: 'everything' } } });
  assert.ok(await waitUntil(async () => (await health()).config.state === 'invalid', { timeout: 5000 }));
  assert.match((await health()).config.error, /remote\.mirror/);
  assert.equal((await req('/api/graph')).status, 503, 'every session request refused while the file is invalid');

  // `tunnel mirror off`: back to the heartbeat.
  writeJsonAtomic(file, raw);
  assert.ok(await waitUntil(async () => refusedFor(await req('/api/mirror/turns/t1')) === 'basic', { timeout: 5000 }),
    'the grant is gone');
  assert.equal((await health()).config.state, 'ok');

  assert.ok(lines.some((l) => /tunnel\.json reloaded/.test(l)), lines.join('\n'));
  assert.ok(!watched.includes(dir), `the portal watched tunnel.json's directory: ${watched.join(', ')}`);
  assert.ok(watched.includes(file), `the portal watched tunnel.json itself: ${watched.join(', ')}`);
});
