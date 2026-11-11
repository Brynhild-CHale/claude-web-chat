// The ring projection: AUDIT_RULES and projectAudit in lib/core/remote-policy.js
// (contracts folder, 11 C-11.18; C-11.1 (b) and (i); U724).
//
// The connector runs every ring entry and every reconciliation record through
// projectAudit before it sends anything, and the hub imports the same table and
// runs it again. What survives is ids, state words, counts, numbers, booleans
// and the masked, cut label fields: never a store value, html, text, note, url,
// path, distilled or raw_ref.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  AUDIT_RULES, AUDIT_ID_RE, AUDIT_LABEL_MAX, projectAudit,
  RULES, ANSWER_RULES, keyOf,
} = require('../lib/core/remote-policy');
const { homeDir } = require('../lib/core/paths');

const HOME = homeDir(); // the sandbox's throwaway HOME (test-support/sandbox.js)
const OPTS = { home: HOME };
// The text a projection must never carry, planted on every fixture. `value`
// passes the id grammar on purpose: the field itself is never kept.
const PLANT = 'PLANTED';
const TEXT = { html: `<b>${PLANT}</b>`, text: `${PLANT} words`, note: `${PLANT} note`, value: `${PLANT}-value`,
  url: `https://example.test/${PLANT}`, path: `/tmp/${PLANT}.html` };
const BASE = { seq: 41, ts: 1762790400000 };
const deepFrozen = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFrozen(v); }
  return o;
};

// ── every ring kind C-11.18 names has a row, and each row keeps exactly its fields

const SURFACE = { op: 'set', id: 'pane-a', target: 'pane-a', after: 'md-3', anchor: 'pane-b', ids: ['pane-a', 'pane-b'],
  bytes: 512, kept: 2, source: 'claude', component: 'git-dashboard' };

const CASES = {
  render: { in: SURFACE, out: SURFACE },
  clear: { in: SURFACE, out: SURFACE },
  markdown: { in: SURFACE, out: SURFACE },
  page: { in: SURFACE, out: SURFACE },
  pane: { in: { op: 'form', id: 'pane-a', keys: ['#name:3', '@field:0', ':2'], refused: ['col'] },
    out: { op: 'form', id: 'pane-a', keys: ['#name:3', '@field:0', ':2'], refused: ['col'] } },
  store: { in: { patch: { secret_key: 'v', n: 1 }, unset: ['old'], source: 'browser', mount: 'pane-a', gesture: true },
    out: { keys: ['secret_key', 'n'], unset: ['old'], source: 'browser', mount: 'pane-a', gesture: true } },
  queue: { in: { op: 'add', id: 'q-1', msg_id: 'm-7', state: 'queued',
    item: { kind: 'message', id: 'q-1', msg_id: 'm-7', summary: 'the user words', text: 'the user words', chars: 14,
      staged: false, waiting: true, enqueued_at: 1762790400000, mount: 'pane-a', key: 'form_submit', origin: 'remote',
      device: 'mobile', files: ['/tmp/a.png'], skill: { name: 'x', args: 'y' } } },
  out: { op: 'add', id: 'q-1', msg_id: 'm-7', state: 'queued',
    item: { kind: 'message', id: 'q-1', msg_id: 'm-7', chars: 14, staged: false, waiting: true, enqueued_at: 1762790400000,
      mount: 'pane-a', key: 'form_submit', origin: 'remote', device: 'mobile' } } },
  wake: { in: { reason: 'push', source: 'queue', origin: 'remote', device: 'mobile', target_pid: 4242, boot: 'b-1',
    batch: [{ id: 'q-1', summary: 'batch words one' }, { id: 'q-2', summary: 'batch words two' }] },
  out: { reason: 'push', source: 'queue', origin: 'remote', device: 'mobile', batch_count: 2 } },
  comment: { in: { op: 'add', pin: { id: 'c-1', shared: true, text: 'pin words', replies: [{ text: 'reply words' }], anchor: { mount: 'pane-a' } } },
    out: { op: 'add', id: 'c-1', shared: true } },
  element: { in: { type: 'highlight', op: 'add', id: 'h-1', v: 3, shared: false, mount: 'pane-a' },
    out: { type: 'highlight', op: 'add', id: 'h-1', v: 3, shared: false, mount: 'pane-a' } },
  graph: { in: { op: 'commit', id: 'n-abc', base: 'n-xyz', author: 'claude', bookmarked: true, ended: 'stop', ended_by: 'terminal',
    session_id: 'sess-1', prompt_id: 'p-1', name: 'the release page', message: 'prompt words', trigger: { message: 'x' } },
  out: { op: 'commit', id: 'n-abc', base: 'n-xyz', author: 'claude', bookmarked: true, ended: 'stop', ended_by: 'terminal',
    session_id: 'sess-1', prompt_id: 'p-1', name: 'the release page' } },
  capture: { in: { capture_id: 'cap-7', capture_seq: 7, profile: 'github', ref: 'n1.2', format: 'gif', source: 'extension', label: 'A page' },
    out: { capture_id: 'cap-7', capture_seq: 7, profile: 'github', ref: 'n1.2', format: 'gif', source: 'extension', label: 'A page' } },
  export: { in: { capture_id: 'cap-7', profile: 'github', ref: 'n1.2', format: 'gif', source: 'cli', label: 'A page' },
    out: { capture_id: 'cap-7', profile: 'github', ref: 'n1.2', format: 'gif', source: 'cli', label: 'A page' } },
};

