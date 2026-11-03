// The environment harness as a release check (annotation engine, PLAN.md
// 4C.1's third clause; GT-18's go_when "the environment harness (fp_differ <=
// 1% across TZ/locale/width) runs as a release check"; DECISIONS.md C5): the
// BUILT point anchor (lib/core/anchors.js targetFrame / recordPoint /
// resolvePoint / pointAt, U531) across timezone, locale and width over the
// synthetic svg, img and canvas panes of test-support/point-fixtures.js.
//
// P-10's five environments (design prototype tests/F3/environment.js),
// re-expressed over the built code, one case each, in ONE headless Chrome:
//   baseline   UTC, en-US, 1,280 × 900 — every feature's centre recorded as a
//              point (recordPoint), every element's record(root, el).fp kept;
//   repeat     the baseline again: the noise floor, every figure 0;
//   new_york   Emulation.setTimezoneOverride America/New_York;
//   de_DE      Emulation.setLocaleOverride + Emulation.setUserAgentOverride
//              {acceptLanguage: 'de-DE'} — RULED U533@locale-emulation (a): CDP
//              only, no fallback, and an env-sanity assertion that FAILS when
//              de-DE did not take (never a silent pass);
//   width_390  390 × 844 (Emulation.setDeviceMetricsOverride, mobile).
// Math.random is seeded and Date frozen in every page
// (Page.addScriptToEvaluateOnNewDocument, P-10's prelude), so a difference is
// the environment's. The document is the node preview (lib/server/preview
// renderPreviewHtml) of the fixture node, whose point comment copy makes
// carriesElements splice the point cut — the real splice — written under this
// file's own tmp root and loaded as a file:// URL (no listener of its own).
//
// GRADED per environment: fp_differ <= 1% over the union of both path sets
// (P-10's denominator; GT-18); 0 points outside their feature, per target type
// (svg, img, canvas); every point answered exact or re-resolved, on its own
// target; drift <= 0.02 box units at most (P-10's supports line); the repeat's
// figures 0. Printed beside by t.diagnostic, never graded: drift p50/p95 in px
// per type, and the env-sanity readings.
//
// OPT-IN: the Chrome cases SKIP unless WEB_CHAT_E2E_CHROME=1 (and a Chrome is
// found, or WEB_CHAT_CHROME names one). CI never sets it, and no build seat
// runs it: it is the maintainer's release check —
//   WEB_CHAT_E2E_CHROME=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/point-environment.test.js
//
// The fixture set's shape, and the target walk over it in jsdom, run in EVERY
// suite (the first three cases).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM, VirtualConsole } = require('jsdom');

const { e2eGate } = require('../test-support/helpers');
const { FIXTURES, TARGET_TYPES, SVG_NS, fixtureNode } = require('../test-support/point-fixtures');
const { decodePng } = require('../lib/core/png');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');
const { renderPreviewHtml } = require('../lib/server/preview');
const { launchChrome, liveBrowsers } = require('../lib/replay/chrome');

const e2e = e2eGate(['chrome']);

// ── the fixture set, in every suite ─────────────────────────────────────────

const TARGET_TAGS = new Set(TARGET_TYPES);
const inUnit = (b) => [b.x, b.y, b.w, b.h].every(Number.isFinite)
  && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 && b.y + b.h <= 1;

