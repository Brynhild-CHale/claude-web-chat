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
//   service — a service child the supervisor started, proved by the
//             per-child token mintService handed it over IPC (verified: true,
//             owner `service:<name>`). A body owner `service:<name>` from a
//             tokenless local caller still classifies as service with
//             verified: false — the gate refuses it (routes/writers.js).
//   driver  — a local process holding a LEASE on its owner (lib/driver
//             createDriver; verified: true, owner `service:<name>`); or any
//             other owner a tokenless local caller declares (verified: false).
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
// THE CREDENTIALS (U214b) — per-process tokens beside Claude's boot token, in
// memory and per boot, so a token from an earlier boot is stale (401) and its
// holder re-leases:
//   mintService({mountId, name}) → a token for ONE service child, handed to it
//     in the IPC start message (lib/server/services.js) and revoked when the
//     child exits or is stopped (revoke(token)). Minting revokes any driver
//     lease on `service:<name>`: the user's `trust` approval outranks a lease
//     (notes-B Q6, ruling U214b@lease-scope).
//   lease({owner, pid}) → a token for ONE driver instance (two drivers in one
//     process collide — ruling U214b@lease-scope), refused `owner_taken` while
//     a running service child holds the name or another lease's holder pid is
//     alive. A holder whose pid is dead (lib/core/portfiles isPidAlive) is
//     reaped by the next lease request for that owner — there is no timer.
//     release(token) gives a lease back.
// A credential is looked up by its sha256, never compared as text, and its
// owner REPLACES whatever owner the request body names (the gate). These are
// not registered with the redactor: they are minted per child and per lease
// and the redactor has no removal, so the set would only grow; none is ever
// written into a text the daemon keeps.
//
// `state` is held for U214c's pane class (a PANE_HEADER naming a live pane,
// state.mounts.has(id)); this unit does not read it yet.

const crypto = require('crypto');
const {
  WRITER_HEADER, mintToken, writeWriterToken, safeEqual,
} = require('../../core/writer-token');
const { isBrowserRequest } = require('../../core/cors');
const { isComponentName } = require('../../core/names');
const { isPidAlive } = require('../../core/portfiles');

// A leasable owner: `service:<kebab>` — the owner a driver's createDriver tags
// its writes with. claude, user, remote and `pane:*` are never leasable.
const SERVICE_PREFIX = 'service:';
function isLeasableOwner(owner) {
  return typeof owner === 'string' && owner.startsWith(SERVICE_PREFIX) && isComponentName(owner.slice(SERVICE_PREFIX.length));
}

// The key a credential is filed under: its sha256, so a lookup never compares
// a claimed token as text.
const keyOf = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

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

// `pidAlive` — lib/core/portfiles isPidAlive unless a test hands in a stand-in.
function createWriters({
  paths, state = null, redactor = null, audience, log = () => {}, pidAlive = isPidAlive,
} = {}) {
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

  // keyOf(token) → { class: 'service'|'driver', owner, mountId?, pid?, at }.
  const credentials = new Map();

  function resolveWriter(req, body) {
    if (isRemote(req)) return { class: 'remote', owner: 'remote', verified: false };
    const claimed = headerValue(req, WRITER_KEY);
    if (claimed !== null) {
      if (token !== null && safeEqual(claimed, token)) return { class: 'claude', owner: 'claude', verified: true };
      const cred = credentials.get(keyOf(claimed));
      if (cred) return { class: cred.class, owner: cred.owner, verified: true };
      return { stale: true };
    }
    if (isBrowserRequest(req && req.headers)) return { class: 'user', owner: 'user', verified: false };
    return declaredWriter(body && typeof body === 'object' ? body.owner : undefined);
  }

  // A token for one service child (the supervisor's, at its IPC start). Any
  // driver lease on the same owner is revoked first: the user's trust approval
  // outranks a lease.
  function mintService({ mountId, name } = {}) {
    if (!isComponentName(name)) throw new TypeError(`mintService: not a component name: ${JSON.stringify(name)}`);
    const owner = SERVICE_PREFIX + name;
    for (const [k, c] of credentials) {
      if (c.class === 'driver' && c.owner === owner) {
        credentials.delete(k);
        say(`writers: the lease on ${owner} (pid ${c.pid}) was revoked — the service started, and its trust approval outranks a lease`);
      }
    }
    const t = mintToken();
    credentials.set(keyOf(t), { class: 'service', owner, mountId: mountId == null ? null : String(mountId), at: Date.now() });
    return t;
  }

  // Forget a service child's (or a lease's) token. Answers whether it held one.
  // Idempotent.
  function revoke(t) {
    if (typeof t !== 'string' || t === '') return false;
    return credentials.delete(keyOf(t));
  }

  // A lease on `owner` for one driver instance in process `pid`.
  //   → {ok: true, owner, token}
  //   → {ok: false, refused: 'owner_taken', owner, holder: 'service'|'driver'}
  //   → {ok: false, refused: 'bad_owner'|'bad_pid', owner}
  function lease({ owner, pid } = {}) {
    if (!isLeasableOwner(owner)) return { ok: false, refused: 'bad_owner', owner: owner == null ? null : owner };
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, refused: 'bad_pid', owner };
    for (const [k, c] of credentials) {
      if (c.owner !== owner) continue;
      if (c.class === 'service') return { ok: false, refused: 'owner_taken', owner, holder: 'service' };
      let alive = true;
      try { alive = pidAlive(c.pid) !== false; } catch { alive = true; }
      if (alive) return { ok: false, refused: 'owner_taken', owner, holder: 'driver' };
      credentials.delete(k);
      say(`writers: the lease on ${owner} was reaped — its holder (pid ${c.pid}) is gone`);
    }
    const t = mintToken();
    credentials.set(keyOf(t), { class: 'driver', owner, pid, at: Date.now() });
    return { ok: true, owner, token: t };
  }

  // Give a lease back. Only a lease: a service child's token is the
  // supervisor's to revoke. Answers whether one was released.
  function release(t) {
    if (typeof t !== 'string' || t === '') return false;
    const k = keyOf(t);
    const c = credentials.get(k);
    if (!c || c.class !== 'driver') return false;
    return credentials.delete(k);
  }

  // Holds no handle (no timer, no watcher, no file is removed: an orphaned
  // daemon stepping aside must not delete the live one's token). After stop
  // every token claim is stale — Claude's, every service child's and every
  // lease. Idempotent.
  function stop() {
    token = null;
    credentials.clear();
  }

  // `state` is U214c's; kept on the closure so the pane class needs no new
  // argument.
  void state;

  return { resolveWriter, mintService, revoke, lease, release, stop };
}

module.exports = { createWriters, isLeasableOwner };
