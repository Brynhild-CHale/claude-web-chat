// The isolated-origin engine: a page or an API no pane may script.
//
// ── Why a separate origin ───────────────────────────────────────────────────
// Every pane on the surface runs Claude- or pack-authored JavaScript in the
// SAME origin and realm as the chrome (the risk paragraph at the head of
// routes/packs.js). A page that takes a secret, or an API whose call does
// something on the host, cannot live there: a pane can `fetch` it, patch
// `fetch` to read what goes out, or rewrite the DOM around a trusted click.
// The same-origin policy is the one boundary pane code cannot cross, so such a
// page lives on an origin of its own: 127.0.0.1 on an ephemeral port, a
// listener that serves that page and nothing else, so no document that runs
// pane code is ever same-origin with it. (The daemon's own port under the
// other loopback name is NOT pane-free: the replay renderer runs panes at
// http://127.0.0.1:<daemon>/replay, and a user may open the surface there.)
//
// Two surfaces build on this: the remote-access setup page
// (lib/server/tunnel-setup) and the answer surface (lib/server/answer-surface,
// spec §4.4). Each passes a `handle(req, res, kit)`; everything below is the
// engine's, the same for both.
//
// ── Every request, in order ─────────────────────────────────────────────────
//   * the idle timer is re-armed;
//   * the common headers go on the response, so every answer (a refusal's
//     included) carries no-store, no-referrer, nosniff, CORP same-origin,
//     X-Frame-Options DENY when framing is refused outright, and opts.headers;
//   * Host is exactly 127.0.0.1:<this port>, else 421 — no DNS rebinding;
//   * an X-WC-Remote header (the tunnel portal's label) is refused 403 unless
//     allowRemote(req) answers true;
//   * OPTIONS is 403 with no Access-Control-* header at all: a cross-origin
//     caller with a custom header must preflight, and the preflight's answer
//     lets nothing through;
//   * a request documents(req) names a frame document (opt-in; the setup page
//     passes none) is refused 403 when it carries a Sec-Fetch-Dest other than
//     'iframe' or 'document' — an <img>, a no-cors fetch, a <script> — so a
//     page that can only GET it never reaches the handler that mints a nonce.
//     No Sec-Fetch-Dest at all (an older client, a test) passes as before;
//   * then handle(). A throw out of it is 500 '<name> failed' and never echoes
//     the error's message.
// The Host, OPTIONS and Sec-Fetch-Dest refusals are decided here, before
// handle(), so the engine reports them: onRefused(req, 'host' | 'preflight' |
// 'dest') runs once the refusal is sent (res.end called), and nothing it does
// or throws changes the response. A remote refusal is the caller's own to note
// (allowRemote sees it).
//
// ── The call gate (kit.refusal) ─────────────────────────────────────────────
// A state-changing call is refused unless ALL hold: Origin is exactly this
// origin (a pane's fetch carries the chrome's; a driver's carries none);
// Sec-Fetch-Site, when sent, is same-origin; Content-Type is
// application/json; and the caller's named header holds a live nonce minted
// for this key. The nonce is placed in a page this origin served (a <meta>,
// read by the page's own script under a CSP that allows no inline script);
// a cross-origin document cannot read the page, so it cannot learn one. The
// gate returns a code and a reason, and the caller words its own 403.
//
// ── Nonce pools ─────────────────────────────────────────────────────────────
// Every document load mints a nonce, and the caps (perKey, then max) evict the
// oldest, so loads of one kind of document must not push out another kind's
// live nonces. issueNonce(key, {pool}) mints into a named pool, each with its
// own caps: nonce.pools[name] = {max?, perKey?} over the defaults nonce.max /
// nonce.perKey, which an undeclared pool takes too. No pool is the default
// pool (the setup page's). Eviction never crosses pools; checkNonce looks in
// all of them, and a nonce still answers only for the key it was minted for.
// A pool's name is the caller's code, never request data.
//
// ── Framing ─────────────────────────────────────────────────────────────────
// frameAncestors null (the default) → `frame-ancestors 'none'` on the CSP and
// X-Frame-Options: DENY. A function → `frame-ancestors <its origins>` and NO
// X-Frame-Options, which cannot express an allow-list (an empty list is
// 'none'). allowRemote and frameAncestors are the two knobs remote answering
// turns (tranche 7).
//
// ── Lifecycle ───────────────────────────────────────────────────────────────
// ensure() starts the listener lazily (one in-flight start shared by every
// concurrent caller) and resolves { origin, port }. It closes after idleMs
// with no request, unless keepAlive() answers true when the timer fires (an
// ask still pending). close() forgets every nonce, so a page left open says
// it has expired, and ends every connection. Nothing here outlives close().

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOOPBACK, REMOTE_HEADER } = require('../core/cors');
const { resolveDefault, flattenTheme, tokenDecls, themeModes } = require('./theme');

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_NONCE_MAX = 16;
const DEFAULT_MAX_BODY = 64 * 1024;
const DEFAULT_POOL = '';
// The Sec-Fetch-Dest values that load a document a user can see and act in.
const DOCUMENT_DESTS = new Set(['iframe', 'document']);

