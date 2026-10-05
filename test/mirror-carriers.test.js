// The carriers fold (lib/server/mirror/carriers.js): task notifications paired
// across their three carriers, typed-while-busy messages, and web-chat's
// delivery markers (spec §2.5 "Carriers", §2.6 `delivered`, §6.6, V5, V11).

const test = require('node:test');
const assert = require('node:assert/strict');

const { initialCarriers, foldCarriers, parseNotifications, MARKERS_MAX } = require('../lib/server/mirror/carriers');
const { createRecords, taskNotificationText, channelText } = require('../test-support/claude-records');

function toRecs(records, from = 0) {
  let at = from;
  return records.flat().map((obj) => {
    const line = JSON.stringify(obj);
    const start = at;
    at += Buffer.byteLength(line) + 1;
    return { line, obj, bad: false, oversize: false, start, end: at };
  });
}

const fold = (records, state = initialCarriers()) => foldCarriers(state, toRecs(records));
const tasks = (out) => out.changes.filter((c) => c.item.kind === 'task');

const NOTE = { taskId: 'b7f3k2q9', toolUseId: 'toolu_01BG', outputFile: '/tmp/claude-501/x/tasks/b7f3k2q9.output',
  status: 'completed', summary: 'Background command "build" completed (exit code 0)' };

// The three carriers of one notification, each a builder call on `r`.
const CARRIERS = {
  enqueue: (r, text) => r.queueOperation('enqueue', { content: text }),
  user: (r, _text, opts) => r.taskNotification(opts),
  queued: (r, text) => r.queuedCommand(text, { commandMode: 'task-notification' }),
};

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('one notification through all three carriers, in each of the six orders, is one task item', () => {
  const orders = permutations(['enqueue', 'user', 'queued']);
  assert.equal(orders.length, 6);
  for (const order of orders) {
    const r = createRecords({ seed: 100 + orders.indexOf(order) });
    r.prompt('start a build');
    const text = taskNotificationText(NOTE);
    const made = order.map((c) => CARRIERS[c](r, text, NOTE));
    const out = fold(r.records);
    const t = tasks(out);
    assert.equal(t.length, 1, `order ${order.join(' → ')}`);
    // Made at the first delivery carrier, never at the enqueue.
    const firstDelivery = made[order.findIndex((c) => c !== 'enqueue')];
    assert.equal(t[0].uuid, firstDelivery.uuid, `order ${order.join(' → ')}`);
    assert.deepEqual(t[0].item, {
      id: `t_b7f3k2q9_${firstDelivery.uuid}`, kind: 'task', task_id: 'b7f3k2q9', task_kind: 'shell',
      status: 'done', summary: NOTE.summary, exit_code: 0,
    });
    // Every order also pairs across batches, one record at a time.
    let state = initialCarriers();
    let n = 0;
    for (const rec of toRecs(r.records)) {
      const step = foldCarriers(state, [rec]);
      n += tasks(step).length;
      state = step.state;
    }
    assert.equal(n, 1, `order ${order.join(' → ')}, record by record`);
  }
});

test('two notifications with equal text and different delivery ids are two items', () => {
  const r = createRecords({ seed: 120 });
  const text = taskNotificationText(NOTE);
  r.queueOperation('enqueue', { content: text });
  r.queueOperation('enqueue', { content: text });
  r.attachment('queued_command', { prompt: text, commandMode: 'task-notification', delivery_id: 'dlv_1' });
  r.attachment('queued_command', { prompt: text, commandMode: 'task-notification', delivery_id: 'dlv_2' });
  assert.equal(tasks(fold(r.records)).length, 2);

  // A user delivery and a queued_command with different delivery ids never pair.
  const r2 = createRecords({ seed: 121 });
  r2.taskNotification({ ...NOTE, extra: { deliveryId: 'dlv_1' } });
  r2.attachment('queued_command', { prompt: taskNotificationText(NOTE), commandMode: 'task-notification', delivery_id: 'dlv_2' });
  assert.equal(tasks(fold(r2.records)).length, 2);

  // The same delivery id on both pairs them.
  const r3 = createRecords({ seed: 122 });
  r3.taskNotification({ ...NOTE, extra: { deliveryId: 'dlv_1' } });
  r3.attachment('queued_command', { prompt: taskNotificationText(NOTE), commandMode: 'task-notification', delivery_id: 'dlv_1' });
  assert.equal(tasks(fold(r3.records)).length, 1);

  // Without delivery ids, two deliveries of one text are two notifications (the multiset).
  const r4 = createRecords({ seed: 123 });
  r4.queuedCommand(taskNotificationText(NOTE), { commandMode: 'task-notification' });
  r4.queuedCommand(taskNotificationText(NOTE), { commandMode: 'task-notification' });
  const t4 = tasks(fold(r4.records));
  assert.equal(t4.length, 2);
  assert.notEqual(t4[0].item.id, t4[1].item.id);
});

