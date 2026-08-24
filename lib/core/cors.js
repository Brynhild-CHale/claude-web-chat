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

// Shared CORS for the endpoints the browser extension hits cross-origin (from a
// chrome-extension:// origin). No credentials are used; the origin is reflected.
function setCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WC-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Optional helper folding the `app.options(path, ...)` preflight boilerplate.
function mountCors(app, path) {
  app.options(path, (req, res) => { setCors(req, res); res.status(204).end(); });
}

module.exports = { setCors, mountCors, LISTEN_HOST, isLocalOrigin };
