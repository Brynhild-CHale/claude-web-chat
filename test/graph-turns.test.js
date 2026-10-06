// A node's chat turns in the graph inspector, and the rewind marks on the canvas
// (public/app/graph-turns.js through public/app/graph-view.js's three seams):
// design spec §2.8 "What the chrome shows", §15.4, ruled Q1 (attach).
//
//   * #gi-turns sits after the inspector's .gv-meta: 'CHAT TURNS · N', one row
//     per turn in seq order (role, prompt preview as TEXT, time, duration,
//     tools, files ±, interrupted/stopped and rewound tags), the unavailable
//     stub, the empty line and the rewound summary line.
//   * Below `read`, and for any answer that is not a turn list, nothing is
//     drawn — and below `read` nothing is even requested.
//   * registerInspectorAction: a button after ▶ Replay, run with the selected
//     id and the fetched node; the actions row is 0.8.0's with none.
//   * The ↶ mark: a node glyph, a stack holding a marked node, a sleeve row;
//     refresh at most once per 2 s; a stream change while the graph is open
//     refreshes ONCE, 2 s later; stopGraphTurns clears that timer.
//
// main.js does not start graph-turns yet (U51 wires it): the boot's init does.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const T = Date.UTC(2026, 9, 6, 14, 2, 0);
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// n1 ── n2 ── n3 ── n4 ── n5 (active)        n1+n2: a ×2 stack
//              └── n6                        n3: a fork, so its own glyph
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: T - 60000 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T - 50000 },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: T - 40000 },
  { id: 'n4', label: 'n1.3', parent_id: 'n3', created_at: T - 30000 },
  { id: 'n5', label: 'n1.4', parent_id: 'n4', created_at: T - 20000 },
  { id: 'n6', label: 'n1.2.0', parent_id: 'n3', created_at: T - 10000 },
];

const XSS = '<img src=x onerror="window.__gtPwned=1">';
const head = (over) => ({ conversation_id: 'c1', session_id: 's1', kind: 'prompt', author: 'user', status: 'done',
  counts: { items: 4, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 }, tool_names: [], groups: [], code: null,
  ...over });
