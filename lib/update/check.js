const fs = require('fs');
const path = require('path');
const { userPaths } = require('../core/paths');
const { fetchLatestRelease } = require('./release');

const THROTTLE_MS = 24 * 60 * 60 * 1000;

function cachePath() {
  return userPaths().updateCheck;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')); }
  catch { return {}; }
}

function writeCache(data) {
  const f = cachePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
}

function clearCache() {
  try { fs.unlinkSync(cachePath()); } catch {}
}

// Releases are the distribution. Ask GitHub for the latest RELEASE rather than
// reading the default branch's package.json: a branch version moves the moment a
// bump lands, so users were told about builds that had not been released yet,
// and a maintainer working ahead of main saw their own unreleased build
// advertised back to them as an update.
const REPO_SLUG = process.env.WEB_CHAT_REPO || 'Brynhild-CHale/claude-web-chat';
const RELEASES_PAGE = `https://github.com/${REPO_SLUG}/releases/latest`;

// The comparator now lives in lib/core/versions.js — one implementation shared
// with install-layout's version-store ordering. Re-exported here so existing
// callers (and test/version.test.js) keep resolving it from this module.
const { compareVersions } = require('../core/versions');

// "What is the latest release?" is asked by two callers with different needs —
// this throttled check, and `update`, which also needs the assets. One
// implementation answers both (lib/update/release.js); this one keeps only the
// version string. A repo with no published release 404s rather than erroring,
// which release.js already reports as null: the same thing as "no update known".
async function fetchLatest(timeoutMs = 2500) {
  const release = await fetchLatestRelease({ timeoutMs });
  return release ? release.version : null;
}

// The programmatic check: resolve the latest published release (throttled +
// cached) and report whether it is NEWER than the running build. `force:true`
// bypasses the 24h throttle. Never throws — a failed fetch degrades to the last
// cached `latest` (or null). Returns { current, latest, updateAvailable,
// checkedAt, releaseUrl }. The stderr `check()` and the server's GET /api/version
// share this one implementation, so "is an update available" is decided once.
async function resolveLatest({ currentVersion, force = false } = {}) {
  const cache = readCache();
  const now = Date.now();
  let latest = cache.latest || null;
  let checkedAt = cache.last_check || 0;
  if (force || !cache.last_check || (now - cache.last_check) > THROTTLE_MS) {
    try {
      latest = await fetchLatest();
      writeCache({ last_check: now, latest, current_at_check: currentVersion });
    } catch {
      // Network unreachable / GitHub down / rate-limited — silent.
      writeCache({ last_check: now, latest: cache.latest || null, error: 'fetch failed' });
      latest = cache.latest || null;
    }
    checkedAt = now;
  }
  return {
    current: currentVersion,
    latest,
    // STRICTLY newer. "Any difference" used to count, which meant a local build
    // ahead of the last release advertised — and offered to install — a downgrade.
    updateAvailable: !!(latest && compareVersions(latest, currentVersion) > 0),
    checkedAt,
    releaseUrl: RELEASES_PAGE,
  };
}

// The READ-ONLY twin of resolveLatest: report what the throttle cache already
// knows, with no HTTPS call and — crucially — no cache WRITE. `init --report`
// promises the caller it changes nothing on disk, and resolveLatest rewrites
// ~/.web-chat/update-check.json whenever the 24h throttle has expired. Same
// return shape, so a consumer can swap one for the other.
function peekLatest({ currentVersion } = {}) {
  const cache = readCache();
  const latest = cache.latest || null;
  return {
    current: currentVersion,
    latest,
    updateAvailable: !!(latest && compareVersions(latest, currentVersion) > 0),
    checkedAt: cache.last_check || 0,
    releaseUrl: RELEASES_PAGE,
  };
}

async function check({ currentVersion }) {
  const { latest, updateAvailable } = await resolveLatest({ currentVersion });
  if (updateAvailable) {
    process.stderr.write(`[claude-web-chat] v${latest} available (current: v${currentVersion}). Run: claude-web-chat update\n`);
  }
}

module.exports = { check, resolveLatest, peekLatest, clearCache, cachePath, compareVersions, RELEASES_PAGE };
