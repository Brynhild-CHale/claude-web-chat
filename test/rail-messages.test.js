// Composer messages in the queue rail, and queue.js as the chrome's one send
// path (design spec §6.1, §6.3, §6.4, §6.6, §7.10; U62).
//
//   * A frame never carries a message's text: an add, update or remove frame
//     that touches a message schedules ONE GET /api/queue (a burst of frames
//     in one tick is still one), and the rail shows the text the GET served —
//     or, hidden from this viewer, 'message · N chars (hidden from remote
//     viewers of this project)'.
//   * queueSnapshot().messages is the one pending list: queued and held
//     messages, then each message that left the queue until its receipt is
//     confirmed (a confirmed one for one hydrate or CONFIRMED_HOLD_MS).
//   * sendMessage / editMessage / sendNow / recallPending post JSON once and
//     answer the parsed body, never throwing.
//   * The rail: a message row's −/+ and ⟲; the held_messages banner; Take back
//     in place of Cancel on a park that holds a message (ruling C1 a).
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const { bootShell, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

let shell, Q, S, $;

// What the daemon holds, as each route answers it.
const daemon = { items: [], receipts: null, pending: null, answers: {}, recalled: null };
const queueGets = () => shell.calls.filter((c) => c.url === '/api/queue' && c.method === 'GET').length;
const posts = (url) => shell.calls.filter((c) => c.url === url && c.method !== 'GET');

function route(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const path = url.split('?')[0];
  if (path === '/api/queue' && method === 'GET') {
    const body = { items: daemon.items, count: daemon.items.length };
    if (daemon.receipts) body.receipts = daemon.receipts;
    return body;
  }
  if (path === '/api/queue/pending' && method === 'GET') return { pending: daemon.pending };
  const a = daemon.answers[path];
  if (typeof a === 'function') return a(url, init);
  if (a !== undefined) return a;
  if (path === '/api/queue/pending/recall') {
    const r = daemon.recalled || { ok: true, recalled: false };
    if (typeof daemon.afterRecall === 'function') daemon.afterRecall();
    return r;
  }
  if (path === '/api/queue/pending/consume') { daemon.pending = null; return { ok: true, consumed: true }; }
  return { ok: true };
}

const MID = (n) => `m-${String(n).padStart(8, '0')}`;
function msg(n, over = {}) {
  return {
    id: `q${n}`, kind: 'message', msg_id: MID(n), conversation_id: null, text: `message number ${n}`,
    skill: null, files: [], chars: `message number ${n}`.length, autosend: true, staged: true, source: 'composer',
    why_wake: 'message from the user', summary: `message · ${`message number ${n}`.length} chars`,
    origin: 'local', device: 'desktop', enqueued_at: 1000 + n, ...over,
  };
}
// The text-free copy a frame and a basic viewer get (lib/server/domain/queue publicItem).
function pub(it) {
  const { text, files, skill, ...rest } = it;
  return { ...rest, skill: skill ? { name: skill.name } : null, files_count: (files || []).length };
}
const signal = (n, over = {}) => ({ id: `s${n}`, kind: 'signal', source: 'pane-x', signal_key: 'form_submit',
  summary: `form_submit #${n}`, why_wake: 'a declared signal', staged: true, enqueued_at: 1000 + n, ...over });

const rail = () => $('queue-rail');
const row = (id) => rail().querySelector(`.rail-item[data-id="${id}"]`);
const messages = () => Q.queueSnapshot().messages;
const byMsg = (id) => messages().find((m) => m.msg_id === id);

// The rail's hydrate keeps a local item newer than the snapshot's newest (one
// a frame brought during the GET), so a test starts from a cleared queue.
async function setQueue(items, receipts = null) {
  Q.foldQueueFrame({ type: 'queue', op: 'clear' });
  daemon.items = items;
  daemon.receipts = receipts;
  await Q.hydrateQueue();
}

before(async () => {
  shell = await bootShell({ routes: { '/api/queue*': route } });
  Q = await shell.importApp('queue.js');
  S = await shell.importApp('chat-state.js');
  $ = shell.$;
  await shell.tick();
});

after(() => shell.restore());

beforeEach(async () => {
  daemon.answers = {};
  daemon.pending = null;
  daemon.recalled = null;
  daemon.afterRecall = null;
  await setQueue([], []);
  await Q.refreshPending();
});

/* ── frames and the re-hydrate ───────────────────────────────────────────── */

test('a queue add frame for a message schedules one GET /api/queue — two in one tick are still one', async () => {
  const before0 = queueGets();
  daemon.items = [msg(1)];
  await shell.frame({ type: 'queue', op: 'add', item: pub(msg(1)), count: 1 });
  await waitUntil(() => queueGets() === before0 + 1, { timeout: 2000, what: 'the GET after the add frame' });
  assert.equal(row('q1').querySelector('.qi-msg-text').textContent, 'message number 1', 'the text came from the GET');

  const before1 = queueGets();
  daemon.items = [msg(1), msg(2), msg(3)];
  const s = shell.socket();
  s.receive({ type: 'queue', op: 'add', item: pub(msg(2)), count: 2 });
  s.receive({ type: 'queue', op: 'add', item: pub(msg(3)), count: 3 });
  await shell.tick(60);
  assert.equal(queueGets(), before1 + 1, 'one GET for the burst');

  // A signal's frame reads nothing again.
  const before2 = queueGets();
  await shell.frame({ type: 'queue', op: 'add', item: signal(9), count: 4 });
  await shell.tick(40);
  assert.equal(queueGets(), before2, 'a signal frame is folded as it always was');

  // An update frame for a message, and a remove frame naming one, read it again too.
  const before3 = queueGets();
  daemon.items = [{ ...msg(1), text: 'edited words', chars: 12 }, msg(2), msg(3), signal(9)];
  await shell.frame({ type: 'queue', op: 'update', id: 'q1', item: pub({ ...msg(1), chars: 12 }), staged: true });
  await waitUntil(() => queueGets() === before3 + 1, { timeout: 2000, what: 'the GET after the update frame' });
  await waitUntil(() => row('q1').querySelector('.qi-msg-text').textContent === 'edited words', { timeout: 2000, what: 'the edited text from the GET' });
  const before4 = queueGets();
  daemon.items = [msg(1), msg(3), signal(9)];
  await shell.frame({ type: 'queue', op: 'remove', ids: ['q2'], id: 'q2', reason: 'removed', count: 3 });
  await waitUntil(() => queueGets() === before4 + 1, { timeout: 2000, what: 'the GET after the remove frame' });
  assert.ok(!row('q2'), 'the removed message left the rail');
});

test('at read the rail row shows the text, the skill name and the file count', async () => {
  await setQueue([msg(1, { text: 'Tighten the retry logic', chars: 23, skill: { name: 'capture-profile', args: 'x' },
    files: [{ path: 'lib/a.js', bytes: 10 }, { path: 'lib/b.js', bytes: 20 }] })]);
  const r = row('q1');
  assert.ok(r.classList.contains('rail-msg'));
  assert.equal(r.querySelector('.qi-kind').textContent, 'message');
  assert.equal(r.querySelector('.qi-msg-text').textContent, 'Tighten the retry logic');
  assert.equal(r.querySelector('.qi-msg-meta').textContent, '/capture-profile · 2 files');
});

test('at basic it reads "message · 42 chars (hidden from remote viewers of this project)"', async () => {
  await setQueue([{ ...pub(msg(1, { chars: 42, skill: { name: 'review' }, files: [{ path: 'a', bytes: 1 }] })), text_hidden: true }]);
  const r = row('q1');
  assert.equal(r.querySelector('.qi-msg-hidden').textContent, 'message · 42 chars (hidden from remote viewers of this project)');
  assert.ok(!r.querySelector('.qi-msg-text'), 'no text drawn');
  assert.equal(r.querySelector('.qi-msg-meta').textContent, '/review · 1 file');
  const m = byMsg(MID(1));
  assert.equal(m.text, undefined, 'the pending list has no text for it either');
  assert.equal(m.chars, 42);
});

/* ── receipts ────────────────────────────────────────────────────────────── */

test('receipt frames fold: queued → sending → sent; parked → handed_over; unconfirmed; failed', async () => {
  await setQueue([msg(1), msg(2), msg(3), msg(4)], [1, 2, 3, 4].map((n) => ({ msg_id: MID(n), state: 'queued', at: 5 })));
  assert.deepEqual(messages().map((m) => m.state), ['queued', 'queued', 'queued', 'queued']);
  assert.equal(byMsg(MID(1)).text, 'message number 1');

  // A flush takes them out of the queue; their receipts move on.
  daemon.items = [];
  daemon.receipts = [{ msg_id: MID(1), state: 'sending', at: 6 }, { msg_id: MID(2), state: 'parked', at: 6 },
    { msg_id: MID(3), state: 'sending', at: 6 }, { msg_id: MID(4), state: 'parked', at: 6 }];
  const s = shell.socket();
  s.receive({ type: 'queue', op: 'remove', ids: ['q1', 'q2', 'q3', 'q4'], reason: 'flushed', count: 0 });
  for (const r of daemon.receipts) s.receive({ type: 'queue', op: 'receipt', ...r });
  await shell.tick(60);
  assert.deepEqual(messages().map((m) => [m.msg_id, m.state]),
    [[MID(1), 'sending'], [MID(2), 'parked'], [MID(3), 'sending'], [MID(4), 'parked']]);
  assert.equal(byMsg(MID(1)).text, 'message number 1', 'a message that left the queue keeps its last known text');
  assert.equal(byMsg(MID(1)).id, 'q1');
  assert.ok(!row('q1'), 'and is no longer a rail row');

  const step = async (id, state) => {
    daemon.receipts = daemon.receipts.map((r) => (r.msg_id === id ? { ...r, state } : r));
    await shell.frame({ type: 'queue', op: 'receipt', msg_id: id, state, at: 7 });
  };
  await step(MID(1), 'sent');
  await step(MID(2), 'handed_over');
  await step(MID(3), 'failed');
  await step(MID(4), 'handed_over');
  await step(MID(4), 'unconfirmed');
  assert.deepEqual(messages().map((m) => [m.msg_id, m.state]),
    [[MID(1), 'sent'], [MID(2), 'handed_over'], [MID(3), 'failed'], [MID(4), 'unconfirmed']]);
});

test('a confirmed message is held for a render, then gone at the next hydrate', async () => {
  await setQueue([], [{ msg_id: MID(1), state: 'queued', at: 1 }]);
  daemon.items = [msg(1)];
  await Q.hydrateQueue();
  daemon.items = [];
  daemon.receipts = [{ msg_id: MID(1), state: 'sending', at: 2 }];
  await shell.frame({ type: 'queue', op: 'remove', ids: ['q1'], id: 'q1', reason: 'flushed', count: 0 });
  await shell.frame({ type: 'queue', op: 'receipt', msg_id: MID(1), state: 'sending', at: 2 });
  await shell.tick(40);
  daemon.receipts = [{ msg_id: MID(1), state: 'confirmed', at: 3 }];
  await shell.frame({ type: 'queue', op: 'receipt', msg_id: MID(1), state: 'confirmed', at: 3 });
  assert.equal(byMsg(MID(1)).state, 'confirmed', 'it says so — "Received"');
  assert.equal(byMsg(MID(1)).text, 'message number 1');
  await Q.hydrateQueue();
  assert.equal(byMsg(MID(1)), undefined, 'the next hydrate drops it');
});

test('a confirmed message is gone CONFIRMED_HOLD_MS later with no hydrate (no timer: the next read prunes it)', async () => {
  await setQueue([msg(5)], [{ msg_id: MID(5), state: 'queued', at: 1 }]);
  daemon.items = [];
  daemon.receipts = [{ msg_id: MID(5), state: 'sent', at: 3 }];
  await shell.frame({ type: 'queue', op: 'remove', ids: ['q5'], id: 'q5', reason: 'flushed', count: 0 });
  daemon.receipts = [{ msg_id: MID(5), state: 'confirmed', at: 3 }];
  await shell.tick(40);   // the remove frame's hydrate has run
  const timers = shell.intervals().length;
  await shell.frame({ type: 'queue', op: 'receipt', msg_id: MID(5), state: 'confirmed', at: 3 });
  assert.equal(byMsg(MID(5)).state, 'confirmed');
  assert.equal(shell.intervals().length, timers, 'no interval for the hold');
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0 + Q.CONFIRMED_HOLD_MS + 1;
    assert.equal(byMsg(MID(5)), undefined, 'past the hold it is gone');
  } finally { Date.now = realNow; }
});

