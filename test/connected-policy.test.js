// The connected route table (tranche 6 U744; contract 04 C-04.13, C-04.14,
// C-04.19; lib/core/connected-policy.js over lib/core/connected-routes.json):
//   * the shipped table is the locked example byte for byte, valid against the
//     locked schema, and compiles to 116 session, 41 answer and 7 ws_inbound
//     rows; TABLE_VERSION is 1 and TABLE_SHA256 the sha256 of
//     stableStringify(table) (crypto, never stableHash) — the value the locked
//     policy-decision example names its table by;
//   * the mapping: host_only and retired rows deny (allow false, reason
//     refused); a refuse_query row refuses its query however qs spells it; a
//     row's level, requires and daemon_mirror reach the compiled row and never
//     become remote-policy's `mirror` or `destructive`; first match wins and a
//     malformed path is refused;
//   * a sample of rows answering at their level, GET / at read;
//   * a pending route — one the code grew after the table's derivation
//     (test/remote-policy.test.js's pending list) — with no row (GET
//     /api/forms/shifts) falls to the default deny at the connector; one a v1
//     wildcard row admits (POST /api/elements/:id/picture under POST|PATCH|
//     DELETE /api/elements/*, I3 (a)) is let through by the connector; the
//     daemon refuses a remote request for either 403 host only by its own gate
//     (the daemon never reads this table, C-04.21);
//   * wsInboundLevel: the seven types at their levels, null for anything else.
// The ratchet that holds the table to the code (C-04.19's checks, the pending
// list) is the appended block of test/remote-policy.test.js.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const policy = require('../lib/core/connected-policy');
const {
  TABLE, TABLE_VERSION, TABLE_SHA256, SESSION_ROWS, ANSWER_ROWS,
  classifySession, classifyAnswerRoute, wsInboundLevel, compileTable, tableSha256,
} = policy;
const { stableStringify, stableHash } = require('../lib/core/stable-json');
const { classify, keyOf } = require('../lib/core/remote-policy');
const { createValidator } = require('../test-support/contracts-loader');
const { withServer } = require('../test-support/helpers');
const client = require('../lib/client');

const REPO_ROOT = path.resolve(__dirname, '..');
const SHIPPED = path.join(REPO_ROOT, 'lib/core/connected-routes.json');
const LOCKED = path.join(REPO_ROOT, 'test-support/contracts/examples/04-route-table.json');

