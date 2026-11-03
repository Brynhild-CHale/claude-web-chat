// The MCP tool catalogue held equal to its contract hash (contract 10 C-10.8,
// Q-10.2). Catalogue 1.0.0 was minted in the contracts folder from alpha.3's 24
// tools; lib/core/versions.js carries its version and sha256 as constants, and
// this test computes the hash over the live tool modules the way ServerWebChat's
// CI does: sha256 over stableStringify([{name, description, inputSchema}]) in
// lib/mcp/index.js's registration order — the shape its ListTools handler
// answers. A tool change therefore fails here as a contract change, never as a
// silent drift between the two sides.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { stableStringify } = require('../lib/core/stable-json');
const { CATALOGUE_VERSION, CATALOGUE_SHA256 } = require('../lib/core/versions');
const { mcpTools } = require('../test-support/doc-truth');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Catalogue 1.0.0 is 24 tools by definition (C-10.8: "the 24 modules"); a new
// tool is a catalogue minor (C-10.9), so this number moves only with the ruling
// that moves CATALOGUE_VERSION.
const CATALOGUE_1_TOOL_COUNT = 24;

const CONTRACT_CHANGE =
  'the MCP catalogue changed (contract 10 C-10.9): a description or inputSchema edit is a catalogue minor '
  + "announced in the contracts folder's notes/ first; CATALOGUE_VERSION and CATALOGUE_SHA256 move only with "
  + 'that ruling; the result fields and the error code tranche 4 adds under 1.0.0 are announced in the contracts '
  + 'note wc-24 (notes/2026-11-02-wc-24.md)';

// The registration order, read from lib/mcp/index.js itself: the
// require('./tools/<name>') entries of its `const tools = [ … ];` literal.
function registrationOrder() {
  const src = read('lib/mcp/index.js');
  const block = src.match(/\nconst tools = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('could not locate the tools array in lib/mcp/index.js');
  const names = [...block[1].matchAll(/require\('\.\/tools\/([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('the tools array parse in lib/mcp/index.js found no tools');
  // Every entry must be one of those requires: an entry of any other form (an
  // inline object, a spread, a require from elsewhere) would reach ListTools
  // unhashed, so it fails here rather than slipping past the parse.
  const rest = block[1]
    .replace(/require\('\.\/tools\/[A-Za-z0-9_]+'\)/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/[\s,]/g, '');
  if (rest) throw new Error(`lib/mcp/index.js's tools array holds an entry this test cannot read as require('./tools/<name>'): ${rest.slice(0, 80)}`);
  return names;
}

// Each module mapped exactly as the ListTools handler maps it.
function catalogue(names) {
  return names.map((n) => {
    const t = require(path.join(REPO, 'lib', 'mcp', 'tools', `${n}.js`));
    return { name: t.name, description: t.description, inputSchema: t.inputSchema };
  });
}

// sha256 over stableStringify — never stableHash, a different form (C-10.8).
function catalogueHash(list) {
  return crypto.createHash('sha256').update(stableStringify(list)).digest('hex');
}

test('the live catalogue hashes to CATALOGUE_SHA256 (contract 10 C-10.8)', () => {
  assert.equal(catalogueHash(catalogue(registrationOrder())), CATALOGUE_SHA256, CONTRACT_CHANGE);
});

test('CATALOGUE_VERSION is 1.0.0, a v1-round semver', () => {
  assert.equal(CATALOGUE_VERSION, '1.0.0');
  assert.match(CATALOGUE_VERSION, /^1\.\d+\.\d+$/);
  assert.match(CATALOGUE_SHA256, /^[0-9a-f]{64}$/);
});

test('the catalogue is the 24 tools, every module in lib/mcp/tools registered once', () => {
  const order = registrationOrder();
  assert.equal(mcpTools().length, CATALOGUE_1_TOOL_COUNT, CONTRACT_CHANGE);
  assert.deepEqual([...order].sort(), mcpTools(), 'lib/mcp/index.js registers exactly the modules in lib/mcp/tools');
  assert.equal(new Set(order).size, order.length, 'no tool is registered twice');
  // A module's own name is the one Claude calls it by; the file name is how
  // index.js reaches it. They agree for every tool.
  for (const entry of catalogue(order)) assert.ok(order.includes(entry.name), `tool ${entry.name} is named after its file`);
});

test('the ListTools handler answers name, description and inputSchema — the hashed shape', () => {
  const src = read('lib/mcp/index.js');
  const handler = src.match(/setRequestHandler\(ListToolsRequestSchema,[\s\S]*?tools\.map\(\(t\) => \(\{([\s\S]*?)\}\)\)/);
  assert.ok(handler, 'could not locate the ListTools handler in lib/mcp/index.js');
  const keys = [...handler[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['name', 'description', 'inputSchema'],
    `a field added to the ListTools answer is a catalogue change too: ${CONTRACT_CHANGE}`);
});

test('a one-character description change moves the hash, and the failure reads as a contract change', () => {
  const live = catalogue(registrationOrder());
  const mutated = JSON.parse(JSON.stringify(live));
  mutated[0].description = `${mutated[0].description}.`;
  assert.notEqual(catalogueHash(mutated), catalogueHash(live));
  assert.notEqual(catalogueHash(mutated), CATALOGUE_SHA256);
  // The message the equality assertion fails with.
  let message = null;
  try {
    assert.equal(catalogueHash(mutated), CATALOGUE_SHA256, CONTRACT_CHANGE);
  } catch (err) {
    message = err.message;
  }
  assert.ok(message, 'the mutated catalogue fails the equality assertion');
  assert.match(message, /contract 10 C-10\.9/);
  assert.match(message, /wc-24/);
  assert.match(message, /notes\/2026-11-02-wc-24\.md/);
  // The live objects were not touched by the mutation (it was a copy).
  assert.equal(catalogueHash(live), CATALOGUE_SHA256);
});

test('lib/core/versions.js requires no lib/mcp module (it stays a leaf)', () => {
  const src = read('lib/core/versions.js');
  assert.doesNotMatch(src, /require\([^)]*mcp/, 'lib/core/versions.js reaches no lib/mcp module');
  const literals = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  const builtins = new Set(builtinModules);
  for (const spec of literals) {
    assert.ok(builtins.has(spec.replace(/^node:/, '')), `lib/core/versions.js requires only Node builtins by name, not ${spec}`);
  }
});
