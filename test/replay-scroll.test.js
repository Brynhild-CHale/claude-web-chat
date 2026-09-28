// Replay SCROLL — each step's frame smooth-scrolls to what changed.
//
// What must hold:
//   - the change diff (lib/server/diff changeTargets) lists what a step ADDED,
//     then what it CHANGED, each in page order — panes and markdown alike — and
//     nothing for a step that changed nothing (a drag, a minimized pane and a
//     store write are not things to look at);
//   - stepFocus (lib/server/replay/document) chains them: the first step is
//     compared with its node's parent, a no-change step comes in where the last
//     change was, and a script step's `scroll` ('none' | an item id) overrides;
//   - the timeline math is pure: n targets → n moves at fixed times, the first
//     dwell the longest; scrollPlan puts the first target's top at the window's
//     top and brings targets below the fold up later, never scrolling back;
//   - seek(t) SETS the frame's scrollTop to the timeline's value at t —
//     deterministically, whatever was drawn before (stubbed geometry);
//   - the renderer samples every move at fps even in `cut` mode;
//   - a script's `scroll` is validated and pinned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { changeTargets } = require('../lib/server/diff');
const { stepFocus, assembleReplay, normalizeReplayOpts } = require('../lib/server/replay/document');
const { normalizeReplayScript } = require('../lib/server/domain/replay-path');
const { frameSchedule } = require('../lib/server/replay/render');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const player = require('../lib/server/replay/player');

const pane = (id, html, extra = {}) => ({ id, html, params: {}, component: null, pane_state: {}, form_state: {}, ...extra });
const md = (id, text) => ({ id, text });

// ── the change diff ─────────────────────────────────────────────────────────

test('changeTargets: added first, then changed, each in page order; panes and markdown alike', () => {
  const a = { mounts: [pane('p1', '<p>1</p>'), pane('p2', '<p>2</p>'), pane('p3', '<p>3</p>')], markdown: [md('h', '# Title')], order: ['h', 'p1', 'p2', 'p3'] };
  const b = {
    mounts: [pane('p1', '<p>1</p>'), pane('p2', '<p>2!</p>'), pane('p3', '<p>3</p>', { form_state: { '#x:0': 'typed' } }), pane('new1', '<p>n</p>'), pane('new0', '<p>n</p>')],
    markdown: [md('h', '# Title, renamed'), md('cap', 'a caption')],
    order: ['h', 'new0', 'p1', 'p2', 'cap', 'p3', 'new1'],
  };
  assert.deepEqual(changeTargets(a, b), ['new0', 'cap', 'new1', 'h', 'p2', 'p3'],
    'added (new0, cap, new1) in page order, then changed (h text, p2 html, p3 form_state) in page order');
});

test('changeTargets: nothing to look at when nothing a viewer sees changed', () => {
  const a = { mounts: [pane('p1', '<p>1</p>')], store: { k: 1 } };
  assert.deepEqual(changeTargets(a, a), [], 'an identical node');
  const dragged = { mounts: [pane('p1', '<p>1</p>', { pane_state: { col: 3, colSpan: 6 } })], store: { k: 2 } };
  assert.deepEqual(changeTargets(a, dragged), [], 'a drag/resize and a store write are not targets');
  const min = { mounts: [pane('p1', '<p>1</p>'), pane('p2', '<p>2</p>', { pane_state: { minimized: true } })] };
  assert.deepEqual(changeTargets(a, min), [], 'a minimized pane is not on the page to look at');
  assert.deepEqual(changeTargets(null, { mounts: [pane('p1', 'x')] }), ['p1'], 'against nothing, everything is added');
  assert.deepEqual(changeTargets({ mounts: [pane('p1', 'x')] }, {}), [], 'a removal leaves nothing to look at');
});

// ── stepFocus over a graph ──────────────────────────────────────────────────

