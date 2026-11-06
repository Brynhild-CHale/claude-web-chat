// The system soak's harness (annotation engine tranche 4, H.11, U579):
// scripts/soak/ supplies the start, drive, sample and stop commands and the
// thresholds file for the workflow-shape skill's soak.sh template, which the
// runner hands in as SOAK_SH (never copied into this repository).
//
// Pinned here, with no daemon:
//   * lib.js's band and isolation: a port base whose daemon or hub port is in
//     5173–5272 or on 5170 is refused (exit 2 from the CLI, nothing written), a
//     HOME isHomeDir answers for is refused, and soakEnv points HOME,
//     USERPROFILE and CLAUDE_CONFIG_DIR inside the root with the CLAUDE_CODE_*
//     family (and the rest of test-support/sandbox.js's scrub) gone;
//   * thresholds.json: every counter it judges is one sample.js may print
//     (NAMES); every rule holds only max, max_growth or max_slope_per_min with
//     a number once resolved; mirror_parsed's bound is the retention table's,
//     read through its own lookup, never a literal;
//   * sample.js's formatter over injected sources prints only 'name number'
//     lines, one per NAMES entry it has a value for, nothing for a missing
//     source;
//   * fixture.js's copy keeps every file's mtime and refuses a target root
//     that is not empty; its head read follows a worktree's git files;
//   * the strokes rows (U641): the drive's per-frame stroke counters are in
//     NAMES, stroke_failures is judged at max 0, and every soak pane carries
//     an svg (the drive's strokes themselves: test/element-packs-stage.test.js).
//
// And opt-in (WEB_CHAT_E2E_SOAK=1 with SOAK_SH set, through e2eGate; CI never
// sets it): run.sh --minutes 2 in a tmp --out writes report.json with passed
// true, daemons_per_root never above 1, and after the stop no daemon and no
// hub in the soak HOME's registry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { e2eGate } = require('../test-support/helpers');
const { fence } = require('../lib/core/paths');
const { readJson } = require('../lib/core/fsjson');
const { isPidAlive } = require('../lib/core/portfiles');
const { valueOf } = require('../lib/server/mirror/retention');
const { SCAN_PORTS } = require('../lib/util/registry');
const { DEFAULT_HUB_PORT } = require('../lib/util/hub');

const SOAK = path.join(__dirname, '..', 'scripts', 'soak');
const lib = require('../scripts/soak/lib');
const sample = require('../scripts/soak/sample');
const fixture = require('../scripts/soak/fixture');

const tmp = (prefix) => fs.mkdtempSync(path.join(SANDBOX, prefix));

// ── lib.js ───────────────────────────────────────────────────────────────────

test('lib.js refuses a port base whose daemon or hub port is in 5173–5272 or on 5170, and accepts one outside', () => {
  for (const base of [SCAN_PORTS[0], 5200, SCAN_PORTS[SCAN_PORTS.length - 1], SCAN_PORTS[0] - 1, DEFAULT_HUB_PORT, DEFAULT_HUB_PORT - 1]) {
    assert.throws(() => lib.bandOf(base), (e) => e.code === 'SOAK_REFUSED' && typeof e.hint === 'string', `port base ${base} is refused`);
  }
  for (const p of [...SCAN_PORTS, DEFAULT_HUB_PORT]) assert.equal(lib.forbiddenPort(p), true, `${p} is forbidden`);
  assert.deepEqual(lib.bandOf(lib.SOAK_PORT_BASE_DEFAULT), { port: 6400, hubPort: 6401 });
  assert.deepEqual(lib.bandOf('7100'), { port: 7100, hubPort: 7101 }, 'the env var\'s string form');
  assert.throws(() => lib.bandOf('nope'), /not a port/);
});

test('lib.js prepare refuses the band at the CLI with exit 2 and writes nothing', () => {
  const root = tmp('wc-soak-refuse-');
  for (const base of ['5173', '5170', '5169']) {
    const r = spawnSync(process.execPath, [path.join(SOAK, 'lib.js'), 'prepare', '--root', root, '--out', root, '--port-base', base], { encoding: 'utf8' });
    assert.equal(r.status, 2, `--port-base ${base}: ${r.stderr}`);
    assert.match(r.stderr, /hint: /);
  }
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was written under the root');
});

