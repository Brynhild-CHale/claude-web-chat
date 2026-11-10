// The machine's ceiling, read from the connector record (contract 04 C-04.11,
// contract 06 C-06.23a; a MUST under OQ-1's ruling B). The record carries a
// top-level `ceiling`, 'read' or 'full': the most any hub principal reaches on
// this machine's chats. This file is THE one reading of its four cases, over
// lib/core/fsjson readJson's result, so lib/server (the daemon's level stamp),
// lib/connector and the CLI all reach the same answer without requiring
// lib/setup — lib/setup/connector.js re-exports ceilingOf, never a copy:
//
//   (i)   the record absent, unreadable or unparsable (absent / corrupt /
//         invalid), or a parsed value that is not an object  → 'basic'
//   (ii)  an object with no top-level `ceiling`               → 'full'
//   (iii) `ceiling` 'read' or 'full'                          → that value
//   (iv)  any other `ceiling` ('admin', '', null, a number)   → 'basic'
//
// Absent from the record means full (the schema's default); a record that
// cannot be read at all fails closed to basic, as C-06.23a reads a path that
// names no record.
//
// ceilingOf is pure. The reader that fences a path and reads the file,
// readCeiling, sits beside it and is built on it (tranche 6 U742): it requires
// only ./paths (the fence) and ./fsjson (the read), never lib/setup or
// lib/connector, so the daemon (lib/server/audience), `connect ceiling`'s
// read-back and `status` share this one reading.
//
//   readCeiling(recordPath, {connectorDir}) → 'basic' | 'read' | 'full'
//     The fence first (fencedRecord): a path that is not a non-empty absolute
//     string, or that is not strictly inside connectorDir by isInside over the
//     realpath of both (a symlink inside that points out is outside), is as an
//     absent record, 'basic', and is never opened. Then readJson, then
//     ceilingOf: every case after the read is ceilingOf's, never a second table.
//
//   fencedRecord(recordPath, {connectorDir}) → the absolute path, or null
//     The fence alone, for a caller that decides whether to follow the file
//     at all (the daemon arms its watch only on a fenced path).

const path = require('path');
const { isInside, realpath } = require('./paths');
const { readJson } = require('./fsjson');

const CEILINGS = Object.freeze(['read', 'full']);

function ceilingOf(readResult) {
  if (!readResult || readResult.ok !== true) return 'basic';
  const value = readResult.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'basic';
  if (!Object.prototype.hasOwnProperty.call(value, 'ceiling')) return 'full';
  return CEILINGS.includes(value.ceiling) ? value.ceiling : 'basic';
}

function fencedRecord(recordPath, { connectorDir } = {}) {
  if (typeof recordPath !== 'string' || !recordPath || !path.isAbsolute(recordPath)) return null;
  if (typeof connectorDir !== 'string' || !connectorDir || !path.isAbsolute(connectorDir)) return null;
  const dir = realpath(connectorDir) || path.resolve(connectorDir);
  const file = realpath(recordPath) || path.resolve(recordPath);
  if (file === dir || !isInside(connectorDir, recordPath)) return null;
  return path.resolve(recordPath);
}

function readCeiling(recordPath, { connectorDir } = {}) {
  const file = fencedRecord(recordPath, { connectorDir });
  if (!file) return 'basic';
  return ceilingOf(readJson(file));
}

module.exports = { ceilingOf, readCeiling, fencedRecord, CEILINGS };
