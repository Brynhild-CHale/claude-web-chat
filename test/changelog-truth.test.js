// CHANGELOG truth — the few claims in the release history a machine can check.
//
// test/doc-truth.test.js deliberately refuses to walk CHANGELOG.md: a release
// entry quotes wrong states on purpose ("it used to say X"), so every identifier
// check that file runs would fire on prose that is correct precisely because it
// is out of date. That exclusion is right, and it left the history with no
// tripwire at all — which is how 0.5.0 came to have no section (the version bump
// carried the whole GitHub-Releases rewrite and touched no changelog, and the
// `[Unreleased]` block it shipped was relabelled `[0.6.0]` hours later, so the
// gap read as continuous), and how the pane behaviour a 0.7.0 bullet describes
// came to be the opposite of what the pane does.
//
// So: a narrow file, and only claims whose truth source is a FILE IN THE TREE —
// the section list against package.json, a documented flag against the parser
// that accepts it, one release note against the component it describes. No
// prose-quality checks; those have no truth source and would fire on nothing but
// rewording.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { compareVersions, packageVersion } = require('../lib/core/versions');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const CHANGELOG = read('CHANGELOG.md');
const README = read('README.md');

// `## [0.6.0] - 2026-08-24` → '0.6.0'. `## [Unreleased]` is matched separately;
// it carries no date and is not part of the released sequence.
function releasedSections(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(line);
    if (m) out.push({ version: `${m[1]}.${m[2]}.${m[3]}`, major: +m[1], minor: +m[2], patch: +m[3] });
  }
  return out;
}

const SECTIONS = releasedSections(CHANGELOG);

test('the changelog opens with [Unreleased], then releases newest-first', () => {
  const headings = CHANGELOG.split('\n').filter((l) => l.startsWith('## '));
  assert.equal(headings[0], '## [Unreleased]', 'the first section must be [Unreleased]');
  assert.ok(SECTIONS.length >= 2, 'expected a released history to check');
  for (let i = 1; i < SECTIONS.length; i++) {
    const prev = SECTIONS[i - 1].version;
    const cur = SECTIONS[i].version;
    assert.ok(
      compareVersions(prev, cur) > 0,
      `release sections must descend: [${prev}] is listed above [${cur}]`,
    );
  }
});

test('every version the package has worn has a section — no silent gap', () => {
  // A release whose notes were never written is invisible: the reader sees a
  // continuous history and attributes its work to the neighbouring entry, which
  // is exactly what happened to 0.5.0's distribution rewrite. Within one major,
  // consecutive documented minors may not skip a number; a version deliberately
  // never released would need a line here saying so.
  const SKIPPED = [];
  for (let i = 1; i < SECTIONS.length; i++) {
    const newer = SECTIONS[i - 1];
    const older = SECTIONS[i];
    if (newer.major !== older.major) continue;
    if (newer.minor === older.minor) continue; // patch releases inside one minor
    for (let m = older.minor + 1; m < newer.minor; m++) {
      const missing = `${newer.major}.${m}.0`;
      assert.ok(
        SKIPPED.includes(missing),
        `CHANGELOG.md jumps from [${older.version}] to [${newer.version}] with no [${missing}] section`,
      );
    }
  }
});

test('the version in package.json has its own section', () => {
  const v = packageVersion();
  assert.ok(
    SECTIONS.some((s) => s.version === v),
    `package.json is at ${v} and CHANGELOG.md has no [${v}] section (release notes still under [Unreleased]?)`,
  );
});
