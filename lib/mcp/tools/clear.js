const client = require('../client');

module.exports = {
  name: 'clear',
  description: 'Remove mounts from the page. Pass `id` to remove one specific mount (or one markdown item written by `write_markdown`), `target` to clear a slot, or `{}` to clear everything — a page-wide clear takes markdown items too, while pinned panes stay — and so does the markdown directly above each pinned pane (the run of items between it and the previous pane or the page top), in place. Panes owned by another writer — a local driver (`owner:"service:<name>"` in list_mounts) or the pane that spawned them (`owner:"pane:<id>"`) — are soft-rejected like a render over them, and a bulk clear that would take one is rejected whole (a pinned one it keeps does not count) — clear your own by id instead. force:true clears them anyway, and on a bulk clear it also takes every pinned pane, the user\'s included.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Specific mount id to remove.' },
      target: { type: 'string', description: 'Clear all mounts in this target slot.' },
      force: { type: 'boolean', description: 'Clear panes owned by another writer (a driver, or a parent pane) too. Without it, a clear that would take one is soft-rejected. On a bulk clear it also removes pinned panes.' },
    },
  },
  async handler(args) {
    return await client.post('/api/clear', args);
  },
};
