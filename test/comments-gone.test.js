// /api/comments is replaced outright by the element API (U327a; PLAN 2C.4,
// ruling COMMENTS@alias b): no alias, no removal item. What a caller of the
// OLD paths gets is one refusal, lib/server/routes/comments.js's
//
//   410 {ok: false, error: 'gone', code: 'comments-route-replaced', hint}
//
// on every method, on /api/comments and everything below it. The caller that
// matters is a Claude Code session that loaded the web-chat tools before the
// upgrade (lib/mcp/* loads once, at session start): its get_comments and
// reply_comment keep calling the old paths until /exit. Its tool result must
// carry the hint naming /exit, verbatim, which it does because the refusal is
// JSON (lib/mcp/index.js prints `Error: <method> <path> → <status>: <body>`)
// and not a 404 (lib/mcp/skew.js reads a non-JSON 404 as a daemon OLDER than
// the tools and says "claude-web-chat restart" — the opposite fix).
//
// The pre-upgrade session is real here: a copy of this checkout's lib/ and
// bin/ with the two tool modules put back to their code at 39b52f8 (copied
// below), run as Claude Code runs it — bin/claude-web-chat-mcp.js over stdio,
// through the MCP SDK's client — against the NEW daemon.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { withServer, commentBody } = require('../test-support/helpers');
const { COMMENTS_GONE } = require('../lib/server/routes/comments');
const client = require('../lib/client');

const REPO = path.join(__dirname, '..');
const ANCHOR = Object.freeze({ mount: 'm1', selector: 'p', text: 'Hello', ordinal: 0 });
const RESTART = /claude-web-chat restart/;

const PATHS = ['/api/comments', '/api/comments?shared_only=1&since=0', '/api/comments/c1', '/api/comments/c1/reply'];
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'];

function assertGone(r, what) {
  assert.equal(r.status, 410, `${what}: ${r.status} ${JSON.stringify(r.body ?? r.json ?? r.text)}`);
  const body = r.json !== undefined ? r.json : r.body;
  assert.deepStrictEqual(body, COMMENTS_GONE, `${what}: the refusal, as JSON`);
}

test('the refusal: every method on /api/comments and below it answers 410 JSON whose hint names /exit; nothing is written', async (t) => {
  const { api, port, srv } = await withServer(t);
  assert.deepStrictEqual(Object.keys(COMMENTS_GONE).sort(), ['code', 'error', 'hint', 'ok']);
  assert.equal(COMMENTS_GONE.ok, false);
  assert.equal(COMMENTS_GONE.error, 'gone');
  assert.equal(COMMENTS_GONE.code, 'comments-route-replaced');
  assert.match(COMMENTS_GONE.hint, /\/api\/elements/);
  assert.match(COMMENTS_GONE.hint, /\/exit and reopen Claude Code/);
  assert.doesNotMatch(COMMENTS_GONE.hint, RESTART, 'not the old-daemon fix');

  await api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' });
  const pin = (await api.post('/api/elements', commentBody({ text: 'a note', anchor: ANCHOR }))).json.pin;
  assert.equal(pin.id, 'c1');
  const before = JSON.stringify(srv.state.comments);
  const body = { text: 'x', shared: true, anchor: ANCHOR, author: 'claude' };
  for (const p of PATHS) {
    for (const m of METHODS) {
      // A browser (Node's fetch: fetch metadata) and lib/client (none), with
      // Claude's writer token and without.
      const r = m === 'GET' ? await api.get(p)
        : m === 'POST' ? await api.post(p, body)
          : m === 'PATCH' ? await api.patch(p, body)
            : m === 'DELETE' ? await api.del(p) : null;
      if (r) {
        assertGone(r, `browser ${m} ${p}`);
        assert.match(r.headers.get('content-type') || '', /application\/json/, `${m} ${p}: JSON`);
      }
      assertGone(await client.request(port, m, p, m === 'GET' || m === 'DELETE' ? null : body, { timeout: 10000 }), `lib/client ${m} ${p}`);
    }
  }
  assert.equal(JSON.stringify(srv.state.comments), before, 'no old-path write landed');
  // The comment lives on at the element API, the one comment route.
  const live = (await api.get('/api/elements?type=comment')).json;
  assert.deepStrictEqual(live.elements.map((c) => [c.id, c.text, (c.replies || []).length]), [['c1', 'a note', 0]]);
});

// lib/mcp/tools/get_comments.js and reply_comment.js at 39b52f8 (before
// U327a), their handlers verbatim; the descriptions are cut to one line.
const OLD_TOOLS = {
  'get_comments.js': `const client = require('../client');

module.exports = {
  name: 'get_comments',
  description: 'Pull the user\\'s comment pins from the surface (pre-U327a).',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'number' },
      mount: { type: 'string' },
    },
  },
  async handler({ since, mount }) {
    const qs = new URLSearchParams({ shared_only: '1' });
    if (since != null) qs.set('since', String(since));
    if (mount) qs.set('mount', String(mount));
    return await client.get('/api/comments?' + qs.toString());
  },
};
`,
  'reply_comment.js': `const client = require('../client');

module.exports = {
  name: 'reply_comment',
  description: 'Reply to a user\\'s comment pin (pre-U327a).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['id', 'text'],
  },
  async handler({ id, text }) {
    return await client.post('/api/comments/' + encodeURIComponent(String(id)) + '/reply', { text, author: 'claude' });
  },
};
`,
};

