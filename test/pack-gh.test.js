// Fetching a pack through `gh`.
//
// A component pack can live in a PRIVATE repository, which the plain HTTP path
// cannot reach: it authenticates only if GITHUB_TOKEN happens to be exported,
// and even then a bare PAT does not carry the SSO authorization an organization
// requires. If the user has `gh` on PATH and logged in, it is simply the better
// transport — it already knows who they are.
//
// These tests put a FAKE gh on PATH and let the real code shell out to it, so
// what is exercised is the actual spawn path rather than a stub standing where
// it used to be. The fake records every invocation, which is how "did it really
// use gh?" — and, more importantly, "did it correctly REFUSE to?" — are decided.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gh = require('../lib/packs/gh');
const { fetchPack } = require('../lib/packs/fetch');
const { parseSource, resolveCommit, findRelease } = require('../lib/packs/source');
const packs = require('../lib/packs/install');
const { listPacks } = require('../lib/packs/store');
const { projectPaths, claudePaths } = require('../lib/core/paths');
const {
  packFixture, tmpDir, fakeGh, tarballFile, fakeForge, repoWithArchive, sumsText,
} = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

const SHA = 'f'.repeat(40);

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

function ghRepo(dir, { sha = SHA, release = null } = {}) {
  return {
    commits: { HEAD: sha, main: sha, [sha]: sha, 'v1.2.0': sha },
    tarballs: { [sha]: tarballFile(dir) },
    release,
  };
}

// ── host scoping: the credential goes to GitHub and nowhere else ────────────

test('gh is used for github.com', (t) => {
  fakeGh(t, { authed: true, repos: {} });
  assert.equal(gh.hostFor(parseSource('https://github.com/acme/ops-pack')), 'github.com');
});

test('gh is NEVER used for a host the user pasted', (t) => {
  fakeGh(t, { authed: true, repos: {} });
  // The URL is typed by whoever asked for the install — and on the surface that
  // can be a pane script. Spending the user's gh credential on an arbitrary host
  // is the same mistake as sending GITHUB_TOKEN there.
  assert.equal(gh.hostFor(parseSource('http://127.0.0.1:5301/acme/ops-pack')), null);
  assert.equal(gh.hostFor(parseSource('https://evil.example.com/acme/ops-pack')), null);
  assert.equal(gh.hostFor(parseSource('https://notgithub.com/acme/ops-pack')), null);
});

test('an enterprise host is used only when the user configured GH_HOST themselves', (t) => {
  fakeGh(t, { authed: true, repos: {} });
  const src = parseSource('https://github.acme-corp.com/acme/ops-pack');
  assert.equal(gh.hostFor(src, { GH_HOST: undefined }), null);
  assert.equal(gh.hostFor(src, { GH_HOST: 'github.acme-corp.com' }), 'github.acme-corp.com');
  assert.equal(gh.hostFor(src, { GH_HOST: 'github.other.com' }), null, 'a mismatched GH_HOST is not a licence');
});

test('gh logged OUT falls back to plain HTTP', (t) => {
  fakeGh(t, { authed: false, repos: {} });
  assert.equal(gh.available(), false);
  assert.equal(gh.hostFor(parseSource('https://github.com/acme/ops-pack')), null);
});

test('WEB_CHAT_NO_GH=1 forces the plain path even when gh is right there', (t) => {
  fakeGh(t, { authed: true, repos: {} });
  assert.equal(gh.available({ WEB_CHAT_NO_GH: '1' }), false);
  assert.equal(gh.hostFor(parseSource('https://github.com/acme/ops-pack'), { WEB_CHAT_NO_GH: '1' }), null);
});

// ── the api shim keeps release.getJson's contract ───────────────────────────

test('gh api resolves a commit, and a 404 reads as null rather than throwing', (t) => {
  const f = fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(packFixture()) } });
  assert.equal(gh.api('repos/acme/ops-pack/commits/main').sha, SHA);
  assert.equal(gh.api('repos/acme/ops-pack/releases/latest'), null, 'no release is null, the same as over HTTP');
  assert.equal(gh.api('repos/nobody/nothing/commits/main'), null);
  assert.ok(f.calls().some((c) => c[0] === 'api'));
});

test('resolveCommit and findRelease go through gh for a github URL', async (t) => {
  const dir = packFixture();
  const f = fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(dir) } });
  const src = parseSource('https://github.com/acme/ops-pack');
  assert.equal(await resolveCommit(src, 'main'), SHA);
  assert.equal(await findRelease(src, null), null);
  const apiCalls = f.calls().filter((c) => c[0] === 'api').map((c) => c[1]);
  assert.ok(apiCalls.includes('repos/acme/ops-pack/commits/main'));
  assert.ok(apiCalls.includes('repos/acme/ops-pack/releases/latest'));
});

// ── a whole fetch, over gh ──────────────────────────────────────────────────

test('a private pack is fetched end to end through gh — no HTTP at all', async (t) => {
  const dir = packFixture({ components: [{ name: 'deploy-board' }, { name: 'incident-timeline' }] });
  const f = fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(dir) } });

  const got = await fetchPack({ url: 'https://github.com/acme/ops-pack', tmpDir: tmpDir('wc-ghfetch-') });
  t.after(got.cleanup);

  assert.equal(got.via, 'archive');
  assert.equal(got.sha, SHA);
  assert.equal(got.source.transport, 'gh', 'provenance records which transport was used');
  assert.ok(got.files.includes('components/deploy-board/component.html'));
  assert.ok(got.files.includes('SKILL.md'));

  const calls = f.calls();
  assert.ok(calls.some((c) => c[0] === 'api' && c[1] === `repos/acme/ops-pack/tarball/${SHA}`),
    'the tarball came down through gh, which is the only way to read a private repo');
});

