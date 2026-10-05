// The normalizer (lib/server/mirror/normalize.js, spec §2.4, §5.5, §15.4 case c):
// transcript records → exactly turn-machine.js's change contract plus
// `rewind-evidence`, run through a real model and turn machine. Records are
// built with test-support/claude-records.js; nothing here is a real transcript.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { normalize, initialState } = require('../lib/server/mirror/normalize');
const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine } = require('../lib/server/mirror/turn-machine');
const { createRedactor, WITHHELD, NEVER_EMIT } = require('../lib/core/redact');
const { createRecords, jsonl, TINY_PNG } = require('../test-support/claude-records');

const CONTRACT = new Set(['opener', 'item', 'turn-duration', 'interrupt', 'compact', 'compact-summary',
  'permission-decision', 'record', 'rewind-evidence']);

// What the tailer hands over: one rec per non-empty line, with byte offsets.
function recsOf(records) {
  const text = jsonl(records);
  const buf = Buffer.from(text, 'utf8');
  const out = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl < 0) nl = buf.length;
    const line = buf.subarray(start, nl).toString('utf8');
    if (line) {
      let obj = null;
      try { const v = JSON.parse(line); if (v && typeof v === 'object' && !Array.isArray(v)) obj = v; } catch { /* bad */ }
      out.push({ line, obj, bad: !obj, oversize: false, start, end: nl + 1 });
    }
    start = nl + 1;
  }
  return out;
}

function run(records, state = initialState()) {
  return normalize(recsOf(records), state, { session_id: 'sess' });
}

function machine() {
  const model = createModel({ redactor: createRedactor() });
  const tm = createTurnMachine({ model });
  return { model, tm };
}

const items = (changes, kind) => changes.filter((c) => c.type === 'item' && (!kind || c.item.kind === kind));
const last = (list, id) => list.filter((c) => c.item.id === id).at(-1);

// ── one turn, end to end ───────────────────────────────────────────────────

