// The record table (lib/server/mirror/records.js) and the record builders
// every later mirror test uses (test-support/claude-records.js).
//
// The table must cover every transcript kind the validation's drift summary
// found. design/ is not in the repository, so the kind list is committed as
// test/fixtures/mirror/record-kinds.json, generated once from
// design/chat-mirror-validation/drift-summary.json (its `source` names the file
// and the versions it covers); this test reads that fixture (spec §2.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const records = require('../lib/server/mirror/records');
const promptClass = require('../lib/core/prompt-class');
const { NEVER_EMIT } = require('../lib/core/redact');
const { decodePng } = require('../lib/core/png');
const {
  createRecords, jsonl, chunksOf, appendChunked, appendChunkedAsync, midCharOffsets, randomSplits,
  taskNotificationText, TINY_PNG,
} = require('../test-support/claude-records');

const { TABLE, ROUTES, DROP_REASONS, rowOf, consumersOf, kindOf, userClass, versionOf } = records;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mirror', 'record-kinds.json'), 'utf8'));
const JOURNAL_KINDS = ['launched', 'started', 'result', 'failed'];
// Rows beyond the corpus: the allowlisted kind it never held, and the two user
// classes the prototype names that it did not hold either.
const BEYOND_CORPUS = [...FIXTURE.allowlist_missing_from_corpus, 'user/hook-context', 'user/no-content'];