test('the point fixture set: >= 3 svg, >= 2 img, >= 2 canvas panes; unique ids; feature boxes in [0, 1]^2; PNGs decode to their sizes; data: URLs only', () => {
  const count = (type) => FIXTURES.filter((f) => f.type === type).length;
  assert.ok(count('svg') >= 3, `${count('svg')} svg panes`);
  assert.ok(count('img') >= 2, `${count('img')} img panes`);
  assert.ok(count('canvas') >= 2, `${count('canvas')} canvas panes`);
  assert.deepStrictEqual([...new Set(FIXTURES.map((f) => f.type))].filter((t) => !TARGET_TAGS.has(t)), [], 'every type is a target type');
  assert.equal(new Set(FIXTURES.map((f) => f.id)).size, FIXTURES.length, 'unique ids');
  for (const f of FIXTURES) {
    assert.match(f.id, /^pt-[a-z0-9-]+$/, `${f.id}: a prefixed mount id (never a shell id)`);
    assert.ok(typeof f.html === 'string' && f.html.length > 0, `${f.id}: html`);
    assert.ok(typeof f.target === 'string' && f.target, `${f.id}: a target selector`);
    assert.ok(f.features.length >= 2, `${f.id}: features`);
    assert.equal(new Set(f.features.map((x) => x.name)).size, f.features.length, `${f.id}: unique feature names`);
    for (const x of f.features) {
      assert.ok(!!x.box !== !!x.shape, `${f.id}/${x.name}: a box or a shape, one of them`);
      if (x.box) assert.ok(inUnit(x.box), `${f.id}/${x.name}: box ${JSON.stringify(x.box)} inside [0, 1]^2`);
      if (x.shape) assert.equal(f.type, 'svg', `${f.id}/${x.name}: a shape selector only on an svg`);
    }
    // No URL but data: — every src/href/url() a data: URI, and no other
    // absolute URL but the svg namespace a script names (never fetched).
    for (const m of f.html.matchAll(/\b(?:src|href|srcset)\s*=\s*["']?([^"'\s>]*)/gi)) {
      assert.ok(m[1].startsWith('data:'), `${f.id}: ${m[0].slice(0, 40)} is not a data: URL`);
    }
    for (const m of f.html.matchAll(/url\(\s*["']?([^"')]*)/gi)) assert.ok(m[1].startsWith('data:'), `${f.id}: url(${m[1].slice(0, 30)})`);
    assert.doesNotMatch(f.html, /@import/i, `${f.id}: no @import`);
    for (const m of f.html.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi)) {
      assert.equal(m[0], SVG_NS, `${f.id}: ${m[0]} is a URL`);
    }
    if (f.type === 'img') {
      const uris = [...f.html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
      assert.equal(uris.length, 1, `${f.id}: one PNG`);
      const png = decodePng(Buffer.from(uris[0][1], 'base64'));
      assert.deepStrictEqual([png.width, png.height], [f.png.width, f.png.height], `${f.id}: the PNG decodes to its declared size`);
    }
  }
});

// jsdom: mount each fixture into a shadow root as the preview does
// (public/mount-runtime.js attachAndExtract, then runScripts, so the
// script-built svg exist), and walk targetFrame from each feature's element.
// jsdom does no layout, so the walk is refused 'no-box' — WITH the fixture's
// target, which proves it found the fixed-aspect element (never
// 'not-fixed-aspect').
test('jsdom: targetFrame from each feature\'s element reaches its fixture\'s target (refused no-box with that target: no layout)', (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  t.after(() => dom.window.close());
  const W = dom.window;
  W.eval(fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8'));
  for (const f of FIXTURES) {
    const host = W.document.createElement('div');
    host.id = f.id;
    W.document.body.appendChild(host);
    const { root, scripts } = W.__wcMount.attachAndExtract(host, f.html);
    const errors = [];
    W.__wcMount.runScripts(root, scripts, W.__wcMount.createStore({}), {}, f.id, (e) => errors.push(String(e && e.message)));
    assert.deepStrictEqual(errors, [], `${f.id}: its script runs`);
    const targets = root.querySelectorAll(f.target);
    assert.equal(targets.length, 1, `${f.id}: ${f.target} matches one element`);
    const target = targets[0];
    const tag = target.localName.toLowerCase();
    assert.ok(TARGET_TAGS.has(tag) || target.hasAttribute('data-fixed-aspect'), `${f.id}: the target is an svg, img or canvas (${tag})`);
    assert.equal(tag, f.type, `${f.id}: its type is its target's tag`);
    for (const x of f.features) {
      const el = x.shape ? root.querySelector(x.shape) : target;
      assert.ok(el, `${f.id}/${x.name}: ${x.shape || f.target} in the pane`);
      for (const from of [el, el.firstChild].filter(Boolean)) {
        const fr = anchors.targetFrame(root, from, { mount: f.id });
        assert.equal(fr.refused, 'no-box', `${f.id}/${x.name}: no layout in jsdom (${fr.refused || 'framed'})`);
        assert.strictEqual(fr.target, target, `${f.id}/${x.name}: the walk reached ${f.target}`);
      }
    }
    // The prose beside it is no target: a point there is refused.
    const prose = root.querySelector('.wrap > p');
    assert.equal(anchors.targetFrame(root, prose.firstChild).refused, 'not-fixed-aspect', `${f.id}: the prose is no target`);
  }
});

test('the fixture node carries a point comment copy: kindsOf element+point, and its preview splices the point cut', () => {
  const node = fixtureNode();
  assert.deepStrictEqual(node.mounts.map((m) => m.id), FIXTURES.map((f) => f.id));
  assert.equal(anchorsSrc.carriesElements(node), true);
  assert.deepStrictEqual(anchorsSrc.kindsOf(node), ['element', 'point']);
  const html = renderPreviewHtml(node, { tokens: {} });
  assert.ok(html.includes(anchorsSrc.scriptElement({ kinds: ['element', 'point'] })), 'the element+point cut, spliced');
  assert.ok(!html.includes(anchorsSrc.scriptElement({ kinds: ['element'] })), 'not the element-only cut');
  assert.equal(fixtureNode({ fixtures: FIXTURES.slice(3, 4) }).comments[0].anchor.mount, FIXTURES[3].id, 'the default anchor sits on the first pane');
});

// ── the five environments, opt-in ───────────────────────────────────────────

const FROZEN = Date.UTC(2026, 9, 16, 12, 0, 0);
const SEED = 99;
const [EXACT, RE_RESOLVED] = ANCHOR_STATES;
const FP_DIFFER_MAX_PCT = 1;      // GT-18's harness clause
const DRIFT_MAX = 0.02;           // P-10's supports line, in box units
const ENVS = {
  baseline: { width: 1280, height: 900, tz: 'UTC', locale: 'en-US' },
  repeat: { width: 1280, height: 900, tz: 'UTC', locale: 'en-US' },
  new_york: { width: 1280, height: 900, tz: 'America/New_York', locale: 'en-US' },
  de_DE: { width: 1280, height: 900, tz: 'UTC', locale: 'de-DE' },
  width_390: { width: 390, height: 844, tz: 'UTC', locale: 'en-US', mobile: true },
};

// P-10's prelude: a seeded Math.random (mulberry32) and a frozen Date.
const PRELUDE = `(function (w) {
  var a = ${SEED};
  Math.random = function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  var RD = w.Date, T = ${FROZEN};
  var FD = function () { if (!(this instanceof FD)) return new RD(T).toString(); var args = Array.prototype.slice.call(arguments); return args.length ? new (Function.prototype.bind.apply(RD, [null].concat(args)))() : new RD(T); };
  FD.prototype = RD.prototype; FD.now = function () { return T; }; FD.UTC = RD.UTC; FD.parse = RD.parse; w.Date = FD;
})(window);`;

// One Chrome for the file, launched by the first opted-in case; closed after.
let browser = null;
let tmpDir = null;
let docUrl = null;
let userAgent = null;
const runs = {};
test.after(async () => {
  if (browser) await browser.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(liveBrowsers(), 0, `${liveBrowsers()} browser(s) still up when the file finished`);
});
async function chrome() {
  if (!browser) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-point-env-'));
    const file = path.join(tmpDir, 'point-fixtures.html');
    fs.writeFileSync(file, renderPreviewHtml(fixtureNode(), { tokens: {} }));
    docUrl = pathToFileURL(file).href;
    browser = launchChrome({ chromePath: e2e.chrome, tmpDir });
    userAgent = (await browser.cdp.send('Browser.getVersion')).userAgent;
  }
  return browser.cdp;
}

async function openTab(cdp, env) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  // A background target gets no animation frame in headless Chrome unless it
  // thinks it is focused (P-10's openPage).
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: env.width, height: env.height, deviceScaleFactor: 1, mobile: !!env.mobile }, sessionId);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: env.tz }, sessionId);
  await cdp.send('Emulation.setLocaleOverride', { locale: env.locale }, sessionId);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: env.locale }, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sessionId);
  return { targetId, sessionId };
}
async function navigate(cdp, sid, url) {
  const loaded = cdp.once('Page.loadEventFired', { sessionId: sid });
  const nav = await cdp.send('Page.navigate', { url }, sid);
  if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
  await loaded;
}
async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`evaluate failed: ${(d.exception && d.exception.description) || d.text}`);
  }
  return r.result ? r.result.value : undefined;
}

