// Notice when tunnel.json changes, for the running portal (lib/portal/index.js
// reloads it) — and when the connector token file does (the portal reports
// "restart needed": the token is cloudflared's, fixed at its launch).
//
// The watching is lib/core/watch's (watchFile), the one file-watch engine:
//   * a watch on the file that follows it to each new inode — `tunnel setup`
//     writes through writeJsonAtomic (a tmp file renamed over), which replaces
//     the inode a plain file watch would be holding, and an editor's
//     save-as-rename does the same;
//   * unless `dirWatch: false`, one watch on the file's DIRECTORY, filtered to
//     its name, opened once at the start;
//   * a poll every POLL_MS, because fs.watch is best-effort — a network or
//     container filesystem may never fire it, and a file (or directory) that
//     does not exist yet cannot be watched at all.
// Every source lands in one debounced call of check() (DEBOUNCE_MS: one save is
// several events), and none of them holds the process open (persistent: false;
// the portal's server does that).
//
// check() reads the file's bytes and calls onChange only when they differ from
// the last read (absent and unreadable are states too), so a touch with no
// edit, or a watch event and a poll for the same save, is one reload at most.
// The first check (at start) runs at once and always calls onChange: the file
// may have changed between the portal's load and its listen, and the callback
// treats "the same config" as nothing to do.
//
// `dirWatch: false` leaves the directory alone, for a caller that starts and
// stops watchers often: closing a directory watcher can block the event loop
// for seconds on macOS (see lib/core/watch.js). The file watch and the poll
// still see every edit.

const fs = require('fs');
const { watchFile } = require('../core/watch');

const POLL_MS = 2000;
const DEBOUNCE_MS = 150;

// The file's current bytes as a comparable string: its content, 'absent', or
// 'unreadable:<code>'.
function snapshot(file) {
  try {
    return `ok:${fs.readFileSync(file, 'utf8')}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : `unreadable:${(e && e.code) || 'error'}`;
  }
}

function watchConfigFile(file, onChange, {
  pollMs = POLL_MS, debounceMs = DEBOUNCE_MS, dirWatch = true, log = () => {}, label = 'tunnel.json reload',
} = {}) {
  let last;
  let stopped = false;

  function check() {
    if (stopped) return;
    const now = snapshot(file);
    if (now === last) return;
    last = now;
    try { onChange(); } catch (e) { log(`${label} failed: ${e && e.message}`); }
  }

  const watch = watchFile(file, check, { pollMs, debounceMs, dirWatch, persistent: false, log });
  check();

  return {
    check,
    stop() {
      stopped = true;
      watch.stop();
    },
  };
}

module.exports = { watchConfigFile, POLL_MS, DEBOUNCE_MS };
