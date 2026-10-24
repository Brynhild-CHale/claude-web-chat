// Tranche 2 of the annotation engine, end to end (PLAN.md §3, items 2A.1–2E.5;
// U340): a project that starts at schema v3 — test-support/v3-graph.js's fixed
// graph with three pinless nodes (U351's `pinless: 3`) — met the way an
// upgrading user meets it, on the real createServer (withServer). ONE root, one
// subtest per step, in order, each step reading the state the step before it
// left:
//
//   (1) the first boot migrates: _version.json 4, a commit record for every
//       node (A-1, the pinless ones included), a clean boot report and
//       graph_integrity, no node-without-commit-record;
//   (2) the census (K-2, F-DEL c): a comment added and deleted before any
//       commit, a graceful stop and a reboot → clean, `discarded` 1; a pin left
//       live and a hard stop → uncommitted-lost reported once, then
//       `acknowledged` and clean;
//   (3) get_comments and reply_comment through the REAL MCP tool handlers in a
//       process of their own (cwd the root, WEB_CHAT_PORT, WEB_CHAT_MCP_SERVER=1
//       so the writer token is sent): they read and reply through the element
//       API, the reply verified claude; the OLD path as a pre-upgrade MCP
//       server calls it (lib/client) is refused with a JSON body whose hint
//       names /exit — never a bare 404 (B3 = b);
//   (4) a turn commits a node whose copies carry v and whose commit record pins
//       every element id@v; a highlight-only turn commits a node (E-STORE a);
//       diff_nodes (the real handler) names the element diff; a shared
//       highlight raises ONE type-tagged element queue item and get_comments
//       with type 'highlight' reads it (F3 b, K.2-10);
//   (5) reports: a local socket's report lands and the next commit's side
//       table records the committed node's answer (F-SIDE, U313), diff_nodes
//       names the orphan; a remote basic socket gets no private element, no
//       anchor text and no comment text in any frame; the per-surface counter
//       is stamped on hello, bumped by a Set active and stamped on the reset,
//       and a late report echoing the old counter never replaces one echoing
//       the new, while a report for the restored surface is accepted although
//       its mount gen restarted (B6 = b);
//   (6) a graceful stop and a reboot append only the close and an epoch;
//   (7) Set active on a migrated older node restores its pins with their v, and
//       the next no-op turn commits 0 nodes;
//   (8) GET /api/toolbar merges the user and project tiers; protocol 12;
//   (9) the writer token across a restart: the MCP process's next call re-reads
//       .web-chat/writer-token once and lands verified; a token the daemon
//       never minted fails with the daemon's hint and no tokenless retry;
//  (10) AG-1's shape: every node file parses as a 0.8.5 node and every comment
//       copy keeps every v3 field (test/fixtures/v3-node-shape.json), and every
//       log record is one alpha.1's reader indexes with the fields it needs or
//       one it counts unknown and ignores (test/fixtures/alpha1-log-shape.json,
//       derived once from 39b52f8's index()).
//
// Through every step the comment cursor never decreases. Every server is
// closed by withServer's t.after. One more test pins K.2-66: a failed answers
// append is logged as the answers record, never as the commit record.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// No box grab is drawn here; a stray one must never launch the machine's Chrome.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, waitUntil, wsConnect, commentBody } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const client = require('../lib/client');
const { projectPaths } = require('../lib/core/paths');
const { SCHEMA_VERSION, PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
const { copyMatches, parsePin } = require('../lib/core/element-log');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const { liveIsDirty } = require('../lib/server/domain/turns');
const { NORMAL } = require('../lib/server/domain/elements-reconcile');
const SHAPE = require('./fixtures/v3-node-shape.json');
const ALPHA1 = require('./fixtures/alpha1-log-shape.json');

const REPO = path.join(__dirname, '..');
const WAIT = { timeout: 15000, interval: 10 };

// ── helpers ──────────────────────────────────────────────────────────────────

const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const logRecords = (paths) => {
  let text = '';
  try { text = fs.readFileSync(paths.elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const nodeIdsOnDisk = (paths) => fs.readdirSync(paths.graphDir).filter((f) => /^n\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
const bootReport = (paths) => readJsonFile(paths.elementsBootReport);
const unclean = (report) => Object.keys(report.states).filter((k) => !NORMAL.has(k)).sort();
const integrityEvents = (srv) => srv.bus.read({ since: 0, kinds: ['integrity'] }).events;

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  assert.notEqual(r.json && r.json.ok, false, `${what}: ${r.text}`);
  return r.json;
}

// The turn routes as the hooks call them: lib/client, no Origin, no fetch
// metadata, no spawn, with the session fields lib/hooks/turn-begin.js sends.
const SESSION = { session_id: 'sess-elements-e2e-t2', permission_mode: 'default' };
let promptNo = 0;
async function turn(ctx, message, during) {
  const call = { port: ctx.port, noSpawn: true, timeout: 15000 };
  promptNo += 1;
  await client.post('/api/turn-begin', {
    message, author: 'user', ...SESSION, cwd: ctx.root, prompt_id: `p${promptNo}`, prompt: message,
  }, call);
  if (during) await during();
  return client.post('/api/turn-end', {
    author: 'claude', reply: `done: ${message}`, ended: 'stop', ...SESSION, cwd: ctx.root,
    last_assistant_message: `done: ${message}`,
  }, call);
}

// A socket that keeps every frame it is sent (parsed and raw).
async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const raw = [];
  const frames = [];
  ws.on('message', (data) => { const s = data.toString(); raw.push(s); try { frames.push(JSON.parse(s)); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  return {
    ws, raw, frames,
    of: (type) => frames.filter((f) => f.type === type),
    send: (f) => ws.send(JSON.stringify(f)),
    report: (surface, mounts) => ws.send(JSON.stringify({ type: 'report', surface, mounts })),
    close: () => { try { ws.terminate(); } catch {} },
  };
}

// The MCP tools' handlers, run as Claude Code's MCP server runs them: a process
// of their own, cwd the project, WEB_CHAT_MCP_SERVER=1 (lib/mcp/client sends
// this boot's writer token) and WEB_CHAT_PORT. It stays up across commands, so
// its token cache lives across a daemon restart (step 9): each line on stdin
// is {port, calls}; each answer line is {results, reads, stderr}. `reads`
// counts the reads of .web-chat/writer-token (lib/core/writer-token
// readWriterToken, wrapped before lib/mcp/client binds it).
function mcpProcess(t, root, port) {
  const script = `
    const wt = require(${JSON.stringify(path.join(REPO, 'lib/core/writer-token.js'))});
    let reads = 0;
    const read = wt.readWriterToken;
    wt.readWriterToken = (...a) => { reads += 1; return read(...a); };
    const tools = {};
    for (const n of ['get_comments', 'reply_comment', 'diff_nodes']) tools[n] = require(${JSON.stringify(path.join(REPO, 'lib/mcp/tools'))} + '/' + n + '.js');
    let buf = '';
    process.stdin.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const { port, calls } = JSON.parse(line);
        process.env.WEB_CHAT_PORT = String(port);
        const out = [];
        const r0 = reads;
        for (const [name, args] of calls) {
          try { out.push({ ok: true, value: await tools[name].handler(args) }); }
          catch (e) { out.push({ ok: false, error: String(e && e.message), status: e && e.status, body: e && e.body }); }
        }
        process.stdout.write(JSON.stringify({ results: out, reads: reads - r0 }) + '\\n');
      }
    });`;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, WEB_CHAT_PORT: String(port), WEB_CHAT_MCP_SERVER: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let out = '';
  let err = '';
  const waiting = [];
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1);
      const w = waiting.shift();
      if (w) w.resolve({ ...JSON.parse(line), stderr: err });
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => { for (const w of waiting.splice(0)) w.reject(new Error(`mcp process exited ${code}: ${err}`)); });
  return {
    run(p, calls) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`mcp tools timed out: ${err}`)), 30000);
        waiting.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify({ port: p, calls }) + '\n');
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch {} },
  };
}
const values = (answer) => answer.results.map((r) => { assert.ok(r.ok, `a tool call failed: ${JSON.stringify(r)}`); return r.value; });

