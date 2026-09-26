const client = require('../client');

module.exports = {
  name: 'list_mounts',
  description: 'List currently rendered mounts on the page. Returns `{mounts: [{id, target, component?, pane_state?, place, form_state?, owner?}], markdown: [{id, owner, chars, headings}], order, runs}` — panes in page order, the markdown items `write_markdown` put between them (summarised by their headings, not echoed), and `order`, the full page sequence of pane and markdown ids (use an id from it as `after` to position a new item). `place` is each pane\'s current `{col, span, rows}` on the 12-column grid (as the user may have left it — pass `place` on render to propose a new one); `runs` holds non-default per-run flags keyed by the markdown id that anchors the run (or `start`) — `{stacks:false}` means that run keeps its fixed grid on a narrow screen. Pane metadata plus the user\'s current typed form values, no HTML payload. `form_state` is the auto-captured per-pane form snapshot — keys are `#<id>:<n>` (element id), `@<name>:<n>` (element name), or positional `:<n>`; hidden/file/password inputs and `contenteditable="false"` are never captured — read it to see what the user has typed into a pane even if they never hit a submit affordance (it survives refresh, navigation, and re-renders). Use to check what is already visible before rendering, or to find a mount to clear/replace. `owner` identifies who last rendered the pane: `null`/`"claude"` is yours; `"service:<name>"` means a local driver process owns it — re-rendering over it is rejected unless you intend to take it over.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/mounts');
  },
};
