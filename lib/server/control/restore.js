// lib/server/control/restore.js — the restore engine code revert stands on
// (spec §15.3, C44, Q-D; design/chat-mirror-control.md C-REV-1).
//
// It puts the project's working tree back to a tree the per-turn diff engine
// snapshot earlier, over that engine's shadow store (lib/server/mirror/
// codediff.js createShadowStore): its snapshot, env, gitArgs, pathspec and
// emptyTree — never a second snapshot engine — and every git call goes
// through lib/server/git-run.js. The mirror engine never writes the working
// tree; this module is the one thing that does. Nothing here gates (the graph
// lock, a busy conversation, `claude agents --json`), keeps a preview_id, a
// restores record, an audit line or a notice to Claude: those are the control
// domain's (U81/U83, lib/server/control/revert.js and lib/server/routes/
// code.js, tranche 4). No ctx key reaches it yet.
//
//   createRestore({root, paths, shadow, runGit, now, log}) →
//     {features, preview, apply, undo, safetyRefs}
//   `shadow` is the codediff store for this root, and `runGit` MUST be the
//   runner that store was built over (the daemon's one runGit): apply holds
//   runGit.exclusive for its whole sequence, so no turn's snapshot interleaves.
//
//   features() → {ok: true} | {ok: false, reason: 'git-missing' |
//       'not-a-git-repo' | 'init-failed' | 'git-too-old' | 'shadow-store-full'}
//     revert needs --attr-source (git 2.40 or newer, runGit.features()); a
//     store over its size cap is full. Never call it inside a held slot.
//
//   preview(targetTree, {targetHead}) → {ok: true, current_tree,
//       written: [{path, status: 'A'|'M'|'T'}], deleted: [path],
//       notCovered: [{path, reason}], headMoved}
//     | {ok: false, refused}
//     `current_tree` is a fresh snapshot of the working tree: hand it back to
//     apply as `expect` to refuse a working tree that changed since.
//
//   apply(targetTree, {expect, targetHead}) → {ok, restore_id, safety_tree,
//       after_tree, written, deleted, notCovered, headMoved,
//       residual: [{path, reason: 'mismatch'|'still-present'|'missing'|'error',
//                   code?}], duration_ms}
//     | {ok: false, refused}
//     ok is false whenever a residual is listed.
//
//   undo(restoreId, {expect}) → apply's answer plus `undo_of`, applying the
//     safety tree that restore kept, with a safety ref of its own (an undo is
//     itself undoable) | {ok: false, refused: 'unknown'}.
//
//   safetyRefs() → Promise<[{restore_id, tree}]>, newest first.
//
//   REFUSALS ({ok: false, refused}): a features() reason; 'bad-tree' (not a
//   tree id); 'tree-missing' (not in the shadow: trees are pruned after 7
//   days); 'stale' (`expect` given and the working tree's snapshot differs —
//   nothing is written); 'unknown' (undo of an id with no safety ref);
//   'snapshot-failed' (with `reason`, the store's); 'safety-failed' (the
//   safety ref could not be written — nothing is written); 'failed' (a git
//   failure before any write, with `code`).
//
//   NOT COVERED — each path left alone, and listed with its reason:
//     'ignored'      a path to write that the project's rules ignore now
//                    (`check-ignore --no-index`, against the project's own
//                    repository), or an untracked file standing where the
//                    target needs a directory
//     'over-cap'     a path to write or delete that is an untracked file over
//                    the size cap now (the snapshot's excluded.large)
//     'sensitive'    the same for an untracked file sensitivePath() withholds
//                    (the snapshot's excluded.sensitive): its bytes were never
//                    snapshot, so nothing could put them back
//     'outside'      a path whose real parent is not inside the root (a
//                    symlinked directory leading out, lib/core/paths fence),
//                    one reached through a symlink apply would replace, and
//                    anything under the root's .web-chat/
//     'nested-repo'  a path at or under a nested repository or git worktree
//                    (the snapshot's `nested`), or a gitlink: listed, never
//                    written part way
//
//   NEVER TOUCHED: HEAD, branches, the project's index, refs, objects and
//   config (the project's repository is only read: `rev-parse` in the
//   snapshot, `check-ignore` here); everything under NOT COVERED; the
//   shadow's own directory and .web-chat/. Nothing runs checkout, reset,
//   stash, commit or gc in the project.
//
//   AN APPLY, inside ONE runGit.exclusive slot: (1) a fresh snapshot is the
//   safety tree; `expect` given and different → 'stale'; (2) `update-ref
//   refs/wc/safety/<restore_id> <safety tree>` in the shadow, and every
//   safety ref but the newest SAFETY_KEEP deleted (gc keeps what a ref
//   names); (3) the plan, preview's lists from that same snapshot; (4) each
//   path to delete is unlinked — its real parent fenced inside the root, a
//   file or a symlink only, never a directory — and the directories that
//   left empty are removed, deepest first, never the root, never outside it;
//   (5) `read-tree <target>` into a fresh index under paths.mirrorTmp, then
//   `checkout-index -f -z --stdin` for the paths to write (a path where a
//   directory stands, or below a leading entry that is not a directory, is
//   skipped as an error: checkout-index -f would delete that directory or
//   entry whole), with GIT_DIR = the shadow, GIT_WORK_TREE = the toplevel,
//   --attr-source = the empty tree, core.autocrlf=false, core.symlinks=true,
//   cwd = the toplevel; the index goes; (6) VERIFY: a fresh snapshot, and for
//   every planned path its mode and blob id against the target's (`ls-tree
//   -r -z`): written equal, deleted absent. The snapshot stores the bytes on
//   disk (Q-D), so an equal blob id is equal bytes — a per-path byte check,
//   never a tree-id comparison. An error part way (EACCES, EPERM, ENOSPC)
//   stops the writes, still verifies, and reports residuals; the safety ref
//   is already written, so undo can put everything back.
//
// Dependency direction: lib/server; imports lib/core and ../git-run.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runGit: defaultRunGit } = require('../git-run');
const { fence, realpath, isSafeId } = require('../../core/paths');