test('a repeated identical notification is a new item even after an earlier one was delivered', () => {
  // A monitor firing the same event twice: idle the first time (enqueue, user
  // record), mid-turn the second (enqueue, queued_command). The second delivery
  // must not fold into the first, already delivered, notification.
  const EVT = { taskId: 'b5555555', status: null, summary: 'Monitor event', event: 'tick' };
  const text = taskNotificationText(EVT);
  const r = createRecords({ seed: 125 });
  r.queueOperation('enqueue', { content: text });
  r.taskNotification(EVT);
  r.queueOperation('enqueue', { content: text });
  r.queuedCommand(text, { commandMode: 'task-notification' });
  const t = tasks(fold(r.records));
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((c) => [c.item.status, c.item.event]), [['running', 'tick'], ['running', 'tick']]);
});

test('two notification blocks of one task in one record are two items with distinct ids', () => {
  const r = createRecords({ seed: 126 });
  const text = `${taskNotificationText({ taskId: 'b6666666', status: null, summary: 'Monitor event', event: 'one' })}\n`
    + taskNotificationText({ taskId: 'b6666666', status: null, summary: 'Monitor event', event: 'two' });
  const del = r.queuedCommand(text, { commandMode: 'task-notification' });
  const t = tasks(fold(r.records));
  assert.deepEqual(t.map((c) => [c.item.id, c.item.event]),
    [[`t_b6666666_${del.uuid}`, 'one'], [`t_b6666666_${del.uuid}_1`, 'two']]);
});

test('task item fields: kinds, statuses, exit codes and monitor events', () => {
  const r = createRecords({ seed: 130 });
  r.queuedCommand(taskNotificationText({ taskId: 'b1111111', status: 'failed', summary: 'Background command "t" failed with exit code 3' }),
    { commandMode: 'task-notification' });
  r.queuedCommand(taskNotificationText({ taskId: 'a0123456789abcdef', status: 'completed', summary: 'Agent "x" completed' }),
    { commandMode: 'task-notification' });
  r.queuedCommand(taskNotificationText({ taskId: 'b2222222', status: null, summary: 'Monitor event', event: 'server ready on :5173' }),
    { commandMode: 'task-notification' });
  r.queuedCommand(taskNotificationText({ taskId: 'wabc12345', status: 'killed', summary: 'Workflow "w" was stopped' }),
    { commandMode: 'task-notification' });
  r.queuedCommand(taskNotificationText({ taskId: 'b3333333', status: 'completed', summary: 'Monitor "m" script failed (exit 2)' }),
    { commandMode: 'task-notification' });
  // A shell whose summary quotes a description that says "monitor" is still a shell.
  r.queuedCommand(taskNotificationText({ taskId: 'b1234567', status: 'completed',
    summary: 'Background command "restart the monitor daemon" completed (exit code 0)' }), { commandMode: 'task-notification' });
  const items = tasks(fold(r.records)).map((c) => c.item);
  assert.deepEqual(items.map((i) => [i.task_kind, i.status, i.exit_code]), [
    ['shell', 'failed', 3],
    ['agent', 'done', undefined],
    ['monitor', 'running', undefined],
    ['workflow', 'killed', undefined],
    ['monitor', 'done', 2],
    ['shell', 'done', 0],
  ]);
  assert.equal(items[2].event, 'server ready on :5173');
  assert.ok(!('event' in items[0]));
});

// The item each queued id ends as, its changes merged in order (as the model
// merges an item's writes field by field).
function queuedItems(out) {
  const by = new Map();
  for (const c of out.changes) if (c.item.kind === 'queued') by.set(c.item.id, { ...(by.get(c.item.id) || {}), ...c.item });
  return [...by.values()];
}