test('every ring kind C-11.18 names has a row, and the two reconciliation rows; the table is frozen', () => {
  assert.deepStrictEqual(Object.keys(AUDIT_RULES).sort(), [...Object.keys(CASES), 'capture-record', 'element-record'].sort());
  assert.ok(Object.isFrozen(AUDIT_RULES));
  for (const [name, row] of Object.entries(AUDIT_RULES)) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.keep) && Object.isFrozen(row.labels), `${name}: frozen`);
    for (const k of [...row.keep, ...row.labels]) assert.ok(!['kind', 'seq', 'ts'].includes(k), `${name}: kind/seq/ts are always kept, never a row field`);
    for (const k of ['html', 'text', 'note', 'value', 'url', 'path', 'distilled', 'raw_ref', 'patch', 'batch', 'pin', 'summary']) {
      assert.ok(!row.keep.includes(k) && !row.labels.includes(k), `${name}: never ${k}`);
    }
  }
  assert.equal(AUDIT_ID_RE.source, '^[A-Za-z0-9_.:@#-]{1,128}$');
  assert.equal(AUDIT_LABEL_MAX, 200);
});

test('each ring kind projects exactly its listed fields, with kind, seq and ts, and no planted text', () => {
  for (const [kind, c] of Object.entries(CASES)) {
    const entry = deepFrozen({ kind, ...BASE, ...TEXT, ...c.in });
    const out = projectAudit(entry, OPTS);
    assert.deepStrictEqual(out, { kind, ...BASE, ...c.out }, kind);
    const wire = JSON.stringify(out);
    for (const t of [PLANT, 'words']) assert.ok(!wire.includes(t), `${kind}: no ${t} in ${wire}`);
  }
});

test('store: the patch\'s key names as keys, never a value', () => {
  const out = projectAudit({ kind: 'store', ...BASE, patch: { secret_key: 'v', n: 1 } }, OPTS);
  assert.deepStrictEqual(out, { kind: 'store', ...BASE, keys: ['secret_key', 'n'] });
  assert.ok(!JSON.stringify(out).includes('"v"'));
  assert.ok(!('patch' in out) && !('value' in out));
});

test('wake: batch_count is the batch\'s length; never the note or the batch\'s text', () => {
  const out = projectAudit({ kind: 'wake', ...BASE, reason: 'push', note: 'wake note words',
    batch: [{ id: 'q-1', summary: 'first item words' }, { id: 'q-2', summary: 'second item words' }] }, OPTS);
  assert.equal(out.batch_count, 2);
  assert.ok(!('note' in out) && !('batch' in out));
  assert.ok(!/words/.test(JSON.stringify(out)));
  assert.ok(!('batch_count' in projectAudit({ kind: 'wake', ...BASE, batch: 'not a list' }, OPTS)));
});

