// The mirror's model (lib/server/mirror/model.js, spec §2.4, §2.9): the one
// inbound redaction point, the caps and `truncated`, the never-serialized `_`
// fields, the merge rules, the derivation of a turn's groups, the item LRU and
// the change log the emitter drains. Pure unit tests: no server, no files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createModel, serialize, cutString, charsOf, ITEM_CAPS, INPUT_CAPS, DEFAULT_ITEM_CAP, PREVIEW_CHARS,
} = require('../lib/server/mirror/model');

// A marking fake of ctx.redactor (lib/core/redact's interface): it masks the
// sentinel `SECRET…` wherever it appears, masks a key-named value whole in
// `value` (the json-key rule), and RECORDS every string it returns, so a test can
// prove that every string the model holds came out of it.
function markingRedactor() {
  const produced = new Set();
  const contexts = [];
  const mask = (s) => s.replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]');
  const r = {
    produced,
    contexts,
    calls: 0,
    text(s, opts) {
      r.calls += 1;
      if (opts && opts.context) contexts.push({ s, context: opts.context });
      const out = mask(s);
      produced.add(out);
      return out;
    },
    value(v) {
      const walk = (x, key) => {
        if (typeof x === 'string') {
          const out = /^(api_key|token|password|secret)$/i.test(key || '') ? '[MASK:key]' : mask(x);
          produced.add(out);
          return out;
        }
        if (Array.isArray(x)) return x.map((y) => walk(y));
        if (x && typeof x === 'object') {
          const o = {};
          for (const k of Object.keys(x)) o[k] = walk(x[k], k);
          return o;
        }
        return x;
      };
      return walk(v);
    },
  };
  return r;
}

// Every string VALUE held anywhere in the model, `_` fields included, and every
// object key that is not a plain field name.
function heldStrings(model) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) out.push(k);
        walk(v[k]);
      }
    }
  };
  for (const c of model.conversations()) {
    walk(c);
    walk(model.live(c.id));
    for (const t of model.turnsOf(c.id)) { walk(t); walk(model.itemsOf(t.id)); }
  }
  walk(model.tasks());
  return out;
}

function setup(opts = {}) {
  const redactor = opts.redactor || markingRedactor();
  const model = createModel({ redactor, ...opts.model });
  const w = model.claimTurnWriter();
  let seq = 0;
  const turn = (id, extra = {}) => w.putTurn({ id, conversation_id: 'c1', session_id: 's1', seq: ++seq, status: 'open', started_at: 1, ...extra });
  return { redactor, model, w, turn };
}

const big = (n, ch = 'x') => ch.repeat(n);

// ---- construction -------------------------------------------------------------------

test('a model needs a redactor: it never holds an unredacted string', () => {
  assert.throws(() => createModel({}), /redactor/);
  assert.throws(() => createModel({ redactor: {} }), /redactor/);
});

// ---- the inbound redaction point ------------------------------------------------------