// n4: two turns, given out of seq order — the folded one first in seq.
const N4_TURNS = [
  head({ id: 't4', seq: 6, role: 'commit', started_at: T, ended_at: T + 42000, duration_ms: 42000,
    prompt: { preview: XSS, origin: 'terminal' }, counts: { items: 9, tools: 3, tool_errors: 0, agents: 0, tasks: 0, edits: 2 },
    code: { status: 'ready', files: 2, additions: 12, deletions: 4 } }),
  head({ id: 't3', seq: 5, role: 'folded', started_at: T - 120000, duration_ms: 5000, status: 'interrupted', ended_by: 'web',
    prompt: { preview: 'look at the queue rail', origin: 'web' }, counts: { items: 2, tools: 1, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    code: { status: 'pending' } }),
];
// n3: an unavailable stub and two superseded turns.
const N3_TURNS = [
  { id: 't0', conversation_id: 'c1', session_id: 's1', seq: 1, role: 'folded', unavailable: true },
  head({ id: 't1', seq: 2, role: 'folded', superseded: true, started_at: T - 300000, duration_ms: 1000,
    prompt: { preview: 'try the other approach', origin: 'terminal' }, status: 'interrupted', ended_by: 'terminal' }),
  head({ id: 't2', seq: 3, role: 'commit', superseded: true, started_at: T - 200000, duration_ms: 65000,
    prompt: { preview: 'and render it', origin: 'terminal' } }),
];

let shell, gv, gt, S, bus, view, $;
let level = 'local';
let rev = 100;
const answers = {};            // node id → what GET /api/mirror/node/<id> answers
let nodesAnswer = null;        // what GET /api/mirror/nodes answers

const SUMMARIES = {
  n2: { turns: 1, superseded: 1, rewound_at: T },
  n3: { turns: 3, superseded: 2, rewound_at: T },
  n4: { turns: 2, superseded: 0 },
  n5: { turns: 0, superseded: 0 },
};

const snapshot = () => ({ v: 1, enabled: true, now: Date.now(), rev: ++rev, content: level !== 'basic',
  access: { level, remote: false }, capabilities: {}, primary: null, aggregate: { state: 'idle' },
  conversations: [], tasks: [], asks: [] });

async function setLevel(next) {
  level = next;
  const want = rev + 1;
  await shell.frame(helloFrame({ active: 'n5' }));
  await waitUntil(() => S.mirror.rev >= want, { timeout: 2000, what: 'the mirror snapshot' });
  await waitUntil(() => S.mirror.access.level === next, { timeout: 2000, what: `access level ${next}` });
  await shell.tick();
}

const mirrorCalls = (p) => shell.calls.filter((c) => c.url.startsWith(p));
const nodesCalls = () => shell.calls.filter((c) => c.url === '/api/mirror/nodes').length;
const turnsEl = () => $('gi-turns');
const glyph = (id) => shell.document.querySelector(`#graph-svg g.gv-node[data-id="${id}"]`);
const stackGlyph = () => shell.document.querySelector('#graph-svg g.gv-stack');
const markIn = (el) => el && el.querySelector(':scope > .gv-rewound');
const acts = () => [...$('gv-inspector').querySelectorAll('.gv-actions [data-act]')].map((b) => b.dataset.act);

async function select(id) {
  const before_ = mirrorCalls('/api/mirror/node/').length;
  await gv.selectNode(id);
  return before_;
}
async function selectAndSettle(id) {
  const n = await select(id);
  await waitUntil(() => mirrorCalls('/api/mirror/node/').length > n, { timeout: 2000, what: `the turns request for ${id}` });
  await shell.tick(40);
}

before(async () => {
  Object.assign(answers, {
    n4: () => ({ node: { id: 'n4', label: 'n1.3' }, turns: N4_TURNS, rev: 7 }),
    n3: () => ({ node: { id: 'n3', label: 'n1.2' }, turns: N3_TURNS, rev: 7 }),
    n5: () => ({ node: { id: 'n5', label: 'n1.4' }, turns: [], rev: 7 }),
  });
  nodesAnswer = { nodes: SUMMARIES, rev: 7 };
  shell = await bootShell({
    routes: {
      '/api/graph': () => ({ nodes: NODES.map((n) => ({ ...n })), active: 'n5' }),
      '/api/graph/node/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        const n = NODES.find((x) => x.id === id);
        return n ? { ...n, author: 'claude', trigger: { message: `the turn at ${n.label}` }, mounts: [], store: {} }
          : respond({ ok: false, error: 'not found' }, { status: 404 });
      },
      '/api/mirror': () => snapshot(),
      '/api/mirror/node/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        const a = answers[id];
        return typeof a === 'function' ? a() : a;
      },
      '/api/mirror/nodes': () => nodesAnswer,
    },
    init: async (sh) => {
      gt = await sh.importApp('graph-turns.js');
      gt.initGraphTurns();
      gt.initGraphTurns();   // idempotent
    },
  });
  gv = await shell.importApp('graph-view.js');
  S = await shell.importApp('chat-state.js');
  ({ bus } = await shell.importApp('bus.js'));
  ({ view } = await shell.importApp('state.js'));
  $ = shell.$;
  await setLevel('local');
  await gv.openOverlay();
  // the marks arrive with the open: wait for them, so the summary line can show
  await waitUntil(() => markIn(glyph('n3')), { timeout: 2000, what: 'the n1.2 mark' });
});

after(async () => {
  if (gt) gt.stopGraphTurns();
  await shell.restore();
});

/* ── the inspector's turns ────────────────────────────────────────────────── */

