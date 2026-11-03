'use strict';
// scripts/soak/fixture.js — the soak's project: 300 committed nodes and a
// synthetic Claude Code tier of 50 conversations (H.11, U579).
//
// THE NODES are primed ONCE per int head, through the daemon's own commit path
// — an in-process createServer at the band's port (no portfile, no registry
// entry, no hub), and per turn POST /api/turn-begin, POST /api/render of the
// three panes (stable ids, PANES), POST /api/markdown of one item (MD_ID), POST
// /api/turn-end — never node files written by hand. The primed project is
// cached under the soak's cache dir (--cache, else SOAK_CACHE, else
// <os tmpdir>/web-chat-soak-cache), keyed by the head's sha (read from the int
// worktree's git files, no git program), and copied into each run's root with
// fs.cpSync(…, {recursive: true, preserveTimestamps: true}) — mtimes kept, so a
// graph index keyed by stat (U572's .web-chat/graph-index.json) is read on boot
// rather than rebuilt. A target that is not empty is refused (one daemon per
// root; a reused root is a false failure).
//
// THE CLAUDE TIER is written per run, because Claude Code keys a project's
// transcripts by the project's physical path (lib/core/paths
// claudeProjectSlug), which is the run's root: 50 transcripts built by
// test-support/claude-records createRecords and written through
// test-support/claude-home into the soak's CLAUDE_CONFIG_DIR, and for each a
// SessionStart and a SessionEnd envelope (lib/hooks/envelope hookEnvelope)
// posted to the host-only intake POST /api/hooks/event of a second in-process
// boot, so the mirror's registry lists them (and persists them for the soak's
// daemon). Never a copy of ~/.claude. The claude-home fixture refuses to build
// outside its sandbox, which here is the soak's HOME (WEB_CHAT_TEST_SANDBOX is
// set to it in this process only, before the fixture is required).
//
// THE STROKES PACK (U565, wave 3): when <int>/test-support/element-packs/
// strokes-fixture/ exists and <int>/test-support/element-packs exports
// stageStrokesFixture(root) → {name}, the pack is staged into the project's
// quarantine and approved through the control domain's 'pack-approve' row
// (lib/server/control/pack-approve.js), as a person's confirm would. Absent,
// the soak runs without it and sample.js prints pack_listed 0.
//
//   node scripts/soak/fixture.js --root R --int <worktree> [--cache DIR] [--nodes 300] [--conversations 50]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { enter, parseArgs, runMain } = require('./lib');
const client = require('../../lib/client');
const { readJson, writeJsonAtomic } = require('../../lib/core/fsjson');

const NODES = 300;
const CONVERSATIONS = 50;
const PANES = Object.freeze(['soak-a', 'soak-b', 'soak-c']);
const MD_ID = 'md-soak';
const SHA_RE = /^[0-9a-f]{40}$/;
const CALL = { timeout: 15000 };

// ── the page the soak writes, turn after turn (drive.js writes the same) ────
function paneHtml(id, n) {
  return `<section class="soak"><p class="lead">Hello world — ${id}, turn ${n}</p>`
    + `<p>The soak re-renders this pane once a minute; its text changes so the turn commits a node.</p>`
    + `<ul><li>pane ${id}</li><li>turn ${n}</li></ul></section>`;
}
function markdownText(n) {
  return `## Soak turn ${n}\n\nThe soak's markdown item, rewritten on every turn.`;
}

// One turn through the daemon's commit path: lock, three panes, the markdown
// item, Stop. → turn-end's answer.
async function commitTurn(port, n, { message = `soak turn ${n}` } = {}) {
  const opts = { ...CALL, port };
  await client.post('/api/turn-begin', { message, author: 'user' }, opts);
  for (const id of PANES) await client.post('/api/render', { id, html: paneHtml(id, n) }, opts);
  await client.post('/api/markdown', { id: MD_ID, text: markdownText(n) }, opts);
  return client.post('/api/turn-end', { author: 'claude', summary: `soak turn ${n}` }, opts);
}