//   n0 [a] → n1 [a, b] → n2 = → n3 [a, b'] (+ md 'm')
function fixture() {
  let clock = 1000;
  const node = (id, parent_id, extra) => ({ id, parent_id, created_at: (clock += 1000), author: 'claude', trigger: { kind: 'turn', message: id }, mounts: [], store: {}, ...extra });
  const list = [
    node('n0', null, { mounts: [pane('a', 'A')] }),
    node('n1', 'n0', { mounts: [pane('a', 'A'), pane('b', 'B')] }),
    node('n2', 'n1', { mounts: [pane('a', 'A'), pane('b', 'B')], store: { k: 1 } }),
    node('n3', 'n2', { mounts: [pane('a', 'A'), pane('b', 'B2')], markdown: [md('m', 'hi')], order: ['a', 'm', 'b'] }),
  ];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-scroll-')));
  const graph = createGraph({ paths: { GRAPH_DIR: tmp, META_PATH: path.join(tmp, '_meta.json') }, state: createState() });
  for (const n of list) graph.registerNode(n);
  graph.active = 'n3';
  return graph;
}

test('stepFocus: the first step against its parent; a no-change step enters where the last change was', () => {
  const G = fixture();
  const steps = ['n1', 'n2', 'n3'].map((id) => ({ id }));
  assert.deepEqual(stepFocus(G, steps), [
    { targets: ['b'], enter: [] },               // n1 vs its parent n0: b was added
    { targets: [], enter: ['b'] },               // n2 changed nothing on the page: stay on b
    { targets: ['m', 'b'], enter: ['b'] },       // n3: the markdown added, then b changed
  ]);
  const root = stepFocus(G, [{ id: 'n0' }]);
  assert.deepEqual(root, [{ targets: ['a'], enter: [] }], 'a root step: everything on it is new');
  assert.deepEqual(stepFocus(G, [{ id: 'n1' }, { id: 'n2' }].slice(1)), [null], 'nothing changed and nothing before: no focus at all');
});

test('stepFocus: a script step\'s scroll overrides — an item id, or none (which keeps the entry)', () => {
  const G = fixture();
  const f = stepFocus(G, [{ id: 'n1' }, { id: 'n3', scroll: 'a' }, { id: 'n3', scroll: 'none' }]);
  assert.deepEqual(f[1], { targets: ['a'], enter: ['b'] });
  assert.deepEqual(f[2], { targets: [], enter: ['a'] }, "'none' does not move, and comes in on the last target");
  const many = { mounts: Array.from({ length: 9 }, (_, i) => pane(`p${i}`, 'x')) };
  const G2 = fixture();
  G2.registerNode({ id: 'big', parent_id: 'n3', created_at: 99999, author: 'claude', trigger: {}, store: {}, ...many });
  assert.equal(stepFocus(G2, [{ id: 'big' }])[0].targets.length, player.MAX_FOCUS, 'capped');
});

// ── the pure timeline math ──────────────────────────────────────────────────

test('focusMoves: n targets → n moves after the fade; the first dwell is the longest; all inside the hold', () => {
  assert.deepEqual(player.focusMoves(3000, 0, 0), []);
  const one = player.focusMoves(3000, 0, 1);
  assert.deepEqual(one, [{ at: 0, dur: player.MOVE_MS }]);
  const faded = player.focusMoves(3000, 400, 1);
  assert.equal(faded[0].at, 400, 'the scroll starts once the fade-in is done');
  const three = player.focusMoves(4000, 0, 3);
  const dwell = (k) => (k + 1 < three.length ? three[k + 1].at : 4000) - (three[k].at + three[k].dur);
  assert.ok(dwell(0) > dwell(1) && Math.abs(dwell(1) - dwell(2)) < 1e-9, `first dwell longest (${[0, 1, 2].map(dwell)})`);
  assert.ok(Math.abs(dwell(0) - 2 * dwell(1)) < 1e-9, 'twice the others');
  const short = player.focusMoves(600, 0, 3);
  assert.ok(short.reduce((a, m) => a + m.dur, 0) <= 300, 'a short hold: moves take at most half of it');
  const tl = player.timeline([{ focus: { targets: ['a', 'b'] } }, {}], { hold_ms: 2000 });
  assert.equal(tl.spans[0].moves.length, 2, 'the timeline carries each step\'s moves');
  assert.deepEqual(tl.spans[1].moves, [], 'a step with no targets has none');
});