test('a message removed (not delivered) leaves the pending list', async () => {
  await setQueue([msg(6)], [{ msg_id: MID(6), state: 'queued', at: 1 }]);
  daemon.items = [];
  daemon.receipts = [];
  await shell.frame({ type: 'queue', op: 'remove', ids: ['q6'], id: 'q6', reason: 'removed', count: 0 });
  assert.equal(byMsg(MID(6)), undefined);
});

test('a message the user removes with ⟲ leaves the pending list (its remove frame finds it already gone)', async () => {
  await setQueue([msg(1)], [{ msg_id: MID(1), state: 'queued', at: 1 }]);
  shell.click(row('q1').querySelector('.qi-revert'));
  await shell.tick();
  await shell.frame({ type: 'queue', op: 'remove', ids: ['q1'], id: 'q1', reason: 'removed', count: 0 });
  assert.equal(byMsg(MID(1)), undefined, 'a removed message is not still queued at position 1');
});

/* ── positions ───────────────────────────────────────────────────────────── */

test('positions: per conversation among queued autosend messages; held has none; null is the primary\'s', async () => {
  await setQueue([
    msg(1, { conversation_id: 'c1' }),
    msg(2, { conversation_id: 'c1' }),
    msg(3, { conversation_id: 'c2' }),
    msg(4, { conversation_id: 'c1', staged: false }),
    msg(5, { conversation_id: 'c2', autosend: false }),
  ]);
  assert.deepEqual(messages().map((m) => [m.msg_id, m.state, m.position]), [
    [MID(1), 'queued', 1], [MID(2), 'queued', 2], [MID(3), 'queued', 1], [MID(4), 'held', null], [MID(5), 'queued', null],
  ]);
  const was = S.mirror.serverPrimary;
  try {
    S.mirror.serverPrimary = 'c1';
    await setQueue([msg(1, { conversation_id: 'c1' }), msg(2, { conversation_id: null }), msg(3, { conversation_id: 'c2' })]);
    assert.deepEqual(messages().map((m) => m.position), [1, 2, 1], 'a null conversation counts as the primary\'s');
  } finally { S.mirror.serverPrimary = was; }
  const m = messages()[0];
  assert.ok(Object.isFrozen(m) && Object.isFrozen(messages()), 'frozen');
  for (const k of ['id', 'msg_id', 'state', 'at', 'chars', 'files_count', 'conversation_id', 'device', 'autosend', 'position']) {
    assert.ok(Object.hasOwn(m, k), `an entry carries ${k}`);
  }
});

