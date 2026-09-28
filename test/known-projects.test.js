// Known projects, and starting one from the portal picker.
//
// ~/.web-chat/projects.json remembers every project whose daemon has booted
// here (lib/util/registry rememberProject, called by registerInstance), so a
// stopped one can still be listed — sessions() gains INACTIVE rows, `ls --all`
// prints them, the Sessions panel groups them, the picker splits ACTIVE from
// INACTIVE — and the portal can start one: POST /api/sessions/<id>/start on the
// apex (lib/portal/start.js). Pinned here:
//   * boot upserts, a gone or uninstalled root is pruned on read;
//   * sessions() rows carry `known`; inactive ones are surface:null, claude:null;
//   * `ls` hides inactive rows unless --all;
//   * the start route: known ids only, never a hidden project, never a path,
//     CSRF, rate limit, the access log, and the redirect url on success;
//   * the picker page: both sections and the confirm step, under the strict
//     CSP, in Georgetown Blue from the pack's own tokens.
//
// Every test runs under a throwaway HOME (withTempHome).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const { withPortal, withTempHome } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const registry = require('../lib/util/registry');
const { projectPaths } = require('../lib/core/paths');
const { sessionHost } = require('../lib/tunnel/config');
const { getBuiltin } = require('../lib/server/theme');
const ls = require('../lib/cli/commands/ls');

const DEAD_PID = 2 ** 30;

