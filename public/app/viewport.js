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
// hold, comment, Push) and the graph's actions.
//
// The phone is chosen by SHAPE, not by pointer (maintainer ruling a11): narrow
// AND portrait-tall, whatever the pointer. A phone held upright is ~9:19 (its
// viewport, less the browser's bars, ~0.5–0.65 wide-per-tall); a terminal beside
// a browser on a laptop is ~700×900 (0.78) and stays the editable desktop. A
// landscape phone is wide-per-tall > 1 and stays non-phone (the canvas and
// editing). The cost, accepted: a desktop window dragged narrower than 3:4 gets
// the phone view. Both thresholds live HERE and nowhere else (app.css keys its
// phone rules off <html class="phone">, never a media query of its own).
//
// The answer rides on <html class="phone"> for CSS, and `isPhone()` + a bus
// 'viewport' event for the modules that change behaviour (mounts.js read-only,
// graph-view.js log vs canvas). No matchMedia (jsdom, very old engines) = not a
// phone, which is the desktop everyone has today.
import { bus } from './bus.js';

export const PHONE_MAX_WIDTH = 759;        // px — the narrow breakpoint (app.css's <760px)
export const PHONE_MAX_ASPECT = '3/4';     // width/height — portrait at least this tall
const BY_SHAPE = `(max-width: ${PHONE_MAX_WIDTH}px) and (max-aspect-ratio: ${PHONE_MAX_ASPECT})`;
const BY_POINTER = `(max-width: ${PHONE_MAX_WIDTH}px) and (pointer: coarse)`;   // the pre-a11 rule
// To revert to "narrow + a finger": PHONE_QUERY = BY_POINTER.
export const PHONE_QUERY = BY_SHAPE;

let mql = null;
let phone = false;

export function isPhone() { return phone; }
// The same answer in the daemon's push-provenance vocabulary (lib/server/domain/
// queue provenance): the phone view is `mobile`, everything else `desktop`.
export function deviceKind() { return phone ? 'mobile' : 'desktop'; }

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
