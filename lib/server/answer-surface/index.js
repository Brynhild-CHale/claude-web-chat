// The answer surface (spec §4.4, §15.5), `ctx.answerSurface`: the loopback
// listener, on an origin of its own, that serves the answer frames' documents
// and the ONLY routes through which a click answers an ask — plus the
// `register` seam through which the control layer adds its own documents and
// actions, so no later unit edits this file (U74's remote knobs excepted).
//
// ── Why its own origin ──────────────────────────────────────────────────────
// Pane scripts run in the chrome's realm with fetch to every daemon route; an
// endpoint that approves a permission runs host commands. The same-origin
// policy is the one boundary pane code cannot cross, so the documents and the
// decide route live on 127.0.0.1:<ephemeral> (lib/server/isolated-origin, which
// binds loopback even when WEB_CHAT_HOST binds the daemon elsewhere), framed by
// the chrome (frame-ancestors) but never scriptable by it.
//
//   createAnswerSurface({asks, mainPort, audience, root, publicDir, fontsDir,
//                        idleMs, now, log})
//     → { ensure() → Promise<{origin, port}>, close(), port, origin,
//         info() → {port} | null, register(kind, spec) → unregister,
//         remoteAnswering() → whether this project is opted in at `full` }
//
// ── Routes (the answer origin only) ─────────────────────────────────────────
//   GET  /answer/ask/:id?layout=bar|card|sheet|page&mode=light|dark&device=
//        the document: <publicDir>/index.html with {{NONCE}} (a nonce minted
//        for 'ask:<id>'), {{MODE}}, {{KIND}} ('ask') and {{META}} (empty)
//        substituted, nothing of the ask inlined. layout=page adds COOP.
//   GET  /answer/<name>.js | /answer/<name>.css   a file of publicDir by name
//   GET  /answer/palette.css                      the frame palette (./palette)
//   GET  /answer/fonts.css                        THE @font-face list (public/fonts/
//        fonts.css via lib/server/fonts fontFaces(), read from the parent of
//        fontsDir), each src moved to /answer/fonts/ — never a second list
//   GET  /answer/fonts/<file>.woff2               a font of public/fonts
//   GET  /answer/api/asks/:id?v=&wait=≤20000      the display view, long-polled
//   POST /answer/api/asks/:id/decide {decision, version, device?}
//   GET  /answer/<kind>/<rest>                    a registered kind's document
//   GET|POST /answer/api/<kind>/<rest>            a registered kind's API
//
// ── Documents and their nonces (ruling F2) ─────────────────────────────────
// A document (an ask's, or a registered kind's) is refused 403 {refused:
// 'dest'} before its handler when Sec-Fetch-Dest says anything but 'iframe'
// or 'document' (the engine's gate, given documents()): an <img> or a no-cors
// fetch from any page would otherwise mint a nonce on every load. The refusal
// is noted on the ask, or reaches the kind's onRefused. Each document kind
// mints into a nonce pool of its own (the engine's pools), so loads of one
// kind never evict another kind's live nonces: 64 ask documents leave a
// control frame's nonce standing.
//
// ── The gate ────────────────────────────────────────────────────────────────
// Every /answer/api/* request passes it HERE, before any handler — a kind
// supplies only the nonce key, so a later kind cannot forget the gate:
//   * the engine's Host (421), remote (403) and OPTIONS (403, no CORS) rules;
//   * Origin, when sent, exactly this origin (always required on a POST);
//   * Sec-Fetch-Site, when sent, same-origin;
//   * a POST's Content-Type application/json, its body read by the kit (64 KB);
//   * X-WC-Answer holding a live nonce minted for the request's key: 'ask:<id>'
//     for an ask, the kind's nonceKey(req, {rest, query, body}) otherwise. A
//     nonce lives only in a document this listener served (a <meta>, read by
//     the page's own script under a CSP with no inline script), so only such a
//     document can call. A cross-origin caller with that header preflights,
//     and the preflight is refused.
// A refusal answers 403 {ok:false, refused: <code>} and nothing a pane could
// use; a refused decide is noted on the ask's audit (asks.noteRefusal), a
// kind's refusal goes to its onRefused. The refusals the engine answers before
// the handler (remote, a bad Host 'host', a preflight 'preflight') are noted
// the same way, through its allowRemote and onRefused.
//
// ── Keep-alive (§15.5; notes-A Q3) ──────────────────────────────────────────
// Every request re-arms the 30-minute idle timer (the engine), so a mounted
// frame that polls keeps the listener up. When the timer fires, it stays up
// while an ask is pending or any registered kind's keepAlive() answers true.
//
// ── Remote (§4.6, tranche 7) ────────────────────────────────────────────────
// A remote viewer reaches this listener only through the tunnel portal's
// ANSWER host (`<session>-a`, lib/tunnel/config answerHost), whose own table
// (ANSWER_RULES, lib/core/remote-policy) lets through exactly these routes and
// only for a project opted in at `full`; the portal rewrites Origin to this
// origin, forwards the X-WC-Answer nonce and labels the request X-WC-Remote
// (lib/portal/answer.js). Behind it, three knobs:
//   * remoteAnswering() — the project's opt-in is `full` (the audience's
//     remoteLevel(); false with no audience). The asks domain reads it: a
//     full remote viewer counts as a viewer (viewersOk), and a remote decide
//     and the view open. An elicitation stays local only at every level (D3).
//   * allowRemote — the engine's second lock: an X-WC-Remote request passes
//     only while remoteAnswering() and the request's own level is `full`;
//     anything else is refused 403 with REMOTE_HINT and noted on the ask.
//   * frameAncestors — stays the main port's two loopback origins. The portal
//     replaces the directive on answer-host responses with exactly the
//     session's public origin (Q2 (a)); this listener never reads hostnames.
// A refusal the asks domain answers to a remote decide (403 'remote-off') is
// noted on the ask's audit here too, with origin 'remote'.

