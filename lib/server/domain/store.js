// lib/server/domain/store.js — the shared key/value store's write path.
//
// Stateless like the other domain modules: every fn receives the live `state`
// (which owns `state.store`) and the change `bus`. patchStore is the ONE place a
// store patch is applied and announced, for the three writers that used to
// hand-pair `Object.assign(state.store, …)` with their own emit — the HTTP route
// (Claude's set_store, drivers), a pane's WS `store:set`, and the queue's Revert.
//
// It hands the patch's PRE-WRITE values to live bus subscribers as `meta.prior`
// (`{ [key]: { had, value } }` — never in the ring or on the wire). The wake-
// policy subscriber stamps that on a signal item so a Revert can put the key
// back the way it was; without it the value is gone by the time the subscriber
// runs, because the write lands before the event does.
//
// `unset` names keys to DELETE (a Revert restoring a key that was absent before
// the write). The store protocol has no delete op on the wire, so the WS frame
// carries them as `null` — the nearest thing a browser store can hold — while
// the daemon's store, which is what get_store reads and what a node commits,
// genuinely drops them. The event carries them as `unset` beside the patch.
function patchStore(state, bus, patch, { source = 'server', unset = [], mount, gesture, except } = {}) {
  const p = patch || {};
  const prior = {};
  for (const k of [...Object.keys(p), ...unset]) {
    prior[k] = Object.hasOwn(state.store, k) ? { had: true, value: state.store[k] } : { had: false };
  }
  Object.assign(state.store, p);
  for (const k of unset) delete state.store[k];
  const wsPatch = unset.length ? { ...p, ...Object.fromEntries(unset.map((k) => [k, null])) } : p;
  // Conditional fields so an unattributed write's event shape stays byte-identical
  // (bus-golden): `mount`/`gesture` only on a pane write, `unset` only on a revert.
  bus.emit({
    event: {
      kind: 'store', patch: p, source,
      ...(unset.length ? { unset: [...unset] } : {}),
      ...(mount ? { mount } : {}),
      ...(gesture ? { gesture: true } : {}),
    },
    ws: { type: 'store:patch', patch: wsPatch },
    except,
    meta: { prior },
  });
  return prior;
}

module.exports = { patchStore };
