// Fetching a release: resolve → download → VERIFY → unpack → move into place.
//
// Driven against a real HTTP server standing in for GitHub, so the code under
// test is the code that runs for real (redirect following, streaming to disk,
// the checksum gate) rather than a mock of it. The gate is the point: an
// unverified or truncated download must never reach ~/.web-chat/versions, and a
// failure must leave whatever is installed exactly as it was.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const release = require('../lib/update/release');
const { makeTar } = require('../scripts/build-release');

function tmpDir(prefix = 'wc-release-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A miniature but genuine release tarball: one prefix dir, a package.json, a bin.
function fakeTarball(version) {
  const src = tmpDir('wc-src-');
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  fs.writeFileSync(path.join(src, 'bin', 'claude-web-chat.js'), '#!/usr/bin/env node\n');
  const prefix = `claude-web-chat-${version}`;
  return zlib.gzipSync(makeTar([
    { name: `${prefix}/package.json`, type: 'file', mode: 0o644, source: path.join(src, 'package.json') },
    { name: `${prefix}/bin`, type: 'dir' },
    { name: `${prefix}/bin/claude-web-chat.js`, type: 'file', mode: 0o755, source: path.join(src, 'bin', 'claude-web-chat.js') },
  ]));
}

// A stand-in for the two endpoints an install talks to. `state` is mutable so a
// test can corrupt the sums or drop an asset between requests.
async function fakeGithub(t, state) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/releases/')) {
      if (state.noRelease) { res.writeHead(404); res.end('{"message":"Not Found"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: `v${state.version}`,
        draft: Boolean(state.draft),
        assets: state.assets.map((a) => ({ name: a.name, size: a.body.length, browser_download_url: `${base()}/dl/${a.name}` })),
      }));
      return;
    }
    // One hop of redirect, the way a real asset download goes to object storage.
    if (req.url.startsWith('/dl/')) {
      res.writeHead(302, { Location: `${base()}/obj/${req.url.slice(4)}` });
      res.end();
      return;
    }
    if (req.url.startsWith('/obj/')) {
      const name = decodeURIComponent(req.url.slice(5));
      const asset = state.assets.find((a) => a.name === name);
      if (!asset) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Length': asset.body.length });
      res.end(asset.body);
      return;
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = () => `http://127.0.0.1:${srv.address().port}`;
  return `${base()}`;
}

function sums(entries) {
  return entries.map(({ name, body }) => `${crypto.createHash('sha256').update(body).digest('hex')}  ${name}\n`).join('');
}

function releaseState(version = '0.5.0') {
  const tgz = fakeTarball(version);
  const name = `claude-web-chat-${version}.tar.gz`;
  const sumsBody = Buffer.from(sums([{ name, body: tgz }]));
  return {
    version,
    assets: [
      { name, body: tgz },
      { name: 'SHA256SUMS', body: sumsBody },
    ],
  };
}

test('a published release resolves to its version and its two assets', async (t) => {
  const state = releaseState('0.5.0');
  const base = await fakeGithub(t, state);
  const rel = await release.fetchLatestRelease({ apiBase: base });
  assert.equal(rel.tag, 'v0.5.0');
  assert.equal(rel.version, '0.5.0');
  const picked = release.pickAssets(rel);
  assert.equal(picked.tarball.name, 'claude-web-chat-0.5.0.tar.gz');
  assert.equal(picked.sums.name, 'SHA256SUMS');
});

test('a repo with no published release reads as "nothing to update to", not an error', async (t) => {
  const base = await fakeGithub(t, { noRelease: true, version: '0', assets: [] });
  assert.equal(await release.fetchLatestRelease({ apiBase: base }), null);
});

test('a DRAFT release is not offered as an update', async (t) => {
  const state = releaseState('0.9.0');
  state.draft = true;
  const base = await fakeGithub(t, state);
  assert.equal(await release.fetchLatestRelease({ apiBase: base }), null);
});

