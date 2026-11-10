'use strict';
// A listed element type's files over HTTP (annotation engine tranche 4, U511;
// PLAN.md 4A.1 and 4A.2; DECISIONS.md B1 review-approve, B3 fenced-route;
// PLAN-T4 §2.3 DRAW@loader and PFH@inline).
//
//   GET /api/elements/types/:type/draw.js     the type's draw module — the URL
//         the chrome's dynamic import() names (never eval); a `?d=<sha256>`
//         query is the chrome's cache key and is ignored here
//   GET /api/elements/types/:type/assets/*    a file under the type's assets/
//         (PNG, SVG, WebP, WOFF2 — lib/core/element-assets ASSET_TYPES)
//
// Only a plug-in type the registry LISTS (ctx.elementTypes: reviewed,
// approved, recorded, intact) is served, and only through
// lib/server/element-files readTypeFile — the one reader of a type's files:
// the fence, the no-link walk, the O_NOFOLLOW open, element-assets FILE_MAX,
// the recorded digests re-checked on every read, and the sniff. A built-in's
// draw code is the chrome's own and is never served here.
//
// Before the fence: a path with an empty, '.' or '..' segment, a backslash, a
// NUL or an encoded separator (%2F, %5C) is refused 400, judged on the RAW
// path (Express decodes its params, so an encoded '/' would otherwise read as
// a separator).
//
// Levels: read and above (audience.requireMirror('read')), then the type's own
// gate — ctx.elementTypes.gate(type).see met by the viewer's level, as GET
// /api/elements/types filters its listing — else 403. Remotely both paths sit
// under element-policy FLOOR_RULES' existing `GET /api/elements/*` row (and
// its write row refuses any other method below full): no RULES row, no
// protocol change (PROTO@none).
//
// The answer: the bytes with element-assets' media type,
// X-Content-Type-Options: nosniff, Cross-Origin-Resource-Policy: same-origin,
// Cache-Control: no-store, ETag the file's recorded sha256 in quotes (an equal
// If-None-Match → 304, after the same checks), and on an image or a font
// Content-Security-Policy BRAND_CSP (as routes/brand.js sendImage sets it). A
// refusal is JSON {ok: false, error, hint} with readTypeFile's status.
//
// Mounted from lib/server/index.js right after the types route and BEFORE the
// element routes, whose `/api/elements/:id` would take `types` for an id.
// Writes nothing; no WS frame; no ctx member.

const { isSafeId } = require('../../core/paths');
const { hintFor } = require('../../core/remote-policy');
const { ALLOWED_HINT, DRAW_FILE, ASSETS_DIR } = require('../../core/element-assets');
const { BRAND_CSP } = require('../brand');
const { readTypeFile, TypeFileRefusal } = require('../element-files');

const FILES_PREFIX = '/api/elements/types/';

// A raw (still percent-encoded) path segment → its decoded text, or null when
// it may not name a served file.
const ENCODED_BAD = /%(?:2f|5c|00)/i;
function segmentOf(raw) {
  if (!raw || raw.includes('\\') || ENCODED_BAD.test(raw)) return null;
  let s;
  try { s = decodeURIComponent(raw); } catch { return null; }
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  return s;
}

// req → {type, rel}, or null for a path refused before the fence.
function parsePath(req) {
  const p = String(req.path || '');
  if (!p.startsWith(FILES_PREFIX)) return null;
  const raw = p.slice(FILES_PREFIX.length).split('/');
  if (raw.length < 2) return null;
  const segs = raw.map(segmentOf);
  if (segs.some((s) => s === null)) return null;
  const [type, ...rest] = segs;
  if (rest.length === 1 && rest[0] === DRAW_FILE) return { type, rel: DRAW_FILE };
  if (rest.length >= 2 && rest[0] === ASSETS_DIR) return { type, rel: rest.join('/') };
  return null;
}

// Whether an If-None-Match header names this entity tag.
function matches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*');
}

function mountElementFileRoutes(app, ctx) {
  const { audience, elementTypes } = ctx;
  const relayed = (req) => {
    try { return typeof audience.peerOf === 'function' && audience.peerOf(req) === 'relayed'; } catch { return false; }
  };

  function serve(req, res) {
    const parsed = parsePath(req);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: 'not a file path a type may serve', hint: ALLOWED_HINT });
    }
    const { type, rel } = parsed;
    // The type's own gate, for a type the registry lists.
    const row = isSafeId(type) && elementTypes ? elementTypes.descriptor(type) : null;
    if (row && !row.builtin) {
      const gate = elementTypes.gate(type);
      if (!gate || !audience.atLeast(audience.levelOf(req), gate.see)) {
        return res.status(403).json({
          ok: false,
          error: `the element type '${type}' is not shown at this viewer's level`,
          // The one chooser: the hub's words for a relayed viewer (06 C-06.34a).
          hint: hintFor(gate && gate.see === 'full' ? 'full' : 'read', { connected: relayed(req) }),
        });
      }
    }
    let file;
    try {
      file = readTypeFile(ctx, type, rel);
    } catch (e) {
      if (e instanceof TypeFileRefusal) return res.status(e.status).json({ ok: false, error: e.why, hint: e.hint });
      return res.status(500).json({ ok: false, error: 'the file could not be read' });
    }
    const etag = `"${file.sha256}"`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('ETag', etag);
    if (file.kind === 'image' || file.kind === 'font') res.setHeader('Content-Security-Policy', BRAND_CSP);
    if (matches(req.headers['if-none-match'], etag)) return res.status(304).end();
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Length', String(file.bytes.length));
    return res.end(file.bytes);
  }

  const read = audience.requireMirror('read');
  // Literal paths: test/remote-policy.test.js's route census reads them.
  app.get('/api/elements/types/:type/draw.js', read, serve);
  app.get('/api/elements/types/:type/assets/*', read, serve);
}

module.exports = { mountElementFileRoutes, FILES_PREFIX };
