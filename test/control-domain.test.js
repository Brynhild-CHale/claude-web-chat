// The control domain (lib/server/control/index.js, spec §15.2, §15.3, §15.5):
//   * the action table: a row is validated, replaced by name, unregistered;
//     invoke() runs limiter → check → run → audit, and a check refusal never
//     reaches run; each action its own bucket;
//   * on the REAL answer surface (U55's, an ephemeral loopback port, a fixture
//     publicDir): the control document with its nonce and its wc-control meta,
//     404 for a layout the row does not list or an unknown action, and the
//     decide gate for POST /answer/api/control/interrupt — refused from the
//     chrome's origin, with no Origin, with a wrong Host, cross-site, without
//     JSON, with another target's or another action's nonce, with an extra
//     body key, remotely; accepted with all of it right; every refusal our
//     handler can see and the acceptance write one audit line;
//   * the notices: one per conversation, capped, claimed once, within
//     max_chars, by session or by pid, a null conversation to the next claimer;
//   * the audit: its fields, nothing else, and the move aside past 1 MiB;
//   * starting the surface: a conversation turning working with a local viewer
//     ensure()s it once; framesActive() and the keep-alive it hands register().

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const {
  createControl, capNotice, NOTICE_MAX, AUDIT_MAX_BYTES, FRAME_ACTIVE_MS,
} = require('../lib/server/control');

const MAIN = 54321;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

// ── fixtures ────────────────────────────────────────────────────────────────

const PUB = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-control-pub-'));
  fs.writeFileSync(path.join(dir, 'index.html'), [
    '<!doctype html>',
    '<html data-mode="{{MODE}}" data-kind="{{KIND}}">',
    '<head>',
    '<meta name="wc-answer-nonce" content="{{NONCE}}">',
    '<!--meta-->{{META}}<!--/meta-->',
    '<script type="module" src="/answer/answer.js"></script>',
    '</head><body></body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'answer.js'), 'export {};\n');
  return dir;
})();

function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

function fakeAsks() {
  return {
    decide: () => ({ ok: true }),
    pending: () => [],
    waitView: async () => null,
    noteRefusal: () => {},
  };
}

// A fake mirror facade: the snapshot's conversations, the transitions.
function fakeMirror(conversations = []) {
  const subs = new Set();
  const m = {
    conversations,
    pids: new Map(),
    sessions: new Map(),
    snapshot: () => ({ conversations: m.conversations }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ev) { for (const fn of [...subs]) fn({ kind: 'mirror', ...ev }); },
    conversationOfPid: (pid) => m.pids.get(pid) || null,
    subscribers: () => subs.size,
  };
  return m;
}

function conv(id, { state = 'working', sid = S1, pid = 4242, interrupt = 'tty', name = 'fix the tests' } = {}) {
  return {
    id, name, current_session_id: sid,
    process: pid ? { pid, interrupt } : null,
    live: { state },
  };
}

function readAudit(root) {
  try {
    return fs.readFileSync(projectPaths(root).controlAudit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// One raw request, so the test controls Host, Origin and Sec-Fetch-*.
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const nonceOf = (r) => /name="wc-answer-nonce" content="([^"]*)"/.exec(r.text)[1];
function controlMeta(r) {
  const m = /<meta name="wc-control" content="([^"]*)">/.exec(r.text);
  if (!m) return null;
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(raw);
}