test('lib.js refuses a HOME isHomeDir answers true for, and accepts a fresh one', () => {
  assert.throws(() => lib.checkHome(process.env.HOME), (e) => e.code === 'SOAK_REFUSED', 'the home this process runs in');
  const used = tmp('wc-soak-used-');
  fs.mkdirSync(path.join(used, '.web-chat'));
  fs.writeFileSync(path.join(used, '.web-chat', 'instances.json'), '{"instances":[]}');
  assert.throws(() => lib.checkHome(used), (e) => e.code === 'SOAK_REFUSED', 'a HOME that already holds a user tier');
  assert.throws(() => lib.checkHome('relative/home'), (e) => e.code === 'SOAK_REFUSED');
  const fresh = path.join(tmp('wc-soak-fresh-'), 'home');
  assert.equal(lib.checkHome(fresh), fresh);
  // prepare runs the check before it writes: a reused root (its HOME already a
  // user tier) never gets a record.
  const reused = tmp('wc-soak-reused-');
  fs.mkdirSync(path.join(reused, 'home', '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(reused, 'home', '.web-chat', 'instances.json'), '{"instances":[]}');
  assert.throws(() => lib.prepare({ root: reused, out: reused, portBase: 6400 }), (e) => e.code === 'SOAK_REFUSED');
  assert.equal(fs.existsSync(path.join(reused, 'soak.json')), false);
});

test('lib.js soakEnv: HOME, USERPROFILE and CLAUDE_CONFIG_DIR inside the root, the CLAUDE_CODE_* family and the sandbox scrub gone, the base untouched', () => {
  const root = tmp('wc-soak-env-');
  const cfg = lib.prepare({ root, out: path.join(root, 'out'), portBase: 6400 });
  const base = {
    PATH: '/usr/bin', HOME: '/Users/someone', USERPROFILE: '/Users/someone', CLAUDE_CONFIG_DIR: '/Users/someone/.claude',
    CLAUDE_PID: '1', CLAUDECODE: '1', CLAUDE_EFFORT: 'high', CLAUDE_JOB_DIR: '/x',
    CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_MESSAGING_TOKEN: 't',
    WEB_CHAT_CHANNEL: '1', WEB_CHAT_PORT: '5173', WEB_CHAT_HOST: '0.0.0.0', WEB_CHAT_TEST_SANDBOX: '/elsewhere',
  };
  const frozen = JSON.stringify(base);
  const env = lib.soakEnv(cfg, base);
  assert.equal(JSON.stringify(base), frozen, 'pure: the base is not touched');
  for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(fence(cfg.root, env[k]) !== null, `${k}=${env[k]} sits inside the root ${cfg.root}`);
  }
  assert.equal(env.HOME, cfg.home);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(cfg.home, '.claude'));
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_')), [], 'the CLAUDE_CODE_* family is scrubbed');
  for (const k of [...lib.SCRUB_EXACT, 'WEB_CHAT_CHANNEL', 'WEB_CHAT_PORT', 'WEB_CHAT_HOST', 'WEB_CHAT_TEST_SANDBOX']) assert.equal(env[k], undefined, `${k} is scrubbed`);
  assert.equal(env.WEB_CHAT_HUB_PORT, '6401', 'the hub on the band');
  assert.equal(env.PATH, '/usr/bin', 'everything else passes');
  // The record soak.json, read back by every script.
  const rec = lib.readRecord(root);
  assert.equal(rec.port, 6400);
  assert.equal(rec.home, cfg.home);
});

// ── thresholds.json ──────────────────────────────────────────────────────────

const RAW = JSON.parse(fs.readFileSync(path.join(SOAK, 'thresholds.json'), 'utf8'));
const RESOLVED = lib.resolveThresholds(RAW);