const fs = require('fs');
const path = require('path');
const { createIsolatedOrigin } = require('../isolated-origin');
const { REMOTE_HEADER } = require('../../core/cors');
const { escapeHtml } = require('../../core/html');
const { renderPalette } = require('./palette');
const { fontFaces } = require('../fonts');
const { SRC_RE } = require('../../core/fonts');

const ANSWER_HEADER = 'x-wc-answer';
const IDLE_MS = 30 * 60 * 1000;
// The caps of each document kind's own pool ('ask', and one per registered kind).
const NONCE = { ttlMs: 2 * 60 * 60 * 1000, max: 64, perKey: 8 };
const VIEW_WAIT_MAX = 20_000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";
const REMOTE_HINT = 'answering prompts remotely needs full mirror access — on the host: claude-web-chat tunnel mirror on (without --read-only); or answer on the host, in its browser or its terminal';

const LAYOUTS = new Set(['bar', 'card', 'sheet', 'page']);
const MODES = new Set(['light', 'dark']);
const DEVICES = new Set(['desktop', 'mobile']);
const ASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A module or stylesheet of publicDir, served by name, so a later layout is a
// new file rather than an edit here.
const ASSET_RE = /^\/answer\/([a-z0-9][a-z0-9-]{0,40})\.(js|css)$/;
const FONT_RE = /^[A-Za-z0-9._-]+\.woff2$/;
const KIND_RE = /^[a-z][a-z-]{1,23}$/;
// The kinds' URL space shares /answer/ with these.
const RESERVED_KINDS = new Set(['ask', 'asks', 'api', 'fonts']);
const META_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
// The only headers a document's caller may add (COOP for a popup layout).
const DOC_HEADERS = new Set(['cross-origin-opener-policy']);
const PLACEHOLDER_RE = /\{\{(NONCE|MODE|KIND|META)\}\}/g;

