const { buildExportHtml, writeExport, slugLabel } = require('../export');

// Page export. Two shapes off one assembler:
//   GET /api/export/:ref            → streams the .html as an attachment (the
//                                     browser Download button; no disk write)
//   GET /api/export/:ref?format=file → writes .web-chat/exports/<…>.html and
//                                     returns { path, label } (MCP tool + CLI)
//
// ref is a node label ('n1.7'), a stored id ('n5'), 'active' (default), or
// 'live' (the current uncommitted surface). nodeForExport resolves all four.
function mountExportRoutes(app, ctx) {
  app.get('/api/export/:ref', (req, res) => {
    const ref = req.params.ref;

    if (req.query.format === 'file') {
      const r = writeExport(ctx, ref);
      if (r.error) return res.status(404).json({ error: r.error });
      ctx.bus.emit({ event: { kind: 'export', ref, label: r.label, path: r.path } });
      return res.json({ ok: true, path: r.path, label: r.label });
    }

    const built = buildExportHtml(ctx, ref);
    if (built.error) return res.status(404).json({ error: built.error });
    const filename = `${slugLabel(built.label)}.html`;
    res.type('text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    ctx.bus.emit({ event: { kind: 'export', ref, label: built.label } });
    res.send(built.html);
  });
}

module.exports = { mountExportRoutes };
