// Collapse runs of whitespace to single spaces and trim — one copy for the
// profile extractors (default.js, tables.js) and the profile registry.
function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// The schemes a distilled link or a reader-pane href may carry. Anything else —
// `javascript:`, `vbscript:`, `data:`, `blob:`, an unknown custom scheme — is
// dropped. The distillate is not the only consumer: simplify.js's output is
// mounted with `tpl.innerHTML = html` into a shadow root in the SURFACE's own
// origin and is written to the .simplified.html sidecar the daemon serves, and
// nothing downstream sanitizes it — the "the shadow mount sanitizes too" claim
// simplify.js's header used to make was not implemented anywhere.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// Resolve a possibly-relative href/src against the PAGE URL and gate its scheme.
// Returns '' when the value cannot be resolved or lands outside SAFE_SCHEMES —
// callers keep the link TEXT and drop the href.
//
// Normalising through `new URL` rather than a regex is what makes the gate hold:
// the WHATWG parser strips the tab in `java\tscript:alert(1)` before the scheme
// is read (browsers do the same), so a string that slips past a regex test
// arrives here as protocol `javascript:` and is refused. It also means a
// document-relative `c.html` on https://x.com/a/b/page.html resolves to
// https://x.com/a/b/c.html — which is why callers must pass the page URL and not
// its origin.
//
// A leading '#' is returned as-is: an in-page anchor points into the captured
// page, not anywhere reachable from the surface, and every caller degrades it to
// plain text on that basis.
function safeHref(href, pageUrl) {
  const h = String(href == null ? '' : href).trim();
  if (!h) return '';
  if (h.startsWith('#')) return h;
  const base = pageUrl ? String(pageUrl) : '';
  let u = null;
  try {
    u = new URL(h, base || undefined);
  } catch {
    // No usable base. A protocol-relative URL still names a host, so supply the
    // scheme the surface would have used; anything else is unresolvable.
    if (h.startsWith('//')) { try { u = new URL('https:' + h); } catch { return ''; } }
    else return '';
  }
  return SAFE_SCHEMES.has(u.protocol) ? u.href : '';
}

// The lenient resolver, kept for profile BUNDLES (it rides the extract/pane ctx,
// the only way a bundle in ~/.web-chat/profiles can reach a helper at all) whose
// links are known-good and which want an unresolvable value back unchanged
// rather than empty. It is lenient about RESOLUTION — a relative href with no
// usable base comes back as written, where safeHref returns '' — but not about
// executable schemes: `javascript:` used to sit in its passthrough list, which is
// exactly how one reached an href in the reader pane and in the sidecar document
// the daemon serves, and deleting it from that list changed nothing on its own
// because the `new URL` fallback below returns `javascript:alert(1)` unchanged.
// Code inside the package still reaches for safeHref, which gates every scheme
// against an allowlist rather than refusing two.
const SCRIPT_SCHEMES = new Set(['javascript:', 'vbscript:']);

function absolutize(href, base) {
  const out = resolveLenient(href, base);
  // Normalising through `new URL` is what makes this hold: the parser strips the
  // tab in `java\tscript:` before the scheme is read, as a browser does. A value
  // that did not resolve to an absolute URL has no protocol to read and passes.
  try {
    if (SCRIPT_SCHEMES.has(new URL(out).protocol)) return '';
  } catch { /* relative or unparseable — nothing executable to gate */ }
  return out;
}

function resolveLenient(h0, base) {
  const h = String(h0 == null ? '' : h0).trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (/^(mailto:|tel:|data:)/i.test(h)) return h;
  if (h.startsWith('#')) return h;
  if (h.startsWith('//')) return 'https:' + h;
  let origin = '';
  try { origin = new URL(base).origin; } catch {}
  if (!origin) return h;
  if (h.startsWith('/')) return origin + h;
  try { return new URL(h, base).href; } catch { return origin + '/' + h.replace(/^\/+/, ''); }
}

// An element's OWN <li> children — the ONE list walker. `el.querySelectorAll('li')`
// descends into nested lists, so `<ul><li>outer<ul><li>inner</li></ul></li></ul>`
// yielded the items ["outerinner", "inner"] — the nested item once merged into
// its parent's text and once again on its own. Both flat-list walkers made that
// mistake verbatim; markdown.js, which filters children, did not.
//
// Every reader is on this one now: article/simplify and markdown require it, and
// a capture bundle — which cannot require into the package — takes it off the
// injected ctx kit (CTX_HELPERS in ./index.js). Do not re-declare it inside a
// bundle: reddit did, and its copy is where the nested-list fix sat unpinned.
function listItems(el) {
  return (el.childNodes || []).filter(
    (n) => n.nodeType === 1 && String(n.rawTagName || '').toLowerCase() === 'li',
  );
}

module.exports = { collapse, absolutize, safeHref, listItems, SAFE_SCHEMES };
