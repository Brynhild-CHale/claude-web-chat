// lib/core/excerpts.js — the project's excerpt switch: whether Claude receives
// the words of the passages the user pins, quoted as data (the excerpt block,
// lib/channel/envelope excerptText / EXCERPT_HEADER), or ids alone.
//
// One record, .web-chat/excerpts.json (lib/core/paths projectPaths().excerpts):
//
//   { "v": 1, "on": true }        exactly these two keys, `on` a boolean
//
// Absent, torn or the wrong shape, it reads as EXCERPTS_DEFAULT, and the read
// says which (`state`), never throws and never renames the file aside: the one
// writer, `claude-web-chat excerpts on|off`, rewrites it.
//
// WHO MAY FLIP IT (DECISIONS.md L.4 P3 = a): only the host's CLI
// (lib/cli/commands/excerpts.js). There is no route, no ctx member, no frame
// and no RULES row for it: nothing on the page, no pane and no remote viewer
// can reach the switch. It lives in lib/core because both the CLI (which
// writes it) and the daemon (which reads it) need it, and lib/cli → lib/server
// would be an entry → entry edge (notes-B.md D-1; lib/core/project-identity is
// the precedent).
//
// WHERE IT IS READ: the daemon's wake wiring (lib/server/index.js elementWake),
// the one place a queue item gets its words, and `state.excerptsOn` beside it
// for the delivery-time gate. No cache: the record is a few bytes and element
// events are user-paced, so a flip reaches a running daemon at its next
// element event, with no restart and no route.
//
// The default is ON (U425): the maintainer recorded the real-session check
// (GT-14, E3) as passed on the interim build 0.9.0-alpha.2.1 (DECISIONS.md D2,
// L.2 L8 = b, K.2-171), so excerpts ride by default. The record still wins per
// project: {v: 1, on: false} keeps a project off, while an absent, torn or
// wrong-shaped record reads as the default, on — `excerpts status` says
// "on (the default; …)" and names a corrupt or invalid record. The switch
// stays (P3's note; its removal is for tranche 4's planning).
// The record widens no access: it only chooses what the user's own Claude
// reads of the user's own pins, and every excerpt is masked (lib/core/redact)
// and bounded (excerptText) at the producer, and stripped below `read` for a
// remote viewer (lib/core/remote-policy TEXT_RULES.items).

const fs = require('fs');
const { projectPaths, isHomeDir, holdsUserTier } = require('./paths');
const { readJson, writeJsonAtomic } = require('./fsjson');

const EXCERPTS_DEFAULT = true;
const RECORD_VERSION = 1;

// Exactly {v: 1, on: boolean}: no other key, no other version.
function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).length === 2
    && Object.hasOwn(value, 'v') && Object.hasOwn(value, 'on')
    && value.v === RECORD_VERSION && typeof value.on === 'boolean';
}

// → {on, source: 'record'|'default', state: 'ok'|'absent'|'corrupt'|'invalid'}
function readSwitch(root) {
  let r;
  try {
    r = readJson(projectPaths(root).excerpts, { validate: validRecord });
  } catch {
    r = { corrupt: true };
  }
  if (r.ok) return { on: r.value.on, source: 'record', state: 'ok' };
  const state = r.absent ? 'absent' : r.invalid ? 'invalid' : 'corrupt';
  return { on: EXCERPTS_DEFAULT, source: 'default', state };
}

function excerptsOn(root) {
  return readSwitch(root).on;
}

// Write {v: 1, on}. Refuses (TypeError) a non-boolean `on`, a root whose
// .web-chat/ is absent (not a web-chat project: `init` first), and the home
// directory or a folder whose .web-chat/ holds the user tier (never a project).
function setSwitch(root, on) {
  if (typeof on !== 'boolean') throw new TypeError('excerpts: the switch is on or off (a boolean)');
  if (typeof root !== 'string' || !root) throw new TypeError('excerpts: no project root');
  if (isHomeDir(root) || holdsUserTier(root)) {
    throw new TypeError('excerpts: the home directory is never a web-chat project');
  }
  const p = projectPaths(root);
  let isDir = false;
  try { isDir = fs.statSync(p.dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new TypeError(`excerpts: ${root} has no .web-chat/ — run \`claude-web-chat init\` there first`);
  const record = { v: RECORD_VERSION, on };
  writeJsonAtomic(p.excerpts, record, { newline: true });
  return record;
}

module.exports = { EXCERPTS_DEFAULT, RECORD_VERSION, readSwitch, excerptsOn, setSwitch, validRecord };