test('a node with a commit and a folded turn: #gi-turns after .gv-meta, rows in seq order, previews as text', async () => {
  await selectAndSettle('n4');
  const sec = turnsEl();
  assert.ok(sec, '#gi-turns is drawn');
  assert.equal(sec.tagName, 'SECTION');
  assert.ok(sec.classList.contains('gi-turns'));
  assert.equal(shell.document.querySelectorAll('#gi-turns').length, 1, 'one section');
  assert.equal(sec.previousElementSibling, $('gv-inspector').querySelector('.gv-meta'), 'right after .gv-meta');
  assert.equal(sec.querySelector('.gi-turns-head').textContent, 'CHAT TURNS · 2');
  assert.equal(sec.querySelector('.gi-turns-sum'), null, 'no summary line: nothing superseded');

  const rows = [...sec.querySelectorAll('.gi-turn')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.dataset.role), ['folded', 'commit'], 'seq order: 5 then 6');
  assert.deepEqual(rows.map((r) => r.querySelector('.gi-turn-role').textContent), ['◦', '●'], 'the role marks');

  const [folded, commit] = rows;
  assert.equal(commit.querySelector('.gi-turn-text').textContent, XSS, 'the preview, verbatim, as text');
  assert.equal(sec.querySelector('img'), null, 'an <img onerror> preview renders as text, never as markup');
  assert.equal(shell.window.__gtPwned, undefined);
  assert.equal(commit.querySelector('.gi-turn-meta').textContent, `${hhmm(T)} · 42s · 3 tools · files +12 −4`,
    'time, duration, tool count and files ± (code ready)');

  assert.equal(folded.querySelector('.gi-turn-text').textContent, 'look at the queue rail');
  const fm = folded.querySelector('.gi-turn-meta');
  assert.match(fm.textContent, new RegExp(`^${hhmm(T - 120000)} · 5s · 1 tool`), 'singular tool; no files while pending');
  assert.doesNotMatch(fm.textContent, /files/);
  assert.equal(fm.querySelector('.gi-turn-tag').textContent, 'stopped from this page', 'ended_by web');
  assert.ok(!folded.classList.contains('gi-turn-rewound'));
  for (const r of rows) assert.equal(r.querySelector('button, a'), null, 'rows are not links into the chat (deferred)');
});

test('superseded turns are dimmed and tagged rewound; the unavailable stub; the summary line', async () => {
  await selectAndSettle('n3');
  const sec = turnsEl();
  assert.ok(sec);
  assert.equal(sec.querySelector('.gi-turns-head').textContent, 'CHAT TURNS · 3');
  assert.equal(sec.querySelector('.gi-turns-sum').textContent, `↶ 2 of 3 turns rewound in the terminal at ${hhmm(T)}`);
  const rows = [...sec.querySelectorAll('.gi-turn')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.gi-turn-text').textContent, 'turn no longer in the chat history');
  assert.ok(rows[0].classList.contains('gi-turn-gone'));
  assert.equal(rows[0].querySelector('.gi-turn-meta'), null, 'a stub has nothing else to say');
  for (const r of rows.slice(1)) {
    assert.ok(r.classList.contains('gi-turn-rewound'), 'superseded: dimmed');
    const tags = [...r.querySelectorAll('.gi-turn-tag')].map((t) => t.textContent);
    assert.ok(tags.includes('rewound'), `tagged rewound (${tags})`);
  }
  assert.deepEqual([...rows[1].querySelectorAll('.gi-turn-tag')].map((t) => t.textContent), ['interrupted', 'rewound'],
    'ended_by terminal reads interrupted');
  assert.equal(rows[2].querySelector('.gi-turn-meta').textContent.startsWith(`${hhmm(T - 200000)} · 1m · 0 tools`), true);
});

test('a node with no turns reads the empty line', async () => {
  await selectAndSettle('n5');
  const sec = turnsEl();
  assert.ok(sec);
  assert.equal(sec.querySelector('.gi-turns-head').textContent, 'CHAT TURNS · 0');
  assert.equal(sec.querySelector('.gi-turns-empty').textContent, 'No chat turns rode into this node.');
  assert.equal(sec.querySelector('.gi-turn'), null);
  assert.equal(sec.querySelector('.gi-turns-sum'), null);
});

test('a newer selection made while the first node\'s turns are in flight: only the newer node\'s are painted', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const keep = answers.n3;
  answers.n3 = async () => { await gate; return keep(); };
  try {
    const n = await select('n3');
    await waitUntil(() => mirrorCalls('/api/mirror/node/').length > n, { timeout: 2000, what: 'the n3 request' });
    await selectAndSettle('n4');
    assert.equal(turnsEl().querySelector('.gi-turns-head').textContent, 'CHAT TURNS · 2', 'n4 painted');
    release();
    await shell.tick(60);
    assert.equal(shell.document.querySelectorAll('#gi-turns').length, 1);
    assert.equal(turnsEl().querySelector('.gi-turns-head').textContent, 'CHAT TURNS · 2', 'n3\'s late answer drew nothing');
    assert.equal($('gv-inspector').querySelector('.gv-insp-label').textContent, 'n1.3');
  } finally {
    release();
    answers.n3 = keep;
  }
});

