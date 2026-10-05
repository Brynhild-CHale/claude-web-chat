// lib/core/redact.js's context (spec §5.5 "Context", U23): what a tool's
// `{ file, command }` says about its OUTPUT. classifyContext maps it to a
// withholding (a sensitive file, a command that reads one or prints a
// credential) and to a mode (a dotenv, an environment dump); redactText,
// redactValue and redactWindow apply it; the mirror's model applies it to an
// item's output and never to its label, call or input. Also the known-value
// source (addKnownSource) the capture token needs.
//
// Fake credentials come from test-support/fake-secrets.js. Speed is measured,
// never asserted, unless WEB_CHAT_PERF=1 (spec §10.1).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  MASK, WITHHELD, PARTIAL_LINE, WITHHOLD_CATEGORIES, classifyContext, redactText, redactValue, redactWindow, createRedactor,
} = require('../lib/core/redact');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createModel } = require('../lib/server/mirror/model');

const PERF = process.env.WEB_CHAT_PERF === '1';
const FAKES = fakeSecrets();
const fake = (id) => {
  const f = FAKES.find((x) => x.id === id);
  assert.ok(f, `fake-secrets has no ${id}`);
  return f;
};
const HOME = process.env.HOME;
const home = (...p) => path.join(HOME, ...p);
const NONE = { withhold: null, mode: null };
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ── classifyContext: files ──────────────────────────────────────────────────

// One sample per withheld category (a dotenv is a mode, not a withholding).
const WITHHELD_FILES = {
  ssh: [home('.ssh', 'id_rsa'), home('.ssh', 'config'), '/tmp/keys/id_ed25519', home('.ssh', 'known_hosts')],
  key: ['/etc/ssl/private/server.pem', 'certs/client.p12', 'deploy.key'],
  cloud: [home('.aws', 'credentials'), home('.aws', 'config'), home('.config', 'gcloud', 'application_default_credentials.json'), home('.kube', 'config')],
  pkg: [home('.npmrc'), 'project/.npmrc', home('.pypirc'), home('.cargo', 'credentials.toml')],
  claude: [home('.claude', '.credentials.json'), home('.claude.json'), 'repo/.claude/settings.local.json'],
  history: [home('.zsh_history'), home('.bash_history'), home('.python_history')],
  credentials: ['config/credentials.json', 'deploy/prod-secrets.yaml', 'app.secret'],
  browser: [home('Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'), 'profile/cookies.sqlite', home('Library', 'Keychains', 'login.keychain-db')],
};

test('classifyContext: a file in each withheld category is withheld under that category', () => {
  assert.deepEqual(Object.keys(WITHHELD_FILES).sort(), WITHHOLD_CATEGORIES.filter((c) => c !== 'dotenv').sort(),
    'every withheld category has a sample');
  for (const [category, files] of Object.entries(WITHHELD_FILES)) {
    for (const file of files) assert.deepEqual(classifyContext({ file }), { withhold: category, mode: null }, file);
  }
});

test('classifyContext: a dotenv is env-dotenv, not withheld; .env.example is neither; .web-chat/ and .git/ are shown', () => {
  for (const file of ['.env', 'app/.env', 'app/.env.local', 'prod.env', '.envrc', 'worker/.dev.vars']) {
    assert.deepEqual(classifyContext({ file }), { withhold: null, mode: 'env-dotenv' }, file);
  }
  for (const file of ['.env.example', 'app/.env.sample', '.env.template', '.env.defaults']) {
    assert.deepEqual(classifyContext({ file }), NONE, file);
  }
  for (const file of ['repo/.web-chat/server.json', 'repo/.web-chat/graph/n1.json', 'repo/.git/config', 'repo/.git/HEAD']) {
    assert.deepEqual(classifyContext({ file }), NONE, file);
  }
  for (const file of ['lib/server/index.js', 'README.md', 'lib/core/secrets.js', 'docs/credentials.md']) {
    assert.deepEqual(classifyContext({ file }), NONE, `${file}: source code about secrets is shown`);
  }
});