// The control domain over the real answer surface.
async function boot(t, { conversations, idleMs = 60_000, clock = null, viewers = { local: 1 } } = {}) {
  withTempHome(t);
  const root = tmpRoot('wc-control-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bus = createBus();
  const mirror = fakeMirror(conversations || [conv('c1'), conv('c2', { sid: S2, pid: 4343 })]);
  const surface = createAnswerSurface({ asks: fakeAsks(), mainPort: () => MAIN, root, publicDir: PUB, idleMs });
  const control = createControl({
    root, bus, mirror, answerSurface: surface, getViewers: () => viewers,
    ...(clock ? { now: clock.now } : {}),
  });
  t.after(async () => { await control.stop(); await surface.close(); });
  await control.start();
  const { origin, port } = await surface.ensure();
  return { root, bus, mirror, surface, control, origin, port };
}

// A row for the table tests, recording what ran.
function testRow(log, overrides = {}) {
  return {
    fields: ['thing_id'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: 5000 },
    params: (q) => {
      if (typeof q.thing_id !== 'string' || !/^[a-z0-9]{1,16}$/.test(q.thing_id)) throw new TypeError('bad thing');
      return { thing_id: q.thing_id };
    },
    key: (target) => target.thing_id,
    describe: async (target) => ({ title: `thing ${target.thing_id}`, summary: 'Do the thing', lines: ['a', 'b'] }),
    check: async () => { log.push('check'); return null; },
    run: async () => { log.push('run'); return { ok: true, via: 'test' }; },
    ...overrides,
  };
}

// ── the action table ────────────────────────────────────────────────────────

test('the action table: a row missing run or listing an unknown layout is refused with a TypeError', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const control = createControl({ root });
  t.after(() => control.stop());
  const log = [];
  const { run: _run, ...noRun } = testRow(log);
  assert.throws(() => control.action('thing', noRun), TypeError);
  assert.throws(() => control.action('thing', testRow(log, { layouts: ['popup'] })), TypeError);
  assert.throws(() => control.action('thing', testRow(log, { layouts: [] })), TypeError);
  assert.throws(() => control.action('thing', testRow(log, { limit: { scope: 'world', ms: 1 } })), TypeError);
  assert.throws(() => control.action('thing', testRow(log, { fields: [] })), TypeError);
  assert.throws(() => control.action('state', testRow(log)), TypeError, "'state' is the state read's path");
  assert.throws(() => control.action('Bad Name', testRow(log)), TypeError);
});

test('the action table: a second row under one name replaces the first; unregister removes it', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const control = createControl({ root });
  t.after(() => control.stop());
  const first = [];
  const second = [];
  const off1 = control.action('thing', testRow(first));
  const off2 = control.action('thing', testRow(second));
  const a = await control.invoke('thing', { thing_id: 'x1' }, {});
  assert.equal(a.ok, true);
  assert.deepEqual(first, [], 'the first row is replaced');
  assert.deepEqual(second, ['check', 'run']);
  off1(); // a stale unregister leaves the newer row alone
  assert.equal((await control.invoke('thing', { thing_id: 'x2' }, {})).refused, 'rate_limited', 'the row is still there (its window holds)');
  off2();
  const gone = await control.invoke('thing', { thing_id: 'x3' }, {});
  assert.deepEqual([gone.ok, gone.refused], [false, 'unknown-action']);
});

test('invoke(): limiter → check → run → audit, in that order; a check refusal never reaches run and starts no window', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const clock = fakeClock();
  const log = [];
  const fsImpl = { ...fs, appendFileSync: (...a) => { log.push('audit'); return fs.appendFileSync(...a); } };
  const control = createControl({ root, now: clock.now, fsImpl });
  t.after(() => control.stop());
  let refuse = true;
  control.action('thing', testRow(log, {
    check: async () => { log.push('check'); return refuse ? { refused: 'busy', hint: 'Claude is working' } : null; },
  }));

  const r1 = await control.invoke('thing', { thing_id: 'a' }, { device: 'desktop' });
  assert.deepEqual(r1, { ok: false, refused: 'busy', hint: 'Claude is working' });
  assert.deepEqual(log, ['check', 'audit'], 'a refused check never reaches run');

  refuse = false;
  log.length = 0;
  const r2 = await control.invoke('thing', { thing_id: 'a' }, {});
  assert.equal(r2.ok, true, 'the refusal started no window');
  assert.deepEqual(log, ['check', 'run', 'audit']);

  log.length = 0;
  clock.tick(1000);
  const r3 = await control.invoke('thing', { thing_id: 'b' }, {});
  assert.equal(r3.refused, 'rate_limited', "a 'project' row is one bucket for every target");
  assert.deepEqual(log, ['audit'], 'the limiter refuses before check');

  clock.tick(4001);
  assert.equal((await control.invoke('thing', { thing_id: 'b' }, {})).ok, true, 'the window ends after limit.ms');

  const lines = readAudit(root);
  assert.deepEqual(lines.map((l) => l.outcome), ['refused:busy', 'accepted', 'refused:rate_limited', 'accepted']);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'at', 'device', 'origin', 'outcome', 'target', 'via']);
  assert.deepEqual([lines[0].device, lines[1].via, lines[1].origin], ['desktop', 'test', 'local']);
});

