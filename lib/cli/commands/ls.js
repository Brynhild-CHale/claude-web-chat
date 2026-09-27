// `claude-web-chat ls` — every web-chat surface running on this machine.
//
// The daemon is one-per-project and its port is assigned by walking upward from
// 5173, so after a week of use there are several surfaces on several ports and
// nothing maps them back to projects. The registry the capture hub already keeps
// has exactly that — human title, port, url, pid, root — it was simply never
// shown to anyone. This prints it, and can reap the ones you are done with.
//
// It also answers the question the port list could not: which of these has a
// Claude Code session attached? Every session's web-chat MCP server registers a
// presence row for as long as it lives (lib/mcp/presence.js), so a project shows
// here if it has a surface, a session, or both — CLAUDE counts the sessions,
// TURN says whether one is mid-turn (or a channel wake's turn), VIEWERS counts
// browsers. `--json` prints the whole classified row.
//
// The classification is lib/util/registry (sessions() + enrichSessions() for the
// live projects; rows() — read raw so a ghost entry can be reported as one — for
// reaping) and the reaping is lib/cli/reap.js (shared with init's remediation).
// This file is display.
//
// `--all` adds the INACTIVE projects: known on this machine (their daemon has
// booted here before — ~/.web-chat/projects.json) with no surface and no Claude
// session now. Without it they are left out, so the default listing stays
// "what is running".

const path = require('path');
const registry = require('../../util/registry');
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

// The CLAUDE column: how many Claude Code sessions have this project's web-chat
// MCP server running, and whether any of them has a live channel (Push wakes it
// mid-session rather than parking for the next prompt).
function claudeCell(c) {
  if (!c || !c.sessions) return '—';
  return `● ${c.sessions}${c.channel ? ' · channel' : ''}`;
}

// The same fact as one sentence, for `status`.
function claudeLine(c) {
  if (!c || !c.sessions) return 'no Claude Code session attached';
  const n = c.sessions === 1 ? '1 session' : `${c.sessions} sessions`;
  const parts = [`● ${n} attached`, c.channel ? 'channel on' : 'channel off'];
  if (c.started_at) parts.push(`since ${ageOf(c.started_at)} ago`);
  parts.push(c.last_tool_at ? `last tool ${ageOf(c.last_tool_at)} ago` : 'no tool call yet');
  return parts.join(' · ');
}

function turnCell(surface) {
  return (surface && surface.turn) || '';
}

function viewersCell(surface) {
  return surface && surface.reachable && Number.isFinite(surface.viewers) ? String(surface.viewers) : '';
}

// What `ls` knows, gathered once: every live project (a daemon, a Claude Code
// session, or both — lib/util/registry.sessions, enriched from each daemon's
// /api/health) plus the dead daemon records the registry still holds. The file
// is read RAW, once, and classified here, because the pruning reader would
// delete the very records `ls` exists to report as stale.
async function inventory({ timeoutMs, all = false } = {}) {
  let raw = [];
  try { raw = registry.readAllEntries(); } catch {}
  const live = raw.filter(registry.isLive);
  const sessions = await registry.enrichSessions(registry.sessions({ entries: live, inactive: all }), { timeoutMs });
  const stale = raw.filter((e) => (e.role || 'instance') === 'instance' && !registry.isLive(e));
  return { sessions, stale };
}

function pad(s, n) { return String(s).padEnd(n); }

// deps exists so the test suite can capture the output and point `here` at a
// temp project instead of the developer's cwd.
async function ls(args = [], deps = {}) {
  const doReap = args.includes('--reap');
  const asJson = args.includes('--json');
  const all = args.includes('--all');
  const log = deps.log || console.log;
  const here = deps.here !== undefined ? deps.here : findProjectRoot(process.cwd());

  if (asJson && doReap) throw new Error('`ls --json` lists; it does not combine with --reap.');

  const { sessions, stale } = await inventory({ timeoutMs: deps.timeoutMs, all });

  if (asJson) {
    log(JSON.stringify({ sessions, stale }, null, 2));
    return;
  }

  if (!sessions.length && !stale.length) {
    log('No web-chat surfaces are running, and no Claude Code session has web-chat loaded.');
    log(all ? 'Start one with `claude-web-chat open` in a project.'
      : 'Start one with `claude-web-chat open` in a project; `ls --all` also lists the projects known here.');
    return;
  }

  // One table: a row per project, a second line for where it lives and what
  // state it is in. Stale records go last — they are history, not projects.
  const table = [
    ...sessions.map((r) => ({
      name: r.title || path.basename(r.root || '?'),
      surface: r.surface ? r.surface.url : '—',
      claude: claudeCell(r.claude),
      turn: turnCell(r.surface),
      viewers: viewersCell(r.surface),
      root: r.root,
      notes: registry.isInactive(r) ? [
        `inactive${r.last_seen_at ? ` · last up ${ageOf(r.last_seen_at)} ago` : ''} — \`claude-web-chat open\` there starts it`,
      ] : [
        r.surface && r.surface.started_at ? `up ${ageOf(r.surface.started_at)}` : '',
        r.surface && !r.surface.reachable ? '(not answering)' : '',
        !r.surface ? 'no surface — `claude-web-chat open` there starts one' : '',
        r.claude && r.claude.last_tool_at ? `last tool ${ageOf(r.claude.last_tool_at)} ago` : '',
      ].filter(Boolean),
      mine: here && r.root === here,
    })),
    ...stale.map((e) => ({
      name: e.title || path.basename(e.root || '?'),
      surface: e.url || `http://127.0.0.1:${e.port}`,
      claude: '', turn: '', viewers: '',
      root: e.root || '',
      notes: ['(dead — registry entry is stale)'],
      mine: false,
    })),
  ];
  const w = {
    name: Math.max(7, ...table.map((r) => r.name.length)),
    surface: Math.max(7, ...table.map((r) => r.surface.length)),
    claude: Math.max(6, ...table.map((r) => r.claude.length)),
    turn: Math.max(4, ...table.map((r) => r.turn.length)),
  };
  log('');
  log(`  ${pad('PROJECT', w.name)}  ${pad('SURFACE', w.surface)}  ${pad('CLAUDE', w.claude)}  ${pad('TURN', w.turn)}  VIEWERS`);
  for (const r of table) {
    log(`  ${pad(r.name, w.name)}  ${pad(r.surface, w.surface)}  ${pad(r.claude, w.claude)}  ${pad(r.turn, w.turn)}  ${pad(r.viewers, 7)}${r.mine ? ' ←' : ''}`.replace(/\s+$/, ''));
    log(`  ${' '.repeat(w.name)}  ${[r.root, ...r.notes].filter(Boolean).join('  ·  ')}`);
  }
  log('');

  const idle = sessions.filter((r) => r.surface && r.surface.reachable && here && r.root !== here);

  if (!doReap) {
    if (stale.length) log(`${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} — clear with \`claude-web-chat ls --reap\`.`);
    if (idle.length) log(`${idle.length} surface${idle.length === 1 ? '' : 's'} for other projects. \`--reap\` stops them too.`);
    if (!all) log('`--all` also lists the inactive projects known on this machine.');
    if (sessions.some((r) => r.claude)) log('CLAUDE counts the Claude Code sessions with web-chat loaded; · channel means a Push wakes one mid-session.');
    if (here) log('← is this project.');
    return;
  }

  // Reaping acts on daemon records only, classified (and probed) by the one
  // rule lib/util/registry.rows() owns — a Claude Code session is never reaped.
  const rows = await registry.rows();
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
module.exports.claudeLine = claudeLine;
module.exports.claudeCell = claudeCell;
module.exports.inventory = inventory;
