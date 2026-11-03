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
//      record {v: 1, kind: 'page', item, mount, rect, box, scroll, viewport} —
//      rect measured from the item's CONTENT BOX (a pane's `.mount-host`, a
//      markdown item's block), box that content box's {w, h} (K.2-72), scroll
//      its own {top, left} scroll offset (K.2-80) — that the
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
//      to the anchored item and clipped to the rect, measured from the same
//      content box in the export (contentSelector) — which a style injected
//      into the built document (boxStyle) fixes at the sent box's size, so
//      nothing reflows under the clip (K.2-72; the viewport is widened to hold
//      it when the viewer's was narrower), and scrolled as the viewer's was
//      (captureClip's `scroll`, K.2-80). One PNG, captures/cap<n>.png, the
//      ONE file the chrome shows the user
//      (GET /api/elements/:id/grab) and Claude reads (inspect_capture's image
//      block, F4 (a)) — no second render, no resize, no re-encode. The capture's
//      image goes pending → {state: 'ready', width, height, bytes, sha256,
//      scroll_clamped?} — scroll_clamped {top, left} the scroll the browser
//      APPLIED when it fell more than 1 px short of the chrome's on either axis
//      (K.2-85; the clip is unchanged) — |
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
// THE SOURCE DOCUMENT of every render here (both kinds) is the export path's
// live document under the SHARED-ONLY projection: buildExportHtml with
// reader fileReader(PICTURE_LEVEL) — lib/server/document-elements drops every
// shared === false item of every type before anything is spliced (AD5, K.5
// J2, GT-22), so no private element is ever painted into a PNG Claude
// receives (a screenshot bypasses the text redactor). The ctx it is built
// with carries ctx.elementTypes and ctx.sideTable, so a listed plug-in type
// is drawn by its own module, never as a removed type's generic mark.
//
// THE PICTURE (annotation engine tranche 4, 4F.2; U564; DECISIONS N.1 AD3,
// AD5; RULED PICTURE@when AG3 (a), U564@change-picture (a),
// U564@request-path-grab-event (a)): a second job kind on the SAME render
// queue (one render at a time, RENDER_QUEUE_MAX, RENDER_TIMEOUT_MS, the
// sweep, stop()). picture(id, {reason}) pictures the stroke group of `id`
// (lib/core/strokes strokeGroups) among its type's SHARED live records only —
// a private stroke is never pictured — as one capture record {kind and
// profile 'element-picture', source 'element:<type>', url 'element:<newest
// member>', distilled {kind, type, elements: [id@v…], describe (lib/core/
// ink-shape describeOf over the shared members: shape, confidence, count and
// bbox — numbers only, as the queue item's; the text under the strokes
// rides only as the item's excerpt, behind the excerpt switch), previous?,
// new?}, image pending → …} and no capture item or tab_capture bump. One
// capture per send or request: when the group's newest earlier picture shows
// exactly the members' id@v set (ready, or still being drawn) it is answered
// as it is. A CHANGE picture (the group has members its previous picture did
// not show) greys the members that picture showed (one injected style over
// lib/core/strokes STROKE_ID_ATTR) and leaves the new ones in colour. The clip
// is the group's bbox (bboxOf, in its frame's 0..1 units) inside its box
// marker — `.el-marker[data-el-ids~="<id>"]`, which the document runtime
// writes on every marker (U522) — plus PICTURE_MARGIN_PX, computed in the
// page (lib/replay/chrome captureClip's `region`).
// WHEN, and only then: the user's Send to Claude of a shared stroke (the
// element event op 'send' on the bus, heard below) and Claude's request
// (POST /api/elements/:id/picture, lib/server/routes/element-picture.js:
// inspect_capture). Never on add, share, edit or a wake. A settled picture
// emits the element event op 'grab' with its image block — which the wake
// policy folds onto the group's queued item — only while the stroke is on
// the surface AND an undelivered item for the group exists, so a request of
// Claude's never puts a row on the user's rail.
// A WITHDRAWN picture (AD5, K.5 J2): when a member a picture shows is made
// private (the element event op 'edit' with shared false, heard below), every
// live picture naming it is withdrawn — its image {state: 'withdrawn', hint},
// its PNG deleted, its distilled and url stripped of the member (and of the
// describe, whose count and extent it was part of) — and the withdrawn image
// is folded onto the group's undelivered item, replacing the stale block. A
// picture that is withdrawn, or names a member whose latest version is
// private, is refused 404 by pictureBody and servePicture whatever element
// the URL names. A withdrawal gives the live record NEW distilled and image
// objects and never edits one in place (a committed node's copy shares them),
// and survives a restore: after every full-state restore a live picture
// naming a member whose latest version is private is withdrawn again.
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
const { queuedElementItem } = require('./domain/queue');
const { isStrokePayload, strokeGroups, bboxOf, STROKE_ID_ATTR } = require('../core/strokes');
const { describeOf } = require('../core/ink-shape');
const { parsePin } = require('../core/element-log');

