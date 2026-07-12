// The pub/sub store. Its get/set/subscribe core lives once in
// window.__wcMount.createStore (the shared runtime); here we inject the live
// surface's ws-echo publish hook — skipped for a server-originated patch
// (fromServer), during a detached preview, or with no open socket (rewrite risk
// #2: this guard is what prevents a store→ws→store echo storm). Bulk reset/merge
// (fullReset, hello) use the store's silent replace()/merge() to bypass pub/sub.
//
// mount-runtime.js is a classic script loaded before this module, so
// window.__wcMount is guaranteed present at eval time.
import { view } from './state.js';
import { send, isOpen } from './ws.js';

export const store = window.__wcMount.createStore({}, (patch, opts) => {
  if (!opts.fromServer && !view.previewing && isOpen()) {
    send({ type: 'store:set', patch });
  }
});

// Panes' inline scripts reach the store via window.store (the runtime contract).
window.store = store;
