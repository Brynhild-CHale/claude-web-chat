// Comment pins (feature 6). The LIVE pins are state.comments — a dedicated
// array, NOT the freeform store — because the store is exposed to Claude
// (get_store, diff_nodes) and private pins kept there would leak. They persist
// via a `comments` field on each committed node (graph.snapshotLive /
// restoreLiveToNode) and survive restart.
//
// THE ELEMENT LOG IS THE ONE WRITER OF COMMENT TEXT (PLAN 1A.2, 1A.5, GT-09).
// Every add, edit and reply goes through the element store (ctx.graph.elements,
// lib/server/domain/elements): it appends a version through the log's one
// redacted writer and answers the pin projection built from what it stored, and
// this route puts THAT pin into state.comments — it never assigns comment text
// it did not get back from the store. A secret typed into a comment so comes
// back masked to its own author, and the bytes on disk never hold it.
//
// A pin (the store's projection): { id, seq, created_at, shared, text,
//   anchor (the original locator: {mount, selector, text, ordinal}), replies?,
//   v, writer, provenance, edited? } — the stamps below. `shared` defaults
// true; the user can toggle it off to keep a note private.
//
// IDS AND SEQS come from the log alone (G-9, GT-10): an id is 'c' + the seq of
// its first version, minted from the log's max seq — every version it holds,
// every reservation (graph.load reserves each node copy's seq), the migration's
// seq floor — so an id held in a torn node, a set-aside draft or a pin lost to a
// hard stop is never minted again.
//
// THE CURSOR (PLAN 1A.8, GT-20): GET's `next_cursor` is the log's max seq —
// the highest seq ever minted or reserved — so it never decreases: not on a
// delete, a Set active, a Wipe, a New graph or a restart. Each add, changing
// edit and reply appends a version with a fresh seq, so each raises it by one.
// `since=N` answers the live pins whose seq is above N (exclusive).
//
// READ-ONLY: while the comment migration is refused (elements.readOnly), add,
// edit and reply answer 503 with READ_ONLY_HINT; GET and DELETE still work.

const { RESPOND_HINT } = require('../../channel/envelope');
const { deleteComment } = require('../domain/comments');
const { dropPrivate } = require('../../core/remote-policy');
const { provenance } = require('../domain/queue');
const { isRemoteRequest } = require('../../core/cors');
const { STALE_HINT } = require('./writers');

// THE WRITE STAMP (PLAN 1B.4 / 1B.5 / 1D.3, U214c; ruling A2). Every add,
// edit and reply records who wrote it and where from, as two plain objects:
//   writer     — {class, owner, verified}, lib/server/domain/writers
//                resolveWriter's answer for the request (pane class included);
//   provenance — queue.provenance of the request: origin 'remote' through the
//                portal, else 'local'; device from the chrome's own claim
//                (`device` in the body, viewport.js deviceKind), else the
//                User-Agent.
// A new pin carries both; each reply carries the pair of the write that
// appended it; an edit records `edited: {writer, provenance, at}` and never
// rewrites the creator's `writer`. A delete stamps nothing (no tombstone, C2).
// They are the sibling fields of the version the write appends to the element
// log, outside both hashes (F3), and come back on the store's projection;
// redactPin keeps them.
//
// The rules they authenticate (a CLAIMED class, never an ownership rule —
// DECISIONS A1; notes-B Q9, Q10):
//   * a reply claiming author 'claude' needs the claude class (Claude's writer
//     token, or — advisory until 2C — a tokenless local non-browser caller),
//     else 403 {ok:false, writer:'unverified'}; anyone else's reply is 'user'.
//     The self-wake gate (lib/channel/policy) reads that author.
//   * a pane-stamped writer may edit or delete only a pin whose stored
//     writer.owner is its own `pane:<id>`, else 403 {ok:false, writer:'pane'}
//     (ruling B4). It refuses only a request that names itself a pane: pane
//     scripts run in the chrome's realm, and one that calls `window.fetch`
//     unstamped reads as the user (lib/server/domain/writers — cooperative;
//     GT-15's pane clause carries that residual).
const PANE_EDIT_HINT = 'a pane edits and deletes only the pins it added';
const CLAUDE_REPLY_HINT = 'only Claude replies as author claude (the reply_comment tool)';

