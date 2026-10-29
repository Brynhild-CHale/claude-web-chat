// The chat rows and the remote limits, live (PLAN.md 3D.1; DECISIONS.md L.2
// L6, K.5 J1 and J2, K.2-132, K.2-142; RULED REQ@chat-remote-levels a,
// CHAT@type a, REQ@chat-pin-hosts a, PROTO@none; U441). A census, not a
// mechanism: the chat-comment type rides tranche 2's engines (the element
// floor, the compiled element:<type> frame row, PRIVATE_RULES' compiled entry,
// TEXT_RULES.items), and this file proves that every chat-family frame and
// route a daemon serves answers at the chat's own level — read to see the
// words, full to write — with private records dropped for everyone but a
// local browser (audience.seesPrivate). test/remote-policy.test.js's U441
// block pins the tables; this one boots daemons and reads what they send.
//
// The world: three daemons on one sandbox HOME (withServer), whose remote
// viewers are opted in at nothing (basic), `read` and `full` (the sandbox's
// tunnel.json, seeded before the first boot), each over a scratch git
// repository (test-support/treesnap-fixture, so a turn's code diff is
// recorded) with ONE isolated Claude tier (test-support/claude-home, made
// before any boot) fed only synthetic transcripts (test-support/claude-records)
// and v1 hook envelopes: a turn with a Read card, an Edit (its diff line) and
// a reply. Each root's own .web-chat/excerpts.json switches excerpts on
// (written before boot, never through a route), so the strip of the queue
// item's `excerpt` is measured with the field present (D2's order).
//
// Who is who (test/element-routes-private.test.js's terms): a local browser is
// Node's fetch (withServer's anonApi: fetch metadata, seesPrivate); lib/client
// (Claude's tools) sends none, with Claude's writer token or without; a remote
// viewer is a loopback request or socket carrying the portal's X-WC-Remote: 1;
// a network peer is a request whose socket's remoteAddress is stubbed (basic,
// whatever the opt-in). C-15-1: no gate here is a writer claim — a
// body-declared author or owner never changes a verdict (C-15-3).
//
// Three marker families: PIN (a shared chat pin's own words: its text, its
// replies, its edits), PRIV (the private pin's) and CONV (the conversation's,
// in the reply passage and the diff line, so it rides each shared pin's quote,
// label and excerpt). A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { withServer, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { classify } = require('../lib/core/remote-policy');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { WRITER_HEADER } = require('../lib/core/writer-token');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEVELS = ['basic', 'read', 'full'];
const OPT_IN = { basic: 'off', read: 'read', full: 'full' };
const SESSIONS = {
  basic: '44100001-0000-4000-8000-000000004411',
  read: '44100002-0000-4000-8000-000000004412',
  full: '44100003-0000-4000-8000-000000004413',
};
const WAIT = { timeout: 20000, interval: 20 };
const CALL_TIMEOUT_MS = 30000;
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

const PIN = 'wc-u441-pin';
const PRIV = 'wc-u441-priv';
const CONV = 'wc-u441-conv';
const PROMPT = 'please bump the answer and read a.md first';
const PASSAGE = `the passage ${CONV}-passage is here.`;
const REPLY = `Done. The answer is bumped. Later on, ${PASSAGE}`;
const APP_BEFORE = 'const answer = 41;\n';
const APP_AFTER = `const answer = '${CONV}-diff';\n`;
const MOUNT = 'cr-pane';

const has = (v, s) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).includes(s);
const hasAny = (v, marks) => marks.some((m) => has(v, m));
const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
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

