const fs = require('fs');
const path = require('path');

// The reserved component names, and the ONE list of them.
//
// seedBuiltins below only refreshes a directory whose meta.json says
// `builtin: true`. A component pack that shipped a directory named
// `git-dashboard` would therefore win PERMANENTLY: its meta.json says nothing of
// the sort, so every later boot leaves the shadowing copy in place and the real
// builtin never comes back. That is why a builtin name is a hard refusal at
// install time, in either tier, for either actor, with no override — and why
// lib/packs/manifest.js reads this export instead of re-listing the names.
const BUILTINS = ['form-renderer', 'node-render', 'website', 'git-dashboard', 'file-editor', 'web-chat-tour'];
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'components');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function seedBuiltins(paths) {
  for (const name of BUILTINS) {
    const src = path.join(TEMPLATES_DIR, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(paths.COMPONENTS_DIR, name);
    const metaPath = path.join(dest, 'meta.json');
    const present = fs.existsSync(metaPath);
    if (!present) {
      copyDir(src, dest);
      continue;
    }
    // refresh builtin files (component.html + meta.json) if marked builtin
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.builtin) copyDir(src, dest);
    } catch {
      copyDir(src, dest);
    }
  }
}

module.exports = { BUILTINS, seedBuiltins };