test('classifyContext: case does not matter (.ENV, ID_RSA, .SSH, Credentials.json, COOKIES)', () => {
  assert.deepEqual(classifyContext({ file: 'APP/.ENV' }), { withhold: null, mode: 'env-dotenv' });
  assert.deepEqual(classifyContext({ file: 'C:\\Users\\me\\ID_RSA' }), { withhold: 'ssh', mode: null });
  assert.deepEqual(classifyContext({ file: '/Users/me/.SSH/whatever' }), { withhold: 'ssh', mode: null });
  assert.deepEqual(classifyContext({ file: 'Credentials.json' }), { withhold: 'credentials', mode: null });
  assert.deepEqual(classifyContext({ file: 'Default/COOKIES' }), { withhold: 'browser', mode: null });
  assert.deepEqual(classifyContext({ command: 'CAT ~/.SSH/ID_RSA' }), { withhold: 'ssh', mode: null });
  assert.deepEqual(classifyContext({ command: 'cat app/.ENV' }), { withhold: null, mode: 'env-dotenv' });
});

test('classifyContext: no context, or nothing in it, means nothing', () => {
  for (const context of [undefined, null, 'cat ~/.ssh/id_rsa', 42, {}, { file: null, command: null }, { file: 7 }, { command: ['env'] }]) {
    assert.deepEqual(classifyContext(context), NONE, JSON.stringify(context));
  }
});

// ── classifyContext: commands ───────────────────────────────────────────────

test('classifyContext: a command naming a sensitive path withholds under its category; one naming a dotenv is env-dotenv', () => {
  const cases = [
    ['cat ~/.ssh/id_rsa', 'ssh'],
    ['cat ~/.ssh/id_rsa | head', 'ssh'],
    ['head -5 "$HOME/.aws/credentials"', 'cloud'],
    ['cat < ~/.aws/credentials', 'cloud'],
    ['cat <~/.npmrc', 'pkg'],
    ["grep token '/Users/me/.claude/.credentials.json'", 'claude'],
    ['tail -n 50 ~/.zsh_history', 'history'],
    ['openssl rsa -in server.pem -text', 'key'],
    ['ssh -i~/.ssh/deploy host ls', 'ssh'],
    ['docker run -v ~/.aws/credentials:/root/.aws/credentials img', 'cloud'],
    ['npm test && cat ~/.ssh/id_ed25519', 'ssh'],
    ['echo $(cat ~/.ssh/id_rsa)', 'ssh'],
    ['cp ~/.ssh/id\\_rsa /tmp/x', 'ssh'],
  ];
  for (const [command, category] of cases) {
    assert.deepEqual(classifyContext({ command }), { withhold: category, mode: null }, command);
  }
  for (const command of ['cat .env', 'cat app/.env.local | grep DB', 'node --env-file=.env.local app.js', 'source .envrc && npm start']) {
    assert.deepEqual(classifyContext({ command }), { withhold: null, mode: 'env-dotenv' }, command);
  }
  // A withholding wins over a dotenv in the same command.
  assert.deepEqual(classifyContext({ command: 'cat .env ~/.ssh/id_rsa' }), { withhold: 'ssh', mode: 'env-dotenv' });
  for (const command of ['cat .env.example', 'ls .web-chat/', 'cat .git/config', 'git status', 'npm test', 'ls -la ~/.ssh-backup-notes.txt']) {
    assert.deepEqual(classifyContext({ command }), NONE, command);
  }
});

// Each printer, and spellings that name the same program but print no credential.
const PRINTERS = [
  'gh auth token',
  'security find-generic-password -s web -w',
  'security find-internet-password -s example.com -w',
  'aws configure get aws_secret_access_key',
  'aws --profile dev configure get aws_access_key_id',
  'gcloud auth print-access-token',
  'gcloud auth application-default print-access-token',
  'gcloud auth print-identity-token',
  'az account get-access-token',
  'heroku auth:token',
  'op read op://vault/item/password',
  'vault read secret/data/app',
  'vault kv get secret/app',
  '/opt/homebrew/bin/gh auth token',
];
const NOT_PRINTERS = [
  'gh auth status', 'gh pr list', 'aws s3 ls', 'gcloud auth list', 'az account show', 'heroku logs --tail',
  'vault status', 'security list-keychains', 'op whoami', 'npm run build',
];