function oneTurn(r) {
  const prompt = r.prompt('Fix the build please');
  const m1 = r.assistant([
    { type: 'thinking', thinking: 'Let me think about the build.' },
    'I will look at the build',
    'and then run the tests.',
  ], { messageId: 'msg_01one' });
  const m2 = r.assistant([
    { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/package.json' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
  ], { messageId: 'msg_01two' });
  const read = m2[0].message.content[0].id;
  const bash = m2[1].message.content[0].id;
  r.toolResult(read, '{"name":"x"}');
  r.toolResult(bash, 'all tests passed');
  r.assistant(['The build is fixed.'], { messageId: 'msg_01three' });
  r.turnDuration({ durationMs: 9000, messageCount: 8 });
  return { prompt, m1, read, bash };
}

test('one turn: an opener with ts, a joined reply, one thinking, two tool calls done', () => {
  const r = createRecords({ seed: 11 });
  const { prompt, read, bash } = oneTurn(r);
  const { changes, diag } = run(r.records);
  for (const c of changes) assert.ok(CONTRACT.has(c.type), `contract type: ${c.type}`);

  const openers = changes.filter((c) => c.type === 'opener');
  assert.strictEqual(openers.length, 1);
  assert.strictEqual(openers[0].prompt_id, prompt.promptId);
  assert.strictEqual(openers[0].ts, Date.parse(prompt.timestamp));
  assert.strictEqual(openers[0].kind, 'prompt');
  assert.strictEqual(openers[0].origin, 'human');
  assert.strictEqual(openers[0].text, 'Fix the build please');
  assert.strictEqual(openers[0].uuid, prompt.uuid);
  assert.ok('parent_uuid' in openers[0]);

  const reply = last(items(changes, 'reply'), 'r_msg_01one');
  assert.strictEqual(reply.item.text, 'I will look at the build\n\nand then run the tests.');
  assert.strictEqual(reply.item.message_id, 'msg_01one');
  assert.strictEqual(reply.item.model, 'claude-opus-5-5');
  const th = items(changes, 'thinking');
  assert.strictEqual(new Set(th.map((c) => c.item.id)).size, 1);
  assert.strictEqual(th[0].item.chars, 'Let me think about the build.'.length);
  assert.ok(!JSON.stringify(changes).includes('fake-signature-'), 'never the thinking signature');

  const tools = items(changes, 'tool_call');
  const done = (id) => last(tools, id);
  assert.strictEqual(done(read).item.status, 'done');
  assert.strictEqual(done(bash).item.status, 'done');
  const call = tools.find((c) => c.item.id === bash && c.item.status === 'running').item;
  assert.strictEqual(call.tool, 'Bash');
  assert.strictEqual(call.tool_kind, 'Bash');
  assert.strictEqual(call.label, 'Bash · npm test');
  assert.strictEqual(call.input.command, 'npm test');
  assert.deepStrictEqual(done(bash).context, { command: 'npm test' });
  assert.deepStrictEqual(done(read).context, { file: '/tmp/project/package.json' });
  assert.strictEqual(done(read).item.seq, tools.find((c) => c.item.id === read).seq, 'the result does not move the call');

  const td = changes.find((c) => c.type === 'turn-duration');
  assert.strictEqual(td.duration_ms, 9000);
  assert.strictEqual(td.message_count, 8);
  assert.deepStrictEqual(diag.unknown_kinds, {});
  assert.strictEqual(diag.bad_lines, 0);

  // Through the real model and turn machine.
  const { model, tm } = machine();
  const res = tm.applyChanges('conv', r.sessionId, changes);
  assert.strictEqual(res.ok, true);
  const turns = model.turnsOf('conv');
  assert.strictEqual(turns.length, 1);
  const t = model.serializeTurn(turns[0].id);
  assert.strictEqual(t.id, prompt.promptId);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.duration_ms, 9000);
  assert.deepStrictEqual(t.counts, { items: 6, tools: 2, tool_errors: 0, agents: 0, tasks: 0, edits: 0 });
  assert.deepStrictEqual(t.tool_names, ['Read', 'Bash']);
  assert.strictEqual(t.groups.length, 1);
  assert.strictEqual(t.groups[0].count, 2);
  assert.strictEqual(`▸ ${t.groups[0].count} tool calls`, '▸ 2 tool calls');
  assert.strictEqual(t.reply_preview, 'The build is fixed.');
  const kinds = model.itemsOf(t.id).map((it) => it.kind);
  assert.deepStrictEqual(kinds, ['prompt', 'thinking', 'reply', 'tool_call', 'tool_call', 'reply']);
  assert.deepStrictEqual(tm.diagnostics(), { unknown_changes: 0, items_without_turn: 0, foreign_turns: 0, ignored_envelopes: 0 });
});

// ── tool results ───────────────────────────────────────────────────────────