const SAFETY_KEEP = 20;
const SAFETY_REF_PREFIX = 'refs/wc/safety/';

const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// 'rs_' + base-36 milliseconds + 4 random hex.
const RESTORE_ID_RE = /^rs_[0-9a-z]{1,12}[0-9a-f]{4}$/;
const GITLINK = '160000';
// An fs error that stops the writes (anything else on one path is that
// path's own residual).
const STOPPING = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE']);

const idTime = (id) => parseInt(id.slice(3, -4), 36);

function createRestore({ root, paths, shadow, runGit = defaultRunGit, now = Date.now, log = () => {} } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createRestore: root is required');
  if (!paths || typeof paths.mirrorTmp !== 'string') throw new TypeError('createRestore: paths (lib/core/paths projectPaths) is required');
  if (!shadow || typeof shadow.snapshot !== 'function' || typeof shadow.env !== 'function') throw new TypeError('createRestore: shadow (codediff createShadowStore) is required');
  if (typeof runGit !== 'function' || typeof runGit.exclusive !== 'function') throw new TypeError('createRestore: runGit (lib/server/git-run) is required');
  const say = (m) => { try { log(m); } catch { /* a logger never breaks a restore */ } };
  let lastT = 0;
  let copies = 0;

  async function features() {
    let feats;
    try { feats = await runGit.features(); } catch { feats = { missing: false, attrSource: false }; }
    if (feats && feats.missing) return { ok: false, reason: 'git-missing' };
    let inf;
    try { inf = await shadow.init(); } catch { inf = { ok: false, reason: 'init-failed' }; }
    if (!inf || !inf.ok) return { ok: false, reason: (inf && inf.reason) || 'init-failed' };
    if (!feats || !feats.attrSource || !shadow.info().attrSource) return { ok: false, reason: 'git-too-old' };
    if (typeof shadow.full === 'function' && shadow.full()) return { ok: false, reason: 'shadow-store-full' };
    return { ok: true };
  }

  const refuse = (refused, extra = {}) => ({ ok: false, refused, ...extra });

  function newId() {
    const t = Math.max(now(), lastT + 1);
    lastT = t;
    const id = `rs_${t.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    return isSafeId(id) && RESTORE_ID_RE.test(id) ? id : null;
  }

  // ── inside a held slot: `git` is the slot's ──

  const inf = () => shadow.info();
  const shadowOpts = (extra) => ({ cwd: inf().toplevel, env: shadow.env(null), ...extra });

  async function treeIn(git, tree) {
    const r = await git(['cat-file', '-e', `${tree}^{tree}`], shadowOpts());
    return r.code === 0;
  }

  // Every entry of `tree` under the root: Map(toplevel path → {mode, oid}).
  async function lsTree(git, tree) {
    const prefix = inf().prefix;
    const r = await git(shadow.gitArgs('ls-tree', '-r', '-z', '--full-tree', tree, ...(prefix ? ['--', prefix] : [])), shadowOpts());
    if (r.code !== 0) throw Object.assign(new Error('ls-tree failed'), { code: 'ls-tree' });
    const out = new Map();
    for (const ent of r.stdout.split('\0')) {
      const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(ent);
      if (m) out.set(m[3], { mode: m[1], oid: m[2] });
    }
    return out;
  }

  async function pruneSafety(git) {
    const r = await git(['for-each-ref', '--format=%(refname)', SAFETY_REF_PREFIX], shadowOpts());
    if (r.code !== 0) return;
    const ids = r.stdout.split('\n').map((l) => l.trim().slice(SAFETY_REF_PREFIX.length)).filter((id) => RESTORE_ID_RE.test(id));
    ids.sort((a, b) => idTime(b) - idTime(a) || (a < b ? 1 : a > b ? -1 : 0));
    for (const id of ids.slice(SAFETY_KEEP)) {
      const d = await git(['update-ref', '-d', `${SAFETY_REF_PREFIX}${id}`], shadowOpts());
      if (d.code !== 0) say(`restore: could not drop safety ref ${id}`);
    }
  }

  // The first entry along `rel`'s leading directories (below the root) that
  // exists and is not a real directory: {at, link} or null.
  function leadingObstacle(topRel) {
    const { toplevel, prefix } = inf();
    const parts = topRel.split('/');
    const skip = prefix ? prefix.split('/').filter(Boolean).length : 0;
    for (let i = skip + 1; i < parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      let st;
      try { st = fs.lstatSync(path.join(toplevel, at)); } catch { return null; }
      if (!st.isDirectory()) return { at, link: st.isSymbolicLink() };
    }
    return null;
  }

  // The plan from a snapshot of the working tree to `target`.
  async function planIn(git, snap, target, targetHead) {
    const { toplevel, prefix, emptyTree } = inf();
    const rootReal = realpath(root) || root;
    const rootRel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const r = await git(shadow.gitArgs('diff-tree', '-r', '--no-renames', '-z', '--raw', snap.tree, target, ...shadow.pathspec()),
      shadowOpts({ attrSource: inf().attrSource ? emptyTree : undefined }));
    if (r.code !== 0) return refuse('failed', { code: 'diff-tree' });
    const entries = [];
    const tokens = r.stdout.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok || !tok.startsWith(':')) continue;
      const p = tokens[++i];
      if (p === undefined) break;
      const [oldMode, newMode, , , status] = tok.slice(1).trim().split(/\s+/);
      entries.push({ top: p, rel: rootRel(p), status: status.charAt(0), oldMode, newMode });
    }
    const nested = Array.isArray(snap.nested) ? snap.nested : [];
    const underNested = (rel) => nested.some((n) => rel === n || rel.startsWith(`${n}/`));
    const ex = snap.excluded || {};
    const large = new Set(ex.large || []);
    const sensitive = new Set((ex.sensitive || []).map((s) => s.path));
    const deleteSet = new Set(entries.filter((e) => e.status === 'D').map((e) => e.top));
    const notCovered = [];
    const writes = [];
    const deletes = [];
    const askIgnore = [];
    for (const e of entries) {
      const abs = path.join(toplevel, e.top);
      let reason = null;
      if (e.rel === '.web-chat' || e.rel.startsWith('.web-chat/')) reason = 'outside';
      else if (e.oldMode === GITLINK || e.newMode === GITLINK || underNested(e.rel)) reason = 'nested-repo';
      else if (large.has(e.rel)) reason = 'over-cap';
      else if (sensitive.has(e.rel)) reason = 'sensitive';
      else if (!fence(rootReal, path.dirname(abs))) reason = 'outside';
      let deferIgnore = false;
      if (!reason && e.status !== 'D') {
        const ob = leadingObstacle(e.top);
        if (ob && deleteSet.has(ob.at)) deferIgnore = true; // gone before the write: nothing of the user's stands there
        else if (ob && ob.link) reason = 'outside';
        else if (ob) reason = large.has(rootRel(ob.at)) ? 'over-cap' : sensitive.has(rootRel(ob.at)) ? 'sensitive' : 'ignored';
      }
      if (reason) { notCovered.push({ path: e.rel, reason }); continue; }
      if (e.status === 'D') deletes.push(e);
      else {
        writes.push(e);
        if (!deferIgnore) askIgnore.push(e.top);
      }
    }
    // The project's own ignore rules, now: its .gitignore files, info/exclude
    // and core.excludesFile (no shadow GIT_DIR: the project's repository,
    // read only). check-ignore reads its paths as pathspecs and refuses the
    // literal magic, so each goes in as './<path>' (a name starting ':' is
    // then no magic) and comes back as given. Exit 1 means none is ignored.
    let ignored = new Set();
    if (askIgnore.length) {
      const ci = await git(['check-ignore', '--no-index', '-z', '--stdin'],
        { cwd: toplevel, input: `${askIgnore.map((p) => `./${p}`).join('\0')}\0` });
      if (ci.code !== 0 && ci.code !== 1) return refuse('failed', { code: 'check-ignore' });
      ignored = new Set(ci.stdout.split('\0').filter(Boolean).map((p) => p.replace(/^\.\//, '')));
    }
    const keptWrites = [];
    for (const e of writes) {
      if (ignored.has(e.top)) notCovered.push({ path: e.rel, reason: 'ignored' });
      else keptWrites.push(e);
    }
    notCovered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      ok: true,
      current_tree: snap.tree,
      written: keptWrites.map((e) => ({ path: e.rel, status: e.status })),
      deleted: deletes.map((e) => e.rel),
      notCovered,
      headMoved: headMoved(targetHead, snap.head),
      writeTops: keptWrites.map((e) => e.top),
      deleteTops: deletes.map((e) => e.top),
    };
  }

  // Given and different from HEAD now; null against a sha counts as moved.
  function headMoved(targetHead, head) {
    if (targetHead === undefined) return false;
    return (targetHead === null ? null : String(targetHead)) !== (head || null);
  }

  // (4) one unlink: a file or a symlink, its real parent inside the root.
  // → null, or an error code.
  function unlinkOne(abs, rootReal) {
    if (!fence(rootReal, path.dirname(abs))) return 'EXDEV';
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { return e && e.code === 'ENOENT' ? null : (e && e.code) || 'EIO'; }
    if (st.isDirectory()) return 'EISDIR';
    try { fs.unlinkSync(abs); } catch (e) { return e && e.code === 'ENOENT' ? null : (e && e.code) || 'EIO'; }
    return null;
  }

  // Directories the deletions left empty, deepest first; never the root,
  // never outside it, never through a symlink.
  function pruneDirs(tops, rootReal) {
    const { toplevel, prefix } = inf();
    // The root as the toplevel spells it (both are realpaths): every path
    // here is the toplevel joined with a tree path under the prefix.
    const rootTop = path.join(toplevel, prefix);
    const dirs = new Set();
    for (const top of tops) {
      let d = path.dirname(path.join(toplevel, top));
      while (d !== rootTop && path.dirname(d) !== d && fence(rootReal, d)) {
        dirs.add(d);
        d = path.dirname(d);
      }
    }
    const order = [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || (a < b ? 1 : -1));
    for (const d of order) {
      try {
        if (!fs.lstatSync(d).isDirectory() || !fence(rootReal, d)) continue;
        fs.rmdirSync(d);
      } catch { /* not empty, or gone: left as it is */ }
    }
  }

  async function applyIn(git, target, { expect, targetHead }) {
    const t0 = now();
    const { toplevel } = inf();
    const rootReal = realpath(root) || root;
    if (!(await treeIn(git, target))) return refuse('tree-missing');
    // (1) the safety tree.
    const snap = await shadow.snapshot({ git });
    if (!snap.ok) return refuse('snapshot-failed', { reason: snap.reason });
    if (expect !== undefined && expect !== null && expect !== snap.tree) return refuse('stale', { current_tree: snap.tree });
    // (2) its ref, and the newest SAFETY_KEEP kept.
    const restoreId = newId();
    if (!restoreId) return refuse('safety-failed');
    const ref = await git(['update-ref', `${SAFETY_REF_PREFIX}${restoreId}`, snap.tree], shadowOpts());
    if (ref.code !== 0) return refuse('safety-failed');
    await pruneSafety(git);
    // (3) the plan, from that same snapshot.
    const plan = await planIn(git, snap, target, targetHead);
    if (!plan.ok) return plan;
    const errors = new Map();
    let stopped = false;
    // (4) the deletions, then the directories they emptied.
    for (const top of plan.deleteTops) {
      const code = unlinkOne(path.join(toplevel, top), rootReal);
      if (!code) continue;
      errors.set(top, code);
      if (STOPPING.has(code)) { stopped = true; break; }
    }
    pruneDirs(plan.deleteTops, rootReal);
    // (5) the writes, through a fresh index of the target.
    if (!stopped && plan.writeTops.length) {
      const list = [];
      for (const top of plan.writeTops) {
        const abs = path.join(toplevel, top);
        let code = null;
        if (!fence(rootReal, path.dirname(abs))) code = 'EXDEV';
        else if (leadingObstacle(top)) code = 'ENOTDIR';
        else {
          try { if (fs.lstatSync(abs).isDirectory()) code = 'EISDIR'; } catch { /* absent: written fresh */ }
        }
        if (code) errors.set(top, code);
        else list.push(top);
      }
      if (list.length) {
        copies += 1;
        const idx = path.join(paths.mirrorTmp, `restore-${process.pid}-${copies}`);
        const attrSource = inf().emptyTree;
        try {
          fs.mkdirSync(paths.mirrorTmp, { recursive: true });
          const rt = await git(shadow.gitArgs('read-tree', target), { cwd: toplevel, env: shadow.env(idx), attrSource });
          if (rt.code !== 0) {
            for (const top of list) errors.set(top, 'read-tree');
          } else {
            const co = await git(shadow.gitArgs('-c', 'core.symlinks=true', 'checkout-index', '-f', '-z', '--stdin'),
              { cwd: toplevel, env: shadow.env(idx), attrSource, input: `${list.join('\0')}\0` });
            if (co.code !== 0) say(`restore: checkout-index exited ${co.code}`);
          }
        } catch (e) {
          for (const top of list) if (!errors.has(top)) errors.set(top, (e && e.code) || 'git-error');
        } finally {
          try { fs.rmSync(idx, { force: true }); } catch { /* housekeeping empties tmp */ }
        }
      }
    }
    // (6) verify, path by path, against a fresh snapshot.
    const residual = [];
    let afterTree = null;
    const after = await shadow.snapshot({ git });
    if (!after.ok) {
      for (const top of [...plan.writeTops, ...plan.deleteTops]) residual.push({ path: relOf(top), reason: 'error', code: errors.get(top) || 'verify-failed' });
    } else {
      afterTree = after.tree;
      let want;
      let got;
      try {
        want = await lsTree(git, target);
        got = await lsTree(git, after.tree);
      } catch {
        want = null;
      }
      if (!want) {
        for (const top of [...plan.writeTops, ...plan.deleteTops]) residual.push({ path: relOf(top), reason: 'error', code: 'verify-failed' });
      } else {
        for (const top of plan.writeTops) {
          const w = want.get(top);
          const g = got.get(top);
          const same = w && g && w.mode === g.mode && w.oid === g.oid;
          if (same) continue;
          if (errors.has(top)) residual.push({ path: relOf(top), reason: 'error', code: errors.get(top) });
          else residual.push({ path: relOf(top), reason: g ? 'mismatch' : 'missing' });
        }
        for (const top of plan.deleteTops) {
          if (!got.has(top)) continue;
          if (errors.has(top)) residual.push({ path: relOf(top), reason: 'error', code: errors.get(top) });
          else residual.push({ path: relOf(top), reason: 'still-present' });
        }
      }
    }
    if (residual.length) say(`restore: ${restoreId} left ${residual.length} residual path(s)`);
    return {
      ok: residual.length === 0,
      restore_id: restoreId,
      safety_tree: snap.tree,
      after_tree: afterTree,
      written: plan.written,
      deleted: plan.deleted,
      notCovered: plan.notCovered,
      headMoved: plan.headMoved,
      residual,
      duration_ms: Math.max(0, now() - t0),
    };
  }

  function relOf(top) {
    const prefix = inf().prefix;
    return prefix && top.startsWith(prefix) ? top.slice(prefix.length) : top;
  }

  // A held slot for `fn(git)`; a throw before any write is 'failed'.
  async function inSlot(fn) {
    try {
      return await runGit.exclusive(fn);
    } catch (e) {
      say(`restore: failed (${(e && e.code) || 'error'})`);
      return refuse('failed', { code: (e && e.code) || 'error' });
    }
  }

  async function preview(targetTree, { targetHead } = {}) {
    const f = await features();
    if (!f.ok) return refuse(f.reason);
    if (typeof targetTree !== 'string' || !TREE_RE.test(targetTree)) return refuse('bad-tree');
    return inSlot(async (git) => {
      if (!(await treeIn(git, targetTree))) return refuse('tree-missing');
      const snap = await shadow.snapshot({ git });
      if (!snap.ok) return refuse('snapshot-failed', { reason: snap.reason });
      const plan = await planIn(git, snap, targetTree, targetHead);
      if (!plan.ok) return plan;
      return {
        ok: true, current_tree: plan.current_tree, written: plan.written, deleted: plan.deleted,
        notCovered: plan.notCovered, headMoved: plan.headMoved,
      };
    });
  }

  async function apply(targetTree, { expect, targetHead } = {}) {
    const f = await features();
    if (!f.ok) return refuse(f.reason);
    if (typeof targetTree !== 'string' || !TREE_RE.test(targetTree)) return refuse('bad-tree');
    return inSlot((git) => applyIn(git, targetTree, { expect, targetHead }));
  }

  async function undo(restoreId, { expect } = {}) {
    const f = await features();
    if (!f.ok) return refuse(f.reason);
    if (!isSafeId(restoreId) || !RESTORE_ID_RE.test(restoreId)) return refuse('unknown');
    return inSlot(async (git) => {
      const r = await git(['rev-parse', '--verify', '-q', `${SAFETY_REF_PREFIX}${restoreId}^{tree}`], shadowOpts());
      const tree = r.code === 0 ? r.stdout.trim() : '';
      if (!TREE_RE.test(tree)) return refuse('unknown');
      const out = await applyIn(git, tree, { expect });
      return { ...out, undo_of: restoreId };
    });
  }

  async function safetyRefs() {
    let i;
    try { i = await shadow.init(); } catch { i = null; }
    if (!i || !i.ok) return [];
    let r;
    try {
      r = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)', SAFETY_REF_PREFIX], shadowOpts());
    } catch {
      return [];
    }
    if (r.code !== 0) return [];
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const [name, tree] = line.split('\0');
      if (!name || !tree) continue;
      const id = name.slice(SAFETY_REF_PREFIX.length);
      if (RESTORE_ID_RE.test(id) && TREE_RE.test(tree)) out.push({ restore_id: id, tree });
    }
    out.sort((a, b) => idTime(b.restore_id) - idTime(a.restore_id) || (a.restore_id < b.restore_id ? 1 : -1));
    return out;
  }

  return Object.freeze({ features, preview, apply, undo, safetyRefs });
}

module.exports = { createRestore, SAFETY_KEEP, SAFETY_REF_PREFIX };