test('classifyContext: each credential printer withholds as the command, after && or ;, in a pipeline stage, and in $( )', () => {
  const want = { withhold: 'credentials', mode: null };
  for (const p of PRINTERS) {
    for (const command of [p, `cd /tmp && ${p}`, `true; ${p}`, `${p} | pbcopy`, `echo start | ${p} | head -1`, `export T=$(${p})`,
      `X=\`${p}\``, `(${p})`, `sudo ${p}`]) {
      assert.deepEqual(classifyContext({ command }), want, command);
    }
  }
  for (const command of NOT_PRINTERS) assert.deepEqual(classifyContext({ command }), NONE, command);
  // A printer's words split across stages run nothing.
  assert.deepEqual(classifyContext({ command: 'gh auth status; echo token' }), NONE);
  assert.deepEqual(classifyContext({ command: 'gcloud auth list | grep print-access-token' }), NONE);
});

test('classifyContext: a mention is read as a run, quoted or not (the tokenizer cannot tell them apart, and fails closed)', () => {
  const want = { withhold: 'credentials', mode: null };
  for (const command of ['echo gh auth token', 'echo "gh auth token"', "git commit -m 'gh auth token docs'", 'bash -c "gh auth token"',
    "ssh host 'vault kv get secret/x'"]) {
    assert.deepEqual(classifyContext({ command }), want, command);
  }
  // A quote splits words but opens no stage: the printer's words must still be
  // in one stage, and `;` inside quotes ends one.
  assert.deepEqual(classifyContext({ command: 'echo "gh auth; token"' }), NONE);
});

test('classifyContext: each environment dump is env-dump, as the command, after &&, in a pipeline stage', () => {
  const dumps = ['env', 'printenv', 'printenv HOME', 'set', 'export -p', 'export', 'declare -x', 'declare -px', 'typeset -x',
    'env -0', 'sudo env', '/usr/bin/env', 'env -i printenv', 'FOO=1 export -p', 'kubectl exec pod -- env', 'docker exec web printenv',
    'bash -c "printenv"', 'if set; then :; fi'];
  for (const d of dumps) {
    for (const command of [d, `cd /srv && ${d}`, `${d} | sort`, `echo x | ${d} | grep -i path`, `make; ${d}`, `echo $(${d})`]) {
      assert.deepEqual(classifyContext({ command }), { withhold: null, mode: 'env-dump' }, command);
    }
  }
  for (const command of ['set -euo pipefail; npm test', 'export FOO=1', 'export PATH=$PATH:/x && make', 'env FOO=1 node app.js',
    'declare -x FOO=bar', 'envsubst < tpl', 'ls environment/', 'cat .envrc.example']) {
    assert.deepEqual(classifyContext({ command }), NONE, command);
  }
  // A dump of a dotenv's lines and a dump together: the stricter env-dotenv.
  assert.deepEqual(classifyContext({ command: 'cat .env; env' }), { withhold: null, mode: 'env-dotenv' });
  // Redirections are not operands: `env > out.txt` and `env 2>&1` still dump.
  for (const command of ['env > /tmp/out.txt', 'env 2>&1 | tee log', 'env &> log', 'set >> log']) {
    assert.deepEqual(classifyContext({ command }), { withhold: null, mode: 'env-dump' }, command);
  }
});

// U23b: env's option arguments are consumed with their flag, so `env -u FOO`
// with nothing after it dumps, while `env -u FOO cmd` still runs cmd.
test('classifyContext: env\'s -u, -C, -P and -S take their argument with them; with no utility after, it is still a dump', () => {
  const dumps = ['env -u FOO', 'sudo env -u A -u B', 'env -C dir', 'env -P path', "env -S 'x'", 'env --unset FOO', 'env --chdir /tmp',
    "env --split-string 'x'", 'env -iu FOO', 'env -u FOO -i', 'env -u FOO BAR=1', 'env -uFOO -C /tmp', '/usr/bin/env -u HOME'];
  for (const d of dumps) {
    for (const command of [d, `${d} | sort`, `cd /srv && ${d}`, `echo x | ${d} | grep -i path`, `echo $(${d})`]) {
      assert.deepEqual(classifyContext({ command }), { withhold: null, mode: 'env-dump' }, command);
    }
  }
  for (const command of ['env -u FOO cmd', 'env -u FOO node app.js | sort', 'sudo env -u A -u B make', 'env -C dir ls', 'env -P /bin ls',
    "env -S 'x' y", 'env --unset FOO cmd', 'env -ui cmd', 'env -i -u FOO BAR=1 node app.js']) {
    assert.deepEqual(classifyContext({ command }), NONE, command);
  }
});

