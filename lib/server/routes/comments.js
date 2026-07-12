// Comment pins (feature 6). Pins live in state.comments — a dedicated array,
// NOT the freeform store — because the store is exposed to Claude (get_store,
// diff_nodes) and private pins kept there would leak. They persist via a
// `comments` field on each committed node (see graph.snapshotLive /
// restoreLiveToNode) and survive restart. Every mutation is a server-owned
// read-modify-write, so this route is the sole writer.
//
// A pin: { id, seq, created_at, shared, text, anchor:{mount, selector, text, ordinal} }
// `shared` defaults true; the user can toggle it off to keep a note private.
// `seq` is a server-global monotonic counter (state.commentSeq) — never reset by
// node navigation — so ids stay unique and a get_comments cursor advances safely.

const { RESPOND_HINT } = require('../../channel/envelope');
const { deleteComment } = require('../domain/comments');

function nextSeq(state) {
  state.commentSeq = (state.commentSeq || 0) + 1;
  return state.commentSeq;
}

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

// Human-readable anchor for Claude — never raw DOM internals alone.
function describeAnchor(a) {
  if (!a || !a.mount) return null;
  const t = a.text && String(a.text).trim();
  if (t) return `${a.mount}: "${t.length > 60 ? t.slice(0, 60) + '…' : t}"`;
  if (a.selector) return `${a.mount} @ ${a.selector}`;
  return `${a.mount} (whole pane)`;
}

function mountCommentRoutes(app, { state, bus }) {
  // Notify the surface (its own dedicated message — pins aren't in the store, so
  // no store:patch). The committed node picks them up via snapshotLive.
  function notify(op, extra) {
    const event = { kind: 'comment', op, ...extra };
    if (event.pin) event.pin = redactPin(event.pin); // F1 — never leak a private pin's body into the ring
    bus.emit({
      event,
      // The WS frame carries the FULL comments array — it goes only to the pin
      // author's own browser (which renders private pins), so it isn't a leak.
      ws: { type: 'comments', comments: state.comments },
    });
  }

  // READ. `shared_only` (the MCP boundary) returns only shared pins; the browser
  // omits it and gets everything (incl. private, which it renders for the user).
  // `since` is exclusive on seq; `mount` scopes to one pane. next_cursor is the
  // max seq over the FULL array so a later private pin can't hide a newer shared
  // one behind it.
  app.get('/api/comments', (req, res) => {
    const all = state.comments;
    const sharedOnly = req.query.shared_only === '1' || req.query.shared_only === 'true';
    const since = parseInt(req.query.since || '0', 10) || 0;
    const mount = req.query.mount ? String(req.query.mount) : null;

    let list = all;
    if (sharedOnly) list = list.filter((c) => c.shared);
    if (since) list = list.filter((c) => (c.seq || 0) > since);
    if (mount) list = list.filter((c) => c.anchor && c.anchor.mount === mount);

    const next_cursor = all.reduce((m, c) => Math.max(m, c.seq || 0), 0);
    res.json({
      // `replies` (if any) ride each pin so Claude reads the whole thread.
      comments: list.map((c) => ({ ...c, anchor_label: describeAnchor(c.anchor) })),
      next_cursor,
      // `respond_hint` routes Claude to the reply skill. ONE top-level
      // field — not stamped per pin, which re-shipped the ~160-char string N×
      // per 3s browser poll.
      respond_hint: RESPOND_HINT,
    });
  });

  // ADD.
  app.post('/api/comments', (req, res) => {
    const { text = '', shared = true, anchor = null } = req.body || {};
    const seq = nextSeq(state);
    const pin = {
      id: `c${seq}`,
      seq,
      created_at: Date.now(),
      shared: shared !== false,
      text: String(text),
      anchor: anchor && typeof anchor === 'object' ? anchor : null,
    };
    state.comments = state.comments.concat([pin]);
    // Carry the pin on the ADD event so the wake policy can fold a shared pin into
    // the queue (lib/channel/policy commentItem); notify redacts a private one.
    // No top-level id/mount — pin.id and pin.anchor.mount already carry them and
    // nothing reads the duplicates (C7).
    notify('add', { pin });
    res.json({ ok: true, pin });
  });

  // EDIT / TOGGLE SHARED. Re-stamps seq ONLY when something actually changed, so
  // a private→shared toggle (or a text edit) re-surfaces to Claude on the next
  // get_comments, while a no-op PATCH doesn't needlessly bump the cursor.
  app.patch('/api/comments/:id', (req, res) => {
    const idx = state.comments.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found', id: req.params.id });
    const prev = state.comments[idx];
    const { text, shared } = req.body || {};
    const pin = { ...prev };
    let changed = false;
    if (text !== undefined && String(text) !== prev.text) { pin.text = String(text); changed = true; }
    if (shared !== undefined && !!shared !== prev.shared) { pin.shared = !!shared; changed = true; }
    if (!changed) return res.json({ ok: true, pin: prev, unchanged: true });
    pin.seq = nextSeq(state);
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
  app.post('/api/comments/:id/reply', (req, res) => {
    const idx = state.comments.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found', id: req.params.id });
    const { text = '', author } = req.body || {};
    const who = author === 'claude' ? 'claude' : 'user';
    const prev = state.comments[idx];
    // Claude may not reply into a PRIVATE thread — and we answer 404
    // (not 403) so an enumerable id (c1..cN) can't be probed for existence via
    // 200-vs-403. A user's browser reply on a private pin stays allowed.
    if (who === 'claude' && !prev.shared) return res.status(404).json({ error: 'not found', id: req.params.id });
    const body = String(text).trim();
    if (!body) return res.status(400).json({ error: 'empty reply' });
    const reply = { author: who, text: body, at: Date.now() };
    const pin = {
      ...prev,
      replies: (Array.isArray(prev.replies) ? prev.replies : []).concat([reply]),
      seq: nextSeq(state),
    };
    const next = state.comments.slice();
    next[idx] = pin;
    state.comments = next;
    notify('reply', { pin, author: who }); // no top-level id (C7); notify redacts a private pin
    res.json({ ok: true, pin });
  });

  // DELETE (explicit removal — pins never vanish via a stray store write). The
  // removal + delete frame live in the shared domain helper (C1) so the queue's
  // Revert path can't drift a second delete shape.
  app.delete('/api/comments/:id', (req, res) => {
    if (!deleteComment(state, bus, req.params.id)) return res.status(404).json({ error: 'not found', id: req.params.id });
    res.json({ ok: true, removed: req.params.id });
  });
}

module.exports = { mountCommentRoutes, describeAnchor };
