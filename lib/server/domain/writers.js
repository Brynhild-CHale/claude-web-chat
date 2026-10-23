// Who is writing — the writers domain (PLAN 1B.4, writer identity; DECISIONS
// A1). One function answers it for every guarded route: resolveWriter(req,
// body) → { class, owner, verified } (or { stale: true }). The routes decide
// what a class may do (lib/server/routes/writers.js, the gate); this module
// only says who the request is.
//
// THE CLASSES (the vocabulary the later parts of 1B.4 fill in):
//   remote  — through the tunnel portal (X-WC-Remote) or from a network peer.
//   claude  — Claude's MCP server, proved by this boot's writer token
//             (verified: true); or a tokenless local non-browser caller that
//             names no other owner (verified: false — ATTRIBUTION ONLY, C-15-3:
//             lib/client callers such as the identity CLI's preview render, and
//             an MCP server's first call before any token file exists, land as
//             claude, and every enforced rule refuses them as unverified with
//             that rule's own hint; ruling U355@no-token-first-call). The MCP
//             client's tokenless retry after a refused token is gone (2C,
//             C-15-2; ruling U214a@stale-token-fallback): a token still stale
//             after its one re-read fails with the gate's 401 and its hint.
//   service — a service child the supervisor started, proved by the
//             per-child token mintService handed it over IPC (verified: true,
//             owner `service:<name>`). A body owner `service:<name>` from a
//             tokenless local caller still classifies as service with
//             verified: false — the gate refuses it (routes/writers.js).
//   driver  — a local process holding a LEASE on its owner (lib/driver
//             createDriver; verified: true, owner `service:<name>`); or any
//             other owner a tokenless local caller declares (verified: false).
//   pane    — a LOCAL browser request stamped by the realm with PANE_HEADER
//             naming a pane that is live on the surface (state.mounts.has):
//             owner `pane:<id>`, verified: false (U214c). The stamp is set by
//             public/mount-runtime.js paneFetch, the `fetch` a live pane
//             script is compiled with, and by the chrome's spawn/close facade.
//             It is COOPERATIVE: pane scripts run in the chrome's own realm
//             (lib/server/routes/packs.js records it as accepted; B1/X-4 own
//             it), so a script that calls `window.fetch`, or forges the header
//             naming another live pane, defeats it. The class only ever
//             NARROWS what a browser request may do (the comment routes let a
//             pane edit or delete only its own pins; spawn and close must name
//             the stamping pane as parent) — GT-15's pane clause reads
//             GO-with-conditions on that residual. A remote request is never a
//             pane (the portal drops every viewer-sent x-wc-* header,
//             lib/portal/proxy.js), and a stamp naming no live pane reads as
//             `user`, which is what the same script's unstamped fetch gets.
//             ANSWERED BY DEFAULT ({pane: true}; U214e): every caller is told
//             `pane` — the writer gate on render, markdown and clear
//             (lib/server/routes/writers.js) refuses a browser pane exactly as
//             it refuses `user`, so a stamped request can never fall through
//             to advisory claude. A caller that passes {pane: false} is handed
//             `user` for a stamped request.
//   user    — any other browser request (Origin or fetch metadata), verified
//             false: the chrome, or a pane script's bare fetch.
//
// THE TRANCHE-2 RULE for a route that ENFORCES on a writer (GT-15; results/
// gate-t1-exit.md C-15-1..3 — read this before writing one):
//   * C-15-2: an enforced rule on claude, service or driver keys on
//     `verified === true` — a credential this module checked (the boot's
//     writer token, a service child's token, a driver's lease). A class
//     alone, or a body owner, never grants what the rule guards.
//   * C-15-3: a tokenless local caller's `claude` (verified: false) is
//     attribution only — writer and provenance name who wrote, never who may.
//     An enforced rule refuses it as unverified, with the rule's own hint.
//   * C-15-1: `pane:<id>` and `user` only ever NARROW what a bare local
//     browser request could already do (the pane stamp is cooperative, above);
//     no rule treats either as a security boundary.
// This module enforces nothing itself: it says who the request is. A refusal
// the gate builds on a class is authentication of a CLAIMED class — a
// request that cannot prove it is Claude is not Claude.
//
// THE TOKEN. Minted once per boot at construction and registered with the
// redactor, so it is masked in the mirror, the events and every redacted text.
// It is written to .web-chat/writer-token (0600, lib/core/writer-token) at
// construction unless the caller passes `writeAtConstruction: false`: the
// foreground start (lib/cli/commands/start.js, createServer's `tokenAtClaim`)
// publishes it only AFTER this daemon has claimed its portfile, so at a double
// start the loser of the portfile race can never leave the file naming a token
// the winner never minted (ruling U214a@writer-token-orphan-overwrite, DECISIONS
// I.3 D2). publishToken() re-writes the file only when it is absent or names
// another token — the instance guard calls it while the portfile names this
// daemon, so the token file follows the live daemon — and answers
// {written, reason}, never the token. If .web-chat/ is absent the token stays
// in memory (one log line): a daemon never creates its project directory.
// Nothing this module returns hands the token out — there is deliberately no
// accessor for a route to serve.
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
// owner REPLACES whatever owner the request body names (the gate). Each is
// registered with the redactor while it is live (labels `service-token` and
// `lease-token`) and removed (redactor.removeKnown) on every path that drops
// it — revoke, release, the lease a starting service revokes, the reap of a
// dead holder, stop() — so the known set never only grows. None is served: no
// route, frame, event or mirror text carries one (the lease route answers its
// token to its caller alone, host only).
//
// `state` is read for the pane class: a stamp names a pane only while
// state.mounts has it.

