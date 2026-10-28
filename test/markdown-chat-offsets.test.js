// The chat flavour's source offsets (lib/core/markdown.js, annotation engine
// 3A.5; D5: the chrome places a chat passage through renderer-stamped offsets;
// S2-confirm U418-U432-U434@offset-mapper: the page's one text-offset engine).
//
//   * Without `offsets` the chat flavour is the same bytes it always was, and
//     the page flavour ignores the option; the page flavour's sourceMap is the
//     same with or without an opts object.
//   * With `offsets` every top-level block of the div.md-chat carries
//     data-src="<start>,<end>" whose source slice is that block's lines, and
//     the cut's note data-src-cut="<the shown text's normalised length>".
//   * sourceMap(text, {flavor: 'chat'}) runs reproduce every text node inside
//     the div.md-chat (generated text unmapped, by length), and
//     lib/core/anchors recordSource / resolveSource read it over the element
//     holding the div.md-chat: a record over every reply of the fixture
//     resolves back to its own range (alignBlock stays internal to them).
//   * diffRows is renderDiff's one row grammar: the old renderDiff (kept here
//     as the oracle) and the rebuilt one agree byte for byte, and each row's
//     old/new equal the data-old/data-new drawn.
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const anchors = require('../lib/core/anchors');
const { escapeHtml } = require('../lib/core/html');
const md = require('../lib/core/markdown');

const { renderMarkdown, renderDiff, diffRows, sourceMap, browserModuleSource } = md;
const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;

const chat = (t) => renderMarkdown(t, { flavor: 'chat' });
const chatOff = (t) => renderMarkdown(t, { flavor: 'chat', offsets: true });
const unstamp = (html) => html.replace(/ data-src="\d+,\d+"/g, '').replace(/ data-src-cut="\d+"/g, '');
const norm = (t) => String(t).replace(/\r\n?/g, '\n');

// The element a chat reply is drawn into: a plain box holding the div.md-chat
// (public/app/chat-turns.js prose()).
function box(html) {
  const b = doc.createElement('div');
  b.innerHTML = html;
  doc.body.append(b);
  return b;
}

