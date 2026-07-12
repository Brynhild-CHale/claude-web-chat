// Default capture profile: readability-style fallback. Used whenever no more
// specific profile matches. Strips non-content nodes and returns the page title
// plus collapsed visible text — small enough to sit in the agent's context.

const { collapse } = require('./util');

// Elements that never carry user-visible content; removed before text extraction
// so script bodies / CSS don't pollute the distillation.
const STRIP = 'script, style, noscript, template, svg, link, meta';

const TEXT_CAP = 20000;

module.exports = {
  name: 'default',
  description: 'Readability-style fallback — page title + collapsed visible text. Selected when no other profile matches.',
  // Reader-lite pane: routes/capture.js renders the simplified-site
  // document (simplify.js) into the pane so a no-profile capture pins as a
  // readable page, while this small text distillate is what get_captures returns.
  simplified_pane: true,
  // Always matches; ordered last in the registry so it's the catch-all.
  match: () => true,
  extract({ url, root }) {
    if (!root) {
      return { kind: 'page-text', url, title: '', text: '', text_chars: 0, note: 'parse failed' };
    }
    const titleEl = root.querySelector('title');
    const h1 = root.querySelector('h1');
    const title = collapse(titleEl?.text || h1?.text || '');
    // Remove non-content nodes before text extraction. extract runs once per
    // capture so mutating the parsed root here is fine.
    root.querySelectorAll(STRIP).forEach((e) => e.remove());
    if (titleEl) titleEl.remove(); // captured above; don't let it bleed into body text
    const full = collapse(root.text);
    return {
      kind: 'page-text',
      url,
      title,
      text: full.slice(0, TEXT_CAP),
      text_chars: full.length,
      truncated: full.length > TEXT_CAP,
    };
  },
};
