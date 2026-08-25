// Getting a pack onto this machine: resolve → download → VERIFY → stage.
//
// Driven against a real HTTP server standing in for the GitHub API and codeload,
// with tarballs built by the same makeTar the release build uses — so the code
// exercised here is the code that runs for real, not a mock standing where it
// used to be.
//
// The gates under test are the ones that would otherwise be discovered in
// production: a hostile archive member must be refused on OUR terms rather than
// on whatever the local `tar` happens to do, and a release without SHA256SUMS
// must fall back to the commit-pinned archive rather than install unverified.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { fetchPack, verifyTree, assertSafeMembers, memberEscapes, safeAssetName } = require('../lib/packs/fetch');
const { listTarGz } = require('../lib/update/archive');
const {
  packFixture, tmpDir, write, tarballOf, fakeForge, repoWithArchive, repoWithRelease,
} = require('../test-support/packs');
const { makeTar } = require('../scripts/build-release');

const SHA_A = 'a'.repeat(40);

test('the archive path pins a commit and stages a verified tree', async (t) => {
  const dir = packFixture({ components: [{ name: 'deploy-board' }, { name: 'incident-timeline' }] });
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA_A }) } });

  const got = await fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-') });
  t.after(got.cleanup);

  assert.equal(got.via, 'archive');
  assert.equal(got.sumsVerified, false);
  assert.equal(got.sha, SHA_A);
  assert.equal(got.source.sha, SHA_A, 'provenance carries the sha whichever route was taken');
  assert.ok(fs.existsSync(path.join(got.stageDir, 'web-chat-pack.json')));
  assert.ok(got.files.includes('components/deploy-board/component.html'));
  assert.ok(got.files.includes('SKILL.md'));
});

test('a released pack with SHA256SUMS is verified before anything is unpacked', async (t) => {
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithRelease(dir, { sha: 'b'.repeat(40) }) } });

  const got = await fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-') });
  t.after(got.cleanup);

  assert.equal(got.via, 'release');
  assert.equal(got.sumsVerified, true);
  assert.equal(got.source.ref, 'v1.2.0');
  assert.equal(got.sha, 'b'.repeat(40), 'even the release path anchors on the commit the tag points at');
});

test('a tampered release asset is refused — the sums file is the gate', async (t) => {
  const dir = packFixture();
  const repo = repoWithRelease(dir, { sha: 'b'.repeat(40) });
  // Corrupt the asset AFTER its checksum was published: a tampered mirror and a
  // truncated transfer are indistinguishable here, and both must be refused.
  repo.release.assets[0].body = Buffer.concat([repo.release.assets[0].body, Buffer.from('junk')]);
  const forge = await fakeForge(t, { repos: { 'acme/ops': repo } });
  await assert.rejects(fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-') }), /checksum mismatch/);
});

test('a release with NO SHA256SUMS falls back to the sha-pinned archive, never to an unverified asset', async (t) => {
  const dir = packFixture();
  const repo = repoWithRelease(dir, { sha: 'c'.repeat(40), sums: false });
  const forge = await fakeForge(t, { repos: { 'acme/ops': repo } });
  const lines = [];
  const got = await fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-'), log: (s) => lines.push(s) });
  t.after(got.cleanup);
  assert.equal(got.via, 'archive', 'an asset can be re-uploaded under the same tag; a commit sha cannot');
  assert.equal(got.sumsVerified, false);
  assert.match(lines.join('\n'), /publishes no SHA256SUMS/);
});

test('an explicit ref pins that ref', async (t) => {
  const dir = packFixture();
  const repo = repoWithArchive(dir, { sha: SHA_A });
  repo.commits['v9.9.9'] = SHA_A;
  const forge = await fakeForge(t, { repos: { 'acme/ops': repo } });
  const got = await fetchPack({ url: forge.url('acme', 'ops'), ref: 'v9.9.9', tmpDir: tmpDir('wc-fetch-') });
  t.after(got.cleanup);
  assert.equal(got.source.ref, 'v9.9.9');
  assert.equal(got.sha, SHA_A);
});

test('a ref that does not resolve fails with a message naming the ref', async (t) => {
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA_A }) } });
  await assert.rejects(
    fetchPack({ url: forge.url('acme', 'ops'), ref: 'no-such-branch', tmpDir: tmpDir('wc-fetch-') }),
    /could not resolve 'no-such-branch'/,
  );
});

// ── the hostile-archive gates ───────────────────────────────────────────────

test('a `..` member is refused BY US, not left to whatever the local tar does', async (t) => {
  const dir = packFixture();
  const evil = tmpDir('wc-evil-');
  write(path.join(evil, 'evil.txt'), 'pwned');
  const repo = repoWithArchive(dir, {
    sha: SHA_A,
    extraEntries: [{ name: 'pack-1/../../evil.txt', type: 'file', mode: 0o644, source: path.join(evil, 'evil.txt') }],
  });
  const forge = await fakeForge(t, { repos: { 'acme/ops': repo } });
  await assert.rejects(
    fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-') }),
    /escapes its own directory/,
  );
});

test('an absolute-path member is refused', () => {
  const src = tmpDir('wc-abs-');
  write(path.join(src, 'x'), 'x');
  const f = path.join(src, 'a.tar.gz');
  fs.writeFileSync(f, zlib.gzipSync(makeTar([{ name: '/etc/cron.d/evil', type: 'file', mode: 0o644, source: path.join(src, 'x') }])));
  assert.throws(() => assertSafeMembers(f), /escapes its own directory/);
});

