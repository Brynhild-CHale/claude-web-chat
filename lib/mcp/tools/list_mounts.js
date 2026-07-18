const client = require('../client');

module.exports = {
  name: 'list_mounts',
  description: 'List currently rendered mounts on the page. Returns `{mounts: [{id, target, component?, pane_state?, form_state?, owner?}]}` — metadata plus the user\'s current typed form values, no HTML payload. `form_state` is the auto-captured per-pane form snapshot — keys are `#<id>:<n>` (element id), `@<name>:<n>` (element name), or positional `:<n>`; hidden/file/password inputs and `contenteditable="false"` are never captured — read it to see what the user has typed into a pane even if they never hit a submit affordance (it survives refresh, navigation, and re-renders). Use to check what is already visible before rendering, or to find a mount to clear/replace. `owner` identifies who last rendered the pane: `null`/`"claude"` is yours; `"service:<name>"` means a local driver process owns it — re-rendering over it is rejected unless you intend to take it over.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/mounts');
  },
};
