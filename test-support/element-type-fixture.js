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