test('a symlink member is refused — a pack is plain files', () => {
  const src = tmpDir('wc-link-');
  write(path.join(src, 'x'), 'x');
  const f = path.join(src, 'a.tar.gz');
  // type '2' is a ustar symlink; makeTar only writes files and dirs, so the
  // header is hand-built here to produce the member a hostile pack would ship.
  const entries = makeTar([{ name: 'pack-1/component.html', type: 'file', mode: 0o644, source: path.join(src, 'x') }]);
  const buf = Buffer.from(entries);
  buf.write('2', 156, 1, 'ascii');   // flip the first member's type flag to symlink
  fs.writeFileSync(f, zlib.gzipSync(buf));
  assert.equal(listTarGz(f)[0].type, 'link');
  assert.throws(() => assertSafeMembers(f), /symlink or hard link/);
});

test('a symlink that reaches the staged tree some other way is refused by the walk', () => {
  const stage = tmpDir('wc-stage-');
  write(path.join(stage, 'web-chat-pack.json'), '{}');
  fs.symlinkSync('/etc/passwd', path.join(stage, 'component.html'));
  assert.throws(() => verifyTree(stage), /is a symlink/);
});

test('verifyTree normalizes modes and returns every regular file, sorted', () => {
  const stage = tmpDir('wc-modes-');
  write(path.join(stage, 'web-chat-pack.json'), '{}');
  write(path.join(stage, 'components', 'a', 'component.html'), 'x');
  fs.chmodSync(path.join(stage, 'components', 'a', 'component.html'), 0o777);
  const files = verifyTree(stage);
  assert.deepEqual(files, ['components/a/component.html', 'web-chat-pack.json']);
  assert.equal(fs.statSync(path.join(stage, 'components', 'a', 'component.html')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(stage, 'components', 'a')).mode & 0o777, 0o755);
});

test('memberEscapes recognises the shapes that matter', () => {
  assert.equal(memberEscapes('pack/ok.txt'), false);
  assert.equal(memberEscapes('pack/../../evil'), true);
  assert.equal(memberEscapes('../evil'), true);
  assert.equal(memberEscapes('/etc/passwd'), true);
  assert.equal(memberEscapes('C:/windows/x'), true);
  assert.equal(memberEscapes('pack\\..\\..\\evil'), true);
  assert.equal(memberEscapes(''), true);
});

test('an oversized pack is refused mid-stream rather than filling the disk', async (t) => {
  const dir = packFixture();
  // Incompressible, so the cap is exercised on the wire and not defeated by gzip.
  fs.writeFileSync(path.join(dir, 'big.bin'), require('crypto').randomBytes(256 * 1024));
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA_A }) } });
  await assert.rejects(
    fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-'), maxBytes: 2048 }),
    /exceeded 2048 bytes/,
  );
});

test('a failed fetch leaves no staging directory behind', async (t) => {
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA_A }) } });
  const tmp = tmpDir('wc-fetch-');
  await assert.rejects(fetchPack({ url: forge.url('acme', 'ops'), ref: 'nope', tmpDir: tmp }));
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('the archive tarball is fetched from the same origin the API was — no credential-crossing hop', async (t) => {
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA_A }) } });
  const got = await fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmpDir('wc-fetch-') });
  t.after(got.cleanup);
  assert.ok(forge.seen.some((r) => r.url === `/acme/ops/archive/${SHA_A}.tar.gz`));
});

test('a hostile RELEASE ASSET NAME cannot steer the download out of the temp dir', async (t) => {
  // parseSource accepts any GitHub-API-shaped host, so the release JSON is
  // remote input — and its `name` is where the downloaded body gets written.
  assert.equal(safeAssetName('acme-ops-1.2.0.tar.gz'), 'acme-ops-1.2.0.tar.gz');
  assert.equal(safeAssetName('../../../../.zshrc'), '.zshrc');
  assert.equal(safeAssetName('/etc/cron.d/evil'), 'evil');
  assert.equal(safeAssetName('..'), 'pack.tar.gz');
  assert.equal(safeAssetName(''), 'pack.tar.gz');
  assert.equal(safeAssetName('a\\..\\b.tgz'), 'b.tgz');

  // …and end to end: the file lands inside the work dir, never above it.
  const dir = packFixture();
  const repo = repoWithRelease(dir, { sha: 'b'.repeat(40), assetName: 'ops.tar.gz' });
  repo.release.assets[0].name = '../../../escaped.tar.gz';
  repo.release.assets[1].body = Buffer.from(
    `${require('crypto').createHash('sha256').update(repo.release.assets[0].body).digest('hex')}  ../../../escaped.tar.gz\n`,
  );
  const forge = await fakeForge(t, { repos: { 'acme/ops': repo } });
  const tmp = tmpDir('wc-asset-');
  const got = await fetchPack({ url: forge.url('acme', 'ops'), tmpDir: tmp });
  t.after(got.cleanup);
  assert.equal(got.via, 'release');
  assert.equal(fs.existsSync(path.join(tmp, '..', 'escaped.tar.gz')), false, 'nothing was written above the work dir');
});

test('an archive using GNU base-256 size fields is refused rather than mis-listed', () => {
  // A high-bit size field reads as 0 in octal, which makes the walker treat that
  // member's DATA as the next header — every offset after it is wrong, and the
  // listing stops describing the archive. Since the listing IS the gate, a
  // desynced one is a hole.
  const src = tmpDir('wc-b256-');
  write(path.join(src, 'x'), 'x');
  const buf = Buffer.from(makeTar([{ name: 'pack-1/x', type: 'file', mode: 0o644, source: path.join(src, 'x') }]));
  buf[124] = 0x80;                        // flip the size field into base-256
  const f = path.join(src, 'b256.tar.gz');
  fs.writeFileSync(f, zlib.gzipSync(buf));
  assert.throws(() => listTarGz(f), /base-256/);
  assert.throws(() => assertSafeMembers(f), /could not read the pack archive/);
});
