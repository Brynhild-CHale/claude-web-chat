// GET /api/files (lib/server/routes/files.js, spec §6.2, U57) on a bare
// Express app with a fake ctx, as §10.1 says route units are tested; the
// wiring in lib/server/index.js is U66a's.
//
// What is pinned:
//   * the gate is requireMirror('full'): a remote viewer at basic and at read
//     is refused 403 with the hint, at full (the opt-in) and locally it is let
//     through; the real audience (no opt-in) refuses a remote viewer too;
//   * the body: {ok, files: [{path, bytes}], truncated, source, indexed_at},
//     the index asked with the parsed q and limit (defaults '' and 20);
//   * the mirror switched off (enabled() sync or async) → {ok:true,
//     disabled:true, files:[]}, and the index is not asked;
//   * q over Q_MAX characters, a repeated q, and a limit outside 1..LIMIT_MAX
//     → 400 before the index is asked;
//   * a throw → 500 that names nothing;
//   * against a real index: no file content and no absolute path in the body;
//   * the mount throws without ctx.projectFiles or ctx.audience.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { request } = require('../lib/client');
const { home: SANDBOX } = require('../test-support/sandbox');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { atLeast, fromOptIn, MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const { createAudience } = require('../lib/server/audience');
const { mountFilesRoutes } = require('../lib/server/routes/files');
const { createProjectFiles, Q_MAX, LIMIT_DEFAULT, LIMIT_MAX } = require('../lib/server/project-files');

const ANSWER = {
  files: [{ path: 'src/app.js', bytes: 16 }, { path: 'README.md', bytes: 5 }],
  truncated: false,
  source: 'git',
  indexed_at: 1_780_000_000_000,
};

// §5.4's gate on the real level order and hints (the precedent in
// test/mirror-routes-work.test.js): a plain loopback request is `local`; one
// with the portal's label gets the project's opt-in ('off' is `basic`).
function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    needs: [],
    levelOf(req) { return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local'; },
    requireMirror(need) {
      a.needs.push(need);
      return (req, res, next) => {
        const level = a.levelOf(req);
        if (atLeast(level, need)) return next();
        return res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req),
          hint: need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT });
      };
    },
  };
  return a;
}

function fakeFiles(answer = ANSWER) {
  const f = { calls: [] };
  f.search = async (q, opts) => {
    f.calls.push([q, opts]);
    return typeof answer === 'function' ? answer(q, opts) : answer;
  };
  f.check = async () => ({ ok: false, why: 'missing' });
  return f;
}

function fakeMirror(on = { enabled: true }) {
  return { enabled: () => on };
}

async function host(t, { audience = fakeAudience(), projectFiles = fakeFiles(), mirror = fakeMirror() } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = { audience, projectFiles };
  if (mirror) ctx.mirror = mirror;
  mountFilesRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null,
    { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 30000 });
  return { get, audience, projectFiles, ctx };
}

test('local: 200 with the index\'s answer, asked with the defaults', async (t) => {
  const h = await host(t);
  const r = await h.get('/api/files');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true, ...ANSWER });
  assert.deepStrictEqual(h.projectFiles.calls, [['', { limit: LIMIT_DEFAULT }]]);
  assert.deepStrictEqual(h.audience.needs, ['full']);
  await h.get(`/api/files?q=${encodeURIComponent('src app')}&limit=${LIMIT_MAX}`);
  assert.deepStrictEqual(h.projectFiles.calls[1], ['src app', { limit: LIMIT_MAX }]);
});

test('the gate: a remote viewer below full is refused with the hint; at full it is let through', async (t) => {
  const audience = fakeAudience({ optIn: 'off' });
  const h = await host(t, { audience });
  for (const optIn of ['off', 'read']) {
    audience.optIn = optIn;
    const r = await h.get('/api/files?q=a', { remote: true });
    assert.equal(r.status, 403, optIn);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.hint, MIRROR_FULL_HINT);
    assert.equal(r.body.remote, true);
  }
  assert.equal(h.projectFiles.calls.length, 0, 'the index is never asked for a refused viewer');
  audience.optIn = 'full';
  const ok = await h.get('/api/files?q=a', { remote: true });
  assert.equal(ok.status, 200);
  assert.deepStrictEqual(ok.body, { ok: true, ...ANSWER });
});

