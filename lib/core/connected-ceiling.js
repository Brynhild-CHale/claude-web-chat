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
// Pure: requires nothing. The reader that fences a path and reads the file
// (readCeiling) sits beside this function, built on it.

const CEILINGS = Object.freeze(['read', 'full']);

function ceilingOf(readResult) {
  if (!readResult || readResult.ok !== true) return 'basic';
  const value = readResult.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'basic';
  if (!Object.prototype.hasOwnProperty.call(value, 'ceiling')) return 'full';
  return CEILINGS.includes(value.ceiling) ? value.ceiling : 'basic';
}

module.exports = { ceilingOf, CEILINGS };
