'use strict';
// test-support/element-packs — the fixture strokes pack (strokes-fixture/,
// U565; its page kind U625) for a caller with no test context: the soak
// (scripts/soak/fixture.js stages it, scripts/soak/drive.js strokes with it;
// annotation engine tranche 5, U641, SOAK@strokes-fixture-export, K.2-255).
//
//   STROKES_FIXTURE_DIR / STROKES_FIXTURE_NAME / STROKES_FIXTURE_TYPE
//       the pack's directory, and its name and first element type as its own
//       web-chat-pack.json says them (read here, never copied as literals).
//
//   stageStrokesFixture(root, {srv, owner?, repo?, timeout?}) → {name, record}
//       the pack staged into `root`'s quarantine through
//       test-support/element-type-fixture stageElementPack (the ONE staging
//       helper; never a second copy of it) — the fake forge on an ephemeral
//       loopback port, then POST /api/packs/quarantine {url} on srv's own
//       listener. `t` is a cleanup shim (after(fn) collects; the collected
//       cleanups — the forge's close — run in a finally, since the quarantined
//       tree is a copy), and `d.api.post` is lib/client's request to srv.port
//       mapped to makeApi's {status, json, text}. A non-200, a record that is
//       not the fixture's, or a quarantine that did not land under
//       projectPaths(root).quarantine (root is not srv's) throws an Error
//       naming the status and the body. Installs nothing: the approve is the
//       caller's (the control row 'pack-approve', as a person's confirm).
//
//   strokeBodies({type, mount, html, arrowFrom?, arrowTo, marginItem, frame,
//                 itemBox}) → {element, pane, arrow, margin}
//       four POST /api/elements bodies of the strokes type `type`, each a real
//       stroke (test/strokes-pack-e2e.test.js strokeBody's shape, which is
//       target-frame.js's commit's): samples decimated and rounded by
//       lib/core/strokes, tool 'pen', width a fraction of the frame's width,
//       colour 'accent', stride, aspect, text_under, bbox, and shared false
//       (PRIVATE@create: the route would default a missing one to true).
//       Anchors:
//         element  lib/core/anchors' record of the pane's first svg (a
//                  fixed-aspect target), over `html` mounted as the chrome
//                  mounts it (public/mount-runtime.js attachAndExtract in a
//                  jsdom window, closed after; jsdom required here, lazily);
//         pane     the record of the pane's OUTERMOST element under that svg
//                  (FRAME@pane-element: the ancestor whose parent is the
//                  shadow root);
//         arrow    lib/core/strokes pageRecord from arrowFrom (default mount)
//                  to arrowTo;
//         margin   pageRecord of a stroke beside marginItem (both endpoints
//                  right of its box, x > 1: pageShape 'beside').
//       A page record's points are 0..1 of `frame` ({w, h}: #main's content
//       box at pen-down, fixed by the caller); each endpoint's w, h is
//       `itemBox` ({w, h}, fixed: jsdom lays nothing out, and a 0 × 0 box is
//       one isPageRecord refuses). Throws when pageRecord makes no record.

const fs = require('fs');
const path = require('path');
const { readJson } = require('../../lib/core/fsjson');
const { projectPaths, PUBLIC_DIR } = require('../../lib/core/paths');

const STROKES_FIXTURE_DIR = path.join(__dirname, 'strokes-fixture');
const MANIFEST = (() => {
  const got = readJson(path.join(STROKES_FIXTURE_DIR, 'web-chat-pack.json'));
  if (!got.ok || !got.value || typeof got.value.name !== 'string' || !Array.isArray(got.value.elements) || !got.value.elements.length) {
    throw new Error(`test-support/element-packs: ${STROKES_FIXTURE_DIR}/web-chat-pack.json is not the fixture's manifest (${got.ok ? 'no name or elements' : got.absent ? 'absent' : 'unreadable'})`);
  }
  return got.value;
})();
const STROKES_FIXTURE_NAME = MANIFEST.name;
const STROKES_FIXTURE_TYPE = MANIFEST.elements[0];

const STAGE_TIMEOUT_MS = 30 * 1000;

// lib/client's answer ({status, body}) in makeApi's shape ({status, json, text}).
function asApi(r) {
  const body = r ? r.body : null;
  const json = body && typeof body === 'object' ? body : null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status: r ? r.status : 0, json, text };
}

async function stageStrokesFixture(root, { srv, owner = 'soak', repo = STROKES_FIXTURE_NAME, timeout = STAGE_TIMEOUT_MS } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('stageStrokesFixture: a project root is required');
  const port = srv && srv.port;
  if (!port) throw new TypeError('stageStrokesFixture: {srv} must be a started server (srv.port)');
  // Required here, not at load: the staging pulls in the pack pipeline and
  // the forge's tar builder, which strokeBodies' callers never need.
  const { stageElementPack } = require('../element-type-fixture');
  const { request } = require('../../lib/client');
  const cleanups = [];
  const t = { after(fn) { cleanups.push(fn); } };
  const d = {
    root,
    api: { post: async (p, body) => asApi(await request(port, 'POST', p, body, { timeout })) },
  };
  let res;
  try {
    ({ res } = await stageElementPack(t, d, { dir: STROKES_FIXTURE_DIR, owner, repo }));
  } finally {
    for (const fn of cleanups.splice(0).reverse()) {
      try { await fn(); } catch { /* a forge already closed */ }
    }
  }
  const record = res && res.json && res.json.record;
  if (!res || res.status !== 200 || !res.json || res.json.ok !== true) {
    throw new Error(`stageStrokesFixture: POST /api/packs/quarantine answered ${res ? res.status : 'nothing'}: ${res ? res.text : ''}`);
  }
  if (!record || record.name !== STROKES_FIXTURE_NAME) {
    throw new Error(`stageStrokesFixture: the quarantine staged ${JSON.stringify(record && record.name)}, not ${STROKES_FIXTURE_NAME} (200: ${res.text})`);
  }
  const staged = path.join(projectPaths(root).quarantine, record.name);
  if (!fs.existsSync(staged)) {
    throw new Error(`stageStrokesFixture: nothing was staged under ${staged} — is ${root} the server's root? (200: ${res.text})`);
  }
  return { name: record.name, record };
}