/* ── the one send path ───────────────────────────────────────────────────── */

test('sendMessage posts {text, files, conversation_id, send, device} as JSON once and answers the body', async () => {
  daemon.answers['/api/queue/message'] = { ok: true, id: 'q20', msg_id: MID(20), mode: 'queued', position: 2 };
  const n = posts('/api/queue/message').length;
  const r = await Q.sendMessage({ text: 'do X', files: ['lib/a.js'], conversation_id: 'c1', send: 'auto' });
  assert.deepEqual(r, { ok: true, id: 'q20', msg_id: MID(20), mode: 'queued', position: 2 });
  const sent = posts('/api/queue/message');
  assert.equal(sent.length, n + 1, 'one POST');
  const c = sent.at(-1);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body, { text: 'do X', files: ['lib/a.js'], conversation_id: 'c1', send: 'auto', device: 'desktop' });
  assert.equal(c.headers['Content-Type'], 'application/json');
});

test('a refusal comes back unthrown; a network failure answers refused "network"', async () => {
  daemon.answers['/api/queue/message'] = { ok: false, refused: 'too_large', max: 3000, hint: 'Messages are at most 3,000 characters.' };
  const r = await Q.sendMessage({ text: 'x'.repeat(3001) });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'too_large');
  assert.equal(r.max, 3000);
  daemon.answers['/api/queue/message'] = () => { throw new TypeError('Failed to fetch'); };
  const n = await Q.sendMessage({ text: 'hello' });
  assert.equal(n.ok, false);
  assert.equal(n.refused, 'network');
  assert.equal(typeof n.hint, 'string');
  assert.ok(n.hint.length > 0);
  daemon.answers['/api/queue/message'] = respond({ ok: false, mirror: 'read', remote: true, hint: 'Needs full access.' }, { status: 403 });
  const f = await Q.sendMessage({ text: 'hello' });
  assert.equal(f.ok, false);
  assert.equal(f.refused, 'forbidden');
  assert.equal(f.hint, 'Needs full access.');
});

