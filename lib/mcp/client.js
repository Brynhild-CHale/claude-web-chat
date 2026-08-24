// Spawn-injecting shim over lib/client. The MCP layer is the one caller that WANTS
// auto-spawn: Claude Code spawns the MCP server fresh each session, so the first
// tool call (or hook, or doctor probe) must transparently bring the daemon up if
// it isn't already. We opt in by defaulting spawn:true on every get/post; a caller
// can still pass opts.noSpawn (the turn-end unlock does) and it wins over spawn:true
// in lib/client's api, so we never resurrect a daemon the user has closed.
const c = require('../client');
const { mcpClientHeaders } = require('../core/mcp-seen');

// This process's start time, near enough. When this process IS the MCP server
// Claude Code spawned (lib/mcp/index.js sets WEB_CHAT_MCP_SERVER=1), that is the
// session's start time — the one thing that can prove whether the user restarted
// Claude Code after `install` rewrote .mcp.json. See lib/core/mcp-seen.js.
// Computed once, at require time, so it isn't skewed by a long-lived process.
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

// Identity headers, only for the MCP server process. The CLI and the hooks use
// this same shim and must NOT be counted — a hook firing proves a turn began,
// not that the MCP tool list was reloaded.
function ident() {
  return mcpClientHeaders({ startedAt: PROCESS_STARTED_AT });
}

function withIdent(o) {
  const id = ident();
  if (!id) return { spawn: true, ...o };
  return { spawn: true, ...o, headers: { ...id, ...((o && o.headers) || {}) } };
}

module.exports = {
  ...c,
  get: (p, o) => c.get(p, withIdent(o)),
  post: (p, b, o) => c.post(p, b, withIdent(o)),
  NoServerError: c.NoServerError,
  PROCESS_STARTED_AT,
};
