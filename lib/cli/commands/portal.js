// `claude-web-chat portal run` — the foreground tunnel portal (lib/portal).
//
// Hidden: nobody types it. `tunnel up` spawns it detached, the way `hub run` is
// what ensureHub execs. It reads ~/.web-chat/tunnel/tunnel.json and refuses to
// start on a config it cannot fully understand — the portal is access control,
// and a half-read allowlist is not one.

const { userPaths } = require('../../core/paths');
const { readJson } = require('../../core/fsjson');
const { createPortal } = require('../../portal');
const { normalizeConfig } = require('../../portal/config');

function loadConfig(file = userPaths().tunnelConfig) {
  const r = readJson(file);
  if (r.absent) {
    const e = new Error(`no tunnel config at ${file} — run \`claude-web-chat tunnel setup\` first`);
    e.userFacing = true;
    throw e;
  }
  if (!r.ok) {
    const e = new Error(`tunnel config ${file} is unreadable: ${r.error && r.error.message}`);
    e.userFacing = true;
    throw e;
  }
  return normalizeConfig(r.value);
}

async function portal(args) {
  const sub = args[0];
  if (sub === 'run') {
    const config = loadConfig();
    const p = createPortal({ config, log: (line) => console.log(`[portal] ${line}`) });
    p.installSignalHandlers();
    await p.start();
    console.log(`web-chat portal listening on http://127.0.0.1:${p.server.address().port} for ${config.hostname}`);
    return;
  }
  const e = new Error('usage: claude-web-chat portal run   (internal — manage remote access with `claude-web-chat tunnel`)');
  e.userFacing = true;
  throw e;
}

module.exports = portal;
module.exports.loadConfig = loadConfig;
