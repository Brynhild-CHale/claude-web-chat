// U91 — POST /api/attachments and withAttachments (lib/server/routes/
// attachments.js; spec §15.7, §5.7 P3, §5.3's RULES row; ruled D6 (a)).
//
// A bare Express app with a fake ctx (the real audience with no opt-in, so a
// remote viewer is basic), a project under the sandbox HOME's tmp dir. Every
// save is checked on disk; the bytes are never served back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createAudience } = require('../lib/server/audience');
const { projectPaths } = require('../lib/core/paths');
const { PNG_SIGNATURE } = require('../lib/core/png');
const {
  mountAttachmentRoutes, withAttachments, sniffImage,
  ATTACHMENTS_ROUTE, ATTACHMENT_MAX_BYTES, ATTACHMENTS_KEEP, ATTACHMENTS_RATE_MAX, ATTACHMENT_TYPES, ATTACHMENT_RE,
} = require('../lib/server/routes/attachments');
const { validateMessage } = require('../lib/server/composer');
const { wakeEnvelope } = require('../lib/channel/envelope');

// Sample images: the format's leading bytes, then filler. The GIF header is
// built from its bytes (the GIF writer's signature is a ratchet in lib/).
const fill = (n) => Buffer.alloc(n, 7);
const SAMPLES = {
  'image/png': Buffer.concat([PNG_SIGNATURE, fill(40)]),
  'image/jpeg': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fill(40)]),
  'image/gif': Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), fill(40)]),
  'image/webp': Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), fill(32)]),
};
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u91-att-'));
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function serve(t, root, opts = {}) {
  const app = express();
  const audience = createAudience({ configFile: null });
  t.after(() => audience.stop && audience.stop());
  mountAttachmentRoutes(app, { root, audience }, opts);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, headers = {}) => {
    const res = await fetch(base + ATTACHMENTS_ROUTE, { method: 'POST', headers, body });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  return { base, post };
}

const saved = (root) => {
  try { return fs.readdirSync(projectPaths(root).attachmentsDir).sort(); } catch { return []; }
};

test('the constants: four types, 5 MiB, the newest 50, 20 a minute; the path grammar sits under attachmentsDir', () => {
  assert.deepEqual([...ATTACHMENT_TYPES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  assert.equal(ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(ATTACHMENTS_KEEP, 50);
  assert.equal(ATTACHMENTS_RATE_MAX, 20);
  const root = '/tmp/p';
  const rel = path.relative(root, path.join(projectPaths(root).attachmentsDir, '20261013-0a1b2c3d.png')).split(path.sep).join('/');
  assert.match(rel, ATTACHMENT_RE);
  for (const bad of ['.web-chat/attachments/../x.png', '.web-chat/attachments/x.png', '.web-chat/attachments/20261013-0a1b2c3d.svg', '/.web-chat/attachments/20261013-0a1b2c3d.png']) {
    assert.doesNotMatch(bad, ATTACHMENT_RE);
  }
});

test('sniffImage: the four formats by their leading bytes, anything else null', () => {
  assert.equal(sniffImage(SAMPLES['image/png']), 'png');
  assert.equal(sniffImage(SAMPLES['image/jpeg']), 'jpeg');
  assert.equal(sniffImage(SAMPLES['image/gif']), 'gif');
  assert.equal(sniffImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1])), 'gif');
  assert.equal(sniffImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61, 1])), null);
  assert.equal(sniffImage(SAMPLES['image/webp']), 'webp');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage('png'), null);
  assert.equal(sniffImage(PNG_SIGNATURE.subarray(0, 4)), null);
});

test('a PNG, a JPEG, a GIF and a WebP are saved under attachmentsDir and answered with the relative path', async (t) => {
  const root = project(t);
  const { post } = await serve(t, root);
  for (const [type, bytes] of Object.entries(SAMPLES)) {
    const r = await post(bytes, { 'Content-Type': type });
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.match(r.body.path, ATTACHMENT_RE);
    assert.ok(r.body.path.endsWith(`.${EXT[type]}`), r.body.path);
    assert.equal(r.body.bytes, bytes.length);
    assert.equal(r.body.type, type);
    assert.deepEqual(fs.readFileSync(path.join(root, r.body.path)), bytes);
  }
  assert.equal(saved(root).length, 4);
});

