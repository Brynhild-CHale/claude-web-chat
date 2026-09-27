// Theming. Tokens (--wc-*) inherit through open shadow roots, so applying each
// layer's OWN tokens at its DOM level — global→:root, node→#main, pane→.pane —
// gives the pane→node→global cascade for free. Raw CSS can't cross the shadow
// boundary: global/node css → head <style> (chrome only); pane css → a <style>
// inside that pane's shadow root (content only). (See rewrite risks #1, #11.)
//
// Light/dark is a MODE INSIDE a theme: a theme may carry
// `modes: {light: {tokens, css}, dark: {tokens, css}}` over its mode-free
// tokens/css, and every layer is applied flattened at ONE effective mode — the
// viewer's stored preference if the global theme offers it, else the global
// theme's only mode (a single-mode pack disables the ◑ toggle). These rules
// mirror lib/server/theme.js (themeModes / pickMode / flattenTheme).
import { $ } from './state.js';
import { getLocal, setLocal } from './storage.js';
import { panes } from './mounts.js';
import { bus } from './bus.js';

export const WC_TOKEN_RE = /^--wc-[\w-]+$/;
let globalThemeObj = null;      // resolved web-chat-wide default ({tokens, css, modes?})
let activeNodeThemeObj = null;  // the active node's own theme (re-applied on returnToActive)
let shownNodeThemeObj = null;   // the node theme currently on #main (re-flattened on a mode flip)

// --- modes ---
export const MODES = ['light', 'dark'];
export function themeModes(t) {
  return (t && t.modes && typeof t.modes === 'object') ? MODES.filter(m => t.modes[m]) : [];
}
function pickMode(t, want) {
  const ms = themeModes(t);
  if (!ms.length) return want;
  return ms.includes(want) ? want : ms[0];
}
export function flattenTheme(t, mode) {
  if (!t) return { tokens: null, css: '' };
  const layer = t.modes && t.modes[pickMode(t, mode)];
  return {
    tokens: { ...(t.tokens || {}), ...((layer && layer.tokens) || {}) },
    css: [t.css, layer && layer.css].filter(c => typeof c === 'string' && c.trim()).join('\n'),
  };
}
let _themeTimer = null;

// Arm chrome transitions for ~340ms then strip the class so they never fight
// layout/interaction. Custom props don't transition, but the props consuming them do.
export function beginThemeTransition() {
  document.documentElement.classList.add('wc-theming');
  if (_themeTimer) clearTimeout(_themeTimer);
  _themeTimer = setTimeout(() => {
    document.documentElement.classList.remove('wc-theming');
    _themeTimer = null;
  }, 340);
}

// Set/unset --wc-* tokens on an element via inline style; tokens absent from the
// new set are removed so a cleared theme falls back to the CSS var() defaults.
export function applyTokens(el, tokens, opts = {}) {
  if (!el) return;
  const prev = el.__wcTokens || {};
  for (const k of Object.keys(prev)) {
    if (!tokens || !(k in tokens)) el.style.removeProperty(k);
  }
  if (tokens) for (const [k, v] of Object.entries(tokens)) {
    if (WC_TOKEN_RE.test(k)) el.style.setProperty(k, v);
  }
  el.__wcTokens = tokens ? { ...tokens } : {};
  if (opts.animate) beginThemeTransition();
}

export function setHeadStyle(id, css) {
  let el = document.getElementById(id);
  if (!css) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  el.textContent = css;
}

export function applyGlobalTheme(theme, animate) {
  const prevMode = effectiveMode();
  globalThemeObj = theme || null;
  const mode = effectiveMode();
  setModeAttr(mode);
  const flat = flattenTheme(theme, mode);
  applyTokens(document.documentElement, flat.tokens, { animate });
  setHeadStyle('wc-theme-global-css', flat.css);
  syncModeToggle();
  // A new global pack can move the effective mode (dark pref → a single-mode
  // pack); the node and pane layers follow it, as on a ◑ flip.
  if (mode !== prevMode) { reapplyLayers(); announceMode(); }
}
// Every server-rendered document the chrome frames — the graph inspector's
// preview, the glance, pane history, the replay player — is drawn in the
// viewer's mode (`?mode=`), so each redraws when it moves. They listen on the
// chrome bus ('mode', {mode}) rather than being imported here: replay.js must
// not reach mounts.js, which this module imports.
function announceMode() { bus.emit('mode', { mode: effectiveMode() }); }
export const getGlobalTheme = () => globalThemeObj;