test('upsert passes every text field through the injected redactor, so no stored string skips it', () => {
  const { redactor, model, turn } = setup();
  model.upsertConversation('c1', { title: 'chat about SECRETtitle', name: 'n SECRETname', away: { text: 'away SECRETaway', at: 5 },
    model: 'sonnet', diagnostics: { unknown_kinds: { 'attachment/SECRETkind': 2 } } });
  model.upsertLive('c1', {
    state: 'working', since: 1,
    step: { kind: 'Bash', tool: 'Bash', label: 'Bash · echo SECRETstep', started_at: 2 },
    waiting: { kind: 'permission', tool: 'Bash', summary: 'run SECRETwait?', pending: true },
    last_turn: { id: 't0', outcome: 'done', ended_at: 1, code: null, reply_preview: 'said SECRETlast' },
  });
  turn('t1');
  model.upsertItem({ id: 'p_t1', turn_id: 't1', kind: 'prompt', text: 'key SECRETprompt', origin: 'human',
    attachments: [{ n: 0, kind: 'file', name: 'SECRETfile.txt' }] });
  model.upsertItem({ id: 'r_1', turn_id: 't1', kind: 'reply', text: 'reply SECRETreply', model: 'opus' });
  model.upsertItem({ id: 'th_1', turn_id: 't1', kind: 'thinking', chars: 10, text: 'think SECRETthink' });
  model.upsertItem({
    id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'mcp__svc__do', server: 'svc', tool_kind: 'MCP',
    label: 'svc · SECRETlabel', call: 'do(SECRETcall)', status: 'done',
    input: { query: 'q SECRETinput', api_key: 'plain-but-key-named', nested: { deep: 'SECRETdeep' } },
    result: { preview: 'out SECRETresult', bytes: 9, is_error: false, _path: '/tmp/SECRETpath.txt' },
    edit: { path: 'a.js', patch: '+SECRETpatch' },
    links: { task_id: 'bg1' },
  }, { context: { file: 'a.js', command: null } });
  model.upsertItem({ id: 'n_1', turn_id: 't1', kind: 'notice', notice: 'info', text: 'note SECRETnotice' });
  model.upsertItem({ id: 'l_1', turn_id: 't1', kind: 'local', local: 'bash', input: 'cat SECRETcmd', output: 'SECRETout' },
    { context: { command: 'cat x' } });
  model.upsertTask({ id: 'bg1', conversation_id: 'c1', kind: 'shell', title: 'npm SECRETtask', status: 'running',
    line: 'listening SECRETline', meta: { port: 5173 }, steps: [{ label: 'step SECRETstep', state: 'done' }] });
  model.patchTurn('t1', { code: { status: 'unavailable', reason: 'why SECRETcode' } });

  const held = heldStrings(model);
  assert.ok(held.length > 40, 'the walk saw the model');
  for (const s of held) {
    assert.ok(!s.includes('SECRET'), `a stored string escaped the redactor: ${JSON.stringify(s)}`);
    assert.ok(redactor.produced.has(s), `a stored string did not come out of the redactor: ${JSON.stringify(s)}`);
  }
  // A key named like a secret is masked whole (the structured input goes through value()).
  assert.equal(model.item('toolu_1').input.api_key, '[MASK:key]');
  // A content key the redactor would change is dropped, never kept.
  assert.deepEqual(Object.keys(model.conversation('c1').diagnostics.unknown_kinds), []);
});

test('the tool-output context reaches the redactor for output only, never for a label, call or input', () => {
  const { redactor, model, turn } = setup();
  turn('t1');
  const context = { file: '.env', command: null };
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'Read', label: 'Read · .env', call: 'Read(.env)',
    input: { file_path: '.env' }, status: 'done', result: { preview: 'A=1', is_error: false }, edit: { path: '.env', patch: '+A=1' } },
  { context });
  const withContext = redactor.contexts.map((c) => c.s);
  assert.ok(withContext.includes('A=1'), 'the result preview was redacted with its context');
  assert.ok(withContext.includes('+A=1'), 'the edit patch was redacted with its context');
  for (const s of ['Read · .env', 'Read(.env)', 'Read', '.env'.replace(/^/, '')]) {
    if (s === '.env') continue; // the edit path is output-side (it travels with the patch)
    assert.ok(!withContext.includes(s), `${s} must not be withheld by a file context`);
  }
  for (const c of redactor.contexts) assert.deepEqual(c.context, context);
});

test('a redactor that fails on a string drops it: the raw string is never stored', () => {
  const redactor = { text: (s) => { if (s.includes('BOOM')) throw new Error('nope'); if (s.includes('ODD')) return 42; return s; } };
  const model = createModel({ redactor });
  const w = model.claimTurnWriter();
  w.putTurn({ id: 't1', conversation_id: 'c1', session_id: 's1', seq: 1 });
  const it = model.upsertItem({ id: 'r_1', turn_id: 't1', kind: 'reply', text: 'BOOM secret', model: 'ODD' });
  assert.ok(it);
  assert.equal(it.text, undefined);
  assert.equal(it.model, undefined);
  assert.equal(model.stats().redaction_failures, 2);
  // An id the redactor fails on is no id at all: nothing is stored under it.
  assert.equal(model.upsertItem({ id: 'BOOM', turn_id: 't1', kind: 'reply', text: 'x' }), null);
});

test('stored objects are frozen: nothing can write into the model behind the redactor', () => {
  const { model, turn } = setup();
  turn('t1');
  const it = model.upsertItem({ id: 'r_1', turn_id: 't1', kind: 'reply', text: 'hi' });
  assert.ok(Object.isFrozen(it));
  assert.throws(() => { 'use strict'; it.text = 'SECRETsneak'; }, TypeError);
  assert.ok(Object.isFrozen(model.turn('t1')));
  assert.ok(Object.isFrozen(model.turn('t1').counts));
});

// ---- `_` fields ---------------------------------------------------------------------

