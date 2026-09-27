// The browser setup page for remote access — ⌘K "Set up remote access…" — on
// its OWN ORIGIN, so no pane can script it.
//
// ── Why a separate origin, and why a separate PORT ──────────────────────────
// This page takes a Cloudflare API token, a hostname and an email, and with
// them publishes this machine's surfaces to a Cloudflare account. Every pane on
// the surface runs Claude- or pack-authored JavaScript in the SAME origin and
// realm as the chrome (the risk paragraph at the head of routes/packs.js): if
// the setup API lived on the surface's origin, a malicious pane could `fetch`
// it with an ATTACKER's token and email and hand the attacker the user's
// surfaces. So the page and its API live somewhere panes cannot reach.
//
// The obvious candidate — the daemon's own port under the other loopback name,
// http://127.0.0.1:<port> while the chrome is on http://localhost:<port> — is
// NOT pane-free: the replay renderer drives headless Chrome at
// http://127.0.0.1:<port>/replay (lib/server/replay/render.js), a document that
// runs pane code, and nothing stops a user opening the surface itself under
// 127.0.0.1. Either would put pane code same-origin with the setup API. So this
// is a SEPARATE listener: 127.0.0.1 on an ephemeral port, started when the
// chrome asks for it (GET /tunnel/setup on the daemon, which redirects here)
// and closed after IDLE_MS unused. It serves this page and nothing else, so no
// document that runs pane code is ever same-origin with it.
//
// ── The gate on every setup call (refuse unless ALL hold) ───────────────────
//   * Host is exactly 127.0.0.1:<this port>   — no DNS rebinding onto it.
//   * no X-WC-Remote                          — the tunnel portal's label; it
//                                               never proxies here anyway.
//   * Origin is exactly http://127.0.0.1:<this port>. A pane's fetch carries
//     the SURFACE's origin, which is refused.
//   * Sec-Fetch-Site, when sent, is same-origin.
//   * Content-Type: application/json, and X-WC-Setup: <a nonce this listener
//     issued with a page load>. The custom header makes any cross-origin call
//     preflighted, and a preflight here is answered 403 with no CORS allowance
//     at all, so the real request never leaves the browser.
// The nonce is minted per page load and placed in the page (a <meta>, read by
// the page's own script — the CSP allows no inline script). A cross-origin
// document cannot read the page, so it cannot learn one.
//
// The page is served with a strict CSP (script/style/connect 'self' only), no
// framing (frame-ancestors 'none' + X-Frame-Options), no referrer, and
// Cross-Origin-Opener-Policy: same-origin, so the surface tab that opened it
// keeps no handle on it.
//
// ── The token ───────────────────────────────────────────────────────────────
// The API token arrives in the body of ONE call (plan or apply), lives in that
// call's closure (lib/tunnel/cf-api holds it for the run), and is never logged,
// stored or echoed: every line and error sent back is scrubbed of it, and
// nothing here writes a request body anywhere. What setup stores is the
// tunnel's connector token, exactly as `tunnel setup` does — both run
// lib/tunnel/api-setup, and "Bring it up" is lib/tunnel/control `up`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOOPBACK, REMOTE_HEADER } = require('../../core/cors');
const { userPaths } = require('../../core/paths');
const { createCfApi, PERMS } = require('../../tunnel/cf-api');
const apiSetup = require('../../tunnel/api-setup');
const defaultControl = require('../../tunnel/control');
const { defaultFetchJwks } = require('../../tunnel/jwks');
const { publicOrigin } = require('../../tunnel/config');
const { resolveDefault, flattenTheme, tokenDecls, themeModes } = require('../theme');

const PAGE = '/setup/tunnel';
const CSRF_HEADER = 'x-wc-setup';
const IDLE_MS = 30 * 60 * 1000;
const NONCE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_NONCES = 16;
const MAX_BODY = 64 * 1024;
// The sign-in modes the page offers. Google needs an OAuth client made in
// Google Cloud first, which the terminal walks through (`--signin google`).
const PAGE_SIGNINS = ['pin+biometric', 'pin'];

