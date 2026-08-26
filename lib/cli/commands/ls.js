// `claude-web-chat ls` — every web-chat surface running on this machine.
//
// The daemon is one-per-project and its port is assigned by walking upward from
// 5173, so after a week of use there are several surfaces on several ports and
// nothing maps them back to projects. The registry the capture hub already keeps
// has exactly that — human title, port, url, pid, root — it was simply never
// shown to anyone. This prints it, and can reap the ones you are done with.

const path = require('path');
const { readInstances } = require('../../util/registry');
const portfiles = require('../../core/portfiles');
const { findProjectRoot } = require('../../core/paths');

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

// The registry read plus a liveness probe per entry — the machine inventory,
// with no printing. `init` renders the same rows inside its orientation report,
// so "which surfaces exist on this machine" is answered in exactly one place.
// The registry can outlive the process it describes (a SIGKILL, a reboot), so
// each entry is confirmed rather than reported as a ghost.
async function collectRows() {
  let entries = [];
  try { entries = readInstances().filter((e) => e.role !== 'hub'); } catch {}
  const rows = [];
  for (const e of entries) {
    const live = e.pid ? isAlive(e.pid) : false;
    const reachable = live ? await portfiles.probeReachable(e.port, 400) : false;
    rows.push({ ...e, live, reachable });
  }
  return rows;
}

async function ls(args = []) {
  const reap = args.includes('--reap');
  const here = findProjectRoot(process.cwd());

  const rows = await collectRows();
  if (!rows.length) {
    console.log('No web-chat surfaces are running.');
    console.log('Start one with `claude-web-chat open` in a project.');
    return;
  }

  const pad = Math.max(...rows.map((r) => String(r.title || path.basename(r.root || '')).length), 7);
  console.log('');
  for (const r of rows) {
    const name = String(r.title || path.basename(r.root || '?')).padEnd(pad);
    const mine = here && r.root === here ? ' ←' : '';
    const state = r.reachable ? '' : (r.live ? '  (not answering)' : '  (dead — registry entry is stale)');
    console.log(`  ${name}  ${r.url || 'http://127.0.0.1:' + r.port}${state}${mine}`);
    console.log(`  ${' '.repeat(pad)}  ${r.root || ''}${r.started_at ? `  ·  up ${ageOf(r.started_at)}` : ''}`);
  }
  console.log('');

  const stale = rows.filter((r) => !r.live);
  const idle = rows.filter((r) => r.reachable && here && r.root !== here);

  if (!reap) {
    if (stale.length) console.log(`${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} — clear with \`claude-web-chat ls --reap\`.`);
    if (idle.length) console.log(`${idle.length} surface${idle.length === 1 ? '' : 's'} for other projects. \`--reap\` stops them too.`);
    if (here) console.log('← is this project.');
    return;
  }

  let stopped = 0;
  for (const r of rows) {
    if (here && r.root === here) continue; // never reap the project you are standing in
    if (r.live && r.pid) { try { process.kill(r.pid, 'SIGTERM'); stopped++; } catch {} }
    // Guarded on the pid we listed (and just signalled): between collectRows
    // and here the project's daemon may have been restarted by someone else.
    try { portfiles.deletePortfile('server', { root: r.root, pid: r.pid }); } catch {}
  }
  console.log(stopped
    ? `Stopped ${stopped} surface${stopped === 1 ? '' : 's'}${here ? ' (kept this project\'s)' : ''}.`
    : 'Nothing to stop; cleared any stale registry entries.');
  console.log('Each restarts on the next `claude-web-chat open` in its project — graph state is on disk, not in the process.');
}

module.exports = ls;
module.exports.collectRows = collectRows;
