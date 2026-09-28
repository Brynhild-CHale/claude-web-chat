// Replay SCRIPTS — Claude's directed replay: two moments (from / to) and,
// optionally, grouped, timed, captioned beats between them.
//
// What must hold:
//   - validation (domain/replay-path normalizeReplayScript) refuses, by name
//     and step, a node off the from → to path, steps out of path order or
//     naming a node twice, a group with a gap in it (a no-change node the graph
//     hides may sit inside a group unnamed), and a malformed script; holds,
//     captions and titles are clamped, not refused;
//   - a script with no steps IS the plain replay, and the pinned script it
//     hands back normalises to the same answer again;
//   - the replay document, the player and the GIF renderer all play the
//     normalised script: per-step holds and transitions set the timeline and
//     the frames, a group shows its last node and its caption lists the group;
//   - the export MCP tool passes the script through, and `open: true` opens
//     the player in the browser (a `replay:open` WS frame) without writing a
//     file — refused to a browser request.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const { withServer, fakeBin, wsConnect, waitUntil } = require('../test-support/helpers');
const { decodeGif } = require('../test-support/gif-decode');
const { PREVIEW_CSP } = require('../lib/core/cors');
const { projectPaths } = require('../lib/core/paths');
const client = require('../lib/client');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const {
  normalizeReplayScript, resolveReplayPath, MAX_STEPS, HOLD_MIN, HOLD_MAX, CAPTION_MAX, TITLE_MAX,
} = require('../lib/server/domain/replay-path');
const { assembleReplay, normalizeReplayOpts } = require('../lib/server/replay/document');
const { createScriptStore } = require('../lib/server/replay/scripts');
const { frameSchedule } = require('../lib/server/replay/render');
const player = require('../lib/server/replay/player');

