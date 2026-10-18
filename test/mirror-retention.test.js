// The chat mirror's retention table (lib/server/mirror/retention.js,
// annotation engine PLAN.md 1D.2; readiness R4 §3 seam (f), §5 bug 3).
//
// Pinned:
//   * RETENTION is frozen, its rows too; ids are unique; every row has a
//     finite or string value, a unit, a `where` naming an existing
//     lib/server/mirror file (or ../domain/asks.js, the one owner outside
//     the mirror) and a one-sentence user_text;
//   * retention(id) answers the row (null for an unknown id); valueOf(id) its
//     value, and throws on an unknown id;
//   * every owning module's named export equals its row, and its source takes
//     the value from ./retention — no literal left beside the name;
//   * docs/guide.md lists every row's user_text verbatim.
// The expired state codediff answers from the table is pinned in
// test/mirror-codediff.test.js, its chrome note in test/chat-detail.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RETENTION, retention, valueOf } = require('../lib/server/mirror/retention');

const REPO = path.resolve(__dirname, '..');
const MIRROR = path.join(REPO, 'lib', 'server', 'mirror');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
// The one owner outside lib/server/mirror: the asks domain's resolved-ask keep.
const ASKS = '../domain/asks.js';
// How each owner's source requires the table.
const requireOf = (file) => (file === ASKS ? "require('../mirror/retention')" : "require('./retention')");

// Each row's enforcing module, the export it keeps, and how the source names it.
const OWNERS = [
  ['record-max-days', 'codediff.js', (m) => m.LIMITS.RECORD_MAX_DAYS, 'RECORD_MAX_DAYS'],
  ['prune-expire', 'codediff.js', (m) => m.LIMITS.PRUNE_EXPIRE, 'PRUNE_EXPIRE'],
  ['shadow-max-bytes', 'codediff.js', (m) => m.LIMITS.SHADOW_MAX_BYTES, 'SHADOW_MAX_BYTES'],
  ['codediff-turns-max', 'codediff.js', null, 'TURNS_MAX'],
  ['conversations-max', 'conversations.js', (m) => m.CONVERSATIONS_MAX, 'CONVERSATIONS_MAX'],
  ['sessions-max', 'conversations.js', (m) => m.SESSIONS_MAX, 'SESSIONS_MAX'],
  ['index-turns-max', 'index-store.js', (m) => m.TURNS_MAX, 'TURNS_MAX'],
  ['tasks-finished-keep', 'tasks.js', (m) => m.FINISHED_KEEP_MS, 'FINISHED_KEEP_MS'],
  ['agents-finished-keep', 'agents.js', (m) => m.FINISHED_KEEP_MS, 'FINISHED_KEEP_MS'],
  ['asks-resolved-keep', ASKS, (m) => m.RESOLVED_KEEP_MS, 'RESOLVED_KEEP_MS'],
  ['tasks-persist-rows', 'tasks.js', (m) => m.PERSIST_ROWS_MAX, 'PERSIST_ROWS_MAX'],
  ['agents-persist-rows', 'agents.js', (m) => m.PERSIST_ROWS_MAX, 'PERSIST_ROWS_MAX'],
  ['workflows-persist-rows', 'workflows.js', (m) => m.PERSIST_ROWS_MAX, 'PERSIST_ROWS_MAX'],
];

