// Tranche 1 of the annotation engine, end to end (PLAN.md §2, items 1A.1–1D.4;
// U240): a project that starts at schema v3, met the way an upgrading user
// meets it — `claude-web-chat migrate` first (a dry run that writes nothing),
// then the first boot of the real createServer (withServer), which migrates the
// comment pins into .web-chat/elements/log.jsonl and keeps working.
//
// The project is test-support/v3-graph.js's fixed graph (U204's fixture): a
// fork, ghost copies, replies on ghosts, a page note with no `replies` key, a
// re-minted id, a draft and a set-aside node file. ONE root, one subtest per
// step, in order, each step reading the state the step before it left:
//
//   (1) the dry run: a report naming the copies to migrate, 0 bytes written;
//   (2) the first boot: _version.json 4, the log, a clean boot report and a
//       clean graph_integrity on /api/health (a host request);
//   (3) add, reply, edit and delete through the comment routes as the chrome
//       sends them (a browser's fetch, its device claim), then get_comments and
//       reply_comment through the REAL MCP tool handlers in a subprocess (cwd
//       the root, WEB_CHAT_PORT, WEB_CHAT_MCP_SERVER=1 so the writer token is
//       sent): the reply is author claude, verified;
//   (4) a turn through the turn routes the hooks call commits a node whose
//       comment copies carry `v` and whose commit record pins id@v;
//   (5) a graceful stop and a reboot: the log grows by at most one record, an
//       epoch; the boot report is still clean; the live state is not dirty;
//   (6) a Wipe with a pinned pane under its heading: the pin on that kept
//       heading survives, every other live pin goes, committed node files are
//       byte-identical (U206; PLAN §7 obligation 10);
//   (7) Set active on a migrated older node: 200, its pins restored with their
//       v, and the next no-op turn commits 0 nodes;
//   (8) a remote socket at basic (X-WC-Remote) receives no comment text in any
//       frame, and GET /api/comments refuses it;
//   (9) AG-1's shape: every node file still parses as a node and every comment
//       copy keeps every v3 field (test/fixtures/v3-node-shape.json, derived
//       once from f3c4a7f's reader);
//  (10) the H1 rulings are built in: createAnchors' CONFIG has head_floor and
//       ordinal true.
//
// Through every step the comment cursor (GET /api/comments next_cursor) never
// decreases. Every server is closed by withServer's t.after.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const client = require('../lib/client');
const { projectPaths } = require('../lib/core/paths');
const { SCHEMA_VERSION } = require('../lib/core/versions');
const { copyMatches } = require('../lib/core/element-log');
const { liveIsDirty } = require('../lib/server/domain/turns');
const { createAnchors, ANCHOR_STATES } = require('../lib/core/anchors');
const { GRAPH_ANCHOR_STATES } = require('../lib/server/domain/refs');
const SHAPE = require('./fixtures/v3-node-shape.json');

const REPO = path.join(__dirname, '..');
const BIN = path.join(REPO, 'bin', 'claude-web-chat.js');
const WAIT = { timeout: 10000, interval: 20 };

// ── helpers ──────────────────────────────────────────────────────────────────

