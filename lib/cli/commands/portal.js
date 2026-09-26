// `claude-web-chat portal run` — the foreground tunnel portal (lib/portal).
//
// Hidden: nobody types it. `tunnel up` spawns it detached, the way `hub run` is
// what ensureHub execs. It reads ~/.web-chat/tunnel/tunnel.json through the one
// loader (lib/tunnel/config) and refuses to start on a config it cannot fully
// understand — the portal is access control, and a half-read allowlist is not
// one. When the config names a tunnel, the portal also supervises cloudflared
// (lib/tunnel/cloudflared): started once the portal is listening, restarted
// with backoff, killed when the portal exits.

const { userPaths } = require('../../core/paths');
const { createPortal } = require('../../portal');
const { loadConfig } = require('../../tunnel/config');
const { createSupervisor, findCloudflared } = require('../../tunnel/cloudflared');

async function portal(args) {
  const sub = args[0];
  if (sub === 'run') {
    const config = loadConfig();
    const log = (line) => console.log(`[portal] ${line}`);
    let supervisor = null;
    const p = createPortal({
      config,
      log,
      // Built lazily: the supervisor needs the port the portal actually bound.
      supervise: config.tunnel
        ? (port) => (supervisor = createSupervisor({
          config, portalPort: port, logFile: userPaths().cloudflaredLog, log,
          // `tunnel up` checked this binary's version; spawn that same file.
          bin: findCloudflared() || 'cloudflared',
        }))
        : null,
    });
    p.installSignalHandlers();
    await p.start();
    console.log(`web-chat portal listening on http://127.0.0.1:${p.server.address().port} for ${config.hostname}`
      + (supervisor ? ` — supervising cloudflared (${config.tunnel.kind} tunnel)` : ' — no tunnel configured; run cloudflared yourself'));
    return;
  }
  const e = new Error('usage: claude-web-chat portal run   (internal — manage remote access with `claude-web-chat tunnel`)');
  e.userFacing = true;
  throw e;
}

module.exports = portal;