test('a typed-while-busy message becomes a queued item; a queue-operation content is never read into a change', () => {
  // A typed enqueue alone: one queued item, waiting.
  const r0 = createRecords({ seed: 139 });
  r0.prompt('refactor the parser');
  r0.queueOperation('enqueue', { content: 'also check the README' });
  const recs0 = toRecs(r0.records);
  const out0 = foldCarriers(initialCarriers(), recs0);
  assert.equal(out0.changes.length, 1);
  const [c0] = out0.changes;
  assert.deepEqual(c0.item, { id: `q_o${recs0[1].start}`, kind: 'queued', text: 'also check the README', status: 'queued' });
  assert.deepEqual(c0.offset, { start: recs0[1].start, end: recs0[1].end });
  assert.ok(Number.isFinite(c0.ts));
  assert.ok(!('uuid' in c0), 'an enqueue has no uuid');
  assert.ok(!('seq' in c0) && !('seq' in c0.item));
  assert.ok(!JSON.stringify(out0.state).includes('README'), 'the state keeps a digest, never the text');

  // enqueue → remove(absorbed_mid_turn) → queued_command: ONE item, absorbed.
  const r = createRecords({ seed: 140 });
  r.prompt('refactor the parser');
  r.queueOperation('enqueue', { content: 'also check the README' });
  r.queueOperation('remove', { content: 'also check the README', reason: 'absorbed_mid_turn' });
  r.queuedCommand('also check the README', { commandMode: 'prompt' });
  // A notification whose only carrier in this file is the enqueue (a subagent's task).
  r.queueOperation('enqueue', { content: taskNotificationText({ ...NOTE, taskId: 'b9999999', summary: 'ENQUEUE-ONLY-SUMMARY' }) });
  r.queueOperation('dequeue');
  const recs = toRecs(r.records);
  const out = foldCarriers(initialCarriers(), recs);
  assert.deepEqual(queuedItems(out), [{ id: `q_o${recs[1].start}`, kind: 'queued', text: 'also check the README', status: 'absorbed' }]);
  assert.equal(tasks(out).length, 0);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('ENQUEUE-ONLY-SUMMARY'), "a notification enqueue's content is never read into a change");
  assert.ok(!JSON.stringify(out.state).includes('b9999999'), 'the state keeps a digest, never the text');
  assert.ok(!JSON.stringify(out.state).includes('README'));

  // The order the corpus shows (V5): enqueue → queued_command → remove. One item.
  const r1 = createRecords({ seed: 142 });
  r1.prompt('refactor the parser');
  r1.queueOperation('enqueue', { content: 'also check the README' });
  r1.queuedCommand('also check the README', { commandMode: 'prompt' });
  r1.queueOperation('remove', { content: 'also check the README', reason: 'absorbed_mid_turn' });
  const recs1 = toRecs(r1.records);
  assert.deepEqual(queuedItems(foldCarriers(initialCarriers(), recs1)),
    [{ id: `q_o${recs1[1].start}`, kind: 'queued', text: 'also check the README', status: 'absorbed' }]);

  // A dequeue sends it (it opens the next turn as a prompt); a dequeue names no
  // content, so it pops the queue's head — a notification enqueued first is popped first.
  const r2q = createRecords({ seed: 143 });
  r2q.prompt('refactor the parser');
  r2q.queueOperation('enqueue', { content: taskNotificationText(NOTE) });
  r2q.queueOperation('enqueue', { content: 'then run the tests' });
  r2q.queueOperation('dequeue');
  const mid = foldCarriers(initialCarriers(), toRecs(r2q.records));
  assert.deepEqual(queuedItems(mid).map((i) => i.status), ['queued']);
  r2q.queueOperation('dequeue');
  assert.deepEqual(queuedItems(fold(r2q.records)).map((i) => [i.text, i.status]), [['then run the tests', 'sent']]);

  // Any other remove marks it removed.
  const r3q = createRecords({ seed: 144 });
  r3q.queueOperation('enqueue', { content: 'never mind' });
  r3q.queueOperation('remove', { content: 'never mind' });
  assert.deepEqual(queuedItems(fold(r3q.records)).map((i) => i.status), ['removed']);

  // A queued_command with no enqueue before it (a subagent's file) keeps its own item.
  const r4q = createRecords({ seed: 145 });
  const qc = r4q.queuedCommand('also check the README', { commandMode: 'prompt' });
  const out4 = fold(r4q.records);
  assert.deepEqual(out4.changes.map((c) => c.item), [{ id: `q_${qc.uuid}`, kind: 'queued', text: 'also check the README', status: 'absorbed' }]);
  assert.equal(out4.changes[0].uuid, qc.uuid);

  // A fresh-state fold of the turn's byte range names the same queued item (U28a's refill).
  const rr = createRecords({ seed: 146 });
  rr.prompt('first');
  rr.assistant(['ok']);
  rr.turnDuration();
  const turn = rr.records.length;
  rr.prompt('refactor the parser');
  rr.queueOperation('enqueue', { content: 'also check the README' });
  rr.queuedCommand('also check the README', { commandMode: 'prompt' });
  rr.queueOperation('remove', { content: 'also check the README', reason: 'absorbed_mid_turn' });
  rr.assistant(['done']);
  rr.turnDuration();
  const all = toRecs(rr.records);
  const whole = foldCarriers(initialCarriers(), all);
  const range = foldCarriers(initialCarriers(), all.slice(turn));
  assert.deepEqual(range.changes, whole.changes);
  assert.deepEqual(queuedItems(range), [{ id: `q_o${all[turn + 1].start}`, kind: 'queued', text: 'also check the README', status: 'absorbed' }]);

  // A paired notification's change is built from the delivery record alone.
  const r2 = createRecords({ seed: 141 });
  r2.queueOperation('enqueue', { content: taskNotificationText(NOTE) });
  const del = r2.queuedCommand(taskNotificationText(NOTE), { commandMode: 'task-notification' });
  const [ch] = fold(r2.records).changes;
  const [rec] = toRecs(r2.records).slice(1);
  assert.equal(ch.uuid, del.uuid);
  assert.deepEqual(ch.offset, { start: rec.start, end: rec.end });
  assert.equal(ch.ts, Date.parse(del.timestamp));
});

