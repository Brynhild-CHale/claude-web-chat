const fs = require('fs');
const path = require('path');
const { DOCS_URL } = require('../../core/versions');

// The bundled contract docs ship inside the installed package, not the
// consumer's project — this command is the resolvable pointer the managed
// rules file uses ("run `claude-web-chat docs service-components`"), so the
// agent (and the user) can read a contract without knowing where the package
// landed on disk.
const DOCS_DIR = path.join(__dirname, '..', '..', '..', 'docs');

// Never throws. `docs/` is only present if package.json's `files` allowlist ships
// it — it did not, once, and because the shipped rules file points Claude here
// three times, every one of those pointers died with a raw ENOENT stack on every
// installed copy. A packaging slip should degrade to a sentence, not a crash.
function listDocs() {
  try {
    return fs
      .readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function reportMissing() {
  console.error('the bundled docs are not present in this build of claude-web-chat.');
  console.error(`Read them in the repository instead: ${DOCS_URL}`);
}

function docs(args = []) {
  const name = (args[0] || '').replace(/\.md$/, '');
  const available = listDocs();
  if (!available.length) {
    reportMissing();
    process.exit(1);
  }
  if (!name) {
    console.log('Bundled docs (claude-web-chat docs <name>):');
    for (const d of available) console.log(`  ${d}`);
    return;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    console.error(`invalid doc name: ${name}`);
    process.exit(1);
  }
  const file = path.join(DOCS_DIR, name + '.md');
  if (!fs.existsSync(file)) {
    console.error(`unknown doc: ${name}`);
    console.error(`available: ${available.join(', ')}`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

module.exports = docs;
