'use strict';
// The report path's REMOTE half (annotation engine PLAN.md 2B.1; DECISIONS.md
// A3 remote-full-stamped, E2; U312): the `elements` answer kind, through which
// a remote viewer at `full` hands the daemon what its resolver answered —
// the same batches a local page sends over its socket (U311's `report`
// message, public/app/overlay-report.js), into the same reports.accept().
//
//   registerRemoteReports({accept, answerSurface, audience, count, now, log})
//     → unregister()        called by reports.js start() / stop() only
//
// WHY AN ANSWER KIND AND NOT A ROUTE (PLAN-T2 §2.3 2B (2)). A remote viewer
// reaches the daemon only through the portal; the session host's table would
// let a POST to /api/elements/* through at full, but any pane script runs in
// the chrome's realm and could call it. The answer surface serves
// /answer/api/<kind>/<rest> only for a registered kind and only with an
// X-WC-Answer nonce minted for a document it served itself, so the caller is
// the framed document (elements-report.js) the chrome hands its batches to.
// There is no main-port route: POST /api/elements/report stays unmounted.
//
//   GET  /answer/elements/report?layout=report&mode=&device=&viewer=
//        the document (answer.js loads ./elements-report.js by kind and
//        layout); its nonce is minted for 'elements:report', or
//        'elements:report:<viewer>' when the chrome names its per-tab viewer
//        id (so one tab's reloads never evict another tab's nonce). Any other
//        rest, or another layout, is 404.
//   POST /answer/api/elements/report  {reports: [{surface, mounts}], device?, viewer?}
//        the batch, at most MAX_REPORTS messages; each goes through
//        accept(msg, {viewer, peer: 'remote', device, transport: 'answer'}),
//        so it is ordered by the same per-surface counter and mount gen as a
//        local report (RULED 2B@replace-key = b: there is no node test) and
//        stamped source {peer: 'remote', device}. → 200 {ok: true, accepted,
//        confirmed, refused: {reason: n}}: counts only, nothing of the held
//        table, never the body back.
//
// THE CHECKS, in order (the engine's gate runs first: Host, the remote lock —
// an X-WC-Remote request passes only while the project is opted in at full
// and the request's own level is full — Origin, Sec-Fetch-*, the JSON type,
// the kit's 64 KB body and the nonce):
//   * a request that is not remote (no X-WC-Remote: the host's own page) is
//     403 'local' — a local page reports over its socket, one path per peer;
//   * the level again, here (the engine's allowRemote is the first lock): below
//     full, 403 'mirror' with ANSWER_HINT;
//   * the body's shape: 400 'shape'.
// Every refusal (the engine's, through onRefused, and these) is counted into
// reports.stats().refused by its code.
//
// THE VIEWER (K.2-56). The held answers are keyed by viewer: 'remote:<id>'
// for the per-tab id the chrome minted (the body's `viewer`, which must be
// the document's own — the nonce key holds it), else 'remote:' + a short hash
// of the request's nonce (one frame load). The ranking rule is reports.js's:
// an equal key from the same viewer replaces, another viewer's never does.
//
// C-15-1: the remote chrome's pane scripts share its realm and can post into
// the frame (P-17: a relay channel can be forged); such a report is bounded
// exactly as a local pane's forged socket report is (U311: the counter, the
// gen, the daemon-stamped qualifier), and no rule here treats pane:<id> or
// user as a boundary. C-15-2: no rule here is enforced on claude, service or
// driver. C-15-3: the source stamp and the viewer key are attribution, not
// authorization.

const crypto = require('crypto');
const { ANSWER_HINT } = require('../../core/remote-policy');

const KIND = 'elements';
const REST = 'report';
const LAYOUT = 'report';
const NONCE_KEY = 'elements:report';
const ANSWER_HEADER = 'x-wc-answer';
const MAX_REPORTS = 8;
const KEEP_ALIVE_MS = 5 * 60 * 1000;
const DEVICES = new Set(['desktop', 'mobile']);
// The chrome's per-tab viewer id (public/app/overlay-report-remote.js
// tabViewerId), as lib/server/ws.js reads it from a local socket's client frame.
const VIEWER_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LOCAL_HINT = 'this route takes a remote viewer\'s reports through the tunnel; a page on this machine reports over its own socket';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const viewerOf = (v) => (typeof v === 'string' && VIEWER_RE.test(v) ? v : null);
const keyFor = (viewer) => (viewer ? `${NONCE_KEY}:${viewer}` : NONCE_KEY);
const deviceOf = (d) => (DEVICES.has(d) ? d : null);
const nonceTag = (n) => crypto.createHash('sha256').update(String(n || '')).digest('hex').slice(0, 12);