test('tool_result variants: error, denied, persisted, structuredPatch, images, links', () => {
  const r = createRecords({ seed: 12 });
  r.prompt('go');
  const calls = r.assistant([
    { type: 'tool_use', name: 'Bash', input: { command: 'false' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/project/lib/x.js', old_string: 'a', new_string: 'b' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/big.log' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/project/lib/y.js', old_string: 'c', new_string: 'd' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/shot.png' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'sleep 100', run_in_background: true } },
  ]);
  const id = (i) => calls[i].message.content[0].id;
  r.toolResult(id(0), 'exit 1', { isError: true });
  r.toolResult(id(1), '', { denied: true });
  r.toolResult(id(2), 'first 2 KB…', { persistedOutputPath: '/tmp/home/.claude/projects/p/s/tool-results/x.txt', persistedOutputSize: 41234 });
  r.toolResult(id(3), 'The file has been updated.', {
    filePath: '/tmp/project/lib/y.js',
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-c', '+d'] }],
  });
  r.toolResult(id(4), 'an image', { images: true });
  r.toolResult(id(5), 'Command running in background with ID: b123.', { taskId: 'b123' });
  const { changes } = run(r.records);
  const res = (i) => last(items(changes, 'tool_call'), id(i)).item;

  assert.strictEqual(res(0).status, 'error');
  assert.strictEqual(res(0).result.is_error, true);
  assert.strictEqual(res(1).status, 'denied');
  assert.strictEqual(res(2).status, 'done');
  assert.strictEqual(res(2).result.full, false);
  assert.strictEqual(res(2).result._persisted, '/tmp/home/.claude/projects/p/s/tool-results/x.txt');
  assert.strictEqual(res(2).result.bytes, 41234);
  assert.deepStrictEqual(res(3).edit, { path: '/tmp/project/lib/y.js', patch: '@@ -1,1 +1,1 @@\n-c\n+d' });
  assert.strictEqual(res(0).result.full, true);
  assert.deepStrictEqual(res(4).result.attachments, [{ n: 1, kind: 'image', media_type: 'image/png', bytes: TINY_PNG.length }]);
  assert.deepStrictEqual(res(5).links, { task_id: 'b123' });

  const b64 = TINY_PNG.toString('base64');
  const all = JSON.stringify(changes);
  assert.ok(!all.includes(b64) && !all.includes(b64.slice(0, 24)), 'no base64 in any change');

  // The model keeps `_persisted` in process; serializeItem drops it.
  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  const stored = model.item(id(2));
  assert.strictEqual(stored.result._persisted, '/tmp/home/.claude/projects/p/s/tool-results/x.txt');
  const out = model.serializeItem(id(2), { level: 'full' });
  assert.strictEqual(out.result.full, false);
  assert.ok(!('_persisted' in out.result));
  assert.ok(!JSON.stringify(out).includes('tool-results'));
  assert.strictEqual(model.serializeItem(id(1)).status, 'denied');
});

test('an interrupt marker as a tool result reads interrupted', () => {
  const r = createRecords({ seed: 13 });
  r.prompt('go');
  const [call] = r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 9' } }]);
  r.toolResult(call.message.content[0].id, '[Request interrupted by user for tool use]', { isError: true });
  r.interrupt({ forToolUse: true });
  const { changes } = run(r.records);
  assert.strictEqual(last(items(changes, 'tool_call'), call.message.content[0].id).item.status, 'interrupted');
  const int = changes.find((c) => c.type === 'interrupt');
  assert.strictEqual(int.text, '[Request interrupted by user for tool use]');
});

// ── the duplicates and the secrets ─────────────────────────────────────────