test('refusals: a type the bytes do not match, text/plain, empty, 5 MiB + 1, a foreign Origin, a remote viewer below full', async (t) => {
  const root = project(t);
  const { post } = await serve(t, root);
  const mismatch = await post(SAMPLES['image/jpeg'], { 'Content-Type': 'image/png' });
  assert.equal(mismatch.status, 415);
  assert.equal(mismatch.body.ok, false);
  assert.equal(mismatch.body.refused, 'mismatch');
  assert.ok(mismatch.body.hint);
  const svgAsPng = await post(Buffer.from('<svg/>'), { 'Content-Type': 'image/png' });
  assert.equal(svgAsPng.status, 415);
  const text = await post('hello', { 'Content-Type': 'text/plain' });
  assert.equal(text.status, 415);
  assert.equal(text.body.refused, 'type');
  const svg = await post('<svg/>', { 'Content-Type': 'image/svg+xml' });
  assert.equal(svg.status, 415);
  const empty = await post(Buffer.alloc(0), { 'Content-Type': 'image/png' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.refused, 'empty');
  const big = await post(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1 - PNG_SIGNATURE.length)]), { 'Content-Type': 'image/png' });
  assert.equal(big.status, 413);
  assert.equal(big.body.refused, 'too_large');
  const bigger = await post(Buffer.alloc(ATTACHMENT_MAX_BYTES + 4096), { 'Content-Type': 'image/png' });
  assert.equal(bigger.status, 413);
  const foreign = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png', Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.refused, 'origin');
  const local = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png', Origin: 'http://127.0.0.1:5173' });
  assert.equal(local.status, 200, 'a local Origin passes');
  const remote = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png', 'X-WC-Remote': '1' });
  assert.equal(remote.status, 403);
  assert.equal(remote.body.ok, false);
  assert.equal(remote.body.mirror, 'basic');
  assert.equal(saved(root).length, 1, 'only the local one was saved');
});

test(`the ${ATTACHMENTS_RATE_MAX + 1}st upload in a minute is refused rate_limited`, async (t) => {
  const root = project(t);
  let now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const { post } = await serve(t, root, { now: () => now });
  for (let i = 0; i < ATTACHMENTS_RATE_MAX; i++) {
    const r = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
    assert.equal(r.status, 200, `upload ${i + 1}`);
  }
  const over = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
  assert.equal(over.status, 429);
  assert.equal(over.body.refused, 'rate_limited');
  assert.ok(over.body.retry_after >= 1);
  now += 61000;
  assert.equal((await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' })).status, 200, 'a minute later');
  // A wrong type is refused before the budget is spent.
  assert.equal((await post('x', { 'Content-Type': 'text/plain' })).status, 415);
});

test(`after ${ATTACHMENTS_KEEP + 1} saves ${ATTACHMENTS_KEEP} files remain, the oldest gone; other files are never pruned`, async (t) => {
  const root = project(t);
  let now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const { post } = await serve(t, root, { now: () => now });
  const dir = projectPaths(root).attachmentsDir;
  const first = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
  assert.equal(first.status, 200);
  // The first is the oldest on disk, whatever the clock's resolution.
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(root, first.body.path), past, past);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an attachment');
  for (let i = 1; i <= ATTACHMENTS_KEEP; i++) {
    now += 4000;
    const r = await post(SAMPLES['image/gif'], { 'Content-Type': 'image/gif' });
    assert.equal(r.status, 200, `save ${i + 1}`);
  }
  const names = saved(root).filter((n) => n !== 'notes.txt');
  assert.equal(names.length, ATTACHMENTS_KEEP);
  assert.ok(!fs.existsSync(path.join(root, first.body.path)), 'the oldest is gone');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'a name outside the grammar stays');
});