test('invoke(): each action is its own bucket, and a failed run hands its window back', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const clock = fakeClock();
  const control = createControl({ root, now: clock.now });
  t.after(() => control.stop());
  const log = [];
  control.action('restore', testRow(log));
  let fail = true;
  control.action('undo', testRow(log, { run: async () => (fail ? { ok: false, refused: 'stale', hint: 'files changed' } : { ok: true }) }));
  assert.equal((await control.invoke('restore', { thing_id: 'a' }, {})).ok, true);
  const u = await control.invoke('undo', { thing_id: 'a' }, {});
  assert.deepEqual([u.ok, u.refused], [false, 'stale'], "the toast's Undo is not refused by its own Restore's window");
  fail = false;
  assert.equal((await control.invoke('undo', { thing_id: 'a' }, {})).ok, true, 'a refused run started no window');
  // A run that throws answers 'failed', audited.
  control.action('fork', testRow(log, { run: async () => { throw new Error('boom'); } }));
  assert.deepEqual(await control.invoke('fork', { thing_id: 'a' }, {}), { ok: false, refused: 'failed', hint: 'the action failed' });
  assert.equal(readAudit(root).at(-1).outcome, 'refused:failed');
});

test('provide/use: a service reached through ctx.control alone; features() reads the rows', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const control = createControl({ root });
  t.after(() => control.stop());
  const api = { preview: () => 1 };
  const off = control.provide('revert', api);
  assert.equal(control.use('revert'), api);
  assert.equal(control.use('nothing'), null);
  off();
  assert.equal(control.use('revert'), null);

  assert.deepEqual(control.features(), {
    interrupt: { ok: false, reason: 'no-answer-surface' },
    code_revert: { ok: false, reason: 'not-installed' },
    fork: { ok: false, reason: 'not-installed' },
  });
  control.action('restore', testRow([], { features: () => ({ ok: false, reason: 'git-too-old' }) }));
  control.action('fork', testRow([]));
  const f = control.features();
  assert.deepEqual(f.code_revert, { ok: false, reason: 'git-too-old' });
  assert.deepEqual(f.fork, { ok: true });
  await control.stop();
  assert.deepEqual(control.features().fork, { ok: false, reason: 'stopped' });
});

// ── on the answer surface ───────────────────────────────────────────────────

