const { buildExportHtml, writeExport, slugLabel } = require('../export');
const { isBrowserRequest } = require('../../core/cors');

// Page export. Two shapes off one assembler:
//   GET /api/export/:ref            → streams the .html as an attachment (the
//                                     browser Download button; no disk write)
//   GET /api/export/:ref?format=file → writes .web-chat/exports/<…>.html and
//                                     returns { path, label } (MCP tool + CLI)
//
// ref is a node label ('n1.7'), a stored id ('n5'), 'active' (default), or
// 'live' (the current uncommitted surface). nodeForExport resolves all four.
//
// Only the second shape writes to disk, and it carries the same "no browsers"
// gate POST /api/shutdown does (lib/server/routes/health.js). A GET with a
// durable side effect is triggerable by any page the user happens to be
// browsing — an <img> or a no-cors fetch is enough, since nothing needs to read
// the reply — and each hit assembles the whole export, writes a second-stamped
// file under .web-chat/exports/ and appends to the event ring that get_events
// and the channel bridge read. Both legitimate callers are non-browser and go
// through lib/client (lib/mcp/tools/export.js, lib/cli/commands/export.js), so
// the gate costs them nothing. The attachment shape below is untouched: it
// writes nothing, and its callers ARE browsers (the topbar and graph-view
// download buttons).
function mountExportRoutes(app, ctx) {
  app.get('/api/export/:ref', (req, res) => {
    const ref = req.params.ref;

    if (req.query.format === 'file') {
      if (isBrowserRequest(req.headers)) {
        return res.status(403).json({
          error: 'format=file is not available to a browser',
          hint: 'a page export that writes to disk is an MCP/CLI action; the download button uses GET /api/export/:ref with no format.',
        });
      }
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
