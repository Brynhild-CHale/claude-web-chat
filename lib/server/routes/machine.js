// The machine-wide sessions view: every web-chat surface on this computer and
// which of them have a Claude Code session attached. GET /api/machine/sessions
// feeds the chrome's Sessions panel (public/app/sessions.js); `claude-web-chat ls`
// prints the same rows. Both read ONE classifier — lib/util/registry sessions()
// (registry only: daemons + MCP presence rows) then enrichSessions() (each
// running daemon's /api/health: viewers, the turn lock, the active label) — so
// the panel and the terminal can never disagree about who is here.
//
// LOCAL-ONLY. This route answers about OTHER projects: their absolute roots,
// their ports, whether Claude is mid-turn in them. On loopback that is the user
// looking at their own machine; through a tunnel it is a leak of every project
// on the box to whoever holds the link. The P6 remote policy must REFUSE
// /api/machine/* outright — not filter it, not scope it to this project.
//
// Read-only, and deliberately so: it never starts a daemon. A project with a
// Claude session but no surface is listed with `surface: null` and the command
// that would start it (`open_cmd`) — the user runs that, the page cannot.

const path = require('path');
const { sessions, enrichSessions, versionNote } = require('../../util/registry');
const { homeDir, isInside, realpath } = require('../../core/paths');

// POSIX single-quote a path for a copy-pasteable command. A root is any
// directory name the user chose, so spaces, `$` and quotes all happen.
function shellQuote(s) {
  const str = String(s);
  return /^[A-Za-z0-9_./~-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

function openCommand(root) {
  return `cd ${shellQuote(root)} && claude-web-chat open`;
}

// The root as the user would type it: $HOME collapsed to `~`. Display only —
// open_cmd keeps the absolute path, because a quoted `~` does not expand.
function displayRoot(root, home) {
  if (!home || !isInside(home, root)) return root;
  // isInside compares realpaths; the display wants the spelling `root` already
  // has, so try $HOME as written and as resolved (macOS: /var → /private/var).
  for (const base of new Set([path.resolve(home), realpath(home)].filter(Boolean))) {
    const rel = path.relative(base, root);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return rel ? `~${path.sep}${rel}` : '~';
  }
  return root; // inside only through a symlink the root itself does not spell
}

function mountMachineRoutes(app, { root }) {
  const here = path.resolve(root);

  app.get('/api/machine/sessions', async (req, res) => {
    let list = [];
    try { list = sessions(); } catch {}
    // This daemon is answering, so its own project is running whatever the
    // registry says: a registry write it lost (unwritable ~/.web-chat, a racing
    // writer) must not make the page the user is looking at list itself as
    // stopped. Supplied from the socket, then enriched like any other row.
    const port = req.socket && req.socket.localPort;
    const own = list.find((r) => r.root === here);
    const self = { running: true, port, url: `http://localhost:${port}`, pid: process.pid, started_at: null };
    if (!own) {
      list.push({ root: here, title: path.basename(here), surface: self, claude: null });
      list.sort((a, b) => String(a.title).localeCompare(String(b.title)) || a.root.localeCompare(b.root));
    } else if (!own.surface) own.surface = self;

    let home = null;
    try { home = homeDir(); } catch {}
    let rows = list;
    try { rows = await enrichSessions(list); } catch {}
    res.json({
      ok: true,
      // The server's clock, so the panel's "3m ago" is measured against the
      // same clock that stamped started_at / last_tool_at.
      now: Date.now(),
      current: here,
      sessions: rows.map((r) => ({
        ...r,
        current: r.root === here,
        display_root: displayRoot(r.root, home),
        open_cmd: r.surface ? null : openCommand(r.root),
        // A Claude session on a different release than its surface, as one
        // sentence (registry versionNote — the wording `ls` prints too).
        version_note: versionNote(r.version_skew),
      })),
    });
  });
}

module.exports = { mountMachineRoutes, openCommand, shellQuote, displayRoot };