test('comment: a delete keeps its own id; the pin\'s id and shared otherwise, never the rest of the pin', () => {
  assert.deepStrictEqual(projectAudit({ kind: 'comment', ...BASE, op: 'delete', id: 'c-9' }, OPTS),
    { kind: 'comment', ...BASE, op: 'delete', id: 'c-9' });
  const out = projectAudit({ kind: 'comment', ...BASE, op: 'reply', id: 'outer', pin: { id: 'c-1', shared: false, text: 'secret' } }, OPTS);
  assert.deepStrictEqual(out, { kind: 'comment', ...BASE, op: 'reply', id: 'c-1', shared: false });
});

// ── the id grammar ─────────────────────────────────────────────────────────

test('the id grammar: form keys and ids kept; a sentence, a 129-character id and a slash dropped; arrays keep their passing elements', () => {
  for (const id of ['#name:3', '@field:0', ':2', 'md-3', 'a'.repeat(128)]) {
    assert.equal(projectAudit({ kind: 'render', ...BASE, id }, OPTS).id, id, `${id} kept`);
  }
  for (const id of ['a sentence with words', 'a'.repeat(129), 'a/b', '', 'x\ny']) {
    assert.ok(!('id' in projectAudit({ kind: 'render', ...BASE, id }, OPTS)), `${JSON.stringify(id).slice(0, 40)} dropped`);
  }
  const out = projectAudit({ kind: 'render', ...BASE,
    ids: ['pane-a', 'two words', 'a/b', 7, true, null, { id: 'x' }, ['nested'], 'pane-b'] }, OPTS);
  assert.deepStrictEqual(out.ids, ['pane-a', 7, true, 'pane-b']);
  assert.deepStrictEqual(projectAudit({ kind: 'pane', ...BASE, keys: ['bad key', '/x'] }, OPTS).keys, []);
  // A value that is no string, number or boolean is dropped; numbers and booleans as they are.
  const odd = projectAudit({ kind: 'render', ...BASE, anchor: { mount: 'pane-a' }, bytes: NaN, kept: 0, target: null }, OPTS);
  assert.deepStrictEqual(odd, { kind: 'render', ...BASE, kept: 0 });
  // The store's key names pass the grammar too.
  assert.deepStrictEqual(projectAudit({ kind: 'store', ...BASE, patch: { ok_key: 1, 'a key with spaces': 2 } }, OPTS).keys, ['ok_key']);
});

test('kind, seq and ts: kind a grammar string, seq and ts numbers; otherwise dropped', () => {
  assert.deepStrictEqual(projectAudit({ kind: 'render', seq: '41', ts: '2026-11-10' }, OPTS), { kind: 'render' });
  assert.deepStrictEqual(projectAudit({ kind: 'two words', seq: 1, ts: 2, id: 'x' }, OPTS), { seq: 1, ts: 2 });
  assert.deepStrictEqual(projectAudit(null, OPTS), {});
  assert.deepStrictEqual(projectAudit(['kind'], OPTS), {});
});

// ── the label fields ───────────────────────────────────────────────────────

test('labels: host paths masked through redactHostPaths (root and home as given), then cut', () => {
  const name = `see ${path.join(HOME, 'projects', 'a')} now`;
  assert.equal(projectAudit({ kind: 'graph', ...BASE, name }, OPTS).name, 'see ~/projects/a now');
  const root = path.join(HOME, 'projects', 'a');
  assert.equal(projectAudit({ kind: 'export', ...BASE, label: `${root}/out.html` }, { home: HOME, root }).label, '<project>/out.html');
  // A label is no id: spaces and slashes survive (masked); a non-string is dropped.
  assert.equal(projectAudit({ kind: 'capture', ...BASE, label: 'A page / its title' }, OPTS).label, 'A page / its title');
  assert.ok(!('label' in projectAudit({ kind: 'capture', ...BASE, label: { x: 1 } }, OPTS)));
});

test('labels: a 300-character label is cut to 200 code units ending in U+2026', () => {
  const out = projectAudit({ kind: 'graph', ...BASE, name: 'x'.repeat(300) }, OPTS).name;
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('…'));
  assert.equal(out, `${'x'.repeat(199)}…`);
  assert.equal(projectAudit({ kind: 'graph', ...BASE, name: 'y'.repeat(200) }, OPTS).name, 'y'.repeat(200), 'exactly 200: not cut');
});