// U23b (ruling U23@redact.js:command-path-spellings): a word's adjacent quoted
// fragments are tried joined, and a glob's directory against the directories
// whose files are a category. No category is added.
test('classifyContext: quoted fragments are joined, and a glob in a credentials directory withholds under its category', () => {
  const cases = [
    ['cat ~/.aws/*', 'cloud'],
    ['cat ~/.aws/cred*', 'cloud'],
    ['head ~/.aws/c?nfig', 'cloud'],
    ['cat ~/.aws/[cC]redentials', 'cloud'],
    ['cat ~/.aws/{credentials,config}', 'cloud'],
    ['cat "$HOME"/.kube/*', 'cloud'],
    ['tar czf x.tgz ~/.docker/*.json', 'cloud'],
    ['cat ~/.cargo/cred*', 'pkg'],
    ['cat ~/.claude/*', 'claude'],
    ['cat ~/.ssh/*', 'ssh'],
    ['cat ~/.n"p"mrc', 'pkg'],
    ["cat ~/.n'p'mrc", 'pkg'],
    ['cat ~/.n""pmrc', 'pkg'],
    ['cat ~/".ssh"/id_rsa', 'ssh'],
    ['cat "$HOME/.aws/"credentials', 'cloud'],
    ["cat ~/.a'w's/cred*", 'cloud'],
    ['cat < ~/.n"p"mrc', 'pkg'],
    ['echo x && cat ~/".npm"rc | head', 'pkg'],
  ];
  for (const [command, category] of cases) {
    assert.deepEqual(classifyContext({ command }), { withhold: category, mode: null }, command);
  }
  for (const command of ['ls ~/Downloads/*', 'echo "a"b', 'cat src/*.js', 'ls *', 'cat ~/.config/*', 'echo "~/.n" pmrc', 'echo "~/.n"; pmrc',
    'cat ~/.aws', 'ls ~/project/config/*', 'rm -rf build/*']) {
    assert.deepEqual(classifyContext({ command }), NONE, command);
  }
  // A dotenv spelled in fragments is still a dotenv.
  assert.deepEqual(classifyContext({ command: 'cat ."en"v' }), { withhold: null, mode: 'env-dotenv' });
});

test('classifyContext: an explicit mode selects the mode and never lifts a withholding; an unknown one is ignored', () => {
  assert.deepEqual(classifyContext({ command: 'printenv', mode: 'env-dotenv' }), { withhold: null, mode: 'env-dotenv' });
  assert.deepEqual(classifyContext({ file: '.env', mode: 'env-dump' }), { withhold: null, mode: 'env-dump' });
  assert.deepEqual(classifyContext({ mode: 'env-dump' }), { withhold: null, mode: 'env-dump' });
  assert.deepEqual(classifyContext({ file: home('.ssh', 'id_rsa'), mode: 'env-dump' }), { withhold: 'ssh', mode: 'env-dump' });
  assert.deepEqual(classifyContext({ command: 'printenv', mode: 'nothing' }), { withhold: null, mode: 'env-dump' });
  assert.deepEqual(classifyContext({ mode: 'nothing' }), NONE);
});

test('classifyContext: a file and a command together — either withholds; the file decides the mode first', () => {
  assert.deepEqual(classifyContext({ file: 'a.js', command: 'cat ~/.ssh/id_rsa' }), { withhold: 'ssh', mode: null });
  assert.deepEqual(classifyContext({ file: home('.npmrc'), command: 'ls' }), { withhold: 'pkg', mode: null });
  assert.deepEqual(classifyContext({ file: '.env', command: 'env' }), { withhold: null, mode: 'env-dotenv' });
  assert.deepEqual(classifyContext({ file: 'a.js', command: 'env' }), { withhold: null, mode: 'env-dump' });
});

