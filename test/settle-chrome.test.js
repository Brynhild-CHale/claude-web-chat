// The settle sync point in the LIVE chrome (annotation engine 1C.3): the real
// public/index.html and public/app module graph (test-support/chrome-shell),
// one hello with every pane this file needs.
//
// Pinned here:
//   - mountPane settles each pane ONCE, with why 'mount', after the last step
//     that changes its DOM: after the restored form_state's input event and,
//     for a mode pane (params.modes), after the wc:mode re-assert;
//   - the remote paths settle too: a pane:form (why 'form') once the DOM shows
//     the new values; a pane:state that changes the mode (why 'mode') once the
//     pane shows it, and none when the mode is unchanged; the pane's own toggle
//     (wc:mode-request) settles with why 'mode';
//   - the pane-theme <style> the chrome puts in every pane root is marked
//     data-wc-chrome="theme";
//   - itemEl finds every pane (its .mount-host, even for a pane whose id names
//     chrome — contents-nav) and every markdown block, and agrees with the
//     chrome's own hostFor (public/app/state.js) on every pane.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { wrapModes } = require('../lib/capture/pane');

// A pane script that logs its form input events and the wc:mode events it hears
// into the shared log, beside settle's own calls.
const LOGGING = (body) => `${body}<input id="q" value="baked"><script>
  var log = window.__settleLog;
  root.querySelector('#q').addEventListener('input', function () { log.push('input:' + mountId + ':' + root.querySelector('#q').value); });
  root.addEventListener('wc:mode', function (e) { log.push('mode:' + mountId + ':' + (e.detail && e.detail.mode)); });
</script>`;

const MOUNTS = [
  { id: 'p1', html: '<p>one</p>', target: 'main', params: {} },
  { id: 'contents-nav', html: '<p>a pane named like the chrome\'s nav</p>', target: 'main', params: {} },
  // a mode pane with a restored draft: settle after the input AND the re-assert
  { id: 'pm', html: LOGGING('<p>mode pane</p>'), target: 'main', params: { modes: true },
    pane_state: { mode: 'expanded' }, form_state: { '#q:0': { value: 'typed' } } },
  // no params.modes: settle after the input
  { id: 'pp', html: LOGGING('<p>plain pane</p>'), target: 'main', params: {},
    form_state: { '#q:0': { value: 'typed' } } },
  // a capture pane (lib/capture/pane.js wrapModes): its own toggle
  { id: 'pc', html: wrapModes('<p data-wc-when="reduced">short</p><p data-wc-when="expanded">long</p>', 'reduced'),
    target: 'main', params: { modes: true }, pane_state: { mode: 'reduced' } },
];
const PANE_IDS = MOUNTS.map((m) => m.id);

let shell, W, log, M, realSettle, hostFor;

before(async () => {
  shell = await bootShell();
  W = shell.window;
  log = [];
  W.__settleLog = log;
  M = W.__wcMount;
  realSettle = M.settle;
  // The spy goes on the object every call site reads at call time
  // (window.__wcMount.settle), before the hello.
  M.settle = function (root, id, why) {
    const q = root && root.querySelector && root.querySelector('#q');
    const box = root && root.querySelector && root.querySelector('.wc-pane-modes');
    log.push(`settle:${id}:${why}` + (q ? `:${q.value}` : '') + (box ? `:${box.getAttribute('data-mode')}` : ''));
    return realSettle.apply(this, arguments);
  };
  ({ hostFor } = await shell.importApp('state.js'));
  await shell.frame(helloFrame({
    mounts: MOUNTS,
    markdown: [{ id: 'md-1', text: '# Settle' }],
    order: ['md-1', ...PANE_IDS],
  }));
});

after(async () => {
  if (M) M.settle = realSettle;
  await shell.restore();
});

const entries = (id) => log.filter((l) => l.split(':')[1] === id);
const rootOf = (id) => M.itemEl(shell.document, id).el.shadowRoot;

test('mount: a mode pane settles once, after its form input and the wc:mode re-assert', () => {
  assert.deepEqual(entries('pm'), ['input:pm:typed', 'mode:pm:expanded', 'settle:pm:mount:typed'],
    'exactly one settle, why mount, after the list holds the input and the mode');
});

