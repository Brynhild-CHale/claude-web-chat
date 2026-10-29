// Excerpts on by default (U425; DECISIONS.md D2, L.2 L8 = b, K.2-171): the
// maintainer recorded the real-session check (GT-14, E3) as passed on the
// interim build 0.9.0-alpha.2.1, so lib/core/excerpts' EXCERPTS_DEFAULT is on.
// The switch stays (P3's note): a project's {v: 1, on: false} record still
// keeps it off, and the host's `claude-web-chat excerpts on|off|status` is
// still its one writer.
//
//   (1) the record: none reads on from 'default'; {v:1,on:false} reads off
//       from 'record'; a corrupt record reads on, and status names it.
//   (2) the daemon: with no record, a shared highlight on a range anchor
//       queues with its excerpt and a Push carries one excerpt block, live and
//       parked; after `excerpts off` (setSwitch) the next Push is ids-only,
//       even for an item queued while on (U423's delivery gate).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { withServer, tmpRoot, openSSE, waitUntil } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { EXCERPTS_DEFAULT, readSwitch, excerptsOn, setSwitch } = require('../lib/core/excerpts');
const { wakeEnvelope, excerptText, EXCERPT_HEADER, EXCERPT_PREFIX } = require('../lib/channel/envelope');
const excerptsCli = require('../lib/cli/commands/excerpts');