test('the real audience: a remote viewer with no opt-in is refused; a local one is answered', async (t) => {
  const audience = createAudience({ configFile: null });
  t.after(() => audience.stop());
  const h = await host(t, { audience });
  const refused = await h.get('/api/files', { remote: true });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(typeof refused.body.hint, 'string');
  assert.equal((await h.get('/api/files')).status, 200);
});

test('the mirror switched off: {ok:true, disabled:true, files:[]}, sync or async', async (t) => {
  for (const mirror of [fakeMirror({ enabled: false, scope: 'project' }),
    { enabled: async () => ({ enabled: false, scope: 'user' }) }]) {
    const h = await host(t, { mirror });
    const r = await h.get('/api/files?q=a');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, disabled: true, files: [] });
    assert.equal(h.projectFiles.calls.length, 0);
  }
  const h = await host(t, { mirror: { enabled: async () => ({ enabled: true }) } });
  assert.deepStrictEqual((await h.get('/api/files')).body, { ok: true, ...ANSWER });
});

test('a malformed q or limit is 400 before the index is asked', async (t) => {
  const h = await host(t);
  const long = 'a'.repeat(Q_MAX + 1);
  for (const p of [`/api/files?q=${long}`, '/api/files?q=a&q=b', `/api/files?limit=${LIMIT_MAX + 1}`,
    '/api/files?limit=0', '/api/files?limit=x', '/api/files?limit=-1', '/api/files?limit=2.5', '/api/files?limit=']) {
    const r = await h.get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.body.ok, false, p);
    assert.equal(typeof r.body.error, 'string', p);
  }
  assert.equal(h.projectFiles.calls.length, 0);
  const ok = await h.get(`/api/files?q=${'a'.repeat(Q_MAX)}&limit=1`);
  assert.equal(ok.status, 200);
  assert.deepStrictEqual(h.projectFiles.calls, [['a'.repeat(Q_MAX), { limit: 1 }]]);
});

test('a throw is a 500 that names nothing', async (t) => {
  const secret = '/Users/someone/project/.env says TOKEN=abc';
  const h = await host(t, { projectFiles: fakeFiles(() => { throw new Error(secret); }) });
  const r = await h.get('/api/files?q=a');
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  assert.ok(!JSON.stringify(r.body).includes('TOKEN'));
  assert.ok(!JSON.stringify(r.body).includes('/Users/'));
});

test('only {path, bytes} of relative paths leave the route', async (t) => {
  const h = await host(t, { projectFiles: fakeFiles({
    files: [{ path: 'a.txt', bytes: 1, content: 'SECRET' }, { path: '/etc/passwd', bytes: 9 }, { path: 7 }, null],
    truncated: 'yes',
    source: 'other',
    indexed_at: 'now',
    extra: 'SECRET',
  }) });
  const r = await h.get('/api/files');
  assert.deepStrictEqual(r.body, { ok: true, files: [{ path: 'a.txt', bytes: 1 }], truncated: false, source: 'git', indexed_at: null });
});

test('against a real index: no file content and no absolute path in the body', async (t) => {
  const MARK = 'U57-CONTENT-MARKER-7f3a';
  const repo = treesnapRepo(t, { files: { 'src/app.js': `// ${MARK}\n`, 'notes.md': `${MARK}\n` } });
  const projectFiles = createProjectFiles({ root: repo.root });
  t.after(() => projectFiles.stop());
  const h = await host(t, { projectFiles });
  const r = await h.get('/api/files');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body.files.map((f) => f.path).sort(), ['notes.md', 'src/app.js']);
  assert.equal(r.body.source, 'git');
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(MARK), 'no content');
  assert.ok(!raw.includes(repo.root) && !raw.includes(SANDBOX) && !raw.includes(fs.realpathSync(SANDBOX)), 'no absolute path');
  for (const f of r.body.files) assert.ok(!path.isAbsolute(f.path));
});

test('the mount throws without ctx.projectFiles or ctx.audience', () => {
  const app = express();
  assert.throws(() => mountFilesRoutes(app, { audience: fakeAudience() }), TypeError);
  assert.throws(() => mountFilesRoutes(app, { audience: fakeAudience(), projectFiles: {} }), TypeError);
  assert.throws(() => mountFilesRoutes(app, { projectFiles: fakeFiles() }), TypeError);
  assert.throws(() => mountFilesRoutes(app, null), TypeError);
});
