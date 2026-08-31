// Host-side service for the file-editor component. Reads/writes a file on the
// host, keeps a version history (one snapshot per save), and computes diffs
// (reusing the daemon's line-diff engine via ctx.diff). The pane drives it with
// a control key `editor_ctl { action, path, content, version, dir, seq }`, where
// `seq` is wall-clock ms (Date.now() at click time) and a write stamped at or
// before this service's own start is treated as PERSISTED, not clicked — it is
// never executed, and only a view action is replayed from one (see below). The
// service pushes state under the store key `editor`, echoing the seq it last
// applied as `ack` so the pane can tell a write that landed from one that did
// not. v1 contract: store writes only.
//
// Path fencing: by default paths resolve under `root` (params.root or the repo
// the daemon runs in) and anything escaping it is rejected — through ctx.fence,
// the daemon's containment engine (lib/core/paths), which refuses a lexical
// `../..` AND a symlink that resolves out of the tree. params.unfenced:true
// lifts the fence (for LLM-driven use) — a per-mount setting, off by default.
//
// Everything in `editor_ctl` is attacker-shaped input: it is a store key, so
// every script in the page and every local driver can write it. Paths go
// through the fence; a version id is checked against the index this service
// itself wrote; and a control write stamped at or before this service's own
// start is PERSISTED, not clicked, so it is never executed — only a view action
// (`open`/`browse`) is replayed from one, and only at startup (see below). The
// pane stamps `seq: Date.now()` at click time, which is what makes that test
// mean what it says.
//
// Version snapshots live under <webChatDir>/file-versions/<sha1(abspath)>/ :
// an index.json plus one raw-content file per version. Gitignored, project-local.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The id shape `snapshot` mints, and the only actions a respawn may replay.
const VERSION_RE = /^v\d+$/;
const VIEW_ACTIONS = new Set(['open', 'browse']);

let stream = null;
let pollTimer = null;
let stopped = false;