function project(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wc-known-${name}-`)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function readKnownFile() {
  return JSON.parse(fs.readFileSync(registry.knownPath(), 'utf8')).projects;
}

// ───────────────────────────────────────────── the known list ────

test('a daemon boot makes its project known; a re-boot upserts, never duplicates', (t) => {
  withTempHome(t);
  const a = project(t, 'a');
  registry.registerInstance({ root: a, port: 1, pid: process.pid, title: 'alpha' });
  let list = readKnownFile();
  assert.equal(list.length, 1);
  assert.deepEqual({ id: list[0].id, root: list[0].root, title: list[0].title },
    { id: registry.instanceId(a), root: a, title: 'alpha' });
  const first = list[0].last_seen_at;
  assert.ok(Number.isFinite(first));

  registry.rememberProject({ root: a, title: 'alpha', now: first + 5000 });
  list = readKnownFile();
  assert.equal(list.length, 1, 'one entry per root');
  assert.equal(list[0].last_seen_at, first + 5000, 'last_seen_at moves forward');
});

test('a known root that is gone, or no longer has .web-chat/, is pruned on read', (t) => {
  withTempHome(t);
  const kept = project(t, 'kept');
  const gone = project(t, 'gone');
  const uninstalled = project(t, 'uninst');
  for (const r of [kept, gone, uninstalled]) registry.rememberProject({ root: r });
  fs.rmSync(gone, { recursive: true, force: true });
  fs.rmSync(path.join(uninstalled, '.web-chat'), { recursive: true, force: true });

  const roots = registry.sessions().map((r) => r.root);
  assert.deepEqual(roots, [kept]);
  assert.deepEqual(readKnownFile().map((e) => e.root), [kept], 'and the file is rewritten without them');
});

test('sessions(): inactive rows for known projects with nothing running; every row says whether it is known', (t) => {
  withTempHome(t);
  const live = project(t, 'live');
  const asleep = project(t, 'asleep');
  const stranger = project(t, 'stranger');
  registry.registerInstance({ root: live, port: 1, pid: process.pid, title: 'live' });
  registry.rememberProject({ root: asleep, title: 'asleep', now: 42 });
  registry.registerMcp({ root: stranger, pid: process.pid, ppid: process.ppid });

  const by = Object.fromEntries(registry.sessions().map((r) => [r.root, r]));
  assert.equal(by[live].known, true);
  assert.ok(by[live].surface, 'a running project is not inactive');
  assert.equal(registry.isInactive(by[live]), false);
  assert.deepEqual(by[asleep], { root: asleep, title: 'asleep', surface: null, claude: null, known: true, last_seen_at: 42, last_package_version: null, version_skew: null });
  assert.equal(registry.isInactive(by[asleep]), true);
  assert.equal(by[stranger].known, false, 'a Claude-only project whose daemon never booted is not known');
  assert.equal(registry.isInactive(by[stranger]), false);

  assert.equal(registry.sessions({ inactive: false }).some((r) => r.root === asleep), false, 'inactive:false leaves them out');
});

test('a dead daemon\'s project reads as inactive, not gone', (t) => {
  withTempHome(t);
  const p = project(t, 'crashed');
  registry.registerInstance({ root: p, port: 1, pid: DEAD_PID, title: 'crashed' });
  const [row] = registry.sessions();
  assert.equal(row.root, p);
  assert.equal(row.surface, null);
  assert.equal(registry.isInactive(row), true);
});

test('ls: inactive projects only with --all', async (t) => {
  withTempHome(t);
  const asleep = project(t, 'asleep');
  registry.rememberProject({ root: asleep, title: 'sleepy-project' });
  const lines = [];
  await ls([], { log: (s) => lines.push(String(s)), here: null, timeoutMs: 200 });
  assert.doesNotMatch(lines.join('\n'), /sleepy-project/);
  assert.match(lines.join('\n'), /ls --all/, 'the empty listing points at --all');

  lines.length = 0;
  await ls(['--all'], { log: (s) => lines.push(String(s)), here: null, timeoutMs: 200 });
  const out = lines.join('\n');
  assert.match(out, /sleepy-project/);
  assert.match(out, /inactive/);

  lines.length = 0;
  await ls(['--json', '--all'], { log: (s) => lines.push(String(s)), here: null, timeoutMs: 200 });
  const parsed = JSON.parse(lines.join('\n'));
  assert.equal(parsed.sessions[0].known, true);
});

// ───────────────────────────────────────────── the portal start ────

// A portal over injected registry views: `known` roots (sessions() rows) and a
// `live` list the fake spawn adds to, exactly as a real daemon's boot would.
async function startRig(t, { known = [], config, spawnImpl, now } = {}) {
  const access = createFakeAccess();
  const live = [];
  const spawned = [];
  const logged = [];
  const accessLog = { record: (e) => logged.push(e) };
  const rows = () => known.map((k) => {
    const up = live.find((e) => e.root === k.root);
    return {
      root: k.root, title: path.basename(k.root), known: k.known !== false, claude: null,
      surface: up ? { running: true, port: up.port, url: `http://localhost:${up.port}`, pid: process.pid, started_at: 1 } : null,
    };
  });
  const spawnDaemon = spawnImpl || (async (root) => {
    spawned.push(root);
    const entry = { id: registry.instanceId(root), root, port: 40000 + spawned.length, pid: process.pid };
    live.push(entry);
    return { port: entry.port };
  });
  const p = await withPortal(t, {
    config: access.config(config),
    fetchJwks: access.fetchJwks,
    instances: () => live,
    sessions: rows,
    enrich: async (list) => list,
    accessLog,
    now,
    spawnDaemon,
  });
  const apex = 'https://wc.example.test';
  const post = (id, { headers = {}, rawPath } = {}) => p.request(rawPath || `/api/sessions/${id}/start`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': access.mint(), origin: apex, 'sec-fetch-site': 'same-origin', ...headers },
  });
  return { p, access, live, spawned, logged, post, apex };
}

test('start: a known, stopped project is started and the answer carries its session url', async (t) => {
  withTempHome(t);
  const root = project(t, 'known');
  const id = registry.instanceId(root);
  const r = await startRig(t, { known: [{ root }] });

  const res = await r.post(id);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(r.spawned, [root], 'the daemon was spawned for that root');
  assert.equal(res.json.ok, true);
  assert.equal(res.json.started, true);
  assert.equal(res.json.url, `https://${sessionHost(r.p.config, id)}/`);

  // The session hostname now routes (the portal's memo was dropped).
  const list = await r.p.request('/api/sessions', { headers: { 'cf-access-jwt-assertion': r.access.mint() } });
  assert.ok(list.json.sessions.find((s) => s.id === id).url, 'listed as active');

  assert.deepEqual(r.logged.map((e) => [e.instance, e.method, e.path, e.status]),
    [[id, 'POST', `/api/sessions/${id}/start`, 200]], 'the start is in the remote access log');
});

test('start: a project already running is not spawned again', async (t) => {
  withTempHome(t);
  const root = project(t, 'running');
  const id = registry.instanceId(root);
  const r = await startRig(t, { known: [{ root }] });
  r.live.push({ id, root, port: 45000, pid: process.pid });
  const res = await r.post(id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.started, false);
  assert.deepEqual(r.spawned, []);
});

