// The chat tool card's Show on page (public/app/chat-tools.js, the webchat
// case) for every kind of item a web-chat call puts up — render, use_component
// and write_markdown — live and on a previewed older node (annotation engine
// tranche 1, U231; PLAN.md 1D.4; X-19).
//
//   * A pane (render, use_component) is found by mounts.js revealPane, as at
//     f3c4a7f: it flashes `.pane-flash` and the label stays "Show on page".
//   * A markdown item (write_markdown) is found by page.js revealMarkdown, tried
//     only when revealPane finds no pane: `.md-block[data-md-id]` flashes
//     `md-flash` for 1400 ms, and the label stays "Show on page".
//   * "Not on the page now" only when the page now DRAWN lacks the item: a
//     previewed node without it, an item a page frame removed, an id nothing has.
//   * A click writes nothing: no POST, previewing or not.
//
// The cards are built by the real renderToolCard, opened as a click on their
// header opens them, and their button clicked (the x19 driver's shape).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const PANE = (id, extra = {}) => ({ id, html: `<p>${id}</p>`, target: 'main', params: {}, pane_state: {}, ...extra });
const result = (preview) => ({ preview, bytes: Buffer.byteLength(preview), is_error: false, full: true });
let seq = 0;
const call = (tool, input, res) => ({ id: `tu_sop_${++seq}`, kind: 'tool_call', tool: `mcp__web-chat__${tool}`, tool_kind: 'MCP',
  server: 'web-chat', label: tool, call: tool, status: 'done', started_at: T0, ended_at: T0 + 10, duration_ms: 10,
  input, result: result(res) });

const NODE_OLD = { id: 'n0', label: 'n1.0', mounts: [PANE('x19-old')], markdown: [{ id: 'md-old', text: '## Old' }],
  order: ['md-old', 'x19-old'], store: {} };

// The host's own page: the mirror reads at `local`, with no conversation yet.
const MIRROR = { v: 1, enabled: true, now: T0, rev: 1, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [] };

let shell, W, D, tools, page, state, chatState, topbar, host;

before(async () => {
  shell = await bootShell({ routes: {
    '/api/graph': { nodes: [{ id: 'n0', label: 'n1.0', parent_id: null, created_at: 1 },
      { id: 'n1', label: 'n1.1', parent_id: 'n0', created_at: 2 }], active: 'n1' },
    '/api/graph/node/*': (url) => (url.split('?')[0].endsWith('/n0') ? NODE_OLD : { id: 'n1', mounts: [], store: {} }),
    '/api/mirror': () => ({ ...MIRROR, now: Date.now() }),
    '/api/mirror/items/*': () => respond({ ok: false, error: 'not found' }, { status: 404 }),
  } });
  W = shell.window;
  D = W.document;
  tools = await shell.importApp('chat-tools.js');
  page = await shell.importApp('page.js');
  state = await shell.importApp('state.js');
  topbar = await shell.importApp('topbar.js');
  chatState = await shell.importApp('chat-state.js');
  await shell.frame(helloFrame({
    active: 'n1',
    mounts: [PANE('sop-pane'), PANE('mount-1784236922999'), PANE('sop-comp', { component: 'git-dashboard' })],
    markdown: [{ id: 'md-x', text: '## Results' }, { id: 'md-7', text: 'A caption.' }, { id: 'md-gone', text: 'Going.' }],
    order: ['md-x', 'sop-pane', 'mount-1784236922999', 'md-7', 'sop-comp', 'md-gone'],
  }));
  await waitUntil(() => chatState.mirror.access.level === 'local', { what: 'the mirror read at local' });
  host = D.createElement('div');
  host.id = 'sop-cards';
  D.body.appendChild(host);
});
after(() => shell.restore());

const mdEl = (id) => D.querySelector(`#main .md-block[data-md-id="${id}"]`);
const paneEl = (id) => [...D.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === id) || null;
const posts = () => shell.calls.filter((c) => c.method !== 'GET').length;

// Build the card, open it, click its Show on page. → { label, button }.
async function reveal(item) {
  const card = tools.renderToolCard(item);
  host.appendChild(card);
  card.open = true;
  card.dispatchEvent(new W.Event('toggle'));
  const b = await waitUntil(() => card.querySelector('.tc-reveal'), { what: 'the Show on page button' });
  assert.equal(b.textContent, 'Show on page', 'the button\'s label before any click');
  shell.click(b);
  const label = b.textContent;
  card.remove();
  return { label, button: b };
}

const CASES = {
  render: () => call('render', { id: 'sop-pane', html: '<p/>' }, '{"ok":true,"id":"sop-pane"}'),
  renderAssigned: () => call('render', { html: '<p/>' }, '{"ok":true,"id":"mount-1784236922999"}'),
  useComponent: () => call('use_component', { id: 'sop-comp', name: 'git-dashboard' }, '{"ok":true,"id":"sop-comp"}'),
  markdown: (id = 'md-x') => call('write_markdown', { id, text: '## Results' }, `{"ok":true,"id":"${id}"}`),
  markdownAssigned: () => call('write_markdown', { text: 'A caption.' }, '{"ok":true,"id":"md-7"}'),
};