test('the shipped table: the locked example byte for byte, valid against the locked schema', () => {
  assert.equal(policy.TABLE_FILE, SHIPPED);
  assert.ok(fs.readFileSync(SHIPPED).equals(fs.readFileSync(LOCKED)), 'lib/core/connected-routes.json is U734\'s copy at cad3e8e');
  const v = createValidator({ folders: [] }).validateExample('04-route-table', JSON.parse(fs.readFileSync(SHIPPED, 'utf8')));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('compile: 116 session, 41 answer, 7 ws_inbound rows; TABLE_VERSION 1; the table frozen all the way down', () => {
  assert.equal(TABLE_VERSION, 1);
  assert.equal(SESSION_ROWS.length, 116);
  assert.equal(ANSWER_ROWS.length, 41);
  assert.equal(TABLE.ws_inbound.length, 7);
  assert.equal(TABLE.session.length, 116);
  assert.equal(TABLE.answer.length, 41);
  for (const v of [TABLE, TABLE.session, TABLE.session[0], TABLE.session[0].methods, TABLE.ws_inbound[0],
    SESSION_ROWS, SESSION_ROWS[0], SESSION_ROWS[0].methods, ANSWER_ROWS[0].requires]) {
    assert.ok(Object.isFrozen(v), JSON.stringify(v).slice(0, 60));
  }
  assert.throws(() => TABLE.session.push({}), TypeError);
  // One key a row (a second row under one key could never decide anything).
  for (const rows of [SESSION_ROWS, ANSWER_ROWS]) assert.equal(new Set(rows.map(keyOf)).size, rows.length);
});

test('TABLE_SHA256: crypto sha256 over the UTF-8 of stableStringify(table), never stableHash — the locked decision example\'s table', () => {
  const want = crypto.createHash('sha256').update(Buffer.from(stableStringify(JSON.parse(fs.readFileSync(SHIPPED, 'utf8'))), 'utf8')).digest('hex');
  assert.equal(TABLE_SHA256, want);
  assert.match(TABLE_SHA256, /^[0-9a-f]{64}$/);
  assert.notEqual(TABLE_SHA256, stableHash(TABLE), 'not the sha1 form');
  assert.equal(tableSha256(TABLE), TABLE_SHA256);
  const decision = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test-support/contracts/examples/04-policy-decision.json'), 'utf8'));
  assert.deepStrictEqual(decision.table, { version: TABLE_VERSION, sha256: TABLE_SHA256 }, 'the hub names this copy by both');
  // Key order and whitespace are not the identity; a value is.
  const reordered = JSON.parse(JSON.stringify({ ws_inbound: TABLE.ws_inbound, answer: TABLE.answer, session: TABLE.session,
    grammar: TABLE.grammar, derived_from: TABLE.derived_from, table_version: TABLE.table_version }));
  assert.equal(tableSha256(reordered), TABLE_SHA256);
  const edited = JSON.parse(JSON.stringify(TABLE));
  edited.session[0].level = 'message';
  assert.notEqual(tableSha256(edited), TABLE_SHA256);
});

test('mapping: allow is false for host_only and retired and true otherwise; refuse_query becomes refuseQuery; level, requires and daemon_mirror ride the row', () => {
  for (const [rows, raw] of [[SESSION_ROWS, TABLE.session], [ANSWER_ROWS, TABLE.answer]]) {
    rows.forEach((row, i) => {
      const r = raw[i];
      assert.equal(row.allow, r.level !== 'host_only' && r.level !== 'retired', keyOf(r));
      assert.equal(row.level, r.level);
      assert.deepStrictEqual([...row.requires], r.requires ? [...r.requires] : []);
      assert.equal(row.daemon_mirror, r.daemon_mirror || null);
      assert.equal(row.from_rule, r.from_rule);
      assert.equal(keyOf(row), keyOf(r));
      if (r.refuse_query) assert.deepStrictEqual({ ...row.refuseQuery }, { ...r.refuse_query });
      else assert.equal(row.refuseQuery, undefined);
      // Never remote-policy's own level or destructive fields: the connector checks those.
      assert.equal(row.mirror, undefined);
      assert.equal(row.destructive, undefined);
    });
  }
});

test('verdicts: host_only and retired rows deny with reason refused; the row comes with the verdict', () => {
  for (const [m, u, key, level] of [
    ['POST', '/api/turn-begin', '* /api/turn-begin', 'host_only'],
    ['GET', '/api/events/stream', '* /api/events/*', 'host_only'],
    ['POST', '/api/packs/install', '* /api/packs/*', 'host_only'],
    ['POST', '/api/queue/items/q1/resend', '* /api/queue/items/:id/resend', 'host_only'],
    ['GET', '/api/queue/items', 'GET /api/queue/*', 'host_only'],
    ['DELETE', '/api/elements/e1', 'POST|PATCH|DELETE /api/elements/*', 'write_page'],
    ['PUT', '/api/elements/e1', '* /api/elements/*', 'host_only'],
    ['GET', '/api/comments', '* /api/comments/*', 'retired'],
    ['POST', '/api/comments/c1/reply', '* /api/comments/*', 'retired'],
  ]) {
    const v = classifySession(m, u);
    assert.equal(v.key, key, `${m} ${u}`);
    assert.equal(v.row.level, level, `${m} ${u}`);
    assert.equal(v.allow, level !== 'host_only' && level !== 'retired', `${m} ${u}`);
    if (!v.allow) assert.equal(v.reason, 'refused', `${m} ${u}`);
  }
  for (const a of ['resume', 'fork', 'session-resume', 'pack-approve']) {
    for (const [m, u] of [['GET', `/answer/control/${a}`], ['POST', `/answer/api/control/${a}`]]) {
      const v = classifyAnswerRoute(m, u);
      assert.equal(v.allow, false, `${m} ${u}`);
      assert.equal(v.reason, 'refused');
      assert.equal(v.row.level, 'host_only');
    }
  }
});

test('verdicts: the refuse_query row refuses format=file however qs spells it, and only that', () => {
  for (const q of ['format=file', 'format=FILE', 'format[]=file', 'format[0]=file', 'x=1&format=file']) {
    const v = classifySession('GET', `/api/export/n1.2?${q}`);
    assert.equal(v.allow, false, q);
    assert.equal(v.reason, 'query', q);
    assert.equal(v.key, 'GET /api/export/:ref');
  }
  const ok = classifySession('GET', '/api/export/n1.2?format=html');
  assert.equal(ok.allow, true);
  assert.equal(ok.row.level, 'read');
});

test('verdicts: a sample of rows answer at their level, with their requires (GET / at read)', () => {
  const S = (m, u) => classifySession(m, u);
  const A = (m, u) => classifyAnswerRoute(m, u);
  for (const [v, key, level, requires, mirror] of [
    [S('GET', '/'), 'GET /', 'read', [], null],
    [S('HEAD', '/index.html'), 'GET /index.html', 'read', [], null],
    [S('GET', '/app/strokes.js'), 'GET /app/*', 'read', [], null],
    [S('GET', '/ws'), 'GET /ws', 'read', [], null],
    [S('GET', '/api/health'), 'GET /api/health', 'status', [], null],
    [S('GET', '/api/mirror/status'), 'GET /api/mirror/status', 'status', [], 'basic'],
    [S('GET', '/api/mirror/tasks'), 'GET /api/mirror/*', 'read', [], 'read'],
    [S('GET', '/api/store'), 'GET /api/store', 'read', [], null],
    [S('POST', '/api/store'), 'POST /api/store', 'write_page', [], null],
    [S('POST', '/api/queue/message'), 'POST /api/queue/message', 'message', [], 'full'],
    [S('POST', '/api/queue/push'), '* /api/queue/*', 'message', [], null],
    [S('GET', '/api/queue/policy'), 'GET /api/queue/policy', 'read', [], null],
    [S('GET', '/api/elements/search?q=x'), 'GET /api/elements/search', 'read', [], 'read'],
    [S('POST', '/api/graph/wipe'), 'POST /api/graph/wipe', 'write_page', ['destructive'], null],
    [S('GET', '/api/code/preview'), 'GET /api/code/preview', 'files', [], 'read'],
    [S('GET', '/api/files'), 'GET /api/files', 'message', [], 'full'],
    [A('POST', '/answer/api/asks/a1/decide'), 'POST /answer/api/asks/:id/decide', 'message', ['steer'], 'full'],
    [A('POST', '/answer/api/control/interrupt'), 'POST /answer/api/control/interrupt', 'message', ['steer'], 'full'],
    [A('GET', '/answer/control/restore'), 'GET /answer/control/restore', 'files', [], 'full'],
    [A('POST', '/answer/api/elements/report'), 'POST /answer/api/elements/report', 'write_page', [], 'full'],
    [A('GET', '/answer/answer.js'), 'GET /answer/answer.js', 'message', [], 'full'],
  ]) {
    assert.equal(v.key, key);
    assert.equal(v.allow, true, key);
    assert.equal(v.row.level, level, key);
    assert.deepStrictEqual([...v.row.requires], requires, key);
    assert.equal(v.row.daemon_mirror, mirror, key);
  }
  // The level check is the connector's: classifier() sees no opt-in and no
  // destructive flag, so a write_page + destructive row is "admitted" here.
  assert.equal(classify('POST', '/api/graph/wipe').reason, 'destructive', 'the portal reads its flag; the connected table does not');
});

test('verdicts: first match wins, default deny, malformed refused, the two origins apart', () => {
  // GET /api/queue/* (host only) is after the three GET reads it would shadow.
  assert.equal(classifySession('GET', '/api/queue/pending').row.level, 'read');
  assert.equal(classifySession('GET', '/api/queue/other').row.level, 'host_only');
  for (const [m, u] of [['GET', '/api/nothing-here'], ['GET', '/answer/ask/a1'], ['POST', '/api/graph/active2']]) {
    const v = classifySession(m, u);
    assert.deepStrictEqual([v.allow, v.key, v.reason, v.row], [false, null, 'unknown', null], `${m} ${u}`);
  }
  assert.equal(classifyAnswerRoute('GET', '/').reason, 'unknown', 'the answer origin has no surface rows');
  assert.equal(classifyAnswerRoute('GET', '/answer/control/no-such-action').reason, 'unknown', 'an action no row names is refused');
  for (const u of ['/api/%2e%2e/graph', '/api//graph', 'api/graph', '/api/gr%00aph', '/api/%zz']) {
    assert.equal(classifySession('GET', u).reason, 'malformed', u);
  }
  // Express's matching: case-insensitive, one trailing slash, HEAD is GET.
  assert.equal(classifySession('GET', '/API/Graph/').key, 'GET /api/graph');
  assert.equal(classifySession('HEAD', '/api/graph').allow, true);
});

test('pending routes: one with no v1 row (GET /api/forms/shifts) falls to the default deny at the connector; one a v1 wildcard admits (POST /api/elements/:id/picture) passes it; the daemon refuses both 403 host only', async (t) => {
  const v = classifySession('GET', '/api/forms/shifts');
  assert.deepStrictEqual([v.allow, v.key, v.reason, v.row], [false, null, 'unknown', null], 'the runtime is C-04.13\'s default deny, whatever the test\'s pending list says');
  // A pending route a v1 wildcard row admits (I3 (a), hand fold 3): the
  // connector lets it through at the wildcard's level. The ink picture's POST
  // (U564) is host only at the daemon; the type's draw.js (U511), also
  // pending, is served at the daemon's own read level (element-files.js), so
  // it shows only the connector's half.
  const pic = classifySession('POST', '/api/elements/e1/picture');
  assert.deepStrictEqual([pic.allow, pic.key, pic.row.level], [true, 'POST|PATCH|DELETE /api/elements/*', 'write_page']);
  const draw = classifySession('GET', '/api/elements/types/ink/draw.js');
  assert.deepStrictEqual([draw.allow, draw.key, draw.row.level], [true, 'GET /api/elements/*', 'read']);
  // The daemon never reads the connected table (C-04.21): its own gate.
  const d = await withServer(t);
  const remote = await client.request(d.port, 'GET', '/api/forms/shifts', null, { headers: { 'X-WC-Remote': '1' } });
  assert.equal(remote.status, 403, JSON.stringify(remote.body));
  assert.equal((await client.request(d.port, 'GET', '/api/forms/shifts')).status, 200, 'the host\'s own read');
  const remotePic = await client.request(d.port, 'POST', '/api/elements/e1/picture', {}, { headers: { 'X-WC-Remote': '1' } });
  assert.equal(remotePic.status, 403, JSON.stringify(remotePic.body));
  assert.equal(remotePic.body.ok, false);
  assert.match(String(remotePic.body.hint), /host|terminal|machine/i, JSON.stringify(remotePic.body));
  const hostPic = await client.request(d.port, 'POST', '/api/elements/e1/picture', {});
  assert.notEqual(hostPic.status, 403, 'the host passes the daemon\'s own gate: ' + JSON.stringify(hostPic.body));
});

test('wsInboundLevel: the seven types at their levels; null for any other type (the connector drops it)', () => {
  assert.deepStrictEqual(Object.fromEntries(TABLE.ws_inbound.map((m) => [m.type, wsInboundLevel(m.type)])), {
    client: 'read', 'store:set': 'write_page', event: 'write_page', 'pane:form': 'write_page',
    'pane:state': 'write_page', 'script:error': 'write_page', report: 'host_only',
  });
  for (const t of ['hello', 'Store:set', 'constructor', '__proto__', 'toString', '', null, undefined, 7, { type: 'client' }]) {
    assert.equal(wsInboundLevel(t), null, String(t));
  }
});

test('compileTable: a fixture compiles through the same code (the seam U744b\'s table_version 2 rides)', () => {
  const fixture = JSON.parse(JSON.stringify(TABLE));
  fixture.table_version = 2;
  fixture.session.unshift({ methods: ['GET'], path: '/api/forms/shifts', level: 'host_only', from_rule: '* /api/forms/*' });
  const c = compileTable(fixture);
  assert.equal(c.TABLE_VERSION, 2);
  assert.notEqual(c.TABLE_SHA256, TABLE_SHA256);
  const v = c.classifySession('GET', '/api/forms/shifts');
  assert.deepStrictEqual([v.allow, v.key, v.reason, v.row.level], [false, 'GET /api/forms/shifts', 'refused', 'host_only']);
  assert.equal(classifySession('GET', '/api/forms/shifts').key, null, 'the shipped table is untouched');
});
