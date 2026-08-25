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
