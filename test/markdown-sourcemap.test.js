// The markdown source map (lib/core/markdown.js `sourceMap`, annotation engine
// 1C.2/1C.3): where each piece of a page item's rendered text came from in its
// source, kept out of band. Pinned here:
//   * the page flavour stays byte-identical (the map is a separate function that
//     re-instantiates the factory with a tagging escaper; stripping the tags
//     gives renderMarkdown's output) — over the 350 recorded golden inputs;
//   * host == browser: the served /app/markdown.js answers the same map;
//   * the runs align with the rendered DOM's text nodes (one named exception:
//     a NUL, which the HTML parser drops), their offsets index the source, and
//     a CRLF input maps as its LF form;
//   * the headings agree with headings() and carry their line's span;
//   * the markers never collide with the text, and are never raw characters in
//     the source;
//   * pageItems is unchanged without the option and adds {map, src} with it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { escapeHtml } = require('../lib/core/html');
const { renderMarkdown, headings, sourceMap, createMarkdown, browserModuleSource } = require('../lib/core/markdown');
const { pageItems, previewNodeJson } = require('../lib/server/preview');
const { withServer } = require('../test-support/helpers');

const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'markdown-page-golden.json'), 'utf8')).cases;
const lf = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');
const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;

// The rendered block's text nodes, the inter-block '\n' separators skipped.
function textNodes(html) {
  const box = doc.createElement('div');
  box.className = 'md-block';
  box.innerHTML = html;
  const out = [];
  const w = doc.createTreeWalker(box, 4 /* SHOW_TEXT */);
  let n;
  while ((n = w.nextNode())) {
    if (n.parentNode === box && /^\n*$/.test(n.data)) continue;
    out.push(n.data);
  }
  return out;
}

// The rendered characters a run stands for, read back through its offsets.
function runText(src, run) {
  if (run[3] === 'exact') return src.slice(run[0], run[1]);
  if (run[3] === 'subseq') return run[4].map((o) => src[o]).join('');
  return null;
}

// Walk the runs by `len` over the text nodes: true when, in order, they
// reproduce every node exactly (several consecutive runs may share one node).
function aligns(src, map, nodes) {
  let r = 0;
  for (const data of nodes) {
    let off = 0;
    while (r < map.runs.length && off < data.length) {
      const run = map.runs[r];
      const want = runText(src, run);
      if (want == null || data.substr(off, run[2]) !== want) return false;
      off += run[2];
      r++;
    }
    if (off !== data.length) return false;
  }
  return r === map.runs.length;
}

test('sourceMap: the shape — {v: 1, len, runs, headings}, offsets on the LF-normalised text', () => {
  const text = '# Title\r\n\r\nSome **bold** and a [link](https://a.test/) here.\r\n';
  const m = sourceMap(text);
  assert.deepStrictEqual(Object.keys(m), ['v', 'len', 'runs', 'headings']);
  assert.equal(m.v, 1);
  assert.equal(m.len, lf(text).length);
  const src = lf(text);
  // The href is an attribute run and is dropped; the data-slug too.
  assert.deepStrictEqual(m.runs.map((r) => runText(src, r)), ['Title', 'Some ', 'bold', ' and a ', 'link', ' here.']);
  for (const r of m.runs) assert.deepStrictEqual(r.slice(0, 4), [src.indexOf(runText(src, r)), src.indexOf(runText(src, r)) + r[2], r[2], 'exact']);
  assert.deepStrictEqual(m.headings, [{ level: 1, slug: 'title', start: 0, end: 7 }]);
  assert.deepStrictEqual(sourceMap(''), { v: 1, len: 0, runs: [], headings: [] });
});

