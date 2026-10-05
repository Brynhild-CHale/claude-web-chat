// The meta fold (lib/server/mirror/meta.js): title, model, modes, tokens, cost,
// away, skills and the known values, folded from transcript records and hook
// envelopes (spec §2.5 "Meta, skills and cost", §2.10, §5.5 "Known values").

const test = require('node:test');
const assert = require('node:assert/strict');

const { initialMeta, foldMeta, foldEnvelope, COUNTED_MAX } = require('../lib/server/mirror/meta');
const { createRecords } = require('../test-support/claude-records');

// The tailer's record shape: {line, obj, start, end}, offsets in bytes.
function toRecs(records, from = 0) {
  let at = from;
  return records.flat().map((obj) => {
    const line = JSON.stringify(obj);
    const start = at;
    at += Buffer.byteLength(line) + 1;
    return { line, obj, bad: false, oversize: false, start, end: at };
  });
}

const fold = (records, opts, state = initialMeta()) => foldMeta(state, toRecs(records), opts);

test('title: ai-title over agent-name over sessionName over the first prompt', () => {
  const r = createRecords({ seed: 11 });
  r.prompt('  Please   fix the flaky build in CI and then look at why the deploy step keeps timing out on staging  ');
  let out = fold(r.records, {});
  assert.equal(out.title, 'Please fix the flaky build in CI and then look at why the de');
  assert.equal(out.title.length, 60);
  assert.equal(out.patch.title, out.title);

  out = fold(r.records, { sessionName: 'deploy-fixes' });
  assert.equal(out.title, 'deploy-fixes', 'the sessions file name beats the prompt');

  r.agentName('builder-agent');
  out = fold(r.records, { sessionName: 'deploy-fixes' });
  assert.equal(out.title, 'builder-agent', 'agent-name beats the sessions file name');

  r.aiTitle('Fix the flaky build');
  out = fold(r.records, { sessionName: 'deploy-fixes' });
  assert.equal(out.title, 'Fix the flaky build', 'ai-title beats agent-name');

  r.aiTitle('Fix flaky CI and staging deploys');
  out = fold(r.records, { sessionName: 'deploy-fixes' });
  assert.equal(out.title, 'Fix flaky CI and staging deploys', 'a later ai-title replaces an earlier one');
  assert.equal(out.state.title, 'Fix flaky CI and staging deploys');
});

test('title: returned only when it changes; a later batch keeps it; a sessionName change alone is a change', () => {
  const r = createRecords({ seed: 12 });
  r.aiTitle('First title');
  const a = foldMeta(initialMeta(), toRecs(r.records), {});
  assert.equal(a.title, 'First title');
  const b = foldMeta(a.state, [], {});
  assert.equal(b.title, null);
  assert.equal(b.patch, null, 'nothing changed');

  const c = foldMeta(initialMeta(), [], { sessionName: 'name-one' });
  assert.equal(c.title, 'name-one');
  const d = foldMeta(c.state, [], { sessionName: 'name-two' });
  assert.equal(d.title, 'name-two');
  assert.equal(d.patch.title, 'name-two');
});

test('the first prompt only: a later prompt never re-titles; an isMeta prompt is not the first', () => {
  const r = createRecords({ seed: 13 });
  r.user('Caveat text the harness wrote', { extra: { isMeta: true } });
  r.prompt('The real first prompt');
  r.prompt('A second prompt');
  const out = fold(r.records, {});
  assert.equal(out.title, 'The real first prompt');
});

