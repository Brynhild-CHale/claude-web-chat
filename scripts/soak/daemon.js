'use strict';
// scripts/soak/daemon.js — the soak's daemon host (H.11, U579).
//
// The daemon the soak runs is the product's own: createServer({root, port})
// from lib/server/index.js at the band's port (never port 'auto', which walks
// upward from 5173), start() with its portfile and registry entry (so
// lib/util/registry daemonFor finds it and ensureHub brings up the soak's hub
// on WEB_CHAT_HUB_PORT, in the soak's HOME), and installSignalHandlers, so the
// SIGTERM stop.js sends takes the graceful path (draft.json kept).
//
// THE HOST'S OWN COUNTERS. Every PROC_EVERY_MS (and once at the listen) it
// writes <out>/proc.json through writeJsonAtomic: what only the daemon's own
// process can see, read here rather than added to /api/health or any route
// (remote-visible, and a product change):
//
//   heap_used_mb, rss_mb   process.memoryUsage()
//   handles                process.getActiveResourcesInfo().length
//   timers                 its 'Timeout' entries
//   mirror_timers, mirror_watchers, mirror_conversations
//                          the chat mirror's stats(): timers, watchers and the
//                          registry's conversations (stats().conversations.conversations)
//   mirror_parsed          the facade's parsed-conversation budget: the
//                          conversations holding turns, snapshot().diagnostics
//                          .parsed.held (lib/server/mirror/index.js diagnostics)
//   services               the service supervisor's children whose status is
//                          'running'
//
//   node scripts/soak/daemon.js --root R     (start.js spawns it detached)

const path = require('path');
const { enter, parseArgs, runMain } = require('./lib');
const { writeJsonAtomic } = require('../../lib/core/fsjson');

const PROC_EVERY_MS = 10 * 1000;
const MB = 1024 * 1024;

const round2 = (n) => Math.round(n * 100) / 100;

// The counters, from a server handle (createServer's return) and this process.
// Each read is guarded: a counter that cannot be read is left out, never 0.
function procSnapshot(srv, proc = process) {
  const out = { at: Date.now(), pid: proc.pid };
  const mem = proc.memoryUsage();
  out.heap_used_mb = round2(mem.heapUsed / MB);
  out.rss_mb = round2(mem.rss / MB);
  const res = typeof proc.getActiveResourcesInfo === 'function' ? proc.getActiveResourcesInfo() : null;
  if (Array.isArray(res)) {
    out.handles = res.length;
    out.timers = res.filter((r) => r === 'Timeout').length;
  }
  const mirror = srv && srv.mirror;
  if (mirror) {
    try {
      const s = mirror.stats();
      if (Number.isFinite(s.timers)) out.mirror_timers = s.timers;
      if (Number.isFinite(s.watchers)) out.mirror_watchers = s.watchers;
      if (s.conversations && Number.isFinite(s.conversations.conversations)) out.mirror_conversations = s.conversations.conversations;
    } catch {}
    try {
      const snap = mirror.snapshot({ level: 'local' });
      const held = snap && snap.diagnostics && snap.diagnostics.parsed && snap.diagnostics.parsed.held;
      if (Number.isFinite(held)) out.mirror_parsed = held;
    } catch {}
  }
  const sup = srv && srv.services;
  if (sup && sup._children instanceof Map) {
    out.services = [...sup._children.values()].filter((e) => e && e.status === 'running').length;
  } else if (srv) out.services = 0;
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  const { createServer } = require('../../lib/server');
  const srv = createServer({ root: cfg.project, port: cfg.port });
  srv.installSignalHandlers();
  await srv.start();
  const file = path.join(cfg.out, 'proc.json');
  const write = () => { try { writeJsonAtomic(file, procSnapshot(srv)); } catch (e) { console.error(`soak daemon: proc.json: ${e.message}`); } };
  write();
  setInterval(write, PROC_EVERY_MS).unref();
  return new Promise(() => {}); // the server's handles keep it alive; the signal handlers exit
}

if (require.main === module) runMain(main);

module.exports = { procSnapshot, PROC_EVERY_MS };
