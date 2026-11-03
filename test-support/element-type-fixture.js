// The ONE element-pack test helper (annotation engine tranche 4, U511; ruling
// U511-U565@approveElementPack-twice a): stage a plug-in element type as a
// pack and install it the reviewed way, so a test lists a type without
// writing a fourth copy of the staging.
//
//   elementJson(type, json?)  a minimal valid element.json for `type`
//                             (family page, remote {see: read, send: full},
//                             schema/reads <type>@1, anchors element+range),
//                             `json` spread over it
//   elementPack({name, version, type, json, files, draw})
//                           → the staged pack's directory (test-support/packs
//                             packFixture): elements/<type>/element.json, its
//                             draw.js (`draw`, default DRAW; null leaves it
//                             out) and each `files` entry {rel: string|Buffer}
//                             under elements/<type>/
//   approveElementPack(d, opts) → the install's result: elementPack(opts)
//                             installed through lib/packs/install
//                             installFromStage via 'approve' (B1's path — a
//                             record and a ledger entry), then
//                             d.srv.elementTypes.invalidate() (an in-process
//                             install emits no `packs` event). `d` is a
//                             withServer context.
//
// U565 appends stageElementPack and a frame-path approveFromFrame below the
// marked line (an append-only grant), never a second module.

const { packFixture } = require('./packs');
const packs = require('../lib/packs/install');

const DRAW = "export default function draw(group) { group.container.textContent = 'x'; }\n";

function elementJson(type, json = {}) {
  return {
    type,
    family: 'page',
    remote: { see: 'read', send: 'full' },
    schema: `${type}@1`,
    reads: [`${type}@1`],
    anchors: ['element', 'range'],
    ...json,
  };
}

function elementPack({ name = 'fixture-pack', version = '1.0.0', type = 'fixture', json = {}, files = {}, draw = DRAW } = {}) {
  const extra = {
    [`elements/${type}/element.json`]: JSON.stringify(elementJson(type, json), null, 2) + '\n',
  };
  if (draw != null) extra[`elements/${type}/draw.js`] = draw;
  for (const [rel, body] of Object.entries(files)) extra[`elements/${type}/${rel}`] = body;
  return packFixture({
    name, version, components: [], skill: false,
    manifest: { name, version, description: 'A fixture element type.', elements: [type] },
    extraFiles: extra,
  });
}

function approveElementPack(d, opts = {}) {
  const result = packs.installFromStage({
    stageDir: elementPack(opts), source: { via: 'test' }, tier: 'local', root: d.root, via: 'approve',
  });
  d.srv.elementTypes.invalidate();
  return result;
}

module.exports = {
  DRAW,
  elementJson,
  elementPack,
  approveElementPack,
};

// ── U565's append (stageElementPack, approveFromFrame) goes below ───────────
//
// stageElementPack(t, d, {dir, owner?, repo?, sha?, global?})
//                         → {url, forge, res}: ANY pack directory `dir` (a
//                           checked-in fixture, a packFixture, the real ink
//                           pack's checkout) served by test-support/packs
//                           fakeForge as <owner>/<repo> (repoWithArchive: one
//                           commit, its codeload archive), then staged the way
//                           the drawer's Download for review stages it — POST
//                           /api/packs/quarantine {url} (`global`: the user
//                           tier's quarantine). `res` is that POST's answer.
//                           No source kind of its own: the pipeline's GitHub
//                           path, pointed at the stand-in (PACK@source).
// approveFromFrame(srv, {name, tier?, query?})
//                         → {doc, body, res, desc}: the person's Approve, as
//                           the answer surface's confirm frame sends it — GET
//                           /answer/control/pack-approve?name&tier (the
//                           document, its nonce and its review), then the POST
//                           control-confirm.js's bodyOf builds, with the
//                           frame's nonce. tier 'local' (default), or 'user'
//                           (the user tier, the row's 'system'); `query`, a
//                           raw query string, replaces name and tier (a test
//                           of the document's refusals). `desc` is the review
//                           the person read; a document that is not 200 comes
//                           back as {doc} alone. `srv` is withServer's.
// frameNonce(html) / frameReview(html)
//                         the confirm document's nonce, and its review
//                         (the wc-control meta, decoded): the one reader of
//                         the frame's protocol in the harness.

const path = require('path');
const { pathToFileURL } = require('url');
const { fakeForge, repoWithArchive } = require('./packs');
const { request } = require('../lib/client');

const CONFIRM_JS = path.join(__dirname, '..', 'lib', 'server', 'answer-surface', 'public', 'control-confirm.js');
// The row's tier words (lib/server/control/pack-approve TIERS) for the
// helper's: 'user' is the user tier, which the row calls 'system'.
const FRAME_TIERS = Object.freeze({ local: 'local', user: 'system' });

async function stageElementPack(t, d, { dir, owner = 'acme', repo = 'marks', sha, global = false } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('stageElementPack: a pack directory is required');
  const forge = await fakeForge(t, { repos: { [`${owner}/${repo}`]: repoWithArchive(dir, sha ? { sha } : {}) } });
  const url = forge.url(owner, repo);
  const res = await d.api.post('/api/packs/quarantine', global ? { url, global: true } : { url });
  return { url, forge, res };
}

const frameNonce = (html) => /name="wc-answer-nonce" content="([^"]*)"/.exec(html)[1];
function frameReview(html) {
  const m = /<meta name="wc-control" content="([^"]*)">/.exec(html);
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(raw);
}

let confirmModule = null;
async function approveFromFrame(srv, { name, tier = 'local', query } = {}) {
  if (!confirmModule) confirmModule = await import(pathToFileURL(CONFIRM_JS).href);
  const target = query != null ? String(query)
    : new URLSearchParams({ name: String(name), tier: Object.hasOwn(FRAME_TIERS, tier) ? FRAME_TIERS[tier] : String(tier) }).toString();
  await srv.controlStarted;
  const { origin, port } = await srv.answerSurface.ensure();
  const qs = `${target}&layout=confirm&mode=light`;
  const doc = await request(port, 'GET', `/answer/control/pack-approve?${qs}`);
  if (doc.status !== 200) return { doc };
  const body = confirmModule.bodyOf(Object.fromEntries(new URLSearchParams(qs)));
  const res = await request(port, 'POST', '/answer/api/control/pack-approve?device=desktop', body, {
    headers: { origin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': frameNonce(doc.body) },
  });
  return { doc, body, res, desc: frameReview(doc.body) };
}

module.exports.stageElementPack = stageElementPack;
module.exports.approveFromFrame = approveFromFrame;
module.exports.frameNonce = frameNonce;
module.exports.frameReview = frameReview;
