// Exports and replays carry no conversation (design spec §11.10's end-to-end
// check, its last clause; §13: "the mirror in exports and replays" is
// deferred, so a node's `mirror` field and everything the chat mirror holds
// stay out of every file a node is shared as).
//
// A synthetic session through the daemon exactly as createServer wires it: a
// project under the sandbox HOME (a git repository, so the turn has a code
// diff with before/after trees, and a restore and its undo leave safety refs),
// a private Claude tier with a transcript whose assistant text, thinking, tool
// output and subagent file each carry a unique non-secret marker phrase and a
// fake secret, and the hooks of two turns whose Stops commit two nodes (the
// Stop's turn-end, as test/t2-e2e.test.js commits one). Then every way a node
// leaves as a file:
//   * GET /api/export/<label> (the download button's attachment),
//   * GET /api/export/<label>?format=file through lib/client — the export path
//     the MCP tool and the CLI use (lib/server/export writeExport →
//     buildExportHtml), read back from .web-chat/exports/,
//   * the same two for 'live',
//   * the replay: GET /api/replay/html and GET /replay (the player document),
//     with and without include_prompts, and GET /api/replay/path.
// None may carry the transcript's text, a session, conversation, turn or
// prompt id, a tree id (the diff record's before/after trees, the restores'
// trees, the safety refs), the node's `mirror` field, or any fake; the
// replay's captions carry only the graph's own (redacted) trigger text, and
// the prompt only with include_prompts. Every failure names the seed, the
// carrier and the rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { withServer, waitUntil, fakeBin } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { agentFixtures } = require('../test-support/agent-fixtures');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { projectPaths } = require('../lib/core/paths');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');

const SEED = 0x7576;
const FAKES = fakeSecrets({ seed: SEED });
const fake = (id) => {
  const f = FAKES.find((x) => x.id === id);
  if (!f) throw new Error(`seed ${SEED}: no fake ${id}`);
  return f;
};
// What the window search looks for (the email by its local part: its domain
// is in every fixture's text; the dotenv fake's host is plain outside its
// context). A window of only hex digits counts when 12 characters are there
// (test/mirror-redaction-sweep.test.js says why).
const SCAN = FAKES.map((f) => {
  if (f.id === 'known-email') return { ...f, secrets: [f.secrets[0].split('@')[0]] };
  if (f.id === 'env-dotenv') return { ...f, secrets: f.secrets.filter((s) => !/\.example\.org$/.test(s)) };
  return f;
});
function leaksIn(hay, fakes = SCAN) {
  let h = hay;
  const out = [];
  let pending = fakes;
  for (let round = 0; round < 64 && pending.length; round++) {
    const next = [];
    for (const l of findLeaks(h, pending)) {
      const w = h.slice(l.at, l.at + 8);
      const f = pending.find((x) => x.id === l.id);
      if (/^[0-9a-fA-F-]{8}$/.test(w) && !findLeaks(h, [f], { window: 12 }).length) {
        h = `${h.slice(0, l.at)}${'\u0000'.repeat(8)}${h.slice(l.at + 8)}`;
        next.push(f);
      } else out.push({ id: l.id, window: w });
    }
    pending = next;
  }
  return out;
}

// The transcript's markers: none may leave in an export or a replay.
const TRANSCRIPT_MARKS = Object.freeze({
  'assistant text': 'XCL-ASSIST-r4t8',
  thinking: 'XCL-THINK-m2k6',
  'tool output': 'XCL-TOOLOUT-c9v1',
  'subagent text': 'XCL-SUBAGENT-y5q3',
});
// The graph's own text: the prompt (the trigger) and the Stop's reply.
const PROMPT_MARK = 'XCL-PROMPT-b7n2';
const GRAPH_REPLY_MARK = 'XCL-STOPREPLY-d3w0';

const S1 = '11111111-1111-4111-8111-111111117576';
const AGENT = 'a0123456789ab7576';
const TURNS = ['xcl-turn-4f1a9c', 'xcl-turn-8e2b0d'];
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };

const FAKE_CLAUDE = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + '\\n');
if (argv[0] === 'agents') process.stdout.write('[]\\n');
`;

function stubClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-xcl-claude-'));
  const script = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(script, FAKE_CLAUDE);
  const stub = fakeBin(t, { name: 'claude', script, env: { ARGV_LOG: path.join(dir, 'argv.log') } });
  const before = process.env.PATH;
  process.env.PATH = `${stub.dir}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); });
}

