'use strict';
// Tranche 3 end to end (annotation engine PLAN.md §4, "The chat family, as a
// group"; DECISIONS.md L.1–L.4, K.5; U460). The daemon exactly as createServer
// wires it (withServer), over a scratch git repository
// (test-support/treesnap-fixture, so a turn's code diff is recorded), with a
// private Claude tier (test-support/claude-home, isolate: true) fed only
// synthetic transcripts (test-support/claude-records, rewind-fixtures) and v1
// hook envelopes. Two worlds:
//
// WORLD A — one conversation through the hooks (turn cp-1: a Read card, an
// Edit of src/app.js, the reply; a provisional turn hook-p), a remote viewer
// whose project is not opted in (basic) and a stubbed network peer:
//   (1)  a chat-comment on a turn, a passage, a tool card and a diff line:
//        POST /api/elements, then GET answers each placed with its EXPLAIN line;
//   (2)  a rewind in the transcript supersedes one;
//   (3)  a learned value masks one: masked, never exact, no served body holding
//        the value and no text in the answer;
//   (4)  an rh_ target refused with the hint (409, state provisional);
//   (11) POST /api/elements/:id/send queues once; a second send says already;
//   (12) a comment on a heading reads 'on section "…"' and a comment on a
//        highlight reads its chain, in the queue summary and in get_comments
//        (the real handler, lib/mcp/tools/get_comments.js, in a subprocess
//        with cwd the root and WEB_CHAT_PORT the daemon's port);
//   (9)  the excerpt switch off → the envelope ids-only; on → one excerpt
//        block for a batch of 20 pins in one delivery, within ENVELOPE_MAX;
//   (10) a basic socket and a network peer see no anchor text, no excerpt, no
//        chain label words and no Push note in any frame or route;
//   (8)  a page Wipe, a bulk clear and New graph keep every chat pin, its
//        versions in the element log alone (C1, WIPE@chat), and no commit
//        record, close record or node file names a chat element (D5);
//   (13) the preview document of a node made while chat pins existed, its
//        export and the replay path and document carry no chat-comment record,
//        quote or glyph (L2);
//   (7)  the disk budget half: no budget set (no .web-chat/mirror.json), a
//        mirror over 5 GiB (a sparse file) and diff records 40 days old — after
//        the first housekeeping nothing is deleted and no budget line is logged;
//   AG-1 every node file and log record read as alpha.2 reads them
//        (test/fixtures/alpha2-log-shape.json, derived once from cf3af5d):
//        node ids and comment counts unchanged, the log's earlier bytes a
//        prefix of its later ones, and the residuals named.
//
// WORLD B — a registry of 205 conversations written before the boot (more
// than 0.8.5's cap of 200), over a graph with one node:
//   (5)  the boot parses only the eager set (the three active after the
//        graph-link cutoff); an old conversation's pin answers indexing from
//        the resolver's list with no parse kicked, and from GET /api/elements
//        without waiting; placed once a host's direct read has parsed it;
//   (6)  a deleted transcript leaves its pin unavailable, its quote,
//        fingerprint and label readable;
//   (7)  the count and age half: every conversation listed, every index file
//        kept, the 40-day-old diff records kept.
//
// A test never requires design/ (CI has none), never runs `claude`, and never
// reaches the user's ~/.claude or ~/.web-chat (test-support/sandbox).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { withServer, waitUntil, commentBody } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords, jsonl } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const rewindFixtures = require('../test-support/rewind-fixtures');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { INTAKE_EVENTS } = require('../lib/server/routes/hooks');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { SCHEMAS } = require('../lib/core/element-log');
const { setSwitch } = require('../lib/core/excerpts');
const { readMirrorSettings } = require('../lib/core/mirror-settings');
const { LIMITS } = require('../lib/server/mirror/codediff');
const { bootCutoff } = require('../lib/server/mirror/graph-link');
const { EXCERPT_HEADER, ENVELOPE_MAX } = require('../lib/channel/envelope');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const SHAPE = require('./fixtures/v3-node-shape.json');
const ALPHA2 = require('./fixtures/alpha2-log-shape.json');

const REPO = path.resolve(__dirname, '..');
const S1 = '11111111-1111-4111-8111-111111114600';
const S2 = '22222222-2222-4222-8222-222222224600';
const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const WAIT = { timeout: 20000, interval: 20 };
const CALL_TIMEOUT_MS = 20000;
const DAY = 24 * 60 * 60 * 1000;
const GiB = 1024 ** 3;
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

// The markers: a chat pin's own words (CPIN), a page comment's (PIN), the
// conversation's (CONV, so it rides each chat pin's quote, label and
// excerpt), the Push note's (NOTE).
const CPIN = 'wc-u460-chat-pin';
const PIN = 'wc-u460-page-pin';
const CONV = 'wc-u460-conv';
const NOTE = 'wc-u460-push-note';
const FAKES = fakeSecrets();
const EMAIL = FAKES.find((x) => x.id === 'known-email');
const E = EMAIL.secrets[0];
const PROMPT = `please bump the answer ${CONV}-prompt and read a.md first`;
const READ_INPUT = { file_path: '/tmp/project/a.md' };
const PASSAGE = `the ${CONV}-passage anchor is here.`;
const SECRET_PASSAGE = `Contact ${E} for access`;
const REPLY = `Done. ${SECRET_PASSAGE} to the staging host. Later on, ${PASSAGE}`;
const APP_BEFORE = 'const answer = 41;\n';
const APP_AFTER = `const answer = '${CONV}-diff';\n`;

