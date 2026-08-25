// GitHub Releases — the distribution channel, and the only one.
//
// A release carries two assets: `claude-web-chat-<version>.tar.gz` (the whole
// runnable program, including production node_modules — the package has four
// runtime dependencies, so a source-only tarball dies on `Cannot find module
// 'express'`) and `SHA256SUMS`. This module fetches them, VERIFIES the checksum
// before anything is unpacked, and unpacks into a staging directory that is only
// moved into place once it is complete. A download that dies halfway leaves the
// previous install untouched.
//
// npm is not involved: no registry, no `npm i -g`, no shared global prefix that
// an unrelated install can clobber. See lib/core/paths.js for the layout and
// lib/update/install-layout.js for the activation/rollback mechanics.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const REPO_SLUG = process.env.WEB_CHAT_REPO || 'Brynhild-CHale/claude-web-chat';
// Overridable so the release path can be exercised end-to-end against a local
// stand-in for GitHub — the download/verify/unpack code under test is then the
// same code that runs for real, rather than a mock of it.
const API_BASE = process.env.WEB_CHAT_API_BASE || `https://api.github.com/repos/${REPO_SLUG}`;

const USER_AGENT = 'claude-web-chat';
const SUMS_ASSET = 'SHA256SUMS';

function agentFor(u) {
  return u.protocol === 'http:' ? http : https;
}

// One GET with redirect following (release assets redirect to object storage).
// `onResponse` receives the final response stream.
function httpGet(url, { timeoutMs = 30_000, headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = agentFor(u).get(u, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpGet(next, { timeoutMs, headers, redirects: redirects - 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function getJson(url, opts = {}) {
  const res = await httpGet(url, { headers: { Accept: 'application/vnd.github+json' }, ...opts });
  const code = res.statusCode || 0;
  const body = await readAll(res);
  if (code === 404) return null; // no release published yet
  if (code !== 200) {
    const err = new Error(`github returned ${code} for ${url}`);
    err.statusCode = code;
    throw err;
  }
  return JSON.parse(body.toString('utf8'));
}

// Normalize a GitHub release payload down to what an install needs.
function shapeRelease(json) {
  if (!json || json.draft) return null;
  const tag = json.tag_name ? String(json.tag_name) : null;
  if (!tag) return null;
  const assets = (json.assets || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
  }));
  return { tag, version: tag.replace(/^v/, ''), assets, htmlUrl: json.html_url || null };
}

// The latest published release, or null when the repo has none yet (GitHub 404s
// rather than erroring, which is the same thing for our purposes). `apiBase` is
// injectable so tests drive a local stand-in — a test that reaches the real
// GitHub is a test that fails on a plane, and worse, one that can be rate-limited
// into a false green.
async function fetchLatestRelease({ apiBase = API_BASE, ...opts } = {}) {
  return shapeRelease(await getJson(`${apiBase}/releases/latest`, opts));
}

async function fetchReleaseByTag(tag, { apiBase = API_BASE, ...opts } = {}) {
  return shapeRelease(await getJson(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, opts));
}

function tarballName(version) {
  return `claude-web-chat-${String(version).replace(/^v/, '')}.tar.gz`;
}

// Pick the two assets an install needs. Named exactly (the build script owns the
// naming), falling back to "the only .tar.gz in the release" so a hand-made
// release with a differently-named tarball still installs.
function pickAssets(release) {
  const assets = (release && release.assets) || [];
  const want = tarballName(release.version);
  const tarballs = assets.filter((a) => a.name.endsWith('.tar.gz'));
  const tarball = assets.find((a) => a.name === want)
    || (tarballs.length === 1 ? tarballs[0] : null);
  const sums = assets.find((a) => a.name === SUMS_ASSET) || null;
  return { tarball: tarball || null, sums };
}

// Stream a URL to a file. Writes to `dest`.part and renames on success, so a
// truncated download can never be mistaken for a complete one.
async function download(url, dest, opts = {}) {
  const res = await httpGet(url, opts);
  if ((res.statusCode || 0) !== 200) {
    res.resume();
    throw new Error(`download failed: ${res.statusCode} for ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.pipe(out);
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
  fs.renameSync(part, dest);
  return dest;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// `<sha256>  <name>` per line — the format `shasum -a 256` writes and
// `shasum -a 256 -c` reads, so install.sh and this module verify the same file
// the same way.
function parseSums(text) {
  const map = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m) map[m[2]] = m[1].toLowerCase();
  }
  return map;
}

// Throws unless the file's digest matches the entry for `name` in SHA256SUMS.
// This is the gate: nothing is unpacked, and `current` is never touched, until
// it passes.
function verifyChecksum({ file, name, sumsText }) {
  const sums = parseSums(sumsText);
  const expected = sums[name];
  if (!expected) {
    throw new Error(`${SUMS_ASSET} has no entry for ${name} — refusing to install an unverified download`);
  }
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${name}\n  expected ${expected}\n  actual   ${actual}`);
  }
  return expected;
}

// Unpack a release tarball into `destDir`. The archive has a single
// `claude-web-chat-<version>/` prefix (so a hand-extraction is not a tarbomb),
// stripped here. Uses the system tar: GNU and BSD both read the plain ustar the
// build script writes.
function unpackTarball(tarball, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tarball, '--strip-components', '1', '-C', destDir], {
    encoding: 'utf8',
  });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('`tar` is not installed — it is needed to unpack a release');
  }
  if (r.status !== 0) {
    throw new Error(`tar failed (${r.status}): ${(r.stderr || '').trim()}`);
  }
  if (!fs.existsSync(path.join(destDir, 'package.json'))) {
    throw new Error(`unpacked archive has no package.json at ${destDir} — not a claude-web-chat release`);
  }
  return destDir;
}

