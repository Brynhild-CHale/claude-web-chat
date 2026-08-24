// The local network trust boundary — one home for "who may reach this server".
//
// Owns three related facts that must never drift apart:
//   LISTEN_HOST   — what address the instance server and the hub bind.
//   isLocalOrigin — whether a browser Origin belongs to this machine's own
//                   surface (used to gate the WebSocket upgrade).
//   setCors       — the cross-origin headers for the endpoints the browser
//                   extension legitimately hits from a chrome-extension:// origin.
//
// Loopback by default. Everything web-chat serves is unauthenticated by design
// — the graph, the shared store (which holds whatever a file-editor pane has
// open), arbitrary HTML/JS injection via /api/render, and /api/update — so the
// bind address IS the access control. WEB_CHAT_HOST exists for the deliberate
// remote case (a dev container, a remote workstation); setting it is an explicit
// decision to expose all of the above to the chosen interface.
//
// Zero imports (core leaf), so any layer may require it without creating a cycle.

const LISTEN_HOST = process.env.WEB_CHAT_HOST || '127.0.0.1';

// Everything else in web-chat — the portfile URL, `open`, the MCP client, the
// extension hub — talks to localhost. Binding a single non-loopback address
// therefore makes the server unreachable to its own tooling, which surfaces as
// "the daemon is down" and invites a second daemon over the same graph
// directory. Binding a wildcard keeps loopback working but exposes the
// unauthenticated API. Neither is wrong to want, but both deserve to be said out
// loud once rather than debugged.
function warnIfExposed(log = console.error) {
  if (LISTEN_HOST === '127.0.0.1' || LISTEN_HOST === 'localhost' || LISTEN_HOST === '::1') return null;
  const wildcard = LISTEN_HOST === '0.0.0.0' || LISTEN_HOST === '::';
  const msg = wildcard
    ? `WEB_CHAT_HOST=${LISTEN_HOST} — the surface, graph, store and /api/update are reachable from your network with NO authentication.`
    : `WEB_CHAT_HOST=${LISTEN_HOST} — binding a single non-loopback address; web-chat's own tooling connects over localhost and will report the daemon as down.`;
  log(`[web-chat] ${msg}`);
  return msg;
}

// Hosts that are unambiguously this machine. `localhost` is included because
// that is what the surface is served from and what every doc tells users to open.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Is this browser Origin one of our own surfaces? Used by the WS upgrade gate.
// A missing/empty origin is NOT decided here — a non-browser client (a local
// driver process, the CLI, a test) sends no Origin at all, and the caller
// decides whether that is allowed. Never throws on a malformed origin.
function isLocalOrigin(origin) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  // URL() strips the brackets from an IPv6 literal; check both forms.
  return LOCAL_HOSTNAMES.has(host) || LOCAL_HOSTNAMES.has(`[${host}]`);
}

// Who is actually meant to talk to the capture endpoints cross-origin: the
// browser extension, which is served from an extension scheme.
const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'];

function isExtensionOrigin(origin) {
  if (!origin) return false;
  try { return EXTENSION_SCHEMES.includes(new URL(origin).protocol); } catch { return false; }
}

// CORS for the endpoints the browser extension hits cross-origin.
//
// The allowed set is deliberately NARROW. This used to reflect whatever `Origin`
// arrived (`origin || '*'`), which made every capture readable by any website
// the user happened to visit: `GET /api/captures`, `/api/captures/:id/raw` and
// `/api/captures/:id/simplified` are unauthenticated reads, and a reflected
// origin is what lets the calling page actually SEE the response. The POST side
// was already gated by X-WC-Token; the reads were not gated by anything.
//
// Now only an extension origin (or a same-machine one) is reflected. Anything
// else gets no CORS header at all, so the browser refuses the read — while
// non-browser callers, which send no Origin, are unaffected.
function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || isExtensionOrigin(origin) || isLocalOrigin(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WC-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  return allowed;
}

// Optional helper folding the `app.options(path, ...)` preflight boilerplate.
function mountCors(app, path) {
  app.options(path, (req, res) => { setCors(req, res); res.status(204).end(); });
}

module.exports = { setCors, mountCors, LISTEN_HOST, isLocalOrigin, isExtensionOrigin, warnIfExposed };
