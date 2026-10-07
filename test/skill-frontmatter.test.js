// lib/packs/manifest parseFrontmatter / frontmatterFlag (spec §6.2 step 2, U58):
// the one frontmatter parser, lifted out of readSkillFrontmatter so the `/`
// catalog (lib/server/skills.js) reads `disable-model-invocation` with the
// same rules the pack drawer reads `description` with.
//
// What is pinned:
//   * every key of the flat block lands in `fields`, as written;
//   * a folded multi-line description reads as one line;
//   * disable-model-invocation: true for true/yes in any case (quoted or not),
//     false for false, another word or no key;
//   * no frontmatter → present with an error, fields empty; not a string →
//     not present;
//   * readSkillFrontmatter answers exactly parseFrontmatter's answer less
//     `fields`, and exactly the old shapes (absent, no block, a block).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { parseFrontmatter, frontmatterFlag, readSkillFrontmatter } = require('../lib/packs/manifest');

const FOLDED = `---
name: acme-ops
description: Deploy status, incident timelines and per-service health.
  Use when the user asks about deploys, incidents or service health.
disable-model-invocation: true
allowed-tools: Bash(git:*), Read
argument-hint: "[branch]"
---

body here
`;

test('every key of the flat block is in fields, as written', () => {
  const fm = parseFrontmatter(FOLDED);
  assert.equal(fm.present, true);
  assert.equal(fm.error, undefined);
  assert.deepStrictEqual(Object.keys(fm.fields), ['name', 'description', 'disable-model-invocation', 'allowed-tools', 'argument-hint']);
  assert.equal(fm.fields['allowed-tools'], 'Bash(git:*), Read');
  assert.equal(fm.fields['argument-hint'], '"[branch]"', 'a value keeps its quotes in fields');
  assert.equal(fm.name, 'acme-ops');
  assert.match(fm.body, /body here/);
  assert.equal(fm.raw, FOLDED);
});

test('a folded multi-line description reads as one line', () => {
  const fm = parseFrontmatter(FOLDED);
  const one = 'Deploy status, incident timelines and per-service health. Use when the user asks about deploys, incidents or service health.';
  assert.equal(fm.description, one);
  assert.equal(fm.fields.description, one);
});

test('disable-model-invocation: true and yes in any case are true; false and the rest are false', () => {
  const flag = (v) => frontmatterFlag(parseFrontmatter(`---\nname: x\ndisable-model-invocation: ${v}\n---\n`).fields, 'disable-model-invocation');
  for (const v of ['true', 'TRUE', 'True', 'yes', 'Yes', 'YES', '"true"', "'yes'"]) assert.equal(flag(v), true, v);
  for (const v of ['false', 'no', 'False', '', '1', 'truthy', 'yes please']) assert.equal(flag(v), false, v);
  assert.equal(frontmatterFlag(parseFrontmatter('---\nname: x\n---\n').fields, 'disable-model-invocation'), false, 'no key');
  assert.equal(frontmatterFlag(null, 'disable-model-invocation'), false);
  assert.equal(frontmatterFlag({}, 'toString'), false, 'an inherited key is no key');
});

test('no frontmatter: present, with an error and empty fields; not a string: not present', () => {
  const fm = parseFrontmatter('# just a heading\n');
  assert.equal(fm.present, true);
  assert.match(fm.error, /no --- frontmatter/);
  assert.deepStrictEqual(fm.fields, {});
  assert.equal(fm.name, null);
  assert.equal(fm.description, null);
  assert.equal(fm.body, '# just a heading\n');
  for (const v of [null, undefined, 42, {}]) {
    assert.deepStrictEqual(parseFrontmatter(v), { present: false, fields: {}, name: null, description: null, body: null, raw: null });
  }
});

test('readSkillFrontmatter answers parseFrontmatter less fields, in the old shapes', (t) => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-skillfm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepStrictEqual(readSkillFrontmatter(dir), { present: false, name: null, description: null, body: null, raw: null });

  fs.writeFileSync(path.join(dir, 'SKILL.md'), FOLDED);
  const withBlock = readSkillFrontmatter(dir);
  const { fields, ...rest } = parseFrontmatter(FOLDED);
  assert.ok(fields);
  assert.deepStrictEqual(withBlock, rest);
  assert.deepStrictEqual(Object.keys(withBlock), ['present', 'name', 'description', 'body', 'raw']);
  assert.equal(JSON.stringify(withBlock), JSON.stringify({
    present: true, name: rest.name, description: rest.description, body: rest.body, raw: FOLDED,
  }));

  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# just a heading\n');
  assert.deepStrictEqual(readSkillFrontmatter(dir), {
    present: true, name: null, description: null, body: '# just a heading\n', raw: '# just a heading\n',
    error: 'SKILL.md has no --- frontmatter block; Claude Code will not load it as a skill',
  });
});