test('thresholds.json: every counter it judges is in sample.js NAMES; each rule holds only max, max_growth or max_slope_per_min, with a number', () => {
  assert.ok(Object.keys(RESOLVED).length >= 10, 'the rules are there');
  for (const [name, rule] of Object.entries(RESOLVED)) {
    assert.ok(sample.NAMES.includes(name), `${name} is a counter sample.js prints`);
    const keys = Object.keys(rule).filter((k) => !k.startsWith('_'));
    assert.ok(keys.length >= 1, `${name} has a rule`);
    for (const k of keys) {
      assert.ok(lib.RULE_KEYS.includes(k), `${name}.${k} is one of ${lib.RULE_KEYS.join(', ')}`);
      assert.equal(typeof rule[k], 'number', `${name}.${k} is a number`);
      assert.ok(Number.isFinite(rule[k]), `${name}.${k} is finite`);
    }
    assert.equal(typeof rule._why, 'string', `${name} says why`);
  }
  // The shape soak.sh's judge reads (thresholds.json's keys, `name` → rule).
  for (const k of ['daemons_per_root', 'reconnect_failures', 'restart_failures', 'write_failures', 'script_errors']) {
    assert.ok(RESOLVED[k] && 'max' in RESOLVED[k], `${k} is judged by max`);
  }
  assert.equal(RESOLVED.daemons_per_root.max, 1);
});

test('thresholds.json: mirror_parsed\'s bound is read from lib/server/mirror/retention.js at run time, never a literal; viewers and mirror_watchers are the drive\'s own numbers', () => {
  assert.equal('max' in RAW.mirror_parsed, false, 'no literal bound in the file');
  assert.equal(RAW.mirror_parsed._max_from, 'retention:parsed-conversations-max');
  assert.equal(RESOLVED.mirror_parsed.max, valueOf('parsed-conversations-max'));
  // Through the table's own lookup at resolve time, not a number lib.js carries
  // that merely equals today's row: a changed row moves the bound.
  const retention = require('../lib/server/mirror/retention');
  const real = retention.valueOf;
  retention.valueOf = (id) => (id === 'parsed-conversations-max' ? 4242 : real(id));
  try {
    assert.equal(lib.resolveThresholds(RAW).mirror_parsed.max, 4242, 'the bound follows retention.valueOf');
  } finally {
    retention.valueOf = real;
  }
  assert.equal('max' in RAW.viewers, false);
  assert.equal(RESOLVED.viewers.max, lib.DRIVE_SOCKETS);
  assert.equal('max' in RAW.mirror_watchers, false);
  assert.equal(RESOLVED.mirror_watchers.max, lib.DRIVE_RESTART_EVERY + lib.WATCH_SLACK, 'a daemon\'s conversation reads, plus the slack');
  assert.equal(require('../scripts/soak/drive').RESTART_EVERY, lib.DRIVE_RESTART_EVERY, 'the drive restarts on the cadence the bound assumes');
  assert.throws(() => lib.resolveThresholds({ x: { _max_from: 'nowhere' } }), /unknown _max_from/);
});

// ── sample.js ────────────────────────────────────────────────────────────────

const LINE = /^[a-z_]+ -?[0-9.]+$/;
const PROC = { at: Date.now(), heap_used_mb: 41.237, rss_mb: 88.5, handles: 7, timers: 3, mirror_timers: 1, mirror_watchers: 2, mirror_conversations: 50, mirror_parsed: 4, services: 0 };
const HEALTH = { ok: true, viewers: 1, nodes: 312, lock: null, pid: 1 };
const REGISTRY = { daemons: [{ pid: 1, port: 6400, source: 'portfile' }], unknown: [] };
const DRIVE = Object.fromEntries(sample.DRIVE_NAMES.map((k, i) => [k, i]));

function parse(text) {
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'every line ends in a newline');
  for (const l of lines) assert.match(l, LINE);
  const names = lines.map((l) => l.split(' ')[0]);
  assert.equal(new Set(names).size, names.length, 'one line per name');
  return Object.fromEntries(lines.map((l) => { const [k, v] = l.split(' '); return [k, Number(v)]; }));
}

test('sample.js formatSample: only "name number" lines, one per NAMES entry it has a value for', () => {
  const got = parse(sample.formatSample({ proc: PROC, health: HEALTH, registry: REGISTRY, drive: DRIVE, scriptErrors: 0, packListed: 0 }));
  assert.deepEqual(Object.keys(got), sample.NAMES.slice(), 'every name, in NAMES order');
  assert.equal(got.heap_used_mb, 41.24);
  assert.equal(got.lock_held, 0);
  assert.equal(got.daemons_per_root, 1);
  assert.equal(got.viewers, 1);
  assert.equal(parse(sample.formatSample({ health: { ...HEALTH, lock: { message: 'x' } } })).lock_held, 1);
});