test('RETENTION is frozen, rows too; ids unique; every row has a value, a unit, an existing `where` and one sentence for the user', () => {
  assert.ok(Object.isFrozen(RETENTION));
  assert.ok(RETENTION.length >= 13);
  const ids = new Set();
  for (const r of RETENTION) {
    assert.ok(Object.isFrozen(r), `${r.id} is frozen`);
    assert.deepEqual(Object.keys(r).sort(), ['id', 'unit', 'user_text', 'value', 'what', 'where']);
    assert.match(r.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(r.id), `${r.id} is unique`);
    ids.add(r.id);
    assert.ok((typeof r.value === 'number' && Number.isFinite(r.value)) || (typeof r.value === 'string' && r.value), `${r.id}: a finite or string value`);
    assert.ok(typeof r.unit === 'string' && r.unit, `${r.id}: a unit`);
    assert.ok(typeof r.what === 'string' && r.what, `${r.id}: what it bounds`);
    assert.ok(r.where === ASKS || /^[a-z-]+\.js$/.test(r.where), `${r.id}: where is a mirror file, or ${ASKS} (${r.where})`);
    assert.ok(fs.existsSync(path.join(MIRROR, r.where)), `${r.id}: lib/server/mirror/${r.where} exists`);
    assert.match(r.user_text, /^[A-Z][^.!?\n]*\.$/, `${r.id}: one plain sentence (${r.user_text})`);
  }
  assert.deepEqual([...ids].sort(), OWNERS.map(([id]) => id).sort(), 'every row has an owner below, and every owner a row');
});

test('retention(id) answers the row; valueOf(id) its value, and throws on an unknown id', () => {
  for (const r of RETENTION) {
    assert.equal(retention(r.id), r);
    assert.equal(valueOf(r.id), r.value);
  }
  assert.equal(retention('nope'), null);
  assert.throws(() => valueOf('nope'), /nope/);
  assert.throws(() => valueOf(undefined));
});

test('the values are unchanged (no retention value moved with the table)', () => {
  assert.equal(valueOf('record-max-days'), 30);
  assert.equal(valueOf('prune-expire'), '7.days.ago');
  assert.equal(valueOf('shadow-max-bytes'), 1024 * 1024 * 1024);
  assert.equal(valueOf('codediff-turns-max'), 1000);
  assert.equal(valueOf('conversations-max'), 200);
  assert.equal(valueOf('sessions-max'), 100);
  assert.equal(valueOf('index-turns-max'), 5000);
  assert.equal(valueOf('tasks-finished-keep'), 30 * 60 * 1000);
  assert.equal(valueOf('agents-finished-keep'), 30 * 60 * 1000);
  assert.equal(valueOf('asks-resolved-keep'), 600000);
  assert.equal(valueOf('tasks-persist-rows'), 64);
  assert.equal(valueOf('agents-persist-rows'), 64);
  assert.equal(valueOf('workflows-persist-rows'), 32);
  assert.equal(retention('asks-resolved-keep').unit, 'ms');
  for (const id of ['tasks-persist-rows', 'agents-persist-rows', 'workflows-persist-rows']) assert.equal(retention(id).unit, 'rows per session', `${id}: its unit`);
});

test('each owning module keeps its named export, equal to its row, and takes the value from ./retention', () => {
  for (const [id, file, get, name] of OWNERS) {
    if (get) assert.equal(get(require(path.join(MIRROR, file))), valueOf(id), `${file} ${name}`);
    const src = fs.readFileSync(path.join(MIRROR, file), 'utf8');
    assert.ok(src.includes(requireOf(file)), `${file} requires the table (${requireOf(file)})`);
    // The name's definition reads the row, and carries no literal value.
    const def = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && new RegExp(`^\\s*(?:const\\s+)?${name}\\s*[:=]`).test(l));
    assert.equal(def.length, 1, `${file}: one definition of ${name}`);
    assert.ok(def[0].includes(`valueOf('${id}')`), `${file}: ${name} is valueOf('${id}') (${def[0].trim()})`);
    const rest = def[0].replace(`valueOf('${id}')`, '').replace(`${requireOf(file)}.`, '');
    assert.doesNotMatch(rest, /\d|'[^']*'/, `${file}: no literal beside ${name}`);
  }
});

test('docs/guide.md lists every row\'s user_text verbatim', () => {
  const guide = read('docs/guide.md');
  const head = guide.indexOf('**What the chat mirror keeps.**');
  assert.ok(head > 0, 'the guide has the list');
  const lines = guide.slice(head).split('\n\n')[1].split('\n');
  assert.deepEqual(lines, RETENTION.map((r) => `- ${r.user_text}`), 'the list is the table, in its order');
});
