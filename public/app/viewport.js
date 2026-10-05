// The phone posture — the one question the chrome asks the viewport in script.
//
// Width alone is CSS's job: under 760px (app.css, "narrow") the panes stack in
// reading order, the topbar sheds, and a bottom bar carries ↑/↓, ↩ active, Graph
// and Queue. That is layout, and a desktop window that narrow still wants it —
// the product's own default posture is a terminal beside a browser.
//
// A PHONE is more than narrow: its LAYOUT is fixed (design, Layout Engine
// "Phone viewer" + Graph Prototype phone). Its panes show a title and type chip
// and no layout control — no drag, resize, pin, lock, minimize or close — while
// what is INSIDE a pane works exactly as on the desktop (maintainer, 2026-09-27:
// through the tunnel the phone can be the only way to reach a session). The two
// gates live in mounts.js: contentReadOnly (a preview only) and layoutLocked
// (a preview or a phone).
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
// 'viewport' event for the modules that change behaviour (mounts.js layout lock,
// graph-view.js log vs canvas). No matchMedia (jsdom, very old engines) = not a
// phone, which is the desktop everyone has today.
//
// Two more answers live here, so this stays the one module that asks matchMedia
// (test/responsive-a11y.test.js):
//
//   * NARROW (design spec §7.1, C19): below 760px, phone or not. CSS owns what
//     narrow LOOKS like (the bottom bar, the stacked page), so there is no class
//     for it; script that must ACT on it (the chat dock closing itself, the pull)
//     asks `isNarrow()` or listens for 'viewport:narrow' {narrow, phone}, which
//     fires on every narrow flip. 'viewport' stays a phone-flip event — its
//     detail also says `narrow` — so its listeners never see a width change
//     that left the phone answer alone.
//   * The BROWSER's colour scheme (§9.7): `prefersDark()` and 'scheme' {dark},
//     for what the browser itself draws (the favicon in its tab strip). It is
//     not web-chat's light/dark, which is <html data-theme>, the topbar's choice
//     (§9.4), so it puts nothing on <html>.
//
// Every answer starts false (desktop, light), an event fires only when an
// answer changes, and a phone is narrow by definition (its query is narrow AND
// portrait-tall), which the answers keep true even while a host updates its
// query lists one at a time.
import { bus } from './bus.js';

export const PHONE_MAX_WIDTH = 759;        // px — the narrow breakpoint (app.css's <760px)
export const PHONE_MAX_ASPECT = '3/4';     // width/height — portrait at least this tall
const BY_SHAPE = `(max-width: ${PHONE_MAX_WIDTH}px) and (max-aspect-ratio: ${PHONE_MAX_ASPECT})`;
const BY_POINTER = `(max-width: ${PHONE_MAX_WIDTH}px) and (pointer: coarse)`;   // the pre-a11 rule
// To revert to "narrow + a finger": PHONE_QUERY = BY_POINTER.
export const PHONE_QUERY = BY_SHAPE;
// Width only — app.css's one breakpoint (`@media (max-width: 759px)`).
export const NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
export const SCHEME_QUERY = '(prefers-color-scheme: dark)';

// The query lists, made once by initViewport. Narrow is made first: a host that
// fires the lists' change events one list at a time (in the order they were
// made) then has the narrow answer current by the time the phone list fires.
const lists = { narrow: null, phone: null, scheme: null };
let narrow = false;
let phone = false;
let dark = false;

export function isPhone() { return phone; }
export function isNarrow() { return narrow; }
export function prefersDark() { return dark; }
// The same answer in the daemon's push-provenance vocabulary (lib/server/domain/
// queue provenance): the phone view is `mobile`, everything else `desktop`.
export function deviceKind() { return phone ? 'mobile' : 'desktop'; }

// A list's answer; a list that is missing, or whose `matches` throws (a host
// that does not know the feature), answers no.
function answer(mql) {
  try { return !!(mql && mql.matches); } catch { return false; }
}

function makeList(query) {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null; }
  catch { return null; }
}

// Re-read all three answers and announce each that changed. Every list's change
// listener is this one function, so a change that flips two answers at once
// (a phone rotated past the breakpoint) is announced once whichever list
// reports it first, and the rest find nothing to say.
function refresh() {
  const nextNarrow = answer(lists.narrow);
  const nextPhone = nextNarrow && answer(lists.phone);
  const nextDark = answer(lists.scheme);
  const narrowFlip = nextNarrow !== narrow;
  const phoneFlip = nextPhone !== phone;
  const darkFlip = nextDark !== dark;
  narrow = nextNarrow;
  phone = nextPhone;
  dark = nextDark;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.classList.toggle('phone', phone);
  }
  if (narrowFlip) bus.emit('viewport:narrow', { narrow, phone });
  if (phoneFlip) bus.emit('viewport', { phone, narrow });
  if (darkFlip) bus.emit('scheme', { dark });
}

export function initViewport() {
  lists.narrow = makeList(NARROW_QUERY);
  lists.phone = makeList(PHONE_QUERY);
  lists.scheme = makeList(SCHEME_QUERY);
  refresh();
  for (const mql of new Set(Object.values(lists))) {
    if (!mql) continue;
    // addListener is the pre-2020 Safari spelling; both deliver the same change.
    try {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', refresh);
      else if (typeof mql.addListener === 'function') mql.addListener(refresh);
    } catch { /* a list that cannot be listened to keeps its first answer */ }
  }
}
