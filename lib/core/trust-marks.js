// The `x-trust` vocabulary: what a component's params_schema may declare about
// each param's place in a service's consent identity.
//
// Consent for a service.js is keyed on (project root, code, params), so any
// change to a param is a new request (lib/server/services.js). Some params change
// nothing a user would decide differently: a pane's title, or a file inside the
// project that the service could already browse to. Asking again for each of
// those trains people to approve without reading. So a property of params_schema
// may carry a mark:
//
//   "x-trust": "display"        never part of the identity
//   "x-trust": "project-path"   left out of the identity while the value is a
//                               path inside the project root; otherwise its
//                               exact value, as for an unmarked param
//
// The service receives every value unchanged either way. A mark only decides
// whether a change to that value asks again.
//
// Anything else counts as absent: no mark, a misspelling, a non-string, or a
// mark from a later build. The param then stays in the identity by its exact
// value. This fails closed: a word this build does not know never widens what an
// approval covers.
//
// This file holds only the WORDS. The identity itself (what counts as inside,
// how the declaration enters the code hash) is minted in lib/server/services.js
// and nowhere else. The vocabulary lives in core because pack review
// (lib/packs/manifest.js) must warn about the same unknown marks the
// save_component route does, and a shared library may not import the server.
//
// Zero imports: core is the dependency leaf.

// Mark → what an approval covers for a param that carries it, in the words the
// CLI prints. Ordered as `describeCovers` lists them.
const TRUST_MARKS = Object.freeze({
  'project-path': 'any path inside this project',
  display: 'display only',
});

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isTrustMark(value) {
  return typeof value === 'string' && has(TRUST_MARKS, value);
}

// The declaration in a params_schema. Returns
//   { marks: { [param]: mark }, unknown: [{ param, value }] }
// `marks` holds KNOWN marks only. `unknown` lists every other `x-trust` value,
// so a caller can warn about it; the param itself counts as unmarked.
// A schema without `properties` declares nothing.
function readTrustMarks(schema) {
  const marks = {};
  const unknown = [];
  const props = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : null;
  if (!props) return { marks, unknown };
  for (const [param, spec] of Object.entries(props)) {
    if (!isPlainObject(spec) || !has(spec, 'x-trust')) continue;
    const value = spec['x-trust'];
    if (isTrustMark(value)) marks[param] = value;
    else unknown.push({ param, value });
  }
  return { marks, unknown };
}

// One warning per unknown mark, in the one wording the save route and pack
// review both use.
function trustMarkWarnings(schema) {
  return readTrustMarks(schema).unknown.map(({ param, value }) => (
    `params_schema: "${param}" has x-trust ${JSON.stringify(value)}, which web-chat does not know. `
    + `It counts as absent, so any change to "${param}" asks for approval again `
    + `(known marks: ${Object.keys(TRUST_MARKS).join(', ')}).`
  ));
}

// What an approval covers, in words, from a `covers` map ({ param: mark }, as
// the daemon reports it for one request):
//   "path, root: any path inside this project · title: display only"
// Params are listed in the map's order (the daemon sends them sorted). An empty
// or missing map is '' — the caller says what that means in its own context.
function describeCovers(covers) {
  if (!isPlainObject(covers)) return '';
  const groups = [];
  for (const mark of Object.keys(TRUST_MARKS)) {
    const params = Object.keys(covers).filter((p) => covers[p] === mark);
    if (params.length) groups.push(`${params.join(', ')}: ${TRUST_MARKS[mark]}`);
  }
  return groups.join(' · ');
}

// The marked params a request holds to ONE value, from an `exact` map (as the
// daemon reports it): a `project-path` param whose value could not be proven
// inside the project. An approval then covers the value shown and no other:
//   "path (not a path inside this project: only the value shown)"
function describeExact(exact) {
  if (!isPlainObject(exact)) return '';
  const params = Object.keys(exact).filter((p) => exact[p] === 'project-path');
  return params.length ? `${params.join(', ')} (not a path inside this project: only the value shown)` : '';
}

// Does an approval with these `covers` let a pane choose a file?
function coversProjectPath(covers) {
  return isPlainObject(covers) && Object.values(covers).includes('project-path');
}

// What that means, said once for every place that asks or records it: the
// CLI's listings and grants, and the surface's notice. `subject` names the
// service (or services).
function pathReach(subject) {
  return `An approval lets any pane point ${subject} at any file inside this project, .env files included, without asking again.`;
}

module.exports = {
  TRUST_MARKS, isTrustMark, readTrustMarks, trustMarkWarnings,
  describeCovers, describeExact, coversProjectPath, pathReach,
};
