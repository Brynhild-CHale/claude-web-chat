const express = require('express');
const brand = require('../brand');

// Brand image slots (lib/server/brand.js is the engine; this is thin over it).
//   GET    /api/brand         → { theme: {key,name,title}, slots: {logotype|lockup|seal: {type,bytes,version}|null},
//                                fill, max_bytes, types, sizes }
//   PUT    /api/brand/:slot   → body = the raw image (Content-Type image/png or image/svg+xml)
//   DELETE /api/brand/:slot   → clear the slot
//   GET    /brand/:slot       → the image bytes, locked down (sendImage, below)
//
// The images are kept per THEME — the project's global theme when they were
// added — so `theme` says whose images `slots` are, and every read and write
// here is on the current global theme's. Beside `slots`, the snapshot, the
// replies and the `brand` frame carry `fill` — what fills a slot the theme has
// no image in (brand.fills; code comments only, on purpose). /brand/:slot
// serves the theme's image, else that fill, at ?mode=light|dark.
//
// P6: PUT and DELETE here are write routes — mark them remote-refused.
//
// The write routes are reachable by any pane (same origin), like the theme
// routes: a pane can already restyle the whole chrome, and an upload is refused
// unless it is an inert PNG/SVG.
//
// Three pieces below belong to every image route, not only to these, so they
// are exported rather than copied: rawBodyReader, the one raw-body reader;
// readImageBody, the reader of an uploaded brand image built on it; and
// sendImage, the one locked-down response that serves one. The project's
// identity images (routes/project.js) go in and out through the last two, and
// the composer's attachments (routes/attachments.js) through the first.

// A raw-body reader: the request's bytes as req.body, a Buffer — or a
// refusal. The one place a route takes a raw body (test/conventions.test.js
// holds the raw parser to this one file): the image upload below and the
// composer's attachments (routes/attachments.js, U91) are each built on it.
//   rawBodyReader({types, maxBytes, refuse}) → middleware(req, res, next)
// `types` the Content-Types it reads; the body is capped a byte over
// `maxBytes`, so the caller's own check — not body-parser — states the
// refusal for an oversize body (one message, one status, whichever layer sees
// it first). `refuse(res, why, status)` answers a body it could not read:
// why 'too-large' (413), 'unreadable' (400 or body-parser's status), or 'type'
// (415: a Content-Type outside `types`, or no body at all — express.raw
// leaves req.body as {}, or unset, for either).
function rawBodyReader({ types, maxBytes, refuse }) {
  if (!Array.isArray(types) || !types.length || !Number.isInteger(maxBytes) || maxBytes < 1 || typeof refuse !== 'function') {
    throw new TypeError('rawBodyReader needs { types, maxBytes, refuse }');
  }
  const parse = express.raw({ type: types, limit: maxBytes + 1 });
  return function readRawBody(req, res, next) {
    parse(req, res, (err) => {
      if (err) {
        const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : (err.status || 400);
        return refuse(res, status === 413 ? 'too-large' : 'unreadable', status);
      }
      if (!Buffer.isBuffer(req.body)) return refuse(res, 'type', 415);
      next();
    });
  };
}

// Route middleware: the uploaded image as req.body, a Buffer — or a refusal.
// 413 over the limit, 400 a body that could not be read, 415 a Content-Type
// other than PNG or SVG.
// Whether the bytes ARE what that Content-Type says is the engine's question:
// it sniffs them and refuses with the same statuses (400 empty, 413, 415, 422).
const readImageBody = rawBodyReader({
  types: Object.values(brand.TYPES),
  maxBytes: brand.MAX_BYTES,
  refuse(res, why, status) {
    const error = why === 'too-large' ? `image exceeds ${brand.MAX_BYTES} bytes`
      : why === 'type' ? 'send the image as the raw body with Content-Type image/png or image/svg+xml'
        : 'unreadable body';
    return res.status(status).json({ error });
  },
});

// Serve an image's bytes, locked down. The chrome only ever loads one through
// <img>, where an SVG runs nothing; the headers are for the one other way in —
// opening the url as a document — where the CSP (no script, sandboxed) and
// nosniff keep it an image, and Cross-Origin-Resource-Policy keeps another
// site from embedding it. no-cache: each url is stable per image and the
// chrome busts it with ?v=<version> anyway. `type` is the one the engine
// sniffed from the bytes, never one a request or a file name claims.
function sendImage(res, { bytes, type }) {
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', brand.BRAND_CSP);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(bytes);
}

// A slot this layout does not know is a 404 before anything else: an upload to
// one is refused before its body is read.
function knownSlot(req, res, next) {
  const { slot } = req.params;
  if (brand.isSlot(slot)) return next();
  res.status(404).json({ error: `unknown brand slot '${slot}'` });
}

// Does this bus event change which theme the project is on? set_theme and
// apply_theme at global scope, a pack removal or update that reset the active
// theme (all three carry scope:'global'), and save_theme with set_default.
function changesGlobalTheme(e) {
  if (!e || e.kind !== 'theme') return false;
  return e.scope === 'global' || (e.op === 'save' && !!e.set_default);
}

function mountBrandRoutes(app, ctx) {
  const { root, bus } = ctx;

  const snapshot = () => ({
    ...brand.snapshot(root),
    max_bytes: brand.MAX_BYTES,
    types: Object.values(brand.TYPES),
    sizes: brand.SLOTS,
  });

  // One frame to every viewer, so each topbar re-reads its logotype and each
  // Settings → Brand its slots and the theme they belong to. The event names
  // that theme's key. Returns what it sent.
  const announce = (event) => {
    const s = brand.snapshot(root);
    bus.emit({
      event: { kind: 'brand', ...event, theme: s.theme.key },
      ws: { type: 'brand', ...s },
    });
    return s;
  };

  // Which images show follows the GLOBAL theme, so a change of theme is a
  // change of brand. Every route that changes it announces it on the bus with a
  // `theme` event (routes/theme.js, and routes/packs.js's reset); following
  // those from here means none of them has to remember the brand, and a frame
  // goes out whichever of them moved the theme. Synchronous, inside the theme
  // route's own emit: the brand frame reaches each viewer just ahead of the
  // theme frame, and the event is in the ring before the route answers.
  bus.subscribe((e) => {
    if (changesGlobalTheme(e)) announce({ op: 'theme' });
  });

  app.get('/api/brand', (req, res) => res.json(snapshot()));

  app.put('/api/brand/:slot', knownSlot, readImageBody, (req, res) => {
    const { slot } = req.params;
    let r;
    try { r = brand.write(root, slot, req.body); } catch (e) {
      if (e instanceof brand.BrandError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const s = announce({ op: 'set', slot });
    res.json({ ok: true, slot: r.slot, type: r.type, bytes: r.bytes, ...s });
  });

  app.delete('/api/brand/:slot', knownSlot, (req, res) => {
    const { slot } = req.params;
    const removed = brand.remove(root, slot);
    const s = removed ? announce({ op: 'remove', slot }) : brand.snapshot(root);
    res.json({ ok: true, slot, removed, ...s });
  });

  app.get('/brand/:slot', (req, res) => {
    const { slot } = req.params;
    const mode = req.query.mode === 'dark' ? 'dark' : 'light';
    const r = brand.isSlot(slot) ? brand.effective(root, slot, { mode }) : null;
    if (!r) return res.status(404).type('text/plain').send('no such brand image');
    sendImage(res, r);
  });
}

module.exports = { mountBrandRoutes, changesGlobalTheme, readImageBody, rawBodyReader, sendImage };
