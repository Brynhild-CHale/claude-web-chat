// The browser tab's favicon, and the dot on it while Claude waits on the user
// (design spec §9.7; maintainer rulings D11 and N1).
//
// WHICH IMAGE. web-chat's W is every project's default — blue in a light
// browser (/favicon.png), gold in a dark one (/favicon-dark.png) — and a project
// that has a mark (project.js getProject(): its favicon, else a square logo)
// shows that instead, in its dark variant when the browser is dark and one is
// set. index.html's two `rel="icon"` links carry `media` queries so the browser
// picks before any script runs; this module then keeps BOTH links on the image
// for the active scheme, so a browser that ignores `media` on icon links still
// shows the right one. The scheme is the BROWSER's (viewport.js prefersDark()
// and bus 'scheme'), never web-chat's own mode on <html data-theme>: the tab
// strip is the browser's, and the topbar's images follow web-chat's mode
// (cobrand.js). #wc-touch-icon points at the project's home-screen icon while
// one is set, else web-chat's.
//
// THE BADGE (N1). While the socket is live and the daemon's aggregate — the
// most urgent state across live, non-headless conversations (§8.3) — is
// `waiting` (a permission, a plan or another wait) or `question`, a dot is
// composited at runtime onto whichever image is showing: drawn into a canvas
// from its same-origin URL (so the canvas is never tainted), a transparent ring
// cut around the dot's place with 'destination-out' (so it reads on light,
// dark, active and inactive tabs and over busy artwork), the dot drawn, and
// both links set to the canvas's data URL. The plain image returns when the
// wait ends, and while the socket is down (the state is unknown then; ruling
// U77a@badge-and-touch). The inks are fixed hex, deliberately: the tab strip is
// not themed. The aggregate reaches every level, so a remote viewer gets the
// badge too.
//
// THE TITLE NEVER CHANGES. document.title is project.js's alone (ruling N1);
// nothing here reads or writes it.
//
// NO CANVAS, NO BADGE, NO THROW. A host without a 2d context (jsdom, a locked-
// down browser), an image that fails to load or a canvas that throws leaves the
// plain href. The decisions are pure, exported functions — iconFor, touchFor,
// badgeFor, composeBadge (on an injected canvas) — so plain node tests them.
//
// Repaints on bus 'scheme', 'project' and 'mirror'. main.js calls initFavicon()
// after initProject and initChatState; it is idempotent.
import { bus } from './bus.js';
import { prefersDark } from './viewport.js';
import { getProject } from './project.js';
import { mirror } from './chat-state.js';

export const DEFAULT_ICON = '/favicon.png';
export const DEFAULT_ICON_DARK = '/favicon-dark.png';
export const DEFAULT_TOUCH_ICON = '/apple-touch-icon.png';

// The Final's state inks (§8.3): rust for "needs you", gold for a question.
export const BADGE_INKS = Object.freeze({ rust: '#cc592e', gold: '#c79a12' });

// The dot, as fractions of the icon's side: top-right, its edge on the corner,
// with a transparent ring around it.
const DOT_R = 0.2;
const RING = 0.09;

const isMeta = (m) => !!m && typeof m === 'object' && typeof m.version === 'string' && m.version !== '';

// The tab icon's URL for an identity in the browser's scheme. The project's
// mark, in cobrand.js's form: /project/mark?v=<version> light, and
// /project/mark?mode=dark&v=<version> dark, where the version is that of the
// image the mode serves — the dark variant's when the mark has one, else the
// light image's (the route falls back to it). No mark: web-chat's W.
export function iconFor(identity, dark) {
  const id = identity && typeof identity === 'object' ? identity : {};
  const light = (id.mark === 'favicon' || id.mark === 'logo') ? id[id.mark] : null;
  if (!isMeta(light)) return dark ? DEFAULT_ICON_DARK : DEFAULT_ICON;
  const darkMeta = id.mark_dark === true ? id[`${id.mark}_dark`] : null;
  const meta = dark && isMeta(darkMeta) ? darkMeta : light;
  return `/project/mark?${dark ? 'mode=dark&' : ''}v=${encodeURIComponent(meta.version)}`;
}

