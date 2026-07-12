// HTML-fragment → Markdown serializer — "capture highlighted text as Markdown".
// The tab-stream extension serializes the user's highlighted
// Range into an HTML fragment and POSTs it with `kind:'selection'`; the server
// distills it here. The Markdown IS the capture's distillate — get_captures
// returns it verbatim because the user already curated the excerpt, so the
// context cost is exactly what they highlighted (the ruled context-cost model).
//
// Built on the EXISTING node-html-parser dep (no new dependency). Two exports
// share one parse + one set of node-walk helpers:
//   - toMarkdown(html, { baseUrl }) → the distillate (for Claude / get_captures)
//   - toSafeHtml(html, { baseUrl }) → sanitized semantic HTML for the capture pane
//     (a "rendered markdown view": we render from the SAME parse rather than add a
//     Markdown-renderer dep, whitelisting tags/attrs so untrusted page markup can
//     never inject scripts/handlers into the shadow-mounted pane).

const { parse, NodeType } = require('node-html-parser');
const { escapeHtml } = require('../server/util/html');

const ELEMENT = NodeType.ELEMENT_NODE; // 1
const TEXT = NodeType.TEXT_NODE;       // 3

// Elements whose content is never user-visible prose — dropped wholesale so a
// stray <script>/<style> caught in the selection never leaks its body into the
// distillate or the pane.
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
  'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'button', 'input', 'select',
]);

// Block-level tags with a dedicated Markdown/HTML rendering.
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr']);

// Structural wrappers we recurse THROUGH (their inline runs become paragraphs,
// their block children render in place).
const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
  'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'address',
  'form', 'fieldset', 'blockquote',
]);

function tagOf(node) {
  return String((node && node.rawTagName) || '').toLowerCase();
}

// A node is block-level if it's a known block/container, or an unknown element
// that structurally contains a block child (so unrecognized wrappers still
// recurse correctly; unknown leaf elements fall through to inline → their text,
// per the ruling's "unknown blocks → their text").
function hasBlockChild(node) {
  return (node.childNodes || []).some(
    (c) => c.nodeType === ELEMENT && (BLOCK_TAGS.has(tagOf(c)) || CONTAINER_TAGS.has(tagOf(c))),
  );
}
function isBlock(node) {
  if (!node || node.nodeType !== ELEMENT) return false;
  const t = tagOf(node);
  if (SKIP_TAGS.has(t)) return false;
  if (BLOCK_TAGS.has(t) || CONTAINER_TAGS.has(t)) return true;
  return hasBlockChild(node);
}

// Resolve a possibly-relative URL against the captured page URL so links/images
// in the excerpt still point somewhere. With no base (unit tests / bare frag) the
// value passes through untouched.
function resolveUrl(u, base) {
  const s = String(u == null ? '' : u).trim();
  if (!s || !base) return s;
  try { return new URL(s, base).href; } catch { return s; }
}
function safeUrl(u, base) {
  const r = resolveUrl(u, base);
  return /^\s*(?:javascript|vbscript):/i.test(r) ? '' : r;
}