test('classifyContext: a remembered answer is never stale (a mutated context object is read again)', () => {
  const ctx = { file: home('.ssh', 'id_rsa'), command: null };
  assert.equal(classifyContext(ctx).withhold, 'ssh');
  ctx.file = 'a.js';
  assert.deepEqual(classifyContext(ctx), NONE);
  ctx.command = 'printenv';
  assert.deepEqual(classifyContext(ctx), { withhold: null, mode: 'env-dump' });
  const out = classifyContext(ctx);
  out.withhold = 'ssh';
  assert.deepEqual(classifyContext(ctx), { withhold: null, mode: 'env-dump' }, 'a caller cannot poison the remembered answer');
});

// ── the three redactions under a context ────────────────────────────────────

const SSH = { context: { file: home('.ssh', 'id_rsa') } };

test('redactText / redactWindow under a withheld file: every string, however short, is WITHHELD(category) whole', () => {
  const key = fake('pem-openssh').text;
  for (const text of [key, 'plain words', 'x', fake('sk-anthropic-api').text]) {
    assert.equal(redactText(text, SSH), WITHHELD('ssh'));
    assert.equal(redactWindow(text, { ...SSH, startsMidFile: true, complete: false }), WITHHELD('ssh'));
  }
  assert.equal(redactText('', SSH), '', 'an empty string holds nothing to withhold');
  assert.equal(redactText(42, SSH), 42, 'a non-string comes back as it came');
  assert.equal(redactText('[profile]\nregion = x', { context: { file: home('.aws', 'credentials') } }), WITHHELD('cloud'));
  assert.equal(redactText('anything', { context: { command: 'gh auth token' } }), WITHHELD('credentials'));
  assert.equal(redactWindow('mid-line\nrest', { context: { command: 'tail ~/.bash_history' }, startsMidFile: true }), WITHHELD('history'));
});

test('redactValue under a withheld file: every string leaf is WITHHELD; numbers, booleans, null and the keys are kept', () => {
  const secret = fake('github-ghp').secrets[0];
  const v = {
    preview: `contents ${secret}`, bytes: 412, lines: 9, is_error: false, truncated: null,
    nested: [{ line: 'a' }, 'b', 7, true], edit: { old_string: 'x', new_string: secret },
    raw: new TextEncoder().encode(`bin ${secret}`),
  };
  const out = redactValue(v, SSH);
  const W = WITHHELD('ssh');
  assert.deepEqual(out, {
    preview: W, bytes: 412, lines: 9, is_error: false, truncated: null,
    nested: [{ line: W }, W, 7, true], edit: { old_string: W, new_string: W }, raw: W,
  });
  assert.deepEqual(findLeaks(JSON.stringify(out), [fake('github-ghp')]), []);
});

test('under printenv: values are masked and names kept, exactly as the env-dump mode does', () => {
  const dump = fake('env-dump').text;
  const text = `HOME=/Users/someone\n${dump}\nSHELL=/bin/zsh`;
  const byMode = redactText(text, { context: { mode: 'env-dump' } });
  for (const command of ['printenv', 'env | sort', 'export -p']) {
    const out = redactText(text, { context: { command } });
    assert.equal(out, byMode, command);
    assert.ok(out.includes('HOME=/Users/someone') && out.includes('SHELL=/bin/zsh'), 'names and ordinary values are kept');
    assert.ok(out.includes(MASK('env-value')), 'the credential value is masked');
    assert.deepEqual(findLeaks(out, [fake('env-dump')]), [], command);
  }
  assert.notEqual(byMode, redactText(text), 'the context changes what is masked');
  assert.deepEqual(redactValue({ out: text }, { context: { command: 'printenv' } }), { out: byMode });
  assert.equal(redactWindow(text, { context: { command: 'printenv' } }), byMode);
});

test('an explicit context.mode still wins over the command, and never lifts a withholding', () => {
  const text = 'HOME=/Users/someone\nDEBUG=1';
  const dotenv = redactText(text, { context: { mode: 'env-dotenv' } });
  assert.notEqual(dotenv, redactText(text, { context: { mode: 'env-dump' } }), 'the two modes differ on this text');
  assert.equal(redactText(text, { context: { command: 'printenv', mode: 'env-dotenv' } }), dotenv);
  assert.equal(redactText(text, { context: { file: home('.ssh', 'id_rsa'), mode: 'env-dotenv' } }), WITHHELD('ssh'));
});