test('fields starting with _ are kept in process and never serialize', () => {
  const { model, turn } = setup();
  model.upsertConversation('c1', { title: 't', _org: 'org-uuid' });
  model.upsertLive('c1', { state: 'idle', _raw: { x: 1 } });
  turn('t1');
  model.patchTurn('t1', { _segment: { from: 0, to: 10 }, code: null });
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'Bash', status: 'done',
    result: { preview: 'ok', _path: '/x/tool-results/a.txt', full: true }, _ctx: 'k' });
  model.upsertTask({ id: 'k1', conversation_id: 'c1', kind: 'shell', title: 't', status: 'running', _output: '/x/tasks/k1.output' });

  assert.equal(model.item('toolu_1').result._path, '/x/tool-results/a.txt', 'kept in process');
  const out = [model.serializeItem('toolu_1'), model.serializeItem('toolu_1', { level: 'full' }), model.serializeTurn('t1'),
    model.serializeTask('k1'), model.serializeConversation('c1'), model.serializeLive('c1')];
  const keys = [];
  const walk = (v) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); } };
  walk(out);
  assert.ok(keys.length > 20);
  assert.deepEqual(keys.filter((k) => k.startsWith('_')), [], 'no _ field serializes, at any depth');
  assert.equal(JSON.stringify(out).includes('tool-results'), false);
  assert.deepEqual(serialize({ a: 1, _b: 2, c: [{ _d: 3, e: 4 }] }), { a: 1, c: [{ e: 4 }] });
});

// ---- caps and `truncated` -----------------------------------------------------------------

test('caps: each field is cut at its summary cap in frames and kept to its full cap, with truncated set', () => {
  const cases = [
    // [kind, field path, summary cap, full cap, extra fields]
    ['prompt', 'text', 16 * 1024, 256 * 1024, {}],
    ['queued', 'text', 16 * 1024, 256 * 1024, {}],
    ['reply', 'text', 32 * 1024, 1024 * 1024, {}],
    ['thinking', 'text', 4 * 1024, 64 * 1024, { chars: 1 }],
    ['notice', 'text', 2 * 1024, 64 * 1024, { notice: 'info' }],
    ['tool_call', 'label', 200, 200, { tool: 'Bash' }],
    ['tool_call', 'call', 2 * 1024, 8 * 1024, { tool: 'Bash' }],
    ['tool_call', 'result.preview', 2 * 1024, 256 * 1024, { tool: 'Bash' }],
    ['tool_call', 'edit.patch', 16 * 1024, 256 * 1024, { tool: 'Edit' }],
    ['local', 'output', 2 * 1024, 64 * 1024, { local: 'bash' }],
    ['compact', 'summary', 2 * 1024, 64 * 1024, { trigger: 'auto' }],
    ['away', 'text', 2 * 1024, 64 * 1024, {}],
  ];
  for (const [kind, field, sum, full, extra] of cases) {
    // The table the model enforces is the spec's.
    const want = field.includes('.') ? ITEM_CAPS[kind][field] : ITEM_CAPS[kind][field];
    assert.deepEqual(want, [sum, full], `${kind}.${field} caps`);
    const { model, turn } = setup();
    turn('t1');
    const set = (n) => {
      const it = { id: 'i1', turn_id: 't1', kind, ...extra };
      const [a, b] = field.split('.');
      if (b) it[a] = { [b]: big(n) }; else it[a] = big(n);
      model.upsertItem(it);
    };
    const get = (o) => { const [a, b] = field.split('.'); return b ? o[a][b] : o[a]; };

    set(sum); // exactly at the summary cap: nothing cut
    let s = model.serializeItem('i1');
    assert.equal(get(s).length, sum, `${kind}.${field} at its cap`);
    assert.equal(s.truncated, undefined, `${kind}.${field} at its cap is not truncated`);

    set(sum + 10); // over the summary cap: cut in a frame, whole in a full read
    s = model.serializeItem('i1');
    assert.equal(get(s).length, sum, `${kind}.${field} summary cut`);
    assert.equal(s.truncated, true, `${kind}.${field} summary truncated`);
    const f = model.serializeItem('i1', { level: 'full' });
    assert.equal(get(f).length, Math.min(sum + 10, full), `${kind}.${field} full read`);
    assert.equal(f.truncated, sum + 10 > full ? true : undefined, `${kind}.${field} full truncated`);

    set(full + 10); // over the full cap: cut even in a full read
    const f2 = model.serializeItem('i1', { level: 'full' });
    assert.equal(get(f2).length, full, `${kind}.${field} full cut`);
    assert.equal(f2.truncated, true, `${kind}.${field} full truncated`);

    set(5); // a later short write clears the field's cut
    assert.equal(model.serializeItem('i1', { level: 'full' }).truncated, undefined, `${kind}.${field} cut cleared`);
  }
});