test('NEVER_EMIT fields seeded with sentinels appear in no change', () => {
  const S = {
    wire: 'SENTINEL_WIRE_7c1', stdout: 'SENTINEL_STDOUT_7c2', stderr: 'SENTINEL_STDERR_7c3', original: 'SENTINEL_ORIG_7c4',
    file: 'SENTINEL_FILECONTENT_7c5', rendered: 'SENTINEL_RENDERED_7c6', sig: 'SENTINEL_SIGNATURE_7c7', queue: 'SENTINEL_QUEUE_7c8',
  };
  const r = createRecords({ seed: 14 });
  r.prompt('go');
  r.assistant([{ type: 'thinking', thinking: 'hm', signature: S.sig }]);
  const [call] = r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.js' } }],
    { extra: { wireToolInputs: { a: S.wire } } });
  r.toolResult(call.message.content[0].id, 'ok', {
    stdout: S.stdout, stderr: S.stderr,
    toolUseResult: { originalFile: S.original, file: { filePath: '/tmp/project/a.js', content: S.file } },
  });
  r.attachment('edited_text_file', { filename: '/tmp/project/b.js', rendered: S.rendered }, { extra: { rendered: S.rendered } });
  r.attachment('file', { filename: '/tmp/project/c.md', content: { rendered: S.rendered } }, { extra: { rendered: S.rendered } });
  r.sessionContext({ rendered: S.rendered });
  r.queueOperation('enqueue', { content: S.queue });
  r.turnDuration();
  const { changes } = run(r.records);
  const all = JSON.stringify(changes);
  for (const [k, v] of Object.entries(S)) assert.ok(!all.includes(v), `${k} leaked`);
  // The fields named are the ones redact.js forbids.
  for (const f of ['wireToolInputs', 'attachment.rendered', 'thinking.signature', 'queue-operation.content',
    'toolUseResult.stdout', 'toolUseResult.stderr', 'toolUseResult.file.content', 'toolUseResult.originalFile']) {
    assert.ok(NEVER_EMIT.fields.includes(f), f);
  }
  // The edited file and the attached file still show, by path.
  assert.ok(items(changes, 'notice').some((c) => c.item.notice === 'file-changed' && c.item.text.includes('/tmp/project/b.js')));
  const p = items(changes, 'prompt').at(-1);
  assert.deepStrictEqual(p.item.attachments, [{ n: 1, kind: 'file', name: '/tmp/project/c.md' }]);
  // A NEVER_EMIT kind and a uuid-less carrier are forwarded as records only.
  assert.ok(changes.some((c) => c.type === 'record' && c.kind === 'attachment/session_context'));
  const q = changes.find((c) => c.type === 'record' && c.kind === 'queue-operation');
  assert.ok(q && !('uuid' in q) && Number.isInteger(q.seq));
});

test('an Edit of a key file: old and new strings WITHHELD, the label and path kept, the output in context', () => {
  const key = path.join(process.env.HOME || '/home/u', '.ssh', 'id_rsa');
  const r = createRecords({ seed: 15 });
  r.prompt('rotate my key');
  const [call] = r.assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: key, old_string: 'OLD-KEY-BYTES', new_string: 'NEW-KEY-BYTES' } }]);
  const [multi] = r.assistant([{ type: 'tool_use', name: 'MultiEdit', input: { file_path: key, edits: [{ old_string: 'OLD2', new_string: 'NEW2' }] } }]);
  const [write] = r.assistant([{ type: 'tool_use', name: 'Write', input: { file_path: `${key}.pub`, content: 'PUBLIC-KEY-TEXT' } }]);
  const [plain] = r.assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/project/a.js', old_string: 'x', new_string: 'y' } }]);
  const useId = call.message.content[0].id;
  r.toolResult(useId, 'The file was updated: OLD-KEY-BYTES', {
    filePath: key, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-OLD-KEY-BYTES', '+NEW-KEY-BYTES'] }],
  });
  const { changes } = run(r.records);
  const running = (id) => items(changes, 'tool_call').find((c) => c.item.id === id && c.item.status === 'running').item;

  const edit = running(useId);
  assert.strictEqual(edit.input.old_string, WITHHELD('ssh'));
  assert.strictEqual(edit.input.new_string, WITHHELD('ssh'));
  assert.strictEqual(edit.input.file_path, key);
  assert.ok(!('old_string_bytes' in edit.input));
  assert.strictEqual(edit.label, 'Edit · id_rsa');
  assert.ok(edit.call.includes('id_rsa'));
  const me = running(multi.message.content[0].id);
  assert.strictEqual(me.input.edits, WITHHELD('ssh'));
  assert.strictEqual(me.input.old_string, WITHHELD('ssh'));
  assert.strictEqual(running(write.message.content[0].id).input.content, WITHHELD('ssh'));
  assert.deepStrictEqual(running(plain.message.content[0].id).input,
    { file_path: '/tmp/project/a.js', old_string_bytes: 1, new_string_bytes: 1 });
  for (const s of ['OLD-KEY-BYTES', 'NEW-KEY-BYTES', 'OLD2', 'PUBLIC-KEY-TEXT']) {
    assert.ok(!JSON.stringify(changes.filter((c) => c.item && c.item.status === 'running')).includes(s), s);
  }

  const out = last(items(changes, 'tool_call'), useId);
  assert.deepStrictEqual(out.context, { file: key });
  // The model's upsert withholds the output and the diff with that context.
  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  const stored = model.serializeItem(useId, { level: 'full' });
  assert.strictEqual(stored.result.preview, WITHHELD('ssh'));
  assert.strictEqual(stored.edit.patch, WITHHELD('ssh'));
  assert.strictEqual(stored.input.old_string, WITHHELD('ssh'));
  assert.ok(!JSON.stringify(stored).includes('KEY-BYTES'));
});

