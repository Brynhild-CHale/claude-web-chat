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
// `../..` AND a symlink that resolves out of the tree. While the approval
// covers `root` (it was proven inside the project, so the user never saw its
// value), every path is held inside the project root too, whatever `root`
// turns into later. params.unfenced:true lifts the fence (for LLM-driven use) —
// a per-mount setting, off by default.
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
//
// PUBLISH ON CHANGE. Every push follows an action, except the one at startup —
// and a start is not an event: the service is respawned on a socket flap, when
// the pane returns to the active node and when the daemon restarts. So startup
// rebuilds the view, compares it with the `editor` the store already holds (what
// the last run published), and writes nothing when they match. `load` and `seq`
// carry on from the stored values, never restart at 0: a fresh `load` the pane
// has not seen makes it reload the buffer, which drops typing not yet saved.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The id shape `snapshot` mints, and the only actions a respawn may replay.
const VERSION_RE = /^v\d+$/;
const VIEW_ACTIONS = new Set(['open', 'browse']);
// The view fields a quiet respawn must find unchanged in the stored `editor`.
const VIEW_FIELDS = ['root', 'unfenced', 'start_path', 'path', 'exists', 'content', 'versions', 'listing'];

// Order-free JSON, so a view read back from the store compares equal to the one
// built here. Written out here, not required from lib/: a service.js stands alone.
function stableJson(v) {
  const sorted = (x) => {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = sorted(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(sorted(v === undefined ? null : JSON.parse(JSON.stringify(v))));
}

let stream = null;
let pollTimer = null;
let stopped = false;

module.exports = {
  async start(ctx) {
    const startedAt = Date.now(); // the control-key cursor's floor — see below
    // The project root as the daemon spells it (ctx.root): the frame the
    // supervisor proved a covered `root`/`path` inside, comparing an absolute
    // value to it as text. This process runs in that directory, but
    // process.cwd() returns its real path, which is spelled differently when
    // the project is reached through a symlink — and then every path under an
    // absolute covered root read as outside the project. process.cwd() only
    // when no ctx.root is handed in.
    const cwd = ctx.root || process.cwd();
    const root = ctx.params && ctx.params.root ? path.resolve(cwd, ctx.params.root) : cwd;
    const unfenced = !!(ctx.params && ctx.params.unfenced);
    const versionsBase = path.join(ctx.webChatDir || path.join(cwd, '.web-chat'), 'file-versions');
    const startPath = ctx.params && ctx.params.path ? ctx.params.path : null;

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
      // `start_path`: the params.path this view was started on, so a respawn
      // can tell a file the USER opened from a pane re-mounted on a new path.
      unfenced, start_path: startPath, path: null, exists: false, content: '', versions: [],
      selected: null, diff: null, listing: null, error: null,
    };

    function displayPath(abs) {
      if (unfenced) return abs;
      const rel = path.relative(root, abs);
      return rel === '' ? '.' : rel;
    }
    // A `root` this run's approval COVERS (x-trust project-path, ctx.covers)
    // was proven inside the project when the approval was keyed — not for the
    // life of this process. The fence below is anchored on root and realpaths
    // it on every call, so a root that later becomes a link out of the project
    // (a checkout, a pull, a build tool's output link) would carry the fence
    // out with it, under an approval that never named root at all. While root
    // is covered, every path is ALSO held inside the project root (`cwd`
    // above: this process's working directory, as the daemon spells it). A root
    // the approval names by its exact value — one the user saw and approved —
    // keeps its own fence only.
    const covers = ctx.covers && typeof ctx.covers === 'object' ? ctx.covers : {};
    const projectRoot = !unfenced && covers.root === 'project-path' ? cwd : null;
    // The fence lives in the daemon (ctx.fence → lib/core/paths). It resolves
    // the path AND refuses a symlink that points out of the root, which the
    // lexical path.relative check this used to do could not see — readFileSync
    // and writeFileSync follow links, so a link committed in the repo walked
    // straight out of the fence the pane's description promises.
    function resolveInput(p) {
      if (unfenced) return path.resolve(root, p || '.');
      const abs = ctx.fence(root, p || '.');
      if (!abs || (projectRoot && !ctx.fence(projectRoot, abs))) throw new Error('path is outside the project root: ' + p);
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

    function run(c) {
      ack = c.seq == null ? ack : c.seq;   // executed — the pane's Save can settle
      try {
        switch (c.action) {
          case 'open': doOpen(c.path); break;
          case 'save': doSave(c.path, c.content, c.label); break;
          case 'diff': doDiff(c.path, c.version, c.content); break;
          case 'revert': doRevert(c.path, c.version); break;
          case 'browse': doBrowse(c.dir); break;
          default: return false;
        }
      } catch (e) { st.error = String((e && e.message) || e); }
      return true;
    }
    function handle(c) { if (run(c)) push(); }

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
    //
    // Then publish only if the view differs from the `editor` already in the
    // store (PUBLISH ON CHANGE, above).
    let prev = null;
    try {
      const got = (await ctx.driver.getStore(['editor'])).editor;
      if (got && typeof got === 'object' && !Array.isArray(got)) prev = got;
    } catch {}
    if (prev && Number.isFinite(prev.seq) && prev.seq > seq) seq = prev.seq;
    if (prev && Number.isFinite(prev.load) && prev.load > load) load = prev.load;
    const storedLoad = load;
    // params.path is the file the pane was FIRST opened on, not the one it
    // shows: the user may have opened another since, and the control write that
    // did it is long gone when that file was then saved (`editor_ctl` holds the
    // save, which a respawn never replays). Opening params.path again would
    // publish that file with a `load` past the stored one, and the pane would
    // reload its buffer over the typing in the other file. So a respawn of the
    // SAME pane (the stored view was started on this params.path) reopens the
    // file the stored view names — read through the same fence as every open,
    // since it is store input. params.path opens on a first start (no stored
    // view), on a pane re-mounted on another path (the stored `start_path`
    // differs, or a view stored before it was recorded), and when the stored
    // path is refused (outside the project) or cannot be read.
    function openStartFile(first) {
      const stored = prev && prev.start_path === first &&
        typeof prev.path === 'string' && prev.path ? prev.path : null;
      if (stored) {
        try { doOpen(stored); return; } catch {}
      }
      doOpen(first);
    }
    try {
      const ctl = (await ctx.driver.getStore(['editor_ctl'])).editor_ctl;
      if (ctl && ctl.seq > lastCtlSeq) lastCtlSeq = ctl.seq;
      if (ctl && VIEW_ACTIONS.has(ctl.action)) {
        run(ctl);
      } else {
        if (startPath) openStartFile(startPath); else doBrowse('.');
      }
    } catch (e) { st.error = String(e.message || e); }

    // The start path builds one half of the view — the file (an `open`, or
    // params.path) or the listing (a `browse`) — and every later push spreads
    // `st`. The pane shows both halves the last run had, so rebuild the half the
    // start path left empty from the stored view, re-read from disk through the
    // same fence a control write's path goes through (it is store input, exactly
    // like an `open` replayed from editor_ctl). Then the compare sees the whole
    // view, and a later push never blanks the half the start path did not build.
    if (prev && !st.error) {
      try {
        if (st.path == null && typeof prev.path === 'string' && prev.path) doOpen(prev.path);
        if (st.listing == null && prev.listing && typeof prev.listing.dir === 'string') doBrowse(prev.listing.dir);
      } catch {}
      st.error = null; // a half that could not be rebuilt stays empty, and the compare publishes
    }

    const same = (k) => stableJson(st[k]) === stableJson(prev[k]);
    if (prev && !st.error && VIEW_FIELDS.every(same)) {
      // Nothing changed: the pane already shows this view. Adopt the stored
      // stamps (doOpen's own load++ does not count) and write nothing.
      load = storedLoad;
      if ('ack' in prev) ack = prev.ack;
      if ('selected' in prev) st.selected = prev.selected;
      if ('diff' in prev) st.diff = prev.diff;
    } else {
      // Changed: publish. `load` moves past the stored one only when the FILE
      // changed (a doOpen ran and read something else), so a new directory
      // entry, or a half that could not be rebuilt, never reloads the buffer.
      if (prev && st.path === prev.path && st.content === prev.content) load = storedLoad;
      push();
    }

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