test('mount: a pane without params.modes settles once, after its form input', () => {
  assert.deepEqual(entries('pp'), ['input:pp:typed', 'settle:pp:mount:typed']);
});

test('mount: every pane settles once', () => {
  for (const id of PANE_IDS) {
    assert.equal(log.filter((l) => l.startsWith(`settle:${id}:`)).length, 1, `${id}: one settle`);
    assert.equal(M.generation(rootOf(id)), 1, `${id}: generation 1`);
  }
});

test('itemEl: every pane and markdown item is found; contents-nav is the pane, never the chrome nav', () => {
  for (const id of PANE_IDS) {
    const hit = M.itemEl(shell.document, id);
    assert.ok(hit && hit.kind === 'pane', `${id} → a pane`);
    assert.ok(hit.el.classList.contains('mount-host'));
    assert.ok(hit.el.shadowRoot, `${id}'s host holds the pane`);
  }
  const md = M.itemEl(shell.document, 'md-1');
  assert.ok(md && md.kind === 'md', 'the markdown item → its block');
  assert.equal(md.el.getAttribute('data-md-id'), 'md-1');
  const nav = shell.$('contents-nav');
  assert.ok(nav, 'the chrome has its own #contents-nav');
  assert.ok(!nav.classList.contains('mount-host'), 'a lookup by id finds the chrome');
  assert.notEqual(M.itemEl(shell.document, 'contents-nav').el, nav, 'itemEl finds the pane, never the chrome nav');
  assert.equal(M.itemEl(shell.document, 'no-such-item'), null);
});

test('itemEl agrees with the chrome\'s hostFor on every pane', () => {
  for (const id of PANE_IDS) assert.equal(M.itemEl(shell.document, id).el, hostFor(id), id);
});

test('chrome marker: the pane-theme <style> in each pane root is data-wc-chrome="theme"', () => {
  for (const id of PANE_IDS) {
    const marked = rootOf(id).querySelectorAll('style[data-wc-chrome="theme"]');
    assert.equal(marked.length, 1, `${id}: one chrome-marked theme style`);
  }
});

test('remote pane:form → one settle (form), after the DOM shows the new values', async () => {
  log.length = 0;
  await shell.frame({ type: 'pane:form', id: 'pp', form_state: { '#q:0': { value: 'remote' } } });
  assert.deepEqual(entries('pp'), ['input:pp:remote', 'settle:pp:form:remote']);
  assert.equal(rootOf('pp').querySelector('#q').value, 'remote');
});

test('remote pane:state with a changed mode → one settle (mode), after the pane shows it', async () => {
  log.length = 0;
  await shell.frame({ type: 'pane:state', id: 'pc', pane_state: { mode: 'expanded' } });
  assert.deepEqual(log, ['settle:pc:mode:expanded']);
  log.length = 0;
  await shell.frame({ type: 'pane:state', id: 'pm', pane_state: { mode: 'reduced' } });
  assert.deepEqual(entries('pm'), ['mode:pm:reduced', 'settle:pm:mode:typed']);
});

test('remote pane:state with the mode unchanged → no settle', async () => {
  log.length = 0;
  await shell.frame({ type: 'pane:state', id: 'pc', pane_state: { mode: 'expanded', colSpan: 6 } });
  await shell.frame({ type: 'pane:state', id: 'pp', pane_state: { colSpan: 6 } });
  assert.deepEqual(log.filter((l) => l.startsWith('settle:')), []);
});

test('the pane\'s own toggle (wc:mode-request) → one settle (mode), after the pane flipped', async () => {
  log.length = 0;
  const root = rootOf('pc');
  shell.click(root.querySelector('.wc-mode-toggle'));
  await shell.tick();
  assert.equal(root.querySelector('.wc-pane-modes').getAttribute('data-mode'), 'reduced');
  assert.deepEqual(log, ['settle:pc:mode:reduced']);
  await shell.tick(120);   // emitPaneState's 80 ms debounce
  const sent = shell.socket().frames('pane:state').filter((f) => f.id === 'pc').at(-1);
  assert.equal(sent && sent.pane_state.mode, 'reduced', 'and the toggle still reaches the daemon');
});