const TYPE = 'box-grab';
const SOURCE = 'element:box-grab';
// The picture's capture kind and profile (U564).
const PICTURE = 'element-picture';
// Around the group's bbox, in CSS px, so the ink's edge and what it marks show.
const PICTURE_MARGIN_PX = 24;
// The level a render's source document is read at: a FILE's reader
// (fileReader: never seesPrivate), text kept — shared elements only, of every
// type whose see gate `full` meets.
const PICTURE_LEVEL = 'full';
const PICTURE_PRIVATE_HINT = 'share the stroke first: a private stroke is never pictured';
const PICTURE_STROKE_HINT = 'only a stroke group is pictured here; a box grab carries its own picture (GET /api/elements/:id/grab)';
const PICTURE_GONE_HINT = 'the stroke is no longer on the surface; draw it again';
const PICTURE_WITHDRAWN_HINT = 'a stroke this picture showed was made private, so the picture was withdrawn; send the group again to picture what is still shared';
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
// A content box's height may exceed any viewport (a content-height pane); it
// is laid out at it all the same (K.2-85), the viewport sized by its width.
const BOX_H_MAX = 100000;
// How far the applied scroll may sit from the asked one, on either axis,
// before the capture records it as clamped (K.2-85): sub-pixel rounding only.
const SCROLL_SLACK_PX = 1;
// The export's page gutter around a widened content box (its body's padding,
// with room to spare): the viewport is at least the box's width plus twice this.
const BOX_GUTTER_PX = 40;

const BUSY_HINT = 'the daemon is still drawing earlier box grabs; wait for their pictures, then grab again';
const ANCHOR_HINT = 'a box grab is anchored to the page: {v: 1, kind: "page", item, mount, rect, box, viewport}, or null with rect.item';
const RECT_HINT = 'rect is {x, y, w, h, item, viewport}: numbers in CSS px, measured from the item\'s content box (a pane\'s .mount-host, a markdown item\'s block), w and h above 0; box {w, h} is that content box\'s size';
const PRIVATE_HINT = 'a box grab is always shared: it exists to reach Claude (delete it instead)';
const FIXED_HINT = 'a box grab is a picture of what was on screen; draw a new one instead of editing it';
const STOPPED_ERROR = 'the daemon stopped before the grab was drawn';
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

// The content box's size {w, h} the chrome sent (anchor.box or payload.box),
// rounded to hundredths of a CSS px; null when absent or not two positive numbers.
function boxOf(...cands) {
  const b = cands.find((c) => isObj(c) && finite(c.w) && finite(c.h) && c.w > 0 && c.h > 0);
  if (!b) return null;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { w: r2(clamp(b.w, 1, VIEWPORT.max)), h: r2(clamp(b.h, 1, BOX_H_MAX)) };
}

// The content box's own scroll {top, left} the chrome sent (anchor.scroll or
// payload.scroll; K.2-80): a rows-capped pane's box scrolls, and the rect is
// relative to what was scrolled into view. Rounded to hundredths, clamped to
// [0, BOX_H_MAX]; null when absent or not two finite numbers (an older
// chrome: the box is drawn unscrolled, as before).
function scrollOf(...cands) {
  const s = cands.find((c) => isObj(c) && finite(c.top) && finite(c.left));
  if (!s) return null;
  const r2 = (n) => Math.round(clamp(n, 0, BOX_H_MAX) * 100) / 100;
  return { top: r2(s.top), left: r2(s.left) };
}

// A CSS string holding `s`: every character but [A-Za-z0-9_-] as its hex
// escape, so an item id can never close the string, the rule or the <style>.
const cssString = (s) => `"${String(s).replace(/[^A-Za-z0-9_-]/gu, (c) => `\\${c.codePointAt(0).toString(16)} `)}"`;

// The item's content box in the export's document (lib/server/export's shell:
// a pane's wrapper carries data-pane-id, its `.mount-host` a direct child; a
// markdown block carries data-md-id): the frame the chrome measured the rect in.
function contentSelector(item, pane) {
  return pane ? `[data-pane-id=${cssString(item)}] > .mount-host` : `[data-md-id=${cssString(item)}]`;
}