test('a mode "wake" answer adds the message to messages with the request\'s text', async () => {
  daemon.answers['/api/queue/message'] = { ok: true, id: 'q21', msg_id: MID(21), mode: 'wake', seq: 4, boot: 'b' };
  await Q.sendMessage({ text: 'run the tests', conversation_id: 'c1' });
  const m = byMsg(MID(21));
  assert.ok(m, 'listed');
  assert.equal(m.state, 'sending');
  assert.equal(m.text, 'run the tests');
  assert.equal(m.conversation_id, 'c1');
  daemon.answers['/api/queue/message'] = { ok: true, id: 'q22', msg_id: MID(22), mode: 'parked', pending_id: 'pw9', delivers: 'x' };
  await Q.sendMessage({ text: 'later' });
  assert.equal(byMsg(MID(22)).state, 'parked');
  assert.equal(byMsg(MID(22)).text, 'later');
});

test('editMessage PATCHes /api/queue/:id {text}; sendNow posts push {ids:[id], device}; recallPending posts recall {id}', async () => {
  daemon.answers['/api/queue/q7'] = { ok: false, refused: 'not_editable', hint: 'Only a queued message can be edited.' };
  const e = await Q.editMessage('q7', { text: 'new words' });
  assert.equal(e.refused, 'not_editable');
  const patch = shell.calls.filter((c) => c.url === '/api/queue/q7').at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.deepEqual(patch.body, { text: 'new words' });

  daemon.answers['/api/queue/push'] = { ok: true, pushed: 1, mode: 'queued', waiting: 'parked_message', waiting_ids: ['q7'] };
  const p = await Q.sendNow('q7');
  assert.equal(p.waiting, 'parked_message');
  assert.deepEqual(posts('/api/queue/push').at(-1).body, { ids: ['q7'], device: 'desktop' });

  daemon.recalled = { ok: true, recalled: true, ids: ['q8'], pending_id: null };
  const r = await Q.recallPending('pw1');
  assert.deepEqual(r, { ok: true, recalled: true, ids: ['q8'], pending_id: null });
  assert.deepEqual(posts('/api/queue/pending/recall').at(-1).body, { id: 'pw1' });
});

