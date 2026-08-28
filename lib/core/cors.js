// The local network trust boundary — one home for "who may reach this server".
//
// Owns four related facts that must never drift apart:
//   LISTEN_HOST   — what address the instance server and the hub bind.
//   isLocalHost   — whether the NAME the client dialled is one this server
//                   answers to (the DNS-rebinding gate; see requireLocalHost).
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

// What web-chat's OWN clients dial. Deliberately the literal address, never the
// name `localhost`: on a dual-stack machine that name resolves to both ::1 and
// 127.0.0.1, and which one a connection gets is not ours to predict. With the
// server bound to a single loopback address, a client that happened to resolve
// to the other family would miss it entirely — or, if some other process holds
// the wildcard on that port, reach THAT server instead. Both were observed.
const LOOPBACK = '127.0.0.1';

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

// Wildcard binds. Under one of these the server answers on every interface, so
// there is no single name it "is" and no correct value for Host to carry.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

// The hostname half of a `Host:` header value (or of a bind address). Keeps the
// bracket form of an IPv6 literal, because LOCAL_HOSTNAMES carries both. Never
// throws; returns null for anything unparseable, including an absent header.
function hostnameOf(hostValue) {
  if (typeof hostValue !== 'string') return null;
  const h = hostValue.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? null : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon) || null;
}

// Is the gate decidable at all? Under a wildcard bind it is not: any name that
// resolves to this machine reaches us legitimately, so refusing on the name
// would break the deliberate remote case WEB_CHAT_HOST exists for. The gate is
// then skipped, and the bind address remains the only access control (which is
// exactly what setting a wildcard opts into — warnIfExposed says so out loud).
function hostGateApplies(listenHost = LISTEN_HOST) {
  return !WILDCARD_HOSTS.has(String(listenHost));
}

// Is the name the client dialled one this server answers to?
//
// Different question from isLocalOrigin, and it closes a different hole. The
// bind address is the access control, but "bound to loopback" does not mean
// "only reachable by something that knows it is loopback": a page at
// attacker.example whose DNS is rebound to 127.0.0.1 reaches us as a SAME-ORIGIN
// request, so it carries no Origin at all — setCors reflects `*`, isLocalOrigin
// is never consulted, and the page reads the graph, the store and the WS hello
// dump. The one header that still tells the truth is Host, which carries the
// name the page used and which page script cannot forge (it is a forbidden
// header name in both fetch and XHR).
//
// An absent Host (HTTP/1.0) is refused: every browser and every client in this
// repo sends one, so nothing legitimate depends on it. Never throws.
function isLocalHost(hostValue, listenHost = LISTEN_HOST) {
  const name = hostnameOf(hostValue);
  if (!name) return false;
  if (LOCAL_HOSTNAMES.has(name)) return true;
  // A single non-loopback bind is a deliberate remote case: the address the user
  // chose is a legitimate name to dial, alongside loopback.
  if (!hostGateApplies(listenHost)) return false;
  const bound = hostnameOf(listenHost);
  return !!bound && (name === bound || `[${name}]` === bound || name === `[${bound}]`);
}

// Express middleware form. Mounted FIRST on both apps — above express.json, so a
// rebound-Host POST is refused before its body is parsed at the 200mb limit.
// 421 Misdirected Request is the status for "you reached the right socket with
// the wrong name"; the body says which name was refused so a legitimate remote
// setup is diagnosable rather than silent.
function requireLocalHost(req, res, next) {
  if (!hostGateApplies() || isLocalHost(req.headers && req.headers.host)) return next();
  res.status(421).json({
    error: 'host not allowed',
    host: (req.headers && req.headers.host) || null,
    hint: 'web-chat answers on localhost only; set WEB_CHAT_HOST to bind elsewhere.',
  });
}

// The WebSocket upgrade never passes through express middleware, so it needs the
// same two decisions folded into one predicate: the Origin gate documented at
// lib/server/ws.js, plus the Host gate above. Shape matches ws's verifyClient.
function verifyUpgrade(info) {
  const origin = info && info.origin;
  if (origin && !isLocalOrigin(origin)) return false;
  const headers = (info && info.req && info.req.headers) || {};
  return !hostGateApplies() || isLocalHost(headers.host);
}

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

// Is this request coming from a BROWSER at all — ours or anyone's?
//
// Different question from isLocalOrigin, and it exists for a different class of
// endpoint. isLocalOrigin asks "is this browser one of our own surfaces", which
// is the right gate when the danger is what the caller gets to READ (the WS
// hello dump, a reflected CORS header on a capture read). For an endpoint whose
// damage is done by the REQUEST — POST /api/shutdown terminates the daemon —
// CORS is no defence at all: a form-style POST is a "simple request", so the
// browser fires it cross-origin and only withholds the reply. The daemon is
// already dead by then. Ports 5173+ are trivially scannable, so "they'd have to
// guess the port" is not a defence either.
//
// Such an endpoint has NO legitimate browser caller — not even the surface's own
// page, which has never needed to kill its own daemon (and whose panes run
// arbitrary Claude-authored JS SAME-ORIGIN, where no preflight is required at
// all). So the gate is simply "no browsers", and a browser is detectable by
// headers page script cannot forge or strip:
//
//   Origin      — sent by every browser on a POST, same-origin and cross-origin
//                 alike. The load-bearing one, for the same-origin reason above.
//   Sec-Fetch-* — the Fetch Metadata request headers; also forbidden headers.
//
// Either present ⇒ refused. "Browser" is the intent rather than the exact set:
// any WHATWG-fetch-conformant client sends Sec-Fetch-* — Node's own global
// `fetch` sends `sec-fetch-mode: cors` — so those callers are refused too. That
// is deliberate, and it fails CLOSED. The supported way for local tooling to
// reach a gated endpoint is lib/client (raw http.request, no fetch metadata),
// and anything with that much local access could `kill` the pid directly anyway.
// Never throws.
const FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

function isBrowserRequest(headers) {
  const h = headers || {};
  if (h.origin) return true;
  return FETCH_METADATA_HEADERS.some((k) => h[k] != null);
}

// The second layer on POST /api/shutdown, in the same X-WC-Token shape the
// capture routes already use. A cross-origin fetch that sets a CUSTOM header is
// no longer a "simple request", so the browser must preflight it — and no
// OPTIONS handler is mounted for that path, so the preflight fails closed and
// the real request never fires. Lives here, not in the route, so the route and
// the CLI that calls it read the name from ONE place and cannot drift apart.
// Header names are case-insensitive on the wire; Node lowercases what it parses.
const SHUTDOWN_HEADER = 'x-wc-shutdown';
const SHUTDOWN_HEADER_VALUE = '1';

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

module.exports = {
  setCors, mountCors, LISTEN_HOST, LOOPBACK, LOCAL_HOSTNAMES,
  isLocalOrigin, isExtensionOrigin, isBrowserRequest, warnIfExposed,
  isLocalHost, hostGateApplies, requireLocalHost, verifyUpgrade,
  SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE,
};