test('a cat of a dotenv masks every value and keeps the keys', () => {
  const f = fake('env-dotenv');
  const out = redactText(f.text, { context: { command: 'cat .env' } });
  assert.equal(out, redactText(f.text, { context: { mode: 'env-dotenv' } }));
  assert.deepEqual(findLeaks(out, [f]), []);
  assert.equal(redactText(f.text, { context: { file: 'app/.env' } }), out);
});

test('the command text itself is never withheld: only what a caller passes under the context is', () => {
  for (const command of ['cat ~/.ssh/id_rsa', 'gh auth token', 'printenv', 'cat .env']) {
    assert.equal(redactText(command), command, 'no context, no withholding');
    assert.equal(redactText(`Bash · ${command}`), `Bash · ${command}`);
  }
});

test('redaction stays idempotent under a context: a WITHHELD mark is returned unchanged', () => {
  const contexts = [SSH, { context: { command: 'gh auth token' } }, { context: { command: 'printenv' } }, { context: { command: 'cat .env' } }];
  const text = `${fake('env-dump').text}\n${fake('sk-openrouter').text}`;
  for (const o of contexts) {
    const once = redactText(text, o);
    assert.equal(redactText(once, o), once);
    const w = redactWindow(text, { ...o, startsMidFile: false });
    assert.equal(redactWindow(w, { ...o, startsMidFile: false }), w);
    const v = redactValue({ a: text, n: 3 }, o);
    assert.deepEqual(redactValue(v, o), v);
  }
  // A mark of another kind under a withholding context stays as it is too.
  assert.equal(redactText(MASK('jwt'), SSH), MASK('jwt'));
  assert.equal(redactText(WITHHELD('cloud'), SSH), WITHHELD('cloud'));
  assert.equal(redactText(PARTIAL_LINE, SSH), PARTIAL_LINE);
});

test('onMask hears a withholding as {id, label: category, tier} and never the value', () => {
  const notes = [];
  const secret = fake('sk-anthropic-api').secrets[0];
  redactValue({ a: secret, b: 'x', c: 1 }, { ...SSH, onMask: (n) => notes.push(n) });
  assert.deepEqual(notes, [{ id: 'withheld', label: 'ssh', tier: 1 }, { id: 'withheld', label: 'ssh', tier: 1 }]);
  assert.ok(!JSON.stringify(notes).includes(secret));
});

test('a redactor passes the context through text, value and window', () => {
  const r = createRedactor();
  assert.equal(r.text('x', SSH), WITHHELD('ssh'));
  assert.deepEqual(r.value({ s: 'x', n: 1 }, SSH), { s: WITHHELD('ssh'), n: 1 });
  assert.equal(r.window('a\nb', SSH), WITHHELD('ssh'));
});

// ── the real model ──────────────────────────────────────────────────────────

test('a real model (createModel + createRedactor): a tool_call reading ~/.ssh/id_rsa stores WITHHELD in result and edit; label, call and input stay readable', () => {
  const model = createModel({ redactor: createRedactor() });
  const w = model.claimTurnWriter();
  model.upsertConversation('c1', { title: 'keys' });
  w.putTurn({ id: 't1', conversation_id: 'c1', session_id: 's1', seq: 1, status: 'open', started_at: 1 });
  const file = home('.ssh', 'id_rsa');
  const f = fake('sk-anthropic-api');
  const secret = f.secrets[0];
  model.upsertItem({
    id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'Read', tool_kind: 'Read', status: 'done',
    label: 'Read · .ssh/id_rsa', call: 'Read(~/.ssh/id_rsa)', input: { file_path: file },
    result: { preview: `ANTHROPIC_API_KEY=${secret}`, bytes: 1675, is_error: false },
    edit: { path: file, patch: `+${secret}` },
  }, { context: { file, command: null } });
  const it = model.item('toolu_1');
  const W = WITHHELD('ssh');
  assert.deepEqual(it.result, { preview: W, bytes: 1675, is_error: false });
  assert.deepEqual(it.edit, { path: W, patch: W });
  assert.equal(it.label, 'Read · .ssh/id_rsa');
  assert.equal(it.call, 'Read(~/.ssh/id_rsa)');
  assert.deepEqual(it.input, { file_path: file });
  assert.deepEqual(findLeaks(JSON.stringify(it), [f]), []);

  // A credential printer's output, the same way: the command stays readable.
  model.upsertItem({
    id: 'toolu_2', turn_id: 't1', kind: 'tool_call', tool: 'Bash', tool_kind: 'Bash', status: 'done',
    label: 'Bash · gh auth token', call: 'gh auth token', input: { command: 'gh auth token' },
    result: { preview: fake('github-gho').secrets[0], bytes: 41 },
  }, { context: { file: null, command: 'gh auth token' } });
  const it2 = model.item('toolu_2');
  assert.deepEqual(it2.result, { preview: WITHHELD('credentials'), bytes: 41 });
  assert.equal(it2.call, 'gh auth token');
  assert.deepEqual(it2.input, { command: 'gh auth token' });
});

