// `claude-web-chat pack …` — install, review and remove component packs.
//
// A pack is a git repository that installs as components PLUS a Claude skill.
// The skill is the point: `list_components` is a PULL (Claude only learns a
// component exists if it decides to call the tool) while a skill's frontmatter
// description is in context from session start. A component library Claude has
// to go looking for gets used rarely; the same components shipped as a skill get
// used constantly.
//
// Subcommands:
//   install <url>   fetch and install straight away
//   get <url>       fetch and QUARANTINE for review (the advised default for
//                   anything you did not write)
//   review <name>   read a quarantined pack: manifest, plan, files, SKILL.md
//   approve <name>  install a reviewed pack
//   discard <name>  delete a quarantined pack
//   list            what is installed here (--verify checks for local edits)
//   info <name>     one pack in detail
//   remove <name>   uninstall (per-unit; local edits are kept unless --force)
//
// Two things are TERMINAL-ONLY and deliberately absent from the HTTP routes:
// `--replace` (overwriting a component you already had) and removing a pack you
// have edited. Both destroy something the user made, and the daemon cannot tell
// a user's click from a pane's fetch.
//
// `pack update` is deliberately not here in v1. A correct update is a 3-way tree
// reconcile — the record already carries the baseline, so it is cheap to add
// later — and a half-reconcile that clobbers edits is worse than nothing.

const fs = require('fs');
const path = require('path');
const { findProjectRoot, projectPaths } = require('../../core/paths');
const { discoverPort } = require('../../core/portfiles');
const { createPrompt } = require('../prompt');
const { printResults } = require('../../update/managed-files');
const client = require('../../client');
const packs = require('../../packs/install');

// The flags that TAKE a value. Everything else is a boolean.
//
// A parser that lets any `--flag` swallow the next non-`--` token turns
// `pack remove --force mypack` into { force: 'mypack' } with no positional at
// all — so the command dies with "needs a pack name" while the name is sitting
// right there, and `pack install --yes <url>` silently loses BOTH the flag and
// the URL. Only flags-last worked, which nothing said.
const VALUE_FLAGS = new Set(['ref', 'asset', 'file']);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k) && args[i + 1] && !args[i + 1].startsWith('--')) out[k] = args[++i];
    else out[k] = true;
  }
  return out;
}

function root() {
  return findProjectRoot(process.cwd()) || process.cwd();
}

function die(e) {
  console.error(e && e.userFacing ? `\n${e.message}\n` : `\npack failed: ${(e && e.message) || e}\n`);
  process.exit(1);
}

const tierOf = (o) => (o.global || o.system ? 'system' : 'local');
const tierWord = (t) => (t === 'system' ? 'all projects' : 'this project');

// Tell a running daemon that the component set moved, so an open surface
// refreshes instead of showing a stale drawer until someone reloads. Best
// effort: no daemon is not an error, it just means nobody is watching.
async function announce(name) {
  const port = discoverPort({ role: 'server', root: root(), env: true });
  if (!port) return false;
  try {
    await client.request(port, 'POST', '/api/packs/announce', { pack: name }, { timeout: 3000 });
    return true;
  } catch { return false; }
}

function provenance(source) {
  if (!source) return 'unknown source';
  const bits = [];
  if (source.via === 'release') {
    bits.push(`release ${source.ref}`, source.sums_verified ? 'sha256 verified' : 'UNVERIFIED', String(source.sha || '').slice(0, 7));
  } else {
    bits.push(`tarball @ ${String(source.sha || '').slice(0, 7)}`);
  }
  // Which transport fetched it. Worth showing: `gh` means the install was
  // authenticated as you, which is the only way a private pack arrives at all.
  if (source.transport === 'gh') bits.push('via gh');
  return bits.join(' · ');
}

function afterInstall(out, { tier }) {
  console.log('');
  printResults(out.results);
  console.log('');
  for (const w of out.warnings || []) console.log(`  note: ${w}`);
  if (out.pack.skill) {
    // Empirically checked against Claude Code 2.1.243: a newly written
    // SKILL.md is picked up mid-session, within a few seconds, with no
    // /exit + reopen. So no restart is claimed here.
    console.log(`  skill  ${out.pack.skill.dest} — Claude picks this up within a few seconds; no restart needed.`);
  }
  if ((out.pack.services || []).length) {
    console.log('');
    console.log(`  ${out.pack.services.length} component(s) carry a host-side service.js. They stay inert until you approve them:`);
    for (const s of out.pack.services) console.log(`    claude-web-chat trust ${s}`);
  }
  console.log('');
  console.log(`  installed for ${tierWord(tier)} — ${provenance(out.pack.source)}`);
  console.log('');
}