module.exports = {
  async start(ctx) {
    const startedAt = Date.now(); // the control-key cursor's floor — see below
    const cwd = process.cwd();
    const root = ctx.params && ctx.params.root ? path.resolve(cwd, ctx.params.root) : cwd;
    const unfenced = !!(ctx.params && ctx.params.unfenced);
    const versionsBase = path.join(ctx.webChatDir || path.join(cwd, '.web-chat'), 'file-versions');

    let seq = 0;
    let load = 0;          // bumped only when the pane should (re)load the buffer
    // The seq of the last control write this service actually EXECUTED, echoed
    // to the pane. A `save` is not guaranteed to run — the start-time floor
    // below refuses one stamped before we started, which is right for a
    // persisted write and also catches a real click made in the spawn window
    // (viewer arrives -> 200 ms debounce -> fork -> start()). Without this echo
    // the pane had no way to know, and cleared its dirty marker at click time.
    let ack = null;
    // The control-key cursor. It starts at THIS SERVICE'S START TIME, not at
    // zero: the pane stamps `seq: Date.now()` at click time (component.html), so
    // a write stamped at or before we started is by construction not a click
    // made during our life — it is a persisted one, and a persisted `save` or
    // `revert` must never execute (D8). Only a live write gets past this floor.
    let lastCtlSeq = startedAt;
    const st = {
      root: unfenced ? '(any host path)' : displayPath(root),
      unfenced, path: null, exists: false, content: '', versions: [],
      selected: null, diff: null, listing: null, error: null,
    };

    function displayPath(abs) {
      if (unfenced) return abs;
      const rel = path.relative(root, abs);
      return rel === '' ? '.' : rel;
    }
    // The fence lives in the daemon (ctx.fence → lib/core/paths). It resolves
    // the path AND refuses a symlink that points out of the root, which the
    // lexical path.relative check this used to do could not see — readFileSync
    // and writeFileSync follow links, so a link committed in the repo walked
    // straight out of the fence the pane's description promises.
    function resolveInput(p) {
      if (unfenced) return path.resolve(root, p || '.');
      const abs = ctx.fence(root, p || '.');
      if (!abs) throw new Error('path is outside the project root: ' + p);
      return abs;
    }
    function verDir(abs) {
      return path.join(versionsBase, crypto.createHash('sha1').update(abs).digest('hex'));
    }
    function loadIndex(abs) {
      try { return JSON.parse(fs.readFileSync(path.join(verDir(abs), 'index.json'), 'utf8')); }
      catch { return []; }
    }
    function snapshot(abs, content, label) {
      const dir = verDir(abs);
      fs.mkdirSync(dir, { recursive: true });
      const idx = loadIndex(abs);
      const id = 'v' + (idx.length + 1);
      fs.writeFileSync(path.join(dir, id), content);
      idx.push({ id, at: Date.now(), size: Buffer.byteLength(content), label: label || '', path: abs });
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2));
      return idx;
    }
    // A version id becomes a FILENAME inside the snapshot directory, and it
    // arrives from the store — so only an id this service minted may be read
    // back. Shape first (`v<N>` is all `snapshot` ever writes), then the index
    // itself, which is the unforgeable half: `../../../etc/passwd` is not a
    // version, and neither is a well-shaped `v99` nobody took.
    function readVersion(abs, id) {
      const key = String(id == null ? '' : id);
      if (!VERSION_RE.test(key) || !loadIndex(abs).some((v) => v && v.id === key)) {
        throw new Error('unknown version: ' + key);
      }
      return fs.readFileSync(path.join(verDir(abs), key), 'utf8');
    }

    const push = () => { if (!stopped) ctx.driver.setStore({ editor: { ...st, seq: ++seq, load, ack } }); };

    function doOpen(p) {
      const abs = resolveInput(p);
      let content = '', exists = false;
      try { content = fs.readFileSync(abs, 'utf8'); exists = true; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      st.path = displayPath(abs); st.exists = exists; st.content = content;
      st.versions = loadIndex(abs); st.selected = null; st.diff = null; st.error = null;
      load++; // tell the pane to load this content into the buffer
    }
    function doSave(p, content, label) {
      const abs = resolveInput(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content == null ? '' : content);
      st.path = displayPath(abs); st.exists = true; st.content = content || '';
      st.versions = snapshot(abs, content || '', label); st.diff = null; st.selected = null; st.error = null;
    }
    function doDiff(p, version, content) {
      const abs = resolveInput(p);
      const was = readVersion(abs, version);
      const d = ctx.diff(was, content == null ? '' : content, { context: 3, maxLines: 6000, maxHunkLines: 6000 });
      st.selected = version;
      st.diff = { version, against: 'buffer', result: d }; // result null ⇒ identical
      st.error = null;
    }
    function doRevert(p, version) {
      const abs = resolveInput(p);
      st.content = readVersion(abs, version); st.selected = version; st.diff = null; st.error = null;
      load++; // load the reverted content into the buffer (not written until Save)
    }
    function doBrowse(dirArg) {
      const abs = resolveInput(dirArg || '.');
      let dirents;
      try { dirents = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (e) { st.error = 'cannot list ' + displayPath(abs) + ': ' + e.message; return; }
      const entries = dirents
        .map((e) => ({ name: e.name, dir: e.isDirectory(), path: displayPath(path.join(abs, e.name)) }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
        .slice(0, 1000);
      const atRoot = !unfenced && path.relative(root, abs) === '';
      st.listing = { dir: displayPath(abs), parent: atRoot ? null : displayPath(path.dirname(abs)), entries };
      st.error = null;
    }

    function handle(c) {
      ack = c.seq == null ? ack : c.seq;   // executed — the pane's Save can settle
      try {
        switch (c.action) {
          case 'open': doOpen(c.path); break;
          case 'save': doSave(c.path, c.content, c.label); break;
          case 'diff': doDiff(c.path, c.version, c.content); break;
          case 'revert': doRevert(c.path, c.version); break;
          case 'browse': doBrowse(c.dir); break;
          default: return;
        }
      } catch (e) { st.error = String((e && e.message) || e); }
      push();
    }

    const applyCtl = (c) => {
      if (!c || !(c.seq > lastCtlSeq)) return false;
      lastCtlSeq = c.seq;
      handle(c);
      return true;
    };

    // Startup: adopt the pane's VIEW state, never re-run its mutations. Nothing
    // ever clears `editor_ctl`, and this service is respawned every time the
    // last viewer leaves, the pane returns to the active node, or the daemon
    // restarts — and a graph node restores the whole store, so navigating to an
    // older node hands us that node's control write. Replaying it re-executed
    // whatever it was: a stale `save` rewrote the file on disk with a buffer
    // from another session (edit the file in your IDE, reopen the tab, lose it),
    // a stale `revert` refilled the buffer from an old snapshot. So replay only
    // `open`/`browse`, and take the persisted seq into the cursor if it is
    // somehow ahead of our start.
    //
    // The startup read is not the only way a persisted write reaches us: the
    // supervisor keeps this child alive across graph nodes that carry the same
    // mount, and restoring a node swaps the WHOLE store — so a jump to a node
    // whose snapshot holds a `save` hands that save to the live SSE stream and
    // to the 4 s poll below, with no respawn involved. The `startedAt` floor is
    // what covers that leg: that save was stamped when it was clicked, which is
    // before we started, so it is refused there exactly as it is here.
    try {
      const ctl = (await ctx.driver.getStore(['editor_ctl'])).editor_ctl;
      if (ctl && ctl.seq > lastCtlSeq) lastCtlSeq = ctl.seq;
      if (ctl && VIEW_ACTIONS.has(ctl.action)) {
        handle(ctl); // pushes
      } else {
        if (ctx.params && ctx.params.path) doOpen(ctx.params.path); else doBrowse('.');
        push();
      }
    } catch (e) { st.error = String(e.message || e); push(); }

    // React to the pane's control writes live; poll as a startup/SSE-drop fallback.
    try {
      stream = ctx.driver.streamEvents({
        kinds: ['store'],
        onEvent: (e) => { if (e && e.patch) applyCtl(e.patch.editor_ctl); },
        onError: () => {}, onClose: () => {},
      });
    } catch {}
    pollTimer = setInterval(async () => {
      try { applyCtl((await ctx.driver.getStore(['editor_ctl'])).editor_ctl); } catch {}
    }, 4000);
    if (pollTimer.unref) pollTimer.unref();
  },

  async stop() {
    stopped = true;
    if (stream) { try { stream.close(); } catch {} stream = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  },
};
