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
// and closed when idle; the portal asks for it as a LOCAL caller through
// lib/relay's createAnswerPorts (lib/relay/answer-ports.js, re-exported here),
// memoised for a second per id:port:pid. A GET whose connection is refused
// (the surface just closed) forgets it and is retried once on the port asked
// anew. A write is never replayed.
//
// Imports lib/relay only (spec §10.2 allows lib/client, lib/tunnel/config and
// lib/core; lib/relay is the shared layer the portal's relay code moved to);
// the proxy itself is handed in by index.js.

const { createAnswerPorts, PORT_MEMO_MS } = require('../relay');
const UNAVAILABLE = 'the answer frames are not available on the host right now — answer in the terminal';

const DOCUMENT_PATH = /^\/answer\/(?:ask\/[^/]+|control\/[^/]+|elements\/[^/]+)$/i;
const DOCUMENT_DESTS = new Set(['iframe', 'document']);

function pathOf(url) {
  const s = String(url || '/');
  const q = s.search(/[?#]/);
  return q === -1 ? s : s.slice(0, q);
}

// A browser opening an answer document: a navigation GET (the frame's load,
// the popup, a reload) of an ask's or a control action's document, or of the
// report path's frame (the `elements` kind, U312; its ANSWER_RULES rows ride
// protocol 12).
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

// One answer-host request, proxied to the session's answer surface.
//   proxyAnswer(req, res, { session, sessionHost, ports, proxy })
// `proxy` is lib/relay's proxyHttp (handed in by index.js), run in its
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