// Every entry under a directory: its path, kind, size and bytes' hash.
function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isDirectory()) { out.push(`${rel}/`); walk(full); } else {
        out.push(`${rel} ${st.size} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out;
}

// sha256 of every committed node file, by name.
function nodeDigests(paths) {
  const out = {};
  for (const f of fs.readdirSync(paths.graphDir).filter((x) => /^n\d+\.json$/.test(x)).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(paths.graphDir, f))).digest('hex');
  }
  return out;
}

const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const logRecords = (paths) => {
  let text = '';
  try { text = fs.readFileSync(paths.elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const version = (paths) => readJsonFile(paths.version).version;

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  assert.notEqual(r.json && r.json.ok, false, `${what}: ${r.text}`);
  return r.json;
}

// The turn routes as the hooks call them: lib/client, no Origin, no
// Sec-Fetch-*, no spawn, with the session fields lib/hooks/turn-begin.js sends.
const SESSION = { session_id: 'sess-elements-e2e', cwd: null, permission_mode: 'default' };
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

// pane_state is only settable over the WS (the browser owns pane chrome).
async function pinPane(ctx, id) {
  const sock = ctx.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  try {
    await waitUntil(async () => {
      const m = (await ctx.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
      return !!(m && m.pane_state && m.pane_state.pinned);
    }, { ...WAIT, what: `pane ${id} pinned` });
  } finally { sock.close(); }
}

// A socket that keeps every frame it is sent.
async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { frames.push(data.toString()); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => /"type":"hello"/.test(f)), { ...WAIT, what: 'the hello' });
  return { ws, frames, close: () => { try { ws.terminate(); } catch {} } };
}

// The MCP tools' handlers, run as Claude Code's MCP server runs them: a
// process of their own, cwd the project, WEB_CHAT_MCP_SERVER=1 (so
// lib/mcp/client sends this boot's writer token) and WEB_CHAT_PORT.
function mcpTools(ctx, calls) {
  const script = `
    const calls = ${JSON.stringify(calls)};
    const tools = {
      get_comments: require(${JSON.stringify(path.join(REPO, 'lib/mcp/tools/get_comments.js'))}),
      reply_comment: require(${JSON.stringify(path.join(REPO, 'lib/mcp/tools/reply_comment.js'))}),
    };
    (async () => {
      const out = [];
      for (const [name, args] of calls) {
        try { out.push({ ok: true, value: await tools[name].handler(args) }); }
        catch (e) { out.push({ ok: false, error: String(e && e.message), status: e && e.status, body: e && e.body }); }
      }
      process.stdout.write(JSON.stringify(out));
    })();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ctx.root,
      env: { ...process.env, WEB_CHAT_PORT: String(ctx.port), WEB_CHAT_MCP_SERVER: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`mcp tools timed out: ${err}`)); }, 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`mcp tools exited ${code}: ${err}`));
      try { resolve({ results: JSON.parse(out), stderr: err }); } catch (e) { reject(new Error(`mcp tools: ${out} ${err}`)); }
    });
  });
}

// AG-1: a value against one field rule of the shape fixture.
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

// ── the run ──────────────────────────────────────────────────────────────────

