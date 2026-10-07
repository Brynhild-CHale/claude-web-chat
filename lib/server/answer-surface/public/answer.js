// The answer frame's runtime (spec §4.4, §4.5): the one script of a document
// on the answer origin, which a pane can neither script nor read. It draws a
// blocking prompt beside its own buttons, decides whether a click may answer
// it, and posts the answer to the answer surface (lib/server/answer-surface).
//
// It reads what it is from the page: the kind ({{KIND}}, on <html data-kind>),
// the id or path and the query (layout, mode, device) from its URL, the nonce
// from <meta name="wc-answer-nonce">. Then it dispatches on kind and layout:
//   ask      bar · card · sheet · page, drawn by answer-view.js (below)
//   <kind>   any other layout is a module of its own, loaded by name,
//            ./<kind>-<layout>.js, whose mount(rt) gets the runtime below —
//            U85's control layouts (`control-stop.js`, `control-confirm.js`)
//            are added that way, never by copying a guard.
//
// THE GUARDS (createGuard, over answer-gate.js's pure machine): the visibility
// proof (IntersectionObserver v2 on one container holding the subject and the
// buttons, 500 ms), the fit rule, the 300 ms pointer dwell, the 600 ms content
// cooldown and the keyboard rule; and before EVERY POST, event.isTrusted and
// navigator.userActivation.isActive. Without IntersectionObserver v2 the
// answering buttons of a framed layout become `Review & answer ↗`, which opens
// this prompt's page layout in a popup no pane can overlay (item 6).
//
// THE MESSAGES (item 10). Out, to window.parent only: wc-answer:size {height}
// (22-480, on every change), wc-answer:done {id, outcome, result?} (`result`:
// counts only, ≤ 2 KB, never a restore id or a command) and wc-answer:open-chat
// {id}. In, from window.parent only: wc-answer:mode {mode}, which sets
// data-mode. Every other message is ignored. The outbound messages are hints
// with nothing in them a page could use, so they go to '*': the frame cannot
// know its parent's origin (no referrer), and frame-ancestors already limits
// who that parent can be.
import { createGate, fits, COVERED } from './answer-gate.js';
import { renderAsk, whyNotWords, outcomeWords } from './answer-view.js';

export const SIZE_MIN = 22;
export const SIZE_MAX = 480;
export const POPUP_FEATURES = 'popup,width=460,height=600';
export const VIEW_WAIT_MS = 20000;
export const RESULT_MAX_BYTES = 2048;
const ASK_LAYOUTS = new Set(['bar', 'card', 'sheet', 'page']);
const MODES = new Set(['light', 'dark']);
const DEVICES = new Set(['desktop', 'mobile']);
const NAME_RE = /^[a-z][a-z-]{0,23}$/;
const NAV_RECENT_MS = 1000;
const RETRY_MS = [1000, 2000, 5000, 10000];

export const clampSize = (h) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.ceil(Number(h) || 0)));

// Chromium's IntersectionObserver v2: the visibility proof exists.
export function hasVisibilityProof(win) {
  try {
    return !!(win.IntersectionObserver && win.IntersectionObserverEntry
      && 'isVisible' in win.IntersectionObserverEntry.prototype);
  } catch { return false; }
}

// A click may reach a POST only if the browser made it and the user is active.
export function userActive(win) {
  const ua = win.navigator && win.navigator.userActivation;
  return !!(ua && ua.isActive === true);
}

// What this document is, from its own URL and markup.
export function readContext(win) {
  const doc = win.document;
  const url = new URL(win.location.href);
  const q = url.searchParams;
  const m = /^\/answer\/([a-z][a-z-]{0,23})(?:\/(.*))?$/.exec(url.pathname);
  const pathKind = m ? m[1] : null;
  let rest = '';
  try { rest = m && m[2] ? decodeURIComponent(m[2]) : ''; } catch { rest = ''; }
  const declared = doc.documentElement.getAttribute('data-kind');
  const kind = declared && NAME_RE.test(declared) ? declared : pathKind;
  const meta = doc.querySelector('meta[name="wc-answer-nonce"]');
  const mode = MODES.has(q.get('mode')) ? q.get('mode') : (MODES.has(doc.documentElement.dataset.mode) ? doc.documentElement.dataset.mode : 'light');
  return {
    kind,
    rest,
    id: kind === 'ask' ? rest : (q.get('id') || rest),
    layout: q.get('layout') || (kind === 'ask' ? 'card' : ''),
    mode,
    device: DEVICES.has(q.get('device')) ? q.get('device') : 'desktop',
    query: Object.fromEntries(q),
    nonce: meta ? meta.getAttribute('content') || '' : '',
  };
}

