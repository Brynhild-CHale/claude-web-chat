const test = require('node:test');
const assert = require('node:assert');
const { packageVersion, SCHEMA_VERSION, PROTOCOL_VERSION, isProtocolCurrent } = require('../lib/core/versions');
const pkg = require('../package.json');

test('packageVersion reads the package.json semver', () => {
  assert.equal(packageVersion(), pkg.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test('SCHEMA_VERSION is a positive integer', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
});

test('PROTOCOL_VERSION is 2 (profile-match landed in v2)', () => {
  assert.equal(PROTOCOL_VERSION, 2);
});

test('isProtocolCurrent gates on version >= PROTOCOL_VERSION', () => {
  assert.equal(isProtocolCurrent({ version: PROTOCOL_VERSION }), true);
  assert.equal(isProtocolCurrent({ version: PROTOCOL_VERSION + 1 }), true, 'newer is current');
  assert.equal(isProtocolCurrent({ version: PROTOCOL_VERSION - 1 }), false, 'older is stale');
  // Missing version predates the field → treated as v1 → stale (since PROTOCOL_VERSION > 1).
  assert.equal(isProtocolCurrent({}), false);
  assert.equal(isProtocolCurrent(null), false, 'null health is not current');
});

test('HUB_PROTOCOL_VERSION alias still equals PROTOCOL_VERSION', () => {
  const { HUB_PROTOCOL_VERSION } = require('../lib/util/hub');
  assert.equal(HUB_PROTOCOL_VERSION, PROTOCOL_VERSION);
});
