// The chat flavour of the one markdown engine (lib/core/markdown, spec §7.11,
// U35). Pinned here: the PAGE flavour is byte-identical to what it rendered
// before the chat flavour existed (test/fixtures/markdown-page-golden.json,
// recorded at wc085/int 29228ee), server-side and through the module the
// browser imports; every chat construct; the image and link gates; renderDiff;
// the caps; and that everything a reply carries reaches the DOM escaped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const md = require('../lib/core/markdown');
const { withServer } = require('../test-support/helpers');

const { renderMarkdown, renderDiff, gateImg, gateHref, browserModuleSource } = md;
const chat = (t) => renderMarkdown(t, { flavor: 'chat' });
const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'markdown-page-golden.json'), 'utf8'));

// The chat corpus the browser module must render identically to the server.
const CHAT_CORPUS = [
  '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### seven',
  '| L | C | R |\n| :-- | :-: | --: |\n| 1 | **2** | `3` |\n| <img src=x onerror=y> | a \\| b | [l](https://a.test) |',
  '- [ ] open\n- [x] done\n  - nested\n    - deeper\n      - deepest\n        - flattened',
  '> a\n> > b\n> > > c\n> > > > d',
  '---\n~~gone~~ see https://a.test/x?y=1&z=2.',
  '![a](/api/mirror/items/it-1/attachments/0) ![b](https://img.test/b.png) ![c](rel.png)',
  '```diff\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n```',
  '```mermaid\ngraph TD; A-->B["<b>"]\n```',
  '1. one\n2. two\n   - mixed',
];

/* ======================= the page flavour, frozen ======================= */

test('golden: the corpus is large and covers what it claims', () => {
  assert.ok(GOLDEN.cases.length >= 200, `${GOLDEN.cases.length} cases`);
  const inputs = GOLDEN.cases.map((c) => c.input).filter((s) => typeof s === 'string');
  for (const probe of ['#### ', '###### ', '| :-: |', '- [x]', '> > ', '~~', '```diff', '```mermaid', '<script>',
    'javascript:', 'data:text/html', '‮', ' ', '\u0000', '```\nunterminated', '`unterminated', '![']) {
    assert.ok(inputs.some((s) => s.includes(probe)), `the corpus has an input containing ${JSON.stringify(probe)}`);
  }
});

test('golden: the page flavour reproduces every recorded output byte for byte (server)', () => {
  for (const { input, output } of GOLDEN.cases) {
    assert.equal(renderMarkdown(input), output, `no option: ${JSON.stringify(input)}`);
    assert.equal(renderMarkdown(input, { flavor: 'page' }), output, `{flavor:'page'}: ${JSON.stringify(input)}`);
    assert.equal(renderMarkdown(input, {}), output, `{}: ${JSON.stringify(input)}`);
  }
});

test('golden: the page flavour reproduces every recorded output through the browser module', async () => {
  const mod = await importSource(browserModuleSource());
  for (const { input, output } of GOLDEN.cases) {
    assert.equal(mod.renderMarkdown(input), output, JSON.stringify(input));
    assert.equal(mod.renderMarkdown(input, { flavor: 'page' }), output, JSON.stringify(input));
  }
});

test('page: headings() stays the page\'s — levels 1-3 only, chat levels never become sections', () => {
  assert.deepEqual(md.headings('# a\n#### b\n###### c\n### d'), [
    { level: 1, text: 'a', slug: 'a' },
    { level: 3, text: 'd', slug: 'd' },
  ]);
});

/* ============================ chat: blocks ============================ */

test('chat: the output is one .md-chat block; empty input renders nothing', () => {
  assert.match(chat('x'), /^<div class="md-chat"><p>x<\/p><\/div>$/);
  assert.equal(chat(''), '');
  assert.equal(chat(null), '');
});

