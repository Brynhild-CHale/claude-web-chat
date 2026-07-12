// Collapse runs of whitespace to single spaces and trim — one copy for the
// profile extractors (default.js, tables.js) and the profile registry.
function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Resolve a possibly-relative href/src against a page URL's origin. One copy for
// the builtin content extractors (article.js) and the simplified-site transform
// (simplify.js) — so distilled links and reader-view assets are absolute and
// openable off the surface. Leaves already-absolute, scheme (mailto:/tel:/data:),
// protocol-relative, and in-page (#) links intact; falls back to the raw value
// when there is no usable base.
function absolutize(href, base) {
  const h = String(href == null ? '' : href).trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (/^(mailto:|tel:|data:|javascript:)/i.test(h)) return h;
  if (h.startsWith('#')) return h;
  if (h.startsWith('//')) return 'https:' + h;
  let origin = '';
  try { origin = new URL(base).origin; } catch {}
  if (!origin) return h;
  if (h.startsWith('/')) return origin + h;
  try { return new URL(h, base).href; } catch { return origin + '/' + h.replace(/^\/+/, ''); }
}

module.exports = { collapse, absolutize };
