'use strict';
// Two wave-5 residuals in the 2A chrome (annotation engine 2A.1; U302c,
// DECISIONS.md K.2-51 and K.2-52). The real chrome (test-support/chrome-shell,
// booted once, main.js's input-mode policy installed); the daemon's own
// projection (lib/server/domain/element-projection leanElements) builds the
// rows the hello carries.
//
// Pinned here:
//   - K.2-52: a projected row carries its record's schema (a reference row the
//     log version's, a comment row comment@1), the overlay keeps it (normRow),
//     and U324's reads gate (public/app/element-types.js) parks, through the
//     real overlay, a row whose schema the type's listed `reads` excludes —
//     state 'parked', its schema named, the type's draw never handed it —
//     while a row of a read schema draws;
//   - K.2-51: a gesture that is up but never got its click (a browser that
//     sends no click when the down and up targets differ) no longer takes its
//     pointer's hover moves: a pointermove {buttons: 0} after the pointerup is
//     not default-prevented and the pane hears it; the entry still takes its
//     own click when that comes.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { leanElements } = require('../lib/server/domain/element-projection');
const { setRefs } = require('../lib/server/domain/element-refs');

let shell, W, M, ov, IM, ET, anchors;
let listing = { ok: true, types: [], reserved: ['comment', 'highlight', 'box-grab'] };

const PANE = (id) => ({
  id, target: 'main', params: {},
  html: `<p class="lead">lead of ${id}</p><button class="go">Go</button><script>
    root.querySelector('.go').addEventListener('click', function () { window.__goClicks.push(mountId); });
  </script>`,
});
const MOUNTS = [PANE('p1'), PANE('p2')];

before(async () => {
  shell = await bootShell({ routes: { '/api/elements/types': () => listing } });
  W = shell.window;
  M = W.__wcMount;
  W.__goClicks = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  ET = await shell.importApp('element-types.js');
  anchors = (await shell.importApp('anchors.js')).default;
  await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS }));
  await shell.tick();
});
after(async () => {
  if (ov) ov.setArmed(null);
  if (W) W.localStorage.removeItem('wc:finger-draws');
  if (shell) await shell.restore();
});

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const goBtn = (id) => rootOf(id).querySelector('button.go');

function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
// What the page heard inside a pane: the shadow root's own listeners, which an
// event the overlay swallows on the well never reaches.
function pageLog(id) {
  const log = [];
  const root = rootOf(id);
  const fns = ['pointermove', 'click'].map((t) => {
    const fn = (e) => log.push(`${t}:${e.pointerType || ''}:${e.pointerId}`);
    root.addEventListener(t, fn);
    return [t, fn];
  });
  Object.defineProperty(log, 'off', { value: () => { for (const [t, fn] of fns) root.removeEventListener(t, fn); } });
  return log;
}

// ── K.2-51 ──────────────────────────────────────────────────────────────────
// First: the schema case below hands the overlay a fake raf.
test('an up entry whose click never came: its hover move passes through to the pane, and the entry still takes its own click', () => {
  IM.setFingerDraws('off');
  const created = [];
  const off = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  const log = pageLog('p1');
  try {
    ov.setArmed('opt');
    W.__goClicks = [];
    // Down on p1's text, up on p2's: a browser that sends no click when the
    // targets differ leaves the entry up with no click.
    pe(lead('p1'), 'pointerdown', 'mouse', 7);
    pe(lead('p2'), 'pointerup', 'mouse', 7);
    log.length = 0;
    const mv = pe(goBtn('p1'), 'pointermove', 'mouse', 7, { buttons: 0 });
    assert.equal(mv.defaultPrevented, false, 'the hover is not swallowed');
    assert.deepEqual(log, ['pointermove:mouse:7'], 'the pane heard it');
    const mv2 = pe(lead('p1'), 'pointermove', 'mouse', 7, { buttons: 0, clientX: 120 });
    assert.equal(mv2.defaultPrevented, false, 'nor the next one');
    assert.deepEqual(log, ['pointermove:mouse:7', 'pointermove:mouse:7']);
    assert.deepEqual(created, [], 'no tool input from a hover');
    // The entry stayed: its own click (detail 1, as a pointer makes) is the tool's.
    lead('p1').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    assert.deepEqual(created, ['click:mouse'], 'the up entry took its click');
    assert.deepEqual(W.__goClicks, [], 'the page did not');
  } finally {
    log.off();
    ov.setArmed(null);
    off();
  }
});

// ── K.2-52 ──────────────────────────────────────────────────────────────────
const queue = [];
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  return n;
}
const rectOf = () => ({ left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 });
const typeRow = (type, schema, reads) => ({
  type, schema, reads, anchors: ['element'], family: 'page', remote: { see: 'read', send: 'full' },
  private: false, builtin: false, tier: 'local', pack: 'notes-pack', toolbar: {},
});

test('a projected row carries its record\'s schema: the reads gate parks one the type does not read through the real overlay, and draws one it does', async () => {
  ov.initOverlay({ rectOf, raf: fakeRaf });
  ET.initElementTypes({ overlay: ov });
  listing = { ok: true, types: [typeRow('sticky', 'sticky@2', ['sticky@2'])], reserved: ['comment', 'highlight', 'box-grab'] };
  assert.equal((await ET.loadTypes()).ok, true);
  const drawn = [];
  const offType = ET.registerElementType('sticky', {
    draw: (g) => { for (const it of g.items) drawn.push(`${it.id}:${it.row && it.row.schema}`); g.container.textContent = 'sticky'; },
  });
  try {
    // The daemon's projection over a log that holds one version of each
    // schema, both anchored on p1's lead.
    const anchor = anchors.record(rootOf('p1'), lead('p1'), { mount: 'p1' });
    const versions = {
      's1@1': { schema: 'sticky@1', payload: { anchor, shared: true } },
      's2@1': { schema: 'sticky@2', payload: { anchor, shared: true } },
    };
    const elements = {
      version: (id, v) => versions[`${id}@${v}`] || null,
      log: { element: () => ({ kind: 'sticky' }) },
    };
    const state = { comments: [{ id: 'c1', v: 1, shared: true, anchor: null, replies: [] }] };
    setRefs(state, ['s1@1', 's2@1']);
    const rows = leanElements(state, elements);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.type, r.schema]),
      [['c1', 'comment', 'comment@1'], ['s1', 'sticky', 'sticky@1'], ['s2', 'sticky', 'sticky@2']],
      'each row names its record\'s schema');
    // Through the hello, as the daemon sends them.
    await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS, elements: rows, surface: 1 }));
    await shell.tick();
    assert.deepStrictEqual(ov.elementsOf('live').filter((r) => r.type === 'sticky').map((r) => [r.id, r.schema]),
      [['s1', 'sticky@1'], ['s2', 'sticky@2']], 'the overlay kept each row\'s schema');
    await waitUntil(() => { flush(); return drawn.includes('s2:sticky@2'); }, { what: 's2 drawn by its type' });
    flush();
    assert.ok(!drawn.some((d) => d.startsWith('s1:')), 'the type\'s draw was never handed s1');
    const st = Object.fromEntries(ET.drawStates().map((s) => [s.id, s]));
    assert.equal(st.s1 && st.s1.state, 'parked', 's1 (sticky@1, not read) is parked');
    assert.equal(st.s1.schema, 'sticky@1', 'parked under its record\'s schema');
    assert.equal(st.s2, undefined, 's2 (sticky@2, read) drew: no state');
  } finally {
    offType();
    ov.setElements('live', []);
    flush();
  }
});