test('start: refused for an unknown id, a hidden project, a non-known row, and anything path-shaped', async (t) => {
  withTempHome(t);
  const known = project(t, 'ok');
  const marked = project(t, 'marked');
  const excluded = project(t, 'excluded');
  const notKnown = project(t, 'notknown');
  fs.writeFileSync(projectPaths(marked).noRemote, '');
  const r = await startRig(t, {
    known: [{ root: known }, { root: marked }, { root: excluded }, { root: notKnown, known: false }],
    config: { expose: { exclude: [excluded] } },
  });

  const unknown = await r.post('0123abcd');
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /no known project/);
  const hiddenMarker = await r.post(registry.instanceId(marked));
  assert.equal(hiddenMarker.status, 404, 'no-remote: answered exactly like an unknown id');
  assert.deepEqual(hiddenMarker.json, unknown.json);
  assert.equal((await r.post(registry.instanceId(excluded))).status, 404, 'expose.exclude');
  assert.equal((await r.post(registry.instanceId(notKnown))).status, 404, 'a row that is not on the known list');

  // Only an 8-hex id is ever read; a path in any spelling names nothing.
  for (const rawPath of [
    `/api/sessions/${encodeURIComponent(known)}/start`,
    '/api/sessions/..%2f..%2fetc/start',
    `/api/sessions/${registry.instanceId(known)}/start?root=${encodeURIComponent(known)}`.replace('/start?', '/x/start?'),
  ]) {
    const res = await r.post(null, { rawPath });
    assert.ok(res.status === 404 || res.status === 405, `${rawPath} → ${res.status}`);
  }
  assert.deepEqual(r.spawned, [], 'nothing was spawned');
});