// In the page (stringified, run through Runtime.evaluate): wait for the
// images and fonts and two frames, then, through window.__wcMount.anchor,
// every element's record(root, el).fp keyed mount#path, and per feature its
// measured box (an svg shape's own box; an img or canvas feature's normalised
// box × the target's box). With spec.record the feature's centre is recorded
// by recordPoint; either way the stored point is resolved by resolvePoint and
// placed by pointAt against the box of the element it resolved to.
async function inPage(spec) {
  const hosts = Array.prototype.slice.call(document.querySelectorAll('.mount-host'));
  for (const h of hosts) {
    if (!h.shadowRoot) continue;
    for (const img of h.shadowRoot.querySelectorAll('img')) { try { await img.decode(); } catch (e) { /* counted below */ } }
  }
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const A = window.__wcMount && window.__wcMount.anchor;
  if (!A || typeof A.recordPoint !== 'function' || typeof A.resolvePoint !== 'function' || typeof A.pointAt !== 'function') {
    throw new Error('the preview document carries no point cut (window.__wcMount.anchor.recordPoint)');
  }
  const rectOf = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
  const fps = {};
  const feats = [];
  const errors = [];
  for (const pane of spec.panes) {
    const host = document.getElementById(pane.id);
    const root = host && host.shadowRoot;
    if (!root) { errors.push(`${pane.id}: no shadow root`); continue; }
    const ix = A.index(root);
    for (const el of root.querySelectorAll('*')) {
      const r = A.record(root, el, { ix, mount: pane.id });
      if (r) fps[`${pane.id}#${r.at.path.join('.')}`] = JSON.stringify(r.fp);
    }
    const ts = root.querySelectorAll(pane.target);
    if (ts.length !== 1) { errors.push(`${pane.id}: ${pane.target} matches ${ts.length}`); continue; }
    const target = ts[0];
    const tb = rectOf(target);
    if (target.localName === 'img' && !(target.naturalWidth > 0)) errors.push(`${pane.id}: the image did not decode`);
    for (const f of pane.features) {
      const key = `${pane.id}/${f.name}`;
      const el = f.shape ? root.querySelector(f.shape) : target;
      const fb = !el ? null : f.shape ? rectOf(el)
        : { left: tb.left + f.box.x * tb.width, top: tb.top + f.box.y * tb.height, width: f.box.w * tb.width, height: f.box.h * tb.height };
      if (!fb || !(fb.width > 0) || !(fb.height > 0)) { feats.push({ key, type: pane.type, lost: 'the feature has no box' }); continue; }
      const cx = fb.left + fb.width / 2;
      const cy = fb.top + fb.height / 2;
      const out = { key, type: pane.type, norm: [(cx - tb.left) / tb.width, (cy - tb.top) / tb.height] };
      let stored = spec.points ? spec.points[key] : null;
      if (spec.record) {
        const rec = A.recordPoint(root, el, cx, cy, { mount: pane.id, ix });
        if (rec.refused) out.refused = rec.refused;
        else stored = out.rec = rec;
      }
      if (!stored) { out.lost = out.refused ? `refused ${out.refused}` : 'no stored point'; feats.push(out); continue; }
      const ans = A.resolvePoint(root, stored, undefined, ix);
      const at = ans.el ? rectOf(ans.el) : null;
      const p = at ? A.pointAt(ans, at) : null;
      out.state = ans.state;
      out.how = ans.how || null;
      out.same = ans.el === target;
      out.inside = !!p && p.x >= fb.left && p.x <= fb.left + fb.width && p.y >= fb.top && p.y <= fb.top + fb.height;
      out.px = p ? Math.hypot(p.x - cx, p.y - cy) : null;
      feats.push(out);
    }
  }
  const ro = Intl.DateTimeFormat().resolvedOptions();
  return { fps, feats, errors, env: {
    lang: navigator.language, langs: (navigator.languages || []).join(','), intl: ro.locale, tz: ro.timeZone,
    num: (1234567.5).toLocaleString(), date: new Date().toLocaleString(), now: Date.now(), w: document.documentElement.clientWidth, inner: innerWidth, h: innerHeight,
  } };
}
const SPEC_PANES = FIXTURES.map((f) => ({ id: f.id, type: f.type, target: f.target, features: f.features }));