test('sourceMap: an escape\'s backslash and a trimmed continuation line are subseq runs with their offsets', () => {
  const text = 'a \\*star\\* b';
  const m = sourceMap(text);
  assert.equal(m.runs.length, 1);
  const [start, end, len, kind, offs] = m.runs[0];
  assert.equal(kind, 'subseq');
  assert.equal(len, 'a *star* b'.length);
  assert.equal(offs.length, len);
  assert.equal(start, offs[0]);
  assert.equal(end, offs[offs.length - 1] + 1);
  assert.equal(offs.map((o) => text[o]).join(''), 'a *star* b');
});

test('subseq: the window is len*2 + 16 characters from the previous run\'s end; past it a run is unmapped and still holds its length', () => {
  // A list item's continuation line loses its indent: "a\nb" (3 rendered
  // characters) is a subseq run while its "b" sits inside 0 + 3*2 + 16 = 22.
  const inside = '- a\n' + ' '.repeat(17) + 'b';
  assert.deepStrictEqual(sourceMap(inside).runs, [[2, 22, 3, 'subseq', [2, 3, 21]]]);
  const past = '- a\n' + ' '.repeat(18) + 'b';
  const m = sourceMap(past);
  assert.deepStrictEqual(m.runs, [[-1, -1, 3, 'unmapped']]);
  // The unmapped run still occupies its rendered characters.
  assert.equal(textNodes(renderMarkdown(past)).join('').length, m.runs[0][2]);
});

test('golden: the page flavour is untouched — renderMarkdown still reproduces every recorded output', () => {
  assert.equal(GOLDEN.length, 350);
  for (const c of GOLDEN) assert.equal(renderMarkdown(c.input), c.output, JSON.stringify(c.input));
});

test('golden: the tagged render with its markers stripped is renderMarkdown byte for byte', () => {
  // The mechanism sourceMap reads its runs off, rebuilt here with markers that
  // no golden input holds: every escaper call wrapped, then the wrapping cut.
  const OPEN = '\uE100', MID = '\uE101', CLOSE = '\uE102';
  const strip = new RegExp(OPEN + '\\d+' + MID + '|' + CLOSE, 'g');
  for (const c of GOLDEN) {
    assert.ok(!/[\uE100-\uE102]/.test(c.input));
    let k = 0;
    const tagged = createMarkdown((s) => OPEN + (k++) + MID + escapeHtml(s) + CLOSE).renderMarkdown(c.input);
    assert.equal(tagged.replace(strip, ''), renderMarkdown(c.input), JSON.stringify(c.input));
  }
});

test('golden: the runs align with the rendered DOM text, but for the one input the HTML parser rewrites (a NUL)', () => {
  const misaligned = [];
  let subseq = 0;
  for (const c of GOLDEN) {
    const src = lf(c.input);
    const m = sourceMap(c.input);
    const nodes = textNodes(renderMarkdown(c.input));
    const rendered = nodes.join('').length;
    const sum = m.runs.reduce((a, r) => a + r[2], 0);
    if (!aligns(src, m, nodes)) {
      misaligned.push(c.input);
      continue;
    }
    // Sum of run lengths = the rendered text, separators excluded.
    assert.equal(sum, rendered, JSON.stringify(c.input));
    for (const r of m.runs) {
      assert.notEqual(r[3], 'unmapped', JSON.stringify(c.input));
      if (r[3] === 'subseq') subseq++;
    }
  }
  // Named, not skipped: the HTML parser drops the NUL from the text node, so a
  // run's 3 characters render as 2. A CR never reaches a run (lines() turns it
  // into a LF first), so no CR case is left.
  assert.deepStrictEqual(misaligned, ['a\u0000b']);
  assert.equal(subseq, 7, 'the 350 golden hold seven subseq runs (an escape\'s backslash, a trimmed continuation line)');
});