test('delivery markers: a channel record, a channel queued_command and a hook context, once each, with the right via', () => {
  const r = createRecords({ seed: 150 });
  r.channel({ body: 'Message from the user [web-chat message m-0000000a]\nhi' });
  r.queuedCommand(channelText({ body: '[web-chat message m-0000000b] mid-turn' }),
    { commandMode: 'prompt', origin: { kind: 'channel', server: 'web-chat' } });
  r.hookAdditionalContext('Delivered with your prompt: [web-chat message m-0000000c]');
  // A marker a tool result echoes, and one in a typed message, confirm nothing.
  r.toolResult('toolu_01ECHO', 'cat log: [web-chat message m-0000000d]');
  r.queuedCommand('see [web-chat message m-0000000e]', { commandMode: 'prompt' });
  // A user record whose text blocks hold a marker and a tool_result block holding another.
  r.user([{ type: 'text', text: '<channel source="web-chat">[web-chat message m-0000000f]</channel>' },
    { type: 'tool_result', tool_use_id: 'toolu_01Z', content: '[web-chat message m-00000010]' }]);
  const out = fold(r.records);
  assert.deepEqual(out.delivered.map(({ via, marker }) => ({ via, marker })), [
    { via: 'channel', marker: 'm-0000000a' },
    { via: 'channel', marker: 'm-0000000b' },
    { via: 'parked', marker: 'm-0000000c' },
  ]);
  const recs = toRecs(r.records);
  assert.deepEqual(out.delivered[0].offset, { start: recs[0].start, end: recs[0].end });
  assert.deepEqual(out.state.markers, ['m-0000000a', 'm-0000000b', 'm-0000000c']);
});

test('a repeated record does not deliver twice, in one batch or the next', () => {
  const r = createRecords({ seed: 160 });
  const ch = r.channel({ body: '[web-chat message m-12345678] and again [web-chat message m-12345678]' });
  const once = foldCarriers(initialCarriers(), toRecs([ch, ch]));
  assert.equal(once.delivered.length, 1);
  const twice = foldCarriers(once.state, toRecs([ch]));
  assert.equal(twice.delivered.length, 0);
  // Every hook context is scanned (the parked prefix is not importable here).
  const r2 = createRecords({ seed: 161 });
  r2.hookAdditionalContext(['first line', 'second [web-chat message m-87654321]'], { hookEvent: 'PreToolUse' });
  assert.deepEqual(fold(r2.records).delivered.map((d) => d.via), ['parked']);
});

test('the remembered markers are bounded', () => {
  const r = createRecords({ seed: 170 });
  for (let i = 0; i < MARKERS_MAX + 5; i++) r.hookAdditionalContext(`[web-chat message m-${i.toString(16).padStart(8, '0')}]`);
  const out = fold(r.records);
  assert.equal(out.delivered.length, MARKERS_MAX + 5);
  assert.equal(out.state.markers.length, MARKERS_MAX);
  assert.equal(out.state.markers[0], `m-${(5).toString(16).padStart(8, '0')}`);
});

test('changes carry ts, offset and uuid, and no seq', () => {
  const r = createRecords({ seed: 180 });
  r.queueOperation('enqueue', { content: taskNotificationText(NOTE) });
  r.taskNotification(NOTE);
  r.queuedCommand('typed while busy', { commandMode: 'prompt' });
  const out = fold(r.records);
  assert.equal(out.changes.length, 2);
  for (const c of out.changes) {
    assert.equal(c.type, 'item');
    assert.ok(Number.isFinite(c.ts));
    assert.ok(Number.isFinite(c.offset.start) && c.offset.end > c.offset.start);
    assert.equal(typeof c.uuid, 'string');
    assert.ok(!('seq' in c), 'no seq on the change');
    assert.ok(!('seq' in c.item), 'no seq on the item');
  }
});