// A content-free result: a plain object of numbers and booleans, ≤ 2 KB.
export function cleanResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(k)) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  if (!Object.keys(out).length) return undefined;
  return JSON.stringify(out).length <= RESULT_MAX_BYTES ? out : undefined;
}

// ── the messages ────────────────────────────────────────────────────────────
export function createMessenger(win) {
  const doc = win.document;
  const framed = () => !!win.parent && win.parent !== win;
  let lastSize = null;
  const post = (msg) => {
    if (!framed()) return false;
    try { win.parent.postMessage(msg, '*'); return true; } catch { return false; }
  };
  const onMessage = (e) => {
    if (!framed() || e.source !== win.parent) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'wc-answer:mode') return;
    if (MODES.has(d.mode)) doc.documentElement.dataset.mode = d.mode;
  };
  win.addEventListener('message', onMessage);
  return {
    framed,
    size(height, { force = false } = {}) {
      const h = clampSize(height);
      if (!force && h === lastSize) return false;
      lastSize = h;
      return post({ type: 'wc-answer:size', height: h });
    },
    done(id, outcome, result) {
      const msg = { type: 'wc-answer:done', id: String(id || ''), outcome: String(outcome || '') };
      const r = cleanResult(result);
      if (r) msg.result = r;
      return post(msg);
    },
    openChat(id) { return post({ type: 'wc-answer:open-chat', id: String(id || '') }); },
    stop() { win.removeEventListener('message', onMessage); },
  };
}

// ── the guard: answer-gate.js wired to the browser ─────────────────────────
//   createGuard(rt, { box, subjects, proof, fit, measureDoc, complete, onChange })
//   → { allows(event, {acting}), rebind(box, subjects), content(), measure(),
//       state(), destroy() }
// `box` is the one container the proof observes; `subjects()` the elements the
// fit rule measures; `complete()` the display view's flag. onChange(state)
// runs whenever what the buttons should show may have changed.
export function createGuard(rt, {
  box, subjects = () => [], proof = rt.proof, fit = true, measureDoc = true,
  complete = () => true, onChange = () => {},
} = {}) {
  const { win } = rt;
  const doc = win.document;
  const de = doc.documentElement;
  const gate = createGate({ now: rt.now, proof, fit });
  let target = box;
  let io = null;
  let ro = null;
  let wake = null;
  let lastNav = null;       // { how: 'tab'|'pointer', at }
  const offs = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); offs.push(() => el.removeEventListener(type, fn, opts)); };

  function update() {
    if (wake !== null) { win.clearTimeout(wake); wake = null; }
    const st = gate.state();
    try { onChange(st); } catch (e) { console.error('[web-chat answer] a guard listener failed', e); }
    const ms = gate.wakeIn();
    if (ms !== null) wake = win.setTimeout(update, ms + 5);
    return st;
  }
  function measure() {
    if (!fit) return gate.state();
    const m = (el) => (el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null);
    const ok = fits({
      doc: measureDoc ? { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, innerWidth: win.innerWidth, innerHeight: win.innerHeight } : null,
      subjects: (subjects() || []).map(m),
      complete: complete() === true,
    });
    gate.setFit(ok);
    return gate.state();
  }
  function observe() {
    if (io) { io.disconnect(); io = null; }
    if (!proof || !target) return;
    io = new win.IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === target) gate.observe(e);
      update();
    }, { trackVisibility: true, delay: 100, threshold: [1] });
    io.observe(target);
  }

  // Item 3: when the pointer entered. Any pointer event inside the frame says
  // it is here; leaving the document says it is not.
  const entered = () => gate.pointerEnter();
  on(doc, 'pointerover', entered, true);
  on(doc, 'pointermove', entered, true);
  on(de, 'pointerleave', () => gate.pointerLeave());
  // Item 5: how focus arrived.
  on(doc, 'keydown', (e) => { if (e.key === 'Tab') lastNav = { how: 'tab', at: rt.now() }; }, true);
  on(doc, 'pointerdown', () => { lastNav = { how: 'pointer', at: rt.now() }; }, true);
  on(doc, 'focusin', () => {
    const recent = lastNav && rt.now() - lastNav.at <= NAV_RECENT_MS ? lastNav.how : 'other';
    gate.focusArrived(recent);
  });
  on(doc, 'focusout', (e) => { if (!e.relatedTarget) gate.blurred(); });
  // Item 4: the content cooldown.
  on(doc, 'visibilitychange', () => { if (doc.visibilityState === 'visible') { gate.content(); update(); } });
  on(win, 'focus', () => { gate.content(); update(); });
  on(win, 'resize', () => { measure(); update(); });
  if (typeof win.ResizeObserver === 'function') {
    ro = new win.ResizeObserver(() => { measure(); update(); });
    ro.observe(de);
  }

  observe();
  gate.content();
  measure();
  update();

  return {
    allows(e, { acting = true } = {}) {
      if (!e || e.isTrusted !== true) return false;
      if (!userActive(win)) return false;
      measure();
      return gate.allows({ acting, keyboard: e.detail === 0 });
    },
    // A new ask version drawn into a new container: the proof starts again,
    // and the cooldown runs.
    rebind(nextBox) {
      target = nextBox;
      gate.reset();
      observe();
      gate.content();
      measure();
      return update();
    },
    content() { gate.content(); return update(); },
    measure() { measure(); return update(); },
    state: () => gate.state(),
    gate,
    destroy() {
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      if (wake !== null) win.clearTimeout(wake);
      for (const off of offs.splice(0)) off();
    },
  };
}

