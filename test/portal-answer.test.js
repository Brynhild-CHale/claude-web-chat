// Remote answering through the tunnel portal (spec §4.6, §15.2, §15.5; rulings
// Q3, Q-C, Q2, Q9, B1 (a), B2 (a), D3 (a), E2-E5 (a); U74): the answer host
// (`<session>-a`), its own table ANSWER_RULES, its CSRF rule, the proxy's
// answer mode and X-WC-Answer-Origin on a session's /api/health — end to end
// through a REAL portal (withPortal) and a REAL daemon (withServer), found
// through the REAL registry, with Claude Code played by its hooks' code, a
// sessions file and an MCP presence row (test-support/claude-home), and a fake
// mod over the bridge (test-support/fake-mod). No real Claude Code, browser,
// cloudflared or Cloudflare runs here: gate V31 is the maintainer's.
//
// tunnel.json is written into the sandbox HOME before the daemon boots, so the
// daemon's audience (its second lock) and the portal read the same grant.
//
// Pinned, a test per clause:
//   * config: answerHost / parseHost for both styles;
//   * at full: the bar document (frame-ancestors exactly the session host, no
//     X-Frame-Options), the view, a decide marked remote — every answer-host
//     response free of the fake secret in the ask's subject (findLeaks), and the
//     X-WC-Answer-Origin header on the session's /api/health;
//   * at read and with no grant: every answer-host route 403 with ANSWER_HINT,
//     nothing reaching the answer surface; no X-WC-Answer-Origin;
//   * a hidden project and a stopped one: the same JSON 404;
//   * CSRF, header hygiene, the default deny, the upgrade, the port (started
//     on demand, forgotten and retried, 503 with no surface to start);
//   * a remote Stop: the hook halt with no mod (never the Esc), the mod's ONE
//     abort with one; rate-limited; audited as remote;
//   * D3 (a): an elicitation is never answerable remotely, even at full;
//   * the chrome at full with the header: the mod stopper's Kill and the
//     fork-in-place action are offered at the answer host and act through it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  withServer, withPortal, withTempHome, tmpRoot, waitUntil, wsConnect, openSSE,
} = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { claudeHome } = require('../test-support/claude-home');
const { fakeMod } = require('../test-support/fake-mod');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { registerInstance, deregisterInstance, instanceId } = require('../lib/util/registry');
const { projectPaths, userPaths, PACKAGE_ROOT } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { OPS } = require('../lib/core/mod-protocol');
const { ANSWER_HINT } = require('../lib/core/remote-policy');
const { parseHost, sessionHost, answerHost, normalizeConfig } = require('../lib/tunnel/config');
const { forwardHeaders, responseHeaders } = require('../lib/portal/proxy');
const { answerCsrfRefusal } = require('../lib/portal/answer');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');

const HOOK_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js');
const S1 = '11111111-1111-4111-8111-111111111111';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const NAV = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' };
const SECRET = fakeSecrets().find((f) => f.id === 'github-ghp');

// ── config ──────────────────────────────────────────────────────────────────

test('config: answerHost and parseHost round-trip in both styles; only exactly `<id>-a` is the answer kind', () => {
  const flat = normalizeConfig(createFakeAccess().config({ hostname: 'wc.example.com' }));
  const nested = normalizeConfig(createFakeAccess().config({ hostname: 'wc.example.com', style: 'nested' }));
  const id = '0a1b2c3d';
  assert.equal(answerHost(flat, id), 'wc-0a1b2c3d-a.example.com');
  assert.equal(answerHost(nested, id), '0a1b2c3d-a.wc.example.com');
  for (const c of [flat, nested]) {
    assert.deepEqual(parseHost(c, answerHost(c, id)), { kind: 'answer', id, host: answerHost(c, id) });
    assert.deepEqual(parseHost(c, `${answerHost(c, id)}:443`), { kind: 'answer', id, host: answerHost(c, id) });
    assert.deepEqual(parseHost(c, sessionHost(c, id)), { kind: 'session', id, host: sessionHost(c, id) }, 'the session kind unchanged');
    assert.equal(parseHost(c, answerHost(c, id).toUpperCase()).kind, 'answer', 'hostnames are case-insensitive');
    for (const bad of [
      sessionHost(c, id).replace(id, `${id}-b`),
      sessionHost(c, id).replace(id, `${id}-a-a`),
      sessionHost(c, id).replace(id, '0a1b2c3-a'),
      sessionHost(c, id).replace(id, 'zzzzzzzz-a'),
      sessionHost(c, id).replace(id, '-a'),
    ]) assert.equal(parseHost(c, bad), null, bad);
  }
  assert.equal(sessionHost(flat, id), 'wc-0a1b2c3d.example.com', 'sessionHost unchanged');
  assert.equal(parseHost(flat, 'wc-a.example.com'), null, 'the apex with -a');
  assert.equal(parseHost(nested, 'wc-a.example.com'), null, 'the apex with -a (nested)');
  assert.equal(parseHost(nested, 'a.wc.example.com'), null);
});