test('the control document: a nonce and the wc-control meta; a layout the row does not list, or an unknown action, is 404', async (t) => {
  const { port, control } = await boot(t);
  const d = await req(port, { path: '/answer/control/interrupt?conversation_id=c1&layout=stop&size=bar&mode=dark' });
  assert.equal(d.status, 200);
  assert.match(d.text, /data-mode="dark" data-kind="control"/);
  assert.match(nonceOf(d), /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(controlMeta(d), { title: 'fix the tests', summary: 'Stop Claude in this conversation' });
  assert.doesNotMatch(d.text, /<script>/, 'no inline script');
  assert.equal(control.framesActive(), true);

  assert.equal((await req(port, { path: '/answer/control/interrupt?conversation_id=c1&layout=confirm' })).status, 404);
  assert.equal((await req(port, { path: '/answer/control/interrupt?conversation_id=c1' })).status, 404, 'no layout');
  assert.equal((await req(port, { path: '/answer/control/nothing?conversation_id=c1&layout=stop' })).status, 404);
  assert.equal((await req(port, { path: '/answer/control/interrupt?conversation_id=..%2Fx&layout=stop' })).status, 400, 'a bad target');

  // A row's own lines reach the meta; nothing the chrome sent does.
  control.action('thing', testRow([]));
  const c = await req(port, { path: '/answer/control/thing?thing_id=t1&layout=confirm&title=EVIL' });
  assert.deepEqual(controlMeta(c), { title: 'thing t1', summary: 'Do the thing', lines: ['a', 'b'] });
});

test('the decide gate for POST /answer/api/control/interrupt: every wrong shape is refused, the right one accepted, each audited', async (t) => {
  const { port, origin, root, bus } = await boot(t);
  const events = [];
  bus.subscribe((e) => events.push(e));
  const doc = async (q) => nonceOf(await req(port, { path: `/answer/control/${q}` }));
  const n1 = await doc('interrupt?conversation_id=c1&layout=stop');
  const n2 = await doc('interrupt?conversation_id=c2&layout=stop');
  const post = (opts = {}) => {
    const { headers = {}, body = { conversation_id: 'c1', mode: 'now' } } = opts;
    const nonce = 'nonce' in opts ? opts.nonce : n1;
    return req(port, {
      method: 'POST',
      path: '/answer/api/control/interrupt?device=desktop',
      headers: {
        origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        ...(nonce != null ? { 'x-wc-answer': nonce } : {}),
        ...headers,
      },
      body,
    });
  };
  const before = () => readAudit(root).length;

  const cases = [
    ['the chrome\'s origin', { headers: { origin: `http://127.0.0.1:${MAIN}` } }, 403, 'origin'],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'site'],
    ['not JSON', { headers: { 'content-type': 'text/plain' } }, 403, 'type'],
    ['another conversation\'s nonce', { nonce: n2 }, 403, 'nonce'],
    ['no nonce', { nonce: undefined }, 403, 'nonce'],
    ['an extra body key', { body: { conversation_id: 'c1', mode: 'now', force: true } }, 400, 'bad-target'],
    ['a missing body key', { body: { conversation_id: 'c1' } }, 400, 'bad-target'],
    // A body whose target cannot be read names no target a nonce could be
    // bound to: the gate's nonce refusal.
    ['a bad mode', { body: { conversation_id: 'c1', mode: 'kill' } }, 403, 'nonce'],
    ['X-WC-Remote (no remote answering until U74)', { headers: { 'x-wc-remote': '1' } }, 403, null],
  ];
  for (const [label, opts, status, code] of cases) {
    const n = before();
    const r = await post(opts);
    assert.equal(r.status, status, `${label}: ${r.status} ${r.text}`);
    if (code) assert.equal(r.json.refused, code, label);
    assert.equal(readAudit(root).length, n + 1, `${label}: one audit line`);
    const line = readAudit(root).at(-1);
    assert.match(line.outcome, /^refused:/, label);
  }
  // No Origin at all.
  {
    const n = before();
    const r = await req(port, {
      method: 'POST', path: '/answer/api/control/interrupt',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': n1 },
      body: { conversation_id: 'c1', mode: 'now' },
    });
    assert.deepEqual([r.status, r.json.refused], [403, 'origin']);
    assert.equal(readAudit(root).length, n + 1);
  }
  // A wrong Host: the engine's 421, before any handler (lib/server/isolated-origin.js
  // answers it and exposes no hook, so it is not audited — U55's open issue 1).
  {
    const n = before();
    const r = await post({ headers: { host: `localhost:${port}` } });
    assert.equal(r.status, 421);
    assert.equal(readAudit(root).length, n);
  }
  // OPTIONS: 403 with no CORS header.
  {
    const r = await req(port, { method: 'OPTIONS', path: '/answer/api/control/interrupt', headers: { origin } });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(events.filter((e) => e.kind === 'control').length, 0, 'no refusal reached the action');

  // With all of it right: accepted.
  const n = before();
  const ok = await post();
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.ok, ok.json.accepted, ok.json.via], [true, true, 'tty']);
  assert.match(ok.json.request_id, /^ci_[0-9a-z]+[0-9a-f]{4}$/);
  assert.equal(readAudit(root).length, n + 1);
  const line = readAudit(root).at(-1);
  assert.deepEqual(
    { ...line, at: 0 },
    { at: 0, action: 'interrupt', target: { conversation_id: 'c1', mode: 'now' }, outcome: 'accepted', via: 'tty', origin: 'local', device: 'desktop' },
  );
  assert.equal(events.filter((e) => e.kind === 'control').length, 1);

  // A second within 1.5 s: 429, audited, no second event.
  const again = await post();
  assert.deepEqual([again.status, again.json.refused], [429, 'rate_limited']);
  assert.equal(readAudit(root).at(-1).outcome, 'refused:rate_limited');
  assert.equal(events.filter((e) => e.kind === 'control').length, 1);
});

