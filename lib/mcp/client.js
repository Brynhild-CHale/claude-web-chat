// Spawn-injecting shim over lib/client. The MCP layer is the one caller that WANTS
// auto-spawn: Claude Code spawns the MCP server fresh each session, so the first
// tool call (or hook, or doctor probe) must transparently bring the daemon up if
// it isn't already. We opt in by defaulting spawn:true on every get/post; a caller
// can still pass opts.noSpawn (the turn-end unlock does) and it wins over spawn:true
// in lib/client's api, so we never resurrect a daemon the user has closed.
const c = require('../client');

module.exports = {
  ...c,
  get: (p, o) => c.get(p, { spawn: true, ...o }),
  post: (p, b, o) => c.post(p, b, { spawn: true, ...o }),
  NoServerError: c.NoServerError,
};
