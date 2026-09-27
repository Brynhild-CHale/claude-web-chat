// A request to the PUBLIC internet, bounded — the one home shared by the
// requesters that have nothing to fence but time, size and scheme.
//
// Extracted when the fourth outbound requester arrived (the Cloudflare API
// client behind `tunnel setup --api-token`, lib/tunnel/cf-api.js), as the
// conventions ratchet on the https module said it would be. The Access key
// set fetch (lib/tunnel/jwks.js) moved onto it at the same time. The two older
// requesters keep their own request, on purpose: the embed probe
// (lib/server/routes/embed.js) resolves and fences the address it dials, and
// the release download (lib/update/release.js) streams a tarball to disk and
// follows redirects — neither is "a small JSON exchange", which is all this is.
//
// Policy, and why:
//   * https only — except plain http to a LOOPBACK host, which is how a test
//     points a requester at an in-process fake. A plaintext request to anywhere
//     else is refused before it is made: every caller here sends either a
//     credential (an API token) or trusts the answer (a signing key).
//   * Bounded in time (timeoutMs, from the first byte of the attempt to the
//     last of the answer) and in size (maxBytes — the socket is destroyed the
//     moment the answer outgrows it).
//   * A non-2xx is NOT an error at this layer: request() resolves with the
//     status, and the caller decides (Cloudflare's API explains a refusal in a
//     JSON body the caller must read). fetchJson() is the strict GET for
//     callers that only want a 200.
//   * No redirects are followed and no cookies kept.

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// The module that may carry a request to `u`, or a thrown Error saying why none
// may. Exported for the test.
function transportFor(u) {
  if (u.protocol === 'https:') return https;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return http;
  if (u.protocol === 'http:') throw new Error(`outbound: refusing plaintext http to ${u.hostname} — only https leaves this machine`);
  throw new Error(`outbound: unsupported scheme ${u.protocol}`);
}

// One request → { status, headers, text, json } (json null when the body is
// not JSON). Rejects only when there is no answer to give: refused scheme,
// network error, timeout, oversize.
function request(url, {
  method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(v);
    };
    let u;
    let lib;
    try {
      u = new URL(url);
      lib = transportFor(u);
    } catch (e) { reject(e); return; }
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = { accept: 'application/json', ...headers };
    if (payload) {
      if (!Object.keys(hdrs).some((k) => k.toLowerCase() === 'content-type')) hdrs['content-type'] = 'application/json';
      hdrs['content-length'] = payload.length;
    }
    const where = `${u.origin}${u.pathname}`;
    let req;
    const timer = setTimeout(() => {
      if (req) req.destroy();
      done(new Error(`timed out fetching ${where}`));
    }, timeoutMs);
    try {
      req = lib.request(u, { method, headers: hdrs }, (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); done(new Error(`response from ${where} exceeds ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch {}
          done(null, { status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', (e) => done(e));
      });
    } catch (e) { done(e); return; }
    req.on('error', (e) => done(e));
    req.end(payload || undefined);
  });
}

// GET a JSON document, or reject: anything but a 200 with a JSON body.
async function fetchJson(url, opts = {}) {
  const r = await request(url, { ...opts, method: 'GET' });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
  if (r.json == null) throw new Error(`the answer from ${url} is not JSON`);
  return r.json;
}

module.exports = { request, fetchJson, transportFor, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
