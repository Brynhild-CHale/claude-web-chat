// The session controls' rows on the control domain (lib/server/control/
// session-ops.js installSessionOps, U93; spec §15.7 'Session controls', §15.5,
// §15.6; rulings Q10, Q-E, Q-C, D-defaults (a)), driven through a REAL
// createControl over the REAL answer surface (as test/control-domain.test.js
// builds it), with a fake bridge standing in for ctx.bridge (U87) and a fake
// mirror facade — nothing here runs `claude`:
//   * each of the five rows registers through control.action, its name passes
//     ACTION_RE and none is 'state'; uninstall removes them; features() follows
//     the bridge;
//   * a confirm POST through the answer origin's handler with its document's
//     nonce enqueues exactly ONE command op (compact; plan; rename with the
//     cleaned name; clear; resume with the target's session id) and answers
//     {ok, via: 'mod', said};
//   * each refusal by name — not-live, no-mod, bad-name (empty, 101
//     characters, two lines, control characters), plan-on, bad-target,
//     experimental without WEB_CHAT_REWIND_IN_PLACE — enqueues nothing;
//   * a second call within 2 s → rate_limited; every action and refusal writes
//     one audit line, and none holds the name typed;
//   * a body whose keys are not exactly the row's fields → 400 (an extra
//     key) or the gate's 403 'nonce' (a missing one: no target to bind);
//   * the enqueue's own refusals map onto mod-refused, timeout and no-result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { withTempHome, tmpRoot } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createControl } = require('../lib/server/control');
const { installSessionOps, ACTIONS, SAID, LIMIT_MS, RESULT_MS } = require('../lib/server/control/session-ops');
const { FLAG } = require('../lib/server/control/mod');

const MAIN = 54321;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const ACTION_RE = /^[a-z][a-z-]{1,31}$/;
const SECRET_NAME = 'zebra quartz renamed';

const PUB = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-session-ops-pub-'));
  fs.writeFileSync(path.join(dir, 'index.html'), [
    '<!doctype html>',
    '<html data-mode="{{MODE}}" data-kind="{{KIND}}">',
    '<head>',
    '<meta name="wc-answer-nonce" content="{{NONCE}}">',
    '<!--meta-->{{META}}<!--/meta-->',
    '</head><body></body></html>',
  ].join('\n'));
  return dir;
})();
test.after(() => fs.rmSync(PUB, { recursive: true, force: true }));

function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

const fakeAsks = () => ({ decide: () => ({ ok: true }), pending: () => [], waitView: async () => null, noteRefusal: () => {} });

// ctx.bridge's reads and enqueue (U87's signatures). Every op is recorded.
function fakeBridge({ attached = [S1], byConv = { c1: S1 } } = {}) {
  const b = { ops: [], set: new Set(attached), byConv: { ...byConv }, answer: null };
  b.attached = (sid) => b.set.has(sid);
  b.sessionOf = (cid) => { const s = b.byConv[cid]; return s && b.set.has(s) ? s : null; };
  b.any = () => b.set.size > 0;
  b.enqueue = async (sid, { op, args } = {}, opts = {}) => {
    b.ops.push({ sid, op, args, opts });
    return b.answer || { ok: true, result: { ran: true } };
  };
  return b;
}

function conv(id, { state = 'idle', sid = S1, mode = 'default', title = `title ${id}` } = {}) {
  return { id, title, current_session_id: sid, permission_mode: mode, process: { pid: 4242 }, live: { state },
    sessions: [{ session_id: sid }] };
}

function fakeMirror(conversations) {
  const m = {
    conversations,
    snapshot: () => ({ conversations: m.conversations }),
    subscribe: () => () => {},
    conversationOf(id) {
      const c = m.conversations.find((x) => x.id === id || x.current_session_id === id);
      return c ? c.id : null;
    },
    set(id, patch) { m.conversations = m.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)); },
  };
  return m;
}

function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
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

const nonceOf = (r) => /name="wc-answer-nonce" content="([^"]*)"/.exec(r.text)[1];
function metaOf(r) {
  const m = /<meta name="wc-control" content="([^"]*)">/.exec(r.text);
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(raw);
}