// The validation prototype's classifier, verbatim
// (design/chat-mirror-validation/record-inventory.js:46-79), as the oracle the
// port must agree with. Kept here, not in lib: it is the reference, not a
// second home of the tag list.
const PROTOTYPE = (() => {
  function userClass(rec) {
    const msg = rec.message || {};
    const c = msg.content;
    const lead = (s) => {
      const t = String(s).trimStart();
      if (t.startsWith('<task-notification>')) return 'task-notification';
      if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return 'slash-command';
      if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return 'local-command-output';
      if (t.startsWith('<local-command-caveat>')) return 'local-command-caveat';
      if (t.startsWith('<bash-input>') || t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return 'bash-mode';
      if (t.startsWith('<channel')) return 'channel';
      if (t.startsWith('<user-prompt-submit-hook>')) return 'hook-context';
      if (t.startsWith('[Request interrupted')) return 'interrupt-marker';
      if (t.startsWith('<system-reminder>')) return 'system-reminder';
      return null;
    };
    if (rec.isCompactSummary) return 'compact-summary';
    if (typeof c === 'string') return lead(c) || (rec.isMeta ? 'meta' : 'prompt');
    if (Array.isArray(c)) {
      if (c.some((b) => b && b.type === 'tool_result')) return 'tool_result';
      const firstText = c.find((b) => b && b.type === 'text');
      const l = firstText ? lead(firstText.text || '') : null;
      if (l) return l;
      if (rec.isMeta) return 'meta';
      return c.some((b) => b && b.type === 'image') ? 'prompt+image' : 'prompt';
    }
    return 'no-content';
  }
  function kindOf(rec) {
    const t = typeof rec.type === 'string' ? rec.type : '<no-type>';
    if (t === 'system') return `system/${rec.subtype || '<none>'}`;
    if (t === 'attachment') return `attachment/${(rec.attachment && rec.attachment.type) || '<none>'}`;
    if (t === 'user') return `user/${userClass(rec)}`;
    return t;
  }
  return { userClass, kindOf };
})();

// ── the fixture ────────────────────────────────────────────────────────────

test('the kind fixture names its source and holds the 82 transcript kinds', () => {
  assert.match(FIXTURE.source, /^design\/chat-mirror-validation\/drift-summary\.json \(2\.1\.226–2\.1\.284/);
  assert.equal(FIXTURE.kinds.length, 82);
  assert.equal(new Set(FIXTURE.kinds).size, 82, 'no kind twice');
  assert.deepEqual(FIXTURE.allowlist_missing_from_corpus, ['system/api_error']);
  for (const k of JOURNAL_KINDS) assert.ok(!FIXTURE.kinds.includes(k), `${k} is a journal kind, not a transcript kind`);
  for (const k of FIXTURE.kinds) assert.equal(typeof k, 'string');
});

// ── the table ──────────────────────────────────────────────────────────────

test('every transcript kind and system/api_error has a row', () => {
  const missing = [...FIXTURE.kinds, ...FIXTURE.allowlist_missing_from_corpus].filter((k) => !rowOf(k));
  assert.deepEqual(missing, [], `kinds with no TABLE row: ${missing.join(', ')}`);
});

test('the four journal kinds have no row, and nothing beyond the corpus is unexplained', () => {
  for (const k of JOURNAL_KINDS) assert.equal(rowOf(k), null, k);
  const known = new Set([...FIXTURE.kinds, ...BEYOND_CORPUS]);
  const extra = Object.keys(TABLE).filter((k) => !known.has(k));
  assert.deepEqual(extra, [], `rows for kinds neither in the corpus nor allowlisted: ${extra.join(', ')}`);
});

test('every row routes to a known route, names a consumer or a drop reason, and is frozen', () => {
  assert.ok(Object.isFrozen(TABLE) && Object.isFrozen(ROUTES) && Object.isFrozen(DROP_REASONS));
  assert.equal(ROUTES.length, 16);
  const allowedKeys = new Set(['turn', 'meta', 'carrier', 'known', 'drop']);
  for (const [kind, row] of Object.entries(TABLE)) {
    assert.ok(Object.isFrozen(row), `${kind}: row frozen`);
    for (const key of Object.keys(row)) assert.ok(allowedKeys.has(key), `${kind}: unknown row key ${key}`);
    assert.ok(Object.hasOwn(row, 'turn'), `${kind}: every row says turn (a route or null)`);
    assert.ok(row.turn === null || ROUTES.includes(row.turn), `${kind}: route ${row.turn} not in ROUTES`);
    if (row.meta !== undefined) assert.equal(row.meta, true, kind);
    if (row.carrier !== undefined) assert.equal(row.carrier, true, kind);
    if (row.known !== undefined) assert.ok(['account-email', 'org-id'].includes(row.known), kind);
    const consumer = row.turn || row.meta || row.carrier || row.known;
    assert.ok(consumer || row.drop, `${kind}: no consumer and no drop reason`);
    if (row.drop !== undefined) {
      assert.ok(DROP_REASONS.includes(row.drop), `${kind}: drop reason ${row.drop}`);
      assert.ok(!row.turn && !row.meta && !row.carrier, `${kind}: a drop row feeds no item and no meta`);
    }
  }
});

test('every route is used by some row', () => {
  const used = new Set(Object.values(TABLE).map((r) => r.turn).filter(Boolean));
  assert.deepEqual(ROUTES.filter((r) => !used.has(r)), []);
});

test('every NEVER_EMIT kind is a drop; session_context and credential_org carry only known', () => {
  for (const kind of NEVER_EMIT.kinds) {
    const row = rowOf(kind);
    assert.ok(row, kind);
    assert.equal(row.drop, 'never-emit', kind);
  }
  assert.deepEqual({ ...rowOf('attachment/session_context') }, { turn: null, drop: 'never-emit', known: 'account-email' });
  assert.deepEqual({ ...rowOf('attachment/credential_org') }, { turn: null, drop: 'never-emit', known: 'org-id' });
  assert.deepEqual({ ...rowOf('attachment/prompt_snapshot') }, { turn: null, drop: 'never-emit' });
  assert.deepEqual({ ...rowOf('attachment/instructions') }, { turn: null, drop: 'never-emit' });
  // No other row carries a known value.
  const knownRows = Object.entries(TABLE).filter(([, r]) => r.known).map(([k]) => k).sort();
  assert.deepEqual(knownRows, ['attachment/credential_org', 'attachment/session_context']);
});

test('the rows the spec names route where §2.4 says', () => {
  const expect = {
    assistant: { turn: 'assistant', meta: true },
    'user/tool_result': { turn: 'tool-result' },
    'user/prompt': { turn: 'opener' },
    'user/prompt+image': { turn: 'opener' },
    'user/task-notification': { turn: 'opener', carrier: true },
    'user/channel': { turn: 'opener', carrier: true },
    'user/slash-command': { turn: 'opener' },
    'user/bash-mode': { turn: 'opener' },
    'user/local-command-output': { turn: 'local-output' },
    'user/interrupt-marker': { turn: 'interrupt' },
    'user/compact-summary': { turn: 'compact-summary' },
    'system/turn_duration': { turn: 'turn-duration' },
    'system/compact_boundary': { turn: 'compact' },
    'system/away_summary': { turn: 'away', meta: true },
    'system/local_command': { turn: 'local-command' },
    'system/informational': { turn: 'notice' },
    'system/api_error': { turn: 'notice' },
    'queue-operation': { turn: null, carrier: true },
    'attachment/queued_command': { turn: null, carrier: true },
    'attachment/hook_permission_decision': { turn: 'permission-decision' },
    'attachment/hook_additional_context': { turn: null, carrier: true },
    'last-prompt': { turn: 'rewind-anchor' },
    'attachment/skill_listing': { turn: null, meta: true },
    'frame-link': { turn: 'artifact' },
  };
  for (const [kind, row] of Object.entries(expect)) assert.deepEqual({ ...rowOf(kind) }, row, kind);
  for (const kind of ['ai-title', 'agent-name', 'mode', 'permission-mode', 'cost-state']) {
    assert.deepEqual({ ...rowOf(kind) }, { turn: null, meta: true }, kind);
  }
  for (const kind of Object.keys(TABLE).filter((k) => /^attachment\/(model|plan_mode|auto_mode|ultra_effort_)/.test(k))) {
    assert.deepEqual({ ...rowOf(kind) }, { turn: 'mode-notice', meta: true }, kind);
  }
  for (const kind of ['attachment/edited_text_file', 'attachment/file', 'attachment/directory',
    'attachment/compact_file_reference', 'attachment/pdf_reference', 'attachment/invoked_skills']) {
    assert.ok(['notice', 'prompt-attachment'].includes(rowOf(kind).turn), kind);
  }
  for (const kind of ['file-history-snapshot', 'file-history-delta', 'system/stop_hook_summary',
    'system/bridge_status', 'atis-latch', 'user/local-command-caveat', 'user/meta',
    'user/system-reminder', 'user/hook-context', 'user/no-content']) {
    assert.ok(rowOf(kind).drop, `${kind} is dropped`);
  }
});

test('consumersOf names which of normalize, meta and carriers reads a kind', () => {
  assert.deepEqual(consumersOf('assistant'), ['normalize', 'meta']);
  assert.deepEqual(consumersOf('user/channel'), ['normalize', 'carriers']);
  assert.deepEqual(consumersOf('queue-operation'), ['carriers']);
  assert.deepEqual(consumersOf('attachment/credential_org'), ['meta']);
  assert.deepEqual(consumersOf('attachment/instructions'), []);
  assert.deepEqual(consumersOf('no-such-kind'), []);
  // Every corpus kind is read by someone or dropped with a reason.
  for (const k of FIXTURE.kinds) assert.ok(consumersOf(k).length || rowOf(k).drop, k);
});

test('rowOf answers null for an unknown kind and never throws', () => {
  for (const k of ['no-such-kind', 'attachment/<none>', 'system/<none>', '<no-type>', 'constructor',
    '__proto__', 'toString', 'hasOwnProperty', '', undefined, null, 42, {}, ['assistant']]) {
    assert.equal(rowOf(k), null, String(k));
  }
});

test('the table version and tested range', () => {
  assert.equal(records.TABLE_VERSION, 1);
  assert.deepEqual({ ...records.TESTED }, { min: '2.1.226', max: '2.1.287' });
  assert.ok(Object.isFrozen(records.TESTED));
  assert.equal(records.classifyPrompt, promptClass.classifyPrompt, 'classifyPrompt is re-exported, not copied');
});

// ── kinds and classes ──────────────────────────────────────────────────────

function classCorpus() {
  const r = createRecords({ seed: 7 });
  const corpus = [
    [r.prompt('fix the build'), 'prompt'],
    [r.prompt('   leading space then text'), 'prompt'],
    [r.prompt(''), 'prompt'],
    [r.promptImage('what is this?'), 'prompt+image'],
    [r.user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]), 'prompt+image'],
    [r.toolResult('toolu_x', 'done'), 'tool_result'],
    [r.taskNotification({ taskId: 'b1234567' }), 'task-notification'],
    [r.channel(), 'channel'],
    [r.prompt('<channels are a word here>'), 'channel'],          // the parity choice (U07a)
    [r.slashCommand('review', 'the diff'), 'slash-command'],
    [r.user('<command-message>review</command-message>'), 'slash-command'],
    [r.bashMode('ls'), 'bash-mode'],
    [r.bashOutput('a', 'b'), 'bash-mode'],
    [r.user('<bash-stderr>oops</bash-stderr>'), 'bash-mode'],
    [r.localCommandOutput('Compacted'), 'local-command-output'],
    [r.localCommandOutput('', { stderr: 'no' }), 'local-command-output'],
    [r.localCommandCaveat(), 'local-command-caveat'],
    [r.user('<user-prompt-submit-hook>ctx</user-prompt-submit-hook>'), 'hook-context'],
    [r.interrupt(), 'interrupt-marker'],
    [r.interrupt({ forToolUse: true }), 'interrupt-marker'],
    [r.user('[Request interrupted by user]'), 'interrupt-marker'],
    [r.user('<system-reminder>be brief</system-reminder>'), 'system-reminder'],
    [r.user([{ type: 'text', text: '\n<system-reminder>x</system-reminder>' }]), 'system-reminder'],
    [r.compactSummary(), 'compact-summary'],
    [r.compactSummary('<task-notification>looks tagged</task-notification>'), 'compact-summary'],
    [r.user('plain meta text', { extra: { isMeta: true } }), 'meta'],
    [r.user([{ type: 'text', text: 'meta block' }], { extra: { isMeta: true } }), 'meta'],
    [r.user([{ type: 'text', text: 'prompt later mentions <task-notification>' }]), 'prompt'],
    [r.user([null, { type: 'text', text: '<bash-input>pwd</bash-input>' }]), 'bash-mode'],
    [r.user([{ type: 'text' }]), 'prompt'],
    [r.user([]), 'prompt'],
    [r.user(undefined), 'no-content'],
    [r.user(42), 'no-content'],
    [{ ...r.user('x'), message: 'not an object' }, 'no-content'],
    [{ ...r.user('x'), message: null }, 'no-content'],
  ];
  return corpus;
}

