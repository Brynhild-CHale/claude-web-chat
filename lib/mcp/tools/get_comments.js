const client = require('../client');

module.exports = {
  name: 'get_comments',
  description: 'Pull the user\'s comment pins from the surface — notes they attached to specific points on the page by clicking an element and typing. Returns ONLY pins the user shared (a per-pin toggle, default on; private pins are withheld). Each pin: `{id, seq, created_at, text, anchor, anchor_label, replies}`. `text` is the ROOT note; `anchor_label` describes what it\'s pinned to (e.g. `plan: "Timeline"`); `replies` is the thread, `[{author:\'user\'|\'claude\', text, at}]` oldest→newest. On a `[comment] reply` wake the ask is the LATEST entry in `replies[]` (the user\'s newest message), NOT `pin.text` — answer that, in-thread, with reply_comment. Use `since` (a seq cursor; pass the prior `next_cursor`) to fetch only new/updated pins, `mount` to scope to one pane. Returns `{comments, next_cursor, respond_hint}` — `respond_hint` is ONE top-level field (not per pin) routing you to the respond-to-comment skill. Check this at the start of a turn when the user mentions leaving comments/notes. The same read serves every element type: pass `type: \'highlight\'` for the text the user highlighted on the page and shared (a `Highlight sent to Claude` queue item names one) — each `{id, v, anchor, color, note, shared, seq, created_at}`, where `anchor.quote.exact` is the highlighted text and `note` the user\'s note on it (often empty) — returned as `{type, elements, next_cursor}`; only comments take replies (reply_comment).',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'number', description: 'Only return pins with seq greater than this (exclusive). Pass the prior call\'s next_cursor to get just new/edited pins.' },
      mount: { type: 'string', description: 'Scope to pins anchored in this mount id only.' },
      type: { type: 'string', description: 'The element type to read: \'comment\' (the default) or \'highlight\'.' },
    },
  },
  // The element API's one read, for the comment type (U327a; PLAN 2C.4): the
  // records come back under `elements` and are handed on as `comments`, so the
  // tool's output keeps its shape. next_cursor is the log's max seq (1A.8):
  // it never decreases. `type` (U328a; F3 b, K.2-10) reads another element
  // type through the same route — no per-type tool; with no type, the request
  // and the answer are the comment's, byte for byte.
  async handler({ since, mount, type } = {}) {
    const t = type == null || type === '' ? 'comment' : String(type);
    const qs = new URLSearchParams({ type: t, shared_only: '1' });
    if (since != null) qs.set('since', String(since));
    if (mount) qs.set('mount', String(mount));
    const body = await client.get('/api/elements?' + qs.toString());
    if (t !== 'comment') return { type: t, elements: body.elements, next_cursor: body.next_cursor };
    return { comments: body.elements, next_cursor: body.next_cursor, respond_hint: body.respond_hint };
  },
};
