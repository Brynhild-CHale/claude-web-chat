// Tiny pub/sub over EventTarget. Breaks the module cycles the old flat client
// wired through file-global `let`s: producers `emit(type, detail)`, consumers
// `on(type, fn)`. Detail is passed as the event's `detail`.
const target = new EventTarget();

export const bus = {
  on(type, fn) {
    const h = (e) => fn(e.detail);
    target.addEventListener(type, h);
    return () => target.removeEventListener(type, h);
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};
