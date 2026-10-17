// Who is writing — the writers domain (PLAN 1B.4, writer identity; DECISIONS
// A1). One function answers it for every guarded route: resolveWriter(req,
// body) → { class, owner, verified } (or { stale: true }). The routes decide
// what a class may do (lib/server/routes/writers.js, the gate); this module
// only says who the request is.
//
// THE CLASSES (the vocabulary the later parts of 1B.4 fill in):
//   remote  — through the tunnel portal (X-WC-Remote) or from a network peer.
//   claude  — Claude's MCP server, proved by this boot's writer token
//             (verified: true); or, until GT-15's enforcement, a tokenless
//             local non-browser caller that names no other owner (verified:
//             false — lib/client callers such as the identity CLI's preview
//             render and the MCP tool tests stay working as ADVISORY claude).
//   service — a body owner `service:<name>` from a tokenless local caller
//             (verified: false). U214b adds the per-service credential.
//   driver  — any other owner a tokenless local caller declares (verified:
//             false). U214b adds the driver lease.
//   pane    — U214c: a browser request stamped by the realm with PANE_HEADER.
//   user    — any other browser request (Origin or fetch metadata), verified
//             false: the chrome, or a pane script's bare fetch.
//
// Ownership stays ADVISORY until GT-15 is GO (DECISIONS A1): nothing here is an
// ownership rule. A refusal the gate builds on a class is authentication of a
// CLAIMED class — a request that cannot prove it is Claude is not Claude.
//
// THE TOKEN. Minted once per boot at construction, written to
// .web-chat/writer-token (0600, lib/core/writer-token) and registered with the
// redactor, so it is masked in the mirror, the events and every redacted text.
// If .web-chat/ is absent the token stays in memory (one log line): a daemon
// never creates its project directory. Nothing this module returns hands the
// token out — there is deliberately no accessor for a route to serve.
//
// `state` is held for U214c's pane class (a PANE_HEADER naming a live pane,
// state.mounts.has(id)); this unit does not read it yet.

const {
  WRITER_HEADER, mintToken, writeWriterToken, safeEqual,
} = require('../../core/writer-token');
const { isBrowserRequest } = require('../../core/cors');

const WRITER_KEY = WRITER_HEADER.toLowerCase();

// The header's value when it is a non-empty string; an empty or absent header
// claims nothing.
function headerValue(req, key) {
  const v = req && req.headers ? req.headers[key] : undefined;
  return typeof v === 'string' && v !== '' ? v : null;
}

// What a tokenless local non-browser caller's body owner reads as — today's
// normalizeOwner rule (absent → claude), classified.
function declaredWriter(owner) {
  if (owner == null || owner === 'claude') return { class: 'claude', owner: 'claude', verified: false };
  const o = String(owner);
  if (o.startsWith('service:')) return { class: 'service', owner: o, verified: false };
  if (o.startsWith('pane:')) return { class: 'pane', owner: o, verified: false };
  return { class: 'driver', owner: o, verified: false };
}

function createWriters({ paths, state = null, redactor = null, audience, log = () => {} } = {}) {
  if (!paths || typeof paths.root !== 'string' || !paths.root) throw new TypeError('createWriters: paths (projectPaths of the root) is required');
  if (!audience || typeof audience.peerOf !== 'function') throw new TypeError('createWriters: audience (lib/server/audience) is required');
  const say = (msg) => { try { log(msg); } catch {} };

  let token = mintToken();
  try {
    writeWriterToken(paths.root, token);
  } catch (e) {
    // ENOENT: no .web-chat/ (removed under a running daemon, or a root that
    // never had one). The token works for this process; the MCP server cannot
    // read it, so its writes land as advisory claude until the next boot.
    say(`writers: the writer token was not written (${(e && e.code) || (e && e.name) || 'error'}); Claude's writes are advisory until the next boot`);
  }
  if (redactor && typeof redactor.addKnown === 'function') {
    try { redactor.addKnown(token, 'writer-token'); } catch {}
  }

  // remote: the portal's label, or a peer that is not loopback — decided once,
  // by the audience (lib/server/audience peerOf: 'local', 'remote' or
  // 'network'). A peer it cannot place is not local.
  function isRemote(req) {
    try { return audience.peerOf(req) !== 'local'; } catch { return true; }
  }

  function resolveWriter(req, body) {
    if (isRemote(req)) return { class: 'remote', owner: 'remote', verified: false };
    const claimed = headerValue(req, WRITER_KEY);
    if (claimed !== null) {
      if (token !== null && safeEqual(claimed, token)) return { class: 'claude', owner: 'claude', verified: true };
      return { stale: true };
    }
    if (isBrowserRequest(req && req.headers)) return { class: 'user', owner: 'user', verified: false };
    return declaredWriter(body && typeof body === 'object' ? body.owner : undefined);
  }

  // Holds no handle (no timer, no watcher, no file is removed: an orphaned
  // daemon stepping aside must not delete the live one's token). After stop
  // every token claim is stale. Idempotent.
  function stop() {
    token = null;
  }

  // `state` is U214c's; kept on the closure so the pane class needs no new
  // argument.
  void state;

  return { resolveWriter, stop };
}

module.exports = { createWriters };
