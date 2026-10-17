'use strict';
// The crash child for test/applog.test.js (C-2, ported from the folder's F5
// c2-child.js onto lib/core/applog openLog).
//
//   node test-support/applog-child.js <file> <count> [restart]
//
// Loads the log, then appends <count> records `{t: 'x', i, pad}` (pad 40–100
// characters) and writes `a<i>\n` to stdout after each append RETURNS — an ack is
// a promise that write(2) took the whole record. With `restart` it first prints
// `loaded <complete> <bad> <tornBytes>` and continues `i` after the largest one in
// the log, so a test can check that no `i` is written twice across a crash.
const path = require('path');
const { openLog } = require(path.join(__dirname, '..', 'lib', 'core', 'applog'));

const [file, countS, mode] = process.argv.slice(2);
const count = Number(countS);
const log = openLog(file);
let next = 0;
const st = log.load({ onRecord: (rec) => { if (rec.t === 'x' && rec.i >= next) next = rec.i + 1; } });
if (mode === 'restart') process.stdout.write(`loaded ${st.complete} ${st.bad} ${st.torn ? st.torn.bytes : 0}\n`);
for (let k = 0; k < count; k++) {
  const i = next + k;
  log.append({ t: 'x', i, pad: 'p'.repeat(40 + (i % 61)) });
  process.stdout.write(`a${i}\n`);
}
log.close();
