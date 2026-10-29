const client = require('../client');

const CHAT = 'chat-comment';

// An older daemon (before tranche 3) has no chat-comment type: its one read
// answers 400 'unknown element type' for it, and the default call then lists
// the comments alone.
const unknownType = (e) => !!(e && e.status === 400 && e.body && e.body.error === 'unknown element type');
const larger = (a, b) => (typeof b === 'number' && !(b <= a) ? b : a);

module.exports = {
  name: 'get_comments',
  description: 'Pull the user\'s comment pins — notes they attached by clicking something and typing. By default it lists BOTH kinds: comments on the page (a point in a rendered pane) and pins on the chat (a turn, a passage of a prompt, reply or thinking block, a tool card, or a line of a turn\'s code diff). Returns ONLY pins the user shared (a per-pin toggle, default on; private pins are withheld). Each pin: `{id, seq, created_at, text, anchor, anchor_label, replies}`. `text` is the ROOT note; `anchor_label` describes what it\'s pinned to (e.g. `plan: "Timeline"` on the page, `on turn 3\'s reply: "…"` or `on tool card Bash` or `on diff line lib/x.js:42` on the chat); `replies` is the thread, `[{author:\'user\'|\'claude\', text, at}]` oldest→newest. A chat pin also has `type: \'chat-comment\'`, an `anchor` of `{kind, conversation_id, turn_id, item_id?, file?, line?, quote}` (`quote.exact` is the pinned words, masked where they hold a value web-chat hides) and where it stands now: `visible` is one of placed, refused, superseded (the turn was rewound in the terminal), masked, indexing (the conversation is still being read) or unavailable (what it was on is gone from this machine), and `explain` is that state\'s one line for the user. When a chat pin is not placed, answer it from its `quote` and `anchor_label`. On a `[comment] reply` wake the ask is the LATEST entry in `replies[]` (the user\'s newest message), NOT `pin.text` — answer that, in-thread, with reply_comment (either kind). Use `since` (a seq cursor; pass the prior `next_cursor`) to fetch only new/updated pins, `mount` to scope to one pane (it lists page comments only: a chat pin has no pane). Returns `{comments, next_cursor, respond_hint}`, comments and chat pins together in seq order — `respond_hint` is ONE top-level field (not per pin) routing you to the respond-to-comment skill. Check this at the start of a turn when the user mentions leaving comments/notes. Pass `type: \'chat-comment\'` to read only the chat pins (the same `{comments, next_cursor, respond_hint}`) or `type: \'comment\'` for only the page\'s. The same read serves every element type: pass `type: \'highlight\'` for the text the user highlighted on the page and shared (a `Highlight sent to Claude` queue item names one) — each `{id, v, anchor, color, note, shared, seq, created_at}`, where `anchor.quote.exact` is the highlighted text and `note` the user\'s note on it (often empty) — returned as `{type, elements, next_cursor}`; only comments and chat pins take replies (reply_comment).',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'number', description: 'Only return pins with seq greater than this (exclusive). Pass the prior call\'s next_cursor to get just new/edited pins.' },
      mount: { type: 'string', description: 'Scope to pins anchored in this mount id only (page comments; a chat pin has no pane).' },
      type: { type: 'string', description: 'The element type to read: omitted, comments on the page and pins on the chat together; \'comment\' for the page\'s only, \'chat-comment\' for the chat\'s only, or \'highlight\'.' },
    },
  },
  // The element API's one read, for the comment type (U327a; PLAN 2C.4): the
  // records come back under `elements` and are handed on as `comments`, so the
  // tool's output keeps its shape. next_cursor is the log's max seq (1A.8):
  // it never decreases. `type` (U328a; F3 b, K.2-10) reads another element
  // type through the same route — no per-type tool.
  //
  // Chat pins (U419; PLAN 3A.1, DECISIONS L1, L4, L5; RULED CHAT@type a): with
  // no type the comment read goes first, unchanged, then the chat type's
  // through the same route (skipped for `mount`: a chat pin has no pane). Each
  // chat record is the route's own — state, visible, explain (anchor-states
  // EXPLAIN, served by the daemon, never copied here), anchor_label, the
  // masked quote — and an unavailable one is listed with its quote. With no
  // chat pin the answer is the comment read's, byte for byte (S-14). A list
  // never waits on a parse: the daemon answers `indexing` instead.
  async handler({ since, mount, type } = {}) {
    const explicit = !(type == null || type === '');
    const t = explicit ? String(type) : 'comment';
    const read = (ty) => {
      const qs = new URLSearchParams({ type: ty, shared_only: '1' });
      if (since != null) qs.set('since', String(since));
      if (mount) qs.set('mount', String(mount));
      return client.get('/api/elements?' + qs.toString());
    };
    const body = await read(t);
    if (t === CHAT) return { comments: body.elements, next_cursor: body.next_cursor, respond_hint: body.respond_hint };
    if (t !== 'comment') return { type: t, elements: body.elements, next_cursor: body.next_cursor };
    let chat = null;
    if (!explicit && !mount) {
      try { chat = await read(CHAT); } catch (e) { if (!unknownType(e)) throw e; }
    }
    const pins = ((chat && chat.elements) || []).filter((e) => e && e.type === CHAT);
    if (!pins.length) {
      return { comments: body.elements, next_cursor: larger(body.next_cursor, chat && chat.next_cursor), respond_hint: body.respond_hint };
    }
    const all = (body.elements || []).concat(pins).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return { comments: all, next_cursor: larger(body.next_cursor, chat.next_cursor), respond_hint: body.respond_hint };
  },
};