// ── the chain ──────────────────────────────────────────────────────────────

test('a sibling branch yields an opener whose parent is the earlier record, and the machine supersedes', () => {
  const r = createRecords({ seed: 16 });
  r.prompt('one');
  r.assistant(['first']);
  const end1 = r.turnDuration();
  const p2 = r.prompt('two');
  r.assistant(['second']);
  r.turnDuration();
  r.branchFrom(end1.uuid);
  const p3 = r.prompt('two, again');
  const { changes } = run(r.records);
  const op = changes.filter((c) => c.type === 'opener').at(-1);
  assert.strictEqual(op.prompt_id, p3.promptId);
  assert.strictEqual(op.parent_uuid, end1.uuid);

  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  assert.strictEqual(model.turn(p2.promptId).superseded, true);
  assert.ok(!model.turn(p3.promptId).superseded);
});

test('a dropped chain record is forwarded as {type: record, uuid, kind}', () => {
  const r = createRecords({ seed: 17 });
  r.prompt('go');
  const env = r.attachment('environment', { cwd: '/tmp/project' });
  const caveat = r.localCommandCaveat();
  const unknown = r.attachment('brand_new_kind', {});
  const { changes, diag } = run(r.records);
  for (const rec of [env, caveat, unknown]) {
    const c = changes.find((x) => x.uuid === rec.uuid);
    assert.strictEqual(c.type, 'record');
    assert.strictEqual(c.kind, rec === env ? 'attachment/environment' : rec === caveat ? 'user/local-command-caveat' : 'attachment/brand_new_kind');
    assert.strictEqual(c.parent_uuid, rec.parentUuid);
    assert.ok(Number.isInteger(c.seq) && c.offset && Number.isFinite(c.offset.start));
  }
  assert.deepStrictEqual(diag.unknown_kinds, { 'attachment/brand_new_kind': 1 });
});

