// Reddit post-page extractor. root = node-html-parser document.
//
// DOM choice (documented in profile.json): modern Reddit renders each post as a
// <shreddit-post> web component and each comment as a <shreddit-comment>, both
// carrying SEMANTIC attributes (author, subreddit-prefixed-name, permalink,
// post-title, score, comment-count, post-type, content-href) that are part of the
// component's public surface and survive CSS/redesign churn far better than class
// names. We read those attributes first, and fall back to old.reddit's equally
// stable div.thing / div.comment `data-*` attributes so old.reddit captures still
// distill. Both paths produce the SAME shape.
//
// Distilled: post title + author + subreddit, self-text body (links preserved),
// the primary image for image posts, and the TOP FEW top-level comments (author +
// text + permalink each), plus a link to open the thread (titleHref).
module.exports = ({ url, html, root }) => {
  const MAX_COMMENTS = 5;
  const COMMENT_TEXT_CAP = 1200;
  const BODY_PARA_CAP = 20;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );

  const clean = (s) =>
    (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch (_) {
      return 'https://www.reddit.com';
    }
  })();

  const absolutize = (href) => {
    if (!href) return href;
    href = String(href).replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return origin + href;
    return href;
  };

  // r/<sub> / u/<user> display + href normalization (inputs come bare or prefixed).
  const subDisplay = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    return s.startsWith('r/') ? s : 'r/' + s.replace(/^\//, '');
  };
  const subHref = (raw) => {
    const d = subDisplay(raw);
    return d ? origin + '/' + d : null;
  };
  const userName = (raw) => (raw ? String(raw).replace(/^u\//, '').replace(/^\//, '') : null);
  const userDisplay = (raw) => {
    const n = userName(raw);
    return n && n !== '[deleted]' ? 'u/' + n : n ? n : null;
  };
  const userHref = (raw) => {
    const n = userName(raw);
    return n && n !== '[deleted]' ? origin + '/user/' + n : null;
  };

  const fmtDate = (v) => {
    if (v == null || v === '') return null;
    const t = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
    return isNaN(t) ? String(v) : new Date(t).toISOString().slice(0, 10);
  };

  const imgLike = (u) =>
    /(?:i\.redd\.it|preview\.redd\.it|i\.imgur\.com|\.(?:jpe?g|png|gif|webp))(?:$|[?#])/i.test(u || '');

  // Render a node to HTML keeping ONLY <a href> (absolutized, page-anchor links
  // collapsed to plain text) — drop images/svg/scripts and every other tag's
  // markup while preserving its text.
  const linkify = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return esc(node.rawText);
    if (node.nodeType !== 1) return '';
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'img' || tag === 'svg') return '';
    if (tag === 'br') return ' ';
    const inner = node.childNodes.map(linkify).join('');
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return inner;
      return `<a href="${esc(absolutize(href))}" target="_blank" rel="noopener">${inner}</a>`;
    }
    return inner;
  };
  const richHtml = (el) =>
    el ? el.childNodes.map(linkify).join('').replace(/\s+/g, ' ').trim() : '';
  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');

  // Body paragraphs, links preserved (mirrors wikipedia's summaryHtml[] shape).
  // Handles plain paragraphs and flattens list items to "• item" lines.
  const bodyParagraphs = (mdEl) => {
    if (!mdEl) return [];
    const out = [];
    const blocks = mdEl.childNodes.filter((n) => n.nodeType === 1);
    if (!blocks.length) {
      const t = richHtml(mdEl);
      return t ? [t.slice(0, 1500)] : [];
    }
    for (const ch of blocks) {
      const tag = (ch.rawTagName || '').toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        for (const li of ch.querySelectorAll('li')) {
          const t = richHtml(li);
          if (t) out.push('• ' + t.slice(0, 1500));
          if (out.length >= BODY_PARA_CAP) return out;
        }
      } else {
        const t = richHtml(ch);
        if (t) out.push(t.slice(0, 1500));
      }
      if (out.length >= BODY_PARA_CAP) break;
    }
    return out;
  };

  // Structural top-level test: a comment is top-level iff it has no same-kind
  // ancestor (a <shreddit-comment> under a <shreddit-comment>, or a .comment under
  // a .comment, is a reply). Depth-attribute-independent, so it holds even when a
  // page omits `depth`.
  const hasClass = (el, name) =>
    ((el && el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).includes(name);
  const ancestorMatches = (el, test) => {
    let p = el.parentNode;
    while (p) {
      if (test(p)) return true;
      p = p.parentNode;
    }
    return false;
  };
  const nestedUnderTag = (el, tag) =>
    ancestorMatches(el, (p) => (p.rawTagName || '').toLowerCase() === tag);
  const nestedUnderClass = (el, cls) => ancestorMatches(el, (p) => hasClass(p, cls));

  const makeComment = ({ author, permalink, score, bodyEl }) => {
    const htmlText = richHtml(bodyEl);
    const text = stripTags(htmlText).trim().slice(0, COMMENT_TEXT_CAP);
    if (!text) return null;
    return {
      author: userDisplay(author) || 'u/[deleted]',
      authorHref: userHref(author),
      score: score != null && score !== '' ? String(score) : null,
      permalink: permalink ? absolutize(permalink) : null,
      text,
      textHtml: htmlText,
    };
  };

  // ---- shreddit (modern reddit: www / new / np) --------------------------------
  const extractShreddit = () => {
    const post = root.querySelector('shreddit-post');
    if (!post) return null;

    const title =
      clean(post.getAttribute('post-title')) ||
      clean(post.querySelector('[slot="title"]')?.text) ||
      clean(post.querySelector('h1')?.text) ||
      null;

    const permalink = post.getAttribute('permalink') || null;
    const titleHref = permalink ? absolutize(permalink) : url;

    const bodyContainer = post.querySelector('[slot="text-body"]');
    const mdEl = bodyContainer
      ? bodyContainer.querySelector('.md') || bodyContainer
      : null;
    const bodyHtml = bodyParagraphs(mdEl);

    const postType = (post.getAttribute('post-type') || '').toLowerCase() || null;
    const contentHref = post.getAttribute('content-href') || null;

    // Primary image (image posts): the rendered media, else an image-like
    // content-href.
    let image = null;
    const mediaImg =
      post.querySelector('[slot="post-media-container"] img[src]') ||
      post.querySelector('figure img[src]') ||
      post.querySelector('img[src*="redd.it"]');
    const mediaSrc = mediaImg ? absolutize(mediaImg.getAttribute('src') || '') : '';
    if (mediaSrc) image = { src: mediaSrc, alt: clean(mediaImg.getAttribute('alt')) || null };
    else if (contentHref && imgLike(contentHref)) image = { src: absolutize(contentHref), alt: null };

    const linkUrl =
      !image && contentHref && !/reddit\.com/.test(contentHref) ? absolutize(contentHref) : null;

    // Top-level comments in document order (reddit renders best/top first).
    const comments = [];
    for (const c of root.querySelectorAll('shreddit-comment')) {
      if (nestedUnderTag(c, 'shreddit-comment')) continue; // a reply, not top-level
      const bodyEl = c.querySelector('[slot="comment"]');
      const cm = makeComment({
        author: c.getAttribute('author'),
        permalink: c.getAttribute('permalink'),
        score: c.getAttribute('score'),
        bodyEl,
      });
      if (cm) comments.push(cm);
      if (comments.length >= MAX_COMMENTS) break;
    }

    return {
      source: 'shreddit',
      title,
      titleHref,
      author: userDisplay(post.getAttribute('author')),
      authorHref: userHref(post.getAttribute('author')),
      subreddit: subDisplay(post.getAttribute('subreddit-prefixed-name') || post.getAttribute('subreddit-name')),
      subredditHref: subHref(post.getAttribute('subreddit-prefixed-name') || post.getAttribute('subreddit-name')),
      score: post.getAttribute('score') || null,
      commentCount: post.getAttribute('comment-count') || null,
      created: fmtDate(post.getAttribute('created-timestamp')),
      postType: postType || (image ? 'image' : linkUrl ? 'link' : 'text'),
      bodyHtml,
      image,
      linkUrl,
      comments,
    };
  };

  // ---- old.reddit --------------------------------------------------------------
  const extractOld = () => {
    const thing = root.querySelector('div.thing.link') || root.querySelector('.thing');
    if (!thing) return null;

    const title =
      clean(thing.querySelector('a.title')?.text) ||
      clean(root.querySelector('title')?.text).replace(/\s*:\s*r\/.*$/i, '') ||
      null;

    const permalink = thing.getAttribute('data-permalink') || thing.querySelector('a.bylink')?.getAttribute('href') || null;
    const titleHref = permalink ? absolutize(permalink) : url;

    const mdEl =
      thing.querySelector('.expando .usertext-body .md') ||
      thing.querySelector('.usertext-body .md') ||
      null;
    const bodyHtml = bodyParagraphs(mdEl);

    const dataUrl = thing.getAttribute('data-url') || null;
    let image = null;
    if (imgLike(dataUrl)) image = { src: absolutize(dataUrl), alt: null };
    else {
      const im = thing.querySelector('.expando img[src]');
      if (im) image = { src: absolutize(im.getAttribute('src') || ''), alt: clean(im.getAttribute('alt')) || null };
    }
    const linkUrl =
      !image && dataUrl && !/reddit\.com/.test(dataUrl) && !imgLike(dataUrl) ? absolutize(dataUrl) : null;

    const postScoreEl = thing.querySelector('.score.unvoted') || thing.querySelector('.score');
    const score = postScoreEl ? postScoreEl.getAttribute('title') || clean(postScoreEl.text) : null;

    const comments = [];
    for (const c of root.querySelectorAll('.comment')) {
      if (nestedUnderClass(c, 'comment')) continue; // a reply, not top-level
      const scoreEl = c.querySelector('.tagline .score.unvoted') || c.querySelector('.tagline .score');
      const cm = makeComment({
        author: c.getAttribute('data-author') || c.querySelector('.tagline a.author')?.text,
        permalink:
          c.getAttribute('data-permalink') || c.querySelector('a.bylink')?.getAttribute('href'),
        score: scoreEl ? scoreEl.getAttribute('title') || clean(scoreEl.text) : null,
        bodyEl: c.querySelector('.usertext-body .md') || c.querySelector('.usertext-body'),
      });
      if (cm) comments.push(cm);
      if (comments.length >= MAX_COMMENTS) break;
    }

    return {
      source: 'old.reddit',
      title,
      titleHref,
      author: userDisplay(thing.getAttribute('data-author')),
      authorHref: userHref(thing.getAttribute('data-author')),
      subreddit: subDisplay(thing.getAttribute('data-subreddit-prefixed') || thing.getAttribute('data-subreddit')),
      subredditHref: subHref(thing.getAttribute('data-subreddit-prefixed') || thing.getAttribute('data-subreddit')),
      score,
      commentCount: thing.getAttribute('data-comments-count') || null,
      created: fmtDate(thing.getAttribute('data-timestamp')),
      postType: image ? 'image' : linkUrl ? 'link' : 'text',
      bodyHtml,
      image,
      linkUrl,
      comments,
    };
  };

  const distilled = extractShreddit() || extractOld() || {
    source: 'unknown',
    title: clean(root.querySelector('title')?.text) || null,
    titleHref: url,
    author: null,
    authorHref: null,
    subreddit: null,
    subredditHref: null,
    score: null,
    commentCount: null,
    created: null,
    postType: 'text',
    bodyHtml: [],
    image: null,
    linkUrl: null,
    comments: [],
  };

  return { kind: 'reddit', url, ...distilled };
};