async function importSource(src) {
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// Every chat construct, each a block of its own (and a few run together).
const CORPUS = [
  '',
  'plain',
  '# One\n## Two\n###### Six #',
  'Some **bold**, *em*, `code`, ~~gone~~ and [a link](https://x.test/a).\nA second line.',
  'see https://example.com/path). and http://x.y',
  '- one\n- two\n  - nested\n    - deeper\n      - deepest\n        - flattened\n- three',
  '1. first\n2. second\n\n3) third',
  '- a\n1. b\n- c',
  '  - indented first\n- back out',
  '- item\n  continued\n- next',
  '- [x] done\n- [ ] todo\n- [X] Done too',
  '> quote *em*\n> > nested\n> > > three\n> > > > four',
  '> q1\n>\n> q2 para',
  '```js\nconst a = 1;\n```',
  '```\nunterminated\nfence',
  '```mermaid\ngraph TD\n  A-->B\n```',
  '```diff\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx\n```',
  '---\n***\n_ _ _',
  '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 \\| 5 |',
  '| h |\n|---|',
  `| ${Array.from({ length: 31 }, (_, i) => `c${i}`).join(' | ')} |\n|${'---|'.repeat(31)}\n| x |`,
  '![shot](https://e.test/i.png) ![](https://e.test/j.png) ![a](/nope) ![d](data:image/png;base64,AAAA)',
  '<script>alert(1)</script> & "quotes" \'apos\'',
  'a\r\nb\r\n\r\n# h\r\n- c\r\n',
  'para one\n\n\n\npara two\n# head\npara three\n- list\npara four',
  '\\*not em\\* and \\`not code\\`',
];

// A seeded generator over the constructs' pieces, for the fuzzed equalities.
function fuzz(seed, count) {
  const P = ['# h', '## h2', '- li', '  - sub', '1. n', '> q', '> > qq', '```', '```js', '```diff', '@@ -1 +1 @@', '+a', '-b',
    '---', '| a | b |', '|---|---|', '| 1 | 2 |', '- [x] t', 'text **b** *e* `c`', 'https://x.y/z', '', '', 'word', '\\*', '~~s~~'];
  let st = seed;
  const r = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  const out = [];
  for (let k = 0; k < count; k++) {
    const n = 1 + Math.floor(r() * 12);
    const ls = [];
    for (let j = 0; j < n; j++) ls.push(P[Math.floor(r() * P.length)]);
    out.push(ls.join('\n'));
  }
  return out;
}
const FUZZ = fuzz(4181, 400);
const ALL = [...CORPUS, ...FUZZ];

// ── without offsets: byte-identical ─────────────────────────────────────────

test('offsets: without the option the chat flavour is unchanged; with it, only data-src and data-src-cut are added', () => {
  for (const t of ALL) {
    const plain = chat(t);
    assert.equal(renderMarkdown(t, { flavor: 'chat', offsets: false }), plain, JSON.stringify(t));
    assert.equal(unstamp(chatOff(t)), plain, JSON.stringify(t));
  }
  const long = 'x'.repeat(200010);
  assert.equal(unstamp(chatOff(long)), chat(long));
});

test('offsets: the page flavour ignores the option, and its sourceMap is the same with or without opts', () => {
  for (const t of ALL) {
    assert.equal(renderMarkdown(t, { offsets: true }), renderMarkdown(t), JSON.stringify(t));
    assert.equal(renderMarkdown(t, { flavor: 'page', offsets: true }), renderMarkdown(t));
    assert.deepStrictEqual(sourceMap(t, {}), sourceMap(t));
    assert.deepStrictEqual(sourceMap(t, { flavor: 'page' }), sourceMap(t));
  }
});

// ── data-src ────────────────────────────────────────────────────────────────

function blocksOf(html) {
  const b = box(html);
  const root = b.firstElementChild;
  return root ? [...root.children] : [];
}
function spanOf(el) {
  const v = el.getAttribute('data-src');
  if (v == null) return null;
  const [a, z] = v.split(',').map(Number);
  return [a, z];
}

test('offsets: each top-level block carries data-src, and its source slice is that block\'s lines', () => {
  const text = [
    '# Title',
    '',
    'Some **bold** and `code`.',
    'Second line.',
    '- one',
    '- two',
    '  - nested',
    '1. num',
    '> quote *em*',
    '> > deeper',
    '```js',
    'const a = 1;',
    '```',
    '---',
    '| a | b |',
    '|---|:-:|',
    '| 1 | 2 |',
    '',
    '- [x] done task',
    '  continued',
    '```diff',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '```',
    '```mermaid',
    'graph TD',
    '```',
    '#### Four',
    'https://ex.am/ple ~~gone~~ ![img](https://e.test/x.png)',
  ].join('\n');
  const got = blocksOf(chatOff(text)).map((b) => [b.tagName, text.slice(...spanOf(b))]);
  assert.deepStrictEqual(got, [
    ['H1', '# Title'],
    ['P', 'Some **bold** and `code`.\nSecond line.'],
    ['UL', '- one\n- two\n  - nested'],
    ['OL', '1. num'],
    ['BLOCKQUOTE', '> quote *em*\n> > deeper'],
    ['PRE', '```js\nconst a = 1;\n```'],
    ['HR', '---'],
    ['DIV', '| a | b |\n|---|:-:|\n| 1 | 2 |'],
    ['UL', '- [x] done task\n  continued'],
    ['PRE', '```diff\n@@ -1 +1 @@\n-a\n+b\n```'],
    ['PRE', '```mermaid\ngraph TD\n```'],
    ['H4', '#### Four'],
    ['P', 'https://ex.am/ple ~~gone~~ ![img](https://e.test/x.png)'],
  ]);
  // An unterminated fence runs to the text's end; an overflowing table is its <pre>.
  assert.deepStrictEqual(blocksOf(chatOff('para\n```\nopen\nfence')).map((b) => spanOf(b)), [[0, 4], [5, 19]]);
  const wide = CORPUS[20];
  const [pre] = blocksOf(chatOff(wide));
  assert.equal(pre.tagName, 'PRE');
  assert.equal(wide.slice(...spanOf(pre)), wide);
});

test('offsets: on every input, every top-level block is stamped; spans are in order, inside the text, and start at a line', () => {
  for (const t of ALL) {
    const src = norm(t);
    let last = -1;
    for (const b of blocksOf(chatOff(t))) {
      const s = spanOf(b);
      assert.ok(s, `${b.tagName} stamped in ${JSON.stringify(t)}`);
      assert.ok(s[0] > last && s[0] <= s[1] && s[1] <= src.length, `${JSON.stringify(s)} in ${JSON.stringify(t)}`);
      assert.ok(s[0] === 0 || src.charAt(s[0] - 1) === '\n', 'a block starts at a line');
      assert.ok(s[1] === src.length || src.charAt(s[1]) === '\n', 'and ends at one');
      assert.ok(src.slice(s[0], s[1]).trim(), 'never a blank span');
      last = s[1];
    }
  }
});

test('offsets: CRLF text is stamped in its LF-normalised offsets (the source map\'s grammar)', () => {
  const t = 'a\r\nb\r\n\r\n# h\r\n- c\r\n';
  const src = norm(t);
  assert.deepStrictEqual(blocksOf(chatOff(t)).map((b) => src.slice(...spanOf(b))), ['a\nb', '# h', '- c']);
});

test('offsets: the cut\'s note carries data-src-cut, the shown text\'s normalised length; a block before it is stamped', () => {
  const long = `# head\n\n${'x'.repeat(200010)}`;
  const blocks = blocksOf(chatOff(long));
  const note = blocks[blocks.length - 1];
  assert.equal(note.className, 'md-note');
  assert.equal(note.getAttribute('data-src'), null, 'the note is no source block');
  assert.equal(note.getAttribute('data-src-cut'), '200000');
  assert.deepStrictEqual(spanOf(blocks[0]), [0, 6]);
  assert.deepStrictEqual(spanOf(blocks[1]), [8, 200000], 'the cut paragraph ends at the cut');
  // CRLF before the cut: the cut is counted in the normalised text.
  const crlf = `a\r\n${'y'.repeat(200010)}`;
  const n = blocksOf(chatOff(crlf)).pop();
  assert.equal(n.getAttribute('data-src-cut'), String(norm(crlf.slice(0, 200000)).length));
  assert.equal(n.getAttribute('data-src-cut'), '199999');
  // No cut, no note.
  assert.equal(box(chatOff('short')).querySelector('[data-src-cut]'), null);
});

// ── the chat flavour's source map ───────────────────────────────────────────

// The text nodes inside the div.md-chat, in order (what a reader of the map
// lines its runs up against; nothing skipped).
function textNodes(root) {
  const out = [];
  const w = doc.createTreeWalker(root, 4);
  let n;
  while ((n = w.nextNode())) out.push(n.data);
  return out.join('');
}
// Lays the runs end to end by len; answers the offset per rendered character.
function laid(map) {
  const R = [];
  for (const r of map.runs) {
    for (let j = 0; j < r[2]; j++) R.push(r[3] === 'unmapped' ? -1 : r[3] === 'subseq' ? r[4][j] : r[0] + j);
  }
  return R;
}

test('sourceMap(chat): {v: 1, len, runs, headings: []}; the runs reproduce every text node of the div.md-chat', () => {
  assert.deepStrictEqual(sourceMap('', { flavor: 'chat' }), { v: 1, len: 0, runs: [], headings: [] });
  for (const t of ALL) {
    const src = norm(t);
    const map = sourceMap(t, { flavor: 'chat' });
    assert.equal(map.v, 1);
    assert.equal(map.len, src.length);
    assert.deepStrictEqual(map.headings, [], 'a chat heading is no section');
    const shown = textNodes(box(chat(t)));
    const R = laid(map);
    assert.equal(R.length, shown.length, `the runs' lengths cover the text nodes: ${JSON.stringify(t)}`);
    for (let i = 0; i < R.length; i++) {
      if (R[i] >= 0) assert.equal(src.charAt(R[i]), shown.charAt(i), `char ${i} of ${JSON.stringify(t)}`);
    }
    let prev = -1;
    for (const o of R) if (o >= 0) { assert.ok(o > prev, 'mapped offsets ascend'); prev = o; }
  }
});

test('sourceMap(chat): generated text (separators, a task\'s glyph, the mermaid label, the notes) is unmapped, never guessed', () => {
  const t = '- [x] done\n\n```mermaid\ng\n```';
  const map = sourceMap(t, { flavor: 'chat' });
  const shown = textNodes(box(chat(t)));
  const R = laid(map);
  const unmapped = [...shown].filter((_, i) => R[i] < 0).join('');
  assert.equal(unmapped, '☑ \nMermaid diagram · source');
  const long = 'z'.repeat(200005);
  const lm = sourceMap(long, { flavor: 'chat' });
  assert.equal(lm.len, 200005, 'len is the whole text');
  const lR = laid(lm);
  assert.equal(lR.filter((o) => o >= 0).length, 200000, 'the shown part is mapped');
  assert.equal(lR[199999], 199999, 'up to the cut');
  assert.ok(lR.slice(200000).every((o) => o < 0), 'the note is generated');
});

test('host == browser: the served module exports diffRows and answers the chat map and the offsets alike', async () => {
  const src = browserModuleSource();
  assert.equal(src.split('export const diffRows').length - 1, 1);
  const mod = await importSource(src);
  for (const t of CORPUS) {
    assert.deepStrictEqual(mod.sourceMap(t, { flavor: 'chat' }), sourceMap(t, { flavor: 'chat' }), JSON.stringify(t));
    assert.equal(mod.renderMarkdown(t, { flavor: 'chat', offsets: true }), chatOff(t));
    assert.deepStrictEqual(mod.diffRows(t), diffRows(t));
  }
});

// ── S2: the page's one offset engine over a chat reply ──────────────────────

// The fixture's eight replies (chat-dom-stamps.test.js draws the same shapes
// through the stream).
const REPLIES = [
  '# Plan\n\nI will **fix** the rail first, then *the tray*.',
  '## Steps\n\n- read `app.css`\n- edit the rule\n  - keep the token\n- run the tests',
  'The change:\n\n```css\n.rail { color: var(--wc-accent); }\n```\n\nThat is all.',
  'See [the guide](https://example.test/guide) and https://example.test/other for more.',
  '> The maintainer said: keep the look.\n> Nothing else.\n\nAgreed.',
  '1. first\n2. second\n3. third\n\n---\n\nDone with the list.',
  '### Result\n\n| file | lines |\n|---|--:|\n| app.css | 4 |\n| page.css | 2 |',
  'Inline `code`, ~~old~~ and a final **bold *nested* word**.',
];

test('S2: recordSource over every fixture reply answers a record, and resolveSource places it back at the same range', () => {
  for (const text of REPLIES) {
    const el = box(chatOff(text));
    const map = sourceMap(text, { flavor: 'chat' });
    // The whole reply, then each text node's own middle.
    const ranges = [];
    const all = doc.createRange();
    all.selectNodeContents(el);
    ranges.push(all);
    const w = doc.createTreeWalker(el, 4);
    let n;
    while ((n = w.nextNode())) {
      if (n.data.trim().length < 3) continue;
      const r = doc.createRange();
      r.setStart(n, 1);
      r.setEnd(n, n.data.length - 1);
      ranges.push(r);
    }
    for (const range of ranges) {
      const rec = anchors.recordSource(el, range, map, text, { md: null });
      assert.ok(rec, `a record over ${JSON.stringify(range.toString())} in ${JSON.stringify(text)}`);
      assert.equal(rec.kind, 'source');
      assert.equal(rec.md, null);
      assert.equal(rec.slug, null, 'a chat map has no headings');
      assert.equal(rec.quote.exact, text.slice(rec.pos.start, rec.pos.end));
      const back = anchors.resolveSource(el, text, map, { v: 1, kind: 'source', slug: null, quote: rec.quote, pos: rec.pos });
      assert.notEqual(back.state, 'orphaned', JSON.stringify(rec.quote.exact));
      assert.deepStrictEqual([back.start, back.end], [rec.pos.start, rec.pos.end]);
      assert.ok(back.range, 'a range is drawn');
      const again = anchors.recordSource(el, back.range, map, text, { md: null });
      assert.deepStrictEqual(again.pos, rec.pos, 'the placed range records the same span');
    }
  }
  assert.equal(anchors.alignBlock, undefined, 'alignBlock stays internal to recordSource / resolveSource');
});

test('S2: a code block\'s Copy and a prompt\'s tag are chrome (data-wc-chrome), outside the text the map aligns', () => {
  const text = '```js\nx = 1\n```';
  const el = box(chatOff(text));
  const pre = el.querySelector('pre');
  const wrap = doc.createElement('div');
  pre.replaceWith(wrap);
  const copy = doc.createElement('button');
  copy.textContent = 'Copy';
  copy.setAttribute('data-wc-chrome', 'copy');
  wrap.append(pre, copy);
  const map = sourceMap(text, { flavor: 'chat' });
  const range = doc.createRange();
  range.selectNodeContents(pre);
  const rec = anchors.recordSource(el, range, map, text, { md: null });
  assert.equal(rec.quote.exact, 'x = 1');
  copy.removeAttribute('data-wc-chrome');
  assert.equal(anchors.recordSource(el, range, map, text, { md: null }), null, 'an unmarked button breaks the alignment');
});

// ── diffRows: renderDiff's one row grammar ──────────────────────────────────

// renderDiff as it was before diffRows (ae/int cf3af5d), the oracle.
const OLD_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const OLD_META_RE = /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|\\)/;
function oldRenderDiff(input, opts) {
  if (typeof input !== 'string') return '';
  const numbers = !opts || opts.lineNumbers === undefined ? true : !!opts.lineNumbers;
  const ls = input.replace(/\r\n?/g, '\n').split('\n');
  if (ls.length && ls[ls.length - 1] === '') ls.pop();
  let out = '';
  let oldN = 0; let newN = 0; let oldLeft = 0; let newLeft = 0;
  const span = (kind, text, o, n) => {
    const attrs = numbers ? ` data-old="${o == null ? '' : o}" data-new="${n == null ? '' : n}"` : '';
    return `<span class="dl ${kind}"${attrs}>${escapeHtml(text)}</span>`;
  };
  const shown = Math.min(ls.length, 5000);
  for (let i = 0; i < shown; i++) {
    const l = ls[i];
    const c = l.charAt(0);
    if (oldLeft > 0 || newLeft > 0) {
      if (c === '+') { out += span('dl-add', l, null, newN); newN++; newLeft--; continue; }
      if (c === '-') { out += span('dl-del', l, oldN, null); oldN++; oldLeft--; continue; }
      if (c === ' ' || l === '') { out += span('dl-ctx', l, oldN, newN); oldN++; newN++; oldLeft--; newLeft--; continue; }
      if (c === '\\') { out += span('dl-meta', l); continue; }
      oldLeft = newLeft = 0;
    }
    const hm = OLD_HUNK_RE.exec(l);
    if (hm) {
      oldN = parseInt(hm[1], 10); newN = parseInt(hm[3], 10);
      oldLeft = hm[2] == null ? 1 : parseInt(hm[2], 10);
      newLeft = hm[4] == null ? 1 : parseInt(hm[4], 10);
      out += span('dl-hunk', l);
      continue;
    }
    if (c === '@' && l.charAt(1) === '@') { out += span('dl-hunk', l); continue; }
    if (OLD_META_RE.test(l)) { out += span('dl-meta', l); continue; }
    out += span(c === '+' ? 'dl-add' : c === '-' ? 'dl-del' : 'dl-ctx', l);
  }
  if (ls.length > shown) out += `<span class="dl dl-meta dl-more">… ${ls.length - shown} more lines not shown</span>`;
  return out;
}

