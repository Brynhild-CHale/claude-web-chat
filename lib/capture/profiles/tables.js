// Structured profile: extract every <table> into {headers, rows}. Demonstrates
// the "pre-process programmatically so the agent's context isn't crushed"
// principle — a spreadsheet-like grid arrives as rows of cells, not raw DOM.
//
// Auto-selected when the captured HTML contains a table (content-based match);
// also requestable explicitly via the `profile: 'tables'` hint.

const { collapse } = require('./util');

module.exports = {
  name: 'tables',
  description: 'Structured extraction of every <table> into {headers, rows}. Auto-selected when the page contains a table; pre-formats tabular/grid data so it reaches the agent as rows, not raw markup.',
  // match receives (url, html); a content-based test keeps it dependency-light
  // (no parse needed just to decide selection).
  match: (url, html) => /<table[\s>]/i.test(html || ''),
  extract({ url, root }) {
    if (!root) return { kind: 'tables', url, table_count: 0, tables: [], note: 'parse failed' };
    const tables = root.querySelectorAll('table').map((tbl) => {
      const trs = tbl.querySelectorAll('tr');
      const rows = trs.map((tr) => tr.querySelectorAll('th, td').map((c) => collapse(c.text)));
      // Treat a leading row of <th> as the header row.
      const firstTr = trs[0];
      const headers = firstTr && firstTr.querySelector('th')
        ? firstTr.querySelectorAll('th').map((c) => collapse(c.text))
        : [];
      const body = headers.length ? rows.slice(1) : rows;
      return { headers, rows: body, row_count: body.length };
    });
    return { kind: 'tables', url, table_count: tables.length, tables };
  },
};