test('userClass and kindOf agree with the prototype on a corpus covering every user class', () => {
  const corpus = classCorpus();
  const seen = new Set();
  for (const [rec, want] of corpus) {
    const label = JSON.stringify(rec.message && rec.message.content);
    assert.equal(PROTOTYPE.userClass(rec), want, `oracle: ${label}`);
    assert.equal(userClass(rec), want, `port: ${label}`);
    assert.equal(kindOf(rec), PROTOTYPE.kindOf(rec), `kindOf: ${label}`);
    assert.equal(kindOf(rec), `user/${want}`);
    seen.add(want);
  }
  const every = ['prompt', 'prompt+image', 'tool_result', 'task-notification', 'channel', 'slash-command',
    'bash-mode', 'local-command-output', 'local-command-caveat', 'hook-context', 'interrupt-marker',
    'system-reminder', 'compact-summary', 'meta', 'no-content'];
  assert.deepEqual(every.filter((c) => !seen.has(c)), [], 'every user class is in the corpus');
  for (const c of every) assert.ok(rowOf(`user/${c}`), `user/${c} has a row`);
});

test('userClass leads on lib/core/prompt-class promptLead (one tag list)', () => {
  for (const text of ['<task-notification>', ' <channel x="1">', '<command-name>/x', '[Request interrupted', 'hello', '']) {
    const want = promptClass.promptLead(text);
    const got = userClass({ type: 'user', message: { content: text } });
    assert.equal(got, want || 'prompt', text);
  }
});

