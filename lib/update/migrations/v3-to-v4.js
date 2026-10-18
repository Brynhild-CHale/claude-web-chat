const { migrateComments } = require('../../core/element-migrate');

// v3 → v4: every comment pin moves into the element log.
//
// Up to v3 a comment pin lived only as copies: one in every graph node that
// carried it (node.comments) and one in draft.json. From v4 each pin is an
// element in .web-chat/elements/log.jsonl (lib/core/element-log), every version
// of its text a record there, and each committed node's pins a commit record
// naming id@v. lib/core/element-migrate plans the mapping (strict: a dry run
// first, any unmapped copy refuses the whole step with 0 bytes appended and a
// report in elements/migration-report.json) and plays it through the log's one
// writer. Node files and the draft are never rewritten.
//
// DAEMON ONLY (`daemonOnly` below): the log has one writer, the project's
// daemon, so the runner defers this step in any other context (`install`
// passes context 'install'); `claude-web-chat migrate` is its dry run.
//
// Idempotent: a log that already holds the migration record appends 0 bytes,
// and a log a crash left half-written gets only what is missing. Never throws:
// the runner calls a step bare on every daemon boot, so a failure comes back as
// a refusal (the state stays at v3 and the next boot tries again) rather than a
// daemon that cannot start.
module.exports = function v3ToV4(stateDir) {
  try {
    return migrateComments(stateDir);
  } catch (e) {
    return { refused: true, error: (e && e.message) || String(e), report_file: null };
  }
};
module.exports.daemonOnly = true;
module.exports.what = 'comment migration';
