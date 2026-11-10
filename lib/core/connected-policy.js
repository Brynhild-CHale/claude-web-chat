// lib/core/connected-policy.js — the connected route table (contract 04,
// C-04.13, C-04.14, C-04.19): which daemon routes, and which inbound socket
// messages, each table level reaches through the hub.
//
// THE DATA is lib/core/connected-routes.json: the locked example
// (web-chat-contracts examples/04-route-table.json at contracts-v1.4, cad3e8e),
// byte for byte — test-support/contracts/examples/04-route-table.json is the
// same file, and test/remote-policy.test.js fails on a byte of difference. A
// row is never added or edited here: the table is the contracts folder's, and a
// change to it is a contracts note first, then a copy of the agreed example
// with its table_version bumped (C-04.19).
//
// THE GRAMMAR is remote-policy's (first match wins, default deny, malformed
// paths refused by normalize): the rows load into remote-policy classifier()
// after one mapping (C-04.13) —
//   allow        false for `host_only` and `retired`, true for every other level
//   refuseQuery  from `refuse_query` ({key, value})
// and nothing else: `level`, `requires` and `daemon_mirror` stay on the
// compiled row for the connector's own check (C-04.20), never as remote-policy's
// `mirror` or `destructive` (which would make classifier() read the portal's
// opt-in or its allowDestructive flag). So a verdict here answers "which row
// decides this request, and does that row admit anything at all"; whether the
// decision holds the row's level and its requires is the connector's question
// (lib/connector), asked of `verdict.row`.
//
// A separate compiled table, never a field on RULES or ANSWER_RULES rows
// (C-04.19): the connected table splits rows one portal row covers (GET|POST
// /api/store, * /api/queue/*, the control rows one per action), and the
// portal's tables stay byte-identical with no protocol bump.
//
// THE KEY is table_version and the sha256 over the table's canonical JSON:
// stableStringify (lib/core/stable-json — RFC 8785 for this document, which
// holds only strings, integers, arrays and objects) as UTF-8, hashed with
// crypto sha256 — never stableHash (a sha1) and never a second serializer. The
// connector reports both in its hello (05); a policy decision names the hub's
// copy by both (04-policy-decision.json `table`).
//
// WHO READS IT. The connector's gate (U717) alone. The daemon never consults
// this table: it keeps its own gates with the stamped level (C-04.21), so a
// route the table admits by a wildcard and the daemon serves host only is
// still refused, by the daemon.
//
// Dependency direction: core; this file requires only ./remote-policy,
// ./stable-json and node's crypto, fs and path.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { classifier, keyOf } = require('./remote-policy');
const { stableStringify } = require('./stable-json');

const TABLE_FILE = path.join(__dirname, 'connected-routes.json');

// The levels a row's `allow` is false for (C-04.14, C-04.15): never reachable
// through the hub by any principal.
const CLOSED_LEVELS = Object.freeze(['host_only', 'retired']);

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// sha256 over the UTF-8 of stableStringify(table) (C-04.19).
function tableSha256(table) {
  return crypto.createHash('sha256').update(stableStringify(table), 'utf8').digest('hex');
}

// One table row → the row classifier() reads, carrying the row's own fields
// for the connector (C-04.13's one mapping).
function compileRow(r) {
  const row = {
    methods: r.methods === '*' ? '*' : [...r.methods],
    path: r.path,
    allow: !CLOSED_LEVELS.includes(r.level),
    level: r.level,
    requires: r.requires ? [...r.requires] : [],
    daemon_mirror: r.daemon_mirror || null,
    from_rule: r.from_rule,
  };
  if (r.refuse_query) row.refuseQuery = { key: r.refuse_query.key, value: r.refuse_query.value };
  return deepFreeze(row);
}

// A group's rows compiled through classifier(), and its rows by key (keyOf is
// what a verdict names the deciding row by; a second row under one key could
// never match first, so the first is the one).
function compileGroup(rows) {
  const compiled = Object.freeze(rows.map(compileRow));
  const byKey = new Map();
  for (const row of compiled) {
    const k = keyOf(row);
    if (!byKey.has(k)) byKey.set(k, row);
  }
  const decide = classifier(compiled);
  return { rows: compiled, byKey, decide };
}

function loadTable(file = TABLE_FILE) {
  return deepFreeze(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Everything the module exports for a table, so a test can compile a fixture
// through exactly the code the shipped table goes through.
function compileTable(table) {
  const session = compileGroup(table.session);
  const answer = compileGroup(table.answer);
  const ws = new Map(table.ws_inbound.map((m) => [m.type, m.level]));
  // The verdict: classifier()'s ({allow, key, reason?, hint?}) plus the row
  // that decided it (null for the default deny and a malformed path). A
  // `refused` verdict is a host_only or retired row; a `query` verdict a
  // refuse_query row; `unknown` the default deny; `malformed` normalize's.
  const judge = (group) => (method, rawUrl) => {
    const v = group.decide(method, rawUrl);
    return { ...v, row: v.key === null ? null : group.byKey.get(v.key) || null };
  };
  return Object.freeze({
    TABLE_VERSION: table.table_version,
    TABLE_SHA256: tableSha256(table),
    SESSION_ROWS: session.rows,
    ANSWER_ROWS: answer.rows,
    classifySession: judge(session),
    classifyAnswerRoute: judge(answer),
    // The level a viewer-to-daemon message type needs (C-04.18), or null for a
    // type no row names: the connector drops it.
    wsInboundLevel: (type) => (typeof type === 'string' && ws.has(type) ? ws.get(type) : null),
  });
}

const TABLE = loadTable();
const compiled = compileTable(TABLE);

module.exports = {
  TABLE,
  TABLE_VERSION: compiled.TABLE_VERSION,
  TABLE_SHA256: compiled.TABLE_SHA256,
  SESSION_ROWS: compiled.SESSION_ROWS,
  ANSWER_ROWS: compiled.ANSWER_ROWS,
  classifySession: compiled.classifySession,
  classifyAnswerRoute: compiled.classifyAnswerRoute,
  wsInboundLevel: compiled.wsInboundLevel,
  CLOSED_LEVELS,
  // For the ratchet and tests: the same compile over a fixture table.
  compileTable,
  tableSha256,
  TABLE_FILE,
};