// Download + verify + unpack a release into ~/.web-chat/versions/<version>, via
// a staging directory that is only renamed into place when the whole thing
// succeeded. Returns { version, dir }.
//
// Deliberately does NOT flip `current` — activation is a separate, atomic step
// (install-layout.activate) so a failed fetch cannot leave a half-installed
// version selected.
async function fetchAndUnpack({ release, versionDir, log = () => {}, tmpDir } = {}) {
  const { tarball, sums } = pickAssets(release);
  if (!tarball) {
    throw new Error(`release ${release.tag} has no tarball asset (expected ${tarballName(release.version)})`);
  }
  if (!sums) {
    throw new Error(`release ${release.tag} has no ${SUMS_ASSET} asset — refusing to install an unverified download`);
  }

  const work = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'wc-release-'));
  try {
    log(`  downloading ${tarball.name}...`);
    const tarPath = path.join(work, tarball.name);
    await download(tarball.url, tarPath);
    const sumsRes = await httpGet(sums.url);
    if ((sumsRes.statusCode || 0) !== 200) {
      sumsRes.resume();
      throw new Error(`could not fetch ${SUMS_ASSET} (${sumsRes.statusCode})`);
    }
    const sumsText = (await readAll(sumsRes)).toString('utf8');

    const digest = verifyChecksum({ file: tarPath, name: tarball.name, sumsText });
    log(`  checksum ok (sha256 ${digest.slice(0, 12)}…)`);

    const staging = path.join(work, 'unpacked');
    unpackTarball(tarPath, staging);

    // Move into place last. rename() across the same filesystem is atomic; the
    // staging dir lives under tmpDir when the caller passes one (the version
    // store itself), so this is a rename and not a copy.
    fs.mkdirSync(path.dirname(versionDir), { recursive: true });
    fs.rmSync(versionDir, { recursive: true, force: true });
    try {
      fs.renameSync(staging, versionDir);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(staging, versionDir, { recursive: true });
    }
    return { version: release.version, dir: versionDir };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  REPO_SLUG,
  API_BASE,
  SUMS_ASSET,
  httpGet,
  getJson,
  download,
  fetchLatestRelease,
  fetchReleaseByTag,
  pickAssets,
  tarballName,
  sha256File,
  parseSums,
  verifyChecksum,
  unpackTarball,
  fetchAndUnpack,
};
