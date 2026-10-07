// Is this page being viewed REMOTELY — through the tunnel portal (lib/portal)?
// And where do its answer frames live?
//
// The portal adds `X-WC-Remote: 1` to every request it forwards and the
// daemon's GET /api/health echoes it as `remote:true`. The answer only changes
// what the page SAYS: a remote viewer cannot install packs or approve services
// (the portal refuses those routes), so the Manage tab and the service-trust
// card point at the host instead of offering a control that would 403. It is
// never an access decision — that is the portal's, server-side.
//
// THE ANSWER ORIGIN (spec §4.5's chrome side, §4.6). The same /api/health
// answer carries, through the portal, an `X-WC-Answer-Origin` header: the
// https origin of this session's answer host, where a remote viewer's answer
// frames load (tranche 7's portal sends it). answerOrigin() keeps only the
// ORIGIN of a valid https URL there, and null without one; public/app/asks.js
// frames from it when remote, and from loopbackOrigin(port) — the answer
// surface on this machine — otherwise. That origin is also what every frame's
// `message` events are checked against.
//
// Asked once per page load and remembered: a page does not move between
// local and remote without being reloaded. Fails closed to "local" — the local
// UI is the one that has always been there — with no answer origin.
//
//   isRemote()           → Promise<boolean>   (one fetch per page load)
//   remoteNow()          → boolean            the last answer (false until known)
//   remoteKnown()        → boolean            whether isRemote() has answered
//   answerOrigin()       → string | null      the header's https origin, once known
//   loopbackOrigin(port) → 'http://127.0.0.1:<port>' | null

let answer = null;     // Promise<boolean>
let known = false;
let settled = false;
let origin = null;

const ANSWER_ORIGIN_HEADER = 'X-WC-Answer-Origin';

// The origin of a valid https URL, or null.
export function parseAnswerOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.origin && u.origin !== 'null' ? u.origin : null;
}

function headerOf(r) {
  try {
    return r.headers && typeof r.headers.get === 'function' ? r.headers.get(ANSWER_ORIGIN_HEADER) : null;
  } catch { return null; }
}

export function isRemote() {
  if (!answer) {
    answer = fetch('/api/health')
      .then((r) => {
        if (!r || !r.ok) return null;
        origin = parseAnswerOrigin(headerOf(r));
        return r.json();
      })
      .then((j) => { known = !!(j && j.remote === true); return known; })
      .catch(() => false)
      .then((v) => { settled = true; return v; });
  }
  return answer;
}

// The last answer, synchronously (false until isRemote() has resolved).
export function remoteNow() { return known; }

export function remoteKnown() { return settled; }

export function answerOrigin() { return origin; }

export function loopbackOrigin(port) {
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null;
}