test('the decide gate: a nonce minted for another action on the same target is refused', async (t) => {
  const { port, origin, root, control } = await boot(t);
  // A row whose key is a conversation id too, served in the confirm layout.
  control.action('probe', testRow([], {
    fields: ['conversation_id'],
    params: (q) => { if (typeof q.conversation_id !== 'string') throw new TypeError('x'); return { conversation_id: q.conversation_id }; },
    key: (target) => target.conversation_id,
  }));
  const probeNonce = nonceOf(await req(port, { path: '/answer/control/probe?conversation_id=c1&layout=confirm' }));
  const n = readAudit(root).length;
  const r = await req(port, {
    method: 'POST', path: '/answer/api/control/interrupt',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': probeNonce },
    body: { conversation_id: 'c1', mode: 'now' },
  });
  assert.deepEqual([r.status, r.json.refused], [403, 'nonce']);
  assert.deepEqual(readAudit(root).slice(n).map((l) => [l.action, l.outcome]), [['interrupt', 'refused:nonce']]);
  // …and the probe's own nonce does reach the probe.
  const ok = await req(port, {
    method: 'POST', path: '/answer/api/control/probe',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': probeNonce },
    body: { conversation_id: 'c1' },
  });
  assert.equal(ok.status, 200, ok.text);
});

// ── notices ─────────────────────────────────────────────────────────────────

function noticesRig(t, { mirror = fakeMirror([]) } = {}) {
  withTempHome(t);
  const root = tmpRoot();
  const clock = fakeClock();
  const control = createControl({ root, mirror, now: clock.now });
  t.after(() => control.stop());
  const changes = [];
  control.notices.onChange((c) => changes.push(c));
  return { control, notices: control.notices, mirror, clock, changes };
}

test('notices: put then claim by session returns [{id, text}] once; a second claim nothing', (t) => {
  const { notices, changes } = noticesRig(t);
  const id = notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'Files restored from the web-chat page', source: 'restore' });
  assert.match(id, /^cn_/);
  const got = notices.claim({ session_id: S1, max_chars: 9000 });
  assert.deepEqual(got, [{ id, text: 'Files restored from the web-chat page' }]);
  assert.deepEqual(notices.claim({ session_id: S1, max_chars: 9000 }), []);
  assert.deepEqual(changes.map((c) => c.op), ['put', 'claim'], 'onChange fires on put and claim');
  assert.equal(changes[0].notice.id, id);
});

test('notices: a 2,000-character text is cut to at most 1,500 at a whole line ending "…and N more"', (t) => {
  const { notices } = noticesRig(t);
  const lines = Array.from({ length: 130 }, (_, i) => `src/module-${String(i).padStart(3, '0')}.js`);
  const text = lines.join('\n');
  assert.ok(text.length >= 2000);
  notices.put({ conversation_id: 'c1', session_ids: [S1], text });
  const [n] = notices.claim({ session_id: S1, max_chars: 10_000 });
  assert.ok(n.text.length <= NOTICE_MAX, `${n.text.length} ≤ ${NOTICE_MAX}`);
  const out = n.text.split('\n');
  const tail = out.pop();
  const m = /^…and (\d+) more$/.exec(tail);
  assert.ok(m, tail);
  assert.deepEqual(out, lines.slice(0, out.length), 'whole lines, in order');
  assert.equal(Number(m[1]), lines.length - out.length, 'N counts the lines cut');
  // A text that fits is untouched; one long line is cut inside it.
  assert.equal(capNotice('short'), 'short');
  assert.ok(capNotice('x'.repeat(3000)).length <= NOTICE_MAX);
});

test('notices: max_chars below a notice keeps it for the next claim; with room for one of two, the older whole one comes', (t) => {
  const { notices, clock } = noticesRig(t);
  const older = notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'a'.repeat(400) });
  clock.tick(10);
  const newer = notices.put({ conversation_id: null, session_ids: [], text: 'b'.repeat(400) });
  assert.deepEqual(notices.claim({ session_id: S1, max_chars: 300 }), [], 'too small for either');
  const first = notices.claim({ session_id: S1, max_chars: 500 });
  assert.deepEqual(first.map((n) => n.id), [older], 'the older whole notice');
  const second = notices.claim({ session_id: S1, max_chars: 500 });
  assert.deepEqual(second.map((n) => n.id), [newer], 'the rest at the next claim');
});

