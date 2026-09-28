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
const GUIDE = read('docs/guide.md');

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

test('the release note about a private embed target matches what the pane does', () => {
  // The daemon refuses to FETCH a private target and labels that one refusal
  // `private-target`; the website pane answers the label by framing the URL
  // itself, because the browser has no such restriction. A note claiming the
  // user is left with an unreachable pane describes the release the fix was
  // in — as its opposite.
  const pane = read('templates/components/website/component.html');
  const branch = pane.slice(pane.indexOf("j.code === 'private-target'"));
  assert.ok(branch.startsWith("j.code === 'private-target'"), 'the pane no longer answers the private-target label');
  // show(url) is the pane's one framing path (it picks the sandbox for the URL).
  assert.ok(
    /\bshow\(url\)|frame\.src = url/.test(branch.slice(0, 400)),
    'the pane no longer frames a private target — re-word the 0.7.0 embed-check note before changing this',
  );
  const bullet = CHANGELOG.split('\n').find((l) => l.includes('/api/embed-check` can no longer be used to probe'));
  assert.ok(bullet, 'the embed-check security note is gone from CHANGELOG.md');
  assert.ok(
    !/reports? unreachable/.test(bullet),
    'the embed-check note says a private target reports unreachable; the pane frames it',
  );
});

test('every flag `trust` accepts is documented in the guide', () => {
  // `trust` is the one command that decides whether host code runs, so a flag it
  // accepts and nothing documents is a path the user never learns exists —
  // `--all` shipped in 0.7.0 and appeared in no doc at all. The parser is the
  // truth source; docs/guide.md's command reference and trust section are where a
  // reader looks.
  const src = read('lib/cli/commands/trust.js');
  const parse = src.slice(src.indexOf('function parseArgs('));
  assert.ok(parse.length > 0, 'trust.js no longer has a parseArgs — re-point this check');
  const flags = new Set();
  for (const m of parse.matchAll(/a === '(--[a-z-]+)'/g)) flags.add(m[1]);
  for (const m of parse.matchAll(/a\.startsWith\('(--[a-z-]+)='\)/g)) flags.add(m[1]);
  assert.ok(flags.size >= 3, `expected trust to accept several flags, found ${[...flags].join(', ')}`);
  for (const flag of flags) {
    assert.ok(GUIDE.includes(flag), `\`claude-web-chat trust ${flag}\` is accepted but appears nowhere in docs/guide.md`);
  }
});