function stampOf(w) {
  return { class: w.class, owner: w.owner, verified: w.verified === true };
}

function provenanceOf(req) {
  return provenance({
    remote: isRemoteRequest(req),
    device: req.body && typeof req.body === 'object' ? req.body.device : undefined,
    userAgent: req.headers['user-agent'],
  });
}

const READ_ONLY_ERROR = 'comments are read-only until the comment migration runs';
const READ_ONLY_HINT = 'run claude-web-chat migrate for the report';
const MOUNTLESS_HINT = 'an anchor names the pane it is on ({mount, selector, text, ordinal}), or is null for a page note';
const UNMAPPED_HINT = 'this pin cannot be recorded in the comment log; run claude-web-chat migrate for the report';

// A PRIVATE pin's text must never enter the event ring — get_events
// serves the ring unfiltered, so it would leak exactly what get_comments withholds.
// Redact the note body + every reply body from the EVENT copy, but keep the fields
// the dequeue path reads (lib/channel/policy reads event.pin.id and
// event.pin.shared === false). A shared pin is returned untouched — its text is
// already Claude-visible and commentItem needs it for the wake summary.
function redactPin(pin) {
  if (!pin || pin.shared !== false) return pin;
  const out = { ...pin, text: '' };
  if (Array.isArray(pin.replies)) out.replies = pin.replies.map((r) => ({ ...r, text: '' }));
  return out;
}

// Human-readable anchor for Claude: the element API's (routes/elements.js),
// re-exported here so there is one copy (U325; U327a replaces this file).
const { describeAnchor } = require('./elements');