// The style that lays the content box out at the size the chrome measured it
// at, before any pane script runs (K.2-72, K.2-85: the live box is the frame
// of reference in BOTH dimensions): the box fixed at box.w, and at box.h when
// sent — its overflow left as the built document has it, so a rows-capped
// pane's scroll range is the live one (the export lays its header out inside
// the rows height, where the live chrome caps the whole pane: unpinned, the
// export's box is about a header taller and its range that much shorter); a
// pane's wrapper sized to it (raised, so a neighbour in its run never paints
// over a widened one).
function boxStyle(item, pane, box) {
  const px = `${box.w}px`;
  let fixed = `width: ${px} !important; min-width: ${px} !important; max-width: ${px} !important;`;
  if (finite(box.h) && box.h > 0) {
    const h = `${box.h}px`;
    fixed += ` height: ${h} !important; min-height: ${h} !important; max-height: ${h} !important;`;
  }
  const raised = 'position: relative; z-index: 1;';
  const rules = pane
    ? [`[data-pane-id=${cssString(item)}] { width: max-content !important; max-width: none !important; ${raised} }`,
      `${contentSelector(item, true)} { ${fixed} }`]
    : [`${contentSelector(item, false)} { ${fixed} ${raised} }`];
  return `<style data-wc-grab>\n${rules.join('\n')}\n</style>\n`;
}

// The built document with the box style in its head (unchanged when there is
// no head to put it in).
function withBox(html, item, pane, box) {
  const at = html.indexOf('</head>');
  return at < 0 ? html : html.slice(0, at) + boxStyle(item, pane, box) + html.slice(at);
}

// A style element into the built document's head (unchanged with no head).
function withStyle(html, style) {
  const at = html.indexOf('</head>');
  return at < 0 ? html : html.slice(0, at) + style + html.slice(at);
}

// A change picture's one style (U564): each greyed member's ink — every node
// its type's draw marks with lib/core/strokes STROKE_ID_ATTR — muted, the
// ids as CSS strings; the new members' ink is untouched, so it stays in colour.
function greyStyle(ids) {
  const sel = ids.map((id) => `[${STROKE_ID_ATTR}=${cssString(id)}]`).join(',\n');
  return `<style data-wc-picture>\n${sel} { filter: grayscale(1) !important; opacity: 0.35 !important; color: var(--wc-muted, #8a8a8a) !important; }\n</style>\n`;
}

// The box marker that holds a stroke `id` in the export document: every
// document marker carries data-el-ids, its group's ids space-joined (U522's
// document runtime, as the live overlay's rebuild sets them).
function markerSelector(id) {
  return `.el-marker[data-el-ids~=${cssString(id)}]`;
}

