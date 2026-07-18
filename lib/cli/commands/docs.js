const fs = require('fs');
const path = require('path');

// The bundled contract docs ship inside the installed package, not the
// consumer's project — this command is the resolvable pointer the managed
// rules file uses ("run `claude-web-chat docs service-components`"), so the
// agent (and the user) can read a contract without knowing where the package
// landed on disk.
const DOCS_DIR = path.join(__dirname, '..', '..', '..', 'docs');

function listDocs() {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

function docs(args = []) {
  const name = (args[0] || '').replace(/\.md$/, '');
  if (!name) {
    console.log('Bundled docs (claude-web-chat docs <name>):');
    for (const d of listDocs()) console.log(`  ${d}`);
    return;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    console.error(`invalid doc name: ${name}`);
    process.exit(1);
  }
  const file = path.join(DOCS_DIR, name + '.md');
  if (!fs.existsSync(file)) {
    console.error(`unknown doc: ${name}`);
    console.error(`available: ${listDocs().join(', ')}`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

module.exports = docs;