function jsonBytes(v) {
  try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Infinity; }
}

function registerRemoteReports({ accept, answerSurface, audience, count = () => {}, now = Date.now, log = () => {} } = {}) {
  if (typeof accept !== 'function') throw new TypeError('registerRemoteReports: accept is required');
  const val = (x) => { try { return typeof x === 'function' ? x() : x; } catch { return null; } };
  const surface = val(answerSurface);
  if (!surface || typeof surface.register !== 'function') {
    log('reports: no answer surface; remote reports are off');
    return () => {};
  }
  let lastReportAt = null;
  const tally = (code) => { try { count(code); } catch {} };

  function document(req, res, kit, { rest, query }) {
    if (rest !== REST || query.layout !== LAYOUT) return kit.json(res, 404, { ok: false, error: 'not found' });
    return kit.document(res, { key: keyFor(viewerOf(query.viewer)), mode: query.mode, meta: {} });
  }

  function nonceKey(req, { rest, body }) {
    if (req.method !== 'POST' || rest !== REST) return null;
    return keyFor(isObj(body) ? viewerOf(body.viewer) : null);
  }

  function refuse(kit, res, status, code, hint) {
    tally(code);
    return kit.json(res, status, hint ? { ok: false, refused: code, hint } : { ok: false, refused: code });
  }

  function api(req, res, kit, { rest, query, body }) {
    if (rest !== REST) return kit.json(res, 404, { ok: false, error: 'not found' });
    if (req.method !== 'POST') return kit.json(res, 405, { ok: false, error: 'method not allowed' });
    const aud = val(audience);
    let peer = null;
    let level = null;
    try { peer = aud.peerOf(req); level = aud.levelOf(req); } catch { peer = null; level = null; }
    if (peer !== 'remote') return refuse(kit, res, 403, 'local', LOCAL_HINT);
    if (level !== 'full') return refuse(kit, res, 403, 'mirror', ANSWER_HINT);
    const list = isObj(body) ? body.reports : null;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REPORTS) return refuse(kit, res, 400, 'shape');
    const device = deviceOf(body.device) || deviceOf(query && query.device);
    const id = viewerOf(body.viewer);
    const viewer = `remote:${id || nonceTag(req.headers[ANSWER_HEADER])}`;
    let accepted = 0;
    let confirmed = 0;
    const refused = {};
    for (const r of list) {
      let out;
      try {
        out = accept(r, { viewer, peer: 'remote', device, transport: 'answer', bytes: jsonBytes(r) });
      } catch (e) {
        log(`reports: a remote report failed (${e && e.message})`);
        out = { ok: false, refused: 'error' };
      }
      if (!out) continue;
      accepted += Number(out.accepted) || 0;
      confirmed += Number(out.confirmed) || 0;
      if (out.ok === false && typeof out.refused === 'string') refused[out.refused] = (refused[out.refused] || 0) + 1;
    }
    lastReportAt = Number(now());
    return kit.json(res, 200, { ok: true, accepted, confirmed, refused });
  }

  function keepAlive() {
    return lastReportAt != null && Number(now()) - lastReportAt < KEEP_ALIVE_MS;
  }

  function onRefused({ code } = {}) {
    if (typeof code === 'string' && code) tally(code);
  }

  let unregister;
  try {
    unregister = surface.register(KIND, { document, api, nonceKey, keepAlive, onRefused });
  } catch (e) {
    log(`reports: could not register the elements answer kind (${e && e.message})`);
    return () => {};
  }
  return function unregisterRemoteReports() {
    try { unregister(); } catch {}
  };
}

module.exports = {
  registerRemoteReports,
  KIND, REST, LAYOUT, NONCE_KEY, MAX_REPORTS, KEEP_ALIVE_MS, VIEWER_RE, LOCAL_HINT,
};
