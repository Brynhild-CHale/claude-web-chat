// Is this page being viewed REMOTELY — through the tunnel portal (lib/portal)?
//
// The portal adds `X-WC-Remote: 1` to every request it forwards and the
// daemon's GET /api/health echoes it as `remote:true`. The answer only changes
// what the page SAYS: a remote viewer cannot install packs or approve services
// (the portal refuses those routes), so the Manage tab and the service-trust
// card point at the host instead of offering a control that would 403. It is
// never an access decision — that is the portal's, server-side.
//
// Asked once per page load and remembered: a page does not move between
// local and remote without being reloaded. Fails closed to "local" — the local
// UI is the one that has always been there.

let answer = null;     // Promise<boolean>
let known = false;

export function isRemote() {
  if (!answer) {
    answer = fetch('/api/health')
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => { known = !!(j && j.remote === true); return known; })
      .catch(() => false);
  }
  return answer;
}

// The last answer, synchronously (false until isRemote() has resolved).
export function remoteNow() { return known; }
