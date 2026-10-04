// The chat mirror's audience gate (spec §5.4), `ctx.audience`: who is asking,
// and how much of the mirror they may see. One home for the level of a request
// or a socket, and for the one host-only test.
//
// The levels, least first (lib/core/remote-policy MIRROR_LEVELS, the one copy
// of their order):
//   basic  the heartbeat projection only — states, timings, counts and the kind
//          of step; no text, paths, commands or titles
//   read   all of the conversation, and nothing that acts
//   full   the composer, task stops and answering as well
//   local  everything: the user's own chrome, its panes, local processes
//
// WHO GETS WHICH. The peer comes first:
//   * a peer that is not loopback      → basic, whatever it sends. Only a
//     WEB_CHAT_HOST bind lets one reach this server at all, and the maintainer
//     ruled carve-strict (Q9): the mirror goes remote only through the
//     authenticated tunnel, so nothing raises a network peer — no
//     WEB_CHAT_MIRROR_NETWORK, no header, no setting. (X-WC-Remote is
//     unforgeable only through the portal, and the portal always reaches a
//     daemon over loopback.)
//   * loopback with X-WC-Remote        → the project's opt-in, `tunnel mirror
//     on` ('full'), `on --read-only` ('read'), or none, which is basic.
//   * loopback without it              → local.
//
// THE OPT-IN lives in the user tier, ~/.web-chat/tunnel/tunnel.json
// (`remote.mirror`), never in the project: a repository must not be able to
// ship its own grant (the consent rule, lib/core/paths). This gate follows that
// file through the one watch engine (lib/core/watch) — never a private memo or
// sweep — and reads it with the one normaliser the portal, `tunnel` and doctor
// share (lib/tunnel/config loadConfig + mirrorLevelFor), matching this project
// by its root or its instance id. A file that is absent or invalid is no
// opt-in ('off'), as it is to the portal, which then refuses everything. An
// edit lands within a poll (a second; the file watch usually sooner), and the
// onChange listeners hear it: lib/server/ws.js re-levels its open sockets from
// there and tells each one whose level moved (mirror:access).
//
// isHost(req) IS THE HOST-ONLY TEST: a local level and no browser fetch metadata
// (lib/core/cors isBrowserRequest — every browser sends Origin on a POST, and
// Sec-Fetch-*; lib/client sends neither). The hook intake, the turn routes'
// publish and session fields, and later the asks, channel, notices and bridge
// routes all ask it, so a browser (a pane's fetch included), a remote viewer and
// a network peer are each refused by one rule. requireHost() is its middleware.
//
// A level is a label as well as a gate: GET /api/health and GET
// /api/mirror/access report a request's own, which grants nothing. The gates are
// here — levelOf, requireMirror, isHost — and what a level lets through is
// remote-policy's tables (FRAME_RULES, TEXT_RULES) and each route's own.
//
//   createAudience({ root, configFile = userPaths().tunnelConfig, pollMs, log })
//     → { levelOf, isHost, requireHost, peerOf, remoteLevel, rank, atLeast,
//         requireMirror, accessView, socketLevel, onChange, stop }
//
// `configFile: null` is an audience with no opt-in at all — a remote viewer is
// always basic — and watches nothing. It is what a caller falls back to before
// the server hands it the real one (narrower, never wider).

const path = require('path');
const { userPaths } = require('../core/paths');
const { watchFile } = require('../core/watch');
const { isLoopbackAddress, isRemoteRequest, isBrowserRequest } = require('../core/cors');
const {
  classify, MIRROR_HINT, MIRROR_FULL_HINT, rankLevel, atLeast, fromOptIn,
} = require('../core/remote-policy');
const { loadConfig, mirrorLevelFor } = require('../tunnel/config');
const { instanceId } = require('../util/registry');

// How often the opt-in is re-read when no file event says so. A level change
// reaches an open socket within about this plus a loop turn (spec §5.4: within
// about 1.5 s of the edit).
const OPT_IN_POLL_MS = 1000;

// The words a host-only refusal is sent with: the portal's own for the same
// refusal (its `/api/hooks/*` row), read from the table rather than copied, so
// a remote viewer the portal refuses and a browser this server refuses are told
// the same thing.
const HOST_ONLY = classify('POST', '/api/hooks/event').hint;

// A network peer asking for more than the heartbeat. Not the mirror hint: no
// `tunnel mirror on` reaches a network peer, so this one says where the
// conversation does go.
const NETWORK_HINT = 'a network bind (WEB_CHAT_HOST) shows only Claude\'s status — the conversation goes remote only through the tunnel (on the host: claude-web-chat tunnel setup, then claude-web-chat tunnel mirror on)';

// The host commands that change the opt-in, for GET /api/mirror/access: the
// page names them and cannot grant (the service-trust pattern). Run in the
// project, so no path rides along — a remote viewer is never sent the host's.
const COMMANDS = Object.freeze({
  on: 'claude-web-chat tunnel mirror on',
  read_only: 'claude-web-chat tunnel mirror on --read-only',
  off: 'claude-web-chat tunnel mirror off',
});

// Who is on the other end of a request: 'local' (a loopback peer without the
// portal's label), 'remote' (a loopback peer with it: a viewer through the
// tunnel), or 'network' (any other peer). The upgrade request of a socket is a
// request too. Never throws.
function peerOf(req) {
  const addr = req && req.socket ? req.socket.remoteAddress : undefined;
  if (!isLoopbackAddress(addr)) return 'network';
  return isRemoteRequest(req) ? 'remote' : 'local';
}