test('labels: a surrogate pair at the cut is never split; the label ends before the pair', () => {
  const pair = '\u{1F600}';
  // The pair's first half is the last unit the cut would keep (the 199th; the
  // 200th is U+2026): the pair is dropped whole.
  const a = projectAudit({ kind: 'graph', ...BASE, name: 'a'.repeat(198) + pair.repeat(20) }, OPTS).name;
  assert.equal(a, `${'a'.repeat(198)}…`);
  // The pair's first half is the label's 200th unit: still dropped whole.
  const b = projectAudit({ kind: 'graph', ...BASE, name: 'b'.repeat(199) + pair.repeat(20) }, OPTS).name;
  assert.equal(b, `${'b'.repeat(199)}…`);
  for (const s of [a, b]) {
    assert.ok(s.length <= 200);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(s) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s), 'no lone surrogate');
  }
  // Whole pairs before the cut are kept.
  const c = projectAudit({ kind: 'graph', ...BASE, name: 'c'.repeat(197) + pair.repeat(20) }, OPTS).name;
  assert.equal(c, `${'c'.repeat(197)}${pair}…`);
});

test('home is required: projectAudit never defaults it to the running process\'s own', () => {
  assert.throws(() => projectAudit({ kind: 'render', ...BASE }), TypeError);
  assert.throws(() => projectAudit({ kind: 'render', ...BASE }, { root: '/x' }), TypeError);
  const name = path.join(HOME, 'p');
  assert.equal(projectAudit({ kind: 'graph', ...BASE, name }, { home: null }).name, name, 'null skips the home mask on purpose');
  assert.throws(() => projectAudit({ kind: 'render', ...BASE }, { home: HOME, record: 'nonsense' }), TypeError);
});

// ── the capture counter (U724-U750@capture-seq-crosses (a)) ────────────────

test('capture: capture_seq kept as a non-negative integer beside the row\'s fields; never url or path', () => {
  const entry = { kind: 'capture', ...BASE, capture_id: 'cap-7', capture_seq: 7, url: 'https://example.test/secret',
    path: path.join(HOME, 'x.html'), profile: 'github', source: 'extension' };
  assert.deepStrictEqual(projectAudit(entry, OPTS),
    { kind: 'capture', ...BASE, capture_id: 'cap-7', profile: 'github', source: 'extension', capture_seq: 7 });
  assert.equal(projectAudit({ ...entry, capture_seq: 0 }, OPTS).capture_seq, 0);
  for (const bad of [-1, 7.5, '7', NaN, Infinity, null, 2 ** 53]) {
    assert.ok(!('capture_seq' in projectAudit({ ...entry, capture_seq: bad }, OPTS)), `${String(bad)} dropped`);
  }
  // Only the capture row carries it.
  assert.ok(!('capture_seq' in projectAudit({ ...entry, kind: 'export' }, OPTS)));
});

// ── the reconciliation records ─────────────────────────────────────────────

test('a capture record keeps seq, ts, source and capture_id only — the reconciled item\'s fields (A-11.5); never url, title, profile, distilled, raw_ref or bytes_raw', () => {
  const rec = deepFrozen({ id: 'cap-3', seq: 3, ts: 1762790400000, url: 'https://example.test/private',
    title: `${HOME}/notes/page`, profile: 'default', distilled: 'the page text', raw_ref: 'captures/cap-3.html',
    bytes_raw: 9001, source: 'extension', extra_field: 'x' });
  const out = projectAudit(rec, { record: 'capture', home: HOME });
  assert.deepStrictEqual(out, { seq: 3, ts: 1762790400000, source: 'extension', capture_id: 'cap-3' });
  for (const k of ['profile', 'bytes_raw', 'title', 'url', 'distilled', 'raw_ref']) assert.ok(!(k in out), `no ${k}`);
  assert.deepStrictEqual(AUDIT_RULES['capture-record'], { keep: ['source'], labels: [], derive: { capture_id: { from: 'id', take: 'field' } } });
  // The same object read as a ring entry has no row: kind-less, it keeps seq and ts only.
  assert.deepStrictEqual(projectAudit(rec, OPTS), { seq: 3, ts: 1762790400000 });
});

