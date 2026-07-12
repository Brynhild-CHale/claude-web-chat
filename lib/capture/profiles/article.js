// Article generic: a content-matched rich extractor for
// article-shaped pages — those carrying an <article> element, or a headline plus
// enough paragraph density to read as prose. Slotted in the builtins array ABOVE
// `default` and BELOW `tables` (order: tables → article → default): a richer net
// than default's flat 20k-char text blob, but still a passive builtin. resolve()
// reports it matched:false (Contract 7) — it is the net, not a per-site profile,
// so it never offers the extension's "Capture with <name>" consent button.
//
// The DISTILLATE stays SMALL — structured blocks (headings, paragraphs with their
// inline links preserved, lists, images) under a ~30k text budget — so
// get_captures / Claude's context never pays for the page. The rich reader render
// is the PANE's job: article (like default) carries `simplified_pane: true`, and
// routes/capture.js renders the reader-lite simplified document (simplify.js) into
// the pane while this small distillate is what the model reads.

const { collapse, absolutize } = require('./util');

const TEXT_CAP = 30000; // total distilled text budget (~30k chars)

// Chrome / non-content containers we never descend into.
const SKIP = new Set([
  'nav', 'aside', 'header', 'footer', 'form', 'button', 'script', 'style',
  'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'select', 'label',
]);
// Generic wrappers we recurse THROUGH to reach the content blocks inside.
const STRUCTURAL = new Set([
  'div', 'section', 'article', 'main', 'body', 'details', 'summary', 'span',
]);

// Walk a paragraph/li subtree collecting its plain text and any inline <a href>
// links (absolutized) — links are preserved as { href, text } so the distilled
// content stays navigable without carrying raw markup.
function collectInline(node, origin, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out.text += child.rawText; continue; }
    if (child.nodeType !== 1) continue;
    const tag = (child.rawTagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    if (tag === 'br') { out.text += ' '; continue; }
    if (tag === 'a') {
      const before = out.text.length;
      collectInline(child, origin, out);
      const text = collapse(out.text.slice(before));
      const href = absolutize(child.getAttribute('href'), origin);
      if (href && !href.startsWith('#') && text) out.links.push({ href, text });
    } else {
      collectInline(child, origin, out);
    }
  }
}

function firstText(root, selectors, cap = 200) {
  for (const sel of selectors) {
    let el = null;
    try { el = root.querySelector(sel); } catch { continue; }
    const t = collapse(el && el.text);
    if (t) return t.slice(0, cap);
  }
  return null;
}

function walk(node, origin, blocks, budget) {
  for (const child of node.childNodes) {
    if (budget.chars >= TEXT_CAP) { budget.truncated = true; return; }
    if (child.nodeType !== 1) continue;
    const tag = (child.rawTagName || '').toLowerCase();
    if (SKIP.has(tag)) continue;

    if (/^h[1-6]$/.test(tag)) {
      const text = collapse(child.text);
      if (text) { blocks.push({ type: 'heading', level: +tag[1], text }); budget.chars += text.length; }
    } else if (tag === 'p') {
      const acc = { text: '', links: [] };
      collectInline(child, origin, acc);
      const text = collapse(acc.text);
      if (text) {
        const b = { type: 'para', text };
        if (acc.links.length) b.links = acc.links;
        blocks.push(b);
        budget.chars += text.length;
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const items = child.querySelectorAll('li').map((li) => collapse(li.text)).filter(Boolean);
      if (items.length) {
        blocks.push({ type: 'list', ordered: tag === 'ol', items });
        budget.chars += items.join(' ').length;
      }
    } else if (tag === 'blockquote') {
      const text = collapse(child.text);
      if (text) { blocks.push({ type: 'quote', text }); budget.chars += text.length; }
    } else if (tag === 'pre') {
      const text = child.text.replace(/\s+$/, '');
      if (text.trim()) {
        const clipped = text.slice(0, 4000);
        blocks.push({ type: 'code', text: clipped });
        budget.chars += clipped.length;
      }
    } else if (tag === 'figure') {
      const img = child.querySelector('img');
      const caption = collapse(child.querySelector('figcaption')?.text || '') || null;
      if (img) {
        const src = absolutize(img.getAttribute('src'), origin);
        if (src) blocks.push({ type: 'image', src, alt: collapse(img.getAttribute('alt') || '') || null, caption });
      }
    } else if (tag === 'img') {
      const src = absolutize(child.getAttribute('src'), origin);
      if (src) blocks.push({ type: 'image', src, alt: collapse(child.getAttribute('alt') || '') || null });
    } else if (STRUCTURAL.has(tag)) {
      walk(child, origin, blocks, budget);
    }
    // else: unknown inline-level tag at block scope — skip.
  }
}

module.exports = {
  name: 'article',
  description: 'Rich generic for article-shaped pages (an <article> element, or a headline plus paragraph density). Distills title/byline/date plus structured blocks — headings, paragraphs with inline links, lists, images — under a ~30k text cap. Passive builtin (no consent button); the reader-lite pane is rendered by the simplified-site transform.',
  // Passive builtins carry a `simplified_pane` flag so routes/capture.js renders
  // the reader-lite simplified document into the pane (the human's rich view)
  // while this small distillate is what reaches the agent.
  simplified_pane: true,
  // Content-based, dependency-light (regex on the HTML string, like `tables`):
  // an <article> element, OR an <h1> plus >=5 paragraphs.
  match: (url, html) => {
    const h = html || '';
    if (/<article[\s>]/i.test(h)) return true;
    const paras = (h.match(/<p[\s>]/gi) || []).length;
    return paras >= 5 && /<h1[\s>]/i.test(h);
  },
  extract({ url, root }) {
    if (!root) return { kind: 'article', url, title: '', byline: null, date: null, blocks: [], block_count: 0, text_chars: 0, note: 'parse failed' };

    let origin = '';
    try { origin = new URL(url).origin; } catch {}

    const container =
      root.querySelector('article') ||
      root.querySelector('main') ||
      root.querySelector('[role=main]') ||
      root.querySelector('body') ||
      root;

    const title = collapse(
      root.querySelector('article h1')?.text ||
      root.querySelector('h1')?.text ||
      root.querySelector('title')?.text ||
      ''
    );

    const byline = firstText(root, ['[rel=author]', '[itemprop=author]', '.byline', '.author', 'article address', 'address']);

    let date = null;
    const timeEl = root.querySelector('time[datetime]') || root.querySelector('time');
    if (timeEl) date = collapse(timeEl.getAttribute('datetime') || timeEl.text) || null;
    if (!date) date = firstText(root, ['[itemprop=datePublished]', '.published', '.date', '.timestamp']);

    const blocks = [];
    const budget = { chars: 0, truncated: false };
    walk(container, origin, blocks, budget);

    return {
      kind: 'article',
      url,
      title,
      byline: byline || null,
      date: date || null,
      blocks,
      block_count: blocks.length,
      text_chars: budget.chars,
      truncated: budget.truncated,
    };
  },
};
