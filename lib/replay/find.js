// Finding the host programs a replay render uses: a system Chrome (to draw the
// frames) and ffmpeg (an optional, better encoder). Neither ships with the
// package — the release tarball keeps to its four runtime dependencies, and a
// bundled browser would be hundreds of megabytes — so a render uses what the
// machine already has, and says plainly when it has nothing.
//
// One place decides, so the render route, GET /api/replay/capabilities and
// `claude-web-chat doctor` cannot disagree about whether Chrome is "there".
//
// Order, first hit wins:
//   Chrome  WEB_CHAT_CHROME (an explicit override: when set it is the ONLY
//           candidate, so a wrong value is reported rather than quietly routed
//           around) → macOS app bundles (Chrome, Chromium, Edge, Brave) →
//           executables on PATH (google-chrome, chromium, microsoft-edge, …).
//   ffmpeg  WEB_CHAT_FFMPEG (same override rule) → `ffmpeg` on PATH.
//
// Every function takes { env, platform, isExecutable } so the tests can describe
// a machine instead of depending on this one.

const fs = require('fs');
const path = require('path');

const MAC_BUNDLES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

// Linux and WSL2 (a Linux Chrome inside the distro — a Windows Chrome under
// /mnt/c cannot share a pipe with a Linux process, so it is not a candidate).
const PATH_NAMES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'microsoft-edge-stable', 'brave-browser',
];

function defaultIsExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function onPath(name, { env = process.env, isExecutable = defaultIsExecutable } = {}) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

// Where findChrome looks, in order — for the hint a `chrome-not-found` carries.
function chromeCandidates({ env = process.env, platform = process.platform } = {}) {
  if (env.WEB_CHAT_CHROME) return [env.WEB_CHAT_CHROME];
  return platform === 'darwin' ? [...MAC_BUNDLES, ...PATH_NAMES] : [...PATH_NAMES];
}

// → absolute path of a Chrome-family browser, or null.
function findChrome({ env = process.env, platform = process.platform, isExecutable = defaultIsExecutable } = {}) {
  if (env.WEB_CHAT_CHROME) return isExecutable(env.WEB_CHAT_CHROME) ? env.WEB_CHAT_CHROME : null;
  if (platform === 'darwin') {
    for (const p of MAC_BUNDLES) if (isExecutable(p)) return p;
  }
  for (const name of PATH_NAMES) {
    const p = onPath(name, { env, isExecutable });
    if (p) return p;
  }
  return null;
}

// → absolute path of ffmpeg, or null.
function findFfmpeg({ env = process.env, isExecutable = defaultIsExecutable } = {}) {
  if (env.WEB_CHAT_FFMPEG) return isExecutable(env.WEB_CHAT_FFMPEG) ? env.WEB_CHAT_FFMPEG : null;
  return onPath('ffmpeg', { env, isExecutable });
}

const CHROME_HINT = 'A GIF is drawn by a headless Chrome-family browser already on this machine. '
  + 'Install Google Chrome, Chromium, Microsoft Edge or Brave, or point WEB_CHAT_CHROME at one '
  + '(e.g. WEB_CHAT_CHROME=/path/to/chrome) in the environment the daemon starts from, then '
  + '`claude-web-chat restart`. A replay as .html needs no browser.';

module.exports = { findChrome, findFfmpeg, chromeCandidates, onPath, CHROME_HINT, MAC_BUNDLES, PATH_NAMES };
