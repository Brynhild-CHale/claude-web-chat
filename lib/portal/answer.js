// The portal's ANSWER path (spec §4.6): a session's answer frames, served on a
// sibling hostname of the session's own (`<session>-a`, lib/tunnel/config
// answerHost) and proxied to that daemon's answer surface — its own loopback
// origin (lib/server/answer-surface), never its main port.
//
// Why a separate hostname. On the host the answer frames live on an origin of
// their own (127.0.0.1:<ephemeral>), because pane scripts run in the chrome's
// realm with fetch to every route, and an endpoint that approves a permission
// runs host commands. Remotely the same line has to hold: the session host is
// the chrome's origin, so the frames get another — a sibling under the same
// wildcard DNS record and Access destination (no new setup), framed by the
// session's page and never scriptable by it.
//
// What the gate in index.js does for the answer host, in order: the Access JWT
// as for a session; the session running and visible (else a JSON 404, the same
// for hidden and stopped — never the picker's page inside a frame); the
// project's mirror level and ANSWER_RULES (lib/core/remote-policy: default
// deny, every allow row needs `full`); answerCsrfRefusal below; the daemon's
// identity, as for a session; then proxyAnswer. No WebSocket, no picker, and no
// /api/* route — the mod's bridge included — is reachable here.
//
// THE PORT. The answer surface listens on an ephemeral port, started on demand
// and closed when idle. The portal asks for it as a LOCAL caller (lib/client:
// no Origin, no Sec-Fetch-*, no X-WC-Remote) with `GET /api/asks?ensure=1`,
// which starts an idle-closed surface and answers its port (ruled E2 (a)): a
// phone's Stop or answer works with no desktop browser open. /api/health alone
// never starts it, and since 0.8.5 reports the port to local callers only.
// Memoised for a second per id:port:pid; a GET whose connection is refused
// (the surface just closed) forgets it and is retried once on the port asked
// anew. A write is never replayed.
//
// Imports lib/client only (spec §10.2 allows lib/client, lib/tunnel/config and
// lib/core); the proxy itself is handed in by index.js.

const client = require('../client');

const PORT_MEMO_MS = 1000;
const PORT_TIMEOUT_MS = 3000;
const UNAVAILABLE = 'the answer frames are not available on the host right now — answer in the terminal';

const DOCUMENT_PATH = /^\/answer\/(?:ask\/[^/]+|control\/[^/]+)$/i;
const DOCUMENT_DESTS = new Set(['iframe', 'document']);

function pathOf(url) {
  const s = String(url || '/');
  const q = s.search(/[?#]/);
  return q === -1 ? s : s.slice(0, q);
}

// A browser opening an answer document: a navigation GET (the frame's load,
// the popup, a reload) of an ask's or a control action's document.
function isDocumentNavigation(req) {
  const h = req.headers || {};
  return (req.method === 'GET' || req.method === 'HEAD')
    && h['sec-fetch-mode'] === 'navigate'
    && DOCUMENT_DESTS.has(h['sec-fetch-dest'])
    && DOCUMENT_PATH.test(pathOf(req.url));
}

const refusal = (error) => ({ status: 403, body: { ok: false, remote: true, error } });

// The answer host's CSRF rule. Returns null when the request may proceed, else
// a refusal { status, body }.
//   * an Origin, when present, must be the answer host's public origin;
//   * a non-GET/HEAD must carry one;
//   * Sec-Fetch-Site cross-site is refused;
//   * same-site — the session host framing the document, or opening it in a
//     popup — is allowed only on a navigation GET of a document path; and
//     `none` (a user's own navigation: a reload of the popup) the same;
//   * everything else must be same-origin: the document's own script calling
//     its view, its decide or its action.
function answerCsrfRefusal(req, answerOrigin) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin != null && origin !== answerOrigin) return refusal('cross-origin request refused');
  const safe = req.method === 'GET' || req.method === 'HEAD';
  if (!safe && origin == null) return refusal('an answer must come from the answer frame\'s own page');
  const site = h['sec-fetch-site'];
  if (site == null || site === 'same-origin') return null;
  if ((site === 'same-site' || site === 'none') && isDocumentNavigation(req)) return null;
  return refusal(`${site} request refused`);
}

// The answer surface's port per session, as a local caller asks for it.
//   createAnswerPorts({ client, memoMs, timeoutMs })
//     → { portOf(session) → Promise<port | null>, forget(session) }
function createAnswerPorts({ client: c = client, memoMs = PORT_MEMO_MS, timeoutMs = PORT_TIMEOUT_MS } = {}) {
  const memo = new Map(); // id:port:pid → { at, answer: Promise<port|null> }
  const keyOf = (s) => `${s.id}:${s.port}:${s.pid}`;

  function ask(session) {
    return c.get('/api/asks?ensure=1', { port: session.port, noSpawn: true, timeout: timeoutMs }).then(
      (body) => {
        const p = body && body.answer && body.answer.port;
        return Number.isSafeInteger(p) && p > 0 && p < 65536 ? p : null;
      },
      () => null,
    );
  }

  function portOf(session) {
    if (!session || !Number.isInteger(session.port)) return Promise.resolve(null);
    const key = keyOf(session);
    const at = Date.now();
    for (const [k, v] of memo) if (at - v.at >= memoMs) memo.delete(k);
    const hit = memo.get(key);
    if (hit) return hit.answer;
    const entry = { at, answer: ask(session) };
    memo.set(key, entry);
    // No port is never kept: the next request asks again.
    entry.answer.then((p) => { if (p == null && memo.get(key) === entry) memo.delete(key); });
    return entry.answer;
  }

  function forget(session) {
    if (session) memo.delete(keyOf(session));
  }

  return { portOf, forget };
}

// One answer-host request, proxied to the session's answer surface.
//   proxyAnswer(req, res, { session, sessionHost, ports, proxy })
// `proxy` is lib/portal/proxy's proxyHttp (handed in by index.js), run in its
// answer mode.
async function proxyAnswer(req, res, { session, sessionHost, ports, proxy }) {
  const port = await ports.portOf(session);
  if (!port) {
    res.writeHead(503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify({ ok: false, remote: true, error: UNAVAILABLE }));
    return;
  }
  await proxy(req, res, {
    port,
    origin: req.headers.origin != null,
    mode: 'answer',
    sessionHost,
    onUpstreamError: () => ports.forget(session),
    retry: async () => {
      ports.forget(session);
      return ports.portOf(session);
    },
  });
}

module.exports = {
  answerCsrfRefusal, createAnswerPorts, proxyAnswer, isDocumentNavigation, UNAVAILABLE, PORT_MEMO_MS,
};
