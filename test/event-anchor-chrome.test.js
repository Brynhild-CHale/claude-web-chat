// The chrome's half of the event-time anchor (annotation engine PLAN.md 4D.1;
// DECISIONS.md C4): public/app/mounts.js takes the clicked element's anchor in
// the CAPTURE phase on the pane's root (public/app/event-anchor.js over the
// served anchors module) and reportEvent sends it on the 'event' frame — the
// record anchors.record gives over the same shadow root, even when the pane's
// own handler rewrites the DOM before the report. Never while previewing, and
// never for the synthetic input/change a form rehydrate dispatches. The
// engine and the daemon's half are test/event-anchor.test.js.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];
const LIST = '<section class="card"><h3>Tasks</h3><ul class="rows">'
  + '<li class="row"><b>first</b><button class="go" id="b1">Run</button></li>'
  + '<li class="row"><b>second</b><button class="go" id="b2">Run</button></li>'
  + '</ul></section>';
const FORM = '<form><label>Name <input id="nm" name="nm"></label><button id="sb">Send</button></form>';
const OLD_NODE = {
  id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2, store: {},
  mounts: [{ id: 'm-old', html: LIST, target: 'main', params: {}, pane_state: {} }],
};

let shell;
let anchors;
const events = () => shell.socket().frames('event');
const wire = (o) => JSON.parse(JSON.stringify(o));
const rootOf = (id) => {
  const host = [...shell.document.querySelectorAll('#main .mount-host')].find((h) => (h.dataset.mountId || h.id) === id);
  assert.ok(host && host.shadowRoot, `the pane ${id} is mounted`);
  return host.shadowRoot;
};

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: NODES, active: 'n1' },
      '/api/graph/node/n2': OLD_NODE,
    },
  });
  anchors = (await shell.importApp('anchors.js')).default;
  await shell.frame(helloFrame({
    mounts: [
      { id: 'm-list', html: LIST, target: 'main', params: {}, pane_state: {} },
      { id: 'm-redraw', html: LIST, target: 'main', params: {}, pane_state: {} },
      { id: 'm-form', html: FORM, target: 'main', params: {}, pane_state: {} },
    ],
  }));
});

after(() => shell.restore());

test('a click on a pane button sends an event frame whose anchor is anchors.record over the same shadow root', () => {
  shell.socket().sent.length = 0;
  const root = rootOf('m-list');
  const btn = root.getElementById('b2');
  btn.dispatchEvent(new (shell.window.PointerEvent || shell.window.MouseEvent)('pointerdown', { bubbles: true, composed: true }));
  btn.click();
  const sent = events();
  assert.equal(sent.length, 1, JSON.stringify(sent));
  const { payload } = sent[0];
  assert.deepStrictEqual([payload.type, payload.mountId, payload.id], ['click', 'm-list', 'b2']);
  assert.ok(payload.anchor, 'the frame carries an anchor');
  assert.deepStrictEqual(payload.anchor, wire(anchors.record(root, btn, { mount: 'm-list' })));
});

test('a pane whose own click handler rewrites its DOM still sends the clicked element\'s anchor', () => {
  shell.socket().sent.length = 0;
  const root = rootOf('m-redraw');
  const btn = root.getElementById('b1');
  const expected = wire(anchors.record(root, btn, { mount: 'm-redraw' }));
  // the pane's own handler (bubble phase, below the root): the list redraws
  root.querySelector('section.card').addEventListener('click', () => {
    root.querySelector('ul.rows').innerHTML = '<li class="row"><b>other</b><button class="go">Run</button></li>';
  });
  btn.click();
  assert.ok(!btn.isConnected, 'precondition: the clicked button left the pane');
  const sent = events();
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.deepStrictEqual(sent[0].payload.anchor, expected, 'the anchor was taken before the redraw');
});

test('a change on an input carries its anchor', () => {
  shell.socket().sent.length = 0;
  const root = rootOf('m-form');
  const input = root.getElementById('nm');
  input.value = 'typed';
  input.dispatchEvent(new shell.window.Event('change', { bubbles: true }));
  const sent = events();
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].payload.type, 'change');
  assert.deepStrictEqual(sent[0].payload.anchor, wire(anchors.record(root, input, { mount: 'm-form' })));
});

test('the input/change events a form rehydrate dispatches send no event frame', async () => {
  shell.socket().sent.length = 0;
  await shell.frame({ type: 'pane:form', id: 'm-form', form_state: { '#nm:0': { value: 'from another tab' } } });
  assert.equal(rootOf('m-form').getElementById('nm').value, 'from another tab', 'precondition: the rehydrate applied');
  assert.deepStrictEqual(events(), [], 'no event frame for a synthetic rehydrate');
});

test('while previewing an older node nothing is sent', async () => {
  const { previewNode } = await shell.importApp('topbar.js');
  const { view } = await shell.importApp('state.js');
  await previewNode('n2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(view.previewing, true, 'precondition: the preview is up');
  shell.socket().sent.length = 0;
  const btn = rootOf('m-old').getElementById('b1');
  btn.dispatchEvent(new (shell.window.PointerEvent || shell.window.MouseEvent)('pointerdown', { bubbles: true, composed: true }));
  btn.click();
  assert.deepStrictEqual(events(), [], 'a preview sends no event frame');
});