test('a v3 project migrates on its first boot and keeps working (steps 1–9)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-elements-e2e-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const g = v3Graph(root);
  const paths = projectPaths(root);
  // The v3 copies, as a 0.8.5 daemon wrote them, by node file and id.
  const v3Copies = new Map();
  for (const n of g.nodes) v3Copies.set(n.id, new Map(n.comments.map((c) => [c.id, JSON.parse(JSON.stringify(c))])));

  let ctx = null;
  const cursors = [];
  async function cursor(what) {
    const r = await ok(ctx.api.get('/api/comments'), `cursor ${what}`);
    assert.ok(Number.isInteger(r.next_cursor), `${what}: next_cursor is an integer`);
    cursors.push([what, r.next_cursor]);
    return r.next_cursor;
  }
  // Distinct texts this run writes, for the remote check.
  const TEXTS = [];
  const remember = (s) => { TEXTS.push(s); return s; };
  let remote = null;
  let local = null;
  let committedA = null;

  await t.test('(1) `claude-web-chat migrate` reports the copies to migrate and writes nothing', () => {
    const before = listing(root);
    const r = spawnSync(process.execPath, [BIN, 'migrate'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.match(r.stdout, /copies\s+23 on nodes, 5 in the draft/, 'the report names the copies to migrate');
    assert.match(r.stdout, /would append \d+ records, \d+ bytes/);
    assert.deepEqual(listing(root), before, '0 bytes written');
    assert.equal(version(paths), 3, '_version.json still 3');
    assert.equal(fs.existsSync(paths.elementsDir), false, 'no .web-chat/elements/');
  });

  await t.test('(2) the first boot migrates: schema 4, the log, a clean boot report and graph_integrity', async () => {
    ctx = await withServer(t, { root });
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(version(paths), 4, '_version.json 4');
    assert.ok(fs.existsSync(paths.elementsLog), '.web-chat/elements/log.jsonl present');
    const recs = logRecords(paths);
    assert.equal(recs.filter((r) => r.t === 'migration').length, 1, 'one migration record');
    const report = readJsonFile(paths.elementsBootReport);
    assert.equal(report.clean, true, `the boot report is clean: ${JSON.stringify(report.states)}`);
    const health = await ok(ctx.api.get('/api/health'), 'health');
    assert.ok(health.graph_integrity, 'a host request sees graph_integrity');
    assert.equal(health.graph_integrity.clean, true, JSON.stringify(health.graph_integrity));
    assert.equal(ctx.srv.elements.readOnly, false);
    // The live pins are the draft's, each with the log version it pins.
    const live = (await ok(ctx.api.get('/api/comments'), 'GET')).comments;
    assert.deepEqual(live.map((c) => c.id).sort(), [...g.cases.draft.ids].sort());
    for (const c of live) assert.ok(Number.isInteger(c.v) && c.v >= 1, `${c.id} carries v`);
    remote = await socket(t, ctx.port, { 'X-WC-Remote': '1' });
    local = await socket(t, ctx.port);
    await cursor('boot');
  });

  await t.test('(3) the chrome adds, replies, edits and deletes; the MCP tools read and reply as claude, verified', async () => {
    const browser = ctx.anonApi; // Node's fetch: a browser's request, no writer token
    const c0 = await cursor('before writes');
    const add = await ok(browser.post('/api/comments', {
      text: remember('e2e-note-alpha'), shared: true, device: 'desktop',
      anchor: { mount: 'm-a', selector: 'p.lead', text: 'Pane m-a', ordinal: 0 },
    }), 'add');
    const pin = add.pin;
    assert.match(pin.id, /^c\d+$/);
    assert.equal(pin.v, 1);
    assert.equal(pin.writer.class, 'user');
    assert.equal(pin.provenance.device, 'desktop');
    const c1 = await cursor('after add');
    assert.ok(c1 > c0, 'an add raises the cursor');
    const rep = await ok(browser.post(`/api/comments/${pin.id}/reply`, { text: remember('e2e-reply-beta'), device: 'desktop' }), 'reply');
    assert.equal(rep.pin.v, 2);
    assert.equal(rep.pin.replies.at(-1).author, 'user');
    const edit = await ok(browser.patch(`/api/comments/${pin.id}`, { text: remember('e2e-note-alpha-edited'), device: 'desktop' }), 'edit');
    assert.equal(edit.pin.v, 3);
    assert.equal(edit.pin.text, 'e2e-note-alpha-edited');
    assert.ok(edit.pin.edited && edit.pin.edited.writer.class === 'user', 'the edit stamp');
    // A delete: a migrated pin the draft held (c5, its versions committed on
    // n3 and n5). A delete drops the live copy and writes nothing (C2); see the
    // last test in this file for a pin deleted before any commit.
    const doomed = ctx.srv.state.comments.find((c) => c.id === g.cases.c1Refused.id);
    assert.ok(doomed, 'precondition: the draft\'s c5 is live');
    const logBefore = logRecords(paths).length;
    const del = await browser.del(`/api/comments/${doomed.id}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(logRecords(paths).length, logBefore, 'a delete appends nothing (no tombstone)');
    const c2 = await cursor('after delete');
    assert.ok(c2 >= edit.pin.seq, 'a delete never lowers the cursor');
    assert.equal((await ok(ctx.api.get('/api/comments'), 'GET')).comments.some((c) => c.id === doomed.id), false);

    // The MCP tools, in a process of their own.
    const replyText = remember('e2e-claude-delta');
    const { results, stderr } = await mcpTools(ctx, [
      ['get_comments', {}],
      ['reply_comment', { id: pin.id, text: replyText }],
      ['get_comments', { since: c2 }],
    ]);
    assert.equal(stderr, '', 'no stale-token fallback line');
    for (const r of results) assert.ok(r.ok, `a tool call failed: ${JSON.stringify(r)}`);
    const [first, reply, since] = results.map((r) => r.value);
    const ids = first.comments.map((c) => c.id);
    assert.ok(ids.includes(pin.id), 'get_comments returns the new pin');
    assert.ok(!ids.includes('c2'), 'and never the private page note');
    assert.ok(first.next_cursor >= c2, 'the tool reads the same cursor');
    const last = reply.pin.replies.at(-1);
    assert.equal(last.author, 'claude', 'reply_comment answers as claude');
    assert.equal(last.text, replyText);
    assert.deepEqual(last.writer, { class: 'claude', owner: 'claude', verified: true }, 'verified: the writer token was sent');
    assert.ok(since.comments.some((c) => c.id === pin.id), 'the reply re-surfaces the pin since the cursor');
    assert.ok(since.next_cursor > c2);
    await cursor('after mcp');
    // A local socket saw the comment text (the positive control for (8)).
    await waitUntil(() => local.frames.some((f) => f.includes(replyText)), { ...WAIT, what: 'the local comments frame' });
  });

  await t.test('(4) a turn through the turn routes commits a node whose copies carry v, pinned id@v in its commit record', async () => {
    const before = logRecords(paths).length;
    const liveIds = ctx.srv.state.comments.map((c) => c.id).sort();
    const end = await turn(ctx, 'e2e turn A', () => ok(ctx.api.post('/api/render', {
      id: 'e2e-pane', html: '<section><p class="lead">e2e pane</p></section>',
    }), 'render'));
    assert.ok(end.node_id, `a node was committed: ${JSON.stringify(end)}`);
    committedA = end.node_id;
    const node = readJsonFile(path.join(paths.graphDir, `${end.node_id}.json`));
    assert.deepEqual(node.comments.map((c) => c.id).sort(), liveIds, 'the live pins rode into the node');
    for (const c of node.comments) assert.ok(Number.isInteger(c.v) && c.v >= 1, `${c.id}'s copy carries v`);
    const added = logRecords(paths).slice(before);
    const commits = added.filter((r) => r.t === 'commit' && r.node === end.node_id);
    assert.equal(commits.length, 1, 'one commit record for the node');
    const pins = new Map(commits[0].pins.map((s) => { const i = s.lastIndexOf('@'); return [s.slice(0, i), Number(s.slice(i + 1))]; }));
    assert.deepEqual([...pins.keys()].sort(), node.comments.map((c) => c.id).sort(), 'the record pins every copy');
    for (const c of node.comments) {
      assert.equal(pins.get(c.id), c.v, `${c.id}: the record pins id@v`);
      assert.ok(copyMatches(c, ctx.srv.elements.version(c.id, c.v)), `${c.id}@${c.v} is the copy's version`);
    }
    await cursor('after turn');
  });

  await t.test('(5) a graceful stop and a reboot append at most one record, an epoch; the boot stays clean', async () => {
    const before = logRecords(paths);
    await ctx.graceful();
    ctx = await withServer(t, { root });
    await ok(ctx.api.get('/api/comments'), 'GET after reboot');
    const after = logRecords(paths);
    const added = after.slice(before.length);
    assert.ok(added.length <= 1, `at most one record: ${JSON.stringify(added)}`);
    for (const r of added) assert.equal(r.t, 'epoch', `only an epoch: ${JSON.stringify(r)}`);
    assert.deepEqual(after.slice(0, before.length), before, 'nothing before it changed');
    const report = readJsonFile(paths.elementsBootReport);
    assert.equal(report.clean, true, JSON.stringify(report.states));
    assert.equal(liveIsDirty(ctx.srv.graph), false, 'the reboot is not a change');
    assert.equal(ctx.srv.graph.active, committedA);
    remote.close();
    local.close();
    remote = await socket(t, ctx.port, { 'X-WC-Remote': '1' });
    local = await socket(t, ctx.port);
    await cursor('after reboot');
  });

  await t.test('(6) a Wipe keeps the pin on the heading above a pinned pane, drops every other live pin, and leaves node files as they were', async () => {
    const browser = ctx.anonApi;
    await ok(ctx.api.post('/api/markdown', { id: 'md-e2e-head', text: '## Kept section' }), 'heading');
    await ok(ctx.api.post('/api/render', { id: 'e2e-kept', html: '<p id="k">Kept pane</p>' }), 'kept pane');
    await pinPane(ctx, 'e2e-kept');
    const onHead = (await ok(browser.post('/api/comments', {
      text: remember('e2e-on-heading'), shared: true, device: 'desktop',
      anchor: { mount: 'md-e2e-head', selector: 'h2', text: 'Kept section', ordinal: 0 },
    }), 'pin on the heading')).pin;
    const commit = await turn(ctx, 'e2e turn before the wipe');
    assert.ok(commit.node_id, 'the page above committed');
    const digests = nodeDigests(paths);
    const liveBefore = (await ok(ctx.api.get('/api/comments'), 'GET')).comments.map((c) => c.id);
    assert.ok(liveBefore.length > 1);
    const w = await ok(ctx.api.post('/api/graph/wipe', {}), 'wipe');
    assert.deepEqual(w.kept, ['e2e-kept']);
    const live = (await ok(ctx.api.get('/api/comments'), 'GET')).comments.map((c) => c.id);
    assert.deepEqual(live, [onHead.id], 'only the pin on the kept heading survives');
    const now = nodeDigests(paths);
    for (const [f, h] of Object.entries(digests)) assert.equal(now[f], h, `${f} is byte-identical`);
    await cursor('after wipe');
  });

  await t.test('(7) Set active on a migrated older node restores its pins with their v; the next no-op turn commits 0 nodes', async () => {
    const target = 'n4'; // branch A: a non-prefix reply edit, a ghost with a reply, a re-minted id
    const r = await ctx.api.post('/api/graph/active', { id: target });
    assert.equal(r.status, 200, r.text);
    assert.equal(ctx.srv.graph.active, target);
    const want = [...v3Copies.get(target).keys()].sort();
    const live = ctx.srv.state.comments;
    assert.deepEqual(live.map((c) => c.id).sort(), want, 'the node\'s pins are live');
    for (const c of live) {
      assert.ok(Number.isInteger(c.v) && c.v >= 1, `${c.id} restored with its v`);
      assert.ok(copyMatches(v3Copies.get(target).get(c.id), ctx.srv.elements.version(c.id, c.v)),
        `${c.id}@${c.v} is the v3 copy's version`);
    }
    const nodesBefore = ctx.srv.graph.nodes.size;
    const end = await turn(ctx, 'e2e no-op turn');
    assert.ok(!end.node_id, `a no-op turn commits nothing: ${JSON.stringify(end)}`);
    assert.equal(ctx.srv.graph.nodes.size, nodesBefore, '0 nodes');
    assert.equal(liveIsDirty(ctx.srv.graph), false);
    await cursor('after set active');
  });

  await t.test('(8) a remote socket at basic receives no comment text in any frame; GET /api/comments refuses it', async () => {
    const browser = ctx.anonApi;
    // One more write while both sockets listen.
    const live = ctx.srv.state.comments.find((c) => c.shared);
    const text = remember('e2e-late-epsilon');
    await ok(browser.post(`/api/comments/${live.id}/reply`, { text, device: 'desktop' }), 'late reply');
    await waitUntil(() => local.frames.some((f) => f.includes(text)), { ...WAIT, what: 'the local frame' });
    const remoteGet = await ctx.anonApi.get('/api/comments', { 'X-WC-Remote': '1' });
    assert.equal(remoteGet.status, 403, remoteGet.text);
    for (const s of TEXTS) assert.ok(!remoteGet.text.includes(s), `the refusal carries no ${s}`);
    assert.ok(remote.frames.length >= 1, 'the remote socket was connected');
    const carried = [];
    for (const f of remote.frames) {
      const msg = JSON.parse(f);
      if (msg.type === 'comments') carried.push('a comments frame');
      for (const s of TEXTS) if (f.includes(s)) carried.push(s);
      for (const c of ctx.srv.state.comments) if (c.text && f.includes(`"${c.text}"`)) carried.push(c.text);
    }
    assert.deepEqual(carried, [], 'no comment text reached the remote socket');
    await cursor('after remote');
  });

  await t.test('(9) AG-1: every node file parses as a node and every copy keeps every v3 field', () => {
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
        // A v3 node's copy is the copy a 0.8.5 daemon wrote, every field kept.
        const v3 = v3Copies.get(node.id) && v3Copies.get(node.id).get(c.id);
        if (v3) for (const [k, v] of Object.entries(v3)) assert.deepEqual(c[k], v, `${where}: ${k} kept`);
      }
    }
  });

  await t.test('the comment cursor never decreased across the whole run', () => {
    for (let i = 1; i < cursors.length; i++) {
      assert.ok(cursors[i][1] >= cursors[i - 1][1], `${cursors[i][0]} (${cursors[i][1]}) < ${cursors[i - 1][0]} (${cursors[i - 1][1]})`);
    }
    assert.ok(cursors.length >= 9);
  });
});

