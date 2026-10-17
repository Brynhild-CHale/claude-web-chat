// Spawn-injecting shim over lib/client. The MCP layer is the one caller that WANTS
// auto-spawn: Claude Code spawns the MCP server fresh each session, so the first
// tool call (or hook, or doctor probe) must transparently bring the daemon up if
// it isn't already. We opt in by defaulting spawn:true on every get/post; a caller
// can still pass opts.noSpawn (the turn-end unlock does) and it wins over spawn:true
// in lib/client's api, so we never resurrect a daemon the user has closed.
const c = require('../client');
const { mcpClientHeaders } = require('../core/mcp-seen');
const { WRITER_HEADER, readWriterToken } = require('../core/writer-token');

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

// Claude's writer token (lib/core/writer-token; PLAN 1B.4): the MCP server —
// and only it, the same test as the identity headers — sends this boot's token
// as WRITER_HEADER, so the daemon can tell Claude's writes from a pane
// script's same-origin fetch. Read lazily from the root lib/core/portfiles'
// discovery uses (opts.root, else the working directory), and cached per root
// once read; a missing file is read again on the next call (the daemon may
// not have booted yet) and the call goes out without the header — advisory
// claude, which the daemon still accepts from a local non-browser caller.
const tokens = new Map();
function rootOf(o) {
  return o && o.root != null ? o.root : process.cwd();
}
function tokenFor(root, { reread = false } = {}) {
  if (!reread && tokens.has(root)) return tokens.get(root);
  const t = readWriterToken(root);
  if (t) tokens.set(root, t); else tokens.delete(root);
  return t;
}

function withIdent(o, writerToken) {
  const id = ident();
  if (!id) return { spawn: true, ...o };
  const writer = writerToken ? { [WRITER_HEADER]: writerToken } : {};
  return { spawn: true, ...o, headers: { ...id, ...writer, ...((o && o.headers) || {}) } };
}

// The daemon refused the token as one from an earlier boot (routes/writers.js).
function isStale(e) {
  return !!(e && e.status === 401 && e.body && typeof e.body === 'object' && e.body.writer === 'stale');
}

// One call, with the token when this process is the MCP server. A `stale`
// 401 re-reads the token file ONCE and retries with what it finds; a call
// still refused (or with no token to retry with) goes out once more with no
// header — advisory claude, one stderr line — and whatever that answers is the
// answer. Never a loop. The tokenless fallback is removed at 2C's enforcement
// (a GT-15 condition; ruling U214a@stale-token-fallback).
async function call(send, o) {
  if (!ident()) return send(withIdent(o));
  const root = rootOf(o);
  const first = tokenFor(root);
  try {
    return await send(withIdent(o, first));
  } catch (e) {
    if (!first || !isStale(e)) throw e;
  }
  const fresh = tokenFor(root, { reread: true });
  if (fresh && fresh !== first) {
    try {
      return await send(withIdent(o, fresh));
    } catch (e) {
      if (!isStale(e)) throw e;
    }
  }
  tokens.delete(root);
  try {
    process.stderr.write('[web-chat] the daemon refused the writer token as stale; this call goes out without it (advisory claude)\n');
  } catch {}
  return send(withIdent(o));
}

module.exports = {
  ...c,
  get: (p, o) => call((opts) => c.get(p, opts), o),
  post: (p, b, o) => call((opts) => c.post(p, b, opts), o),
  NoServerError: c.NoServerError,
  PROCESS_STARTED_AT,
};