// One project's daemon, its conversation (turn cp-1: a Read card, an Edit of
// src/app.js and the reply), its sockets (local and remote) and its callers.
async function boot(t, level, repo, seed) {
  const root = repo.root;
  const ch = claudeHome(t, { root, isolate: level === 'basic' });
  const d = await withServer(t, { root, writePortfile: true, ...(seed ? { seed } : {}) });
  t.after(stubPeers(d.server));
  const S = SESSIONS[level];
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}) => hookEnvelope({
    hook_event_name: event, session_id: S, transcript_path: ch.transcript(S), cwd: ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  const fire = async (event, extra) => {
    const r = await client.post('/api/hooks/event', envelope(event, extra), call);
    assert.equal(r.ok, true, `hook ${event}`);
  };
  const snapshots = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };

  ch.writeTranscript(S, []);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const r = createRecords({ seed: 441, sessionId: S, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const seen = await snapshots();
  const begin = envelope('UserPromptSubmit', { prompt: PROMPT, prompt_id: 'cp-1' });
  assert.equal((await client.post('/api/turn-begin', { message: PROMPT, author: 'user', ...sessionFields(begin), prompt: begin.prompt }, call)).ok, true);
  await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: `${level}: cp-1's before-snapshot` });
  const appJs = path.join(root, 'src', 'app.js');
  const edit = { file_path: appJs, old_string: APP_BEFORE.trim(), new_string: APP_AFTER.trim() };
  await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01CrEdit', tool_input: edit });
  repo.write('src/app.js', APP_AFTER);
  await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01CrEdit', tool_input: edit, tool_response: { filePath: appJs }, duration_ms: 3 });
  r.prompt(PROMPT, { promptId: 'cp-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.md' }, id: 'toolu_01CrRead' }]);
  r.toolResult('toolu_01CrRead', 'file a');
  r.assistant([{ type: 'tool_use', name: 'Edit', input: edit, id: 'toolu_01CrEdit' }]);
  r.toolResult('toolu_01CrEdit', `The file ${appJs} has been updated.`);
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 200, messageCount: 6 });
  ch.writeTranscript(S, r.records);
  const end = envelope('Stop', { last_assistant_message: REPLY });
  await client.post('/api/turn-end', { author: 'claude', reply: REPLY, ended: 'stop', ...sessionFields(end), last_assistant_message: end.stop.last_assistant_message }, call);
  await waitUntil(async () => {
    const p = await client.get(`/api/mirror/conversations/${S}/turns?limit=50&items=full`, call);
    const x = (p.turns || []).find((y) => y.id === 'cp-1');
    return x && x.status !== 'open' && x.code && x.code.status === 'ready'
      && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: `${level}: cp-1 closed, its code ready and the transcript's reply in` });
  const items = (await d.srv.mirror.turn('cp-1')).items;
  const reply = items.find((it) => it.kind === 'reply' && it.source === 'transcript');
  const card = items.find((it) => it.kind === 'tool_call' && it.tool === 'Read') || items.find((it) => it.kind === 'tool_call');
  assert.ok(reply && card, `${level}: a reply and a tool card`);
  const served = (await d.srv.mirror.itemField(reply.id, { field: 'text' })).text;
  const at = served.indexOf(PASSAGE);
  assert.ok(at >= 0, `${level}: the passage is served`);

  const sockets = { local: await listen(t, d.port, {}), remote: await listen(t, d.port, { ...REMOTE }) };
  const lib = (method, p, body, headers = {}, { token = false } = {}) => client.request(d.port, method, p, body, {
    headers: { ...headers, ...(token ? { [WRITER_HEADER]: d.writerToken() } : {}) }, timeout: CALL_TIMEOUT_MS,
  });
  const anchors = {
    turn: { kind: 'turn', turn_id: 'cp-1' },
    item: { kind: 'item', item_id: reply.id },
    range: { kind: 'item-range', item_id: reply.id, pos: { start: at, end: at + PASSAGE.length } },
    diff: { kind: 'diff-line', turn_id: 'cp-1', file: 'src/app.js', side: 'new', line: 1 },
    card: { kind: 'item', item_id: card.id },
  };
  return { ...d, level, ch, sockets, lib, anchors, card };
}