const SIX = ['placed', 'refused', 'superseded', 'masked', 'indexing', 'unavailable'];
const has = (v, s) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).includes(s);
const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const logRecords = (root) => logBytes(root).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const nodeFiles = (root) => {
  const dir = projectPaths(root).graphDir;
  return fs.readdirSync(dir).filter((f) => /^n\d+\.json$/.test(f)).map((f) => ({ f, node: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
};
const groupOf = (items, id) => items.find((it) => it.kind === 'element' && (it.element_ids || [it.element_id]).includes(id));

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// Every chat record carries one of L4's six states with its one line.
function assertAnswered(e, label) {
  assert.ok(SIX.includes(e.visible), `${label}: ${e.visible} is one of the six`);
  assert.equal(e.visible, VISIBLE[e.state], `${label}: visible is VISIBLE[state] (${e.state})`);
  assert.equal(e.explain, EXPLAIN[e.visible], `${label}: its EXPLAIN line`);
}

// A network peer (WEB_CHAT_HOST bind): the request's socket address stubbed
// before the app sees it (test/element-routes-private.test.js's pattern).
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

// Every frame a socket gets, raw and parsed.
async function listen(t, port, headers) {
  const raw = [];
  const frames = [];
  const sock = new WebSocket(`ws://localhost:${port}/ws`, { headers });
  sock.on('message', (data) => {
    const s = data.toString();
    raw.push(s);
    try { frames.push(JSON.parse(s)); } catch {}
  });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  t.after(() => { try { sock.terminate(); } catch {} });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'hello' });
  return { raw, frames, of: (type) => frames.filter((f) => f.type === type) };
}

// get_comments through its real handler, run as Claude Code's MCP server runs
// it: a process of its own, cwd the project, WEB_CHAT_PORT the daemon's port
// (U340's step (3) shape). Async: the daemon answers in this process.
function getComments(root, port, args) {
  const script = `
    const tool = require(${JSON.stringify(path.join(REPO, 'lib/mcp/tools/get_comments.js'))});
    tool.handler(${JSON.stringify(args)}).then(
      (v) => { process.stdout.write(JSON.stringify({ ok: true, value: v })); },
      (e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message) })); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...process.env, WEB_CHAT_PORT: String(port), WEB_CHAT_MCP_SERVER: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error(`get_comments timed out: ${err}`)); }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        if (!r.ok) reject(new Error(`get_comments failed: ${r.error} ${err}`));
        else resolve(r.value);
      } catch (e) { reject(new Error(`get_comments answered no JSON: ${out} ${err}`)); }
    });
  });
}

// ── AG-1 against alpha.2's reader (the fixture) ─────────────────────────────
const RE = Object.fromEntries(Object.entries(ALPHA2.patterns).map(([k, v]) => [k, new RegExp(v)]));
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
function parsePin(s) {
  if (typeof s !== 'string') return null;
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const tail = s.slice(at + 1);
  if (!RE.pin_v.test(tail)) return null;
  return { id: s.slice(0, at), v: Number(tail) };
}
function answerItemProblem(it) {
  const A = ALPHA2.answer_item;
  if (!isObj(it)) return 'not-an-object';
  for (const k of Object.keys(it)) if (!A.keys.includes(k)) return `key:${k}`;
  if (typeof it.id !== 'string' || !RE.element_id.test(it.id) || !isPosInt(it.v)) return 'id';
  if (typeof it.mount !== 'string' || !it.mount || it.mount.length > A.mount_max) return 'mount';
  if (!A.states.includes(it.state)) return 'state';
  for (const k of ['how', 'why']) if (it[k] !== undefined && !(typeof it[k] === 'string' && RE.answer_code.test(it[k]))) return k;
  if (it.tie !== undefined && !(typeof it.tie === 'number' && Number.isFinite(it.tie))) return 'tie';
  if (!Number.isSafeInteger(it.gen) || it.gen < 0) return 'gen';
  if (!Number.isSafeInteger(it.surface)) return 'surface';
  const q = it.qual;
  if (!isObj(q) || Object.keys(q).length !== 2 || !RE.answer_hash.test(q.spec) || !RE.answer_hash.test(q.store)) return 'qual';
  const src = it.source;
  if (!isObj(src) || Object.keys(src).some((k) => k !== 'peer' && k !== 'device')
    || !A.peers.includes(src.peer) || !(src.device == null || A.devices.includes(src.device))) return 'source';
  if (it.record !== undefined) {
    let bytes = Infinity;
    try { bytes = Buffer.byteLength(JSON.stringify(it.record)); } catch {}
    if (!isObj(it.record) || bytes > A.record_max) return 'record';
  }
  return null;
}
const FIELD = {
  'non-empty-string': (v) => typeof v === 'string' && v.length > 0,
  'positive-integer': isPosInt,
  array: (v) => Array.isArray(v),
  boolean: (v) => typeof v === 'boolean',
  'array-of-pin-keys': (v) => Array.isArray(v) && v.every((s) => { const p = parsePin(s); return p !== null && isPosInt(p.v) && RE.element_id.test(p.id); }),
  'array-of-ack-keys': (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && RE.ack_key.test(s)),
  'answer-items': (v) => Array.isArray(v) && v.length > 0 && v.every((it) => answerItemProblem(it) === null),
};
function alpha2Reading(rec) {
  const rules = Object.prototype.hasOwnProperty.call(ALPHA2.indexed, rec.t) ? ALPHA2.indexed[rec.t] : null;
  if (!rules) return 'unknown';
  for (const [field, kind] of Object.entries(rules)) {
    if (!FIELD[kind]) throw new Error(`alpha2-log-shape.json: unknown field kind ${kind}`);
    if (!FIELD[kind](rec[field])) return `skipped (${field})`;
  }
  return 'indexed';
}
function fits(rule, value) {
  switch (rule.type) {
    case 'string': return typeof value === 'string' && (!rule.pattern || new RegExp(rule.pattern).test(value));
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object|null': return value === null || (typeof value === 'object' && !Array.isArray(value));
    case 'array-of-objects': return Array.isArray(value) && value.every((r) => r && typeof r === 'object' && !Array.isArray(r));
    case 'array': return Array.isArray(value);
    default: throw new Error(`v3-node-shape.json: unknown rule type ${rule.type}`);
  }
}
function shapeProblems(rules, obj, where) {
  const out = [];
  for (const [field, rule] of Object.entries(rules)) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) { if (rule.required) out.push(`${where}: ${field} missing`); continue; }
    if (!fits(rule, obj[field])) out.push(`${where}: ${field} ${JSON.stringify(obj[field])} is not ${rule.type}`);
  }
  return out;
}

// ── world A ──────────────────────────────────────────────────────────────────
async function worldA(t) {
  const repo = treesnapRepo(t, { files: { 'src/app.js': APP_BEFORE, 'README.md': 'tranche 3\n' } });
  const root = repo.root;
  const ch = claudeHome(t, { root, isolate: true });
  // A tunnel config that opts this project in at nothing: a remote viewer is basic.
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: {} } });
  // The mirror's log lines (console.error '[web-chat] …'), kept for step (7).
  const lines = [];
  const realError = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  t.after(() => { console.error = realError; });
  const d = await withServer(t, { root, writePortfile: true, seed });
  t.after(stubPeers(d.server));
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({
    hook_event_name: event, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  const post = async (e) => { const r = await client.post('/api/hooks/event', e, call); assert.equal(r.ok, true, `hook ${e.event}`); };
  const fire = (event, extra, sid) => post(envelope(event, extra, sid));
  const turnBegin = (promptId, text, sid = S1) => {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
  };
  const turnEnd = (reply, sid = S1) => {
    const e = envelope('Stop', { last_assistant_message: reply }, sid);
    return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message }, call);
  };
  const snapshots = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };
  const items = async (turnId) => { const x = await d.srv.mirror.turn(turnId); return x ? x.items : []; };
  const sockets = { local: await listen(t, d.port, {}), remote: await listen(t, d.port, { ...REMOTE }) };

  // Step (7)'s mirror, made before the first snapshot (the first housekeeping
  // and budget check follow it): a sparse 5 GiB file under the mirror and two
  // diff records 40 days old; no .web-chat/mirror.json (no budget set).
  const P = projectPaths(root);
  fs.mkdirSync(P.mirrorIndexDir, { recursive: true });
  const pad = path.join(P.mirrorIndexDir, 'u460-pad.bin');
  fs.writeFileSync(pad, '');
  fs.truncateSync(pad, 5 * GiB);
  const oldAt = new Date(Date.now() - 40 * DAY);
  const oldDiffs = ['u460-old-1', 'u460-old-2'].map((id) => {
    const f = P.mirrorDiff(id);
    writeJsonAtomic(f, { v: 1, turn_id: id, status: 'ready', at: oldAt.getTime() });
    fs.utimesSync(f, oldAt, oldAt);
    return f;
  });

  // Turn cp-1: a Read card, an Edit of src/app.js (its code diff), the reply.
  ch.writeTranscript(S1, []);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const r = createRecords({ seed: 460, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const seen = await snapshots();
  assert.equal((await turnBegin('cp-1', PROMPT)).ok, true);
  await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: 'cp-1\'s before-snapshot' });
  const appJs = path.join(root, 'src', 'app.js');
  const edit = { file_path: appJs, old_string: APP_BEFORE.trim(), new_string: APP_AFTER.trim() };
  await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01U460Edit', tool_input: edit });
  repo.write('src/app.js', APP_AFTER);
  await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01U460Edit', tool_input: edit, tool_response: { filePath: appJs }, duration_ms: 3 });
  r.prompt(PROMPT, { promptId: 'cp-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: READ_INPUT, id: 'toolu_01U460Read' }]);
  r.toolResult('toolu_01U460Read', 'file a');
  r.assistant([{ type: 'tool_use', name: 'Edit', input: edit, id: 'toolu_01U460Edit' }]);
  r.toolResult('toolu_01U460Edit', `The file ${appJs} has been updated.`);
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 200, messageCount: 6 });
  ch.writeTranscript(S1, r.records);
  await turnEnd(REPLY);
  await waitUntil(async () => {
    const p = await client.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=full`, call);
    const x = (p.turns || []).find((y) => y.id === 'cp-1');
    return x && x.status !== 'open' && x.code && x.code.status === 'ready'
      && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: 'cp-1 closed, its code ready and the transcript\'s reply in' });
  const its = await items('cp-1');
  const reply = its.find((it) => it.kind === 'reply' && it.source === 'transcript');
  const card = its.find((it) => it.kind === 'tool_call' && it.tool === 'Read') || its.find((it) => it.kind === 'tool_call');
  assert.ok(reply && card, 'a reply and a tool card');

  // Turn hook-p: a prompt and a Stop the transcript never records — a
  // provisional turn whose reply is the Stop's rh_.
  assert.equal((await turnBegin('hook-p', 'a provisional turn')).ok, true);
  await turnEnd('The stop hook\'s reply.');
  await waitUntil(async () => (await items('hook-p')).some((it) => it.id === 'rh_hook-p'), { ...WAIT, what: 'the Stop\'s rh_ reply' });

  const served = async () => (await d.srv.mirror.itemField(reply.id, { field: 'text' })).text;
  const posOf = async (exact) => {
    const s = await served();
    const at = s.indexOf(exact);
    assert.ok(at >= 0, `the passage is served: ${exact}`);
    return { start: at, end: at + exact.length };
  };
  const pin = (anchor, payload = {}, api = d.anonApi) => api.post('/api/elements', { type: 'chat-comment', anchor, payload: { text: `${CPIN} a note`, shared: true, ...payload } });
  const list = async (q = '?type=chat-comment', api = d.anonApi) => (await ok(api.get(`/api/elements${q}`), `GET ${q}`)).elements;
  const lib = (method, p, body, headers = {}) => client.request(d.port, method, p, body, { headers, timeout: CALL_TIMEOUT_MS });
  const turn = async (message) => {
    await ok(d.api.post('/api/turn-begin', { message }), 'turn-begin');
    await ok(d.api.post('/api/render', { id: 'e2e-pane', html: `<p class="lead">Hello the pane words ${Date.now()}</p>` }), 'render');
    return (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end')).node_id;
  };
  return { ...d, repo, ch, r, call, post, fire, envelope, turnBegin, turnEnd, items, sockets, reply, card, served, posOf, pin, list, lib, turn, lines, pad, oldDiffs };
}

