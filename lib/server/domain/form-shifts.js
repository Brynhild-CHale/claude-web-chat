'use strict';
// The C4 counter (annotation engine, PLAN.md 4D.1; DECISIONS.md C4, GT-19's
// first clause; rulings U541@shift-classes = a, U541@counter-peers-granularity
// = a): how often a stored form_state, applied to a live mount, met a field
// whose key moved. A2 — form_state keyed by element anchors — is built only
// once this counter shows a real positional shift over a release cycle; the
// maintainer reads it at each release (GET /api/forms/shifts, host only, or
// .web-chat/form-shifts.json). Nothing here re-keys or moves a value.
//
//   createFormShifts({file, version, now, log}) → formShifts
//     accept(id, shifts, {peer, gen})  one live mount's tally → {ok, counted}
//                                      | {ok: false, refused}
//     read()    → {current: version, releases: {<version>: totals}} (a copy)
//     stats()   → {counted, duplicate, refused: {<reason>: n}, write_failed}
//               (in memory, for the tests; never written)
//
// THE TALLY is the chrome's: public/mount-runtime.js applyFormState classes
// each key of the snapshot it applied by X-11's rule (design tests/F1/forms.js)
// — kept, shifted (its #id/@name base now at another index: the real
// positional shift), missing — and public/app/mounts.js sends it after a live
// mount's apply on the existing pane:form frame with no form_state
// (COUNTER@chrome-fed: X-12 maps only 4.47 % of keys from static html, so no
// daemon-side count over the html could see a form built by script).
//
// WHAT COUNTS. A frame is refused whole (no count, a refused stat) unless
// `shifts` is a plain object with exactly the keys kept, shifted and missing,
// each a safe integer 0..FORM_SHIFT_KEYS_MAX, and its peer is 'local' (the
// precedent of lib/server/domain/reports accept: a remote or network socket's
// frame moves nothing). One count per (mount id, mount gen) per process,
// through a bounded in-memory map (FORM_SHIFT_SEEN_MAX, the oldest dropped):
// a second tab or a reload of the same render adds nothing, a re-render (gen +
// 1) counts again. A gen-less mount (restored from a node or a draft; gen is
// live-only, D18) counts once per id until it is re-rendered.
//
// THE RECORD (projectPaths().formShifts), counts and timestamps only — no
// mount id, key name, value or text ever reaches it:
//   {v: 1, releases: {<version>: {first_at, last_at, applies,
//                                 applies_with_shift, kept, shifted, missing}}}
// the newest FORM_SHIFT_RELEASES_MAX releases by last_at. `version` is the
// release this daemon runs (lib/core/versions packageVersion, read once at
// boot). Every counted apply writes it whole through lib/core/fsjson
// writeJsonAtomic with mkdir off, so a removed .web-chat/ is never re-created
// (lib/server/instance-guard's rule); a failed write is logged once and the
// counts kept in memory. At construction an absent file is empty, a corrupt or
// invalid one is renamed aside (renameAside, tag 'corrupt') and the counter
// starts empty.
//
// Nothing here emits: no ring entry, no ws frame. A tally is not activity.
// C-15-1: a pane script can open a local socket and send a tally; the worst it
// can do is skew this counter — no rule here is a security boundary.

const { writeJsonAtomic, readJson, renameAside } = require('../../core/fsjson');