test('caps: a tool input is cut to 512 per string and 2 K whole in frames, 64 K in full reads', () => {
  assert.deepEqual(INPUT_CAPS, { summary: { total: 2048, string: 512 }, full: { total: 65536, string: 65536 } });
  const { model, turn } = setup();
  turn('t1');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'Bash', input: { command: big(1000), description: 'd' } });
  let s = model.serializeItem('toolu_1');
  assert.equal(s.input.command.length, 512);
  assert.equal(s.input.description, 'd');
  assert.equal(s.truncated, true);
  assert.equal(model.serializeItem('toolu_1', { level: 'full' }).input.command.length, 1000);
  assert.equal(model.serializeItem('toolu_1', { level: 'full' }).truncated, undefined);

  // Many strings: halved until the whole fits 2 K of JSON, every key kept.
  const many = {};
  for (let i = 0; i < 10; i++) many[`k${i}`] = big(600, String(i));
  model.upsertItem({ id: 'toolu_2', turn_id: 't1', kind: 'tool_call', tool: 'mcp__x__y', input: many });
  s = model.serializeItem('toolu_2');
  assert.ok(JSON.stringify(s.input).length <= 2048);
  assert.deepEqual(Object.keys(s.input), Object.keys(many));
  assert.equal(s.truncated, true);

  // The label cap is the same at both levels; the default for anything else is 2 K / 64 K.
  assert.deepEqual(ITEM_CAPS.tool_call.label, [200, 200]);
  assert.deepEqual(DEFAULT_ITEM_CAP, [2048, 65536]);
});

test('caps: the turn header previews are 280 characters, and a cut never splits a surrogate pair', () => {
  const { model, turn } = setup();
  turn('t1');
  model.upsertItem({ id: 'p_t1', turn_id: 't1', kind: 'prompt', text: big(500, 'p'), origin: 'human' });
  model.upsertItem({ id: 'r_1', turn_id: 't1', kind: 'reply', text: big(500, 'r') });
  const t = model.serializeTurn('t1');
  assert.equal(PREVIEW_CHARS, 280);
  assert.equal(t.prompt.preview.length, 280);
  assert.equal(t.reply_preview.length, 280);
  const emoji = '😀'.repeat(200); // 400 UTF-16 units
  assert.equal(cutString(emoji, 281).length, 280);
  assert.equal(cutString(emoji, 281), '😀'.repeat(140));
});

// ---- merge rules ------------------------------------------------------------------------

test('merge: the transcript overrides a hook; a hook only fills what the transcript left out', () => {
  const { model, turn } = setup();
  turn('t1');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', tool: 'Bash', label: 'Bash · npm t', status: 'running', started_at: 10 });
  let it = model.item('toolu_1');
  assert.equal(it.provisional, true);
  assert.equal(it.source, 'hook');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'transcript', tool: 'Bash', label: 'Bash · npm test',
    status: 'done', result: { preview: 'ok', is_error: false } });
  it = model.item('toolu_1');
  assert.equal(it.source, 'transcript');
  assert.equal(it.provisional, undefined, 'a transcript item is not provisional');
  assert.equal(it.label, 'Bash · npm test');
  assert.equal(it.started_at, 10, 'kept from the hook');
  // A late hook neither overrides a transcript field nor reopens the call.
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', label: 'Bash · stale', status: 'running',
    duration_ms: 42, result: { preview: 'stale', bytes: 7 } });
  it = model.item('toolu_1');
  assert.equal(it.label, 'Bash · npm test');
  assert.equal(it.status, 'done');
  assert.equal(it.duration_ms, 42, 'a gap the transcript left is filled');
  assert.deepEqual({ ...it.result }, { preview: 'ok', is_error: false, bytes: 7 });
});

test('merge: a finished tool call is never made running again, whichever source is late', () => {
  const { model, turn } = setup();
  turn('t1');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'done', ended_at: 20, duration_ms: 5 });
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'running', started_at: 15 });
  assert.equal(model.item('toolu_1').status, 'done');
  assert.equal(model.item('toolu_1').ended_at, 20);
  assert.equal(model.item('toolu_1').started_at, 15);
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'transcript', status: 'running' });
  assert.equal(model.item('toolu_1').status, 'done');
  // A transcript's terminal status beats a hook's: a refusal reads denied, not error.
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'transcript', status: 'denied' });
  assert.equal(model.item('toolu_1').status, 'denied');
});