// ── install ─────────────────────────────────────────────────────────────────
async function install(url, opts) {
  const tier = tierOf(opts);
  const r = root();
  const prompt = createPrompt({ yes: opts.yes === true, noInput: opts['no-input'] === true });
  try {
    console.log('');
    console.log(`  Installing a pack runs its code.`);
    console.log(`    · its panes run in the surface page with your permissions and no sandbox;`);
    console.log(`    · any service.js is host code, gated behind \`claude-web-chat trust\`;`);
    console.log(`    · its SKILL.md becomes part of Claude's instructions in ${tierWord(tier)}.`);
    console.log(`  If you did not write this pack, \`claude-web-chat pack get ${url}\` downloads it for review instead.`);
    console.log('');
    // --yes must INSTALL. The shared prompt engine deliberately resolves a
    // non-interactive question to its printed DEFAULT, which here is No — that
    // semantic is load-bearing elsewhere (init has gates that must never be
    // taken by --yes, and test/init.test.js pins it), so the override belongs
    // at this call site rather than in the engine.
    const ok = opts.yes === true
      ? (console.log(`  Install ${url} for ${tierWord(tier)}? [y/N]\n  (--yes — installing)`), true)
      : await prompt.confirm(`Install ${url} for ${tierWord(tier)}?`, { def: false });
    if (!ok) { console.log('  nothing installed.\n'); return; }
  } finally { prompt.close(); }

  const out = await packs.installPack({
    url, ref: opts.ref === true ? null : opts.ref, asset: opts.asset === true ? null : opts.asset,
    tier, root: r, replace: opts.replace === true, actor: 'cli', log: (s) => console.log(s),
  });
  afterInstall(out, { tier });
  await announce(out.pack.name);
}

// ── get (quarantine) ────────────────────────────────────────────────────────
async function get(url, opts) {
  const tier = tierOf(opts);
  const out = await packs.quarantinePack({
    url, ref: opts.ref === true ? null : opts.ref, asset: opts.asset === true ? null : opts.asset,
    tier, root: root(), actor: 'cli', log: (s) => console.log(s),
  });
  const rec = out.record;
  console.log('');
  console.log(`  ${rec.name}${rec.version ? ` ${rec.version}` : ''} — downloaded, NOT installed.`);
  console.log(`  ${provenance(rec.source)}`);
  console.log(`  staged at ${path.relative(root(), rec.dir)} — nothing in web-chat reads that directory.`);
  console.log('');
  console.log(`    claude-web-chat pack review ${rec.name}      # manifest, plan, files, SKILL.md`);
  console.log(`    claude-web-chat pack approve ${rec.name}     # install it`);
  console.log(`    claude-web-chat pack discard ${rec.name}     # delete it`);
  console.log('');
  await announce(rec.name);
}

// ── review ──────────────────────────────────────────────────────────────────
function review(name, opts) {
  const r = packs.reviewQuarantine({ name, root: root(), file: opts.file === true ? null : opts.file });
  if (r.text != null) { console.log(r.text); return; }

  const rec = r.record;
  console.log('');
  console.log(`  ${rec.name}${rec.version ? ` ${rec.version}` : ''}`);
  if (rec.description) console.log(`  ${rec.description}`);
  console.log(`  ${provenance(rec.source)} · ${rec.source && rec.source.url}`);
  console.log(`  staged ${rec.staged_at}`);
  console.log('');

  if (r.manifestError) console.log(`  ✗ ${r.manifestError}`);
  for (const e of (r.manifest && r.manifest.errors) || []) console.log(`  ✗ ${e}`);
  for (const w of (r.manifest && r.manifest.warnings) || []) console.log(`  ! ${w}`);
  for (const c of (r.plan && r.plan.collisions) || []) {
    console.log(`  ${c.severity === 'refused' ? '✗' : '!'} ${c.detail}`);
  }
  if ((r.manifest && (r.manifest.errors.length || r.manifest.warnings.length)) || (r.plan && r.plan.collisions.length)) console.log('');

  console.log('  components');
  for (const c of (r.manifest && r.manifest.components) || []) {
    const chips = [c.has_service ? 'service.js — HOST CODE' : null, c.has_seed ? 'seed' : null].filter(Boolean);
    console.log(`    ${c.name}${chips.length ? `  [${chips.join(', ')}]` : ''}`);
    if (c.description) console.log(`      ${c.description}`);
  }
  if ((r.manifest && r.manifest.themes || []).length) {
    console.log('  themes');
    for (const th of r.manifest.themes) console.log(`    ${th.name}`);
  }

  const skill = r.manifest && r.manifest.skill;
  console.log('');
  if (skill && skill.present) {
    console.log('  what this tells Claude (SKILL.md frontmatter)');
    console.log(`    name:        ${skill.name || '(none)'}`);
    console.log(`    description: ${skill.description || '(none)'}`);
    console.log(`    read it in full:  claude-web-chat pack review ${rec.name} --file SKILL.md`);
  } else {
    console.log('  no SKILL.md — the components install, but Claude only finds them by calling list_components.');
  }

  console.log('');
  console.log(`  ${r.tree.length} files:`);
  for (const f of r.tree) console.log(`    ${String(f.bytes).padStart(7)}  ${f.path}`);
  console.log('');
  console.log(`    claude-web-chat pack review ${rec.name} --file <path>   # read any of them`);
  console.log(`    claude-web-chat pack approve ${rec.name}`);
  console.log(`    claude-web-chat pack discard ${rec.name}`);
  console.log('');
}