test('(10) the H1 rulings are built into the resolver: head_floor and ordinal on', () => {
  const { CONFIG } = createAnchors(ANCHOR_STATES);
  assert.equal(CONFIG.head_floor, true, 'H1@head-floor');
  assert.equal(CONFIG.ordinal, true, 'H1@ordinal-tail');
  // The graph family's states are the shared vocabulary's (1C.5; U207's note).
  for (const s of GRAPH_ANCHOR_STATES) assert.ok(ANCHOR_STATES.includes(s), `${s} is an anchor state`);
});

// A FINDING, recorded as a todo rather than pinned (U240 hand-off, open issue
// 1; U209's own open issue): a pin added and deleted before any commit leaves
// versions no commit ever pins, and nothing records the delete (C2: no
// tombstone), so every later boot's reconcile reports them as
// `uncommitted-lost` — a boot report that is never clean again, one stderr
// line and one integrity event per boot. The fix needs an engine change (a
// delete reason the census reads, or the state counted as normal), routed to
// a corrective unit; this test turns green when it lands.
test('a pin added and deleted before any commit leaves the next boot clean', {
  todo: 'U209 open issue: uncommitted-lost for a pin deleted before its first commit (U240 open issue 1)',
}, async (t) => {
  const first = await withServer(t);
  const paths = projectPaths(first.root);
  const pin = (await ok(first.anonApi.post('/api/comments', { text: 'gone before commit', shared: true, anchor: null }), 'add')).pin;
  assert.equal((await first.anonApi.del(`/api/comments/${pin.id}`)).status, 200);
  await first.graceful();
  await withServer(t, { root: first.root });
  const report = readJsonFile(paths.elementsBootReport);
  assert.equal(report.clean, true, JSON.stringify(report.states));
});