test('merge: awaiting and links are live facts — the latest write wins whoever wrote it', () => {
  const { model, turn } = setup();
  turn('t1');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'transcript', status: 'running', links: { task_id: 'b1' } });
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', awaiting: { kind: 'permission', status: 'pending' }, links: { agent_id: 'a1' } });
  assert.deepEqual({ ...model.item('toolu_1').awaiting }, { kind: 'permission', status: 'pending' });
  assert.deepEqual({ ...model.item('toolu_1').links }, { task_id: 'b1', agent_id: 'a1' });
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', awaiting: { status: 'resolved', by: 'terminal' } });
  assert.deepEqual({ ...model.item('toolu_1').awaiting }, { kind: 'permission', status: 'resolved', by: 'terminal' });
  assert.equal(model.item('toolu_1').source, 'transcript', 'a source-less write keeps the item\'s source');
});

test('merge: the transcript places an item; a hook never moves one it placed', () => {
  const { model, turn } = setup();
  turn('t1');
  turn('t2');
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'running', tool: 'Read' });
  model.upsertItem({ id: 'toolu_1', turn_id: 't2', kind: 'tool_call', source: 'transcript', status: 'done', tool: 'Read' });
  assert.equal(model.item('toolu_1').turn_id, 't2');
  assert.deepEqual(model.itemsOf('t1'), []);
  assert.equal(model.turn('t1').counts.tools, 0);
  assert.equal(model.turn('t2').counts.tools, 1);
  model.upsertItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'done' });
  assert.equal(model.item('toolu_1').turn_id, 't2');
});

test('items are validated: a known kind, a URL-safe id, an existing turn', () => {
  const { model, turn } = setup();
  turn('t1');
  assert.equal(model.upsertItem({ id: 'x1', turn_id: 't1', kind: 'bogus' }), null);
  assert.equal(model.upsertItem({ id: 'has space', turn_id: 't1', kind: 'reply' }), null);
  assert.equal(model.upsertItem({ id: 'x2', turn_id: 'nope', kind: 'reply' }), null);
  assert.ok(model.upsertItem({ id: 'x3', turn_id: 't1', kind: 'reply', text: 'ok' }));
  // A later source can extend the vocabulary at construction, without editing the model.
  const m2 = createModel({ redactor: markingRedactor(), kinds: ['elicitation'] });
  m2.claimTurnWriter().putTurn({ id: 't1', conversation_id: 'c1', seq: 1 });
  assert.ok(m2.upsertItem({ id: 'e1', turn_id: 't1', kind: 'elicitation' }));
});

// ---- seq ------------------------------------------------------------------------------------

test('seq: transcript items take ordinals in arrival order, provisional ones fractions after the last known', () => {
  const { model, turn } = setup();
  turn('t1');
  const a = model.upsertItem({ id: 'a', turn_id: 't1', kind: 'reply', text: 'a' });
  const h1 = model.upsertItem({ id: 'h1', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'running' });
  const h2 = model.upsertItem({ id: 'h2', turn_id: 't1', kind: 'tool_call', source: 'hook', status: 'running' });
  const b = model.upsertItem({ id: 'b', turn_id: 't1', kind: 'reply', text: 'b' });
  assert.equal(a.seq, 1);
  assert.ok(h1.seq > 1 && h1.seq < 2 && h2.seq > h1.seq && h2.seq < 2, `${h1.seq} ${h2.seq}`);
  assert.equal(b.seq, 2);
  // The transcript's version of a provisional item takes its place in file order.
  const h1t = model.upsertItem({ id: 'h1', turn_id: 't1', kind: 'tool_call', source: 'transcript', status: 'done' });
  assert.equal(h1t.seq, 3);
  // An explicit ordinal from the transcripts source is honoured.
  const c = model.upsertItem({ id: 'c', turn_id: 't1', kind: 'reply', text: 'c', seq: 100 });
  assert.equal(c.seq, 100);
  assert.deepEqual(model.itemsOf('t1').map((i) => i.id), ['a', 'h2', 'b', 'h1', 'c']);
});

// ---- grouping ---------------------------------------------------------------------------------