// ── the fixture: one lineage with hidden no-change nodes, and a fork ─────────
//   n0 [] → n1 [A] → n2 = → n3 = → n4 [A,B] → n5 [A,B]+k → n6 = → n7 [A]
//   n8 [B] forks off n1 (not on n7's lineage). `=` is a no-change node the
//   graph viewer hides (labels n1.0 … n1.7 follow the ids).
const PANE_A = { id: 'a', html: '<p>A</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };
const PANE_B = { id: 'b', html: '<p>B</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };
let clock = 1000;
function node(id, parent_id, extra = {}) {
  clock += 1000;
  return {
    id, parent_id, created_at: clock, author: 'claude',
    trigger: { kind: 'turn', message: `prompt ${id}`, summary: `sum ${id}`, reply: `reply ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}
function fakeGraph() {
  clock = 1000;
  const list = [
    node('n0', null),
    node('n1', 'n0', { mounts: [PANE_A] }),
    node('n2', 'n1', { mounts: [PANE_A] }),
    node('n3', 'n2', { mounts: [PANE_A] }),
    node('n4', 'n3', { mounts: [PANE_A, PANE_B] }),
    node('n5', 'n4', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
    node('n6', 'n5', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
    node('n7', 'n6', { mounts: [PANE_A], store: { k: 1 } }),
    node('n8', 'n1', { mounts: [PANE_B] }),
  ];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-script-')));
  const graph = createGraph({ paths: { GRAPH_DIR: tmp, META_PATH: path.join(tmp, '_meta.json') }, state: createState() });
  for (const n of list) graph.registerNode(n);
  graph.active = 'n7';
  return graph;
}
const G = fakeGraph();
const norm = (script, o) => normalizeReplayScript(G, script, o);
const ids = (r) => r.steps.map((s) => s.id);

// ── validation / normalisation ──────────────────────────────────────────────

test('script without steps IS the plain replay: the drawn path, each node at the default hold', () => {
  const plain = resolveReplayPath(G, { from: 'n1.0', to: 'n1.7' });
  const r = norm({ from: 'n1.0', to: 'n1.7' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.scripted, false);
  assert.deepEqual(ids(r), ids(plain), 'the same nodes, the hidden ones skipped');
  assert.deepEqual(ids(r), ['n0', 'n1', 'n4', 'n5', 'n7']);
  assert.ok(r.steps.every((s) => s.hold_ms === null && s.caption === null && s.group === null), 'no per-step timing: the replay-wide hold applies');
  assert.deepEqual(r.steps[2].folded.map((f) => f.id), ['n2', 'n3'], 'hidden nodes still fold into the next step');

  const held = norm({ from: 'n1.0', to: 'n1.7', default_hold_ms: 10 });
  assert.ok(held.steps.every((s) => s.hold_ms === HOLD_MIN), 'default_hold_ms is clamped');
  assert.deepEqual(norm({}).to, { id: 'n7', label: 'n1.7' }, 'no from/to: active, as a plain replay');
});

test('steps: single nodes and a group — the group shows its LAST node and lists them all; holds clamp', () => {
  const r = norm({
    from: 'n1.0', to: 'n1.7', title: '  How it   grew  ', default_hold_ms: 1200,
    steps: [
      { node: 'n1.1', hold_ms: 3000, caption: '  the first   pane ' },
      { nodes: ['n1.4', 'n1.5'], hold_ms: 999999, transition: 'fade' },
      { node: 'n7', hold_ms: 1 }, // a stored id works as well as a label
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.scripted, true);
  assert.equal(r.title, 'How it grew');
  assert.deepEqual(ids(r), ['n1', 'n5', 'n7'], 'a group plays as its last node');
  assert.deepEqual(r.steps.map((s) => s.hold_ms), [3000, HOLD_MAX, HOLD_MIN], 'holds are clamped, not refused');
  assert.deepEqual(r.steps.map((s) => s.transition), [null, 'fade', null]);
  assert.equal(r.steps[0].caption, 'the first pane', 'whitespace collapsed');
  assert.deepEqual(r.steps[1].group, [{ id: 'n4', label: 'n1.4' }, { id: 'n5', label: 'n1.5' }]);
  assert.equal(r.steps[0].group, null, 'a single node is not a group');
  assert.equal(r.steps[1].dt_from_prev, G.nodes.get('n5').created_at - G.nodes.get('n1').created_at, 'timed against the previous SHOWN step');
  assert.equal(r.skipped, 8 - 4, 'path nodes the script does not name are not shown');

  const dflt = norm({ from: 'n1.0', to: 'n1.7', default_hold_ms: 1200, steps: [{ node: 'n1.1' }] });
  assert.equal(dflt.steps[0].hold_ms, 1200, 'a step with no hold takes default_hold_ms');
  assert.equal(norm({ steps: [{ node: 'n1.1' }] }).steps[0].hold_ms, null, '…and with neither, the replay-wide hold');
});

test('a group may span nodes the graph hides — but not nodes it draws', () => {
  const spans = norm({ from: 'n1.0', to: 'n1.7', steps: [{ nodes: ['n1.1', 'n1.4'] }] });
  assert.equal(spans.ok, true, 'n1.2 and n1.3 are hidden no-change nodes: the run is contiguous as drawn');

  const raw = norm({ from: 'n1.0', to: 'n1.7', steps: [{ nodes: ['n1.1', 'n1.4'] }] }, { includeCollapsed: true });
  assert.equal(raw.code, 'not-contiguous', 'with every commit drawn, they are a gap');
  assert.match(raw.error, /skips n1\.2, n1\.3/);

  const gap = norm({ from: 'n1.0', to: 'n1.7', steps: [{ node: 'n1.0' }, { nodes: ['n1.4', 'n1.7'] }] });
  assert.equal(gap.code, 'not-contiguous');
  assert.equal(gap.step, 2);
  assert.match(gap.error, /skips n1\.5 between n1\.4 and n1\.7/, 'names the drawn node it skipped, not the hidden n1.6');
});

test('refusals name the step: off the path, out of order, twice, unknown', () => {
  const off = norm({ from: 'n1.0', to: 'n1.7', steps: [{ node: 'n1.1' }, { node: 'n8' }] });
  assert.deepEqual([off.ok, off.code, off.step], [false, 'off-path', 2]);
  assert.match(off.error, /is not on the replay's path n1\.0 → n1\.7/);

  const before = norm({ from: 'n1.4', to: 'n1.7', steps: [{ node: 'n1.1' }] });
  assert.equal(before.code, 'off-path', 'above `from` is off the path too');

  const order = norm({ to: 'n1.7', from: 'n1.0', steps: [{ node: 'n1.5' }, { node: 'n1.4' }] });
  assert.deepEqual([order.code, order.step], ['out-of-order', 2]);
  assert.match(order.error, /n1\.4 comes before n1\.5/);

  const inGroup = norm({ from: 'n1.0', to: 'n1.7', steps: [{ nodes: ['n1.5', 'n1.4'] }] });
  assert.equal(inGroup.code, 'out-of-order', 'order is checked inside a group too');

  const twice = norm({ from: 'n1.0', to: 'n1.7', steps: [{ node: 'n1.4' }, { nodes: ['n1.4', 'n1.5'] }] });
  assert.deepEqual([twice.code, twice.step], ['out-of-order', 2]);
  assert.match(twice.error, /named twice/);

  const missing = norm({ from: 'n1.0', to: 'n1.7', steps: [{ node: 'n9.9' }] });
  assert.deepEqual([missing.code, missing.step], ['not-found', 1]);

  assert.equal(norm({ from: 'n1.1.0', to: 'n1.7', steps: [{ node: 'n1.7' }] }).code, 'not-ancestor', 'from must be an ancestor of to');
  assert.equal(norm({ to: 'live', steps: [{ node: 'n1.1' }] }).code, 'live-not-allowed');
});

test('malformed scripts are refused as bad-script with a message that says how to fix them', () => {
  const cases = [
    [null, /is an object/],
    [[], /is an object/],
    [{ from: 'n1.0', stepz: [] }, /unknown script field 'stepz'/],
    [{ from: 7 }, /'from' is a node label or id/],
    [{ title: 3 }, /'title' is a string/],
    [{ include_prompts: 'yes' }, /'include_prompts' is true or false/],
    [{ default_hold_ms: 'slow' }, /'default_hold_ms' must be a number/],
    [{ steps: 'n1.1' }, /'steps' is a list/],
    [{ steps: [] }, /'steps' is empty — leave it out/],
    [{ steps: ['n1.1'] }, /step 1 is an object/],
    [{ steps: [{ node: 'n1.1', nodes: ['n1.4'] }] }, /exactly one of 'node'.*'nodes'/],
    [{ steps: [{ hold_ms: 100 }] }, /exactly one of 'node'/],
    [{ steps: [{ nodes: [] }] }, /'nodes' is a non-empty list/],
    [{ steps: [{ node: 'n1.1', hold: 100 }] }, /step 1: unknown field 'hold'/],
    [{ steps: [{ node: 'n1.1', hold_ms: '2s' }] }, /step 1: 'hold_ms' must be a number/],
    [{ steps: [{ node: 'n1.1', transition: 'wipe' }] }, /'transition' is 'cut' or 'fade'/],
    [{ steps: [{ node: 'n1.1', caption: 5 }] }, /'caption' is a string/],
    [{ steps: [{ nodes: ['n1.1', 4] }] }, /named by its label or id/],
  ];
  for (const [script, re] of cases) {
    const r = norm(script);
    assert.equal(r.ok, false, JSON.stringify(script));
    assert.equal(r.code, 'bad-script', JSON.stringify(script));
    assert.match(r.error, re, JSON.stringify(script));
  }
  const many = norm({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ node: 'n1.1' })) });
  assert.equal(many.code, 'too-many-steps');
});

test('captions and titles are cut to length, not refused', () => {
  const r = norm({ title: 't'.repeat(500), steps: [{ node: 'n1.1', caption: 'c'.repeat(1000) }, { node: 'n1.4', caption: '   ' }] });
  assert.equal(r.ok, true);
  assert.equal(r.title.length, TITLE_MAX);
  assert.equal(r.steps[0].caption.length, CAPTION_MAX);
  assert.ok(r.steps[0].caption.endsWith('…'), 'the cut is marked');
  assert.equal(r.steps[1].caption, null, 'a blank caption is none');
});

test('the pinned script names every node by id and normalises to the same replay again', () => {
  const r = norm({
    from: 'n1.0', to: 'active', title: 'T', include_prompts: true,
    steps: [{ node: 'n1.1', caption: 'one' }, { nodes: ['n1.4', 'n1.5'], hold_ms: 4000, transition: 'fade' }, { node: 'active' }],
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.script, {
    from: 'n0', to: 'n7', title: 'T', include_prompts: true,
    steps: [{ node: 'n1', caption: 'one' }, { nodes: ['n4', 'n5'], hold_ms: 4000, transition: 'fade' }, { node: 'n7' }],
  });
  const again = norm(r.script);
  assert.deepEqual(again.steps, r.steps);
  assert.deepEqual(again.script, r.script);
  assert.deepEqual(norm({ from: 'n1.0' }).script, { from: 'n0', to: 'n7' }, 'no steps: the ends alone');
});

test('script store: same script, same id; bounded, oldest first', () => {
  const s = createScriptStore({ max: 2 });
  const a = s.put({ from: 'n0', to: 'n7' });
  assert.equal(s.put({ from: 'n0', to: 'n7' }), a, 'content-addressed');
  assert.deepEqual(s.get(a), { from: 'n0', to: 'n7' });
  const b = s.put({ from: 'n1', to: 'n7' });
  s.put({ from: 'n4', to: 'n7' });
  assert.equal(s.get(a), null, 'the oldest went first');
  assert.ok(s.get(b));
  assert.equal(s.size, 2);
  assert.equal(s.get(undefined), null);
});

// ── the player: timeline and captions follow the script ─────────────────────

test('timeline: a step\'s own hold and transition win over the replay-wide ones', () => {
  const tl = player.timeline(
    [{ hold_ms: 1000 }, { hold_ms: 4000, transition: 'fade' }, {}, { transition: 'cut' }],
    { hold_ms: 2000, transition: 'fade', pacing: 'realtime' },
  );
  assert.deepEqual(tl.spans.map((s) => s.dur), [1000, 4000, 2000, 2000], 'an unset hold falls back (the last step to hold_ms under realtime)');
  assert.deepEqual(tl.spans.map((s) => s.fade > 0), [false, true, true, false], 'step transition first, then the replay-wide one');
  assert.equal(tl.total, 9000);
  const sched = frameSchedule(player.timeline([{ hold_ms: 1000 }, { hold_ms: 3000 }, { hold_ms: 500 }], { hold_ms: 2500 }), { fps: 10 });
  assert.deepEqual(sched.map((f) => f.delay), [1000, 3000, 500], 'the render takes one frame per beat, held for the beat');
});

function scriptedSteps() {
  const mk = (i, extra = {}) => ({
    id: `n${i}`, label: `n1.${i}`, author: 'claude', kind: 'turn', prompt: `prompt ${i}`, summary: `sum ${i}`,
    reply: `reply ${i}`, folded_count: 0, created_at: 1000 * i, dt_from_prev: i ? 1000 : null, theme: 0,
    node: { id: `n${i}`, mounts: [{ id: 'p', html: `<p>step ${i}</p>`, params: {} }], store: {} },
    hold_ms: null, transition: null, caption: null, group: null, ...extra,
  });
  return [
    mk(1, { hold_ms: 1000, caption: 'The first pane' }),
    mk(5, { hold_ms: 4000, transition: 'fade', group: [{ id: 'n4', label: 'n1.4' }, { id: 'n5', label: 'n1.5' }] }),
    mk(7, { hold_ms: 500 }),
  ];
}

test('document payload for a script: per-step holds, transitions, group labels, the caption text and the title', () => {
  const html = assembleReplay({ steps: scriptedSteps(), themes: [{}], opts: normalizeReplayOpts({}), meta: { title: 'How it grew' } });
  const doc = new JSDOM(html).window.document;
  const payload = JSON.parse(doc.getElementById('wc-replay-data').textContent);
  assert.equal(doc.title, 'How it grew', 'the script\'s title names the document');
  assert.equal(payload.meta.title, 'How it grew');
  assert.deepEqual(payload.steps.map((s) => s.hold_ms), [1000, 4000, 500]);
  assert.deepEqual(payload.steps.map((s) => s.transition), [undefined, 'fade', undefined]);
  assert.deepEqual(payload.steps[1].group, ['n1.4', 'n1.5'], 'a group carries the labels it stands for');
  assert.equal(payload.steps[0].group, undefined);
  assert.deepEqual(payload.steps[0].caption, { text: 'The first pane' }, 'Claude\'s caption takes the reply\'s place');
  assert.deepEqual(payload.steps[1].caption, { reply: 'reply 5' }, 'no caption: the reply, as ever');
  assert.ok(!/prompt 1|sum 1/.test(html), 'still no prompt text without include_prompts');
  const none = assembleReplay({ steps: scriptedSteps(), themes: [{}], opts: normalizeReplayOpts({ captions: 'none' }) });
  assert.ok(!/The first pane/.test(none), 'captions:none drops the script\'s captions too');
});

test('the document plays a script in a DOM: duration = the beats, a group lists its nodes, the title shows', async () => {
  const html = assembleReplay({ steps: scriptedSteps(), themes: [{}], opts: normalizeReplayOpts({}), meta: { title: 'How it grew' } });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) { win.__wcReplayFrameFactory = () => ({ ready: Promise.resolve(), show() {}, destroy() {} }); },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  const api = w.__wcReplay;
  assert.equal(api.duration(), 5500, '1000 + 4000 + 500');
  assert.equal(api.title, 'How it grew');
  assert.equal($('rp-cap-title').textContent, 'How it grew');
  assert.equal($('rp-cap-title').hidden, false);
  await api.seek(0);
  assert.equal($('rp-cap-note').textContent, 'The first pane');
  assert.equal($('rp-cap-note').hidden, false);
  assert.equal($('rp-cap-reply').hidden, true, 'the caption replaced the reply line');
  await api.seek(api.stepTime(1));
  assert.equal($('rp-cap-label').textContent, 'n1.4 · n1.5', 'the caption lists the group');
  assert.equal($('rp-cap-note').hidden, true);
  assert.equal($('rp-cap-reply').textContent, 'reply 5');
  const ticks = [...w.document.querySelectorAll('.rp-tick')].map((t) => t.style.left);
  assert.deepEqual(ticks, ['0%', `${(1000 / 5500) * 100}%`, `${(5000 / 5500) * 100}%`], 'the scrubber ticks sit at the beats');
  dom.window.close();
});

// ── the daemon: open, the document by script id, the render ─────────────────

async function seed(api) {
  for (const [i, msg] of ['first prompt, maybe private', 'second', 'third', 'fourth'].entries()) {
    await api.post('/api/render', { id: 'm1', html: `<p>v${i}</p>` });
    await api.post('/api/commit', { message: msg });
  }
}
const SCRIPT = {
  from: 'n1.0', to: 'n1.3', title: 'Four versions',
  steps: [
    { node: 'n1.0', hold_ms: 1000, caption: 'Where it started' },
    { nodes: ['n1.1', 'n1.2'], hold_ms: 3000 },
    { node: 'n1.3', hold_ms: 500 },
  ],
};
const payloadOf = (html) => JSON.parse(/<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

function setEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

// A socket that records every frame the daemon broadcasts.
async function listen(t, port) {
  const frames = [];
  const sock = wsConnect(port);
  sock.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  t.after(() => { try { sock.terminate(); } catch {} });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { what: 'hello' });
  return frames;
}

test('POST /api/replay/open: a replay:open frame to every viewer, the document by script id, and no file', async (t) => {
  const { api, port, root } = await withServer(t);
  await seed(api);
  const frames = await listen(t, port);

  const r = await client.request(port, 'POST', '/api/replay/open', { script: SCRIPT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = r.body;
  assert.equal(j.ok, true);
  assert.equal(j.steps, 3);
  assert.equal(j.viewers, 1);
  assert.equal(j.hint, undefined, 'somebody is watching');
  assert.deepEqual(j.from, { id: 'n0', label: 'n1.0' });
  const frame = await waitUntil(() => frames.find((f) => f.type === 'replay:open'), { what: 'the replay:open frame' });
  assert.equal(frame.script_id, j.script_id);
  assert.equal(frame.title, 'Four versions');
  assert.deepEqual(frame.script.steps[1], { nodes: ['n1', 'n2'], hold_ms: 3000 }, 'the frame carries the pinned script (a render sends it back)');
  const ev = (await api.get('/api/events')).json.events.find((e) => e.kind === 'replay');
  assert.deepEqual([ev.op, ev.from, ev.to, ev.steps, ev.scripted], ['open', 'n1.0', 'n1.3', 3, true]);

  const doc = await fetch(`http://127.0.0.1:${port}/replay?script=${j.script_id}&chrome=1`);
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get('content-security-policy'), PREVIEW_CSP);
  const payload = payloadOf(await doc.text());
  assert.deepEqual(payload.steps.map((s) => s.label), ['n1.0', 'n1.2', 'n1.3']);
  assert.deepEqual(payload.steps.map((s) => s.hold_ms), [1000, 3000, 500]);
  assert.deepEqual(payload.steps[1].group, ['n1.1', 'n1.2']);
  assert.deepEqual(payload.steps[0].caption, { text: 'Where it started' });
  assert.equal(payload.meta.title, 'Four versions');

  const dl = await fetch(`http://127.0.0.1:${port}/api/replay/html?script=${j.script_id}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /replay-n1-0_n1-3\.html/);

  const gone = await fetch(`http://127.0.0.1:${port}/replay?script=feedfacefeedfacefeed`);
  assert.equal(gone.status, 404);
  assert.equal(gone.headers.get('content-security-policy'), PREVIEW_CSP, 'its error under the CSP too');
  assert.match(await gone.text(), /no longer held/);
  const gone2 = await fetch(`http://127.0.0.1:${port}/api/replay/html?script=feedfacefeedfacefeed`);
  assert.equal((await gone2.json()).code, 'script-not-found');

  const exportsDir = projectPaths(root).exports;
  assert.ok(!fs.existsSync(exportsDir) || !fs.readdirSync(exportsDir).length, 'opening writes nothing');
});

test('POST /api/replay/open is local MCP/CLI only: a browser or a tunnelled request is refused, and a bad script is named', async (t) => {
  const { api, port } = await withServer(t);
  await seed(api);
  const frames = await listen(t, port);

  const browser = await api.post('/api/replay/open', { script: SCRIPT });
  assert.equal(browser.status, 403, 'fetch sends fetch metadata: a browser (or a pane) cannot pop the player');
  assert.equal(browser.json.code, 'local-only');
  const remote = await client.request(port, 'POST', '/api/replay/open', { script: SCRIPT }, { headers: { 'x-wc-remote': '1' } });
  assert.equal(remote.status, 403);
  const form = await client.request(port, 'POST', '/api/replay/open', 'script=x', { headers: { 'content-type': 'text/plain' } });
  assert.equal(form.status, 415);

  const off = await client.request(port, 'POST', '/api/replay/open', { script: { from: 'n1.2', to: 'n1.3', steps: [{ node: 'n1.0' }] } });
  assert.equal(off.status, 400);
  assert.deepEqual([off.body.code, off.body.step], ['off-path', 1]);
  const missing = await client.request(port, 'POST', '/api/replay/open', { to: 'n9.9' });
  assert.equal(missing.status, 404);

  const plain = await client.request(port, 'POST', '/api/replay/open', { from: 'n1.1', to: 'n1.3' });
  assert.equal(plain.status, 200, 'from/to alone: a plain replay, opened');
  assert.equal(plain.body.steps, 3);
  await waitUntil(() => frames.some((f) => f.type === 'replay:open'), { what: 'the plain open' });
  assert.equal(frames.filter((f) => f.type === 'replay:open').length, 1, 'no frame for any refusal');
});

test('POST /api/replay/open with nobody watching still answers, and says nobody saw it', async (t) => {
  const { api, port } = await withServer(t);
  await seed(api);
  const r = await client.request(port, 'POST', '/api/replay/open', { script: SCRIPT });
  assert.equal(r.status, 200);
  assert.equal(r.body.viewers, 0);
  assert.match(r.body.hint, /claude-web-chat open/);
});

// A fake Chrome (test-support/fake-chrome.js) — the same harness
// test/replay-render.test.js uses; every process it logs is SIGKILLed after.
function fakeChrome(t) {
  let logFile = null;
  const read = () => {
    try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  t.after(() => {
    const log = read();
    for (const pid of log.filter((l) => l.pid).map((l) => l.pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    for (const pid of log.flatMap((l) => [l.pid, l.helper]).filter(Boolean)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  const { bin } = fakeBin(t, {
    name: 'chrome',
    script: path.join(__dirname, '..', 'test-support', 'fake-chrome.js'),
    env: (dir) => ({ FAKE_CHROME_LOG: (logFile = path.join(dir, 'log.jsonl')), FAKE_CHROME_MODE: 'ok' }),
  });
  return { bin, read };
}

test('a scripted GIF: one frame per beat, each delay the beat\'s hold, and Chrome is handed the script by id', async (t) => {
  const fake = fakeChrome(t);
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: '/nonexistent/ffmpeg' });
  const { api, port } = await withServer(t);
  await seed(api);

  const res = await fetch(`http://127.0.0.1:${port}/api/replay/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'gif', width: 320, hold_ms: 2500, script: SCRIPT }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.label, 'n1.0 → n1.3');
  assert.equal(body.duration_ms, 4500, 'the script\'s beats, not 4 × hold_ms');
  const g = decodeGif(fs.readFileSync(body.path));
  // Every beat changed m1, so each opens with a scroll move to it, sampled at
  // 10 fps (500, 700 and 250 ms of motion — a move takes at most half its
  // beat), then one frame holding the rest of the beat.
  const cs = g.frames.map((f) => f.delay);
  assert.equal(g.frames.length, 6 + 8 + 4, 'three beats: their moves sampled, then one held frame each');
  assert.deepEqual([cs[5], cs[13]], [50, 230], 'each beat ends on one long held frame');
  assert.ok(Math.abs(cs.reduce((a, d) => a + d, 0) - 450) <= 2, `the beats' holds, in total (${cs.join(',')})`);

  const log = fake.read();
  const u = new URL(log.find((l) => l.method === 'Page.navigate').params.url);
  assert.equal(u.pathname, '/replay');
  assert.ok(u.searchParams.get('script'), 'the browser loads the script by id');
  assert.equal(u.searchParams.get('from'), null, 'not by from/to');
  const drawn = payloadOf(await (await fetch(u.href)).text());
  assert.deepEqual(drawn.steps.map((s) => s.label), ['n1.0', 'n1.2', 'n1.3'], 'the page the browser drew is the script');
  const seeks = log.filter((l) => l.method === 'Runtime.evaluate' && /seek\(/.test(JSON.stringify(l.params)))
    .map((l) => Number(/seek\(([-\d.e]+)\)/.exec(JSON.stringify(l.params))[1]));
  assert.deepEqual(seeks.filter((ms) => [0, 1000, 4000].includes(ms)), [0, 1000, 4000], 'a frame lands on each beat\'s start');
  assert.ok(seeks.every((ms) => ms < 4500), 'and none past the end');
});

test('a scripted replay .html: the script decides include_prompts unless the request says one; a bad script is refused before any browser', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome' });
  const { api, port } = await withServer(t);
  await seed(api);
  const post = (b) => client.request(port, 'POST', '/api/replay/render', b);

  const off = await post({ format: 'replay', script: SCRIPT });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const html = fs.readFileSync(off.body.path, 'utf8');
  assert.ok(!/maybe private/.test(html), 'no prompts unless asked');
  assert.deepEqual(payloadOf(html).steps[1].group, ['n1.1', 'n1.2']);

  const on = await post({ format: 'replay', script: { ...SCRIPT, include_prompts: true } });
  assert.equal(on.body.include_prompts, true, 'a request that says nothing leaves it to the script');
  assert.match(fs.readFileSync(on.body.path, 'utf8'), /maybe private/);

  const overruled = await post({ format: 'replay', include_prompts: false, script: { ...SCRIPT, include_prompts: true } });
  assert.equal(overruled.body.include_prompts, false, 'an explicit include_prompts on the request (the viewer\'s checkbox) wins over the script\'s');
  assert.ok(!/maybe private/.test(fs.readFileSync(overruled.body.path, 'utf8')));
  const ticked = await post({ format: 'replay', include_prompts: true, script: { ...SCRIPT, include_prompts: false } });
  assert.equal(ticked.body.include_prompts, true, '…both ways');

  const bad = await post({ format: 'gif', script: { ...SCRIPT, steps: [{ node: 'n1.3' }, { node: 'n1.0' }] } });
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.body.code, bad.body.step], ['out-of-order', 2], 'refused by name — no chrome-not-found first');
});

// ── the MCP tool and the CLI ────────────────────────────────────────────────

test('export MCP tool: `script` passes through; with no format it writes the .html player; open:true opens it', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome' });
  const { api, port } = await withServer(t);
  await seed(api);
  setEnv(t, { WEB_CHAT_PORT: String(port) });
  const tool = require('../lib/mcp/tools/export');
  assert.equal(tool.inputSchema.properties.script.type, 'object');
  assert.equal(tool.inputSchema.properties.open.type, 'boolean');
  assert.match(tool.description, /walkthrough/, 'the description says WHEN');
  assert.match(tool.description, /get_graph/, '…and HOW');

  const rep = await tool.handler({ script: SCRIPT });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.format, 'replay', 'a script with no format is the .html player');
  const payload = payloadOf(fs.readFileSync(rep.path, 'utf8'));
  assert.equal(payload.meta.title, 'Four versions');
  assert.deepEqual(payload.steps.map((s) => s.hold_ms), [1000, 3000, 500]);

  const filled = await tool.handler({ script: { steps: [{ node: 'n1.2' }, { node: 'n1.3' }] }, from: 'n1.2', to: 'n1.3' });
  assert.equal(filled.ok, true, 'top-level from/to fill what the script leaves out');
  assert.equal(filled.label, 'n1.2 → n1.3');

  const bad = await tool.handler({ script: { ...SCRIPT, steps: [{ node: 'n1.0' }, { nodes: ['n1.1', 'n1.3'] }] } });
  assert.equal(bad.code, 'not-contiguous', 'a bad script is a result naming what to fix, not a thrown error');
  assert.match(bad.error, /step 2/);
  assert.equal(bad.step, 2, 'the {error, code, step} the description promises: the step, as a field');
  const offPath = await tool.handler({ script: { from: 'n1.0', to: 'n1.2', steps: [{ node: 'n1.0' }, { node: 'n1.3' }] }, format: 'gif' });
  assert.deepEqual([offPath.code, offPath.step], ['off-path', 2], 'a render refusal carries the step too');
  const badEnd = await tool.handler({ format: 'replay', to: 'n9.9' });
  assert.equal(badEnd.which, 'to', 'a bad end is named: which one');
  assert.equal(badEnd.step, undefined, 'no step where no script was refused');

  const html = await tool.handler({ script: SCRIPT, format: 'html' });
  assert.equal(html.code, 'bad-format');

  const opened = await tool.handler({ script: SCRIPT, open: true, format: 'gif' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.opened, true);
  assert.equal(opened.steps, 3);
  assert.equal(opened.viewers, 0);
  assert.match(opened.hint, /claude-web-chat open/, 'nobody watching: say so');
  const events = (await api.get('/api/events')).json.events;
  assert.equal(events.filter((e) => e.kind === 'replay' && e.op === 'open').length, 1, 'the tool reached the open route');
  assert.equal(events.filter((e) => e.kind === 'export' && e.format === 'gif').length, 0, 'and rendered nothing');
});

test('export CLI: --script <file> (any format, .html by default) and --open', () => {
  const { parseExportArgs, readScript } = require('../lib/cli/commands/export');
  assert.deepEqual(parseExportArgs(['--script', 's.json']), { format: 'replay', ref: null, body: { format: 'replay' }, scriptFile: 's.json' });
  assert.deepEqual(parseExportArgs(['--script', 's.json', '--gif', '--width', '640']).body, { format: 'gif', width: 640 });
  assert.match(parseExportArgs(['--script']).error, /needs a file/);
  assert.match(parseExportArgs(['n1.3', '--script', 's.json']).error, /names its own from and to/);
  assert.match(parseExportArgs(['--script', 's.json', '--from', 'n1.0']).error, /names its own from and to/);
  const open = parseExportArgs(['n1.3', '--open', '--from', 'n1.0', '--prompts']);
  assert.deepEqual(open, { format: 'open', ref: 'n1.3', body: { from: 'n1.0', include_prompts: true, to: 'n1.3' }, open: true });
  assert.equal(parseExportArgs(['--open', '--script', 's.json']).scriptFile, 's.json');
  assert.match(parseExportArgs(['--open', '--gif']).error, /writes no file/);
  assert.match(parseExportArgs(['--open', '--hold', '100']).error, /--open takes/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cli-script-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify(SCRIPT));
  assert.deepEqual(readScript(good).script, SCRIPT);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.match(readScript(path.join(dir, 'bad.json')).error, /is not JSON/);
  assert.match(readScript(path.join(dir, 'missing.json')).error, /no such file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('export CLI --script runs end to end against the daemon', async (t) => {
  const { api, port, root } = await withServer(t);
  await seed(api);
  const file = path.join(root, 'walkthrough.json');
  fs.writeFileSync(file, JSON.stringify(SCRIPT));
  // The CLI finds the daemon by the portfile; point it at this test server.
  require('../lib/core/portfiles').writePortfile('server', { root, pid: process.pid, port });
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), 'export', ...args], { cwd: root, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  const r = await run(['--script', file]);
  assert.equal(r.code, 0, r.err);
  const m = /→ (\S+\.html)$/m.exec(r.out);
  assert.ok(m, r.out);
  assert.equal(payloadOf(fs.readFileSync(m[1], 'utf8')).meta.title, 'Four versions');
  const bad = await run(['--script', path.join(root, 'nope.json')]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no such file/);
});
