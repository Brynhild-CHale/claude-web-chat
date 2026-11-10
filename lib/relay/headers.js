// The header hygiene on both legs of a relay from a remote viewer to one
// loopback daemon — the rules the tunnel portal (lib/portal) and the connector
// share. They lived in lib/portal/proxy.js until a second entry point needed
// them (C-06.4 step 7, 05 §4); lib/portal/proxy.js re-exports them from here.
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
// by the allowlist above, and this one is set after. That last part is load-
// bearing: POST /api/pane/spawn refuses a raw-html body when the label is on
// (lib/server/routes/spawn.js), so a viewer who could drop it could spawn html.
//
// RESPONSE: hop-by-hop headers and Set-Cookie are stripped (no daemon cookie
// belongs on the public hostname), and every response carries
//   Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff,
//   frame-ancestors / X-Frame-Options — 'none'/DENY everywhere except
//     /preview/node/*, /preview/pane/* and /replay, which the surface frames
//     from the SAME origin (thumbnails, the glance card, a pane's history, the
//     replay overlay) and get 'self'/SAMEORIGIN,
//   Cache-Control: no-store on /api/* and on those framed documents — graph
//     and store contents must not sit in a shared or disk cache on the remote
//     machine, and a preview is a node's whole HTML plus its store snapshot.
//
// THE ANSWER MODE (`mode: 'answer'`, spec §4.6): the same proxy to a daemon's
// ANSWER SURFACE (its own loopback origin, lib/server/answer-surface) for a
// session's answer host (lib/portal/answer.js). Three differences, and the
// session mode's bytes are untouched:
//   * request: the one x-wc-* header a viewer may send is X-WC-Answer (the
//     frame's nonce, the click token — useless without the answer origin's
//     document), and a matched Origin becomes `http://127.0.0.1:<answer port>`,
//     the engine's own origin (it checks exactly that). X-WC-Remote is still
//     set last, so a viewer can neither send nor suppress it.
//   * response: no X-Frame-Options (it cannot name an allowed ancestor), and
//     the daemon's frame-ancestors directive — loopback only, it never reads
//     hostnames — is REPLACED by exactly `frame-ancestors https://<session
//     host>`: the answer documents are framable by the session's own page and
//     nothing else (ruled E4 (a)).
//   * Cache-Control: no-store on every response.

const { REMOTE_HEADER, REMOTE_HEADER_VALUE, LOOPBACK } = require('../core/cors');

const FORWARD = new Set([
  'accept', 'accept-language', 'content-type', 'content-length',
  'if-none-match', 'if-modified-since', 'range', 'user-agent', 'last-event-id',
]);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie',
]);

// The answer frame's nonce header (lib/server/answer-surface ANSWER_HEADER):
// forwarded in the answer mode only.
const ANSWER_HEADER = 'x-wc-answer';

function forwardHeaders(incoming, { port, origin = false, mode = 'session' } = {}) {
  const answer = mode === 'answer';
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    const name = k.toLowerCase();
    if (v == null) continue;
    if (FORWARD.has(name) || name.startsWith('sec-fetch-') || (answer && name === ANSWER_HEADER)) out[name] = v;
  }
  if (origin) out.origin = answer ? `http://${LOOPBACK}:${port}` : `http://localhost:${port}`;
  out[REMOTE_HEADER] = REMOTE_HEADER_VALUE;
  return out;
}

// The daemon's preview documents (PREVIEW_CSP): a whole node, one pane of one
// node (the pane-history popover), or the replay player (the replay overlay) —
// all iframed by the surface from its own origin.
function isPreviewPath(pathname) {
  return /^\/preview\/(node|pane)(\/|$)/i.test(pathname) || /^\/replay\/?$/i.test(pathname);
}

// Headers every portal response carries, whatever produced it (proxy, picker,
// refusal). `frameSelf` for the one same-origin-framed document.
function securityHeaders(pathname, { frameSelf = isPreviewPath(pathname) } = {}) {
  const h = {
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': frameSelf ? 'SAMEORIGIN' : 'DENY',
  };
  if (/^\/api(\/|$)/i.test(pathname) || isPreviewPath(pathname)) h['cache-control'] = 'no-store';
  return h;
}

// The answer mode's headers: `securityHeaders` without X-Frame-Options, and
// no-store on everything.
function answerSecurityHeaders() {
  return { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
}

// A CSP header value (a string, or a list of policies) with every
// frame-ancestors directive taken out; a policy left empty is dropped.
function withoutFrameAncestors(csp) {
  const out = [];
  for (const policy of [].concat(csp == null ? [] : csp)) {
    const kept = String(policy).split(';').map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
    if (kept.length) out.push(kept.join('; '));
  }
  return out;
}

function responseHeaders(upstream, pathname, { mode = 'session', sessionHost = null, extraHeaders = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(upstream || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(extraHeaders || {})) out[k.toLowerCase()] = v;
  if (mode === 'answer') {
    delete out['x-frame-options'];
    Object.assign(out, answerSecurityHeaders());
    // ONE frame-ancestors directive, naming the session's public origin only.
    // With no session host (never, from the portal) nothing may frame it.
    const fa = `frame-ancestors ${sessionHost ? `https://${sessionHost}` : "'none'"}`;
    const kept = withoutFrameAncestors(out['content-security-policy']);
    if (kept.length) kept[0] = `${kept[0]}; ${fa}`;
    else kept.push(fa);
    out['content-security-policy'] = kept.length === 1 ? kept[0] : kept;
    return out;
  }
  Object.assign(out, securityHeaders(pathname));
  const fa = `frame-ancestors ${isPreviewPath(pathname) ? "'self'" : "'none'"}`;
  // A second policy is enforced alongside the daemon's own (PREVIEW_CSP on
  // /preview/*): both must pass, so this adds without loosening.
  const csp = out['content-security-policy'];
  out['content-security-policy'] = csp ? [].concat(csp, fa) : fa;
  return out;
}

function pathnameOf(url) {
  const q = String(url || '/').search(/[?#]/);
  return q === -1 ? String(url || '/') : String(url).slice(0, q);
}

module.exports = {
  FORWARD,
  HOP_BY_HOP,
  ANSWER_HEADER,
  forwardHeaders,
  isPreviewPath,
  securityHeaders,
  answerSecurityHeaders,
  withoutFrameAncestors,
  responseHeaders,
  pathnameOf,
};