// AG-1: a value against one field rule of the node-shape fixture.
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
    const has = Object.prototype.hasOwnProperty.call(obj, field);
    if (!has) { if (rule.required) out.push(`${where}: ${field} missing`); continue; }
    if (!fits(rule, obj[field])) out.push(`${where}: ${field} ${JSON.stringify(obj[field])} is not ${rule.type}`);
  }
  return out;
}
// AG-1: one log record against alpha.1's index() (the log-shape fixture).
const ALPHA1_FIELD = {
  'non-empty-string': (v) => typeof v === 'string' && v.length > 0,
  'positive-integer': (v) => Number.isSafeInteger(v) && v > 0,
  array: (v) => Array.isArray(v),
};
function alpha1Reading(rec) {
  const rules = Object.prototype.hasOwnProperty.call(ALPHA1.indexed, rec.t) ? ALPHA1.indexed[rec.t] : null;
  if (!rules) return 'unknown';
  for (const [field, kind] of Object.entries(rules)) {
    if (!ALPHA1_FIELD[kind]) throw new Error(`alpha1-log-shape.json: unknown field kind ${kind}`);
    if (!ALPHA1_FIELD[kind](rec[field])) return `skipped (${field})`;
  }
  return 'indexed';
}

const RANGE = (mount, exact) => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });

// ── the run ──────────────────────────────────────────────────────────────────

