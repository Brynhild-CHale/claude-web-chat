const client = require('../client');

module.exports = {
  name: 'list_mounts',
  description: 'List currently rendered mounts on the page. Returns `{mounts: [{id, target, component?, pane_state?, owner?}]}` — metadata only, no HTML payload. Use to check what is already visible before rendering, or to find a mount to clear/replace. `owner` identifies who last rendered the pane: `null`/`"claude"` is yours; `"service:<name>"` means a local driver process owns it — re-rendering over it is rejected unless you intend to take it over.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/mounts');
  },
};
