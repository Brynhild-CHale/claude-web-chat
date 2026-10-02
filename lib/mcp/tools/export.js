const client = require('../client');

// Formats past 'html' go through POST /api/replay/render, which may drive a
// headless Chrome for minutes; the client has no default socket timeout, but
// say how long we are prepared to wait rather than inherit "forever".
const RENDER_TIMEOUT_MS = 6 * 60 * 1000;
const FORMATS = ['html', 'replay', 'gif', 'mp4', 'webm'];

// A failure the route EXPLAINS — a bad ref, no Chrome, no ffmpeg, busy, a cap,
// Chrome or ffmpeg dying mid-render — comes back as a plain {error, code, hint}
// result Claude can relay, plus what points at the fix: a refused script's
// `step` (1-based, as the description promises) and a bad end's `which`
// ('from' | 'to'). Only a failure with no explanation (no JSON body naming a
// code: the daemon is gone, a proxy answered) stays a thrown transport error.
function refusal(e, extra) {
  if (!(e instanceof client.HttpError)) return null;
  const b = (e.body && typeof e.body === 'object') ? e.body : null;
  if (!b || !b.code) return null;
  return {
    error: b.error || `HTTP ${e.status}`, code: b.code,
    ...(b.step != null ? { step: b.step } : {}),
    ...(b.which ? { which: b.which } : {}),
    ...(b.hint ? { hint: b.hint } : {}),
    ...extra,
  };
}

// The script to send: the caller's, with the top-level from / to (or node) /
// include_prompts filling in only what it leaves out. A non-object goes as it
// is — the daemon's validation names what is wrong with it.
function withDefaults(a) {
  const sc = a.script;
  if (sc == null || typeof sc !== 'object' || Array.isArray(sc)) return sc;
  const out = { ...sc };
  const to = a.to || a.node;
  if (out.to == null && to && to !== 'active') out.to = to;
  if (out.from == null && a.from != null) out.from = a.from;
  if (out.include_prompts == null && typeof a.include_prompts === 'boolean') out.include_prompts = a.include_prompts;
  return out;
}

// export({ open: true }): the player in the user's browser, on this replay; no file.
async function openPlayer(a) {
  const body = {};
  if (a.script != null) body.script = withDefaults(a);
  else {
    const to = a.to || a.node;
    if (to && to !== 'active') body.to = to;
    if (a.from != null) body.from = a.from;
    if (typeof a.include_prompts === 'boolean') body.include_prompts = a.include_prompts;
  }
  let r;
  try {
    r = await client.post('/api/replay/open', body);
  } catch (e) {
    const ref = refusal(e, { open: true });
    if (ref) return ref;
    throw e;
  }
  const range = r.from.label === r.to.label ? r.from.label : `${r.from.label} → ${r.to.label}`;
  return {
    ok: true, opened: true, from: r.from.label, to: r.to.label, steps: r.steps, viewers: r.viewers,
    hint: r.viewers === 0
      ? r.hint
      : `Opened the replay ${range} (${r.steps} step${r.steps === 1 ? '' : 's'}) in the user's browser player — nothing was written. Export it with the same script and a format when they are happy with it.`,
  };
}

