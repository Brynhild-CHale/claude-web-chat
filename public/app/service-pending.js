// The ONE service-pending signal (annotation engine 2A.2): which components'
// host-side services are waiting on `claude-web-chat trust`, as the chrome
// knows it. A service-backed pane whose service has not been approved draws
// nothing from its store yet, so an anchored element inside it is HIDDEN, not
// gone (public/app/overlay-hidden.js); the drawer's "needs approval" badges
// read the same list (public/app/drawer.js loadPendingTrust).
//
//   pendingServices()      → a Set of component names (a copy)
//   onPendingChange(fn)    → unregister; fn({pending, added, removed}) after a
//                            read that changed the set
//   refreshPending()       → Promise<Set | null>: one read now; null when the
//                            daemon did not answer (the set is left as it was)
//   initServicePending()   → idempotent: the first read, one more on each
//                            'service:trust' / 'service:trust:clear' frame, and
//                            one on every hello (a request cleared while the
//                            socket was down sends no clear frame after the
//                            reconnect: the hello's read is what drops it)
//
// Read through the chrome's one HTTP reader (http.js) — never a raw fetch —
// from GET /api/services/pending (lib/server/routes/components.js), whose
// entries name the component as `name` or `component`. The service-trust
// notice itself (public/app/service-trust.js) is not this module's: it shows
// the prompt; this only keeps the list.
//
// Reads can overlap (a burst of trust frames on a reconnect): a read started
// earlier never overwrites the answer of one started later.
import { request } from './http.js';
import { onFrame, onHello } from './ws.js';

export const PENDING_PATH = '/api/services/pending';

let names = new Set();
const subs = new Set();
let inited = false;
let started = 0;      // the newest read started
let applied = 0;      // the newest read whose answer is the set

function namesOf(body) {
  const list = body && Array.isArray(body.pending) ? body.pending : [];
  const out = new Set();
  for (const p of list) {
    const n = p && (p.name || p.component);
    if (typeof n === 'string' && n) out.add(n);
  }
  return out;
}

function take(next) {
  const added = [...next].filter((n) => !names.has(n));
  const removed = [...names].filter((n) => !next.has(n));
  names = next;
  if (!added.length && !removed.length) return;
  const msg = { pending: new Set(names), added, removed };
  for (const fn of [...subs]) {
    try { fn(msg); } catch (e) { console.error('[web-chat] service-pending: a listener failed', e); }
  }
}

export function refreshPending() {
  const mine = ++started;
  return request('GET', PENDING_PATH).then((r) => {
    if (!r.ok) return null;
    const next = namesOf(r.body);
    if (mine > applied) { applied = mine; take(next); }
    return new Set(next);
  });
}

export function pendingServices() { return new Set(names); }

export function onPendingChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onPendingChange: expects a function');
  const h = (m) => fn(m);
  subs.add(h);
  return () => { subs.delete(h); };
}

export function initServicePending() {
  if (inited) return;
  inited = true;
  onFrame('service:trust', () => { refreshPending(); });
  onFrame('service:trust:clear', () => { refreshPending(); });
  onHello(() => { refreshPending(); });
  refreshPending();
}
