const client = require('../client');

module.exports = {
  name: 'get_comments',
  description: 'Pull the user\'s comment pins from the surface — notes they attached to specific points on the page by clicking an element and typing. Returns ONLY pins the user shared (a per-pin toggle, default on; private pins are withheld). Each pin: `{id, seq, created_at, text, anchor, anchor_label, replies}`. `text` is the ROOT note; `anchor_label` describes what it\'s pinned to (e.g. `plan: "Timeline"`); `replies` is the thread, `[{author:\'user\'|\'claude\', text, at}]` oldest→newest. On a `[comment] reply` wake the ask is the LATEST entry in `replies[]` (the user\'s newest message), NOT `pin.text` — answer that, in-thread, with reply_comment. Use `since` (a seq cursor; pass the prior `next_cursor`) to fetch only new/updated pins, `mount` to scope to one pane. Returns `{comments, next_cursor, respond_hint}` — `respond_hint` is ONE top-level field (not per pin) routing you to the respond-to-comment skill. Check this at the start of a turn when the user mentions leaving comments/notes.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'number', description: 'Only return pins with seq greater than this (exclusive). Pass the prior call\'s next_cursor to get just new/edited pins.' },
      mount: { type: 'string', description: 'Scope to pins anchored in this mount id only.' },
    },
  },
  async handler({ since, mount }) {
    const qs = new URLSearchParams({ shared_only: '1' });
    if (since != null) qs.set('since', String(since));
    if (mount) qs.set('mount', String(mount));
    return await client.get('/api/comments?' + qs.toString());
  },
};
