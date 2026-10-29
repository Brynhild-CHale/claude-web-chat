// A chat pin readable after its transcript is gone (PLAN.md 3E.5; RULED
// REQ@chat-lifetime d, CHAT@type a, REQ@chat-wipe a, REQ@visible-states a,
// U451@node-linked-diffs-on-cleanup Q1 a; settled default GONE@leave, PLAN-T3
// §2.3; U456).
//
// The daemon exactly as createServer wires it (withServer), over a scratch git
// repository (test-support/treesnap-fixture, so a turn's code diff is
// recorded) with a private Claude tier (test-support/claude-home) fed only
// synthetic transcripts (test-support/claude-records) and v1 hook envelopes
// posted to the hook intake and the turn routes. Three server lives on one
// root. Pinned:
//   * an ended conversation (no process writes it) with one closed turn
//     attached to a node and a chat-comment on its reply: its transcript
//     unlinked (Claude Code's cleanup) and the server restarted, the boot sweep
//     deletes its session's index, keeps the node-linked turn's diff record
//     (keepDiff, RULED Q1 = a), and the conversation leaves the registry
//     (GET /api/mirror no longer lists it; conversations.json no longer holds
//     it);
//   * GET /api/elements answers the pin {state: 'unavailable', visible:
//     'unavailable', explain: EXPLAIN.unavailable}, its quote, fingerprint and
//     label read from its own record; the element log keeps the pin's one
//     version line (no delete, no new version);
//   * GET /api/mirror/node/:ref answers the ref unavailable:true; GET
//     /api/mirror/diff?node= still answers the turn's diff from its kept
//     record (status 'ready', the combined diff present);
//   * nothing else is lost: a second conversation's turns and pins, the page's
//     elements and the graph's nodes are unchanged;
//   * a second restart: the pin still answers unavailable (re-derived by the
//     resolver, never orphaned, never indexing), the conversation still gone.
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { projectPaths } = require('../lib/core/paths');
const { GONE_TRIGGER } = require('../lib/server/mirror/conversations');

const S1 = '11111111-1111-4111-8111-111111114560';
const S2 = '22222222-2222-4222-8222-222222224560';
const WAIT = { timeout: 15000, interval: 20 };
const CALL_TIMEOUT_MS = 15000;
const PANE = 'cpu-pane';
const REPLY1 = 'Done. The answer is bumped to forty-two, and the pane shows it.';
const REPLY2 = 'Here is the other conversation\'s reply, still on disk.';

