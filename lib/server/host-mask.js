// Host-path masking at serve, below local (tranche 6 U752, 6B.5; contract 11
// section 5, C-11.8, C-11.13, C-11.25; 04 C-04.17; REQ@host-path-masking (a)).
//
// The graph's conversation text (the lock's message, a node's trigger, the
// turns folded onto it), the element text (a comment's words and replies, an
// element's record) and GET /api/health's lock are the user's own words, and
// the user types paths: `/Users/me/proj/src/app.js`. The redactor masks the
// values it KNOWS (lib/core/redact); a path is not one of them. Below `local`
// (a tunnel viewer at basic, read or full, a relayed request at any stamp, a
// network peer) those words are served with the project root as `<project>`
// and the home directory as `~`, through lib/core/paths redactHostPaths — the
// one home rule, never a second regex. The host keeps its history whole: the
// node files, the element log, the lock and the bookmarks are never rewritten,
// and a local request or socket gets them byte for byte as before.
//
// Three seams, one rule:
//   * hostMaskBelowLocal({audience, root, prefixes}) — ONE Express middleware,
//     mounted once in lib/server/index.js before the routes, over HOST_MASK_
//     PREFIXES: for a request whose audience.levelOf(req) is not 'local' it
//     wraps res.json, so every JSON body under those prefixes passes
//     maskHostText after the route has stripped, dropped and redacted it (the
//     redactor first, never instead: U634@pin-reach). A later element or graph
//     route is masked without calling a helper. SSE, files, images and every
//     non-JSON body are untouched.
//   * maskFrameText(frame, {root}) — lib/server/ws.js's projector, for a socket
//     that is not local: the lock, a node's trigger text and folded turns, the
//     element rows and marks of the full-surface frames, the element frames and
//     the queued re-aim's name.
//   * maskHostText(value, {root}) — the value itself: lib/server/routes/graph.js
//     masks the wipe and new-graph labels with it at emit (after the redactor),
//     so every reader of the ring, the connector's hold included, reads them
//     masked; the bookmark the graph keeps is the label as typed.
//
// PASS-THROUGH (contract 11 section 4): pane HTML, params, store, form_state
// and markdown are the surface, served whole at every level — a node's and a
// diff's `mounts`, `store` and `markdown` are never masked, at any depth.

const { redactHostPaths } = require('../core/paths');
const { TEXT_RULES } = require('../core/remote-policy');

// The route prefixes the middleware masks: the graph (GET /api/graph, the node
// read, /api/graph/changes, /api/graph/diff and the re-aims' answers), health
// (its lock), the element API (/api/elements and everything under it — the
// comment's routes are the element API's, U327a), and /api/comments, whose one
// answer today is its 410 refusal (routes/comments.js), named so a reopened
// alias is masked from its first byte. Beside the brief's four, the other
// JSON readers of the same text the sweep's planted paths reach (C-11.25):
// the event ring's pages (GET /api/events, and the matched event POST
// /api/wait answers — a comment entry carries its whole pin), the replay path
// (GET /api/replay/path: each step's prompt, reply and summary) and a pane's
// version history (GET /api/mounts/:id/history: each version's
// trigger_summary). And the queue (GET /api/queue and what is under it): a
// comment pinned on a pane queues an item whose summary quotes it, so its
// bodies pass the queue item rule (maskQueueItem) — a message item's text
// verbatim (C-11.14), every other item's TEXT_RULES.items fields masked — and
// the rest of the body maskHostText. Each entry is an Express path: app.use
// matches it as a prefix, and so does `under` below (a `:name` segment is
// any one segment). Matched in any case, as Express routes (case-sensitive
// routing is off, and nothing in lib/server sets it) and as the portal's
// classify reads a path (lib/core/remote-policy lowercases it): /API/health
// and /api/GRAPH/node/<id> reach the same routes, so they are masked the
// same; the queue rule (queueRe) takes the same case rule (U752@host-mask.js:66).
const QUEUE_PREFIX = '/api/queue';
const HOST_MASK_PREFIXES = Object.freeze([
  '/api/graph', '/api/health', '/api/elements', '/api/comments',
  '/api/events', '/api/wait', '/api/replay', '/api/mounts/:id/history',
  QUEUE_PREFIX,
]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const prefixRe = (p) => new RegExp(`^${p.split('/').map((seg) => (seg.startsWith(':') ? '[^/?]+' : escapeRe(seg))).join('/')}(?:[/?]|$)`, 'i');

// The surface carriers a body or frame may hold beside its text (contract 11
// section 4's pass-through): never masked.
const PASS_THROUGH = new Set(['mounts', 'store', 'markdown']);

// A placeholder for a pass-through value while the rest is masked: no path
// separator, so redactHostPaths leaves it as it is.
const HELD = '\u0000wc-host-mask-held:';

const isObj = (v) => v !== null && typeof v === 'object';

// Do two JSON-shaped values read alike? `b` is the input and `a` what the walk
// made of it, the same shape but for the strings it masked (and a toJSON value,
// which reads as changed).
function alike(a, b) {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!alike(a[k], b[k])) return false;
  return true;
}