test('world A: a conversation through the hooks meets tranche 3 end to end (steps 1–4, 7–13, AG-1)', { timeout: 300000 }, async (t) => {
  const w = await worldA(t);
  const ids = {};
  const logAt = {};

  await t.test('(1) a chat-comment on a turn, a passage, a tool card and a diff line: each placed with its EXPLAIN line', async () => {
    const cases = [
      ['turn', { kind: 'turn', turn_id: 'cp-1' }, 'on turn 1'],
      ['passage', { kind: 'item-range', item_id: w.reply.id, pos: await w.posOf(PASSAGE) }, `on turn 1's reply: "${PASSAGE}"`],
      ['card', { kind: 'item', item_id: w.card.id }, `on tool card ${w.card.tool}`],
      ['diff', { kind: 'diff-line', turn_id: 'cp-1', file: 'src/app.js', side: 'new', line: 1 }, 'on diff line src/app.js:1'],
    ];
    for (const [name, anchor, label] of cases) {
      const el = (await ok(w.pin(anchor, { text: `${CPIN} on the ${name}` }), `POST ${name}`)).element;
      ids[name] = el.id;
      assert.equal(el.type, 'chat-comment');
      assert.equal(el.schema, CHAT);
      assert.match(el.id, /^k\d+$/);
      assert.equal(el.anchor.kind, anchor.kind);
      assert.equal(el.anchor_label, label, `${name}: anchor_label`);
    }
    const got = await w.list();
    for (const [name] of cases) {
      const e = got.find((x) => x.id === ids[name]);
      assert.ok(e, `${name}: listed`);
      assert.equal(e.visible, 'placed', `${name}: placed`);
      assert.equal(e.explain, EXPLAIN.placed, `${name}: the placed line`);
      assertAnswered(e, name);
    }
    assert.ok(has(got.find((x) => x.id === ids.diff).anchor.quote, `${CONV}-diff`), 'the diff line quotes the served diff');
  });

  await t.test('(4) an rh_ target and a provisional turn are refused with the hint: 409, state provisional, nothing minted', async () => {
    const bytes = logBytes(w.root);
    for (const anchor of [{ kind: 'item', item_id: 'rh_hook-p' }, { kind: 'turn', turn_id: 'hook-p' }]) {
      const r = await w.pin(anchor);
      assert.equal(r.status, 409, `${JSON.stringify(anchor)}: ${r.text}`);
      assert.deepEqual(r.json, { error: 'provisional', state: 'provisional', hint: EXPLAIN.refused });
      assert.equal(VISIBLE.provisional, 'refused', 'the refused line is the provisional state\'s');
    }
    assert.equal(logBytes(w.root), bytes, 'the element log\'s bytes are unchanged');
  });

  await t.test('(2) a rewind in the transcript supersedes a pinned turn', async () => {
    const f = rewindFixtures.branch({ sessionId: S2, start: Date.now() - 60000 });
    w.ch.writeTranscript(S2, []);
    const base = { sessionId: S2, transcriptPath: w.ch.transcript(S2), cwd: w.ch.cwd };
    for (const hook of f.hooks) {
      if (INTAKE_EVENTS.includes(hook.event)) await w.post(rewindFixtures.envelope(hook, base));
    }
    const cut = f.records.findIndex((x) => x.promptId === 'rw-4');
    w.ch.writeTranscript(S2, f.records.slice(0, cut));
    await waitUntil(async () => { const x = await w.srv.mirror.turn('rw-3'); return x && x.turn && x.turn.status !== 'open'; }, { ...WAIT, what: 'rw-3 closed' });
    const pinned = (await ok(w.pin({ kind: 'turn', turn_id: 'rw-2' }, { text: `${CPIN} on a turn to be rewound` }), 'pin rw-2')).element;
    assert.equal(pinned.state, 'exact');
    ids.rewound = pinned.id;
    fs.appendFileSync(w.ch.transcript(S2), jsonl(f.records.slice(cut)));
    const e = await waitUntil(async () => {
      const x = (await w.list()).find((y) => y.id === pinned.id);
      return x && x.state === 'superseded' ? x : null;
    }, { ...WAIT, what: 'the pin superseded' });
    assertAnswered(e, 'superseded');
    assert.equal(e.explain, EXPLAIN.superseded);
  });

  await t.test('(3) a value learned after the pin masks it: masked, never exact; no served body holds the value; the answer carries no text', async () => {
    const made = (await ok(w.pin({ kind: 'item-range', item_id: w.reply.id, pos: await w.posOf(SECRET_PASSAGE) }, { text: `${CPIN} about the contact` }), 'pin the passage')).element;
    assert.equal(made.state, 'exact', 'placed before the value is known');
    ids.masked = made.id;
    w.r.sessionContext({ userEmail: E });
    w.ch.writeTranscript(S1, w.r.records);
    const e = await waitUntil(async () => {
      const x = (await w.list()).find((y) => y.id === made.id);
      return x && x.state === 'masked' ? x : null;
    }, { ...WAIT, what: 'the pin masked' });
    assertAnswered(e, 'masked');
    assert.notEqual(e.state, 'exact');
    for (const [who, get] of [
      ['local', () => w.anonApi.get('/api/elements?type=chat-comment')],
      ['lib/client', () => w.lib('GET', '/api/elements?type=chat-comment')],
    ]) {
      const r = await get();
      const text = JSON.stringify(r.json || r.body);
      assert.deepEqual(findLeaks(text, [EMAIL]), [], `${who}: no body holds the email`);
    }
    // The answer's placement data: offsets and ids only (the resolver's allowlist), never served text.
    for (const [k, v] of Object.entries(e.at || {})) {
      assert.ok(typeof v === 'number' || (typeof v === 'string' && !v.includes('@') && v.length <= 200), `at.${k} is an offset or an id`);
    }
    assert.deepEqual(findLeaks(JSON.stringify({ state: e.state, at: e.at, how: e.how, note: e.note }), [EMAIL]), [], 'the answer holds no span of the value');
  });

  await t.test('(11) Send to Claude queues once; a second send says already', async () => {
    const mine = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: `${CPIN} mine, then sent`, shared: false }), 'a private pin')).element;
    assert.equal(groupOf(w.srv.state.queue, mine.id), undefined, 'a private pin raises nothing');
    const first = await ok(w.anonApi.post(`/api/elements/${mine.id}/send`, { device: 'desktop' }), 'send');
    assert.equal(typeof first.item.id, 'string');
    assert.ok(!first.already, 'the first send raised it');
    const second = await ok(w.anonApi.post(`/api/elements/${mine.id}/send`, { device: 'desktop' }), 'send again');
    assert.equal(second.already, true, 'the second says already');
    assert.equal(second.item.id, first.item.id, 'the same item');
    assert.equal(w.srv.state.queue.filter((it) => it.kind === 'element' && (it.element_ids || [it.element_id]).includes(mine.id)).length, 1, 'queued once');
    ids.sent = mine.id;
  });

  await t.test('(12) a comment on a heading reads on section "…"; a comment on a highlight reads its chain — in the queue summary and get_comments', async () => {
    const pane = 'Hello the highlighted words here';
    await ok(w.api.post('/api/render', { id: 'm1', html: `<p class="lead">${pane}</p>` }), 'render m1');
    await ok(w.api.post('/api/markdown', { id: 'md-opts', text: '## Options\n\nPick one.' }), 'markdown');
    const exact = 'the highlighted words';
    const at = pane.indexOf(exact);
    const hl = (await ok(w.anonApi.post('/api/elements', { type: 'highlight', anchor: { v: 1, kind: 'range', mount: 'm1', quote: { exact, prefix: pane.slice(0, at), suffix: pane.slice(at + exact.length) }, pos: { start: at, end: at + exact.length } }, payload: { color: 'gold', note: '' } }), 'highlight')).element;
    const chained = (await ok(w.anonApi.post('/api/elements', { type: 'comment', anchor: { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 }, payload: { text: `${PIN} on the highlight`, shared: true, chain: [hl.id] } }), 'chained comment')).pin;
    const heading = (await ok(w.anonApi.post('/api/elements', commentBody({
      text: `${PIN} on the heading`, shared: true,
      anchor: { v: 1, kind: 'source', md: 'md-opts', slug: 'options', quote: { exact: 'Options', prefix: '## ', suffix: '\n\nPick one.' }, pos: { start: 3, end: 10 } },
      locator: { mount: 'md-opts', selector: 'h2', text: 'Options', ordinal: 0, section: 'Options' },
    })), 'heading comment')).pin;
    ids.chained = chained.id;
    ids.heading = heading.id;
    ids.highlight = hl.id;
    const cg = groupOf(w.srv.state.queue, chained.id);
    const hg = groupOf(w.srv.state.queue, heading.id);
    assert.ok(cg && hg, 'both queued');
    assert.ok(cg.summary.includes(`on highlight ${hl.id}`), `the chain in the summary: ${cg.summary}`);
    assert.ok(hg.summary.includes('on section "Options"'), `on section in the summary: ${hg.summary}`);
    const read = await getComments(w.root, w.port, { type: 'comment' });
    const list = read.comments || [];
    const c = list.find((x) => x.id === chained.id);
    const h = list.find((x) => x.id === heading.id);
    assert.ok(c && h, `get_comments lists both: ${JSON.stringify(list.map((x) => x.id))}`);
    assert.ok(has(c.chain_label, `highlight ${hl.id}`), `get_comments: the chain label ${c.chain_label}`);
    assert.ok(has(h.anchor_label, 'on section "Options"'), `get_comments: the section label ${h.anchor_label}`);
  });

  await t.test('(9) the excerpt switch off: the envelope is ids-only; on: one excerpt block for a batch of 20 pins in one delivery, within ENVELOPE_MAX', async () => {
    const drain = async () => {
      const p = (await ok(w.api.get('/api/queue/pending'), 'pending')).pending;
      if (p) await ok(w.api.post('/api/queue/pending/consume', { id: p.id }), 'consume');
    };
    await drain();
    const batch = async (tag) => {
      const out = [];
      for (let i = 0; i < 20; i++) out.push((await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: `${CPIN} ${tag} ${i}` }), `${tag} ${i}`)).element.id);
      return out;
    };
    const deliver = async () => {
      const pushed = await ok(w.api.post('/api/queue/push', { note: `${NOTE} for the batch` }), 'push');
      assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
      return (await ok(w.api.get('/api/queue/pending'), 'pending')).pending.envelope.content;
    };
    setSwitch(w.root, false);
    const off = await batch('off');
    const contentOff = await deliver();
    assert.ok(!contentOff.includes(EXCERPT_HEADER), 'off: no excerpt block');
    assert.ok(!contentOff.includes(`${CONV}-prompt`), 'off: no quote of the conversation');
    for (const id of off) assert.ok(contentOff.includes(id), `off: ${id} named`);
    await drain();
    setSwitch(w.root, true);
    const on = await batch('on');
    const content = await deliver();
    assert.equal(content.split(`${EXCERPT_HEADER}:`).length - 1, 1, 'on: one excerpt block');
    for (const id of on) assert.ok(content.includes(id), `on: ${id} named`);
    assert.ok(content.includes(`${CONV}-prompt`), 'on: the turn\'s quote rides the block');
    assert.ok(content.length <= ENVELOPE_MAX, `within ENVELOPE_MAX: ${content.length}`);
    ids.batch = [...off, ...on];
    await drain();
  });

  await t.test('(10) a basic socket and a network peer: no anchor text, excerpt, chain label words or Push note in any frame or route', async () => {
    // A Push with a note now, so a parked delivery with its note is there to read.
    await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: `${CPIN} for the noted push` }), 'a pin to push');
    assert.equal((await ok(w.api.post('/api/queue/push', { note: `${NOTE} the second` }), 'push')).mode, 'parked');
    const mine = (await ok(w.api.get('/api/queue/pending'), 'local pending')).pending;
    assert.ok(has(mine.note, NOTE), 'precondition: a local reader gets the Push note');
    const MARKS = [CONV, NOTE, `on highlight ${ids.highlight}`, 'on section "Options"', PIN, CPIN];
    const hits = (v) => MARKS.filter((m) => has(v, m));
    // Precondition: the local socket did carry them (the excerpts were on, the note was pushed).
    assert.ok(w.sockets.local.raw.some((s) => s.includes(CONV)), 'the local socket carried the conversation\'s words');
    const leaking = w.sockets.remote.raw.filter((s) => hits(s).length);
    assert.deepEqual(leaking.map((s) => [JSON.parse(s).type, hits(s)]), [], 'no basic frame holds a marker');
    assert.ok(w.sockets.remote.frames.some((f) => f.type === 'queue'), 'the basic socket still got queue frames');
    for (const p of ['/api/events?since=0', '/api/queue', '/api/queue/pending', '/api/elements?type=chat-comment', '/api/elements?type=comment', '/api/graph']) {
      for (const [who, headers] of [['basic remote', REMOTE], ['network peer', PEER]]) {
        const r = await w.lib('GET', p, null, headers);
        assert.deepEqual(hits(r.body), [], `${who} ${p} (${r.status}): no marker`);
      }
    }
    const basic = (await w.lib('GET', '/api/queue/pending', null, REMOTE)).body;
    if (basic && basic.pending) assert.equal(basic.pending.note_hidden, true, 'basic: the note is hidden, and says so');
    await ok(w.api.post('/api/queue/pending/consume', { id: mine.id }), 'consume');
  });

  let nodeWithPins = null;
  await t.test('(8) a page Wipe, a bulk clear and New graph keep every chat pin, its versions in the log alone; no commit record, close or node names a chat element', async () => {
    nodeWithPins = await w.turn('a node while chat pins exist');
    assert.ok(nodeWithPins, 'a node committed');
    logAt.before = logBytes(w.root);
    const before = (await w.list()).map((e) => e.id).sort();
    assert.ok(before.length >= 10, `chat pins live: ${before.length}`);
    await ok(w.api.post('/api/graph/wipe', {}), 'wipe');
    assert.deepEqual((await w.list()).map((e) => e.id).sort(), before, 'after a Wipe');
    await w.api.post('/api/clear', {});
    assert.deepEqual((await w.list()).map((e) => e.id).sort(), before, 'after a bulk clear');
    await ok(w.api.post('/api/graph/new', {}), 'new graph');
    assert.deepEqual((await w.list()).map((e) => e.id).sort(), before, 'after New graph');
    await w.turn('a node after New graph');
    const recs = logRecords(w.root);
    const chatIds = new Set(before);
    for (const id of chatIds) {
      const kinds = [...new Set(recs.filter((x) => x.id === id).map((x) => x.t))].sort();
      assert.deepEqual(kinds, ['el', 'ver'], `${id}: its identity and versions, nothing else`);
    }
    const pinned = (list) => (list || []).map((p) => String(p).split('@')[0]);
    for (const x of recs) {
      if (x.t === 'commit') assert.deepEqual(pinned(x.pins).filter((id) => chatIds.has(id)), [], `commit ${x.node} names no chat element`);
      if (x.t === 'close') assert.deepEqual(pinned(x.held).filter((id) => chatIds.has(id)), [], 'a close holds no chat element');
    }
    for (const { f, node } of nodeFiles(w.root)) {
      for (const id of chatIds) assert.ok(!has(node, `"${id}"`) && !has(node, `"${id}@`), `${f} names no chat element (${id})`);
    }
  });

  await t.test('(13) no document carries a chat pin: the preview, the export and the replay of a node made while chat pins existed', async () => {
    const chatIds = (await w.list()).map((e) => e.id);
    const bodies = [];
    for (const p of [`/preview/node/${nodeWithPins}`, `/api/export/${nodeWithPins}`, `/api/replay/path?to=${nodeWithPins}`, `/replay?to=${nodeWithPins}`]) {
      const r = await w.anonApi.get(p);
      assert.equal(r.status, 200, `${p}: ${String(r.text).slice(0, 200)}`);
      bodies.push([p, r.text]);
    }
    for (const [p, body] of bodies) {
      assert.ok(!body.includes('chat-comment'), `${p}: no chat-comment record`);
      assert.ok(!body.includes(CPIN), `${p}: no chat pin's words`);
      assert.ok(!body.includes('el-layer-chat') && !body.includes('pin-marker'), `${p}: no chat glyph`);
      for (const id of chatIds) assert.ok(!body.includes(`"${id}"`), `${p}: no chat id ${id}`);
    }
  });

  await t.test('(7) no disk budget set: a mirror over 5 GiB and diff records 40 days old — nothing deleted at the first housekeeping, no budget line', async () => {
    assert.equal(fs.existsSync(projectPaths(w.root).mirrorSettings), false, 'no .web-chat/mirror.json');
    assert.equal(readMirrorSettings(projectPaths(w.root)).disk_budget_bytes, null, 'no budget');
    assert.equal(LIMITS.DISK_BUDGET_BYTES, null, 'the default is unlimited (P4 = c)');
    // The first housekeeping follows cp-1's snapshot; three later turns have
    // snapshotted since. Give the check its turn on the event loop.
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(fs.existsSync(w.pad) && fs.statSync(w.pad).size === 5 * GiB, 'the 5 GiB file kept');
    for (const f of w.oldDiffs) assert.ok(fs.existsSync(f), `${path.basename(f)}: a 40-day-old diff record kept`);
    assert.deepEqual(w.lines.filter((l) => l.includes('[mirror] budget')), [], 'no budget line');
    assert.ok(!w.lines.some((l) => l.includes('shadow-store-full')), 'recording never stopped');
  });

  await t.test('AG-1: every node file and log record read as alpha.2 reads them; node ids and comment counts unchanged; the log only appended to', () => {
    const now = logBytes(w.root);
    assert.ok(now.startsWith(logAt.before), 'the log\'s earlier bytes are a prefix of its later ones');
    for (const { f, node } of nodeFiles(w.root)) {
      assert.equal(`${node.id}.json`, f, `${f}: its id`);
      assert.deepEqual(shapeProblems(SHAPE.node, node, f), []);
      const comments = node.comments || [];
      assert.ok(comments.every((c) => !/^k\d+$/.test(String(c.id))), `${f}: no chat pin among its comments`);
      for (const c of comments) assert.deepEqual(shapeProblems(SHAPE.comment, c, `${f} ${c.id}`), []);
    }
    const readings = new Map();
    const schemas = new Set();
    for (const rec of logRecords(w.root)) {
      const how = alpha2Reading(rec);
      assert.ok(how === 'indexed' || how === 'unknown', `alpha.2 would skip a ${rec.t} record: ${how} ${JSON.stringify(rec).slice(0, 200)}`);
      if (!readings.has(rec.t)) readings.set(rec.t, how);
      if (rec.t === 'ver' && typeof rec.schema === 'string') schemas.add(rec.schema);
    }
    // The residuals, named for the acceptor and the alpha notes: alpha.2's
    // draw parks a version whose schema its manifests do not read (C-5) —
    // chat-comment@1 and comment@2 here; it indexes them as versions.
    const reads = new Set(Object.values(ALPHA2.types).flatMap((x) => x.reads));
    const parked = [...schemas].filter((s) => !reads.has(s)).sort();
    assert.deepEqual(parked, ['chat-comment@1', 'comment@2'], `the versions alpha.2 parks: ${parked.join(', ')}`);
    const unknown = [...readings].filter(([, how]) => how === 'unknown').map(([k]) => k).sort();
    assert.deepEqual(unknown, [], `record types alpha.2 counts unknown here: ${unknown.join(', ')}`);
    // The comment count alpha.2 reads off a node is its page comments: no chat pin rides a node.
    assert.ok(ids.chained && ids.heading, 'the run made page comments, one chained');
  });
});