const logLines = (root) => {
  let s = '';
  try { s = fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { s = ''; }
  return s.split('\n').filter(Boolean);
};
const linesNaming = (root, id) => logLines(root).filter((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// The project and its Claude tier, outliving each server life.
function project(t) {
  const repo = treesnapRepo(t, { files: { 'src/app.js': 'const answer = 41;\n', 'README.md': 'gone pins\n' } });
  const ch = claudeHome(t, { root: repo.root, isolate: true });
  return { repo, root: repo.root, ch };
}

// One server life on the project's root, and Claude Code's side of it.
async function life(t, p) {
  const d = await withServer(t, { root: p.root, writePortfile: true });
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({
    hook_event_name: event, session_id: sid, transcript_path: p.ch.transcript(sid), cwd: p.ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  const fire = async (event, extra, sid) => {
    const r = await client.post('/api/hooks/event', envelope(event, extra, sid), call);
    assert.equal(r.ok, true, `hook ${event}`);
  };
  const turnBegin = (promptId, text, sid) => {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
  };
  const turnEnd = (reply, sid) => {
    const e = envelope('Stop', { last_assistant_message: reply }, sid);
    return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message }, call);
  };
  const snapshots = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };
  const turnsOf = (cid) => client.get(`/api/mirror/conversations/${cid}/turns?limit=50&items=full`, call);
  const listed = async () => ((await client.get('/api/mirror', call)).conversations || []).map((c) => c.id);
  const elements = async (q = '') => (await ok(d.anonApi.get(`/api/elements${q}`), `GET /api/elements${q}`)).elements;
  const get = (pth) => client.request(d.port, 'GET', pth, null, { timeout: CALL_TIMEOUT_MS });
  return { ...d, call, fire, turnBegin, turnEnd, snapshots, turnsOf, listed, elements, get };
}

// A closed turn of `sid` whose reply the transcript holds; `work` runs inside
// it (an edit, a render); `code` waits for its code diff to settle. Answers
// the turn-end's body, the turn and the reply item.
async function closedTurn(L, p, { sid, promptId, prompt, reply, seed, code = false, work = async () => {} }) {
  p.ch.writeTranscript(sid, []);
  await L.fire('SessionStart', { source: 'startup', model: 'claude-test' }, sid);
  const r = createRecords({ seed, sessionId: sid, cwd: p.ch.cwd, start: Date.now() - 60000, step: 50 });
  const seen = await L.snapshots();
  assert.equal((await L.turnBegin(promptId, prompt, sid)).ok, true, `${promptId} begins`);
  await waitUntil(async () => (await L.snapshots()) > seen, { ...WAIT, what: `${promptId}'s before-snapshot` });
  r.prompt(prompt, { promptId });
  await work(r);
  r.assistant([reply]);
  r.turnDuration({ durationMs: 200, messageCount: 4 });
  p.ch.writeTranscript(sid, r.records);
  const end = await L.turnEnd(reply, sid);
  const turn = await waitUntil(async () => {
    const pg = await L.turnsOf(sid);
    const x = (pg.turns || []).find((y) => y.id === promptId);
    return x && x.status !== 'open' && (code ? x.code && x.code.status !== 'pending' : true)
      && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: `${promptId} closed${code ? ', its code settled' : ''} and the transcript's reply in` });
  const item = (await L.srv.mirror.turn(promptId)).items.find((it) => it.kind === 'reply' && it.source === 'transcript');
  assert.ok(item, `${promptId}'s reply`);
  return { end, turn, reply: item };
}

const PIN_FIELDS = (e) => ({
  id: e.id, type: e.type, v: e.v, text: e.payload && e.payload.text,
  quote: e.anchor.quote, fp: e.anchor.fp, label: e.anchor.label, anchor_label: e.anchor_label,
  conversation_id: e.anchor.conversation_id, session_id: e.anchor.session_id, turn_id: e.anchor.turn_id,
});

test('a chat pin readable after its transcript is gone: the conversation leaves, its pin answers unavailable from its own record, across restarts', { timeout: 240000 }, async (t) => {
  const p = project(t);
  const paths = projectPaths(p.root);
  let L = null;
  // Registered before any life, so each life's daemon stops first.
  t.after(async () => { if (L) await L.stop(); });

  // ── life 1: two conversations, a node, the pins ──
  L = await life(t, p);
  let pagePin = null;
  const appJs = path.join(p.root, 'src', 'app.js');
  const edit = { file_path: appJs, old_string: 'const answer = 41;', new_string: 'const answer = 42;' };
  const one = await closedTurn(L, p, {
    sid: S1, promptId: 'gp-1', prompt: 'bump the answer and show it', reply: REPLY1, seed: 456, code: true,
    work: async (r) => {
      await L.fire('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01GpEdit', tool_input: edit }, S1);
      p.repo.write('src/app.js', 'const answer = 42;\n');
      await L.fire('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01GpEdit', tool_input: edit, tool_response: { filePath: appJs }, duration_ms: 3 }, S1);
      await ok(L.api.post('/api/render', { id: PANE, html: '<p class="lead">Hello world</p>' }), 'render');
      // A page pin on it, committed with the node.
      pagePin = (await ok(L.anonApi.post('/api/elements', {
        type: 'comment', anchor: { mount: PANE, selector: 'p.lead', text: 'Hello world', ordinal: 0 }, payload: { text: 'page note', shared: true },
      }), 'page pin')).element;
      r.assistant([{ type: 'tool_use', name: 'Edit', input: edit, id: 'toolu_01GpEdit' }]);
      r.toolResult('toolu_01GpEdit', `The file ${appJs} has been updated.`);
    },
  });
  const nodeId = one.end.node_id;
  assert.ok(nodeId, `gp-1's Stop committed a node: ${JSON.stringify(one.end)}`);
  assert.equal(one.turn.code.status, 'ready', 'the turn\'s code diff is recorded');
  const nodeBody = (await L.get(`/api/graph/node/${encodeURIComponent(nodeId)}`)).body;
  assert.deepEqual(nodeBody.mirror.turns.map((x) => x.turn_id), ['gp-1'], 'the node links the turn');
  const two = await closedTurn(L, p, { sid: S2, promptId: 'gq-1', prompt: 'the other conversation', reply: REPLY2, seed: 457 });
  assert.deepEqual((await L.listed()).sort(), [S1, S2].sort(), 'two conversations');

  const pinOn = async (reply, text) => (await ok(L.anonApi.post('/api/elements', {
    type: 'chat-comment', anchor: { kind: 'item', item_id: reply.id }, payload: { text, shared: true },
  }), `pin ${text}`)).element;
  const gonePin = await pinOn(one.reply, 'on the gone reply');
  const keptPin = await pinOn(two.reply, 'on the kept reply');
  for (const e of [gonePin, keptPin]) {
    assert.equal(e.state, 'exact', `${e.id} placed`);
    assert.ok(e.anchor.quote && e.anchor.quote.exact, `${e.id}: a bounded quote`);
    assert.ok(e.anchor.fp, `${e.id}: a fingerprint`);
  }
  assert.equal(gonePin.anchor.conversation_id, S1);
  assert.equal(gonePin.anchor_label, 'on turn 1\'s reply');

  const before = {
    gone: PIN_FIELDS(gonePin),
    kept: (await L.elements('?type=chat-comment')).find((e) => e.id === keptPin.id),
    page: await L.elements('?type=comment'),
    graph: (await L.get('/api/graph')).body.nodes.map((n) => [n.id, n.label]),
    s2turns: (await L.turnsOf(S2)).turns.map((x) => [x.id, x.status, x.seq]),
    goneLines: linesNaming(p.root, gonePin.id),
  };
  const kinds = (lines) => lines.map((l) => JSON.parse(l).t);
  assert.deepEqual(kinds(before.goneLines), ['el', 'ver'], 'the gone pin: its identity and its one version line');
  const diffRecord = paths.mirrorDiff('gp-1');
  assert.ok(fs.existsSync(diffRecord), 'gp-1\'s diff record on disk');
  await L.stop();
  assert.ok(fs.existsSync(paths.mirrorIndex(S1)), 'S1\'s index written at the stop');
  assert.ok(fs.existsSync(paths.mirrorIndex(S2)), 'S2\'s index written at the stop');

  // ── Claude Code's cleanup takes S1's transcript ──
  fs.unlinkSync(p.ch.transcript(S1));

  // ── life 2: the boot sweep ──
  L = await life(t, p);
  await waitUntil(async () => !(await L.listed()).includes(S1), { ...WAIT, what: 'the boot sweep removes S1' });

  await t.test('the conversation leaves the registry; its index goes, the node-linked diff record stays', async () => {
    assert.deepEqual(await L.listed(), [S2], 'GET /api/mirror lists only the other conversation');
    assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'S1\'s index deleted');
    assert.equal(fs.existsSync(diffRecord), true, 'the node-linked turn\'s diff record kept (RULED Q1 = a)');
    assert.equal(fs.existsSync(paths.mirrorIndex(S2)), true, 'S2\'s index kept');
    await waitUntil(() => {
      const saved = JSON.parse(fs.readFileSync(paths.mirrorConversations, 'utf8')).conversations.map((c) => c.id);
      return !saved.includes(S1) && saved.includes(S2) ? saved : null;
    }, { ...WAIT, what: 'conversations.json loses S1' });
    assert.equal(GONE_TRIGGER, 'transcript-gone');
  });

  await t.test('its pin answers unavailable with EXPLAIN\'s line, its quote, fingerprint and label read from its own record', async () => {
    const pins = await L.elements('?type=chat-comment');
    const e = pins.find((x) => x.id === gonePin.id);
    assert.ok(e, 'the pin is still listed (never deleted)');
    assert.deepEqual([e.state, e.visible, e.explain], ['unavailable', 'unavailable', EXPLAIN.unavailable]);
    assert.equal(VISIBLE[e.state], e.visible);
    assert.deepEqual(PIN_FIELDS(e), before.gone, 'quote, fingerprint, label and text as created');
    assert.equal(e.anchor_label, 'on turn 1\'s reply', 'the label reads from the record');
    // Every read of the element routes says the same (the full list too).
    const all = (await L.elements()).find((x) => x.id === gonePin.id);
    assert.equal(all.state, 'unavailable');
  });

  await t.test('the element log keeps the pin\'s one version line: no delete, no new version', async () => {
    assert.deepEqual(linesNaming(p.root, gonePin.id), before.goneLines, 'the same lines, no drop, no ver');
  });

  await t.test('the node\'s ref answers unavailable:true; its diff is still answered from the kept record', async () => {
    const turns = (await L.get(`/api/mirror/node/${encodeURIComponent(nodeId)}`)).body;
    assert.equal(turns.turns.length, 1);
    assert.equal(turns.turns[0].id, 'gp-1');
    assert.equal(turns.turns[0].unavailable, true, JSON.stringify(turns.turns[0]));
    assert.notEqual(turns.turns[0].indexing, true);
    const diff = await L.get(`/api/mirror/diff?node=${encodeURIComponent(nodeId)}`);
    assert.equal(diff.status, 200, diff.text);
    assert.deepEqual(diff.body.turns.map((x) => [x.turn_id, x.status]), [['gp-1', 'ready']]);
    assert.ok(diff.body.combined, 'the node\'s combined diff');
    assert.match(String(diff.body.combined.patch || ''), /\+const answer = 42;/);
  });

  await t.test('nothing else is lost: the other conversation\'s turns and pin, the page\'s elements, the graph\'s nodes', async () => {
    // The other conversation read as its chat host reads it (its turns), then
    // its pin. (Before that read, a pin on a conversation the boot opened can
    // answer unavailable: the hand-off's open issue, measured with no cleanup
    // at all, so not this unit's.)
    const s2 = await waitUntil(async () => {
      const pg = await L.turnsOf(S2);
      return pg && Array.isArray(pg.turns) && pg.turns.length ? pg : null;
    }, { ...WAIT, what: 'S2\'s turns' });
    assert.deepEqual(s2.turns.map((x) => [x.id, x.status, x.seq]), before.s2turns);
    const kept = await waitUntil(async () => {
      const e = (await L.elements('?type=chat-comment')).find((x) => x.id === keptPin.id);
      return e && e.state === before.kept.state ? e : null;
    }, { ...WAIT, what: `the other conversation's pin answers ${before.kept.state}` });
    assert.equal(before.kept.state, 'exact');
    assert.deepEqual(PIN_FIELDS(kept), PIN_FIELDS(before.kept));
    assert.deepEqual(await L.elements('?type=comment'), before.page, 'the page\'s elements');
    assert.equal(before.page.find((x) => x.id === pagePin.id).id, pagePin.id);
    assert.deepEqual((await L.get('/api/graph')).body.nodes.map((n) => [n.id, n.label]), before.graph, 'the graph\'s nodes');
  });

  await L.stop();

  // ── life 3: re-derived ──
  L = await life(t, p);
  await t.test('a second restart: the conversation stays gone and the pin still answers unavailable (never orphaned, never indexing)', async () => {
    await waitUntil(async () => (await L.listed()).includes(S2), { ...WAIT, what: 'the registry loaded' });
    assert.deepEqual(await L.listed(), [S2]);
    const e = (await L.elements('?type=chat-comment')).find((x) => x.id === gonePin.id);
    assert.deepEqual([e.state, e.visible, e.explain], ['unavailable', 'unavailable', EXPLAIN.unavailable]);
    assert.deepEqual(PIN_FIELDS(e), before.gone);
    assert.deepEqual(linesNaming(p.root, gonePin.id), before.goneLines);
    assert.equal(fs.existsSync(diffRecord), true, 'the diff record still kept');
    const diff = await L.get(`/api/mirror/diff?node=${encodeURIComponent(nodeId)}`);
    assert.equal(diff.body.turns[0].status, 'ready');
  });
});
