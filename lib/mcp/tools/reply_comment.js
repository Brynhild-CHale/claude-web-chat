const client = require('../client');

module.exports = {
  name: 'reply_comment',
  description: 'Reply to a user\'s comment pin — post a short response into its thread, Google-Docs style. It answers either kind get_comments lists: a comment on the page or a pin on the chat (a turn, a passage, a tool card, a diff line; `type: \'chat-comment\'`, a `k…` id). The user sees your message under their note, the pin\'s marker turns green ("Claude answered"), and they can reply back to continue the thread. Read the pin first with get_comments (it carries the anchor, its `anchor_label` and any prior `replies`; a chat pin that is not placed is answered from its `quote`); keep the reply short and specific — a margin comment, not an essay. Ask a follow-up only if you\'re genuinely blocked. Args: {id, text}. Returns the updated pin.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The pin id from get_comments: a page comment (e.g. "c3") or a chat pin (e.g. "k7").' },
      text: { type: 'string', description: 'Your reply. Short and specific — a doc comment, not an essay.' },
    },
    required: ['id', 'text'],
  },
  // The element API's reply (U327a): the updated comment comes back as the
  // write's `element`, handed on as `pin`, the tool's own key. A chat pin
  // (U419) takes the same route, which hands it to the log's replyElement.
  async handler({ id, text }) {
    const body = await client.post('/api/elements/' + encodeURIComponent(String(id)) + '/reply', { text, author: 'claude' });
    return { ok: body.ok, pin: body.element };
  },
};
