const fs = require('fs');
const path = require('path');

// Seeding the builtin components, and the boot-time repair that gives the
// reserved-name policy its teeth.
//
// The LIST itself lives in lib/core/names.js — lib/packs needs it too, and
// `lib/packs → lib/server` is backwards. `BUILTINS` is re-exported from here so
// the server layer keeps the name it has always used for it.
//
// seedBuiltins below only refreshes a directory whose meta.json says
// `builtin: true`. A component pack that shipped a directory named
// `git-dashboard` would therefore win PERMANENTLY: its meta.json says nothing of
// the sort, so every later boot leaves the shadowing copy in place and the real
// builtin never comes back. That is why a builtin name is a hard refusal at
// every name entry, in either tier, for either actor, with no override —
// asserted through lib/core/names.assertComponentName.
const { BUILTIN_COMPONENTS } = require('../core/names');

const BUILTINS = BUILTIN_COMPONENTS;
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

// Seed / refresh the builtin components, and REPORT any that are shadowed.
//
// The refusal at every name entry is prospective: it stops a new shadow, it
// cannot undo one a build without that refusal already wrote. A marker-less
// directory under a builtin name is left strictly alone here — overwriting it
// would silently destroy whatever the user has since edited into it — so the
// only remediation is for someone to know it is there. Hence the report: the
// names are returned (for tests and callers) and named on stderr once per boot,
// with the directory to delete to get the real builtin back.
function seedBuiltins(paths, { log = console.warn } = {}) {
  const shadowed = [];
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
      else shadowed.push({ name, dir: dest });
    } catch {
      copyDir(src, dest);
    }
  }
  if (shadowed.length && typeof log === 'function') {
    for (const s of shadowed) {
      log(`web-chat: the built-in component "${s.name}" is shadowed by a component of the same name at ${s.dir}. It is not marked builtin, so web-chat leaves it alone and never repairs it — delete that directory to get the built-in back.`);
    }
  }
  return { shadowed };
}

module.exports = { BUILTINS, seedBuiltins };
