const fs = require('fs');
const path = require('path');
const { SLOTS } = require('../../core/brand-image');
const { EXTS, slotFile, legacySlotFile } = require('../../core/brand-store');
const { projectTheme } = require('../../core/theme-identity');
const { renameAside } = require('../../core/fsjson');

// v2 → v3: brand images move under the theme they belong to.
//
// Up to v2 a Settings → Brand image was the PROJECT's: one file per slot,
// .web-chat/brand/<slot>.<ext>, shown whatever theme was applied. From v3 an
// image belongs to the theme that was the project's global theme when it was
// added (.web-chat/brand/themes/<key>/<slot>.<ext> — lib/core/brand-store), so
// switching themes switches images. The images a project already has were all
// added under SOME theme, and the only one this step can name is the theme the
// project is on now — so that is where they go: the user sees exactly what they
// saw before the upgrade, and the first switch of theme is the first time
// another theme's images (or its logo fill) show instead.
//
// Per slot, only a REGULAR file moves (lstat, never stat): a symlink is not
// followed, read or moved — it stays where it is, where nothing reads any more —
// and both paths are fenced to .web-chat/ (lib/core/brand-store), so a brand/
// or themes/ directory that is itself a link out of the project moves nothing.
// If the bucket already holds the slot (in either format) the bucket wins, and
// the old file is renamed aside — <slot>.<ext>.superseded-<ms> beside where it
// was — never deleted. A file is moved with rename, so its bytes and its mtime
// (the chrome's cache-buster) are untouched.
//
// Idempotent: a second pass finds no <slot>.<ext> left to move, and the
// renamed-aside files no longer match one. Append-only in the sense the runner
// asks for: nothing under graph/ is read or written. Never throws — the runner
// calls a step bare, on every daemon boot, and a file it could not move stays
// where it was, which costs this one slot's image its place in the new layout,
// not the project its daemon.
module.exports = function v2ToV3(stateDir) {
  const root = path.dirname(stateDir);
  let key;
  try { key = projectTheme(root).key; } catch (e) {
    warn(`could not tell which theme the project is on (${e.message}); brand images left in .web-chat/brand/`);
    return;
  }
  for (const slot of Object.keys(SLOTS)) {
    const legacy = [];
    for (const ext of EXTS) {
      const file = legacySlotFile(root, slot, ext);
      if (!file) continue;
      let st;
      try { st = fs.lstatSync(file); } catch { continue; }
      if (st.isFile()) legacy.push(file);
    }
    if (!legacy.length) continue;
    // The bucket's own copy of this slot wins over the old file — whatever it
    // is, it was put there under the new layout, which only this build writes.
    const taken = EXTS.some((ext) => {
      const f = slotFile(root, key, slot, ext);
      if (!f) return false;
      try { fs.lstatSync(f); return true; } catch { return false; }
    });
    for (const file of legacy) {
      try {
        if (taken) { renameAside(file, { tag: 'superseded' }); continue; }
        const dest = slotFile(root, key, slot, path.extname(file).slice(1));
        if (!dest) { warn(`${path.basename(file)} stays in .web-chat/brand/: the theme's folder is not inside .web-chat`); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file, dest);
      } catch (e) {
        warn(`could not move ${path.basename(file)} under the theme it belongs to (${e.message}); it stays in .web-chat/brand/`);
      }
    }
  }
};

function warn(msg) {
  process.stderr.write(`[claude-web-chat] brand images: ${msg}\n`);
}
