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

test('PROTOCOL_VERSION is 3 (the hub Host gate landed in v3)', () => {
  assert.equal(PROTOCOL_VERSION, 3);
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

// ── prerelease and dev-build ordering ────────────────────────────────────────
// A `build-release.js --dev` build is `<next minor>-dev.<yyyymmddhhmm>.<sha>`.
// It must sort above the release it was built after (so 0.7.6 does not nag it),
// below the release it is heading for (so 0.8.0 is offered when it ships), and
// two of them by their stamp.

const { compareVersions, isDevVersion, devBuildCommit, isPrerelease } = require('../lib/core/versions');

test('a dev build sorts below its own final release and above the last one', () => {
  const dev = '0.8.0-dev.202609271415.abc1234';
  assert.ok(compareVersions(dev, '0.8.0') < 0);
  assert.ok(compareVersions('0.8.0', dev) > 0);
  assert.ok(compareVersions('0.7.6', dev) < 0);
  assert.ok(compareVersions(dev, '0.7.6') > 0);
});

test('two dev builds order by their timestamp, not by their sha', () => {
  const older = '0.8.0-dev.202609271415.fffffff';
  const newer = '0.8.0-dev.202609271416.0000000';
  assert.ok(compareVersions(newer, older) > 0);
  assert.ok(compareVersions(older, newer) < 0);
  assert.equal(compareVersions(newer, newer), 0);
  // Across a digit-count change a string compare would get this wrong.
  assert.ok(compareVersions('0.8.0-dev.10.a', '0.8.0-dev.9.a') > 0);
});

test('prerelease identifiers follow semver precedence', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0, 'a shorter run it prefixes is older');
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0, 'numeric sorts below alphanumeric');
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0, 'numeric identifiers compare numerically');
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-beta.11') > 0);
  assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0, 'build metadata never orders');
  assert.ok(compareVersions('v0.8.0-dev.1.a', '0.8.0') < 0, 'a v prefix is still tag syntax');
});

test('isDevVersion names a --dev stamp and nothing else', () => {
  assert.equal(isDevVersion('0.8.0-dev.202609271415.abc1234'), true);
  assert.equal(isDevVersion('v0.8.0-dev.1.a'), true);
  assert.equal(isDevVersion('0.8.0'), false);
  assert.equal(isDevVersion('0.8.0-rc.1'), false);
  assert.equal(isDevVersion('0.8.0-devil'), false);
  assert.equal(isDevVersion(null), false);
});

test('devBuildCommit reads the commit out of a --dev stamp, and nothing else', () => {
  // The stamp scripts/build-release.js writes, from its own devVersion.
  const { devVersion } = require('../scripts/build-release');
  assert.equal(devBuildCommit(devVersion('0.8.2', { now: new Date(Date.UTC(2026, 9, 2, 12, 0)), sha: 'abc1234' })), 'abc1234');
  assert.equal(devBuildCommit('v0.8.0-dev.1.0a1b'), '0a1b');
  assert.equal(devBuildCommit('0.9.0-dev.202610021200.nogit'), null, 'built outside a checkout: no commit');
  assert.equal(devBuildCommit('0.8.2'), null);
  assert.equal(devBuildCommit('0.8.0-rc.1'), null);
  assert.equal(devBuildCommit(null), null);
});

test('isPrerelease reads the tail compareVersions orders by, never build metadata', () => {
  assert.equal(isPrerelease('0.8.0-dev.202609271415.abc1234'), true);
  assert.equal(isPrerelease('v1.0.0-rc.1'), true);
  assert.equal(isPrerelease('0.7.5'), false);
  assert.equal(isPrerelease('1.0.0+build-7'), false, 'a dash inside +build metadata is not a prerelease tail');
  assert.equal(compareVersions('1.0.0+build-7', '1.0.0'), 0, 'and compareVersions agrees it is the release');
  assert.equal(isPrerelease(null), false);
});
