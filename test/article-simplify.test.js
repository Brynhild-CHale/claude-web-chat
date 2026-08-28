// Article generic + reader-lite simplified-site pane.
//
// Two features, one file:
//   1. `article` — a content-matched BUILTIN distiller for article-shaped pages,
//      slotted tables → article → default. Small STRUCTURED distillate (headings,
//      paragraphs with inline links, lists, images) under a ~30k text cap.
//   2. The simplified-site PANE — a server-side reader-lite render over the parsed
//      DOM (scripts/site-CSS/iframes stripped, structure kept, absolute URLs) that
//      article AND default render into their capture pane. CRITICAL split: the rich
//      render is the pane + a sidecar; the distillate get_captures returns stays
//      small so Claude's context never pays for it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

// ~/.web-chat is already isolated: test-support/sandbox (loaded by --import
// before any require, and by helpers above as a fallback) points HOME at a
// throwaway dir, so the dev machine's real global profiles cannot shadow the
// builtins (article/default) these tests exercise. Paths are computed per-call,
// so the redirect governs every resolve regardless of require order.

const reg = require('../lib/capture/profiles');
const article = require('../lib/capture/profiles/article');
const { simplifyDom, simplifiedDocument } = require('../lib/capture/profiles/simplify');

const FIXTURES = path.join(__dirname, 'fixtures', 'profiles');
const ARTICLE_HTML = fs.readFileSync(path.join(FIXTURES, 'article.html'), 'utf8');
const ARTICLE_URL = 'https://blog.example.com/posts/my-article';

// A plain page: one paragraph, a script — the shape that must resolve to `default`.
const PLAIN_HTML = '<html><head><title>Doc</title></head><body>'
  + '<p>SECRET-MARKER hello world</p><script>var x=1</script></body></html>';

// ---------------------------------------------------------------------------
// article — the extractor + match heuristic
// ---------------------------------------------------------------------------

test('article match: fires on <article>, on h1 + paragraph density, not on a lone <p>', () => {
  assert.equal(article.match('u', '<article><p>hi</p></article>'), true, '<article> element matches');
  const dense = '<h1>T</h1>' + '<p>x</p>'.repeat(5);
  assert.equal(article.match('u', dense), true, 'h1 + 5 paragraphs matches');
  assert.equal(article.match('u', '<h1>T</h1><p>x</p>'), false, 'h1 + 1 paragraph does not match');
  assert.equal(article.match('u', PLAIN_HTML), false, 'a lone-paragraph page does not match');
});

