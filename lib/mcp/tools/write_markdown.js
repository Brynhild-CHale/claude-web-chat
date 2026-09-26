const client = require('../client');

module.exports = {
  name: 'write_markdown',
  description: 'Write a chunk of MARKDOWN prose onto the page, between or around panes. The page is one ordered sequence of markdown items and panes: consecutive panes form a grid run, and markdown sits between runs — so use this for the headings and short connective prose that organise a page ("## Options", one sentence of framing, a caption under a chart), and `render` for anything interactive or visual. `#`/`##` HEADINGS BUILD THE PAGE\'S CONTENTS NAV (`###` is a sub-heading with no row) and the first `#` is the page\'s title — a page with several sections should open each with a `#` or `##` heading. Replace-by-id like render: reuse `id` to rewrite an item in place (it keeps its position); omit it and the server assigns `md-<n>` (returned as `id`). `after` positions the item: the id of any pane or markdown item already on the page, or "start"; omitted, a new item goes at the end. An unknown `after` still writes (appended) and returns a `warning`. `render`/`use_component` take the same `after`, so you can build a page top to bottom: heading → panes → heading → panes. Subset: paragraphs, `#`–`###` headings, **strong**, *em*, `code`, fenced code blocks, `-` and `1.` lists, [links](https://…) (http/https/mailto/relative only). Everything is ESCAPED — raw HTML shows as literal text, never markup; put markup in a pane. Keep prose short: the text is capped (a longer write is refused with `too_large`), and the chat is where reasoning belongs. A markdown item is part of the surface like a pane: the write folds into this turn\'s node, `clear` removes one by id (and a page-wide `clear {}` takes them all), and `list_mounts` lists them with their headings. Panes and markdown share one id space — an id a pane already holds is refused with `conflict`, and "start" (the page-top anchor) is never an id.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The markdown. `#`/`##` headings become entries in the page\'s Contents nav (`###` is a sub-heading with no row); the first `#` is the page title.' },
      id: { type: 'string', description: 'Stable item id — reuse to replace in place. Omitted: the server assigns md-<n>. Must not be a pane\'s id or a reserved shell element id.' },
      after: { type: 'string', description: 'Place the item right after this pane/markdown id, or "start" for the top. Omitted: a new item appends; a replaced item keeps its position.' },
      force: { type: 'boolean', description: 'Replace an item another writer (owner:"service:<name>") owns. Without it, that write soft-rejects with {ok:false, owned:true, owner}.' },
    },
    required: ['text'],
  },
  async handler(args) {
    const { text, id, after, force } = args || {};
    return await client.post('/api/markdown', { text, id, after, force });
  },
};