// ── addKnownSource ──────────────────────────────────────────────────────────

function clocked(start = 1_000_000) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

test('addKnownSource: a value the source starts answering after the redactor was built is masked within maxAgeMs', () => {
  const token = fake('json-key-hex-token').secrets[0];
  const clock = clocked();
  const r = createRedactor({ now: clock.now });
  let current = null;
  assert.equal(r.addKnownSource(() => current, 'capture-token'), true);
  const line = `fetch('/api/capture?token=${token}')`;
  assert.equal(r.text(`x ${token}`), `x ${token}`, 'no value yet');
  current = token;
  clock.t += 1999;
  assert.equal(r.text(`x ${token}`), `x ${token}`, 'not consulted again inside maxAgeMs');
  clock.t += 1;
  assert.equal(r.text(`x ${token}`), `x ${MASK('capture-token')}`, 'consulted once maxAgeMs has passed');
  assert.ok(!r.text(line).includes(token));
  assert.ok(!JSON.stringify(r.value({ a: [line] })).includes(token));
  assert.ok(!r.window(`a\n${line}\n`, { startsMidFile: true }).includes(token));
  // A rotated value replaces the old one, which leaves the set.
  const next = fake('json-key-api-key').secrets[0];
  current = next;
  clock.t += 2000;
  assert.equal(r.text(`${next} ${token}`), `${MASK('capture-token')} ${token}`);
  // A value that stops (null, too short) leaves the set.
  current = 'short';
  clock.t += 2000;
  assert.equal(r.text(`x ${next}`), `x ${next}`);
});

test('addKnownSource: the source is called at most once per maxAgeMs, lazily, and again when the clock steps back', () => {
  const clock = clocked();
  const r = createRedactor({ now: clock.now });
  let calls = 0;
  r.addKnownSource(() => { calls++; return 'someone.person@example.com'; }, 'email', { maxAgeMs: 500 });
  assert.equal(calls, 0, 'registration consults nothing');
  for (let i = 0; i < 50; i++) { r.text('a'); r.value({ a: 'b' }); r.window('x\ny'); clock.t += 9; }
  assert.equal(calls, Math.ceil(50 * 9 / 500), 'once per 500 ms of clock across text, value and window');
  const before = calls;
  clock.t -= 10_000;
  r.text('b');
  assert.equal(calls, before + 1, 'a clock stepped back consults again');
  r.text('c');
  assert.equal(calls, before + 1);
  const zero = createRedactor({ now: clock.now });
  let zc = 0;
  zero.addKnownSource(() => { zc++; return null; }, 'x', { maxAgeMs: 0 });
  zero.text('a'); zero.text('b');
  assert.equal(zc, 2, 'maxAgeMs 0 consults on every call');
});

test('addKnownSource: a throwing source masks nothing and breaks nothing; addKnown values keep working', () => {
  const clock = clocked();
  const r = createRedactor({ now: clock.now });
  r.addKnown('someone.person@example.com', 'email');
  let calls = 0;
  r.addKnownSource(() => { calls++; throw new Error('token file unreadable'); }, 'capture-token');
  assert.equal(r.text('mail someone.person@example.com now'), `mail ${MASK('email')} now`);
  assert.deepEqual(r.value({ a: 'plain' }), { a: 'plain' });
  assert.equal(r.window('plain text\n'), 'plain text\n');
  assert.equal(calls, 1);
  assert.equal(r.addKnownSource('not a function', 'x'), false);
  assert.equal(r.addKnownSource(null), false);
});

