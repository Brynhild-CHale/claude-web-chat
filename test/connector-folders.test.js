// Folders offered (contract 06 C-06.13, C-06.14, C-06.18; 11 C-11.6; U721):
// lib/connector/folders.js's offer, withdraw and folders, its interactive init
// through lib/connector/init-child.js, the watch a running connector installs,
// and the three `connect` rows in lib/connector/cli.js's table.
//
// Pins: every refusal C-06.13 names answers `refused` and leaves the record's
// bytes as they were; an offered folder's display is the home rule's `~`
// (both spellings of a HOME reached through /var → /private/var); its id is
// random `f_<16 hex>`, never from the path; the same folder twice is one entry;
// a folder without .web-chat/ runs the init child interactively (argv
// ['init', <real>], stdio inherited) and a failed init offers nothing; the
// watch reports a change written by another process once, and a withdraw by
// its id. Every case runs in a throwaway HOME (withTempHome, under
// test-support/sandbox.js) with a paired record for hub-one and the default
// workdir <HOME>/web-chat-hub/hub-one; no init here is the real bin (a stub
// script stands in through deps), and nothing dials.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const { withTempHome, waitUntil } = require('../test-support/helpers');
const conn = require('../lib/setup/connector');
const folders = require('../lib/connector/folders');
const table = require('../lib/connector/cli');
const { runInit } = require('../lib/connector/init-child');
const { userPaths } = require('../lib/core/paths');

const REPO = path.resolve(__dirname, '..');
const HUB = 'hub-one';
const ID_RE = /^f_[0-9a-f]{16}$/;

const nativeReal = (p) => fs.realpathSync.native(p);
const recordFile = () => userPaths().connectorRecord(HUB);
const recordBytes = () => fs.readFileSync(recordFile(), 'utf8');
const recordNow = () => JSON.parse(recordBytes());

// A sandbox HOME holding a paired record for hub-one, its workdir made.
function paired(t) {
  const home = withTempHome(t);
  const record = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
  record.credential = { state: 'paired', paired_at: 1793177400000 };
  conn.writeRecord(record);
  const workdir = userPaths().defaultWorkdir(HUB);
  assert.strictEqual(workdir, path.join(home, 'web-chat-hub', HUB));
  fs.mkdirSync(workdir, { recursive: true });
  return { home, workdir };
}