test('kindOf builds <type>, system/<subtype> and attachment/<type>', () => {
  assert.equal(kindOf({ type: 'system', subtype: 'turn_duration' }), 'system/turn_duration');
  assert.equal(kindOf({ type: 'system' }), 'system/<none>');
  assert.equal(kindOf({ type: 'attachment', attachment: { type: 'skill_listing' } }), 'attachment/skill_listing');
  assert.equal(kindOf({ type: 'attachment' }), 'attachment/<none>');
  assert.equal(kindOf({ type: 'attachment', attachment: 'str' }), 'attachment/<none>');
  assert.equal(kindOf({ type: 'last-prompt' }), 'last-prompt');
  assert.equal(kindOf({ type: 7 }), '<no-type>');
});

test('nothing throws on a record with no type, a non-object message or a huge content array', () => {
  const odd = [undefined, null, 0, 'assistant', [], {}, { type: null }, { type: 'user' },
    { type: 'user', message: 5 }, { type: 'user', message: 'text' }, { type: 'user', message: [] },
    { type: 'user', message: { content: { type: 'text' } } },
    { type: 'user', message: { content: [{ type: 'text', text: { toString() { throw new Error('boom'); } } }] } },
    { type: 'attachment', attachment: null }, { type: 'system', subtype: null }];
  for (const rec of odd) {
    const k = kindOf(rec);
    assert.equal(typeof k, 'string');
    assert.equal(rowOf(k) === null || typeof rowOf(k) === 'object', true);
    if (rec && typeof rec === 'object') assert.equal(typeof userClass(rec), 'string');
  }
  assert.equal(kindOf(null), '<no-type>');
  assert.equal(rowOf(kindOf({ type: 'user', message: 5 })), TABLE['user/no-content']);
  const huge = new Array(500000).fill({ type: 'text', text: 'x' });
  huge.push({ type: 'image' });
  assert.equal(kindOf({ type: 'user', message: { content: huge } }), 'user/prompt+image');
  const hugeResult = new Array(500000).fill(null);
  hugeResult.push({ type: 'tool_result' });
  assert.equal(kindOf({ type: 'user', message: { content: hugeResult } }), 'user/tool_result');
});

