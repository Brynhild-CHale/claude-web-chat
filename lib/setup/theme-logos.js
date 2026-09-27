// The per-user logos folders of the builtin packs that are an institution's
// look (Georgetown Blue) — where the user drops the marks that pack wants.
// They are trademarks, so none ship; lib/server/brand.js fills a project's
// empty brand slots from whatever valid files the folder holds.
//
// Deliberately quiet: nothing in the UI, the docs, the CHANGELOG, the rules
// file or --help mentions the folder, and whoever calls seedThemeLogos prints
// nothing about it. The only description of it is the README.txt written into
// it.
//
// Created by `claude-web-chat install` and by `update` (the TARGET build's copy
// of this file — lib/cli/commands/update.js loadThemeLogos), whatever theme any
// project is on — never lazily on first use. Idempotent: README.txt goes only
// into a folder that does not exist yet, or one a crash left empty. A folder
// with anything in it is the user's — never touched, never rewritten, so a user
// who deletes the README while keeping logos does not get it back.
//
// A theme installed from a THEME PACK (a private `gtown` pack, say) brings its
// own logos beside it in the theme library — lib/server/brand.js fillSource
// resolves those by the pack theme's own name; this folder is only the builtin
// pack's.

const fs = require('fs');
const path = require('path');
const { userPaths } = require('../core/paths');

// The builtin packs that have a per-user folder.
const FILL_PACKS = Object.freeze(['georgetown-blue']);

const LOGOS_README = `Georgetown Blue logos
=====================

Put your logos in this folder and web-chat shows them whenever a project
uses the Georgetown Blue theme and has not set its own (a project's own
images, from Settings > Brand, always win). No logos ship with web-chat.

The three files
---------------
  logotype   the topbar, drawn at 150 x 22
  lockup     the header of an exported page, drawn at 260 x 52
  seal       the footer of an exported page, drawn at 44 x 44

Exact filenames
---------------
  logotype.svg  or  logotype.png
  lockup.svg    or  lockup.png
  seal.svg      or  seal.png

Optional reversed (white) versions for dark mode:
  logotype-reversed.svg|png, lockup-reversed.svg|png, seal-reversed.svg|png

If both an .svg and a .png are here, the .svg is used.

Format
------
  SVG is preferred. It must not contain scripts, event handlers
  (onload= and the like) or <foreignObject> -- the same rules as
  Settings > Brand uploads -- and should not use external references
  (linked images or fonts): a logo is drawn where nothing is fetched,
  so they would not show. Convert text to outlines.
  Or PNG at 2x on a transparent background:
    logotype 300 x 44, lockup 520 x 104, seal 88 x 88.
  At most 256 KB each.

Colour
------
  Georgetown Blue #041E42 on light backgrounds. The reversed files are
  for dark backgrounds.

A file that breaks these rules is skipped (the web-chat log says which
one). Changes show the next time the page loads. web-chat wrote this
file once and never rewrites it; edit or delete it as you like.
`;

// One pack's folder + README, when the folder is missing or empty. Never
// throws: a user directory we cannot write is not a reason to fail an install.
function ensureLogosFolder(pack) {
  const dir = userPaths().themeLogosDir(pack);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.txt'), LOGOS_README, { flag: 'wx' });
  } catch {}
}

// Every FILL_PACKS folder — what install and update call.
function seedThemeLogos() {
  for (const pack of FILL_PACKS) ensureLogosFolder(pack);
}

module.exports = { FILL_PACKS, LOGOS_README, ensureLogosFolder, seedThemeLogos };
