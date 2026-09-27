const client = require('../client');

// Formats past 'html' go through POST /api/replay/render, which may drive a
// headless Chrome for minutes; the client has no default socket timeout, but
// say how long we are prepared to wait rather than inherit "forever".
const RENDER_TIMEOUT_MS = 6 * 60 * 1000;
const FORMATS = ['html', 'replay', 'gif', 'mp4', 'webm'];

// A failure the route EXPLAINS — a bad ref, no Chrome, no ffmpeg, busy, a cap,
// Chrome or ffmpeg dying mid-render — comes back as a plain {error, code, hint} result Claude can
// relay. Only a failure with no explanation (no JSON body naming a code: the
// daemon is gone, a proxy answered) stays a thrown transport error.
function refusal(e, extra) {
  if (!(e instanceof client.HttpError)) return null;
  const b = (e.body && typeof e.body === 'object') ? e.body : null;
  if (!b || !b.code) return null;
  return { error: b.error || `HTTP ${e.status}`, code: b.code, ...(b.hint ? { hint: b.hint } : {}), ...extra };
}

module.exports = {
  name: 'export',
  description: "Export rendered work to a file the user can attach to a message or email. format 'html' (default) writes ONE page (a graph node) as a self-contained, interactive .html — every pane's HTML/JS, the store snapshot and the resolved theme inlined, opening in any browser with no server and no network; pass `node` as a hierarchical label (e.g. n1.7), a stored id, 'active' (default — where the next turn commits), or 'live' (the current uncommitted surface). format 'replay' writes a REPLAY — the surface played forward node by node down one lineage, `from` an earlier node `to` a later one — as one self-contained .html player; format 'gif' renders that replay to an animated GIF, and 'mp4' / 'webm' to a video (every one needs a Chrome-family browser on the machine, answering {error, code:'chrome-not-found', hint} when there is none; mp4/webm also need ffmpeg, answering code:'ffmpeg-not-found' without it — a GIF uses ffmpeg when present and a built-in encoder otherwise). For a replay, `to` (or `node`) defaults to the active node and `from` to the nearest bookmarked ancestor, else the root; captions show Claude's reply summary and each node's label and time, and leave the user's prompts OUT unless include_prompts is true — pass it only when the user asked for their prompts in the file. Files land under .web-chat/exports/ and the absolute path is returned. Use when the user wants to share, save, or send a page — or show how the work evolved.",
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: FORMATS,
        description: "'html' (default): one page. 'replay': the lineage as a self-contained .html player. 'gif': the lineage as an animated GIF. 'mp4' (H.264) / 'webm' (VP9): the lineage as a video — needs ffmpeg on the machine.",
      },
      node: {
        type: 'string',
        description: "For 'html': which node to export — a hierarchical label ('n1.7'), a stored id, 'active' (default), or 'live'. For a replay format it means the same as `to`.",
      },
      from: { type: 'string', description: 'Replay formats: the node to start from (label or id). Default: the nearest bookmarked ancestor of `to`, else its root.' },
      to: { type: 'string', description: 'Replay formats: the node to arrive at (label or id). Default: the active node.' },
      hold_ms: { type: 'number', description: 'Replay formats: how long each node is held, in ms (500–20000, default 2500).' },
      transition: { type: 'string', enum: ['cut', 'fade'], description: "Replay formats: 'cut' (default) or 'fade' between nodes." },
      captions: { type: 'string', enum: ['on', 'none'], description: "Replay formats: 'on' (default) — a caption per node: its label, time and Claude's reply summary (plus the prompt when include_prompts is true) — or 'none' for no caption bar." },
      include_prompts: { type: 'boolean', description: "Replay formats: true puts the user's own prompts in the captions (they may be private). Default false: no prompt text anywhere in the file." },
      width: { type: 'number', description: "'gif'/'mp4'/'webm': output width in px (320–1920, default 960); the height follows the 16:10 frame." },
      mode: { type: 'string', enum: ['light', 'dark'], description: "Draw the file in this light/dark mode of the theme. Default: light, whatever the user's browser shows — pass 'dark' only when the user asks for a dark copy." },
    },
  },
  async handler(args) {
    const a = args || {};
    const format = a.format || 'html';

    if (format === 'html') {
      const ref = a.node || 'active';
      let r;
      try {
        r = await client.get('/api/export/' + encodeURIComponent(ref) + '?format=file' + (a.mode ? '&mode=' + encodeURIComponent(a.mode) : ''));
      } catch (e) {
        // The route answers an unknown ref with 404 {error}, and client.get turns
        // any >= 400 into a throw — so the `if (r.error)` branch this replaces was
        // unreachable and an unknown label reached Claude as a raw transport error
        // (isError: true). The tool's documented contract is a plain {error, ref}
        // result, so translate the one status that means "the ref is wrong" and
        // let every other failure stay a failure.
        if (e instanceof client.HttpError && e.status === 404) {
          const msg = (e.body && typeof e.body === 'object' && e.body.error) || 'node not found';
          return { error: msg, ref };
        }
        throw e;
      }
      return { ok: true, path: r.path, label: r.label, hint: `Exported ${r.label} → ${r.path}. Attach this .html file to share the page.` };
    }

    if (!FORMATS.includes(format)) return { error: `unknown format '${format}'`, hint: `one of: ${FORMATS.join(', ')}` };
    const body = { format };
    const to = a.to || a.node;
    if (to && to !== 'active') body.to = to;
    for (const k of ['from', 'hold_ms', 'transition', 'captions', 'include_prompts', 'width', 'mode']) if (a[k] != null) body[k] = a[k];
    let r;
    try {
      r = await client.post('/api/replay/render', body, { timeout: RENDER_TIMEOUT_MS });
    } catch (e) {
      const ref = refusal(e, { format });
      if (ref) return ref;
      throw e;
    }
    const what = { gif: 'an animated GIF', mp4: 'an MP4 video', webm: 'a WebM video' }[r.format] || 'a self-contained replay .html';
    return {
      ok: true, format: r.format, path: r.path, label: r.label, frames: r.frames, encoder: r.encoder, bytes: r.bytes,
      include_prompts: !!r.include_prompts,
      hint: `Rendered ${r.label} as ${what} → ${r.path}.${r.include_prompts ? ' Its captions include the user\'s prompts.' : ''} Attach the file to share it.`,
    };
  },
};
