// Spawn-injecting shim over lib/client. The MCP layer is the one caller that WANTS
// auto-spawn: Claude Code spawns the MCP server fresh each session, so the first
// tool call (or hook, or doctor probe) must transparently bring the daemon up if
// it isn't already. We opt in by defaulting spawn:true on every get/post; a caller
// can still pass opts.noSpawn (the turn-end unlock does) and it wins over spawn:true
// in lib/client's api, so we never resurrect a daemon the user has closed.
// One exception, the no-spawn knob (below): a root the web-chat connector
// supervises is never spawned here.
const path = require('path');
const fs = require('fs');
const c = require('../client');
const { sameRoot } = require('../core/portfiles');
// Read at call time (daemon.waitForDaemon), not destructured, so a test can
// stand in for the wait.
const daemon = require('../util/daemon');
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
// once read. A missing file is read again on the next call (the daemon may not
// have booted yet — the auto-spawn race — or could not write its .web-chat/),
// and that call goes out without the header: it lands as an UNVERIFIED call
// attributed to Claude, which every enforced rule refuses with that rule's
// own hint (C-15-3; ruling U355@no-token-first-call). That is the only
// tokenless call this process sends: after a refused token it never falls
// back to one (below).
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
// 401 re-reads the token file ONCE and retries with the token it finds, when
// that is a different one. A call still refused — or with nothing new to
// retry with — clears this root's cached token (the next call reads the file
// again) and throws the daemon's own HttpError: its JSON body carries the
// gate's hint naming .web-chat/writer-token (lib/server/routes/writers.js
// STALE_HINT), which lib/mcp/index.js hands Claude as the tool's error. Never
// a loop, and never a tokenless send after a refused token: that fallback
// (advisory claude) was removed at 2C's enforcement (GT-15 C-15-2; ruling
// U214a@stale-token-fallback).
async function call(send, o) {
  if (!ident()) return send(withIdent(o));
  const root = rootOf(o);
  const first = tokenFor(root);
  let refused;
  try {
    return await send(withIdent(o, first));
  } catch (e) {
    if (!first || !isStale(e)) throw e;
    refused = e;
  }
  const fresh = tokenFor(root, { reread: true });
  if (fresh && fresh !== first) {
    try {
      return await send(withIdent(o, fresh));
    } catch (e) {
      if (!isStale(e)) throw e;
      refused = e;
    }
  }
  tokens.delete(root);
  throw refused;
}

// The no-spawn knob (contract 10 C-10.5, A-10.3; PLAN 6B.5). The web-chat
// connector supervises the daemon of the root it launches a session in, and
// sets WEB_CHAT_SUPERVISED=<that root> in the session's environment (beside
// WEB_CHAT_CHANNEL=1; claudeEnv drops every WEB_CHAT_* name, so the connector's
// session command sets it explicitly). A daemon this process spawned would be
// an unsupervised one, so under the knob a call goes out with spawn: false and,
// when it finds no daemon, waits ONCE (lib/util/daemon waitForDaemon, its
// default wait) for the supervised daemon to come up, retries once, and
// otherwise fails with a hint naming the connector. The knob holds only when
// this call's own root IS the knob's root (sameRoot, so a symlinked spelling
// is the same root): the variable is inherited, and a nested claude or a
// workflow agent in another folder must still spawn its own daemon (the lesson
// lib/mcp/channel-proof.js records). Read per call. A value that is not an
// absolute path naming an existing folder is no knob at all. A caller's
// noSpawn (the hooks) still wins: such a call goes out exactly as before, and
// never waits. The port override variable (C-10.5: the connector never sets
// it) is neither read nor set here; lib/client's discovery is untouched.
const SUPERVISED_ENV = 'WEB_CHAT_SUPERVISED';
const SUPERVISED_HINT = 'the web-chat server for this project is supervised by the web-chat connector and is not up '
  + '— check `claude-web-chat connect status`';

function supervised(root) {
  const v = process.env[SUPERVISED_ENV];
  if (typeof v !== 'string' || v === '' || v.includes('\0') || !path.isAbsolute(v)) return false;
  try {
    if (!fs.statSync(v).isDirectory()) return false;
    return sameRoot(v, root);
  } catch {
    return false;
  }
}

function isNoServer(e) {
  return !!(e && (e instanceof c.NoServerError || e.code === 'NO_SERVER'));
}

async function send(fn, o) {
  if ((o && o.noSpawn === true) || !supervised(rootOf(o))) return call(fn, o);
  const root = rootOf(o);
  const so = { ...(o || {}), spawn: false };
  try {
    return await call(fn, so);
  } catch (e) {
    if (!isNoServer(e)) throw e;
  }
  const d = await daemon.waitForDaemon(root);
  if (!d) throw new c.NoServerError(SUPERVISED_HINT);
  // The record daemonFor verified for this root (its pid and instance on
  // /api/health): its port, unless the caller named one, so a portfile the
  // instance guard has not re-written yet does not fail the retry.
  const retry = so.port != null || !d.port ? so : { ...so, port: d.port };
  try {
    return await call(fn, retry);
  } catch (e) {
    if (isNoServer(e)) throw new c.NoServerError(SUPERVISED_HINT);
    throw e;
  }
}

module.exports = {
  ...c,
  get: (p, o) => send((opts) => c.get(p, opts), o),
  post: (p, b, o) => send((opts) => c.post(p, b, opts), o),
  NoServerError: c.NoServerError,
  PROCESS_STARTED_AT,
  SUPERVISED_ENV,
  SUPERVISED_HINT,
  supervised,
};
