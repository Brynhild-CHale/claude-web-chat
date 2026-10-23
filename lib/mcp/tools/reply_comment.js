const client = require('../client');

module.exports = {
  name: 'reply_comment',
  description: 'Reply to a user\'s comment pin — post a short response into its thread, Google-Docs style. The user sees your message under their note, the pin\'s marker turns green ("Claude answered"), and they can reply back to continue the thread. Read the pin first with get_comments (it carries the anchor and any prior `replies`); keep the reply short and specific — a margin comment, not an essay. Ask a follow-up only if you\'re genuinely blocked. Args: {id, text}. Returns the updated pin.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The comment pin id (from get_comments, e.g. "c3").' },
      text: { type: 'string', description: 'Your reply. Short and specific — a doc comment, not an essay.' },
    },
    required: ['id', 'text'],
  },
  // The element API's reply (U327a): the updated comment comes back as the
  // write's `element`, handed on as `pin`, the tool's own key.
  async handler({ id, text }) {
    const body = await client.post('/api/elements/' + encodeURIComponent(String(id)) + '/reply', { text, author: 'claude' });
    return { ok: body.ok, pin: body.element };
  },
};