test('a v3 project with pinless nodes meets tranche 2 end to end (steps 1–10)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-elements-e2e-t2-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const g = v3Graph(root, { pinless: 3 });
  const paths = projectPaths(root);
  const v3Copies = new Map();
  for (const n of g.nodes) v3Copies.set(n.id, new Map((n.comments || []).map((c) => [c.id, JSON.parse(JSON.stringify(c))])));
  const pinless = g.nodes.filter((n) => !(n.comments || []).length).map((n) => n.id);

  let ctx = null;
  const cursors = [];
  async function cursor(what) {
    const r = await ok(ctx.api.get('/api/elements?type=comment'), `cursor ${what}`);
    assert.ok(Number.isInteger(r.next_cursor), `${what}: next_cursor is an integer`);
    cursors.push([what, r.next_cursor]);
    return r.next_cursor;
  }
  const reboot = async (how) => {
    if (how === 'hard') await ctx.stop(); else await ctx.graceful();
    ctx = await withServer(t, { root });
    return ctx;
  };
  let mcp = null;
  const nodes = {};

  await t.test('(1) the first boot migrates: schema 4, a commit record for every node (pinless ones too), a clean report', async () => {
    assert.deepEqual(pinless, ['n7', 'n8', 'n10'], 'the fixture\'s pinless nodes');
    ctx = await withServer(t, { root });
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(readJsonFile(paths.version).version, 4, '_version.json 4');
    const recs = logRecords(paths);
    assert.equal(recs.filter((r) => r.t === 'migration').length, 1, 'one migration record');
    const committed = new Set(recs.filter((r) => r.t === 'commit').map((r) => r.node));
    for (const id of nodeIdsOnDisk(paths)) assert.ok(committed.has(id), `${id} has a commit record (A-1)`);
    for (const id of pinless) assert.deepEqual(ctx.srv.elements.pinsOf(id), [], `${id}: an empty commit record`);
    const report = bootReport(paths);
    assert.equal(report.clean, true, `the boot report is clean: ${JSON.stringify(report.states)}`);
    assert.equal(report.states['node-without-commit-record'], undefined, 'no node without a commit record');
    const health = await ok(ctx.api.get('/api/health'), 'health');
    assert.ok(health.graph_integrity, 'a host request sees graph_integrity');
    assert.equal(health.graph_integrity.clean, true, JSON.stringify(health.graph_integrity));
    await cursor('boot');
  });

  await t.test('(2) the census: delete before commit + graceful → discarded 1, clean; a live pin + hard stop → uncommitted-lost once, then acknowledged', async () => {
    const browser = ctx.anonApi;
    const gone = (await ok(browser.post('/api/elements', commentBody({
      text: 'e2e-t2 gone before commit', shared: true, device: 'desktop',
      anchor: { mount: 'm-a', selector: 'p.lead', text: 'Pane m-a', ordinal: 0 },
    })), 'add')).pin;
    assert.equal((await browser.del(`/api/elements/${gone.id}`)).status, 200);
    await reboot('graceful');
    let report = bootReport(paths);
    assert.equal(report.clean, true, JSON.stringify(report.states));
    assert.deepEqual(report.states.discarded, { count: 1, examples: [`${gone.id}@${gone.v}`] }, 'the delete-before-commit reads discarded');
    assert.equal(integrityEvents(ctx.srv).length, 0);

    const lost = (await ok(ctx.anonApi.post('/api/elements', commentBody({
      text: 'e2e-t2 lost to a crash', shared: true, device: 'desktop',
      anchor: { mount: 'm-a', selector: 'p.lead', text: 'Pane m-a', ordinal: 0 },
    })), 'add live')).pin;
    await reboot('hard');
    report = bootReport(paths);
    assert.equal(report.clean, false);
    assert.deepEqual(unclean(report), ['uncommitted-lost'], JSON.stringify(report.states));
    assert.deepEqual(report.states['uncommitted-lost'], { count: 1, examples: [`${lost.id}@${lost.v}`] }, 'reported once');
    assert.equal(integrityEvents(ctx.srv).length, 1, 'one integrity event');
    assert.ok(logRecords(paths).some((r) => r.t === 'ack' && r.keys.includes(`uncommitted-lost ${lost.id}@${lost.v}`)), 'the reporting boot wrote the ack');

    await reboot('graceful');
    report = bootReport(paths);
    assert.equal(report.clean, true, JSON.stringify(report.states));
    assert.equal(report.states['uncommitted-lost'], undefined, 'not reported again');
    assert.ok(report.states.acknowledged && report.states.acknowledged.examples.includes(`uncommitted-lost ${lost.id}@${lost.v}`), JSON.stringify(report.states));
    assert.equal(integrityEvents(ctx.srv).length, 0);
    await cursor('after the census');
  });

  await t.test('(3) get_comments and reply_comment through the real MCP handlers, verified claude; the old /api/comments path answers the /exit hint in JSON', async () => {
    const c0 = await cursor('before mcp');
    const live = ctx.srv.state.comments.find((c) => c.id === g.cases.draft.newId);
    assert.ok(live && live.shared, 'precondition: the draft\'s c21 is live and shared');
    mcp = mcpProcess(t, root, ctx.port);
    const answer = await mcp.run(ctx.port, [
      ['get_comments', {}],
      ['reply_comment', { id: live.id, text: 'e2e-t2 claude replies' }],
      ['get_comments', { since: c0 }],
    ]);
    assert.equal(answer.stderr, '', 'no stderr line');
    const [first, reply, since] = values(answer);
    assert.ok(first.comments.some((c) => c.id === live.id), 'get_comments reads the element API');
    assert.ok(!first.comments.some((c) => c.id === 'c2'), 'and never the private page note');
    assert.ok(first.next_cursor >= c0);
    const last = reply.pin.replies.at(-1);
    assert.equal(last.author, 'claude');
    assert.equal(last.text, 'e2e-t2 claude replies');
    assert.deepEqual(last.writer, { class: 'claude', owner: 'claude', verified: true }, 'the writer token was sent');
    assert.ok(since.comments.some((c) => c.id === live.id) && since.next_cursor > c0);
    await cursor('after mcp');

    // The pre-upgrade MCP server's calls (lib/client, as its tools sent them).
    for (const [method, p, body] of [['GET', '/api/comments', null], ['POST', `/api/comments/${live.id}/reply`, { text: 'old', author: 'claude' }]]) {
      const r = await client.request(ctx.port, method, p, body, { timeout: 10000 });
      assert.notEqual(r.status, 404, `${method} ${p}: never a bare 404 (skew.js would call the daemon older)`);
      assert.equal(r.status, 410, `${method} ${p}: ${r.status}`);
      assert.ok(r.body && typeof r.body === 'object', `${method} ${p}: a JSON body`);
      assert.equal(r.body.ok, false);
      assert.match(r.body.hint, /\/exit/, `${method} ${p}: the hint names /exit`);
    }
    await assert.rejects(client.get('/api/comments', { port: ctx.port, noSpawn: true }), (e) => {
      assert.equal(e.status, 410);
      assert.match(JSON.stringify(e.body), /\/exit/);
      return true;
    });
  });

  await t.test('(4) commits: copies carry v and every element id@v is pinned; a highlight-only turn commits; diff_nodes names the element diff; a shared highlight raises one element queue item that get_comments type highlight reads', async () => {
    const browser = ctx.anonApi;
    // A: a pane rendered twice (gen 1), with a pin on it.
    const before = logRecords(paths).length;
    const endA = await turn(ctx, 'e2e-t2 turn A', async () => {
      await ok(ctx.api.post('/api/render', { id: 'e2e-pane', html: '<section><p class="lead">e2e-t2 pane one</p></section>' }), 'render');
      await ok(ctx.api.post('/api/render', { id: 'e2e-pane', html: '<section><p class="lead">e2e-t2 pane</p><p class="two">second line</p></section>' }), 'render again');
    });
    assert.ok(endA.node_id, `A committed: ${JSON.stringify(endA)}`);
    nodes.A = endA.node_id;
    const nodeA = readJsonFile(path.join(paths.graphDir, `${nodes.A}.json`));
    for (const c of nodeA.comments) assert.ok(Number.isInteger(c.v) && c.v >= 1, `${c.id}'s copy carries v`);
    const commitA = logRecords(paths).slice(before).filter((r) => r.t === 'commit' && r.node === nodes.A);
    assert.equal(commitA.length, 1);
    const pinsA = new Map(commitA[0].pins.map((s) => { const p = parsePin(s); return [p.id, p.v]; }));
    for (const c of nodeA.comments) {
      assert.equal(pinsA.get(c.id), c.v, `${c.id}: the record pins id@v`);
      assert.ok(copyMatches(c, ctx.srv.elements.version(c.id, c.v)), `${c.id}@${c.v} is the copy's version`);
    }

    // B: a highlight-only turn (E-STORE a): the user's shared highlight.
    let hl = null;
    const endB = await turn(ctx, 'e2e-t2 highlight only', async () => {
      hl = (await ok(browser.post('/api/elements', {
        type: 'highlight', anchor: RANGE('e2e-pane', 'e2e-t2 pane'), payload: { color: 'gold', note: 'e2e-t2 highlight note', shared: true }, device: 'desktop',
      }), 'highlight')).element;
    });
    assert.match(hl.id, /^h\d+$/, 'the highlight letter over the one counter (F1 a)');
    assert.ok(endB.node_id, `the highlight-only turn committed: ${JSON.stringify(endB)}`);
    nodes.B = endB.node_id;
    assert.deepEqual(readJsonFile(path.join(paths.graphDir, `${nodes.B}.json`)).elements, [`${hl.id}@1`], 'the node carries the reference, no copy');
    assert.ok(ctx.srv.elements.pinsOf(nodes.B).includes(`${hl.id}@1`), 'its commit record pins it');
    const queued = (await ok(ctx.api.get('/api/queue'), 'queue')).items.filter((it) => it.kind === 'element' && it.element_id === hl.id);
    assert.equal(queued.length, 1, 'one element queue item for the highlight');
    assert.equal(queued[0].type, 'highlight', 'type-tagged');
    const hlRead = values(await mcp.run(ctx.port, [['get_comments', { type: 'highlight' }]]))[0];
    assert.equal(hlRead.type, 'highlight');
    const got = hlRead.elements.find((e) => e.id === hl.id);
    assert.ok(got, 'get_comments type highlight reads it');
    assert.equal(got.note, 'e2e-t2 highlight note');
    assert.equal(got.anchor.quote.exact, 'e2e-t2 pane');

    // C: added, replied, edited and shared, then the real diff_nodes.
    let added = null;
    const replied = ctx.srv.state.comments.find((c) => c.id === g.cases.draft.newId);
    const edited = ctx.srv.state.comments.find((c) => c.id === g.cases.c1Refused.id);
    const shared = ctx.srv.state.comments.find((c) => c.id === g.cases.pageNote.id);
    assert.ok(replied && edited && shared && shared.shared === false, 'preconditions: c21, c5 and the private page note c2 are live');
    const endC = await turn(ctx, 'e2e-t2 comment changes', async () => {
      added = (await ok(browser.post('/api/elements', commentBody({
        text: 'e2e-t2 on the pane', shared: true, device: 'desktop',
        anchor: { mount: 'e2e-pane', selector: 'p.lead', text: 'e2e-t2 pane', ordinal: 0 },
      })), 'add')).pin;
      await ok(browser.post(`/api/elements/${replied.id}/reply`, { text: 'e2e-t2 user reply', device: 'desktop' }), 'reply');
      await ok(browser.patch(`/api/elements/${edited.id}`, { text: 'e2e-t2 edited wording', device: 'desktop' }), 'edit');
      await ok(browser.patch(`/api/elements/${shared.id}`, { shared: true, device: 'desktop' }), 'share');
    });
    assert.ok(endC.node_id, `C committed: ${JSON.stringify(endC)}`);
    nodes.C = endC.node_id;
    nodes.added = added;
    const diff = values(await mcp.run(ctx.port, [['diff_nodes', { a: nodes.A, b: nodes.C }]]))[0];
    assert.ok(diff.elements, `diff_nodes carries the element diff: ${JSON.stringify(Object.keys(diff))}`);
    const addedIds = diff.elements.added.map((e) => e.id).sort();
    assert.deepEqual(addedIds, [added.id, hl.id].sort(), 'added: the new comment and the highlight');
    assert.equal(diff.elements.added.find((e) => e.id === hl.id).type, 'highlight');
    const changes = Object.fromEntries(diff.elements.changed.map((e) => [e.id, e.changes]));
    assert.ok(changes[replied.id] && changes[replied.id].includes('replied'), `replied: ${JSON.stringify(changes)}`);
    assert.ok(changes[edited.id] && changes[edited.id].includes('edited'), `edited: ${JSON.stringify(changes)}`);
    assert.ok(changes[shared.id] && changes[shared.id].includes('shared'), `shared: ${JSON.stringify(changes)}`);
    assert.ok(!JSON.stringify(diff.elements).includes('e2e-t2 edited wording'), 'ids and types only, never text');
    await cursor('after the commits');
  });

  await t.test('(5) reports: the side table at commit; a remote basic socket gets no private element, anchor text or comment text; the counter orders reports across a restore', async (st) => {
    const pin = nodes.added;
    const TEXTS = [];
    const remember = (s) => { TEXTS.push(s); return s; };
    const local = await socket(t, ctx.port);
    const remote = await socket(t, ctx.port, { 'X-WC-Remote': '1' });
    const hello = local.of('hello')[0];
    const s0 = hello.surface;
    assert.ok(Number.isSafeInteger(s0) && s0 > 0, 'hello stamps the counter');
    assert.equal(s0, ctx.srv.reports.surface());
    const paneGen = hello.mounts.find((m) => m.id === 'e2e-pane').gen;
    assert.equal(paneGen, 1, 'the pane was rendered twice: gen 1');
    const stats = () => ctx.srv.reports.stats();

    await st.test('a local report lands, and the next commit\'s side table records the committed node\'s answer; diff_nodes names the orphan', async () => {
      const acc = stats().accepted;
      local.report(s0, [{ mount: 'e2e-pane', gen: paneGen, items: [{ id: pin.id, v: pin.v, state: 'orphaned', how: 'none' }] }]);
      await waitUntil(() => stats().accepted > acc, { ...WAIT, what: 'the report accepted' });
      const end = await turn(ctx, 'e2e-t2 report commit', () => ok(ctx.api.post('/api/render', { id: 'e2e-pane-2', html: '<p>another pane</p>' }), 'render'));
      assert.ok(end.node_id, JSON.stringify(end));
      nodes.D = end.node_id;
      const answer = ctx.srv.sideTable.answersFor(nodes.D).get(`${pin.id}@${pin.v}`);
      assert.ok(answer, 'the side table holds the committed node\'s answer');
      assert.equal(answer.state, 'orphaned');
      assert.equal(answer.node, nodes.D, 'recorded at this commit');
      assert.ok(logRecords(paths).some((r) => r.t === 'answers' && r.node === nodes.D), 'one answers record');
      const diff = values(await mcp.run(ctx.port, [['diff_nodes', { a: nodes.C, b: nodes.D }]]))[0];
      assert.deepEqual(diff.elements.orphaned.map((e) => e.id), [pin.id], 'diff_nodes names the orphan');
    });

    let r1 = null;
    await st.test('a remote basic socket: no private element, no anchor text, no comment text in hello, reset, element:* or marks', async () => {
      const browser = ctx.anonApi;
      const priv = (await ok(browser.post('/api/elements', commentBody({
        text: remember('e2e-t2-private-note'), shared: false, device: 'desktop',
        anchor: { mount: 'e2e-pane', selector: 'p.lead', text: remember('e2e-t2-private-anchor'), ordinal: 0 },
      })), 'private comment')).pin;
      const privHl = (await ok(browser.post('/api/elements', {
        type: 'highlight', anchor: RANGE('e2e-pane', remember('e2e-t2-private-quote')), payload: { color: 'rust', note: remember('e2e-t2-private-hl-note'), shared: false }, device: 'desktop',
      }), 'private highlight')).element;
      await ok(browser.post(`/api/elements/${pin.id}/reply`, { text: remember('e2e-t2-shared-reply'), device: 'desktop' }), 'shared reply');
      const marked = await client.request(ctx.port, 'POST', '/api/marks', { marks: [{ mount: 'e2e-pane', kind: 'look', label: remember('e2e-t2-mark-label') }] }, { timeout: 10000 });
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      await waitUntil(() => local.raw.some((f) => f.includes('e2e-t2-mark-label')), { ...WAIT, what: 'the local marks frame' });
      // A restore: every socket gets a reset (and the counter moves, below).
      const resets = local.of('reset').length;
      await ok(ctx.api.post('/api/graph/active', { id: nodes.C }), 'set active C');
      await waitUntil(() => local.of('reset').length > resets, { ...WAIT, what: 'the reset' });
      r1 = local.of('reset').at(-1);
      await waitUntil(() => remote.of('reset').length >= 1, { ...WAIT, what: 'the remote reset' });
      // The positive control: the local socket carried what the remote must not.
      for (const s of ['e2e-t2-private-note', 'e2e-t2-shared-reply', 'e2e-t2-mark-label']) {
        assert.ok(local.raw.some((f) => f.includes(s)), `the local socket carried ${s}`);
      }
      assert.ok(local.raw.some((f) => f.includes(`"${privHl.id}"`)), 'and the private highlight');
      const carried = [];
      for (const f of remote.raw) {
        for (const s of TEXTS) if (f.includes(s)) carried.push(s);
        for (const id of [priv.id, privHl.id]) if (f.includes(`"${id}"`)) carried.push(id);
        const msg = JSON.parse(f);
        if (/^element:/.test(msg.type)) carried.push(`an ${msg.type} frame`);
        if (msg.type === 'marks') carried.push('a marks frame');
        if ((msg.type === 'hello' || msg.type === 'reset') && ('elements' in msg || 'marks' in msg)) carried.push(`${msg.type} with elements or marks`);
      }
      assert.deepEqual(carried, [], 'nothing private, no anchor text and no comment text reached the remote basic socket');
      assert.ok(remote.of('hello').length === 1 && remote.of('reset').length >= 1, 'the remote socket got its hello and the reset');
    });

    await st.test('the counter: bumped by the Set active and stamped on its reset; a late report on the old counter never replaces one on the new; the restored surface is accepted although its gen restarted', async () => {
      assert.ok(r1.surface > s0, `the reset carries a larger counter: ${s0} < ${r1.surface}`);
      assert.equal(r1.surface, ctx.srv.reports.surface());
      const restored = r1.mounts.find((m) => m.id === 'e2e-pane');
      assert.equal(restored.gen ?? 0, 0, 'the restored pane\'s gen restarted (D18)');
      const acc = stats().accepted;
      local.report(r1.surface, [{ mount: 'e2e-pane', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact', how: 'path' }] }]);
      await waitUntil(() => stats().accepted > acc, { ...WAIT, what: 'the restored surface\'s report accepted' });
      const stale = stats().refused['stale-surface'] || 0;
      local.report(s0, [{ mount: 'e2e-pane', gen: paneGen, items: [{ id: pin.id, v: pin.v, state: 'orphaned', how: 'none' }] }]);
      await waitUntil(() => (stats().refused['stale-surface'] || 0) > stale, { ...WAIT, what: 'the late report refused' });
      const held = ctx.srv.reports.answers({ mount: 'e2e-pane' }).filter((a) => a.id === pin.id);
      assert.equal(held.length, 1);
      assert.equal(held[0].state, 'exact', 'the new counter\'s answer stands');
      assert.equal(held[0].surface, r1.surface);
      assert.deepEqual(Object.keys(stats().refused).filter((k) => stats().refused[k] > 0), ['stale-surface'], 'no "not the active node" refusal exists');
    });
    local.close();
    remote.close();
    await cursor('after reports');
  });

  await t.test('(6) a graceful stop and a reboot append only the close and an epoch; the boot stays clean; the live state is not dirty', async () => {
    const before = logRecords(paths);
    const active = ctx.srv.graph.active;
    await reboot('graceful');
    await ok(ctx.api.get('/api/elements?type=comment'), 'GET after reboot');
    const after = logRecords(paths);
    const added = after.slice(before.length);
    assert.ok(added.length >= 1 && added.length <= 2, `a close and at most an epoch: ${JSON.stringify(added)}`);
    assert.equal(added[0].t, 'close', JSON.stringify(added));
    assert.equal(added[0].complete, true);
    for (const p of added[0].held) assert.ok(parsePin(p), `ids only: ${p}`);
    // heldCopies reads value.elements beside value.comments (U352, K.2-4): a
    // graceful close holds the live highlights as it holds the comments.
    assert.ok(added[0].held.some((p) => /^h\d+@\d+$/.test(p)), `the close holds a highlight: ${JSON.stringify(added[0].held)}`);
    for (const r of added.slice(1)) assert.equal(r.t, 'epoch');
    assert.deepEqual(after.slice(0, before.length), before, 'nothing before it changed');
    const report = bootReport(paths);
    assert.equal(report.clean, true, JSON.stringify(report.states));
    assert.equal(liveIsDirty(ctx.srv.graph), false, 'the reboot is not a change');
    assert.equal(ctx.srv.graph.active, active);
    await cursor('after reboot');
  });

  await t.test('(7) Set active on a migrated older node restores its pins with their v; the next no-op turn commits 0 nodes', async () => {
    const target = 'n4';
    const r = await ctx.api.post('/api/graph/active', { id: target });
    assert.equal(r.status, 200, r.text);
    assert.equal(ctx.srv.graph.active, target);
    const want = [...v3Copies.get(target).keys()].sort();
    const live = ctx.srv.state.comments;
    assert.deepEqual(live.map((c) => c.id).sort(), want, 'the node\'s pins are live');
    for (const c of live) {
      assert.ok(Number.isInteger(c.v) && c.v >= 1, `${c.id} restored with its v`);
      assert.ok(copyMatches(v3Copies.get(target).get(c.id), ctx.srv.elements.version(c.id, c.v)), `${c.id}@${c.v} is the v3 copy's version`);
    }
    const count = ctx.srv.graph.nodes.size;
    const end = await turn(ctx, 'e2e-t2 no-op turn');
    assert.ok(!end.node_id, `a no-op turn commits nothing: ${JSON.stringify(end)}`);
    assert.equal(ctx.srv.graph.nodes.size, count, '0 nodes');
    assert.equal(liveIsDirty(ctx.srv.graph), false);
    await cursor('after set active');
  });

  await t.test('(8) GET /api/toolbar merges the user and project tiers; the portal protocol reads 12', async () => {
    const call = (method, p, body) => client.request(ctx.port, method, p, body, { timeout: 10000 });
    let r = await call('PATCH', '/api/toolbar/user', { bindings: { X: { kind: 'tool', type: 'highlight' }, Z: { kind: 'tool', type: 'box-grab' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('PATCH', '/api/toolbar', { bindings: { Y: { kind: 'tool', type: 'comment' }, X: null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = await ok(ctx.anonApi.get('/api/toolbar'), 'GET /api/toolbar');
    const b = body.merged.bindings;
    assert.equal(b.Z.tier, 'user', 'a user-only key comes from the user tier');
    assert.equal(b.Z.value.type, 'box-grab');
    assert.equal(b.Y.tier, 'project', 'a project-only key from the project tier');
    assert.equal(b.X.tier, 'project', 'the project tier wins a key both name');
    assert.equal(b.X.value, null, 'an unbind is a value (null) that wins');
    assert.deepEqual(b.X.shadows.map((s) => s.tier), ['user'], 'the user binding it shadows');
    assert.deepEqual(body.tools.map((x) => x.type), ['comment', 'highlight', 'box-grab'], 'the built-in types listed');
    assert.ok(fs.existsSync(paths.toolbar), '.web-chat/toolbar.json written');
    assert.equal(PORTAL_PROTOCOL_VERSION, 12, 'protocol 12 (PROTO@bump a, U332)');
  });

  await t.test('(9) the writer token across a restart: the MCP process re-reads it once and lands verified; a never-minted token fails with the daemon\'s hint and no tokenless retry', async () => {
    const reply = ctx.srv.state.comments.find((c) => c.shared);
    assert.ok(reply, 'a shared live pin to reply to');
    // Warm the process's cache on this boot.
    const warm = await mcp.run(ctx.port, [['get_comments', {}]]);
    values(warm);
    const oldToken = ctx.writerToken();
    await reboot('graceful');
    assert.notEqual(ctx.writerToken(), oldToken, 'the new boot wrote its own token');
    assert.ok(oldToken);
    const seen = [];
    const listen = (req) => { if (req.url.startsWith('/api/elements')) seen.push(req.headers[WRITER_HEADER.toLowerCase()] || null); };
    ctx.server.prependListener('request', listen);
    t.after(() => ctx.server.off('request', listen));
    const again = await mcp.run(ctx.port, [['reply_comment', { id: reply.id, text: 'e2e-t2 after the restart' }]]);
    assert.equal(again.reads, 1, 'one re-read of .web-chat/writer-token');
    const [r] = values(again);
    assert.deepEqual(r.pin.replies.at(-1).writer, { class: 'claude', owner: 'claude', verified: true }, 'verified claude');
    // The process's cached token is an earlier boot's (a GET with a stale
    // token is answered, so the warm call kept it); the daemon refuses it on
    // the write, the client re-reads once and resends with this boot's.
    assert.equal(seen.length, 2, `two requests: ${seen.length}`);
    assert.ok(seen[0] && seen[0] !== ctx.writerToken(), 'the cached, earlier boot\'s token first');
    assert.equal(seen[1], ctx.writerToken(), 'then the token the re-read found');

    // A token this daemon never minted: a fresh MCP process reads it.
    const real = fs.readFileSync(paths.writerToken, 'utf8');
    const forged = 'f'.repeat(real.trim().length);
    fs.writeFileSync(paths.writerToken, forged + '\n');
    t.after(() => { try { fs.writeFileSync(paths.writerToken, real); } catch {} });
    const fresh = mcpProcess(t, root, ctx.port);
    seen.length = 0;
    const refused = await fresh.run(ctx.port, [['reply_comment', { id: reply.id, text: 'e2e-t2 forged' }]]);
    fresh.kill();
    fs.writeFileSync(paths.writerToken, real);
    assert.equal(refused.results[0].ok, false, 'refused');
    assert.equal(refused.results[0].status, 401);
    assert.match(refused.results[0].error, /writer-token/, 'the daemon\'s hint names .web-chat/writer-token');
    assert.ok(seen.length >= 1 && seen.every((tok) => tok === forged), `every request carried the token, never a tokenless retry: ${JSON.stringify(seen.map((s) => s && s.slice(0, 4)))}`);
    assert.ok(!ctx.srv.state.comments.find((c) => c.id === reply.id).replies.some((x) => x.text === 'e2e-t2 forged'), 'nothing landed');
    mcp.kill();
    await cursor('after the token checks');
  });

  await t.test('(10) AG-1: every node file parses as a 0.8.5 node and every copy keeps its v3 fields; every log record is one alpha.1 indexes or counts unknown', () => {
    const files = fs.readdirSync(paths.graphDir).filter((f) => /^n\d+\.json$/.test(f));
    assert.ok(files.length > g.nodes.length, 'the run added nodes beside the v3 ones');
    for (const f of files) {
      const node = readJsonFile(path.join(paths.graphDir, f));
      assert.deepEqual(shapeProblems(SHAPE.node, node, f), []);
      for (const c of node.comments || []) {
        const where = `${f} ${c.id}`;
        assert.deepEqual(shapeProblems(SHAPE.comment, c, where), []);
        if (c.anchor) assert.deepEqual(shapeProblems(SHAPE.anchor, c.anchor, `${where} anchor`), []);
        for (const [i, r] of (c.replies || []).entries()) assert.deepEqual(shapeProblems(SHAPE.reply, r, `${where} reply ${i}`), []);
        const v3 = v3Copies.get(node.id) && v3Copies.get(node.id).get(c.id);
        if (v3) for (const [k, v] of Object.entries(v3)) assert.deepEqual(c[k], v, `${where}: ${k} kept`);
      }
    }
    const readings = new Map();
    for (const rec of logRecords(paths)) {
      const how = alpha1Reading(rec);
      assert.ok(how === 'indexed' || how === 'unknown', `alpha.1 would skip a ${rec.t} record: ${how} ${JSON.stringify(rec).slice(0, 200)}`);
      if (!readings.has(rec.t)) readings.set(rec.t, how);
    }
    // The residuals, named for the acceptor and the alpha notes: alpha.1
    // counts tranche 2's close, ack and answers records unknown and ignores
    // them (a delete-before-commit reads uncommitted-lost again there; an
    // acknowledged state re-reports); it indexes highlight@1 versions as
    // versions, and its chrome draws no highlight; it cannot read the toolbar
    // records (.web-chat/toolbar.json, outside the log).
    const unknown = [...readings].filter(([, how]) => how === 'unknown').map(([t_]) => t_).sort();
    assert.deepEqual(unknown, ['ack', 'answers', 'close'], `the record types alpha.1 counts unknown: ${unknown.join(', ')}`);
    assert.ok(logRecords(paths).some((r) => r.t === 'ver' && typeof r.schema === 'string' && r.schema.startsWith('highlight@')), 'a highlight version is in the log (indexed by alpha.1 as a version)');
  });

  await t.test('the comment cursor never decreased across the whole run', () => {
    for (let i = 1; i < cursors.length; i++) {
      assert.ok(cursors[i][1] >= cursors[i - 1][1], `${cursors[i][0]} (${cursors[i][1]}) < ${cursors[i - 1][0]} (${cursors[i - 1][1]})`);
    }
    assert.ok(cursors.length >= 9);
  });
});

// K.2-66 (U313's review): a failed answers append is logged as the answers
// record, not as the commit record (graph.elements.noteAppendFailure's kind).
test('a failed answers append logs the answers record, and the commit still lands', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'a note', shared: true, anchor: { mount: 'p1', selector: 'p', text: 'one' } })), 'pin')).pin;
  const s = await socket(t, d.port);
  const acc = d.srv.reports.stats().accepted;
  s.report(d.srv.reports.surface(), [{ mount: 'p1', gen: 0, items: [{ id: pin.id, v: pin.v, state: 'exact', how: 'path' }] }]);
  await waitUntil(() => d.srv.reports.stats().accepted > acc, { ...WAIT, what: 'the report' });
  d.srv.elements.log.appendAnswers = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  let end;
  try {
    await ok(d.api.post('/api/turn-begin', { message: 'go' }), 'turn-begin');
    end = await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'go' }), 'turn-end');
  } finally { console.error = orig; }
  assert.ok(end.node_id, 'the commit landed');
  // The side table logs its own line too; the store's line is noteAppendFailure's.
  const failed = lines.filter((l) => /could not append the (commit|answers) record/.test(l));
  assert.equal(failed.length, 1, JSON.stringify(lines));
  assert.match(failed[0], /could not append the answers record \(ENOSPC\)/);
  assert.ok(!/commit record/.test(failed[0]), 'never named the commit record');
  assert.equal(d.srv.elements.stats().append_failures, 1);
});
