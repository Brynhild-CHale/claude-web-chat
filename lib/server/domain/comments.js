// lib/server/domain/comments.js — comment-pin domain helpers shared across the
// route and the queue-revert path. Stateless like the other domain modules: every
// fn receives the live `state` (which owns state.comments) and the change `bus`.
//
// deleteComment is the ONE canonical pin removal (C1): it filters the pin out of
// state.comments and emits the `comment` delete event + `comments` WS frame in a
// single shape, so the route's DELETE and the queue's Revert can't drift a second
// divergent delete frame. Returns true if a pin was removed, false if the id
// wasn't found. A delete event carries no pin (only the bare id policy.js reads on
// the dequeue path), so there is nothing to redact here.
function deleteComment(state, bus, id) {
  const next = state.comments.filter((c) => c.id !== id);
  if (next.length === state.comments.length) return false;
  state.comments = next;
  bus.emit({
    event: { kind: 'comment', op: 'delete', id },
    ws: { type: 'comments', comments: state.comments },
  });
  return true;
}

module.exports = { deleteComment };
