// This MCP server process's presence row in the machine registry.
//
// Claude Code spawns one web-chat MCP server per session, at session start, and
// kills it at exit. That makes this process's lifetime the only honest answer to
// "is a Claude Code session attached to this project?" — mcp-seen (the last
// request the process made to a daemon) cannot say it, because a session that
// never called a tool never made one, and a finished session's last sighting
// looks exactly like a live one's.
//
// So the process says so itself, in ~/.web-chat/instances.json
// (lib/util/registry, role:'mcp'): registered at startup with NO daemon
// involved — nothing here spawns, probes or waits — and removed on the way out.
// A crash or SIGKILL skips the removal; the registry's liveness rule (pid, and
// the Claude Code parent pid) drops the row on the next read.
//
// Everything is best-effort: a registry that cannot be written costs the
// listing one row, never a tool call or the session.

const registry = require('../util/registry');

// At most one last_tool_at write per window. Tool calls come in bursts; the
// listing reads "last tool 3m ago", which ten seconds of slack cannot change.
const TOOL_WRITE_INTERVAL_MS = 10_000;

function startPresence({
  root,
  pid = process.pid,
  ppid = process.ppid,
  now = Date.now,
  intervalMs = TOOL_WRITE_INTERVAL_MS,
  defer = setImmediate,
  reg = registry,
} = {}) {
  let stopped = false;
  let channel = false;
  let lastWrite = -Infinity;
  try { reg.registerMcp({ root, pid, ppid, channel }); } catch {}

  return {
    // The channel bridge opened (true) or lost (false) its wake stream.
    setChannel(on) {
      const next = Boolean(on);
      if (stopped || next === channel) return;
      channel = next;
      try { reg.updateMcp(pid, { channel }); } catch {}
    },
    // A tool call happened. Throttled, and the write is deferred off the call
    // path so the registry's read-modify-write never sits in front of a tool.
    touch() {
      if (stopped) return false;
      const t = now();
      if (t - lastWrite < intervalMs) return false;
      lastWrite = t;
      defer(() => {
        if (stopped) return;
        try { reg.updateMcp(pid, { last_tool_at: t }); } catch {}
      });
      return true;
    },
    // Idempotent: stdin closing, a signal and process 'exit' can all arrive.
    stop() {
      if (stopped) return;
      stopped = true;
      try { reg.deregisterMcp({ pid }); } catch {}
    },
  };
}

module.exports = { startPresence, TOOL_WRITE_INTERVAL_MS };
