const { buildExportHtml, writeExport, slugLabel, privateLeftOut, OVER_CAP } = require('../export');
const { modeParam } = require('../preview');
const { isBrowserRequest } = require('../../core/cors');
const { readerOf, fileReader } = require('../document-elements');

// Page export. Two shapes off one assembler:
//   GET /api/export/:ref            → streams the .html as an attachment (the
//                                     browser Download button; no disk write)
//   GET /api/export/:ref?format=file → writes .web-chat/exports/<…>.html and
//                                     returns { path, label } (MCP tool + CLI)
//
// ref is a node label ('n1.7'), a stored id ('n5'), 'active' (default), or
// 'live' (the current uncommitted surface). nodeForExport resolves all four.
// `?mode=light|dark` draws it in that mode; without one an export is light —
// the download button never sends one, whatever mode the viewer is in.
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
//
// The elements the file draws (U524; RULED U524-U525@file-documents-private
// a): both shapes read the requester's level (readerOf) and hand the builder
// fileReader(level) — a file is made to be shared, saved or sent, so it never
// carries a private element whoever downloads it. A remote read viewer's
// download carries the shared elements of every type whose `see` it meets,
// with their text; a remote basic viewer's and a network peer's carry none,
// and no runtime. lib/client (the MCP tool, the CLI) is local and never
// seesPrivate: shared elements only. A local browser's download (the one
// requester readerOf says sees private records) is told how many private
// notes it left out — a count the builder writes as one line in #export-head,
// never an element; every other download carries no count and no line.
//
// THE EXPORT CAP (U526; lib/server/export.js EXPORT_ELEMENTS_MAX; RULED
// U526@over-cap-browser-download a): an export whose element payload is over
// the cap is, on format=file (the MCP tool, the CLI), REFUSED by default —
// 413 {error, code: 'export-over-cap', hint, bytes, cap, would_strip}, the
// hint naming `claude-web-chat export <node> --strip`, and nothing written —
// and stripped on strip=1, the reply naming what it left out (`stripped`).
// The download (no format) strips by default: its callers are plain anchors
// (the topbar's and the graph viewer's) that cannot show a refusal, so the
// file names what it left out in #export-head instead. One that does not fit
// even stripped is refused 413 on both shapes. strip=1 only ever narrows what
// a file carries, so a remote download may pass it (remote-policy's
// refuseQuery row for format=file is unchanged).
// capSeam: FOR TESTS ONLY — a cap that narrows EXPORT_ELEMENTS_MAX for the
// routes (null: the constant). Nothing in the product sets it.
const capSeam = { cap: null };
const refusal = (r) => ({ error: r.error, code: r.code, hint: r.hint, bytes: r.bytes, cap: r.cap, would_strip: r.would_strip });

function mountExportRoutes(app, ctx) {
  app.get('/api/export/:ref', (req, res) => {
    const ref = req.params.ref;
    const viewer = readerOf(ctx.audience, req);
    const opts = {
      mode: modeParam(req.query.mode), reader: fileReader(viewer.level),
      ...(capSeam.cap != null ? { cap: capSeam.cap } : {}),
    };

    if (req.query.format === 'file') {
      if (isBrowserRequest(req.headers)) {
        return res.status(403).json({
          error: 'format=file is not available to a browser',
          hint: 'a page export that writes to disk is an MCP/CLI action; the download button uses GET /api/export/:ref with no format.',
        });
      }
      const r = writeExport(ctx, ref, undefined, { ...opts, strip: req.query.strip === '1' });
      if (r.code === OVER_CAP) return res.status(413).json(refusal(r));
      if (r.error) return res.status(404).json({ error: r.error });
      ctx.bus.emit({ event: { kind: 'export', ref, label: r.label, path: r.path } });
      return res.json({ ok: true, path: r.path, label: r.label, ...(r.stripped ? { stripped: r.stripped } : {}) });
    }

    const leftOut = viewer.seesPrivate ? privateLeftOut(ctx, ref, viewer) : 0;
    const built = buildExportHtml(ctx, ref, undefined, { ...opts, privateLeftOut: leftOut, strip: true });
    if (built.code === OVER_CAP) return res.status(413).json(refusal(built));
    if (built.error) return res.status(404).json({ error: built.error });
    const filename = `${slugLabel(built.label)}.html`;
    res.type('text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    ctx.bus.emit({ event: { kind: 'export', ref, label: built.label } });
    res.send(built.html);
  });
}

module.exports = { mountExportRoutes, capSeam };