test('chat: # to ###### render as h1-h6 with neither data-slug nor id; seven hashes is a paragraph', () => {
  const out = chat('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### Seven');
  for (let n = 1; n <= 6; n++) assert.match(out, new RegExp(`<h${n}>[A-Z][a-z]+</h${n}>`));
  assert.ok(!/data-slug|\sid=/.test(out), out);
  assert.match(out, /<p>####### Seven<\/p>/);
});

test('chat: a GFM table renders with :--, :-: and --: alignment', () => {
  const out = chat('| L | C | R | N |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |');
  assert.match(out, /<div class="md-table"><table><thead><tr>/);
  assert.match(out, /<th style="text-align:left">L<\/th><th style="text-align:center">C<\/th><th style="text-align:right">R<\/th><th>N<\/th>/);
  assert.match(out, /<tbody><tr><td style="text-align:left">1<\/td><td style="text-align:center">2<\/td><td style="text-align:right">3<\/td><td>4<\/td><\/tr><\/tbody>/);
  // Outer pipes are optional, a short row is padded, \| is a literal pipe.
  const loose = chat('a | b\n--|--\nx \\| y\n');
  assert.match(loose, /<td>x \| y<\/td><td><\/td>/);
});

test('chat: a 201-row or 31-column table falls back to <pre>', () => {
  const rows = (n, cols) => Array.from({ length: n }, (_, i) => '|' + Array.from({ length: cols }, () => ` ${i} `).join('|') + '|');
  const table = (n, cols) => ['|' + ' h |'.repeat(cols), '|' + ' - |'.repeat(cols), ...rows(n, cols)].join('\n');
  assert.match(chat(table(200, 30)), /<table>/, '200 rows x 30 columns is a table');
  for (const [n, cols] of [[201, 2], [2, 31]]) {
    const out = chat(table(n, cols));
    assert.ok(!/<table/.test(out), `${n}x${cols} is not a table`);
    assert.match(out, /^<div class="md-chat"><pre>\| h \|/);
  }
});

test('chat: - [ ] and - [x] render the glyphs, never a form control', () => {
  const out = chat('- [ ] open\n- [x] done\n- [X] upper\n- plain');
  assert.match(out, /<li class="md-task"><span class="md-tick">☐<\/span> open<\/li>/);
  assert.match(out, /<li class="md-task"><span class="md-tick md-done">☑<\/span> done<\/li>/);
  assert.match(out, /<span class="md-tick md-done">☑<\/span> upper/);
  assert.match(out, /<li>plain<\/li>/);
  assert.ok(!/<input|<button|<form/i.test(out), out);
});

test('chat: lists nest to depth 4 and deeper items flatten into the fourth level', () => {
  const out = chat('- a\n  - b\n    - c\n      - d\n        - e\n          - f\n- g');
  assert.equal(out, '<div class="md-chat"><ul><li>a<ul><li>b<ul><li>c<ul><li>d</li><li>e</li><li>f</li></ul></li></ul></li></ul></li><li>g</li></ul></div>');
  assert.equal((out.match(/<ul>/g) || []).length, 4);
  // An ordered list nests inside a bullet and keeps its start.
  assert.match(chat('- a\n  3. b\n  4. c'), /<ul><li>a<ol start="3"><li>b<\/li><li>c<\/li><\/ol><\/li><\/ul>/);
  // A marker change at one level starts a sibling list.
  assert.match(chat('- a\n1. b'), /<ul><li>a<\/li><\/ul><ol><li>b<\/li><\/ol>/);
});

test('chat: quotes nest to depth 3 and deeper markers flatten into the third', () => {
  const out = chat('> a\n> > b\n> > > c\n> > > > d');
  assert.equal((out.match(/<blockquote>/g) || []).length, 3);
  assert.match(out, /<blockquote><p>c\nd<\/p><\/blockquote>/);
  // A quote holds other blocks.
  assert.match(chat('> # h\n> - x'), /<blockquote><h1>h<\/h1>\n<ul><li>x<\/li><\/ul><\/blockquote>/);
});

test('chat: ---, *** and ___ are rules; ~~strike~~ is <del>', () => {
  const out = chat('para\n---\n***\n_ _ _\n~~gone~~ and ~single~');
  assert.equal((out.match(/<hr>/g) || []).length, 3);
  assert.match(out, /<del>gone<\/del> and ~single~/);
  assert.match(chat('~~**b** <i>~~'), /<del><strong>b<\/strong> &lt;i&gt;<\/del>/);
});

/* ========================= chat: links and images ========================= */

test('chat: a bare https:// URL autolinks with rel=noopener noreferrer, trailing punctuation left out', () => {
  const out = chat('see https://a.test/x?q=1&r=2. and (http://b.test/y)');
  assert.match(out, /<a href="https:\/\/a\.test\/x\?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">https:\/\/a\.test\/x\?q=1&amp;r=2<\/a>\. and \(<a href="http:\/\/b\.test\/y" [^>]*>http:\/\/b\.test\/y<\/a>\)/);
  // Not inside a word, not inside a link's label, not without a host.
  assert.ok(!/<a/.test(chat('xhttps://a.test')));
  assert.equal((chat('[https://a.test](https://b.test)').match(/<a /g) || []).length, 1);
  assert.ok(!/<a/.test(chat('https:// nothing')));
  // The page flavour never autolinks.
  assert.ok(!/<a/.test(renderMarkdown('see https://a.test/x')));
});

test('chat: javascript:, data: and java\\tscript: never link, in any form', () => {
  for (const href of ['javascript:alert(1)', 'JavaScript:x', 'data:text/html;base64,PHA+', 'java\tscript:x', 'java\u0001script:x', 'vbscript:x']) {
    const out = chat(`[go](${href}) and ${href}`);
    assert.ok(!/<a\b/.test(out), `${JSON.stringify(href)} must not link: ${out}`);
    assert.match(out, /go/);
  }
});

test('gateImg: only the attachment route and a small base64 data:image load', () => {
  assert.deepEqual(gateImg('/api/mirror/items/it-1/attachments/0'), { kind: 'img', src: '/api/mirror/items/it-1/attachments/0' });
  const png = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(4) + '=';
  assert.equal(gateImg(png).kind, 'img');
  for (const type of ['jpeg', 'gif', 'webp', 'svg+xml']) assert.equal(gateImg(`data:image/${type};base64,AAAA`).kind, 'img', type);
  const big = 'data:image/png;base64,' + 'A'.repeat(1048576 + 1 - 'data:image/png;base64,'.length);
  assert.equal(big.length, 1048577);
  assert.equal(gateImg(big).kind, 'alt', '1 MiB + 1');
  assert.equal(gateImg(big.slice(0, -1)).kind, 'img', 'exactly 1 MiB');
  for (const bad of ['data:text/html;base64,PHA+', 'data:image/png,raw', 'data:image/bmp;base64,AA', 'rel.png', '/api/other',
    '/api/mirror/items/../attachments/0', '/api/mirror/items/x/attachments/0?y', 'javascript:x', '//evil.test/a.png', '']) {
    assert.equal(gateImg(bad).kind, 'alt', bad);
  }
  assert.deepEqual(gateImg('https://img.test/a.png'), { kind: 'remote', src: 'https://img.test/a.png' });
  assert.equal(gateImg('HTTP://img.test/a.png').kind, 'remote');
  // The control-character strip is the same as gateHref's.
  assert.equal(gateImg('java\tscript:x').kind, 'alt');
  assert.equal(gateHref('java\tscript:x'), '');
});

test('chat: images render through gateImg', () => {
  const ok = chat('![shot](/api/mirror/items/it-1/attachments/2) ![dot](data:image/png;base64,iVBORw0KGgo=)');
  assert.match(ok, /<img src="\/api\/mirror\/items\/it-1\/attachments\/2" alt="shot" loading="lazy">/);
  assert.match(ok, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot" loading="lazy">/);
  for (const src of ['data:text/html;base64,PHA+', 'rel/path.png', 'javascript:alert', 'data:image/png;base64,***']) {
    const out = chat(`![the alt](${src})`);
    assert.ok(!/<img/.test(out), src);
    assert.match(out, /<span class="md-img-alt">the alt<\/span>/);
  }
  // A 1 MiB + 1 data URL never loads. In a reply it cannot even be whole: the
  // 200,000-character input cap cuts it first, so it is left as escaped text.
  const big = chat('![the alt](data:image/png;base64,' + 'A'.repeat(1048577 - 22) + ')');
  assert.ok(!/<img/.test(big) && /md-note/.test(big), 'a 1 MiB + 1 image renders no <img>');
  const remote = chat('![a "quoted" <alt>](https://img.test/a.png?x=1&y=2)');
  assert.ok(!/<img/.test(remote), remote);
  assert.match(remote, /<span class="md-img-remote" data-src="https:\/\/img\.test\/a\.png\?x=1&amp;y=2" role="button" tabindex="0">a &quot;quoted&quot; &lt;alt&gt;<\/span>/);
  // The page flavour has no images: the old link-and-bang reading stands.
  assert.ok(!/<img|md-img/.test(renderMarkdown('![a](https://img.test/a.png)')));
});

/* ============================ renderDiff ============================ */

test('chat: diff and patch fences render through renderDiff', () => {
  const body = '@@ -1 +1 @@\n-a\n+b';
  for (const lang of ['diff', 'patch', 'DIFF']) {
    assert.equal(chat('```' + lang + '\n' + body + '\n```'), '<div class="md-chat"><pre class="md-diff">' + renderDiff(body) + '</pre></div>');
  }
  // The page flavour keeps them plain code.
  assert.match(renderMarkdown('```diff\n' + body + '\n```'), /<pre><code class="lang-diff">/);
});

test('renderDiff: add, del, ctx, hunk and meta lines with their old/new numbers', () => {
  const out = renderDiff([
    'diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f',
    '@@ -10,3 +10,4 @@ fn()', ' same', '-gone', '+came', '+also', ' tail', '\\ No newline at end of file', '',
  ].join('\n'));
  const lines = [...out.matchAll(/<span class="dl ([a-z-]+)" data-old="(\d*)" data-new="(\d*)">([^<]*)<\/span>/g)]
    .map((m) => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(lines, [
    ['dl-meta', '', '', 'diff --git a/f b/f'],
    ['dl-meta', '', '', 'index 1..2 100644'],
    ['dl-meta', '', '', '--- a/f'],
    ['dl-meta', '', '', '+++ b/f'],
    ['dl-hunk', '', '', '@@ -10,3 +10,4 @@ fn()'],
    ['dl-ctx', '10', '10', ' same'],
    ['dl-del', '11', '', '-gone'],
    ['dl-add', '', '11', '+came'],
    ['dl-add', '', '12', '+also'],
    ['dl-ctx', '12', '13', ' tail'],
    ['dl-meta', '', '', '\\ No newline at end of file'],
  ]);
  // One span per line, nothing between them.
  assert.equal(out, out.match(/<span[^>]*>[^<]*<\/span>/g).join(''));
  // A fragment with no hunk header is classed by its first character, unnumbered.
  assert.equal(renderDiff('+a\n-b\n c'), '<span class="dl dl-add" data-old="" data-new="">+a</span>'
    + '<span class="dl dl-del" data-old="" data-new="">-b</span><span class="dl dl-ctx" data-old="" data-new=""> c</span>');
  // {lineNumbers: false} leaves the numbers off.
  assert.equal(renderDiff('@@ -1 +1 @@\n-a\n+b', { lineNumbers: false }),
    '<span class="dl dl-hunk">@@ -1 +1 @@</span><span class="dl dl-del">-a</span><span class="dl dl-add">+b</span>');
  // Every line's text is escaped.
  assert.match(renderDiff('+<script>"x"</script>'), /&lt;script&gt;&quot;x&quot;&lt;\/script&gt;/);
});

test('renderDiff: truncates after 5,000 lines with a note; a non-string renders nothing', () => {
  const text = Array.from({ length: 5003 }, (_, i) => '+' + i).join('\n');
  const out = renderDiff(text);
  assert.equal((out.match(/class="dl dl-add"/g) || []).length, 5000);
  assert.match(out, /<span class="dl dl-meta dl-more">… 3 more lines not shown<\/span>$/);
  assert.ok(!/\+5000</.test(out));
  assert.ok(!/dl-more/.test(renderDiff(Array.from({ length: 5000 }, () => '+x').join('\n'))), 'exactly 5,000 is whole');
  for (const v of [undefined, null, 42, {}, [{ header: '@@ -1 +1 @@', lines: ['+a'] }], ['+a']]) {
    assert.equal(renderDiff(v), '', JSON.stringify(v));
  }
  assert.equal(renderDiff(''), '');
});

/* ======================= mermaid, caps, escaping ======================= */

test('chat: a mermaid fence renders as labelled, escaped source', () => {
  const out = chat('```mermaid\ngraph TD; A-->B["<img src=x onerror=y>"]\n```');
  assert.equal(out, '<div class="md-chat"><pre class="md-mermaid"><span class="md-fence-label">Mermaid diagram · source</span>'
    + '<code class="lang-mermaid">graph TD; A--&gt;B[&quot;&lt;img src=x onerror=y&gt;&quot;]</code></pre></div>');
  assert.match(renderMarkdown('```mermaid\nx\n```'), /^<pre><code class="lang-mermaid">x<\/code><\/pre>$/, 'the page keeps plain code');
});

test('chat: a 200,001-character input renders the first 200,000 and a note', () => {
  const text = 'a'.repeat(199999) + 'bc';
  assert.equal(text.length, 200001);
  const out = chat(text);
  assert.match(out, /^<div class="md-chat"><p>a{199999}b<\/p>\n<p class="md-note">The rest of this message \(1 more characters\) is not shown here\.<\/p><\/div>$/);
  assert.ok(!/c</.test(out));
  assert.ok(!/md-note/.test(chat('a'.repeat(200000))), 'exactly 200,000 is whole');
  // A surrogate pair across the cut is never split.
  const emoji = chat('a'.repeat(199999) + '😀z');
  assert.ok(!/\ud83d</.test(emoji) && /a<\/p>/.test(emoji), 'the cut steps back before a high surrogate');
});

test('chat: raw HTML, an <img onerror> in a table cell and a link title with quotes stay escaped everywhere', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const docs = [
    evil, `# ${evil}`, `###### ${evil}`, `| h |\n| - |\n| ${evil} |`, `| ${evil} |\n| :-: |`, `- [x] ${evil}`, `- a\n  - ${evil}`,
    `> ${evil}`, `> > > > ${evil}`, `~~${evil}~~`, `**${evil}**`, `[${evil}](https://a.test)`, `![${evil}](https://a.test/i.png)`,
    `![${evil}](/api/mirror/items/a/attachments/1)`, `![${evil}](rel)`, '```diff\n+' + evil + '\n```', '```mermaid\n' + evil + '\n```',
    '```' + evil + '\nx\n```', '[a](https://a.test "title with \\"quotes\\" and \'single\'")', `https://a.test/"><script>x</script>`,
    `https://a.test/'onmouseover='x`,
  ];
  for (const d of docs) {
    const out = chat(d);
    assert.ok(!/<img src=x|<script|onerror="|onmouseover='/i.test(out), `${JSON.stringify(d)} → ${out}`);
    assertSafe(out, d);
  }
  const titled = chat('[a](https://a.test "t")');
  assert.ok(!/title=/.test(titled) && /&quot;t&quot;/.test(titled), titled);
});

// Every tag and attribute the chat flavour can emit, and what an href/src may hold.
const TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'span', 'table', 'thead', 'tbody', 'tr', 'th',
  'td', 'blockquote', 'hr', 'pre', 'code', 'a', 'img', 'strong', 'em', 'del']);
const ATTRS = new Set(['class', 'style', 'href', 'target', 'rel', 'src', 'alt', 'loading', 'data-src', 'data-old', 'data-new', 'role',
  'tabindex', 'start']);
function assertSafe(out, input) {
  for (const tag of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(TAGS.has(tag[1]), `tag <${tag[1]}> from ${JSON.stringify(input)}`);
    const rest = tag[2].replace(/\s([a-z-]+)="([^"<>]*)"/g, (_, name, value) => {
      assert.ok(ATTRS.has(name), `attribute ${name} from ${JSON.stringify(input)}`);
      if (name === 'href') assert.ok(/^(?:https?:\/\/|mailto:|[^:]*$)/i.test(value), `href ${value}`);
      if (name === 'src') assert.equal(gateImg(value.replace(/&amp;/g, '&')).kind, 'img', `src ${value}`);
      if (name === 'style') assert.match(value, /^text-align:(?:left|center|right)$/);
      return '';
    });
    assert.equal(rest.trim(), '', `stray markup in <${tag[1]}${tag[2]}> from ${JSON.stringify(input)}`);
  }
}