// `value` with every host path in it masked (redactHostPaths: the root as
// `<project>`, the home as `~`, both spellings, longest first), its
// pass-through carriers kept whole. A copy when anything was masked, else
// `value` itself (so a projector that caches by value still serializes one
// string for a frame that had nothing to mask); `value` is never touched.
// `home` defaults to lib/core/paths homeDir(), as redactHostPaths' does.
const maskOpts = (root, home) => (home === undefined ? { root: root || null } : { root: root || null, home });

function maskHostText(value, { root = null, home } = {}) {
  const opts = maskOpts(root, home);
  if (!isObj(value)) return redactHostPaths(value, opts);
  const out = maskObject(value, opts, passThrough);
  return alike(out, value) ? value : out;
}

// A hold rule for maskObject: for a key and its value, null to walk on, else
// the value to put back in place of it after the walk.
const passThrough = (k, x) => (PASS_THROUGH.has(k) ? { put: x } : null);

function maskObject(value, opts, hold) {
  const held = [];
  const setAside = (v) => {
    if (isObj(v) && typeof v.toJSON === 'function') v = v.toJSON();
    if (Array.isArray(v)) return v.map(setAside);
    if (!isObj(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const kept = hold(k, x);
      if (kept) { out[k] = `${HELD}${held.length}`; held.push({ k, put: kept.put }); } else out[k] = setAside(x);
    }
    return out;
  };
  const masked = redactHostPaths(setAside(value), opts);
  if (!held.length) return masked;
  const putBack = (v) => {
    if (Array.isArray(v)) return v.map(putBack);
    if (!isObj(v)) return v;
    for (const k of Object.keys(v)) {
      const x = v[k];
      const h = typeof x === 'string' && x.startsWith(HELD) ? held[Number(x.slice(HELD.length))] : null;
      if (h && h.k === k) v[k] = h.put;
      else v[k] = putBack(x);
    }
    return v;
  };
  return putBack(masked);
}

// The queue item rule (C-11.14, TEXT_RULES.items): a message item keeps its
// text as written — the queue's own projection (publicItem, fullItem) decides
// what of it leaves, and the daemon's queue never rewrites it — so it is
// returned as it is; any other item has the fields TEXT_RULES.items names for
// its kind (a comment's or an element's summary, excerpt and members: the
// pin's words a comment pinned on a pane queues) host-path masked, and
// nothing else. A copy when anything was masked, else `item` itself.
function maskQueueItem(item, { root = null, home } = {}) {
  if (!isObj(item) || Array.isArray(item) || typeof item.kind !== 'string') return item;
  if (item.kind === 'message') return item;
  const fields = Object.hasOwn(TEXT_RULES.items, item.kind) ? TEXT_RULES.items[item.kind] : [];
  const opts = maskOpts(root, home);
  let out = null;
  for (const f of fields) {
    if (!Object.hasOwn(item, f)) continue;
    const masked = maskHostText(item[f], opts);
    if (masked === item[f]) continue;
    if (!out) out = { ...item };
    out[f] = masked;
  }
  return out || item;
}
const maskQueueItems = (v, opts) => (Array.isArray(v) ? v.map((it) => maskQueueItem(it, opts)) : maskQueueItem(v, opts));

// A queue route's body (GET /api/queue's `items`, the park's `pending.items`,
// a queue answer's `item`): each item through maskQueueItem, the rest of the
// body maskHostText (its pass-through carriers kept whole as there).
function maskQueueBody(value, { root = null, home } = {}) {
  const opts = maskOpts(root, home);
  if (!isObj(value)) return redactHostPaths(value, opts);
  const hold = (k, x) => {
    if ((k === 'items' && Array.isArray(x)) || (k === 'item' && isObj(x) && !Array.isArray(x))) return { put: maskQueueItems(x, opts) };
    return passThrough(k, x);
  };
  const out = maskObject(value, opts, hold);
  return alike(out, value) ? value : out;
}

// The fields of a projected frame that carry graph or element text: the lock
// (hello, reset, lock), the node (node-added: its trigger_summary, a full
// node's trigger and folded turns), the lean element rows and the marks
// (hello, reset), the queued re-aim's intent (reaim:pending: the wipe's or new
// graph's name before it applies), the bookmark frame's `name` (the label the
// user typed, as GET /api/graph serves it masked; no other host-masked frame
// has a top-level `name`). Pane html, store, form_state and markdown are never
// among them (PASS_THROUGH holds even inside these). A `queue` frame's `item`
// and `items` go through the queue item rule (QUEUE_FRAME_FIELDS,
// maskQueueItem) instead.
const FRAME_TEXT_FIELDS = Object.freeze(['lock', 'node', 'elements', 'marks', 'intent', 'name']);
const QUEUE_FRAME_FIELDS = Object.freeze(['item', 'items']);
const isElementFrame = (type) => typeof type === 'string' && type.startsWith('element:');
// The frame types the projector masks beside TEXT_RULES.frames (hello, reset,
// lock, node-added) and every element:<type>: the marks frame (its labels and
// anchors, as hello's `marks`), the queued re-aim (its name), the queue (its
// items, by the queue item rule: a comment item's summary quotes the pin) and
// the bookmark (its name: routes/graph.js POST /api/graph/bookmark;
// U752@bookmark-frame-name).
const HOST_MASK_FRAMES = Object.freeze(['marks', 'reaim:pending', 'queue', 'bookmark']);

// One frame for a socket that is not local: an element frame (element:<type>,
// the comment pins' included) masked whole, any other only in
// FRAME_TEXT_FIELDS (a copy of the frame, the rest of it shared). Returns
// `frame` itself when nothing in it was masked.
function maskFrameText(frame, { root = null, home } = {}) {
  if (!isObj(frame) || Array.isArray(frame)) return frame;
  const opts = home === undefined ? { root } : { root, home };
  if (isElementFrame(frame.type)) return maskHostText(frame, opts);
  const queue = frame.type === 'queue';
  let out = null;
  for (const k of queue ? QUEUE_FRAME_FIELDS : FRAME_TEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(frame, k) || frame[k] == null) continue;
    const masked = queue ? maskQueueItems(frame[k], opts) : maskHostText(frame[k], opts);
    if (masked === frame[k]) continue;
    if (!out) out = { ...frame };
    out[k] = masked;
  }
  return out || frame;
}

