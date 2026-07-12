// YouTube individual-video extractor. root = node-html-parser document.
// Reads canonical values from rendered ytd-* elements + aria-labels, because
// YouTube's og: meta tags go stale across single-page-app navigation.
module.exports = ({ url, html, root }) => {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );

  const clean = (s) =>
    (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  // YouTube wraps external description links in /redirect?...&q=<real-url>.
  const decodeHref = (href) => {
    if (!href) return href;
    if (/\/redirect\?/.test(href) || href.startsWith('/redirect')) {
      const m = href.match(/[?&]q=([^&]+)/);
      if (m) {
        try {
          return decodeURIComponent(m[1]);
        } catch (_) {
          /* fall through */
        }
      }
    }
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return 'https://www.youtube.com' + href;
    return href;
  };

  const hasClass = (el, name) =>
    ((el && el.getAttribute && el.getAttribute('class')) || '')
      .split(/\s+/)
      .includes(name);

  // Render a node to HTML keeping only <a> (href cleaned), dropping images/icons.
  const linkify = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return esc(node.rawText);
    if (node.nodeType !== 1) return '';
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'img' || tag === 'svg' || tag === 'style' || tag === 'script') return '';
    if (tag === 'br') return '\n';
    const inner = node.childNodes.map(linkify).join('');
    if (tag === 'a') {
      const href = decodeHref(node.getAttribute('href') || '');
      const text = clean(inner);
      if (!href || !text) return text;
      return `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
    }
    return inner;
  };

  const richText = (el) => {
    if (!el) return '';
    // collapse runs of spaces but keep newlines from <br>
    return el.childNodes
      .map(linkify)
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim();
  };

  // Video id from the URL (watch?v=, youtu.be/, /shorts/, /embed/).
  const idMatch =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/\/(?:shorts|embed)\/([\w-]{11})/);
  const videoId = idMatch ? idMatch[1] : null;

  const title = clean(root.querySelector('ytd-watch-metadata h1')?.text) ||
    clean(root.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.text) || null;

  // Channel
  const chA = root.querySelector('ytd-watch-metadata #owner ytd-channel-name a') ||
    root.querySelector('ytd-video-owner-renderer ytd-channel-name a');
  const channel = chA
    ? { name: clean(chA.text), url: decodeHref(chA.getAttribute('href') || '') }
    : null;
  const subscribers =
    clean(root.querySelector('ytd-watch-metadata #owner #owner-sub-count')?.text) || null;

  // Views & date live in aria-labels (the visible text is a digit-roll animation).
  const ariaOf = (sel) => {
    const el = root.querySelector(sel);
    return el ? clean(el.getAttribute('aria-label')) : null;
  };
  const views = ariaOf('#view-count') || null;
  const published = ariaOf('#date-text') || null;

  // Likes from the like button's aria-label ("like this video along with N other people").
  let likes = null;
  for (const b of root.querySelectorAll('button[aria-label]')) {
    const m = (b.getAttribute('aria-label') || '').match(/along with ([\d,.]+[KMB]?) other/i);
    if (m) {
      likes = m[1];
      break;
    }
  }

  // Description snippet (the real description start; YouTube lazy-renders the
  // full body only on expand, so the snippet is what's reliably present).
  const descRoot =
    root.querySelector('#description-inline-expander') ||
    root.querySelector('ytd-watch-metadata #description');
  const description =
    clean(root.querySelector('#attributed-snippet-text')?.text) || null;

  // AI-generated summary, when YouTube provides one (the node repeats the text
  // and carries label chrome — strip both).
  let summary = clean(root.querySelector('#video-summary')?.text) || null;
  if (summary) {
    summary = summary
      .replace(/\s*AI-generated video summary.*$/i, '')
      .replace(/^Summary\s+/i, '')
      .trim() || null;
  }

  // Description links — the genuine body links (class ytAttributedStringLink);
  // external ones are unwrapped from /redirect?...&q=, internal ones absolutized.
  // (ytAttributedStringLink also tags the left-nav subscription guide, which is
  // all youtube.com/@handle or /channel/ links — exclude those; keep externals
  // and in-video youtube.com/watch links.)
  const links = [];
  const seen = new Set();
  for (const a of root.querySelectorAll('a')) {
    if (!/ytAttributedStringLink/.test(a.getAttribute('class') || '')) continue;
    const href = decodeHref(a.getAttribute('href') || '');
    if (!/^https?:\/\//.test(href) || seen.has(href)) continue;
    if (/youtube\.com\/(@|channel\/)/.test(href)) continue;
    const text = clean(a.text);
    if (text && text.length < 3) continue; // skip bare social-icon links ("X")
    seen.add(href);
    links.push({ text: text || href, href });
    if (links.length >= 25) break;
  }

  const thumbnail = videoId
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : null;

  return {
    kind: 'youtube',
    url,
    videoId,
    title,
    channel,
    subscribers,
    views,
    published,
    likes,
    thumbnail,
    description,
    summary,
    links,
  };
};