// ── approve / discard ───────────────────────────────────────────────────────
async function approve(name, opts) {
  const out = packs.approvePack({ name, root: root(), replace: opts.replace === true, actor: 'cli' });
  afterInstall(out, { tier: out.tier });
  await announce(name);
}

async function discard(name) {
  packs.discardPack({ name, root: root(), actor: 'cli' });
  console.log(`\n  discarded ${name}\n`);
  await announce(name);
}

// ── list / info ─────────────────────────────────────────────────────────────
function list(opts) {
  const { packs: installed, quarantined, pending } = packs.listInstalled({ root: root(), verify: opts.verify === true });
  console.log('');
  if (!installed.length) console.log('  no packs installed here');
  for (const p of installed) {
    const drift = opts.verify ? (p.drift ? '  · locally edited' : '  · unmodified') : '';
    console.log(`  ${p.name}${p.version ? ` ${p.version}` : ''}   ${tierWord(p.tier)}${drift}`);
    if (p.description) console.log(`    ${p.description}`);
    console.log(`    ${provenance(p.source)}`);
    console.log(`    components: ${p.components.join(', ') || '—'}${p.skill ? `   skill: ${p.skill.dest}` : '   (no skill)'}`);
    if ((p.services || []).length) console.log(`    services:   ${p.services.join(', ')}  (each needs \`claude-web-chat trust <name>\`)`);
  }
  if (quarantined.length) {
    console.log('');
    console.log('  awaiting review (downloaded, not installed):');
    for (const q of quarantined) {
      console.log(`    ${q.name}${q.version ? ` ${q.version}` : ''}   ${provenance(q.source)}${q.errors.length ? `   ✗ ${q.errors.length} problem(s)` : ''}`);
      console.log(`      claude-web-chat pack review ${q.name}`);
    }
  }
  // Listed apart from the installed packs on purpose — an install that started
  // and never finished is not an install. The transaction rolls its files back,
  // so a marker surviving usually means the process died before it could; re-
  // running the install is the whole recovery.
  //
  // A `rollback-failed` marker is the other case, and it is not the same news:
  // the unwind ran and could not finish, so the tree really is half-applied and
  // the previous bytes are sitting in a snapshot directory this has to name.
  if ((pending || []).length) {
    console.log('');
    console.log('  interrupted installs (started, never finished — nothing is registered):');
    for (const p of pending) {
      const torn = p.status === 'rollback-failed';
      console.log(`    ${p.name}${p.version ? ` ${p.version}` : ''}   ${tierWord(p.tier)}   started ${p.started_at || '?'}${torn ? '   ✗ rollback failed' : ''}`);
      if (torn) {
        if (p.error) console.log(`      ${p.error.split('\n')[0]}`);
        for (const f of p.rollback_errors || []) console.log(`      could not undo: ${f}`);
        if (p.backup_dir) console.log(`      the previous bytes are in ${p.backup_dir}`);
        console.log('      the tree is half-applied — restore from the snapshots above, then re-run the install');
      } else {
        console.log(`      re-run the install to finish it, or delete the marker: ${p.tier === 'system' ? '~/.web-chat' : '.web-chat'}/packs/pending.json`);
      }
    }
  }
  console.log('');
}