const PUBLIC = path.join(__dirname, 'public');
const ASSETS = {
  [`${PAGE}/setup.js`]: ['setup.js', 'text/javascript; charset=utf-8'],
  [`${PAGE}/setup.css`]: ['setup.css', 'text/css; charset=utf-8'],
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Every response, page or refusal.
const COMMON = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

// The project's global theme as tokens only — its light mode on :root, its
// dark mode under prefers-color-scheme. Raw theme CSS is the chrome's, never
// this page's.
function themeCss(paths) {
  let t = { tokens: {} };
  try { t = resolveDefault(paths); } catch {}
  const light = flattenTheme(t, 'light').tokens;
  let css = `:root {\n${tokenDecls(light)}\n}\n`;
  if (themeModes(t).includes('dark')) {
    css += `@media (prefers-color-scheme: dark) {\n  :root {\n${tokenDecls(flattenTheme(t, 'dark').tokens, '    ')}\n  }\n}\n`;
  }
  return css;
}

// What the page shows as live status: `tunnel status`'s read, trimmed to what
// a checklist needs (no ports, pids or other projects' names).
function summarize(s) {
  const p = s.portal || {};
  const c = s.cloudflared || null;
  return {
    configured: !!s.configured,
    error: s.configured ? null : (s.error || null),
    hostname: s.hostname || null,
    picker: s.picker || null,
    signin: s.signin || null,
    tunnel: s.tunnel ? { kind: s.tunnel.kind, name: s.tunnel.name || null } : null,
    portal: {
      running: !!p.running,
      invalid: !!(p.config && p.config.state === 'invalid'),
      restart: (p.config && Array.isArray(p.config.restart)) ? p.config.restart : [],
      config_current: p.config_current !== false,
      token_current: p.token_current !== false,
    },
    cloudflared: c ? {
      state: c.state || null,
      ready: !!c.ready,
      connections: Number.isFinite(c.connections) ? c.connections : null,
      error: c.error || null,
    } : null,
    jwks_error: (s.jwks && s.jwks.error) || null,
    sessions: Array.isArray(s.sessions) ? s.sessions.length : 0,
  };
}

function createTunnelSetup({
  paths,
  env = process.env,
  fetchJwks = defaultFetchJwks,
  control = defaultControl,
  userPathsFn = userPaths,
  idleMs = IDLE_MS,
} = {}) {
  let server = null;
  let starting = null;
  let port = null;
  let idle = null;
  let busy = false;
  const nonces = new Map(); // nonce → issued at

  const origin = () => `http://${LOOPBACK}:${port}`;

  function touch() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { close(); }, idleMs);
    if (idle.unref) idle.unref();
  }

  function issueNonce() {
    const now = Date.now();
    for (const [n, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(n);
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value);
    const n = crypto.randomBytes(32).toString('base64url');
    nonces.set(n, now);
    return n;
  }
  function nonceOk(n) {
    if (typeof n !== 'string' || !nonces.has(n)) return false;
    if (Date.now() - nonces.get(n) > NONCE_TTL_MS) { nonces.delete(n); return false; }
    return true;
  }

  // Why a setup CALL is refused, or null. See the header.
  function refusal(req) {
    const h = req.headers;
    if (h.origin !== origin()) return 'this page only answers itself (Origin)';
    const site = h['sec-fetch-site'];
    if (site != null && site !== 'same-origin') return 'this page only answers itself (Sec-Fetch-Site)';
    if (!/^application\/json(\s*;|$)/i.test(String(h['content-type'] || ''))) return 'expected application/json';
    if (!nonceOk(h[CSRF_HEADER])) return 'this setup page has expired — reopen it from ⌘K "Set up remote access…"';
    return null;
  }

  function send(res, status, headers, body) {
    res.writeHead(status, { ...COMMON, ...headers });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(obj));

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
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

  // The form's values → what api-setup takes. The token never leaves here
  // except into createCfApi.
  function readInput(body) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
    const emails = (Array.isArray(body.emails) ? body.emails : [body.email])
      .filter((e) => typeof e === 'string').flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean);
    const signin = typeof body.signin === 'string' && body.signin ? body.signin : 'pin+biometric';
    const account = typeof body.account === 'string' && body.account.trim() ? body.account.trim() : null;
    const err = (m) => { const e = new Error(m); e.userFacing = true; return e; };
    if (!token) throw err('paste the Cloudflare API token');
    if (token.length > 4096 || /\s/.test(token)) throw err('that does not look like a Cloudflare API token (paste the token itself)');
    if (!hostname) throw err('a picker hostname is required, like wc.example.com');
    if (!emails.length) throw err('at least one allowed email is required (your own)');
    if (!PAGE_SIGNINS.includes(signin)) {
      throw err('Google sign-in needs an OAuth client made in Google Cloud first — set it up in the terminal: claude-web-chat tunnel setup --signin google');
    }
    return { token, hostname, emails, signin, account };
  }

  // A line or message with the API token taken out, whatever put it there —
  // in any case: a token pasted into the hostname field comes back from the
  // config check lowercased.
  const scrubber = (token) => {
    const re = token && token.length >= 8 ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
    return (s) => {
      const str = String(s == null ? '' : s);
      return re ? str.replace(re, '‹API token›') : str;
    };
  };

  // One setup run's collected context — the same pieces `tunnel setup` uses.
  function prepare(input) {
    const up = userPathsFn();
    const ex = apiSetup.readExisting(up);
    const style = ex.existing.style || 'flat';
    const want = apiSetup.buildWant({
      hostname: input.hostname, style, emails: input.emails, signin: input.signin,
      tunnelName: apiSetup.defaultsFrom(ex.existing).tunnelName, account: input.account, env,
    });
    const api = createCfApi({ token: input.token, env });
    return { up, ex, style, want, api };
  }

  // gather's "which account?" — the page answers it with a picker, so record
  // the list and let gather refuse; the response carries the choices.
  function chooser() {
    const seen = { accounts: null };
    return { seen, choose: async (accounts) => { seen.accounts = accounts.map((a) => ({ id: a.id, name: a.name })); return null; } };
  }

  async function doStatus(res) {
    let s;
    try { s = await control.collectStatus({ env }); } catch (e) { s = { configured: false, error: e.message }; }
    let defaults = { hostname: '', emails: [] };
    try {
      const d = apiSetup.defaultsFrom(apiSetup.readExisting(userPathsFn()).existing);
      defaults = { hostname: d.hostname, emails: d.emails };
    } catch {}
    json(res, 200, {
      ok: true,
      busy,
      status: summarize(s),
      defaults,
      perms: Object.values(PERMS),
      links: { token: apiSetup.TOKEN_PAGE_URL, zeroTrust: apiSetup.ZERO_TRUST_URL },
    });
  }

  async function doPlan(res, body) {
    let input;
    try { input = readInput(body); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const scrub = scrubber(input.token);
    const lines = [];
    const log = (l) => lines.push(scrub(l));
    const { seen, choose } = chooser();
    try {
      const { want, api } = prepare(input);
      const run = await apiSetup.runSetup({
        api, want, dryRun: true, log, choose,
        dryRunNote: 'Nothing was changed. If the plan looks right, apply it.',
      });
      json(res, 200, {
        ok: true, lines,
        plan: { steps: run.plan.steps, conflicts: run.plan.conflicts, warnings: run.plan.warnings || [] },
        account: run.state.account, zone: run.state.zone, team: run.state.team,
      });
    } catch (e) {
      json(res, 200, { ok: false, error: scrub(e.message), lines, ...(seen.accounts ? { accounts: seen.accounts } : {}) });
    }
  }

  // A streamed step: one JSON object per line ({line}), then {done, ok, …}.
  function stream(res) {
    res.writeHead(200, { ...COMMON, 'content-type': 'application/x-ndjson; charset=utf-8' });
    res.on('error', () => {}); // the page went away mid-run; the run still finishes
    return {
      line: (l) => res.write(`${JSON.stringify({ line: l })}\n`),
      end: (obj) => res.end(`${JSON.stringify({ done: true, ...obj })}\n`),
    };
  }

  async function doApply(res, body) {
    let input;
    try { input = readInput(body); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const scrub = scrubber(input.token);
    const out = stream(res);
    const log = (l) => out.line(scrub(l));
    const { seen, choose } = chooser();
    try {
      const { up, ex, style, want, api } = prepare(input);
      const run = await apiSetup.runSetup({ api, want, dryRun: false, log, choose });
      const config = await apiSetup.finishSetup({
        paths: up, existing: ex.existing, existingRead: ex.existingRead, unreadable: ex.unreadable,
        hostname: input.hostname, style, emails: input.emails, result: run.result, log, fetchJwks,
      });
      out.end({ ok: true, signin: run.result.signin, why: run.result.why ? scrub(run.result.why) : null, picker: `${publicOrigin(config.hostname)}/` });
    } catch (e) {
      out.end({ ok: false, error: scrub(e.message), ...(seen.accounts ? { accounts: seen.accounts } : {}) });
    }
  }

  async function doUp(res) {
    const out = stream(res);
    try {
      const r = await control.up({}, { log: out.line, env });
      out.end({ ok: true, already: !!r.already });
    } catch (e) {
      out.end({ ok: false, error: e.message });
    }
  }

  const ACTIONS = { status: doStatus, plan: doPlan, apply: doApply, up: doUp };
  const EXCLUSIVE = new Set(['plan', 'apply', 'up']);

  async function handle(req, res) {
    touch();
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `${LOOPBACK}:${port}`) return json(res, 421, { ok: false, error: 'host not allowed' });
    if (req.headers[REMOTE_HEADER] != null) {
      return json(res, 403, { ok: false, remote: true, error: 'remote access is set up on the host, never through the tunnel' });
    }
    const pathname = String(req.url || '/').split(/[?#]/)[0];

    // A preflight is how a cross-origin page would ask to call in. The answer
    // is always no, and says nothing that would let one through.
    if (req.method === 'OPTIONS') return json(res, 403, { ok: false, error: 'no cross-origin calls' });

    if (req.method === 'GET' || req.method === 'HEAD') {
      const head = req.method === 'HEAD';
      if (pathname === PAGE || pathname === `${PAGE}/`) {
        let html;
        try { html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch {
          return json(res, 500, { ok: false, error: 'setup page missing' });
        }
        html = html.replace('{{CSRF}}', issueNonce());
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }, head ? undefined : html);
      }
      if (pathname === `${PAGE}/theme.css`) {
        return send(res, 200, { 'content-type': 'text/css; charset=utf-8', 'content-security-policy': PAGE_CSP }, head ? undefined : themeCss(paths));
      }
      const asset = ASSETS[pathname];
      if (asset) {
        let bytes;
        try { bytes = fs.readFileSync(path.join(PUBLIC, asset[0])); } catch {
          return json(res, 404, { ok: false, error: 'not found' });
        }
        return send(res, 200, { 'content-type': asset[1], 'content-security-policy': PAGE_CSP }, head ? undefined : bytes);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    const m = req.method === 'POST' && /^\/setup\/tunnel\/(status|plan|apply|up)$/.exec(pathname);
    if (!m) return json(res, 405, { ok: false, error: 'not here' });
    const why = refusal(req);
    if (why) return json(res, 403, { ok: false, error: why });
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
    const action = m[1];
    if (EXCLUSIVE.has(action)) {
      if (busy) return json(res, 409, { ok: false, error: 'another setup step is still running — wait for it to finish' });
      busy = true;
      try { await ACTIONS[action](res, body); } finally { busy = false; }
      return;
    }
    await ACTIONS[action](res, body);
  }

  // Start the listener if it is not running; → { url, port }.
  async function ensure() {
    if (server && server.listening) { touch(); return { url: `${origin()}${PAGE}`, port }; }
    if (!starting) {
      starting = new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          handle(req, res).catch(() => { try { if (!res.headersSent) json(res, 500, { ok: false, error: 'setup failed' }); else res.end(); } catch {} });
        });
        s.once('error', reject);
        s.listen(0, LOOPBACK, () => {
          s.off('error', reject);
          server = s;
          port = s.address().port;
          touch();
          resolve();
        });
      }).finally(() => { starting = null; });
    }
    await starting;
    return { url: `${origin()}${PAGE}`, port };
  }

  // Stop listening and forget every nonce. A page left open then says it has
  // expired, and ⌘K opens a fresh one.
  function close() {
    if (idle) { clearTimeout(idle); idle = null; }
    nonces.clear();
    const s = server;
    server = null;
    port = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      try { s.closeAllConnections(); } catch {}
    });
  }

  return {
    ensure,
    close,
    get port() { return port; },
    get origin() { return port ? origin() : null; },
  };
}

module.exports = { createTunnelSetup, summarize, PAGE, CSRF_HEADER, PAGE_CSP, PAGE_SIGNINS };