test('download → verify → unpack lands a complete version directory', async (t) => {
  const state = releaseState('0.5.0');
  const base = await fakeGithub(t, state);
  const store = tmpDir('wc-store-');
  const rel = {
    tag: 'v0.5.0',
    version: '0.5.0',
    assets: state.assets.map((a) => ({ name: a.name, url: `${base}/dl/${a.name}` })),
  };
  const out = await release.fetchAndUnpack({ release: rel, versionDir: path.join(store, '0.5.0'), tmpDir: store });
  assert.equal(out.version, '0.5.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out.dir, 'package.json'), 'utf8')).version, '0.5.0');
  // The executable bit survives the round trip — the bins are what get linked.
  assert.ok(fs.statSync(path.join(out.dir, 'bin', 'claude-web-chat.js')).mode & 0o111);
  // Nothing but the version dir is left behind in the store.
  assert.deepEqual(fs.readdirSync(store), ['0.5.0']);
});

test('a tampered tarball is refused, and nothing is written to the version store', async (t) => {
  const state = releaseState('0.5.0');
  // Corrupt the asset AFTER its checksum was published — a tampered mirror, or
  // a truncated transfer, are indistinguishable here and both must be refused.
  state.assets[0].body = Buffer.concat([state.assets[0].body, Buffer.from('junk')]);
  const base = await fakeGithub(t, state);
  const store = tmpDir('wc-store-');
  const rel = {
    tag: 'v0.5.0', version: '0.5.0',
    assets: state.assets.map((a) => ({ name: a.name, url: `${base}/dl/${a.name}` })),
  };
  await assert.rejects(
    release.fetchAndUnpack({ release: rel, versionDir: path.join(store, '0.5.0'), tmpDir: store }),
    /checksum mismatch/,
  );
  assert.deepEqual(fs.readdirSync(store), [], 'a failed verify leaves the version store untouched');
});

test('a release with no SHA256SUMS is refused rather than trusted', async (t) => {
  const state = releaseState('0.5.0');
  state.assets = state.assets.filter((a) => a.name !== 'SHA256SUMS');
  const base = await fakeGithub(t, state);
  const store = tmpDir('wc-store-');
  const rel = {
    tag: 'v0.5.0', version: '0.5.0',
    assets: state.assets.map((a) => ({ name: a.name, url: `${base}/dl/${a.name}` })),
  };
  await assert.rejects(
    release.fetchAndUnpack({ release: rel, versionDir: path.join(store, '0.5.0'), tmpDir: store }),
    /SHA256SUMS/,
  );
});

test('SHA256SUMS is parsed in the format `shasum -a 256` writes and -c reads', () => {
  const dir = tmpDir('wc-sums-');
  const f = path.join(dir, 'thing.tar.gz');
  fs.writeFileSync(f, 'hello');
  const digest = release.sha256File(f);
  const text = `${digest}  thing.tar.gz\n`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), text);
  assert.deepEqual(release.parseSums(text), { 'thing.tar.gz': digest });
  assert.equal(release.verifyChecksum({ file: f, name: 'thing.tar.gz', sumsText: text }), digest);
  // The stock tool agrees — install.sh verifies with it, so the formats must match.
  const tool = fs.existsSync('/usr/bin/shasum') ? ['/usr/bin/shasum', ['-a', '256', '-c', 'SHA256SUMS']] : null;
  if (tool) {
    const out = execFileSync(tool[0], tool[1], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /thing\.tar\.gz: OK/);
  }
});

test('unpackTarball rejects an archive that is not a claude-web-chat release', () => {
  const dir = tmpDir('wc-bad-');
  const f = path.join(dir, 'x.tar.gz');
  const src = tmpDir('wc-badsrc-');
  fs.writeFileSync(path.join(src, 'readme.txt'), 'nope');
  fs.writeFileSync(f, zlib.gzipSync(makeTar([
    { name: 'something/readme.txt', type: 'file', mode: 0o644, source: path.join(src, 'readme.txt') },
  ])));
  assert.throws(() => release.unpackTarball(f, path.join(dir, 'out')), /no package\.json/);
});

// ── the redirect credential guard ──────────────────────────────────────────
// A release asset URL redirects to object storage on a DIFFERENT host. Any
// credentialed header carried across that hop is handed to whoever answers
// there. This was latent while nothing minted a token; honoring GITHUB_TOKEN
// (which a pack install must, since unauthenticated api.github.com is 60
// req/hr/IP) makes it a live leak. These two tests are the guard.