test('grouping: consecutive tool calls share a group; the header reads ▸ 3 tool calls · Read, Edit, Bash', () => {
  const { model, turn } = setup();
  turn('t1');
  const tool = (id, name, kind = name) => model.upsertItem({ id, turn_id: 't1', kind: 'tool_call', tool: name, tool_kind: kind, status: 'done' });
  model.upsertItem({ id: 'p_t1', turn_id: 't1', kind: 'prompt', text: 'fix the rail', origin: 'human' });
  model.upsertItem({ id: 'r_1', turn_id: 't1', kind: 'reply', text: 'Looking at it.' });
  tool('tu1', 'Read');
  tool('tu2', 'Edit');
  model.upsertItem({ id: 'n_1', turn_id: 't1', kind: 'notice', notice: 'file-changed', text: 'a.js changed' }); // does not split
  tool('tu3', 'Bash');
  model.upsertItem({ id: 'r_2', turn_id: 't1', kind: 'reply', text: 'Done: the rail is fixed.' });
  const t = model.turn('t1');
  assert.equal(t.groups.length, 1);
  const g = t.groups[0];
  assert.equal(`▸ ${g.count} tool calls · ${g.names.join(', ')}`, '▸ 3 tool calls · Read, Edit, Bash');
  assert.deepEqual([...t.tool_names], ['Read', 'Edit', 'Bash']);
  for (const id of ['tu1', 'tu2', 'tu3']) assert.equal(model.item(id).group, g.id);
  assert.equal(model.item('r_1').group, undefined);
  assert.deepEqual({ ...t.counts }, { items: 7, tools: 3, tool_errors: 0, agents: 0, tasks: 0, edits: 1 });
  assert.equal(t.prompt.preview, 'fix the rail');
  assert.equal(t.reply_preview, 'Done: the rail is fixed.');
});

test('grouping: a reply, thinking or prompt item splits a run; tool names are unique, in order, at most 8', () => {
  const { model, turn } = setup();
  turn('t1');
  const tool = (id, name, extra = {}) => model.upsertItem({ id, turn_id: 't1', kind: 'tool_call', tool: name, status: 'done', ...extra });
  tool('a1', 'Read');
  tool('a2', 'Read');
  model.upsertItem({ id: 'th', turn_id: 't1', kind: 'thinking', chars: 3 });
  tool('b1', 'Grep', { status: 'error' });
  model.upsertItem({ id: 'r', turn_id: 't1', kind: 'reply', text: 'x' });
  for (let i = 0; i < 10; i++) tool(`c${i}`, `T${i}`, i === 0 ? { tool: 'Agent', links: { agent_id: 'ag' } } : i === 1 ? { links: { task_id: 'bg' } } : {});
  const t = model.turn('t1');
  assert.deepEqual(t.groups.map((g) => [g.count, g.names.length]), [[2, 1], [1, 1], [10, 8]]);
  assert.deepEqual(t.groups[0].names, ['Read']);
  assert.equal(t.tool_names.length, 8);
  assert.deepEqual(t.tool_names.slice(0, 3), ['Read', 'Grep', 'Agent']);
  assert.equal(t.counts.tool_errors, 1);
  assert.equal(t.counts.agents, 1);
  assert.equal(t.counts.tasks, 1);
  // An item arriving late, between two calls, splits their group and re-stamps them.
  model.upsertItem({ id: 'r_late', turn_id: 't1', kind: 'reply', text: 'between', seq: 1.5 });
  assert.notEqual(model.item('a1').group, model.item('a2').group);
});

// ---- the turn writer and patchTurn ---------------------------------------------------------------

test('the turn writer is claimed once; sources patch only the header fields nobody else owns', () => {
  const { model, w, turn } = setup();
  assert.throws(() => model.claimTurnWriter(), /already claimed/);
  turn('t1');
  model.patchTurn('t1', { status: 'done', superseded: true, counts: { items: 99 }, kind: 'shell', code: { status: 'pending' } });
  const t = model.turn('t1');
  assert.equal(t.status, 'open');
  assert.equal(t.superseded, undefined);
  assert.equal(t.counts.items, 0);
  assert.equal(t.kind, 'prompt');
  assert.deepEqual({ ...t.code }, { status: 'pending' });
  // Even the lifecycle writer cannot set superseded: only markSuperseded does.
  w.putTurn({ id: 't1', superseded: true, status: 'done' });
  assert.equal(model.turn('t1').superseded, undefined);
  assert.equal(model.turn('t1').status, 'done');
  assert.deepEqual(w.markSuperseded(['t1', 'nope']), ['t1']);
  assert.equal(model.turn('t1').superseded, true);
  assert.deepEqual(w.markSuperseded(['t1']), [], 'idempotent');
  // A restored header never brings superseded with it.
  const r = w.restoreTurn({ id: 't9', conversation_id: 'c1', seq: 9, status: 'done', superseded: true, counts: { items: 4 } });
  assert.equal(r.superseded, undefined);
  assert.equal(r.counts.items, 4);
  assert.equal(model.isEvicted('t9'), true, 'a restored turn waits for its refill');
});