// A pre-upgrade install: this checkout's lib/, bin/ and package.json copied
// into a scratch directory, node_modules linked, the two tools put back.
function preUpgradeTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pre-u327a-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['lib', 'bin']) fs.cpSync(path.join(REPO, sub), path.join(dir, sub), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(dir, 'node_modules'), 'dir');
  for (const [name, src] of Object.entries(OLD_TOOLS)) fs.writeFileSync(path.join(dir, 'lib', 'mcp', 'tools', name), src);
  return dir;
}

test('a session that loaded the tools before the upgrade: its get_comments and reply_comment, through lib/mcp/index.js, answer the hint naming /exit — not the restart message', async (t) => {
  const d = await withServer(t);
  await d.api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' });
  const pin = (await d.api.post('/api/elements', commentBody({ text: 'a note', anchor: ANCHOR }))).json.pin;
  const tree = preUpgradeTree(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pre-u327a-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(tree, 'bin', 'claude-web-chat-mcp.js')],
    // cwd the daemon's own project, so the old session even sends this
    // boot's writer token: a verified caller is refused the same.
    cwd: d.root,
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_PORT: String(d.port), WEB_CHAT_CHANNEL: '0' },
  });
  const mcp = new Client({ name: 'u327a-test', version: '0.0.0' });
  await mcp.connect(transport);
  t.after(() => mcp.close());

  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes('get_comments') && tools.includes('reply_comment'));
  const cases = [
    ['get_comments', {}, /^Error: GET \/api\/comments\?shared_only=1 → 410: /],
    ['get_comments', { since: 0, mount: 'm1' }, /^Error: GET \/api\/comments\?shared_only=1&since=0&mount=m1 → 410: /],
    ['reply_comment', { id: pin.id, text: 'answered' }, new RegExp(`^Error: POST /api/comments/${pin.id}/reply → 410: `)],
  ];
  for (const [name, args, head] of cases) {
    const res = await mcp.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name}: an error result`);
    const text = res.content.map((c) => c.text).join('\n');
    assert.match(text, head, `${name}: the dispatcher's error line`);
    assert.ok(text.includes('/exit'), `${name}: the hint names /exit: ${text}`);
    assert.ok(text.includes(COMMENTS_GONE.hint), `${name}: the hint verbatim`);
    assert.doesNotMatch(text, RESTART, `${name}: not skew.js's older-daemon message`);
  }
  const live = (await d.api.get('/api/elements?type=comment')).json.elements;
  assert.deepStrictEqual(live.map((c) => [c.id, (c.replies || []).length]), [[pin.id, 0]], 'the old reply landed nowhere');
});

// ── the chrome at this merge ────────────────────────────────────────────────
// public/app/comments.js's fetches are the element API's: a pin added through
// the composer is one POST /api/elements {type: 'comment', anchor, payload},
// and the refresh that follows reads GET /api/elements?type=comment's
// `elements` and draws its marker. Last in the file: the shell replaces the
// globals (fetch among them) from its before() to its after().
test.describe('chrome: a pin added through the composer posts to the element API and draws its marker', () => {
  let shell;
  let W;
  const held = [];
  // The element API, as far as the chrome's comment reads and writes need it.
  const elementsRoute = (url, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'POST' && url === '/api/elements') {
      const b = JSON.parse(init.body);
      const pin = { id: `c${held.length + 1}`, seq: held.length + 1, text: b.payload.text, shared: b.payload.shared !== false, replies: [], anchor: b.anchor };
      held.push(pin);
      return { ok: true, pin, element: { ...pin, type: 'comment' } };
    }
    return { elements: held.map((p) => ({ ...p, type: 'comment' })), next_cursor: held.length };
  };

  test.before(async () => {
    const { bootShell, helloFrame } = require('../test-support/chrome-shell');
    shell = await bootShell({ open: true, routes: { '/api/elements': elementsRoute } });
    W = shell.window;
    await shell.frame(helloFrame({ mounts: [{ id: 'drop', html: '<p>plain</p>', target: 'main', params: {}, pane_state: {} }] }));
  });
  test.after(() => shell && shell.restore());

  test('POST /api/elements with the comment body, then a GET whose elements draw the marker', async () => {
    const markers = () => [...W.document.getElementById('pin-layer').querySelectorAll('.pin-marker')];
    assert.equal(markers().length, 0, 'precondition: no marker');
    shell.key('c');
    const host = [...W.document.querySelectorAll('.mount-host')].find((h) => (h.dataset.mountId || h.id) === 'drop');
    const target = host.shadowRoot.querySelector('p');
    for (const type of ['pointerdown', 'click']) {
      target.dispatchEvent(new W.MouseEvent(type, { bubbles: true, composed: true, clientX: 40, clientY: 40 }));
    }
    await shell.tick();
    const pop = W.document.querySelector('.pin-pop');
    assert.ok(pop, 'the composer opened');
    pop.querySelector('.pin-text').value = 'a note';
    shell.click(pop.querySelector('.pin-save'));
    for (let i = 0; i < 5; i++) await shell.tick();

    const post = shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements').pop();
    assert.ok(post, 'the add went to the element API');
    assert.strictEqual(post.body.type, 'comment');
    assert.deepStrictEqual({ text: post.body.payload.text, shared: post.body.payload.shared }, { text: 'a note', shared: true });
    assert.strictEqual(post.body.anchor.mount, 'drop', 'the anchor is the locator, as today');
    assert.ok(!('text' in post.body), 'the text rides the payload, not the top level');
    assert.ok(shell.calls.some((c) => c.method === 'GET' && c.url === '/api/elements?type=comment'), 'the refresh read the element API');
    assert.equal(shell.calls.filter((c) => /^\/api\/comments/.test(c.url)).length, 0, 'nothing reaches /api/comments');
    assert.equal(markers().length, 1, 'the pin drew a marker');
  });
});
