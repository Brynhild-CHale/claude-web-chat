// Theming. Tokens (--wc-*) inherit through open shadow roots, so applying each
// layer's OWN tokens at its DOM level — global→:root, node→#main, pane→.pane —
// gives the pane→node→global cascade for free. Raw CSS can't cross the shadow
// boundary: global/node css → head <style> (chrome only); pane css → a <style>
// inside that pane's shadow root (content only). (See rewrite risks #1, #11.)
import { $ } from './state.js';

export const WC_TOKEN_RE = /^--wc-[\w-]+$/;
let globalThemeObj = null;      // resolved web-chat-wide default ({tokens, css})
let activeNodeThemeObj = null;  // the active node's own theme (re-applied on returnToActive)
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
  globalThemeObj = theme || null;
  applyTokens(document.documentElement, theme && theme.tokens, { animate });
  setHeadStyle('wc-theme-global-css', (theme && theme.css) || '');
}
export const getGlobalTheme = () => globalThemeObj;

// Node's OWN tokens/css at #main (global lives on :root; the node layer overrides).
export function applyNodeTheme(theme, animate) {
  applyTokens($('main'), theme && theme.tokens, { animate });
  setHeadStyle('wc-theme-node-css', (theme && theme.css) || '');
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
  applyTokens(p.wrapper, theme && theme.tokens, { animate });
  if (!p.themeStyle && p.root) {
    p.themeStyle = document.createElement('style');
    p.root.appendChild(p.themeStyle);
  }
  if (p.themeStyle) p.themeStyle.textContent = WC_SHADOW_TRANSITION + '\n' + ((theme && theme.css) || '');
  if (p.spec) p.spec.theme = theme || undefined;
}

// --- Earthy light/dark mode (Earthy Light is the default; dark via stored pref) ---
// Orthogonal to named themes: this only flips which set of --wc-* DEFAULTS :root
// resolves to. A saved theme's tokens (applied inline) still override on top.
const MODE_KEY = 'wc-mode';
export function initMode() {
  // Earthy Light is the default; only an explicit stored 'dark' opts back into
  // the dark look. index.html ships data-theme="light" so the first paint is
  // already light — this just reconciles a returning user's dark preference.
  if (localStorage.getItem(MODE_KEY) === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = 'light';
}
export function toggleMode() {
  const nowLight = document.documentElement.dataset.theme !== 'light';
  beginThemeTransition();
  if (nowLight) { document.documentElement.dataset.theme = 'light'; localStorage.setItem(MODE_KEY, 'light'); }
  else { delete document.documentElement.dataset.theme; localStorage.setItem(MODE_KEY, 'dark'); }
  return nowLight;
}