test('last-prompt: rewound, a null leaf and an earlier leaf are evidence; the leaf itself is not', () => {
  const r = createRecords({ seed: 18 });
  const p = r.prompt('go');
  r.assistant(['done']);
  r.lastPrompt();                          // the leaf: nothing
  r.lastPrompt({ rewound: true });         // rewound
  r.lastPrompt({ leafUuid: null });        // a headless anchor
  r.lastPrompt({ leafUuid: p.uuid });      // an earlier record
  const { changes } = run(r.records);
  const ev = changes.filter((c) => c.type === 'rewind-evidence');
  assert.strictEqual(ev.length, 3);
  assert.deepStrictEqual(ev.map((c) => [c.rewound, c.leaf_uuid]), [[true, r.leaf], [false, null], [false, p.uuid]]);
  for (const c of ev) {
    assert.ok(Number.isFinite(c.ts) && Number.isInteger(c.seq) && Number.isFinite(c.offset.end));
    assert.ok(!('uuid' in c));
  }
  // The machine counts the type it does not know, and nothing else.
  const { tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  assert.strictEqual(tm.diagnostics().unknown_changes, 3);
});

test('compact_boundary: compact with tokens = preTokens, then the c_<uuid> item with pre and post tokens', () => {
  const r = createRecords({ seed: 19 });
  r.prompt('go');
  r.assistant(['working']);
  const tail = r.leaf;
  const b = r.compactBoundary({ trigger: 'auto', preTokens: 150000, postTokens: 12000, durationMs: 30000 });
  r.compactSummary('Summary of what came before.');
  const { changes } = run(r.records);
  const i = changes.findIndex((c) => c.type === 'compact');
  assert.deepStrictEqual(
    { type: changes[i].type, trigger: changes[i].trigger, tokens: changes[i].tokens, duration_ms: changes[i].duration_ms, tail_uuid: changes[i].tail_uuid },
    { type: 'compact', trigger: 'auto', tokens: 150000, duration_ms: 30000, tail_uuid: tail },
  );
  assert.strictEqual(changes[i].parent_uuid, null);
  const it = changes[i + 1];
  assert.strictEqual(it.type, 'item');
  assert.strictEqual(it.item.id, `c_${b.uuid}`);
  assert.strictEqual(it.item.pre_tokens, 150000);
  assert.strictEqual(it.item.post_tokens, 12000);
  assert.strictEqual(it.seq, changes[i].seq);
  const cs = changes.find((c) => c.type === 'compact-summary');
  assert.strictEqual(cs.parent_uuid, b.uuid);
  assert.strictEqual(cs.text, 'Summary of what came before.');

  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  const c = model.serializeItem(`c_${b.uuid}`);
  assert.strictEqual(c.tokens, 150000);
  assert.strictEqual(c.pre_tokens, 150000);
  assert.strictEqual(c.post_tokens, 12000);
  assert.strictEqual(c.summary, 'Summary of what came before.');
});

// ── determinism and the seq rule ───────────────────────────────────────────

function busySession() {
  const r = createRecords({ seed: 20 });
  oneTurn(r);
  const boundary = r.records.length;
  r.slashCommand('model', 'opus');
  r.localCommandOutput('Set model to opus');
  r.prompt('and now [web-chat message m-0a1b2c3d] from the composer');
  r.attachment('file', { filename: '/tmp/project/notes.md' });
  r.assistant([{ type: 'thinking', thinking: 'ok' }, 'Sure.']);
  r.attachment('plan_mode', {});
  r.attachment('plan_mode', {});
  r.awaySummary('Away: tests passed.');
  r.lastPrompt({ leafUuid: null });
  r.turnDuration();
  return { r, boundary };
}

test('determinism: whole and in two halves with the state carried give identical changes', () => {
  const { r, boundary } = busySession();
  const whole = run(r.records);
  const a = run(r.records.slice(0, boundary));
  const carried = JSON.parse(JSON.stringify(a.state)); // as persisted
  assert.deepStrictEqual(carried.msgs, {});
  assert.deepStrictEqual(carried.tools, {});
  assert.deepStrictEqual(carried.attach, []);
  // The second half keeps the file's offsets; the carried state numbers it on.
  const recs = recsOf(r.records);
  const b = normalize(recs.slice(boundary), carried, { session_id: 'sess' });
  assert.deepStrictEqual([...a.changes, ...b.changes], whole.changes);
  assert.deepStrictEqual(b.state, whole.state);

  // Every change of one record carries that record's file ordinal.
  const ordinal = new Map(recs.map((rec, n) => [rec.start, n + 1]));
  for (const c of whole.changes) {
    assert.ok(Number.isInteger(c.seq), 'integer seq');
    assert.strictEqual(c.seq, ordinal.get(c.offset.start), `${c.type} seq`);
  }
  // A re-read gives the same again.
  assert.deepStrictEqual(run(r.records).changes, whole.changes);

  // The composer's marker authors the turn 'web'; the command turn names its command.
  const ops = whole.changes.filter((c) => c.type === 'opener');
  assert.deepStrictEqual(ops.map((c) => c.kind), ['prompt', 'command', 'prompt']);
  assert.strictEqual(ops[1].command, '/model');
  assert.strictEqual(ops[1].text, '/model opus');
  assert.strictEqual(ops[2].author, 'web');
  const local = items(whole.changes, 'local')[0];
  assert.strictEqual(local.item.id, `rl_${ops[1].prompt_id}`);
  assert.strictEqual(local.item.local, '/model');
  assert.strictEqual(local.item.output, 'Set model to opus');
  // The mode notice comes once for two plan_mode records.
  assert.strictEqual(items(whole.changes, 'notice').filter((c) => c.item.notice === 'mode').length, 1);

  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, whole.changes);
  assert.strictEqual(model.turnsOf('conv').length, 3);
  assert.strictEqual(model.turn(ops[2].prompt_id).author, 'web');
  assert.deepStrictEqual(model.item(`p_${ops[2].prompt_id}`).attachments, [{ n: 1, kind: 'file', name: '/tmp/project/notes.md' }]);
  assert.strictEqual(tm.diagnostics().items_without_turn, 0);
});

