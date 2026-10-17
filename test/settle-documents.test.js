// The documents that draw a node — the preview (lib/server/preview.js), a
// replay frame (the same template, filled by lib/server/replay/document.js) and
// an export (lib/server/export.js) — draw the mode the user toggled, and settle
// each pane once its DOM is final (annotation engine 1C.3).
//
// A capture pane's html bakes the mode it was rendered in (lib/capture/pane.js
// wrapModes); the user's toggle moves pane_state.mode. The live chrome
// re-asserts that mode on every mount (public/app/mounts.js mountPane); the
// documents did not, so a preview, a replay and an export drew the baked mode
// (R1 §4.2). Pinned here:
//   - pane_state.mode 'expanded' over html baked 'reduced' draws data-mode
//     "expanded" (and the toggle pressed) in all three; no pane_state.mode keeps
//     the baked mode;
//   - window.__wcMount.settle is called once per pane, AFTER the re-assert —
//     seen through a getter trap on window.__wcMount installed before the
//     document's scripts run, as F3's settle harness traps it;
//   - the export's per-pane css <style> carries data-wc-chrome="theme"; a
//     preview root has no chrome style at all;
//   - no element ids: every id in a rendered preview or export is a pane's, or
//     one the document had before its scripts ran, and the set is the same with
//     settle stubbed to a no-op.
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { wrapModes } = require('../lib/capture/pane');
const { renderPreviewHtml } = require('../lib/server/preview');
const { assembleExport } = require('../lib/server/export');
const { assembleReplay, normalizeReplayOpts } = require('../lib/server/replay/document');

const INNER = '<p data-wc-when="reduced">short</p><div data-wc-when="expanded"><p>the long view</p></div>';
const capturePane = (id, paneState) => ({
  id, html: wrapModes(INNER, 'reduced'), target: 'main', params: { modes: true },
  ...(paneState ? { pane_state: paneState } : {}),
});
const MOUNTS = [
  capturePane('cap-toggled', { mode: 'expanded' }),
  capturePane('cap-baked', null),
  { id: 'plain', html: '<p id="inner-id">plain</p>', target: 'main', params: {} },
];

// Run `html` in jsdom with a trap on window.__wcMount: when the runtime assigns
// it, settle is wrapped (or, with `noop`, replaced) so each call records the
// pane's mode as the DOM shows it at that moment.
function run(html, { noop = false } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      let M;
      Object.defineProperty(w, '__wcMount', {
        configurable: true,
        get() { return M; },
        set(v) {
          const real = v.settle;
          v.settle = function (root, id, why) {
            const box = root && root.querySelector && root.querySelector('.wc-pane-modes');
            calls.push({ id, why, mode: box ? box.getAttribute('data-mode') : null });
            return noop ? 0 : real.apply(this, arguments);
          };
          M = v;
        },
      });
    },
  });
  return { dom, doc: dom.window.document, calls };
}

// A pane's shadow root, found by the document's own runtime.
const rootOf = (doc, id) => doc.defaultView.__wcMount.itemEl(doc, id).el.shadowRoot;

function assertModes(doc, calls, where) {
  const toggled = rootOf(doc, 'cap-toggled');
  assert.equal(toggled.querySelector('.wc-pane-modes').getAttribute('data-mode'), 'expanded',
    `${where}: the toggled mode is drawn, not the baked one`);
  assert.equal(toggled.querySelector('.wc-mode-toggle').getAttribute('aria-pressed'), 'true', `${where}: the toggle reads pressed`);
  const baked = rootOf(doc, 'cap-baked');
  assert.equal(baked.querySelector('.wc-pane-modes').getAttribute('data-mode'), 'reduced',
    `${where}: with no pane_state.mode the baked mode stays`);
  assert.equal(baked.querySelector('.wc-mode-toggle').getAttribute('aria-pressed'), 'false');

  assert.deepEqual(calls, [
    { id: 'cap-toggled', why: 'mount', mode: 'expanded' },
    { id: 'cap-baked', why: 'mount', mode: 'reduced' },
    { id: 'plain', why: 'mount', mode: null },
  ], `${where}: one settle per pane, in page order, after the mode re-assert`);
  for (const m of MOUNTS) {
    assert.equal(doc.defaultView.__wcMount.generation(rootOf(doc, m.id)), 1, `${where}: ${m.id} settled once`);
  }
}