test('a 403, a 404, a 503, a disabled answer and the shell\'s default {ok: true} each draw nothing', async () => {
  const cases = {
    n1: respond({ ok: false, error: 'mirror level' }, { status: 403 }),
    n2: respond({ ok: false, error: 'not found' }, { status: 404 }),
    n6: respond({ ok: false, unavailable: true }, { status: 503 }),
  };
  const keep = { ...answers };
  try {
    for (const [id, a] of Object.entries(cases)) {
      answers[id] = a;
      await selectAndSettle(id);
      assert.ok(!$('gv-inspector').classList.contains('hidden'), `${id}: the inspector shows`);
      assert.equal(turnsEl(), null, `${id}: no #gi-turns`);
    }
    answers.n6 = { ok: false, disabled: true, scope: 'project' };
    await selectAndSettle('n6');
    assert.equal(turnsEl(), null, 'disabled: no #gi-turns');
    delete answers.n6;   // → the shell's default {ok: true}
    await selectAndSettle('n6');
    assert.equal(turnsEl(), null, '{ok: true}: no #gi-turns');
    answers.n6 = { node: { id: 'n6', label: 'n1.2.0' }, turns: 'nope' };
    await selectAndSettle('n6');
    assert.equal(turnsEl(), null, 'a body whose turns is not an array: no #gi-turns');
  } finally {
    for (const k of Object.keys(answers)) delete answers[k];
    Object.assign(answers, keep);
    view.expandedStacks.clear();
  }
});

test('below read: no #gi-turns, no marks, and nothing under /api/mirror/ is requested', async () => {
  gv.closeOverlay();
  await setLevel('basic');
  try {
    const n = shell.calls.length;
    await gv.openOverlay();
    await gv.selectNode('n4');
    await shell.tick(80);
    await gv.refreshGraph();
    await shell.tick(80);
    assert.equal(turnsEl(), null, 'no turns section');
    assert.equal(shell.document.querySelector('.gv-rewound'), null, 'no rewind mark anywhere');
    const asked = shell.calls.slice(n).filter((c) => c.url.startsWith('/api/mirror/node'));
    assert.deepEqual(asked.map((c) => c.url), [], 'neither /api/mirror/node/* nor /api/mirror/nodes');
    assert.ok(shell.calls.slice(n).some((c) => c.url.startsWith('/api/graph/node/')), 'while the inspector itself still loads');
  } finally {
    gv.closeOverlay();
    await setLevel('local');
  }
});

test('every id graph-turns draws is reserved; graph-turns.js names no other', async () => {
  await gv.openOverlay();
  await selectAndSettle('n4');
  const ids = [...turnsEl().querySelectorAll('[id]')].map((e) => e.id).concat(turnsEl().id);
  for (const id of ids) assert.ok(isReservedId(id), `#${id} is in RESERVED_IDS`);
  const src = fs.readFileSync(path.join(REPO, 'public/app/graph-turns.js'), 'utf8');
  const named = [...src.matchAll(/\.id\s*=\s*'([^']+)'|getElementById\('([^']+)'\)|id="([^"]+)"/g)].map((m) => m[1] || m[2] || m[3]);
  assert.deepEqual([...new Set(named)], ['gi-turns']);
  assert.ok(named.every(isReservedId));
});

/* ── registerInspectorAction ──────────────────────────────────────────────── */

const ROW_080 = ['active', 'branch', 'glance', 'bookmark', 'export', 'replay'];