test('a released private pack verifies its SHA256SUMS over gh too', async (t) => {
  const dir = packFixture();
  const tar = tarballFile(dir);
  const sumsPath = path.join(tmpDir('wc-ghsums-'), 'SHA256SUMS');
  fs.writeFileSync(sumsPath, sumsText([{ name: 'ops.tar.gz', body: fs.readFileSync(tar) }]));

  const f = fakeGh(t, {
    authed: true,
    repos: {
      'acme/ops-pack': {
        commits: { HEAD: SHA, 'v1.2.0': SHA, [SHA]: SHA },
        tarballs: { [SHA]: tar },
        release: { tag: 'v1.2.0', assets: [{ name: 'ops.tar.gz', file: tar }, { name: 'SHA256SUMS', file: sumsPath }] },
      },
    },
  });

  const got = await fetchPack({ url: 'https://github.com/acme/ops-pack', tmpDir: tmpDir('wc-ghrel-') });
  t.after(got.cleanup);

  assert.equal(got.via, 'release');
  assert.equal(got.sumsVerified, true);
  assert.equal(got.source.transport, 'gh');

  // Both assets came through gh. Fetching the tarball one way and its checksums
  // the other is how you end up verifying one release against another's sums.
  const downloads = f.calls().filter((c) => c[0] === 'release' && c[1] === 'download');
  const patterns = downloads.map((c) => c[c.indexOf('--pattern') + 1]).sort();
  assert.deepEqual(patterns, ['SHA256SUMS', 'ops.tar.gz']);
  assert.ok(downloads.every((c) => c.includes('--output') && c[c.indexOf('--output') + 1] === '-'),
    'assets stream to stdout — a remote-supplied name never picks a path on disk');
});

test('a tampered asset is still refused when it arrives over gh', async (t) => {
  const dir = packFixture();
  const tar = tarballFile(dir);
  const sumsPath = path.join(tmpDir('wc-ghsums-'), 'SHA256SUMS');
  // Sums published for DIFFERENT bytes than the asset actually carries.
  fs.writeFileSync(sumsPath, sumsText([{ name: 'ops.tar.gz', body: Buffer.from('something else entirely') }]));

  fakeGh(t, {
    authed: true,
    repos: {
      'acme/ops-pack': {
        commits: { HEAD: SHA, 'v1.2.0': SHA },
        tarballs: { [SHA]: tar },
        release: { tag: 'v1.2.0', assets: [{ name: 'ops.tar.gz', file: tar }, { name: 'SHA256SUMS', file: sumsPath }] },
      },
    },
  });
  await assert.rejects(
    fetchPack({ url: 'https://github.com/acme/ops-pack', tmpDir: tmpDir('wc-ghbad-') }),
    /checksum mismatch/,
  );
});

test('the byte cap is enforced on the gh transport too', async (t) => {
  const dir = packFixture();
  fs.writeFileSync(path.join(dir, 'big.bin'), require('crypto').randomBytes(256 * 1024));
  fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(dir) } });
  await assert.rejects(
    fetchPack({ url: 'https://github.com/acme/ops-pack', tmpDir: tmpDir('wc-ghcap-'), maxBytes: 2048 }),
    /exceeded 2048 bytes/,
  );
});

test('installing a private pack through gh lands it like any other', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(dir) } });

  const out = await packs.installPack({ url: 'https://github.com/acme/ops-pack', root, actor: 'cli' });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html')));
  assert.ok(fs.existsSync(claudePaths(root).skill('acme-ops')));
  assert.equal(listPacks(root)[0].source.transport, 'gh');
});

// ── the fallback, proven by absence ─────────────────────────────────────────

test('with gh RIGHT THERE, a non-GitHub pack still goes over plain HTTP', async (t) => {
  const dir = packFixture();
  const f = fakeGh(t, { authed: true, repos: { 'acme/ops-pack': ghRepo(dir) } });
  const forge = await fakeForge(t, { repos: { 'acme/ops-pack': repoWithArchive(dir, { sha: 'a'.repeat(40) }) } });

  const got = await fetchPack({ url: forge.url('acme', 'ops-pack'), tmpDir: tmpDir('wc-nogh-') });
  t.after(got.cleanup);

  assert.equal(got.source.transport, 'https');
  assert.equal(got.sha, 'a'.repeat(40));
  const reached = f.calls().filter((c) => c[0] === 'api' || c[0] === 'release');
  assert.deepEqual(reached, [], 'gh was never invoked for a host that is not GitHub');
});

test('with NO gh on PATH, a github pack still fetches over plain HTTP', async (t) => {
  const prev = process.env.WEB_CHAT_NO_GH;
  process.env.WEB_CHAT_NO_GH = '1';
  gh.resetAvailability();
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_CHAT_NO_GH; else process.env.WEB_CHAT_NO_GH = prev;
    gh.resetAvailability();
  });

  // A public pack over the plain path is exactly what everyone without gh gets.
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops-pack': repoWithArchive(dir, { sha: 'a'.repeat(40) }) } });
  const got = await fetchPack({ url: forge.url('acme', 'ops-pack'), tmpDir: tmpDir('wc-plain-') });
  t.after(got.cleanup);
  assert.equal(got.source.transport, 'https');
});
