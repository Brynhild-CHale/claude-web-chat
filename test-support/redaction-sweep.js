// The chat mirror's redaction sweep, shared by its two test files (sweep(teardown)
// below; design spec §11.10, "End-to-end check
// (U75, U76)"; §5.2-§5.6, §2.7, §2.11, §6.1, §6.5, §15.2-§15.7; ruling E6 (a)):
// one synthetic session, seeded from test-support/fake-secrets, driven through
// the daemon exactly as createServer wires it, and everything that leaves it —
// every WebSocket frame on four sockets, every SSE event and GET /api/events
// page, every response of every GET route the daemon mounts (locally, and as a
// remote viewer at basic, read and full, and as a network peer), the answer
// surface's documents, views and control state reads, the host-only responses
// the scenario drives, the daemon's log, and every file under .web-chat/ after
// the daemon stops through BOTH teardown paths — is searched for what must
// never be in it.
//
// THE SCENARIO (one project under the sandbox HOME, so a raw home path would
// show if it leaked; a git repository with a tracked source file and an
// untracked .env; tunnel.json in the sandbox HOME; a private Claude tier):
//   * S1, this process's Claude Code: a transcript whose head carries the
//     session_context (the planted email) and credential_org (the planted
//     organisation id) records and the other NEVER_EMIT kinds and fields, then
//     a turn whose prompt, thinking, assistant text, tool inputs (a Bash
//     command with a credential flag, an Edit whose strings hold keys, a Write
//     of the .env) and results carry fakes; a subagent file; a tool-results
//     file named by persistedOutputPath; the hooks' envelopes for that turn;
//     a pending ask (the ask hook) whose Bash subject holds a key, decided
//     through the answer origin; an elicitation (the elicit hook) with a fake
//     in its message and in a field's description, accepted with a marker;
//     a composer message (held) carrying a non-secret marker and an `@` file;
//     a restore and its undo; a fork against a stub `claude`; a Stop that
//     takes the hook halt, then the turn closing.
//   * S2, a child process's Claude Code with a FAKE MOD attached
//     (test-support/fake-mod.js): a background shell whose output file holds
//     fakes; a composer message transported as a submit op (the lock and the
//     node read 'web message m-…', F7) and a second one mid-turn; turn.step
//     deltas past TAP_RATE with a key cut across two chunks; tool.call and
//     tool.done; session.append rows; a session.measure; a diag whose shapes
//     try to carry fakes; a permission.request whose input holds a key (the
//     mod transport of the asks, its wait raised through createServer's
//     test-only option); a Kill through the stopper's frame (one taskStop);
//     an interrupt (one abort); the transcript's later copy, with a
//     mod-submitted user/prompt and an attachment/queued_command whose
//     origin.kind is 'plugin', each carrying the composer marker and a fake;
//     session-rename (a marker in the name) and session-compact; an image
//     uploaded to /api/attachments and named in the transported message.
//   * the mod's package staged into .web-chat/mod through lib/setup/
//     registration applyMod with an injected runClaude (no real claude).
//   * then `tunnel mirror on --read-only` and `tunnel mirror on`, a short turn
//     at each level, and the route sweep at each.
//
// WHAT MUST HOLD (§11.10, one subtest per clause; every failure names the
// seed, the carrier and the rule): (1) no generated value and no 8-character
// window of one anywhere, local included; (2) the planted email and
// organisation id nowhere; (3) the composer marker in nothing delivered below
// read, the queue there showing `message · N chars`, and the transported
// message's lock and node 'web message m-…' at every level; (4) no raw home
// path in the carriers ruling E6 (a) lists — every other local response and
// file that shows one must be on the reasoned allowlist below, which may only
// shrink; (5) the withheld .env never in the shadow store, its diff entry
// withheld with no counts; (6) the audits and the restores ledger hold only
// their documented keys, ids, trees, relative paths and outcomes; (7) no halt
// flag outlives its turn, nor either teardown; (8) the fork's argv holds only
// ids, flags and web-chat's own label; (9) the mod's carriers masked, the
// elicitation's accepted marker nowhere.
//
// A LEAK THIS SWEEP FINDS is reported and left failing here for a lettered
// corrective under the leaking file's owner (ruling E6 (a), notes-E Q9): this
// file never fixes another unit's file, and no assertion here is loosened to
// get green.
//
// One allowance in the window search, said here because it is not in
// findLeaks: a window that is all hex digits (or a UUID's hex and dashes) is a
// leak only if 12 characters of that value are found, since a fake's hex
// windows meet random ids, git object names and nonces by chance (a 16^8
// space against ~10^6 hex positions per run). Every other window is held at 8.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { withServer, waitUntil, wsConnect, openSSE, fakeBin } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { agentFixtures } = require('../test-support/agent-fixtures');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { fakeMod } = require('../test-support/fake-mod');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const client = require('../lib/client');
const { createServer } = require('../lib/server');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { projectPaths, userPaths, PACKAGE_ROOT, realpath } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { classify } = require('../lib/core/remote-policy');
const { OPS, TAP_RATE } = require('../lib/core/mod-protocol');
const { PNG_SIGNATURE } = require('../lib/core/png');
const { runGit } = require('../lib/server/git-run');
const reg = require('../lib/setup/registration');
const tunnel = require('../lib/cli/commands/tunnel');

const REPO = path.resolve(__dirname, '..');
const HOOK_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js');

// ── the seed and what it plants ──────────────────────────────────────────────

const SEED = 0x7575;
const FAKES = fakeSecrets({ seed: SEED });
const fake = (id) => {
  const f = FAKES.find((x) => x.id === id);
  if (!f) throw new Error(`seed ${SEED}: no fake ${id}`);
  return f;
};
const EMAIL = fake('known-email').secrets[0];
const ORG = fake('known-org').secrets[0];
// What the window search looks for. The email's domain (example.com) is in
// every fake's host and in the fixtures' git identity, so the email is held by
// its local part; the dotenv fake's host is plain text outside its context.
const SCAN = FAKES.map((f) => {
  if (f.id === 'known-email') return { ...f, secrets: [EMAIL.split('@')[0]] };
  if (f.id === 'env-dotenv') return { ...f, secrets: f.secrets.filter((s) => !/\.example\.org$/.test(s)) };
  return f;
});
const PLANTED = [
  { id: 'planted-email', rule: 'known', secrets: [EMAIL, EMAIL.split('@')[0]] },
  { id: 'planted-org', rule: 'known', secrets: [ORG] },
];

// Non-secret marker phrases: where each must never be is the clause's.
const PROMPT_MARK = 'SWEEP-PROMPT-q7f2';
const REPLY_MARK = 'SWEEP-ASSIST-k3d9';
const THINK_MARK = 'SWEEP-THINK-w8r1';
const TOOLOUT_MARK = 'SWEEP-TOOLOUT-z5m4';
const SUBAGENT_MARK = 'SWEEP-SUBAGENT-h6c0';
const MSG_MARK = 'SWEEP-COMPOSER-u2p8 please tidy the queue rail';
const ELICIT_MARK = 'SWEEP-ELICIT-ACCEPT-v4n7';
const RENAME_MARK = 'SWEEP-RENAME-j9x3';
const MOD_MARK = 'SWEEP-MODSTEP-g1b6';
const FILE_BEFORE = 'SWEEP-FILE-BEFORE-e2a5';
const FILE_AFTER = 'SWEEP-FILE-AFTER-e2a6';

const S1 = '11111111-1111-4111-8111-111111111175';
const S2 = '22222222-2222-4222-8222-222222222275';
const FORKED = '99999999-9999-4999-8999-999999999975';
const AGENT = 'a0123456789ab7575';
const TASK2 = 'b75shell01';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const SETTLE_WAIT = { timeout: 25000, interval: 10 };
const RAISED_WAIT_MS = 60000;
const PEER = '192.168.1.75';
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

// The home directory, both spellings (macOS tmp dirs answer /private/var/…).
const HOMES = () => [...new Set([process.env.HOME, realpath(process.env.HOME)].filter(Boolean))];

// ── the stub claude ──────────────────────────────────────────────────────────

const FAKE_CLAUDE = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + '\\n');
if (argv[0] === 'agents') process.stdout.write('[]\\n');
else if (argv.includes('--fork-session')) process.stdout.write(JSON.stringify({ type: 'result', session_id: ${JSON.stringify(FORKED)} }) + '\\n');
`;

function stubClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sweep-claude-'));
  const script = path.join(dir, 'fake-claude.js');
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(script, FAKE_CLAUDE);
  fs.writeFileSync(log, '');
  const stub = fakeBin(t, { name: 'claude', script, env: { ARGV_LOG: log } });
  const before = process.env.PATH;
  process.env.PATH = `${stub.dir}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return { argvs: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

// mod-cli.test.js's injected runClaude, in its one shape this file needs: a
// Claude Code new enough for the mod, whose plugin commands all succeed.
function modClaude() {
  return (argv) => {
    if (argv[0] === '--version') return { ok: true, stdout: '2.1.296 (Claude Code)\n' };
    if (argv[0] === 'plugin' && argv[1] === 'validate') return { ok: true, stdout: 'Validation passed\n' };
    if (argv[0] === 'plugin' && argv[1] === 'test') return { ok: true, stdout: 'Usage: claude plugin test\n' };
    if (argv[0] === 'plugin') return { ok: true, stdout: 'Done\n{"ok":true}\n' };
    return { ok: false, stderr: `not played: ${argv.join(' ')}` };
  };
}

// ── raw HTTP (headers the test sets itself) ──────────────────────────────────

function raw(port, { method = 'GET', path: p = '/', headers = {}, body = null, timeout = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', (e) => resolve({ status: 'error', text: String(e && e.message), json: null }));
    });
    r.setTimeout(timeout, () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: /timeout/.test(String(e && e.message)) ? 'timeout' : 'error', text: '', json: null }));
    if (data != null) r.write(data);
    r.end();
  });
}

// Requests carrying x-test-peer arrive from that address (§10.1's network
// peer), the WebSocket upgrade too.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  const onUpgrade = (req) => {
    const addr = req.headers['x-test-peer'];
    if (addr) Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
  };
  server.prependListener('request', onRequest);
  server.prependListener('upgrade', onUpgrade);
  return () => { server.off('request', onRequest); server.off('upgrade', onUpgrade); };
}

// ── finding what must not be there ───────────────────────────────────────────

const HEXISH = /^[0-9a-fA-F-]{8}$/;

// findLeaks over `hay`, with the hex allowance in the file's header: a hit
// whose window is all hex counts only when 12 characters of the value are
// there; it is blanked and the fake searched again, so a real leak behind a
// chance collision is still found.
function leaksIn(hay, fakes = SCAN) {
  let h = typeof hay === 'string' ? hay : JSON.stringify(hay);
  if (h == null) return [];
  const out = [];
  let pending = fakes;
  for (let round = 0; round < 64 && pending.length; round++) {
    const found = findLeaks(h, pending);
    const next = [];
    for (const l of found) {
      const w = h.slice(l.at, l.at + 8);
      const f = pending.find((x) => x.id === l.id);
      if (HEXISH.test(w) && !findLeaks(h, [f], { window: 12 }).length) {
        h = `${h.slice(0, l.at)}${'\u0000'.repeat(8)}${h.slice(l.at + 8)}`;
        next.push(f);
      } else {
        out.push({ id: l.id, rule: l.rule, window: w });
      }
    }
    pending = next;
  }
  return out;
}

