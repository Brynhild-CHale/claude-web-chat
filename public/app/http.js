// The chrome's one HTTP reader (annotation engine 2A.5): every request the
// chrome makes to the daemon is answered in ONE shape, and the daemon's refusal
// grammar — ok:false, a `refused` reason, a `hint` — reaches the caller the
// same way whichever route refused.
//
//   request(method, path, {body, headers, signal, device}) →
//     Promise<{ ok, status, body, refused, hint }>
//
// It never throws and never rejects. `body` is the parsed JSON answer, or null
// when the answer was not JSON (a 204, an HTML error page). `ok` is a 2xx whose
// JSON body does not say ok:false, so a GET of plain data is ok. A refusal is
// one of four shapes:
//
//   (a) the fetch rejected (the daemon is gone, the socket dropped), or the
//       body read failed with anything but a parse error →
//       status 0 (the answer's own once its headers had arrived), refused
//       'network' — or 'aborted' when the caller's `signal` aborted it;
//   (b) a non-2xx whose body is not JSON → refused 'network', with its status;
//   (c) a JSON refusal naming a string `refused` → that reason;
//   (d) a JSON non-ok naming none → 'forbidden' for a 403 (a remote viewer
//       below the level), else the body's `code`, else 'error'.
//
// In (c) and (d) the hint is the body's `hint`, else its `error`, else
// NETWORK_HINT, so a caller always has a sentence to show.
//
// THE DEVICE CLAIM. `device: true` puts `device: deviceKind()` into an object
// body that has none — the one place the chrome adds it. The daemon reads the
// claim from the JSON body (lib/server/routes/elements.js, the element API;
// lib/server/domain/queue.js provenance), never from a header, and it is attribution only
// (C-15-3): nothing grants or refuses on it, so it is never sent as a header
// and never on a GET. An explicit body.device is kept.
//
// Pane identity is not this module's: a pane's own requests are stamped by
// public/mount-runtime.js paneFetch, the one home of that header.
//
// test/conventions.test.js counts the bare fetch call per public/app file and
// this module is its home: a new chrome request comes through here, not
// through a new baseline entry.
import { deviceKind } from './viewport.js';

export const NETWORK_HINT = 'The daemon did not answer — check that web-chat is running, then try again.';
export const ABORTED_HINT = 'The request was cancelled before the daemon answered.';
const BUILD_HINT = 'The request could not be built — reload the page and try again.';

// A body sent as JSON: a plain object or an array. Anything else (a string, a
// Blob, FormData) goes as it is, with no Content-Type of ours.
function isJsonBody(body) {
  if (Array.isArray(body)) return true;
  if (body === null || typeof body !== 'object') return false;
  const proto = Object.getPrototypeOf(body);
  return proto === Object.prototype || proto === null;
}

function refusal(status, body, refused, hint) {
  return { ok: false, status, body, refused, hint };
}

// The answer for a JSON body that is not ok (shapes c and d).
function jsonRefusal(status, body) {
  const obj = body !== null && typeof body === 'object' ? body : {};
  const refused = typeof obj.refused === 'string'
    ? obj.refused
    : (status === 403 ? 'forbidden' : (typeof obj.code === 'string' && obj.code ? obj.code : 'error'));
  return refusal(status, body, refused, obj.hint || obj.error || NETWORK_HINT);
}

export async function request(method, path, opts) {
  const { body, headers, signal, device } = opts && typeof opts === 'object' ? opts : {};
  let init;
  try {
    const verb = String(method || 'GET').toUpperCase();
    const bodyless = verb === 'GET' || verb === 'HEAD';
    init = { method: verb };
    const sendHeaders = {};
    let payload;
    if (!bodyless && body !== undefined && body !== null) {
      if (isJsonBody(body)) {
        let out = body;
        if (device === true && !Array.isArray(body) && body.device === undefined) {
          out = { ...body, device: deviceKind() };
        }
        sendHeaders['Content-Type'] = 'application/json';
        payload = JSON.stringify(out);
      } else {
        payload = body;
      }
    }
    if (headers && typeof headers === 'object') Object.assign(sendHeaders, headers);
    if (Object.keys(sendHeaders).length) init.headers = sendHeaders;
    if (payload !== undefined) init.body = payload;
    if (signal) init.signal = signal;
  } catch {
    // A body JSON cannot carry (a cycle, a BigInt): nothing was sent.
    return refusal(0, null, 'error', BUILD_HINT);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    const aborted = !!(signal && signal.aborted) || (err && err.name === 'AbortError');
    return aborted
      ? refusal(0, null, 'aborted', ABORTED_HINT)
      : refusal(0, null, 'network', NETWORK_HINT);
  }

  const status = res && Number.isFinite(res.status) ? res.status : 0;
  const success = status >= 200 && status < 300;
  let parsed;
  let isJson = false;
  try { parsed = await res.json(); isJson = true; } catch (err) {
    // A body read that throws is not always a body that is not JSON. The
    // caller's signal aborting mid-body is the caller's own cancel, and a
    // stream that dropped (a TypeError in a browser) is an answer that never
    // arrived: neither may read as an ok with no body. Only a parse failure
    // (a SyntaxError: a 204, an HTML page) is "not JSON".
    if ((signal && signal.aborted) || (err && err.name === 'AbortError')) {
      return refusal(status || 0, null, 'aborted', ABORTED_HINT);
    }
    if (!err || err.name !== 'SyntaxError') return refusal(status || 0, null, 'network', NETWORK_HINT);
    parsed = null;
  }
  const out = isJson ? parsed : null;

  if (!isJson) {
    return success
      ? { ok: true, status, body: null, refused: null, hint: null }
      : refusal(status, null, 'network', NETWORK_HINT);
  }
  if (!success || (out !== null && typeof out === 'object' && out.ok === false)) {
    return jsonRefusal(status, out);
  }
  return { ok: true, status, body: out, refused: null, hint: null };
}