test("folding one turn's byte range with a fresh state gives the whole-file fold's task items (U28a's refill)", () => {
  const r = createRecords({ seed: 190 });
  // Turn 1: a background build starts.
  r.prompt('build it in the background');
  const [use] = r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'make', run_in_background: true } }]);
  r.toolResult(use.message.content[0].id, 'Command running in background with ID: b7f3k2q9.', { taskId: 'b7f3k2q9' });
  r.assistant(['Started.']);
  r.turnDuration();
  // Turn 2: busy when the build ends; absorbed mid-turn.
  const turn2 = r.records.length;
  r.prompt('meanwhile, read the README');
  r.queueOperation('enqueue', { content: taskNotificationText(NOTE) });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/README.md' } }]);
  r.queuedCommand(taskNotificationText(NOTE), { commandMode: 'task-notification' });
  r.queueOperation('remove', { content: taskNotificationText(NOTE), reason: 'absorbed_mid_turn' });
  r.turnDuration();
  // Turn 3: idle when a second task ends; the notification opens the turn.
  const NOTE2 = { ...NOTE, taskId: 'b8a8a8a8', summary: 'Background command "test" failed with exit code 1', status: 'failed' };
  r.queueOperation('enqueue', { content: taskNotificationText(NOTE2) });
  r.queueOperation('dequeue');
  const turn3 = r.records.length;
  r.taskNotification(NOTE2);
  r.assistant(['The tests failed.']);
  r.turnDuration();

  const all = toRecs(r.records);
  const whole = foldCarriers(initialCarriers(), all);
  const wholeTasks = tasks(whole);
  assert.equal(wholeTasks.length, 2);

  const range2 = foldCarriers(initialCarriers(), all.slice(turn2, turn3 - 2));
  const range3 = foldCarriers(initialCarriers(), all.slice(turn3));
  assert.deepEqual(tasks(range2), [wholeTasks[0]]);
  assert.deepEqual(tasks(range3), [wholeTasks[1]]);
  // The offsets are the file's, so the refill merges by offset with the normalizer.
  assert.equal(tasks(range3)[0].offset.start, all[turn3].start);
});

test('the fold is pure: the given state is untouched, and a JSON round trip folds the same', () => {
  const r = createRecords({ seed: 200 });
  r.queueOperation('enqueue', { content: taskNotificationText(NOTE) });
  r.channel({ body: '[web-chat message m-aaaaaaaa]' });
  const first = fold(r.records);
  const frozen = JSON.stringify(first.state);
  const more = createRecords({ seed: 201 });
  more.taskNotification(NOTE);
  more.hookAdditionalContext('[web-chat message m-bbbbbbbb]');
  const a = foldCarriers(first.state, toRecs(more.records));
  assert.equal(JSON.stringify(first.state), frozen);
  const b = foldCarriers(JSON.parse(frozen), toRecs(more.records));
  assert.deepEqual(a, b);
  assert.equal(tasks(a).length, 1, 'the enqueue from the earlier batch did not make an item; the delivery did');
});

test('malformed input reads as nothing', () => {
  const out = foldCarriers(undefined, [null, { obj: null, bad: true }, { obj: [] }, { obj: { type: 'queue-operation', operation: 'enqueue', content: 7 } },
    { obj: { type: 'attachment', attachment: { type: 'queued_command', prompt: 42, commandMode: 'task-notification' } } }]);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.delivered, []);
  assert.deepEqual(foldCarriers({ v: 2, markers: ['m-00000001'] }, []).state, initialCarriers());
  // A notification block with neither a task id nor a tool-use id is skipped.
  const r = createRecords({ seed: 210 });
  r.queuedCommand('<task-notification>\n<summary>orphan</summary>\n</task-notification>', { commandMode: 'task-notification' });
  assert.deepEqual(fold(r.records).changes, []);
});

test('parseNotifications reads every block and its tags', () => {
  const text = `${taskNotificationText(NOTE)}\n${taskNotificationText({ taskId: 'b2', event: 'tick', status: null, summary: 's' })}`;
  const blocks = parseNotifications(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].tags['task-id'], 'b7f3k2q9');
  assert.equal(blocks[0].tags['output-file'], NOTE.outputFile);
  assert.equal(blocks[1].tags.event, 'tick');
  assert.deepEqual(parseNotifications('no block here'), []);
  assert.deepEqual(parseNotifications(null), []);
});