/* ── the rail ────────────────────────────────────────────────────────────── */

test('a message row\'s −/+ and ⟲ act as for a signal (⟲ is a plain remove for a message)', async () => {
  await setQueue([msg(1), signal(2)]);
  shell.click(row('q1').querySelector('.qi-stage'));
  await shell.tick();
  const patch = shell.calls.filter((c) => c.url === '/api/queue/q1' && c.method === 'PATCH').at(-1);
  assert.deepEqual(patch.body, { staged: false });
  assert.ok(row('q1').classList.contains('held'));
  assert.equal(byMsg(MID(1)).state, 'held');
  assert.equal(byMsg(MID(1)).position, null);
  shell.click(row('q1').querySelector('.qi-stage'));
  await shell.tick();
  assert.deepEqual(shell.calls.filter((c) => c.url === '/api/queue/q1' && c.method === 'PATCH').at(-1).body, { staged: true });

  assert.match(row('q1').querySelector('.qi-revert').title, /message/);
  shell.click(row('q1').querySelector('.qi-revert'));
  await shell.tick();
  const del = shell.calls.filter((c) => c.method === 'DELETE' && c.url.startsWith('/api/queue/q1')).at(-1);
  assert.equal(del.url, '/api/queue/q1', 'no ?revert=1: there is nothing to undo');
  shell.click(row('s2').querySelector('.qi-revert'));
  await shell.tick();
  assert.ok(shell.calls.some((c) => c.method === 'DELETE' && c.url === '/api/queue/s2?revert=1'), 'a signal still reverts');
});