// ── the int head's sha, from its git files ──────────────────────────────────
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function headSha(worktree) {
  const dotgit = path.join(worktree, '.git');
  let gitdir = dotgit;
  let st;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotgit) || '');
    if (!m) return null;
    gitdir = path.resolve(worktree, m[1].trim());
  }
  const common = (() => {
    const c = readText(path.join(gitdir, 'commondir'));
    return c ? path.resolve(gitdir, c.trim()) : gitdir;
  })();
  const head = (readText(path.join(gitdir, 'HEAD')) || '').trim();
  if (SHA_RE.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head);
  if (!ref) return null;
  for (const base of [gitdir, common]) {
    const v = (readText(path.join(base, ref[1])) || '').trim();
    if (SHA_RE.test(v)) return v;
  }
  for (const line of (readText(path.join(common, 'packed-refs')) || '').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref[1] && SHA_RE.test(sha)) return sha;
  }
  return null;
}

// ── the copy ─────────────────────────────────────────────────────────────────
function isEmptyDir(p) {
  try { return fs.readdirSync(p).length === 0; } catch (e) { return e.code === 'ENOENT'; }
}

function copyFixture(src, dst) {
  if (!isEmptyDir(dst)) throw new Error(`soak fixture: ${dst} is not empty — a soak root is made fresh per run`);
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
  return dst;
}

// ── an in-process boot (priming and seeding; never the soak's own daemon) ───
async function withBoot(project, port, fn) {
  const { createServer } = require('../../lib/server');
  const srv = createServer({ root: project, port });
  await srv.start({ writePortfile: false });
  try { return await fn(srv); } finally { await srv.gracefulShutdown(); }
}

async function primeProject(project, port, { nodes = NODES, log = console.log } = {}) {
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  await withBoot(project, port, async () => {
    const opts = { ...CALL, port };
    await client.post('/api/markdown', { id: 'md-title', text: '# Soak', after: 'start' }, opts);
    for (let n = 1; n <= nodes; n++) {
      const r = await commitTurn(port, n, { message: `soak prime ${n}` });
      if (!r || !r.node_id) throw new Error(`soak fixture: prime turn ${n} committed no node: ${JSON.stringify(r)}`);
      if (n % 50 === 0) log(`soak fixture: primed ${n}/${nodes} nodes`);
    }
    const h = await client.get('/api/health', opts);
    if (!(h.nodes >= nodes)) throw new Error(`soak fixture: the primed graph holds ${h.nodes} nodes, not ${nodes}`);
  });
}

// The cached project for `sha`, primed when absent. Primed into a fresh
// directory beside the cache entry, then renamed into place; a concurrent
// primer that won the rename leaves ours to be removed.
async function cachedProject({ cache, sha, port, nodes, log = console.log }) {
  const entry = path.join(cache, `${sha}-${nodes}`);
  const marker = path.join(entry, 'fixture.json');
  if (readJson(marker).ok) return path.join(entry, 'project');
  fs.mkdirSync(cache, { recursive: true });
  const work = fs.mkdtempSync(path.join(cache, `${sha}-priming-`));
  const t0 = Date.now();
  log(`soak fixture: priming ${nodes} nodes for ${sha.slice(0, 12)} in ${work}`);
  await primeProject(path.join(work, 'project'), port, { nodes, log });
  writeJsonAtomic(path.join(work, 'fixture.json'), { v: 1, sha, nodes, primed_ms: Date.now() - t0, at: Date.now() });
  if (fs.existsSync(entry)) fs.rmSync(entry, { recursive: true, force: true });
  try { fs.renameSync(work, entry); } catch (e) {
    if (!readJson(marker).ok) throw e;
    fs.rmSync(work, { recursive: true, force: true });
  }
  log(`soak fixture: primed in ${Date.now() - t0} ms`);
  return path.join(entry, 'project');
}

// <root>/fixture.json: what this run's fixture holds, for drive.js.
const fixtureRecord = (cfg) => path.join(cfg.root, 'fixture.json');
function readFixtureRecord(cfg) {
  const got = readJson(fixtureRecord(cfg));
  return got.ok && got.value && typeof got.value === 'object' ? got.value : null;
}