test('start: needs the apex\'s own Origin and a sign-in', async (t) => {
  withTempHome(t);
  const root = project(t, 'csrf');
  const id = registry.instanceId(root);
  const r = await startRig(t, { known: [{ root }] });
  assert.equal((await r.post(id, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await r.post(id, { headers: { origin: `https://${sessionHost(r.p.config, id)}` } })).status, 403,
    'a session\'s own page cannot start projects through the apex');
  assert.equal((await r.post(id, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const noOrigin = await r.p.request(`/api/sessions/${id}/start`, {
    method: 'POST', headers: { 'cf-access-jwt-assertion': r.access.mint() },
  });
  assert.equal(noOrigin.status, 403);
  const noToken = await r.p.request(`/api/sessions/${id}/start`, { method: 'POST', headers: { origin: r.apex } });
  assert.equal(noToken.status, 401);
  assert.deepEqual(r.spawned, []);

  // On a SESSION hostname the path names no daemon route: default deny.
  const viaSession = await r.p.request(`/api/sessions/${id}/start`, {
    host: sessionHost(r.p.config, id), method: 'POST',
    headers: { 'cf-access-jwt-assertion': r.access.mint(), origin: `https://${sessionHost(r.p.config, id)}` },
  });
  assert.equal(viaSession.status, 404, 'a stopped session\'s hostname is the friendly 404, not a start');
});

test('start: one per id per 10s — a second is 429 with retry-after; another id is not held up', async (t) => {
  withTempHome(t);
  const a = project(t, 'ra');
  const b = project(t, 'rb');
  let clock = Date.now();
  const r = await startRig(t, {
    known: [{ root: a }, { root: b }],
    now: () => clock,
    // A start that never comes up still spends the attempt.
    spawnImpl: async (root) => { r.spawned.push(root); return null; },
  });
  const idA = registry.instanceId(a);
  const first = await r.post(idA);
  assert.equal(first.status, 504, first.text);
  assert.match(first.json.error, /did not come up/);
  const second = await r.post(idA);
  assert.equal(second.status, 429);
  assert.equal(second.headers['retry-after'], '10');
  assert.equal((await r.post(registry.instanceId(b))).status, 504, 'the limit is per id');
  clock += 10_000;
  assert.equal((await r.post(idA)).status, 504, 'after 10s it may try again');
  assert.equal(r.spawned.length, 3);
});

// ───────────────────────────────────────────── the picker page ────

test('picker assets: Georgetown Blue from the pack\'s own tokens, fonts same-origin, strict CSP', async (t) => {
  withTempHome(t);
  const r = await startRig(t);
  const auth = { 'cf-access-jwt-assertion': r.access.mint() };
  const css = await r.p.request('/theme.css', { headers: auth });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  const gt = getBuiltin('georgetown-blue');
  assert.ok(css.text.includes(`--wc-accent: ${gt.modes.light.tokens['--wc-accent']};`), 'light accent');
  const dark = css.text.slice(css.text.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(dark.includes(`--wc-bg: ${gt.modes.dark.tokens['--wc-bg']};`), 'dark ground under prefers-color-scheme');
  assert.ok(css.text.includes('Libre Caslon Text'));

  const page = await r.p.request('/', { headers: auth });
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /font-src 'self'/);
  assert.doesNotMatch(page.text, /<script>[^<]/, 'no inline script');
  assert.doesNotMatch(page.text, /style=/, 'no inline style');

  const font = await r.p.request('/fonts/LibreCaslonText-Regular.latin.woff2', { headers: auth });
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal((await r.p.request('/fonts/..%2fapp.css', { headers: auth })).status, 404);
  assert.equal((await r.p.request('/fonts/nope.woff2', { headers: auth })).status, 404);
});

// The picker's own script in a DOM, fed a canned /api/sessions.
async function pickerDom(sessions) {
  const dir = path.join(__dirname, '..', 'lib', 'portal', 'public');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, { url: 'https://wc.example.test/', runScripts: 'outside-only' });
  const { window } = dom;
  const posts = [];
  const assigned = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST') {
      posts.push(u);
      return { ok: true, status: 200, json: async () => ({ ok: true, url: 'https://wc-abcd1234.example.test/' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, email: 'me@example.com', host: 'studio', sessions }) };
  };
  window.setInterval = () => 0;
  window.__assign = (u) => assigned.push(u);
  const src = fs.readFileSync(path.join(dir, 'app.js'), 'utf8').replace('window.location.assign(', 'window.__assign(');
  window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((res) => setTimeout(res, 20));
  return { window, doc: window.document, posts, assigned };
}

test('picker page: ACTIVE and INACTIVE sections, every row clickable, confirm-to-start then redirect', async () => {
  const { window, doc, posts, assigned } = await pickerDom([
    { id: 'aaaa1111', title: 'running-one', url: 'https://wc-aaaa1111.example.test/', known: true,
      surface: { reachable: true, started_at: null, viewers: 1, turn: null, active_label: 'n1.2' }, claude: null },
    { id: 'abcd1234', title: 'sleepy <b>one</b>', url: null, known: true, last_seen_at: Date.now() - 3_600_000, surface: null, claude: null },
    { id: 'bbbb2222', title: 'never-booted', url: null, known: false, surface: null,
      claude: { sessions: 1, channel: false, last_tool_at: null } },
  ]);
  assert.equal(doc.getElementById('host').textContent, 'studio');
  const active = doc.getElementById('active');
  const inactive = doc.getElementById('inactive');
  assert.equal(doc.getElementById('active-group').hidden, false);
  assert.equal(doc.getElementById('inactive-group').hidden, false);
  assert.equal(active.querySelectorAll('li').length, 1);
  assert.equal(active.querySelector('a').getAttribute('href'), 'https://wc-aaaa1111.example.test/');
  const buttons = inactive.querySelectorAll('button.card');
  assert.equal(buttons.length, 2, 'every inactive row is a button');
  assert.equal(inactive.querySelector('b'), null, 'a title is text, never markup');
  assert.match(buttons[0].textContent, /last up 1h ago/);

  // Not known here: the click explains, and offers no Start.
  buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('confirm').hidden, false);
  assert.match(doc.getElementById('confirm-q').textContent, /never-booted has not been started on studio/);
  assert.equal(doc.getElementById('confirm-go').hidden, true);
  doc.getElementById('confirm-cancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('confirm').hidden, true);
  assert.deepEqual(posts, [], 'nothing started by looking');

  buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('confirm-q').textContent, 'Start sleepy <b>one</b> on studio?');
  assert.equal(doc.getElementById('confirm-go').hidden, false);
  doc.getElementById('confirm-go').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(posts, ['/api/sessions/abcd1234/start']);
  assert.deepEqual(assigned, ['https://wc-abcd1234.example.test/'], 'then it goes to the session');
  window.close();
});

test('picker: listSessions carries each side\'s release and the restart sentence', async () => {
  const { listSessions } = require('../lib/portal/picker');
  const config = { hostname: 'wc.example.test', naming: 'flat', showRoots: false };
  const rows = [
    { root: '/x/skewed', title: 'skewed', known: true,
      surface: { running: true, port: 1, pid: 2, reachable: true, package_version: '0.8.0' },
      claude: { sessions: 1, channel: false, pids: [3], last_tool_at: null, package_versions: [{ version: '0.7.6', sessions: 1 }] } },
    { root: '/x/asleep', title: 'asleep', known: true, surface: null, claude: null, last_seen_at: 1, last_package_version: '0.7.6' },
  ];
  const out = await listSessions({ config, rows, enrich: async (r) => r.map((x) => ({ ...x, version_skew: registry.versionSkew(x) })) });
  assert.equal(out[0].surface.package_version, '0.8.0');
  assert.deepEqual(out[0].claude.package_versions, [{ version: '0.7.6', sessions: 1 }]);
  assert.equal(out[0].version_note, 'Claude is on v0.7.6 — restart Claude Code to pick up v0.8.0');
  assert.equal(out[1].version_note, null);
  assert.equal(out[1].last_package_version, '0.7.6');
  assert.equal(JSON.stringify(out).includes('"pids"'), false, 'still no pids');
});

test('picker page: release chips (full string in the tooltip) and the ⚠ line only on a mismatch', async () => {
  const DEV = '0.8.0-dev.202609280312.abc1234';
  const { window, doc } = await pickerDom([
    { id: 'aaaa1111', title: 'skewed', url: 'https://wc-aaaa1111.example.test/', known: true,
      surface: { reachable: true, started_at: null, viewers: 1, turn: null, active_label: null, package_version: DEV },
      claude: { sessions: 1, channel: false, last_tool_at: null, package_versions: [{ version: '0.7.6', sessions: 1 }] },
      version_note: `Claude is on v0.7.6 — restart Claude Code to pick up v${DEV}` },
    { id: 'bbbb2222', title: 'fine', url: 'https://wc-bbbb2222.example.test/', known: true,
      surface: { reachable: true, started_at: null, viewers: 0, turn: null, active_label: null, package_version: '0.8.0' },
      claude: { sessions: 1, channel: false, last_tool_at: null, package_versions: [{ version: '0.8.0', sessions: 1 }] }, version_note: null },
    { id: 'cccc3333', title: 'asleep', url: null, known: true, surface: null, claude: null, last_package_version: '0.7.6', version_note: null },
  ]);
  const [skewed, fine] = doc.getElementById('active').querySelectorAll('li');
  const chips = [...skewed.querySelectorAll('.ver')];
  assert.deepEqual(chips.map((c) => c.textContent), [`v${DEV}`, 'v0.7.6']);
  assert.equal(chips[0].title, `web-chat ${DEV}`);
  assert.match(skewed.querySelector('.warn').textContent, /^⚠ Claude is on v0\.7\.6 — restart Claude Code/);
  assert.equal(fine.querySelector('.warn'), null, 'no mismatch, no warning');
  assert.equal(doc.getElementById('inactive').querySelector('.ver').textContent, 'v0.7.6', 'an inactive row: the release it last ran');
  window.close();
});

test('picker page: an empty machine says so; no section headers', async () => {
  const { window, doc } = await pickerDom([]);
  assert.equal(doc.getElementById('active-group').hidden, true);
  assert.equal(doc.getElementById('inactive-group').hidden, true);
  assert.match(doc.getElementById('state').textContent, /No web-chat project is known/);
  window.close();
});

test('startTarget: only a POST to the start route names an id', () => {
  const { startTarget, START_ROUTE } = require('../lib/portal/start');
  assert.equal(startTarget('POST', START_ROUTE.replace(':id', 'ABCD1234')), 'abcd1234');
  assert.equal(startTarget('GET', START_ROUTE.replace(':id', 'abcd1234')), null);
  assert.equal(startTarget('POST', '/api/sessions/abcd1234'), null);
  assert.equal(startTarget('POST', '/api/sessions/a/b/start'), null);
});
