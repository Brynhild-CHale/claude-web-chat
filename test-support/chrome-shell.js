// The chrome under test: the REAL public/index.html and the real public/app
// module graph, booted in jsdom ONCE per test file, behind one call.
//
//   const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
//   let shell;
//   before(async () => { shell = await bootShell({ routes, onSocket, init }); });
//   after(() => shell.restore());
//
// Thirty chrome test files hand-roll this boot, each a copy of the same thirty
// lines that drifted apart: which globals got aliased (and how — Node 21+
// defines `navigator` as a getter, so a plain assignment silently does
// nothing), whether the socket opened, which timers were stubbed, and whether
// anything was put back. This is the one boot; new chrome tests use it.
//
// ONCE PER FILE. node --test runs each test file in its own process, and the
// ESM cache would hand a second import of main.js the same already-initialised
// modules, so a file boots one shell: a second bootShell() call returns the
// same one. Passing options to that second call is refused rather than
// silently ignored — use setRoutes() for a test's own answers.
//
// What it does, and why each matters:
//
//   * fetch goes through ONE indirection. The modules call the bare global
//     `fetch`, so a test cannot swap answers by reassigning it after boot. The
//     shell answers from three layers, most specific first: the overrides of
//     the last setRoutes(), the boot's `routes`, then quiet defaults for every
//     endpoint the chrome reads at boot. A route is keyed by the URL with its
//     query, by its path alone, or by a prefix ending in `*`
//     ('/api/graph/node/*'); its value is a JSON body, a respond() for any
//     other status, or a function (url, init) returning either. Every request
//     is recorded in `calls` as { url, method, body, headers }, a JSON body
//     parsed.
//   * The socket is a FakeSocket the test drives: `shell.socket()` is the
//     chrome's current one, `.sent` the frames it sent (parsed), `.open()`,
//     `.drop()` (the server going away) and `.receive(msg)`. The first opens
//     once `init` has run (pass `open: false` to keep every socket closed until
//     the test opens it); a reconnect's opens on the next tick (set
//     `socket.autoOpen = false` in `onSocket` to hold one back).
//   * Timers. A perpetual chrome poller or ticker is one setInterval (design
//     spec §10.1), so setInterval is STUBBED: it records and never fires —
//     `shell.intervals()` lists the live ones, so a test can run a ticker's
//     function itself. setTimeout stays real but is TRACKED, and restore()
//     clears whatever is still pending: a reconnect scheduled by a dropped
//     socket, or a notice's dismissal, must never fire after the globals are
//     put back (it would run against Node's own, absent, `document`).
//     requestAnimationFrame is a tracked 0 ms timeout.
//   * Layout, which jsdom does not do. `scrollMetrics(el, {scrollHeight,
//     clientHeight, …, scrollTop, rect})` gives one element the geometry a test
//     needs, live (mutate the object it returns); scrollIntoView, which jsdom
//     lacks, is a no-op recorded in `shell.scrolls`; Element#scrollTo and
//     #scrollBy move scrollTop/scrollLeft. Real layout is the opt-in e2e tests'.
//   * The viewport. jsdom has no matchMedia; the shell's evaluates media
//     queries against `viewport` ({width, height, dark, coarse, reducedMotion},
//     default a 1280×800 desktop), and setViewport() changes it, firing
//     `change` on every query list whose answer flipped and `resize` on the
//     window — so viewport.js, the one module that asks, sees a real flip.
//     window.visualViewport follows it (visualHeight / visualTop for a
//     keyboard).
//   * Every global it replaces is put back by restore() exactly as it was,
//     property descriptor and all, and the window is closed. restore() first
//     lets the chrome's in-flight work settle, then clears its timers; it is
//     idempotent, and returns a promise for the after() hook to await.
//
// `init(shell)` runs after main.js, before the socket opens: the place for a
// feature module main.js does not initialise yet (spec §10.1), and for
// listeners that must see the first connect. `shell.importApp('x.js')` imports
// public/app/x.js — the same module instance the chrome itself uses.
//
// Deliberately OUTSIDE test/ (node --test would collect it as a test file) and
// the one place a test boots public/index.html in jsdom.
require('./sandbox');   // a throwaway HOME, and /app/markdown.js resolvable off the disk

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');

// Node's own timers, held before anything here replaces the globals.
const real = {
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
};
const NodeBlob = global.Blob;

