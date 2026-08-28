// YouTube individual-video extractor. root = node-html-parser document.
// Reads canonical values from rendered ytd-* elements + aria-labels, because
// YouTube's og: meta tags go stale across single-page-app navigation.
module.exports = ({ url, root, collapse: clean, safeHref }) => {
  // YouTube wraps external description links in /redirect?...&q=<real-url>: unwrap
  // that, then hand the result to the injected safeHref, which resolves it
  // against the captured page and refuses anything outside http/https/mailto/tel
  // (a /redirect?q= payload is attacker-controllable text). The site-specific
  // half is the unwrap; the URL rules are not site-specific, so they are not
  // re-implemented here.
  //
  // The dead `linkify`/`richText` pair that used to sit below — nothing called
  // them — went with the private escaper they carried.
  const base = (() => {
    try { return new URL(url).href; } catch (_) { return 'https://www.youtube.com/'; }
  })();
  const decodeHref = (href) => {
    if (!href) return '';
    if (/\/redirect\?/.test(href) || href.startsWith('/redirect')) {
      const m = href.match(/[?&]q=([^&]+)/);
      if (m) {
        try {
          return safeHref(decodeURIComponent(m[1]), base);
        } catch (_) {
          /* malformed percent-encoding — fall through to the plain resolve */
        }
      }
    }
    return safeHref(href, base);
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
