// Notice when tunnel.json changes, for the running portal (lib/portal/index.js
// reloads it).
//
// Two sources, one check:
//   * fs.watch on the file's DIRECTORY, not the file — `tunnel setup` writes
//     through writeJsonAtomic (a tmp file renamed over), which replaces the
//     inode a file watch would be holding, and an editor's save-as-rename does
//     the same. Events are debounced (DEBOUNCE_MS): one save is several.
//   * a poll every POLL_MS, because fs.watch is best-effort — a network or
//     container filesystem may never fire it, and a directory that does not
//     exist yet cannot be watched at all.
// Both land in check(), which reads the file's bytes and calls onChange only
// when they differ from the last read (absent and unreadable are states too),
// so a touch with no edit, or a watch event and a poll for the same save, is
// one reload at most. The first check (at start) always calls onChange: the
// file may have changed between the portal's load and its listen, and the
// callback treats "the same config" as nothing to do.

const fs = require('fs');
const path = require('path');

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

function watchConfigFile(file, onChange, { pollMs = POLL_MS, debounceMs = DEBOUNCE_MS, log = () => {} } = {}) {
  let last;
  let watcher = null;
  let poller = null;
  let pending = null;
  let stopped = false;

  function check() {
    pending = null;
    if (stopped) return;
    const now = snapshot(file);
    if (now === last) return;
    last = now;
    try { onChange(); } catch (e) { log(`tunnel.json reload failed: ${e && e.message}`); }
  }
  function schedule() {
    if (stopped) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(check, debounceMs);
    pending.unref();
  }

  const base = path.basename(file);
  try {
    watcher = fs.watch(path.dirname(file), { persistent: false }, (_ev, name) => {
      // Some platforms do not say which file; re-check rather than miss one.
      if (!name || String(name) === base) schedule();
    });
    watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
  } catch {
    watcher = null; // the poll alone
  }
  poller = setInterval(check, pollMs);
  poller.unref();
  check();

  return {
    check,
    stop() {
      stopped = true;
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      if (poller) { clearInterval(poller); poller = null; }
      if (pending) { clearTimeout(pending); pending = null; }
    },
  };
}

module.exports = { watchConfigFile, POLL_MS, DEBOUNCE_MS };
