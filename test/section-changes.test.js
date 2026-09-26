// What a node changed, per #/## section of its page (UX upgrade p34c, unit c2):
// lib/server/domain/lineage sectionChanges, served as GET /api/graph/changes for
// the phone graph log's chips (design "Graph Prototype": `# Results +2 ~1`).
// Pinned here: sections are read off the markdown headings in page order (no
// stored structure), an item belongs to the section it sits under (a chunk that
// opens with a heading, to that heading), panes compare by content — never
// layout — markdown by text, removals count where the item sat in the PARENT,
// a page with no headings has no sections, and the route carries only the
// nodes that have some.

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { sectionChanges } = require('../lib/server/domain/lineage');

const pane = (id, html = `<p>${id}</p>`, extra = {}) => ({ id, html, target: 'main', params: {}, ...extra });
const md = (id, text) => ({ id, text, owner: 'claude' });

const PARENT = {
  id: 'n1',
  markdown: [md('m-top', 'Intro, no heading.'), md('m-setup', '# Setup\n\nmethod'), md('m-res', '## Results')],
  mounts: [pane('lead'), pane('method'), pane('params'), pane('fig'), pane('gone')],
  order: ['m-top', 'lead', 'm-setup', 'method', 'params', 'm-res', 'fig', 'gone'],
};

test('a root node: everything it holds is added, section by section', () => {
  assert.deepEqual(sectionChanges(PARENT, null), [
    { h: '', sec: 'top of page', add: 2 },
    { h: '#', sec: 'Setup', add: 3 },
    { h: '##', sec: 'Results', add: 3 },
  ]);
});

test('against its parent: added, changed and removed, in the section each sits under', () => {
  const child = {
    id: 'n2',
    markdown: [
      md('m-top', 'Intro, no heading.'),
      md('m-setup', '# Setup\n\nmethod, revised'),          // text changed
      md('m-res', '## Results'),
      md('m-disc', '# Discussion\n\nopen questions'),       // new section
    ],
    mounts: [
      pane('lead'),
      pane('method', '<p>method</p>', { pane_state: { col: 7, colSpan: 6, rows: 4 } }), // layout only
      pane('params', '<p>params v2</p>'),                    // content changed
      pane('fig', '<p>fig</p>', { form_state: { '#x:0': 'typed' } }),                  // typing only
      pane('q', '<p>questions</p>'),                          // new, under Discussion
    ],
    order: ['m-top', 'lead', 'm-setup', 'method', 'params', 'm-res', 'fig', 'm-disc', 'q'],
  };
  assert.deepEqual(sectionChanges(child, PARENT), [
    { h: '#', sec: 'Setup', chg: 2 },
    { h: '#', sec: 'Discussion', add: 2 },
    { h: '##', sec: 'Results', rm: 1 },
  ], 'layout and typed values are not changes; `gone` counts where it sat in the parent');
});

test('a chunk belongs to the heading it opens with; later headings in it start the next section', () => {
  const node = {
    id: 'n3',
    markdown: [md('a', '# One\n\ntext\n\n## Two'), md('b', 'just prose')],
    mounts: [pane('p1')],
    order: ['a', 'p1', 'b'],
  };
  assert.deepEqual(sectionChanges(node, null), [
    { h: '#', sec: 'One', add: 1 },
    { h: '##', sec: 'Two', add: 2 },
  ], 'the chunk is One\'s; the pane and the prose after it sit under Two');
});

test('### is not a section, fenced code is not a heading, and a page with no headings has none', () => {
  const plain = { id: 'n4', mounts: [pane('a'), pane('b')] };
  assert.deepEqual(sectionChanges(plain, null), [], 'a node from before markdown: no chips');
  const deep = { id: 'n5', markdown: [md('x', '### Detail\n\n```\n# not a heading\n```')], mounts: [pane('a')], order: ['x', 'a'] };
  assert.deepEqual(sectionChanges(deep, null), []);
  // …but a node whose PARENT had sections still reports what it took away.
  assert.deepEqual(sectionChanges(plain, { id: 'n0', markdown: [md('h', '# Gone')], mounts: [pane('a'), pane('b')], order: ['h', 'a', 'b'] }),
    [{ h: '#', sec: 'Gone', rm: 1 }]);
});

test('the answer is kept per node, and asked again for a different parent', () => {
  const node = { id: 'n6', markdown: [md('h', '# S')], mounts: [pane('a')], order: ['h', 'a'] };
  const first = sectionChanges(node, null);
  assert.equal(sectionChanges(node, null), first, 'cached on the node');
  const withParent = sectionChanges(node, { id: 'n5', markdown: [md('h', '# S')], mounts: [], order: ['h'] });
  assert.deepEqual(withParent, [{ h: '#', sec: 'S', add: 1 }]);
});

test('GET /api/graph/changes: each committed node against its parent, only nodes with sections', async (t) => {
  const { api } = await withServer(t);
  const turn = async (message) => {
    await api.post('/api/turn-begin', { message });
    return (await api.post('/api/turn-end', {})).json.node_id;
  };
  await api.post('/api/render', { id: 'bare', html: '<p>no headings yet</p>' });
  const n1 = await turn('a pane, no markdown');
  await api.post('/api/markdown', { id: 'h-res', text: '# Results' });
  await api.post('/api/render', { id: 'fig', html: '<p>fig</p>' });
  const n2 = await turn('a section and a figure');
  await api.post('/api/render', { id: 'fig', html: '<p>fig v2</p>' });
  const n3 = await turn('redraw the figure');

  const body = (await api.get('/api/graph/changes')).json;
  assert.equal(n1 in body.changes, false, 'no heading on either side: no entry');
  assert.deepEqual(body.changes[n2], [{ h: '#', sec: 'Results', add: 2 }],
    'the heading and the figure under it are new; `bare`, unchanged above it, is not listed');
  assert.deepEqual(body.changes[n3], [{ h: '#', sec: 'Results', chg: 1 }]);
});