test('an optional header field set to null by the lifecycle writer is removed', () => {
  const { model, w, turn } = setup();
  turn('t1', { provisional: true });
  assert.equal(model.turn('t1').provisional, true);
  w.putTurn({ id: 't1', provisional: null, ended_by: 'web', status: 'interrupted' });
  assert.equal('provisional' in model.turn('t1'), false);
  assert.equal(model.turn('t1').ended_by, 'web');
  w.putTurn({ id: 't1', ended_by: null });
  assert.equal('ended_by' in model.turn('t1'), false);
});

// ---- the item LRU ------------------------------------------------------------------------------

test('the item LRU evicts the least recently used closed turn, never an open or a recent one, and refills it', () => {
  const { model, w } = setup({ model: { lru: { maxChars: 3000, keepRecent: 1 } } });
  for (let i = 1; i <= 4; i++) {
    w.putTurn({ id: `t${i}`, conversation_id: 'c1', session_id: 's1', seq: i, status: i === 1 ? 'open' : 'done' });
  }
  const fill = (tid) => model.upsertItem({ id: `r_${tid}`, turn_id: tid, kind: 'reply', text: big(900, tid[1]) });
  fill('t1'); // open: pinned
  fill('t2');
  fill('t3');
  const before = model.turn('t2');
  fill('t4'); // the newest: pinned; over budget → t2 (least recent closed) goes
  assert.equal(model.isEvicted('t2'), true);
  assert.equal(model.itemsOf('t2'), null, 'an evicted turn asks for a refill');
  assert.equal(model.item('r_t2'), null);
  assert.equal(model.isEvicted('t1'), false, 'an open turn is never evicted');
  assert.equal(model.isEvicted('t4'), false, 'the newest turn is never evicted');
  assert.deepEqual(model.turn('t2'), before, 'the header keeps its summary while evicted');
  assert.ok(model.stats().chars <= 3000 + 1000);
  // A refill puts the items back, silently.
  model.takeChanges();
  assert.equal(model.refillTurn('t2', [{ item: { id: 'r_t2', kind: 'reply', text: big(900, '2') } }]), true);
  assert.equal(model.isEvicted('t2'), false);
  assert.equal(model.item('r_t2').text.length, 900);
  assert.deepEqual(model.takeChanges(), [], 'a refill is not a change');
});

test('the LRU\'s count stays exact through re-stamped groups, renames, moves, removals and evictions', () => {
  const { model, w } = setup({ model: { lru: { maxChars: 2500, keepRecent: 1 } } });
  const recount = () => {
    let n = 0;
    let k = 0;
    for (const t of model.turnsOf('c1')) for (const it of model.itemsOf(t.id) || []) { n += charsOf(it); k += 1; }
    return { n, k };
  };
  for (let i = 1; i <= 6; i++) {
    w.putTurn({ id: `t${i}`, conversation_id: 'c1', session_id: 's1', seq: i, status: 'done' });
    model.upsertItem({ id: `a${i}`, turn_id: `t${i}`, kind: 'tool_call', tool: 'Read', status: 'done', label: big(300) });
    model.upsertItem({ id: `b${i}`, turn_id: `t${i}`, kind: 'tool_call', tool: 'Edit', status: 'done' });
    model.upsertItem({ id: `r${i}`, turn_id: `t${i}`, kind: 'reply', text: big(200), seq: 0.5 }); // splits the run: re-stamps
    const { n, k } = recount();
    assert.equal(model.stats().chars, n, `chars after turn ${i}`);
    assert.equal(model.stats().items, k, `items after turn ${i}`);
  }
  w.putTurn({ id: 'h1', conversation_id: 'c1', session_id: 's1', seq: 7, status: 'open' });
  model.upsertItem({ id: 'p_h1', turn_id: 'h1', kind: 'prompt', text: 'x', source: 'hook' });
  w.renameTurn('h1', 'longer-transcript-id-1');
  model.upsertItem({ id: 'b6', turn_id: 'longer-transcript-id-1', kind: 'tool_call', source: 'transcript', status: 'done' }); // a move
  model.removeItem('a6');
  const { n, k } = recount();
  assert.equal(model.stats().chars, n);
  assert.equal(model.stats().items, k);
  assert.ok(model.stats().evicted > 0, 'the budget evicted some turns on the way');
});

// ---- changes and rev ---------------------------------------------------------------------------