// Split a <pre> into { lang, code }. node-html-parser treats <pre> as a
// block-text element (its inner is one raw text node), so a wrapping <code> shows
// up as literal text — we lift the language off the raw class and strip the
// wrapper from the (entity-decoded) text.
function preParts(el) {
  const raw = String(el.rawText || '');
  const lm = raw.match(/<code[^>]*(?:language|lang)-([\w+#.-]+)/i);
  const lang = lm ? lm[1] : '';
  let code = String(el.text || '')
    .replace(/^\s*<code[^>]*>/i, '')
    .replace(/<\/code>\s*$/i, '')
    .replace(/\s+$/, '');
  return { lang, code };
}

/* ------------------------------------------------------------------ Markdown */

// Wrap inline emphasis without swallowing boundary spaces (` **x** ` not `** x **`).
function emphasize(s, marker) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const core = m[2];
  if (!core) return s;
  return m[1] + marker + core + marker + m[3];
}

function mdInline(nodes, opts) {
  let out = '';
  for (const n of nodes || []) {
    if (n.nodeType === TEXT) { out += String(n.text || '').replace(/\s+/g, ' '); continue; }
    if (n.nodeType !== ELEMENT) continue;
    const t = tagOf(n);
    if (SKIP_TAGS.has(t)) continue;
    if (t === 'br') { out += '  \n'; continue; }
    if (t === 'wbr') continue;
    if (t === 'a') {
      const href = safeUrl(n.getAttribute('href'), opts.baseUrl);
      const inner = mdInline(n.childNodes, opts).trim();
      out += href ? `[${inner || href}](${href})` : inner;
      continue;
    }
    if (t === 'strong' || t === 'b') { out += emphasize(mdInline(n.childNodes, opts), '**'); continue; }
    if (t === 'em' || t === 'i') { out += emphasize(mdInline(n.childNodes, opts), '*'); continue; }
    if (t === 'del' || t === 's' || t === 'strike') { out += emphasize(mdInline(n.childNodes, opts), '~~'); continue; }
    if (t === 'code') { out += '`' + String(n.text || '') + '`'; continue; }
    if (t === 'img') {
      const src = safeUrl(n.getAttribute('src'), opts.baseUrl);
      out += `![${String(n.getAttribute('alt') || '')}](${src})`;
      continue;
    }
    // Unknown / passthrough inline (span, sup, sub, mark, small, u, cite, …).
    out += mdInline(n.childNodes, opts);
  }
  return out;
}

function mdList(el, ordered, depth, opts) {
  const indent = '  '.repeat(depth);
  const items = (el.childNodes || []).filter((c) => c.nodeType === ELEMENT && tagOf(c) === 'li');
  const lines = [];
  items.forEach((li, i) => {
    const marker = ordered ? `${i + 1}. ` : '- ';
    const lead = (li.childNodes || []).filter((c) => !isBlock(c));
    const nested = (li.childNodes || []).filter((c) => isBlock(c));
    lines.push(indent + marker + mdInline(lead, opts).trim());
    for (const sub of nested) {
      const st = tagOf(sub);
      if (st === 'ul') lines.push(mdList(sub, false, depth + 1, opts));
      else if (st === 'ol') lines.push(mdList(sub, true, depth + 1, opts));
      else {
        const block = mdBlock(sub, opts);
        const cont = indent + '  ';
        lines.push(block.split('\n').map((l) => (l ? cont + l : l)).join('\n'));
      }
    }
  });
  return lines.join('\n');
}

function mdTable(el, opts) {
  const trs = el.querySelectorAll('tr');
  if (!trs.length) return '';
  const cellsOf = (tr) => (tr.childNodes || [])
    .filter((c) => c.nodeType === ELEMENT && (tagOf(c) === 'td' || tagOf(c) === 'th'))
    .map((c) => mdInline(c.childNodes, opts).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
  const header = cellsOf(trs[0]);
  const body = trs.slice(1).map(cellsOf);
  const cols = Math.max(header.length, ...body.map((r) => r.length), 1);
  const pad = (row) => { const r = row.slice(); while (r.length < cols) r.push(''); return r; };
  const line = (row) => '| ' + pad(row).join(' | ') + ' |';
  const sep = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  return [line(header), sep, ...body.map(line)].join('\n');
}

function mdBlock(el, opts) {
  const t = tagOf(el);
  if (/^h[1-6]$/.test(t)) return '#'.repeat(Number(t[1])) + ' ' + mdInline(el.childNodes, opts).trim();
  if (t === 'p') return mdInline(el.childNodes, opts).trim();
  if (t === 'ul') return mdList(el, false, 0, opts);
  if (t === 'ol') return mdList(el, true, 0, opts);
  if (t === 'blockquote') {
    const inner = mdBlocks(el, opts);
    return inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  }
  if (t === 'pre') {
    const { lang, code } = preParts(el);
    return '```' + lang + '\n' + code + '\n```';
  }
  if (t === 'table') return mdTable(el, opts);
  if (t === 'hr') return '---';
  if (CONTAINER_TAGS.has(t) || hasBlockChild(el)) return mdBlocks(el, opts);
  // Unknown leaf block → its text (ruling).
  return mdInline(el.childNodes, opts).trim();
}

// Walk a node's children, grouping inline runs into paragraphs and rendering
// block children in place. Blocks are separated by a blank line.
function mdBlocks(node, opts) {
  const blocks = [];
  let inline = [];
  const flush = () => {
    if (!inline.length) return;
    const text = mdInline(inline, opts).replace(/[ \t]+\n/g, '\n').trim();
    inline = [];
    if (text) blocks.push(text);
  };
  for (const child of node.childNodes || []) {
    if (isBlock(child)) { flush(); const b = mdBlock(child, opts); if (b && b.trim()) blocks.push(b); }
    else inline.push(child);
  }
  flush();
  return blocks.join('\n\n');
}

function toMarkdown(html, opts = {}) {
  const root = parse(String(html == null ? '' : html));
  return mdBlocks(root, { baseUrl: opts.baseUrl || '' }).trim();
}

/* ---------------------------------------------------------------- Safe HTML */

function htmlInline(nodes, opts) {
  let out = '';
  for (const n of nodes || []) {
    if (n.nodeType === TEXT) { out += escapeHtml(String(n.text || '').replace(/\s+/g, ' ')); continue; }
    if (n.nodeType !== ELEMENT) continue;
    const t = tagOf(n);
    if (SKIP_TAGS.has(t)) continue;
    if (t === 'br') { out += '<br>'; continue; }
    if (t === 'wbr') continue;
    if (t === 'a') {
      const href = safeUrl(n.getAttribute('href'), opts.baseUrl);
      const inner = htmlInline(n.childNodes, opts);
      out += href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      continue;
    }
    if (t === 'strong' || t === 'b') { out += `<strong>${htmlInline(n.childNodes, opts)}</strong>`; continue; }
    if (t === 'em' || t === 'i') { out += `<em>${htmlInline(n.childNodes, opts)}</em>`; continue; }
    if (t === 'del' || t === 's' || t === 'strike') { out += `<del>${htmlInline(n.childNodes, opts)}</del>`; continue; }
    if (t === 'code') { out += `<code>${escapeHtml(String(n.text || ''))}</code>`; continue; }
    if (t === 'img') {
      const src = safeUrl(n.getAttribute('src'), opts.baseUrl);
      if (src) out += `<img src="${escapeHtml(src)}" alt="${escapeHtml(n.getAttribute('alt') || '')}" style="max-width:100%">`;
      continue;
    }
    out += htmlInline(n.childNodes, opts);
  }
  return out;
}

function htmlList(el, ordered, opts) {
  const tag = ordered ? 'ol' : 'ul';
  const items = (el.childNodes || []).filter((c) => c.nodeType === ELEMENT && tagOf(c) === 'li');
  const lis = items.map((li) => {
    const lead = (li.childNodes || []).filter((c) => !isBlock(c));
    const nested = (li.childNodes || []).filter((c) => isBlock(c));
    let inner = htmlInline(lead, opts).trim();
    for (const sub of nested) {
      const st = tagOf(sub);
      if (st === 'ul') inner += htmlList(sub, false, opts);
      else if (st === 'ol') inner += htmlList(sub, true, opts);
      else inner += htmlBlock(sub, opts);
    }
    return `<li>${inner}</li>`;
  });
  return `<${tag}>${lis.join('')}</${tag}>`;
}

function htmlTable(el, opts) {
  const trs = el.querySelectorAll('tr');
  if (!trs.length) return '';
  const cellsOf = (tr) => (tr.childNodes || [])
    .filter((c) => c.nodeType === ELEMENT && (tagOf(c) === 'td' || tagOf(c) === 'th'))
    .map((c) => htmlInline(c.childNodes, opts).trim());
  const header = cellsOf(trs[0]);
  const body = trs.slice(1).map(cellsOf);
  const head = `<thead><tr>${header.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const rows = body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table>${head}<tbody>${rows}</tbody></table>`;
}

function htmlBlock(el, opts) {
  const t = tagOf(el);
  if (/^h[1-6]$/.test(t)) return `<${t}>${htmlInline(el.childNodes, opts)}</${t}>`;
  if (t === 'p') return `<p>${htmlInline(el.childNodes, opts)}</p>`;
  if (t === 'ul') return htmlList(el, false, opts);
  if (t === 'ol') return htmlList(el, true, opts);
  if (t === 'blockquote') return `<blockquote>${htmlBlocks(el, opts)}</blockquote>`;
  if (t === 'pre') { const { code } = preParts(el); return `<pre><code>${escapeHtml(code)}</code></pre>`; }
  if (t === 'table') return htmlTable(el, opts);
  if (t === 'hr') return '<hr>';
  if (CONTAINER_TAGS.has(t) || hasBlockChild(el)) return htmlBlocks(el, opts);
  return `<p>${htmlInline(el.childNodes, opts)}</p>`;
}

function htmlBlocks(node, opts) {
  const out = [];
  let inline = [];
  const flush = () => {
    if (!inline.length) return;
    const h = htmlInline(inline, opts).trim();
    inline = [];
    if (h) out.push(`<p>${h}</p>`);
  };
  for (const child of node.childNodes || []) {
    if (isBlock(child)) { flush(); const b = htmlBlock(child, opts); if (b) out.push(b); }
    else inline.push(child);
  }
  flush();
  return out.join('');
}

function toSafeHtml(html, opts = {}) {
  const root = parse(String(html == null ? '' : html));
  return htmlBlocks(root, { baseUrl: opts.baseUrl || '' });
}

module.exports = { toMarkdown, toSafeHtml };