test('with no action registered the actions row is 0.8.0\'s', async () => {
  await selectAndSettle('n4');
  assert.deepEqual(acts(), [...ROW_080]);
  const labels = [...$('gv-inspector').querySelectorAll('.gv-actions .gv-act')].map((b) => b.textContent);
  assert.deepEqual(labels, ['A · Set active here', '⑃ Branch', 'Glance', '⚑ Bookmark', '↧ Export', '▶ Replay']);
});

test('registerInspectorAction: after Replay where applies(), run(selectedId, node) on click, gone when unregistered', async () => {
  const ran = [];
  const off = gv.registerInspectorAction({
    id: 'restore', label: '↶ Restore <files>', title: 'to "before" this turn',
    applies: (node) => !!node && node.id === 'n4',
    run: (id, node) => { ran.push([id, node && node.id, node && node.trigger && node.trigger.message]); },
  });
  try {
    await selectAndSettle('n4');
    assert.deepEqual(acts(), [...ROW_080, 'x:restore'], 'right after ▶ Replay');
    const b = $('gv-inspector').querySelector('[data-act="x:restore"]');
    assert.ok(b.classList.contains('gv-act'));
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.textContent, '↶ Restore <files>', 'the label through esc()');
    assert.equal(b.querySelector('files'), null);
    assert.equal(b.title, 'to "before" this turn', 'the title through esc()');
    shell.click(b);
    assert.deepEqual(ran, [['n4', 'n4', 'the turn at n1.3']], 'run with the selected id and the fetched node');

    await selectAndSettle('n3');
    assert.deepEqual(acts(), [...ROW_080], 'applies() false: nothing added');

    await selectAndSettle('n4');
    assert.ok($('gv-inspector').querySelector('[data-act="x:restore"]'));
    off();
    assert.equal($('gv-inspector').querySelector('[data-act="x:restore"]'), null, 'unregister takes the painted button away');
    await selectAndSettle('n4');
    assert.deepEqual(acts(), [...ROW_080], 'and it is not drawn again');
  } finally { off(); }
});

test('an action whose applies() throws is skipped; a bad registration is refused', async () => {
  const off = gv.registerInspectorAction({ id: 'boom', label: 'Boom', applies: () => { throw new Error('nope'); }, run: () => {} });
  const err = console.error;
  console.error = () => {};
  try {
    await selectAndSettle('n4');
    assert.deepEqual(acts(), [...ROW_080]);
    assert.ok(turnsEl(), 'the panel and the turns still draw');
  } finally { console.error = err; off(); }
  assert.throws(() => gv.registerInspectorAction({ id: 'has space', run: () => {} }), TypeError);
  assert.throws(() => gv.registerInspectorAction({ id: 'norun' }), TypeError);
});

/* ── the rewind marks ─────────────────────────────────────────────────────── */

test('the ↶ mark: n1.2 superseded 2 of 3 carries .gv-rewound with its title; a stack holding a marked node is marked', async () => {
  view.expandedStacks.clear();
  if (!gv.isOverlayOpen()) await gv.openOverlay();
  await shell.tick(2100);   // past the refresh gap: this refreshGraph asks
  const n = nodesCalls();
  await gv.refreshGraph();
  await waitUntil(() => nodesCalls() > n && markIn(glyph('n3')), { timeout: 2000, what: 'the marks' });
  const g3 = glyph('n3');
  const mk = markIn(g3);
  assert.ok(mk, 'n1.2 is marked');
  assert.equal(mk.tagName.toLowerCase(), 'text');
  assert.equal(mk.textContent.startsWith('↶'), true);
  assert.equal(mk.querySelector('title').textContent, `2 of 3 turns rewound in the terminal at ${hhmm(T)}`);
  const body = g3.querySelector('.gv-body');
  assert.ok(Number(mk.getAttribute('x')) < Number(body.getAttribute('cx')), 'to the left of the node');
  assert.equal(mk.getAttribute('text-anchor'), 'end');

  const st = stackGlyph();
  assert.ok(st, 'n1.0 + n1.1 draw as a stack');
  const smk = markIn(st);
  assert.ok(smk, 'the stack holding n1.1 is marked');
  assert.equal(smk.querySelector('title').textContent, `n1.1: 1 of 1 turn rewound in the terminal at ${hhmm(T)}`);

  assert.equal(markIn(glyph('n4')), null, 'superseded 0: no mark');
  assert.equal(markIn(glyph('n5')), null, 'no turn rewound: no mark');
  assert.equal(markIn(glyph('n6')), null, 'no summary: no mark');

  // expanded, the stack's row carries it
  view.expandedStacks.add('n1');
  gv.layoutAndRender();
  const row = shell.document.querySelector('#gv-world .gv-srow[data-id="n2"] .gv-rewound');
  assert.ok(row, 'the sleeve row of n1.1 carries the mark');
  assert.equal(row.title, `1 of 1 turn rewound in the terminal at ${hhmm(T)}`);
  assert.equal(shell.document.querySelector('#gv-world .gv-srow[data-id="n1"] .gv-rewound'), null);
  view.expandedStacks.clear();
  gv.layoutAndRender();
});