// ── responses ────────────────────────────────────────────────────────────────

const RESPONSE = Symbol('chrome-shell response');

// A fetch Response for a route: `respond(body)` is a 200 JSON answer, and
// `respond(body, { status: 404 })` anything else. A string body is sent as text.
function respond(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body === undefined ? null : body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!h.has('content-type')) h.set('content-type', typeof body === 'string' ? 'text/plain' : 'application/json');
  return {
    [RESPONSE]: true,
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null),
      has: (k) => h.has(String(k).toLowerCase()) },
    json: async () => JSON.parse(text),   // parsed per call: the chrome can never edit a route's own object
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    blob: async () => new NodeBlob([text], { type: h.get('content-type') }),
    clone: () => respond(body, { status, headers }),
  };
}

// What the chrome reads while it boots and connects, answered quietly. One
// active node, nothing queued, no components, packs, themes, comments, pending
// services or update, a local (not remote) page.
const DEFAULT_ROUTES = Object.freeze({
  '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' },
  '/api/graph/node/*': (url) => ({ id: decodeURIComponent(url.split('?')[0].split('/').pop()), mounts: [], store: {} }),
  '/api/components': { components: [] },
  '/api/packs': { ok: true, packs: [], quarantined: [] },
  '/api/services/pending': { ok: true, pending: [] },
  '/api/themes': { themes: [] },
  '/api/theme*': { name: 'earthy' },
  '/api/queue': { items: [], count: 0 },
  '/api/queue/pending': { pending: null },
  '/api/queue/policy': { channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {},
    parked_delivery: 'held' },
  '/api/comments': { comments: [] },
  '/api/brand': { slots: {}, fill: {}, theme: null },
  '/api/version': { ok: true, current: '0.0.0-test', updateAvailable: false },
  '/api/health': { ok: true, remote: false },
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// One layer's answer for a URL: exact (with the query), then the path alone,
// then the longest matching `*` prefix.
function lookup(table, url) {
  if (has(table, url)) return { hit: table[url] };
  const pathOnly = url.split('?')[0];
  if (has(table, pathOnly)) return { hit: table[pathOnly] };
  let best = null;
  for (const k of Object.keys(table)) {
    if (k.endsWith('*') && url.startsWith(k.slice(0, -1)) && (!best || k.length > best.length)) best = k;
  }
  return best ? { hit: table[best] } : null;
}

// ── media queries ────────────────────────────────────────────────────────────

// Whether one media query holds for the viewport: comma-separated alternatives,
// each a list of `and`-joined features. What the chrome asks (the phone shape,
// the narrow width, the colour scheme, reduced motion) and a little more; an
// unknown feature never matches, as in a browser.
function mediaMatches(query, vp) {
  return String(query).toLowerCase().split(',').some((alt) => {
    let q = alt.trim();
    const negate = /^not\s/.test(q);
    if (negate) q = q.slice(4);
    q = q.replace(/^(only\s+)?(all|screen)(\s+and\s+|\s*$)/, '');
    const features = q.split(/\s+and\s+/).map((f) => f.trim()).filter(Boolean);
    const ok = features.length > 0 && features.every((f) => featureMatches(f, vp));
    return negate ? !ok : ok;
  });
}

function featureMatches(f, vp) {
  const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]*?))?\s*\)$/.exec(f);
  if (!m) return false;
  const [, name, value = ''] = m;
  const px = () => { const n = /^(\d+(?:\.\d+)?)px$/.exec(value); return n ? Number(n[1]) : NaN; };
  const ratio = () => { const r = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(value); return r ? Number(r[1]) / Number(r[2]) : NaN; };
  switch (name) {
    case 'max-width': return vp.width <= px();
    case 'min-width': return vp.width >= px();
    case 'max-height': return vp.height <= px();
    case 'min-height': return vp.height >= px();
    case 'max-aspect-ratio': return vp.width / vp.height <= ratio();
    case 'min-aspect-ratio': return vp.width / vp.height >= ratio();
    case 'orientation': return value === (vp.height >= vp.width ? 'portrait' : 'landscape');
    case 'pointer': case 'any-pointer': return value === (vp.coarse ? 'coarse' : 'fine');
    case 'hover': case 'any-hover': return value === (vp.coarse ? 'none' : 'hover');
    case 'prefers-color-scheme': return value === (vp.dark ? 'dark' : 'light');
    case 'prefers-reduced-motion': return value === (vp.reducedMotion ? 'reduce' : 'no-preference');
    default: return false;
  }
}