test('sample.js formatSample: nothing for a missing source, and nothing for a value that is not a finite number', () => {
  assert.equal(sample.formatSample({}), '', 'no source, no line');
  const noProc = parse(sample.formatSample({ health: HEALTH, registry: REGISTRY, drive: DRIVE }));
  for (const k of sample.PROC_NAMES) assert.equal(k in noProc, false, `${k}: proc.json missing`);
  for (const k of [...sample.EXTRA_NAMES]) assert.equal(k in noProc, false, `${k}: its source missing`);
  const noDrive = parse(sample.formatSample({ proc: PROC }));
  assert.deepEqual(Object.keys(noDrive), sample.PROC_NAMES.slice());
  const odd = parse(sample.formatSample({ proc: { heap_used_mb: 'x', rss_mb: NaN, handles: Infinity, timers: 1e30, services: null, mirror_parsed: -2 } }));
  assert.deepEqual(odd, { mirror_parsed: -2 });
  const noDaemons = parse(sample.formatSample({ registry: { daemons: [] } }));
  assert.deepEqual(noDaemons, { daemons_per_root: 0 }, 'an empty registry is 0, a missing one nothing');
});

test('the strokes rows (U641): sample.js prints the drive\'s three per-frame stroke counters, thresholds.json judges stroke_failures at max 0, and drive.js counts each', () => {
  for (const k of ['stroke_writes', 'stroke_failures', 'stroke_writes_element', 'stroke_writes_pane', 'stroke_writes_page']) {
    assert.ok(sample.DRIVE_NAMES.includes(k), `${k} is a drive counter sample.js prints`);
    assert.ok(require('../scripts/soak/drive').COUNTERS.includes(k), `${k} is one drive.js keeps`);
  }
  assert.deepEqual(Object.keys(RESOLVED.stroke_failures).filter((k) => !k.startsWith('_')), ['max']);
  assert.equal(RESOLVED.stroke_failures.max, 0, 'a refused stroke is a fault (RULED I4 a)');
  for (const k of ['stroke_writes', 'stroke_writes_element', 'stroke_writes_pane', 'stroke_writes_page']) {
    assert.equal(k in RESOLVED, false, `${k} is read from report.json's counters, not judged`);
  }
});

// ── fixture.js ───────────────────────────────────────────────────────────────

test('fixture.js paneHtml carries one inline svg, a fixed-aspect target for the drive\'s element-anchored stroke', () => {
  for (const id of fixture.PANES) {
    const html = fixture.paneHtml(id, 'd1');
    assert.equal((html.match(/<svg\b/g) || []).length, 1, `${id}: one svg`);
    assert.match(html, /<svg [^>]*viewBox="0 0 \d+ \d+"/, 'with a viewBox (its aspect)');
    assert.match(html, /^<section class="soak">[\s\S]*<\/section>$/, 'one outermost element, the pane frame\'s record');
  }
});

test('fixture.js copyFixture keeps every file\'s mtime and refuses a target that is not empty', () => {
  const dir = tmp('wc-soak-copy-');
  const src = path.join(dir, 'src');
  const files = ['.web-chat/graph/n1.json', '.web-chat/graph/_meta.json', '.web-chat/graph-index.json', '.web-chat/mirror/conversations.json'];
  const old = new Date('2026-01-02T03:04:05.678Z');
  files.forEach((f, i) => {
    const p = path.join(src, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `{"i":${i}}`);
    const t = new Date(old.getTime() + i * 1000);
    fs.utimesSync(p, t, t);
  });
  const dst = path.join(dir, 'dst');
  fixture.copyFixture(src, dst);
  for (const f of files) {
    const a = fs.statSync(path.join(src, f)).mtimeMs;
    const b = fs.statSync(path.join(dst, f)).mtimeMs;
    assert.ok(Math.abs(a - b) < 1, `${f}: mtime ${b} kept (${a})`);
    assert.equal(fs.readFileSync(path.join(dst, f), 'utf8'), fs.readFileSync(path.join(src, f), 'utf8'));
  }
  // An empty existing directory is a fresh target; a non-empty one is refused.
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  fixture.copyFixture(src, empty);
  assert.throws(() => fixture.copyFixture(src, dst), /is not empty/);
  assert.throws(() => fixture.copyFixture(src, empty), /is not empty/);
});