// The content types that are documents or run in one: they carry the CSP.
const CSP_TYPES = /^\s*(?:text\/html|text\/css|text\/javascript|application\/javascript|image\/svg\+xml)\b/i;
// One origin in a frame-ancestors list: no space, no separator, no quote.
const ORIGIN_TOKEN = /^[^\s;,'"]+$/;

function closedError(name) {
  return Object.assign(new Error(`${name} was closed while it started`), { code: 'closed' });
}

function createIsolatedOrigin({
  name = 'isolated-origin',
  idleMs = DEFAULT_IDLE_MS,
  keepAlive = () => false,
  csp = '',
  frameAncestors = null,
  nonce: nonceOpts = {},
  allowRemote = () => false,
  onRefused = null,
  documents = null,
  remoteHint = 'not reachable through the tunnel; answer on the host',
  headers: extraHeaders = {},
  publicDir = null,
  paths = null,
  maxBody = DEFAULT_MAX_BODY,
  handle,
} = {}) {
  if (typeof handle !== 'function') throw new TypeError('createIsolatedOrigin needs handle(req, res, kit)');
  const ttlMs = Number.isFinite(nonceOpts.ttlMs) && nonceOpts.ttlMs > 0 ? nonceOpts.ttlMs : DEFAULT_NONCE_TTL_MS;
  const maxNonces = Number.isInteger(nonceOpts.max) && nonceOpts.max > 0 ? nonceOpts.max : DEFAULT_NONCE_MAX;
  const perKey = Number.isInteger(nonceOpts.perKey) && nonceOpts.perKey > 0 ? nonceOpts.perKey : maxNonces;
  const capsOf = (name) => {
    const o = nonceOpts.pools && Object.prototype.hasOwnProperty.call(nonceOpts.pools, name) ? nonceOpts.pools[name] || {} : {};
    return {
      max: Number.isInteger(o.max) && o.max > 0 ? o.max : maxNonces,
      perKey: Number.isInteger(o.perKey) && o.perKey > 0 ? o.perKey : perKey,
    };
  };

  let server = null;     // the listening server, or null
  let port = null;
  let starting = null;   // the in-flight start, shared by concurrent ensure()s
  let attempt = null;    // that start's cancel flag, which close() sets
  let idle = null;
  const pools = new Map(); // pool name → Map(nonce → { key, at }), in issue order

  const originOf = () => `http://${LOOPBACK}:${port}`;

  // ── nonces ────────────────────────────────────────────────────────────────
  function issueNonce(key = '', { pool = DEFAULT_POOL } = {}) {
    const k = String(key);
    const p = String(pool);
    const caps = capsOf(p);
    let nonces = pools.get(p);
    if (!nonces) { nonces = new Map(); pools.set(p, nonces); }
    const now = Date.now();
    for (const [n, v] of nonces) if (now - v.at > ttlMs) nonces.delete(n);
    const n = crypto.randomBytes(32).toString('base64url');
    nonces.set(n, { key: k, at: now });
    let mine = 0;
    for (const v of nonces.values()) if (v.key === k) mine++;
    for (const [old, v] of nonces) {
      if (mine <= caps.perKey) break;
      if (v.key === k) { nonces.delete(old); mine--; }
    }
    while (nonces.size > caps.max) nonces.delete(nonces.keys().next().value);
    return n;
  }
  // Live and minted for THIS key, in any pool. Checking never consumes: a
  // page polls with its nonce.
  function checkNonce(n, key = '') {
    if (typeof n !== 'string') return false;
    for (const nonces of pools.values()) {
      const v = nonces.get(n);
      if (!v) continue;
      if (Date.now() - v.at > ttlMs) { nonces.delete(n); return false; }
      return v.key === String(key);
    }
    return false;
  }

  // ── the call gate ─────────────────────────────────────────────────────────
  function refusal(req, { key = '', header } = {}) {
    const h = (req && req.headers) || {};
    if (port == null || h.origin !== originOf()) return { code: 'origin', reason: 'this origin only answers itself (Origin)' };
    const site = h['sec-fetch-site'];
    if (site != null && site !== 'same-origin') return { code: 'site', reason: 'this origin only answers itself (Sec-Fetch-Site)' };
    if (!/^application\/json(\s*;|$)/i.test(String(h['content-type'] || ''))) return { code: 'type', reason: 'expected application/json' };
    const name = typeof header === 'string' && header ? header.toLowerCase() : null;
    if (!name || !checkNonce(h[name], key)) return { code: 'nonce', reason: 'no live nonce for this call' };
    return null;
  }

  // ── headers ───────────────────────────────────────────────────────────────
  function ancestors() {
    if (typeof frameAncestors !== 'function') return "'none'";
    let list = [];
    try { list = frameAncestors(); } catch { list = []; }
    const ok = (Array.isArray(list) ? list : []).filter((o) => typeof o === 'string' && ORIGIN_TOKEN.test(o));
    return ok.length ? ok.join(' ') : "'none'";
  }
  // The CSP this request's documents carry: opts.csp plus the frame-ancestors
  // directive the engine owns.
  function composeCsp(req) {
    let base = typeof csp === 'function' ? csp(req) : csp;
    base = String(base == null ? '' : base).trim().replace(/;+\s*$/, '');
    const fa = `frame-ancestors ${ancestors()}`;
    return base ? `${base}; ${fa}` : fa;
  }
  function setCommon(res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    if (typeof frameAncestors !== 'function') res.setHeader('x-frame-options', 'DENY');
    for (const [k, v] of Object.entries(extraHeaders || {})) res.setHeader(k.toLowerCase(), v);
    res.setHeader('cross-origin-resource-policy', 'same-origin');
  }

  // ── the kit ───────────────────────────────────────────────────────────────
  function send(res, status, headers = {}, body) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
    if (h['content-security-policy'] == null && CSP_TYPES.test(String(h['content-type'] || ''))) {
      h['content-security-policy'] = composeCsp(res.req);
    }
    res.writeHead(status, h);
    res.end(body);
  }
  const json = (res, status, obj, headers = {}) => send(res, status, { 'content-type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(obj));

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBody) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch { reject(Object.assign(new Error('the body is not JSON'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  // A plain file name under publicDir, and nothing else.
  function serveAsset(res, rel, type, { head = false } = {}) {
    const ok = publicDir && typeof rel === 'string' && rel && rel !== '.' && rel !== '..'
      && !rel.includes('..') && !/[/\\\0]/.test(rel) && !path.isAbsolute(rel);
    let bytes = null;
    if (ok) { try { bytes = fs.readFileSync(path.join(publicDir, rel)); } catch { bytes = null; } }
    if (!bytes) return json(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { 'content-type': type, 'content-security-policy': composeCsp(res.req) }, head ? undefined : bytes);
  }

  // The project's global theme as tokens only (never its raw CSS). No mode:
  // light on :root and dark under prefers-color-scheme; a mode: that mode's
  // tokens on :root.
  function themeCss(mode) {
    let t = { tokens: {} };
    try { t = resolveDefault(paths); } catch {}
    if (mode === 'light' || mode === 'dark') return `:root {\n${tokenDecls(flattenTheme(t, mode).tokens)}\n}\n`;
    const light = flattenTheme(t, 'light').tokens;
    let css = `:root {\n${tokenDecls(light)}\n}\n`;
    if (themeModes(t).includes('dark')) {
      css += `@media (prefers-color-scheme: dark) {\n  :root {\n${tokenDecls(flattenTheme(t, 'dark').tokens, '    ')}\n  }\n}\n`;
    }
    return css;
  }

  const kit = { json, send, readBody, issueNonce, checkNonce, refusal, serveAsset, themeCss, csp: composeCsp };

  // ── requests ──────────────────────────────────────────────────────────────
  // Tell the caller about a refusal the engine decided, after it is sent. A
  // throw (or a rejected promise) out of the hook is swallowed: the response
  // is already on its way and must not change.
  function refused(req, code) {
    if (typeof onRefused !== 'function') return;
    try {
      const r = onRefused(req, code);
      if (r && typeof r.then === 'function') r.then(null, () => {});
    } catch {}
  }

  async function onRequest(req, res) {
    touch();
    setCommon(res);
    const host = String(req.headers.host || '').toLowerCase();
    if (port == null || host !== `${LOOPBACK}:${port}`) {
      json(res, 421, { ok: false, error: 'host not allowed' });
      return refused(req, 'host');
    }
    if (req.headers[REMOTE_HEADER] != null && allowRemote(req) !== true) {
      return json(res, 403, { ok: false, remote: true, error: remoteHint });
    }
    if (req.method === 'OPTIONS') {
      json(res, 403, { ok: false, error: 'no cross-origin calls' });
      return refused(req, 'preflight');
    }
    const dest = req.headers['sec-fetch-dest'];
    if (dest != null && !DOCUMENT_DESTS.has(dest) && isDocument(req)) {
      json(res, 403, { ok: false, refused: 'dest', error: 'this document only loads in a frame or a window' });
      return refused(req, 'dest');
    }
    return handle(req, res, kit);
  }

  // A throwing documents() counts the request as a document: the gate fails
  // closed.
  function isDocument(req) {
    if (typeof documents !== 'function') return false;
    try { return documents(req) === true; } catch { return true; }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function touch() {
    if (idle) clearTimeout(idle);
    idle = null;
    if (!server) return;
    idle = setTimeout(onIdle, idleMs);
    if (idle.unref) idle.unref();
  }
  function onIdle() {
    idle = null;
    let keep = false;
    try { keep = keepAlive() === true; } catch { keep = false; }
    if (keep) touch(); else close();
  }

  function shut(s) {
    return new Promise((resolve) => {
      s.close(() => resolve());
      try { s.closeAllConnections(); } catch {}
    });
  }

  async function ensure() {
    if (server) { touch(); return { origin: originOf(), port }; }
    if (!starting) {
      const mine = { cancelled: false };
      attempt = mine;
      const s = http.createServer((req, res) => {
        onRequest(req, res).catch(() => {
          try {
            if (!res.headersSent) json(res, 500, { ok: false, error: `${name} failed` });
            else res.end();
          } catch {}
        });
      });
      const p = new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, LOOPBACK, () => { s.off('error', reject); resolve(); });
      }).then(async () => {
        if (mine.cancelled) { await shut(s); throw closedError(name); }
        server = s;
        port = s.address().port;
        touch();
      }).finally(() => {
        if (attempt === mine) attempt = null;
        if (starting === p) starting = null;
      });
      starting = p;
    }
    await starting;
    if (port == null) throw closedError(name); // a close() landed after the start
    return { origin: originOf(), port };
  }

  // Stop listening and forget every nonce; idempotent. A close() racing a
  // start closes that server once it listens.
  async function close() {
    if (idle) { clearTimeout(idle); idle = null; }
    pools.clear();
    // A start in flight is cancelled and forgotten, so the next ensure()
    // starts afresh rather than awaiting the one this close() ends.
    const pending = starting;
    if (attempt) attempt.cancelled = true;
    attempt = null;
    starting = null;
    const s = server;
    server = null;
    port = null;
    if (pending) { try { await pending; } catch {} }
    if (s) await shut(s);
  }

  return {
    ensure,
    close,
    get port() { return port; },
    get origin() { return port != null ? originOf() : null; },
  };
}

module.exports = { createIsolatedOrigin };
