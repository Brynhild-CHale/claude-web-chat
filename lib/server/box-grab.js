'use strict';
// The box grab, daemon side (PLAN 2C.4; DECISIONS.md I box-grabs@2C.4; U328b).
//
// The user draws a box on the surface (the chrome half, U328c) and the element
// API (lib/server/routes/elements.js) hands the POST here. This module turns it
// into three things:
//
//   1. ONE box-grab@1 version in the element log, through the log's one writer
//      (graph.elements addElement — appendVersion redacts every text in it):
//      {anchor, shared: true, rect, meta, grab: {capture: 'cap<n>'}}.
//      admit() shapes the payload the route appends: the anchor is a PAGE
//      record {v: 1, kind: 'page', item, mount, rect, viewport} that the
//      engine never resolves (C5; F6 (a): nothing is drawn on the page after
//      the grab is sent; lib/core/anchors.js has no page kind and
//      anchors-src kindsOf adds none for it); the meta is completed here —
//      the pane's last SCRIPT_ERRORS_MAX `script-error` events from the ring
//      and the active global theme's name — over the chrome's item_path,
//      element_path, clipped html, mode and viewport (a closed shape: any
//      other key is dropped); a grab is always shared (F5 (a)), and the capture
//      id is reserved first, so the one version names it.
//   2. ONE capture record (domain/captures createCapture, the one writer),
//      built from the STORED, redacted version, never the request body:
//      {kind: 'box-grab', source: 'element:box-grab', url: 'element:<id>',
//      distilled: {element, v, anchor, rect, meta less its html, html_chars},
//      raw (captures/cap<n>.html): the clipped outerHTML, image}. It raises no
//      capture item and bumps no tab_capture: the grab's one queue item is the
//      element item (F6 (a)).
//   3. THE PICTURE, off the request: the live surface as the export path draws
//      it (lib/server/export buildExportHtml(ctx, 'live', now, {mode})), loaded
//      into the export path's headless Chrome (lib/replay/chrome captureClip,
//      found by lib/replay/find findChrome) at the viewer's viewport, scrolled
//      to the anchored item and clipped to the rect, measured from that item's
//      box. One PNG, captures/cap<n>.png, the ONE file the chrome shows the user
//      (GET /api/elements/:id/grab) and Claude reads (inspect_capture's image
//      block, F4 (a)) — no second render, no resize, no re-encode. The capture's
//      image goes pending → {state: 'ready', width, height, bytes, sha256} |
//      {state: 'chrome-not-found', hint} | {state: 'failed', error} (a render
//      not done in RENDER_TIMEOUT_MS fails). Only then is the element event
//      with op 'grab' emitted, carrying the image block, which the wake policy
//      turns into the grab's element queue item (lib/channel/policy
//      elementItem): the item exists only once there is a picture, or the
//      reason there is none, for the user to see before Push (B2's note).
//
// One render at a time, at most RENDER_QUEUE_MAX admitted and unsettled (the
// one in flight included); admit() answers 429 with a hint past that. A render
// in flight when the HTTP server closes is aborted (the request's server
// 'close' — the daemon's stop and its graceful shutdown both close it), and
// lib/replay/chrome's own exit hook and timeout bound it in every other case.
//
// SEAMS (tests; setSeams(state, {...})): findChrome, captureImpl (captureClip's
// signature), timeoutMs.
//
// C-15-1..3: nothing here is a security boundary; the writer stamp is the
// element API's, and the picture is gated as the element's own read (F5 (a):
// from the type's see level, read).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findChrome, CHROME_HINT } = require('../replay/find');
const { captureClip } = require('../replay/chrome');
const { sweepStaleTmp } = require('../replay/tmp');
const { pngSize } = require('../core/png');
const { projectPaths } = require('../core/paths');
const { globalThemeRecord, globalThemeFiles, STOCK_THEME } = require('../core/theme-identity');
const { allocateCapture, createCapture } = require('./domain/captures');
const { emitElements, elementEvent } = require('./domain/comments');
const { refOf } = require('./domain/element-refs');