test('takeChanges drains what changed per conversation and stamps the flush rev on it', () => {
  const { model, turn } = setup();
  model.upsertConversation('c1', { title: 'x' });
  turn('t1');
  model.upsertItem({ id: 'a', turn_id: 't1', kind: 'reply', text: 'a' });
  model.upsertItem({ id: 'b', turn_id: 't1', kind: 'reply', text: 'b' });
  model.upsertTask({ id: 'k1', conversation_id: 'c1', kind: 'shell', title: 'k', status: 'running' });
  let ch = model.takeChanges({ rev: 7 });
  assert.equal(ch.length, 1);
  assert.deepEqual(ch[0].turns, ['t1']);
  assert.deepEqual(ch[0].items.sort(), ['a', 'b']);
  assert.deepEqual(ch[0].tasks, ['k1']);
  assert.equal(ch[0].conversation, true);
  assert.equal(model.serializeItem('a').rev, 7);
  assert.equal(model.serializeTurn('t1').rev, 7);
  assert.equal(model.serializeTask('k1').rev, 7);
  assert.equal(model.serializeConversation('c1').rev, 7);
  assert.deepEqual(model.takeChanges(), []);
  model.removeItem('b');
  model.removeTask('k1');
  ch = model.takeChanges({ rev: 8 });
  assert.deepEqual(ch[0].removed_items, ['b']);
  assert.deepEqual(ch[0].removed_tasks, ['k1']);
  assert.deepEqual(ch[0].turns, ['t1'], 'the header changed with its items');
  assert.equal(model.serializeItem('a').rev, 7, 'an unchanged item keeps its rev');
  model.removeConversation('c1', { merged_into: 'c0' });
  ch = model.takeChanges();
  assert.equal(ch[0].removed, true);
  assert.equal(ch[0].merged_into, 'c0');
  assert.equal(model.turn('t1'), null);
  assert.equal(model.item('a'), null);
});

// ---- tasks and conversations ------------------------------------------------------------------

test('tasks: a finished row is never made running again; meta merges; counts per category', () => {
  const { model } = setup();
  model.upsertTask({ id: 'k1', conversation_id: 'c1', kind: 'shell', title: 'npm run dev', status: 'running', meta: { port: 5173 } });
  model.upsertTask({ id: 'k1', meta: { no_output_yet: true } });
  assert.deepEqual({ ...model.task('k1').meta }, { port: 5173, no_output_yet: true });
  model.upsertTask({ id: 'k1', status: 'done', exit_code: 0, ended_at: 9 });
  model.upsertTask({ id: 'k1', status: 'running' });
  assert.equal(model.task('k1').status, 'done');
  model.upsertTask({ id: 'm1', conversation_id: 'c1', kind: 'monitor', title: 'errors', status: 'running' });
  model.upsertTask({ id: 'a1', conversation_id: 'c1', kind: 'agent', title: 'explore', status: 'done' });
  assert.deepEqual(model.taskCounts('c1'), { shells: { running: 0, total: 1 }, agents: { running: 0, done: 1 },
    workflows: { running: 0, total: 0 }, monitors: { running: 1, total: 1 } });
  assert.equal(model.upsertTask({ id: 'orphan' }), null, 'a new row needs its conversation');
  const conv = model.serializeConversation('c1');
  assert.deepEqual(conv.counts, { shells: 0, agents: 0, workflows: 0, monitors: 1 });
});

test('a conversation serializes with its live state, turn count and open turn', () => {
  const { model, turn } = setup();
  model.upsertConversation('c1', { title: 'first', model: 'opus' });
  model.upsertConversation('c1', { model: 'sonnet', title: undefined });
  model.upsertLive('c1', { state: 'working', since: 3 });
  turn('t1', { status: 'done' });
  turn('t2');
  const c = model.serializeConversation('c1');
  assert.equal(c.title, 'first');
  assert.equal(c.model, 'sonnet');
  assert.equal(c.turn_count, 2);
  assert.equal(c.open_turn_id, 't2');
  assert.equal(c.live.state, 'working');
  // Computed fields cannot be written.
  model.upsertConversation('c1', { turn_count: 99, open_turn_id: 'x', live: { state: 'gone' } });
  assert.equal(model.serializeConversation('c1').turn_count, 2);
  assert.equal(model.serializeConversation('c1').live.state, 'working');
  const page = model.turnPage('c1', { limit: 1 });
  assert.deepEqual(page.turns.map((t) => t.id), ['t2']);
  assert.equal(page.next_before, 2);
  assert.equal(page.total, 2);
});

// ---- purity ------------------------------------------------------------------------------------------

test('the model is pure: it requires nothing and holds no timer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'model.js'), 'utf8');
  assert.deepEqual(src.match(/require\(/g), null, 'model.js requires no module');
  for (const banned of ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'Date.now', 'process.', 'fs.']) {
    assert.equal(src.includes(banned), false, `model.js mentions ${banned}`);
  }
});