test('chat: a fuzzed corpus only ever emits the allowed tags and attributes', () => {
  const A = ['#', '###### ', ' ', '\t', '\n', '\n\n', '- ', '* ', '1. ', '[ ] ', '[x] ', '`', '```', '```diff\n', '```mermaid\n', '[', ']',
    '(', ')', '!', '~~', '|', '| :-: |', '> ', '---', '\\', 'https://a.test/', 'javascript:', 'data:image/png;base64,AA', '<', '>',
    '&', '"', '\'', 'x', '/api/mirror/items/a/attachments/0', '‮', ' ', '@@ -1 +1 @@\n'];
  let seed = 7;
  const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 4000; k++) {
    let s = '';
    for (let j = 0, n = 1 + Math.floor(r() * 40); j < n; j++) s += A[Math.floor(r() * A.length)];
    assertSafe(chat(s), s);
  }
});

test('chat: long pathological runs stay linear', () => {
  for (const t of ['['.repeat(200000), '!['.repeat(100000), '['.repeat(100000) + '](' + 'a'.repeat(99990), '~~'.repeat(100000),
    '> '.repeat(100000), '| '.repeat(100000) + '\n|-|', ('- a\n  ').repeat(40000)]) {
    const t0 = Date.now();
    chat(t);
    renderMarkdown(t);
    assert.ok(Date.now() - t0 < 5000, `${JSON.stringify(t.slice(0, 12))}… took ${Date.now() - t0} ms`);
  }
});