test('golden: every exact run slices its text, every subseq run\'s offsets increase and index its characters', () => {
  for (const c of GOLDEN) {
    const src = lf(c.input);
    const m = sourceMap(c.input);
    assert.equal(m.len, src.length);
    let prevEnd = 0;
    for (const r of m.runs) {
      const [start, end, len, kind] = r;
      if (kind === 'exact') {
        assert.equal(r.length, 4);
        assert.equal(end - start, len);
        assert.ok(start >= prevEnd, 'runs search forward from the previous run\'s end');
      } else if (kind === 'subseq') {
        const offs = r[4];
        assert.equal(offs.length, len);
        for (let i = 1; i < offs.length; i++) assert.ok(offs[i] > offs[i - 1], JSON.stringify(c.input));
        assert.ok(offs[0] >= prevEnd);
        assert.equal(start, offs[0]);
        assert.equal(end, offs[len - 1] + 1);
      } else {
        assert.deepStrictEqual([start, end], [-1, -1]);
        continue;
      }
      assert.ok(len > 0, 'an empty raw string is no run');
      assert.ok(end <= src.length);
      prevEnd = end;
    }
  }
});

test('golden: a CRLF (or lone CR) input maps exactly as its LF form', () => {
  for (const c of GOLDEN) {
    if (typeof c.input !== 'string' || /\r/.test(c.input)) continue;
    const want = sourceMap(c.input);
    assert.deepStrictEqual(sourceMap(c.input.replace(/\n/g, '\r\n')), want, JSON.stringify(c.input));
    assert.deepStrictEqual(sourceMap(c.input.replace(/\n/g, '\r')), want, JSON.stringify(c.input));
  }
});

test('headings: the level and slug headings() gives, and the heading line\'s span', () => {
  const extra = [
    '# Same\n\ntext\n\n## Same\n\n### Same',
    '# One\n\n```\n# x\n```\n\n## Two',
    '  \n# Lead  #\r\n\r\n#### four is a paragraph\r\n## *em* [l](https://a.test)',
  ];
  for (const text of GOLDEN.map((c) => c.input).concat(extra)) {
    const m = sourceMap(text);
    const src = lf(text);
    assert.deepStrictEqual(m.headings.map((h) => [h.level, h.slug]), headings(text).map((h) => [h.level, h.slug]), JSON.stringify(text));
    for (const h of m.headings) {
      assert.deepStrictEqual(Object.keys(h), ['level', 'slug', 'start', 'end']);
      const line = src.slice(h.start, h.end);
      assert.ok(!line.includes('\n'), JSON.stringify(text));
      assert.ok(h.start === 0 || src[h.start - 1] === '\n');
      assert.ok(h.end === src.length || src[h.end] === '\n');
      assert.match(line, /^#{1,3}[ \t]/);
    }
  }
  assert.deepStrictEqual(sourceMap(extra[0]).headings.map((h) => h.slug), ['same', 'same-1', 'same-2']);
  const fenced = sourceMap(extra[1]);
  assert.deepStrictEqual(fenced.headings.map((h) => [h.slug, extra[1].slice(h.start, h.end)]), [['one', '# One'], ['two', '## Two']]);
});

test('markers: a text holding U+E000–U+E002 (or all of the BMP Private Use Area) maps as cleanly as one that does not', () => {
  const plain = '# Head x\n\nsome x **bold x** and `x` \\* x';
  for (const pua of ['\uE000', '\uE001', '\uE002']) {
    const text = plain.replace(/x/g, pua + '\uE000\uE001\uE002'.replace(pua, ''));
    const m = sourceMap(text);
    assert.ok(m.runs.length > 0);
    assert.ok(aligns(text, m, textNodes(renderMarkdown(text))), JSON.stringify(text));
    const shape = sourceMap(plain.replace(/x/g, 'xyz')).runs.map((r) => [r[2], r[3]]);
    assert.deepStrictEqual(m.runs.map((r) => [r[2], r[3]]), shape);
  }
  // Every BMP PUA character present: the walk moves on to plane 15.
  let all = '';
  for (let c = 0xe000; c <= 0xf8ff; c++) all += String.fromCharCode(c);
  const text = '# T\n\n' + all + ' **b**';
  const m = sourceMap(text);
  assert.ok(m.runs.length >= 3);
  assert.ok(aligns(text, m, textNodes(renderMarkdown(text))));
  assert.ok(m.runs.every((r) => r[3] === 'exact'));
});

test('markers: the module source holds no raw Private Use Area character', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'markdown.js'), 'utf8');
  assert.ok(!/[\uE000-\uF8FF]/.test(src), 'a BMP PUA character is written raw');
  assert.ok(!/[\uDB80-\uDBFF]/.test(src), 'a plane 15/16 PUA character is written raw');
  assert.ok(!/[\uE000-\uF8FF\uDB80-\uDBFF]/.test(browserModuleSource()));
});