// Two independent servers, so a redirect between them is genuinely cross-origin
// (different port ⇒ different origin). Each records the headers it was sent.
async function recordingServer(t, handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    handler(req, res, () => `http://127.0.0.1:${srv.address().port}`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { seen, base: () => `http://127.0.0.1:${srv.address().port}` };
}

test('Authorization is DROPPED on a cross-host redirect — the second host never sees the token', async (t) => {
  const dest = await recordingServer(t, (req, res) => { res.writeHead(200); res.end('payload'); });
  const origin = await recordingServer(t, (req, res) => {
    res.writeHead(302, { Location: `${dest.base()}/obj/thing` });
    res.end();
  });

  const res = await release.httpGet(`${origin.base()}/dl/thing`, {
    headers: { Authorization: 'Bearer super-secret', Cookie: 'session=abc', Accept: 'application/json' },
  });
  assert.equal(res.statusCode, 200);
  res.resume();

  assert.equal(origin.seen[0].headers.authorization, 'Bearer super-secret', 'the origin host is the one we meant to authenticate to');
  assert.equal(dest.seen.length, 1, 'the redirect was followed');
  assert.equal(dest.seen[0].headers.authorization, undefined, 'the token must not cross the origin boundary');
  assert.equal(dest.seen[0].headers.cookie, undefined, 'nor may a cookie');
  assert.equal(dest.seen[0].headers.accept, 'application/json', 'non-sensitive headers still travel');
});

test('Authorization SURVIVES a same-origin redirect (else authenticated fetches break)', async (t) => {
  const srv = await recordingServer(t, (req, res, base) => {
    if (req.url === '/a') { res.writeHead(302, { Location: `${base()}/b` }); res.end(); return; }
    res.writeHead(200); res.end('ok');
  });
  const res = await release.httpGet(`${srv.base()}/a`, { headers: { Authorization: 'Bearer keep-me' } });
  res.resume();
  assert.equal(srv.seen.length, 2);
  assert.equal(srv.seen[1].headers.authorization, 'Bearer keep-me');
});

test('githubAuth mints a token for github.com only — never for a host the user pasted', () => {
  const env = { GITHUB_TOKEN: 'tok' };
  assert.deepEqual(release.githubAuth('https://api.github.com/repos/a/b', env), { Authorization: 'Bearer tok' });
  assert.deepEqual(release.githubAuth('https://codeload.github.com/a/b/tar.gz/x', env), { Authorization: 'Bearer tok' });
  assert.deepEqual(release.githubAuth('https://evil.example.com/repos/a/b', env), {});
  assert.deepEqual(release.githubAuth('https://notgithub.com/x', env), {});
  assert.deepEqual(release.githubAuth('https://api.github.com/x', {}), {}, 'no token, no header');
});

test('download enforces maxBytes mid-stream and leaves no .part behind', async (t) => {
  const big = Buffer.alloc(64 * 1024, 0x61);
  const srv = await recordingServer(t, (req, res) => {
    // No Content-Length: the cap must be enforced on the bytes actually seen,
    // not on a header the server is free to omit or lie about.
    res.writeHead(200);
    res.end(big);
  });
  const dir = tmpDir('wc-cap-');
  const dest = path.join(dir, 'thing.tar.gz');
  await assert.rejects(
    release.download(`${srv.base()}/big`, dest, { maxBytes: 1024 }),
    /exceeded 1024 bytes/,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'neither the file nor its .part survives an overflow');
});

test('download under the cap still lands the whole file', async (t) => {
  const body = Buffer.from('small enough');
  const srv = await recordingServer(t, (req, res) => { res.writeHead(200); res.end(body); });
  const dir = tmpDir('wc-cap-ok-');
  const dest = path.join(dir, 'thing.bin');
  await release.download(`${srv.base()}/small`, dest, { maxBytes: 1024 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'small enough');
  assert.deepEqual(fs.readdirSync(dir), ['thing.bin']);
});
