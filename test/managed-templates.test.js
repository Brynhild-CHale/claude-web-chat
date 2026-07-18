const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MANAGED_FILES, templatesDir } = require('../lib/update/managed-files');

const repoRoot = path.join(__dirname, '..');

// Parity ratchet: this repo dogfoods its own install, but consumers only ever
// receive templates/. An edit to a live managed file that isn't backported to
// its template ships stale (or wrong) guidance to every consumer — the exact
// drift that let the rules template fall a whole feature-set behind.
test('every managed template exists and matches this repo\'s live install', () => {
  for (const { tpl, dest } of MANAGED_FILES) {
    const tplPath = path.join(templatesDir(), tpl);
    const destPath = path.join(repoRoot, dest);
    assert.ok(fs.existsSync(tplPath), `template missing: templates/${tpl}`);
    assert.ok(fs.existsSync(destPath), `live managed file missing: ${dest} (this repo dogfoods the install)`);
    assert.equal(
      fs.readFileSync(destPath, 'utf8'),
      fs.readFileSync(tplPath, 'utf8'),
      `${dest} diverged from templates/${tpl} — backport the edit; consumers only receive the template`
    );
  }
});

// The rules file points at bundled docs via `claude-web-chat docs <name>` —
// every name it cites must actually ship in docs/.
test('docs referenced by the rules resolve to bundled docs', () => {
  const rules = fs.readFileSync(path.join(templatesDir(), 'rules', 'web-chat.md'), 'utf8');
  const cited = [...rules.matchAll(/claude-web-chat docs ([a-z0-9-]+)/g)].map(m => m[1]);
  assert.ok(cited.length >= 3, 'rules should cite the contract docs via `claude-web-chat docs <name>`');
  for (const name of cited) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'docs', `${name}.md`)),
      `rules cite \`claude-web-chat docs ${name}\` but docs/${name}.md does not exist`
    );
  }
});
