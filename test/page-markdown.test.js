// The one markdown renderer (lib/core/markdown) — the prose write_markdown puts
// on the page. Pinned here: the subset it renders, that EVERYTHING is escaped,
// that links are scheme-gated, that headings() agrees with the rendered slugs,
// and that the browser module served at /app/markdown.js is the same
// implementation (built from the factory's own source) rather than a copy.

const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, headings, browserModuleSource, createMarkdown } = require('../lib/core/markdown');
const { withServer } = require('../test-support/helpers');

const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));

test('markdown: raw HTML is text, never markup', () => {
  const out = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="y">');
  assert.ok(!/<script|<img/i.test(out), out);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=&quot;y&quot;&gt;/);
});

test('markdown: every inline span escapes its content', () => {
  const out = renderMarkdown('**<b>** *<i>* `<code>` [<x>](https://a.test/?q=1&r="2")');
  assert.match(out, /<strong>&lt;b&gt;<\/strong>/);
  assert.match(out, /<em>&lt;i&gt;<\/em>/);
  assert.match(out, /<code>&lt;code&gt;<\/code>/);
  // The href is escaped into its attribute (quote and ampersand), the label too.
  assert.match(out, /<a href="https:\/\/a\.test\/\?q=1&amp;r=&quot;2&quot;" target="_blank" rel="noopener noreferrer">&lt;x&gt;<\/a>/);
});

test('markdown: links are gated to http/https/mailto/relative/fragment', () => {
  const ok = ['https://a.test/x', 'http://a.test', 'mailto:me@a.test', '/rel/path', 'rel.html', '#frag', 'HTTPS://A.TEST'];
  for (const href of ok) {
    assert.match(renderMarkdown(`[go](${href})`), /<a href=/, `${href} should link`);
  }
  const bad = ['javascript:alert`1`', 'JavaScript:x', 'vbscript:x', 'data:text/html;base64,PHA+', 'file:///etc/passwd', 'java\u0001script:x'];
  for (const href of bad) {
    const out = renderMarkdown(`[go](${href})`);
    assert.ok(!/<a\b/.test(out), `${JSON.stringify(href)} must not link: ${out}`);
    assert.match(out, /go/, 'a gated link keeps its label');
  }
});

test('markdown: the block subset — headings, paragraphs, lists, fenced code', () => {
  const out = renderMarkdown([
    '# One', '## Two', '### Three', '#### not a heading', '',
    'a paragraph', 'on two lines', '',
    '- a', '- b', '  continued', '',
    '3. c', '4. d', '',
    '```js', 'const x = "<y>";', '# not a heading either', '```',
  ].join('\n'));
  assert.match(out, /<h1 data-slug="one">One<\/h1>/);
  assert.match(out, /<h2 data-slug="two">Two<\/h2>/);
  assert.match(out, /<h3 data-slug="three">Three<\/h3>/);
  assert.match(out, /<p>#### not a heading<\/p>/);
  assert.match(out, /<p>a paragraph\non two lines<\/p>/);
  assert.match(out, /<ul><li>a<\/li><li>b\ncontinued<\/li><\/ul>/);
  assert.match(out, /<ol start="3"><li>c<\/li><li>d<\/li><\/ol>/);
  assert.match(out, /<pre><code class="lang-js">const x = &quot;&lt;y&gt;&quot;;\n# not a heading either<\/code><\/pre>/);
});

test('markdown: headings() returns level, plain text and the rendered slug', () => {
  const text = '# Intro **bold** [link](https://a.test)\n\n## Intro\n```\n# skipped\n```\n### Intro\n#### no';
  const hs = headings(text);
  assert.deepEqual(hs, [
    { level: 1, text: 'Intro bold link', slug: 'intro-bold-link' },
    { level: 2, text: 'Intro', slug: 'intro' },
    { level: 3, text: 'Intro', slug: 'intro-1' },
  ]);
  const html = renderMarkdown(text);
  for (const h of hs) assert.ok(html.includes(`data-slug="${h.slug}"`), `rendered output carries ${h.slug}`);
});

test('markdown: a heading can never claim an element id', () => {
  const out = renderMarkdown('# main\n## topbar');
  assert.ok(!/\sid=/.test(out), 'headings carry data-slug, not id');
});

test('markdown: the factory is self-contained — the browser module renders identically', async () => {
  const mod = await importSource(browserModuleSource());
  const corpus = [
    '# A *b* `c`\n\npara [l](https://x.test) [bad](javascript:x)\n\n- 1\n- 2\n\n1. x\n\n```sh\n<&>\n```',
    '<b>raw</b> **s** *e*',
    '## Dup\n## Dup',
  ];
  for (const t of corpus) {
    assert.equal(mod.renderMarkdown(t), renderMarkdown(t));
    assert.deepEqual(mod.headings(t), headings(t));
  }
  assert.equal(typeof mod.default.renderMarkdown, 'function');
  // A factory that closed over a module-level helper would render in Node and
  // throw in the browser. Rebuilding it from its source text in a bare scope is
  // exactly what the served module does.
  const rebuilt = new Function('escapeHtml', `return (${createMarkdown.toString()})(escapeHtml);`); // eslint-disable-line no-new-func
  assert.equal(rebuilt((s) => String(s)).renderMarkdown('# x'), '<h1 data-slug="x">x</h1>');
});

test('GET /app/markdown.js serves the renderer as an ES module', async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/app/markdown.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const src = await res.text();
  assert.equal(src, browserModuleSource());
  const mod = await importSource(src);
  assert.equal(mod.renderMarkdown('**x**'), '<p><strong>x</strong></p>');
});