const plantedIn = (hay) => {
  const h = typeof hay === 'string' ? hay : JSON.stringify(hay);
  return PLANTED.filter((p) => p.secrets.some((s) => h.includes(s))).map((p) => p.id);
};
// Claude Code's task outputs live in its own tmp directory (/tmp/claude-<uid>,
// never under HOME on a real machine); test-support/claude-home stands that
// directory in under the sandbox, so its path is set aside before the home
// search (STANDINS, both spellings, filled by the scenario).
const STANDINS = [];
const homeIn = (hay) => {
  let h = typeof hay === 'string' ? hay : JSON.stringify(hay);
  for (const d of STANDINS) h = h.split(d).join('<claude-tmp>');
  return HOMES().filter((d) => h.includes(d));
};
const say = (carrier, level, rule, detail) => `seed ${SEED} · ${carrier} · level ${level} · rule ${rule}: ${detail}`;

// ── the route scan ───────────────────────────────────────────────────────────

// Every route the daemon mounts, as test/remote-policy.test.js daemonRoutes()
// finds them (its one regex, reproduced: requiring that file would run its
// tests), plus the GETs mounted through a helper or a constant, which that
// regex cannot see: mirror-query's jsonRoute(host, '<path>', …) and
// app.get(NAME, …) where NAME is a string constant in the same file.
const ROUTE_RE = /\bapp\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]*)\2/g;
const JSON_ROUTE_RE = /\bjsonRoute\(\s*\w+\s*,\s*(['"`])([^'"`]*)\1/g;
const CONST_GET_RE = /\bapp\.get\(\s*([A-Z_][A-Z0-9_]*)\s*,/g;

function daemonGetRoutes() {
  const files = fs.readdirSync(path.join(REPO, 'lib/server/routes'))
    .filter((f) => f.endsWith('.js')).map((f) => `lib/server/routes/${f}`);
  files.push('lib/server/index.js');
  const out = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const m of src.matchAll(ROUTE_RE)) {
      const verb = m[1];
      const method = verb === 'use' || verb === 'all' ? '*' : verb.toUpperCase();
      if (method === 'GET' || method === '*') out.push({ method, path: m[3], file: rel, via: 'app' });
    }
    for (const m of src.matchAll(JSON_ROUTE_RE)) out.push({ method: 'GET', path: m[2], file: rel, via: 'jsonRoute' });
    for (const m of src.matchAll(CONST_GET_RE)) {
      const def = new RegExp(`\\b(?:const|let)\\s+${m[1]}\\s*=\\s*(['"\`])([^'"\`]*)\\1`).exec(src);
      out.push({ method: 'GET', path: def ? def[2] : `<unresolved ${m[1]}>`, file: rel, via: 'const' });
    }
  }
  return out;
}

// The GET routes the sweep does not request, each with its reason. It may
// only shrink: an entry that names no mounted route fails the test.
const SKIP = Object.freeze({
  '/api/events/stream': 'an event stream that never ends: read through openSSE for the whole scenario instead (the `sse` carrier)',
  '/api/bridge/ops': 'the mod\'s token-held long-poll: driven through the fake mod, whose every op is recorded (the `bridge ops` host carrier)',
});

// The routes whose paths take parameters: what the sweep fills them with, from
// the scenario's own ids. A parameterised GET route in neither this nor SKIP
// fails the test — so a later one is added here with ids that reach it.
const FILL = {
  '/api/asks/:id/decision': (s) => s.askIds.map((id) => `/api/asks/${id}/decision`),
  '/brand/:slot': () => ['/brand/lockup', '/brand/seal'],
  '/api/captures/:id/raw': () => ['/api/captures/sweep-none/raw'],
  '/api/captures/:id/simplified': () => ['/api/captures/sweep-none/simplified'],
  '/api/components/:name/seed': () => ['/api/components/file-editor/seed', '/api/components/git-dashboard/seed'],
  '/api/components/:name': () => ['/api/components/file-editor', '/api/components/git-dashboard'],
  '/api/services/pack/:name': () => ['/api/services/pack/sweep-pack'],
  '/api/export/:ref': (s) => [...s.nodeLabels.map((l) => `/api/export/${l}`), '/api/export/live', '/api/export/active'],
  '/extensions/${name}/files': () => ['/extensions/sample/files/', '/extensions/sample/files/manifest.json'],
  '/extensions/:name/download': () => ['/extensions/sample/download'],
  '/extensions/:name': () => ['/extensions/sample'],
  '/api/graph/node/:id': (s) => s.nodeIds.map((id) => `/api/graph/node/${encodeURIComponent(id)}`),
  '/preview/node/:id': (s) => s.nodeIds.map((id) => `/preview/node/${encodeURIComponent(id)}`),
  '/preview/pane/:node/:mount': (s) => s.panes.map(([n, m]) => `/preview/pane/${encodeURIComponent(n)}/${encodeURIComponent(m)}`),
  '/api/mounts/:id/history': (s) => s.mountIds.map((id) => `/api/mounts/${encodeURIComponent(id)}/history`),
  '/api/packs/quarantine/:name/review': () => ['/api/packs/quarantine/sweep-pack/review'],
  '/api/packs/quarantine/:name/logo': () => ['/api/packs/quarantine/sweep-pack/logo'],
  '/api/replay/file/:name': () => ['/api/replay/file/sweep.gif'],
  '/api/mirror/conversations/:cid/turns': (s) => [S1, S2].flatMap((c) => [
    `/api/mirror/conversations/${c}/turns?limit=50&items=full`, `/api/mirror/conversations/${c}/turns?limit=50&items=summary`]),
  '/api/mirror/turns/:turnId': (s) => s.turnIds.map((id) => `/api/mirror/turns/${encodeURIComponent(id)}`),
  '/api/mirror/items/:itemId': (s) => s.itemIds.flatMap((id) => ['text', 'input', 'result']
    .map((field) => `/api/mirror/items/${encodeURIComponent(id)}?field=${field}`)),
  '/api/mirror/items/:itemId/attachments/:n': (s) => s.itemIds.slice(0, 4).map((id) => `/api/mirror/items/${encodeURIComponent(id)}/attachments/0`),
  '/api/mirror/tasks/:taskId/output': () => [`/api/mirror/tasks/${TASK2}/output`],
  '/api/mirror/agents/:agentId': () => [`/api/mirror/agents/${AGENT}`],
  '/api/mirror/workflows/:runId': () => ['/api/mirror/workflows/wf-sweep-none'],
  '/api/mirror/node/:ref': (s) => [...s.nodeLabels, 'live'].map((l) => `/api/mirror/node/${encodeURIComponent(l)}`),
};

// More than one request for a parameter-free route: its queries.
const QUERIES = {
  '/api/asks': () => ['/api/asks', '/api/asks?ensure=1'],
  '/api/mirror/diff': (s) => ['/api/mirror/diff?turn=p1', ...s.nodeLabels.slice(0, 3).map((l) => `/api/mirror/diff?node=${l}`)],
  '/api/code/preview': (s) => ['/api/code/preview?turn=p1', ...s.nodeLabels.slice(0, 2).map((l) => `/api/code/preview?node=${l}`)],
  '/api/mirror/context': () => [`/api/mirror/context?conversation=${S2}`, `/api/mirror/context?conversation=${S1}`],
  '/api/files': () => ['/api/files?q=app', '/api/files?q=env', '/api/files?q=attach'],
  '/api/graph/diff': (s) => (s.nodeLabels.length >= 2 ? [`/api/graph/diff?a=${s.nodeLabels[0]}&b=${s.nodeLabels.at(-1)}`] : ['/api/graph/diff']),
  '/api/replay/path': (s) => ['/api/replay/path', `/api/replay/path?from=${s.nodeLabels[0]}`],
  '/api/replay/html': (s) => ['/api/replay/html', `/api/replay/html?from=${s.nodeLabels[0]}&include_prompts=1`],
  '/replay': (s) => ['/replay', `/replay?from=${s.nodeLabels[0]}&include_prompts=1`],
  '/api/events': () => ['/api/events?since=0'],
  '/embed-helper/files': () => ['/embed-helper/files/', '/embed-helper/files/manifest.json'],
};

// The concrete GET targets for the scenario `s`: {route, url}. Throws for a
// mounted route that is neither requested nor skipped.
function getTargets(s) {
  const routes = daemonGetRoutes();
  const seen = new Set();
  const out = [];
  const missing = [];
  for (const r of routes) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    if (SKIP[r.path]) continue;
    let urls;
    if (FILL[r.path]) urls = FILL[r.path](s);
    else if (QUERIES[r.path]) urls = QUERIES[r.path](s);
    else if (/[:$<]/.test(r.path)) { missing.push(`${r.method} ${r.path} (${r.file})`); continue; }
    else urls = [r.path];
    for (const url of urls) out.push({ route: r.path, url });
  }
  return { targets: out, missing, routes };
}

// ── the reasoned home-path allowlist (ruling E6 (a), notes-E Q8) ─────────────

// The carriers clause (4) names: in them a home path is a leak, never allowed.
const HOME_SCOPE_ROUTE = /^\/(?:api\/(?:mirror|asks|control|code|queue|files|skills|attachments|bridge|graph)(?:[/?]|$)|answer\/)/;
const HOME_SCOPE_FILE = /^(?:mirror|asks|control|mod|attachments|graph)(?:\/|$)/;
// Outside that scope, a local response or a file that shows the home path
// must be named here with its reason, or the test fails; an entry that
// excuses nothing in a run fails as stale. It may only shrink.
const PRE_085_LOCAL = 'pre-0.8.5, local by design (ruling E6 (a)); a remote request gets it through redactHostPaths';
const HOME_ALLOW = [
  { kind: 'response', match: '/api/services/pending', reason: `the service-trust listing (0.3.0) names each pending service's project root — ${PRE_085_LOCAL} (routes/components.js)` },
  { kind: 'response', match: '/api/services/pack/:name', reason: `trust --pack's listing (0.8.2) names the project root — ${PRE_085_LOCAL} (routes/components.js)` },
  { kind: 'response', match: '/api/packs', reason: `the pack listing (0.6.0) names install paths — ${PRE_085_LOCAL} (routes/packs.js)` },
  // Machine-dependent (judged only when it shows one): the local answer names
  // where Chrome and ffmpeg are installed, which is under HOME on a machine
  // with a per-user Chrome (~/Applications); a remote one says only whether.
  { kind: 'response', match: '/api/replay/capabilities', optional: true, reason: `the replay's capabilities (0.8.0) name the Chrome and ffmpeg found on this machine — ${PRE_085_LOCAL} (routes/replay.js)` },
  { kind: 'response', match: '/api/machine/sessions', reason: `the Sessions panel (0.8.0) lists every web-chat on this machine with its root — ${PRE_085_LOCAL}` },
  // Only after srv.stop(): gracefulShutdown releases the portfile (release()).
  { kind: 'file', match: 'server.json', teardown: 'stop', reason: 'the portfile (pre-0.8.5): the daemon\'s discovery record names its root, which the CLI, the hooks and the portal read to find it' },
];

// ── the scenario ─────────────────────────────────────────────────────────────

// A socket that records every frame, each tagged with the level the socket
// was at when it came (the level it opened at, then each mirror:access).
async function socket(t, port, name, { headers, level = 'local', full = true } = {}) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const rec = { name, level, frames: [] };
  ws.on('message', (data) => {
    let f = null;
    try { f = JSON.parse(data.toString()); } catch { return; }
    if (f && f.type === 'mirror:access' && typeof f.level === 'string') rec.level = f.level;
    rec.frames.push({ level: rec.level, frame: f, text: data.toString() });
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => rec.frames.some((x) => x.frame.type === 'hello'), { ...WAIT, what: `${name}'s hello` });
  if (full) ws.send(JSON.stringify({ type: 'client', mirror: 'full' }));
  rec.ws = ws;
  rec.of = (type) => rec.frames.filter((x) => x.frame.type === type).map((x) => x.frame);
  return rec;
}

// A hook subcommand as Claude Code runs it: a child, the payload on stdin.
function runHook(root, sub, payload, env) {
  const child = spawn(process.execPath, [HOOK_BIN, sub], { cwd: root, env });
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
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
  });
  child.stdin.end(JSON.stringify(payload));
  return { child, done };
}