function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const nonceOf = (text) => { const m = /name="wc-answer-nonce" content="([^"]*)"/.exec(text || ''); return m ? m[1] : null; };

// The session, committed: two nodes, a code diff, a restore and its undo.
async function scenario(t) {
  assert.equal(process.env.HOME, SANDBOX, 'precondition: HOME is the sandbox');
  const repo = treesnapRepo(t, { files: { 'src/app.js': 'const answer = 41;\n', 'README.md': 'export scratch\n' } });
  const root = repo.root;
  stubClaude(t);
  const ch = claudeHome(t, { root, isolate: true });
  const procStart = formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);
  ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'idle' });
  const ctx = await withServer(t, { root, writePortfile: true, home: false });
  await ctx.srv.controlStarted;
  const port = ctx.port;
  const call = { port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const get = (p) => client.get(p, call);
  const post = (p, body) => client.post(p, body, call);
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) };
  const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1,
    transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const fire = async (event, extra) => assert.equal(await postEnvelope(envelope(event, extra), { root, timeout: CALL_TIMEOUT_MS }), 'posted', event);
  const snapshots = async () => {
    const s = await get('/api/mirror');
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };

  const r = createRecords({ seed: SEED, sessionId: S1, cwd: ch.cwd, start: Date.now() - 300000, step: 50 });
  ch.writeTranscript(S1, []);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const appJs = path.join(root, 'src', 'app.js');
  const fx = agentFixtures(ch, S1);
  const nodes = [];
  for (const [i, turnId] of TURNS.entries()) {
    const prompt = `${PROMPT_MARK} turn ${i} with ${fake(i ? 'github-ghp' : 'sk-anthropic-api').text}`;
    const seen = await snapshots();
    const e = envelope('UserPromptSubmit', { prompt, prompt_id: turnId });
    const b = await post('/api/turn-begin', { message: prompt, author: 'user', ...sessionFields(e), prompt: e.prompt });
    assert.equal(b.ok, true, JSON.stringify(b));
    await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: `${turnId}'s before-snapshot` });
    const edit = { file_path: appJs, old_string: `const answer = ${41 + i};`, new_string: `const answer = ${42 + i};` };
    await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: `toolu_01Xcl${i}`, tool_input: edit });
    repo.write('src/app.js', `const answer = ${42 + i};\n`);
    await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: `toolu_01Xcl${i}`, tool_input: edit, tool_response: { filePath: appJs }, duration_ms: 3 });
    await post('/api/render', { id: `xcl-pane-${i}`, html: `<p>pane ${i}</p>` });
    // The transcript's copy of the turn, every marker in it.
    r.prompt(prompt, { promptId: turnId });
    r.assistant([
      { type: 'thinking', thinking: `${TRANSCRIPT_MARKS.thinking} ${fake('google-api-key').text}` },
      `${TRANSCRIPT_MARKS['assistant text']} ${fake('slack-bot').text}`,
      { type: 'tool_use', name: 'Bash', input: { command: fake('cli-flag-token').text }, id: `toolu_01XclBash${i}` },
    ]);
    r.toolResult(`toolu_01XclBash${i}`, `${TRANSCRIPT_MARKS['tool output']} ${fake('pem-rsa').text}`);
    r.assistant([{ type: 'tool_use', name: 'Edit', input: edit, id: `toolu_01Xcl${i}` }]);
    r.toolResult(`toolu_01Xcl${i}`, `The file ${appJs} has been updated.`);
    if (i === 0) {
      fx.agentCall(r, { toolUseId: 'toolu_01XclAgent', description: 'Look around', prompt: `${TRANSCRIPT_MARKS['subagent text']} go`, runInBackground: true });
      fx.asyncLaunched(r, 'toolu_01XclAgent', { agentId: AGENT, description: 'Look around' });
    }
    r.assistant([`${TRANSCRIPT_MARKS['assistant text']} done ${fake('stripe-sk-live').text}`]);
    r.turnDuration({ durationMs: 200, messageCount: 8 });
    ch.writeTranscript(S1, r.records);
    if (i === 0) {
      fx.writeAgentMeta(AGENT, { description: 'Look around', toolUseId: 'toolu_01XclAgent' });
      const a = fx.agentRecords({ agentId: AGENT, seed: SEED + 1 });
      a.prompt(`${TRANSCRIPT_MARKS['subagent text']} go`, { promptId: 'p-agent' });
      a.assistant([`${TRANSCRIPT_MARKS['subagent text']} found ${fake('slack-webhook').text}`]);
      fx.writeAgent(AGENT, a.records);
    }
    const s = envelope('Stop', { last_assistant_message: `${GRAPH_REPLY_MARK} ${i} ${fake('url-creds-postgres').text}` });
    const end = await post('/api/turn-end', { author: 'claude', reply: `${GRAPH_REPLY_MARK} ${i} ${fake('url-creds-postgres').text}`,
      ended: 'stop', ...sessionFields(s), last_assistant_message: s.stop.last_assistant_message });
    assert.ok(end.node_id, `${turnId} committed a node: ${JSON.stringify(end)}`);
    nodes.push(end.node_id);
    await waitUntil(async () => {
      const p = await get(`/api/mirror/conversations/${S1}/turns?limit=50&items=full`);
      const x = (p.turns || []).find((y) => y.id === turnId);
      return x && x.status !== 'open' && x.code && x.code.status === 'ready'
        && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
    }, { ...WAIT, what: `${turnId} closed, its code ready and the transcript's reply in` });
  }
  await waitUntil(async () => {
    const res = await raw(port, { path: `/api/mirror/agents/${AGENT}` });
    return res.status === 200 && res.text.includes(TRANSCRIPT_MARKS['subagent text']);
  }, { ...WAIT, what: 'the subagent\'s stream' });

  // A restore of the first turn and its undo: two safety refs and their trees.
  const ao = await get('/api/asks?ensure=1');
  const aport = ao.answer.port;
  const origin = `http://127.0.0.1:${aport}`;
  const act = async (action, params) => {
    const q = new URLSearchParams({ ...params, layout: 'confirm', mode: 'light' });
    const doc = await raw(aport, { path: `/answer/control/${action}?${q}` });
    assert.equal(doc.status, 200, doc.text.slice(0, 200));
    const res = await raw(aport, { method: 'POST', path: `/answer/api/control/${action}`, body: params,
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': nonceOf(doc.text) } });
    assert.equal(res.status, 200, `${action}: ${res.text}`);
  };
  const pv = await get(`/api/code/preview?turn=${TURNS[0]}`);
  assert.equal(pv.ok, true, JSON.stringify(pv));
  await act('restore', { preview_id: pv.preview_id });
  await act('undo', { restore_id: 'latest' });

  // Every id the conversation holds, and every tree.
  const p = projectPaths(root);
  const ids = new Map([['session id', S1], ['conversation id', S1]]);
  for (const id of TURNS) { ids.set(`turn id ${id}`, id); }
  const page = await get(`/api/mirror/conversations/${S1}/turns?limit=50&items=full`);
  for (const x of page.turns || []) {
    if (x.prompt_id) ids.set(`prompt id ${x.prompt_id}`, x.prompt_id);
    for (const it of x.items || []) {
      if (it.message_id) ids.set(`message id ${it.message_id}`, it.message_id);
    }
  }
  const trees = new Map();
  for (const id of TURNS) {
    const rec = JSON.parse(fs.readFileSync(p.mirrorDiff(id), 'utf8'));
    for (const k of ['before', 'after']) if (rec[k] && rec[k].tree) trees.set(`${id} ${k} tree`, rec[k].tree);
  }
  const ledger = JSON.parse(fs.readFileSync(p.controlRestores, 'utf8'));
  for (const x of ledger.restores || []) {
    for (const k of ['target_tree', 'safety_tree', 'after_tree']) if (x[k]) trees.set(`${x.restore_id} ${k}`, x[k]);
  }
  const safetyDir = path.join(p.mirrorGit, 'refs', 'wc', 'safety');
  for (const name of fs.existsSync(safetyDir) ? fs.readdirSync(safetyDir) : []) {
    trees.set(`safety ref ${name}`, fs.readFileSync(path.join(safetyDir, name), 'utf8').trim());
    ids.set(`safety ref name ${name}`, name);
  }
  assert.ok(trees.size >= 4, `seed ${SEED}: the diff records and the restores gave trees: ${[...trees.keys()].join(', ')}`);
  // The node's own mirror field (the turns that committed or folded into it).
  const node = await get(`/api/graph/node/${encodeURIComponent(nodes[0])}`);
  assert.ok(node.mirror && JSON.stringify(node.mirror).includes(TURNS[0]), `seed ${SEED}: the node carries its turns under \`mirror\` (§2.8): ${JSON.stringify(node.mirror)}`);
  const graph = await get('/api/graph');
  const labels = nodes.map((id) => (graph.nodes.find((n) => n.id === id) || {}).label);
  assert.ok(labels.every(Boolean), `seed ${SEED}: the nodes' labels: ${JSON.stringify(labels)}`);
  return { ctx, port, root, ids, trees, node, labels, get };
}

// What one artifact must not carry. `prompts`: the replay was asked to show
// the user's prompts (only then may the prompt marker be in it).
function violations(carrier, text, { ids, trees, node }, { prompts = false } = {}) {
  const bad = [];
  const at = (rule, what) => bad.push(`seed ${SEED} · ${carrier} · rule ${rule}: ${what}`);
  for (const [where, mark] of Object.entries(TRANSCRIPT_MARKS)) if (text.includes(mark)) at('no transcript text (§13)', `the ${where} marker ${mark}`);
  for (const [what, id] of ids) if (text.includes(id)) at('no session, conversation, turn or prompt id', what);
  for (const [what, tree] of trees) if (text.includes(tree)) at('no tree id', what);
  if (/"mirror"\s*:\s*\{/.test(text) || text.includes(JSON.stringify(node.mirror))) at('no node `mirror` field', 'a "mirror": {…} object');
  if (!prompts && text.includes(PROMPT_MARK)) at('the prompt only with include_prompts', PROMPT_MARK);
  for (const l of leaksIn(text)) at('findLeaks', `fake ${l.id}, window ${JSON.stringify(l.window)}`);
  return bad;
}

test(`exports and replays carry no conversation, seed ${SEED}: no transcript text, session, turn, prompt or tree id, no \`mirror\` field, no fake`, { timeout: 180000 }, async (t) => {
  const s = await scenario(t);
  const artifacts = [];
  for (const ref of [...s.labels, 'live']) {
    const dl = await raw(s.port, { path: `/api/export/${encodeURIComponent(ref)}` });
    assert.equal(dl.status, 200, `seed ${SEED}: GET /api/export/${ref}: ${dl.text.slice(0, 200)}`);
    artifacts.push({ carrier: `GET /api/export/${ref} (the download)`, text: dl.text });
    const file = await s.get(`/api/export/${encodeURIComponent(ref)}?format=file`);
    assert.ok(file.ok && file.path, `seed ${SEED}: the MCP/CLI export of ${ref}: ${JSON.stringify(file)}`);
    assert.ok(file.path.startsWith(projectPaths(s.root).dir), `seed ${SEED}: written under .web-chat/exports: ${file.path}`);
    artifacts.push({ carrier: `the export file of ${ref} (GET /api/export/${ref}?format=file, writeExport → buildExportHtml)`, text: fs.readFileSync(file.path, 'utf8') });
  }
  const from = s.labels[0];
  for (const [q, prompts] of [['', false], [`?from=${from}`, false], [`?from=${from}&include_prompts=1`, true]]) {
    const html = await raw(s.port, { path: `/api/replay/html${q}` });
    assert.equal(html.status, 200, `seed ${SEED}: GET /api/replay/html${q}: ${html.text.slice(0, 200)}`);
    artifacts.push({ carrier: `GET /api/replay/html${q}`, text: html.text, prompts });
    const doc = await raw(s.port, { path: `/replay${q}` });
    assert.equal(doc.status, 200, `seed ${SEED}: GET /replay${q}: ${doc.text.slice(0, 200)}`);
    artifacts.push({ carrier: `GET /replay${q} (the player)`, text: doc.text, prompts });
  }
  for (const q of ['', `?from=${from}`]) {
    const rp = await raw(s.port, { path: `/api/replay/path${q}` });
    assert.equal(rp.status, 200, `seed ${SEED}: GET /api/replay/path${q}: ${rp.text.slice(0, 200)}`);
    // The path is the replay's data, prompts included at local (its captions'
    // source): the transcript, the ids, the trees and the mirror still never.
    artifacts.push({ carrier: `GET /api/replay/path${q}`, text: rp.text, prompts: true });
  }

  // The replays drew the graph's own reply text — the captions' source — so
  // its absence of the transcript's means something.
  const replays = artifacts.filter((a) => /replay/.test(a.carrier) && !/path/.test(a.carrier));
  assert.ok(replays.every((a) => a.text.includes(GRAPH_REPLY_MARK)), `seed ${SEED}: each replay's captions show the graph's reply text`);
  assert.ok(replays.filter((a) => a.prompts).every((a) => a.text.includes(PROMPT_MARK)), `seed ${SEED}: include_prompts shows the prompt`);

  const bad = artifacts.flatMap((a) => violations(a.carrier, a.text, s, { prompts: !!a.prompts }));
  assert.equal(bad.length, 0, `${bad.length} found:\n  ${bad.slice(0, 30).join('\n  ')}`);
});