test('scrollPlan: the first target\'s top at the top; targets below the fold come up later; never back up', () => {
  const M = player.FOCUS_MARGIN;
  const geo = (targets, enter = []) => ({ winH: 600, docH: 3000, targets, enter });
  // first at 1000; one below the fold (1700–1900); one already in view (1100–1300); one ABOVE the first.
  const p = player.scrollPlan(geo([{ top: 1000, height: 200 }, { top: 1700, height: 200 }, { top: 1100, height: 200 }, { top: 100, height: 50 }]), 4);
  assert.equal(p.start, 0, 'no entry: from the top');
  assert.deepEqual(p.stops, [1000 - M, 1000 - M, 1900 + M - 600, 1900 + M - 600],
    'first → top; the in-view one does not move; the one below is brought fully into view; the one above is not revisited');
  // A target taller than the window: its top goes to the top instead.
  const tall = player.scrollPlan(geo([{ top: 0, height: 100 }, { top: 800, height: 900 }]), 2);
  assert.deepEqual(tall.stops, [0, 800 - M]);
  // Clamped to the page: nothing scrolls past the bottom.
  const end = player.scrollPlan(geo([{ top: 2900, height: 100 }]), 1);
  assert.deepEqual(end.stops, [2400]);
  // Entry: the step before's targets replayed on this geometry.
  const entered = player.scrollPlan(geo([], [{ top: 1500, height: 100 }]), 0);
  assert.deepEqual(entered, { start: 1500 - M, stops: [] });
  // A target not on the page holds its slot still.
  assert.deepEqual(player.scrollPlan(geo([null, { top: 900, height: 10 }]), 2).stops, [900 - M, 900 - M]);
});

test('scrollAt: holds before a move, eases through it (easeInOutCubic), holds after', () => {
  const moves = [{ at: 100, dur: 600 }, { at: 1500, dur: 400 }];
  const plan = { start: 50, stops: [650, 1050] };
  assert.equal(player.scrollAt(moves, plan, 0), 50);
  assert.equal(player.scrollAt(moves, plan, 100), 50);
  assert.equal(player.scrollAt(moves, plan, 400), 350, 'halfway through the move, halfway there');
  assert.equal(player.scrollAt(moves, plan, 250), 50 + 600 * player.easeInOutCubic(0.25), 'eased, not linear');
  assert.ok(player.scrollAt(moves, plan, 250) < 200);
  assert.equal(player.scrollAt(moves, plan, 1000), 650);
  assert.equal(player.scrollAt(moves, plan, 1700), 850);
  assert.equal(player.scrollAt(moves, plan, 5000), 1050);
});

// ── seek(t) sets scrollTop: the whole document in a DOM, stubbed geometry ───

function stubbedDoc(steps, opts) {
  const html = assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts(opts) });
  const frames = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.__wcReplayFrameFactory = (s, i) => {
        // Each step's page: 3000 px tall, the window 800 (chrome on: no caption over it).
        const where = { a: { top: 100, height: 300 }, b: { top: 1500, height: 200 }, c: { top: 2200, height: 300 } };
        const h = {
          i, y: 0, ready: Promise.resolve(), show() {}, destroy() {},
          measure: (focus) => ({
            winH: 800, docH: 3000,
            targets: (focus.targets || []).map((id) => where[id] || null),
            enter: (focus.enter || []).map((id) => where[id] || null),
          }),
          scrollTo(y) { h.y = y; },
        };
        frames.push(h);
        return h;
      };
    },
  });
  const live = (i) => frames.filter((f) => f.i === i).pop();
  return { dom, api: dom.window.__wcReplay, live };
}

const pstep = (i, focus) => ({
  id: `n${i}`, label: `n1.${i}`, author: 'claude', created_at: 1000 * i, dt_from_prev: i ? 1000 : null, theme: 0,
  node: { id: `n${i}`, mounts: [], store: {} }, ...(focus ? { focus } : {}),
});

test('seek(t) sets the frame\'s scrollTop to the timeline\'s value at t — from anywhere', async () => {
  const M = player.FOCUS_MARGIN;
  const steps = [
    pstep(0, { targets: ['b', 'c'], enter: [] }),     // b to the top, then c (below the fold) up
    pstep(1, { targets: [], enter: ['b', 'c'] }),      // no change: stays where step 0 ended
  ];
  const { dom, api, live } = stubbedDoc(steps, { hold_ms: 3000 });
  const tl = player.timeline(steps, { hold_ms: 3000 });
  const [m0, m1] = tl.spans[0].moves;
  const bTop = 1500 - M;
  const cFit = 2200 + 300 + M - 800;

  // The first seek builds the frame: it is scrolled once it has loaded.
  await api.seek(m0.at + m0.dur / 2);
  assert.equal(live(0).y, bTop / 2, 'mid-move: eased halfway');
  await api.seek(0);
  assert.equal(live(0).y, 0, 'the step comes in at the top (nothing before it)');
  await api.seek(m0.at + m0.dur + 10);
  assert.equal(live(0).y, bTop, 'the newest target\'s top at the top of the window');
  await api.seek(m1.at + m1.dur);
  assert.equal(live(0).y, cFit, 'then down to the target below the fold, fully in view');
  assert.equal(api.state().scroll, cFit, 'state() reports it');

  await api.seek(3500);
  assert.equal(live(1).y, cFit, 'a no-change step enters where the last change left off — no jump');

  // Deterministic: back to a mid-move time from the end draws the same offset.
  await api.seek(m0.at + m0.dur / 2);
  assert.equal(live(0).y, bTop / 2);
  dom.window.close();
});

