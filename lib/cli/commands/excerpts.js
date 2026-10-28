// `claude-web-chat excerpts on|off|status` — the project's excerpt switch
// (lib/core/excerpts): whether Claude receives the words of the passages the
// user pins, quoted as data (the excerpt block), or their ids alone.
//
//   excerpts on      writes .web-chat/excerpts.json {v: 1, on: true}
//   excerpts off     writes {v: 1, on: false}
//   excerpts status  on or off, and whether that is this project's record or
//                    the default; a corrupt or invalid record is named (it
//                    reads as the default, and `excerpts on|off` rewrites it)
//
// The host's CLI is the ONLY writer (DECISIONS.md L.4 P3 = a): there is no
// route, and nothing on the page or a remote viewer can reach the switch. The
// running daemon reads the record at each element event, so a flip needs no
// restart; it applies from the next Push, to items queued from then on.

const { resolveRoot } = require('../../setup/registration');
const { readSwitch, setSwitch } = require('../../core/excerpts');

const USAGE = 'usage: claude-web-chat excerpts on|off|status';
const RECORD = '.web-chat/excerpts.json';
const MEANING = {
  true: 'Claude receives the words of the passages you pin, quoted as data',
  false: 'Claude receives the passages you pin by id only, never their words',
};
const APPLIES_LINE = 'applies from the next Push, to items queued from now on; a delivery already parked keeps what it carries';

const word = (on) => (on ? 'on' : 'off');

function statusLine(s) {
  if (s.source === 'record') return `excerpts: ${word(s.on)} (this project's record, ${RECORD})`;
  if (s.state === 'absent') return `excerpts: ${word(s.on)} (the default; this project has no record)`;
  return `excerpts: ${word(s.on)} (the default; ${RECORD} is ${s.state}: reads as ${word(s.on)}; \`excerpts on|off\` rewrites it)`;
}

function excerpts(args = [], opts = {}) {
  const log = opts.log || ((s = '') => console.log(s));
  const sub = args[0];
  if (!['on', 'off', 'status'].includes(sub) || args.length > 1) {
    log(USAGE);
    process.exitCode = 1;
    return { ok: false, exitCode: 1 };
  }
  const { root } = resolveRoot(opts.cwd || process.cwd(), { mode: 'existing' });
  if (sub === 'status') {
    const s = readSwitch(root);
    log(statusLine(s));
    log(`  ${MEANING[s.on]}`);
    return { ok: true, root, ...s };
  }
  const on = sub === 'on';
  setSwitch(root, on);
  const s = readSwitch(root);
  log(statusLine(s));
  log(`  ${MEANING[s.on]}`);
  log(`  ${APPLIES_LINE}`);
  return { ok: true, root, ...s };
}

module.exports = excerpts;
module.exports.USAGE = USAGE;
module.exports.MEANING = MEANING;
module.exports.APPLIES_LINE = APPLIES_LINE;
module.exports.statusLine = statusLine;
