const { PROTOCOL_VERSION, packageVersion } = require('../../core/versions');
const { isBrowserRequest, SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE, isRemoteRequest } = require('../../core/cors');
const { atLeast, stripText, projectValue } = require('../../core/remote-policy');
const { lockIsStale } = require('../domain/turns');
const { computeLabels } = require('../graph');
const { createAudience } = require('../audience');

// Newest commit time, from the topology index (cheap: one field per node).
function lastCommitAt(graph) {
  let max = null;
  const topo = graph && graph.topology;
  if (!topo) return null;
  for (const t of topo.values()) {
    if (t && Number.isFinite(t.created_at) && (max == null || t.created_at > max)) max = t.created_at;
  }
  return max;
}

function activeLabel(graph) {
  if (!graph || !graph.active) return null;
  try { return computeLabels(graph).get(graph.active) || null; } catch { return null; }
}

// The chat mirror on /api/health (C15): one object, content-free — whether the
// mirror is on, its aggregate state, how many conversations it knows and when a
// hook last reached it, from the mirror's own summary (ctx.mirror.summary,
// spec §2.12) — and `level`, this request's mirror level: a label for the page,
// never a grant. Every viewer may read /api/health, so the summary goes through
// the one typed projection (lib/core/remote-policy projectValue): a field of the
// wrong shape is dropped, never sent. With no mirror (the server not wired yet,
// or a summary that failed) it says the mirror is off.
const MIRROR_SUMMARY_SCHEMA = { enabled: 'boolean', state: 'word', conversations: 'number', last_hook_at: 'number' };

function mirrorSummary(mirror, level) {
  let s = null;
  if (mirror && typeof mirror.summary === 'function') {
    try { s = projectValue(MIRROR_SUMMARY_SCHEMA, mirror.summary()); } catch { s = null; }
  }
  s = s || {};
  return {
    enabled: s.enabled === true,
    level,
    state: typeof s.state === 'string' ? s.state : null,
    conversations: Number.isInteger(s.conversations) && s.conversations >= 0 ? s.conversations : 0,
    last_hook_at: typeof s.last_hook_at === 'number' ? s.last_hook_at : null,
  };
}

// Daemon lifecycle: "are you alive" (GET /api/health) and "stop being alive"
// (POST /api/shutdown). One file because they are the same concern — the
// process's own liveness — and because the shutdown gate below is only
// defensible next to the liveness endpoint it shares a trust boundary with.
//
// GET /api/health is the lightweight liveness endpoint used by `probeReachable`,
// the `doctor` command, and the MCP client's auto-spawn retry: enough state
// (active node, node count, lock) to diagnose a wedged graph without pulling the
// full graph payload.
//
// `role`/`version` mirror the hub's health shape so the same protocol self-heal
// generalizes: probeHub keys on role==='hub', so an instance advertising
// role:'instance' is never mistaken for one.