test('host == browser: the module source exports sourceMap once, and it answers the host\'s map', async () => {
  const src = browserModuleSource();
  assert.equal(src.split('export const sourceMap').length - 1, 1);
  const mod = await importSource(src);
  for (const c of GOLDEN) assert.deepStrictEqual(mod.sourceMap(c.input), sourceMap(c.input), JSON.stringify(c.input));
});

test('host == browser: the served /app/markdown.js answers the host\'s map for every golden input', async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/app/markdown.js`);
  assert.equal(res.status, 200);
  const mod = await importSource(await res.text());
  for (const c of GOLDEN) {
    assert.equal(mod.renderMarkdown(c.input), c.output, JSON.stringify(c.input));
    assert.deepStrictEqual(mod.sourceMap(c.input), sourceMap(c.input), JSON.stringify(c.input));
    if (typeof c.input === 'string') {
      const crlf = c.input.replace(/\n/g, '\r\n');
      assert.deepStrictEqual(mod.sourceMap(crlf), sourceMap(crlf));
    }
  }
});

test('pageItems: unchanged without the option; with it, markdown items carry {map, src}', () => {
  const node = {
    id: 'n',
    mounts: [{ id: 'p1', html: '<b>1</b>' }, { id: 'p2', html: '<i>2</i>' }],
    markdown: [
      { id: 'md-title', text: '# Title\r\n\r\nA line.' },
      { id: 'md-mid', text: 'between **panes** <x>' },
      { id: 'md-end', text: '## End\n\n- a\n- b' },
    ],
    order: ['md-title', 'p1', 'md-mid', 'p2', 'md-end'],
  };
  // Today's shape, built by hand: { md, html } and { pane }.
  const today = [
    { md: 'md-title', html: renderMarkdown(node.markdown[0].text) },
    { pane: 'p1' },
    { md: 'md-mid', html: renderMarkdown(node.markdown[1].text) },
    { pane: 'p2' },
    { md: 'md-end', html: renderMarkdown(node.markdown[2].text) },
  ];
  assert.deepStrictEqual(pageItems(node), today);
  assert.deepStrictEqual(pageItems(node, {}), today);
  assert.deepStrictEqual(pageItems(node, { sourceMap: false }), today);
  for (const item of pageItems(node)) assert.deepStrictEqual(Object.keys(item), item.md ? ['md', 'html'] : ['pane']);
  // previewNodeJson's bytes are the pre-change form.
  const { markdown: _m, mirror: _t, ...rest } = node;
  assert.equal(previewNodeJson(node), JSON.stringify({ ...rest, page: today }).replace(/</g, '\\u003c'));

  const mapped = pageItems(node, { sourceMap: true });
  assert.equal(mapped.length, today.length);
  mapped.forEach((item, i) => {
    if (item.pane) { assert.deepStrictEqual(item, today[i]); return; }
    const text = node.markdown.find((m) => m.id === item.md).text;
    assert.deepStrictEqual(Object.keys(item), ['md', 'html', 'map', 'src']);
    assert.equal(item.html, today[i].html);
    assert.equal(item.src, lf(text));
    assert.deepStrictEqual(item.map, sourceMap(text));
    assert.equal(item.map.len, item.src.length);
  });
  assert.deepStrictEqual(pageItems(null, { sourceMap: true }), []);
});
