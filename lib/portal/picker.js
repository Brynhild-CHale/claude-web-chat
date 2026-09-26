// The session picker, served at the portal's apex hostname (wc.example.com),
// and the friendly page a dead or unknown session answers with.
//
// The picker lists the web-chat surfaces running on this machine right now:
// the registry's live instances, each probed through lib/client's short,
// never-spawning /api/health — so a listing never starts or resurrects a
// daemon, and one that is not answering shows as such instead of stalling the
// page. What it shows about each: the project's directory NAME (its basename),
// the instance id, when it started, how many browsers are watching, and when a
// Claude Code session last called in. The full path is shown only when the
// operator opted in (`showRoots`) — a remote screen is not the place to leak a
// home-directory layout by default.
//
// The page is static (lib/portal/public/) under a strict CSP: no inline script,
// no inline style, nothing off-origin. It fetches its list from /api/sessions
// and builds the DOM with createElement/textContent, never innerHTML, because a
// project title is a directory name and a directory name can be anything.

const fs = require('fs');
const path = require('path');
const client = require('../client');
const { escapeHtml } = require('../core/html');
const { sessionHost, publicOrigin } = require('./config');

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

async function listSessions({ config, instances, probe = client.probeHealth }) {
  return Promise.all(instances.map(async (e) => {
    let health = null;
    try { health = await probe(e.port, PROBE_TIMEOUT_MS); } catch {}
    const live = !!(health && health.role === 'instance');
    const row = {
      id: e.id,
      title: path.basename(String(e.root || e.title || e.id)),
      url: `${publicOrigin(sessionHost(config, e.id))}/`,
      started_at: e.started_at || null,
      reachable: live,
      viewers: live && Number.isFinite(health.viewers) ? health.viewers : null,
      claude_seen_at: live && health.mcp_seen && Number.isFinite(health.mcp_seen.seen_at) ? health.mcp_seen.seen_at : null,
    };
    if (config.showRoots) row.root = e.root || null;
    return row;
  }));
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// Serve the apex. `instances()` is the registry read; `common` the security
// headers every portal response carries.
async function servePicker(req, res, { config, instances, common, probe, email }) {
  const pathname = req.url.split(/[?#]/)[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { ...common, 'content-type': 'application/json', allow: 'GET, HEAD' },
      JSON.stringify({ ok: false, error: 'the picker is read-only' }));
  }
  if (pathname === '/api/sessions') {
    const sessions = await listSessions({ config, instances: instances(), probe });
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