test('a write_markdown card shows its item: scrolled to, md-flash for 1400 ms, "Show on page"', async () => {
  assert.ok(mdEl('md-x'), 'the markdown item is drawn');
  const scrolls = shell.scrolls.length;
  const before = posts();
  const { label } = await reveal(CASES.markdown());
  assert.equal(label, 'Show on page');
  assert.ok(mdEl('md-x').classList.contains('md-flash'), 'the markdown item flashes');
  assert.ok(shell.scrolls.slice(scrolls).some((s) => s.el === mdEl('md-x')
    && s.arg && s.arg.block === 'nearest' && s.arg.behavior === 'smooth'), 'and is brought into view');
  assert.equal(D.querySelectorAll('#main .pane-flash').length, 0, 'no pane flashed');
  assert.equal(posts(), before, 'the click wrote nothing');
  await waitUntil(() => !mdEl('md-x').classList.contains('md-flash'), { timeout: 3000, what: 'the flash to end' });
});

test('a write_markdown card with a server-assigned id reveals the id its result answered', async () => {
  const { label } = await reveal(CASES.markdownAssigned());
  assert.equal(label, 'Show on page');
  assert.ok(mdEl('md-7').classList.contains('md-flash'), 'md-7 flashes');
  assert.ok(!mdEl('md-x').classList.contains('md-flash'), 'and only md-7');
  await waitUntil(() => !mdEl('md-7').classList.contains('md-flash'), { timeout: 3000, what: 'the flash to end' });
});

test('render and use_component cards still flash their pane, as at f3c4a7f', async () => {
  for (const [make, id] of [[CASES.render, 'sop-pane'], [CASES.renderAssigned, 'mount-1784236922999'], [CASES.useComponent, 'sop-comp']]) {
    const before = posts();
    const { label } = await reveal(make());
    assert.equal(label, 'Show on page', id);
    assert.ok(paneEl(id).classList.contains('pane-flash'), `${id} flashes its pane`);
    assert.equal(D.querySelectorAll('#main .md-flash').length, 0, `${id}: no markdown item flashed`);
    assert.equal(posts(), before, `${id}: the click wrote nothing`);
  }
});

test('revealMarkdown answers false for an id the page lacks, and throws nothing', () => {
  assert.equal(typeof page.revealMarkdown, 'function');
  assert.equal(page.revealMarkdown('nope'), false);
  assert.equal(page.revealMarkdown('sop-pane'), false, 'a pane id is not a markdown item');
  assert.equal(page.revealMarkdown(undefined), false);
  // an element still held but no longer in the document is not on the page
  const el = mdEl('md-7');
  const parent = el.parentNode;
  const next = el.nextSibling;
  el.remove();
  try {
    assert.equal(page.revealMarkdown('md-7'), false, 'a detached element is not revealed');
    assert.ok(!el.classList.contains('md-flash'), 'and is not flashed');
  } finally {
    parent.insertBefore(el, next);
  }
  assert.equal(mdEl('md-7'), el, 'put back where it was');
});

test('a card for an id that is neither a pane nor a drawn markdown item reads "Not on the page now"', async () => {
  const { label } = await reveal(call('render', { id: 'sop-absent', html: '<p/>' }, '{"ok":true,"id":"sop-absent"}'));
  assert.equal(label, 'Not on the page now');
  const md = await reveal(CASES.markdown('md-never'));
  assert.equal(md.label, 'Not on the page now');
});

test('a markdown item a page frame removed reads "Not on the page now"', async () => {
  assert.ok(mdEl('md-gone'), 'drawn first');
  const before = (await reveal(CASES.markdown('md-gone'))).label;
  assert.equal(before, 'Show on page');
  await shell.frame({ type: 'markdown:remove', id: 'md-gone' });
  assert.equal(mdEl('md-gone'), null, 'layoutPage took it off the page');
  assert.equal((await reveal(CASES.markdown('md-gone'))).label, 'Not on the page now');
});

test('previewing an older node: its markdown item is shown, a live-only one is not, and nothing is posted', async () => {
  await topbar.previewNode('n0');
  await shell.tick();
  assert.equal(state.view.previewing, true, 'the older node is previewed');
  assert.ok(mdEl('md-old'), 'the previewed node\'s markdown item is drawn');
  assert.equal(mdEl('md-x'), null, 'the live markdown item is not');
  const before = posts();

  const old = await reveal(CASES.markdown('md-old'));
  assert.equal(old.label, 'Show on page');
  assert.ok(mdEl('md-old').classList.contains('md-flash'), 'md-old flashes on the preview');

  const liveOnly = await reveal(CASES.markdown('md-x'));
  assert.equal(liveOnly.label, 'Not on the page now');

  // the x19 driver's other three kinds, previewing: none of their panes is drawn
  for (const make of [CASES.render, CASES.renderAssigned, CASES.useComponent]) {
    assert.equal((await reveal(make())).label, 'Not on the page now');
  }
  // and the previewed node's own pane still flashes through revealPane
  const pane = await reveal(call('render', { id: 'x19-old', html: '<p/>' }, '{"ok":true,"id":"x19-old"}'));
  assert.equal(pane.label, 'Show on page');
  assert.ok(paneEl('x19-old').classList.contains('pane-flash'));

  assert.equal(posts(), before, 'no click sent a POST on the read-only preview');
  assert.equal(state.view.previewing, true, 'and the preview is still up');
});

test('app.css flashes a markdown item with the pane flash\'s own keyframes, and a still outline under reduced motion', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/app.css'), 'utf8');
  assert.match(css, /\.md-block\.md-flash \{ animation: pane-flash 1\.2s ease-out; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.md-block\.md-flash \{ animation: none; outline: 2px solid var\(--wc-accent\); \} \}/);
  assert.equal((css.match(/@keyframes pane-flash\b/g) || []).length, 1, 'one @keyframes, reused');
});