// The notes being written for the next release. `[Unreleased]` ends up as the
// release's section verbatim, so the claims below are checked while it is
// still being written, not after it has shipped.
function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const next = text.indexOf('\n## [', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function unreleased(text) {
  return sectionBody(text, '## [Unreleased]');
}

// The notes the checks below read: `[Unreleased]` while it holds any, else the
// newest dated section. On a release branch `[Unreleased]` is empty — its notes
// have just moved, verbatim, under the release's date — and a check that read
// only `[Unreleased]` there passed on nothing, which is how the 0.8.0 notes
// shipped a merge's two copies of one Upgrading item and one Added bullet.
// `from` is the release those notes upgrade from.
function currentNotes(text) {
  const pending = unreleased(text);
  if (pending.split('\n').some((l) => l.startsWith('### '))) {
    return { name: '[Unreleased]', body: pending, from: SECTIONS[0] && SECTIONS[0].version };
  }
  const newest = SECTIONS[0];
  return {
    name: `[${newest.version}]`,
    body: sectionBody(text, `## [${newest.version}]`),
    from: SECTIONS[1] && SECTIONS[1].version,
  };
}

// Two defects a merge leaves in release notes, both found in 0.8.0's: an
// ordered list with a number twice (a rewritten item kept beside the one it
// replaced), and two bullets whose bold titles say the same thing in slightly
// different words (a rewritten bullet kept beside its original). Titles are
// compared as words — a shared opening run of five or more, or three in five of
// their distinct words in common — which over the whole history fires on the
// 0.8.0 pair and nothing else.
function mergeResidue(body) {
  const problems = [];
  for (const sub of body.split(/\n(?=### )/)) {
    const heading = sub.split('\n')[0];
    const nums = [...sub.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    nums.forEach((n, i) => {
      if (n !== i + 1) {
        const dup = nums.indexOf(n) !== i;
        problems.push(`${heading}: item ${i + 1} is numbered ${n}${dup ? ` — a second item ${n}` : ''}`);
      }
    });
  }
  const words = (t) => t.toLowerCase().replace(/[`*_.,:;!?()'"—–-]/g, ' ').split(/\s+/).filter(Boolean);
  const titles = [...body.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = words(titles[i]);
      const b = words(titles[j]);
      let lead = 0;
      while (lead < a.length && lead < b.length && a[lead] === b[lead]) lead++;
      const A = new Set(a);
      const B = new Set(b);
      const shared = [...A].filter((w) => B.has(w)).length;
      const overlap = shared / (A.size + B.size - shared);
      if (lead >= 5 || overlap >= 0.6) problems.push(`two bullets say the same thing: "${titles[i]}" / "${titles[j]}"`);
    }
  }
  return problems;
}

test('the current notes carry no merge residue — no list number twice, no bullet twice', () => {
  const { name, body } = currentNotes(CHANGELOG);
  assert.deepEqual(mergeResidue(body), [], `${name} has merge residue`);
});

test('the merge-residue check catches the 0.8.0 residue it was written for', () => {
  const residue = [
    '### Upgrading from 0.7.6',
    '',
    '3. **Expect a new look, and read-only previews.** The chrome is restyled.',
    '4. **New commands, all opt-in:** `claude-web-chat tunnel setup|up|down|status|logs`',
    '4. **New commands and flags, all opt-in:** `claude-web-chat tunnel',
    '5. **Out-of-tree drivers: `POST /api/graph/branch-here` and the `branch-here` WS',
    '',
    '### Added',
    '',
    '- **The tunnel picker lists Active and Inactive projects, and can start a stopped one.** Every project…',
    '- **The tunnel picker lists Active and Inactive projects with live Claude presence, and can start a stopped one.** Every project…',
    '- **A push says where it came from.** Every push…',
  ].join('\n');
  const problems = mergeResidue(residue);
  assert.ok(problems.some((p) => /a second item 4/.test(p)), `the duplicate item 4 was not caught: ${problems.join('; ')}`);
  assert.ok(problems.some((p) => /tunnel picker lists/.test(p)), `the duplicate picker bullet was not caught: ${problems.join('; ')}`);
  assert.equal(problems.filter((p) => /A push says/.test(p)).length, 0, 'an unrelated bullet was flagged');
});

test('pending release notes open with how to upgrade from the newest release', () => {
  // Every release since 0.7.0 has told its reader what to do on update — and the
  // one release that most needed it (a new MCP tool, read-only previews, a removed
  // endpoint) was about to ship without. The version it upgrades from is the
  // newest released section before the notes, so the heading cannot drift either.
  const { name, body, from } = currentNotes(CHANGELOG);
  const firstSub = body.split('\n').find((l) => l.startsWith('### '));
  if (!firstSub || !from) return; // nothing pending, or the first release
  assert.equal(firstSub, `### Upgrading from ${from}`,
    `${name} has notes but opens with "${firstSub}" — say how to upgrade from ${from} first`);
});

test('every portal protocol version the current notes state is the one the code carries', () => {
  // The number went 3 → 4 → 5 inside one release, and the notes kept all three.
  const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
  const { name, body } = currentNotes(CHANGELOG);
  const re = /portal(?:'s)? protocol(?: version)?(?: is)?(?: now)? (\d+)/gi;
  for (const m of body.matchAll(re)) {
    assert.equal(Number(m[1]), PORTAL_PROTOCOL_VERSION,
      `${name} says "${m[0]}" but lib/core/versions has PORTAL_PROTOCOL_VERSION = ${PORTAL_PROTOCOL_VERSION}`);
  }
});
