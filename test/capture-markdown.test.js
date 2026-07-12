// "Capture highlighted text as Markdown". Two halves:
//   1. Golden tests for the HTML-fragment → Markdown serializer (lib/capture/
//      markdown.js), one fragment exercising every construct + nesting, plus the
//      sanitize contract for the pane's rendered-Markdown view.
//   2. Route integration for `kind:'selection'`: the Markdown is the distillate
//      (stored + returned verbatim — the ruled context-cost model), the capture
//      enqueues on the wake rail exactly like a tab capture, and the clipping pane
//      renders the sanitized excerpt with a source link.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const { toMarkdown, toSafeHtml } = require('../lib/capture/markdown');

// One fragment touching headings, bold/em/strikethrough, inline code, links,
// nested + ordered lists, a multi-paragraph blockquote, a fenced code block with
// a language hint and an HTML entity, a pipe table (with pipe-escaping), an image,
// a horizontal rule, container recursion (div > section > p), and an unknown leaf.
const FRAG = [
  '<h1>Report</h1>',
  '<p>Lead with <strong>bold</strong>, <em>italic</em>, <del>struck</del>, <code>fn()</code> and a <a href="https://ex.com/a">link</a>.</p>',
  '<ul><li>alpha</li><li>beta<ul><li>beta-1</li><li>beta-2</li></ul></li></ul>',
  '<ol><li>step one</li><li>step two</li></ol>',
  '<blockquote><p>first quoted</p><p>second quoted</p></blockquote>',
  '<pre><code class="language-python">x = 1\nif a &lt; b:\n    pass</code></pre>',
  '<table><thead><tr><th>Item</th><th>Note</th></tr></thead><tbody><tr><td>Rent</td><td>a|b</td></tr><tr><td>Food</td><td>ok</td></tr></tbody></table>',
  '<p><img src="https://ex.com/c.png" alt="chart"></p>',
  '<hr>',
  '<div><section><p>nested via containers</p></section></div>',
  '<widget>unknown-leaf</widget>',
].join('');

const GOLDEN = [
  '# Report',
  '',
  'Lead with **bold**, *italic*, ~~struck~~, `fn()` and a [link](https://ex.com/a).',
  '',
  '- alpha',
  '- beta',
  '  - beta-1',
  '  - beta-2',
  '',
  '1. step one',
  '2. step two',
  '',
  '> first quoted',
  '>',
  '> second quoted',
  '',
  '```python',
  'x = 1',
  'if a < b:',
  '    pass',
  '```',
  '',
  '| Item | Note |',
  '| --- | --- |',
  '| Rent | a\\|b |',
  '| Food | ok |',
  '',
  '![chart](https://ex.com/c.png)',
  '',
  '---',
  '',
  'nested via containers',
  '',
  'unknown-leaf',
].join('\n');

test('markdown: converts every construct + nesting (golden)', () => {
  assert.equal(toMarkdown(FRAG), GOLDEN);
});

test('markdown: plain-text selection (empty fragment fallback) round-trips as a paragraph', () => {
  assert.equal(toMarkdown('just some highlighted words'), 'just some highlighted words');
});

test('markdown: relative link/image URLs resolve against the page URL', () => {
  const md = toMarkdown('<p>see <a href="/docs/x">x</a> <img src="img/y.png" alt="y"></p>', { baseUrl: 'https://ex.com/dir/page' });
  assert.match(md, /\[x\]\(https:\/\/ex\.com\/docs\/x\)/);
  assert.match(md, /!\[y\]\(https:\/\/ex\.com\/dir\/img\/y\.png\)/);
});

test('markdown: toSafeHtml renders semantic HTML but strips scripts, handlers, and javascript: URLs', () => {
  const html = toSafeHtml(
    '<h2>Hi</h2><p onclick="evil()">click <a href="javascript:alert(1)">bad</a> <strong>ok</strong></p><script>steal()</script>',
  );
  assert.match(html, /<h2>Hi<\/h2>/);
  assert.match(html, /<strong>ok<\/strong>/);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /steal\(\)/);
});

// ── route integration ────────────────────────────────────────────────────────

function selectionMount(hello, id) {
  return hello.mounts.find((m) => m.id === 'tab-capture:selection:' + id);
}

const SEL_HTML = '<h2>Budget</h2><p>Keep <strong>rent</strong> under <em>$1200</em>.</p><ul><li>rent</li><li>food</li></ul>';

