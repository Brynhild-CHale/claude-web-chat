const fs = require('fs');
const path = require('path');
const https = require('https');
const { userPaths } = require('../core/paths');

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

// Distribution is the public git repo, not the npm
// registry. Poll the default-branch package.json version on raw.githubusercontent
// instead of `registry.npmjs.org`. Same https.get mechanism (conventions ratchet
// untouched), same 24h throttle and silent-failure behavior.
const RAW_PACKAGE_URL =
  'https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/package.json';

function fetchLatest(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = https.get(RAW_PACKAGE_URL, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.version || null);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function check({ currentVersion }) {
  const cache = readCache();
  const now = Date.now();
  let latest = cache.latest;
  if (!cache.last_check || (now - cache.last_check) > THROTTLE_MS) {
    try {
      latest = await fetchLatest();
      writeCache({ last_check: now, latest, current_at_check: currentVersion });
    } catch {
      // Network unreachable / registry down / package not published yet — silent.
      writeCache({ last_check: now, latest: cache.latest || null, error: 'fetch failed' });
    }
  }
  if (latest && latest !== currentVersion) {
    process.stderr.write(`[claude-web-chat] v${latest} available (current: v${currentVersion}). Run: claude-web-chat update\n`);
  }
}

module.exports = { check, clearCache, cachePath };