const VIEWPORT_KEYS = ['width', 'height', 'dark', 'coarse', 'reducedMotion', 'visualHeight', 'visualTop'];

// ── the boot ─────────────────────────────────────────────────────────────────

let booted = null;      // the promise of THIS file's one shell
let wasRestored = false;

function bootShell(opts) {
  if (wasRestored) throw new Error('bootShell: this file\'s shell has been restored, and a file boots one shell');
  if (booted) {
    if (opts !== undefined) {
      throw new TypeError('bootShell: this file has booted its shell already, and it boots once — '
        + 'call bootShell() with no options to get it, and setRoutes() for a test\'s own answers');
    }
    return booted;
  }
  booted = boot(opts || {});
  return booted;
}

async function boot({ routes = {}, onSocket, init, open = true, url = 'http://localhost:5173/', viewport = {} }) {
  if (!routes || typeof routes !== 'object') throw new TypeError('bootShell: routes must be an object');
  if (onSocket !== undefined && typeof onSocket !== 'function') throw new TypeError('bootShell: onSocket must be a function');
  if (init !== undefined && typeof init !== 'function') throw new TypeError('bootShell: init must be a function');
  for (const k of Object.keys(viewport || {})) {
    if (!VIEWPORT_KEYS.includes(k)) throw new TypeError(`bootShell: unknown viewport key '${k}' (${VIEWPORT_KEYS.join(', ')})`);
  }

  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const W = dom.window;

  const state = {
    booting: true,
    restored: false,
    open,
    sockets: [],
    pending: new Set(),      // tracked timeouts still to fire
    intervals: new Map(),    // stubbed setIntervals: id → { id, fn, ms, args }
    nextInterval: 1,
    bootRoutes: { ...routes },
    overrides: {},
    queries: new Set(),      // every MediaQueryList the chrome made
    viewport: { width: 1280, height: 800, dark: false, coarse: false, reducedMotion: false },
  };
  const calls = [];
  const scrolls = [];

  // timers
  function setTimeoutTracked(fn, ms, ...args) {
    const h = real.setTimeout(function fire(...a) {
      state.pending.delete(h);
      if (typeof fn === 'function') fn.apply(this, a);
    }, ms, ...args);
    state.pending.add(h);
    return h;
  }
  function clearTimeoutTracked(h) {
    state.pending.delete(h);
    real.clearTimeout(h);
  }
  function setIntervalStub(fn, ms, ...args) {
    const id = state.nextInterval++;
    state.intervals.set(id, { id, fn, ms: Number(ms) || 0, args });
    return id;
  }
  function clearIntervalStub(h) {
    if (!state.intervals.delete(h)) real.clearInterval(h);
  }
  const tick = (ms = 25) => new Promise((r) => real.setTimeout(r, ms));
  const later = (fn) => setTimeoutTracked(fn, 0);

  // fetch
  async function fetchShim(input, init = {}) {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    let body = init && init.body !== undefined ? init.body : null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* text, kept as sent */ } }
    calls.push({ url: u, method: String((init && init.method) || 'GET').toUpperCase(), body,
      headers: (init && init.headers) || null });
    const found = lookup(state.overrides, u) || lookup(state.bootRoutes, u) || lookup(DEFAULT_ROUTES, u);
    let v = found ? found.hit : { ok: true };
    if (typeof v === 'function') v = await v(u, init);
    if (v === undefined) v = { ok: true };
    return v && v[RESPONSE] ? v : respond(v);
  }

  // the socket
  class FakeSocket {
    constructor(socketUrl) {
      this.url = String(socketUrl);
      this.readyState = FakeSocket.CONNECTING;
      this.sent = [];
      this.onopen = null;
      this.onclose = null;
      this.onmessage = null;
      this.onerror = null;
      this.autoOpen = state.open;
      state.sockets.push(this);
      if (onSocket) onSocket(this);
      if (this.autoOpen && !state.booting) later(() => this.open());
    }
    send(data) {
      if (this.readyState !== FakeSocket.OPEN) throw new Error('InvalidStateError: send() on a socket that is not open');
      let frame = data;
      try { frame = JSON.parse(data); } catch { /* not JSON: kept as sent */ }
      this.sent.push(frame);
    }
    close() {
      if (this.readyState >= FakeSocket.CLOSING) return;
      this.readyState = FakeSocket.CLOSING;
      later(() => this.drop());
    }
    // ── the test's side of the wire ──
    open() {
      if (this.readyState !== FakeSocket.CONNECTING) return false;
      this.readyState = FakeSocket.OPEN;
      if (this.onopen) this.onopen({ type: 'open' });
      return true;
    }
    drop() {
      if (this.readyState === FakeSocket.CLOSED) return false;
      this.readyState = FakeSocket.CLOSED;
      if (this.onclose) this.onclose({ type: 'close', code: 1006 });
      return true;
    }
    receive(msg) {
      if (this.onmessage) this.onmessage({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    }
    frames(type) {
      return this.sent.filter((f) => !type || (f && f.type === type));
    }
  }
  Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // the viewport: matchMedia, the window's size, the visual viewport
  function matchMedia(query) {
    const listeners = new Set();
    const mql = {
      media: String(query),
      matches: mediaMatches(query, state.viewport),
      onchange: null,
      addEventListener(type, fn) { if (type === 'change' && typeof fn === 'function') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
      addListener(fn) { if (typeof fn === 'function') listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
      dispatchEvent() { return true; },
    };
    state.queries.add({ mql, listeners });
    return mql;
  }
  const visualViewport = new W.EventTarget();
  function applyViewport() {
    const vp = state.viewport;
    for (const [k, v] of [['innerWidth', vp.width], ['innerHeight', vp.height], ['outerWidth', vp.width], ['outerHeight', vp.height]]) {
      Object.defineProperty(W, k, { value: v, configurable: true, writable: true });
    }
    const vh = vp.visualHeight === undefined ? vp.height : vp.visualHeight;
    const vt = vp.visualTop === undefined ? 0 : vp.visualTop;
    Object.assign(visualViewport, { width: vp.width, height: vh, offsetTop: vt, offsetLeft: 0, pageTop: vt, pageLeft: 0, scale: 1 });
  }
  function setViewport(next = {}) {
    for (const k of Object.keys(next)) {
      if (!VIEWPORT_KEYS.includes(k)) throw new TypeError(`setViewport: unknown key '${k}' (${VIEWPORT_KEYS.join(', ')})`);
    }
    const before = { ...state.viewport };
    Object.assign(state.viewport, next);
    applyViewport();
    for (const { mql, listeners } of state.queries) {
      const now = mediaMatches(mql.media, state.viewport);
      if (now === mql.matches) continue;
      mql.matches = now;
      const ev = { type: 'change', matches: now, media: mql.media };
      for (const fn of [...listeners, ...(typeof mql.onchange === 'function' ? [mql.onchange] : [])]) {
        try { fn.call(mql, ev); } catch (e) { console.error('[chrome-shell] a media query listener failed', e); }
      }
    }
    const v = state.viewport;
    if (v.width !== before.width || v.height !== before.height) W.dispatchEvent(new W.Event('resize'));
    if (v.visualHeight !== before.visualHeight || v.width !== before.width || v.height !== before.height) {
      visualViewport.dispatchEvent(new W.Event('resize'));
    }
    if (v.visualTop !== before.visualTop) visualViewport.dispatchEvent(new W.Event('scroll'));
  }

  // layout: scroll metrics and the scroll calls jsdom lacks
  const METRICS = ['scrollHeight', 'scrollWidth', 'clientHeight', 'clientWidth', 'offsetHeight', 'offsetWidth',
    'offsetTop', 'offsetLeft'];
  function scrollMetrics(el, m = {}) {
    for (const k of METRICS) {
      if (has(m, k)) Object.defineProperty(el, k, { configurable: true, get: () => m[k] });
    }
    if (has(m, 'scrollTop')) el.scrollTop = m.scrollTop;
    if (has(m, 'scrollLeft')) el.scrollLeft = m.scrollLeft;
    if (has(m, 'rect')) {
      el.getBoundingClientRect = () => {
        const r = { left: 0, top: 0, width: 0, height: 0, ...m.rect };
        return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
      };
    }
    return m;
  }
  const scrollTarget = (el, a, b, add) => {
    const o = a && typeof a === 'object' ? a : { left: a, top: b };
    if (typeof o.top === 'number') el.scrollTop = (add ? el.scrollTop : 0) + o.top;
    if (typeof o.left === 'number') el.scrollLeft = (add ? el.scrollLeft : 0) + o.left;
  };
  W.Element.prototype.scrollIntoView = function scrollIntoView(arg) { scrolls.push({ el: this, arg }); };
  W.Element.prototype.scrollTo = function scrollTo(a, b) { scrollTarget(this, a, b, false); };
  W.Element.prototype.scrollBy = function scrollBy(a, b) { scrollTarget(this, a, b, true); };
  W.scrollTo = () => {};
  W.scrollBy = () => {};

  W.WebSocket = FakeSocket;
  W.fetch = fetchShim;
  W.matchMedia = matchMedia;
  W.visualViewport = visualViewport;
  W.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));
  Object.assign(state.viewport, viewport);
  applyViewport();

  // the globals: what the modules reach for bare, and what the shell supplies
  const FROM_WINDOW = ['window', 'document', 'location', 'history', 'navigator', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent',
    'InputEvent', 'HTMLElement', 'Element', 'Node', 'ShadowRoot', 'DocumentFragment', 'MutationObserver',
    'DOMParser', 'matchMedia', 'visualViewport'];
  const SUPPLIED = {
    WebSocket: FakeSocket,
    fetch: fetchShim,
    setTimeout: setTimeoutTracked,
    clearTimeout: clearTimeoutTracked,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    requestAnimationFrame: (fn) => setTimeoutTracked(() => fn(W.performance.now()), 0),
    cancelAnimationFrame: (h) => clearTimeoutTracked(h),
  };
  const saved = new Map();   // key → its own property descriptor before the boot (undefined: it had none)
  const put = (k, v) => {
    if (!saved.has(k)) saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: false });
  };
  for (const k of FROM_WINDOW) put(k, W[k]);
  for (const [k, v] of Object.entries(SUPPLIED)) put(k, v);

  function restoreGlobals() {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }

  let restoring = null;
  function restore() {
    if (restoring) return restoring;
    restoring = (async () => {
      await tick();   // what the last test set in motion settles on the live realm first
      state.restored = true;
      wasRestored = true;
      state.intervals.clear();
      for (const h of state.pending) real.clearTimeout(h);
      state.pending.clear();
      try { W.close(); } catch { /* already gone */ }
      for (const h of state.pending) real.clearTimeout(h);
      state.pending.clear();
      restoreGlobals();
    })();
    return restoring;
  }

  const socket = () => state.sockets[state.sockets.length - 1] || null;
  const shell = {
    window: W,
    document: W.document,
    $: (id) => W.document.getElementById(id),
    calls,
    scrolls,
    sockets: state.sockets,
    socket,
    async frame(msg) {
      const s = socket();
      if (!s) throw new Error('bootShell: the chrome has not opened a socket');
      s.receive(msg);
      await tick();
    },
    setRoutes(next) {
      if (next !== undefined && (!next || typeof next !== 'object')) throw new TypeError('setRoutes: expects an object');
      state.overrides = { ...(next || {}) };
    },
    intervals: () => [...state.intervals.values()],
    scrollMetrics,
    setViewport,
    importApp(rel) {
      if (typeof rel !== 'string' || !/^[\w-]+(\/[\w-]+)*\.js$/.test(rel)) {
        throw new TypeError(`importApp: '${rel}' is not a module path under public/app`);
      }
      return import(pathToFileURL(path.join(REPO, 'public/app', rel)).href);
    },
    tick,
    click(el) { el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); },
    // A real click is pointerdown THEN click: the shell's dismiss layer runs on
    // the first and the target's own toggle on the second, and a test that only
    // fires `click` cannot see the ordering bugs that live between them.
    press(el) {
      el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
      shell.click(el);
    },
    key(k, { target, ...init } = {}) {
      const e = new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...init });
      (target || W.document).dispatchEvent(e);
      return e;
    },
    restore,
    get restored() { return state.restored; },
  };

  try {
    await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
    if (init) await init(shell);
    state.booting = false;
    const first = state.sockets[0];
    if (first && first.autoOpen) first.open();
    await tick();
  } catch (e) {
    await restore();
    throw e;
  }
  return shell;
}

// The frame every (re)connection opens with, as the daemon sends it: one live
// node, an empty surface. Pass what a test needs on top.
function helloFrame(overrides = {}) {
  return { type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: [], ...overrides };
}

module.exports = { bootShell, helloFrame, respond, DEFAULT_ROUTES };
