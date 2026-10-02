const express = require('express');
const brand = require('../brand');

// Brand image slots (lib/server/brand.js is the engine; this is thin over it).
//   GET    /api/brand         → { theme: {key,name,title}, slots: {logotype|lockup|seal: {type,bytes,version}|null},
//                                fill, max_bytes, types, sizes }
//   PUT    /api/brand/:slot   → body = the raw image (Content-Type image/png or image/svg+xml)
//   DELETE /api/brand/:slot   → clear the slot
//   GET    /brand/:slot       → the image bytes, locked down (see below)
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

// The raw body, capped a byte over the limit so the engine — not body-parser —
// states the refusal (one message, one status, whichever layer sees it first).
const rawImage = express.raw({ type: ['image/png', 'image/svg+xml'], limit: brand.MAX_BYTES + 1 });

function readBody(req, res, next) {
  rawImage(req, res, (err) => {
    if (!err) return next();
    const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : (err.status || 400);
    res.status(status).json({ error: status === 413 ? `image exceeds ${brand.MAX_BYTES} bytes` : 'unreadable body' });
  });
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

  app.put('/api/brand/:slot', readBody, (req, res) => {
    const { slot } = req.params;
    if (!brand.isSlot(slot)) return res.status(404).json({ error: `unknown brand slot '${slot}'` });
    // express.raw leaves req.body as {} (or unset) for any other Content-Type.
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'send the image as the raw body with Content-Type image/png or image/svg+xml' });
    }
    let r;
    try { r = brand.write(root, slot, req.body); } catch (e) {
      if (e instanceof brand.BrandError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const s = announce({ op: 'set', slot });
    res.json({ ok: true, slot: r.slot, type: r.type, bytes: r.bytes, ...s });
  });

  app.delete('/api/brand/:slot', (req, res) => {
    const { slot } = req.params;
    if (!brand.isSlot(slot)) return res.status(404).json({ error: `unknown brand slot '${slot}'` });
    const removed = brand.remove(root, slot);
    const s = removed ? announce({ op: 'remove', slot }) : brand.snapshot(root);
    res.json({ ok: true, slot, removed, ...s });
  });

  // The bytes. The chrome only ever loads these through <img>, where an SVG
  // runs nothing; the headers are for the one other way in — opening the url as
  // a document — where the CSP (no script, sandboxed) and nosniff keep it an
  // image. no-cache: the url is stable per slot and the chrome busts it with
  // ?v=<version> anyway.
  app.get('/brand/:slot', (req, res) => {
    const { slot } = req.params;
    const mode = req.query.mode === 'dark' ? 'dark' : 'light';
    const r = brand.isSlot(slot) ? brand.effective(root, slot, { mode }) : null;
    if (!r) return res.status(404).type('text/plain').send('no such brand image');
    res.setHeader('Content-Type', r.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', brand.BRAND_CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(r.bytes);
  });
}

module.exports = { mountBrandRoutes, changesGlobalTheme };