test('notices: a second put for one conversation replaces the first (an undo replaces a pending restore)', (t) => {
  const { notices, changes } = noticesRig(t);
  notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'restored to before turn 3', source: 'restore' });
  const undo = notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'the restore was undone', source: 'undo' });
  assert.equal(notices.pending().length, 1);
  assert.deepEqual(notices.claim({ session_id: S1, max_chars: 9000 }), [{ id: undo, text: 'the restore was undone' }]);
  assert.deepEqual(changes.map((c) => c.op), ['put', 'replace', 'claim'], 'onChange fires on put, replace and claim');
});

test('notices: a claim by claude_pid resolves through conversationOfPid; conversationOf wins when the facade has it', (t) => {
  const mirror = fakeMirror([]);
  mirror.pids.set(777, 'c9');
  const { notices } = noticesRig(t, { mirror });
  notices.put({ conversation_id: 'c9', session_ids: [], text: 'for c9' });
  notices.put({ conversation_id: 'c8', session_ids: [], text: 'for c8' });
  assert.deepEqual(notices.claim({ claude_pid: 778, max_chars: 9000 }), [], 'another pid');
  assert.deepEqual(notices.claim({ claude_pid: 777, max_chars: 9000 }).map((n) => n.text), ['for c9']);
  mirror.conversationOf = (sid) => (sid === S2 ? 'c8' : null);
  assert.deepEqual(notices.claim({ session_id: S2, claude_pid: 777, max_chars: 9000 }).map((n) => n.text), ['for c8']);
});

test('notices: a null-conversation notice goes to the next claimer in the project', (t) => {
  const { notices } = noticesRig(t);
  notices.put({ conversation_id: null, session_ids: [], text: 'unresolved' });
  notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'for c1' });
  assert.deepEqual(notices.claim({ session_id: S2, max_chars: 9000 }).map((n) => n.text), ['unresolved'], 'another session takes only the unresolved one');
  assert.deepEqual(notices.claim({ session_id: S1, max_chars: 9000 }).map((n) => n.text), ['for c1']);
});

// ── the audit ───────────────────────────────────────────────────────────────

test('the audit: one JSONL line with at, action, target, outcome, via, origin and device — ids only', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const control = createControl({ root, now: () => 1234 });
  t.after(() => control.stop());
  control.audit({
    action: 'restore',
    target: { turn: 't1', prompt: 'x'.repeat(500), body: { content: 'secret file content' }, list: ['a'], n: 3 },
    outcome: 'accepted', via: 'web', origin: 'remote', device: 'mobile',
  });
  const [line] = readAudit(root);
  assert.deepEqual(Object.keys(line).sort(), ['action', 'at', 'device', 'origin', 'outcome', 'target', 'via']);
  assert.equal(line.at, 1234);
  assert.deepEqual(line.target, { turn: 't1', prompt: 'x'.repeat(200), n: 3 }, 'primitives only, strings capped');
  assert.doesNotMatch(JSON.stringify(line), /secret file content/);
  assert.deepEqual([line.origin, line.device], ['remote', 'mobile']);
});

test('the audit: past 1 MiB the file moves to audit.log.1, one generation', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const p = projectPaths(root);
  const control = createControl({ root });
  t.after(() => control.stop());
  fs.mkdirSync(p.controlDir, { recursive: true });
  fs.writeFileSync(`${p.controlAudit}.1`, 'old generation\n');
  fs.writeFileSync(p.controlAudit, `${'x'.repeat(AUDIT_MAX_BYTES)}\n`);
  control.audit({ action: 'interrupt', target: { conversation_id: 'c1' }, outcome: 'accepted', via: 'tty' });
  assert.equal(readAudit(root).length, 1, 'a fresh file with the new line');
  assert.ok(fs.statSync(`${p.controlAudit}.1`).size > AUDIT_MAX_BYTES, 'the full file moved aside, replacing the older generation');
  assert.deepEqual(fs.readdirSync(p.controlDir).sort(), ['audit.log', 'audit.log.1']);
});