test('no GET route answers a saved name: the bytes are never served back', async (t) => {
  const root = project(t);
  const { base, post } = await serve(t, root);
  const r = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
  const name = path.basename(r.body.path);
  for (const url of [`${ATTACHMENTS_ROUTE}/${name}`, `/${r.body.path}`, ATTACHMENTS_ROUTE, `${ATTACHMENTS_ROUTE}?name=${name}`]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 404, url);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(!body.includes(PNG_SIGNATURE), url);
  }
});

test('withAttachments: a saved name answers itself; a symlink is refused; any other rel goes to the wrapped index', async (t) => {
  const root = project(t);
  const { post } = await serve(t, root);
  const r = await post(SAMPLES['image/webp'], { 'Content-Type': 'image/webp' });
  const calls = [];
  const index = {
    check(rel) { calls.push(['check', rel]); return { ok: false, why: 'ignored' }; },
    search(q, o) { calls.push(['search', q, o]); return { files: [] }; },
    refresh() { calls.push(['refresh']); },
    stop() { calls.push(['stop']); },
  };
  const files = withAttachments(index, { root });
  assert.deepEqual(files.check(r.body.path), { ok: true, path: r.body.path, bytes: SAMPLES['image/webp'].length });
  assert.deepEqual(calls, []);

  const dir = projectPaths(root).attachmentsDir;
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, SAMPLES['image/png']);
  fs.symlinkSync(outside, path.join(dir, '20261013-deadbeef.png'));
  assert.deepEqual(files.check('.web-chat/attachments/20261013-deadbeef.png'), { ok: false, why: 'symlink' });
  assert.deepEqual(files.check('.web-chat/attachments/20261013-0000beef.png'), { ok: false, why: 'missing' });

  for (const rel of ['.web-chat/attachments/../x', 'lib/a.js', '.web-chat/graph.json', '.web-chat/attachments/x.png']) {
    assert.deepEqual(files.check(rel), { ok: false, why: 'ignored' }, rel);
  }
  assert.deepEqual(calls.map((c) => c[1]), ['.web-chat/attachments/../x', 'lib/a.js', '.web-chat/graph.json', '.web-chat/attachments/x.png']);
  files.search('q', { limit: 3 });
  files.refresh();
  files.stop();
  assert.deepEqual(calls.slice(-3), [['search', 'q', { limit: 3 }], ['refresh'], ['stop']]);
  assert.equal('search' in withAttachments({ check: index.check }, { root }), false, 'only what the index has');
  assert.throws(() => withAttachments(index, {}), TypeError);
});

test('an attachments directory that is a symlink out of the project: nothing is saved through it', async (t) => {
  const root = project(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u91-else-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, projectPaths(root).attachmentsDir);
  const { post } = await serve(t, root);
  const r = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
  assert.equal(r.status, 500);
  assert.equal(r.body.refused, 'unavailable');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('validateMessage with the wrapped index accepts the saved path, and the envelope\'s File line names it', async (t) => {
  const root = project(t);
  const { post } = await serve(t, root);
  const r = await post(SAMPLES['image/png'], { 'Content-Type': 'image/png' });
  const projectFiles = withAttachments({ check: () => ({ ok: false, why: 'ignored' }) }, { root });
  const v = await validateMessage({ text: 'describe the attached image', files: [r.body.path] }, { projectFiles });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.message.files, [{ path: r.body.path, bytes: SAMPLES['image/png'].length }]);
  const item = { kind: 'message', id: 'q1', msg_id: 'm-0a1b2c3d', source: 'composer', ...v.message };
  const { content } = wakeEnvelope([item], {});
  assert.ok(content.includes(`File attached: ${r.body.path} (`), content);
  assert.ok(content.includes('read it with the Read tool before acting on the message.'));
  assert.ok(!content.includes(PNG_SIGNATURE.toString('latin1')), 'never the bytes');
});