function createAnswerSurface({
  asks,
  mainPort,
  audience = null,
  root = null,
  publicDir = path.join(__dirname, 'public'),
  fontsDir = path.join(__dirname, '..', '..', '..', 'public', 'fonts'),
  idleMs = IDLE_MS,
  now = Date.now, // accepted from the wiring; nothing here reads a clock yet
  log = () => {},
} = {}) {
  if (!asks || typeof asks.decide !== 'function') throw new TypeError('createAnswerSurface needs asks');
  const kinds = new Map(); // kind → spec
  const polls = new Set(); // waiting long-polls, ended by close()

  // Remote answering rides the mirror opt-in at `full` (Q3, ride): no
  // separate switch, and `--read-only` is watch-only.
  const remoteAnswering = () => {
    try { return !!audience && typeof audience.remoteLevel === 'function' && audience.remoteLevel() === 'full'; } catch { return false; }
  };

  function mainPortNow() {
    let p = null;
    try { p = typeof mainPort === 'function' ? mainPort() : mainPort; } catch { p = null; }
    return Number.isSafeInteger(p) && p > 0 && p < 65536 ? p : null;
  }

  const isRemote = (req) => req.headers[REMOTE_HEADER] != null;
  const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 200) || null;

  function noteAskRefusal(req, id, code, device = null) {
    if (typeof asks.noteRefusal !== 'function') return;
    try {
      asks.noteRefusal(id, { reason: code, origin: isRemote(req) ? 'remote' : 'local', device, ua: uaOf(req) });
    } catch (e) { log(`answer surface: noteRefusal failed: ${e && e.message}`); }
  }
  function noteKindRefusal(spec, req, code, info) {
    if (!spec || typeof spec.onRefused !== 'function') return;
    try {
      spec.onRefused({ code, method: req.method, rest: info.rest, query: info.query, remote: isRemote(req), ua: uaOf(req) });
    } catch (e) { log(`answer surface: onRefused failed: ${e && e.message}`); }
  }

  // ── the routes, as data the gate and the handler share ────────────────────
  function parse(req) {
    let url;
    try { url = new URL(req.url, 'http://answer.invalid'); } catch { return null; }
    const query = Object.fromEntries(url.searchParams);
    return { pathname: url.pathname, query };
  }
  function decodeRest(s) {
    try { return decodeURIComponent(s); } catch { return null; }
  }
  // An /answer/api/* path → { kind: 'ask', id, action } | { kind, spec, rest } | null.
  function apiRoute(pathname) {
    let m = /^\/answer\/api\/asks\/([^/]+)(\/decide)?$/.exec(pathname);
    if (m) {
      const id = decodeRest(m[1]);
      return id && ASK_ID_RE.test(id) ? { kind: 'ask', id, action: m[2] ? 'decide' : 'view' } : null;
    }
    m = /^\/answer\/api\/([a-z][a-z-]{1,23})(?:\/(.*))?$/.exec(pathname);
    if (m && kinds.has(m[1])) {
      const rest = decodeRest(m[2] || '');
      return rest == null ? null : { kind: m[1], spec: kinds.get(m[1]), rest };
    }
    return null;
  }

  // The gate's header half: Origin (required for a POST, else only checked
  // when sent), Sec-Fetch-Site and Content-Type. → a code, or null.
  function headerRefusal(req, kit) {
    const h = req.headers;
    if (req.method === 'POST') {
      // The engine's call gate; with no nonce checked yet it answers 'nonce'
      // once the origin, the fetch metadata and the type are right.
      const r = kit.refusal(req, { key: '', header: null });
      return r && r.code !== 'nonce' ? r.code : null;
    }
    if (h.origin != null && h.origin !== surface.origin) return 'origin';
    const site = h['sec-fetch-site'];
    if (site != null && site !== 'same-origin') return 'site';
    return null;
  }
  const nonceOk = (req, kit, key) => typeof key === 'string' && key !== '' && kit.checkNonce(req.headers[ANSWER_HEADER], key);

  function refuse(kit, res, code) {
    return kit.json(res, 403, { ok: false, refused: code });
  }

  // ── documents ─────────────────────────────────────────────────────────────
  function metaTags(meta) {
    if (meta == null) return '';
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new TypeError('document meta must be an object');
    const tags = [];
    for (const [name, value] of Object.entries(meta)) {
      if (!META_NAME_RE.test(name)) throw new TypeError(`bad document meta name: ${name}`);
      tags.push(`<meta name="${escapeHtml(name)}" content="${escapeHtml(value == null ? '' : String(value))}">`);
    }
    return tags.join('\n');
  }
  // Serve index.html with a nonce minted for `key`. Read from disk each time,
  // so an edit to the page is a frame refresh away.
  function serveDocument(kit, res, { key, mode, kind, meta, headers } = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('a document needs a nonce key');
    const k = kind === 'ask' || (typeof kind === 'string' && KIND_RE.test(kind)) ? kind : null;
    if (!k) throw new TypeError(`bad document kind: ${kind}`);
    const values = {
      NONCE: kit.issueNonce(key, { pool: k }),
      MODE: MODES.has(mode) ? mode : 'light',
      KIND: k,
      META: metaTags(meta),
    };
    return sendPage(kit, res, values, headers);
  }
  function sendPage(kit, res, values, headers) {
    let html;
    try { html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'); } catch { html = null; }
    if (html == null) return kit.json(res, 404, { ok: false, error: 'not found' });
    // One pass: a substituted value is never scanned for another placeholder.
    const body = html.replace(PLACEHOLDER_RE, (_, name) => values[name]);
    const extra = {};
    for (const [h, v] of Object.entries(headers || {})) if (DOC_HEADERS.has(h.toLowerCase())) extra[h.toLowerCase()] = v;
    return kit.send(res, 200, { ...extra, 'content-type': 'text/html; charset=utf-8' }, body);
  }

  // The kit a kind's handlers get: the engine's, plus document() (its kind by
  // default) and info(). One per kind, built once.
  const kindKits = new Map();
  function kitFor(kit, kind) {
    let k = kindKits.get(kind);
    if (!k) {
      k = Object.freeze({
        ...kit,
        issueNonce: (key) => kit.issueNonce(key, { pool: kind }),
        document: (res, opts = {}) => serveDocument(kit, res, { kind, ...opts }),
        info,
      });
      kindKits.set(kind, k);
    }
    return k;
  }

  // ── long-polls ────────────────────────────────────────────────────────────
  // Answer `promise`'s value with `respond`, unless the client goes away first
  // (nothing is written) or close() lands (503).
  function longPoll(kit, res, promise, respond) {
    return new Promise((resolve) => {
      let done = false;
      const entry = {};
      const finish = (write) => {
        if (done) return;
        done = true;
        polls.delete(entry);
        res.off('close', gone);
        try { write(); } catch {}
        resolve();
      };
      const gone = () => finish(() => {});
      entry.end = () => finish(() => { if (!res.headersSent) kit.json(res, 503, { ok: false, error: 'closed' }); });
      polls.add(entry);
      res.on('close', gone);
      Promise.resolve(promise).then(
        (v) => finish(() => respond(v)),
        () => finish(() => kit.json(res, 500, { ok: false, error: 'answer failed' })),
      );
    });
  }

  // ── the asks' API ─────────────────────────────────────────────────────────
  async function askApi(req, res, kit, route, query) {
    const key = `ask:${route.id}`;
    const remote = isRemote(req);
    const device = DEVICES.has(query.device) ? query.device : null;
    if (route.action === 'view') {
      if (req.method !== 'GET') return kit.json(res, 405, { ok: false, error: 'method not allowed' });
      const code = headerRefusal(req, kit) || (nonceOk(req, kit, key) ? null : 'nonce');
      if (code) return refuse(kit, res, code);
      const v = query.v != null && /^\d{1,15}$/.test(query.v) ? Number(query.v) : null;
      const wait = Math.max(0, Math.min(VIEW_WAIT_MAX, Math.floor(Number(query.wait) || 0)));
      return longPoll(kit, res, asks.waitView(route.id, v, wait, { remote }), (view) => {
        if (!view) return kit.json(res, 404, { ok: false, error: 'unknown ask' });
        return kit.json(res, 200, view);
      });
    }
    if (req.method !== 'POST') return kit.json(res, 405, { ok: false, error: 'method not allowed' });
    const r = kit.refusal(req, { key, header: ANSWER_HEADER });
    if (r) {
      noteAskRefusal(req, route.id, r.code, device);
      return refuse(kit, res, r.code);
    }
    let body;
    try { body = await kit.readBody(req); } catch (e) {
      return kit.json(res, e && e.status === 413 ? 413 : 400, { ok: false, error: e && e.status === 413 ? 'request too large' : 'the body is not JSON' });
    }
    const bodyDevice = DEVICES.has(body.device) ? body.device : device;
    const out = asks.decide(route.id, body.decision, {
      via: 'web', remote, device: bodyDevice, ua: uaOf(req), version: body.version,
    }) || { ok: false, status: 409 };
    if (out.ok) return kit.json(res, 200, { ok: true, state: out.state, outcome: out.outcome, version: out.version });
    const { status, ok: _ok, ...rest } = out;
    const code = [400, 403, 404, 409].includes(status) ? status : 409;
    // The domain's own refusal of a remote decide ('remote-off': an
    // elicitation, or no remote answering) writes no audit line; note it as
    // the engine's refusals are noted.
    if (code === 403) noteAskRefusal(req, route.id, typeof out.why_not === 'string' ? out.why_not : 'refused', bodyDevice);
    return kit.json(res, code, { ok: false, ...rest });
  }

  // ── a kind's API ──────────────────────────────────────────────────────────
  async function kindApi(req, res, kit, route, query) {
    const { spec, rest } = route;
    if (req.method !== 'GET' && req.method !== 'POST') return kit.json(res, 405, { ok: false, error: 'method not allowed' });
    const info = { rest, query };
    const pre = headerRefusal(req, kit);
    if (pre) { noteKindRefusal(spec, req, pre, info); return refuse(kit, res, pre); }
    let body = null;
    if (req.method === 'POST') {
      try { body = await kit.readBody(req); } catch (e) {
        return kit.json(res, e && e.status === 413 ? 413 : 400, { ok: false, error: e && e.status === 413 ? 'request too large' : 'the body is not JSON' });
      }
    }
    let key = null;
    try { key = spec.nonceKey(req, { rest, query, body }); } catch { key = null; }
    if (!nonceOk(req, kit, key)) { noteKindRefusal(spec, req, 'nonce', info); return refuse(kit, res, 'nonce'); }
    return spec.api(req, res, kitFor(kit, route.kind), { rest, query, body });
  }

  // ── static ────────────────────────────────────────────────────────────────
  // The one @font-face list, as the frame loads it: every face of
  // public/fonts/fonts.css with its src moved from /fonts/ (the chrome's
  // origin, which a frame never loads from) to this origin's /answer/fonts/.
  // A face whose file this route could not serve (not one bundled .woff2) is
  // dropped rather than left pointing elsewhere, as inlineFontCss drops one.
  let fontCss = null;
  function frameFontCss() {
    if (fontCss != null) return fontCss;
    const out = [];
    for (const face of fontFaces(path.dirname(fontsDir))) {
      if (!face.files.length || !face.files.every((f) => FONT_RE.test(f))) continue;
      const css = face.css.replace(SRC_RE, (_, q, file) => `url(${q}/answer/fonts/${file}${q})`);
      if (/url\(\s*(?!['"]?\/answer\/fonts\/)/.test(css)) continue;
      out.push(css);
    }
    fontCss = out.length ? `${out.join('\n')}\n` : '';
    return fontCss;
  }

  function serveFont(kit, res, name) {
    let bytes = null;
    if (FONT_RE.test(name) && name !== '.woff2') {
      try { bytes = fs.readFileSync(path.join(fontsDir, name)); } catch { bytes = null; }
    }
    if (!bytes) return kit.json(res, 404, { ok: false, error: 'not found' });
    return kit.send(res, 200, { 'content-type': 'font/woff2' }, bytes);
  }

  // ── the handler ───────────────────────────────────────────────────────────
  async function handle(req, res, kit) {
    const u = parse(req);
    if (!u) return kit.json(res, 400, { ok: false, error: 'bad url' });
    const { pathname, query } = u;

    if (pathname.startsWith('/answer/api/')) {
      const route = apiRoute(pathname);
      if (!route) return kit.json(res, 404, { ok: false, error: 'not found' });
      if (route.kind === 'ask') return askApi(req, res, kit, route, query);
      return kindApi(req, res, kit, route, query);
    }

    if (req.method !== 'GET') return kit.json(res, 405, { ok: false, error: 'method not allowed' });

    const doc = documentRoute(req);
    if (doc && doc.kind === 'ask') {
      const layout = query.layout == null ? 'card' : query.layout;
      if (!LAYOUTS.has(layout)) return kit.json(res, 400, { ok: false, error: 'layout must be bar, card, sheet or page' });
      const { id } = doc;
      const mode = MODES.has(query.mode) ? query.mode : 'light';
      const headers = layout === 'page' ? { 'cross-origin-opener-policy': 'same-origin' } : {};
      // An unknown id still gets the page, which says the prompt is no longer
      // waiting; a malformed one gets no nonce (its API route does not exist).
      if (id && ASK_ID_RE.test(id)) return serveDocument(kit, res, { key: `ask:${id}`, mode, kind: 'ask', headers });
      return sendPage(kit, res, { NONCE: '', MODE: mode, KIND: 'ask', META: '' }, headers);
    }
    if (pathname === '/answer/palette.css') {
      let css;
      try { css = renderPalette({ root }); } catch (e) {
        log(`answer surface: palette failed: ${e && e.message}`);
        css = renderPalette({});
      }
      return kit.send(res, 200, { 'content-type': 'text/css; charset=utf-8' }, css);
    }
    if (pathname === '/answer/fonts.css') {
      return kit.send(res, 200, { 'content-type': 'text/css; charset=utf-8' }, frameFontCss());
    }
    let m = ASSET_RE.exec(pathname);
    if (m) return kit.serveAsset(res, `${m[1]}.${m[2]}`, m[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    m = /^\/answer\/fonts\/([^/]+)$/.exec(pathname);
    if (m) return serveFont(kit, res, decodeRest(m[1]) || '');
    if (doc) {
      if (doc.rest == null) return kit.json(res, 400, { ok: false, error: 'bad path' });
      return doc.spec.document(req, res, kitFor(kit, doc.kind), { rest: doc.rest, query });
    }
    return kit.json(res, 404, { ok: false, error: 'not found' });
  }

  // ── the engine ────────────────────────────────────────────────────────────
  function keepAlive() {
    let pending = 0;
    try { pending = asks.pending().length; } catch { pending = 0; }
    if (pending > 0) return true;
    for (const spec of kinds.values()) {
      if (typeof spec.keepAlive !== 'function') continue;
      try { if (spec.keepAlive() === true) return true; } catch {}
    }
    return false;
  }

  function allowRemote(req) {
    let ok = false;
    try { ok = remoteAnswering() === true && !!audience && audience.levelOf(req) === 'full'; } catch { ok = false; }
    if (!ok) noteEngineRefusal(req, 'remote');
    return ok;
  }

  // The requests that load a frame document, for the engine's Sec-Fetch-Dest
  // gate: a GET of an ask's document or of a registered kind's. → the route,
  // or null.
  function documentRoute(req) {
    if (req.method !== 'GET') return null;
    const u = parse(req);
    if (!u) return null;
    let m = /^\/answer\/ask\/([^/]+)$/.exec(u.pathname);
    if (m) return { kind: 'ask', id: decodeRest(m[1]), query: u.query };
    m = /^\/answer\/([a-z][a-z-]{1,23})(?:\/(.*))?$/.exec(u.pathname);
    if (m && !RESERVED_KINDS.has(m[1]) && kinds.has(m[1])) {
      return { kind: m[1], spec: kinds.get(m[1]), rest: decodeRest(m[2] || ''), query: u.query };
    }
    return null;
  }

  // A refusal the engine answers itself (remote, a bad Host, a preflight, a
  // document's Sec-Fetch-Dest): note it where a refused decide or a kind's
  // call is noted.
  function noteEngineRefusal(req, code) {
    if (code === 'dest') {
      const doc = documentRoute(req);
      if (doc && doc.kind === 'ask') {
        if (doc.id && ASK_ID_RE.test(doc.id)) noteAskRefusal(req, doc.id, code, DEVICES.has(doc.query.device) ? doc.query.device : null);
      } else if (doc) {
        noteKindRefusal(doc.spec, req, code, { rest: doc.rest, query: doc.query });
      }
      return;
    }
    const u = parse(req);
    const route = u && u.pathname.startsWith('/answer/api/') ? apiRoute(u.pathname) : null;
    if (route && route.kind === 'ask' && route.action === 'decide') {
      noteAskRefusal(req, route.id, code, DEVICES.has(u.query.device) ? u.query.device : null);
    } else if (route && route.spec) {
      noteKindRefusal(route.spec, req, code, { rest: route.rest, query: u.query });
    }
  }

  const engine = createIsolatedOrigin({
    name: 'answer',
    idleMs,
    keepAlive,
    csp: CSP,
    frameAncestors: () => {
      const p = mainPortNow();
      return p ? [`http://localhost:${p}`, `http://127.0.0.1:${p}`] : [];
    },
    nonce: NONCE,
    allowRemote,
    onRefused: noteEngineRefusal,
    documents: (req) => documentRoute(req) != null,
    remoteHint: REMOTE_HINT,
    publicDir,
    handle,
  });

  function info() {
    return engine.port != null ? { port: engine.port } : null;
  }

  async function close() {
    for (const p of [...polls]) p.end();
    await engine.close();
  }

  function register(kind, spec) {
    if (typeof kind !== 'string' || !KIND_RE.test(kind) || RESERVED_KINDS.has(kind)) {
      throw new TypeError(`answer surface: bad kind ${JSON.stringify(kind)}`);
    }
    if (kinds.has(kind)) throw new Error(`answer surface: kind '${kind}' is already registered`);
    const s = spec || {};
    for (const fn of ['document', 'api', 'nonceKey']) {
      if (typeof s[fn] !== 'function') throw new TypeError(`answer surface: kind '${kind}' needs ${fn}()`);
    }
    for (const fn of ['keepAlive', 'onRefused']) {
      if (s[fn] != null && typeof s[fn] !== 'function') throw new TypeError(`answer surface: kind '${kind}': ${fn} must be a function`);
    }
    const entry = Object.freeze({
      document: s.document, api: s.api, nonceKey: s.nonceKey,
      keepAlive: s.keepAlive || null, onRefused: s.onRefused || null,
    });
    kinds.set(kind, entry);
    return function unregister() {
      if (kinds.get(kind) === entry) kinds.delete(kind);
    };
  }

  const surface = {
    ensure: () => engine.ensure(),
    close,
    get port() { return engine.port; },
    get origin() { return engine.origin; },
    info,
    register,
    remoteAnswering,
  };
  return surface;
}

module.exports = { createAnswerSurface, ANSWER_HEADER, CSP };
