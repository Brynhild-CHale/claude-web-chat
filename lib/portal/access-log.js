// The remote access log — ~/.web-chat/tunnel/remote-access.log.
//
// One JSON line per remote request that could CHANGE something: every write
// (anything but GET/HEAD) and every live-socket upgrade that got past the
// sign-in check, whether the portal let it through or refused it:
//
//   {"ts":"…","email":"me@example.com","instance":"0a1b2c3d","method":"POST","path":"/api/store","status":200}
//
// Reads are not logged: a page load is dozens of asset requests and would bury
// the lines worth reading. The PATH is logged without its query string — the
// query of a write is the page's business, and what the route was is enough to
// answer "what did that account do here?".
//
// Size-capped: when the file would pass `maxBytes` it is renamed to `.1`
// (replacing the previous one) and a new file starts, so the log never holds
// more than about twice the cap. 0600 — it names who signed in and when.
//
// Never throws. A log that cannot be written must not fail the request it
// describes; the first failure is reported through `onError` once.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1024 * 1024;

function createAccessLog({ file, maxBytes = DEFAULT_MAX_BYTES, now = Date.now, onError = () => {} } = {}) {
  let warned = false;

  function record({ email, instance, method, path: reqPath, status }) {
    if (!file) return;
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      email: email || null,
      instance: instance || null,
      method: String(method || ''),
      path: String(reqPath || '').split(/[?#]/)[0].slice(0, 512),
      status: Number.isInteger(status) ? status : null,
    }) + '\n';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (e) {
      if (!warned) { warned = true; onError(e); }
    }
  }

  return { record, file };
}

// Is this a request the log records? `upgrade` for the socket handshake.
function isLoggedRequest(method, { upgrade = false } = {}) {
  return upgrade || (method !== 'GET' && method !== 'HEAD');
}

module.exports = { createAccessLog, isLoggedRequest, DEFAULT_MAX_BYTES };