test('proxy: the answer mode forwards X-WC-Answer and rewrites Origin to the engine\'s origin; the session mode is as before', () => {
  const incoming = { 'x-wc-answer': 'n0nce', 'x-wc-remote': '0', 'x-wc-token': 't', 'x-wc-shutdown': '1', origin: 'https://x', cookie: 'a=b', 'sec-fetch-site': 'same-origin' };
  assert.deepEqual(forwardHeaders(incoming, { port: 4100, origin: true, mode: 'answer' }),
    { 'x-wc-answer': 'n0nce', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4100', 'x-wc-remote': '1' });
  assert.deepEqual(forwardHeaders(incoming, { port: 4100, origin: true }),
    { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:4100', 'x-wc-remote': '1' }, 'a session never forwards X-WC-Answer');
  const up = { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'set-cookie': 'x',
    'content-security-policy': "default-src 'none'; frame-ancestors http://localhost:1 http://127.0.0.1:1; form-action 'none'" };
  const a = responseHeaders(up, '/answer/ask/x', { mode: 'answer', sessionHost: 'wc-0a1b2c3d.example.com' });
  assert.equal(a['x-frame-options'], undefined);
  assert.equal(a['set-cookie'], undefined);
  assert.equal(a['cache-control'], 'no-store');
  assert.equal(a['content-security-policy'], "default-src 'none'; form-action 'none'; frame-ancestors https://wc-0a1b2c3d.example.com");
  assert.equal(responseHeaders({}, '/answer/api/asks/x', { mode: 'answer', sessionHost: 'h.example.com' })['content-security-policy'],
    'frame-ancestors https://h.example.com', 'a response with no CSP gets the one directive');
  const s = responseHeaders(up, '/api/graph');
  assert.equal(s['x-frame-options'], 'DENY', 'the session mode unchanged');
  assert.deepEqual(s['content-security-policy'], [up['content-security-policy'], "frame-ancestors 'none'"]);
});

test('answerCsrfRefusal: Origin, the write rule and Sec-Fetch-Site', () => {
  const O = 'https://wc-0a1b2c3d-a.example.com';
  const r = (method, url, headers) => answerCsrfRefusal({ method, url, headers }, O);
  assert.equal(r('GET', '/answer/ask/x?layout=bar', NAV), null, 'the frame\'s load from the session');
  assert.equal(r('GET', '/answer/control/interrupt?conversation_id=c', { ...NAV, 'sec-fetch-dest': 'document' }), null, 'the popup');
  assert.equal(r('GET', '/answer/ask/x', { ...NAV, 'sec-fetch-site': 'none' }), null, 'a reload of the popup');
  assert.equal(r('POST', '/answer/api/asks/x/decide', { origin: O, 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(r('GET', '/answer/api/asks/x', { 'sec-fetch-site': 'same-origin' }), null);
  for (const [what, method, url, headers] of [
    ['the session host\'s Origin', 'POST', '/answer/api/asks/x/decide', { origin: 'https://wc-0a1b2c3d.example.com', 'sec-fetch-site': 'same-site' }],
    ['no Origin on a write', 'POST', '/answer/api/asks/x/decide', { 'sec-fetch-site': 'same-origin' }],
    ['cross-site', 'POST', '/answer/api/asks/x/decide', { origin: O, 'sec-fetch-site': 'cross-site' }],
    ['a cross-site navigation', 'GET', '/answer/ask/x', { ...NAV, 'sec-fetch-site': 'cross-site' }],
    ['a same-site read that is not a navigation', 'GET', '/answer/api/asks/x', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }],
    ['a same-site navigation to an API path', 'GET', '/answer/api/asks/x', NAV],
    ['a same-site navigation to a static file', 'GET', '/answer/answer.js', NAV],
    ['a same-site no-cors image load of a document', 'GET', '/answer/ask/x', { ...NAV, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
    ['a foreign Origin on a read', 'GET', '/answer/api/asks/x', { origin: 'https://evil.example' }],
  ]) {
    const out = r(method, url, headers);
    assert.ok(out && out.status === 403, what);
    assert.equal(out.body.remote, true, what);
  }
});

test('tunnel mirror on prints the full-level line (answering, Stop, Restore, Fork); --read-only does not', async (t) => {
  withTempHome(t);
  const tunnel = require('../lib/cli/commands/tunnel');
  const root = tmpRoot('wc-portal-answer-cli-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(createFakeAccess().config()));
  const LINE = 'At full they can also answer Claude\'s permission prompts — which can run commands on this machine — and stop Claude, restore files and fork a conversation from the page.';
  const run = async (args) => {
    const out = [];
    await tunnel(['mirror', ...args, '--project', root], { log: (x) => out.push(String(x)) });
    return out.join('\n');
  };
  const full = await run(['on']);
  assert.ok(full.includes(LINE), full);
  assert.ok(full.includes('will see Claude\'s conversation'), 'the conversation warning stays');
  const again = await run(['on']);
  assert.ok(again.includes(LINE), 'said again when already at full');
  const read = await run(['on', '--read-only']);
  assert.ok(!read.includes('At full they can also'), read);
  assert.ok(read.includes('will see Claude\'s conversation'));
});

// ── the rig ─────────────────────────────────────────────────────────────────

// A project at `level` ('off' | 'read' | 'full'), its daemon, a portal in front
// of it, and Claude Code's side (the sessions file says this process is S1).
// `tty`: S1's MCP server can inject an Esc. Every answer-host response is kept
// in `seen` for the leak sweep.
async function rig(t, { level = 'full', tty = false } = {}) {
  withTempHome(t);
  const root = tmpRoot('wc-portal-answer-');
  const ch = claudeHome(t, { root, isolate: true });
  const procStart = formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);
  ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'idle' });
  if (tty) ch.addMcp({ pid: process.pid, ppid: process.pid, root: ch.cwd, interrupt: 'tty' });
  const access = createFakeAccess();
  const remote = { allowDestructive: false, ...(level === 'off' ? {} : { mirror: { [path.resolve(root)]: level } }) };
  const raw = access.config({ remote });
  writeJsonAtomic(userPaths().tunnelConfig, raw);
  const ctx = await withServer(t, { root, writePortfile: true });
  await ctx.srv.controlStarted;
  registerInstance({ root: ctx.root, port: ctx.port, pid: process.pid });
  const id = instanceId(ctx.root);
  const p = await withPortal(t, { config: raw, fetchJwks: access.fetchJwks });
  const shost = sessionHost(p.config, id);
  const ahost = answerHost(p.config, id);
  const aorigin = `https://${ahost}`;
  const auth = { 'cf-access-jwt-assertion': access.mint() };
  const seen = [];
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1,
    transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const send = (h) => (pathStr, { method = 'GET', headers = {}, body } = {}) => p.request(pathStr, {
    host: h, method, body,
    headers: { ...auth, ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
  });
  const r = {
    ...ctx, ch, p, id, shost, ahost, aorigin, auth, access, seen, call, procStart,
    S: send(shost),
    async A(pathStr, opts) {
      const res = await send(ahost)(pathStr, opts);
      seen.push(res);
      return res;
    },
    get: (x) => client.get(x, call),
    post: (x, body) => client.post(x, body, call),
    async fire(event, extra) {
      assert.equal(await postEnvelope(envelope(event, extra), { root: ctx.root, timeout: CALL_TIMEOUT_MS }), 'posted', event);
    },
    turnBegin(promptId, text) {
      const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId });
      return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
    },
    hookEnv() {
      const e = { ...process.env, ...env };
      delete e.WEB_CHAT_HOOK_LOG;
      return e;
    },
    // An answer document, loaded as the bar's frame loads it: → {res, nonce}.
    async doc(pathStr, headers = NAV) {
      const res = await r.A(pathStr, { headers });
      const m = /name="wc-answer-nonce" content="([^"]*)"/.exec(res.text || '');
      return { res, nonce: m ? m[1] : null };
    },
    view: (askId, nonce, extra = {}) => r.A(`/answer/api/asks/${askId}?v=0`, {
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-wc-answer': nonce, ...extra },
    }),
    decide: (askId, nonce, version, decision = { behavior: 'allow' }, extra = {}) => r.A(`/answer/api/asks/${askId}/decide`, {
      method: 'POST',
      headers: { origin: aorigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-wc-answer': nonce, ...extra },
      body: { decision, version, device: 'mobile' },
    }),
    act: (action, nonce, body, extra = {}) => r.A(`/answer/api/control/${action}`, {
      method: 'POST',
      headers: { origin: aorigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-wc-answer': nonce, ...extra },
      body,
    }),
    // The fake mod for S1, said hello, answering every op and recording it.
    async attach(handlers = {}) {
      const m = fakeMod({ port: ctx.port, sessionId: S1, root: ctx.root });
      t.after(() => m.close());
      const hello = await m.hello();
      assert.equal(hello.status, 200, JSON.stringify(hello.body));
      const ops = [];
      const wrapped = {};
      for (const name of OPS) {
        wrapped[name] = (args, op) => {
          ops.push({ op: op.op, args });
          return typeof handlers[name] === 'function' ? handlers[name](args, op) : {};
        };
      }
      m.runOps(wrapped, { wait: 200 });
      return { mod: m, ops };
    },
  };
  return r;
}

// A local browser tab: the viewer the asks domain wants before a page may answer.
async function viewer(t, port) {
  const ws = wsConnect(port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  return ws;
}

// A hook subcommand as Claude Code runs it: a child, the payload on stdin.
function runHook(t, r, sub, payload) {
  const child = spawn(process.execPath, [HOOK_BIN, sub], { cwd: r.root, env: r.hookEnv() });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => { clearTimeout(killer); resolve({ status, signal, stdout, stderr }); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done.catch(() => {}); });
  child.stdin.end(JSON.stringify(payload));
  return { child, done };
}

const askPayload = (r, extra = {}) => ({
  session_id: S1, transcript_path: r.ch.transcript(S1), cwd: r.ch.cwd, hook_event_name: 'PermissionRequest',
  prompt_id: 'p-ask', permission_mode: 'default', tool_name: 'Bash',
  tool_input: { command: SECRET.text, description: 'Point the remote at the mirror' }, ...extra,
});

async function pendingAsk(r, kind = 'permission') {
  return waitUntil(async () => {
    const list = (await r.get('/api/asks')).asks || [];
    return list.find((a) => a.kind === kind && a.state === 'pending' && a.answerable) || null;
  }, { ...WAIT, what: `a pending ${kind} ask` });
}

const lines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// S1 at work: its process busy, a prompt (the lock), a tool running and a pane
// rendered, the mirror seeing it work.
async function working(r, promptId = 'p-work') {
  r.ch.writeSession({ pid: process.pid, procStart: r.procStart, sessionId: S1, status: 'busy' });
  await r.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await r.turnBegin(promptId, 'run the slow tests');
  await r.fire('PreToolUse', { tool_name: 'Bash', tool_use_id: `toolu_01${promptId.replace(/\W/g, '')}`, tool_input: { command: 'npm test' } });
  await r.post('/api/render', { id: `pa-${promptId}`, html: '<p>running</p>' });
  return waitUntil(async () => {
    const c = ((await r.get('/api/mirror')).conversations || []).find((x) => x.id === S1);
    return c && c.process && c.process.pid === process.pid && c.live && c.live.state === 'working' ? c : null;
  }, { ...WAIT, what: 'the mirror to see S1 working, with its process' });
}

// ── answering at full ────────────────────────────────────────────────────────

test('at full: the bar frame loads from the answer host (framable by the session only), its view and decide answer, the decide is remote; nothing leaks', async (t) => {
  const r = await rig(t);
  await viewer(t, r.port);
  const run = runHook(t, r, 'ask', askPayload(r));
  const ask = await pendingAsk(r);

  // The session's health names the answer origin; the chrome accepts it.
  const health = await r.S('/api/health', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(health.status, 200);
  assert.equal(health.headers['x-wc-answer-origin'], r.aorigin);
  assert.equal(health.json.remote, true);
  assert.equal(health.json.answer, null, 'never the loopback port to a remote page');
  const { parseAnswerOrigin } = await import('../public/app/remote.js');
  assert.equal(parseAnswerOrigin(health.headers['x-wc-answer-origin']), r.aorigin);

  const { res: d, nonce } = await r.doc(`/answer/ask/${ask.id}?layout=bar&mode=light`);
  assert.equal(d.status, 200, d.text);
  assert.match(d.headers['content-type'], /^text\/html/);
  const csp = String(d.headers['content-security-policy']);
  assert.equal(typeof d.headers['content-security-policy'], 'string', 'one policy');
  assert.deepEqual(csp.split(';').map((x) => x.trim()).filter((x) => x.startsWith('frame-ancestors')), [`frame-ancestors https://${r.shost}`]);
  assert.equal(d.headers['x-frame-options'], undefined);
  assert.equal(d.headers['cache-control'], 'no-store');
  assert.ok(nonce, 'the document carries its nonce');

  const v = await r.view(ask.id, nonce);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.id, ask.id);
  assert.equal(v.json.can_answer, true, `answerable remotely at full: ${v.json.why_not}`);
  assert.equal(v.headers['cache-control'], 'no-store');

  const dec = await r.decide(ask.id, nonce, v.json.version);
  assert.equal(dec.status, 200, dec.text);
  assert.equal(dec.json.ok, true);
  const out = await run.done;
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"behavior":"allow"/);
  const audit = lines(projectPaths(r.root).asksAudit).filter((l) => l.ask === ask.id);
  // The decision's line (the hook's collection of it follows, as the host's).
  assert.deepEqual([audit[0].outcome, audit[0].via, audit[0].origin, audit[0].device], ['allowed', 'web', 'remote', 'mobile']);
  const logged = lines(userPaths().remoteAccessLog).filter((l) => l.path.startsWith('/answer/'));
  assert.ok(logged.some((l) => l.method === 'POST' && l.path === `/answer/api/asks/${ask.id}/decide` && l.status === 200 && l.instance === r.id),
    JSON.stringify(logged));

  // The static files the frame loads.
  for (const f of ['answer.js', 'answer.css', 'answer-gate.js', 'answer-view.js', 'palette.css', 'fonts.css']) {
    const s = await r.A(`/answer/${f}`, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': f.endsWith('.js') ? 'script' : 'style' } });
    assert.equal(s.status, 200, `${f}: ${s.text.slice(0, 120)}`);
  }

  // The leak sweep: every answer-host response, and the header (T7 (i)).
  assert.ok(r.seen.length >= 9);
  for (const res of r.seen) {
    assert.deepEqual(findLeaks(`${JSON.stringify(res.headers)}\n${res.text}`, [SECRET]), [], `a response to ${res.status}: ${res.text.slice(0, 200)}`);
  }
  assert.deepEqual(findLeaks(String(health.headers['x-wc-answer-origin']), [SECRET]), []);
  assert.equal(v.json.masked, true, 'the fake secret was in the subject, and was masked');
  assert.deepEqual(findLeaks(JSON.stringify(v.json), [SECRET]), [], 'the subject is masked in the remote view');
});

// ── below full ───────────────────────────────────────────────────────────────

for (const level of ['read', 'off']) {
  test(`at ${level === 'off' ? 'no grant' : 'read'}: every answer-host route is 403 with ANSWER_HINT, nothing reaches the answer surface, and health names no answer origin`, async (t) => {
    const r = await rig(t, { level });
    const ASK = 'ask_0123456789ab';
    const posts = { origin: r.aorigin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' };
    for (const [method, p, headers, body] of [
      ['GET', `/answer/ask/${ASK}?layout=bar`, NAV],
      ['GET', `/answer/api/asks/${ASK}?v=0`, { 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' }],
      ['POST', `/answer/api/asks/${ASK}/decide`, posts, { decision: { behavior: 'allow' }, version: 1 }],
      ['GET', '/answer/control/interrupt?conversation_id=c1&layout=stop', NAV],
      ['GET', '/answer/api/control/state?action=interrupt&conversation_id=c1', { 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' }],
      ['POST', '/answer/api/control/interrupt', posts, { conversation_id: 'c1', mode: 'now' }],
      ['POST', '/answer/api/control/task-stop', posts, { task_id: 's1' }],
      ['GET', '/answer/answer.js', { 'sec-fetch-site': 'same-origin' }],
      ['GET', '/answer/palette.css', { 'sec-fetch-site': 'same-origin' }],
      ['GET', '/answer/fonts/x.woff2', { 'sec-fetch-site': 'same-origin' }],
    ]) {
      const res = await r.A(p, { method, headers, body });
      assert.equal(res.status, 403, `${method} ${p}: ${res.text}`);
      assert.deepEqual(res.json, { ok: false, remote: true, hint: ANSWER_HINT, mirror: level === 'off' ? 'basic' : 'read' }, `${method} ${p}`);
    }
    assert.equal(r.srv.answerSurface.port, null, 'the answer surface was never started');
    const health = await r.S('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['x-wc-answer-origin'], undefined, 'no answer origin below full');
    assert.equal(health.json.answer, null);
  });
}

// ── not found ────────────────────────────────────────────────────────────────

test('a hidden project and a stopped one: the same JSON 404 on the answer host, never the picker\'s page', async (t) => {
  const r = await rig(t);
  const P = `/answer/ask/ask_0123456789ab?layout=bar`;
  fs.writeFileSync(projectPaths(r.root).noRemote, '');
  await new Promise((resolve) => setTimeout(resolve, 1100)); // past the registry memo
  const hidden = await r.A(P, { headers: NAV });
  fs.rmSync(projectPaths(r.root).noRemote);
  deregisterInstance(r.root, { pid: process.pid });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const stopped = await r.A(P, { headers: NAV });
  for (const res of [hidden, stopped]) {
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.json, { ok: false, remote: true, error: 'not found' });
  }
  assert.equal(hidden.text, stopped.text, 'nothing tells hidden from stopped');
});

// ── CSRF, hygiene, the default deny, the upgrade ─────────────────────────────

test('CSRF on the answer host; the default deny; /answer/* on a session host; an upgrade is 404', async (t) => {
  const r = await rig(t);
  const ASK = 'ask_0123456789ab';
  const body = { decision: { behavior: 'allow' }, version: 1 };
  for (const [what, headers] of [
    ['the session host\'s Origin', { origin: `https://${r.shost}`, 'sec-fetch-site': 'same-site', 'x-wc-answer': 'x' }],
    ['no Origin', { 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' }],
    ['cross-site', { origin: r.aorigin, 'sec-fetch-site': 'cross-site', 'x-wc-answer': 'x' }],
  ]) {
    const res = await r.A(`/answer/api/asks/${ASK}/decide`, { method: 'POST', headers, body });
    assert.equal(res.status, 403, what);
    assert.equal(res.json.remote, true, what);
    assert.equal(res.json.hint, undefined, `${what}: a CSRF refusal, not the table's`);
  }
  const sameSiteRead = await r.A(`/answer/api/asks/${ASK}?v=0`, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'x-wc-answer': 'x' } });
  assert.equal(sameSiteRead.status, 403, 'a same-site read that is not a navigation');

  // ANSWER_RULES are the only door.
  for (const [method, p] of [
    ['GET', '/api/graph'], ['GET', '/api/asks'], ['GET', '/api/health'], ['GET', '/api/bridge/status'], ['POST', '/api/bridge/hello'],
    ['POST', `/answer/api/asks/${ASK}/withdraw`], ['GET', '/answer/bridge'], ['GET', '/'], ['GET', '/answer/index.html'],
    ['GET', '/answer/api/asks%2fx'], ['GET', '/answer/ask/..'], ['GET', '/answer/%2e%2e/api/graph'],
  ]) {
    const res = await r.A(p, { method, headers: { origin: r.aorigin, 'sec-fetch-site': 'same-origin' }, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 403, `${method} ${p}: ${res.text}`);
    assert.equal(res.json.remote, true);
    assert.notEqual(res.json.hint, ANSWER_HINT, `${method} ${p}: refused by the default deny or as malformed`);
  }
  // On the session host, /answer/* is RULES' default deny.
  const onSession = await r.S(`/answer/ask/${ASK}?layout=bar`, { headers: NAV });
  assert.equal(onSession.status, 403);
  assert.equal(onSession.json.hint, 'this route is not available remotely — use it on the host');

  // No socket on the answer host.
  const up = await new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({
      hostname: '127.0.0.1', port: r.p.port, path: '/ws', setHost: false,
      headers: { host: r.ahost, ...r.auth, origin: r.aorigin, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(up, 404);
});

test('header hygiene: X-WC-Answer reaches only the answer surface; the daemon\'s main port never sees it; X-WC-Remote always set', async (t) => {
  const r = await rig(t);
  const heard = [];
  const onRequest = (req) => heard.push({ url: req.url, headers: { ...req.headers } });
  r.server.prependListener('request', onRequest);
  t.after(() => r.server.off('request', onRequest));
  const g = await r.S('/api/graph', { headers: { 'x-wc-answer': 'n0nce', 'x-wc-remote': '0', 'sec-fetch-site': 'same-origin' } });
  assert.equal(g.status, 200);
  const seen = heard.find((h) => h.url === '/api/graph');
  assert.ok(seen, 'the daemon saw the request');
  assert.equal(seen.headers['x-wc-answer'], undefined, 'never forwarded on a session host');
  assert.equal(seen.headers['x-wc-remote'], '1', 'the portal\'s label, not the viewer\'s');
  // The answer host: the surface answers a nonce-checked view only when the
  // nonce arrived, and a decide only when Origin arrived as its own origin.
  await viewer(t, r.port);
  const run = runHook(t, r, 'ask', askPayload(r));
  const ask = await pendingAsk(r);
  const { nonce } = await r.doc(`/answer/ask/${ask.id}?layout=bar`);
  const v = await r.view(ask.id, nonce, { 'x-wc-remote': '0' });
  assert.equal(v.status, 200, 'X-WC-Answer arrived');
  const missing = await r.A(`/answer/api/asks/${ask.id}?v=0`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(missing.status, 403);
  assert.deepEqual(missing.json, { ok: false, refused: 'nonce' }, 'the surface\'s own refusal: no nonce sent');
  const dec = await r.decide(ask.id, nonce, v.json.version, { behavior: 'deny' });
  assert.equal(dec.status, 200, `Origin arrived as http://127.0.0.1:<answer port>: ${dec.text}`);
  assert.equal(lines(projectPaths(r.root).asksAudit).filter((l) => l.ask === ask.id).at(-1).origin, 'remote', 'X-WC-Remote arrived');
  await run.done;
  assert.ok(!heard.some((h) => h.url.startsWith('/answer/')), 'nothing on the answer host reached the main port');
});

// ── the port ─────────────────────────────────────────────────────────────────

test('the port: an idle-closed surface is started by the first answer-host request; after a close a GET is retried once, a POST is not; no surface is 503', async (t) => {
  const r = await rig(t);
  assert.equal(r.srv.answerSurface.port, null, 'not started at boot');
  const P = '/answer/answer.js';
  const H = { headers: { 'sec-fetch-site': 'same-origin' } };
  const first = await r.A(P, H);
  assert.equal(first.status, 200, first.text);
  const p1 = r.srv.answerSurface.port;
  assert.ok(Number.isInteger(p1), 'the portal\'s local ensure started it');

  await r.srv.answerSurface.close();
  assert.equal(r.srv.answerSurface.port, null);
  const post = await r.A('/answer/api/control/interrupt', { method: 'POST',
    headers: { origin: r.aorigin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' }, body: { conversation_id: 'c1', mode: 'now' } });
  assert.equal(post.status, 502, `a write is never replayed: ${post.text}`);
  const again = await r.A(P, H);
  assert.equal(again.status, 200, `a GET after the close is served: ${again.text}`);
  assert.ok(Number.isInteger(r.srv.answerSurface.port), 'started again');

  // No surface to start (the asks domain stopped): 503 with the terminal hint.
  await r.srv.answerSurface.close();
  await r.srv.asks.stop();
  await new Promise((resolve) => setTimeout(resolve, 1100)); // past the port memo
  const none = await r.A(P, H);
  assert.equal(none.status, 503, none.text);
  assert.deepEqual(none.json, { ok: false, remote: true, error: 'the answer frames are not available on the host right now — answer in the terminal' });
});

// ── a remote Stop (§15.2; B2 (a)) ────────────────────────────────────────────

test('a remote Stop through the answer host takes the hook halt, never the Esc, though the MCP row says tty; rate-limited; audited remote', async (t) => {
  const r = await rig(t, { tty: true });
  const c = await working(r);
  assert.equal(c.process.interrupt, 'tty', 'the session could take an Esc');
  const sse = await openSSE(r.port, { kinds: ['control'] });
  t.after(() => sse.close());
  const { res, nonce } = await r.doc(`/answer/control/interrupt?conversation_id=${S1}&layout=stop&mode=light`);
  assert.equal(res.status, 200, res.text);
  const st = await r.A(`/answer/api/control/state?action=interrupt&conversation_id=${S1}`, { headers: { 'sec-fetch-site': 'same-origin', 'x-wc-answer': nonce } });
  assert.equal(st.status, 200, st.text);
  assert.deepEqual([st.json.path, st.json.label], ['hook', 'Stop after this step'], 'remotely: the hook');

  const a = await r.act('interrupt', nonce, { conversation_id: S1, mode: 'now' });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual([a.json.ok, a.json.via], [true, 'hook']);
  assert.ok(fs.existsSync(userPaths().haltFlag(S1)), 'the halt flag is written');
  const ev = await waitUntil(() => sse.events.find((e) => e.kind === 'control' && e.op === 'interrupt'), { ...WAIT, what: 'the control event' });
  assert.equal(ev.via, 'hook');
  assert.equal(ev.target_pid, undefined, 'no Esc is addressed');

  const second = await r.act('interrupt', nonce, { conversation_id: S1, mode: 'now' });
  assert.equal(second.status, 429, second.text);
  assert.equal(second.json.refused, 'rate_limited');
  const audit = lines(projectPaths(r.root).controlAudit).filter((l) => l.action === 'interrupt');
  assert.deepEqual(audit.map((l) => [l.outcome, l.via, l.origin]), [['accepted', 'hook', 'remote'], ['refused:rate_limited', null, 'remote']]);
  assert.equal(sse.events.filter((e) => e.kind === 'control').length, 1);
});

test('a remote Stop with a mod attached: the state reads Interrupt, ONE abort op, no taskStop, no halt flag, via mod, audited remote', async (t) => {
  const r = await rig(t);
  const { ops } = await r.attach({ abort: () => ({ aborted: true }) });
  await working(r);
  const sse = await openSSE(r.port, { kinds: ['control'] });
  t.after(() => sse.close());
  const { nonce } = await r.doc(`/answer/control/interrupt?conversation_id=${S1}&layout=stop&mode=light`);
  const st = await r.A(`/answer/api/control/state?action=interrupt&conversation_id=${S1}`, { headers: { 'sec-fetch-site': 'same-origin', 'x-wc-answer': nonce } });
  assert.equal(st.status, 200, st.text);
  assert.deepEqual([st.json.path, st.json.label], ['mod', 'Interrupt']);
  const a = await r.act('interrupt', nonce, { conversation_id: S1, mode: 'now' });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual([a.json.ok, a.json.via], [true, 'mod']);
  const ev = await waitUntil(() => sse.events.find((e) => e.kind === 'control' && e.op === 'interrupt'), { ...WAIT, what: 'the control event' });
  assert.equal(ev.via, 'mod');
  assert.equal(ev.target_pid, undefined);
  await waitUntil(() => ops.some((o) => o.op === 'abort'), { ...WAIT, what: 'the abort op' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ops.filter((o) => o.op === 'abort').length, 1, 'one abort op');
  assert.equal(ops.filter((o) => o.op === 'taskStop').length, 0, 'no taskStop');
  assert.equal(fs.existsSync(userPaths().haltFlag(S1)), false, 'no halt flag');
  const audit = lines(projectPaths(r.root).controlAudit).filter((l) => l.action === 'interrupt');
  assert.deepEqual(audit.map((l) => [l.outcome, l.via, l.origin]), [['accepted', 'mod', 'remote']]);
});

// ── D3 (a): an elicitation is local only ────────────────────────────────────

test('D3 (a) through the portal: an elicitation is not answerable remotely at full — view remote-off, decide 403 remote-off, audited remote', async (t) => {
  const r = await rig(t);
  await r.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await viewer(t, r.port);
  const schema = { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] };
  const run = runHook(t, r, 'elicit', {
    session_id: S1, transcript_path: r.ch.transcript(S1), cwd: r.ch.cwd, hook_event_name: 'Elicitation',
    mcp_server_name: 'scratch', message: 'Who is asking?', mode: 'form', elicitation_id: 'el-remote', requested_schema: schema,
  });
  const ask = await pendingAsk(r, 'elicitation');
  const { res, nonce } = await r.doc(`/answer/ask/${ask.id}?layout=bar`);
  assert.equal(res.status, 200, res.text);
  const v = await r.view(ask.id, nonce);
  assert.equal(v.status, 200, v.text);
  assert.deepEqual([v.json.can_answer, v.json.why_not], [false, 'remote-off']);
  const dec = await r.decide(ask.id, nonce, v.json.version, { behavior: 'accept', content: { name: 'Grace' } });
  assert.equal(dec.status, 403, dec.text);
  assert.equal(dec.json.why_not, 'remote-off');
  const audit = lines(projectPaths(r.root).asksAudit).filter((l) => l.ask === ask.id);
  assert.deepEqual(audit.map((l) => [l.outcome, l.reason, l.origin]).at(-1), ['refused', 'remote-off', 'remote']);
  assert.equal(((await r.get('/api/asks')).asks || []).find((a) => a.id === ask.id).state, 'pending', 'still pending');
  run.child.kill('SIGKILL');
});

// ── the chrome at full (U86's viewer rule; T7 (ii)) ──────────────────────────

test('the chrome at full, with the portal\'s X-WC-Answer-Origin: the stopper\'s Kill and fork-in-place are offered on the answer host and act through it; below full neither', async (t) => {
  const r = await rig(t);
  const health = await r.S('/api/health', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(health.headers['x-wc-answer-origin'], r.aorigin);

  const { bootShell, respond, helloFrame } = require('../test-support/chrome-shell');
  const cid = S1;
  const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);
  const caps = { interrupt: true, task_stop: true, mod: true, rewind_in_place: true, fork: true };
  let rev = 9100;
  let access = { level: 'full', remote: true };
  const snapshot = () => ({
    v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: caps,
    primary: cid, aggregate: { state: 'idle' },
    conversations: [{ id: cid, rev: 1, headless: false, counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
      process: { pid: 4242, mod: true }, live: { state: 'idle', since: T0, last_activity_at: T0 } }],
    tasks: [{ id: 's1', kind: 'shell', conversation_id: cid, title: 'npm run dev', status: 'running', started_at: T0 - 60000 }],
    asks: [],
  });
  let current = snapshot();
  const turn = {
    id: 't1', rev: 9000, conversation_id: cid, session_id: 's1', seq: 1, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0, ended_at: T0 + 5000, duration_ms: 5000,
    counts: { items: 1, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: { id: 'n1', label: 'n1.1', role: 'commit' }, folded_into: null,
    items: [{ id: 'p_t1', kind: 'prompt', text: 'prompt t1', origin: 'human', turn_id: 't1', seq: 1000, ts: T0, rev: 9000 }],
  };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  let MC = null;
  let shell = null;
  let kill = null;
  let resume = null;
  try {
    shell = await bootShell({
      routes: {
        // The remote page's health, exactly as the portal answered it.
        '/api/health': respond(health.json, { headers: { 'X-WC-Answer-Origin': health.headers['x-wc-answer-origin'] } }),
        '/api/mirror': () => current,
        '/api/mirror/conversations/*': () => ({ conversation_id: cid, turns: [turn], next_before: null, total: 1, rev: 9001 }),
        '/api/asks': () => ({ asks: [], answer: null }),
      },
      init: async (sh) => {
        MC = await sh.importApp('mod-controls.js');
        MC.initModControls();
      },
    });
    const { bus } = await shell.importApp('bus.js');
    const S = await shell.importApp('chat-state.js');
    const P = await shell.importApp('chat-present.js');
    const Q = await shell.importApp('queue.js');
    const asksMod = await shell.importApp('asks.js');
    await shell.frame(helloFrame());
    bus.emit('chat:open', { view: 'chat' });
    const turnActions = () => [...shell.$('chat-stream').querySelectorAll('.ct-turn[data-turn-id="t1"] .ct-foot .ct-action')].map((b) => b.dataset.action);
    await waitUntil(() => S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
      && shell.$('chat-stream').querySelectorAll('.ct-turn').length === 1, { timeout: 3000, what: 'the stream' });
    await shell.tick();
    assert.equal(asksMod.answerFrameOrigin(), r.aorigin, 'frames load from the answer host');
    const row = () => P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).find((e) => e.cat === 'shells').rows.find((x) => x.id === 's1');

    const slot = shell.document.createElement('div');
    shell.document.body.append(slot);
    assert.equal(MC.modStopper.mount(slot, row(), { density: 'compact' }), true, 'the stopper takes the Kill');
    kill = new URL(slot.querySelector('iframe.wc-answer-frame').src);
    assert.equal(kill.origin, r.aorigin);
    assert.equal(kill.pathname, '/answer/control/task-stop');
    MC.modStopper.unmount(slot);

    assert.ok(turnActions().includes('fork-in-place'), `fork-in-place offered: ${turnActions().join(', ')}`);
    shell.press(shell.$('chat-stream').querySelector('.ct-turn[data-turn-id="t1"] [data-action="fork-in-place"]'));
    await shell.tick();
    const frame = [...shell.document.querySelectorAll('.popover.ta-dialog')].filter((d) => !d.id)
      .map((d) => d.querySelector('.ta-confirm iframe.wc-answer-frame')).find(Boolean);
    assert.ok(frame, 'the resume confirm frame');
    resume = new URL(frame.src);
    assert.equal(resume.origin, r.aorigin);
    assert.equal(resume.pathname, '/answer/control/resume');
    shell.key('Escape');
    await shell.tick();

    // Below full: neither is offered.
    access = { level: 'read', remote: true };
    current = snapshot();
    const want = current.rev;
    await shell.frame(helloFrame());
    await waitUntil(() => S.mirror.rev >= want, { timeout: 3000, what: 'the read snapshot' });
    await shell.tick();
    assert.equal(MC.modStopper.mount(slot, row(), { density: 'compact' }), false, 'no Kill frame below full');
    await waitUntil(() => !turnActions().includes('fork-in-place'), { timeout: 3000, what: 'fork-in-place gone below full' });
  } finally {
    if (MC) MC.stopModControls();
    delete globalThis.IntersectionObserver;
    if (shell) await shell.restore();
  }

  // Each frame's document and action, through the answer host: they reach the
  // control layer (its answer, not the portal's) and are audited as remote.
  for (const [u, action, body] of [[kill, 'task-stop', { task_id: 's1' }], [resume, 'resume', { turn_id: 't1' }]]) {
    const { res, nonce } = await r.doc(`${u.pathname}${u.search}`);
    assert.equal(res.status, 200, `${action}'s document: ${res.text.slice(0, 200)}`);
    const a = await r.act(action, nonce, body);
    assert.notEqual(a.json && a.json.remote, true, `${action}: not refused by the portal (${a.text})`);
    assert.ok(a.json && (a.json.ok === true || typeof a.json.refused === 'string'), `${action}: the control layer answered: ${a.text}`);
    const line = lines(projectPaths(r.root).controlAudit).filter((l) => l.action === action).at(-1);
    assert.ok(line, `${action}: audited`);
    assert.equal(line.origin, 'remote');
  }
});
