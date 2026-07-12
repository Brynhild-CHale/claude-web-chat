// Reader-lite simplified-site transform.
//
// A server-side, "bandwidth-reducing-browser"-style render over a captured page's
// parsed DOM: strip all scripts / event handlers / iframes / embeds and the site's
// own CSS, keep the document's semantic structure (headings, paragraphs, lists,
// tables, blockquotes, code, links, images) with absolute URLs, and dress it in a
// small clean stylesheet built on --wc-* tokens. A GitHub issue or any no-profile
// page then pins as a *readable page*, not a text blob.
//
// CRITICAL split (ruled): this rich output is the PANE side only. It is NEVER put
// in the capture's distillate — routes/capture.js writes it to a sidecar file
// (parity with the raw-DOM tier) and embeds it in the pane, while get_captures
// keeps returning the small structured/text distillate. Claude's context never
// pays for the pretty render. Cap ~200KB with an "open original" link.

const { collapse, absolutize } = require('./util');

// Chrome / non-content containers we never descend into. iframe/object/embed and
// script/style are dropped here (defence in depth — the shadow mount sanitizes
// too, but the reader render simply never emits them).
const SKIP = new Set([
  'nav', 'aside', 'header', 'footer', 'form', 'button', 'script', 'style',
  'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'select', 'label',
  'input', 'textarea', 'canvas', 'video', 'audio', 'link', 'meta',
]);
// Generic wrappers we recurse THROUGH to reach the content blocks inside.
const STRUCTURAL = new Set([
  'div', 'section', 'article', 'main', 'body', 'details', 'summary',
]);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Serialize an inline subtree keeping only a safe whitelist of formatting tags
// (<a>, <strong>, <em>, <code>, <br>); everything else collapses to its text.
// <a> hrefs are absolutized; in-page/anchor links degrade to plain text.
function inlineHtml(node, origin) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += esc(child.rawText); continue; }
    if (child.nodeType !== 1) continue;
    const tag = (child.rawTagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    if (tag === 'br') { out += '<br>'; continue; }
    const inner = inlineHtml(child, origin);
    if (tag === 'a') {
      const href = absolutize(child.getAttribute('href'), origin);
      if (href && !href.startsWith('#')) out += `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${inner}</a>`;
      else out += inner;
    } else if (tag === 'strong' || tag === 'b') {
      out += inner ? `<strong>${inner}</strong>` : '';
    } else if (tag === 'em' || tag === 'i') {
      out += inner ? `<em>${inner}</em>` : '';
    } else if (tag === 'code') {
      out += inner ? `<code>${inner}</code>` : '';
    } else {
      out += inner;
    }
  }
  return out;
}

function renderTable(tbl) {
  const trs = tbl.querySelectorAll('tr');
  if (!trs.length) return '';
  const parts = ['<table>'];
  for (const tr of trs) {
    const cells = tr.querySelectorAll('th, td');
    if (!cells.length) continue;
    parts.push('<tr>' + cells.map((c) => {
      const t = (c.rawTagName || '').toLowerCase() === 'th' ? 'th' : 'td';
      return `<${t}>${esc(collapse(c.text))}</${t}>`;
    }).join('') + '</tr>');
  }
  parts.push('</table>');
  return parts.length > 2 ? parts.join('') : '';
}