// ── never throws ───────────────────────────────────────────────────────────

test('unknown kinds, bad lines and oversize records are counted and never throw', () => {
  const r = createRecords({ seed: 21 });
  r.prompt('go');
  const recs = recsOf(r.records);
  const end = recs.at(-1).end;
  const odd = [
    { line: 'not json', obj: null, bad: true, oversize: false, start: end, end: end + 9 },
    { line: null, obj: null, bad: true, oversize: true, start: end + 9, end: end + 9000 },
    { line: '{}', obj: { type: 'mystery' }, bad: false, oversize: false, start: end + 9000, end: end + 9003 },
    { line: '{}', obj: { type: 'assistant', uuid: 'u-1', message: 5 }, bad: false, oversize: false, start: 1, end: 2 },
    { line: '{}', obj: { type: 'user', uuid: 'u-2', message: { content: [{ type: 'tool_result' }] } }, bad: false, oversize: false, start: 3, end: 4 },
    { line: '{}', obj: { type: 'system', subtype: 'compact_boundary', compactMetadata: 'x' }, bad: false, oversize: false, start: 5, end: 6 },
    { line: '{}', obj: { type: 'attachment', attachment: { type: 'hook_permission_decision' } }, bad: false, oversize: false, start: 7, end: 8 },
    null,
  ];
  let res;
  assert.doesNotThrow(() => { res = normalize([...recs, ...odd], initialState()); });
  assert.strictEqual(res.diag.bad_lines, 1);
  assert.strictEqual(res.diag.oversize_lines, 1);
  assert.deepStrictEqual(res.diag.unknown_kinds, { mystery: 1 });
  // The five readable records after the prompt carry no version: they inherit its (V15).
  assert.deepStrictEqual(res.diag.versions_seen, { '2.1.287': 6 });
  assert.strictEqual(res.state.seq, recs.length + odd.length - 1);
  assert.doesNotThrow(() => normalize(null, null));
  assert.doesNotThrow(() => normalize([{ obj: { type: 'user', message: { content: [{ type: 'text', text: 5 }] } } }], { seq: 'x', msgs: 3 }));
});

test('thinking: no thinkingDurationMs means no duration_ms; with it, duration_ms is that value', () => {
  const r = createRecords({ seed: 22 });
  r.prompt('go');
  r.assistant([{ type: 'thinking', thinking: 'quiet' }], { messageId: 'msg_01a' });
  r.assistant([{ type: 'thinking', thinking: 'timed', durationMs: 1234 }], { messageId: 'msg_01b' });
  const { changes } = run(r.records);
  const a = last(items(changes, 'thinking'), 'th_msg_01a').item;
  const b = last(items(changes, 'thinking'), 'th_msg_01b').item;
  assert.ok(!('duration_ms' in a));
  assert.strictEqual(b.duration_ms, 1234);
});