const nonceOf = (text) => { const m = /name="wc-answer-nonce" content="([^"]*)"/.exec(text || ''); return m ? m[1] : null; };

// Every file under `dir`, as {rel: Buffer}. The shadow repository's object
// store is read through git instead (its objects are compressed).
function filesUnder(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (/^mirror\/git\/objects\/(?:[0-9a-f]{2}|pack)$/.test(rel)) continue;
        walk(p);
      } else if (e.isFile()) out[rel] = fs.readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

async function runScenario(t, teardown) {
  const cap = {
    teardown, frames: [], sse: [], events: [], responses: [], answers: [], host: [], logs: [], files: {},
    gitObjects: '', notes: {}, hooks: [],
  };
  // The daemon's log (server.log in production: its stderr), captured.
  const realError = console.error;
  console.error = (...a) => { cap.logs.push(a.map(String).join(' ')); };
  t.after(() => { console.error = realError; });

  // The project, under the sandbox HOME: a repository with a tracked source
  // file and an untracked .env.
  assert.equal(process.env.HOME, SANDBOX, 'precondition: HOME is the sandbox (the project and the Claude tier live under it)');
  fs.mkdirSync(path.dirname(userPaths().tunnelConfig), { recursive: true });
  writeJsonAtomic(userPaths().tunnelConfig, TUNNEL);
  const repo = treesnapRepo(t, { files: {
    'src/app.js': `// ${FILE_BEFORE}\nconst answer = 41;\nmodule.exports = { answer };\n`,
    'README.md': 'sweep scratch\n',
  } });
  const root = repo.root;
  assert.ok(HOMES().some((h) => root.startsWith(h)), `precondition: the project ${root} is under the sandbox HOME`);
  repo.write('.env', fake('env-dotenv').text);
  const claude = stubClaude(t);
  const ch = claudeHome(t, { root, isolate: true });
  STANDINS.length = 0;
  STANDINS.push(...new Set([ch.tmpDir, realpath(ch.tmpDir)].filter(Boolean)));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const procs = await sampleProcs([process.pid, child.pid]);
  const START = { [S1]: formatProcStart(procs.get(process.pid).startedAt), [S2]: formatProcStart(procs.get(child.pid).startedAt) };
  const PID = { [S1]: process.pid, [S2]: child.pid };
  ch.writeSession({ pid: PID[S1], procStart: START[S1], sessionId: S1, status: 'idle' });
  ch.writeSession({ pid: PID[S2], procStart: START[S2], sessionId: S2, status: 'idle' });
  const session = (sid, status) => ch.writeSession({ pid: PID[sid], procStart: START[sid], sessionId: sid, status, updatedAt: Date.now(), statusUpdatedAt: Date.now() });

  const ctx = await withServer(t, {
    root, writePortfile: true, home: false,
    createServer: (o) => createServer({ ...o, modPermissionWait: RAISED_WAIT_MS }),
  });
  await ctx.srv.controlStarted;
  t.after(stubPeers(ctx.server));
  const port = ctx.port;
  const call = { port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const get = (p) => client.get(p, call);
  const post = (p, body) => client.post(p, body, call);
  const LOCAL_ORIGIN = { origin: `http://localhost:${port}` };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envOf = (sid) => ({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(PID[sid]) });
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({ hook_event_name: event, session_id: sid,
    transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default', ...extra }, envOf(sid), { now: stamp() });
  const fire = async (event, extra, sid = S1) => {
    assert.equal(await postEnvelope(envelope(event, extra, sid), { root, timeout: CALL_TIMEOUT_MS }), 'posted', `${event} (${sid})`);
  };
  const turnBegin = (promptId, text, sid = S1) => {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt });
  };
  const turnEnd = (reply, sid = S1) => {
    const e = envelope('Stop', { last_assistant_message: reply }, sid);
    return post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message });
  };
  const hookEnv = (sid = S1) => {
    const e = { ...process.env, ...envOf(sid) };
    delete e.WEB_CHAT_HOOK_LOG;
    return e;
  };
  const conversation = async (cid) => ((await get('/api/mirror')).conversations || []).find((c) => c.id === cid) || null;
  const turnsOf = (cid, items = 'full') => get(`/api/mirror/conversations/${cid}/turns?limit=50&items=${items}`);
  const closedTurn = (cid, id, what) => waitUntil(async () => {
    const p = await turnsOf(cid);
    const x = (p.turns || []).find((y) => y.id === id);
    return x && x.status !== 'open' && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: what || `${cid}'s turn ${id} closed with the transcript's reply` });
  const snapshots = async () => {
    const s = await get('/api/mirror');
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };
  const answerOrigin = async () => {
    const a = await get('/api/asks?ensure=1');
    assert.ok(a.answer && Number.isInteger(a.answer.port), `the answer surface listens: ${JSON.stringify(a.answer)}`);
    return { port: a.answer.port, origin: `http://127.0.0.1:${a.answer.port}` };
  };
  const controlFrame = async (action, params, layout = 'confirm') => {
    const ao = await answerOrigin();
    const q = new URLSearchParams({ ...params, layout, mode: 'light' });
    const doc = await raw(ao.port, { path: `/answer/control/${action}?${q}` });
    cap.answers.push({ who: 'local', url: `/answer/control/${action}?${q}`, status: doc.status, text: doc.text });
    assert.equal(doc.status, 200, `${action}'s document: ${doc.text.slice(0, 200)}`);
    const nonce = nonceOf(doc.text);
    assert.ok(nonce, `a nonce minted for ${action}`);
    return { ...ao, nonce };
  };
  const act = async (f, action, body) => {
    const r = await raw(f.port, {
      method: 'POST', path: `/answer/api/control/${action}`, body,
      headers: { origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': f.nonce },
    });
    cap.answers.push({ who: 'local', url: `POST /answer/api/control/${action}`, status: r.status, text: r.text });
    return r;
  };
  const askFrame = async (id) => {
    const ao = await answerOrigin();
    const doc = await raw(ao.port, { path: `/answer/ask/${id}?layout=card&mode=light` });
    cap.answers.push({ who: 'local', url: `/answer/ask/${id}`, status: doc.status, text: doc.text });
    assert.equal(doc.status, 200, doc.text.slice(0, 200));
    const nonce = nonceOf(doc.text);
    const view = await raw(ao.port, { path: `/answer/api/asks/${id}?v=0`, headers: { 'x-wc-answer': nonce } });
    cap.answers.push({ who: 'local', url: `/answer/api/asks/${id}?v=0`, status: view.status, text: view.text });
    assert.equal(view.status, 200, view.text);
    return { ...ao, nonce, view: view.json };
  };
  const decide = async (f, id, decision) => {
    const r = await raw(f.port, {
      method: 'POST', path: `/answer/api/asks/${id}/decide`,
      headers: { origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': f.nonce },
      body: { decision, version: f.view.version, device: 'desktop' },
    });
    cap.answers.push({ who: 'local', url: `POST /answer/api/asks/${id}/decide`, status: r.status, text: r.text });
    return r;
  };
  const host = (what, value) => cap.host.push({ what, text: typeof value === 'string' ? value : JSON.stringify(value) });

  // ── the sockets and the event stream ──
  const sockets = [];
  const local = await socket(t, port, 'local', { level: 'local' });
  sockets.push(local);
  const remoteHeaders = { 'X-WC-Remote': '1' };
  sockets.push(await socket(t, port, 'remote (opened at basic)', { headers: remoteHeaders, level: 'basic' }));
  const sse = await openSSE(port, {});
  t.after(() => sse.close());
  const eventPages = async () => { cap.events.push(await get('/api/events?since=0')); };

  // ── S1: the transcript's head, then a closed turn the engine reads first ──
  const r1 = createRecords({ seed: SEED, sessionId: S1, cwd: ch.cwd, start: Date.now() - 600000, step: 50 });
  r1.sessionContext({ userEmail: EMAIL, rendered: `Session context for ${EMAIL}: ${fake('sk-anthropic-oauth').text}` });
  r1.credentialOrg(ORG);
  r1.attachment('prompt_snapshot', { content: `snapshot ${fake('sk-openrouter').text}` });
  r1.attachment('instructions', { content: `instructions ${fake('slack-app').text}` });
  r1.queueOperation('enqueue', { content: `queued ${fake('github-gho').text}` });
  r1.promptImage(`warm up ${PROMPT_MARK}`, { promptId: 'p0' });
  r1.assistant([`${REPLY_MARK} warmed up.`]);
  r1.turnDuration({ durationMs: 20, messageCount: 2 });
  ch.writeTranscript(S1, r1.records);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await closedTurn(S1, 'p0', 'the transcript\'s head read (the known values registered)');
  // With the head read, the known values are registered (§5.5).

  // ── S1 · p1: a turn whose every carrier holds a fake ──
  const PROMPT1 = `${PROMPT_MARK} deploy as ${EMAIL} for org ${ORG} with ${fake('sk-anthropic-api').text} and ${fake('github-ghp').text}`;
  const seen = await snapshots();
  const b1 = await turnBegin('p1', PROMPT1);
  assert.equal(b1.ok, true, JSON.stringify(b1));
  await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: 'p1\'s before-snapshot' });
  const appJs = path.join(root, 'src', 'app.js');
  const envFile = path.join(root, '.env');
  const BASH1 = 'toolu_01SweepBash';
  const EDIT1 = 'toolu_01SweepEdit';
  const WRITE1 = 'toolu_01SweepWrite';
  const READ1 = 'toolu_01SweepRead';
  const BIG1 = 'toolu_01SweepBig';
  const AGENT1 = 'toolu_01SweepAgent';
  const bashInput = { command: fake('cli-flag-token').text, description: 'Deploy' };
  const editInput = { file_path: appJs, old_string: fake('assign-js').text, new_string: fake('x-api-key').text };
  const writeInput = { file_path: envFile, content: fake('env-line-plain').text };
  await fire('PreToolUse', { tool_name: 'Bash', tool_use_id: BASH1, tool_input: bashInput });
  await fire('PostToolUse', { tool_name: 'Bash', tool_use_id: BASH1, tool_input: bashInput,
    tool_response: { stdout: `${TOOLOUT_MARK}\n${fake('pem-rsa').text}\n${fake('cookie-set').text}`, stderr: fake('assign-shell').text }, duration_ms: 9 });
  await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: EDIT1, tool_input: editInput });
  repo.write('src/app.js', `// ${FILE_AFTER}\nconst answer = 42;\nmodule.exports = { answer };\n`);
  await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: EDIT1, tool_input: editInput, tool_response: { filePath: appJs }, duration_ms: 3 });
  await fire('PreToolUse', { tool_name: 'Write', tool_use_id: WRITE1, tool_input: writeInput });
  repo.write('.env', fake('env-line-plain').text);
  await fire('PostToolUse', { tool_name: 'Write', tool_use_id: WRITE1, tool_input: writeInput, tool_response: { filePath: envFile }, duration_ms: 2 });
  await post('/api/render', { id: 'sweep-p1', html: '<p>the sweep\'s first pane</p>' });

  // The transcript's copy of p1, every NEVER_EMIT field filled.
  const n0 = r1.records.length;
  r1.prompt(PROMPT1, { promptId: 'p1' });
  r1.assistant([
    { type: 'thinking', thinking: `${THINK_MARK} ${fake('sk-openai-project').text} ${fake('google-api-key').text}`, signature: fake('sk-openai-service').secrets[0] },
    `${REPLY_MARK} I will deploy with ${fake('slack-bot').text} and ${fake('stripe-sk-live').text}.`,
    { type: 'tool_use', name: 'Bash', input: bashInput, id: BASH1 },
  ], { extra: { wireToolInputs: { [BASH1]: { command: fake('curl-user').text } } } });
  r1.toolResult(BASH1, `${TOOLOUT_MARK}\n${fake('pem-rsa').text}\n${fake('cookie-set').text}`, {
    stdout: `${TOOLOUT_MARK} ${fake('bearer-basic').text}`, stderr: fake('assign-shell').text });
  r1.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: appJs }, id: READ1 }]);
  r1.toolResult(READ1, `     1→// ${FILE_BEFORE}\n     2→${fake('env-line-numbered').text}`, {
    toolUseResult: { type: 'text', file: { filePath: appJs, content: fake('assign-python').text, numLines: 3 } } });
  r1.assistant([{ type: 'tool_use', name: 'Edit', input: editInput, id: EDIT1 }]);
  r1.toolResult(EDIT1, `The file ${appJs} has been updated.`, {
    filePath: appJs,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${fake('assign-js').text}`, `+${fake('x-api-key').text}`] }],
    toolUseResult: { originalFile: `${fake('assign-quoted-phrase').text}\n`, oldString: editInput.old_string, newString: editInput.new_string } });
  r1.assistant([{ type: 'tool_use', name: 'Write', input: writeInput, id: WRITE1 }]);
  r1.toolResult(WRITE1, `File created successfully at: ${envFile}`, { toolUseResult: { type: 'create', filePath: envFile, content: writeInput.content } });
  // A result too big for the transcript: the rest in a tool-results file.
  const bigFile = path.join(ch.sessionDir(S1), 'tool-results', `${BIG1}.txt`);
  fs.mkdirSync(path.dirname(bigFile), { recursive: true });
  fs.writeFileSync(bigFile, `${TOOLOUT_MARK} big output\n${fake('pem-openssh').text}\n${fake('npm').text}\n${fake('huggingface').text}\n${'filler line\n'.repeat(400)}`);
  r1.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm ls --all', description: 'List' }, id: BIG1 }]);
  r1.toolResult(BIG1, `<persisted-output>\nOutput too large (40KB). Full output saved to: ${bigFile}\n\nPreview (first 2KB):\n${TOOLOUT_MARK} big output\n${fake('pem-openssh').text}\n</persisted-output>`, {
    persistedOutputPath: bigFile, persistedOutputSize: 40000 });
  // A subagent, launched in the background, its own file holding fakes.
  const fx = agentFixtures(ch, S1);
  fx.agentCall(r1, { toolUseId: AGENT1, description: 'Check the rail', prompt: `${SUBAGENT_MARK} look with ${fake('github-pat').text}`, runInBackground: true });
  fx.asyncLaunched(r1, AGENT1, { agentId: AGENT, description: 'Check the rail' });
  r1.assistant([`${REPLY_MARK} done: ${fake('url-creds-postgres').text}`]);
  r1.turnDuration({ durationMs: 900, messageCount: 12 });
  ch.appendTranscript(S1, r1.records.slice(n0));
  fx.writeAgentMeta(AGENT, { description: 'Check the rail', toolUseId: AGENT1 });
  const a = fx.agentRecords({ agentId: AGENT, seed: SEED + 1 });
  a.prompt(`${SUBAGENT_MARK} look with ${fake('github-pat').text}`, { promptId: 'p-agent' });
  a.assistant([`${SUBAGENT_MARK} found ${fake('slack-webhook').text}`, { type: 'tool_use', name: 'Bash', input: { command: fake('cli-flag-client-secret').text }, id: 'toolu_01SubSweep' }], { model: 'claude-haiku-5' });
  a.toolResult('toolu_01SubSweep', `${SUBAGENT_MARK} ${fake('stripe-whsec').text}`);
  fx.writeAgent(AGENT, a.records);
  const end1 = await turnEnd(`${REPLY_MARK} done: ${fake('google-oauth-token').text}`);
  assert.ok(end1.node_id, `p1 committed a node: ${JSON.stringify(end1)}`);
  await closedTurn(S1, 'p1');
  await waitUntil(async () => {
    const p = await turnsOf(S1, 'summary');
    const x = (p.turns || []).find((y) => y.id === 'p1');
    return x && x.code && x.code.status === 'ready';
  }, { ...WAIT, what: 'p1\'s code' });
  await waitUntil(async () => {
    const r = await raw(port, { path: `/api/mirror/agents/${AGENT}` });
    return r.status === 200 && r.text.includes(SUBAGENT_MARK);
  }, { ...WAIT, what: 'the subagent\'s stream' });

  // ── S1: an ask whose Bash subject holds a key, decided through the answer origin ──
  const askRun = runHook(root, 'ask', { session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    hook_event_name: 'PermissionRequest', prompt_id: 'p1', permission_mode: 'default', tool_name: 'Bash',
    tool_input: { command: fake('bearer-header').text, description: 'Call the API' } }, hookEnv(S1));
  const ask = await waitUntil(async () => ((await get('/api/asks')).asks || []).find((x) => x.kind === 'permission' && x.state === 'pending') || null,
    { ...WAIT, what: 'the pending ask' });
  const askF = await askFrame(ask.id);
  const askDec = await decide(askF, ask.id, { behavior: 'allow' });
  assert.equal(askDec.status, 200, askDec.text);
  cap.hooks.push({ what: 'ask', ...(await askRun.done) });

  // ── S1: an elicitation, accepted with a marker ──
  const ELICIT_SCHEMA = { type: 'object', properties: { answer: { type: 'string', title: 'Answer',
    description: `Paste the value (${fake('google-client-secret').text})` } }, required: ['answer'] };
  const elRun = runHook(root, 'elicit', { session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    hook_event_name: 'Elicitation', mcp_server_name: 'scratch', message: `Confirm the key ${fake('sk-openai-legacy').text}`,
    mode: 'form', elicitation_id: 'el-sweep', requested_schema: ELICIT_SCHEMA }, hookEnv(S1));
  const el = await waitUntil(async () => ((await get('/api/asks')).asks || []).find((x) => x.kind === 'elicitation' && x.state === 'pending' && x.answerable) || null,
    { ...WAIT, what: 'the elicitation ask' });
  const elF = await askFrame(el.id);
  const elDec = await decide(elF, el.id, { behavior: 'accept', content: { answer: ELICIT_MARK } });
  assert.equal(elDec.status, 200, elDec.text);
  const elOut = await elRun.done;
  assert.ok(elOut.stdout.includes(ELICIT_MARK), 'precondition: the accepted value reached the hook (and Claude Code)');
  cap.notes.elicitOut = elOut.stdout;

  // ── S1: a composer message (held), its marker and an @ file ──
  const held = await client.request(port, 'POST', '/api/queue/message',
    { text: `${MSG_MARK} @src/app.js`, files: ['src/app.js'], send: 'hold', conversation_id: S1 }, { headers: LOCAL_ORIGIN, timeout: CALL_TIMEOUT_MS });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.ok, true, JSON.stringify(held.body));
  cap.notes.heldId = held.body.id;

  // ── S1: a restore of p1 and its undo, through the answer origin ──
  const pv = await get('/api/code/preview?turn=p1');
  assert.equal(pv.ok, true, JSON.stringify(pv));
  const restored = await act(await controlFrame('restore', { preview_id: pv.preview_id }), 'restore', { preview_id: pv.preview_id });
  assert.equal(restored.status, 200, restored.text);
  const undone = await act(await controlFrame('undo', { restore_id: 'latest' }), 'undo', { restore_id: 'latest' });
  assert.equal(undone.status, 200, undone.text);
  // The notices claim, as the next turn-begin hook makes it (host-only).
  host('POST /api/control/notices/claim', await post('/api/control/notices/claim', { session_id: S1, claude_pid: PID[S1], max_chars: 4000 }));

  // ── S1: a fork of p1 against the stub claude ──
  const forked = await act(await controlFrame('fork', { turn_id: 'p1' }), 'fork', { turn_id: 'p1' });
  assert.equal(forked.status, 200, forked.text);
  cap.notes.forkArgv = claude.argvs().filter((x) => x.includes('--fork-session'));
  assert.equal(cap.notes.forkArgv.length, 1, 'the stub ran one fork');

  // ── S1 · p2: a Stop that takes the hook halt, then the turn closing ──
  session(S1, 'busy');
  await turnBegin('p2', `${PROMPT_MARK} run the slow tests with ${fake('aws-akia').text}`);
  await fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_01SweepSlow', tool_input: { command: 'npm test' } });
  await post('/api/render', { id: 'sweep-p2', html: '<p>running</p>' });
  await waitUntil(async () => { const c = await conversation(S1); return c && c.live && c.live.state === 'working'; }, { ...WAIT, what: 'S1 working' });
  const stopped = await act(await controlFrame('interrupt', { conversation_id: S1 }, 'stop'), 'interrupt', { conversation_id: S1, mode: 'now' });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.via, 'hook', `a Stop with no tty row and no mod takes the hook halt: ${stopped.text}`);
  const flag = userPaths().haltFlag(S1);
  assert.ok(fs.existsSync(flag), 'the halt flag is written');
  const addedBefore = local.of('node-added').length;
  session(S1, 'idle'); // the turn ends at the halt: busy → idle, no Stop
  await waitUntil(() => local.of('node-added').length > addedBefore, { ...SETTLE_WAIT, what: 'the guard\'s commit of p2' });
  cap.notes.flagAfterTurn = await waitUntil(() => !fs.existsSync(flag), { ...WAIT, what: 'the halt flag gone once p2 closed' })
    .then(() => fs.existsSync(flag)).catch(() => fs.existsSync(flag));
  await waitUntil(async () => !(await get('/api/graph')).lock, { ...WAIT, what: 'the lock released' });

  // ── S2: a background shell, then a fake mod ──
  const r2 = createRecords({ seed: SEED + 2, sessionId: S2, cwd: ch.cwd, start: Date.now() - 300000, step: 50 });
  const taskFile = ch.writeTaskOutput(S2, TASK2, `${TOOLOUT_MARK} serving\n${fake('messaging-token').text}\n${fake('cloudflare-tunnel').text}\n${fake('aws-secret').text}\n${fake('assign-yaml').text}\n`);
  r2.prompt('start the dev server', { promptId: 's2-p0' });
  r2.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run dev', description: 'Start', run_in_background: true }, id: 'toolu_01Dev75' }]);
  r2.toolResult('toolu_01Dev75', `Command running in background with ID: ${TASK2}. Output is being written to: ${taskFile}.`, { taskId: TASK2 });
  r2.assistant(['Started.']);
  r2.turnDuration({ durationMs: 50, messageCount: 4 });
  ch.writeTranscript(S2, r2.records);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' }, S2);
  await waitUntil(async () => ((await get('/api/mirror/tasks')).tasks || []).some((x) => x.id === TASK2 && x.status === 'running'),
    { ...WAIT, what: 'S2\'s running shell' });
  const mod = fakeMod({ port, sessionId: S2, root });
  t.after(() => mod.close());
  const hi = await mod.hello();
  assert.equal(hi.status, 200, JSON.stringify(hi.body));
  host('POST /api/bridge/hello', hi.body);
  const ops = [];
  const handlers = {
    abort: () => ({ aborted: true, stopped: ['b75abort1'] }),
    taskStop: () => ({ stopped: true }),
    submit: () => ({ submitted: true }),
    command: () => ({ ran: true }),
    fill: () => ({ filled: true }),
    permissionDecision: () => ({}),
    usage: () => ({}),
    messages: () => ({}),
  };
  const wrapped = {};
  for (const name of OPS) wrapped[name] = (args, op) => { ops.push({ op: op.op, args }); return handlers[name] ? handlers[name](args, op) : {}; };
  mod.runOps(wrapped, { wait: 200 });
  cap.notes.ops = ops;
  await waitUntil(() => local.of('mirror:reset').some((f) => f.conversation_id === S2), { ...WAIT, what: 'S2\'s catch-up' });

  // An image, uploaded from the chrome's origin.
  const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(48, 7)]);
  const up = await raw(port, { method: 'POST', path: '/api/attachments', headers: { ...LOCAL_ORIGIN, 'content-type': 'image/png' }, body: png });
  cap.responses.push({ who: 'local', route: 'POST /api/attachments', url: 'POST /api/attachments', status: up.status, text: up.text, portal: false });
  assert.equal(up.status, 200, up.text);
  cap.notes.attachment = up.json.path;

  // A composer message the transport hands the mod as a submit op.
  const sentC = await client.request(port, 'POST', '/api/queue/message',
    { text: `${MSG_MARK} (to the mod)`, files: [up.json.path], send: 'now', conversation_id: S2 }, { headers: LOCAL_ORIGIN, timeout: CALL_TIMEOUT_MS });
  assert.equal(sentC.body.ok, true, JSON.stringify(sentC.body));
  const submitC = await waitUntil(() => ops.find((o) => o.op === 'submit'), { ...WAIT, what: 'the submit op' });
  cap.notes.msgC = sentC.body.msg_id;

  // Claude Code runs the submitted prompt: its UserPromptSubmit hook (F7).
  session(S2, 'busy');
  const tb = await runHook(root, 'turn-begin', { session_id: S2, transcript_path: ch.transcript(S2), cwd: ch.cwd,
    hook_event_name: 'UserPromptSubmit', prompt: submitC.args.text, prompt_id: 'm-p1', permission_mode: 'default' }, hookEnv(S2)).done;
  assert.equal(tb.status, 0, tb.stderr);
  cap.notes.modLock = (await get('/api/graph')).lock;
  await fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_01ModSweep', tool_input: { command: fake('cli-flag-password').text } }, S2);
  await post('/api/render', { id: 'sweep-m1', html: '<p>the mod\'s turn</p>' });

  // The mod's live feed: one step's deltas, the first batch past TAP_RATE (so
  // the bridge merges its tail, U87b) and ending inside a key; once that text
  // is written, the second batch opens with the key's rest — the key cut
  // across two writes of the provisional reply (U90's case).
  const SPLIT = fake('github-ghu').secrets[0];
  const half = Math.floor(SPLIT.length / 2);
  const FIRST = TAP_RATE + 4; // deltas in the first batch: past the rate, its tail merged
  const N = FIRST + 10;
  const now0 = Date.now();
  const step = (i, delta) => ({ kind: 'turn.step', at: now0 + i, turn_id: 'mt-75', index: 0, delta });
  const batch1 = [];
  for (let i = 0; i < FIRST; i++) batch1.push(step(i, `${MOD_MARK} part ${i}. ${i === FIRST - 1 ? `the key is ${SPLIT.slice(0, half)}` : ''}`));
  const ev1 = await mod.events([{ kind: 'turn.start', at: now0 - 1, turn_id: 'mt-75' }, ...batch1]);
  host('POST /api/bridge/events', ev1.body);
  const provisionalHas = (needle) => local.of('mirror:stream').some((f) => (f.items || []).some((it) => typeof it.id === 'string'
    && it.id.startsWith('rm_') && typeof it.text === 'string' && it.text.includes(needle)));
  await waitUntil(() => provisionalHas(`part ${FIRST - 1}.`), { ...WAIT, what: 'the first batch written, its merged tail included' });
  const batch2 = [];
  for (let i = FIRST; i < N; i++) batch2.push(step(i, `${i === FIRST ? `${SPLIT.slice(half)} — keep it. ` : ''}${MOD_MARK} part ${i}. `));
  const ev1b = await mod.events(batch2);
  host('POST /api/bridge/events', ev1b.body);
  await waitUntil(() => provisionalHas(`part ${N - 1}.`), { ...WAIT, what: 'the provisional reply, every delta in it' });
  const provisional = local.of('mirror:stream').flatMap((f) => f.items || []).filter((it) => typeof it.id === 'string' && it.id.startsWith('rm_'));
  cap.notes.provisional = provisional;
  cap.notes.bridgeCounters = ctx.srv.bridge.status().counters;

  // The live card, an appended row, a measure, a diag, a prompt.
  const ev2 = await mod.events([
    { kind: 'tool.call', at: Date.now(), tool_use_id: 'toolu_01ModSweep', tool: 'Bash', input: { command: fake('cli-flag-password').text, description: 'Migrate' } },
    { kind: 'tool.done', at: Date.now(), tool_use_id: 'toolu_01ModSweep', ok: true, duration_ms: 40 },
    { kind: 'session.append', at: Date.now(), uuid: '7575aaaa-0000-4000-8000-000000000001', message: { role: 'assistant', id: 'msg_01ModSweepRow',
      content: [{ type: 'text', text: `${MOD_MARK} row: ${fake('slack-user').text}` },
        { type: 'tool_use', id: 'toolu_01ModSweep', name: 'Bash', input: { command: fake('cli-flag-password').text } }] } },
    { kind: 'session.measure', at: Date.now(), changed: ['context'], context: { tokens: 75000, window: 200000 } },
    { kind: 'diag', at: Date.now(), shapes: { [fake('aws-asia').secrets[0]]: [fake('github-ghs').secrets[0], 'message.content[0].text'],
      'turn.step': [fake('github-ghr').secrets[0]] } },
  ]);
  host('POST /api/bridge/events', ev2.body);
  await waitUntil(() => local.of('mirror:stream').some((f) => (f.items || []).some((it) => it.id === 'toolu_01ModSweep')),
    { ...WAIT, what: 'the live card' });
  await waitUntil(async () => { const r = await get(`/api/mirror/context?conversation=${S2}`); return r.ok && r.context; }, { ...WAIT, what: 'the context reading' });

  // A second message, mid-turn: a second submit op.
  const sentC2 = await client.request(port, 'POST', '/api/queue/message',
    { text: `${MSG_MARK} (mid-turn)`, send: 'now', conversation_id: S2 }, { headers: LOCAL_ORIGIN, timeout: CALL_TIMEOUT_MS });
  assert.equal(sentC2.body.ok, true, JSON.stringify(sentC2.body));
  const submitC2 = await waitUntil(() => ops.filter((o) => o.op === 'submit')[1], { ...WAIT, what: 'the second submit op' });

  // The mod's permission prompt, its input holding a key; answered on the page.
  await mod.events([{ kind: 'permission.request', at: Date.now(), request_id: 'pr_sweep_75', tool: 'Bash',
    input: { command: fake('url-creds-https').text, description: 'Clone' } }]);
  const modAsk = await waitUntil(async () => ((await get('/api/asks')).asks || []).find((x) => x.state === 'pending' && x.kind === 'permission') || null,
    { ...WAIT, what: 'the mod\'s ask' });
  cap.notes.modAskTransport = ctx.srv.asks.get(modAsk.id).transport;
  const modF = await askFrame(modAsk.id);
  const modDec = await decide(modF, modAsk.id, { behavior: 'allow' });
  assert.equal(modDec.status, 200, modDec.text);
  await waitUntil(() => ops.some((o) => o.op === 'permissionDecision'), { ...WAIT, what: 'the decision op' });

  // A Kill through the stopper's frame (one taskStop), then an interrupt (one abort).
  const killed = await act(await controlFrame('task-stop', { task_id: TASK2 }), 'task-stop', { task_id: TASK2 });
  assert.equal(killed.status, 200, killed.text);
  await waitUntil(() => ops.some((o) => o.op === 'taskStop'), { ...WAIT, what: 'the taskStop op' });
  await waitUntil(async () => { const c = await conversation(S2); return c && c.live && c.live.state === 'working'; }, { ...WAIT, what: 'S2 working' });
  const aborted = await act(await controlFrame('interrupt', { conversation_id: S2 }, 'stop'), 'interrupt', { conversation_id: S2, mode: 'now' });
  assert.equal(aborted.status, 200, aborted.text);
  assert.equal(aborted.json.via, 'mod', aborted.text);
  await waitUntil(() => ops.some((o) => o.op === 'abort'), { ...WAIT, what: 'the abort op' });
  await waitUntil(() => cap.logs.some((l) => l.includes('control: mod abort ok')), { ...WAIT, what: 'the abort\'s log line' });

  // The turn completes; the transcript's later copy lands.
  await mod.events([{ kind: 'turn.complete', at: Date.now(), turn_id: 'mt-75', reason: 'end_turn',
    text: `${MOD_MARK} finished: the key is ${SPLIT} and ${fake('stripe-rk-live').text}` }]);
  const n2 = r2.records.length;
  r2.prompt(`${submitC.args.text}\n> and ${fake('huggingface').text}`, { promptId: 'm-p1' });
  r2.queuedCommand(`${submitC2.args.text}\n> and ${fake('npm').text}`, { origin: { kind: 'plugin' } });
  r2.assistant([`${MOD_MARK} part 0. the key is ${SPLIT} — keep it.`, { type: 'tool_use', name: 'Bash', input: { command: fake('cli-flag-password').text, description: 'Migrate' }, id: 'toolu_01ModSweep' }]);
  r2.toolResult('toolu_01ModSweep', `${TOOLOUT_MARK} migrated with ${fake('slack-bot').text}`);
  r2.assistant([`${MOD_MARK} finished: the key is ${SPLIT} and ${fake('stripe-rk-live').text}`]);
  r2.turnDuration({ durationMs: 400, messageCount: 6 });
  ch.appendTranscript(S2, r2.records.slice(n2));
  session(S2, 'idle');
  const endM = await turnEnd(`${MOD_MARK} finished`, S2);
  assert.ok(endM.node_id, `the mod's turn committed a node: ${JSON.stringify(endM)}`);
  cap.notes.modNode = await get(`/api/graph/node/${encodeURIComponent(endM.node_id)}`);
  await closedTurn(S2, 'm-p1');
  await waitUntil(async () => {
    const p = await turnsOf(S2);
    const x = (p.turns || []).find((y) => y.id === 'm-p1');
    return x && !(x.items || []).some((it) => typeof it.id === 'string' && /^rm_/.test(it.id));
  }, { ...WAIT, what: 'the provisional replies replaced by the transcript\'s' });

  // Session controls through the answer origin.
  const renamed = await act(await controlFrame('session-rename', { conversation_id: S2, name: RENAME_MARK }), 'session-rename', { conversation_id: S2, name: RENAME_MARK });
  assert.equal(renamed.status, 200, renamed.text);
  const compacted = await act(await controlFrame('session-compact', { conversation_id: S2 }), 'session-compact', { conversation_id: S2 });
  assert.equal(compacted.status, 200, compacted.text);
  host('GET /api/bridge/status', await get('/api/bridge/status'));
  host('bridge ops', ops);

  // The mod's package, staged as `mod on` stages it (an injected claude).
  const staged = reg.applyMod(root, { runClaude: modClaude() });
  assert.equal(staged.state, 'on', JSON.stringify(staged));

  // ── the scenario's ids, for the route sweep ──
  const scenarioIds = async () => {
    const g = await get('/api/graph');
    const nodes = g.nodes || [];
    const mounts = await get('/api/mounts');
    const mountIds = (Array.isArray(mounts) ? mounts : (mounts.mounts || [])).map((m) => m.id).filter(Boolean);
    const panes = [];
    for (const n of nodes.slice(-6)) {
      const full = await get(`/api/graph/node/${encodeURIComponent(n.id)}`);
      for (const m of (full.mounts || []).slice(0, 2)) panes.push([n.id, m.id]);
    }
    const itemIds = [];
    const turnIds = [];
    for (const cid of [S1, S2]) {
      const p = await turnsOf(cid);
      for (const x of p.turns || []) {
        turnIds.push(x.id);
        for (const it of x.items || []) if (typeof it.id === 'string') itemIds.push(it.id);
      }
    }
    return {
      nodeIds: nodes.map((n) => n.id), nodeLabels: nodes.map((n) => n.label).filter(Boolean),
      mountIds, panes, itemIds: [...new Set(itemIds)], turnIds: [...new Set(turnIds)],
      askIds: [ask.id, el.id, modAsk.id],
    };
  };

  // The GET sweep for one viewer: who ∈ local | basic | read | full | peer.
  const sweep = async (who) => {
    const s = await scenarioIds();
    const { targets, missing } = getTargets(s);
    cap.notes.missingRoutes = missing;
    cap.notes.scanned = targets.length;
    const headers = who === 'local' ? {} : who === 'peer' ? { 'x-test-peer': PEER } : { 'X-WC-Remote': '1' };
    const optIn = who === 'read' ? 'read' : who === 'full' ? 'full' : 'off';
    for (const { route, url } of targets) {
      let r = await raw(port, { path: url, headers });
      // A preview already being made answers 429: ask again once it is done.
      if (r.status === 429) {
        r = await waitUntil(async () => { const x = await raw(port, { path: url, headers }); return x.status === 429 ? null : x; },
          { timeout: 10000, interval: 100 }) || r;
      }
      const portal = who === 'local' ? false : who === 'peer' ? true : classify('GET', url, { mirror: optIn }).allow;
      cap.responses.push({ who, route, url, status: r.status, text: r.text, portal });
    }
    // The answer surface is its own loopback listener: no network peer reaches it.
    if (who !== 'peer') await answerSweep(who, s);
  };

  // The answer surface's documents, views and control state reads.
  const answerSweep = async (who, s) => {
    const ao = await answerOrigin();
    const headers = who === 'local' ? {} : who === 'peer' ? { 'x-test-peer': PEER } : { 'X-WC-Remote': '1' };
    const docs = [
      ...s.askIds.map((id) => `/answer/ask/${id}?layout=card&mode=light`),
      `/answer/control/interrupt?conversation_id=${S1}&layout=stop&mode=light`,
      `/answer/control/interrupt?conversation_id=${S2}&layout=stop&mode=light`,
      `/answer/control/fork?turn_id=p1&layout=confirm&mode=light`,
      `/answer/control/undo?restore_id=latest&layout=confirm&mode=light`,
      `/answer/control/task-stop?task_id=${TASK2}&layout=confirm&mode=light`,
      `/answer/control/session-compact?conversation_id=${S2}&layout=confirm&mode=light`,
    ];
    for (const url of docs) {
      const doc = await raw(ao.port, { path: url, headers });
      cap.answers.push({ who, url, status: doc.status, text: doc.text });
      // The doc's own nonce (a local one when a remote doc is refused) reads its view.
      const nonce = nonceOf(doc.text) || nonceOf((await raw(ao.port, { path: url })).text);
      const m = /^\/answer\/ask\/([^?]+)/.exec(url);
      const c = /^\/answer\/control\/([a-z-]+)\?(.*)$/.exec(url);
      let view = null;
      if (m) view = `/answer/api/asks/${m[1]}?v=0`;
      else if (c) {
        const q = new URLSearchParams(c[2]);
        for (const k of ['layout', 'mode']) q.delete(k);
        view = `/answer/api/control/state?action=${c[1]}&${q}`;
      }
      if (view && nonce) {
        const v = await raw(ao.port, { path: view, headers: { ...headers, 'x-wc-answer': nonce } });
        cap.answers.push({ who, url: view, status: v.status, text: v.text });
      }
    }
  };

  // ── phase basic: the sweep at basic (a remote viewer of a project that has not opted in) ──
  await eventPages();
  await sweep('basic');

  // ── phase read ──
  sockets.push(await socket(t, port, 'remote (opened at read)', { headers: remoteHeaders, level: 'basic' }));
  const asRead = await tunnel(['mirror', 'on', '--read-only'], { log: () => {}, cwd: root });
  assert.equal(asRead.level, 'read', JSON.stringify(asRead));
  for (const sk of sockets.filter((x) => x.name.startsWith('remote'))) {
    await waitUntil(() => sk.level === 'read', { timeout: 20000, interval: 20, what: `${sk.name} told it is read` });
  }
  await shortTurn('p3', fake('x-api-key-json').text);
  await sweep('read');

  // ── phase full ──
  sockets.push(await socket(t, port, 'remote (opened at full)', { headers: remoteHeaders, level: 'read' }));
  const asFull = await tunnel(['mirror', 'on'], { log: () => {}, cwd: root });
  assert.equal(asFull.level, 'full', JSON.stringify(asFull));
  for (const sk of sockets.filter((x) => x.name.startsWith('remote'))) {
    await waitUntil(() => sk.level === 'full', { timeout: 20000, interval: 20, what: `${sk.name} told it is full` });
  }
  sockets.push(await socket(t, port, 'network peer', { headers: { 'x-test-peer': PEER }, level: 'basic' }));
  await shortTurn('p4', fake('url-creds-redis').text);
  await sweep('full');
  await sweep('local');
  await sweep('peer');
  await eventPages();

  async function shortTurn(promptId, secretText) {
    const prompt = `${PROMPT_MARK} ${promptId}: ${secretText}`;
    const r = await turnBegin(promptId, prompt);
    assert.equal(r.ok, true, JSON.stringify(r));
    const n = r1.records.length;
    r1.prompt(prompt, { promptId });
    r1.assistant([`${REPLY_MARK} ${promptId} answered with ${secretText}`]);
    r1.turnDuration({ durationMs: 30, messageCount: 2 });
    ch.appendTranscript(S1, r1.records.slice(n));
    await post('/api/render', { id: `sweep-${promptId}`, html: `<p>${promptId}</p>` });
    const e = await turnEnd(`${REPLY_MARK} ${promptId}: ${secretText}`);
    assert.ok(e.node_id, `${promptId} committed: ${JSON.stringify(e)}`);
    await closedTurn(S1, promptId);
  }

  // The receipts: the transcript's mod-submitted prompt confirmed message C
  // (carriers.js read it via 'mod', F7), so the carrier was reached.
  cap.notes.receipts = (await get('/api/queue')).receipts || [];
  // The files a later check reads before the teardown takes nothing away.
  cap.notes.diffRecord = fs.readFileSync(projectPaths(root).mirrorDiff('p1'), 'utf8');
  cap.notes.sse = sse.events;

  // ── the teardown ──
  sse.close();
  await mod.close();
  for (const sk of sockets) { try { sk.ws.terminate(); } catch {} }
  for (const sk of sockets) for (const f of sk.frames) cap.frames.push({ socket: sk.name, level: f.level, type: f.frame.type, frame: f.frame, text: f.text });
  if (teardown === 'stop') await ctx.srv.stop();
  else await ctx.srv.gracefulShutdown();
  assert.equal(ctx.server.listening, false, 'the server is closed');
  cap.sse = cap.notes.sse;
  delete cap.notes.sse;

  // ── after it: every file under .web-chat/, the shadow store, the halt dir ──
  cap.files = filesUnder(projectPaths(root).dir);
  const shadow = projectPaths(root).mirrorGit;
  const objects = await runGit(['cat-file', '--batch-all-objects', '--batch'], { cwd: repo.top, env: { GIT_DIR: shadow }, encoding: 'buffer' });
  assert.equal(objects.code, 0, String(objects.stderr));
  cap.gitObjects = objects.stdout.toString('latin1');
  let halt = [];
  try { halt = fs.readdirSync(userPaths().haltDir); } catch {}
  cap.notes.haltAfter = halt;
  cap.notes.root = root;
  cap.notes.sockets = sockets.map((s) => ({ name: s.name, level: s.level, frames: s.frames.length }));
  return cap;
}

// ── the clauses ──────────────────────────────────────────────────────────────

// Every carrier as {carrier, level, text}, for the clauses that read them all.
function carriers(cap) {
  const out = [];
  for (const f of cap.frames) out.push({ carrier: `frame ${f.type} on ${f.socket}`, level: f.level, text: f.text, kind: 'frame', f });
  for (const e of cap.sse) out.push({ carrier: `sse ${e.kind}${e.op ? `/${e.op}` : ''}`, level: 'local', text: JSON.stringify(e), kind: 'event' });
  for (const p of cap.events) out.push({ carrier: 'GET /api/events page', level: 'local', text: JSON.stringify(p), kind: 'event' });
  for (const r of cap.responses) out.push({ carrier: `GET ${r.url} → ${r.status}`, level: r.who, text: r.text, kind: 'response', r });
  for (const r of cap.answers) out.push({ carrier: `answer ${r.url} → ${r.status}`, level: r.who, text: r.text, kind: 'answer', r });
  for (const h of cap.host) out.push({ carrier: `host ${h.what}`, level: 'local', text: h.text, kind: 'host' });
  out.push({ carrier: 'server.log (the daemon\'s stderr)', level: 'local', text: cap.logs.join('\n'), kind: 'log' });
  for (const [rel, buf] of Object.entries(cap.files)) out.push({ carrier: `file .web-chat/${rel}`, level: 'file', text: buf.toString('latin1'), kind: 'file', rel });
  return out;
}

function report(list, max = 25) {
  return list.length ? `${list.length} found:\n  ${list.slice(0, max).join('\n  ')}${list.length > max ? `\n  … and ${list.length - max} more` : ''}` : '';
}

async function clauses(t, cap) {
  const all = carriers(cap);

  await t.test('the scenario reached every carrier it names', () => {
    assert.deepEqual(cap.notes.missingRoutes, [], `seed ${SEED}: mounted GET routes neither requested nor in SKIP — add each to FILL (with ids that reach it) or, with a reason, to SKIP: ${cap.notes.missingRoutes.join(', ')}`);
    const routes = new Set(daemonGetRoutes().map((r) => r.path));
    const stale = Object.keys(SKIP).filter((p) => !routes.has(p));
    assert.deepEqual(stale, [], `seed ${SEED}: SKIP may only shrink — these entries name no mounted route: ${stale.join(', ')}`);
    const unmounted = [...Object.keys(FILL), ...Object.keys(QUERIES)].filter((p) => !routes.has(p));
    assert.deepEqual(unmounted, [], `seed ${SEED}: FILL and QUERIES name only mounted routes: ${unmounted.join(', ')}`);
    for (const [p, why] of Object.entries(SKIP)) assert.ok(typeof why === 'string' && why.length > 20, `seed ${SEED}: SKIP's ${p} carries its reason`);
    assert.ok(cap.notes.scanned > 60, `seed ${SEED}: the route sweep requested only ${cap.notes.scanned} targets`);
    for (const lvl of ['local', 'basic', 'read', 'full']) {
      assert.ok(cap.frames.some((f) => f.level === lvl && f.type === 'mirror:status'), `seed ${SEED}: a mirror:status frame was captured at ${lvl}`);
    }
    for (const lvl of ['local', 'read', 'full']) {
      assert.ok(cap.frames.some((f) => f.level === lvl && f.type === 'mirror:stream'), `seed ${SEED}: a mirror:stream frame was captured at ${lvl}`);
    }
    assert.ok(cap.frames.some((f) => f.socket === 'network peer'), `seed ${SEED}: the network peer's socket got frames`);
    assert.ok(cap.files['mod/opted-out.json'] || Object.keys(cap.files).some((r) => r.startsWith('mod/')), `seed ${SEED}: .web-chat/mod was reached`);
    assert.ok(Object.keys(cap.files).some((r) => r.startsWith('attachments/')), `seed ${SEED}: .web-chat/attachments was reached`);
    assert.ok(cap.files['control/audit.log'] && cap.files['asks/audit.log'], `seed ${SEED}: both audits were written`);
    assert.ok(cap.files['control/restores.json'], `seed ${SEED}: the restores ledger was written`);
  });

  await t.test('(1) no generated value, and no 8-character window of one, in any frame, event, response or file, at any level', () => {
    const bad = [];
    for (const c of all) {
      for (const l of leaksIn(c.text)) bad.push(say(c.carrier, c.level, `findLeaks (${l.rule})`, `fake ${l.id}, window ${JSON.stringify(l.window)}`));
    }
    assert.equal(bad.length, 0, report(bad));
  });

  await t.test('(1) the shadow store and the subagent, tool-results and task files reached the engine and left only masks', () => {
    // The subagent's text did reach the mirror (so its masks above mean something).
    const agentResp = cap.responses.filter((r) => r.url === `/api/mirror/agents/${AGENT}` && r.who === 'local');
    assert.ok(agentResp.some((r) => r.text.includes(SUBAGENT_MARK)), `seed ${SEED}: the subagent's stream reached GET /api/mirror/agents/${AGENT}`);
    const taskResp = cap.responses.filter((r) => r.url === `/api/mirror/tasks/${TASK2}/output` && r.who === 'local');
    assert.ok(taskResp.some((r) => r.text.includes(TOOLOUT_MARK)), `seed ${SEED}: the task output reached GET /api/mirror/tasks/${TASK2}/output`);
  });

  await t.test('(2) the planted email and organisation id appear nowhere, index files included', () => {
    const bad = [];
    for (const c of all) for (const id of plantedIn(c.text)) bad.push(say(c.carrier, c.level, 'known value (§2.11)', id));
    for (const id of plantedIn(cap.gitObjects)) bad.push(say('the shadow store\'s objects', 'file', 'known value', id));
    assert.equal(bad.length, 0, report(bad));
  });

  await t.test('(3) the composer marker reaches nothing below read; the queue there says `message · N chars`', () => {
    // Below read: a frame on a socket at basic (a remote viewer of a project
    // that has not opted in, and the network peer's); a remote request at
    // basic that the portal lets through; a network peer's request (no portal
    // in front of it); the answer surface's answers to a remote request at basic.
    const below = (c) => (c.kind === 'frame' && c.level === 'basic')
      || (c.kind === 'response' && ((c.level === 'basic' && c.r.portal) || c.level === 'peer'))
      || (c.kind === 'answer' && c.level === 'basic');
    const bad = [];
    for (const c of all.filter(below)) {
      if (c.text.includes('SWEEP-COMPOSER-u2p8')) bad.push(say(c.carrier, c.level, 'message text below read (§6.1)', 'the composer marker'));
    }
    assert.ok(all.filter(below).length > 100, `seed ${SEED}: the carriers below read were captured (${all.filter(below).length})`);
    assert.equal(bad.length, 0, report(bad));
    const q = cap.responses.find((r) => r.who === 'basic' && r.url === '/api/queue');
    assert.ok(q, `seed ${SEED}: GET /api/queue was requested at basic`);
    const items = (JSON.parse(q.text).items || []).filter((it) => it.kind === 'message');
    assert.ok(items.length > 0, `seed ${SEED}: the held message is in the queue at basic: ${q.text.slice(0, 300)}`);
    for (const it of items) {
      assert.match(String(it.summary), /^message · \d+ chars?(?: · \/[\w-]+)?(?: · \d+ files?)?$/, `seed ${SEED} · GET /api/queue · basic · the message's label: ${JSON.stringify(it)}`);
      assert.equal(it.text, undefined, `seed ${SEED} · GET /api/queue · basic · no text: ${JSON.stringify(it)}`);
    }
  });

  await t.test('(3) the mod-transported message\'s lock and node read \'web message m-…\' at every level, with no marker (F7)', () => {
    const want = `web message ${cap.notes.msgC}`;
    assert.equal(cap.notes.modLock && cap.notes.modLock.message, want, `seed ${SEED} · GET /api/graph · local · the lock: ${JSON.stringify(cap.notes.modLock)}`);
    assert.equal(cap.notes.modNode.trigger.message, want, `seed ${SEED} · GET /api/graph/node · local · the trigger: ${JSON.stringify(cap.notes.modNode.trigger)}`);
    const bad = [];
    for (const f of cap.frames) {
      const locks = [f.frame.lock, f.frame.node && f.frame.node.trigger_summary].filter(Boolean);
      for (const l of locks) {
        const s = JSON.stringify(l);
        if (s.includes('SWEEP-COMPOSER-u2p8')) bad.push(say(`frame ${f.type} on ${f.socket}`, f.level, 'F7: a lock or trigger with the message text', s.slice(0, 160)));
      }
    }
    for (const r of cap.responses.filter((x) => /^\/api\/graph(?:[/?]|$)/.test(x.url))) {
      let body = null;
      try { body = JSON.parse(r.text); } catch { continue; }
      const texts = [body.lock, ...(body.nodes || []).map((n) => n.trigger_summary), body.trigger].filter(Boolean);
      for (const x of texts) if (JSON.stringify(x).includes('SWEEP-COMPOSER-u2p8')) bad.push(say(`GET ${r.url}`, r.who, 'F7: graph text with the message text', JSON.stringify(x).slice(0, 160)));
    }
    assert.equal(bad.length, 0, report(bad));
  });

  await t.test('(4) no raw home path in the carriers E6 (a) names; any other that shows one is on the reasoned allowlist, which has no stale entry', () => {
    const bad = [];
    const used = new Set();
    const excused = (kind, key) => {
      const e = HOME_ALLOW.find((x) => x.kind === kind && (x.match instanceof RegExp ? x.match.test(key) : x.match === key));
      if (e) used.add(e);
      return !!e;
    };
    for (const c of all) {
      const hits = homeIn(c.text);
      if (!hits.length) continue;
      if (c.kind === 'frame') {
        const mirror = String(c.f.type).startsWith('mirror:');
        const remote = c.f.socket !== 'local';
        const graphText = ['hello', 'reset', 'lock', 'node-added'].includes(c.f.type)
          && homeIn(JSON.stringify([c.f.frame.lock, c.f.frame.node && c.f.frame.node.trigger_summary])).length;
        if (mirror || remote || graphText) bad.push(say(c.carrier, c.level, 'home path (E6 a)', hits.join(' | ')));
      } else if (c.kind === 'response' || c.kind === 'answer') {
        // A remote viewer (X-WC-Remote, through the portal's table) at any
        // level, and every carrier E6 (a) lists, at any level; a network
        // peer reaching a pre-0.8.5 route is WEB_CHAT_HOST's documented
        // exposure, held like a local request to the reasoned list.
        const remoteReach = ['basic', 'read', 'full'].includes(c.level) && (c.kind === 'answer' || c.r.portal);
        const url = c.kind === 'answer' ? '/answer/' : c.r.url;
        if (remoteReach || HOME_SCOPE_ROUTE.test(url)) bad.push(say(c.carrier, c.level, 'home path (E6 a)', hits.join(' | ')));
        else if (!excused('response', c.r.route)) bad.push(say(c.carrier, c.level, 'home path outside E6 (a)\'s list and not on the reasoned allowlist', hits.join(' | ')));
      } else if (c.kind === 'host') {
        bad.push(say(c.carrier, c.level, 'home path (E6 a: the bridge and control routes)', hits.join(' | ')));
      } else if (c.kind === 'file') {
        if (HOME_SCOPE_FILE.test(c.rel)) bad.push(say(c.carrier, c.level, 'home path (E6 a)', hits.join(' | ')));
        else if (!excused('file', c.rel)) bad.push(say(c.carrier, c.level, 'home path outside E6 (a)\'s list and not on the reasoned allowlist', hits.join(' | ')));
      }
    }
    // The shadow repository's alternates: a relative path (§2.7).
    const alt = cap.files['mirror/git/objects/info/alternates'];
    assert.ok(alt, `seed ${SEED}: the shadow store has an alternates file`);
    for (const line of alt.toString('utf8').split('\n').filter(Boolean)) {
      if (path.isAbsolute(line)) bad.push(say('file .web-chat/mirror/git/objects/info/alternates', 'file', 'alternates are relative (§2.7)', line));
    }
    for (const e of HOME_ALLOW) assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `seed ${SEED}: every allowlist entry carries its reason: ${JSON.stringify(e)}`);
    const stale = HOME_ALLOW.filter((e) => !used.has(e) && !e.optional && (!e.teardown || e.teardown === cap.teardown)).map((e) => `${e.kind} ${e.match} (${e.reason})`);
    assert.equal(bad.length, 0, report(bad));
    assert.deepEqual(stale, [], `seed ${SEED}: the home-path allowlist may only shrink — these entries excused nothing: ${stale.join('; ')}`);
  });

  await t.test('(4) /api/health\'s instance is the registry id, never a path (U105)', () => {
    for (const r of cap.responses.filter((x) => x.url === '/api/health')) {
      const body = JSON.parse(r.text);
      if (body.instance === undefined) continue;
      assert.match(String(body.instance), /^[0-9a-f]{8}$/, `seed ${SEED} · GET /api/health · ${r.who} · instance: ${JSON.stringify(body.instance)}`);
    }
  });

  await t.test('(5) the withheld .env never enters the shadow store; its diff entry reads withheld, with no counts', () => {
    const envFakes = [fake('env-dotenv'), fake('env-line-plain')].map((f) => SCAN.find((x) => x.id === f.id));
    const inStore = leaksIn(cap.gitObjects, envFakes);
    assert.deepEqual(inStore.map((l) => say('the shadow store\'s objects (git cat-file --batch-all-objects)', 'file', 'withheld file in the store (§2.7)', `${l.id} ${JSON.stringify(l.window)}`)), []);
    const rec = JSON.parse(cap.notes.diffRecord);
    const entries = JSON.stringify(rec);
    const env = (rec.files || []).find((f) => f && (f.path === '.env' || f.path === '/.env'));
    assert.ok(env, `seed ${SEED} · .web-chat/mirror/diffs/p1.json · the .env is listed: ${entries.slice(0, 400)}`);
    assert.ok(env.withheld, `seed ${SEED} · .web-chat/mirror/diffs/p1.json · the .env entry is withheld: ${JSON.stringify(env)}`);
    for (const k of ['additions', 'deletions', 'added', 'removed', 'lines', 'patch', 'hunks']) {
      assert.ok(!(k in env) || env[k] === null || env[k] === undefined, `seed ${SEED} · .web-chat/mirror/diffs/p1.json · the withheld .env has no ${k}: ${JSON.stringify(env)}`);
    }
  });

  await t.test('(6) the audits and the restores ledger hold only their documented keys, ids, trees, relative paths and outcomes', () => {
    const bad = [];
    const MARKS = [PROMPT_MARK, REPLY_MARK, THINK_MARK, TOOLOUT_MARK, 'SWEEP-COMPOSER-u2p8', ELICIT_MARK, RENAME_MARK, MOD_MARK, FILE_BEFORE, FILE_AFTER];
    const CONTROL_KEYS = new Set(['at', 'action', 'target', 'outcome', 'via', 'origin', 'device']);
    const ASKS_KEYS = new Set(['at', 'ask', 'kind', 'tool', 'outcome', 'via', 'origin', 'device', 'ua', 'reason', 'transport']);
    const lines = (rel) => (cap.files[rel] ? cap.files[rel].toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const control = [...lines('control/audit.log.1'), ...lines('control/audit.log')];
    const asks = [...lines('asks/audit.log.1'), ...lines('asks/audit.log')];
    assert.ok(control.length > 0 && asks.length > 0, `seed ${SEED}: the audits have lines`);
    for (const l of control) {
      for (const k of Object.keys(l)) if (!CONTROL_KEYS.has(k)) bad.push(say('file .web-chat/control/audit.log', 'file', 'a documented key (control/index.js audit)', `${k} in ${JSON.stringify(l)}`));
      for (const [k, v] of Object.entries(l.target || {})) {
        if (typeof v === 'string' && !/^[A-Za-z0-9_.:-]{1,200}$/.test(v)) bad.push(say('file .web-chat/control/audit.log', 'file', 'the target holds ids only', `${l.action}.${k} = ${JSON.stringify(v)}`));
      }
      if (/^session-/.test(String(l.action)) && JSON.stringify(l).includes(RENAME_MARK)) bad.push(say('file .web-chat/control/audit.log', 'file', 'a session-* line carries ids only (U93)', JSON.stringify(l)));
    }
    for (const l of asks) {
      for (const k of Object.keys(l)) if (!ASKS_KEYS.has(k)) bad.push(say('file .web-chat/asks/audit.log', 'file', 'a documented key (asks.js audit)', `${k} in ${JSON.stringify(l)}`));
      if ('transport' in l && l.transport !== 'mod') bad.push(say('file .web-chat/asks/audit.log', 'file', 'transport is \'mod\' only', JSON.stringify(l)));
    }
    assert.ok(control.some((l) => /^session-rename$/.test(l.action)), `seed ${SEED}: the rename's audit line was written`);
    assert.ok(asks.some((l) => l.transport === 'mod'), `seed ${SEED}: the mod ask's audit line says transport 'mod'`);
    for (const rel of ['control/audit.log', 'control/audit.log.1', 'asks/audit.log', 'asks/audit.log.1', 'control/restores.json']) {
      if (!cap.files[rel]) continue;
      const s = cap.files[rel].toString('utf8');
      for (const m of MARKS) if (s.includes(m)) bad.push(say(`file .web-chat/${rel}`, 'file', 'no prompt text, message, command or file content', m));
    }
    const ledger = JSON.parse(cap.files['control/restores.json'].toString('utf8'));
    const walk = (v, at) => {
      if (typeof v === 'string') {
        if (path.isAbsolute(v) || /^~\//.test(v)) bad.push(say('file .web-chat/control/restores.json', 'file', 'project-relative paths only', `${at} = ${v}`));
        if (v.length > 200) bad.push(say('file .web-chat/control/restores.json', 'file', 'no file content', `${at}: ${v.length} characters`));
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(ledger, 'restores');
    assert.ok(JSON.stringify(ledger).includes('src/app.js'), `seed ${SEED}: the ledger names the restored path: ${JSON.stringify(ledger).slice(0, 300)}`);
    assert.equal(bad.length, 0, report(bad));
  });

  await t.test('(7) no halt flag remains once the stopped turn closed, nor after the teardown', () => {
    assert.equal(cap.notes.flagAfterTurn, false, `seed ${SEED} · ~/.web-chat/halt/${S1} · rule §15.2: the flag outlived p2`);
    assert.deepEqual(cap.notes.haltAfter, [], `seed ${SEED} · ~/.web-chat/halt · rule §15.2: flags left after ${cap.teardown}`);
  });

  await t.test('(8) the fork\'s argv holds only ids, flags and web-chat\'s own `fork of n…` label', () => {
    const argv = cap.notes.forkArgv[0];
    const ok = (a) => /^-{1,2}[a-z][a-z-]*$/.test(a) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a)
      || /^\/rename fork of n[0-9.]+$/.test(a) || /^(?:json|stream-json|text)$/.test(a);
    const bad = argv.filter((a) => !ok(a));
    assert.deepEqual(bad, [], `seed ${SEED} · the stub claude's argv · rule §15.6 (ids, flags and the label only): ${JSON.stringify(argv)}`);
    assert.ok(argv.some((a) => /^\/rename fork of n/.test(a)), `seed ${SEED}: the label: ${JSON.stringify(argv)}`);
    for (const m of [PROMPT_MARK, REPLY_MARK, EMAIL, ORG]) assert.ok(!argv.join('\n').includes(m), `seed ${SEED} · fork argv · no user text: ${m}`);
  });

  await t.test('(9) the mod: the split key masked in the provisional reply and in the transcript\'s copy; the card, the ask, the status, the context and the attachment', () => {
    const SPLIT = fake('github-ghu');
    const prov = cap.notes.provisional;
    assert.ok(prov.length > 0, `seed ${SEED}: a provisional reply was streamed`);
    assert.ok(cap.notes.bridgeCounters.events_merged > 0, `seed ${SEED}: the first batch went past TAP_RATE and the bridge merged its tail: ${JSON.stringify(cap.notes.bridgeCounters)}`);
    const written = prov.filter((it) => typeof it.text === 'string');
    assert.ok(written.some((it) => it.text.includes(`part ${TAP_RATE + 3}.`) && !it.text.includes(`part ${TAP_RATE + 4}.`)),
      `seed ${SEED}: one write ended inside the key (the first batch), before the second batch: ${JSON.stringify(written.map((it) => it.text.slice(-80)))}`);
    for (const it of prov) {
      assert.deepEqual(leaksIn(JSON.stringify(it), [SPLIT]), [], say(`mirror:stream item ${it.id}`, 'local', 'the key cut across two chunks is masked whole (U90)', JSON.stringify(it.text).slice(0, 200)));
    }
    assert.ok(prov.some((it) => /‹redacted:/.test(String(it.text))), `seed ${SEED}: the provisional reply shows a mask: ${JSON.stringify(prov.map((p) => p.text)).slice(0, 400)}`);
    // The transcript's copy: one reply per transcript reply, no rm_ left.
    const page = cap.responses.find((r) => r.who === 'local' && r.url === `/api/mirror/conversations/${S2}/turns?limit=50&items=full`);
    const turn = (JSON.parse(page.text).turns || []).find((x) => x.id === 'm-p1');
    assert.ok(turn, `seed ${SEED}: the mod's turn`);
    const replies = (turn.items || []).filter((it) => it.kind === 'reply');
    assert.ok(!replies.some((it) => /^rm_/.test(String(it.id))), `seed ${SEED} · the mod's turn · no provisional reply left: ${JSON.stringify(replies.map((x) => x.id))}`);
    const finished = replies.filter((it) => String(it.text).includes(`${MOD_MARK} finished`));
    assert.equal(finished.length, 1, `seed ${SEED} · the mod's turn · the tailer's copy is not duplicated: ${JSON.stringify(replies.map((x) => [x.id, x.source]))}`);
    // The live card was drawn.
    assert.ok(cap.frames.some((f) => f.type === 'mirror:stream' && (f.frame.items || []).some((it) => it.id === 'toolu_01ModSweep')), `seed ${SEED}: the live card`);
    // The mod's permission prompt was the asks' mod transport, framed and answered.
    assert.equal(cap.notes.modAskTransport, 'mod', `seed ${SEED}: the mod ask's transport`);
    assert.ok(cap.frames.some((f) => f.type === 'mirror:ask' && f.frame.ask && f.frame.ask.kind === 'permission'), `seed ${SEED}: mirror:ask frames`);
    // The bridge's status, as the host reads it: no diag shape carries a fake
    // (the mod's diag sends names, never values; the shapes it tried here were
    // fakes shaped as names).
    const status = cap.host.find((h) => h.what === 'GET /api/bridge/status');
    const fromDiag = leaksIn(status.text, ['aws-asia', 'github-ghs', 'github-ghr'].map(fake));
    assert.deepEqual(fromDiag.map((l) => say('GET /api/bridge/status (host, through lib/client): sessions[].shapes', 'local', 'no diag shape carries a fake (§15.7, U87)', `fake ${l.id}, window ${JSON.stringify(l.window)}`)), []);
    // The context reading: numbers only.
    for (const r of cap.responses.filter((x) => x.url.startsWith('/api/mirror/context') && x.status === 200)) {
      const body = JSON.parse(r.text);
      const leaves = [];
      const walk = (v, at) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`); else leaves.push([at, v]); };
      walk(body.context, 'context');
      for (const [at, v] of leaves) assert.ok(v === null || typeof v === 'number' || typeof v === 'boolean', `seed ${SEED} · GET ${r.url} · ${r.who} · numbers only: ${at} = ${JSON.stringify(v)}`);
    }
    // The attachment's saved name and the message naming it.
    assert.match(String(cap.notes.attachment), /^\.web-chat\/attachments\/\d{8}-[0-9a-f]{8}\.png$/, `seed ${SEED}: the attachment's saved name`);
    const submit = cap.notes.ops.find((o) => o.op === 'submit');
    assert.ok(submit.args.text.includes(`File attached: ${cap.notes.attachment}`), `seed ${SEED}: the message names the attachment by its relative path: ${submit.args.text}`);
    assert.deepEqual(homeIn(JSON.stringify(cap.notes.ops)), [], `seed ${SEED} · bridge ops · no home path`);
    // The abort's log line: ids only.
    const line = cap.logs.find((l) => l.includes('control: mod abort ok'));
    assert.match(line.replace(/^\[web-chat\]\s*/, ''), /^control: mod abort ok \(stopped \d+: [A-Za-z0-9_, -]*\)$/, `seed ${SEED} · server.log · the abort's line carries ids only: ${line}`);
  });

  await t.test('(9) the elicitation\'s accepted value reaches no frame, event, response or file (the hook\'s own output aside)', () => {
    const bad = [];
    for (const c of all) if (c.text.includes(ELICIT_MARK)) bad.push(say(c.carrier, c.level, 'the accepted value goes to Claude Code only (U92)', ELICIT_MARK));
    assert.equal(bad.length, 0, report(bad));
  });

  await t.test('the transcript-side mod carriers: the mod-submitted user/prompt and the plugin queued_command reach no viewer below read', () => {
    // Their fakes are in (1); their marker below read in (3); here: they did
    // reach the mirror at read and above, so (3) means something.
    const page = cap.responses.find((r) => r.who === 'full' && r.url === `/api/mirror/conversations/${S2}/turns?limit=50&items=full`);
    assert.ok(page && page.status === 200, `seed ${SEED}: S2's turns at full: ${page && page.status}`);
    assert.ok(page.text.includes('SWEEP-COMPOSER-u2p8'), `seed ${SEED}: the mod-submitted prompt reached the mirror at full`);
    const basic = cap.responses.find((r) => r.who === 'basic' && r.url === `/api/mirror/conversations/${S2}/turns?limit=50&items=full`);
    assert.ok(basic && basic.status === 403, `seed ${SEED} · GET S2's turns · basic · refused: ${basic && basic.status} ${basic && basic.text.slice(0, 200)}`);
    const receipt = cap.notes.receipts.find((r) => r.msg_id === cap.notes.msgC);
    assert.equal(receipt && receipt.state, 'confirmed', `seed ${SEED}: the mod-submitted user/prompt confirmed its message (carriers.js via 'mod'): ${JSON.stringify(cap.notes.receipts)}`);
  });
}

// One run of the sweep, torn down one way ('stop' or 'graceful'). Each teardown
// is its own test file (test/mirror-redaction-sweep.test.js and
// test/mirror-redaction-sweep-graceful.test.js), so each ~22 s run has the
// per-file timeout to itself: the two in one file went past `npm test`'s 60 s on
// a CI macOS runner on Node 22 (the 0.8.5 release run, 2026-10-15).
function sweep(teardown) {
  test(`the redaction sweep, seed ${SEED}, torn down by ${teardown === 'stop' ? 'srv.stop()' : 'gracefulShutdown()'}`, { timeout: 300000 }, async (t) => {
    const cap = await runScenario(t, teardown);
    await clauses(t, cap);
  });
}

module.exports = { sweep };