function info(name) {
  const r = root();
  const found = require('../../packs/store').findPack(r, name);
  if (found) {
    const { verifyPack } = require('../../packs/tree');
    const v = verifyPack(found.pack, { root: r, tier: found.tier });
    console.log('');
    console.log(`  ${found.pack.name}${found.pack.version ? ` ${found.pack.version}` : ''}   ${tierWord(found.tier)}`);
    if (found.pack.description) console.log(`  ${found.pack.description}`);
    console.log(`  ${provenance(found.pack.source)}`);
    console.log(`  source ${found.pack.source && found.pack.source.url}`);
    console.log(`  installed ${found.pack.installed_at}`);
    console.log('');
    for (const u of v.units) {
      // String() because a refused unit's kind/name came out of a record that by
      // definition did not validate — neither is guaranteed to be a string.
      console.log(`    ${String(u.kind).padEnd(9)} ${String(u.name).padEnd(24)} ${u.state}`);
      // The state alone does not say WHICH path was refused, and that is the
      // only actionable half of a refusal.
      if (u.state === 'refused' && u.refused) console.log(`    ${' '.repeat(9)} ↳ ${u.refused}`);
    }
    console.log('');
    if (v.units.some((u) => u.state === 'refused')) {
      console.log('  a unit above did not validate — nothing will be removed for it, with or without --force\n');
    } else if (v.drift) {
      console.log(`  locally edited — \`pack remove ${name}\` will keep the edited units unless you pass --force\n`);
    }
    return;
  }
  // Not installed — maybe quarantined.
  review(name, {});
}

// ── remove ──────────────────────────────────────────────────────────────────
function remove(name, opts) {
  const out = packs.removePackByName({
    name, root: root(), tier: opts.global || opts.system ? 'system' : null,
    force: opts.force === true, dryRun: opts['dry-run'] === true, actor: 'cli',
  });
  console.log('');
  printResults(out.results);
  console.log('');
  if (opts['dry-run']) { console.log('  (dry run — nothing was removed)\n'); return; }
  if (!out.removedAll) {
    console.log(`  Kept the units you had edited — they are yours now, and complete (a unit is`);
    console.log(`  kept whole, never stripped down to the files you did not touch).`);
    console.log(`  \`claude-web-chat pack remove ${name} --force\` removes them too.`);
    console.log('');
  }
  announce(name);
}

// ── dispatch ────────────────────────────────────────────────────────────────
const USAGE = `usage: claude-web-chat pack <command>

  install <url> [--ref <r>] [--asset <n>] [--global] [--replace] [--yes]
                          fetch and install. --global installs for all projects.
                          --replace overwrites a component you already have.
  get <url> [--ref <r>] [--global]
                          fetch and QUARANTINE for review — nothing is installed.
                          The right default for a pack you did not write.
  review <name> [--file <path>]
                          read a quarantined pack: manifest, plan, files, SKILL.md
  approve <name> [--replace]      install a reviewed pack
  discard <name>                  delete a quarantined pack
  list [--verify]                 what is installed here (--verify finds local edits)
  info <name>                     one pack in detail
  remove <name> [--force] [--global] [--dry-run]
                          uninstall. Removes every unit you have not touched; a unit
                          you HAVE edited is kept whole (--force removes it too).
                          --dry-run reports without removing anything.

A pack is a repository of components plus a Claude skill. Installing one runs its
code: panes are unsandboxed in the surface page, and a service.js is host code
behind \`claude-web-chat trust\`. Read a pack before you install it.

PRIVATE PACKS. If \`gh\` is on your PATH and logged in, it is used to reach
github.com — which is the only way a private pack repository can be fetched at
all, and it also lifts the anonymous API rate limit. Without it, or for any host
that is not GitHub, the plain HTTPS path is used instead. Set WEB_CHAT_NO_GH=1
to force the plain path. Your gh credential is never spent on a non-GitHub host.`;

function pack(args = []) {
  const sub = args[0];
  const opts = flags(args.slice(1));
  const arg = opts._[0];

  const need = (what) => {
    if (!arg) { console.error(`pack ${sub} needs ${what}\n\n${USAGE}`); process.exit(1); }
    return arg;
  };

  try {
    switch (sub) {
      case 'install': return install(need('a repository URL'), opts).catch(die);
      case 'get': case 'download': return get(need('a repository URL'), opts).catch(die);
      case 'review': return review(need('a pack name'), opts);
      case 'approve': return approve(need('a pack name'), opts).catch(die);
      case 'discard': return discard(need('a pack name')).catch(die);
      case 'list': case 'ls': return list(opts);
      case 'info': return info(need('a pack name'));
      case 'remove': case 'rm': case 'uninstall': return remove(need('a pack name'), opts);
      default:
        console.error(sub ? `unknown pack command: ${sub}\n\n${USAGE}` : USAGE);
        process.exit(sub ? 1 : 0);
    }
  } catch (e) { die(e); }
}

module.exports = pack;