test('a Push answer with held_messages: 2 shows the banner, and keeps the messages on the rail', async () => {
  await setQueue([msg(1), msg(2), signal(3)]);
  daemon.answers['/api/queue/push'] = { ok: true, pushed: 1, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed', held_messages: 2 };
  daemon.items = [msg(1), msg(2)];
  await Q.pushQueue();
  await shell.tick();
  const b = rail().querySelector('.rail-held-msgs');
  assert.ok(b, 'the banner');
  assert.equal(b.textContent, '2 messages stay queued: sending a message from this page needs full access');
  assert.ok(row('q1') && row('q2'), 'the messages stay');
  assert.ok(!row('s3'), 'the signal went');
});

function park(items, id = 'pw1') {
  return { id, created_at: 1, note: '', envelope: { meta: { count: String(items.length) } },
    items: items.map((it) => ({ id: it.id, kind: it.kind, summary: it.summary, source: it.source, why_wake: it.why_wake })) };
}
const pendingBox = () => rail().querySelector('.rail-pending');
const visible = (el) => !!el && !el.hidden;

test('a park holding a message offers Take back and no Cancel; the header counts messages', async () => {
  daemon.pending = park([{ ...msg(1), summary: 'message · 16 chars' }, signal(2), signal(3)]);
  await Q.refreshPending();
  const box = pendingBox();
  assert.ok(!box.classList.contains('hidden'));
  assert.equal(box.querySelector('.rp-text').textContent, '⇢ Parked: 1 message, 2 signals deliver with your next message.');
  assert.ok(visible(box.querySelector('.rp-takeback')), 'Take back');
  assert.ok(!visible(box.querySelector('.rp-cancel')), 'no Cancel: it would discard the user\'s words');
});

test('Take back on a park with a message and a stop request: recall, then the park with the stop request and Cancel', async () => {
  const stop = { id: 'q30', kind: 'message', source: 'task-stop', task_id: 'bdz1n2', summary: 'stop request · bdz1n2' };
  daemon.pending = park([{ ...msg(1), summary: 'message · 16 chars' }, stop]);
  await Q.refreshPending();
  assert.equal(pendingBox().querySelector('.rp-text').textContent,
    '⇢ Parked: 1 message, 1 stop request deliver with your next message.');
  daemon.recalled = { ok: true, recalled: true, ids: ['q1'], pending_id: 'pw2' };
  daemon.afterRecall = () => {
    daemon.items = [{ ...msg(1), autosend: false }];
    daemon.pending = park([stop], 'pw2');
  };
  const consumes = posts('/api/queue/pending/consume').length;
  shell.click(pendingBox().querySelector('.rp-takeback'));
  await waitUntil(() => !!row('q1'), { timeout: 2000, what: 'the recalled message back on the rail' });
  await waitUntil(() => visible(pendingBox().querySelector('.rp-cancel')), { timeout: 2000, what: 'Cancel on what is left of the park' });
  assert.deepEqual(posts('/api/queue/pending/recall').at(-1).body, { id: 'pw1' });
  assert.equal(posts('/api/queue/pending/consume').length, consumes, 'nothing consumed');
  assert.ok(!visible(pendingBox().querySelector('.rp-takeback')), 'the rest of the park has no message: Cancel again');
  assert.equal(pendingBox().querySelector('.rp-text').textContent, '⇢ Parked: 1 stop request deliver with your next message.');
  assert.equal(byMsg(MID(1)).state, 'queued', 'the message is back in the queue');
  assert.equal(byMsg(MID(1)).position, null, 'with autosend off');
});

test('a signal-only park keeps Cancel and its consume POST', async () => {
  daemon.pending = park([signal(1), signal(2)]);
  await Q.refreshPending();
  const box = pendingBox();
  assert.equal(box.querySelector('.rp-text').textContent, '⇢ Parked: 2 signals deliver with your next message.');
  assert.ok(visible(box.querySelector('.rp-cancel')));
  assert.ok(!visible(box.querySelector('.rp-takeback')));
  shell.click(box.querySelector('.rp-cancel'));
  await waitUntil(() => box.classList.contains('hidden'), { timeout: 2000, what: 'the cancelled park hidden' });
  assert.deepEqual(posts('/api/queue/pending/consume').at(-1).body, { id: 'pw1' });
});

test('the chrome sends messages through queue.js alone: no other module fetches the message routes', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'public', 'app');
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'queue.js')
    .filter((f) => /\/api\/queue\/(message|pending\/recall)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(hits, []);
});
