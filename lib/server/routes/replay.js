const fs = require('fs');
const path = require('path');
const { PREVIEW_CSP, isRemoteRequest } = require('../../core/cors');
const { escapeHtml } = require('../../core/html');
const { isInside, projectPaths } = require('../../core/paths');
const { resolveReplayPath } = require('../domain/replay-path');
const { buildReplay, one, flag } = require('../replay/document');
const { renderReplay } = require('../replay/render');
const { findChrome, findFfmpeg } = require('../../replay/find');
const { pickEncoder } = require('../../replay/encode');
const { sweepStaleTmp } = require('../../replay/tmp');

// The files GET /api/replay/file/:name will hand back: what the render route
// writes, and nothing else under .web-chat/exports/ (a page export is fetched
// through its own route; everything else there is not this route's to serve).
const RENDERED_FILE_RE = /^replay-[A-Za-z0-9_.-]+\.(gif|mp4|webm|html)$/;
const FILE_TYPES = { gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', html: 'text/html; charset=utf-8' };

// Replay. A replay plays one lineage of the graph, node by node, as the graph
// viewer draws it (domain/replay-path is the whole decision of WHICH nodes and
// what each one's caption says; this file is HTTP translation only).
//
//   GET /api/replay/path?from=&to=&include_collapsed=1
//        → { ok, from, to, from_default, steps[], skipped, truncated, total_steps }
//
// `from`/`to` take any node ref domain/refs resolves — a label (n1.7), a stored
// id, or `active` — except `live`: a replay is committed history. Both are
// optional: `to` defaults to the active node, `from` to the nearest bookmark at
// or above it (else the tree's root). Read-only, no side effects.
//
//   GET /replay?from=&to=&hold_ms=&pacing=&transition=&captions=&include_prompts=&size=&chrome=&mode=
//        → the replay DOCUMENT (lib/server/replay/document.js): what the player
//          overlay iframes, and what a headless renderer seeks through. `mode`
//          (light|dark) is the viewer's — the overlay passes it; absent, light.
//   GET /api/replay/html?…same
//        → the same document as an attachment, replay-<from>_<to>.html. The
//          overlay's download link sends no mode, so the file is light.
//
// The document runs every step's pane scripts, same-origin, exactly like the
// graph viewer's /preview/node documents — so it is served under the same
// PREVIEW_CSP (connect-src 'none'; its srcdoc frames inherit it), on every
// branch including the errors.
//
//   POST /api/replay/render  {from,to,format,width,hold_ms,pacing,transition,captions,include_prompts,fps,size,mode}
//        → { ok, path, label, from, to, format, frames, encoder, bytes, … }
//          writes .web-chat/exports/replay-<from>_<to>-<stamp>.<gif|mp4|webm|html>
//   GET  /api/replay/capabilities[?refresh=1] → { ok, chrome, ffmpeg, formats, gif_encoder }
//   GET  /api/replay/file/:name → a file the render route wrote, as a download
//
// ── The render route's risk, stated plainly ────────────────────────────────
//
// POST /api/replay/render starts a PROCESS on the user's machine — their own
// Chrome, headless, on a throwaway profile — and writes a file. Like
// POST /api/packs/install (see the head of routes/packs.js) it is reachable by
// any pane: pane scripts run in the surface's window with `fetch`, and a pane's
// request is byte-identical to the player overlay's. That is accepted, because
// what a pane can make it do is bounded to what the overlay can:
//
//   * It launches nothing but the browser lib/replay/find chose, with fixed
//     flags, pointed at this daemon's own /replay document over loopback — and,
//     for the encode, the ffmpeg lib/replay/find chose, with an argv built by
//     lib/replay/encode from its own paths and clamped numbers. No argument,
//     path or URL in the body reaches either command line.
//   * It writes only under .web-chat/exports/, a name built from the resolved
//     node labels (slugged) and a timestamp — never a caller-supplied path.
//   * It is single-flight (a second render while one runs is 409 `busy`) and
//     capped in frames, width, output bytes and wall-clock time (render.js
//     LIMITS), so a loop of requests queues nothing and exhausts nothing.
//   * It accepts only a JSON body (415 otherwise). A cross-origin page can send
//     a "simple" POST — form-encoded or text/plain — without a preflight;
//     application/json forces one, and no OPTIONS handler answers it, so a site
//     the user is browsing cannot start a render at all.
//
// GET /api/replay/file/:name serves only names the render route writes
// (RENDERED_FILE_RE), resolved inside .web-chat/exports/ and refused if the
// resolved file is not there (a symlink pointing out is refused too).
//
// Returns { abortRender() }: the daemon's shutdown calls it so an in-flight
// render tears its browser down (lib/replay/chrome close) instead of holding
// the shutdown's inflight drain — and a Chrome — for up to the render's
// five-minute ceiling.
function mountReplayRoutes(app, { graph, paths, root, bus }) {
  // A daemon killed mid-render never removed its Chrome profile or frame dir;
  // this one sweeps them at boot (and replay/render again before each render).
  sweepStaleTmp(projectPaths(root || paths.root).tmp);
  let rendering = false;
  let inFlight = null; // the running render's AbortController
  let caps = null;
  app.get('/api/replay/path', (req, res) => {
    const q = req.query || {};
    const r = resolveReplayPath(graph, {
      from: one(q.from) || undefined,
      to: one(q.to) || undefined,
      includeCollapsed: flag(one(q.include_collapsed), false),
    });
    if (!r.ok) {
      const status = (r.code === 'not-found' || r.code === 'no-active') ? 404 : 400;
      return res.status(status).json({ error: r.error, code: r.code, which: r.which });
    }
    res.json(r);
  });

  app.get('/replay', (req, res) => {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Cache-Control', 'no-store');
    const r = buildReplay({ graph, paths }, req.query || {});
    if (!r.ok) {
      return res.status(r.status).type('text/html')
        .send(`<!doctype html><meta charset="utf-8"><title>replay</title><p>${escapeHtml(r.error)}</p>`);
    }
    res.type('text/html').send(r.html);
  });

  app.get('/api/replay/html', (req, res) => {
    const r = buildReplay({ graph, paths }, req.query || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code, which: r.which });
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.type('text/html').send(r.html);
  });

  app.get('/api/replay/capabilities', (req, res) => {
    if (!caps || ['1', 'true'].includes(String(req.query.refresh || ''))) {
      const chrome = findChrome();
      const ffmpeg = findFfmpeg();
      caps = {
        ok: true,
        chrome,
        ffmpeg,
        // What POST /api/replay/render can produce on this machine right now:
        // every image format needs the browser; mp4/webm need ffmpeg as well.
        formats: { replay: true, gif: !!chrome, mp4: !!(chrome && ffmpeg), webm: !!(chrome && ffmpeg) },
        // Which encoder a GIF would get (lib/replay/encode.pickEncoder).
        gif_encoder: chrome ? pickEncoder('gif', ffmpeg) : null,
      };
    }
    // A remote viewer learns WHETHER a browser and ffmpeg are here (all the
    // replay menu needs), never where they are installed.
    res.json(isRemoteRequest(req) ? { ...caps, chrome: !!caps.chrome, ffmpeg: !!caps.ffmpeg } : caps);
  });

  app.post('/api/replay/render', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'send the render request as JSON', code: 'json-only' });
    }
    if (rendering) {
      return res.status(409).json({ error: 'a replay render is already running', code: 'busy', hint: 'wait for it to finish, then try again' });
    }
    rendering = true;
    const ac = new AbortController();
    inFlight = ac;
    try {
      const r = await renderReplay({ graph, paths, root }, req.body || {}, { port: req.socket.localPort, signal: ac.signal });
      if (!r.ok) {
        const { status, ...rest } = r;
        return res.status(status || 500).json(rest);
      }
      bus.emit({ event: { kind: 'export', format: r.format, label: r.label, path: r.path } });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || String(e), code: 'render-failed' });
    } finally {
      rendering = false;
      if (inFlight === ac) inFlight = null;
    }
  });

  app.get('/api/replay/file/:name', (req, res) => {
    const name = String(req.params.name || '');
    const m = RENDERED_FILE_RE.exec(name);
    if (!m || name.includes('..')) return res.status(400).json({ error: 'not a rendered replay file name', code: 'bad-name' });
    const dir = paths.EXPORTS_DIR;
    const file = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(file); } catch { /* absent */ }
    if (!st || !st.isFile() || !isInside(dir, file)) return res.status(404).json({ error: `no such file: ${name}`, code: 'not-found' });
    if (m[1] === 'html') res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Content-Type', FILE_TYPES[m[1]]);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });

  return {
    abortRender() { if (inFlight) inFlight.abort(); },
  };
}

module.exports = { mountReplayRoutes };