// Remotely, reading the pins is the conversation's (`read`) and writing one is
// speaking into it (`full`): the levels lib/core/remote-policy's RULES give
// these routes, checked here again (requireMirror), as the portal's table is
// not the daemon's only lock — a network peer never reaches that table, and a
// portal older than protocol 11 lets every comment route through.
function mountCommentRoutes(app, { state, bus, audience, writers, graph }) {
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountCommentRoutes: ctx.writers is required');
  if (!graph || !graph.elements) throw new TypeError('mountCommentRoutes: ctx.graph.elements (the element store) is required');
  // Reached through the graph on every call, never captured (domain/elements).
  const elements = () => graph.elements;
  const see = audience.requireMirror('read');
  const send = audience.requireMirror('full');

  // Who is writing, or a 401 for a stale writer token (the MCP client
  // re-reads .web-chat/writer-token once, as on the render gate). Answers
  // null when it sent the response.
  function writerOf(req, res) {
    const w = writers.resolveWriter(req, req.body, { pane: true });
    if (w.stale) { res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT }); return null; }
    return stampOf(w);
  }

  // A private pin answers 404 to anyone who does not see private pins
  // (audience.seesPrivate: a local browser) — the 404-not-403 rule the
  // claude-reply gate uses, so an enumerable id (c1..cN) cannot be probed, and
  // a write route cannot hand back or publish what GET withholds (DECISIONS
  // A2). Answers true when it sent the response.
  function hiddenPrivate(req, res, pin) {
    if (pin.shared !== false || audience.seesPrivate(req)) return false;
    res.status(404).json({ error: 'not found', id: req.params.id });
    return true;
  }

  // Ruling B4: a pane edits or deletes only the pins it added.
  function refusedPane(res, w, pin) {
    if (w.class !== 'pane') return false;
    if (pin.writer && pin.writer.owner === w.owner) return false;
    res.status(403).json({ ok: false, writer: 'pane', hint: PANE_EDIT_HINT });
    return true;
  }
  // A write the store cannot take answers here (true when it sent the
  // response): read-only (503, D15), an anchor with no mount (400), a live pin
  // with no version and none to be had (409). Anything else is a real fault.
  function readOnly(res) {
    if (!elements().readOnly) return false;
    res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    return true;
  }
  function refusedWrite(res, e) {
    if (e && e.code === 'READ_ONLY') { res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT }); return true; }
    if (e && e.reason === 'anchor-without-mount') { res.status(400).json({ error: 'anchor without a mount', hint: MOUNTLESS_HINT }); return true; }
    if (e && e.code === 'UNMAPPED') { res.status(409).json({ error: 'unmapped pin', hint: UNMAPPED_HINT }); return true; }
    return false;
  }
  // Notify the surface (its own dedicated message — pins aren't in the store, so
  // no store:patch). The committed node picks them up via snapshotLive.
  function notify(op, extra) {
    const event = { kind: 'comment', op, ...extra };
    if (event.pin) event.pin = redactPin(event.pin); // F1 — never leak a private pin's body into the ring
    bus.emit({
      event,
      // The WS frame carries the FULL comments array, and lib/server/ws.js
      // projects it per socket (remote-policy FRAME_RULES' `comments` row): a
      // local socket gets it whole, private pins included (its chrome renders
      // them for the user); a remote viewer at read or full gets it without the
      // private pins (PRIVATE_RULES); one below read gets no frame at all.
      ws: { type: 'comments', comments: state.comments },
    });
  }

  // READ. `shared_only` (the MCP boundary) returns only shared pins; the browser
  // omits it and gets everything (incl. private, which it renders for the user).
  // `since` is exclusive on seq; `mount` scopes to one pane. next_cursor is the
  // log's max seq (the cursor rule, above): never below any pin's seq, private
  // ones included, so a later private pin can't hide a newer shared one behind
  // it — a number, no text, the same for every caller.
  // Learned later (C-13, ruling A3): the list passes elements.maskPins, so a
  // value the redactor learned after the write is masked on this read too.
  // Private (decision A2): only a local browser sees a private pin
  // (audience.seesPrivate). Anyone else — lib/client (Claude's tools, a hook, a
  // plain curl), a remote viewer at any opt-in — gets the body less its private
  // pins, through PRIVATE_RULES' 'GET /api/comments' row (remote-policy
  // dropPrivate), whatever `shared_only` says. audience.js names the two
  // residuals (the node files on disk; a curl that forges Origin).
  app.get('/api/comments', see, (req, res) => {
    const all = state.comments;
    const sharedOnly = req.query.shared_only === '1' || req.query.shared_only === 'true';
    const since = parseInt(req.query.since || '0', 10) || 0;
    const mount = req.query.mount ? String(req.query.mount) : null;

    let list = all;
    if (sharedOnly) list = list.filter((c) => c.shared);
    if (since) list = list.filter((c) => (c.seq || 0) > since);
    if (mount) list = list.filter((c) => c.anchor && c.anchor.mount === mount);

    const next_cursor = elements().maxSeq();
    const body = {
      // `replies` (if any) ride each pin so Claude reads the whole thread.
      comments: elements().maskPins(list).map((c) => ({ ...c, anchor_label: describeAnchor(c.anchor) })),
      next_cursor,
      // `respond_hint` routes Claude to the reply skill. ONE top-level
      // field — not stamped per pin, which re-shipped the ~160-char string N×
      // per 3s browser poll.
      respond_hint: RESPOND_HINT,
    };
    res.json(audience.seesPrivate(req) ? body : dropPrivate('routes', 'GET /api/comments', body));
  });

  // ADD.
  app.post('/api/comments', send, (req, res) => {
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (readOnly(res)) return undefined;
    const { text = '', shared = true, anchor = null } = req.body || {};
    let pin;
    try {
      pin = elements().add({
        text: String(text),
        shared: shared !== false,
        anchor: anchor && typeof anchor === 'object' ? anchor : null,
        author: 'user',
        writer,
        provenance: provenanceOf(req),
      });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    state.comments = state.comments.concat([pin]);
    // Carry the pin on the ADD event so the wake policy can fold a shared pin into
    // the queue (lib/channel/policy commentItem); notify redacts a private one.
    // No top-level id/mount — pin.id and pin.anchor.mount already carry them and
    // nothing reads the duplicates (C7).
    notify('add', { pin });
    res.json({ ok: true, pin });
  });

  // EDIT / TOGGLE SHARED. A new seq ONLY when something actually changed, so
  // a private→shared toggle (or a text edit) re-surfaces to Claude on the next
  // get_comments, while a no-op PATCH doesn't needlessly bump the cursor.
  app.patch('/api/comments/:id', send, (req, res) => {
    const idx = state.comments.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found', id: req.params.id });
    const prev = state.comments[idx];
    if (hiddenPrivate(req, res, prev)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (refusedPane(res, writer, prev)) return undefined;
    const { text, shared } = req.body || {};
    let changed = false;
    if (text !== undefined && String(text) !== prev.text) changed = true;
    if (shared !== undefined && !!shared !== prev.shared) changed = true;
    if (!changed) return res.json({ ok: true, pin: prev, unchanged: true });
    if (readOnly(res)) return undefined;
    // The store appends the edit's version (a fresh seq) carrying this write's
    // writer and provenance; its projection keeps the creator's `writer` and
    // answers the edit's own stamp as `edited` (ruling A2). An edit whose
    // stored (redacted) payload equals the pin's version appends nothing.
    let r;
    try {
      r = elements().edit(prev, {
        text: text !== undefined ? String(text) : undefined,
        shared: shared !== undefined ? !!shared : undefined,
        writer,
        provenance: provenanceOf(req),
      });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    if (r.unchanged) return res.json({ ok: true, pin: prev, unchanged: true });
    const pin = r.pin;
    // The store's pin where the live one was (a new array: the bus ring and a
    // queued item may hold the old one).
    const next = state.comments.slice();
    next[idx] = pin;
    state.comments = next;
    // Carry the pin so the wake policy can enqueue a private→shared toggle: the
    // moment a note is made visible to Claude is a deliberate handoff, same as an
    // add. `became_shared` gates the enqueue; `became_private` is the writer-side
    // symmetry (B7) a later consumer reads to dequeue on a shared→private flip
    // (policy.js infers it from raw state today — don't change that here). No
    // top-level id/mount (C7).
    const becameShared = !prev.shared && pin.shared;
    const becamePrivate = prev.shared && !pin.shared;
    notify('edit', { pin, became_shared: becameShared, became_private: becamePrivate });
    res.json({ ok: true, pin });
  });

  // REPLY — append a message to a pin's thread. `author` is 'claude'
  // (the reply_comment MCP tool) or 'user' (the browser reply box; the default).
  // Bumps seq so the thread re-surfaces on the next get_comments(since). The reply
  // event carries the pin + author so the wake policy enqueues a USER reply (to
  // continue the thread) but never Claude's own (self-wake gate).
  app.post('/api/comments/:id/reply', send, (req, res) => {
    const idx = state.comments.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found', id: req.params.id });
    const { text = '', author } = req.body || {};
    const who = author === 'claude' ? 'claude' : 'user';
    const prev = state.comments[idx];
    if (hiddenPrivate(req, res, prev)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    // Claude may not reply into a PRIVATE thread — and we answer 404
    // (not 403) so an enumerable id (c1..cN) can't be probed for existence via
    // 200-vs-403. A user's browser reply on a private pin stays allowed.
    if (who === 'claude' && !prev.shared) return res.status(404).json({ error: 'not found', id: req.params.id });
    // Author 'claude' is a claim of the claude class (above).
    if (who === 'claude' && writer.class !== 'claude') {
      return res.status(403).json({ ok: false, writer: 'unverified', hint: CLAUDE_REPLY_HINT });
    }
    const body = String(text).trim();
    if (!body) return res.status(400).json({ error: 'empty reply' });
    if (readOnly(res)) return undefined;
    // The store appends the reply's version (a fresh seq); the projected reply
    // carries this write's writer and provenance (ruling A2).
    let pin;
    try {
      pin = elements().reply(prev, { text: body, author: who, writer, provenance: provenanceOf(req) });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    // The store's pin where the live one was (a new array: the bus ring and a
    // queued item may hold the old one).
    const next = state.comments.slice();
    next[idx] = pin;
    state.comments = next;
    notify('reply', { pin, author: who }); // no top-level id (C7); notify redacts a private pin
    res.json({ ok: true, pin });
  });

  // DELETE (explicit removal — pins never vanish via a stray store write). The
  // removal + delete frame live in the shared domain helper (C1) so the queue's
  // Revert path can't drift a second delete shape.
  app.delete('/api/comments/:id', send, (req, res) => {
    const prev = state.comments.find((c) => c.id === req.params.id);
    if (!prev) return res.status(404).json({ error: 'not found', id: req.params.id });
    if (hiddenPrivate(req, res, prev)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (refusedPane(res, writer, prev)) return undefined;
    if (!deleteComment(state, bus, req.params.id)) return res.status(404).json({ error: 'not found', id: req.params.id });
    res.json({ ok: true, removed: req.params.id });
  });
}

module.exports = { mountCommentRoutes, describeAnchor };