function readAudit(root) {
  try {
    return fs.readFileSync(projectPaths(root).controlAudit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

const ENDED = () => conv('c2', { state: 'ended', sid: S2, title: 'last week\'s work' });

async function boot(t, { conversations = [conv('c1'), ENDED()], bridge = fakeBridge(), env = { [FLAG]: '1' }, clock = fakeClock() } = {}) {
  withTempHome(t);
  const root = tmpRoot('wc-session-ops-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mirror = fakeMirror(conversations);
  const surface = createAnswerSurface({ asks: fakeAsks(), mainPort: () => MAIN, root, publicDir: PUB, idleMs: 60_000 });
  const control = createControl({ root, bus: createBus(), mirror, answerSurface: surface, now: clock.now });
  t.after(async () => { await control.stop(); await surface.close(); });
  await control.start();
  const uninstall = installSessionOps(control, { bridge, mirror, env });
  t.after(() => uninstall());
  const { origin, port } = await surface.ensure();
  // The frame's own round trip: its document (the nonce), then its POST.
  const doc = (action, query) => req(port, { path: `/answer/control/${action}?${new URLSearchParams({ ...query, layout: 'confirm', mode: 'light' })}` });
  const post = async (action, body, { nonceQuery = body, nonce } = {}) => {
    const n = nonce || nonceOf(await doc(action, nonceQuery));
    return req(port, {
      method: 'POST', path: `/answer/api/control/${action}?device=desktop`,
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': n },
      body,
    });
  };
  return { root, mirror, bridge, control, uninstall, clock, port, origin, doc, post, audit: () => readAudit(root) };
}

// ── the table ───────────────────────────────────────────────────────────────

test('the five rows register through control.action: names pass ACTION_RE, none is state; uninstall removes them', async (t) => {
  const r = await boot(t);
  assert.deepEqual([...ACTIONS], ['session-compact', 'session-plan', 'session-rename', 'session-clear', 'session-resume']);
  for (const a of ACTIONS) {
    assert.match(a, ACTION_RE);
    assert.notEqual(a, 'state');
    const d = await r.doc(a, a === 'session-rename' ? { conversation_id: 'c1', name: 'x' } : a === 'session-resume' ? { conversation_id: 'c1', target: S2 } : { conversation_id: 'c1' });
    assert.equal(d.status, 200, `${a}: its document`);
  }
  assert.equal((await r.doc('session-compact', { conversation_id: 'c1' }).then((d) => d.status)), 200);
  r.uninstall();
  r.uninstall();   // idempotent
  for (const a of ACTIONS) {
    assert.equal((await r.doc(a, { conversation_id: 'c1' })).status, 404, `${a}: gone`);
  }
});

test('features() follows the bridge', async (t) => {
  const bridge = fakeBridge({ attached: [] });
  const r = await boot(t, { bridge });
  assert.deepEqual(r.uninstall.features(), { ok: false, reason: 'no-mod' });
  bridge.set.add(S1);
  assert.deepEqual(r.uninstall.features(), { ok: true });
});

test('the documents describe each action in plain words, from server state and the target only', async (t) => {
  const r = await boot(t);
  const meta = async (a, q) => metaOf(await r.doc(a, q));
  assert.equal((await meta('session-compact', { conversation_id: 'c1' })).title, 'Compact this conversation now');
  assert.equal((await meta('session-plan', { conversation_id: 'c1' })).title,
    'Turn on plan mode — it also switches the model, as /plan does in the terminal');
  assert.equal((await meta('session-rename', { conversation_id: 'c1', name: '  Payments​ work ' })).title,
    'Rename this session to “Payments work”', 'the cleaned name, shown before the click');
  assert.equal((await meta('session-clear', { conversation_id: 'c1' })).title,
    'Clear this session: Claude starts a new one, and this one stays resumable');
  assert.equal((await meta('session-resume', { conversation_id: 'c1', target: S2 })).title,
    'Switch this terminal to “last week\'s work”');
});

// ── the happy paths, through the frame's POST ───────────────────────────────

test('a confirm POST with its document\'s nonce enqueues exactly ONE command op per action and answers {ok, via: mod, said}', async (t) => {
  const r = await boot(t);
  const cases = [
    ['session-compact', { conversation_id: 'c1' }, { name: 'compact' }, SAID.compact],
    ['session-plan', { conversation_id: 'c1' }, { name: 'plan' }, SAID.plan],
    ['session-rename', { conversation_id: 'c1', name: `  ${SECRET_NAME}‮ ` }, { name: 'rename', args: SECRET_NAME }, SAID.rename],
    ['session-clear', { conversation_id: 'c1' }, { name: 'clear' }, SAID.clear],
    ['session-resume', { conversation_id: 'c1', target: S2.toUpperCase() }, { name: 'resume', args: S2 }, SAID.resume],
  ];
  for (const [action, body, args, said] of cases) {
    const n = r.bridge.ops.length;
    const res = await r.post(action, body);
    assert.equal(res.status, 200, `${action}: ${res.text}`);
    assert.deepEqual(res.json, { ok: true, via: 'mod', said }, action);
    assert.ok(said.length <= 120);
    const ops = r.bridge.ops.slice(n);
    assert.equal(ops.length, 1, `${action}: one op`);
    assert.deepEqual(ops[0], { sid: S1, op: 'command', args, opts: { resultWithinMs: RESULT_MS } }, action);
  }
  const lines = r.audit();
  assert.deepEqual(lines.map((l) => [l.action, l.outcome, l.via, l.origin, l.device]),
    cases.map(([a]) => [a, 'accepted', 'mod', 'local', 'desktop']));
  assert.equal(lines[2].target.conversation_id, 'c1');
  assert.deepEqual(Object.keys(lines[2].target), ['conversation_id'], 'the rename\'s target holds no name');
  assert.ok(!JSON.stringify(lines).includes('zebra'), 'the audit never holds the name typed');
  assert.deepEqual(lines[4].target, { conversation_id: 'c1', target: S2 });
});

// ── refusals ────────────────────────────────────────────────────────────────

test('each refusal by name enqueues nothing and writes one audit line (never the name typed)', async (t) => {
  const bridge = fakeBridge({ attached: [S1], byConv: { c1: S1, c3: S3 } });
  const r = await boot(t, { bridge, conversations: [conv('c1'), ENDED(), conv('c3', { sid: S3 }), conv('c4', { sid: S3, mode: 'plan' }),
    conv('c5', { state: 'working', sid: '55555555-5555-4555-8555-555555555555' }), conv('c6', { state: 'idle', sid: '66666666-6666-4666-8666-666666666666' })] });
  r.bridge.byConv.c4 = S1;
  const cases = [
    ['unknown conversation', 'session-compact', { conversation_id: 'nope' }, 'not-live'],
    ['ended conversation', 'session-compact', { conversation_id: 'c2' }, 'not-live'],
    ['no mod attached', 'session-plan', { conversation_id: 'c3' }, 'no-mod'],
    ['empty name', 'session-rename', { conversation_id: 'c1', name: '   ' }, 'bad-name'],
    ['101 characters', 'session-rename', { conversation_id: 'c1', name: `${'zebra '.repeat(17)}`.slice(0, 101) }, 'bad-name'],
    ['two lines', 'session-rename', { conversation_id: 'c1', name: 'zebra one\nzebra two' }, 'bad-name'],
    ['control characters', 'session-rename', { conversation_id: 'c1', name: 'zebra\u001b[31m red' }, 'bad-name'],
    ['led by /', 'session-rename', { conversation_id: 'c1', name: '/zebra' }, 'bad-name'],
    ['plan mode already on', 'session-plan', { conversation_id: 'c4' }, 'plan-on'],
    ['a live conversation as target', 'session-resume', { conversation_id: 'c1', target: '66666666-6666-4666-8666-666666666666' }, 'bad-target'],
    ['an unknown session as target', 'session-resume', { conversation_id: 'c1', target: '77777777-7777-4777-8777-777777777777' }, 'bad-target'],
  ];
  for (const [what, action, target, code] of cases) {
    const n = r.audit().length;
    // Through the frame's own round trip, so the target is the row's params().
    const p = await r.post(action, target);
    assert.equal(p.status, code === 'bad-target' ? 400 : 409, what);
    const a = p.json;
    assert.equal(a.ok, false, what);
    assert.equal(a.refused, code, what);
    assert.equal(typeof a.hint, 'string', what);
    assert.equal(r.bridge.ops.length, 0, `${what}: nothing enqueued`);
    const lines = r.audit().slice(n);
    assert.equal(lines.length, 1, `${what}: one audit line`);
    assert.equal(lines[0].outcome, `refused:${code}`, what);
  }
  assert.ok(!JSON.stringify(r.audit()).includes('zebra'), 'no audit line holds the name typed');
  // The domain's own pipeline answers the same, and audits it the same way.
  const n = r.audit().length;
  assert.equal((await r.control.invoke('session-plan', { conversation_id: 'c4' }, {})).refused, 'plan-on');
  assert.equal(r.audit().length, n + 1);
  assert.equal(r.bridge.ops.length, 0);
});

test('session-resume is refused experimental without WEB_CHAT_REWIND_IN_PLACE=1 (read once, at install)', async (t) => {
  const r = await boot(t, { env: {} });
  const a = await r.control.invoke('session-resume', { conversation_id: 'c1', target: S2 }, {});
  assert.deepEqual([a.ok, a.refused], [false, 'experimental']);
  assert.match(a.hint, /WEB_CHAT_REWIND_IN_PLACE=1/);
  const p = await r.post('session-resume', { conversation_id: 'c1', target: S2 });
  assert.deepEqual([p.status, p.json.refused], [409, 'experimental']);
  assert.equal(r.bridge.ops.length, 0);
  // The other four do not wait on the flag.
  assert.equal((await r.post('session-compact', { conversation_id: 'c1' })).status, 200);
});

test('a second call within 2 s is rate_limited, per action per conversation; a refused run hands its window back', async (t) => {
  const r = await boot(t);
  assert.equal((await r.post('session-compact', { conversation_id: 'c1' })).status, 200);
  const again = await r.post('session-compact', { conversation_id: 'c1' });
  assert.deepEqual([again.status, again.json.refused], [429, 'rate_limited']);
  assert.equal(r.bridge.ops.length, 1);
  assert.equal((await r.post('session-clear', { conversation_id: 'c1' })).status, 200, 'another action has its own bucket');
  assert.equal(LIMIT_MS, 2000, '§15.5: a session control at most once per 2 s');
  r.clock.tick(1999);
  const late = await r.post('session-compact', { conversation_id: 'c1' });
  assert.deepEqual([late.status, late.json.refused], [429, 'rate_limited'], 'still inside the 2 s window at 1999 ms');
  r.clock.tick(1);
  assert.equal((await r.post('session-compact', { conversation_id: 'c1' })).status, 200, 'after 2 s');
  // A refusal does not spend the window.
  r.mirror.set('c1', { permission_mode: 'plan' });
  assert.equal((await r.control.invoke('session-plan', { conversation_id: 'c1' }, {})).refused, 'plan-on');
  r.mirror.set('c1', { permission_mode: 'default' });
  assert.equal((await r.control.invoke('session-plan', { conversation_id: 'c1' }, {})).ok, true);
  assert.deepEqual(r.audit().map((l) => l.outcome),
    ['accepted', 'refused:rate_limited', 'accepted', 'refused:rate_limited', 'accepted', 'refused:plan-on', 'accepted']);
});

test('a body whose keys are not exactly the row\'s fields is 400 (one name per target); an unparseable target too', async (t) => {
  const r = await boot(t);
  const nonce = nonceOf(await r.doc('session-rename', { conversation_id: 'c1', name: 'ok' }));
  // An extra key is 400. A missing one leaves no target a nonce could be bound
  // to, so the gate refuses it as 'nonce' (U81's hand-off, deviation 3).
  const cases = [
    [{ conversation_id: 'c1', name: 'ok', extra: 1 }, 400, 'bad-target'],   // a key too many
    [{ conversation_id: 'c1' }, 403, 'nonce'],                             // a field missing
    [{ conversation_id: 'c1', title: 'ok' }, 403, 'nonce'],                // another name for the field
  ];
  for (const [body, status, code] of cases) {
    const p = await r.post('session-rename', body, { nonce });
    assert.deepEqual([p.status, p.json.refused], [status, code], JSON.stringify(body));
  }
  assert.equal((await r.post('session-rename', { conversation_id: 'c1', name: 'ok' }, { nonce })).status, 200, 'the exact fields');
  const p2 = await r.post('session-compact', { conversation_id: 'c1', name: 'x' }, { nonceQuery: { conversation_id: 'c1' } });
  assert.equal(p2.status, 400);
  // A resume target that is no session id names no target at all.
  assert.equal((await r.doc('session-resume', { conversation_id: 'c1', target: 'not-a-uuid' })).status, 400);
  assert.equal(r.bridge.ops.length, 1, 'only the exact body ran');
});

test('the enqueue\'s refusals: timeout and no-result pass through, anything else is mod-refused, each with a hint', async (t) => {
  const r = await boot(t);
  const cases = [
    [{ ok: false, refused: 'timeout', delivered: false, hint: 'the mod did not take it' }, 'timeout'],
    [{ ok: false, refused: 'no-result', delivered: true }, 'no-result'],
    [{ ok: false, refused: 'failed', error: 'compaction is switched off (DISABLE_COMPACT)', delivered: true }, 'mod-refused'],
    [{ ok: false, refused: 'not-attached', delivered: false }, 'mod-refused'],
  ];
  for (const [answer, code] of cases) {
    r.bridge.answer = answer;
    const a = await r.control.invoke('session-compact', { conversation_id: 'c1' }, {});
    assert.deepEqual([a.ok, a.refused], [false, code]);
    assert.equal(typeof a.hint, 'string');
    assert.ok(a.hint.length > 0);
  }
  assert.equal(r.bridge.ops.length, 4, 'each asked once, the window handed back each time');
});
