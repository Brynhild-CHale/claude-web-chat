// Host-side service for the file-editor component. Reads/writes a file on the
// host, keeps a version history (one snapshot per save), and computes diffs
// (reusing the daemon's line-diff engine via ctx.diff). The pane drives it with
// a control key `editor_ctl { action, path, content, version, dir }`; the service
// pushes state under the store key `editor`. v1 contract: store writes only.
//
// Path fencing: by default paths resolve under `root` (params.root or the repo
// the daemon runs in) and anything escaping it is rejected. params.unfenced:true
// lifts the fence (for LLM-driven use) — a per-mount setting, off by default.
//
// Version snapshots live under <webChatDir>/file-versions/<sha1(abspath)>/ :
// an index.json plus one raw-content file per version. Gitignored, project-local.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let stream = null;
let pollTimer = null;
let stopped = false;

module.exports = {
  async start(ctx) {
    const cwd = process.cwd();
    const root = ctx.params && ctx.params.root ? path.resolve(cwd, ctx.params.root) : cwd;
    const unfenced = !!(ctx.params && ctx.params.unfenced);
    const versionsBase = path.join(ctx.webChatDir || path.join(cwd, '.web-chat'), 'file-versions');

    let seq = 0;
    let load = 0;          // bumped only when the pane should (re)load the buffer
    let lastCtlSeq = 0;
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
    function resolveInput(p) {
      const abs = path.resolve(root, p || '.');
      if (!unfenced) {
        const rel = path.relative(root, abs);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          throw new Error('path is outside the project root: ' + p);
        }
      }
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
    function readVersion(abs, id) {
      return fs.readFileSync(path.join(verDir(abs), id), 'utf8');
    }

    const push = () => { if (!stopped) ctx.driver.setStore({ editor: { ...st, seq: ++seq, load } }); };

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

    // Honor a pre-existing control write, then an initial view.
    try { if (!applyCtl((await ctx.driver.getStore(['editor_ctl'])).editor_ctl)) {
      if (ctx.params && ctx.params.path) doOpen(ctx.params.path); else doBrowse('.');
      push();
    } } catch (e) { st.error = String(e.message || e); push(); }

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