test('fixture.js headSha follows a worktree\'s .git file to its HEAD, its ref and packed-refs', () => {
  const dir = tmp('wc-soak-git-');
  const common = path.join(dir, 'repo.git');
  const gitdir = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(path.join(common, 'refs', 'heads', 'ae'), { recursive: true });
  fs.mkdirSync(gitdir, { recursive: true });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/ae/int\n');
  fs.writeFileSync(path.join(common, 'packed-refs'), `# pack-refs with: peeled\n${B} refs/heads/ae/int\n`);
  assert.equal(fixture.headSha(wt), B, 'from packed-refs');
  fs.writeFileSync(path.join(common, 'refs', 'heads', 'ae', 'int'), `${A}\n`);
  assert.equal(fixture.headSha(wt), A, 'a loose ref wins');
  fs.writeFileSync(path.join(gitdir, 'HEAD'), `${B}\n`);
  assert.equal(fixture.headSha(wt), B, 'a detached HEAD');
  assert.equal(fixture.headSha(path.join(dir, 'nowhere')), null);
});

// ── the whole soak (opt-in) ─────────────────────────────────────────────────

test('e2eGate([\'soak\']): opt-in by WEB_CHAT_E2E_SOAK=1, and then only with SOAK_SH an absolute existing file and python3 on the gate\'s PATH', () => {
  assert.match(e2eGate(['soak'], { env: { SOAK_SH: '/x/soak.sh' }, find: { soak: () => '/x/soak.sh' } }).skip, /WEB_CHAT_E2E_SOAK=1/);
  const dir = tmp('wc-soak-gate-');
  const sh = path.join(dir, 'soak.sh');
  fs.writeFileSync(sh, '#!/bin/bash\n');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const on = { WEB_CHAT_E2E_SOAK: '1' };
  assert.match(e2eGate(['soak'], { env: { ...on, PATH: bin } }).skip, /SOAK_SH/, 'no SOAK_SH');
  assert.match(e2eGate(['soak'], { env: { ...on, PATH: bin, SOAK_SH: 'soak.sh' } }).skip, /SOAK_SH/, 'a relative SOAK_SH');
  assert.match(e2eGate(['soak'], { env: { ...on, PATH: bin, SOAK_SH: sh } }).skip, /python3/, 'no python3');
  fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'python3'), 0o755);
  assert.deepEqual(e2eGate(['soak'], { env: { ...on, PATH: bin, SOAK_SH: sh } }), { skip: false, soak: sh });
});

const e2e = e2eGate(['soak']);

test('opt-in: run.sh --minutes 2 writes report.json with passed true, daemons_per_root never above 1, and leaves no daemon and no hub', { skip: e2e.skip, timeout: 12 * 60 * 1000 }, async () => {
  const out = tmp('wc-soak-e2e-');
  const code = await new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(SOAK, 'run.sh'), '--int', path.join(__dirname, '..'), '--out', out, '--minutes', '2'], {
      env: { ...process.env, SOAK_SH: e2e.soak }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', reject);
    child.on('close', (c) => { fs.writeFileSync(path.join(out, 'run.log'), log); resolve(c); });
  });
  const report = readJson(path.join(out, 'report.json'));
  assert.ok(report.ok, `report.json exists (run.sh exit ${code}; ${path.join(out, 'run.log')})`);
  assert.equal(report.value.passed, true, `the soak passed: ${JSON.stringify(report.value.failures)}`);
  assert.equal(code, 0);
  const row = report.value.counters.find((c) => c.name === 'daemons_per_root');
  assert.ok(row && row.max <= 1, `daemons_per_root never above 1: ${JSON.stringify(row)}`);
  const roots = fs.readdirSync(out).filter((n) => n.startsWith('root.'));
  assert.equal(roots.length, 1, 'one fresh root');
  const reg = readJson(path.join(out, roots[0], 'home', '.web-chat', 'instances.json'));
  const live = (reg.ok ? reg.value.instances : []).filter((e) => e && (e.role === 'hub' || (e.role || 'instance') === 'instance') && isPidAlive(e.pid));
  assert.deepEqual(live, [], 'no daemon and no hub left in the soak HOME\'s registry');
});
