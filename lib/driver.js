// Public driver helper for non-MCP callers — a local process (dev server, test
// runner, file watcher, pipeline step) that wants to push content into the
// web-chat surface and react to user input, without being Claude.
//
// It mirrors lib/mcp/client.js's HTTP-client pattern but is exported for outside
// use and ergonomic: discover the port once, then call render/writeMarkdown/
// removeMarkdown/setStore/clear/getStore/getEvents/waitFor. Every render,
// markdown write and clear is attributed to the driver's `owner` (stored as
// `service:<owner>`) so panes and prose are attributable and the server's
// clobber-guard keeps the driver and Claude from overwriting each other's items
// by id.
//
// THE OWNER IS PROVED, NOT DECLARED (PLAN 1B.4, writer identity). The daemon
// accepts a `service:` owner only with its credential (lib/server/routes/
// writers.js); the body's owner is ignored. A driver gets one of two:
//   * a LEASE — the default. On its first render, markdown write or clear the
//     driver asks POST /api/writers/lease {owner, pid} (once; concurrent first
//     calls share the request) and sends the lease token as the writer header
//     (lib/core/writer-token WRITER_HEADER) from then on. One owner per live
//     driver INSTANCE: while another driver holds
//     the owner (two drivers in one process included) or a running service of
//     that name does, the write resolves to the soft envelope
//     {ok:false, rejected:true, owner_taken:true, owner, hint} — never a throw —
//     and the next write asks again. A lease whose holder process has died is
//     reaped by the next request for that owner. The daemon keeps leases in
//     memory, so after a daemon restart the token is `stale` (401) and the
//     driver re-leases once and retries. release() gives the lease back.
//   * a service child's own token (`writerToken`, handed over IPC by the
//     supervisor — lib/server/service-runner.js), sent on every call; it never
//     leases.
// createDriver itself stays synchronous: no request is made until the first
// call.
//
// Driver etiquette (see docs/driving-the-surface.md): write to the store and
// render mounts, but never touch the graph routes (turn-begin/turn-end/unlock) —
// the graph belongs to Claude's turn lifecycle and the user. A driver is a
// passive collaborator.

const portfiles = require('./core/portfiles');
const client = require('./client');
const { WRITER_HEADER } = require('./core/writer-token');

const LEASE_PATH = '/api/writers/lease';

// The soft envelope a write resolves to while another writer holds the owner.
function ownerTaken(ownerTag, body) {
  return {
    ok: false, rejected: true, owner_taken: true, owner: ownerTag,
    hint: (body && body.hint) || 'another live driver or a running service holds this owner',
  };
}

const isStale = (e) => e && e.status === 401 && e.body && e.body.writer === 'stale';

