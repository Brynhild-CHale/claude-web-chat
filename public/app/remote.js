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
//
// EMBEDDED MODE (U470; form 6 V1/V2/W2, web-chat-contracts 06 C-06.33 to
// C-06.36). Inside the hub's chat view the daemon's own chrome is shown in a
// frame, and the shell around it provides the project name, the node label and
// page title, Sessions, the theme toggle, the version banner and the ⋯ menu.
// Embedded is ONE flag beside the remote flag, read from the same /api/health
// answer, from EITHER source the hub's relay may use: the response headers
// `X-WC-Embedded: 1` and `X-WC-Embed-Parent: <https origin>` (wc's preferred
// form, 06 Q-06.3), or the body fields `embedded: true` and `embed_parent`
// (C-06.33's form; the daemon itself sets neither in 0.9, so only a relay can).
// It holds only while this page is IN A FRAME (window.self !== window.top): the
// same origin opened top-level shows the full chrome, whatever health says.
// embed_parent is kept only when it parses as an https origin (null else), and
// it is the one origin the bridge (public/app/embed-bridge.js) listens to and
// posts to. Like the remote flag it changes what the page SHOWS, never what it
// may do: the relay and the daemon decide access.
//
// The look is one CSS block (public/app.css, U470's) under html.embedded, which
// this module sets on <html> when health answers embedded and removes when it
// does not. So the full topbar never flashes in a frame, html.framed is set
// SYNCHRONOUSLY when this module is first evaluated (before main.js's body
// runs) whenever the page is framed; the same block pre-hides the items under
// it, and it is dropped once health answers not embedded.
//
//   isFramed()           → boolean            window.self !== window.top
//   isEmbedded()         → boolean            framed AND health said embedded (false until known)
//   embedParent()        → string | null      the parent's https origin, once known
//   shellHidden()        → boolean            embedded, or framed while health is still unanswered:
//                                            what the openers of a shell-provided panel (Sessions) ask
//   frameParent()        → Window | null      the window the bridge talks to (window.parent when framed)
//   healthVersion()      → string | null      health's package_version (the bridge's ready)
//   onEmbedChange(fn)    → unsubscribe        fn({embedded, parent}) each time health is read
//   resetEmbedForTests({framed, parent})      TESTS ONLY: jsdom cannot frame a window (its
//                                            top/parent are unforgeable), so a test swaps the
//                                            frame probe and drops the cached health answer

let answer = null;     // Promise<boolean>
let known = false;
let settled = false;
let origin = null;
let embedded = false;
let parentOrigin = null;
let version = null;
const embedListeners = new Set();

const ANSWER_ORIGIN_HEADER = 'X-WC-Answer-Origin';
const EMBEDDED_HEADER = 'X-WC-Embedded';
const EMBED_PARENT_HEADER = 'X-WC-Embed-Parent';

// Is this page inside a frame? A cross-origin top that throws on the compare is
// a frame too.
const realFramed = () => {
  try { return typeof window !== 'undefined' && window.self !== window.top; } catch { return true; }
};
let framedProbe = realFramed;
let parentOverride = undefined;
export function isFramed() { try { return framedProbe() === true; } catch { return false; } }
export function frameParent() {
  if (parentOverride !== undefined) return parentOverride;
  try { return isFramed() ? window.parent : null; } catch { return null; }
}

const rootEl = () => (typeof document !== 'undefined' && document.documentElement) || null;
function setRootClass(name, on) {
  const r = rootEl();
  if (r && r.classList) r.classList.toggle(name, !!on);
}
// The provisional pre-hide, at first evaluation: no flash of the full topbar.
setRootClass('framed', isFramed());

// The origin of a valid https URL, or null.
export function parseAnswerOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  let u;
  try { u = new URL(value.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.origin && u.origin !== 'null' ? u.origin : null;
}

function headerOf(r, name = ANSWER_ORIGIN_HEADER) {
  try {
    return r.headers && typeof r.headers.get === 'function' ? r.headers.get(name) : null;
  } catch { return null; }
}

// What one health answer says of embedding: the headers first (wc's form), else
// the body's fields. Framed or not is the caller's.
export function readEmbed({ embeddedHeader = null, parentHeader = null, body = null } = {}) {
  const head = typeof embeddedHeader === 'string' && embeddedHeader.trim() === '1';
  const inBody = !!(body && typeof body === 'object' && body.embedded === true);
  const parent = parseAnswerOrigin(parentHeader)
    || (body && typeof body === 'object' ? parseAnswerOrigin(body.embed_parent) : null);
  return { embedded: head || inBody, parent: head || inBody ? parent : null };
}

function settleEmbed(r, j) {
  const said = r ? readEmbed({ embeddedHeader: headerOf(r, EMBEDDED_HEADER), parentHeader: headerOf(r, EMBED_PARENT_HEADER), body: j })
    : { embedded: false, parent: null };
  embedded = isFramed() && said.embedded;
  parentOrigin = embedded ? said.parent : null;
  version = j && typeof j.package_version === 'string' && j.package_version.length <= 64 ? j.package_version : null;
  setRootClass('embedded', embedded);
  if (!embedded) setRootClass('framed', false);
  const state = Object.freeze({ embedded, parent: parentOrigin });
  for (const fn of [...embedListeners]) {
    try { fn(state); } catch (err) { console.error('[remote] an embed listener failed', err); }
  }
}

export function isRemote() {
  if (!answer) {
    let res = null;
    answer = fetch('/api/health')
      .then((r) => {
        if (!r || !r.ok) return null;
        res = r;
        origin = parseAnswerOrigin(headerOf(r));
        return r.json();
      })
      .then((j) => { known = !!(j && j.remote === true); settleEmbed(res, j); return known; })
      .catch(() => { settleEmbed(null, null); return false; })
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

export function isEmbedded() { return embedded; }
export function embedParent() { return parentOrigin; }
export function healthVersion() { return version; }
// The openers of a panel the shell provides ask this: embedded, or framed with
// the health answer still out (the same moment html.framed pre-hides them).
export function shellHidden() { return embedded || (isFramed() && !settled); }

export function onEmbedChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onEmbedChange: fn must be a function');
  embedListeners.add(fn);
  return () => embedListeners.delete(fn);
}

// TESTS ONLY (see the head): frame the page or not, and ask health again on the
// next isRemote(). Returns that promise.
export function resetEmbedForTests({ framed = false, parent = undefined } = {}) {
  framedProbe = () => framed === true;
  parentOverride = parent;
  answer = null; known = false; settled = false; origin = null;
  embedded = false; parentOrigin = null; version = null;
  setRootClass('embedded', false);
  setRootClass('framed', isFramed());
  return isRemote();
}