// The home-screen icon's URL: the project's while one is set, else web-chat's.
// It has no dark variant (it sits on its own opaque tile in both schemes).
export function touchFor(identity) {
  const t = identity && typeof identity === 'object' ? identity.touch : null;
  return isMeta(t) ? `/project/touch-icon?v=${encodeURIComponent(t.version)}` : DEFAULT_TOUCH_ICON;
}

// Which dot the tab wears for the chat store's state: 'rust' while Claude needs
// the user, 'gold' for a question, null otherwise — and null whenever the
// socket is not live, since the state is unknown then.
export function badgeFor(m) {
  if (!m || typeof m !== 'object' || m.conn !== 'live') return null;
  const state = m.aggregate && typeof m.aggregate === 'object' ? m.aggregate.state : null;
  if (state === 'waiting') return 'rust';
  if (state === 'question') return 'gold';
  return null;
}

// Draw `image` onto `canvas` (its own width × height, square) with the dot in
// `colour` — 'rust', 'gold' or a hex ink — and return the canvas's PNG data
// URL; null when there is no 2d context or anything throws.
export function composeBadge(canvas, image, colour) {
  try {
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return null;
    const s = Number(canvas.width) > 0 ? Number(canvas.width) : 32;
    const r = s * DOT_R;
    const cx = s - r;
    const cy = r;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(image, 0, 0, s, s);
    // The ring: everything under it made transparent.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy, r + s * RING, 0, Math.PI * 2);
    ctx.fill();
    // The dot.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BADGE_INKS[colour] || colour;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const url = canvas.toDataURL('image/png');
    return typeof url === 'string' && url.startsWith('data:') ? url : null;
  } catch {
    return null;
  }
}

// ── the runtime ──────────────────────────────────────────────────────────────

// How the badge gets its canvas and its image. Injectable (initFavicon's
// options) because jsdom has neither a 2d context nor image loading.
function defaultCanvas() {
  return document.createElement('canvas');
}
function defaultLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`favicon: could not load ${src}`));
    img.src = src;
  });
}

const hooks = { createCanvas: defaultCanvas, loadImage: defaultLoadImage };
let wired = false;
let lastKey = null;   // what the icon links show (or are being given): `${href}|${badge}`
let token = 0;        // the newest paint: an older composition that lands late is dropped

const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

function setHref(el, href) {
  if (el && el.getAttribute('href') !== href) el.setAttribute('href', href);
}
function setIcons(href) {
  setHref(byId('wc-favicon'), href);
  setHref(byId('wc-favicon-dark'), href);
}

function pixelSize() {
  const dpr = typeof window !== 'undefined' && Number(window.devicePixelRatio);
  return dpr >= 2 ? 64 : 32;
}

async function badged(href, badge, mine) {
  let url = null;
  try {
    const image = await hooks.loadImage(href);
    if (mine !== token) return;
    const canvas = hooks.createCanvas();
    if (canvas) {
      const size = pixelSize();
      canvas.width = size;
      canvas.height = size;
      url = composeBadge(canvas, image, badge);
    }
  } catch { /* no image, no canvas: the plain icon */ }
  if (mine !== token) return;
  setIcons(url || href);
}

// Put the links on what the identity, the scheme and the store say now.
export function paintFavicon() {
  const identity = getProject();
  setHref(byId('wc-touch-icon'), touchFor(identity));
  const href = iconFor(identity, prefersDark());
  const badge = badgeFor(mirror);
  const key = `${href}|${badge || ''}`;
  if (key === lastKey) return;
  lastKey = key;
  const mine = ++token;
  if (!badge) {
    setIcons(href);
    return;
  }
  badged(href, badge, mine);
}

// Wire the repaints and paint once. A later call only swaps the injected
// `createCanvas` / `loadImage` (a test's fakes) and repaints from scratch.
export function initFavicon({ createCanvas, loadImage } = {}) {
  if (typeof createCanvas === 'function') hooks.createCanvas = createCanvas;
  if (typeof loadImage === 'function') hooks.loadImage = loadImage;
  lastKey = null;
  if (!wired) {
    wired = true;
    bus.on('scheme', paintFavicon);
    bus.on('project', paintFavicon);
    bus.on('mirror', paintFavicon);
  }
  paintFavicon();
}