// A folder under HOME, with a .web-chat/ unless `bare`.
function folder(home, rel, { bare = false } = {}) {
  const dir = path.join(home, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (!bare) fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

// An init that must never run.
const noInit = () => { throw new Error('init ran'); };

// A stub standing in for CLI_BIN: it records its argv and cwd in a file beside
// itself, makes .web-chat/ in its cwd when it succeeds (or when `make` says so),
// and exits `code`.
function stubBin(t, code = 0, { make = code === 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(userPaths().root, '..', 'stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'stub-cli.js');
  fs.writeFileSync(bin, [
    "const fs = require('fs');",
    "const path = require('path');",
    "fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
    make ? "fs.mkdirSync(path.join(process.cwd(), '.web-chat'));" : '',
    `process.exit(${code});`,
  ].join('\n'));
  const spawns = [];
  const spawn = (cmd, argv, opts) => {
    spawns.push({ cmd, argv, opts });
    return childProcess.spawn(cmd, argv, opts);
  };
  const calls = () => {
    const f = path.join(dir, 'call.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  return { bin, spawns, calls, deps: { bin, spawn } };
}

test('every refusal C-06.13 names answers refused and leaves the record unchanged', async (t) => {
  const { home, workdir } = paired(t);
  fs.mkdirSync(path.join(userPaths().root, 'x'), { recursive: true });
  const offered = folder(home, 'projects/a');
  const first = await folders.offer(offered, { deps: { runInit: noInit } });
  assert.strictEqual(first.ok, true);
  fs.mkdirSync(path.join(offered, 'sub'));
  fs.mkdirSync(path.join(workdir, 'inner'));
  fs.writeFileSync(path.join(home, 'a-file'), 'x');

  const cases = [
    ['the home directory', home, 'home-directory'],
    ['<HOME>/.web-chat', userPaths().root, 'inside-user-tier'],
    ['<HOME>/.web-chat/x', path.join(userPaths().root, 'x'), 'inside-user-tier'],
    ['a folder containing <HOME>/.web-chat', path.dirname(home), 'contains-user-tier'],
    ['a folder inside the workdir', path.join(workdir, 'inner'), 'inside-workdir'],
    ['the workdir itself', workdir, 'inside-workdir'],
    ['a folder containing the workdir', path.join(home, 'web-chat-hub'), 'contains-workdir'],
    ['a folder inside an offered one', path.join(offered, 'sub'), 'inside-offered'],
    ['a folder containing an offered one', path.join(home, 'projects'), 'contains-offered'],
    ['a missing path', path.join(home, 'projects', 'nope'), 'missing'],
    ['a file', path.join(home, 'a-file'), 'not-a-directory'],
  ];
  for (const [what, p, code] of cases) {
    const before = recordBytes();
    const r = await folders.offer(p, { deps: { runInit: noInit } });
    assert.deepStrictEqual(r, { ok: false, refused: code }, what);
    assert.strictEqual(recordBytes(), before, `${what}: the record is unchanged`);
    assert.ok(folders.REFUSALS[code], `${what}: the refusal has a sentence`);
  }
  // <HOME> contains the workdir too; it is refused whichever rule answers.
  assert.strictEqual((await folders.offer(home, { deps: { runInit: noInit } })).ok, false);
  assert.strictEqual(recordNow().folders.length, 1);
});

test('a label with a control character or over 120 characters is refused before anything is read', async (t) => {
  const { home } = paired(t);
  const dir = folder(home, 'projects/a');
  const before = recordBytes();
  for (const label of ['bad\u0007label', 'x'.repeat(121), 'rtl‮flip']) {
    assert.deepStrictEqual(await folders.offer(dir, { label, deps: { runInit: noInit } }), { ok: false, refused: 'bad-label' });
  }
  assert.strictEqual(recordBytes(), before);
});

test('an offered folder has its real path and a ~ display, through a link and through /private/var', async (t) => {
  const { home } = paired(t);
  const a = folder(home, 'projects/a');
  const r = await folders.offer(a, { label: 'Project A', deps: { runInit: noInit } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.folder.path, nativeReal(a));
  assert.strictEqual(r.folder.display, '~/projects/a');
  assert.strictEqual(r.folder.label, 'Project A');
  assert.strictEqual(r.folder.access, 'read-write');
  assert.strictEqual(typeof r.folder.offered_at, 'number');
  assert.deepStrictEqual(recordNow().folders, [r.folder]);
  assert.strictEqual(recordNow().ceiling, 'full', 'withDefaults kept the default ceiling');

  // macOS: the sandbox HOME is /var/folders/…, whose realpath is /private/var/….
  if (process.platform === 'darwin' && home.startsWith('/var/')) {
    assert.ok(r.folder.path.startsWith('/private/var/'), r.folder.path);
    assert.ok(!r.folder.display.includes('/private/'), r.folder.display);
  }

  // A link to the folder: the real path, and the same display.
  const b = folder(home, 'projects/b');
  fs.mkdirSync(path.join(home, 'links'));
  const link = path.join(home, 'links', 'b-link');
  fs.symlinkSync(b, link);
  const viaLink = await folders.offer(link, { deps: { runInit: noInit } });
  assert.strictEqual(viaLink.ok, true);
  assert.strictEqual(viaLink.folder.path, nativeReal(b));
  assert.strictEqual(viaLink.folder.display, '~/projects/b');
  // The same folder by its own spelling is the entry the link made.
  const again = await folders.offer(b, { deps: { runInit: noInit } });
  assert.strictEqual(again.existing, true);
  assert.strictEqual(again.folder.id, viaLink.folder.id);
});

test('a HOME spelled through a link masks the real spelling the same (the /var → /private/var case, on every platform)', async (t) => {
  const real = withTempHome(t);
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const prev = process.env.HOME;
  process.env.HOME = link;
  try {
    const record = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
    conn.writeRecord(record);
    const a = folder(real, 'projects/a');
    const r = await folders.offer(path.join(link, 'projects', 'a'), { deps: { runInit: noInit } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.folder.path, nativeReal(a));
    assert.strictEqual(r.folder.display, '~/projects/a');
    // The workdir fence holds through the link too, made or not.
    fs.mkdirSync(path.join(real, 'web-chat-hub'));
    assert.deepStrictEqual(await folders.offer(path.join(real, 'web-chat-hub'), { deps: { runInit: noInit } }),
      { ok: false, refused: 'contains-workdir' });
  } finally {
    process.env.HOME = prev;
  }
});

test('a ceiling the user set is kept when a folder is offered', async (t) => {
  const { home } = paired(t);
  conn.updateRecord(HUB, (r) => ({ ...r, ceiling: 'read' }));
  const r = await folders.offer(folder(home, 'projects/a'), { deps: { runInit: noInit } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(recordNow().ceiling, 'read');
});

test('ids are random f_<16 hex>, never from the path; the same folder twice is one entry', async (t) => {
  const { home } = paired(t);
  const a = folder(home, 'projects/a');
  const b = folder(home, 'projects/b');
  const ra = await folders.offer(a, { deps: { runInit: noInit } });
  const rb = await folders.offer(b, { deps: { runInit: noInit } });
  assert.match(ra.folder.id, ID_RE);
  assert.match(rb.folder.id, ID_RE);
  assert.notStrictEqual(ra.folder.id, rb.folder.id);
  for (const { folder: f } of [ra, rb]) {
    const hex = f.id.slice(2);
    // No 6-character window of the id appears in the path, nor of the path in the id.
    for (let i = 0; i + 6 <= hex.length; i++) assert.ok(!f.path.toLowerCase().includes(hex.slice(i, i + 6)), `${f.id} vs ${f.path}`);
    for (const algo of ['md5', 'sha1', 'sha256']) {
      for (const p of [f.path, f.display]) {
        assert.ok(!crypto.createHash(algo).update(p).digest('hex').includes(hex), `${algo} of the path`);
      }
    }
  }

  // Twice: the first id, no second entry, no write.
  const before = recordBytes();
  const twice = await folders.offer(a, { deps: { runInit: noInit } });
  assert.deepStrictEqual(twice, { ok: true, folder: ra.folder, existing: true });
  assert.strictEqual(recordBytes(), before);
  assert.strictEqual(recordNow().folders.length, 2);

  // Withdrawn and offered again: a NEW id for the same path.
  assert.strictEqual(folders.withdraw(ra.folder.id).ok, true);
  const anew = await folders.offer(a, { deps: { runInit: noInit } });
  assert.match(anew.folder.id, ID_RE);
  assert.notStrictEqual(anew.folder.id, ra.folder.id);

  // The id is what the random source says, whatever the path.
  const fixed = await folders.offer(folder(home, 'projects/c'), {
    deps: { runInit: noInit, randomBytes: () => Buffer.from('0123456789abcdef', 'hex') },
  });
  assert.strictEqual(fixed.folder.id, 'f_0123456789abcdef');
});

test('a folder without .web-chat/ runs the init child interactively; a failed init offers nothing', async (t) => {
  const { home } = paired(t);

  const ok = stubBin(t, 0);
  const a = folder(home, 'projects/a', { bare: true });
  const r = await folders.offer(a, { deps: ok.deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ok.spawns.length, 1);
  const s = ok.spawns[0];
  assert.strictEqual(s.cmd, process.execPath);
  assert.deepStrictEqual(s.argv, [ok.bin, 'init', nativeReal(a)]);
  assert.strictEqual(s.opts.stdio, 'inherit');
  assert.strictEqual(s.opts.shell, false);
  assert.strictEqual(s.opts.cwd, nativeReal(a));
  assert.deepStrictEqual(ok.calls().argv, ['init', nativeReal(a)]);
  assert.strictEqual(nativeReal(ok.calls().cwd), nativeReal(a));
  assert.ok(fs.statSync(path.join(a, '.web-chat')).isDirectory());

  const bad = stubBin(t, 1);
  const b = folder(home, 'projects/b', { bare: true });
  const before = recordBytes();
  assert.deepStrictEqual(await folders.offer(b, { deps: bad.deps }), { ok: false, refused: 'init-failed' });
  assert.strictEqual(bad.spawns.length, 1);
  assert.deepStrictEqual(bad.calls().argv, ['init', nativeReal(b)]);
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(fs.readdirSync(b), [], 'the folder is as it was');

  // The exit code alone decides: an init that made .web-chat/ but exited 1 offers nothing.
  const half = stubBin(t, 1, { make: true });
  const h = folder(home, 'projects/h', { bare: true });
  assert.deepStrictEqual(await folders.offer(h, { deps: half.deps }), { ok: false, refused: 'init-failed' });
  assert.strictEqual(half.spawns.length, 1);
  assert.ok(fs.statSync(path.join(h, '.web-chat')).isDirectory(), 'the stub made .web-chat/');
  assert.strictEqual(recordBytes(), before);

  const none = stubBin(t, 0);
  const c = folder(home, 'projects/c');
  assert.strictEqual((await folders.offer(c, { deps: none.deps })).ok, true);
  assert.strictEqual(none.spawns.length, 0, 'a folder with .web-chat/ runs no init');
  assert.strictEqual(none.calls(), null);
});

test('runInit answers the child exit code, and 1 for a child that cannot start', async (t) => {
  withTempHome(t);
  const dir = fs.mkdtempSync(path.join(userPaths().root, '..', 'init-'));
  const three = path.join(dir, 'three.js');
  fs.writeFileSync(three, 'process.exit(3);\n');
  assert.strictEqual(await runInit(dir, ['--yes'], { stdio: 'ignore', deps: { bin: three } }), 3);
  assert.strictEqual(await runInit(dir, [], { stdio: 'ignore', deps: { execPath: path.join(dir, 'no-such-node') } }), 1);
  await assert.rejects(runInit('', []), TypeError);
  await assert.rejects(runInit(dir, ['ok', 3]), TypeError);
});

test('withdraw by path and by id removes the folder; folders lists id, display and label', async (t) => {
  const { home } = paired(t);
  const a = folder(home, 'projects/a');
  const b = folder(home, 'projects/b');
  const ra = await folders.offer(a, { label: 'A', deps: { runInit: noInit } });
  const rb = await folders.offer(b, { deps: { runInit: noInit } });

  assert.deepStrictEqual(folders.folders(), {
    ok: true,
    hubId: HUB,
    folders: [
      { id: ra.folder.id, display: '~/projects/a', label: 'A' },
      { id: rb.folder.id, display: '~/projects/b' },
    ],
  });

  const byPath = folders.withdraw(a);
  assert.strictEqual(byPath.ok, true);
  assert.strictEqual(byPath.folder.id, ra.folder.id);
  assert.deepStrictEqual(recordNow().folders.map((f) => f.id), [rb.folder.id]);

  const byId = folders.withdraw(rb.folder.id);
  assert.strictEqual(byId.ok, true);
  assert.deepStrictEqual(recordNow().folders, []);

  const before = recordBytes();
  assert.deepStrictEqual(folders.withdraw(rb.folder.id), { ok: false, refused: 'unknown-folder' });
  assert.deepStrictEqual(folders.withdraw(path.join(home, 'projects', 'zz')), { ok: false, refused: 'unknown-folder' });
  assert.strictEqual(recordBytes(), before);

  // A folder removed from the disk after it was offered can still be withdrawn by its path.
  const c = folder(home, 'projects/c');
  await folders.offer(c, { deps: { runInit: noInit } });
  fs.rmSync(c, { recursive: true });
  assert.strictEqual(folders.withdraw(c).ok, true);
  assert.deepStrictEqual(recordNow().folders, []);
});

test('with no record: offer, withdraw and folders say not paired and write nothing', async (t) => {
  const home = withTempHome(t);
  const dir = folder(home, 'projects/a');
  assert.deepStrictEqual(await folders.offer(dir, { deps: { runInit: noInit } }), { ok: false, refused: 'not-paired' });
  assert.deepStrictEqual(folders.withdraw(dir), { ok: false, refused: 'not-paired' });
  assert.deepStrictEqual(folders.folders(), { ok: false, refused: 'not-paired' });
  assert.ok(!fs.existsSync(userPaths().connectorDir), 'no connector directory was made');
});

// U721b: the hub choice is setup.soleHub's, refusal included — two records on
// the machine and no hub named answer several-hubs (not not-paired), and the
// named hub still answers.
test('with two records and no hub named: offer, withdraw and folders say several-hubs and write nothing', async (t) => {
  const { home } = paired(t);
  const other = conn.newRecord({ hubId: 'hub-two', origin: 'https://other.example.com' });
  other.credential = { state: 'paired', paired_at: 1793177400000 };
  conn.writeRecord(other);
  const before = recordBytes();
  const dir = folder(home, 'projects/a');
  assert.deepStrictEqual(await folders.offer(dir, { deps: { runInit: noInit } }), { ok: false, refused: 'several-hubs' });
  assert.deepStrictEqual(folders.withdraw(dir), { ok: false, refused: 'several-hubs' });
  assert.deepStrictEqual(folders.folders(), { ok: false, refused: 'several-hubs' });
  assert.strictEqual(recordBytes(), before);
  assert.strictEqual(folders.folders({ hubId: HUB }).ok, true);
});

test('install: a change written by another process is reported once; a withdraw names the id', async (t) => {
  const { home } = paired(t);
  const changed = [];
  const withdrawn = [];
  const ctx = {
    hubId: HUB,
    onFoldersChanged: (list) => changed.push(list),
    onFolderWithdrawn: (id) => withdrawn.push(id),
  };
  const stop = folders.install(ctx, { pollMs: 50 });
  t.after(() => stop());

  // Another process writes an offer through updateRecord (the record's one writer).
  const dir = folder(home, 'projects/a');
  const entry = {
    id: 'f_00112233445566aa', path: nativeReal(dir), display: '~/projects/a', access: 'read-write', offered_at: 1793177520000,
  };
  const script = [
    `const conn = require(${JSON.stringify(path.join(REPO, 'lib', 'setup', 'connector'))});`,
    `const entry = JSON.parse(process.argv[1]);`,
    `conn.updateRecord(${JSON.stringify(HUB)}, (r) => { r.folders.push(entry); return r; });`,
  ].join('\n');
  const child = childProcess.spawnSync(process.execPath, ['-e', script, JSON.stringify(entry)], { env: process.env, encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);

  await waitUntil(() => changed.length >= 1, { timeout: 5000, what: 'onFoldersChanged' });
  await stop.trigger('again');
  await new Promise((r) => setTimeout(r, 200)); // a few polls more
  assert.strictEqual(changed.length, 1, 'reported once');
  assert.deepStrictEqual(changed[0], [entry]);
  assert.deepStrictEqual(withdrawn, []);

  // A write that leaves the folders as they were reports nothing.
  conn.updateRecord(HUB, (r) => ({ ...r, settings: { ...r.settings, paused: true } }));
  await stop.trigger('settings');
  assert.strictEqual(changed.length, 1);

  // A withdraw: onFolderWithdrawn with the id, then the new list.
  assert.strictEqual(folders.withdraw(entry.id).ok, true);
  await waitUntil(() => withdrawn.length >= 1, { timeout: 5000, what: 'onFolderWithdrawn' });
  assert.deepStrictEqual(withdrawn, [entry.id]);
  await waitUntil(() => changed.length >= 2, { timeout: 5000, what: 'the second onFoldersChanged' });
  assert.deepStrictEqual(changed[1], []);
});

test('the three rows dispatch through the connect table: 0 on success, 1 on a refusal', async (t) => {
  const { home } = paired(t);
  const run = async (args, extra = {}) => {
    const out = [];
    const err = [];
    const code = await table.main(args, { out: (l) => out.push(l), err: (l) => err.push(l), ...extra });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const help = await run(['help']);
  for (const u of ['connect offer <path> [--label <text>]', 'connect withdraw <path|id>', 'connect folders']) {
    assert.ok(help.out.includes(u), u);
  }

  const dir = folder(home, 'projects/a');
  const offered = await run(['offer', dir, '--label', 'Proj']);
  assert.strictEqual(offered.code, 0, offered.err);
  const id = recordNow().folders[0].id;
  assert.match(offered.out, new RegExp(`~/projects/a "Proj" \\(${id}\\)`));

  const listed = await run(['folders']);
  assert.strictEqual(listed.code, 0);
  assert.strictEqual(listed.out, `~/projects/a "Proj" (${id})`);

  const refusedHome = await run(['offer', home]);
  assert.strictEqual(refusedHome.code, 1);
  assert.match(refusedHome.err, /home directory/);

  const bare = folder(home, 'projects/b', { bare: true });
  const stub = stubBin(t, 1);
  const failedInit = await run(['offer', bare], { folderDeps: stub.deps });
  assert.strictEqual(failedInit.code, 1);
  assert.strictEqual(stub.spawns.length, 1);

  assert.strictEqual((await run(['offer'])).code, 1);
  assert.strictEqual((await run(['offer', dir, '--bogus'])).code, 1);

  const withdrawn = await run(['withdraw', id]);
  assert.strictEqual(withdrawn.code, 0, withdrawn.err);
  assert.deepStrictEqual(recordNow().folders, []);
  assert.strictEqual((await run(['withdraw', id])).code, 1);
  assert.strictEqual((await run(['folders'])).out, 'No folders offered');
});

// U721b: one root spelling, one hub choice and one cap rule in the connector.
// A root's canonical spelling is lib/core/portfiles' canonicalRoot/sameRoot,
// the hub choice lib/setup/connector.js soleHub and the effective cap its
// effectiveCapOf; none of the three connector modules keeps a copy of its own.
test('folders.js, lifecycle.js and chats.js define no canonical, sameRoot, soleHub or effectiveCap of their own', () => {
  const NAMES = '(?:canonical|canonicalRoot|sameRoot|soleHub|pickSole|effectiveCapOf)';
  const def = new RegExp(`\\b(?:function\\s+${NAMES}\\b|(?:const|let|var)\\s+${NAMES}\\s*=)`);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const name of ['folders.js', 'lifecycle.js', 'chats.js']) {
    const src = strip(fs.readFileSync(path.join(REPO, 'lib', 'connector', name), 'utf8'));
    assert.doesNotMatch(src, def, `${name} defines its own copy`);
    // The copies' tells: a nearest-existing-ancestor realpath, a count of the
    // machine's records, a min over the two caps.
    assert.doesNotMatch(src, /\bnearestExisting\b/, `${name} spells a root itself`);
    assert.doesNotMatch(src, /\blistRecords\s*\(/, `${name} picks the hub itself`);
    assert.doesNotMatch(src, /Math\.min\([^)]*(?:local_cap|agents_at_once|cap\b)/, `${name} computes the cap itself`);
  }
  const lifecycle = strip(fs.readFileSync(path.join(REPO, 'lib', 'connector', 'lifecycle.js'), 'utf8'));
  // lifecycle's effectiveCap() is its API (overCap reads it); its body is the record's rule.
  assert.match(lifecycle, /const effectiveCap = \(\) => record\.effectiveCapOf\(settings\(\)\);/);
  const foldersSrc = strip(fs.readFileSync(path.join(REPO, 'lib', 'connector', 'folders.js'), 'utf8'));
  assert.match(foldersSrc, /require\('\.\.\/core\/portfiles'\)/);
  assert.match(foldersSrc, /setup\.soleHub\(\)/);
});