// Node's OWN tokens/css at #main (global lives on :root; the node layer overrides).
export function applyNodeTheme(theme, animate) {
  shownNodeThemeObj = theme || null;
  const flat = flattenTheme(theme, effectiveMode());
  applyTokens($('main'), flat.tokens, { animate });
  setHeadStyle('wc-theme-node-css', flat.css);
}
export const setActiveNodeTheme = (theme) => { activeNodeThemeObj = theme || null; };
export const getActiveNodeTheme = () => activeNodeThemeObj;

// Shadow-content transition rule (token-consuming content fades with chrome).
export const WC_SHADOW_TRANSITION =
  ':host-context(html.wc-theming) *, :host-context(html.wc-theming) {' +
  ' transition: background-color var(--wc-theme-transition,280ms) ease,' +
  ' color var(--wc-theme-transition,280ms) ease,' +
  ' border-color var(--wc-theme-transition,280ms) ease,' +
  ' fill var(--wc-theme-transition,280ms) ease; }';

// Pane's OWN theme: tokens on the .pane wrapper (cross the shadow by inheritance),
// raw css into a <style> inside its shadow root. Never re-renders content.
export function applyPaneTheme(p, theme, animate) {
  if (!p) return;
  p.theme = theme || null;
  const flat = flattenTheme(theme, effectiveMode());
  applyTokens(p.wrapper, flat.tokens, { animate });
  if (!p.themeStyle && p.root) {
    p.themeStyle = document.createElement('style');
    p.root.appendChild(p.themeStyle);
  }
  if (p.themeStyle) p.themeStyle.textContent = WC_SHADOW_TRANSITION + '\n' + flat.css;
  if (p.spec) p.spec.theme = theme || undefined;
}

// --- light/dark mode (a mode INSIDE the global theme) ---
// `wc-mode` in localStorage is the viewer's preference; light is the default.
// The effective mode is that preference when the global theme offers it (or
// declares no modes — a pre-pack theme, where :root's data-theme picks the
// stylesheet's Earthy light/dark fallbacks), else the theme's only mode.
const MODE_KEY = 'wc-mode';
// Held in memory too: where storage cannot keep a write (a private window) the
// toggle must still flip for this page's lifetime.
let modePref = null;
const prefMode = () => modePref || (getLocal(MODE_KEY) === 'dark' ? 'dark' : 'light');
export function effectiveMode() { return pickMode(globalThemeObj, prefMode()); }
// Can the viewer flip modes under the current global theme?
export function modeToggleable() { return themeModes(globalThemeObj).length !== 1; }
function setModeAttr(mode) {
  if (mode === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = 'light';
}
export function initMode() {
  // Earthy Light is the default; only an explicit stored 'dark' opts back into
  // the dark look. index.html ships data-theme="light" so the first paint is
  // already light — this just reconciles a returning user's dark preference
  // (the global theme, and so the final effective mode, arrives with `hello`).
  // Through storage.js: this is main.js's FIRST statement, so an unguarded read
  // in a private window would abort bootstrap and leave a dead page.
  setModeAttr(prefMode());
}
// Re-flatten the node and pane layers at the current effective mode.
function reapplyLayers() {
  applyNodeTheme(shownNodeThemeObj, false);
  for (const p of panes.values()) applyPaneTheme(p, p.theme, false);
}
// ◑ / T / the palette. Flips the stored preference and re-applies every layer
// at the new mode. Under a single-mode pack it does nothing and returns null
// (the button says why).
export function toggleMode() {
  if (!modeToggleable()) return null;
  const next = effectiveMode() === 'light' ? 'dark' : 'light';
  modePref = next;
  setLocal(MODE_KEY, next);
  beginThemeTransition();
  applyGlobalTheme(globalThemeObj, false);
  reapplyLayers();
  announceMode();
  return next === 'light';
}
// The ◑ button reflects whether the current pack has a second mode.
export function syncModeToggle() {
  const btn = $('btn-theme-toggle');
  if (!btn) return;
  const ok = modeToggleable();
  // aria-disabled + a class, not `disabled`: a disabled button swallows the
  // hover that shows its title in some browsers, and the title is the point.
  btn.classList.toggle('is-disabled', !ok);
  btn.setAttribute('aria-disabled', String(!ok));
  const name = (globalThemeObj && (globalThemeObj.title || globalThemeObj.name)) || 'This theme';
  const label = ok ? 'Light / dark · T' : `${name} has only a ${effectiveMode()} mode`;
  btn.title = label;
  btn.setAttribute('aria-label', ok ? 'Toggle light / dark (T)' : label);
  // Settings → Mode says the same thing in words: which mode is on, and — under
  // a single-mode pack — that the other one does not exist.
  const seg = $('settings-mode');
  if (seg) {
    const mode = effectiveMode();
    for (const b of seg.querySelectorAll('button[data-mode]')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !ok && !on;
      b.title = !ok && !on ? label : '';
    }
  }
}