test('openers of every kind, notices, a permission decision and an artifact', () => {
  const r = createRecords({ seed: 23 });
  const img = r.promptImage('look at this');
  r.assistant(['seen']);
  r.turnDuration();
  const tn = r.taskNotification({ taskId: 'b9' });
  r.turnDuration();
  const ch = r.channel();
  r.turnDuration();
  const bash = r.bashMode('ls -la');
  r.bashOutput('a.txt', 'warn');
  const [call] = r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'rm x' } }]);
  r.hookPermissionDecision(call.message.content[0].id, 'deny');
  r.informational('Heads up.');
  r.apiError('API Error: 529');
  r.apiErrorMessage('API Error: 500');
  r.localCommand('clear');
  r.frameLink({ title: 'A page', frameUrl: 'https://example.com/f/1' });
  r.attachment('model', { model: 'claude-opus-5-5' });
  r.attachment('invoked_skills', { skills: [{ name: 'review', content: 'SKILL BODY' }] });
  const { changes } = run(r.records);
  const ops = changes.filter((c) => c.type === 'opener');
  assert.deepStrictEqual(ops.map((c) => [c.kind, c.origin]),
    [['prompt', 'human'], ['task-notification', 'task-notification'], ['channel', 'channel'], ['shell', 'shell']]);
  assert.deepStrictEqual(ops[0].attachments, [{ n: 1, kind: 'image', media_type: 'image/png', bytes: TINY_PNG.length }]);
  assert.strictEqual(ops[0].prompt_id, img.promptId);
  assert.strictEqual(ops[1].prompt_id, tn.promptId);
  assert.strictEqual(ops[2].prompt_id, ch.promptId);
  assert.strictEqual(ops[3].text, 'ls -la');
  const local = last(items(changes, 'local'), `rl_${bash.promptId}`).item;
  assert.deepStrictEqual({ local: local.local, output: local.output, is_error: local.is_error }, { local: 'bash', output: 'a.txt\nwarn', is_error: true });
  assert.strictEqual(items(changes, 'local')[0].item.input, 'ls -la');
  const pd = changes.find((c) => c.type === 'permission-decision');
  assert.deepStrictEqual({ tool_use_id: pd.tool_use_id, decision: pd.decision }, { tool_use_id: call.message.content[0].id, decision: 'deny' });
  const notices = items(changes, 'notice').map((c) => [c.item.notice, c.item.text]);
  assert.deepStrictEqual(notices, [
    ['info', 'Heads up.'], ['api-error', 'API Error: 529'], ['api-error', 'API Error: 500'], ['session', 'Session cleared'],
    ['model', 'Model: claude-opus-5-5'], ['skill', 'Skill: review'],
  ]);
  const art = items(changes, 'artifact')[0].item;
  assert.deepStrictEqual({ title: art.title, url: art.url }, { title: 'A page', url: 'https://example.com/f/1' });
  assert.ok(!JSON.stringify(changes).includes('SKILL BODY'));
  assert.ok(!JSON.stringify(changes).includes(TINY_PNG.toString('base64')));

  const { model, tm } = machine();
  tm.applyChanges('conv', r.sessionId, changes);
  assert.deepStrictEqual(model.turnsOf('conv').map((t) => t.kind), ['prompt', 'task-notification', 'channel', 'shell']);
  assert.strictEqual(model.item(call.message.content[0].id).awaiting.decision, 'deny');
});

test('the input state is never mutated', () => {
  const r = createRecords({ seed: 24 });
  r.prompt('go');
  r.assistant(['hello'], { messageId: 'msg_01m' });
  const s0 = initialState();
  const frozen = JSON.stringify(s0);
  const a = normalize(recsOf(r.records), s0);
  assert.strictEqual(JSON.stringify(s0), frozen);
  const snap = JSON.stringify(a.state);
  normalize(recsOf([r.assistant(['more'], { messageId: 'msg_01m' })]), a.state);
  assert.strictEqual(JSON.stringify(a.state), snap);
});