const MOUNT = 'xd-pane';
const MARK = 'wc-u425-passage-mark';
const RANGE = (exact) => ({ v: 1, kind: 'range', mount: MOUNT, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const HIGHLIGHT = (exact) => ({ type: 'highlight', anchor: RANGE(exact), payload: { color: 'gold', note: 'look here' } });

function sink() {
  const lines = [];
  const log = (s = '') => lines.push(String(s));
  log.lines = lines;
  return log;
}
async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}
const blocks = (content) => content.split(`${EXCERPT_HEADER}:`).length - 1;
const elementItems = (srv) => srv.state.queue.filter((it) => it.kind === 'element');
const groupOf = (items, id) => items.find((it) => (it.element_ids || [it.element_id]).includes(id));
const excerptOf = (it, id) => {
  if (!it) return undefined;
  if (typeof it.excerpt === 'string') return it.element_id === id ? it.excerpt : undefined;
  return Array.isArray(it.excerpt) ? (it.excerpt.find((e) => e.id === id) || {}).text : undefined;
};

// ── (1) the record ──────────────────────────────────────────────────────────

test('(1) a fresh project (no record) reads on from the default; {v:1,on:false} reads off from the record; a corrupt record reads on and status names it', () => {
  assert.strictEqual(EXCERPTS_DEFAULT, true);
  const root = tmpRoot('wc-u425-rec-');
  const file = projectPaths(root).excerpts;
  assert.ok(!fs.existsSync(file));
  assert.deepStrictEqual(readSwitch(root), { on: true, source: 'default', state: 'absent' });
  assert.strictEqual(excerptsOn(root), true);
  let log = sink();
  excerptsCli(['status'], { cwd: root, log });
  assert.strictEqual(log.lines[0], 'excerpts: on (the default; this project has no record)');

  setSwitch(root, false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, on: false });
  assert.deepStrictEqual(readSwitch(root), { on: false, source: 'record', state: 'ok' });
  assert.strictEqual(excerptsOn(root), false, 'the record wins over the default');
  log = sink();
  excerptsCli(['status'], { cwd: root, log });
  assert.strictEqual(log.lines[0], 'excerpts: off (this project\'s record, .web-chat/excerpts.json)');

  fs.writeFileSync(file, '{"v":1,"on":fal');
  assert.deepStrictEqual(readSwitch(root), { on: true, source: 'default', state: 'corrupt' });
  assert.strictEqual(excerptsOn(root), true);
  log = sink();
  excerptsCli(['status'], { cwd: root, log });
  assert.match(log.lines[0], /^excerpts: on \(the default; \.web-chat\/excerpts\.json is corrupt: reads as on; /);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v":1,"on":fal', 'status leaves the record as it is');
});

// ── (2) the daemon ──────────────────────────────────────────────────────────

async function livePush(t, d) {
  const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
  t.after(() => channel.close());
  const pushed = await ok(d.api.post('/api/queue/push', {}), 'live push');
  assert.strictEqual(pushed.mode, 'wake', JSON.stringify(pushed));
  const wake = await waitUntil(() => channel.events.find((e) => e.kind === 'wake'), { timeout: 5000, what: 'the wake' });
  channel.close();
  return { wake, content: wakeEnvelope(wake.batch, { reason: wake.reason, source: wake.source, seq: wake.seq }).content };
}
async function parkPush(d) {
  const pushed = await ok(d.api.post('/api/queue/push', {}), 'park push');
  assert.strictEqual(pushed.mode, 'parked', JSON.stringify(pushed));
  return (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
}
const postHighlight = async (d, exact) => (await ok(d.api.post('/api/elements', HIGHLIGHT(exact)), 'highlight')).element;

test('(2) no record: a shared highlight on a range anchor queues with its excerpt and a Push carries one block; after `excerpts off` the next Push is ids-only', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: MOUNT, html: `<p class="lead">${MARK} and more</p>` }), 'render');
  assert.ok(!fs.existsSync(projectPaths(d.root).excerpts), 'no excerpts record');
  assert.strictEqual(d.srv.state.excerptsOn(), true, 'the default: on');

  // Live: the wake's batch carries the excerpt, and the envelope one block.
  const live = `${MARK} live`;
  const h = await postHighlight(d, live);
  assert.strictEqual(excerptOf(groupOf(elementItems(d.srv), h.id), h.id), excerptText(live), 'queued with its excerpt');
  const { wake, content } = await livePush(t, d);
  assert.strictEqual(excerptOf(groupOf(wake.batch, h.id), h.id), excerptText(live));
  assert.strictEqual(blocks(content), 1, `one excerpt block: ${content}`);
  assert.ok(content.includes(`- highlight ${h.id}\n${EXCERPT_PREFIX}${live}`), content);

  // Parked: the park's envelope carries one block too.
  const parked = `${MARK} parked`;
  const h2 = await postHighlight(d, parked);
  const pending = await parkPush(d);
  assert.strictEqual(blocks(pending.envelope.content), 1, pending.envelope.content);
  assert.ok(pending.envelope.content.includes(`- highlight ${h2.id}\n${EXCERPT_PREFIX}${parked}`));
  // The next prompt consumes a park: consume it here, so the next Push starts clean.
  const consumed = await ok(d.api.post('/api/queue/pending/consume', { id: pending.id }), 'consume the park');
  assert.ok(consumed.consumed, JSON.stringify(consumed));

  // Queued while on, then `excerpts off`: the item still holds its words, and
  // the delivery gate strips them from the next Push — live and parked.
  const late = `${MARK} queued before off`;
  const h3 = await postHighlight(d, late);
  assert.strictEqual(excerptOf(groupOf(elementItems(d.srv), h3.id), h3.id), excerptText(late), 'queued while on');
  setSwitch(d.root, false);
  assert.strictEqual(d.srv.state.excerptsOn(), false, 'the record, read with no restart');
  const off = await livePush(t, d);
  assert.ok(off.wake.batch.every((it) => !('excerpt' in it)), 'the wake batch carries no excerpt');
  assert.strictEqual(blocks(off.content), 0, off.content);
  assert.ok(!off.content.includes(late), 'none of the passage\'s words');
  assert.ok(off.content.includes(h3.id), 'the delivery names the pin by id');

  const h4 = await postHighlight(d, `${MARK} parked while off`);
  assert.strictEqual(excerptOf(groupOf(elementItems(d.srv), h4.id), h4.id), undefined, 'queued while off: no excerpt');
  const offPark = await parkPush(d);
  assert.strictEqual(blocks(offPark.envelope.content), 0, offPark.envelope.content);
  assert.ok(!offPark.envelope.content.includes(MARK), 'the park holds none of the words');
  assert.ok(offPark.envelope.content.includes(h4.id));
});