function diffFuzz(seed, count) {
  const P = ['@@ -1,3 +1,4 @@', '@@ -10 +12 @@', '@@ -0,0 +1 @@', '@@ bad', '+add', '-del', ' ctx', '', '\\ No newline at end of file',
    'diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', 'new file mode 100644', 'Binary files a and b differ', 'plain', '<&>"\''];
  let st = seed;
  const r = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  const out = [];
  for (let k = 0; k < count; k++) {
    const n = Math.floor(r() * 20);
    const ls = [];
    for (let j = 0; j < n; j++) ls.push(P[Math.floor(r() * P.length)]);
    out.push(ls.join(r() < 0.3 ? '\r\n' : '\n') + (r() < 0.5 ? '\n' : ''));
  }
  return out;
}
const DIFFS = [
  '', '\n', 'x', '@@ -1,2 +1,2 @@\n-a\n+b\n c\n', '@@ -5 +5 @@\n-x\n+y\nafter',
  Array.from({ length: 5003 }, (_, i) => `+l${i}`).join('\n'),
  ...diffFuzz(17, 500),
];

test('diffRows: renderDiff over the rows is the old renderDiff byte for byte (numbers on and off); non-text renders \'\'', () => {
  for (const d of DIFFS) {
    assert.equal(renderDiff(d), oldRenderDiff(d), JSON.stringify(d).slice(0, 200));
    assert.equal(renderDiff(d, { lineNumbers: false }), oldRenderDiff(d, { lineNumbers: false }));
    assert.equal(renderDiff(d, { lineNumbers: true }), oldRenderDiff(d, { lineNumbers: true }));
  }
  for (const x of [null, undefined, 3, {}, ['@@']]) {
    assert.equal(renderDiff(x), '');
    assert.deepStrictEqual(diffRows(x), []);
  }
});