// owner: short service name, e.g. 'test-runner'. Stored on every pane as
// `service:<owner>` so the surface attributes it and the clobber-guard protects
// it — a lowercase kebab name, since the lease refuses any other (400).
// root/port: optional overrides for port discovery. writerToken: a service
// child's own credential (the supervisor's); a driver without one leases.
function createDriver({ owner, root, port, writerToken } = {}) {
  if (!owner) throw new Error('createDriver requires an `owner` (a short service name)');
  const ownerTag = owner.startsWith('service:') ? owner : `service:${owner}`;
  const resolvedPort = portfiles.discoverPort({ role: 'server', root, port, env: true });
  if (!resolvedPort) throw new client.NoServerError();

  const fixed = typeof writerToken === 'string' && writerToken !== '' ? writerToken : null;
  let leased = null;   // the lease token, once granted
  let leasing = null;  // the lease request in flight (memoised)

  const headersFor = (tok) => (tok ? { [WRITER_HEADER]: tok } : undefined);

  // spawn stays false, so a dead/absent server never gets resurrected by a driver.
  // client.api throws on HTTP >=400 and maps ECONNREFUSED/ECONNRESET to
  // NoServerError — matching this module's previous behavior.
  function call(method, pathStr, body, tok = fixed || leased) {
    const headers = headersFor(tok);
    return client.api(method, pathStr, body, headers ? { port: resolvedPort, headers } : { port: resolvedPort });
  }

  // → {token} or {taken: body}. One request in flight at a time; a refusal is
  // not kept, so the next write asks again.
  function lease() {
    if (!leasing) {
      leasing = client.api('POST', LEASE_PATH, { owner: ownerTag, pid: process.pid }, { port: resolvedPort })
        .then((r) => { leased = r.token; return { token: r.token }; }, (e) => {
          if (e && e.status === 409) return { taken: e.body };
          throw e;
        })
        .finally(() => { leasing = null; });
    }
    return leasing;
  }

  // A write that carries the owner (render, markdown, clear): under the
  // service's token, or under a lease taken on first use.
  async function write(pathStr, body) {
    if (fixed) return call('POST', pathStr, body, fixed);
    if (!leased) {
      const got = await lease();
      if (got.taken) return ownerTaken(ownerTag, got.taken);
    }
    const tok = leased;
    try {
      return await call('POST', pathStr, body, tok);
    } catch (e) {
      if (!isStale(e)) throw e;
      // A lease from an earlier boot of the daemon: lease again, once.
      if (leased === tok) leased = null;
      if (!leased) {
        const got = await lease();
        if (got.taken) return ownerTaken(ownerTag, got.taken);
      }
      return call('POST', pathStr, body, leased);
    }
  }

  return {
    owner: ownerTag,
    port: resolvedPort,

    // Render/replace a pane, tagged with this driver's owner. Returns the server
    // envelope: {ok:true, id, owner, place?} on success, or a soft reject
    // ({rejected:true, owned:true|locked:true|owner_taken:true, ...}) — check
    // `.ok`. Pass
    // force:true in opts to take over a pane owned by someone else. `after`
    // puts the pane right after that pane or markdown id ('start': the top of
    // the page); left out, a new pane goes to the bottom and a re-render keeps
    // its place. `place: {col, span, rows}` proposes where it sits on its run's
    // 12-column grid; the applied placement comes back as `place`.
    render({ html, id, target, params, theme, force, after, place } = {}) {
      return write('/api/render', { html, id, target, params, theme, force, after, place, owner: ownerTag });
    },

    // Put a markdown item on the page (headings and short prose between and
    // around panes), tagged with this driver's owner. Reuse `id` to rewrite one
    // in place; left out, the server assigns md-<n> and returns it as `id`.
    // `after` places it as it places a pane. Returns {ok:true, id, owner,
    // warning?}, or a soft reject — owned (force:true takes it over), an id a
    // pane holds (conflict), a reserved id, or text over the cap (too_large).
    writeMarkdown({ text, id, after, force } = {}) {
      return write('/api/markdown', { text, id, after, force, owner: ownerTag });
    },

    // Take one markdown item off the page by id; a pane of that id is never
    // touched (`clear` takes either). Returns {ok:true, removed, id} — removed
    // is false when no such item was there — or the owned soft reject unless
    // force:true.
    removeMarkdown({ id, force } = {}) {
      return write('/api/markdown', { id, remove: true, force, owner: ownerTag });
    },

    // Merge a patch into the shared store. Use a signal key with a bumping seq
    // (e.g. {test_run: {seq, ...}}) — Claude catches it up next turn; a pane
    // can react live. Driver writes are source:'server' and never enqueue.
    setStore(patch) {
      return call('POST', '/api/store', { patch });
    },

    getStore(keys) {
      const q = Array.isArray(keys) && keys.length ? `?keys=${keys.join(',')}` : '';
      return call('GET', `/api/store${q}`);
    },

    // Clear a pane/target/everything, attributed to this driver.
    clear({ id, target } = {}) {
      return write('/api/clear', { id, target, owner: ownerTag });
    },

    // Give the lease on this owner back, so another driver can take it (a
    // later write by this driver leases again). Resolves {ok:true, released}:
    // released is false when this driver held no lease — a service child's
    // token is the supervisor's, and is never released here.
    async release() {
      if (leasing) { try { await leasing; } catch {} }
      const tok = leased;
      leased = null;
      if (!tok) return { ok: true, released: false };
      return call('DELETE', LEASE_PATH, undefined, tok);
    },

    getEvents({ since = 0 } = {}) {
      return call('GET', `/api/events?since=${since}`);
    },

    // Long-poll until a store key / event predicate matches. Predicate shape
    // matches /api/wait: {store_key, equals|exists} or {event_kind, match, since_seq}.
    waitFor(predicate, { timeout_ms = 30000 } = {}) {
      return call('POST', '/api/wait', { predicate, timeout_ms });
    },

    // Subscribe to the live event stream (SSE) — push-based, lower latency than
    // polling getEvents. onEvent(e) fires per event; onGap({dropped,oldest})
    // fires if a `since` catch-up cursor predated the ring buffer (resync from a
    // full getStore/get_graph snapshot then); onClose() fires when the stream
    // ends (e.g. the server shut down) so the caller can resubscribe if it wants.
    // Returns a handle with .close(). Opts: {since, kinds:[...], onEvent, onGap,
    // onClose, onError}. (Auto-reconnect/Last-Event-ID resume is not built in —
    // resubscribe from onClose with `since` = the last seq you saw if you need it.)
    streamEvents({ since, kinds, onEvent, onGap, onClose, onError } = {}) {
      return client.subscribeSSE({ port: resolvedPort, since, kinds, onEvent, onGap, onClose, onError });
    },
  };
}

// Wrap a driver so an UNAWAITED call's rejection cannot kill the process.
// Service children fire-and-forget store pushes (a ticking clock, an fs-watch
// callback), and since the client contract rejects on a dead socket or a non-2xx
// (it used to hang), one transient blip would otherwise become an unhandled
// rejection that takes the child down — and the supervisor then crash-blocks
// that service version. The catch is attached to a BRANCH of the promise, so a
// caller that does await still receives the rejection unchanged.
function guardDriver(driver, onError) {
  const report = onError || ((method, e) => console.error(`[driver] ${method} failed:`, e && e.message ? e.message : e));
  const out = {};
  for (const k of Object.keys(driver)) {
    const fn = driver[k];
    if (typeof fn !== 'function') { out[k] = fn; continue; }
    out[k] = (...args) => {
      const p = fn.apply(driver, args);
      if (p && typeof p.catch === 'function') p.catch((e) => report(k, e));
      return p;
    };
  }
  return out;
}

module.exports = { createDriver, guardDriver, NoServerError: client.NoServerError };