// The group's extent in its frame's 0..1 units: the union of each member's
// lib/core/strokes bboxOf; the whole frame when no member has a point.
function relOf(members) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of members) {
    const b = bboxOf(r.points, { stride: r.stride });
    if (!b) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 'p3@2' → 'p3' (lib/core/element-log parsePin, the one id@v parser).
const idOfRef = (ref) => { const p = parsePin(ref); return p ? p.id : String(ref); };
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && [...a].sort().join('\n') === [...b].sort().join('\n');

// The scroll the browser applied, when it is not the one asked for (K.2-85):
// either axis more than SCROLL_SLACK_PX off — the box's range was shorter than
// the live one's — the APPLIED {top, left}, rounded to hundredths; else null
// (and null when the render reported no scroll). Never a failure, never a
// change to the clip: the record says so, and inspect_capture names it.
function clampedScroll(asked, applied) {
  if (!isObj(applied) || !finite(applied.top) || !finite(applied.left)) return null;
  if (Math.abs(applied.top - asked.top) <= SCROLL_SLACK_PX && Math.abs(applied.left - asked.left) <= SCROLL_SLACK_PX) return null;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { top: r2(applied.top), left: r2(applied.left) };
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
  // The pictures withdrawn because a member they showed was made private: a
  // render still in flight for one settles to nothing (its PNG removed).
  const withdrawn = new Set();
  let inFlight = null;
  let reserved = 0;
  let stopped = false;
  const watched = new WeakSet();

  const load = () => (inFlight ? 1 : 0) + waiting.length + reserved;

  // The capture record the live surface holds now, by id. A full-state
  // restore (a re-aim, graph.js restoreLiveToNode; the boot's draft, turns.js)
  // replaces state.captures with copies, so a job's own record may be
  // detached: a settle writes to both (K.2-63).
  const liveRecord = (id) => (Array.isArray(state.captures) ? state.captures.find((c) => c && c.id === id) : null) || null;
  function setImage(job, image) {
    const live = liveRecord(job.capture);
    if (live) live.image = image;
    if (job.record && job.record !== live) job.record.image = image;
    if (!isObj(image) || image.state !== 'pending') wake(job.capture, image);
  }

  // Who waits on a capture's image to settle (the picture request's long-poll).
  const waiters = new Map();
  function wake(capture, image) {
    const list = waiters.get(capture);
    if (!list) return;
    waiters.delete(capture);
    for (const fn of list) fn(image);
  }

  // THE SWEEP (K.2-63): a capture whose image is pending with no render job
  // in flight or waiting will never settle — it was pending when the daemon
  // stopped (restored from the draft) or when a node copied it (restored by a
  // re-aim). It becomes failed, unless its picture is already on disk (the
  // render finished after that copy was made), which it then reads as.
  function sweep() {
    if (!Array.isArray(state.captures)) return 0;
    const busy = new Set([...waiting, ...(inFlight ? [inFlight] : [])].map((j) => j.capture));
    let n = 0;
    for (const c of state.captures) {
      if (!c || (c.kind !== TYPE && c.kind !== PICTURE) || !isObj(c.image) || c.image.state !== 'pending' || busy.has(c.id)) continue;
      c.image = fromDisk(c.id) || { state: 'failed', error: STOPPED_ERROR };
      n++;
    }
    return n;
  }

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
    const box = boxOf(isObj(anchor) && anchor.box, p.box);
    const scroll = scrollOf(isObj(anchor) && anchor.scroll, p.scroll);
    const page = { v: 1, kind: 'page', item, mount, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      ...(box ? { box } : {}), ...(scroll ? { scroll } : {}), viewport };
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
      pane: isObj(rec.anchor) && rec.anchor.mount != null,
      box: isObj(rec.anchor) && isObj(rec.anchor.box) ? rec.anchor.box : null,
      scroll: isObj(rec.anchor) && isObj(rec.anchor.scroll) ? rec.anchor.scroll : null,
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
    const { fileReader } = require('./document-elements');
    // The SHARED-ONLY projection, passed explicitly (AD5, GT-22): a file's
    // reader, never seesPrivate, whatever the export's own default is; the
    // registry and the side table, so a listed plug-in type draws by its module.
    const built = buildExportHtml({
      graph, paths: paths(), root: root(), elementTypes: ctx.elementTypes, sideTable: ctx.sideTable,
    }, 'live', new Date(), { mode: job.mode, reader: fileReader(PICTURE_LEVEL) });
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
    // One frame of reference (K.2-72, K.2-85): the clip is measured from the
    // item's content box, laid out at the size the chrome measured it at. A
    // picture's region is relative to its marker, which its target lays out,
    // so it needs no fixed box; a change picture's style greys the older ink.
    let html = job.box ? withBox(built.html, job.item, job.pane, job.box) : built.html;
    if (job.kind === PICTURE && job.greyed.length) html = withStyle(html, greyStyle(job.greyed));
    const width = job.box ? clamp(Math.max(vp.w, Math.ceil(job.box.w) + 2 * BOX_GUTTER_PX), VIEWPORT.min, VIEWPORT.max) : vp.w;
    const asked = { top: job.scroll ? job.scroll.top : 0, left: job.scroll ? job.scroll.left : 0 };
    const where = job.kind === PICTURE
      ? { item: null, selector: null, region: { selector: markerSelector(job.marker), rel: job.rel, margin: PICTURE_MARGIN_PX } }
      : {
        item: job.item, selector: contentSelector(job.item, job.pane),
        clip: { x: job.clip.x, y: job.clip.y, w: job.clip.w, h: job.clip.h },
        scroll: asked,
      };
    let out;
    try {
      const running = Promise.resolve((s.captureImpl || captureClip)({
        chromePath, html, width, height: vp.h, mobile: vp.mobile === true,
        colorScheme: job.mode, ...where,
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
    const clamped = job.kind === PICTURE ? null : clampedScroll(asked, out.scroll);
    return {
      state: 'ready', width: size.width, height: size.height, bytes: png.length,
      sha256: crypto.createHash('sha256').update(png).digest('hex'),
      ...(clamped ? { scroll_clamped: clamped } : {}),
    };
  }

  // The picture has settled (or never will): onto the capture record, then the
  // element event that raises the grab's one queue item — while the element is
  // still on the surface.
  function settle(job, image) {
    if (job.kind === PICTURE && withdrawn.has(job.capture)) { removePng(job.capture); return; }
    setImage(job, image);
    if (stopped) return;
    if (job.kind === PICTURE) { foldPicture(job.capture, job.type, job.members, image); return; }
    if (!refOf(state, job.rec.id) || !graph.elements) return;
    const event = { ...elementEvent(state, 'grab', job.rec), image: imageBlock(job.capture, image) };
    emitElements(state, bus, graph.elements, TYPE, event);
  }

  // A picture's image onto the group's queued item: the element event op
  // 'grab' for the newest member the item holds, which the wake policy folds
  // onto that item (lib/channel/policy declarative; mergeElement's image rule)
  // — only while that member is on the surface and the item is undelivered
  // (RULED U564@request-path-grab-event (a)): with no such item nothing is
  // emitted, so neither a request of Claude's nor a picture that settles after
  // the user's Push raises a row.
  function foldPicture(capture, type, members, image) {
    if (!graph.elements) return false;
    let item = null;
    for (const id of members) { item = queuedElementItem(state, id); if (item) break; }
    if (!item || !Array.isArray(item.element_ids)) return false;
    // Already folded (a send heard twice, a reused picture): no second op.
    if (isObj(item.image) && item.image.capture === capture && item.image.state === (isObj(image) ? image.state : null)) return false;
    const held = members.filter((id) => item.element_ids.includes(id) && refOf(state, id));
    const target = held[held.length - 1];
    if (!target) return false;
    const ref = refOf(state, target);
    let rec = null;
    try { rec = graph.elements.record(target, ref.v); } catch { rec = null; }
    if (!rec || rec.shared !== true) return false;
    const event = { ...elementEvent(state, 'grab', rec), image: imageBlock(capture, image) };
    emitElements(state, bus, graph.elements, type, event);
    return true;
  }

  // Abort the render in flight and drop the waiting ones (their capture
  // records keep a failed image). Idempotent.
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const job of waiting.splice(0)) setImage(job, { state: 'failed', error: STOPPED_ERROR });
    if (inFlight && typeof inFlight.abort === 'function') inFlight.abort();
    if (typeof unsubscribe === 'function') unsubscribe();
    for (const capture of [...waiters.keys()]) wake(capture, imageOf(capture));
  }

  // ── THE PICTURE (U564) ──────────────────────────────────────────────────

  // The shared live strokes of `rec`'s type, on the surface, and the read-time
  // group (lib/core/strokes strokeGroups) holding rec: its records, oldest first.
  function groupOf(rec) {
    let live = [];
    try { live = graph.elements.liveRecords(rec.type) || []; } catch { live = []; }
    const shared = live.filter((r) => r && r.shared === true && isStrokePayload(r) && refOf(state, r.id));
    if (!shared.some((r) => r.id === rec.id)) shared.push(rec);
    const group = strokeGroups(shared).find((g) => g.members.includes(String(rec.id)));
    const members = group ? group.members.map((id) => shared.find((r) => String(r.id) === id)).filter(Boolean) : [];
    return members.length ? members : [rec];
  }

  // The newest picture capture (live) of `type` showing any of `ids`, or null.
  function previousPicture(type, ids) {
    let best = null;
    for (const c of Array.isArray(state.captures) ? state.captures : []) {
      if (!c || c.kind !== PICTURE || !isObj(c.distilled) || c.distilled.type !== type || !Array.isArray(c.distilled.elements)) continue;
      if (!c.distilled.elements.some((ref) => ids.includes(idOfRef(ref)))) continue;
      if (!best || c.seq > best.seq) best = c;
    }
    return best;
  }

  // picture(id, {reason, req?}) → {ok: true, capture, record, reused?} |
  // {ok: false, refused, status, hint}: the picture of the stroke group of
  // `id` among its type's SHARED live records (reason 'send' | 'request').
  function picture(id, { reason = 'request', req = null } = {}) {
    if (stopped) return { ok: false, refused: 'stopping', status: 503, hint: BUSY_HINT };
    watch(req);
    const ref = typeof id === 'string' && graph.elements ? refOf(state, id) : null;
    if (!ref) return { ok: false, refused: 'gone', status: 404, hint: PICTURE_GONE_HINT };
    let rec = null;
    try { rec = graph.elements.record(id, ref.v); } catch { rec = null; }
    if (!rec || !isStrokePayload(rec)) return { ok: false, refused: 'not-a-stroke', status: 400, hint: PICTURE_STROKE_HINT };
    if (rec.shared !== true) return { ok: false, refused: 'private', status: 409, hint: PICTURE_PRIVATE_HINT };
    const type = rec.type;
    const members = groupOf(rec);
    const memberIds = members.map((r) => String(r.id));
    const refs = members.map((r) => `${r.id}@${r.v}`);
    const prev = previousPicture(type, memberIds);
    // One capture per send or request (the cost rule): the group's newest
    // picture already shows exactly these versions, drawn or being drawn.
    if (prev && sameSet(prev.distilled.elements, refs) && isObj(prev.image) && (prev.image.state === 'ready' || prev.image.state === 'pending')) {
      if (prev.image.state === 'ready') {
        const image = prev.image;
        setImmediate(() => { if (!stopped) foldPicture(prev.id, type, memberIds, image); });
      }
      return { ok: true, capture: prev.id, record: prev, reused: true, reason };
    }
    if (load() >= RENDER_QUEUE_MAX) return { ok: false, refused: 'busy', status: 429, hint: BUSY_HINT };
    // A change picture (RULED U564@change-picture (a)): the members the
    // previous picture showed are greyed, the ones created since in colour.
    const before = prev ? new Set(prev.distilled.elements.map(idOfRef)) : new Set();
    const fresh = memberIds.filter((m) => !before.has(m));
    const greyed = prev && fresh.length && fresh.length < memberIds.length ? memberIds.filter((m) => before.has(m)) : [];
    const d = describeOf(members);
    const describe = d && d.count > 0 ? { shape: d.shape, confidence: d.confidence, count: d.count, bbox: d.bbox } : null;
    const newest = members[members.length - 1];
    const capture = allocateCapture(state);
    const made = createCapture(state, bus, paths(), {
      id: capture.id,
      seq: capture.seq,
      source: `element:${type}`,
      url: `element:${newest.id}`,
      title: '',
      profile: PICTURE,
      distilled: {
        kind: PICTURE, type, elements: refs,
        ...(describe ? { describe } : {}),
        ...(greyed.length ? { previous: prev.id, new: fresh } : {}),
      },
      raw: '',
      extra: { kind: PICTURE, image: { state: 'pending' } },
    });
    if (!made.ok) return { ok: false, refused: 'failed', status: 500, error: made.error, hint: FAILED_HINT };
    waiting.push({
      kind: PICTURE, reason, capture: capture.id, record: made.record, type, members: memberIds,
      marker: String(newest.id), rel: relOf(members), greyed, viewport: null, mode: null,
    });
    pump();
    return { ok: true, capture: capture.id, record: made.record, reason };
  }

  // A member made private (AD5, K.5 J2): every live picture naming `id` is
  // withdrawn — the image {state: 'withdrawn'}, the PNG deleted, distilled
  // (elements, new) and url stripped of it and its describe dropped (the
  // count and extent it was part of) — and the withdrawn image folded onto
  // the group's undelivered item (mergeElement's image rule replaces the
  // stale block). The live record and a render job's own (detached) copy both.
  function withdrawMember(id) {
    const byCapture = new Map();
    const take = (c) => {
      if (!c || c.kind !== PICTURE || !isObj(c.distilled) || !Array.isArray(c.distilled.elements)) return;
      if (!c.distilled.elements.some((ref) => idOfRef(ref) === id)) return;
      if (!byCapture.has(c.id)) byCapture.set(c.id, new Set());
      byCapture.get(c.id).add(c);
    };
    for (const c of Array.isArray(state.captures) ? state.captures : []) take(c);
    for (const job of [...waiting, ...(inFlight ? [inFlight] : [])]) if (job.kind === PICTURE) take(job.record);
    for (const [capture, records] of byCapture) withdrawFrom(capture, records, [id], { fold: true });
  }

  // Withdraw capture `capture` (its `records`: the live one, a job's detached
  // copy) of the members `ids`. A capture record shares its distilled and
  // image objects with every committed node and draft that copied it (a
  // commit and a restore copy captures one level deep, graph.js), so a record
  // is only ever given NEW objects — distilled rebuilt without the members
  // and without describe, url and image re-assigned — never edited in place:
  // a committed node keeps what it committed, as its file on disk does.
  function withdrawFrom(capture, records, ids, { fold = false } = {}) {
    const drop = new Set(ids);
    withdrawn.add(capture);
    const image = { state: 'withdrawn', hint: PICTURE_WITHDRAWN_HINT };
    let type = null;
    let left = [];
    for (const rec of records) {
      const { describe: _describe, ...rest } = rec.distilled;
      const kept = rest.elements.filter((ref) => !drop.has(idOfRef(ref)));
      rec.distilled = {
        ...rest, elements: kept,
        ...(Array.isArray(rest.new) ? { new: rest.new.filter((m) => !drop.has(m)) } : {}),
      };
      left = kept.map(idOfRef);
      type = rest.type;
      const urlId = typeof rec.url === 'string' && rec.url.startsWith('element:') ? rec.url.slice('element:'.length) : null;
      if (urlId && drop.has(urlId)) rec.url = left.length ? `element:${left[left.length - 1]}` : '';
      rec.image = image;
    }
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].capture === capture) waiting.splice(i, 1);
    removePng(capture);
    wake(capture, image);
    if (fold && !stopped && type) foldPicture(capture, type, left, image);
  }

  // The members of picture `rec` whose latest version in the element log is
  // private — whatever version the live surface (or a restored node) pins.
  function privateMembers(rec) {
    const dist = isObj(rec.distilled) ? rec.distilled : {};
    const out = [];
    for (const ref of Array.isArray(dist.elements) ? dist.elements : []) {
      const mid = idOfRef(ref);
      let r = null;
      try { const latest = graph.elements.latest(mid); r = latest ? graph.elements.record(mid, latest.v) : null; } catch { r = null; }
      if (r && r.shared === false) out.push(mid);
    }
    return out;
  }

  // Withdrawal survives a restore: a re-aim (or the boot's draft) puts back a
  // node's copy of a picture, which may still name a member made private since
  // (or hold a withdrawn picture's ready image). Each such live record is
  // withdrawn again, by the same new-object rule; no item is folded (the
  // first withdrawal did that).
  function rewithdraw() {
    let n = 0;
    for (const c of Array.isArray(state.captures) ? state.captures : []) {
      if (!c || c.kind !== PICTURE || !isObj(c.distilled) || !Array.isArray(c.distilled.elements)) continue;
      const gone = privateMembers(c);
      const marked = withdrawn.has(c.id) && !(isObj(c.image) && c.image.state === 'withdrawn');
      if (!gone.length && !marked) continue;
      withdrawFrom(c.id, [c], gone);
      n++;
    }
    return n;
  }

  // Whether a picture may no longer be served: withdrawn, or naming a member
  // whose latest version is private (whatever element a request names).
  function isWithdrawn(rec) {
    if (withdrawn.has(rec.id) || (isObj(rec.image) && rec.image.state === 'withdrawn')) return true;
    return privateMembers(rec).length > 0;
  }
  const withdrawnBody = (id, rec) => ({
    ok: false, status: 404, error: 'withdrawn', id,
    image: { state: 'withdrawn', capture: rec.id, hint: PICTURE_WITHDRAWN_HINT },
  });

  // The user's Send to Claude of a shared stroke (the element event op 'send',
  // heard on the bus): one picture, after the send's own raise (the send's
  // item is enqueued right after its event, in the same call). `sent(id)` is
  // the same for a caller that knows a send happened without that event (a
  // send that shared a private stroke, or found its item already queued):
  // the element's live version; nothing for anything but a shared stroke, and
  // a picture already showing the group's versions is reused, so hearing one
  // send twice draws once.
  function heardSend(event) { sent(event.id); }
  function sent(id) {
    setImmediate(() => {
      if (stopped || !graph.elements || typeof id !== 'string') return;
      const ref = refOf(state, id);
      let rec = null;
      try { rec = ref ? graph.elements.record(id, ref.v) : null; } catch { rec = null; }
      if (!rec || rec.shared !== true || !isStrokePayload(rec)) return;
      picture(id, { reason: 'send' });
    });
  }

  // A capture's image once it settles (or `timeoutMs` passes, or the engine
  // stops): the picture request's long-poll.
  function whenSettled(capture, timeoutMs = RENDER_TIMEOUT_MS) {
    const now = imageOf(capture);
    if (now.state !== 'pending' || stopped) return Promise.resolve(now);
    return new Promise((resolve) => {
      let timer = null;
      const fn = (image) => { clearTimeout(timer); resolve(image); };
      timer = setTimeout(() => {
        const list = waiters.get(capture);
        if (list) { list.delete(fn); if (!list.size) waiters.delete(capture); }
        resolve(imageOf(capture));
      }, timeoutMs);
      if (!waiters.has(capture)) waiters.set(capture, new Set());
      waiters.get(capture).add(fn);
    });
  }

  // The newest picture (live) naming element `id` — or, given `capture`, that
  // capture when it is a picture naming `id` — or null.
  function pictureOf(id, capture = null) {
    let best = null;
    for (const c of Array.isArray(state.captures) ? state.captures : []) {
      if (!c || c.kind !== PICTURE || !isObj(c.distilled) || !Array.isArray(c.distilled.elements)) continue;
      if (capture != null && c.id !== capture) continue;
      if (!c.distilled.elements.some((ref) => idOfRef(ref) === id)) continue;
      if (!best || c.seq > best.seq) best = c;
    }
    return best;
  }

  // What a picture answers: its capture, the versions it shows, its describe
  // and image block (and, `data`, the PNG base64 when ready).
  function pictureBody(id, rec, { data = false } = {}) {
    if (isWithdrawn(rec)) return withdrawnBody(id, rec);
    const image = imageOf(rec.id);
    let png = null;
    if (data && image.state === 'ready') { try { png = fs.readFileSync(pngPath(rec.id)); } catch { png = null; } }
    const block = imageBlock(rec.id, data && image.state === 'ready' && !png ? { state: 'gone' } : image);
    const dist = isObj(rec.distilled) ? rec.distilled : {};
    return {
      ok: true, id, capture: rec.id, type: dist.type, elements: Array.isArray(dist.elements) ? dist.elements.slice() : [],
      ...(isObj(dist.describe) ? { describe: dist.describe } : {}),
      ...(dist.previous ? { previous: dist.previous, new: dist.new } : {}),
      image: block,
      ...(png ? { mimeType: 'image/png', data: png.toString('base64') } : {}),
    };
  }

  // GET /api/elements/:id/picture for an element the route has gated: the
  // newest picture of its group (?capture=<id>: that picture of it) — the
  // PNG, or with ?as=json its body.
  function servePicture(req, res, id) {
    res.set('Cache-Control', 'no-store');
    const asked = req.query && typeof req.query.capture === 'string' && req.query.capture ? req.query.capture : null;
    const rec = pictureOf(id, asked);
    if (!rec) return res.status(404).json({ error: 'no picture', id, image: { state: 'none' } });
    if (isWithdrawn(rec)) { const { status, ...body } = withdrawnBody(id, rec); return res.status(status).json(body); }
    if (req.query && req.query.as === 'json') return res.json(pictureBody(id, rec, { data: true }));
    const image = imageOf(rec.id);
    let png = null;
    if (image.state === 'ready') { try { png = fs.readFileSync(pngPath(rec.id)); } catch { png = null; } }
    if (!png) return res.status(404).json({ error: 'no picture', id, image: imageBlock(rec.id, image) });
    return res.type('image/png').send(png);
  }

  const pngPath = (capture) => path.join(paths().CAPTURES_DIR, `${capture}.png`);
  const removePng = (capture) => { try { fs.unlinkSync(pngPath(capture)); } catch {} };

  // The capture's image, from its live record (a committed node's copy may
  // hold an older state), else what the sidecar on disk says.
  function imageOf(capture) {
    const live = liveRecord(capture);
    if (live && isObj(live.image)) return live.image;
    return fromDisk(capture) || { state: 'gone' };
  }

  // The ready image a PNG sidecar on disk describes, or null.
  function fromDisk(capture) {
    try {
      const png = fs.readFileSync(pngPath(capture));
      const size = pngSize(png);
      return { state: 'ready', width: size.width, height: size.height, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') };
    } catch { return null; }
  }

  // Swept at creation (the routes mount it at boot, after the draft restore)
  // and after every full-state restore, heard as the services supervisor
  // hears one: a `graph` event on the change bus (set-active, wipe,
  // new-graph, a turn end applying a queued re-aim).
  sweep();
  rewithdraw();
  const unsubscribe = bus && typeof bus.subscribe === 'function'
    ? bus.subscribe((event) => {
      if (!event) return;
      if (event.kind === 'graph') { sweep(); rewithdraw(); }
      else if (event.kind === 'element' && event.op === 'send' && event.shared !== false) heardSend(event);
      else if (event.kind === 'element' && event.op === 'edit' && event.shared === false && typeof event.id === 'string') withdrawMember(event.id);
    })
    : null;

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
      const block = imageBlock(capture, png ? image : (image.state === 'ready' ? { state: 'gone' } : image));
      // A clamped scroll (K.2-85) beside the scroll the chrome measured, so
      // inspect_capture can say how far short the pane fell.
      const asked = block.scroll_clamped && isObj(rec.anchor) && isObj(rec.anchor.scroll) ? rec.anchor.scroll : null;
      return res.json({
        ok: true, id: rec.id, v: rec.v, capture, image: block,
        ...(asked ? { scroll: asked } : {}),
        ...(png ? { mimeType: 'image/png', data: png.toString('base64') } : {}),
      });
    }
    if (!png) return res.status(404).json({ error: 'no picture', id: rec.id, image: imageBlock(capture, image) });
    return res.type('image/png').send(png);
  }

  return {
    admit, created, serve, stop, sweep,
    picture, sent, whenSettled, pictureOf, pictureBody, servePicture,
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
    return {
      state: 'ready', capture, path: `captures/${capture}.png`, sha256: im.sha256, width: im.width, height: im.height, bytes: im.bytes,
      ...(isObj(im.scroll_clamped) ? { scroll_clamped: im.scroll_clamped } : {}),
    };
  }
  const out = { state: im.state || 'failed', capture };
  if (im.hint) out.hint = im.hint;
  if (im.error) { out.error = im.error; out.hint = out.hint || FAILED_HINT; }
  return out;
}

module.exports = {
  boxGrabFor, createBoxGrab, setSeams, imageBlock, contentSelector, markerSelector, greyStyle, relOf, TYPE,
  PICTURE, PICTURE_MARGIN_PX, PICTURE_LEVEL, PICTURE_PRIVATE_HINT, PICTURE_STROKE_HINT, PICTURE_GONE_HINT, PICTURE_WITHDRAWN_HINT,
  RENDER_TIMEOUT_MS, RENDER_QUEUE_MAX, SCRIPT_ERRORS_MAX, HTML_MAX, CLIP_MAX,
  PRIVATE_HINT, FIXED_HINT, BUSY_HINT,
};