test('refresh is at most once per 2 s', async () => {
  const n = nodesCalls();
  await gv.refreshGraph();
  await gv.refreshGraph();
  await shell.tick(60);
  assert.equal(nodesCalls(), n, 'a refresh inside the gap asks nothing');
});

test('a stream change while the graph is open refreshes the marks once, 2 s later, and redraws a changed mark', async () => {
  assert.ok(gv.isOverlayOpen());
  nodesAnswer = { nodes: { ...SUMMARIES, n4: { turns: 2, superseded: 1, rewound_at: T + 60000 } }, rev: 8 };
  const n = nodesCalls();
  bus.emit('mirror', { what: ['stream'] });
  bus.emit('mirror', { what: ['all'] });        // coalesced into the one pending refresh
  bus.emit('mirror', { what: ['tasks'] });      // not a stream change
  await shell.tick(1000);
  assert.equal(nodesCalls(), n, 'nothing before 2 s');
  await waitUntil(() => nodesCalls() > n, { timeout: 4000, what: 'the delayed /api/mirror/nodes' });
  await waitUntil(() => markIn(glyph('n4')), { timeout: 2000, what: 'the redraw with n1.3 marked' });
  assert.equal(markIn(glyph('n4')).querySelector('title').textContent,
    `1 of 2 turns rewound in the terminal at ${hhmm(T + 60000)}`);
  await shell.tick(600);
  assert.equal(nodesCalls(), n + 1, 'exactly one request, never a chain');
});

test('while the graph is closed a stream change asks nothing', async () => {
  gv.closeOverlay();
  const n = nodesCalls();
  bus.emit('mirror', { what: ['stream'] });
  await shell.tick(2500);
  assert.equal(nodesCalls(), n);
});

test('stopGraphTurns clears the pending refresh and takes the marks and the section away; init brings them back', async () => {
  await gv.openOverlay();
  await waitUntil(() => markIn(glyph('n3')), { timeout: 2000, what: 'the marks' });
  await shell.tick(60);
  const n = nodesCalls();
  bus.emit('mirror', { what: ['stream'] });
  gt.stopGraphTurns();
  gt.stopGraphTurns();   // idempotent
  await shell.tick(2500);
  assert.equal(nodesCalls(), n, 'the pending refresh never fired');
  gv.layoutAndRender();
  assert.equal(shell.document.querySelector('.gv-rewound'), null, 'no marker, no marks');
  const k = mirrorCalls('/api/mirror/node/').length;
  await gv.selectNode('n4');
  await shell.tick(60);
  assert.equal(turnsEl(), null, 'no hook, no section');
  assert.equal(mirrorCalls('/api/mirror/node/').length, k, 'and no request');

  gt.initGraphTurns();
  gt.initGraphTurns();
  await selectAndSettle('n4');
  assert.equal(mirrorCalls('/api/mirror/node/').length, k + 1, 'one hook after two inits');
  assert.ok(turnsEl());
  await gv.refreshGraph();
  await waitUntil(() => markIn(glyph('n3')), { timeout: 2000, what: 'the marks back' });
});
