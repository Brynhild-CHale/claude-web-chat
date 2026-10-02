// lib/core/brand-store.js — WHERE a brand image is kept on disk.
//
// One file per slot per theme: .web-chat/brand/themes/<key>/<slot>.<ext>, the
// <key> being the key of the theme that was the project's global theme when
// the image was added (lib/core/theme-identity themeKey). Two callers resolve
// paths through here: lib/server/brand.js, the engine every read and write goes
// through, and the v2→v3 state migration (lib/update/migrations/v2-to-v3.js),
// which moved each project's images out of the layout before — <slot>.<ext>
// directly under .web-chat/brand/ — from a process (`install`) that may not
// import lib/server. One resolver, so the fence cannot differ between them.
//
// Nothing a caller hands in is joined unchecked: the slot is looked up in
// SLOTS, the extension in TYPES, and the key must have a theme key's shape (one
// safe path segment). `fence` then refuses a file reached through a symlink
// that points out of .web-chat/ — a symlinked bucket, a symlinked brand/ or
// themes/ directory, a dangling link — exactly as it did for the one flat
// directory before.
//
// Imports only lib/core and Node built-ins.

const path = require('path');
const { projectPaths, fence } = require('./paths');
const { SLOTS, TYPES } = require('./brand-image');
const { isThemeKey } = require('./theme-identity');

// The formats a slot may be stored in, by extension.
const EXTS = Object.freeze(Object.keys(TYPES));

function isSlot(slot) {
  return typeof slot === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, slot);
}

// The absolute path of `slot`'s file, in format `ext`, in theme `key`'s
// bucket — or null when it would escape .web-chat/, or slot, ext or key is not
// one this layout knows.
function slotFile(root, key, slot, ext) {
  if (!isSlot(slot) || !EXTS.includes(ext) || !isThemeKey(key)) return null;
  const p = projectPaths(root);
  return fence(p.dir, path.relative(p.dir, path.join(p.brandThemeDir(key), `${slot}.${ext}`)));
}

// The same slot in the layout before per-theme buckets (state schema v2 and
// earlier), fenced the same way. Only the migration reads it: nothing serves
// an image from there any more.
function legacySlotFile(root, slot, ext) {
  if (!isSlot(slot) || !EXTS.includes(ext)) return null;
  const p = projectPaths(root);
  return fence(p.dir, path.relative(p.dir, path.join(p.brandDir, `${slot}.${ext}`)));
}

module.exports = { EXTS, isSlot, slotFile, legacySlotFile };