test('play() scrolls the frame as the clock runs — the player overlay uses the same timeline', async () => {
  const steps = [pstep(0, { targets: ['b'], enter: [] })];
  const { dom, api, live } = stubbedDoc(steps, { hold_ms: 3000 });
  await api.seek(0);
  api.play();
  await new Promise((r) => setTimeout(r, 900));
  api.pause();
  assert.ok(live(0).y > 0, `the frame moved while playing (${live(0).y})`);
  dom.window.close();
});

// ── the renderer samples moves ──────────────────────────────────────────────

test('frameSchedule: a cut step\'s scroll moves are sampled at fps; the still parts are one frame each', () => {
  const tl = player.timeline([{ focus: { targets: ['a', 'b'] } }, {}], { hold_ms: 3000, transition: 'cut' });
  const [m0, m1] = tl.spans[0].moves;
  const s = frameSchedule(tl, { fps: 10 });
  const n0 = Math.round(m0.dur * 10 / 1000);
  const n1 = Math.round(m1.dur * 10 / 1000);
  // move 0 (n0 samples) · dwell (1) · move 1 (n1 samples) · dwell (1) · step 2 (1)
  assert.equal(s.length, n0 + 1 + n1 + 1 + 1);
  assert.equal(s[0].t, 0);
  assert.ok(s.some((f) => f.t > m1.at && f.t < m1.at + m1.dur), 'frames DURING the second move');
  assert.equal(s[s.length - 1].t, 3000, 'the still step is one frame');
  const sum = s.reduce((a, f) => a + f.delay, 0);
  assert.ok(Math.abs(sum - tl.total) < 1e-6, `delays sum to the timeline (${sum})`);
});

// ── scripts: the `scroll` field ─────────────────────────────────────────────

test('script scroll: auto | none | an item on the step\'s page — validated, carried, pinned', () => {
  const G = fixture();
  const r = normalizeReplayScript(G, { from: 'n1.1', to: 'n1.3', steps: [{ node: 'n1.1', scroll: 'auto' }, { node: 'n1.3', scroll: 'm' }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps.map((s) => s.scroll), [null, 'm']);
  assert.deepEqual(r.script.steps, [{ node: 'n1' }, { node: 'n3', scroll: 'm' }], "'auto' is the default and is not pinned");
  const none = normalizeReplayScript(G, { from: 'n1.1', to: 'n1.3', steps: [{ node: 'n1.3', scroll: 'none' }] });
  assert.equal(none.steps[0].scroll, 'none');

  const off = normalizeReplayScript(G, { from: 'n1.1', to: 'n1.3', steps: [{ node: 'n1.1', scroll: 'm' }] });
  assert.equal(off.ok, false);
  assert.equal(off.code, 'bad-script');
  assert.equal(off.step, 1);
  assert.match(off.error, /'m'.*not a pane or markdown item on n1\.1's page/);
  for (const bad of [3, '', true]) {
    const b = normalizeReplayScript(G, { from: 'n1.1', to: 'n1.3', steps: [{ node: 'n1.3', scroll: bad }] });
    assert.equal(b.code, 'bad-script', `scroll: ${JSON.stringify(bad)}`);
  }
});

test('the payload carries each step\'s focus as item ids only', () => {
  const html = assembleReplay({
    steps: [pstep(0, { targets: ['b'], enter: [] }), pstep(1, null), pstep(2, { targets: [], enter: [] })],
    themes: [{}], opts: normalizeReplayOpts({}),
  });
  const payload = JSON.parse(/<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(payload.steps.map((s) => s.focus || null), [{ targets: ['b'], enter: [] }, null, null]);
});