const TYPE = 'box-grab';
const SOURCE = 'element:box-grab';
const RENDER_TIMEOUT_MS = 30000;
const RENDER_QUEUE_MAX = 4;
const SCRIPT_ERRORS_MAX = 5;
const HTML_MAX = 20000;
const PATH_MAX = 1000;
const ITEM_MAX = 256;
const MESSAGE_MAX = 300;
const STACK_HEAD_MAX = 300;
const STACK_HEAD_LINES = 3;
const CLIP_MAX = 4096;
const VIEWPORT = Object.freeze({ min: 200, max: 4096, w: 1280, h: 800 });

const BUSY_HINT = 'the daemon is still drawing earlier box grabs; wait for their pictures, then grab again';
const ANCHOR_HINT = 'a box grab is anchored to the page: {v: 1, kind: "page", item, mount, rect, viewport}, or null with rect.item';
const RECT_HINT = 'rect is {x, y, w, h, item, viewport}: numbers in CSS px, measured from the item\'s box, w and h above 0';
const PRIVATE_HINT = 'a box grab is always shared: it exists to reach Claude (delete it instead)';
const FIXED_HINT = 'a box grab is a picture of what was on screen; draw a new one instead of editing it';
const FAILED_HINT = 'the box grab\'s picture could not be drawn; its metadata still reached the capture';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Test seams, per daemon (keyed by its live state).
const seamsOf = new WeakMap();
function setSeams(state, seams) { seamsOf.set(state, { ...(seamsOf.get(state) || {}), ...seams }); }

// The engine of one daemon, made on its first grab and kept with its state.
const engines = new WeakMap();
function boxGrabFor(ctx) {
  if (!engines.has(ctx.state)) engines.set(ctx.state, createBoxGrab(ctx));
  return engines.get(ctx.state);
}

// The viewer's viewport: {w, h} (and mobile when said), clamped.
function viewportOf(...cands) {
  const v = cands.find((c) => isObj(c) && finite(c.w) && finite(c.h));
  if (!v) return { w: VIEWPORT.w, h: VIEWPORT.h };
  const out = { w: clamp(Math.round(v.w), VIEWPORT.min, VIEWPORT.max), h: clamp(Math.round(v.h), VIEWPORT.min, VIEWPORT.max) };
  if (v.mobile === true) out.mobile = true;
  return out;
}

// The active global theme's name (the project's, the user tier's, the
// project's default pack, else the stock look) — the name, never its tokens.
function themeName(root) {
  try {
    const rec = globalThemeRecord(globalThemeFiles(root));
    return rec && typeof rec.name === 'string' && rec.name ? rec.name : STOCK_THEME;
  } catch { return STOCK_THEME; }
}

function stackHead(stack) {
  if (typeof stack !== 'string' || !stack) return null;
  return stack.split('\n').slice(0, STACK_HEAD_LINES).join('\n').slice(0, STACK_HEAD_MAX);
}