test('tokens are counted once per message.id across its block records', () => {
  const r = createRecords({ seed: 21 });
  r.prompt('go');
  const usage = { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };
  const blocks = r.assistant([{ type: 'thinking', thinking: 'hm' }, 'Reading it.', { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.js' } }],
    { messageId: 'msg_01AAA', usage });
  assert.equal(blocks.length, 3);
  const out = fold(r.records, {});
  assert.deepEqual(out.patch.cost.tokens, { input: 100, output: 40, cache_read: 7, cache_creation: 3 });

  // Two more messages, one split across batches: still once each.
  const r2 = createRecords({ seed: 22 });
  r2.assistant(['a', 'b'], { messageId: 'msg_01BBB', usage: { input_tokens: 10, output_tokens: 1 } });
  const recs = toRecs(r2.records);
  const one = foldMeta(out.state, recs.slice(0, 1), {});
  const two = foldMeta(one.state, recs.slice(1), {});
  assert.deepEqual(two.state.tokens, { input: 110, output: 41, cache_read: 7, cache_creation: 3 });
  assert.equal(two.patch, null, 'the repeated usage changed nothing');
  // The same records folded again (a re-read) count nothing more.
  const again = foldMeta(two.state, recs, {});
  assert.deepEqual(again.state.tokens, two.state.tokens);
});

test('a message whose usage grows across its blocks counts with the latest usage', () => {
  const r = createRecords({ seed: 23 });
  r.assistant(['x'], { messageId: 'msg_01CCC', usage: { input_tokens: 50, output_tokens: 1 } });
  r.assistant(['y'], { messageId: 'msg_01CCC', usage: { input_tokens: 50, output_tokens: 9 } });
  const out = fold(r.records, {});
  assert.deepEqual(out.state.tokens, { input: 50, output: 9, cache_read: 0, cache_creation: 0 });
});

test('the counted message ids are bounded', () => {
  const r = createRecords({ seed: 24 });
  for (let i = 0; i < COUNTED_MAX + 20; i++) r.assistant(['t'], { messageId: `msg_${i}`, usage: { input_tokens: 1, output_tokens: 0 } });
  const out = fold(r.records, {});
  assert.equal(out.state.counted.length, COUNTED_MAX);
  assert.equal(out.state.tokens.input, COUNTED_MAX + 20);
});

test('cost: usd null while live; cost-state sets it with source cost-state', () => {
  const r = createRecords({ seed: 31 });
  r.prompt('go');
  r.assistant(['done'], { messageId: 'msg_01D', usage: { input_tokens: 5, output_tokens: 6 } });
  const live = fold(r.records, {});
  assert.deepEqual(live.patch.cost, { usd: null, source: null, tokens: { input: 5, output: 6, cache_read: 0, cache_creation: 0 } });
  r.costState({ totalCostUSD: 1.25 });
  const ended = foldMeta(live.state, toRecs(r.records.slice(-1)), {});
  assert.deepEqual(ended.patch.cost, { usd: 1.25, source: 'cost-state', tokens: { input: 5, output: 6, cache_read: 0, cache_creation: 0 } });
});

test('model, effort, permission_mode, mode: last value wins; <synthetic> is no model', () => {
  const r = createRecords({ seed: 41 });
  r.permissionMode('default');
  r.mode('normal');
  r.assistant(['one'], { model: 'claude-opus-5-5', effort: 'high' });
  r.permissionMode('acceptEdits');
  r.mode('plan');
  r.attachment('model', { identity: { modelId: 'claude-fable-5-1', marketingName: 'Fable' }, text: 'Model changed' });
  r.assistant(['err'], { model: '<synthetic>', effort: 'xhigh' });
  const out = fold(r.records, {});
  assert.equal(out.patch.model, 'claude-fable-5-1');
  assert.equal(out.patch.effort, 'xhigh');
  assert.equal(out.patch.permission_mode, 'acceptEdits');
  assert.equal(out.patch.mode, 'plan');
  r.assistant(['two'], { model: 'claude-haiku-4-5' });
  const later = foldMeta(out.state, toRecs(r.records.slice(-1)), {});
  assert.equal(later.patch.model, 'claude-haiku-4-5');
});

test('away: the latest away_summary, with its time', () => {
  const r = createRecords({ seed: 51 });
  r.awaySummary('First recap.');
  const second = r.awaySummary('Second recap.');
  const out = fold(r.records, {});
  assert.deepEqual(out.patch.away, { text: 'Second recap.', at: Date.parse(second.timestamp) });
});

test('skills: initial replaces, delta adds, a later initial with fewer names never removes; descriptions parsed', () => {
  const r = createRecords({ seed: 61 });
  r.skillListing({ isInitial: true, names: ['review', 'deploy', 'plugin-x:lint'],
    descriptions: { review: 'Review a diff.', deploy: 'Ship it: carefully.', 'plugin-x:lint': 'Lint the tree.' } });
  let out = fold(r.records, {});
  assert.deepEqual(out.state.skills.names, ['review', 'deploy', 'plugin-x:lint']);
  assert.deepEqual(out.state.skills.descriptions,
    { review: 'Review a diff.', deploy: 'Ship it: carefully.', 'plugin-x:lint': 'Lint the tree.' });

  r.skillListing({ isInitial: false, names: ['probe-late'], descriptions: { 'probe-late': 'Added between turns.' } });
  out = foldMeta(out.state, toRecs(r.records.slice(-1)), {});
  assert.deepEqual(out.state.skills.names, ['review', 'deploy', 'plugin-x:lint', 'probe-late']);
  assert.equal(out.state.skills.descriptions['probe-late'], 'Added between turns.');

  r.skillListing({ isInitial: true, names: ['deploy'], descriptions: { deploy: 'Ship it, v2.' } });
  out = foldMeta(out.state, toRecs(r.records.slice(-1)), {});
  assert.deepEqual(out.state.skills.names.slice().sort(), ['deploy', 'plugin-x:lint', 'probe-late', 'review']);
  assert.equal(out.state.skills.names[0], 'deploy', "the initial's names come first");
  assert.equal(out.state.skills.descriptions.deploy, 'Ship it, v2.');
  assert.equal(out.state.skills.descriptions.review, 'Review a diff.', 'a name the initial left out keeps its description');
});

test('a skill named __proto__ is data, not a prototype', () => {
  const r = createRecords({ seed: 62 });
  r.skillListing({ isInitial: true, names: ['__proto__'], descriptions: { ['__proto__']: 'odd' } });
  const out = fold(r.records, {});
  assert.equal(Object.getPrototypeOf(out.state.skills.descriptions), Object.prototype);
  assert.ok(Object.hasOwn(out.state.skills.descriptions, '__proto__'));
  const back = foldMeta(JSON.parse(JSON.stringify(out.state)), [], {});
  assert.equal(Object.getPrototypeOf(back.state.skills.descriptions), Object.prototype);
});

test('known values come back in `known` and never appear in the state', () => {
  const r = createRecords({ seed: 71 });
  const org = 'f3a1c0de-1111-4222-8333-444455556666';
  const email = 'someone-7c1f@example.com';
  r.credentialOrg(org);
  r.sessionContext({ userEmail: email });
  r.prompt(`Hello`);
  r.aiTitle('A title');
  r.credentialOrg(org);      // a repeat in one batch is returned once
  const out = fold(r.records, { sessionName: 'n' });
  assert.deepEqual(out.known, [{ value: org, label: 'org-id' }, { value: email, label: 'account-email' }]);
  const json = JSON.stringify(out.state);
  assert.ok(!json.includes(org), 'no org id in the state');
  assert.ok(!json.includes(email), 'no account email in the state');
  assert.ok(!JSON.stringify(out.patch).includes(org) && !JSON.stringify(out.patch).includes(email));
  // The rendered copy of the email is never read either.
  assert.ok(!json.includes('Session context for'));
});

test('only session_context context.userEmail is the account email', () => {
  const r = createRecords({ seed: 72 });
  r.attachment('session_context', { context: { userEmail: 'a-1@example.com', otherEmail: 'b-2@example.com' } });
  const out = fold(r.records, {});
  assert.deepEqual(out.known, [{ value: 'a-1@example.com', label: 'account-email' }]);
});

test('foldEnvelope takes model and permission_mode from a SessionStart envelope', () => {
  const env = { v: 1, event: 'SessionStart', ts: 1, session_id: 's1', permission_mode: 'plan',
    session: { source: 'startup', model: 'claude-opus-5-5', title: null, reason: null, agent_type: null }, agent: null };
  const out = foldEnvelope(initialMeta(), env);
  assert.equal(out.state.model, 'claude-opus-5-5');
  assert.equal(out.state.permission_mode, 'plan');
  assert.equal(out.patch.model, 'claude-opus-5-5');
  assert.equal(out.patch.permission_mode, 'plan');
  // Any main-thread envelope carries permission_mode; a subagent's does not count.
  const pre = foldEnvelope(out.state, { v: 1, event: 'PreToolUse', permission_mode: 'acceptEdits', agent: null });
  assert.equal(pre.patch.permission_mode, 'acceptEdits');
  const sub = foldEnvelope(pre.state, { v: 1, event: 'PreToolUse', permission_mode: 'default', agent: { id: 'a1', type: 'x' } });
  assert.equal(sub.patch, null);
  // A model from a non-SessionStart envelope is not read.
  const stop = foldEnvelope(pre.state, { v: 1, event: 'Stop', session: { model: 'other' }, agent: null });
  assert.equal(stop.patch, null);
});

test('both folds are pure: the input state is never mutated, and the state survives JSON', () => {
  const r = createRecords({ seed: 81 });
  r.prompt('Start');
  r.assistant(['x'], { messageId: 'msg_01E', usage: { input_tokens: 3, output_tokens: 4 } });
  r.skillListing({ isInitial: true, names: ['review'] });
  r.awaySummary('Recap.');
  const first = fold(r.records, {});
  const frozen = JSON.stringify(first.state);
  r.assistant(['y'], { messageId: 'msg_01F', usage: { input_tokens: 1, output_tokens: 1 } });
  r.skillListing({ isInitial: false, names: ['deploy'] });
  r.aiTitle('New');
  foldMeta(first.state, toRecs(r.records.slice(-3)), {});
  foldEnvelope(first.state, { event: 'SessionStart', permission_mode: 'plan', session: { model: 'm' } });
  assert.equal(JSON.stringify(first.state), frozen, 'the given state is untouched');

  // Same input, same output; and a JSON round trip of the state folds the same.
  const a = foldMeta(first.state, toRecs(r.records.slice(-3)), {});
  const b = foldMeta(JSON.parse(frozen), toRecs(r.records.slice(-3)), {});
  assert.deepEqual(a, b);
});

test('records the table does not route to meta, and malformed input, change nothing', () => {
  const r = createRecords({ seed: 91 });
  r.toolResult('toolu_01X', 'ok');
  r.turnDuration();
  r.meta('unknown-kind', { aiTitle: 'not a title' });
  const recs = [...toRecs(r.records), { line: 'x', obj: null, bad: true }, null, { obj: 'string' }];
  const out = foldMeta(initialMeta(), recs, {});
  assert.equal(out.title, null);
  assert.deepEqual(out.known, []);
  assert.deepEqual(out.patch, null);
  assert.deepEqual(foldMeta(undefined, undefined).state, initialMeta());
  assert.deepEqual(foldMeta({ v: 99, title: 'x' }, []).state, initialMeta(), 'an unknown state version starts over');
});