// ── fetch ───────────────────────────────────────────────────────────────────
async function call(rt, url, { method = 'GET', body } = {}) {
  const headers = { 'X-WC-Answer': rt.nonce };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await rt.win.fetch(url, init);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, ok: res.ok, body: json };
}

// The URL of this prompt in another layout (the popup's `page`).
function layoutUrl(rt, layout) {
  const u = new URL(rt.win.location.href);
  u.searchParams.set('layout', layout);
  u.searchParams.set('mode', rt.win.document.documentElement.dataset.mode || rt.mode);
  u.searchParams.set('device', rt.device);
  return u.pathname + u.search;
}

// ── the ask ─────────────────────────────────────────────────────────────────
function mountAsk(rt) {
  const { win, main, id, layout } = rt;
  const doc = win.document;
  const top = win.top === win;
  // The page layout in a top-level window cannot be overlaid; anywhere else
  // (a frame, the page layout framed by someone) every rule applies.
  const needsProof = !(layout === 'page' && top);
  // Where the proof is needed but the browser has none, the answering
  // buttons are the popup's (item 6), so no click here ever decides.
  const popup = needsProof && !rt.proof;
  const proof = needsProof && rt.proof;
  const fitDoc = layout !== 'page';
  let view = null;
  let drawn = null;           // renderAsk's answer
  let guard = null;
  let busy = false;
  let stopped = false;
  let barUnfit = null;        // the version the bar found its subject cut at (sticky: no flapping)
  let note = null;            // a sentence that outlives a redraw (a refusal)

  const statusOnly = (words) => {
    if (guard) { guard.destroy(); guard = null; }
    drawn = null;
    const p = doc.createElement('p');
    p.className = 'aw-status aw-alone';
    p.textContent = words;
    main.replaceChildren(p);
    sendSize();
  };

  function sendSize() {
    if (layout === 'bar') return rt.post.size(SIZE_MIN);
    const r = main.getBoundingClientRect();
    return rt.post.size(r && r.height ? r.height : main.scrollHeight);
  }

  function paint(st) {
    if (!drawn) return;
    const unfit = !st.fit;
    if (layout === 'bar') {
      if (unfit && view) barUnfit = view.version;
      drawn.root.dataset.fit = barUnfit !== null && view && barUnfit === view.version ? '0' : '1';
    } else {
      drawn.root.dataset.fit = unfit ? '0' : '1';
    }
    for (const c of drawn.controls) {
      if (c.act !== 'decide') continue;
      const on = !busy && st.enabled && (!c.acting || st.fit);
      c.el.setAttribute('aria-disabled', String(!on));
    }
    const covered = st.reason === 'covered';
    drawn.root.dataset.guard = st.reason || 'ok';
    if (layout === 'bar') {
      drawn.box.title = covered ? COVERED : '';
    } else if (guardLine) {
      guardLine.textContent = covered ? COVERED : '';
      guardLine.hidden = !covered;
    }
    sendSize();
  }

  let guardLine = null;
  function render(next) {
    view = next;
    drawn = renderAsk(doc, view, { layout, popup });
    guardLine = null;
    if (layout !== 'bar') {
      guardLine = doc.createElement('p');
      guardLine.className = 'aw-guard';
      guardLine.hidden = true;
      guardLine.setAttribute('role', 'status');
      drawn.box.append(guardLine);
    }
    if (note) { drawn.problem(note); }
    main.replaceChildren(drawn.root);
    drawn.root.addEventListener('click', onClick);
    const opts = {
      box: drawn.box,
      subjects: () => (drawn ? drawn.subjects : []),
      proof,
      fit: true,
      measureDoc: fitDoc,
      complete: () => !!(view && view.complete === true),
      onChange: paint,
    };
    // A redraw is a new container: the proof starts again and the cooldown runs
    // (item 4: a new ask or version). The subjects and the completeness are
    // read through the closures above.
    if (!guard) guard = createGuard(rt, opts);
    else guard.rebind(drawn.box);
    paint(guard.state());
  }

  function onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn || !drawn) return;
    const c = drawn.controls.find((x) => x.el === btn);
    if (!c) return;
    if (c.act === 'popup' || c.act === 'review') {
      if (e.isTrusted !== true) return;
      if (c.act === 'review' && layout === 'bar') { rt.post.openChat(id); return; }
      win.open(layoutUrl(rt, 'page'), '_blank', POPUP_FEATURES);
      return;
    }
    if (c.act === 'chat') {
      if (e.isTrusted !== true) return;
      rt.post.openChat(id);
      return;
    }
    if (c.act !== 'decide' || busy || !guard) return;
    // Items 1-5 and 7, at the moment of the click.
    if (!guard.allows(e, { acting: c.acting })) return;
    const decision = drawn.decisionOf(btn);
    if (!decision) return;
    decide(decision);
  }

  async function decide(decision) {
    busy = true;
    note = null;
    if (guard) paint(guard.state());
    let r;
    try {
      r = await call(rt, `/answer/api/asks/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: { decision, version: view.version, device: rt.device },
      });
    } catch {
      r = null;
    }
    busy = false;
    if (stopped) return;
    if (r && r.ok && r.body && r.body.ok) {
      const outcome = r.body.outcome;
      statusOnly(layout === 'page' ? `${outcomeWords(outcome) || 'Answered'} — you can close this window` : outcomeWords(outcome) || 'Answered');
      rt.post.done(id, outcome);
      return;
    }
    if (r && r.status === 409) {
      // Lost to the terminal, or the request changed under the click: show
      // what it is now.
      await refresh();
      return;
    }
    if (r && r.status === 403 && r.body && r.body.refused) {
      note = 'This prompt’s page has expired: open it again from the chat';
    } else if (r && r.status === 400) {
      note = 'That answer was refused — answer in the terminal';
    } else {
      note = 'Could not reach web-chat — answer in the terminal';
    }
    if (drawn) { drawn.problem(note); if (guard) paint(guard.state()); }
  }

  async function fetchView(v) {
    const qs = v === null || v === undefined ? '' : `?v=${encodeURIComponent(v)}&wait=${VIEW_WAIT_MS}`;
    return call(rt, `/answer/api/asks/${encodeURIComponent(id)}${qs}`);
  }

  function show(r) {
    if (r.status === 200 && r.body && r.body.id) { render(r.body); return 'ok'; }
    if (r.status === 404) { statusOnly('This prompt is no longer waiting'); return 'stop'; }
    if (r.status === 403) { statusOnly('This prompt’s page has expired: open it again from the chat'); return 'stop'; }
    return 'retry';
  }

  async function refresh() {
    let r;
    try { r = await fetchView(null); } catch { r = { status: 0 }; }
    if (!stopped) show(r);
  }

  async function loop() {
    let failures = 0;
    let first = true;
    while (!stopped) {
      let r;
      try { r = await fetchView(first ? null : view && view.version); } catch { r = { status: 0 }; }
      if (stopped) return;
      const was = view;
      let out;
      if (r.status === 200 && r.body && r.body.id && was && r.body.version === was.version && r.body.state === was.state) {
        out = 'ok';        // the long-poll ran out with nothing new
      } else {
        out = show(r);
      }
      if (out === 'stop') return;
      if (out === 'retry') {
        if (first && !view) statusOnly('Connecting to web-chat…');
        await new Promise((res) => win.setTimeout(res, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]));
        failures += 1;
        continue;
      }
      failures = 0;
      first = false;
      if (view && view.state !== 'pending') return;    // nothing more will change here
    }
  }

  statusOnly('Loading…');
  if (!ASK_LAYOUTS.has(layout)) { statusOnly('This layout does not exist'); return { stop() {} }; }
  if (!id || !rt.nonce) { statusOnly('This prompt is no longer waiting'); return { stop() {} }; }
  const running = loop();
  return {
    running,
    stop() { stopped = true; if (guard) guard.destroy(); },
    get view() { return view; },
  };
}

// ── boot ────────────────────────────────────────────────────────────────────
// boot(win) runs once per document (the module's last line, in a browser).
// `now` is for the tests' clock; nothing else can call this in the frame's
// realm, which no pane can script.
export async function boot(win, { now = () => win.performance.now() } = {}) {
  const doc = win.document;
  const ctx = readContext(win);
  doc.documentElement.dataset.mode = ctx.mode;
  if (ctx.layout && NAME_RE.test(ctx.layout)) doc.documentElement.dataset.layout = ctx.layout;
  let main = doc.getElementById('wc-answer');
  if (!main) {
    main = doc.createElement('main');
    main.id = 'wc-answer';
    main.className = 'wc-answer';
    doc.body.append(main);
  }
  const post = createMessenger(win);
  const rt = Object.freeze({
    win, doc, main, now, post,
    kind: ctx.kind, id: ctx.id, rest: ctx.rest, query: ctx.query, layout: ctx.layout, mode: ctx.mode,
    device: ctx.device, nonce: ctx.nonce,
    proof: hasVisibilityProof(win),
    framed: post.framed(),
    meta: (name) => { const m = doc.querySelector(`meta[name="${String(name).replace(/[^a-z0-9-]/g, '')}"]`); return m ? m.getAttribute('content') : null; },
    createGuard: (opts) => createGuard(rt, opts),
    api: (path, opts) => call(rt, `/answer/api/${ctx.kind}/${String(path || '').replace(/^\/+/, '')}`, opts),
    layoutUrl: (layout) => layoutUrl(rt, layout),
    popup: (layout = 'page') => win.open(layoutUrl(rt, layout), '_blank', POPUP_FEATURES),
  });
  // A size first, whatever comes next: the chrome's 3 s load check (item 10).
  post.size(ctx.layout === 'bar' ? SIZE_MIN : main.scrollHeight, { force: true });
  if (ctx.kind === 'ask') return { rt, ...mountAsk(rt) };
  // Another kind's layout is a module of its own.
  if (!ctx.kind || !NAME_RE.test(ctx.kind) || !NAME_RE.test(ctx.layout || '')) {
    main.textContent = 'This control is not available here';
    return { rt, stop() {} };
  }
  try {
    const mod = await import(`./${ctx.kind}-${ctx.layout}.js`);
    const handle = (mod && typeof mod.mount === 'function' ? mod.mount(rt) : null) || {};
    return { rt, ...handle, stop: typeof handle.stop === 'function' ? handle.stop : () => {} };
  } catch (e) {
    main.textContent = 'This control is not available here';
    post.size(main.scrollHeight);
    return { rt, stop() {}, error: e };
  }
}

// In the frame's own document only: a page that declares its kind.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document
  && document.documentElement && document.documentElement.hasAttribute('data-kind')) {
  boot(window);
}

export { whyNotWords };
