// Browser storage — the ONE place public/app touches the localStorage and
// sessionStorage accessors.
//
// Why an engine for four one-liners: in a private window, or a browser with site
// data blocked (Safari "Block all cookies", Chrome's block-site-data), the
// ACCESSOR ITSELF throws — `localStorage` is a getter on window, so the
// SecurityError lands before `.getItem` is even reached. An unguarded read at
// module scope therefore aborts that module's evaluation, and in an ES-module
// graph that takes down everything downstream of it: theme.js's initMode() is
// main.js's first statement, so one unwrapped read meant no socket, no topbar,
// no rail — a dead page.
//
// Three modules had each grown their own try/catch for this (version.js,
// service-trust.js, graph-view.js) and the fourth (theme.js) had not. One home,
// one rule: every accessor touch is wrapped and FAILS OPEN — a read returns the
// caller's fallback, a write returns false. Nothing here throws, so no caller
// needs a try/catch of its own.
//
// test/conventions.test.js ratchets the two accessor names to this file, at zero
// everywhere else in public/app.

const guard = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export const getLocal = (key, fallback = null) =>
  guard(() => { const v = localStorage.getItem(key); return v === null ? fallback : v; }, fallback);
export const setLocal = (key, value) =>
  guard(() => { localStorage.setItem(key, String(value)); return true; }, false);
export const removeLocal = (key) =>
  guard(() => { localStorage.removeItem(key); return true; }, false);

export const getSession = (key, fallback = null) =>
  guard(() => { const v = sessionStorage.getItem(key); return v === null ? fallback : v; }, fallback);
export const setSession = (key, value) =>
  guard(() => { sessionStorage.setItem(key, String(value)); return true; }, false);
export const removeSession = (key) =>
  guard(() => { sessionStorage.removeItem(key); return true; }, false);

// JSON convenience. A value that will not parse is treated exactly like a missing
// one — a torn or hand-edited entry is a viewport preference, never data worth
// failing over.
const parse = (raw, fallback) => {
  if (raw == null) return fallback;
  try { const v = JSON.parse(raw); return v === null || v === undefined ? fallback : v; }
  catch { return fallback; }
};
export const getLocalJson = (key, fallback = null) => parse(getLocal(key, null), fallback);
export const setLocalJson = (key, value) => setLocal(key, JSON.stringify(value));
export const getSessionJson = (key, fallback = null) => parse(getSession(key, null), fallback);
export const setSessionJson = (key, value) => setSession(key, JSON.stringify(value));