test('an element record follows the element row', () => {
  const rec = { kind: 'element', seq: 12, ts: 5, type: 'comment', id: 'c-1', v: 2, shared: true, mount: 'pane-a',
    text: 'the pin\'s words', anchor: { mount: 'pane-a', quote: 'quoted words' }, replies: [{ text: 'r' }] };
  assert.deepStrictEqual(projectAudit(rec, { record: 'element', home: HOME }),
    { kind: 'element', seq: 12, ts: 5, type: 'comment', id: 'c-1', v: 2, shared: true, mount: 'pane-a' });
  assert.deepStrictEqual(AUDIT_RULES['element-record'], AUDIT_RULES.element);
});

test('a ring entry never selects a reconciliation row by its kind', () => {
  const entry = { kind: 'capture-record', ...BASE, id: 'x', profile: 'p', title: 't' };
  assert.deepStrictEqual(projectAudit(entry, OPTS), { kind: 'capture-record', ...BASE });
});

test('an unknown kind keeps kind, seq and ts only', () => {
  for (const kind of ['hook', 'mirror', 'brand-new-kind', 'constructor', '__proto__', 'toString']) {
    const entry = { ...BASE, ...TEXT, op: 'x', id: 'y', source: 'z' };
    Object.defineProperty(entry, 'kind', { value: kind, enumerable: true });
    assert.deepStrictEqual(projectAudit(entry, OPTS), { kind, ...BASE }, kind);
  }
});

test('projectAudit never mutates its input, and returns a new object', () => {
  for (const [kind, c] of Object.entries(CASES)) {
    const entry = { kind, ...BASE, ...TEXT, ...c.in, name: `${HOME}/a`, label: `${HOME}/b` };
    const before = JSON.stringify(entry);
    const frozen = deepFrozen(structuredClone(entry));
    const out = projectAudit(frozen, OPTS); // a frozen input would throw on any write
    assert.equal(JSON.stringify(frozen), before, kind);
    assert.notEqual(out, frozen);
  }
  const queued = deepFrozen({ kind: 'queue', ...BASE, item: { id: 'q-1', text: 'x' } });
  assert.notEqual(projectAudit(queued, OPTS).item, queued.item, 'the item is a new object');
});

// ── the queue item's keys equal the server's list ──────────────────────────

test('the queue row\'s item keys are PUBLIC_MESSAGE_KEYS less summary, plus kind, mount and key', () => {
  // A test may require lib/server; lib/core may not, so the list is written
  // out there. PUBLIC_MESSAGE_KEYS is not exported: read it through its one
  // user, publicItem, handed a message item that holds EVERY key as its own —
  // what comes back is the list, plus the two fields publicItem computes.
  const { publicItem } = require('../lib/server/domain/queue');
  const everyKey = new Proxy({}, {
    get: (_, k) => (k === 'kind' ? 'message' : undefined),
    has: () => true,
    getOwnPropertyDescriptor: (_, k) => ({ value: k === 'kind' ? 'message' : undefined, enumerable: true, configurable: true }),
  });
  const served = Object.keys(publicItem(everyKey));
  const server = served.filter((k) => k !== 'skill' && k !== 'files_count');
  assert.deepStrictEqual(served.filter((k) => !server.includes(k)).sort(), ['files_count', 'skill'], 'publicItem\'s computed fields');
  assert.ok(server.length > 5 && server.includes('summary') && server.includes('msg_id'));
  const want = new Set([...server.filter((k) => k !== 'summary'), 'kind', 'mount', 'key']);
  const have = AUDIT_RULES.queue.derive.item.keys;
  assert.equal(new Set(have).size, have.length, 'no duplicate');
  assert.deepStrictEqual(new Set(have), want);
  assert.ok(!have.includes('summary') && !have.includes('text'));
});

// ── RULES and ANSWER_RULES unchanged (PROTO@portal-12) ─────────────────────

test('RULES and ANSWER_RULES digests are unchanged (remote-policy.test.js\'s rule)', () => {
  const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  // remote-policy.test.js's lessNoBump: the one no-bump refusal (U541's row) left out.
  const lessNoBump = RULES.filter((r) => keyOf(r) !== '* /api/forms/*');
  assert.equal(lessNoBump.length, RULES.length - 1);
  assert.equal(digest(lessNoBump), '431329a71300f4a5');
  assert.equal(digest(ANSWER_RULES), 'dfa80f57e66ac433');
});
