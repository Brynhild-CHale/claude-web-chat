// `claude-web-chat mirror budget <size>|unlimited|status` — the chat mirror's
// disk budget (lib/core/mirror-settings; DECISIONS.md L.4 P4 = c; RULED R2 = a).
//
//   mirror budget <size>      writes .web-chat/mirror.json {v: 1,
//                             disk_budget_bytes: <bytes>}; a size under 64 MiB,
//                             or one that is not a size, is refused with a hint
//                             and nothing is written
//   mirror budget unlimited   writes {v: 1, disk_budget_bytes: null}
//   mirror budget status      the budget (or unlimited), whether that is this
//                             project's record or the default, and the measured
//                             size of .web-chat/mirror/ with its three parts
//
// The host's CLI is the ONLY writer: there is no route and no daemon call, and
// nothing on the page or a remote viewer can reach the budget. The running
// daemon reads the record at its next budget check (codediff BUDGET_CHECK_MS,
// every 6 hours), or at once after `claude-web-chat restart`.

const { resolveRoot } = require('../../setup/registration');
const { projectPaths } = require('../../core/paths');
const {
  inspectMirrorSettings, writeMirrorSettings, parseSize, formatBytes, measureMirror, SizeError,
} = require('../../core/mirror-settings');

const USAGE = 'usage: claude-web-chat mirror budget <size>|unlimited|status';
const RECORD = '.web-chat/mirror.json';
const ORDER_LINE = 'over it, web-chat deletes the files it can rebuild first, then the oldest snapshots, then the oldest diffs, and a diff linked to a graph node last';
const UNLIMITED_LINE = 'nothing in .web-chat/mirror/ is deleted for its size';
const APPLIES_LINE = 'a running server applies it at its next check (every 6 hours), or now with `claude-web-chat restart`';

const sizeOf = (n) => (n === null ? 'unlimited' : `${formatBytes(n)} (${n} bytes)`);

function budgetLine({ settings, state }) {
  const size = sizeOf(settings.disk_budget_bytes);
  if (state === 'ok') return `mirror budget: ${size}; this project's record, ${RECORD}`;
  if (state === 'absent') return `mirror budget: ${size}; the default, this project has no record`;
  return `mirror budget: ${size}; the default, ${RECORD} is ${state} and reads as unlimited (\`mirror budget <size>|unlimited\` rewrites it)`;
}

function measureLine(m) {
  return `.web-chat/mirror/ holds ${formatBytes(m.total)}: index ${formatBytes(m.index)}, diffs ${formatBytes(m.diffs)}, shadow store ${formatBytes(m.shadow)}`;
}

function usage(log) {
  log(USAGE);
  process.exitCode = 1;
  return { ok: false, exitCode: 1 };
}

function mirror(args = [], opts = {}) {
  const log = opts.log || ((s = '') => console.log(s));
  const err = opts.error || ((s = '') => console.error(s));
  if (args[0] !== 'budget' || args.length !== 2) return usage(log);
  const verb = args[1];
  const { root } = resolveRoot(opts.cwd || process.cwd(), { mode: 'existing' });
  const paths = projectPaths(root);

  if (verb === 'status') {
    const s = inspectMirrorSettings(paths);
    const m = measureMirror(paths);
    log(budgetLine(s));
    log(`  ${measureLine(m)}`);
    log(`  ${s.settings.disk_budget_bytes === null ? UNLIMITED_LINE : ORDER_LINE}`);
    return { ok: true, root, ...s, measured: m };
  }

  let bytes;
  try {
    bytes = parseSize(verb);
  } catch (e) {
    if (!(e instanceof SizeError)) throw e;
    err(`mirror budget: ${e.hint}`);
    log(USAGE);
    process.exitCode = 1;
    return { ok: false, exitCode: 1, code: e.code, hint: e.hint };
  }
  writeMirrorSettings(paths, { disk_budget_bytes: bytes });
  const s = inspectMirrorSettings(paths);
  log(budgetLine(s));
  log(`  ${bytes === null ? UNLIMITED_LINE : ORDER_LINE}`);
  log(`  ${APPLIES_LINE}`);
  return { ok: true, root, ...s };
}

module.exports = mirror;
module.exports.USAGE = USAGE;
module.exports.ORDER_LINE = ORDER_LINE;
module.exports.UNLIMITED_LINE = UNLIMITED_LINE;
module.exports.APPLIES_LINE = APPLIES_LINE;
module.exports.budgetLine = budgetLine;
