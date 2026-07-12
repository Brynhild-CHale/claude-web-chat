// HTML entity escaping — one copy for the graph preview and the capture routes.
// Uses the null-safe coercion (the strict superset of the two prior copies):
// null/undefined render as '' rather than the literal 'null'.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