// ── starting the surface, keeping it up ─────────────────────────────────────

function spySurface() {
  const s = { ensures: 0, registered: null };
  s.register = (kind, spec) => { s.registered = { kind, spec }; return () => { s.registered = null; }; };
  s.ensure = async () => { s.ensures += 1; return { port: 1, origin: 'http://127.0.0.1:1' }; };
  return s;
}

test('starting the surface: a conversation turning working with a local viewer ensure()s it once; no viewer, or no active state, never', async (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const surface = spySurface();
  const mirror = fakeMirror([conv('c1')]);
  let viewers = { local: 1 };
  const control = createControl({ root, mirror, answerSurface: () => surface, getViewers: () => viewers });
  t.after(() => control.stop());
  assert.equal(surface.ensures, 0, 'never at construction');
  await control.start();
  assert.equal(surface.ensures, 0, 'never at boot');
  assert.equal(surface.registered.kind, 'control');

  mirror.emit({ op: 'state', conversation_id: 'c1', state: 'working', prev: 'idle' });
  assert.equal(surface.ensures, 1);
  mirror.emit({ op: 'state', conversation_id: 'c1', state: 'waiting', prev: 'working' });
  assert.equal(surface.ensures, 1, 'active → active is not entering');
  mirror.emit({ op: 'state', conversation_id: 'c1', state: 'idle', prev: 'waiting' });
  assert.equal(surface.ensures, 1, 'idle never');
  viewers = { local: 0, remote: 2 };
  mirror.emit({ op: 'state', conversation_id: 'c1', state: 'working', prev: 'idle' });
  assert.equal(surface.ensures, 1, 'no local viewer, no warm-up');
  viewers = 1;
  mirror.emit({ op: 'state', conversation_id: 'c1', state: 'compacting', prev: 'idle' });
  assert.equal(surface.ensures, 2, 'a viewer count is read as local');
});

test('framesActive(): true for 60 s after a control document or a state read; registerSurface hands it to register() as keepAlive', async (t) => {
  const clock = fakeClock();
  const { port, control, surface } = await boot(t, { clock });
  assert.equal(control.framesActive(), false);
  const d = await req(port, { path: '/answer/control/interrupt?conversation_id=c1&layout=stop' });
  assert.equal(d.status, 200);
  assert.equal(control.framesActive(), true);
  clock.tick(FRAME_ACTIVE_MS - 1);
  assert.equal(control.framesActive(), true);
  clock.tick(2);
  assert.equal(control.framesActive(), false);
  // A state read re-arms it.
  const r = await req(port, {
    path: '/answer/api/control/state?action=interrupt&conversation_id=c1',
    headers: { 'x-wc-answer': nonceOf(d) },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(control.framesActive(), true);
  // register() was handed the keep-alive: the surface asks it at its idle timer.
  assert.equal(surface.port, port);
});

test('the keep-alive: the listener (a short idleMs) stays up while a control document was served in the last 60 s', async (t) => {
  const clock = fakeClock();
  const { port, control, surface } = await boot(t, { clock, idleMs: 150 });
  const d = await req(port, { path: '/answer/control/interrupt?conversation_id=c1&layout=stop' });
  assert.equal(d.status, 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(surface.port, port, 'kept up past several idle timers');
  clock.tick(FRAME_ACTIVE_MS + 1);
  assert.equal(control.framesActive(), false);
  await waitUntil(() => surface.port == null, { timeout: 3000, what: 'the idle close' });
});

test('stop() unregisters the kind and the mirror subscription', async (t) => {
  const { port, control, mirror } = await boot(t);
  assert.equal(mirror.subscribers(), 1);
  await control.stop();
  assert.equal(mirror.subscribers(), 0);
  assert.equal((await req(port, { path: '/answer/control/interrupt?conversation_id=c1&layout=stop' })).status, 404, 'the kind is gone');
  const a = await control.invoke('interrupt', { conversation_id: 'c1', mode: 'now' }, {});
  assert.equal(a.refused, 'stopped');
});