// A peer's level under an opt-in. Anything that is not a known peer is basic.
function levelFor(peer, optIn) {
  if (peer === 'local') return 'local';
  if (peer === 'remote') return fromOptIn(optIn);
  return 'basic';
}

function createAudience({ root, configFile = userPaths().tunnelConfig, pollMs = OPT_IN_POLL_MS, log } = {}) {
  if (configFile != null && (typeof root !== 'string' || !root)) {
    throw new TypeError('createAudience: root (the project root) is required to read its mirror opt-in');
  }
  const note = (msg) => {
    if (typeof log !== 'function') return;
    try { log(msg); } catch {}
  };
  // This project as tunnel.json names it: its root (as `tunnel mirror on`
  // writes it) or its instance id (lib/util/registry, the portal's name for it).
  const self = configFile != null ? { root: path.resolve(root), id: instanceId(root) } : null;

  // The opt-in as last read: 'off' | 'read' | 'full'; and whether tunnel.json
  // was there and valid (remote access is set up at all).
  let optIn = 'off';
  let configured = false;
  const listeners = new Set();

  function read() {
    if (configFile == null) return { optIn: 'off', configured: false };
    let config;
    try { config = loadConfig(configFile); } catch { return { optIn: 'off', configured: false }; }
    return { optIn: mirrorLevelFor(config, self), configured: true };
  }

  // The watch engine's one call: read the file again, and tell the listeners
  // when the project's level moved. Synchronous, so nothing is ever in flight
  // when stop() runs.
  function reread() {
    const next = read();
    configured = next.configured;
    if (next.optIn === optIn) return;
    const from = optIn;
    optIn = next.optIn;
    note(`remote viewers of this project now see the chat mirror at: ${fromOptIn(optIn)} (opt-in ${from} → ${optIn})`);
    for (const fn of [...listeners]) {
      try { fn(from, optIn); } catch (e) { note(`an opt-in listener failed: ${(e && e.message) || e}`); }
    }
  }

  // The first read is synchronous, so a socket that connects at boot already
  // gets its project's level; the watcher only follows edits from there.
  ({ optIn, configured } = read());
  let watcher = configFile != null
    ? watchFile(configFile, reread, { dirWatch: false, pollMs, persistent: false, log: note })
    : null;

  function levelOf(req) {
    return levelFor(peerOf(req), optIn);
  }

  function isHost(req) {
    return levelOf(req) === 'local' && !isBrowserRequest(req && req.headers);
  }

  function requireHost() {
    return function hostOnly(req, res, next) {
      if (isHost(req)) return next();
      res.status(403).json({ ok: false, hint: HOST_ONLY });
    };
  }

  // The hint a level refusal is sent with: what would let this viewer in.
  function refusalHint(peer, need) {
    if (peer === 'network') return NETWORK_HINT;
    if (need === 'local') return HOST_ONLY;
    return need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT;
  }

  // Express middleware: a request whose level does not meet `need` gets a 403
  // saying which level it has. The daemon's second lock behind the portal's
  // table (the packs routes' shape), and the only one for a network peer.
  function requireMirror(need) {
    if (rankLevel(need) === -1) throw new TypeError(`requireMirror: not a mirror level: ${JSON.stringify(need)}`);
    return function mirrorLevel(req, res, next) {
      const peer = peerOf(req);
      const level = levelFor(peer, optIn);
      if (atLeast(level, need)) return next();
      res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req), hint: refusalHint(peer, need) });
    };
  }

  // The GET /api/mirror/access body. `remote` is the portal's label, as GET
  // /api/health reports it; `project` (the opt-in itself, and whether remote
  // access is set up) is the host's business, so only a local caller gets it.
  function accessView(req) {
    const level = levelOf(req);
    const body = { ok: true, level, remote: isRemoteRequest(req) };
    if (level === 'local') body.project = { remote_level: optIn, tunnel_configured: configured };
    body.commands = { ...COMMANDS };
    return body;
  }

  // A socket's level now. lib/server/ws.js keeps each socket's peer, from its
  // upgrade request, in `ws._wc.peer` (peerOf): a remote viewer's level follows
  // the opt-in, a local or network peer's never moves. A socket with no peer on
  // record is basic.
  function socketLevel(ws) {
    return levelFor(ws && ws._wc ? ws._wc.peer : undefined, optIn);
  }

  // fn(from, to) — the opt-in before and after ('off' | 'read' | 'full') —
  // each time a re-read finds it moved. Returns the unsubscribe.
  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange: fn must be a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Ends the watcher (every handle it holds) and drops the listeners.
  // Idempotent; both of the server's teardown paths call it.
  function stop() {
    listeners.clear();
    const w = watcher;
    watcher = null;
    return w ? w.stop() : Promise.resolve();
  }

  return {
    levelOf,
    isHost,
    requireHost,
    peerOf,
    remoteLevel: () => optIn,
    rank: rankLevel,
    atLeast,
    requireMirror,
    accessView,
    socketLevel,
    onChange,
    stop,
  };
}

module.exports = { createAudience, peerOf, HOST_ONLY, NETWORK_HINT, COMMANDS, OPT_IN_POLL_MS };