function createBoxGrab(ctx) {
  const { state, bus, graph } = ctx;
  const paths = () => ctx.paths;
  const root = () => ctx.root || (ctx.paths && ctx.paths.root);
  const seams = () => seamsOf.get(state) || {};

  const waiting = [];
  let inFlight = null;
  let reserved = 0;
  let stopped = false;
  const watched = new WeakSet();

  const load = () => (inFlight ? 1 : 0) + waiting.length + reserved;

  // A request's own HTTP server: a render in flight is aborted when it closes.
  function watch(req) {
    const server = req && req.socket && req.socket.server;
    if (!server || typeof server.once !== 'function' || watched.has(server)) return;
    watched.add(server);
    server.once('close', () => stop());
  }

  // The pane's last script errors, from the ring: message and stack head.
  function scriptErrors(mount) {
    if (!mount || !bus || typeof bus.read !== 'function') return [];
    let events = [];
    try { events = bus.read({ kinds: ['script-error'] }).events || []; } catch { events = []; }
    return events.filter((e) => e && e.id === mount).slice(-SCRIPT_ERRORS_MAX).map((e) => {
      const out = { message: String(e.message || '').slice(0, MESSAGE_MAX) };
      const head = stackHead(e.stack);
      if (head) out.stack = head;
      return out;
    });
  }

  // admit({payload, anchor}, req) → {ok: true, payload, ticket} | {ok: false, status, body}.
  // The payload the route appends (one version); the ticket holds the
  // reserved capture id and a render slot until created() or release().
  function admit({ payload = {}, anchor = null } = {}, req = null) {
    if (stopped) return { ok: false, status: 503, body: { ok: false, error: 'the daemon is stopping', hint: BUSY_HINT } };
    watch(req);
    const p = isObj(payload) ? payload : {};
    if (p.shared === false) return { ok: false, status: 400, body: { ok: false, error: 'a box grab cannot be private', hint: PRIVATE_HINT } };
    if (anchor != null && !(isObj(anchor) && anchor.kind === 'page')) {
      return { ok: false, status: 400, body: { ok: false, error: 'a box grab takes a page anchor', hint: ANCHOR_HINT } };
    }
    const r = isObj(p.rect) ? p.rect : (isObj(anchor) && isObj(anchor.rect) ? anchor.rect : null);
    if (!r || ![r.x, r.y, r.w, r.h].every(finite) || r.w <= 0 || r.h <= 0) {
      return { ok: false, status: 400, body: { ok: false, error: 'a box grab needs its rect', hint: RECT_HINT } };
    }
    const item = str(isObj(anchor) && anchor.item, ITEM_MAX) || str(r.item, ITEM_MAX);
    if (!item) return { ok: false, status: 400, body: { ok: false, error: 'a box grab names the page item it was drawn on', hint: ANCHOR_HINT } };
    if (load() >= RENDER_QUEUE_MAX) return { ok: false, status: 429, body: { ok: false, error: 'too many box grabs rendering', hint: BUSY_HINT } };

    const meta = isObj(p.meta) ? p.meta : {};
    const viewport = viewportOf(isObj(anchor) && anchor.viewport, r.viewport, meta.viewport);
    const rect = {
      x: Math.round(r.x), y: Math.round(r.y),
      w: clamp(Math.round(r.w), 1, CLIP_MAX), h: clamp(Math.round(r.h), 1, CLIP_MAX),
      item, viewport,
    };
    const mount = str(isObj(anchor) && anchor.mount, ITEM_MAX) || (state.mounts && state.mounts.has(item) ? item : null);
    const page = { v: 1, kind: 'page', item, mount, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, viewport };
    const html = typeof meta.html === 'string' ? meta.html.slice(0, HTML_MAX) : '';
    const fullMeta = {
      item_path: str(meta.item_path, PATH_MAX),
      element_path: str(meta.element_path, PATH_MAX),
      html,
      theme: themeName(root()),
      mode: meta.mode === 'dark' || meta.mode === 'light' ? meta.mode : null,
      viewport,
      script_errors: scriptErrors(mount || item),
    };
    const capture = allocateCapture(state);
    reserved++;
    let open = true;
    const ticket = {
      capture,
      release() { if (open) { open = false; reserved--; } },
    };
    return {
      ok: true,
      ticket,
      payload: { anchor: page, shared: true, rect, meta: fullMeta, grab: { capture: capture.id } },
    };
  }

  // The version is in the log: build its capture from the STORED record (its
  // text masked by the log's views) and queue its render.
  function created(rec, ticket) {
    ticket.release();
    const meta = isObj(rec.meta) ? rec.meta : {};
    const { html = '', ...rest } = meta;
    const made = createCapture(state, bus, paths(), {
      id: ticket.capture.id,
      seq: ticket.capture.seq,
      source: SOURCE,
      url: `element:${rec.id}`,
      title: '',
      profile: TYPE,
      distilled: {
        kind: TYPE, element: rec.id, v: rec.v, anchor: rec.anchor, rect: rec.rect,
        meta: rest, html_chars: typeof html === 'string' ? html.length : 0,
      },
      raw: typeof html === 'string' ? html : '',
      extra: { kind: TYPE, image: { state: 'pending' } },
    });
    const job = {
      rec,
      capture: ticket.capture.id,
      record: made.ok ? made.record : null,
      item: rec.rect && rec.rect.item,
      clip: rec.rect,
      viewport: rec.rect && rec.rect.viewport,
      mode: meta.mode === 'dark' || meta.mode === 'light' ? meta.mode : null,
    };
    if (!made.ok) {
      settle(job, { state: 'failed', error: made.error });
      return;
    }
    waiting.push(job);
    pump();
  }

  function pump() {
    if (inFlight || stopped || !waiting.length) return;
    const job = waiting.shift();
    inFlight = job;
    render(job).then((image) => settle(job, image), (e) => settle(job, { state: 'failed', error: (e && e.message) || 'render failed' }))
      .finally(() => { inFlight = null; pump(); });
  }

  async function render(job) {
    const s = seams();
    const chromePath = (s.findChrome || findChrome)({ env: process.env });
    if (!chromePath) return { state: 'chrome-not-found', hint: CHROME_HINT };
    const timeoutMs = Number.isFinite(s.timeoutMs) ? s.timeoutMs : RENDER_TIMEOUT_MS;
    const tmpDir = projectPaths(root()).tmp;
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    sweepStaleTmp(tmpDir);
    // Required here, not at the top: export.js pulls the preview and the
    // runtime sources, which a daemon that never grabs does not need.
    const { buildExportHtml } = require('./export');
    const built = buildExportHtml({ graph, paths: paths(), root: root() }, 'live', new Date(), { mode: job.mode });
    if (built.error) return { state: 'failed', error: built.error };
    const ac = new AbortController();
    job.abort = () => ac.abort();
    let timedOut = false;
    let timer = null;
    const gate = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      ac.signal.addEventListener('abort', () => reject(new Error(timedOut
        ? `the grab did not render within ${Math.round(timeoutMs / 1000)} s`
        : 'the render was cancelled')), { once: true });
    });
    gate.catch(() => {});
    const vp = job.viewport || { w: VIEWPORT.w, h: VIEWPORT.h };
    let out;
    try {
      const running = Promise.resolve((s.captureImpl || captureClip)({
        chromePath, html: built.html, width: vp.w, height: vp.h, mobile: vp.mobile === true,
        colorScheme: job.mode, item: job.item, clip: { x: job.clip.x, y: job.clip.y, w: job.clip.w, h: job.clip.h },
        tmpDir, timeoutMs, signal: ac.signal,
      }));
      running.catch(() => {});
      out = await Promise.race([running, gate]);
    } catch (e) {
      return { state: 'failed', error: timedOut ? `the grab did not render within ${Math.round(timeoutMs / 1000)} s` : ((e && e.message) || 'render failed') };
    } finally {
      clearTimeout(timer);
      job.abort = null;
    }
    const png = out && Buffer.isBuffer(out.png) ? out.png : null;
    if (!png) return { state: 'failed', error: 'the render returned no image' };
    let size;
    try { size = pngSize(png); } catch (e) { return { state: 'failed', error: `the render returned no PNG: ${e.message}` }; }
    fs.writeFileSync(pngPath(job.capture), png);
    return {
      state: 'ready', width: size.width, height: size.height, bytes: png.length,
      sha256: crypto.createHash('sha256').update(png).digest('hex'),
    };
  }

  // The picture has settled (or never will): onto the capture record, then the
  // element event that raises the grab's one queue item — while the element is
  // still on the surface.
  function settle(job, image) {
    if (job.record) job.record.image = image;
    if (stopped) return;
    if (!refOf(state, job.rec.id) || !graph.elements) return;
    const event = { ...elementEvent(state, 'grab', job.rec), image: imageBlock(job.capture, image) };
    emitElements(state, bus, graph.elements, TYPE, event);
  }

  // Abort the render in flight and drop the waiting ones (their capture
  // records keep a failed image). Idempotent.
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const job of waiting.splice(0)) if (job.record) job.record.image = { state: 'failed', error: 'the daemon stopped before the grab was drawn' };
    if (inFlight && typeof inFlight.abort === 'function') inFlight.abort();
  }

  const pngPath = (capture) => path.join(paths().CAPTURES_DIR, `${capture}.png`);

  // The capture's image, from its live record (a committed node's copy may
  // hold an older state), else what the sidecar on disk says.
  function imageOf(capture) {
    const live = Array.isArray(state.captures) ? state.captures.find((c) => c && c.id === capture) : null;
    if (live && isObj(live.image)) return live.image;
    try {
      const png = fs.readFileSync(pngPath(capture));
      const size = pngSize(png);
      return { state: 'ready', width: size.width, height: size.height, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') };
    } catch { return { state: 'gone' }; }
  }

  // GET /api/elements/:id/grab for a box grab `rec` the route has gated: the
  // PNG bytes (no-store), or with ?as=json the image's state and, when ready,
  // the same bytes base64 (inspect_capture's one call, F4 (a)).
  function serve(req, res, rec) {
    const capture = isObj(rec.grab) && typeof rec.grab.capture === 'string' ? rec.grab.capture : null;
    res.set('Cache-Control', 'no-store');
    if (!capture) return res.status(404).json({ error: 'no picture', id: rec.id, image: { state: 'none' } });
    const image = imageOf(capture);
    let png = null;
    if (image.state === 'ready') { try { png = fs.readFileSync(pngPath(capture)); } catch { png = null; } }
    const asJson = req.query && req.query.as === 'json';
    if (asJson) {
      return res.json({
        ok: true, id: rec.id, v: rec.v, capture, image: imageBlock(capture, png ? image : (image.state === 'ready' ? { state: 'gone' } : image)),
        ...(png ? { mimeType: 'image/png', data: png.toString('base64') } : {}),
      });
    }
    if (!png) return res.status(404).json({ error: 'no picture', id: rec.id, image: imageBlock(capture, image) });
    return res.type('image/png').send(png);
  }

  return {
    admit, created, serve, stop,
    stats: () => ({ in_flight: inFlight ? 1 : 0, waiting: waiting.length, reserved, stopped }),
    // A PATCH on a box grab: {status, body} to refuse it, or null (nothing to change).
    refusePatch(patch) {
      if (patch && patch.shared === false) return { status: 400, body: { ok: false, error: 'a box grab cannot be private', hint: PRIVATE_HINT } };
      const keys = Object.keys(patch || {}).filter((k) => k !== 'shared');
      if (keys.length) return { status: 400, body: { ok: false, error: 'a box grab cannot be edited', keys, hint: FIXED_HINT } };
      return null;
    },
  };
}

// The image block an element item carries (F4 (a)): the capture and, when
// ready, the PNG's path under .web-chat, its digest and size; else its state
// and the hint or error.
function imageBlock(capture, image) {
  const im = isObj(image) ? image : { state: 'pending' };
  if (im.state === 'ready') {
    return { state: 'ready', capture, path: `captures/${capture}.png`, sha256: im.sha256, width: im.width, height: im.height, bytes: im.bytes };
  }
  const out = { state: im.state || 'failed', capture };
  if (im.hint) out.hint = im.hint;
  if (im.error) { out.error = im.error; out.hint = out.hint || FAILED_HINT; }
  return out;
}

module.exports = {
  boxGrabFor, createBoxGrab, setSeams, imageBlock, TYPE,
  RENDER_TIMEOUT_MS, RENDER_QUEUE_MAX, SCRIPT_ERRORS_MAX, HTML_MAX, CLIP_MAX,
  PRIVATE_HINT, FIXED_HINT, BUSY_HINT,
};