test('versionOf inherits the last version for a version-less metadata record (V15)', () => {
  const r = createRecords({ seed: 3, version: '2.1.284' });
  const file = [r.prompt('hi'), r.aiTitle('t'), r.mode('normal'), r.lastPrompt(), ...r.assistant(['ok'])];
  r.setVersion('2.1.287');
  file.push(r.permissionMode('plan'), r.turnDuration());
  let last = null;
  const versions = file.map((rec) => (last = versionOf(rec, last)));
  assert.deepEqual(versions, ['2.1.284', '2.1.284', '2.1.284', '2.1.284', '2.1.284', '2.1.284', '2.1.287']);
  assert.equal(versionOf({ type: 'mode' }), null, 'before any version');
  assert.equal(versionOf({ type: 'mode' }, null), null);
  assert.equal(versionOf({ type: 'mode', version: '' }, '2.1.1'), '2.1.1');
  assert.equal(versionOf(null, '2.1.1'), '2.1.1');
  assert.equal(versionOf({ version: 7 }, '2.1.1'), '2.1.1');
});

// ── the builders ───────────────────────────────────────────────────────────

const CORE_KEYS = ['cwd', 'entrypoint', 'gitBranch', 'isSidechain', 'parentUuid', 'sessionId', 'timestamp', 'type', 'userType', 'uuid', 'version'];

