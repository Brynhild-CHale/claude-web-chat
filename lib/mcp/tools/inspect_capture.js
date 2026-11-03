const client = require('../client');
const { isTypedId, typeOfId } = require('../../core/element-log');

// A capture made from an element names it in its url, `element:<id>`: a box
// grab's (U328b; its picture is that element's, GET /api/elements/:id/grab)
// and a stroke group's picture's (U564; url the group's newest member, GET
// /api/elements/:id/picture). The id is read by the element log's own id test
// (lib/core/element-log isTypedId: any type's letter, a plug-in type's `p`
// included), never a second grammar; the pattern only takes the prefix off.
const GRAB_URL_RE = /^element:(.+)$/;
const elementOfUrl = (url) => {
  const m = typeof url === 'string' ? GRAB_URL_RE.exec(url) : null;
  return m && isTypedId(m[1]) ? m[1] : null;
};
const BOX_GRAB = 'box-grab';

// How many px short of the chrome's measured scroll the render's was (K.2-85):
// requested top − applied top, or left when only left differs; null when the
// image records no clamp.
function clampedBy(grab) {
  const c = grab && grab.image && grab.image.scroll_clamped;
  const asked = grab && grab.scroll;
  if (!c || !asked || typeof c !== 'object' || typeof asked !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const dTop = n(asked.top) - n(c.top);
  const d = Math.abs(dTop) > 1 ? dTop : n(asked.left) - n(c.left);
  return Math.abs(d) > 1 ? Math.round(d * 100) / 100 : null;
}

module.exports = {
  name: 'inspect_capture',
  description: "Drill into a capture's RAW DOM — the on-demand tier of tab-stream storage. get_captures gives you the distilled summary; reach for this only when you need detail the profile dropped. Scope your read so you don't pull the whole page back into context: pass `selector` (CSS selector → matching elements), `query` (text → surrounding context windows), or `profile` (re-run a named profile, e.g. 'tables', over the raw). With no scope it returns the raw DOM (capped) — prefer scoping. A box grab's capture (kind 'box-grab', from get_captures) returns its clipped outerHTML here, with the picture the user saw attached as an image beside it.",
  inputSchema: {
    type: 'object',
    properties: {
      capture_id: {
        type: 'string',
        description: "The capture id (e.g. 'cap3'), from get_captures or the tab_capture store key.",
      },
      selector: { type: 'string', description: 'CSS selector; returns matching elements (tag, text, html), capped.' },
      query: { type: 'string', description: 'Text to find; returns occurrences with surrounding context windows.' },
      profile: { type: 'string', description: "Re-run a named profile over the raw DOM (e.g. tables). The re-run gets the capture's own URL, so url-derived fields resolve exactly as they did at ingest." },
      max: { type: 'number', description: 'Max matches/snippets to return (default 20).' },
      context: { type: 'number', description: 'Chars of context around each query hit (default 200).' },
    },
    required: ['capture_id'],
  },
  async handler({ capture_id, selector, query, profile, max, context } = {}) {
    if (!capture_id) throw new Error('capture_id is required');
    // capture_id 'element:<id>' (U564; RULED U563-U580@catalogue-tool-edits
    // (a): the form rides the same words): the stroke group's picture is drawn
    // first — or the one that already shows its versions answered — then read
    // as its capture. A refusal (a private or unknown id, not a stroke) is the
    // daemon's answer, thrown as the client throws it.
    let captureId = capture_id;
    const asked = elementOfUrl(capture_id);
    if (asked) {
      const made = await client.post(`/api/elements/${encodeURIComponent(asked)}/picture`, {});
      if (!made || typeof made.capture !== 'string') return made;
      captureId = made.capture;
    }
    const params = [];
    if (selector) params.push(`selector=${encodeURIComponent(selector)}`);
    if (query) params.push(`query=${encodeURIComponent(query)}`);
    if (profile) params.push(`profile=${encodeURIComponent(profile)}`);
    if (max != null) params.push(`max=${encodeURIComponent(max)}`);
    if (context != null) params.push(`context=${encodeURIComponent(context)}`);
    const q = params.length ? `?${params.join('&')}` : '';
    const raw = await client.get(`/api/captures/${encodeURIComponent(captureId)}/raw${q}`);
    // A box grab or a stroke group's picture: the same PNG the user saw, as an
    // MCP image block beside the raw (one call, F4 (a)); the image's state
    // (chrome-not-found with its hint, failed, pending) and, for a picture,
    // the strokes' description when it has none.
    const el = raw ? elementOfUrl(raw.url) : null;
    if (!el) return raw;
    const own = typeof raw.id === 'string' ? raw.id : captureId;
    const isGrab = typeOfId(el) === BOX_GRAB;
    const route = isGrab
      ? `/api/elements/${encodeURIComponent(el)}/grab?as=json`
      : `/api/elements/${encodeURIComponent(el)}/picture?as=json&capture=${encodeURIComponent(own)}`;
    let grab = null;
    try { grab = await client.get(route); } catch { grab = null; }
    // The url is the capture's own (POST /api/capture takes it as given), so
    // it proves nothing: the picture belongs here only when the grab or the
    // picture names THIS capture as its own (K.2-63).
    if (!grab || grab.capture !== own) return raw;
    const about = isGrab ? { element: el, image: grab.image } : {
      element: el, type: grab.type, elements: grab.elements,
      ...(grab.describe ? { describe: grab.describe } : {}),
      ...(grab.previous ? { previous: grab.previous, new: grab.new } : {}),
      image: grab.image,
    };
    let text = JSON.stringify({ ...raw, ...about }, null, 2);
    // The browser could not scroll the pane as far as the chrome had (K.2-85):
    // the picture sits that much off what the user drew.
    const short = clampedBy(grab);
    if (short) text += `\n\nNote: the pane scrolled ${short} px short of the chrome's measure, so the picture may sit up to that much off what the user drew.`;
    if (typeof grab.data !== 'string') return { ...raw, ...about };
    return { content: [{ type: 'text', text }, { type: 'image', data: grab.data, mimeType: grab.mimeType || 'image/png' }] };
  },
  // For tests: the capture url's element, by the log's own id test.
  GRAB_URL_RE,
  elementOfUrl,
};
