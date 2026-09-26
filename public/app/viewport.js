// The phone posture — the one question the chrome asks the viewport in script.
//
// Width alone is CSS's job: under 760px (app.css, "narrow") the panes stack in
// reading order, the topbar sheds, and a bottom bar carries ↑/↓, ↩ active, Graph
// and Queue. That is layout, and a desktop window that narrow still wants it —
// the product's own default posture is a terminal beside a browser.
//
// A PHONE is more than narrow: it is the read-only viewer (design, Layout Engine
// "Phone viewer" + Graph Prototype phone). Its panes show a title and type chip
// and nothing that writes — no drag, resize, pin, lock, minimize or close, and
// form fields refuse edits — so the phone's writes go through the queue (stage /
// hold, comment, Push) and the graph's actions. Taking editing away from a
// narrow DESKTOP window would break that terminal-beside-browser posture, so the
// phone is narrow AND a coarse primary pointer (a finger).
//
// The answer rides on <html class="phone"> for CSS, and `isPhone()` + a bus
// 'viewport' event for the modules that change behaviour (mounts.js read-only,
// graph-view.js log vs canvas). No matchMedia (jsdom, very old engines) = not a
// phone, which is the desktop everyone has today.
import { bus } from './bus.js';

export const PHONE_QUERY = '(max-width: 759px) and (pointer: coarse)';

let mql = null;
let phone = false;

export function isPhone() { return phone; }

function apply(next) {
  const changed = next !== phone;
  phone = next;
  document.documentElement.classList.toggle('phone', phone);
  if (changed) bus.emit('viewport', { phone });
}

export function initViewport() {
  try { mql = typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null; }
  catch { mql = null; }
  apply(!!(mql && mql.matches));
  if (!mql) return;
  const onChange = () => apply(!!mql.matches);
  // addListener is the pre-2020 Safari spelling; both deliver the same change.
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
  else if (typeof mql.addListener === 'function') mql.addListener(onChange);
}