const FORM_SHIFT_KEYS_MAX = 10000;     // the largest count one frame may carry per class
const FORM_SHIFT_SEEN_MAX = 1024;      // (mount id, gen) pairs remembered per process
const FORM_SHIFT_RELEASES_MAX = 16;    // releases kept in the record, newest by last_at
const FORM_SHIFT_VERSION_MAX = 64;     // the longest release string a record may key
const FORM_SHIFT_ASIDE_KEEP = 3;       // corrupt records kept aside
const RECORD_V = 1;
const CLASSES = ['kept', 'shifted', 'missing'];
const TOTALS = ['applies', 'applies_with_shift', 'kept', 'shifted', 'missing'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isCount = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const isTime = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function validRelease(r) {
  if (!isPlain(r)) return false;
  const keys = Object.keys(r);
  if (keys.length !== TOTALS.length + 2) return false;
  if (!isTime(r.first_at) || !isTime(r.last_at)) return false;
  return TOTALS.every((k) => isCount(r[k]));
}

function validRecord(rec) {
  if (!isPlain(rec) || rec.v !== RECORD_V || !isPlain(rec.releases)) return false;
  if (Object.keys(rec).length !== 2) return false;
  return Object.entries(rec.releases).every(([ver, r]) => ver && ver !== '__proto__' && ver.length <= FORM_SHIFT_VERSION_MAX && validRelease(r));
}

// The frame's tally, or null when it is refused.
function tallyOf(shifts) {
  if (!isPlain(shifts)) return null;
  const keys = Object.keys(shifts);
  if (keys.length !== CLASSES.length || !CLASSES.every((k) => keys.includes(k))) return null;
  if (!CLASSES.every((k) => isCount(shifts[k], FORM_SHIFT_KEYS_MAX))) return null;
  return { kept: shifts.kept, shifted: shifts.shifted, missing: shifts.missing };
}

function copyReleases(releases) {
  const out = {};
  for (const [ver, r] of Object.entries(releases)) out[ver] = { ...r };
  return out;
}

function createFormShifts({ file, version, now = Date.now, log } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('createFormShifts: file is required');
  const current = String(version || 'unknown').slice(0, FORM_SHIFT_VERSION_MAX);
  const note = (...a) => {
    if (typeof log !== 'function') return;
    try { log(...a); } catch {}
  };

  let releases = {};
  const r = readJson(file, { validate: validRecord });
  if (r.ok) releases = copyReleases(r.value.releases);
  else if (r.corrupt || r.invalid) {
    let aside = null;
    try { aside = renameAside(file, { tag: 'corrupt', keep: FORM_SHIFT_ASIDE_KEEP, now }); } catch {}
    note(`form-shifts: ${file} was ${r.corrupt ? 'unreadable' : 'not a counter record'}; ${aside ? `moved aside to ${aside}` : 'could not move it aside'}, starting empty`);
  }

  const seen = new Map();   // `${id}\0${gen}` → true, insertion-ordered (oldest first)
  const stat = { counted: 0, duplicate: 0, refused: {}, write_failed: 0 };
  let writeFailureLogged = false;
  const refuse = (reason) => {
    stat.refused[reason] = (stat.refused[reason] || 0) + 1;
    return { ok: false, refused: reason };
  };

  function trim() {
    const vers = Object.keys(releases);
    if (vers.length <= FORM_SHIFT_RELEASES_MAX) return;
    vers.sort((a, b) => releases[b].last_at - releases[a].last_at);
    for (const ver of vers.slice(FORM_SHIFT_RELEASES_MAX)) delete releases[ver];
  }

  function write() {
    try {
      writeJsonAtomic(file, { v: RECORD_V, releases }, { mkdir: false });
      writeFailureLogged = false;
    } catch (e) {
      stat.write_failed += 1;
      if (!writeFailureLogged) {
        writeFailureLogged = true;
        note(`form-shifts: could not write ${file} (${(e && e.code) || (e && e.message) || e}); the counts stay in memory`);
      }
    }
  }

  function accept(id, shifts, { peer, gen } = {}) {
    if (peer !== 'local') return refuse('peer');
    if (typeof id !== 'string' || !id) return refuse('id');
    const tally = tallyOf(shifts);
    if (!tally) return refuse('shape');
    const key = `${id}\u0000${gen == null ? '' : String(gen)}`;
    if (seen.has(key)) {
      stat.duplicate += 1;
      return { ok: true, counted: false };
    }
    seen.set(key, true);
    while (seen.size > FORM_SHIFT_SEEN_MAX) seen.delete(seen.keys().next().value);

    const t = now();
    const rel = releases[current] || {
      first_at: t, last_at: t, applies: 0, applies_with_shift: 0, kept: 0, shifted: 0, missing: 0,
    };
    rel.last_at = t;
    rel.applies += 1;
    if (tally.shifted > 0) rel.applies_with_shift += 1;
    for (const k of CLASSES) rel[k] += tally[k];
    releases[current] = rel;
    trim();
    stat.counted += 1;
    write();
    return { ok: true, counted: true };
  }

  function read() {
    return { current, releases: copyReleases(releases) };
  }

  function stats() {
    return { counted: stat.counted, duplicate: stat.duplicate, refused: { ...stat.refused }, write_failed: stat.write_failed };
  }

  return { accept, read, stats };
}

module.exports = {
  createFormShifts,
  validRecord,
  FORM_SHIFT_KEYS_MAX,
  FORM_SHIFT_SEEN_MAX,
  FORM_SHIFT_RELEASES_MAX,
  FORM_SHIFT_VERSION_MAX,
  FORM_SHIFT_ASIDE_KEEP,
};
