// The toolbar's records over HTTP (annotation engine 2D.2; DECISIONS.md I.6,
// rulings H-6 and U332@project-chrome-rebind). lib/core/toolbar-record is the
// one validator, chord grammar and patcher; this file reads and writes the two
// files through lib/core/fsjson and says who may write which.
//
//   GET   /api/toolbar       → {ok, v, project, user, merged, canWrite,
//                              canWriteUser, corrupt?, ignored?}
//         every level (the tray reads). `canWrite`: the requester may write the
//         project record (local, or a remote viewer at mirror level full);
//         `canWriteUser`: local only. The chrome greys a read-only tray from
//         these two facts, never from a check of its own (W-12).
//   PATCH /api/toolbar       the project record (.web-chat/toolbar.json): pin,
//         hide, order, settings, profiles, project bindings. Local, or a remote
//         viewer at full (H-6); the daemon checks the level the portal enforces
//         again (requireMirror('full')).
//   PATCH /api/toolbar/user  the user record (~/.web-chat/toolbar.json): the
//         key bindings for every project, fingerDraws, per-tool defaults. Local
//         only — a write that reaches every project on the host (the
//         routes/theme.js precedent for a system theme). NOT requireHost():
//         isHost refuses every browser request, and the user's own chrome must
//         write this record. A pane's fetch reaches it too, which costs nothing:
//         neither record grants, installs, trusts or runs anything (C-15-1 — no
//         rule here reads a pane's identity or an author as a boundary).
//
// A record that is absent reads as the defaults; one that is torn or fails the
// validator reads as the defaults AND is named in `corrupt` — never a silent
// empty. The next PATCH of that tier first moves the bad file aside
// (renameAside, tag 'corrupt'), then writes a fresh record. Writes go through
// writeJsonAtomic only.
//
// A previewed node never refuses a toolbar write: toolbar state is not node
// content (W-4) — only levels refuse. The records never touch state.store
// (which folds into nodes) and never browser storage.
//
// Each successful write emits ONE `toolbar` frame through ctx.bus.emit, with no
// event-log entry: toolbar state is not surface content, folds into no node
// and is not Claude's catch-up (notes-D.md D-5). The frame is a SURFACE_FRAMES
// entry (lib/core/remote-policy): it carries no conversation text and no
// private record, and passes whole at every level, as GET does.
//
// NOT here yet (U337, in this file): the tool listing, `installed` per
// binding, manifest-schema validation of settings, and the icon route.
'use strict';

const { projectPaths, userPaths } = require('../../core/paths');
const { readJson, writeJsonAtomic, renameAside } = require('../../core/fsjson');
const { classify, MIRROR_FULL_HINT } = require('../../core/remote-policy');
const {
  normalizeProject, normalizeUser, emptyProject, emptyUser, applyPatch, view, VERSION,
} = require('../../core/toolbar-record');

// A PATCH body's cap. The global JSON parser (lib/server/index.js) has already
// read the body at its own, far larger, limit, so the cap is checked here on
// the declared length and on the parsed body.
const TOOLBAR_BODY_MAX = 64 * 1024;

// The user-tier refusal's words: the portal's own for the same refusal (its
// `* /api/toolbar/*` row), read from the table rather than copied.
const USER_HINT = classify('PATCH', '/api/toolbar/user').hint;

const TIERS = Object.freeze({
  project: { file: (ctx) => projectPaths(ctx.root).toolbar, normalize: normalizeProject, empty: emptyProject },
  user: { file: () => userPaths().toolbar, normalize: normalizeUser, empty: emptyUser },
});

// One tier's record as the file holds it: {record, ignored, corrupt, absent}.
function readTier(ctx, tier) {
  const t = TIERS[tier];
  const r = readJson(t.file(ctx));
  if (r.absent) return { record: t.empty(), ignored: [], corrupt: false, absent: true };
  if (!r.ok) return { record: t.empty(), ignored: [], corrupt: true, absent: false };
  try {
    const { record, ignored } = t.normalize(r.value);
    return { record, ignored, corrupt: false, absent: false };
  } catch {
    return { record: t.empty(), ignored: [], corrupt: true, absent: false };
  }
}

function bytesOf(v) {
  try { return Buffer.byteLength(JSON.stringify(v) || '', 'utf8'); } catch { return Infinity; }
}

function tooLarge(req) {
  const raw = req.headers['content-length'];
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw) && Number(raw) > TOOLBAR_BODY_MAX) return true;
  return bytesOf(req.body) > TOOLBAR_BODY_MAX;
}

function mountToolbarRoutes(app, ctx) {
  const levelOf = (req) => {
    try { return ctx.audience.levelOf(req); } catch { return 'basic'; }
  };
  const canWrite = (req) => {
    const level = levelOf(req);
    return level === 'local' || level === 'full';
  };
  // The daemon's own check behind the portal's PATCH row. Without an audience
  // (a server built without one) nothing remote is let through: narrower,
  // never wider.
  const fullOnly = ctx.audience && typeof ctx.audience.requireMirror === 'function'
    ? ctx.audience.requireMirror('full')
    : (req, res, next) => (levelOf(req) === 'local' ? next()
      : res.status(403).json({ ok: false, hint: MIRROR_FULL_HINT }));

  function current() {
    return { project: readTier(ctx, 'project'), user: readTier(ctx, 'user') };
  }

  // The view and what this requester may do with it.
  function answer(req, read) {
    const body = { ok: true, v: VERSION, ...view(read.project.record, read.user.record) };
    body.canWrite = canWrite(req);
    body.canWriteUser = levelOf(req) === 'local';
    const corrupt = ['project', 'user'].filter((t) => read[t].corrupt);
    if (corrupt.length) body.corrupt = corrupt;
    const ignored = [
      ...read.project.ignored.map((f) => `project.${f}`),
      ...read.user.ignored.map((f) => `user.${f}`),
    ];
    if (ignored.length) body.ignored = ignored;
    return body;
  }

  function write(req, res, tier) {
    if (tooLarge(req)) {
      return res.status(413).json({ ok: false, error: `a toolbar patch is at most ${TOOLBAR_BODY_MAX} bytes`, field: '' });
    }
    const read = current();
    const now = read[tier];
    const patched = applyPatch(now.record, req.body, tier);
    if (!patched.ok) {
      return res.status(400).json({ ok: false, error: patched.why, field: patched.field });
    }
    const file = TIERS[tier].file(ctx);
    try {
      if (now.corrupt) renameAside(file, { tag: 'corrupt' });
      writeJsonAtomic(file, patched.record);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `the toolbar record could not be written: ${(e && e.message) || e}` });
    }
    const next = { ...read, [tier]: { record: patched.record, ignored: [], corrupt: false, absent: false } };
    ctx.bus.emit({ ws: { type: 'toolbar', v: VERSION, ...view(next.project.record, next.user.record) } });
    return res.json(answer(req, next));
  }

  app.get('/api/toolbar', (req, res) => {
    res.json(answer(req, current()));
  });

  app.patch('/api/toolbar', fullOnly, (req, res) => write(req, res, 'project'));

  app.patch('/api/toolbar/user', (req, res) => {
    if (levelOf(req) !== 'local') return res.status(403).json({ ok: false, remote: true, hint: USER_HINT });
    return write(req, res, 'user');
  });
}

module.exports = { mountToolbarRoutes, TOOLBAR_BODY_MAX };
