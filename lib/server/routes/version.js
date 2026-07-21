// Version / self-update surface. GET /api/version reports the running build vs
// the latest on the git remote (throttled + cached in update/check — one home for
// "is an update available"); POST /api/update spawns a DETACHED
// `claude-web-chat update` that pulls the new build and bounces the daemon.
//
// The restart is state-preserving by construction: the CLI `update` SIGTERMs the
// daemon, whose graceful shutdown snapshots live surface state to draft.json, then
// starts a fresh daemon that restores it. So an open browser tab just drops its
// socket, reconnects, and rehydrates — no rendered state is destroyed. The updater
// runs detached + unref'd so it outlives the very daemon it restarts.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { resolveLatest } = require('../../update/check');
const { projectPaths } = require('../../core/paths');
const pkg = require('../../../package.json');

// After kicking off an update the daemon is expected to die + respawn within
// seconds. This flag only debounces a double-click before that happens; it
// auto-clears so a FAILED update (npm error → no restart, daemon survives) doesn't
// wedge the button permanently.
const UPDATING_TTL_MS = 3 * 60 * 1000;

// The updater argv. Default: the installed CLI's `update` subcommand via this
// package's own bin. WEB_CHAT_UPDATE_CMD (a JSON argv array) overrides it — the
// test suite points it at a harmless command so it never shells out to npm or
// restarts the in-process test server.
function updaterArgv() {
  const override = process.env.WEB_CHAT_UPDATE_CMD;
  if (override) {
    try {
      const argv = JSON.parse(override);
      if (Array.isArray(argv) && argv.length) return argv;
    } catch { /* fall through to the default */ }
  }
  const binPath = path.join(__dirname, '..', '..', '..', 'bin', 'claude-web-chat.js');
  return [process.execPath, binPath, 'update'];
}

function mountVersionRoutes(app, { root }) {
  let updating = false;
  let updatingTimer = null;

  app.get('/api/version', async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    let info;
    try {
      info = await resolveLatest({ currentVersion: pkg.version, force });
    } catch {
      info = { current: pkg.version, latest: null, updateAvailable: false, checkedAt: 0 };
    }
    res.json({ ok: true, updating, ...info });
  });

  app.post('/api/update', (req, res) => {
    if (updating) return res.json({ ok: true, started: false, updating: true });
    let child;
    try {
      const argv = updaterArgv();
      const out = fs.openSync(projectPaths(root).serverLog, 'a');
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', out, out], cwd: root });
      child.unref();
    } catch (e) {
      return res.status(500).json({ ok: false, error: `failed to start updater: ${e.message}` });
    }
    updating = true;
    if (updatingTimer) clearTimeout(updatingTimer);
    updatingTimer = setTimeout(() => { updating = false; }, UPDATING_TTL_MS);
    if (updatingTimer.unref) updatingTimer.unref();
    res.json({ ok: true, started: true });
  });
}

module.exports = { mountVersionRoutes };
