// Tiny pub/sub. Breaks the module cycles the old flat client wired through
// file-global `let`s: producers `emit(type, detail)`, consumers `on(type, fn)`,
// and each listener is handed `detail`.
//
// A plain listener map, not an EventTarget: dispatching a DOM CustomEvent tied
// the bus to whichever realm's Event classes happened to be global, and under
// a test DOM (jsdom's CustomEvent, Node's EventTarget) every emit threw. As
// dispatchEvent does, one listener that throws is reported and the rest still
// run — an emitter never sees a subscriber's failure.
const subs = new Map();

export const bus = {
  on(type, fn) {
    if (!subs.has(type)) subs.set(type, new Set());
    const h = (detail) => fn(detail);
    subs.get(type).add(h);
    return () => { const s = subs.get(type); if (s) s.delete(h); };
  },
  emit(type, detail) {
    const s = subs.get(type);
    if (!s) return;
    for (const h of [...s]) {
      try { h(detail); } catch (e) { console.error(`[web-chat] bus listener for '${type}' failed`, e); }
    }
  },
};
