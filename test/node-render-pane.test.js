// The `node-render` builtin's pane script, driven under jsdom the way the mount
// runtime drives it in the browser (attachAndExtract + runScripts, so the code
// under test is the shipped component.html byte-for-byte).
//
// What it pins: the node preview the pane frames is drawn in the VIEWER's
// light/dark, as the graph inspector's preview and the glance are
// (public/app/graph-view.js previewSrc). Without `?mode=` the daemon draws its
// own default, light, so a dark surface framed a white node.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const mount = require('../public/mount-runtime.js');

const PANE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'components', 'node-render', 'component.html'),
  'utf8',
);

const GRAPH = { active: 'n1', nodes: [{ id: 'n1', created_at: 1 }, { id: 'n2', created_at: 2 }] };

// Mount the real component.html into a jsdom page whose <html> carries the
// chrome's mode attribute (public/app/theme.js setModeAttr: data-theme="light",
// or none for dark). The pane body runs through `new Function`, so its free
// variables resolve against the NODE globals — hence the swap-and-restore.
function mountPane(t, { theme }) {
  const html = theme ? `<!doctype html><html data-theme="${theme}"><body></body></html>` : '<!doctype html><body></body>';
  const dom = new JSDOM(html, { url: 'http://localhost:5173/' });
  const keys = ['window', 'document', 'location', 'fetch', 'MutationObserver'];
  const saved = Object.fromEntries(keys.map((k) => [k, global[k]]));
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.MutationObserver = dom.window.MutationObserver;
  const opened = [];
  dom.window.open = (u) => { opened.push(String(u)); return null; };
  global.fetch = async (u) => {
    const url = String(u);
    if (url === '/api/graph') return { ok: true, json: async () => GRAPH };
    const m = url.match(/^\/api\/graph\/node\/(.+)$/);
    if (m) return { ok: true, json: async () => ({ id: decodeURIComponent(m[1]), author: 'claude' }) };
    return { ok: false, json: async () => ({}) };
  };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete global[k]; else global[k] = v;
    }
    dom.window.close();
  });

  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const { root, scripts } = mount.attachAndExtract(host, PANE);
  const errors = [];
  mount.runScripts(root, scripts, mount.createStore({}), { node_id: 'n1' }, 'nr1', (e) => errors.push(e));
  assert.deepEqual(errors.map((e) => e.message), [], 'the pane script must not throw at mount');
  return { dom, host, root, opened };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const src = (root) => root.getElementById('frame').getAttribute('src');
const modeOf = (u) => new URL(u, 'http://x').searchParams.get('mode');

test('node-render frames the node in the viewer\'s mode: light', async (t) => {
  const { root } = mountPane(t, { theme: 'light' });
  await settle();
  assert.match(src(root), /^\/preview\/node\/n1\?mode=light&t=\d+$/);
});

test('node-render frames the node in the viewer\'s mode: dark (no data-theme on <html>)', async (t) => {
  const { root } = mountPane(t, { theme: null });
  await settle();
  assert.equal(modeOf(src(root)), 'dark');
  assert.match(src(root), /^\/preview\/node\/n1\?/);
});

test('node-render redraws when ◑ flips the mode, and ↗ opens the node in it', async (t) => {
  const { dom, root, opened } = mountPane(t, { theme: 'light' });
  await settle();
  assert.equal(modeOf(src(root)), 'light');

  delete dom.window.document.documentElement.dataset.theme; // the chrome going dark
  await settle();
  assert.equal(modeOf(src(root)), 'dark', 'the frame follows the flip');
  assert.match(src(root), /^\/preview\/node\/n1\?/, 'the same node');

  root.getElementById('btn-open').click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], '/preview/node/n1?mode=dark', 'open-in-a-tab uses the mode too');

  dom.window.document.documentElement.dataset.theme = 'light';
  await settle();
  assert.equal(modeOf(src(root)), 'light', 'and back');
});

test('node-render stops watching the mode once its pane is gone', async (t) => {
  const { dom, host, root } = mountPane(t, { theme: 'light' });
  await settle();
  const before = src(root);
  host.remove();
  delete dom.window.document.documentElement.dataset.theme;
  await settle();
  assert.equal(src(root), before, 'a removed pane does not redraw');
});