test('selection capture: markdown is the distillate — stored + returned verbatim, enqueued, raw sidecar written', async (t) => {
  const { api, root } = await withServer(t);

  const r = await api.post('/api/capture', { url: 'https://ex.com/budget', title: 'Budget', html: SEL_HTML, kind: 'selection' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.capture_id, 'cap1');
  assert.equal(r.json.profile, 'selection');
  assert.equal(r.json.distilled.kind, 'selection');
  const expected = toMarkdown(SEL_HTML, { baseUrl: 'https://ex.com/budget' });
  assert.equal(r.json.distilled.markdown, expected);
  assert.match(r.json.distilled.markdown, /## Budget/);
  assert.match(r.json.distilled.markdown, /\*\*rent\*\*/);
  assert.match(r.json.distilled.markdown, /- rent\n- food/);

  // get_captures returns the markdown distillate verbatim (the curated context cost)
  const caps = (await api.get('/api/captures')).json;
  assert.equal(caps.captures.length, 1);
  assert.equal(caps.captures[0].kind, 'selection');
  assert.equal(caps.captures[0].distilled.markdown, expected);

  // signal key set with the selection "profile" (the wake path, same as tab captures)
  const store = (await api.get('/api/store')).json;
  assert.equal(store.tab_capture.capture_id, 'cap1');
  assert.equal(store.tab_capture.profile, 'selection');

  // enqueued on the wake rail exactly like a tab capture (ext-sourced capture event)
  const q = (await api.get('/api/queue')).json;
  assert.equal(q.count, 1);
  assert.equal(q.items[0].kind, 'capture');
  assert.equal(q.items[0].capture_id, 'cap1');

  // raw fragment persisted as the sidecar (the raw is never inlined into the record)
  const sidecar = path.join(root, '.web-chat', 'captures', 'cap1.html');
  assert.ok(fs.existsSync(sidecar));
  assert.equal(fs.readFileSync(sidecar, 'utf8'), SEL_HTML);
  // the record carries a reference, not the raw HTML
  assert.equal(JSON.stringify(caps.captures[0]).includes('<h2>'), false);
});

test('selection capture: renders a clipping pane (rendered markdown + source link, owner-tagged, no modes)', async (t) => {
  const { api, wsHello } = await withServer(t);

  await api.post('/api/capture', { url: 'https://ex.com/budget', title: 'Budget', html: SEL_HTML, kind: 'selection' });

  const hello = await wsHello();
  const m = selectionMount(hello, 'cap1');
  assert.ok(m, 'a per-capture selection pane mounted');
  assert.equal(m.owner, 'service:tab-stream');
  assert.equal(m.params.modes, false, 'no reduced/expanded toggle for a curated excerpt');
  assert.match(m.params.title, /Selection · Budget/);
  // rendered semantic HTML from the same parse, plus a source link back to the page
  assert.match(m.html, /<strong>rent<\/strong>/);
  assert.match(m.html, /clipped from/);
  assert.match(m.html, /href="https:\/\/ex\.com\/budget"/);
});

test('selection capture: two different clippings coexist as separate panes (per-capture keying)', async (t) => {
  const { api, wsHello } = await withServer(t);

  await api.post('/api/capture', { url: 'https://ex.com/budget', title: 'A', html: '<p>first clip</p>', kind: 'selection' });
  await api.post('/api/capture', { url: 'https://ex.com/budget', title: 'B', html: '<p>second clip</p>', kind: 'selection' });

  const hello = await wsHello();
  assert.ok(selectionMount(hello, 'cap1'), 'clip 1 pane present');
  assert.ok(selectionMount(hello, 'cap2'), 'clip 2 pane present (not clobbered)');
});

test('selection capture: a malicious fragment cannot inject script into the pane', async (t) => {
  const { api, wsHello } = await withServer(t);

  await api.post('/api/capture', {
    url: 'https://ex.com/x', title: 'X', kind: 'selection',
    html: '<p onmouseover="evil()">hi<script>steal()</script></p>',
  });
  const hello = await wsHello();
  const m = selectionMount(hello, 'cap1');
  assert.ok(m);
  assert.doesNotMatch(m.html, /<script/i);
  assert.doesNotMatch(m.html, /onmouseover/i);
  assert.doesNotMatch(m.html, /steal\(\)/);
});

test('selection capture: a large excerpt is stored verbatim — no truncation cap (ruled context-cost model)', async (t) => {
  // The user curates the excerpt, so there is no server-side cap on the Markdown
  // distillate (unlike the default profile's 20k text cap). A big selection is a
  // small body vs. a full-page DOM, so no hub/instance body limit applies either.
  const { api } = await withServer(t);
  const big = '<p>' + 'lorem ipsum dolor sit amet '.repeat(4000) + '</p>'; // ~112k chars
  const r = await api.post('/api/capture', { url: 'https://ex.com/long', title: 'Long', html: big, kind: 'selection' });
  assert.equal(r.status, 200);
  assert.equal(r.json.distilled.text_chars, r.json.distilled.markdown.length);
  assert.ok(r.json.distilled.markdown.length > 100000, 'full excerpt kept, not truncated');
  assert.equal(r.json.distilled.truncated, undefined, 'no truncation flag — verbatim');
});