// The three worlds, then the sequence a local browser runs on each: one
// shared chat pin per anchor kind and one private, replies, an edit, a Send
// and a delete — every one through the element routes (U416, U405).
async function worlds(t) {
  const repos = {};
  for (const level of LEVELS) {
    repos[level] = treesnapRepo(t, { files: { 'src/app.js': APP_BEFORE, 'README.md': 'chat rows\n' } });
    // Excerpts on, in this root's own record, before boot (U422's record).
    writeJsonAtomic(projectPaths(repos[level].root).excerpts, { v: 1, on: true });
  }
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(repos.read.root)]: 'read', [path.resolve(repos.full.root)]: 'full' } },
  });
  const out = {};
  for (const level of LEVELS) out[level] = await boot(t, level, repos[level], level === 'basic' ? seed : null);
  for (const level of LEVELS) {
    const d = out[level];
    const pin = (anchor, text, shared = true) => ok(d.anonApi.post('/api/elements', { type: 'chat-comment', anchor, payload: { text, shared } }), `${level}: pin ${text}`);
    const ids = {};
    for (const k of ['turn', 'item', 'range', 'diff']) {
      const el = (await pin(d.anchors[k], `${PIN}-${k}-text`)).element;
      assert.equal(el.type, 'chat-comment');
      assert.equal(el.anchor.kind, d.anchors[k].kind);
      ids[k] = el.id;
    }
    ids.priv = (await pin(d.anchors.turn, `${PRIV}-text`, false)).element.id;
    ids.gone = (await pin(d.anchors.card, `${PIN}-gone-text`)).element.id;
    await ok(d.anonApi.post(`/api/elements/${ids.turn}/reply`, { text: `${PIN}-turn-reply` }), 'reply');
    await ok(d.anonApi.post(`/api/elements/${ids.priv}/reply`, { text: `${PRIV}-reply` }), 'private reply');
    await ok(d.anonApi.patch(`/api/elements/${ids.item}`, { text: `${PIN}-item-edit` }), 'edit');
    await ok(d.anonApi.patch(`/api/elements/${ids.priv}`, { text: `${PRIV}-edit` }), 'private edit');
    await ok(d.anonApi.post(`/api/elements/${ids.range}/send`, {}), 'send');
    await ok(d.anonApi.del(`/api/elements/${ids.gone}`), 'delete');
    d.ids = ids;
    // The quotes the shared pins carry are the conversation's (CONV), recorded from served text.
    const mine = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local list')).elements;
    assert.ok(has(mine.find((e) => e.id === ids.range).anchor.quote, `${CONV}-passage`), `${level}: the passage pin quotes CONV`);
    assert.ok(has(mine.find((e) => e.id === ids.diff).anchor.quote, `${CONV}-diff`), `${level}: the diff-line pin quotes CONV`);
    await waitUntil(() => d.sockets.local.of('element:chat-comment').some((f) => f.elements.every((e) => e.id !== ids.gone)
      && f.elements.some((e) => e.id === ids.item && has(e, `${PIN}-item-edit`))), { ...WAIT, what: `${level}: the sequence's last frame` });
  }
  return out;
}