test('diffRows: each row\'s kind, text and old/new equal the span renderDiff draws for it', () => {
  for (const d of DIFFS) {
    const rows = diffRows(d);
    const spans = [...box(renderDiff(d)).children];
    assert.equal(rows.length, spans.length);
    rows.forEach((row, i) => {
      const s = spans[i];
      assert.ok(['add', 'del', 'ctx', 'hunk', 'meta', 'more'].includes(row.kind));
      assert.equal(s.textContent, row.text);
      if (row.kind === 'more') {
        assert.equal(s.className, 'dl dl-meta dl-more');
        assert.equal(row.old, null);
        assert.equal(row.new, null);
        assert.equal(typeof row.more, 'number');
        return;
      }
      assert.equal(s.className, `dl dl-${row.kind}`);
      assert.equal(s.getAttribute('data-old'), row.old == null ? '' : String(row.old));
      assert.equal(s.getAttribute('data-new'), row.new == null ? '' : String(row.new));
    });
  }
  assert.deepStrictEqual(diffRows('@@ -3,2 +7,2 @@\n ctx\n-gone\n+came\n'), [
    { kind: 'hunk', text: '@@ -3,2 +7,2 @@', old: null, new: null },
    { kind: 'ctx', text: ' ctx', old: 3, new: 7 },
    { kind: 'del', text: '-gone', old: 4, new: null },
    { kind: 'add', text: '+came', old: null, new: 8 },
  ]);
});
