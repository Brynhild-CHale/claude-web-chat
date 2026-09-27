// Starting a stopped project's surface from the picker —
// POST /api/sessions/<id>/start on the portal's APEX hostname.
//
// This reverses P6's "the portal never spawns a daemon", on purpose and
// narrowly (maintainer, 2026-09-26: the picker lists ACTIVE and INACTIVE
// sessions, all clickable). What keeps it narrow:
//
//   * KNOWN ROOTS ONLY, BY ID. The request names an 8-hex instance id and
//     nothing else. The id is looked up in the registry's sessions() rows, and
//     only a row with `known: true` (its daemon has booted on this machine
//     before — ~/.web-chat/projects.json) may be started. No request field is
//     ever read as a path, so there is no path to inject.
//   * NEVER A HIDDEN PROJECT. The same hiddenReason the picker and the session
//     router ask (tunnel.json expose.exclude, the project's .web-chat/no-remote)
//     — a hidden project answers exactly like an unknown one (404), so the
//     picker cannot be used to probe for it.
//   * RATE-LIMITED. One start per id per START_EVERY_MS, counted from the
//     attempt (a start that failed still spent it), so a stuck button or a
//     scripted loop cannot fork-bomb the host.
//   * THE CLI'S OWN SPAWN. lib/util/daemon spawnDaemon — the detached child
//     `open`/`start` and the MCP client's auto-spawn use — and it waits until
//     the daemon answers before the picker is told where to go.
//   * AUDITED. The route sits past the sign-in check and is a POST, so the
//     portal's access log records it (who, which id, the status) like any
//     remote write; the portal's own log names the project it started.
//
// CSRF is the caller's (lib/portal/index.js): the POST must carry the apex's
// exact Origin, the way a session's writes must carry the session's.

const path = require('path');
const { instanceId } = require('../util/registry');
const { hiddenReason, sessionHost, publicOrigin, ID_RE } = require('../tunnel/config');

const START_EVERY_MS = 10_000;
const START_WAIT_MS = 15_000;
// The route, as docs and the doc-truth scan spell it; START_PATH_RE matches it.
const START_ROUTE = '/api/sessions/:id/start';
const START_PATH_RE = /^\/api\/sessions\/([^/]+)\/start\/?$/i;

// The id a start request names, or null when the path is not the start route.
function startTarget(method, pathname) {
  if (method !== 'POST') return null;
  const m = START_PATH_RE.exec(pathname);
  return m ? m[1].toLowerCase() : null;
}

function createStarter({ spawn, now = Date.now, log = () => {}, everyMs = START_EVERY_MS, waitMs = START_WAIT_MS } = {}) {
  const startDaemon = spawn || ((root, opts) => require('../util/daemon').spawnDaemon(root, opts));
  const last = new Map(); // id -> when a start was last attempted

  // → { status, body, headers? }. `rows` is the registry sessions() read;
  // `running(id)` the portal's routing lookup (after a start it must be
  // re-read, so `forget` drops the portal's memo first).
  async function start(id, { config, rows, running, forget = () => {}, email = null }) {
    const notFound = { status: 404, body: { ok: false, error: 'no known project with that id on this machine' } };
    if (!ID_RE.test(String(id || ''))) return notFound;
    let list = [];
    try { list = rows() || []; } catch {}
    const row = list.find((r) => r && r.root && r.known && instanceId(r.root) === id);
    if (!row || hiddenReason(config, { id, root: row.root })) return notFound;
    const url = `${publicOrigin(sessionHost(config, id))}/`;
    const title = path.basename(row.root);
    if (running(id)) return { status: 200, body: { ok: true, id, title, url, started: false } };

    const t = now();
    const prev = last.get(id);
    if (prev != null && t - prev < everyMs) {
      const wait = Math.ceil((everyMs - (t - prev)) / 1000);
      return {
        status: 429,
        headers: { 'retry-after': String(wait) },
        body: { ok: false, error: `${title} was started a moment ago — wait ${wait}s and try again` },
      };
    }
    last.set(id, t);
    log(`starting ${title} (${id}) for ${email || 'unknown account'}`);
    let info = null;
    try { info = await startDaemon(row.root, { maxMs: waitMs }); } catch (e) { log(`start ${id} failed: ${e && e.message}`); }
    forget();
    if (!info || !running(id)) {
      return { status: 504, body: { ok: false, error: `${title} did not come up — start it on the host with \`claude-web-chat open\`` } };
    }
    return { status: 200, body: { ok: true, id, title, url, started: true } };
  }

  return { start };
}

module.exports = { createStarter, startTarget, START_ROUTE, START_EVERY_MS };