async function measure(name, spec) {
  const cdp = await chrome();
  const { targetId, sessionId } = await openTab(cdp, ENVS[name]);
  try {
    await navigate(cdp, sessionId, docUrl);
    return await evaluate(cdp, sessionId, `(${inPage.toString()})(${JSON.stringify(spec)})`);
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// The comparison of one environment's run against the baseline's.
function compare(base, run) {
  const keys = new Set([...Object.keys(base.fps), ...Object.keys(run.fps)]);
  let differ = 0;
  for (const k of keys) if (base.fps[k] !== run.fps[k]) differ++;
  const baseBy = new Map(base.feats.map((f) => [f.key, f]));
  const per = Object.fromEntries(TARGET_TYPES.map((ty) => [ty, { points: 0, outside: 0, px: [], drift: [] }]));
  const badState = [];
  const otherTarget = [];
  const outside = [];
  for (const f of run.feats) {
    const P = per[f.type];
    P.points++;
    if (f.lost) { P.outside++; outside.push(`${f.key} (${f.lost})`); continue; }
    if (f.state !== EXACT && f.state !== RE_RESOLVED) badState.push(`${f.key}: ${f.state} (${f.how})`);
    if (!f.same) otherTarget.push(f.key);
    if (!f.inside) { P.outside++; outside.push(f.key); }
    if (f.px != null) P.px.push(f.px);
    const b = baseBy.get(f.key);
    if (b && b.norm && f.norm) P.drift.push(Math.max(Math.abs(b.norm[0] - f.norm[0]), Math.abs(b.norm[1] - f.norm[1])));
  }
  const drifts = TARGET_TYPES.flatMap((ty) => per[ty].drift);
  return {
    union: keys.size, differ, pct: (100 * differ) / Math.max(1, keys.size),
    per, badState, otherTarget, outside, driftMax: drifts.length ? Math.max(...drifts) : 0,
    points: run.feats.length,
  };
}
function diagnose(t, name, run, c) {
  t.diagnostic(`${name} env: ${JSON.stringify(run.env)}`);
  t.diagnostic(`${name}: fp_differ ${c.differ}/${c.union} (${r2(c.pct)}%), points ${c.points}, drift max ${r4(c.driftMax)} box units`);
  for (const ty of TARGET_TYPES) {
    const P = c.per[ty];
    t.diagnostic(`${name} ${ty}: ${P.points} points, ${P.outside} outside, drift px p50 ${r2(pct(P.px, 50))} p95 ${r2(pct(P.px, 95))}, box units p95 ${r4(pct(P.drift, 95))}`);
  }
}
function grade(name, run, c) {
  assert.deepStrictEqual(run.errors, [], `${name}: the document drew every pane`);
  assert.equal(run.env.now, FROZEN, `${name}: the prelude froze Date`);
  assert.equal(c.points, SPEC_PANES.reduce((n, p) => n + p.features.length, 0), `${name}: every feature measured`);
  assert.ok(c.pct <= FP_DIFFER_MAX_PCT, `${name}: fp_differ ${r2(c.pct)}% (${c.differ} of ${c.union}) <= ${FP_DIFFER_MAX_PCT}%`);
  for (const ty of TARGET_TYPES) {
    assert.ok(c.per[ty].points > 0, `${name}: ${ty} points measured`);
    assert.equal(c.per[ty].outside, 0, `${name}: ${ty} points outside their feature: ${c.outside.filter((k) => k.startsWith(`pt-${ty}-`)).join(', ')}`);
  }
  assert.deepStrictEqual(c.badState, [], `${name}: every point answered exact or re-resolved`);
  assert.deepStrictEqual(c.otherTarget, [], `${name}: every point resolved to its own target`);
  assert.ok(c.driftMax <= DRIFT_MAX, `${name}: drift ${r4(c.driftMax)} <= ${DRIFT_MAX} box units`);
}
function baselineOf() {
  if (!runs.baseline) assert.fail('the baseline case did not run (or failed): every environment compares against it');
  return runs.baseline;
}

test('real Chrome, baseline (UTC, en-US, 1,280 × 900): every feature\'s centre recorded as a point on its target, resolved back exact inside it',
  { skip: e2e.skip, timeout: 60000 }, async (t) => {
    const run = await measure('baseline', { panes: SPEC_PANES, record: true });
    const c = compare(run, run);
    diagnose(t, 'baseline', run, c);
    assert.equal(run.env.tz, 'UTC', 'baseline: UTC');
    assert.equal(run.env.lang, 'en-US', 'baseline: en-US');
    assert.ok(Object.keys(run.fps).length > 0, 'element fingerprints recorded');
    assert.deepStrictEqual(run.feats.filter((f) => !f.rec).map((f) => `${f.key}: ${f.lost}`), [], 'every feature\'s centre recorded by recordPoint');
    for (const f of run.feats) assert.equal(f.rec.kind, 'point', `${f.key}: a point record`);
    assert.deepStrictEqual(run.feats.filter((f) => f.state !== EXACT).map((f) => `${f.key}: ${f.state}`), [], 'resolved in place: exact');
    grade('baseline', run, c);
    runs.baseline = run;
  });

for (const name of ['repeat', 'new_york', 'de_DE', 'width_390']) {
  test(`real Chrome, ${name}: fp_differ <= 1%, 0 points outside per type, exact or re-resolved, drift <= 0.02 box units${name === 'repeat' ? ' (the noise floor: every figure 0)' : ''}`,
    { skip: e2e.skip, timeout: 60000 }, async (t) => {
      const base = baselineOf();
      const points = Object.fromEntries(base.feats.map((f) => [f.key, f.rec]));
      const run = await measure(name, { panes: SPEC_PANES, points });
      const c = compare(base, run);
      diagnose(t, name, run, c);
      const env = run.env;
      if (name === 'de_DE') {
        // RULED U533@locale-emulation (a): CDP only — a de-DE that did not take
        // FAILS here, never measures en-US under a de-DE name.
        const took = /^de\b/.test(env.lang) && /^de\b/.test(env.intl);
        assert.ok(took, `de-DE did not take through CDP (navigator.language ${env.lang}, Intl ${env.intl}): RULED U533@locale-emulation (a) — `
          + 'CDP only (Emulation.setLocaleOverride + Emulation.setUserAgentOverride acceptLanguage), no fallback; this environment was not measured');
      } else {
        assert.equal(env.lang, 'en-US', `${name}: en-US`);
      }
      assert.equal(env.tz, ENVS[name].tz, `${name}: the timezone override took`);
      assert.equal(env.w, ENVS[name].width, `${name}: the width override took (the layout viewport's clientWidth)`);
      grade(name, run, c);
      if (name === 'repeat') {
        assert.equal(c.differ, 0, 'repeat: no fingerprint differs');
        assert.equal(Math.round(c.driftMax * 1e9), 0, 'repeat: no drift');
      }
    });
}