module.exports = {
  name: 'export',
  description: "Export rendered work to a file the user can attach to a message or email. format 'html' (default) writes ONE page (a graph node) as a self-contained, interactive .html — every pane's HTML/JS, the store snapshot and the resolved theme inlined, opening in any browser with no server and no network; pass `node` as a hierarchical label (e.g. n1.7), a stored id, 'active' (default — where the next turn commits), or 'live' (the current uncommitted surface). format 'replay' writes a REPLAY — the surface played forward node by node down one lineage, `from` an earlier node `to` a later one — as one self-contained .html player; format 'gif' renders that replay to an animated GIF, and 'mp4' / 'webm' to a video (every one needs a Chrome-family browser on the machine, answering {error, code:'chrome-not-found', hint} when there is none; mp4/webm also need ffmpeg, answering code:'ffmpeg-not-found' without it — a GIF uses ffmpeg when present and a built-in encoder otherwise). For a replay, `to` (or `node`) defaults to the active node and `from` to the nearest bookmarked ancestor, else the root; captions show Claude's reply summary and each node's label and time, and leave the user's prompts OUT unless include_prompts is true — pass it only when the user asked for their prompts in the file. Files land under .web-chat/exports/ and the absolute path is returned. Use when the user wants to share, save, or send a page — or show how the work evolved.\n\nREPLAY SCRIPTS — direct the replay instead of playing every node at one pace. Reach for `script` when the user wants a walkthrough, a demo, or a README GIF of how something evolved. How: call get_graph, pick the two moments that bound the story (`from`, `to`), then write `steps` in path order — one step per meaningful moment (`node`), GROUP runs of trivial or in-between nodes into one beat (`nodes: [...]`, consecutive, shown as the group's last node), give the important moments longer holds (`hold_ms`, e.g. 4000–6000; quick beats 1000–1500), and write a SHORT caption per step (a few words: what changed and why it matters — it replaces the automatic reply line). Nodes no step names are not shown. Every node must lie on the from → to lineage, in order, each once; a group must be consecutive. Each frame smooth-scrolls to what its step changed — the newest pane's top to the top of the window, then down to changes below the fold; a step's `scroll` overrides that: 'none' holds still, or name one pane/markdown id on that node's page to look at it instead. Holds clamp to 500–20000 ms. A bad script is refused with {error, code, step} naming the step — fix it and call again. Without `steps` a script plays every drawn node at `default_hold_ms`. `open: true` shows the replay in the user's browser player (play/pause/scrub, their own ↧ GIF) WITHOUT writing a file — use it to let the user watch before you export; it needs a browser on the surface (`viewers: 0` means nobody saw it). With `script` and no `format`, the file is a 'replay' .html; pass format 'gif' / 'mp4' / 'webm' for a GIF or video of the same script.",
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
      width: { type: 'number', description: "'gif'/'mp4'/'webm': output width in px (320–1920, default 960); the height follows `size` (16:10 by default), and a frame over 1920×1200 px in area shrinks to fit, keeping its shape." },
      fps: { type: 'number', description: "'gif'/'mp4'/'webm': frames per second for motion — a fade, and the scroll to each change — and a video's frame rate (1–30, default 10). Left out, a replay too long for the 1000-frame cap is drawn at the highest fps that fits; a named fps is kept, and a replay over the cap at it is refused." },
      size: { type: 'string', description: "Replay formats: the page size each frame is laid out at, 'WxH' in CSS px (default '1280x800'; width 320–3840, height 240–2160). It also gives a GIF or video its shape; a width of 900 or less lays the page out as a narrow screen does." },
      mode: { type: 'string', enum: ['light', 'dark'], description: "Draw the file in this light/dark mode of the theme. Default: light, whatever the user's browser shows — pass 'dark' only when the user asks for a dark copy." },
      script: {
        type: 'object',
        description: 'A replay SCRIPT (see above): the two moments and, optionally, timed and captioned beats between them. Replaces `from`/`to` (a top-level from/to/include_prompts fills in what the script leaves out).',
        properties: {
          from: { type: 'string', description: 'The first moment: a node label or id, an ancestor of `to`. Default: the nearest bookmarked ancestor, else the root.' },
          to: { type: 'string', description: 'The last moment: a node label or id. Default: the active node.' },
          title: { type: 'string', description: 'A title shown over the captions and naming the document (≤120 chars).' },
          default_hold_ms: { type: 'number', description: 'Hold for steps that set none (500–20000; default 2500).' },
          include_prompts: { type: 'boolean', description: "Put the user's own prompts in the captions. Default false." },
          steps: {
            type: 'array',
            description: 'The beats, in path order. Omit to play every node on the path at the default hold.',
            items: {
              type: 'object',
              properties: {
                node: { type: 'string', description: 'One node (label or id) — this beat shows it.' },
                nodes: { type: 'array', items: { type: 'string' }, description: 'A group of CONSECUTIVE nodes played as one beat: shows the last, the caption lists them all.' },
                hold_ms: { type: 'number', description: 'How long this beat is held (500–20000 ms).' },
                caption: { type: 'string', description: 'A short caption for this beat (≤280 chars).' },
                transition: { type: 'string', enum: ['cut', 'fade'], description: 'How this beat comes in.' },
                scroll: { type: 'string', description: "Where the frame looks during this beat: 'auto' (default — scroll to what the node added, then what it changed), 'none' (hold still), or the id of one pane or markdown item on the node's page." },
              },
            },
          },
        },
      },
      open: { type: 'boolean', description: "true: open the replay (the `script`, or from/to) in the user's browser player instead of writing a file — nothing is written and `format` is ignored." },
    },
  },
  async handler(args) {
    const a = args || {};
    const scripted = a.script != null;
    const format = a.format || (scripted ? 'replay' : 'html');

    if (a.open) return openPlayer(a);
    if (format === 'html' && scripted) {
      return { error: "a replay script plays a lineage, but format 'html' exports one page", code: 'bad-format', hint: "leave format out (a .html replay player), or pass 'replay', 'gif', 'mp4' or 'webm'" };
    }

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
    if (scripted) body.script = withDefaults(a);
    else {
      const to = a.to || a.node;
      if (to && to !== 'active') body.to = to;
      if (a.from != null) body.from = a.from;
    }
    for (const k of ['hold_ms', 'transition', 'captions', 'include_prompts', 'width', 'fps', 'size', 'mode']) if (a[k] != null) body[k] = a[k];
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
      // The fps the frames were sampled at: a long replay is fitted to the
      // frame cap by lowering it (lib/server/replay/render fitSchedule).
      ...(r.fps != null ? { fps: r.fps } : {}),
      include_prompts: !!r.include_prompts,
      hint: `Rendered ${r.label} as ${what} → ${r.path}.${r.include_prompts ? ' Its captions include the user\'s prompts.' : ''} Attach the file to share it.`,
    };
  },
};
