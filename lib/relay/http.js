// The streamed HTTP proxy from a remote viewer to one loopback daemon (C-06.4
// step 7's HTTP half), with the header rules of ./headers.js on both legs. It
// lived in lib/portal/proxy.js until the connector needed it too; the portal
// re-requires it from here.
//
// Streaming end to end (lib/client pipe): an export download, a binary asset
// or a long response flows through without being buffered in the relay.
//
// THE SINK IS DUCK-TYPED. proxyHttp reads `req.method`, `req.url` and
// `req.headers`, pipes `req` upstream for a write, and writes into `res`
// through `writeHead`, `flushHeaders` (when present), `headersSent`, `end`,
// `destroy` and `on('close')` — an http.ServerResponse, or any stream that
// answers the same.

const client = require('../client');
const { forwardHeaders, securityHeaders, answerSecurityHeaders, responseHeaders, pathnameOf } = require('./headers');

// The body of a relayed request whose daemon cannot be reached: proxyHttp's
// 502, and the portal's step-6 'down' answer (HTTP and WebSocket alike).
const NOT_ANSWERING = { ok: false, remote: true, error: 'this session\'s daemon is not answering — it may have just stopped' };

// Proxy one request. A daemon that cannot be reached (it has usually just
// exited) is a 502, and `onUpstreamError` lets the caller forget its registry
// memo so the next request sees the session gone. `origin` says the caller
// matched the viewer's Origin and it should be forwarded (rewritten).
// `mode: 'answer'` (with `sessionHost`) is the answer host's proxy (./headers.js);
// `extraHeaders` are added to the response (the portal's X-WC-Answer-Origin);
// `retry(e)`, for a GET or HEAD only, may answer a port to try once more after
// a refused connection (a write is never replayed).
async function proxyHttp(req, res, {
  port, origin, onUpstreamError, mode = 'session', sessionHost = null, extraHeaders = null, retry = null,
}) {
  const pathname = pathnameOf(req.url);
  const safe = req.method === 'GET' || req.method === 'HEAD';
  const send = (p) => client.pipe(p, {
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req.headers, { port: p, origin, mode }),
  }, safe ? null : req);
  let up;
  try {
    up = await send(port);
  } catch (e) {
    let again = null;
    if (safe && typeof retry === 'function' && e && e.code === 'ECONNREFUSED') {
      try { again = await retry(e); } catch { again = null; }
    }
    if (again) {
      try { up = await send(again); } catch { up = null; }
    }
    if (!up) {
      if (onUpstreamError) onUpstreamError(e);
      if (!res.headersSent) {
        const sec = mode === 'answer' ? answerSecurityHeaders() : securityHeaders(pathname);
        res.writeHead(502, { 'content-type': 'application/json', ...sec });
        res.end(JSON.stringify(NOT_ANSWERING));
      } else {
        res.destroy();
      }
      return;
    }
  }
  res.writeHead(up.statusCode || 502, responseHeaders(up.headers, pathname, { mode, sessionHost, extraHeaders }));
  // An SSE response must reach the viewer as each event is written, not when
  // the socket buffer fills.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  up.on('error', () => res.destroy());
  res.on('close', () => { if (!up.complete) up.destroy(); });
  up.pipe(res);
}

module.exports = { proxyHttp, NOT_ANSWERING };