test('addKnownSource: a source that redacts from inside its own fn is not re-entered', () => {
  const clock = clocked();
  const r = createRedactor({ now: clock.now });
  let calls = 0;
  r.addKnownSource(() => { calls++; r.text('inner'); return 'abcdefgh-token-value'; }, 'capture-token', { maxAgeMs: 0 });
  assert.equal(r.text('x abcdefgh-token-value'), `x ${MASK('capture-token')}`);
  assert.equal(calls, 1);
});

test('addKnownSource: nothing of a source is serialized — JSON.stringify of a redactor is {}', () => {
  const token = fake('json-key-hex-token').secrets[0];
  const r = createRedactor({ now: () => 5 });
  r.addKnownSource(() => token, 'capture-token');
  r.text('consult it');
  assert.equal(JSON.stringify(r), '{}');
  assert.deepEqual(Object.keys(r).sort(), ['addKnown', 'addKnownSource', 'text', 'value', 'window']);
  assert.ok(Object.isFrozen(r));
  const util = require('node:util');
  assert.ok(!util.inspect(r, { depth: 5, showHidden: true }).includes(token));
});

test('createRedactor still builds with no argument, and a bad clock falls back to consulting', () => {
  assert.equal(JSON.stringify(createRedactor()), '{}');
  const r = createRedactor({ now: () => { throw new Error('no clock'); } });
  let calls = 0;
  r.addKnownSource(() => { calls++; return null; }, 'x');
  r.text('a'); r.text('b');
  assert.equal(calls, 2, 'a clock that throws never freezes a stale value in place');
});

// ── linear time ─────────────────────────────────────────────────────────────

// Commands a careless tokenizer, stage walk or printer match would make
// quadratic: runs of quotes, parentheses, `$(`, pipes, backslashes, fds glued
// to redirects, wrappers, assignments, a printer's program word repeated with
// no chain after it, and `=`/`:` pieces in one long word. Each is 100 KB; the
// timing is logged, and asserted only under PERF.
test('adversarial command strings finish in linear time', (t) => {
  const N = 100_000;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = {
    'double quotes': rep('"'), 'single quotes': rep("'"), 'mixed quotes': rep('"\''), parentheses: rep('('), 'closing parens': rep(')'),
    'command substitutions': rep('$('), pipes: rep('|'), 'pipes and words': rep('a|'), backslashes: rep('\\'), backticks: rep('`'),
    'quoted words': rep('"a" '), 'glued fds': rep('2>'), 'fd redirects': rep('2>&1 '), 'here-redirects': rep('<'),
    'gh words': rep('gh '), 'gh auth words': rep('gh auth '), 'gcloud auth words': rep('gcloud auth '), 'vault kv words': rep('vault kv '),
    'sudo words': rep('sudo '), 'env words': rep('env '), 'env and a command': `${rep('env ')} node`, assignments: rep('A=1 '),
    'flags after env': `env ${rep('-i ')}`, 'set words': rep('set x '), 'export flags': `export ${rep('-p ')}x`,
    'one long word': rep('a'), 'pieces in a word': rep('a=b:c,'), 'path segments': rep('a/'), 'ssh segments': rep('.ssh/'),
    'dotenv words': rep('.env '), 'history-like words': rep('x_history'), 'printer then nothing': `${rep('op ')}`,
    'everything at once': rep('"$(gh|auth)\'`token` < > & ; \\'),
    // U23b: env's option arguments, glued quoted fragments, and globs.
    'env option arguments': `env ${rep('-u x ')}`, 'env option clusters': `env ${rep('-iu ')}`, 'env long options': `env ${rep('--unset x ')}`,
    'glued fragments': rep('a"'), 'glued quoted pieces': rep('.n"p"m=rc\''), 'globs in a word': rep('a/*'),
    'glob pieces': rep('.aws/*,'), 'a deep glob': `${rep('a/')}*`, 'brace globs': rep('{a,'),
  };
  let worst = ['', 0];
  const text = 'GITHUB_TOKEN=abc\nplain line';
  for (const [name, command] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint();
    classifyContext({ command });
    redactText(text, { context: { command, file: command } });
    const took = ms(t0);
    if (took > worst[1]) worst = [name, took];
    if (PERF) assert.ok(took < 500, `${name}: ${took.toFixed(0)} ms for 100 KB`);
  }
  t.diagnostic(`slowest adversarial command: ${worst[0]} at ${worst[1].toFixed(1)} ms for 100 KB`);
});
