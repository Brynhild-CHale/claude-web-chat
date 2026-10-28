// The page title's meta line (node · panes · updated) sits OUTSIDE the title
// item's [data-md-id] body (U403a, DECISIONS.md K.2-162, PQ-F-3).
//
// The [data-md-id] block is what the comment tool (comments.js
// createOnMarkdown) and the resolver (lib/core/anchors.js recordSource →
// alignBlock) read: alignBlock walks every text node of the block against the
// item's source map, so a meta line inside it made the title item's map
// misalign and its heading and first paragraph unpinnable. public/app/page.js
// syncPageMeta now puts the meta right after the item, on the page, and
// layoutPage passes it over (a counted meta line would move every run after it).
//
// Pinned here:
//   - the title item's body text equals its rendered source with the meta present,
//     and the resolver records a source anchor over its heading and paragraph
//     (a control puts a meta line back inside the body: the record is null);
//   - the meta reads under the H1: the title item's next sibling, after the H1;
//   - a re-layout keeps one meta line after the title item and re-parents no run;
//     a new title takes the meta with it.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const TITLE = '# Experiment 12\n\nThe first paragraph, under the title.\n\n## Method\n\nA later paragraph.';
const PANE = { id: 'pm-a', html: '<p>a</p>', target: 'main', params: {} };
const ORDER = ['md-title', 'pm-a'];

let shell = null, W = null, anchors = null, md = null;

before(async () => {
  shell = await bootShell({
    routes: { '/api/graph': { nodes: [{ id: 'n1', label: 'n1.0', parent_id: null, created_at: Date.now() }], active: 'n1' } },
  });
  W = shell.window;
  anchors = (await shell.importApp('anchors.js')).default;
  md = await shell.importApp('markdown.js');
  await shell.frame(helloFrame({
    active: 'n1', mounts: [PANE],
    markdown: [{ id: 'md-title', text: TITLE, owner: 'claude' }], order: ORDER, claude_order: ORDER,
  }));
  await shell.tick(40);
});
after(async () => { if (shell) await shell.restore(); });

const item = (id = 'md-title') => W.document.querySelector(`[data-md-id="${id}"]`);
const metas = () => [...W.document.querySelectorAll('.page-meta')];
function recordOver(el, text, id = 'md-title') {
  const range = W.document.createRange();
  range.selectNodeContents(el);
  return anchors.recordSource(item(id), range, md.sourceMap(text), text, { md: id });
}

test('the title item\'s body text equals its rendered source with the meta present; its heading and paragraph take a source record', () => {
  assert.equal(metas().length, 1, 'precondition: the meta line is drawn');
  assert.equal(item().querySelector('.page-meta'), null, 'the meta line is not inside the [data-md-id] body');
  const rendered = W.document.createElement('div');
  rendered.innerHTML = md.renderMarkdown(TITLE);
  assert.equal(item().textContent, rendered.textContent, 'the body\'s text is exactly the rendered source\'s');
  const h1 = item().querySelector('h1');
  const rec = recordOver(h1, TITLE);
  assert.ok(rec, 'the title heading records');
  assert.equal(rec.quote.exact, 'Experiment 12');
  const p = item().querySelector('p');
  const prose = recordOver(p, TITLE);
  assert.ok(prose, 'the first paragraph records');
  assert.equal(prose.quote.exact, 'The first paragraph, under the title.');
  // The control: a meta line back inside the body (where it was before U403a)
  // misaligns the item's map, and nothing records.
  const inside = metas()[0].cloneNode(true);
  h1.insertAdjacentElement('afterend', inside);
  try {
    assert.equal(recordOver(h1, TITLE), null, 'with the meta inside the body the heading does not record');
    assert.equal(recordOver(p, TITLE), null, 'nor the paragraph');
  } finally { inside.remove(); }
});

test('the meta reads under the H1: the title item\'s next sibling, the H1 marked as the page\'s', () => {
  const h1 = item().querySelector('h1');
  assert.ok(h1.classList.contains('page-h1'));
  const [meta] = metas();
  assert.equal(item().nextElementSibling, meta, 'right after the title item, before its run');
  assert.ok(h1.compareDocumentPosition(meta) & W.Node.DOCUMENT_POSITION_FOLLOWING, 'after the H1');
  assert.equal(meta.parentElement, shell.$('main'), 'on the page');
  assert.match(meta.textContent, /^n1\.0 · 1 pane · updated \d\d:\d\d/, 'what it says is unchanged');
});

test('a re-layout keeps one meta line after the title item and re-parents no run; a new title takes the meta with it', async () => {
  const run = W.document.querySelector('#main .page-run');
  const wrapper = run.querySelector('.run-grid > .pane');
  const order2 = [...ORDER, 'md-more'];
  // A move is a removal and an insertion on #main's child list: a run moved
  // there re-parents its panes' iframes, which reload.
  const moved = [];
  const obs = new W.MutationObserver((recs) => { for (const r of recs) moved.push(...r.removedNodes); });
  obs.observe(shell.$('main'), { childList: true });
  await shell.frame({ type: 'markdown', id: 'md-more', text: '## More', owner: 'claude', gen: 1, order: order2, claude_order: order2 });
  await shell.tick(20);
  moved.push(...obs.takeRecords().flatMap((r) => [...r.removedNodes]));
  obs.disconnect();
  assert.deepEqual(moved.filter((n) => n.classList && n.classList.contains('page-run')), [], 'no run was moved on the page');
  assert.ok(item('md-more'), 'precondition: the new item is drawn');
  assert.equal(metas().length, 1, 'one meta line');
  assert.equal(item().nextElementSibling, metas()[0]);
  assert.equal(W.document.querySelector('#main .page-run'), run, 'the same run element');
  assert.equal(wrapper.parentElement, run.querySelector('.run-grid'), 'its pane was not re-parented');

  const order3 = ['md-new', ...order2];
  await shell.frame({ type: 'markdown', id: 'md-new', text: '# New title', owner: 'claude', gen: 1, order: order3, claude_order: order3 });
  await shell.tick(20);
  assert.equal(shell.$('page-title').textContent, 'New title');
  assert.equal(metas().length, 1, 'still one meta line');
  assert.equal(item('md-new').nextElementSibling, metas()[0], 'after the new title item');
  assert.equal(item('md-new').querySelector('.page-meta'), null);
  assert.equal(item().querySelector('h1').classList.contains('page-h1'), false, 'the old title is a plain # heading again');
});