// ── world B ──────────────────────────────────────────────────────────────────
const sid = (n, k = 0) => `${(0xb0000000 + k).toString(16)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
let nextSeed = 4600;
function transcriptOf(ch, s, ids, at) {
  const r = createRecords({ seed: nextSeed++, sessionId: s, cwd: ch.cwd, start: at, step: 10 });
  for (const id of ids) {
    r.prompt(`prompt ${id} ${CONV}`, { promptId: id });
    r.assistant([`reply to ${id}`]);
    r.turnDuration({ durationMs: 50 });
  }
  ch.writeTranscript(s, r.records);
}
function stored(ch, { id, lastActivity }) {
  const created = lastActivity - 1000;
  return {
    id, created_at: created, last_activity_at: lastActivity, ended_at: lastActivity,
    title: null, name: null, forked_from: null, current_session_id: id, entrypoint: 'cli',
    sessions: [{ session_id: id, slug: ch.slug, reason: 'start', started_at: created, ended_at: null }],
    process: null,
  };
}
const chatAnchor = (cid, tid, n) => ({
  v: 1, kind: 'turn', conversation_id: cid, session_id: cid, turn_id: tid,
  quote: { exact: `prompt ${tid} ${CONV}`, prefix: '', suffix: '' }, marks: 0, label: `turn ${n}`,
  fp: { h: '0123456789abcdef', len: 24 },
});

test('world B: a 205-conversation registry — the lazy open, a gone transcript, and no count or age deletes (steps 5–7)', { timeout: 300000 }, async (t) => {
  const root = treesnapRepo(t, { files: { 'README.md': 'world b\n' } }).root;
  const ch = claudeHome(t, { root, isolate: true });
  // Life 1: a graph with one node (the graph-link cutoff).
  const first = await withServer(t, { root });
  await ok(first.api.post('/api/turn-begin', { message: 'the first node' }), 'turn-begin');
  await ok(first.api.post('/api/render', { id: 'b-pane', html: '<p>world b</p>' }), 'render');
  assert.ok((await ok(first.api.post('/api/turn-end', { author: 'claude', summary: 'n' }), 'turn-end')).node_id);
  const cutoff = bootCutoff(first.srv.graph);
  assert.ok(Number.isFinite(cutoff), 'the graph has a node');
  await first.graceful();

  // 205 ended conversations: three active after the cutoff, 202 old; X (old)
  // is the one a pin will wait on, G (old) loses its transcript before the boot.
  const P = projectPaths(root);
  const ids = Array.from({ length: 205 }, (_, i) => sid(i + 1));
  const old = cutoff - 2 * DAY;
  const eager = ids.slice(0, 3);
  const X = ids[10];
  const G = ids[11];
  const oldAt = new Date(Date.now() - 40 * DAY);
  const kept = [];
  const list = ids.map((id, i) => {
    const tid = `t-${i}`;
    transcriptOf(ch, id, [tid], old + i * 1000);
    if (i < 3) return stored(ch, { id, lastActivity: cutoff + 1000 * (i + 1) });
    if (id !== X && id !== G) {
      // An index file for the session (never parsed in this life) and a diff
      // record 40 days old for its turn.
      writeJsonAtomic(P.mirrorIndex(id), {
        v: 1, session_id: id, conversation_id: id, slug: ch.slug, file: null, resume: null,
        turns: [{ id: tid, header: { id: tid }, internal: null }],
        state: { meta: {}, skills: { names: [], descriptions: {} }, sources: {} }, saved_at: oldAt.getTime(),
      });
      const diff = P.mirrorDiff(tid);
      writeJsonAtomic(diff, { v: 1, turn_id: tid, status: 'ready', at: oldAt.getTime() });
      fs.utimesSync(diff, oldAt, oldAt);
      kept.push(P.mirrorIndex(id), diff);
    }
    return stored(ch, { id, lastActivity: old + i * 1000 });
  });
  writeJsonAtomic(P.mirrorConversations, { v: 1, conversations: list });
  fs.unlinkSync(ch.transcript(G)); // Claude Code's cleanup

  const d = await withServer(t, { root });
  const lazy = () => d.srv.mirror.snapshot({}).diagnostics.lazy;
  const conv = (cid) => d.srv.mirror.snapshot({ since: 0 }).conversations.find((c) => c.id === cid) || null;
  await waitUntil(() => eager.every((id) => (conv(id) || {}).turn_count === 1), { ...WAIT, what: 'the eager three parsed' });
  await waitUntil(() => !conv(G), { ...WAIT, what: 'the boot sweep removed the gone conversation' });

  await t.test('(5) the boot parses only the eager set; an old conversation\'s pin answers indexing from a list with no parse kicked; placed once a host\'s direct read has parsed it', async () => {
    assert.deepEqual(lazy(), { listed: 201, parsed: 3, indexing: 0 }, 'the eager three parsed, the other 201 listed');
    assert.equal(conv(X).turn_count, 0, 'X listed with no turns');
    const pin = d.srv.elements.addElement({ type: 'chat-comment', schema: CHAT, payload: { text: `${PIN} on an old turn`, shared: true, replies: [], anchor: chatAnchor(X, 't-10', 1), chain: [] }, author: 'user' });
    // The resolver's list: indexing, nothing awaited, no parse kicked (O2).
    const [a] = await d.srv.mirror.resolveAnchors([{ id: pin.id, v: pin.v, anchor: chatAnchor(X, 't-10', 1) }]);
    assert.equal(a.state, 'indexing');
    assert.equal(a.explain, EXPLAIN.indexing);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(lazy(), { listed: 201, parsed: 3, indexing: 0 }, 'the list kicked no parse');
    assert.equal(conv(X).turn_count, 0);
    // GET /api/elements answers from the record and the resolver's memory: indexing, without waiting.
    const e = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'GET')).elements.find((x) => x.id === pin.id);
    assert.equal(e.state, 'indexing', 'the GET answers indexing');
    assertAnswered(e, 'indexing');
    // A host's direct read parses it; the pin is placed then.
    const turns = await waitUntil(async () => {
      const r = await ok(d.anonApi.get(`/api/mirror/conversations/${X}/turns?limit=20`), 'turns');
      return r.indexing === true ? null : r;
    }, { ...WAIT, what: 'X\'s turns read' });
    assert.deepEqual(turns.turns.map((x) => x.id), ['t-10']);
    const placed = await waitUntil(async () => {
      const x = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'GET')).elements.find((y) => y.id === pin.id);
      return x && x.state === 'exact' ? x : null;
    }, { ...WAIT, what: 'the pin placed' });
    assert.equal(placed.visible, 'placed');
    assertAnswered(placed, 'placed');
  });

  await t.test('(6) a deleted transcript leaves its pin unavailable, readable by its quote and fingerprint', async () => {
    const anchor = chatAnchor(G, 't-11', 1);
    const pin = d.srv.elements.addElement({ type: 'chat-comment', schema: CHAT, payload: { text: `${PIN} on a gone turn`, shared: true, replies: [], anchor, chain: [] }, author: 'user' });
    const e = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'GET')).elements.find((x) => x.id === pin.id);
    assert.equal(e.state, 'unavailable');
    assertAnswered(e, 'unavailable');
    assert.deepEqual(e.anchor.quote, anchor.quote, 'its quote readable');
    assert.deepEqual(e.anchor.fp, anchor.fp, 'its fingerprint readable');
    assert.equal(e.anchor.label, anchor.label, 'its label readable');
  });

  await t.test('(7) nothing deleted by a count or by age: every conversation listed, every index file and every 40-day-old diff record kept', async () => {
    const listed = d.srv.mirror.snapshot({ since: 0 }).conversations.filter((c) => ids.includes(c.id));
    assert.equal(listed.length, 204, 'every conversation but the gone one is listed (more than 0.8.5\'s 200)');
    assert.ok(kept.length >= 400);
    for (const f of kept) assert.ok(fs.existsSync(f), `${path.relative(root, f)} kept`);
  });
});
