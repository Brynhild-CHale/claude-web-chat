// What the ask hook prints for a web decision (lib/hooks/ask-output.js, spec
// §4.2): every row of the table, deep-equal on the parsed line, the wordings
// byte for byte, the question picks mapped by index onto the hook's LOCAL copy
// (ruling A3 (a)), and what is never printed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  buildAskOutput, MESSAGE_MAX, DENY_MESSAGE, DECLINE_MESSAGE, WROTE, REJECT_FEEDBACK, REJECT_NO_FEEDBACK, LABEL_JOIN,
} = require('../lib/hooks/ask-output');

const out = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
const parse = (line) => {
  assert.equal(typeof line, 'string');
  assert.ok(!line.includes('\n'), 'one line');
  return JSON.parse(line);
};

const QUESTIONS = [
  {
    question: 'Which colour?', header: 'Colour', multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }],
  },
  {
    question: 'Which toppings?', header: 'Toppings', multiSelect: true,
    options: [{ label: 'Cheese' }, { label: 'Olives, black' }, { label: 'Basil' }],
  },
];
const PLAN = '# Plan\n\n1. Do the thing.\n';
const PLAN_PATH = '/Users/someone/.claude/plans/quiet-river.md';
const LOCAL = { questions: QUESTIONS, plan: PLAN, planFilePath: PLAN_PATH };

// ── the table ───────────────────────────────────────────────────────────────

test('ask-output: the wordings, byte for byte', () => {
  assert.equal(DENY_MESSAGE, 'The user denied this tool call in the web-chat page.');
  assert.equal(DECLINE_MESSAGE, 'The user declined to answer in the web-chat page.');
  assert.equal(WROTE, ' They wrote: ');
  assert.equal(REJECT_FEEDBACK, 'The user rejected this plan in the web-chat page and wrote this feedback: ');
  assert.equal(REJECT_NO_FEEDBACK, 'The user rejected this plan in the web-chat page without feedback. Keep planning and ask what to change.');
  assert.equal(MESSAGE_MAX, 2000);
  assert.equal(LABEL_JOIN, ', ');
});

