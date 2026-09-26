// The session picker, served at the portal's apex hostname (wc.example.com),
// and the friendly page a dead or unknown session answers with.
//
// The picker lists the projects live on this machine right now from the ONE
// classifier `claude-web-chat ls` and the chrome's Sessions panel read:
// lib/util/registry sessions() (daemons + Claude Code presence rows, joined by
// project root) then enrichSessions() (each running daemon's short,
// never-spawning /api/health) — so the three can never disagree, a listing
// never starts or resurrects a daemon, and one that is not answering shows as
// such instead of stalling the page. The caller hands in the rows with the
// hidden projects (no-remote marker, expose.exclude) already taken out.
//
// What it shows about each: the project's directory NAME (its basename), the
// instance id, the surface (started when, how many browsers watching, the
// active node, a turn in flight) and the Claude half (connected ×N, channel
// on/off, last tool call). A project with a Claude session but no running
// surface is listed — "Claude attached · surface stopped" — with NO link: the
// portal never spawns a daemon, so there is nothing to open until someone
// runs `claude-web-chat open` on the host. Ports and pids stay off the page;
// the full path is shown only when the operator opted in (`showRoots`) — a
// remote screen is not the place to leak a home-directory layout by default.
//
// The page is static (lib/portal/public/) under a strict CSP: no inline script,
// no inline style, nothing off-origin. It fetches its list from /api/sessions
// and builds the DOM with createElement/textContent, never innerHTML, because a
// project title is a directory name and a directory name can be anything.

const fs = require('fs');
const path = require('path');
const { enrichSessions, instanceId } = require('../util/registry');
const { escapeHtml } = require('../core/html');
const { sessionHost, publicOrigin } = require('../tunnel/config');

const PUBLIC = path.join(__dirname, 'public');
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

const PICKER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PROBE_TIMEOUT_MS = 600;

// `rows` are registry sessions() rows, hidden projects already removed. Each
// comes back as
//   { id, title, url,            url null when no surface is running
//     surface: null | { reachable, started_at, viewers, turn, active_label },
//     claude:  null | { sessions, channel, last_tool_at },
//     root? }                    only with showRoots
// `enrich` is registry enrichSessions (a test hands in its own).
async function listSessions({ config, rows, enrich = enrichSessions }) {
  const enriched = await enrich(rows || [], { timeoutMs: PROBE_TIMEOUT_MS });
  return enriched.map((r) => {
    const id = instanceId(r.root);
    const s = r.surface;
    const up = !!(s && s.reachable);
    const c = r.claude;
    const row = {
      id,
      title: path.basename(String(r.root)),
      url: s ? `${publicOrigin(sessionHost(config, id))}/` : null,
      surface: s ? {
        reachable: up,
        started_at: Number.isFinite(s.started_at) ? s.started_at : null,
        viewers: up && Number.isFinite(s.viewers) ? s.viewers : null,
        turn: up && (s.turn === 'mid-turn' || s.turn === 'wake') ? s.turn : null,
        active_label: up && s.active_label ? String(s.active_label) : null,
      } : null,
      claude: c ? {
        sessions: Number.isFinite(c.sessions) ? c.sessions : 0,
        channel: !!c.channel,
        last_tool_at: Number.isFinite(c.last_tool_at) ? c.last_tool_at : null,
      } : null,
    };
    if (config.showRoots) row.root = r.root;
    return row;
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// Serve the apex. `rows()` is the registry sessions() read with the hidden
// projects removed; `common` the security headers every portal response carries.
async function servePicker(req, res, { config, rows, enrich, common, email }) {
  const pathname = req.url.split(/[?#]/)[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { ...common, 'content-type': 'application/json', allow: 'GET, HEAD' },
      JSON.stringify({ ok: false, error: 'the picker is read-only' }));
  }
  if (pathname === '/api/sessions') {
    const sessions = await listSessions({ config, rows: rows(), enrich });
    return send(res, 200, { ...common, 'content-type': 'application/json', 'cache-control': 'no-store' },
      req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, email, sessions }));
  }
  const asset = ASSETS[pathname];
  if (!asset) {
    return send(res, 404, { ...common, 'content-type': 'text/plain; charset=utf-8' }, 'not found');
  }
  let body;
  try { body = fs.readFileSync(path.join(PUBLIC, asset[0])); } catch {
    return send(res, 500, { ...common, 'content-type': 'text/plain; charset=utf-8' }, 'picker asset missing');
  }
  return send(res, 200, {
    ...common,
    'content-type': asset[1],
    'content-security-policy': PICKER_CSP,
    'cache-control': 'no-store',
  }, req.method === 'HEAD' ? undefined : body);
}

// A session hostname that names no running surface. JSON for an API call (the
// SPA's fetches), a small page linking back to the picker for anything else.
function sessionNotFound(req, res, { config, common, id }) {
  const pickerUrl = `${publicOrigin(config.hostname)}/`;
  const pathname = req.url.split(/[?#]/)[0];
  if (/^\/api(\/|$)/i.test(pathname) || pathname === '/ws') {
    return send(res, 404, { ...common, 'content-type': 'application/json', 'cache-control': 'no-store' },
      JSON.stringify({ ok: false, remote: true, error: 'no web-chat session is running under this name', picker: pickerUrl }));
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Session not running</title></head><body>'
    + '<h1>This session is not running</h1>'
    + `<p>No web-chat surface with id <code>${escapeHtml(id)}</code> is running on this machine right now. `
    + 'It may have stopped (a surface with no viewers exits after a few seconds), or the link is old.</p>'
    + `<p><a href="${escapeHtml(pickerUrl)}">See the sessions that are running</a></p>`
    + '</body></html>';
  return send(res, 404, {
    ...common,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'cache-control': 'no-store',
  }, html);
}

module.exports = { servePicker, sessionNotFound, listSessions, PICKER_CSP };
