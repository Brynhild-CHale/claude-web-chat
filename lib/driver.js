// Public driver helper for non-MCP callers — a local process (dev server, test
// runner, file watcher, pipeline step) that wants to push content into the
// web-chat surface and react to user input, without being Claude.
//
// It mirrors lib/mcp/client.js's HTTP-client pattern but is exported for outside
// use and ergonomic: discover the port once, then call render/setStore/clear/
// getStore/getEvents/waitFor. Every render/clear automatically carries the
// driver's `owner` (default `service:<owner>`) so panes are attributable and the
// server's clobber-guard keeps the driver and Claude from overwriting each
// other's panes by id.
//
// Driver etiquette (see docs/driving-the-surface.md): write to the store and
// render mounts, but never touch the graph routes (turn-begin/turn-end/unlock) —
// the graph belongs to Claude's turn lifecycle and the user. A driver is a
// passive collaborator.

const portfiles = require('./core/portfiles');
const client = require('./client');

// owner: short service name, e.g. 'test-runner'. Stored on every pane as
// `service:<owner>` so the surface attributes it and the clobber-guard protects
// it. root/port: optional overrides for port discovery.
function createDriver({ owner, root, port } = {}) {
  if (!owner) throw new Error('createDriver requires an `owner` (a short service name)');
  const ownerTag = owner.startsWith('service:') ? owner : `service:${owner}`;
  const resolvedPort = portfiles.discoverPort({ role: 'server', root, port, env: true });
  if (!resolvedPort) throw new client.NoServerError();

  // spawn stays false, so a dead/absent server never gets resurrected by a driver.
  // client.api throws on HTTP >=400 and maps ECONNREFUSED/ECONNRESET to
  // NoServerError — matching this module's previous behavior.
  function call(method, pathStr, body) {
    return client.api(method, pathStr, body, { port: resolvedPort });
  }

  return {
    owner: ownerTag,
    port: resolvedPort,

    // Render/replace a pane, tagged with this driver's owner. Returns the server
    // envelope: {ok:true, id, owner} on success, or a soft reject
    // ({rejected:true, owned:true|locked:true, ...}) — check `.ok`. Pass
    // force:true in opts to take over a pane owned by someone else.
    render({ html, id, target, params, theme, force } = {}) {
      return call('POST', '/api/render', { html, id, target, params, theme, force, owner: ownerTag });
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
      return call('POST', '/api/clear', { id, target, owner: ownerTag });
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

module.exports = { createDriver, NoServerError: client.NoServerError };
