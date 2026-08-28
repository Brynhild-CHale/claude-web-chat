// `claude-web-chat ls` — every web-chat surface running on this machine.
//
// The daemon is one-per-project and its port is assigned by walking upward from
// 5173, so after a week of use there are several surfaces on several ports and
// nothing maps them back to projects. The registry the capture hub already keeps
// has exactly that — human title, port, url, pid, root — it was simply never
// shown to anyone. This prints it, and can reap the ones you are done with.
//
// The inventory itself is lib/util/registry.rows() (one honest classification,
// read raw so a ghost entry can be reported as one) and the reaping is
// lib/cli/reap.js (shared with init's remediation). This file is display.

const path = require('path');
const { rows: registryRows } = require('../../util/registry');
const { reap } = require('../reap');
const { findProjectRoot } = require('../../core/paths');

function ageOf(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// deps exists so the test suite can capture the output and point `here` at a
// temp project instead of the developer's cwd.
async function ls(args = [], deps = {}) {
  const doReap = args.includes('--reap');
  const log = deps.log || console.log;
  const here = deps.here !== undefined ? deps.here : findProjectRoot(process.cwd());

  const rows = await registryRows();
  if (!rows.length) {
    log('No web-chat surfaces are running.');
    log('Start one with `claude-web-chat open` in a project.');
    return;
  }

  const pad = Math.max(...rows.map((r) => String(r.title || path.basename(r.root || '')).length), 7);
  log('');
  for (const r of rows) {
    const name = String(r.title || path.basename(r.root || '?')).padEnd(pad);
    const mine = here && r.root === here ? ' ←' : '';
    const state = r.reachable ? '' : (r.pid_alive ? '  (not answering)' : '  (dead — registry entry is stale)');
    log(`  ${name}  ${r.url || 'http://127.0.0.1:' + r.port}${state}${mine}`);
    log(`  ${' '.repeat(pad)}  ${r.root || ''}${r.started_at ? `  ·  up ${ageOf(r.started_at)}` : ''}`);
  }
  log('');

  const stale = rows.filter((r) => !r.pid_alive);
  const idle = rows.filter((r) => r.reachable && here && r.root !== here);

  if (!doReap) {
    if (stale.length) log(`${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} — clear with \`claude-web-chat ls --reap\`.`);
    if (idle.length) log(`${idle.length} surface${idle.length === 1 ? '' : 's'} for other projects. \`--reap\` stops them too.`);
    if (here) log('← is this project.');
    return;
  }

  // One reaping rule, shared with init's remediation: a surface is stopped only
  // if it answers as the pid we listed, and it is stopped through the same
  // acknowledged-shutdown path `stop` uses so its draft is written. See lib/cli/reap.js.
  const { stopped, cleared } = await reap(rows, { here, log, ackWaitMs: deps.ackWaitMs, signalWaitMs: deps.signalWaitMs });
  const parts = [];
  if (stopped) parts.push(`stopped ${stopped} surface${stopped === 1 ? '' : 's'}`);
  if (cleared) parts.push(`cleared ${cleared} stale entr${cleared === 1 ? 'y' : 'ies'}`);
  log(parts.length
    ? `${parts.join(', ')}${here ? " (kept this project's)" : ''}.`
    : 'Nothing to reap.');
  if (stopped) log('Each restarts on the next `claude-web-chat open` in its project — graph state is on disk, not in the process.');
}

module.exports = ls;