function everyBuilder(r) {
  const out = [];
  const add = (kind, rec) => { out.push([kind, rec]); return rec; };
  add('user/prompt', r.prompt('fix it'));
  add('user/prompt+image', r.promptImage('see'));
  const [th, tx, tu] = r.assistant([{ type: 'thinking', thinking: 'hmm', durationMs: 900 }, 'on it', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]);
  add('assistant', th); add('assistant', tx); add('assistant', tu);
  add('user/tool_result', r.toolResult(tu.message.content[0].id, 'a\nb', { isError: true }));
  add('assistant', r.apiErrorMessage());
  add('system/turn_duration', r.turnDuration({ durationMs: 1234, messageCount: 9 }));
  add('system/compact_boundary', r.compactBoundary());
  add('user/compact-summary', r.compactSummary());
  add('user/interrupt-marker', r.interrupt());
  add('user/task-notification', r.taskNotification({ taskId: 'b7654321' }));
  add('user/channel', r.channel());
  add('user/slash-command', r.slashCommand('compact'));
  add('user/bash-mode', r.bashMode('pwd'));
  add('user/bash-mode', r.bashOutput('/tmp/project'));
  add('user/local-command-output', r.localCommandOutput('done'));
  add('user/local-command-caveat', r.localCommandCaveat());
  add('system/local_command', r.localCommand('clear'));
  add('last-prompt', r.lastPrompt({ rewound: true }));
  add('queue-operation', r.queueOperation('enqueue', { content: 'x' }));
  add('attachment/queued_command', r.queuedCommand('also this'));
  add('attachment/hook_additional_context', r.hookAdditionalContext('ctx'));
  add('attachment/hook_permission_decision', r.hookPermissionDecision('toolu_y', 'deny'));
  add('attachment/skill_listing', r.skillListing());
  add('attachment/credential_org', r.credentialOrg());
  add('attachment/session_context', r.sessionContext());
  add('ai-title', r.aiTitle());
  add('agent-name', r.agentName());
  add('mode', r.mode());
  add('permission-mode', r.permissionMode());
  add('cost-state', r.costState());
  add('system/away_summary', r.awaySummary());
  add('system/informational', r.informational());
  add('system/api_error', r.apiError());
  add('frame-link', r.frameLink());
  add('attachment/model', r.attachment('model', { identity: 'claude-opus-5-5', text: 'Model changed' }));
  add('system/stop_hook_summary', r.system('stop_hook_summary', { hookCount: 1 }));
  add('atis-latch', r.meta('atis-latch', { atis: true }));
  return out;
}

test('each builder\'s record kindOf()s to the kind it names, and every kind has a row', () => {
  const r = createRecords({ seed: 11 });
  const built = everyBuilder(r);
  for (const [kind, rec] of built) {
    assert.equal(kindOf(rec), kind, kind);
    assert.ok(rowOf(kind), `${kind} has a row`);
  }
  // Every route has a builder that reaches it.
  const reached = new Set(built.map(([k]) => rowOf(k).turn).filter(Boolean));
  const routesWithoutBuilder = ROUTES.filter((x) => !reached.has(x) && !['notice', 'prompt-attachment', 'mode-notice'].includes(x));
  assert.deepEqual(routesWithoutBuilder, []);
});

test('chain records carry the core keys; metadata records carry their own', () => {
  const r = createRecords({ seed: 12 });
  for (const [kind, rec] of everyBuilder(r)) {
    if (rec.uuid) {
      for (const k of CORE_KEYS) assert.ok(Object.hasOwn(rec, k), `${kind}: ${k}`);
      if (rec.type === 'user' || rec.type === 'assistant') assert.ok(Object.hasOwn(rec, 'message'), kind);
      assert.equal(rec.sessionId, r.sessionId);
      assert.ok(!Number.isNaN(Date.parse(rec.timestamp)), kind);
    } else {
      assert.equal(rec.version, undefined, `${kind}: a metadata record has no version`);
      assert.equal(rec.sessionId, r.sessionId);
    }
  }
});