// The middleware: below local, res.json's body is masked before it is sent.
// `audience` is ctx.audience (its levelOf, the one level of a request); one
// that cannot answer is not local (fail closed: masked). `prefixes` is what
// it is mounted over (index.js passes HOST_MASK_PREFIXES to app.use); it is
// taken here too so a caller that mounts it bare is still held to them.
function hostMaskBelowLocal({ audience, root = null, prefixes = HOST_MASK_PREFIXES } = {}) {
  const patterns = prefixes.map(prefixRe);
  const under = (url) => patterns.some((re) => re.test(url));
  const queueRe = prefixRe(QUEUE_PREFIX);
  return function hostMask(req, res, next) {
    const url = String(req.originalUrl || req.url || '');
    if (!under(url)) return next();
    let level = null;
    try { level = audience && typeof audience.levelOf === 'function' ? audience.levelOf(req) : null; } catch { level = null; }
    if (level === 'local') return next();
    const json = res.json;
    const mask = queueRe.test(url) ? maskQueueBody : maskHostText;
    res.json = function maskedJson(body) {
      return json.call(this, mask(body, { root }));
    };
    return next();
  };
}

module.exports = {
  maskHostText, maskFrameText, maskQueueItem, maskQueueBody, hostMaskBelowLocal,
  HOST_MASK_PREFIXES, HOST_MASK_FRAMES, PASS_THROUGH, FRAME_TEXT_FIELDS, QUEUE_FRAME_FIELDS,
};