/* ======================= one engine, one module ======================= */

test('the browser module exports renderDiff and gateImg, and renders chat identically to the server', async () => {
  const mod = await importSource(browserModuleSource());
  assert.equal(typeof mod.renderDiff, 'function');
  assert.equal(typeof mod.gateImg, 'function');
  for (const t of CHAT_CORPUS) assert.equal(mod.renderMarkdown(t, { flavor: 'chat' }), chat(t), JSON.stringify(t));
  assert.equal(mod.renderDiff('@@ -1 +1 @@\n-a\n+b'), renderDiff('@@ -1 +1 @@\n-a\n+b'));
  assert.deepEqual(mod.gateImg('https://x.test/a.png'), gateImg('https://x.test/a.png'));
});

test('GET /app/markdown.js serves the module that renders chat like the server', async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/app/markdown.js`);
  assert.equal(res.status, 200);
  const src = await res.text();
  assert.equal(src, browserModuleSource());
  assert.match(src, /^export const renderDiff = md\.renderDiff;$/m);
  const mod = await importSource(src);
  for (const t of CHAT_CORPUS) assert.equal(mod.renderMarkdown(t, { flavor: 'chat' }), chat(t));
});

test('one engine: one heading regex, one escaper, the factory self-contained', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'markdown.js'), 'utf8');
  assert.equal((src.match(/#\{1,\d\}/g) || []).length, 1, 'one #{1,<n>} heading fingerprint');
  assert.match(src, /#\{1,6\}/);
  assert.ok(!/\.replace\(\/&\/g|['"]&['"]\s*:\s*['"]&amp;/.test(src), 'no second escaper');
  // gateHref's control-character class is still an escape, byte for byte.
  assert.ok(src.includes('.replace(/[\\u0000-\\u0020\\u007f]+/g, \'\')'), 'the gate regex is written with \\u escapes');
  // The code (comments aside) carries no raw non-ASCII character.
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
  assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(code.replace(/'\/\/ Generated from[^']*'/, '')), 'non-ASCII in code');
  // Rebuilt from its own source in a bare scope, the factory still renders chat.
  const rebuilt = new Function('escapeHtml', `return (${md.createMarkdown.toString()})(escapeHtml);`)(require('../lib/core/html').escapeHtml); // eslint-disable-line no-new-func
  for (const t of CHAT_CORPUS) assert.equal(rebuilt.renderMarkdown(t, { flavor: 'chat' }), chat(t));
});