// ── the stroke bodies ────────────────────────────────────────────────────────

// The pane's svg and its outermost element, each as lib/core/anchors records
// it, over the html mounted the way the chrome mounts it.
function elementRecords(mount, html) {
  const { JSDOM } = require('jsdom');
  const anchors = require('../../lib/core/anchors');
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
    const host = dom.window.document.createElement('div');
    host.dataset.mountId = mount;
    dom.window.document.body.appendChild(host);
    const root = dom.window.__wcMount.attachAndExtract(host, html).root;
    const svg = root.querySelector('svg');
    if (!svg) throw new Error(`strokeBodies: the pane ${mount}'s html carries no svg (a fixed-aspect target)`);
    let outer = svg;
    while (outer.parentNode && outer.parentNode !== root) outer = outer.parentNode;
    const rec = (el) => JSON.parse(JSON.stringify(anchors.record(root, el, { mount })));
    // jsdom lays nothing out, so the svg's aspect is its viewBox's.
    const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const aspect = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 1;
    return { element: rec(svg), pane: rec(outer), aspect };
  } finally { dom.window.close(); }
}

// A pen stroke from (x0, y0) to (x1, y1) in frame units: samples (x, y,
// pressure, ms), decimated and rounded by lib/core/strokes.
function penPoints(strokes, [x0, y0], [x1, y1], n = 12) {
  const raw = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    raw.push(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + 0.02 * Math.sin(u * Math.PI), 0.5, i * 8);
  }
  return strokes.roundPoints(strokes.decimate(raw));
}

function strokeBodies({ type, mount, html, arrowFrom = mount, arrowTo, marginItem, frame, itemBox } = {}) {
  const strokes = require('../../lib/core/strokes');
  const box = (b, what) => {
    if (!b || !(b.w > 0) || !(b.h > 0)) throw new TypeError(`strokeBodies: ${what} must be {w, h}, both positive`);
    return { w: b.w, h: b.h };
  };
  const f = box(frame, 'frame');
  const ib = box(itemBox, 'itemBox');
  for (const [k, v] of Object.entries({ type, mount, arrowFrom, arrowTo, marginItem })) {
    if (typeof v !== 'string' || !v) throw new TypeError(`strokeBodies: ${k} must be a non-empty string`);
  }
  const PX = 2; // the pen's width in CSS px
  const body = (anchor, points, { frameW, aspect, under }) => ({
    type,
    anchor,
    payload: {
      text_under: under, bbox: strokes.bboxOf(points),
      shared: false, tool: 'pen', width: PX / frameW, colour: 'accent',
      points, stride: strokes.STROKE_STRIDE, aspect,
    },
  });
  const page = (from, to, what) => {
    const rec = strokes.pageRecord({ frame: f, from: { ...from, ...ib }, to: { ...to, ...ib } });
    if (!rec) throw new Error(`strokeBodies: lib/core/strokes pageRecord made no record for the ${what}`);
    return rec;
  };

  const el = elementRecords(mount, html);
  const arrow = page({ item: arrowFrom, x: 0.5, y: 0.9 }, { item: arrowTo, x: 0.5, y: 0.1 }, 'arrow');
  const margin = page({ item: marginItem, x: 1.05, y: 0.2 }, { item: marginItem, x: 1.08, y: 0.8 }, 'margin stroke');
  return {
    element: body(el.element, penPoints(strokes, [0.15, 0.7], [0.85, 0.3]), { frameW: ib.w, aspect: el.aspect, under: `soak stroke on ${mount}'s svg` }),
    pane: body(el.pane, penPoints(strokes, [0.1, 0.2], [0.9, 0.25]), { frameW: ib.w, aspect: ib.w / ib.h, under: `soak stroke over ${mount}` }),
    arrow: body(arrow, penPoints(strokes, [0.4, 0.3], [0.42, 0.55]), { frameW: f.w, aspect: f.w / f.h, under: `soak arrow from ${arrowFrom} to ${arrowTo}` }),
    margin: body(margin, penPoints(strokes, [0.93, 0.6], [0.94, 0.7]), { frameW: f.w, aspect: f.w / f.h, under: `soak margin stroke beside ${marginItem}` }),
  };
}

module.exports = {
  STROKES_FIXTURE_DIR, STROKES_FIXTURE_NAME, STROKES_FIXTURE_TYPE,
  stageStrokesFixture, strokeBodies,
};