function mountHealthRoutes(app, ctx) {
  const { graph, bus, getViewers, getMcpSeen, triggerShutdown } = ctx;
  // ctx.audience and ctx.mirror are read per request, so the order the server
  // builds them in does not matter. Until it hands over an audience, a request
  // is judged with no mirror opt-in (a remote viewer is basic): narrower, never
  // wider.
  const noOptIn = createAudience({ configFile: null });
  app.get('/api/health', (req, res) => {
    const level = (ctx.audience || noOptIn).levelOf(req);
    const body = {
      ok: true,
      role: 'instance',
      version: PROTOCOL_VERSION,
      // `version` is the wire protocol the self-heal compares — never change
      // its meaning. The release a person reads (0.8.0, or a dev build's full
      // string) is this; the machine-wide sessions view shows it per surface, and
      // `install`/`open`/`start`/`update` compare it with their own to find a
      // daemon an update left on the old build (lib/cli/stale-daemon.js).
      package_version: packageVersion(),
      pid: process.pid,
      active: graph.active,
      nodes: graph.nodes.size,
      lock: graph.lock,
      // Whether that lock has outlived its TTL (the next turn-begin steals it).
      // A stale lock is not a turn in progress; the machine-wide sessions view
      // (lib/util/registry enrichSessions) must not report one as "mid-turn".
      lock_stale: graph.lock ? lockIsStale(graph.lock) : false,
      // The active node as the user sees it (n1.7), and when anything was last
      // committed — so a cross-project listing can say where each surface is
      // without pulling /api/graph. Labels are cached per topology revision.
      active_label: activeLabel(graph),
      last_commit_at: lastCommitAt(graph),
      // Connected browsers. Zero means the daemon is fine but nobody is looking:
      // a render still succeeds and still commits, it just isn't seen by anyone.
      // Callers that care about being SEEN (the turn-begin hook, doctor, status)
      // need to tell those two states apart.
      viewers: typeof getViewers === 'function' ? getViewers() : null,
      // Last sighting of the MCP server process Claude Code spawns:
      // { seen_at, started_at } (ms), or null if none has ever called in. The
      // ONLY evidence available for "did the user restart Claude Code after
      // install rewrote .mcp.json?" — see lib/core/mcp-seen.js.
      mcp_seen: typeof getMcpSeen === 'function' ? getMcpSeen() : null,
      // The daemon's per-boot token. The channel bridge reads it at connect BEFORE
      // choosing its reconnect cursor: a changed token means the
      // seq space reset, so it must full-replay instead of resuming a dead cursor.
      boot: bus ? bus.bootId : null,
      // Is THIS request arriving through the tunnel portal (lib/portal), which
      // adds `X-WC-Remote: 1` to everything it forwards? The page reads it to
      // swap host-only controls (pack installs, service approval) for "run this
      // on the host". A label for the UI, never an access GRANT: any local
      // caller can set the header, and what a remote viewer may reach is decided
      // in the portal (lib/core/remote-policy), not here. (The routes that act
      // on it — a raw-html pane spawn, a host-wide theme save, the host paths
      // a few reads redact — only narrow; see lib/core/cors isRemoteRequest.)
      remote: isRemoteRequest(req),
      mirror: mirrorSummary(ctx.mirror, level),
    };
    // Below `read` — a remote viewer of a project that has not opted in, a
    // peer on a network bind — the lock above goes without the typed prompt and
    // the session's fields (TEXT_RULES, lib/core/remote-policy). A local
    // request gets it whole, as it always has.
    res.json(atLeast(level, 'read') ? body : stripText('routes', 'GET /api/health', body));
  });

  // An explicit, ACKNOWLEDGED shutdown request.
  //
  // Why this exists: `stop` used to fire SIGTERM and hope. It could not tell
  // "drained cleanly, draft written" from "died", which is exactly the state its
  // own failure message admitted to ("may not have shut down cleanly"). A signal
  // carries no reply. This route does the same work through the same
  // gracefulShutdown, but answers first — so the caller has a real receipt.
  //
  // ── Security ──────────────────────────────────────────────────────────────
  // This route terminates a process, so it needs a gate that a web page cannot
  // pass. The daemon binds loopback and the WS upgrade already rejects foreign
  // origins, but neither helps here: a page the user visits CAN send a
  // same-origin-simple POST to http://127.0.0.1:<port>/api/shutdown. CORS would
  // withhold the *response* from that page — irrelevant, the daemon is already
  // shutting down. The gate therefore has to reject the REQUEST.
  //
  // Two independent layers, both borrowed from gates already in this codebase
  // rather than invented:
  //   1. isBrowserRequest (lib/core/cors) — no browser may call this, ours
  //      included. Origin and Sec-Fetch-* are forbidden headers, so page script
  //      can neither forge nor suppress them. This is the same "who may reach
  //      this server" engine that gates the WS upgrade, extended, not copied.
  //   2. A custom X-WC-Shutdown header — the X-WC-Token pattern. Any browser
  //      request carrying it is non-simple and must preflight; no OPTIONS
  //      handler is mounted for this path, so the preflight fails closed.
  // Layer 1 alone is sufficient against every browser that sends the metadata;
  // layer 2 covers the hypothetical one that does not, and stops accidental
  // shutdowns from stray tooling. Neither layer is a secret, because there is
  // nothing to keep secret from: a caller with genuine local process access can
  // already `kill` the pid, and the response is never CORS-readable regardless.
  app.post('/api/shutdown', (req, res) => {
    if (isBrowserRequest(req.headers)) {
      return res.status(403).json({
        ok: false,
        error: 'refused: /api/shutdown rejects any request carrying browser fetch metadata (Origin / Sec-Fetch-*). Local tooling should call it through lib/client.',
      });
    }
    if (req.headers[SHUTDOWN_HEADER] !== SHUTDOWN_HEADER_VALUE) {
      return res.status(403).json({
        ok: false,
        error: `refused: POST /api/shutdown requires the header ${SHUTDOWN_HEADER}: ${SHUTDOWN_HEADER_VALUE}`,
      });
    }
    if (typeof triggerShutdown !== 'function') {
      return res.status(501).json({ ok: false, error: 'this server has no shutdown hook wired' });
    }

    // Close the socket along with the reply. gracefulShutdown ends with
    // server.close(), which waits on every *existing* connection — and a
    // keep-alive socket left open by our own acknowledgement is one of those.
    // Without this the shutdown can hang on the request that asked for it.
    res.setHeader('Connection', 'close');

    // ORDER IS THE WHOLE POINT: acknowledge, then shut down.
    //
    // gracefulShutdown drains in-flight requests before it closes the server. If
    // we started it before replying, it would be draining THIS request — which
    // cannot finish until the drain does. The caller would see a dropped socket
    // (exactly the ambiguity we are removing) after a five-second stall.
    //
    // 'close' fires once the response is off the wire, and the in-flight counter
    // is decremented by a listener the counting middleware registered first (so
    // it runs first). setImmediate defers past any remaining same-tick listener,
    // so the drain starts from a genuinely quiet server.
    res.on('close', () => {
      setImmediate(() => { try { triggerShutdown(); } catch {} });
    });

    res.json({
      ok: true,
      shutting_down: true,
      pid: process.pid,
      active: graph.active,
    });
  });
}

module.exports = { mountHealthRoutes };
