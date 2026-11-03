// The chrome's half of the C4 counter (annotation engine 4D.1; DECISIONS.md
// C4): after a LIVE mount applies a stored form_state, public/app/mounts.js
// sends the runtime's tally on the existing pane:form frame — counts only, no
// form_state, no key names, no values — and never while previewing, never from
// applyRemoteFormState (another tab's snapshot of the same html). The daemon's
// half is test/form-shift-counter.test.js.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];
// The stored keys were captured before an <input> was inserted above #a:
// '#first:0' is kept, '#a:1' is now at index 2 (shifted), ':2' is gone (missing).
const HTML = '<input id="first"><input id="inserted"><input id="a"><input>';
const STORED = { '#first:0': { value: 'one' }, '#a:1': { value: 'secret-typed' }, ':2': { value: 'base-less' } };
const OLD_NODE = {
  id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2, store: {},
  mounts: [{ id: 'm-old', html: HTML, target: 'main', params: {}, pane_state: {}, form_state: STORED }],
};

let shell;
const forms = () => shell.socket().frames('pane:form');

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: NODES, active: 'n1' },
      '/api/graph/node/n2': OLD_NODE,
    },
  });
  await shell.frame(helloFrame({
    mounts: [
      { id: 'm-form', html: HTML, target: 'main', params: {}, pane_state: {}, form_state: STORED },
      { id: 'm-plain', html: '<p>no fields, no form_state</p>', target: 'main', params: {}, pane_state: {} },
    ],
  }));
});

after(() => shell.restore());

test('a hello whose stored form_state no longer matches its html → one counts-only pane:form frame', () => {
  const sent = forms();
  assert.equal(sent.length, 1, `one pane:form frame: ${JSON.stringify(sent)}`);
  assert.deepEqual(sent[0], { type: 'pane:form', id: 'm-form', shifts: { kept: 1, shifted: 1, missing: 1 } },
    'counts only: no form_state, no key name, no value');
  assert.ok(!JSON.stringify(sent[0]).includes('secret-typed') && !JSON.stringify(sent[0]).includes('#a'));
});

test('applyRemoteFormState (a pane:form frame from the daemon) sends no counts frame', async () => {
  shell.socket().sent.length = 0;
  await shell.frame({ type: 'pane:form', id: 'm-form', form_state: STORED });
  assert.deepEqual(forms(), [], 'another tab\'s snapshot of the same html is never counted');
});

test('while previewing an older node nothing is sent, though its panes apply a drifted form_state', async () => {
  const { previewNode } = await shell.importApp('topbar.js');
  const { view } = await shell.importApp('state.js');
  shell.socket().sent.length = 0;
  await previewNode('n2');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(view.previewing, true, 'precondition: the preview is up');
  const host = [...shell.document.querySelectorAll('#main .mount-host')].find((h) => (h.dataset.mountId || h.id) === 'm-old');
  assert.ok(host, 'precondition: the previewed node\'s pane is mounted');
  assert.equal(host.shadowRoot.getElementById('first').value, 'one', 'precondition: its form_state was applied');
  assert.deepEqual(forms(), [], 'a preview sends no counts frame');
});