test('article extract: structured distillate preserves headings, linked paragraphs, lists, images', () => {
  const d = article.extract({ url: ARTICLE_URL, root: reg.safeParse(ARTICLE_HTML) });

  assert.equal(d.kind, 'article');
  assert.equal(d.title, 'How Serpentine Rivers Form', 'title lifted from article h1');
  assert.equal(d.byline, 'Jane Doe', 'byline lifted from [rel=author]');
  assert.match(d.date, /2026-07-01/, 'date lifted from <time datetime>');
  assert.ok(d.truncated === false, 'well under the text cap');

  const types = d.blocks.map((b) => b.type);
  assert.ok(types.includes('heading'), 'headings preserved');
  assert.ok(types.includes('para'), 'paragraphs preserved');
  assert.ok(types.includes('list'), 'lists preserved');
  assert.ok(types.includes('image'), 'images preserved');

  // Section headings (h2) are kept as blocks (the h1 lives in a skipped <header>).
  const headings = d.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.ok(headings.includes('The mechanism'), 'a body section heading is captured');

  // A paragraph carries its inline links as { href, text }, absolutized.
  const linked = d.blocks.find((b) => b.type === 'para' && b.links && b.links.length);
  assert.ok(linked, 'at least one paragraph carries inline links');
  assert.ok(linked.links.every((l) => /^https?:\/\//.test(l.href) && l.text), 'links are absolute with text');
  const hrefs = d.blocks.flatMap((b) => (b.links || []).map((l) => l.href));
  assert.ok(hrefs.includes('https://blog.example.com/topics/meander'), 'relative href absolutized to the page origin');
  assert.ok(hrefs.includes('https://usgs.example.gov/rivers'), 'already-absolute href preserved');

  // Lists carry their items as text; both the ul and ol are present.
  const lists = d.blocks.filter((b) => b.type === 'list');
  assert.ok(lists.some((l) => !l.ordered && l.items.length === 3), 'unordered list with 3 items');
  assert.ok(lists.some((l) => l.ordered && l.items.length === 3), 'ordered list with 3 items');

  // Image src is absolutized; alt preserved.
  const img = d.blocks.find((b) => b.type === 'image');
  assert.equal(img.src, 'https://blog.example.com/img/serpentine.jpeg', 'image src absolutized');
  assert.match(img.alt, /serpentine river/i, 'image alt preserved');
});

test('article extract: honors the ~30k text cap (truncates a huge body)', () => {
  const big = '<html><body><article>'
    + ('<p>' + 'x'.repeat(90) + '</p>').repeat(500)
    + '</article></body></html>';
  const d = article.extract({ url: 'https://x/big', root: reg.safeParse(big) });
  assert.equal(d.truncated, true, 'truncated flag set past the cap');
  assert.ok(d.text_chars >= 30000 && d.text_chars <= 31000, `text_chars near the 30k cap (got ${d.text_chars})`);
});

test('article resolves via the registry below tables and above default', () => {
  reg.loadUserProfiles({ PROFILES_DIR: '/nope/project', SYSTEM_PROFILES_DIR: '/nope/global' });

  // An article-shaped page with no table → article.
  const a = reg.resolve({ url: ARTICLE_URL, html: ARTICLE_HTML });
  assert.equal(a.profile.name, 'article');
  assert.equal(a.tier, 'builtin');
  assert.equal(a.matched, false, 'the net is passive — no consent button (Contract 7)');

  // A page carrying BOTH an <article> and a <table> → tables wins (it is first in
  // the builtins array; article is slotted below it).
  const both = '<html><body><article><h1>T</h1><table><tr><td>a</td></tr></table></article></body></html>';
  assert.equal(reg.resolve({ url: 'https://x/both', html: both }).profile.name, 'tables');

  // A lone-paragraph page → default (article does not match).
  assert.equal(reg.resolve({ url: 'https://x/plain', html: PLAIN_HTML }).profile.name, 'default');
});

// ---------------------------------------------------------------------------
// simplify — the reader-lite transform (unit)
// ---------------------------------------------------------------------------

test('simplifyDom: strips scripts/iframes/handlers/site-CSS, keeps semantic structure with absolute URLs', () => {
  const s = simplifyDom(reg.safeParse(ARTICLE_HTML), { url: ARTICLE_URL });

  assert.ok(s.bytes > 0 && s.truncated === false);
  const b = s.bodyHtml;

  // Structure kept.
  assert.match(b, /<h2>The mechanism<\/h2>/, 'section heading kept');
  assert.match(b, /<p>/, 'paragraphs kept');
  assert.match(b, /<ul>.*<li>/s, 'unordered list kept');
  assert.match(b, /<ol>.*<li>/s, 'ordered list kept');
  assert.match(b, /<blockquote>/, 'blockquote kept');
  assert.match(b, /<figure><img src="https:\/\/blog\.example\.com\/img\/serpentine\.jpeg"/, 'figure/image with absolute src');
  assert.match(b, /<a href="https:\/\/blog\.example\.com\/topics\/meander"[^>]*>meander<\/a>/, 'inline link absolutized, text kept');
  assert.match(b, /href="https:\/\/cdn\.example\.net\/data\/flow\.csv"/, 'protocol-relative link absolutized');

  // Stripped.
  assert.equal(/<script/i.test(b), false, 'no <script>');
  assert.equal(/<iframe/i.test(b), false, 'no <iframe>');
  assert.equal(/onclick/i.test(b), false, 'no inline event handlers');
  assert.equal(/hotpink/i.test(b), false, 'no site CSS');
  assert.equal(/site-nav|Sign in/i.test(b), false, 'nav chrome dropped');
  assert.equal(/newsletter/i.test(b), false, 'aside promo dropped');
});

// ---------------------------------------------------------------------------
// Entity decoding + nested lists: the three walkers must agree
// ---------------------------------------------------------------------------

// One paragraph, one nested list — the two shapes the walkers disagreed on.
// `&amp;` `&#8217;` `&nbsp;` are ubiquitous in real pages, so this hit nearly
// every capture: article emitted the raw source text, simplify escaped THAT and
// so double-escaped it into the pane and the sidecar, and only markdown was
// right.
const ENTITY_URL = 'https://e.example.com/post';
const ENTITY_FRAG = '<p>Tom &amp; Jerry&#8217;s&nbsp;show</p>'
  + '<ul><li>outer<ul><li>inner</li></ul></li><li>sibling</li></ul>';
const ENTITY_HTML = `<html><body><article>${ENTITY_FRAG}</article></body></html>`;
const DECODED = 'Tom & Jerry\u2019s show';

// Compare the three walkers on TEXT, not markup: strip tags, unescape the five
// characters escapeHtml writes, collapse whitespace.
function readable(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

test('article/simplify/markdown: the same paragraph decodes to the same text in all three', () => {
  const { toMarkdown } = require('../lib/capture/markdown');

  const para = article.extract({ url: ENTITY_URL, root: reg.safeParse(ENTITY_HTML) })
    .blocks.find((b) => b.type === 'para');
  assert.equal(para.text, DECODED, 'the article distillate carries decoded text, not source text');

  const body = simplifyDom(reg.safeParse(ENTITY_HTML), { url: ENTITY_URL }).bodyHtml;
  assert.match(body, /<p>Tom &amp; Jerry\u2019s\u00a0show<\/p>/,
    'the reader render escapes ONCE from decoded text (never &amp;amp;)');
  assert.doesNotMatch(body, /&amp;(amp|nbsp|#8217);/, 'no double-escaped entity reaches the pane');

  const md = toMarkdown(ENTITY_FRAG, { baseUrl: ENTITY_URL });

  assert.equal(readable(body).split(' outer')[0], DECODED);
  assert.equal(readable(md).split(/\n|- outer/)[0].trim(), DECODED);
  assert.equal(para.text, readable(body).split(' outer')[0], 'article agrees with simplify');
});

test('article/simplify: a nested list yields each item once, not twice', () => {
  const { toMarkdown } = require('../lib/capture/markdown');

  const list = article.extract({ url: ENTITY_URL, root: reg.safeParse(ENTITY_HTML) })
    .blocks.find((b) => b.type === 'list');
  assert.deepEqual(list.items, ['outerinner', 'sibling'],
    'the nested item is not also emitted as a top-level item');

  const body = simplifyDom(reg.safeParse(ENTITY_HTML), { url: ENTITY_URL }).bodyHtml;
  const items = body.match(/<li>/g) || [];
  assert.equal(items.length, 2, 'the reader render emits two <li>, not three');

  // markdown was always right here; it stays right.
  assert.match(toMarkdown(ENTITY_FRAG), /- outer\n {2}- inner\n- sibling/);
});

// ---------------------------------------------------------------------------
// URL handling: the page URL is the base, and the scheme is gated
// ---------------------------------------------------------------------------

// One deep page, one of every href shape a real page throws at a walker.
const LINKS_URL = 'https://x.example.com/a/b/page.html';
const LINKS_HTML = '<html><body><article>'
  + '<p><a href="c.html">rel</a> <a href="../d.html">up</a> <a href="/root.html">root</a>'
  + ' <a href="//cdn.example.net/f.html">proto</a> <a href="https://other.example/g">abs</a></p>'
  + '<p><a href="javascript:alert(1)">js</a> <a href="java&#9;script:alert(2)">jstab</a>'
  + ' <a href="data:text/html,<b>x</b>">data</a></p>'
  + '<img src="img/pic.png" alt="pic">'
  + '</article></body></html>';

test('article/simplify: document-relative hrefs resolve against the page URL, not its origin', () => {
  const root = reg.safeParse(LINKS_HTML);
  const hrefs = article.extract({ url: LINKS_URL, root })
    .blocks.flatMap((b) => (b.links || []).map((l) => l.href));

  assert.ok(hrefs.includes('https://x.example.com/a/b/c.html'), 'c.html resolves beside the page');
  assert.ok(hrefs.includes('https://x.example.com/a/d.html'), '../d.html walks up one directory');
  assert.ok(hrefs.includes('https://x.example.com/root.html'), 'a root-relative href still hits the root');
  assert.ok(hrefs.includes('https://cdn.example.net/f.html'), 'protocol-relative href takes the page scheme');
  assert.ok(hrefs.includes('https://other.example/g'), 'an absolute href is untouched');

  // The image src takes the same base.
  const img = article.extract({ url: LINKS_URL, root: reg.safeParse(LINKS_HTML) })
    .blocks.find((b) => b.type === 'image');
  assert.equal(img.src, 'https://x.example.com/a/b/img/pic.png', 'image src resolves beside the page');

  const b = simplifyDom(reg.safeParse(LINKS_HTML), { url: LINKS_URL }).bodyHtml;
  assert.match(b, /href="https:\/\/x\.example\.com\/a\/b\/c\.html"/, 'the reader render resolves the same way');
  assert.match(b, /href="https:\/\/x\.example\.com\/a\/d\.html"/);
  assert.match(b, /src="https:\/\/x\.example\.com\/a\/b\/img\/pic\.png"/);
});

test('article/simplify/markdown: javascript: and data: hrefs are dropped, their text kept', () => {
  const d = article.extract({ url: LINKS_URL, root: reg.safeParse(LINKS_HTML) });
  const hrefs = d.blocks.flatMap((b) => (b.links || []).map((l) => l.href));
  assert.equal(hrefs.some((h) => /javascript:/i.test(h)), false, 'no javascript: href in the distillate');
  assert.equal(hrefs.some((h) => /^data:/i.test(h)), false, 'no data: href in the distillate');
  // The words survive — only the href is refused.
  const paraText = d.blocks.filter((b) => b.type === 'para').map((b) => b.text).join(' ');
  assert.match(paraText, /js jstab data/, 'the link text is still in the distilled text');

  const b = simplifyDom(reg.safeParse(LINKS_HTML), { url: LINKS_URL }).bodyHtml;
  assert.doesNotMatch(b, /javascript:/i, 'the reader render emits no javascript: href');
  assert.doesNotMatch(b, /href="data:/i, 'the reader render emits no data: href');
  assert.match(b, /<p>js jstab data<\/p>/, 'link text kept in the reader render');

  // The tab-obfuscated spelling is normalised by `new URL` before the scheme is
  // read, so it is refused too — the old regex gate let it through.
  const doc = simplifiedDocument({ title: 'T', url: LINKS_URL, bodyHtml: b });
  assert.doesNotMatch(doc, /javascript:/i, 'nor does the sidecar reader document');

  const { toMarkdown, toSafeHtml } = require('../lib/capture/markdown');
  const md = toMarkdown('<p><a href="javascript:alert(1)">js</a> <a href="c.html">rel</a></p>', { baseUrl: LINKS_URL });
  assert.doesNotMatch(md, /javascript:/i, 'markdown drops it too');
  assert.match(md, /\[rel\]\(https:\/\/x\.example\.com\/a\/b\/c\.html\)/, 'and resolves against the page URL');
  assert.doesNotMatch(toSafeHtml('<a href="java\tscript:alert(1)">x</a>'), /script:/i,
    'the tab-obfuscated spelling is refused with no base at all');
});

test('simplifyDom: enforces the byte cap', () => {
  const s = simplifyDom(reg.safeParse(ARTICLE_HTML), { url: ARTICLE_URL, cap: 300 });
  assert.equal(s.truncated, true, 'truncated when the body exceeds the cap');
  assert.ok(s.bytes <= 300 + 4000, 'body stops near the cap (allowing one final block)');
});

test('simplifiedDocument: a standalone, script-free reader page', () => {
  const s = simplifyDom(reg.safeParse(ARTICLE_HTML), { url: ARTICLE_URL });
  const doc = simplifiedDocument({ title: 'How Serpentine Rivers Form', url: ARTICLE_URL, byline: 'Jane Doe', bodyHtml: s.bodyHtml, truncated: s.truncated, bytes: s.bytes });
  assert.match(doc, /^<!doctype html>/i);
  assert.match(doc, /<title>How Serpentine Rivers Form<\/title>/);
  assert.match(doc, /open original/, 'links back to the source');
  assert.match(doc, /<h2>The mechanism<\/h2>/, 'body structure inlined');
  assert.equal(/<script/i.test(doc), false, 'no scripts in the reader document');
});

// ---------------------------------------------------------------------------
// End-to-end through the capture route
// ---------------------------------------------------------------------------

function paneMounts(hello, suffix) {
  const base = 'tab-capture:' + suffix;
  return hello.mounts.filter((x) => x.id === base || x.id.startsWith(base + ':'));
}

test('capture: an article page distills small AND renders the reader-lite pane + sidecar', async (t) => {
  const { api, root, wsHello } = await withServer(t);

  const r = await api.post('/api/capture', { url: ARTICLE_URL, title: 'Rivers', html: ARTICLE_HTML });
  assert.equal(r.status, 200);
  assert.equal(r.json.profile, 'article');
  assert.equal(r.json.distilled.kind, 'article');
  assert.ok(r.json.distilled.blocks.length > 0);

  // The DISTILLATE stays small: structured only — no reader HTML, no raw scripts.
  const dj = JSON.stringify(r.json.distilled);
  assert.equal(dj.includes('wc-reader'), false, 'no reader markup in the distillate');
  assert.equal(dj.includes('<script'), false, 'no scripts in the distillate');
  assert.ok(dj.length < ARTICLE_HTML.length, 'distillate is smaller than the raw page');

  // The rich reader HTML is written to a sidecar (parity with the raw-DOM tier).
  const sidecar = path.join(root, '.web-chat', 'captures', 'cap1.simplified.html');
  assert.ok(fs.existsSync(sidecar), 'simplified sidecar written');
  const doc = fs.readFileSync(sidecar, 'utf8');
  assert.match(doc, /<h2>The mechanism<\/h2>/, 'sidecar keeps structure');
  assert.equal(/<script/i.test(doc), false, 'sidecar is script-free');

  // The pane is the reader-lite view with both modes.
  const hello = await wsHello();
  const ms = paneMounts(hello, 'article');
  assert.equal(ms.length, 1, 'one per-page article pane');
  const m = ms[0];
  assert.match(m.id, /^tab-capture:article:[0-9a-f]{8}$/);
  assert.equal(m.owner, 'service:tab-stream');
  assert.equal(m.params.modes, true, 'reduced/expanded toggle offered');
  assert.match(m.html, /wc-pane-modes/);
  assert.match(m.html, /data-wc-when="reduced"/);
  assert.match(m.html, /data-wc-when="expanded"/);
  assert.match(m.html, /wc-reader-title/, 'reader header rendered');
  assert.match(m.html, /<h2>The mechanism<\/h2>/, 'reader body rendered in the pane');
});

test('capture: get_captures returns the small distillate; the reader HTML is fetched separately', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: ARTICLE_URL, title: 'Rivers', html: ARTICLE_HTML });

  // The capture list (what get_captures returns) carries the structured distillate
  // and only a REFERENCE to the reader render — never the reader HTML itself.
  const list = (await api.get('/api/captures')).json;
  const rec = list.captures[0];
  assert.equal(rec.distilled.kind, 'article');
  assert.ok(rec.simplified_ref, 'record references the sidecar');
  assert.equal(JSON.stringify(rec).includes('wc-reader'), false, 'no reader HTML in the record');

  // The reader page is served on demand from the sidecar.
  const view = await api.get('/api/captures/cap1/simplified');
  assert.equal(view.status, 200);
  assert.match(view.headers.get('content-type') || '', /text\/html/);
  assert.match(view.text, /<h2>The mechanism<\/h2>/);
  assert.equal(/<script/i.test(view.text), false);

  // A capture with no simplified render (e.g. a bare page → tables) 404s here.
  await api.post('/api/capture', { url: 'https://x/t', html: '<table><tr><td>a</td></tr></table>' });
  const none = await api.get('/api/captures/cap2/simplified');
  assert.equal(none.status, 404);
});

test('capture: a plain (non-article) page still distills as default text and gets the reader pane', async (t) => {
  const { api, root, wsHello } = await withServer(t);

  const r = await api.post('/api/capture', { url: 'https://x/plain', title: 'Doc', html: PLAIN_HTML });
  assert.equal(r.json.profile, 'default', 'article does not over-match a lone-paragraph page');
  assert.equal(r.json.distilled.kind, 'page-text');
  assert.match(r.json.distilled.text, /SECRET-MARKER hello world/);

  // The default pane is now the reader-lite simplified view — with the raw page
  // script stripped out of it.
  const hello = await wsHello();
  const m = paneMounts(hello, 'default')[0];
  assert.ok(m, 'a default reader pane mounted');
  assert.equal(m.params.modes, true);
  assert.match(m.html, /wc-reader/);
  assert.match(m.html, /SECRET-MARKER hello world/, 'page content rendered');
  assert.equal(m.html.includes('var x=1'), false, 'raw page script stripped from the reader pane');

  // Sidecar written for the default capture too.
  assert.ok(fs.existsSync(path.join(root, '.web-chat', 'captures', 'cap1.simplified.html')));
});