test('preview: draws pane_state.mode over the baked mode, then settles', () => {
  const { dom, doc, calls } = run(renderPreviewHtml({ id: 'n1', mounts: MOUNTS, store: {} }, {}));
  assertModes(doc, calls, 'preview');
  for (const m of MOUNTS) {
    assert.equal(rootOf(doc, m.id).querySelectorAll('[data-wc-chrome]').length, 0, 'a preview root holds no chrome style');
  }
  dom.window.close();
});

test('replay frame: the preview template, filled as the player fills it, draws the toggled mode and settles', () => {
  const step = {
    id: 'n1', label: 'n1.0', author: 'claude', kind: 'turn', prompt: 'p', summary: 's', reply: null,
    folded_count: 0, created_at: 1000, dt_from_prev: null, theme: 0,
    node: { id: 'n1', mounts: MOUNTS, store: {} },
  };
  const html = assembleReplay({ steps: [step], themes: [{}], opts: normalizeReplayOpts({}) });
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  const [a, b, c] = payload.frame;
  const s = payload.steps[0];
  const { dom, doc, calls } = run(a + payload.themes[s.theme] + b + s.node + c);
  assertModes(doc, calls, 'replay frame');
  dom.window.close();
});

test('export: draws pane_state.mode over the baked mode, then settles; its css style is chrome-marked', () => {
  const mounts = MOUNTS.map((m) => (m.id === 'plain' ? { ...m, css: 'p { color: red; }' } : m));
  const { dom, doc, calls } = run(assembleExport({ mounts }));
  assertModes(doc, calls, 'export');
  const styles = [...rootOf(doc, 'plain').querySelectorAll('style')];
  assert.equal(styles.length, 1);
  assert.equal(styles[0].getAttribute('data-wc-chrome'), 'theme', 'the export\'s pane css is the chrome\'s, marked');
  assert.equal(rootOf(doc, 'cap-toggled').querySelectorAll('[data-wc-chrome]').length, 0, 'a pane without css gets none');
  dom.window.close();
});

// ── no element ids ───────────────────────────────────────────────────────────

// Every id in the document and in each pane root.
function idsOf(doc) {
  const out = [...doc.querySelectorAll('[id]')].map((e) => `doc:${e.id}`);
  for (const h of doc.querySelectorAll('.mount-host')) {
    if (h.shadowRoot) for (const e of h.shadowRoot.querySelectorAll('[id]')) out.push(`${h.id}:${e.id}`);
  }
  return out.sort();
}

for (const [name, html] of [
  ['preview', () => renderPreviewHtml({ id: 'n1', mounts: MOUNTS, markdown: [{ id: 'md-1', text: '# T' }], order: ['md-1', 'cap-toggled', 'cap-baked', 'plain'], store: {} }, {})],
  ['export', () => assembleExport({ mounts: MOUNTS, markdown: [{ id: 'md-1', text: '# T' }], order: ['md-1', 'cap-toggled', 'cap-baked', 'plain'] })],
]) {
  test(`${name}: creates no element ids — only the panes' and the document's own`, () => {
    const src = html();
    const unscripted = new JSDOM(src);
    const before = new Set([...unscripted.window.document.querySelectorAll('[id]')].map((e) => e.id));
    unscripted.window.close();
    const real = run(src);
    const stub = run(src, { noop: true });
    const ids = idsOf(real.doc);
    assert.deepEqual(ids, idsOf(stub.doc), 'the same ids with settle stubbed to a no-op');
    const paneIds = new Set(MOUNTS.map((m) => m.id));
    for (const k of ids) {
      const [where, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      if (where === 'doc') assert.ok(paneIds.has(id) || before.has(id), `${name}: #${id} is a pane's or the document's own`);
      else assert.equal(`${where}:${id}`, 'plain:inner-id', `${name}: a pane root holds only the pane's own ids`);
    }
    real.dom.window.close();
    stub.dom.window.close();
  });
}