test('ask-output: permission allow and deny, with and without a message', () => {
  assert.equal(buildAskOutput('permission', LOCAL, { behavior: 'allow' }),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.deepEqual(parse(buildAskOutput('permission', LOCAL, { behavior: 'deny' })),
    out({ behavior: 'deny', message: 'The user denied this tool call in the web-chat page.' }));
  assert.deepEqual(parse(buildAskOutput('permission', LOCAL, { behavior: 'deny', message: 'use pnpm' })),
    out({ behavior: 'deny', message: 'The user denied this tool call in the web-chat page. They wrote: use pnpm' }));
  // An empty or blank message is no message.
  assert.deepEqual(parse(buildAskOutput('permission', LOCAL, { behavior: 'deny', message: '  ' })),
    out({ behavior: 'deny', message: DENY_MESSAGE }));
});

test('ask-output: question answer, decline with and without a message', () => {
  const line = buildAskOutput('question', LOCAL, {
    behavior: 'answer', picks: [{ q: 0, options: [1] }, { q: 1, options: [2, 0] }],
  });
  assert.deepEqual(parse(line), out({
    behavior: 'allow',
    updatedInput: { questions: QUESTIONS, answers: { 'Which colour?': 'Blue', 'Which toppings?': 'Cheese, Basil' } },
  }));
  assert.deepEqual(parse(buildAskOutput('question', LOCAL, { behavior: 'decline' })),
    out({ behavior: 'deny', message: 'The user declined to answer in the web-chat page.' }));
  assert.deepEqual(parse(buildAskOutput('question', LOCAL, { behavior: 'decline', message: 'ask me later' })),
    out({ behavior: 'deny', message: 'The user declined to answer in the web-chat page. They wrote: ask me later' }));
});

test('ask-output: plan approve (default and acceptEdits), reject with and without feedback', () => {
  assert.deepEqual(parse(buildAskOutput('plan', LOCAL, { behavior: 'approve', mode: 'default' })),
    out({ behavior: 'allow', updatedInput: { plan: PLAN, planFilePath: PLAN_PATH } }));
  const edits = parse(buildAskOutput('plan', LOCAL, { behavior: 'approve', mode: 'acceptEdits' }));
  assert.deepEqual(edits, out({
    behavior: 'allow',
    updatedInput: { plan: PLAN, planFilePath: PLAN_PATH },
    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  }));
  assert.equal(edits.hookSpecificOutput.decision.updatedPermissions.length, 1, 'exactly one setMode entry');
  assert.deepEqual(parse(buildAskOutput('plan', LOCAL, { behavior: 'reject', message: 'split step 2' })),
    out({ behavior: 'deny', message: 'The user rejected this plan in the web-chat page and wrote this feedback: split step 2' }));
  assert.deepEqual(parse(buildAskOutput('plan', LOCAL, { behavior: 'reject' })),
    out({ behavior: 'deny', message: 'The user rejected this plan in the web-chat page without feedback. Keep planning and ask what to change.' }));
});

test('ask-output: terminal prints nothing, for every kind', () => {
  for (const kind of ['permission', 'question', 'plan']) {
    assert.equal(buildAskOutput(kind, LOCAL, { behavior: 'terminal' }), null, kind);
  }
});

test('ask-output: a behavior of another kind, an unknown one, or no decision prints nothing', () => {
  assert.equal(buildAskOutput('permission', LOCAL, { behavior: 'answer', picks: [] }), null);
  assert.equal(buildAskOutput('permission', LOCAL, { behavior: 'approve', mode: 'default' }), null);
  assert.equal(buildAskOutput('question', LOCAL, { behavior: 'allow' }), null, 'allow alone is ignored for a question (V9)');
  assert.equal(buildAskOutput('plan', LOCAL, { behavior: 'allow' }), null, 'allow alone is ignored for a plan (V9)');
  assert.equal(buildAskOutput('plan', LOCAL, { behavior: 'approve', mode: 'bypassPermissions' }), null);
  assert.equal(buildAskOutput('plan', LOCAL, { behavior: 'approve' }), null);
  assert.equal(buildAskOutput('plan', { ...LOCAL, plan: null }, { behavior: 'approve', mode: 'default' }), null);
  assert.equal(buildAskOutput('permission', LOCAL, { behavior: 'bogus' }), null);
  assert.equal(buildAskOutput('bogus', LOCAL, { behavior: 'allow' }), null);
  for (const d of [null, undefined, 'allow', [], {}, { behavior: 1 }]) assert.equal(buildAskOutput('permission', LOCAL, d), null);
});

// ── question picks onto the local copy ─────────────────────────────────────

test('ask-output: picks map onto the LOCAL question texts and labels; other text passes; multiSelect joins ", "', () => {
  const answers = (picks, local = LOCAL) => parse(buildAskOutput('question', local, { behavior: 'answer', picks }))
    .hookSpecificOutput.decision.updatedInput.answers;
  assert.deepEqual(answers([{ q: 0, other: 'Purple, typed on the web page' }, { q: 1, options: [1] }]),
    { 'Which colour?': 'Purple, typed on the web page', 'Which toppings?': 'Olives, black' });
  assert.deepEqual(answers([{ q: 1, options: [0, 1, 2] }, { q: 0, options: [0] }]),
    { 'Which colour?': 'Red', 'Which toppings?': 'Cheese, Olives, black, Basil' });
  // The local copy is what the answer is built from, whatever was displayed.
  const local = { questions: [{ question: 'Key sk-REAL-1?', multiSelect: false, options: [{ label: 'use sk-REAL-2' }] }] };
  assert.deepEqual(answers([{ q: 0, options: [0] }], local), { 'Key sk-REAL-1?': 'use sk-REAL-2' });
  // The echoed questions are the local copy itself, unchanged.
  const echoed = parse(buildAskOutput('question', LOCAL, { behavior: 'answer', picks: [{ q: 0, options: [0] }, { q: 1, options: [0] }] }));
  assert.deepEqual(echoed.hookSpecificOutput.decision.updatedInput.questions, QUESTIONS);
});

test('ask-output: a pick the local copy cannot map prints nothing (never a wrong answer)', () => {
  const bad = [
    [{ q: 0, options: [5] }, { q: 1, options: [0] }],          // an option index the copy lacks
    [{ q: 2, options: [0] }, { q: 1, options: [0] }],          // a question index the copy lacks
    [{ q: 0, options: [0] }],                                  // a question left unanswered
    [{ q: 0, options: [0] }, { q: 1, options: [0] }, { q: 2, options: [0] }], // more picks than questions
    [{ q: 0, options: [0, 1] }, { q: 1, options: [0] }],       // two options on a single-select question
    [{ q: 0, options: [] }, { q: 1, options: [0] }],           // no option
    [{ q: 0, options: [0, 0] }, { q: 1, options: [0] }],       // the same option twice
    [{ q: 0, options: [0] }, { q: 0, options: [1] }],          // the same question twice
    [{ q: 0, options: [0], other: 'x' }, { q: 1, options: [0] }], // both forms
    [{ q: 0 }, { q: 1, options: [0] }],                        // neither form
    [{ q: 0, other: '' }, { q: 1, options: [0] }],             // empty other text
    [{ q: 0, other: '\u0007‮' }, { q: 1, options: [0] }], // other text that is only control characters
    [{ q: '0', options: [0] }, { q: 1, options: [0] }],        // a string index
    [{ q: 0, options: ['0'] }, { q: 1, options: [0] }],
    [{ q: 0.5, options: [0] }, { q: 1, options: [0] }],
    [{ q: -1, options: [0] }, { q: 1, options: [0] }],
    [null, { q: 1, options: [0] }],
  ];
  for (const picks of bad) {
    assert.equal(buildAskOutput('question', LOCAL, { behavior: 'answer', picks }), null, JSON.stringify(picks));
  }
  assert.equal(buildAskOutput('question', LOCAL, { behavior: 'answer' }), null, 'no picks');
  assert.equal(buildAskOutput('question', LOCAL, { behavior: 'answer', picks: 'x' }), null);
  assert.equal(buildAskOutput('question', { questions: undefined }, { behavior: 'answer', picks: [{ q: 0, options: [0] }] }), null, 'no local copy');
  assert.equal(buildAskOutput('question', { questions: [] }, { behavior: 'answer', picks: [] }), null);
  // A malformed local copy: no question text, a label that is not a string.
  assert.equal(buildAskOutput('question', { questions: [{ options: [{ label: 'a' }] }] }, { behavior: 'answer', picks: [{ q: 0, options: [0] }] }), null);
  assert.equal(buildAskOutput('question', { questions: [{ question: 'q', options: [{ label: 7 }] }] }, { behavior: 'answer', picks: [{ q: 0, options: [0] }] }), null);
  // Two questions of one text would be one key: neither answer is safe.
  const twins = { questions: [{ question: 'Same?', options: [{ label: 'a' }] }, { question: 'Same?', options: [{ label: 'b' }] }] };
  assert.equal(buildAskOutput('question', twins, { behavior: 'answer', picks: [{ q: 0, options: [0] }, { q: 1, options: [0] }] }), null);
});

// ── messages, and what is never printed ─────────────────────────────────────

test('ask-output: messages are cut at 2,000 characters, control and bidi characters stripped', () => {
  const long = '\u{1F600}'.repeat(2500);
  const deny = parse(buildAskOutput('permission', LOCAL, { behavior: 'deny', message: long })).hookSpecificOutput.decision.message;
  assert.equal(deny, `${DENY_MESSAGE}${WROTE}${'\u{1F600}'.repeat(2000)}`, 'cut in characters, never half a pair');
  const dirty = 'ok\u0007 ‮done​\u0000 line\nnext';
  const reject = parse(buildAskOutput('plan', LOCAL, { behavior: 'reject', message: dirty })).hookSpecificOutput.decision.message;
  assert.equal(reject, `${REJECT_FEEDBACK}ok done line\nnext`);
  const other = parse(buildAskOutput('question', LOCAL, {
    behavior: 'answer', picks: [{ q: 0, other: '‮evil\u0007' }, { q: 1, options: [0] }],
  })).hookSpecificOutput.decision.updatedInput.answers['Which colour?'];
  assert.equal(other, 'evil');
  const decline = parse(buildAskOutput('question', LOCAL, { behavior: 'decline', message: 'x'.repeat(3000) })).hookSpecificOutput.decision.message;
  assert.equal(decline, `${DECLINE_MESSAGE}${WROTE}${'x'.repeat(2000)}`);
});

test('ask-output: no output ever holds bypassPermissions, addRules or interrupt', () => {
  const decisions = [
    ['permission', { behavior: 'allow', interrupt: true, updatedPermissions: [{ type: 'addRules' }] }],
    ['permission', { behavior: 'deny', interrupt: true, message: 'x' }],
    ['plan', { behavior: 'approve', mode: 'acceptEdits', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] }],
    ['plan', { behavior: 'approve', mode: 'default', interrupt: true }],
    ['plan', { behavior: 'reject', interrupt: true }],
    ['question', { behavior: 'answer', picks: [{ q: 0, options: [0] }, { q: 1, options: [0] }], updatedPermissions: [{ type: 'addRules' }] }],
    ['question', { behavior: 'decline', interrupt: true }],
  ];
  for (const [kind, d] of decisions) {
    const line = buildAskOutput(kind, LOCAL, d);
    assert.equal(typeof line, 'string', `${kind} ${d.behavior}`);
    assert.doesNotMatch(line, /bypassPermissions|addRules|interrupt/, `${kind} ${d.behavior}`);
  }
});

test('ask-output: pure — it never touches the filesystem, the clock or the environment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hooks', 'ask-output.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../core/text']);
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /process\.|Date\.now|new Date/);
});