test('the builders\' fields: promptId, the split assistant message, tool results, durations, compaction', () => {
  const r = createRecords({ seed: 13 });
  const p = r.prompt('hello', { promptId: 'p-1' });
  assert.equal(p.promptId, 'p-1');
  assert.equal(r.lastPromptId, 'p-1');
  const parts = r.assistant([{ type: 'thinking', thinking: 'plan', durationMs: 1500 }, 'text', { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a' } }], { model: 'claude-x' });
  assert.equal(parts.length, 3);
  assert.equal(new Set(parts.map((x) => x.message.id)).size, 1, 'one message.id');
  for (const x of parts) assert.equal(x.message.content.length, 1, 'one block per record');
  assert.deepEqual(parts.map((x) => x.message.stop_reason), [null, null, 'tool_use']);
  assert.equal(parts[0].thinkingDurationMs, 1500);
  assert.ok(parts[0].message.content[0].signature);
  assert.equal(parts[0].message.model, 'claude-x');
  const call = parts[2].message.content[0];
  assert.match(call.id, /^toolu_01/);

  const tr = r.toolResult(call.id, 'big', {
    persistedOutputPath: '/tmp/x/tool-results/a.txt', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }],
    filePath: '/tmp/project/a', taskId: 'b1', agentId: 'a1', runId: 'r1', stdout: 'dup',
  });
  const block = tr.message.content[0];
  assert.equal(block.tool_use_id, call.id);
  assert.equal(tr.sourceToolAssistantUUID, parts[2].uuid);
  assert.deepEqual(Object.keys(tr.toolUseResult).sort(),
    ['agentId', 'backgroundTaskId', 'filePath', 'persistedOutputPath', 'persistedOutputSize', 'runId', 'stdout', 'structuredPatch']);
  assert.equal(r.toolResult(call.id, 'no', { isError: true }).message.content[0].is_error, true);
  const denied = r.toolResult(call.id, 'x', { denied: true });
  assert.match(denied.message.content[0].content, /doesn't want to proceed/);
  assert.equal(denied.message.content[0].is_error, true);
  assert.equal(denied.toolUseResult, 'User rejected tool use');
  const imgs = r.toolResult(call.id, 'shot', { images: true }).message.content[0].content;
  assert.deepEqual(imgs.map((b) => b.type), ['text', 'image']);

  const td = r.turnDuration({ durationMs: 777, messageCount: 16 });
  assert.equal(td.durationMs, 777);
  assert.equal(td.messageCount, 16);

  const before = r.leaf;
  const cb = r.compactBoundary({ trigger: 'manual', preTokens: 1000, postTokens: 100 });
  assert.equal(cb.parentUuid, null, 'a compaction starts a new root');
  assert.equal(cb.logicalParentUuid, before);
  assert.equal(cb.compactMetadata.preservedSegment.tailUuid, before);
  assert.equal(cb.compactMetadata.trigger, 'manual');
  assert.equal(r.compactSummary().parentUuid, cb.uuid);

  const lp = r.lastPrompt({ leafUuid: null, rewound: true });
  assert.equal(lp.leafUuid, null);
  assert.equal(lp.rewound, true);
  assert.equal(r.lastPrompt().leafUuid, r.leaf);

  assert.equal(r.skillListing({ isInitial: false, names: ['a'] }).attachment.isInitial, false);
  assert.match(r.sessionContext().attachment.context.userEmail, /@example\.com$/);
  assert.equal(r.credentialOrg('org-1').attachment.organizationUuid, 'org-1');
  assert.match(taskNotificationText({ taskId: 'b9' }), /^<task-notification>\n<task-id>b9<\/task-id>/);
  assert.equal(r.queuedCommand(taskNotificationText(), { commandMode: 'task-notification' }).attachment.commandMode, 'task-notification');
});

test('the image prompt carries a real, decodable PNG', () => {
  const r = createRecords({ seed: 14 });
  const rec = r.promptImage('look');
  const img = rec.message.content.find((b) => b.type === 'image');
  assert.equal(img.source.media_type, 'image/png');
  const bytes = Buffer.from(img.source.data, 'base64');
  assert.deepEqual(bytes, TINY_PNG);
  const decoded = decodePng(bytes);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
});

test('the chain: each record\'s parentUuid is the previous chain record; metadata records stay out', () => {
  const r = createRecords({ seed: 15 });
  const p = r.prompt('one');
  assert.equal(p.parentUuid, null, 'the first record is a root');
  const a = r.assistant(['a', 'b']);
  r.aiTitle('x');            // not in the chain
  r.queueOperation('enqueue');
  const t = r.turnDuration();
  assert.equal(a[0].parentUuid, p.uuid);
  assert.equal(a[1].parentUuid, a[0].uuid);
  assert.equal(t.parentUuid, a[1].uuid);
  assert.equal(r.leaf, t.uuid);
  const uuids = r.records.filter((x) => x.uuid).map((x) => x.uuid);
  assert.equal(new Set(uuids).size, uuids.length, 'uuids are unique');
});

test('branchFrom makes a sibling whose parent is the named earlier record', () => {
  const r = createRecords({ seed: 16 });
  const p1 = r.prompt('first');
  const [a1] = r.assistant(['reply one']);
  r.prompt('second');
  r.assistant(['reply two']);
  r.branchFrom(a1.uuid);
  const p3 = r.prompt('rewound and asked again');
  assert.equal(p3.parentUuid, a1.uuid);
  assert.equal(r.byUuid(p1.uuid), p1);
  assert.equal(r.records.filter((x) => x.parentUuid === a1.uuid).length, 2, 'two children: siblings');
  assert.throws(() => r.branchFrom('not-a-uuid'), /not a chain record/);
});

test('the builders are deterministic per seed and differ across seeds', () => {
  const a = jsonl(everyBuilder(createRecords({ seed: 21 })).map(([, x]) => x));
  const b = jsonl(everyBuilder(createRecords({ seed: 21 })).map(([, x]) => x));
  const c = jsonl(everyBuilder(createRecords({ seed: 22 })).map(([, x]) => x));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('agent files: agentId on every chain record, isSidechain true', () => {
  const r = createRecords({ seed: 17, agentId: 'a0123456789abcdef' });
  const p = r.prompt('task');
  assert.equal(p.agentId, 'a0123456789abcdef');
  assert.equal(p.isSidechain, true);
  assert.equal(r.aiTitle().agentId, undefined);
});

// ── files ──────────────────────────────────────────────────────────────────

test('jsonl writes one line per record and flattens the assistant arrays', () => {
  const r = createRecords({ seed: 18 });
  r.prompt('hi');
  r.assistant(['a', 'b']);
  const text = jsonl([r.records.slice(0, 1), r.records.slice(1), 'raw line']);
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'every line ends with a newline');
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines[2]), r.records[2]);
  assert.equal(lines[3], 'raw line');
  assert.equal(jsonl([]), '');
});

test('appendChunked writes a file byte-identical to jsonl(), whatever the split points', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = createRecords({ seed: 19 });
  r.prompt('naïve café — “quotes” 🙂 and 漢字');
  r.assistant(['réponse · 🙂'], {});
  r.aiTitle('Ünïcödé title 🙂');
  everyBuilder(r);
  const text = jsonl(r.records);
  const whole = Buffer.from(text, 'utf8');
  const mids = midCharOffsets(text);
  assert.ok(mids.length > 10, 'the corpus holds multibyte characters');
  for (const at of mids) assert.equal(whole[at] & 0xc0, 0x80, 'a mid-char offset is a continuation byte');

  const plans = [
    [],
    [1],
    [whole.length - 1],
    mids.slice(0, 3),                      // tears characters
    mids,                                  // tears every one
    [0, whole.length, -5, whole.length + 9, 7, 7],   // out of range and repeated points are ignored
  ];
  for (let seed = 1; seed <= 25; seed++) plans.push(randomSplits(text, { seed, count: 1 + (seed % 9) }));
  plans.forEach((splits, i) => {
    const file = path.join(dir, `s${i}.jsonl`);
    const seen = [];
    const n = appendChunked(file, text, { splits, onChunk: (j, buf) => seen.push(buf.length) });
    assert.equal(n, seen.length);
    assert.equal(seen.reduce((s, x) => s + x, 0), whole.length);
    assert.ok(fs.readFileSync(file).equals(whole), `plan ${i} is byte-identical`);
  });
  const asyncFile = path.join(dir, 'async.jsonl');
  const sizes = [];
  await appendChunkedAsync(asyncFile, text, {
    splits: mids.slice(0, 4),
    between: async () => { sizes.push(fs.statSync(asyncFile).size); },
  });
  assert.equal(sizes.length, 4, 'between runs after every write but the last');
  assert.ok(sizes.every((s, i) => i === 0 || s > sizes[i - 1]), 'the file grows chunk by chunk');
  assert.ok(fs.readFileSync(asyncFile).equals(whole));
  const parts = chunksOf(text, [mids[0]]);
  assert.equal(parts.length, 2);
  assert.ok(Buffer.concat(parts).equals(whole));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(parts[0]), 'the first chunk ends mid-character');
});

test('the builders spell no secret marker and no real-looking credential', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'test-support', 'claude-records.js'), 'utf8');
  assert.ok(!src.includes('‹redacted:'), 'no mask opening');
  assert.ok(!src.includes(['PRIVATE', 'KEY-----'].join(' ')), 'no PEM marker');
  const { redactText } = require('../lib/core/redact');
  const r = createRecords({ seed: 23 });
  const text = jsonl(everyBuilder(r).map(([, x]) => x));
  assert.equal(redactText(text), text, 'the redactor finds nothing secret in a builder corpus');
});
