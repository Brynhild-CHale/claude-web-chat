// The pub/sub store. Its get/set/subscribe core lives once in
// window.__wcMount.createStore (the shared runtime); here we inject the live
// surface's ws-echo publish hook — skipped for a server-originated patch
// (fromServer) or during a detached preview (rewrite risk #2: this guard is what
// prevents a store→ws→store echo storm). A CLOSED socket is no longer a third
// skip: ws.send queues the frame and the reconnect's `hello` drains it, because
// dropping it here lost the write at both ends. The full-surface
// appliers in mounts.js (fullReset, applySnapshot) use the store's silent
// replace() to bypass pub/sub — and the one that does not re-mount republishes
// the diff itself.
//
// mount-runtime.js is a classic script loaded before this module, so
// window.__wcMount is guaranteed present at eval time.
import { view } from './state.js';
import { send } from './ws.js';

const writeSubs = new Set();

export const store = window.__wcMount.createStore({}, (patch, opts) => {
  if (!opts.fromServer && !view.previewing) {
    // `mount`/`gesture` ride along when the write came through a pane's injected
    // store facade (see mounts.js): `mount` attributes the write to its pane for
    // opt-out activity routing; `gesture` marks it user-driven (proximate to a
    // real interaction) so script init/tick writes never read as user activity.
    send({ type: 'store:set', patch, ...(opts.mount ? { mount: opts.mount } : {}), ...(opts.gesture ? { gesture: true } : {}) });
  }
  for (const fn of [...writeSubs]) {
    try { fn(patch, opts); } catch (e) { console.error('[web-chat] store: an onWrite listener failed', e); }
  }
});

// onWrite(fn(patch, opts)) → unsubscribe: every write to the chrome's store,
// with the opts its writer passed (a pane facade's `mount` and `gesture`,
// `fromServer`), whether or not it was sent — the one place a listener hears a
// write's opts (the store's own subscribe hands the patch alone). Called after
// the store's subscribers, so a pane that redraws on the write has redrawn.
// The overlay's store re-resolve (overlay-hidden.js) listens here.
export function onWrite(fn) {
  if (typeof fn !== 'function') throw new TypeError('onWrite: expects a function');
  const h = (patch, opts) => fn(patch, opts);
  writeSubs.add(h);
  return () => { writeSubs.delete(h); };
}

// Panes' inline scripts reach the store via window.store (the runtime contract).
window.store = store;
