// "Has Claude Code been restarted since .mcp.json last changed?" — one home.
//
// The problem: `claude-web-chat install` writes .mcp.json, but Claude Code reads
// that file ONLY at process start. Until the user restarts, none of the 23 MCP
// tools exist in their session, and nothing anywhere says so — the user sits
// there concluding web-chat is broken.
//
// The only signal that can PROVE a restart is the MCP server process itself: it
// is spawned by Claude Code at session start, so its start time is (near enough)
// the session's start time. lib/mcp/client tags every daemon request from that
// process with `X-WC-Client: mcp` + `X-WC-MCP-Started: <ms>`; the daemon records
// the last such observation here (lib/server/index.js middleware). `doctor` and
// `status` read it back — from disk, so the answer survives a daemon restart and
// is still available with the daemon down.
//
// Deliberately tri-state. "No MCP client has ever been seen" is NOT proof the
// user failed to restart — a session that simply never called a web-chat tool
// looks identical — so that case reports an honest "can't tell" plus the thing
// to try, never a confident wrong answer.

const fs = require('fs');
const path = require('path');
const { projectPaths } = require('./paths');

// Request headers the MCP server process stamps on its daemon calls. Lowercase:
// Node normalizes incoming header names.
const CLIENT_HEADER = 'x-wc-client';
const STARTED_HEADER = 'x-wc-mcp-started';
const CLIENT_VALUE = 'mcp';
// Set by lib/mcp/index.js on the process Claude Code spawns, read by
// lib/mcp/client.js. The CLI and the hooks share that client shim and must NOT
// be counted as MCP clients — hence an explicit opt-in rather than sniffing.
const MCP_SERVER_ENV = 'WEB_CHAT_MCP_SERVER';

function seenFile(root) {
  return path.join(projectPaths(root).dir, 'mcp-seen.json');
}

// { seen_at, started_at } of the most recent MCP-server observation, or null.
function readMcpSeen(root) {
  try {
    const data = JSON.parse(fs.readFileSync(seenFile(root), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    const seen_at = Number.isFinite(data.seen_at) ? data.seen_at : null;
    if (seen_at == null) return null;
    return { seen_at, started_at: Number.isFinite(data.started_at) ? data.started_at : null };
  } catch {
    return null;
  }
}

// Persist an observation. Best-effort: a failed write only costs us the answer,
// it must never break the request that triggered it.
function recordMcpSeen(root, { startedAt = null, now = Date.now() } = {}) {
  const record = { seen_at: now, started_at: Number.isFinite(startedAt) ? startedAt : null };
  try {
    const f = seenFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(record, null, 2) + '\n');
  } catch {}
  return record;
}

// Did this request come from an MCP server process? Returns { startedAt } or null.
function mcpIdentityFromHeaders(headers) {
  if (!headers || headers[CLIENT_HEADER] !== CLIENT_VALUE) return null;
  const raw = parseInt(headers[STARTED_HEADER], 10);
  return { startedAt: Number.isFinite(raw) ? raw : null };
}

// The headers an MCP server process should stamp on its daemon calls, or
// undefined when this process is not one (CLI, hook, driver, test).
function mcpClientHeaders({ env = process.env, startedAt } = {}) {
  if (env[MCP_SERVER_ENV] !== '1') return undefined;
  const h = { 'X-WC-Client': CLIENT_VALUE };
  if (Number.isFinite(startedAt)) h['X-WC-MCP-Started'] = String(startedAt);
  return h;
}

// mtime of a project's .mcp.json in ms, or null when there is no such file.
// The moment Claude Code's tool list went stale, as far as anything on disk can
// tell us.
function mcpWrittenAt(root) {
  try {
    return fs.statSync(path.join(root, '.mcp.json')).mtimeMs;
  } catch {
    return null;
  }
}

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function gap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  return ago(ms).replace(/ ago$/, '');
}

// The honest verdict. states:
//   'no-mcp'  — no .mcp.json at all (a different check already reports that)
//   'fresh'   — PROVEN fine: an MCP server started after the last .mcp.json write
//               has talked to this daemon
//   'stale'   — PROVEN stale: the MCP server we last heard from was started
//               BEFORE .mcp.json was last written, so its tool list predates it
//   'unknown' — cannot tell; say so and name the cheap thing to try
function describeRestart({ seen, mcpWrittenAt: writtenAt, now = Date.now() } = {}) {
  if (writtenAt == null) {
    return { state: 'no-mcp', line: 'no .mcp.json — nothing registers the web-chat tools' };
  }
  if (!seen || seen.seen_at == null) {
    return {
      state: 'unknown',
      line: `can't tell whether Claude Code has restarted since .mcp.json was written (${ago(now - writtenAt)}) — no web-chat MCP tool call has ever reached this daemon. Claude Code reads .mcp.json only at startup, so if you just ran \`install\`, /exit and reopen it; if you already did, this only means no web-chat tool has been used yet.`,
    };
  }
  if (seen.started_at != null && seen.started_at < writtenAt) {
    return {
      state: 'stale',
      line: `restart Claude Code (/exit, then reopen) — the MCP server we last heard from (${ago(now - seen.seen_at)}) was started ${gap(writtenAt - seen.started_at)} before .mcp.json was last written, so its tool list predates that change and the web-chat tools in that session are stale or missing.`,
    };
  }
  if (seen.started_at == null && seen.seen_at < writtenAt) {
    return {
      state: 'unknown',
      line: `can't tell whether Claude Code has restarted — the last MCP tool call (${ago(now - seen.seen_at)}) predates the last .mcp.json write (${ago(now - writtenAt)}) and did not report its start time. If the web-chat tools are missing, /exit and reopen Claude Code.`,
    };
  }
  return {
    state: 'fresh',
    line: `Claude Code has restarted since .mcp.json changed — an MCP client reached this daemon ${ago(now - seen.seen_at)}`,
  };
}

module.exports = {
  CLIENT_HEADER,
  STARTED_HEADER,
  CLIENT_VALUE,
  MCP_SERVER_ENV,
  seenFile,
  readMcpSeen,
  recordMcpSeen,
  mcpIdentityFromHeaders,
  mcpClientHeaders,
  mcpWrittenAt,
  describeRestart,
  ago,
};