const crypto = require('crypto');
const {
  WRITER_HEADER, PANE_HEADER, mintToken, writeWriterToken, readWriterToken, safeEqual,
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
const PANE_KEY = PANE_HEADER.toLowerCase();

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
// `writeAtConstruction` — write the token file now (the default, which
// withServer, the CLI's in-process callers and the tests keep); false leaves
// the file to publishToken() (the foreground start, after its portfile claim).
function createWriters({
  paths, state = null, redactor = null, audience, log = () => {}, pidAlive = isPidAlive,
  writeAtConstruction = true,
} = {}) {
  if (!paths || typeof paths.root !== 'string' || !paths.root) throw new TypeError('createWriters: paths (projectPaths of the root) is required');
  if (!audience || typeof audience.peerOf !== 'function') throw new TypeError('createWriters: audience (lib/server/audience) is required');
  const say = (msg) => { try { log(msg); } catch {} };

  // The redactor learns each live credential and forgets each dropped one.
  const learn = (t, label) => {
    if (redactor && typeof redactor.addKnown === 'function') { try { redactor.addKnown(t, label); } catch {} }
  };
  const forget = (t) => {
    if (redactor && typeof redactor.removeKnown === 'function') { try { redactor.removeKnown(t); } catch {} }
  };

  let token = mintToken();
  learn(token, 'writer-token');

  // The last failed write's code, so a file that cannot be written is said
  // once, not once per publish (the guard's passes).
  let lastFail = null;

  // Make the token file name this boot's token: re-written (0600, atomic,
  // never creating .web-chat/) only when it is absent, unreadable or names
  // another token; an equal file is left untouched. → {written, reason}:
  // reason 'absent' | 'differs' when written; 'current' | 'stopped' |
  // 'no-state-dir' | 'error' when not. Never answers the token.
  function publishToken() {
    if (token === null) return { written: false, reason: 'stopped' };
    let onDisk = null;
    try { onDisk = readWriterToken(paths.root); } catch { onDisk = null; }
    if (onDisk !== null && safeEqual(onDisk, token)) { lastFail = null; return { written: false, reason: 'current' }; }
    try {
      writeWriterToken(paths.root, token);
    } catch (e) {
      // ENOENT: no .web-chat/ (removed under a running daemon, or a root that
      // never had one). The token works for this process; the MCP server
      // cannot read it, so its writes land as unverified claude until the
      // next boot.
      const code = (e && e.code) || (e && e.name) || 'error';
      if (code !== lastFail) {
        lastFail = code;
        say(`writers: the writer token was not written (${code}); Claude's writes are unverified until the next boot`);
      }
      return { written: false, reason: code === 'ENOENT' ? 'no-state-dir' : 'error' };
    }
    lastFail = null;
    return { written: true, reason: onDisk === null ? 'absent' : 'differs' };
  }

  if (writeAtConstruction) publishToken();

  // remote: the portal's label, or a peer that is not loopback — decided once,
  // by the audience (lib/server/audience peerOf: 'local', 'remote' or
  // 'network'). A peer it cannot place is not local.
  function isRemote(req) {
    try { return audience.peerOf(req) !== 'local'; } catch { return true; }
  }

  // keyOf(token) → { class: 'service'|'driver', owner, mountId?, pid?, at }.
  const credentials = new Map();
  // keyOf(token) → the token itself, kept only so a credential dropped by its
  // key (a revoked lease, a reaped holder, stop) can leave the redactor too.
  const texts = new Map();
  // Drop one credential by its key, and its text from the redactor.
  function drop(k) {
    const had = credentials.delete(k);
    const t = texts.get(k);
    texts.delete(k);
    if (t !== undefined) forget(t);
    return had;
  }

  // The live pane a local browser request's stamp names, or null.
  function stampedPane(req) {
    const id = headerValue(req, PANE_KEY);
    if (id === null) return null;
    try {
      return state && state.mounts && typeof state.mounts.has === 'function' && state.mounts.has(id) ? id : null;
    } catch { return null; }
  }

  // `opts.pane` — answer the pane class; true unless a caller passes false
  // (above: the default since every guarded route names the class).
  function resolveWriter(req, body, opts) {
    if (isRemote(req)) return { class: 'remote', owner: 'remote', verified: false };
    const claimed = headerValue(req, WRITER_KEY);
    if (claimed !== null) {
      if (token !== null && safeEqual(claimed, token)) return { class: 'claude', owner: 'claude', verified: true };
      const cred = credentials.get(keyOf(claimed));
      if (cred) return { class: cred.class, owner: cred.owner, verified: true };
      return { stale: true };
    }
    if (isBrowserRequest(req && req.headers)) {
      const pane = opts && opts.pane === false ? null : stampedPane(req);
      if (pane !== null) return { class: 'pane', owner: 'pane:' + pane, verified: false };
      return { class: 'user', owner: 'user', verified: false };
    }
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
        drop(k);
        say(`writers: the lease on ${owner} (pid ${c.pid}) was revoked — the service started, and its trust approval outranks a lease`);
      }
    }
    const t = mintToken();
    const k = keyOf(t);
    credentials.set(k, { class: 'service', owner, mountId: mountId == null ? null : String(mountId), at: Date.now() });
    texts.set(k, t);
    learn(t, 'service-token');
    return t;
  }

  // Forget a service child's (or a lease's) token. Answers whether it held one.
  // Idempotent.
  function revoke(t) {
    if (typeof t !== 'string' || t === '') return false;
    return drop(keyOf(t));
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
      drop(k);
      say(`writers: the lease on ${owner} was reaped — its holder (pid ${c.pid}) is gone`);
    }
    const t = mintToken();
    const k = keyOf(t);
    credentials.set(k, { class: 'driver', owner, pid, at: Date.now() });
    texts.set(k, t);
    learn(t, 'lease-token');
    return { ok: true, owner, token: t };
  }

  // Give a lease back. Only a lease: a service child's token is the
  // supervisor's to revoke. Answers whether one was released.
  function release(t) {
    if (typeof t !== 'string' || t === '') return false;
    const k = keyOf(t);
    const c = credentials.get(k);
    if (!c || c.class !== 'driver') return false;
    return drop(k);
  }

  // Holds no handle (no timer, no watcher, no file is removed: an orphaned
  // daemon stepping aside must not delete the live one's token). After stop
  // every token claim is stale — Claude's, every service child's and every
  // lease — and publishToken() writes nothing. Every service and lease token
  // leaves the redactor; Claude's boot token stays known, so a stale claim
  // quoted in a text is still masked. Idempotent.
  function stop() {
    token = null;
    for (const k of [...credentials.keys()]) drop(k);
  }

  return { resolveWriter, mintService, revoke, lease, release, publishToken, stop };
}

module.exports = { createWriters, isLeasableOwner };