// Walk block-level content, pushing clean HTML strings into `parts`. Honors a byte
// budget (`cap`) so the reader render can't blow past the ~200KB ceiling.
function walk(node, origin, parts, budget) {
  for (const child of node.childNodes) {
    if (budget.bytes >= budget.cap) { budget.truncated = true; return; }
    if (child.nodeType !== 1) continue;
    const tag = (child.rawTagName || '').toLowerCase();
    if (SKIP.has(tag)) continue;

    let html = '';
    if (/^h[1-6]$/.test(tag)) {
      const t = collapse(child.text);
      if (t) html = `<h${tag[1]}>${esc(t)}</h${tag[1]}>`;
    } else if (tag === 'p') {
      const inner = inlineHtml(child, origin).trim();
      if (inner) html = `<p>${inner}</p>`;
    } else if (tag === 'ul' || tag === 'ol') {
      const items = child.querySelectorAll('li').map((li) => inlineHtml(li, origin).trim()).filter(Boolean);
      if (items.length) html = `<${tag}>${items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`;
    } else if (tag === 'blockquote') {
      const inner = inlineHtml(child, origin).trim();
      if (inner) html = `<blockquote>${inner}</blockquote>`;
    } else if (tag === 'pre') {
      const t = child.text;
      if (t.trim()) html = `<pre>${esc(t.replace(/\s+$/, ''))}</pre>`;
    } else if (tag === 'table') {
      html = renderTable(child);
    } else if (tag === 'figure') {
      const img = child.querySelector('img');
      const caption = collapse(child.querySelector('figcaption')?.text || '');
      if (img) {
        const src = absolutize(img.getAttribute('src'), origin);
        if (src) html = `<figure><img src="${esc(src)}" alt="${esc(collapse(img.getAttribute('alt') || ''))}" loading="lazy">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
      }
    } else if (tag === 'img') {
      const src = absolutize(child.getAttribute('src'), origin);
      if (src) html = `<img src="${esc(src)}" alt="${esc(collapse(child.getAttribute('alt') || ''))}" loading="lazy">`;
    } else if (STRUCTURAL.has(tag)) {
      walk(child, origin, parts, budget);
      continue;
    } else {
      continue;
    }
    if (html) { parts.push(html); budget.bytes += Buffer.byteLength(html); }
  }
}

// The clean stylesheet — tokens only, so it restyles with the surface theme and
// never leaks the origin site's CSS.
const SIMPLIFIED_CSS = `
.wc-reader { font-family: var(--wc-font, system-ui, -apple-system, sans-serif); color: var(--wc-content-fg, var(--wc-fg, #1a1a1a)); line-height: 1.62; max-width: 720px; margin: 0 auto; padding: 1rem 1.15rem; }
.wc-reader h1, .wc-reader h2, .wc-reader h3, .wc-reader h4, .wc-reader h5, .wc-reader h6 { line-height: 1.25; margin: 1.5rem 0 .55rem; color: var(--wc-content-fg, var(--wc-fg, #111)); }
.wc-reader h1 { font-size: 1.5rem; } .wc-reader h2 { font-size: 1.26rem; } .wc-reader h3 { font-size: 1.08rem; } .wc-reader h4 { font-size: 1rem; }
.wc-reader p { margin: .7rem 0; }
.wc-reader a { color: var(--wc-content-accent, var(--wc-accent, #3366cc)); text-decoration: none; }
.wc-reader a:hover { text-decoration: underline; }
.wc-reader img { max-width: 100%; height: auto; border-radius: var(--wc-radius-sm, 4px); margin: .6rem 0; }
.wc-reader figure { margin: 1rem 0; }
.wc-reader figcaption { font-size: .8rem; color: var(--wc-muted, #777); margin-top: .3rem; }
.wc-reader ul, .wc-reader ol { margin: .7rem 0; padding-left: 1.45rem; }
.wc-reader li { margin: .25rem 0; }
.wc-reader blockquote { margin: .9rem 0; padding: .25rem 0 .25rem 1rem; border-left: 3px solid var(--wc-border, #ddd); color: var(--wc-muted, #555); }
.wc-reader pre { background: var(--wc-panel-bg, #f5f5f7); padding: .8rem 1rem; border-radius: var(--wc-radius-sm, 4px); overflow-x: auto; font-family: var(--wc-mono, monospace); font-size: .85rem; }
.wc-reader code { font-family: var(--wc-mono, monospace); font-size: .9em; }
.wc-reader table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9rem; display: block; overflow-x: auto; }
.wc-reader th, .wc-reader td { border: 1px solid var(--wc-border, #ddd); padding: .35rem .6rem; text-align: left; }
.wc-reader th { background: var(--wc-panel-bg, #f5f5f7); }
.wc-reader-head { border-bottom: 1px solid var(--wc-border, #e3e3e8); padding-bottom: .6rem; margin-bottom: .4rem; }
.wc-reader-title { font-size: 1.55rem; font-weight: 650; line-height: 1.2; margin: 0 0 .35rem; }
.wc-reader-meta { font-size: .78rem; color: var(--wc-muted, #888); }
.wc-reader-src { color: var(--wc-accent, #3366cc); text-decoration: none; }
.wc-reader-src:hover { text-decoration: underline; }
.wc-reader-note { font-size: .76rem; color: var(--wc-muted, #999); font-style: italic; margin-top: 1rem; }
`.trim();

function headHtml({ title, url, byline, date }) {
  const bits = [];
  if (byline) bits.push(esc(byline));
  if (date) bits.push(esc(date));
  if (url) bits.push(`<a class="wc-reader-src" href="${esc(url)}" target="_blank" rel="noopener">open original ↗</a>`);
  const meta = bits.length ? `<div class="wc-reader-meta">${bits.join(' · ')}</div>` : '';
  return `<div class="wc-reader-head"><div class="wc-reader-title">${esc(title || 'Untitled page')}</div>${meta}</div>`;
}

// First-screenful lead for the reduced pane mode: the first few blocks, up to a
// small text budget. Derived from the SAME transform output (no second parse).
function leadHtml(parts) {
  const out = [];
  let chars = 0;
  for (const p of parts) {
    out.push(p);
    chars += p.length;
    if (out.length >= 6 || chars >= 1400) break;
  }
  return out.join('') || '<p style="color:var(--wc-muted,#888)">No readable content extracted.</p>';
}

// Run the transform over a parsed DOM. Returns the clean body HTML plus its parts
// (for the lead) and metadata (bytes, truncated). Pure — no fs, no distillate.
function simplifyDom(root, { url = '', cap = 200000 } = {}) {
  if (!root) return { bodyHtml: '', parts: [], blocks: 0, bytes: 0, truncated: false };
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const container =
    root.querySelector('article') ||
    root.querySelector('main') ||
    root.querySelector('[role=main]') ||
    root.querySelector('body') ||
    root;
  const parts = [];
  const budget = { bytes: 0, cap, truncated: false };
  walk(container, origin, parts, budget);
  const bodyHtml = parts.join('\n');
  return { bodyHtml, parts, blocks: parts.length, bytes: Buffer.byteLength(bodyHtml), truncated: budget.truncated };
}

// The reduced/expanded pane inner HTML (embedded into the capture pane via the
// platform mode-wrapper). Head (title/byline/date/source) shows in both modes;
// the lead shows in reduced, the full simplified body in expanded.
function simplifiedPaneInner(simplified, { title, url, byline, date, readerUrl } = {}) {
  const head = headHtml({ title, url, byline, date });
  const lead = leadHtml(simplified.parts);
  const note = simplified.truncated
    ? `<div class="wc-reader-note">Simplified view truncated at ${Math.floor(simplified.bytes / 1024)} KB — <a href="${esc(url)}" target="_blank" rel="noopener">open the original</a> for the rest.</div>`
    : '';
  const reader = readerUrl
    ? `<div class="wc-reader-note"><a class="wc-reader-src" href="${esc(readerUrl)}" target="_blank" rel="noopener">open the full reader page ↗</a></div>`
    : '';
  return `<style>${SIMPLIFIED_CSS}</style>
<div class="wc-reader">
  ${head}
  <div data-wc-when="reduced">${lead}<div class="wc-reader-note">Expand this pane for the full simplified page.</div></div>
  <div data-wc-when="expanded">${simplified.bodyHtml}${note}${reader}</div>
</div>`;
}

// A standalone simplified HTML document — written to the sidecar and served by
// GET /api/captures/:id/simplified so the reader view opens in its own tab.
function simplifiedDocument({ title, url, byline, date, bodyHtml, truncated, bytes } = {}) {
  const head = headHtml({ title, url, byline, date });
  const note = truncated
    ? `<div class="wc-reader-note">Simplified view truncated at ${Math.floor((bytes || 0) / 1024)} KB. <a href="${esc(url)}" target="_blank" rel="noopener">Open the original</a> for the rest.</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Simplified page')}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: var(--wc-bg, #fff); }
  ${SIMPLIFIED_CSS}
</style>
</head>
<body>
<div class="wc-reader">
${head}
${bodyHtml || '<p style="color:#888">No readable content extracted.</p>'}
${note}
</div>
</body>
</html>`;
}

module.exports = { simplifyDom, simplifiedPaneInner, simplifiedDocument, SIMPLIFIED_CSS };
