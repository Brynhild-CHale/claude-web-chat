const fs = require('fs');
const path = require('path');
const { PREVIEW_CSP, isRemoteRequest, isBrowserRequest } = require('../../core/cors');
const { classify } = require('../../core/remote-policy');
const { escapeHtml } = require('../../core/html');
const { isInside, projectPaths } = require('../../core/paths');
const { resolveReplayPath, normalizeReplayScript } = require('../domain/replay-path');
const { buildReplay, one, flag } = require('../replay/document');
const { createScriptStore } = require('../replay/scripts');
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
//          `script=<id>` in place of from/to plays a replay SCRIPT this daemon
//          holds (lib/server/replay/scripts: put there by a scripted render or
//          by POST /api/replay/open); an id it no longer holds is a 404.
//   GET /api/replay/html?…same
//        → the same document as an attachment, replay-<from>_<to>.html. The
//          overlay's download link sends no mode, so the file is light.
//
//   POST /api/replay/open  {script} | {from, to}   (JSON; MCP/CLI only)
//        → { ok, script_id, from, to, steps, title, viewers }
//          Opens the player overlay in every browser watching this surface on
//          that replay — a `replay:open` WS frame carrying the script's id — and
//          writes NOTHING. It is refused (403 local-only) to a browser and to a
//          request through the tunnel portal: it is how Claude, on this machine,
//          shows the user a replay, not something a pane or a remote page may
//          pop over the surface.
//
// The document runs every step's pane scripts, same-origin, exactly like the
// graph viewer's /preview/node documents — so it is served under the same
// PREVIEW_CSP (connect-src 'none'; its srcdoc frames inherit it), on every
// branch including the errors.
//
//   POST /api/replay/render  {from,to|script,format,width,hold_ms,pacing,transition,captions,include_prompts,fps,size,mode}
//        → { ok, path, label, from, to, format, frames, encoder, bytes, … }
//          writes .web-chat/exports/replay-<from>_<to>-<stamp>.<gif|mp4|webm|html>
//   GET  /api/replay/capabilities[?refresh=1] → { ok, chrome, ffmpeg, formats, gif_encoder }
//        Through the tunnel portal it answers { …, remote:true, hint } with
//        every rendered format false: the portal refuses the render route to a
//        remote viewer (lib/core/remote-policy), so the player's ↧ GIF / MP4 /
//        WebM are disabled up front, titled with the table's own hint, instead
//        of failing after the click.
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
// render tears its browser down (lib/replay/chrome close), or kills its ffmpeg
// when it is already encoding (lib/replay/encode), instead of holding the
// shutdown's inflight drain — and a Chrome or an encoder — for up to the
// render's five-minute ceiling. Either way the render answers 503 aborted.
function mountReplayRoutes(app, { graph, paths, root, bus, getViewers }) {
  // A daemon killed mid-render never removed its Chrome profile or frame dir;
  // this one sweeps them at boot (and replay/render again before each render).
  sweepStaleTmp(projectPaths(root || paths.root).tmp);
  let rendering = false;
  let inFlight = null; // the running render's AbortController
  let caps = null;
  const scripts = createScriptStore();

  // The script a document request names, when it names one: { script } to
  // build from, { missing } when this daemon does not hold it, {} for none.
  const scriptFor = (q) => {
    const id = one((q || {}).script);
    if (!id) return {};
    const script = scripts.get(String(id));
    return script ? { script } : { missing: true };
  };
  const SCRIPT_GONE = 'this replay script is no longer held — the daemon restarted, or it aged out; ask Claude to open the replay again';
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
    const sc = scriptFor(req.query);
    const r = sc.missing
      ? { ok: false, status: 404, error: SCRIPT_GONE }
      : buildReplay({ graph, paths }, req.query || {}, { script: sc.script });
    if (!r.ok) {
      return res.status(r.status).type('text/html')
        .send(`<!doctype html><meta charset="utf-8"><title>replay</title><p>${escapeHtml(r.error)}</p>`);
    }
    res.type('text/html').send(r.html);
  });

  app.get('/api/replay/html', (req, res) => {
    const sc = scriptFor(req.query);
    if (sc.missing) return res.status(404).json({ error: SCRIPT_GONE, code: 'script-not-found' });
    const r = buildReplay({ graph, paths }, req.query || {}, { script: sc.script });
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
    if (!isRemoteRequest(req)) return res.json(caps);
    // A remote viewer learns WHETHER a browser and ffmpeg are here, never where
    // they are installed — and that it can render none of them: the portal
    // refuses POST /api/replay/render to it, so every rendered format is false,
    // with the refusal's own hint (the one remote-policy table, not a copy).
    res.json({
      ...caps,
      chrome: !!caps.chrome,
      ffmpeg: !!caps.ffmpeg,
      formats: { replay: true, gif: false, mp4: false, webm: false },
      remote: true,
      hint: classify('POST', '/api/replay/render').hint,
    });
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
      const r = await renderReplay({ graph, paths, root }, req.body || {}, { port: req.socket.localPort, signal: ac.signal, scripts });
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

  app.post('/api/replay/open', (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'send the open request as JSON', code: 'json-only' });
    }
    if (isBrowserRequest(req.headers) || isRemoteRequest(req)) {
      return res.status(403).json({
        error: 'opening the replay player is a local MCP/CLI action',
        code: 'local-only',
        hint: 'Claude opens it with export({ open: true }); `claude-web-chat export --open` does from a terminal. In the browser, R opens the player.',
      });
    }
    const b = req.body || {};
    let script = b.script;
    if (script == null) {
      script = {};
      if (b.from) script.from = b.from;
      if (b.to) script.to = b.to;
    }
    if (b.include_prompts != null && script && typeof script === 'object' && script.include_prompts == null) {
      script = { ...script, include_prompts: flag(b.include_prompts, false) };
    }
    const r = normalizeReplayScript(graph, script, { includeCollapsed: flag(one(b.include_collapsed), false) });
    if (!r.ok) {
      const status = (r.code === 'not-found' || r.code === 'no-active') ? 404 : 400;
      return res.status(status).json({ error: r.error, code: r.code, ...(r.which ? { which: r.which } : {}), ...(r.step ? { step: r.step } : {}) });
    }
    const id = scripts.put(r.script);
    const info = { script_id: id, from: r.from, to: r.to, steps: r.steps.length, title: r.title };
    bus.emit({
      event: { kind: 'replay', op: 'open', from: r.from.label, to: r.to.label, steps: r.steps.length, scripted: r.scripted },
      ws: { type: 'replay:open', ...info, script: r.script },
    });
    const viewers = typeof getViewers === 'function' ? getViewers() : null;
    res.json({
      ok: true, ...info, viewers,
      ...(viewers === 0 ? { hint: 'no browser is watching this surface, so nobody saw it open — run `claude-web-chat open`, then open it again' } : {}),
    });
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
