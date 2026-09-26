// The streamed HTTP proxy from a remote viewer to one loopback daemon, and the
// header hygiene on both legs of it.
//
// REQUEST: an ALLOWLIST, not a blocklist. The daemon trusts a handful of
// headers because only local processes were ever meant to send them —
// `X-WC-Token` (captures), `X-WC-Shutdown`, the MCP-sighting pair in
// lib/core/mcp-seen.js — and through the portal a remote page could set any of
// them. A blocklist is one new trusted header away from a hole; the allowlist
// below is what a browser legitimately needs and nothing else. Cookies (the
// Access cookie included), Authorization, every cf-* and x-forwarded-* header
// are dropped with the rest.
//
// Origin is forwarded only AFTER the caller has matched it against the
// session's public origin, and it is rewritten to `http://localhost:<port>` —
// the name the daemon's own Origin gates (lib/core/cors isLocalOrigin) know.
// The public origin means nothing to the daemon; forwarding it would read as a
// foreign browser.
//
// One header is ADDED: `X-WC-Remote: 1` (lib/core/cors REMOTE_HEADER), which the daemon's
// GET /api/health echoes as `remote:true` so the page can say "do this on the
// host" where a control is refused remotely. It is a label, not a credential —
// a local caller can send it too and gains nothing — and a viewer cannot send
// or suppress it through the portal: every x-wc-* header they send is dropped
// by the allowlist above, and this one is set after.
//
// RESPONSE: hop-by-hop headers and Set-Cookie are stripped (no daemon cookie
// belongs on the public hostname), and every response carries
//   Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff,
//   frame-ancestors / X-Frame-Options — 'none'/DENY everywhere except
//     /preview/node/*, which the graph viewer frames from the SAME origin
//     (thumbnails, the glance card) and gets 'self'/SAMEORIGIN,
//   Cache-Control: no-store on /api/* — graph and store contents must not sit
//     in a shared or disk cache on the remote machine.
//
// Streaming end to end (lib/client pipe): an export download, a binary asset
// or a long response flows through without being buffered in the portal.

const client = require('../client');
const { REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../core/cors');

const FORWARD = new Set([
  'accept', 'accept-language', 'content-type', 'content-length',
  'if-none-match', 'if-modified-since', 'range', 'user-agent', 'last-event-id',
]);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie',
]);

function forwardHeaders(incoming, { port, origin = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    const name = k.toLowerCase();
    if (v == null) continue;
    if (FORWARD.has(name) || name.startsWith('sec-fetch-')) out[name] = v;
  }
  if (origin) out.origin = `http://localhost:${port}`;
  out[REMOTE_HEADER] = REMOTE_HEADER_VALUE;
  return out;
}

function isPreviewPath(pathname) {
  return /^\/preview\/node(\/|$)/i.test(pathname);
}

// Headers every portal response carries, whatever produced it (proxy, picker,
// refusal). `frameSelf` for the one same-origin-framed document.
function securityHeaders(pathname, { frameSelf = isPreviewPath(pathname) } = {}) {
  const h = {
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': frameSelf ? 'SAMEORIGIN' : 'DENY',
  };
  if (/^\/api(\/|$)/i.test(pathname)) h['cache-control'] = 'no-store';
  return h;
}

function responseHeaders(upstream, pathname) {
  const out = {};
  for (const [k, v] of Object.entries(upstream || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  Object.assign(out, securityHeaders(pathname));
  const fa = `frame-ancestors ${isPreviewPath(pathname) ? "'self'" : "'none'"}`;
  // A second policy is enforced alongside the daemon's own (PREVIEW_CSP on
  // /preview/node): both must pass, so this adds without loosening.
  const csp = out['content-security-policy'];
  out['content-security-policy'] = csp ? [].concat(csp, fa) : fa;
  return out;
}

function pathnameOf(url) {
  const q = String(url || '/').search(/[?#]/);
  return q === -1 ? String(url || '/') : String(url).slice(0, q);
}

// Proxy one request. A daemon that cannot be reached (it has usually just
// exited) is a 502, and `onUpstreamError` lets the caller forget its registry
// memo so the next request sees the session gone. `origin` says the caller
// matched the viewer's Origin and it should be forwarded (rewritten).
async function proxyHttp(req, res, { port, origin, onUpstreamError }) {
  const pathname = pathnameOf(req.url);
  let up;
  try {
    up = await client.pipe(port, {
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, { port, origin }),
    }, req.method === 'GET' || req.method === 'HEAD' ? null : req);
  } catch (e) {
    if (onUpstreamError) onUpstreamError(e);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', ...securityHeaders(pathname) });
      res.end(JSON.stringify({ ok: false, remote: true, error: 'this session\'s daemon is not answering — it may have just stopped' }));
    } else {
      res.destroy();
    }
    return;
  }
  res.writeHead(up.statusCode || 502, responseHeaders(up.headers, pathname));
  // An SSE response must reach the viewer as each event is written, not when
  // the socket buffer fills.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  up.on('error', () => res.destroy());
  res.on('close', () => { if (!up.complete) up.destroy(); });
  up.pipe(res);
}

module.exports = { proxyHttp, forwardHeaders, responseHeaders, securityHeaders, pathnameOf, FORWARD };