test('chat pins at the chat\'s own level, live: frames, routes, the ring and the park', { timeout: 300000 }, async (t) => {
  const w = await worlds(t);

  await t.test('GET /api/elements?type=chat-comment: the local browser gets every chat pin; remote read and full and lib/client get the shared ones; remote basic is refused; a network peer is refused at every chat route', async () => {
    for (const level of LEVELS) {
      const d = w[level];
      const { ids } = d;
      const local = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local')).elements;
      assert.deepEqual(local.map((e) => e.id).sort(), [ids.turn, ids.item, ids.range, ids.diff, ids.priv].sort(), `${level}: the local browser gets every live chat pin`);
      assert.ok(has(local, `${PRIV}-edit`) && has(local, `${PRIV}-reply`), `${level}: the local browser gets the private pin's words`);
      const readers = [['lib/client (no token)', {}, {}], ['lib/client (Claude\'s token)', {}, { token: true }]];
      if (level !== 'basic') readers.push([`remote ${level}`, REMOTE, {}]);
      for (const [who, headers, opts] of readers) {
        for (const q of ['?type=chat-comment', '', '?shared_only=0']) {
          const r = await d.lib('GET', `/api/elements${q}`, null, headers, opts);
          assert.equal(r.status, 200, `${level} ${who} ${q}: ${JSON.stringify(r.body)}`);
          const chat = r.body.elements.filter((e) => e.type === 'chat-comment');
          assert.deepEqual(chat.map((e) => e.id).sort(), [ids.turn, ids.item, ids.range, ids.diff].sort(), `${level} ${who} ${q}: the shared chat pins`);
          assert.ok(!r.body.elements.some((e) => e.shared === false), `${level} ${who} ${q}: no private record`);
          assert.ok(!has(r.body, PRIV), `${level} ${who} ${q}: no private marker`);
          assert.ok(!has(r.body, `"${ids.priv}"`), `${level} ${who} ${q}: not even the private pin's id`);
        }
      }
      if (level === 'basic') {
        for (const q of ['?type=chat-comment', '']) {
          const r = await d.lib('GET', `/api/elements${q}`, null, REMOTE);
          assert.equal(r.status, 403, `basic remote ${q}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.mirror, 'basic', 'the refusal names the level');
          assert.ok(!hasAny(r.body, [PIN, PRIV, CONV]), 'no chat marker in the refusal');
        }
      }
      // A network peer: basic whatever the opt-in, at every chat route.
      const before = logBytes(d.root);
      const routes = [
        ['GET', '/api/elements?type=chat-comment', null],
        ['GET', `/api/elements/${ids.turn}/grab`, null],
        ['POST', '/api/elements', { type: 'chat-comment', anchor: d.anchors.turn, payload: { text: `${PIN}-peer` } }],
        ['PATCH', `/api/elements/${ids.turn}`, { text: `${PIN}-peer` }],
        ['POST', `/api/elements/${ids.turn}/reply`, { text: `${PIN}-peer` }],
        ['POST', `/api/elements/${ids.turn}/send`, {}],
        ['DELETE', `/api/elements/${ids.turn}`, null],
        ['PATCH', `/api/elements/${ids.priv}`, { shared: true }],
      ];
      for (const [m, p, body] of routes) {
        for (const opts of [{}, { token: true }]) {
          const r = await d.lib(m, p, body, PEER, opts);
          assert.equal(r.status, 403, `${level} peer ${m} ${p}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.mirror, 'basic', `${level} peer: a network peer is basic`);
          assert.ok(!hasAny(r.body, [PIN, PRIV, CONV]), `${level} peer ${m} ${p}: no chat marker`);
        }
      }
      assert.equal(logBytes(d.root), before, `${level}: no peer request wrote anything`);
    }
  });

  await t.test('writes: remote basic and read are refused on a shared chat pin (log and records unchanged, a body-declared writer changing nothing); remote full creates (origin remote) and replies; on the private pin every reader that does not see it gets the GET\'s 404', async () => {
    const snapshot = async (d) => ({
      log: logBytes(d.root),
      list: (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local list')).elements.map((e) => [e.id, e.v, e.text, (e.replies || []).length, e.shared]),
    });
    const writes = (d, extra = {}) => [
      ['POST', '/api/elements', { type: 'chat-comment', anchor: d.anchors.turn, payload: { text: `${PIN}-remote-create`, ...extra } }],
      ['PATCH', `/api/elements/${d.ids.turn}`, { text: `${PIN}-remote-edit`, ...extra }],
      ['POST', `/api/elements/${d.ids.turn}/reply`, { text: `${PIN}-remote-reply`, ...extra }],
      ['POST', `/api/elements/${d.ids.turn}/send`, { ...extra }],
      ['DELETE', `/api/elements/${d.ids.turn}`, null],
    ];
    for (const level of ['basic', 'read']) {
      const d = w[level];
      const before = await snapshot(d);
      for (const claim of [{}, { author: 'claude' }, { author: 'claude', writer: 'service:x', owner: 'service:x' }]) {
        for (const [m, p, body] of writes(d, claim)) {
          const r = await d.lib(m, p, body, REMOTE);
          const plain = await d.lib(m, p, writes(d).find(([mm, pp]) => mm === m && pp === p)[2], REMOTE);
          assert.equal(r.status, 403, `${level} remote ${m} ${p} ${JSON.stringify(claim)}: ${JSON.stringify(r.body)}`);
          assert.deepEqual(r.body, plain.body, `${level} ${m} ${p}: a body-declared writer changes nothing (C-15-1, C-15-3)`);
          assert.equal(r.body.mirror, level, `${level}: the refusal names the level`);
          assert.ok(!hasAny(r.body, [PIN, PRIV]), `${level} ${m}: no chat marker in the refusal`);
        }
      }
      assert.deepEqual(await snapshot(d), before, `${level}: the element log's bytes and the live records unchanged`);
    }

    const d = w.full;
    const made = await d.lib('POST', '/api/elements', { type: 'chat-comment', anchor: d.anchors.item, payload: { text: `${PIN}-remote-create` } }, REMOTE);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const remoteId = made.body.element.id;
    const rec = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local list')).elements.find((e) => e.id === remoteId);
    assert.equal(rec.provenance.origin, 'remote', 'a remote full viewer\'s create lands, provenance origin remote');
    const replied = await d.lib('POST', `/api/elements/${remoteId}/reply`, { text: `${PIN}-remote-reply` }, REMOTE);
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    const after = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local list')).elements.find((e) => e.id === remoteId);
    assert.equal(after.replies.length, 1, 'the reply appended');
    assert.equal(after.replies[0].text, `${PIN}-remote-reply`);
    d.ids.remote = remoteId;

    // C-16-2 on the private chat pin.
    for (const level of LEVELS) {
      const x = w[level];
      const id = x.ids.priv;
      const before = await snapshot(x);
      const attempts = [
        ['PATCH {}', 'PATCH', `/api/elements/${id}`, {}],
        ['PATCH {shared:true}', 'PATCH', `/api/elements/${id}`, { shared: true }],
        ['reply', 'POST', `/api/elements/${id}/reply`, { text: `${PIN}-sneak` }],
        ['send', 'POST', `/api/elements/${id}/send`, {}],
        ['DELETE', 'DELETE', `/api/elements/${id}`, null],
      ];
      const who = [['lib/client (no token)', {}, {}], ['lib/client (Claude\'s token)', {}, { token: true }]];
      if (level === 'full') who.unshift(['remote full', REMOTE, {}]);
      for (const [label, m, p, body] of attempts) {
        for (const [name, headers, opts] of who) {
          const r = await x.lib(m, p, body, headers, opts);
          assert.equal(r.status, 404, `${level} ${name} ${label}: ${r.status} ${JSON.stringify(r.body)}`);
          assert.deepEqual(r.body, { error: 'not found', id }, `${level} ${name} ${label}: the GET's answer`);
        }
      }
      assert.deepEqual(await snapshot(x), before, `${level}: the private pin unchanged, the log's bytes unchanged`);
    }
  });

  await t.test('sockets: local gets element:chat-comment whole; remote read and full without the private pin; remote basic gets no chat frame, no hello/reset elements and no chat marker in any frame', async () => {
    for (const level of LEVELS) {
      const { sockets: { local, remote }, ids } = w[level];
      const lf = local.of('element:chat-comment');
      assert.ok(lf.length >= 8, `${level}: a frame a write (${lf.length})`);
      assert.ok(lf.some((f) => f.elements.some((e) => e.id === ids.priv && e.shared === false && has(e, `${PRIV}-edit`))), `${level}: the local socket gets the private pin`);
      // Every local frame that holds a pin's words is one of the carriers that may.
      const CARRIERS = ['element:chat-comment', 'queue', 'hello', 'reset'];
      const other = local.frames.filter((f) => hasAny(f, [PIN, PRIV]) && !CARRIERS.includes(f.type)).map((f) => f.type);
      assert.deepEqual(other, [], `${level}: a chat pin's words rode another frame type`);
      assert.ok(!local.frames.some((f) => f.type !== 'element:chat-comment' && has(f, PRIV)), `${level}: the private words ride only the chat frame, locally`);
      if (level === 'basic') {
        assert.deepEqual(remote.of('element:chat-comment'), [], 'basic: no element:chat-comment frame at all');
        assert.ok(!remote.frames.some((f) => typeof f.type === 'string' && f.type.startsWith('element:')), 'basic: no element frame of any type');
        for (const f of remote.frames.filter((x) => x.type === 'hello' || x.type === 'reset')) assert.ok(!Object.hasOwn(f, 'elements'), `basic ${f.type}: no elements key`);
        const leaks = remote.raw.filter((s) => hasAny(s, [PIN, PRIV, CONV]));
        assert.deepEqual(leaks.map((s) => JSON.parse(s).type), [], 'basic: no frame holds a chat marker');
        const queued = remote.of('queue').filter((f) => f.item && f.item.type === 'chat-comment');
        assert.ok(queued.length >= 1, 'basic: the queue frames still come');
        for (const f of queued) {
          assert.equal(f.item.summary, 'chat · chat-comment', 'basic: the summary is the text-free label');
          assert.equal(f.item.text_hidden, true);
          if (Object.hasOwn(f.item, 'excerpt')) assert.equal(f.item.excerpt, 'chat · chat-comment', 'basic: no excerpt, the label');
        }
        // Liveness: the local socket's queue frames carried the excerpt's words.
        assert.ok(local.of('queue').some((f) => f.item && f.item.type === 'chat-comment' && has(f.item.excerpt, CONV)), 'basic local: the excerpt is on (CONV in a queue item)');
      } else {
        const rf = remote.of('element:chat-comment');
        assert.ok(rf.length >= 8, `${level}: the remote socket gets the chat frames (${rf.length})`);
        for (const f of rf) {
          assert.ok(!f.elements.some((e) => e.shared === false || e.id === ids.priv), `${level}: no private record`);
          assert.ok(!has(f, PRIV), `${level}: no private marker`);
        }
        assert.ok(rf.some((f) => has(f, `${PIN}-item-edit`)), `${level}: the shared pins' words, from read`);
        assert.ok(!remote.raw.some((s) => has(s, PRIV)), `${level}: no frame at all holds a private marker`);
      }
    }
  });

  await t.test('the ring and the park: below read no chat marker; lib/client no private marker; refused writes park no chat item', async () => {
    for (const level of LEVELS) {
      const d = w[level];
      const peer = await d.lib('GET', '/api/events?since=0', null, PEER);
      assert.equal(peer.status, 200, `${level} peer ring: ${JSON.stringify(peer.body).slice(0, 200)}`);
      assert.ok(peer.body.events.some((e) => e.kind === 'element' && e.type === 'chat-comment'), `${level}: the ring holds the chat events`);
      for (const m of [PIN, PRIV, CONV]) assert.ok(!has(peer.body, m), `${level} peer ring: no ${m}`);
      for (const opts of [{}, { token: true }]) {
        const r = await d.lib('GET', '/api/events?since=0', null, {}, opts);
        assert.equal(r.status, 200);
        assert.ok(has(r.body, PIN), `${level} lib/client ring: the shared words (the probe is live)`);
        assert.ok(!has(r.body, PRIV), `${level} lib/client ring: no private marker`);
      }
    }
    // The park: a local Push parks the chat items (no channel); a remote basic
    // viewer's GET /api/queue/pending holds no chat marker and no excerpt.
    for (const level of LEVELS) {
      const d = w[level];
      const pushed = await ok(d.api.post('/api/queue/push', {}), `${level}: push`);
      assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
      const mine = (await ok(d.anonApi.get('/api/queue/pending'), 'local pending')).pending;
      assert.ok(mine.items.some((it) => it.type === 'chat-comment' && has(it, PIN)), `${level}: the park holds the chat items (local)`);
      assert.ok(has(mine.envelope, CONV), `${level}: and the envelope quotes the excerpt (local)`);
      if (level === 'basic') {
        const r = await d.lib('GET', '/api/queue/pending', null, REMOTE);
        assert.equal(r.status, 200);
        for (const m of [PIN, PRIV, CONV]) assert.ok(!has(r.body, m), `basic remote pending: no ${m}`);
        const rows = r.body.pending.items.filter((it) => it.type === 'chat-comment');
        assert.ok(rows.length >= 1, 'basic remote pending: the chat rows are there, text-free');
        for (const it of rows) {
          assert.equal(it.summary, 'chat · chat-comment');
          assert.ok(!Object.hasOwn(it, 'excerpt') || it.excerpt === 'chat · chat-comment', 'no excerpt');
        }
        const p = await d.lib('GET', '/api/queue/pending', null, PEER);
        for (const m of [PIN, PRIV, CONV]) assert.ok(!has(p.body, m), `basic peer pending: no ${m}`);
      }
      const ownChat = (it) => it.type === 'chat-comment';
      assert.equal(d.srv.state.queue.filter(ownChat).length, 0, `${level}: the push took every chat item`);
      d.parked = mine.items.filter(ownChat).map((it) => it.element_id);
    }
    // Refused writes from remote basic and read, then a remote push: no chat
    // item queued, nothing parked beyond what was (m15: element-write wakes
    // below full = 0).
    for (const level of ['basic', 'read']) {
      const d = w[level];
      for (const [m, p, body] of [
        ['POST', '/api/elements', { type: 'chat-comment', anchor: d.anchors.turn, payload: { text: `${PIN}-wake` } }],
        ['PATCH', `/api/elements/${d.ids.diff}`, { text: `${PIN}-wake` }],
        ['POST', `/api/elements/${d.ids.diff}/reply`, { text: `${PIN}-wake` }],
        ['POST', `/api/elements/${d.ids.diff}/send`, {}],
      ]) assert.equal((await d.lib(m, p, body, REMOTE)).status, 403, `${level} ${m} ${p}`);
      assert.equal(d.srv.state.queue.filter((it) => it.type === 'chat-comment').length, 0, `${level}: no chat item queued`);
      await d.lib('POST', '/api/queue/push', {}, REMOTE);
      const park = (await ok(d.anonApi.get('/api/queue/pending'), 'local pending')).pending;
      const chat = park ? park.items.filter((it) => it.type === 'chat-comment').map((it) => it.element_id) : [];
      assert.deepEqual(chat, d.parked, `${level}: the remote push parked no chat item`);
      assert.ok(!has(park, `${PIN}-wake`), `${level}: nothing of the refused writes reached the park`);
    }
  });

  await t.test('routes sweep: every GET a remote read or full viewer may reach serves no private chat marker; every one a basic viewer may reach no chat marker; the node read, its preview and its export carry no chat pin even locally (L2, D5)', async () => {
    // A node, committed over the live pins: Claude renders a pane in a turn.
    for (const level of LEVELS) {
      const d = w[level];
      await ok(d.api.post('/api/turn-begin', { message: 'a node' }), 'turn-begin');
      await ok(d.api.post('/api/render', { id: MOUNT, html: '<p>a pane</p>' }), 'render');
      d.node = (await ok(d.api.post('/api/turn-end', { author: 'claude' }), 'turn-end')).node_id;
      assert.ok(d.node, `${level}: a node committed`);
    }
    const routes = [];
    const re = /\bapp\.(get|use|all)\(\s*(['"`])([^'"`]*)\2/g;
    const files = fs.readdirSync(path.join(REPO_ROOT, 'lib/server/routes')).filter((f) => f.endsWith('.js')).map((f) => `lib/server/routes/${f}`);
    files.push('lib/server/index.js');
    for (const rel of files) for (const m of fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').matchAll(re)) routes.push(m[3]);
    // The replay documents (TEXT_UNDECIDED in test/remote-policy.test.js)
    // caption each step with Claude's reply, conversation text a basic viewer
    // still gets there: the one known gap, the maintainer's call. A chat pin's
    // own words are held to none there as everywhere.
    const UNDECIDED = new Set(['/replay', '/api/replay/html', '/api/replay/file/:name']);
    const concrete = (d, p) => p
      .replace('/api/elements/:id', `/api/elements/${d.ids.turn}`)
      .replace('/api/mounts/:id', `/api/mounts/${MOUNT}`)
      .replace(/:(?:id|ref|node)\b/g, d.node).replace(/:mount\b/g, MOUNT)
      .replace(/\$\{[^}]*\}/g, 'sample').replace(/:[A-Za-z_]+/g, 'sample1');
    for (const level of LEVELS) {
      const d = w[level];
      const banned = level === 'basic' ? [PIN, PRIV, CONV] : [PRIV];
      const seen = new Set();
      let reached = 0;
      const wrong = [];
      for (const p of routes) {
        const urls = [concrete(d, p)];
        if (p === '/api/elements') urls.push('/api/elements?type=chat-comment');
        for (const url of urls) {
          if (seen.has(url)) continue;
          seen.add(url);
          if (!classify('GET', url, { mirror: OPT_IN[level] }).allow) continue;
          const r = await d.lib('GET', url, null, REMOTE);
          reached += 1;
          for (const m of banned) {
            if (m === CONV && UNDECIDED.has(p)) continue;
            if (has(r.body, m)) wrong.push(`GET ${url} (${r.status}) carries ${m}`);
          }
        }
      }
      assert.ok(reached >= 30, `${level}: the sweep reached the routes (${reached})`);
      assert.deepEqual(wrong, [], `${level}: a remote ${level} viewer got chat text it may not`);
    }
    // L2 (REQ@chat-pin-hosts a): no document carries a chat pin, for anyone.
    for (const level of LEVELS) {
      const d = w[level];
      const chatIds = Object.values(d.ids);
      for (const [what, get] of [
        ['node read', () => d.anonApi.get(`/api/graph/node/${d.node}`)],
        ['preview', () => d.anonApi.get(`/preview/node/${d.node}`)],
        ['export', () => d.anonApi.get(`/api/export/${d.node}`)],
        ['export (active)', () => d.anonApi.get('/api/export/active')],
      ]) {
        const r = await get();
        assert.equal(r.status, 200, `${level} ${what}: ${r.status}`);
        const text = r.text;
        assert.ok(text.length > 0, `${level} ${what}: a body`);
        for (const m of [PIN, PRIV]) assert.ok(!text.includes(m), `${level} ${what}: no chat pin's words (${m})`);
        for (const id of chatIds) assert.ok(!text.includes(`"${id}"`), `${level} ${what}: no chat pin's id ${id}`);
        assert.ok(!text.includes('"chat-comment"'), `${level} ${what}: no chat-comment record`);
      }
    }
  });

  await t.test('a reset (a page Wipe): remote basic gets it with no `elements` key and no chat marker; read and full no private marker; no socket\'s reset lists a chat pin (the surface never holds one)', async () => {
    for (const level of LEVELS) {
      const d = w[level];
      const { local, remote } = d.sockets;
      const resets = (s) => s.of('reset').length;
      const before = [resets(local), resets(remote)];
      const wiped = await ok(d.anonApi.post('/api/graph/wipe', {}), `${level}: wipe`);
      assert.ok(!wiped.pending, `${level}: the wipe applied now`);
      await waitUntil(() => resets(local) > before[0] && resets(remote) > before[1], { ...WAIT, what: `${level}: the reset on both sockets` });
      for (const [who, s] of [['local', local], ['remote', remote]]) {
        for (const f of s.of('reset')) {
          assert.ok(!(f.elements || []).some((e) => e && e.type === 'chat-comment'), `${level} ${who} reset: no chat pin row`);
          if (who === 'remote' && level === 'basic') {
            assert.ok(!Object.hasOwn(f, 'elements'), 'basic reset: no elements key');
            assert.ok(!hasAny(f, [PIN, PRIV, CONV]), 'basic reset: no chat marker');
          }
          if (who === 'remote') assert.ok(!has(f, PRIV), `${level} remote reset: no private marker`);
        }
      }
      const listed = (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'local list')).elements.map((e) => e.id);
      assert.ok(listed.includes(d.ids.turn) && listed.includes(d.ids.priv), `${level}: the chat pins outlive the Wipe (WIPE@chat)`);
      if (level === 'basic') assert.deepEqual(remote.raw.filter((s) => hasAny(s, [PIN, PRIV, CONV])).map((s) => JSON.parse(s).type), [], 'basic: still no frame holds a chat marker');
      else assert.ok(!remote.raw.some((s) => has(s, PRIV)), `${level}: still no frame holds a private marker`);
    }
  });
});