// ── the Claude Code tier ────────────────────────────────────────────────────
const sessionIdOf = (i) => `${(0xb0000000 + i).toString(16)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function seedConversations(cfg, srv, { count = CONVERSATIONS, intDir, log = console.log } = {}) {
  process.env.WEB_CHAT_TEST_SANDBOX = cfg.home;
  const { claudeHome } = require(path.join(intDir, 'test-support', 'claude-home'));
  const { createRecords } = require(path.join(intDir, 'test-support', 'claude-records'));
  const { hookEnvelope } = require('../../lib/hooks/envelope');
  const ch = claudeHome(null, { root: cfg.project });
  const opts = { ...CALL, port: cfg.port };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  let clock = Date.now() - count * 60 * 1000;
  const fire = (event, sid, extra) => client.post('/api/hooks/event', hookEnvelope({
    hook_event_name: event, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: (clock += 1000) }), opts);
  for (let i = 0; i < count; i++) {
    const sid = sessionIdOf(i);
    const r = createRecords({ seed: 5000 + i, sessionId: sid, cwd: ch.cwd, start: clock, step: 50 });
    for (let k = 0; k < 3; k++) {
      r.prompt(`soak prompt ${i}.${k}`, { promptId: `soak-${i}-${k}` });
      r.assistant([`soak reply ${i}.${k}`]);
      r.turnDuration({ durationMs: 40 });
    }
    ch.writeTranscript(sid, r.records);
    await fire('SessionStart', sid, { source: 'startup', model: 'claude-soak' });
    await fire('SessionEnd', sid, { reason: 'other' });
  }
  const deadline = Date.now() + 20000;
  let listed = 0;
  for (;;) {
    try { listed = srv.mirror.stats().conversations.conversations; } catch { listed = 0; }
    if (listed >= count || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`soak fixture: ${listed} of ${count} conversations listed by the mirror's registry`);
  return listed;
}

// The U565 seam (see the head of this file). → the staged pack's name, or null.
async function stageStrokes(cfg, srv, { intDir, log = console.log } = {}) {
  const dir = path.join(intDir, 'test-support', 'element-packs', 'strokes-fixture');
  if (!fs.existsSync(dir)) return null;
  let helper = null;
  try { helper = require(path.join(intDir, 'test-support', 'element-packs')); } catch { helper = null; }
  if (!helper || typeof helper.stageStrokesFixture !== 'function') {
    log('soak fixture: strokes-fixture is present but test-support/element-packs exports no stageStrokesFixture(root) — running without it');
    return null;
  }
  const staged = await helper.stageStrokesFixture(cfg.project);
  const name = staged && staged.name;
  if (!name) return null;
  await srv.controlStarted;
  const a = await srv.control.invoke('pack-approve', { name, tier: 'local' }, { remote: false });
  log(`soak fixture: strokes pack ${name}: ${a && a.ok ? 'approved' : `not approved (${JSON.stringify(a)})`}`);
  return a && a.ok ? name : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  const intDir = path.resolve(String(args.int || path.join(__dirname, '..', '..')));
  const sha = headSha(intDir);
  if (!sha) throw new Error(`soak fixture: no HEAD sha could be read under ${intDir}`);
  const cache = path.resolve(String(args.cache || process.env.SOAK_CACHE || path.join(os.tmpdir(), 'web-chat-soak-cache')));
  const nodes = args.nodes !== undefined ? Number(args.nodes) : NODES;
  const count = args.conversations !== undefined ? Number(args.conversations) : CONVERSATIONS;
  const src = await cachedProject({ cache, sha, port: cfg.port, nodes });
  copyFixture(src, cfg.project);
  console.log(`soak fixture: ${nodes} nodes copied into ${cfg.project}`);
  let listed = 0;
  let pack = null;
  await withBoot(cfg.project, cfg.port, async (srv) => {
    listed = await seedConversations(cfg, srv, { count, intDir });
    pack = await stageStrokes(cfg, srv, { intDir });
  });
  // What the drive reads back (the conversations it walks).
  writeJsonAtomic(fixtureRecord(cfg), { v: 1, sha, nodes, conversations: count, listed, pack });
  return listed >= count ? 0 : 1;
}

if (require.main === module) {
  runMain(async () => {
    const code = await main();
    // The in-process boots leave pooled sockets and the claude-home module's
    // hooks behind; the fixture is a one-shot.
    process.exit(code);
  });
}

module.exports = {
  NODES, CONVERSATIONS, PANES, MD_ID, paneHtml, markdownText, commitTurn,
  headSha, isEmptyDir, copyFixture, fixtureRecord, readFixtureRecord, primeProject, cachedProject, seedConversations, stageStrokes, sessionIdOf,
};
