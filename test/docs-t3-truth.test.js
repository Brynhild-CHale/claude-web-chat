'use strict';
// Tranche 3's documentation claims, held to the code they describe (U461).
//
// The six visible states of a chat pin (DECISIONS.md L.2 L4) each have ONE
// line, frozen in lib/core/anchor-states.js EXPLAIN (RULED 2026-10-28 Q6 = a):
// the chrome and Claude's tools read the daemon's answers, and the docs quote
// the table — the guide's when-table, the rules files and the
// respond-to-comment skill. A line reworded in the code, or in one doc, fails
// here. The rest are the grep checks the tranche's rulings asked for: the
// guide names the three documented limits of patch redaction (L.6, REQ@patch-
// redaction c), the Space toggle's scroll and rebind note (L.6, U404@space-on-
// tabindex-minus-one-scrollers b), the disk budget's 64 MiB floor (R2 = a) and
// the ⌘K row for pins whose conversation has left the chat (Q4 = b); the two
// rules files and the two skill copies stay byte-identical; and the MCP tool
// count stays 24 (tranche 3 adds none).

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, mcpTools } = require('../test-support/doc-truth');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { MIN_BUDGET_BYTES } = require('../lib/core/mirror-settings');

const STATES = ['placed', 'refused', 'superseded', 'masked', 'indexing', 'unavailable'];
const RULES = ['.claude/rules/web-chat.md', 'templates/rules/web-chat.md'];
const SKILLS = ['templates/skills/respond-to-comment/SKILL.md', '.claude/skills/respond-to-comment/SKILL.md'];

// The guide's when-table: the rows under its header, each `| state | when | line |`.
function whenTable() {
  const guide = read('docs/guide.md');
  const header = '| State | When | What the pin says |';
  const at = guide.indexOf(header);
  assert.ok(at >= 0, 'docs/guide.md no longer carries the chat pins\' when-table (L4)');
  const rows = [];
  for (const line of guide.slice(at).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ state: cells[0].replace(/\*\*/g, '').replace(/\s*\(.*\)$/, ''), when: cells[1], line: cells[2] });
  }
  return rows;
}

test('the six visible states are EXPLAIN\'s keys and VISIBLE\'s values, in L4\'s order', () => {
  assert.deepEqual(Object.keys(EXPLAIN), STATES);
  assert.deepEqual([...new Set(Object.values(VISIBLE))].sort(), [...STATES].sort());
});

test('the guide\'s when-table has one row per visible state, each line EXPLAIN\'s', () => {
  const rows = whenTable();
  assert.deepEqual(rows.map((r) => r.state), STATES, 'one row per L4 state, in order');
  for (const r of rows) {
    assert.equal(r.line, EXPLAIN[r.state], `the ${r.state} row's line is anchor-states EXPLAIN.${r.state}, as written`);
    assert.ok(r.when.length > 20, `the ${r.state} row says when`);
  }
  const refused = read('docs/guide.md').split('\n').find((l) => l.startsWith('| **refused'));
  assert.match(refused, /with a hint/, 'the refused row says the refusal carries a hint');
});

for (const rel of [...RULES, ...SKILLS]) {
  test(`${rel}: lists the six states, each with its EXPLAIN line`, () => {
    const body = read(rel);
    for (const st of STATES) {
      assert.ok(body.includes(`- \`${st}\` — ${EXPLAIN[st]}`), `${rel} lists \`${st}\` with its one line`);
    }
  });
  test(`${rel}: names where a gone conversation's chat pins are read (Q4)`, () => {
    assert.ok(read(rel).includes('⌘K **Chat pins no longer in a chat (n)**'));
  });
}

test('the ⌘K row the docs name is the one the chrome draws', () => {
  assert.ok(read('public/app/chat-pins.js').includes('`Chat pins no longer in a chat (${n})`'),
    'chat-pins.js goneLabel is the row the rules, the skill and the guide name');
  assert.ok(read('docs/guide.md').includes('⌘K **Chat pins no longer in a chat (n)**'));
});

test('the two rules files and the two skill copies are byte-identical', () => {
  assert.equal(read(RULES[0]), read(RULES[1]));
  assert.equal(read(SKILLS[0]), read(SKILLS[1]));
});

test('tranche 3 adds no MCP tool: there are still 24, and the rules say so', () => {
  assert.equal(mcpTools().length, 24);
  for (const rel of RULES) assert.match(read(rel), /the 24 tools above are unchanged/);
});

test('the guide names the three documented limits of patch redaction (L.6)', () => {
  const g = read('docs/guide.md');
  assert.match(g, /private key pasted into an ordinary file without its BEGIN and END marker lines/, 'a bare PEM body in a neutral file');
  assert.match(g, /dotenv-style `KEY=value` lines in a file that is not a dotenv file/, 'dotenv values outside a dotenv file');
  assert.match(g, /the values of a `\.env` file that git tracks, as they appear inside a code diff/, 'a tracked .env inside a code diff');
});

test('the guide says the Space toggle stops scrolling, fires once per hold and is rebindable (L.6)', () => {
  const g = read('docs/guide.md');
  assert.match(g, /Space no longer scrolls the page or a focused chat stream/);
  assert.match(g, /holding it down toggles once/);
  assert.match(g, /you can bind another key to the toggle \(the `tools\.last` action/);
  assert.ok(read('public/app/tools.js').includes("LAST_TOOL_ACTION = 'tools.last'"), 'the action the guide names is tools.js\'s');
});

test('the guide\'s mirror budget row names the 64 MiB floor (R2)', () => {
  assert.equal(MIN_BUDGET_BYTES, 64 * 1024 * 1024);
  const g = read('docs/guide.md');
  const row = g.slice(g.indexOf('mirror [verb]'), g.indexOf('\ninstall '));
  assert.match(row.replace(/\s+/g, ' '), /a size is at least 64 MiB \(a smaller one is refused\)/);
});
