// lib/server/control/pack-approve.js — approving a quarantined pack that ships
// ELEMENT TYPES, by a person, from the isolated origin (DECISIONS.md K.4: H3 a,
// I3 b, with the maintainer's note and the main session's reading (i)-(iv)).
//
//   installPackApprove(control, {root, paths, bus, packs, log})
//     → {unregister(), params(source), describe(target), check(target, reqCtx), run(target)}
//   `paths` is the server's resolvePaths(root) (the theme reset reads it);
//   `packs` is lib/packs/install (a test seam).
//
// An element type's draw.js runs in the surface page's own realm, so a pack
// that ships one installs only after a person read its review and approved it,
// and no pane can do that for them (H3 a). The main origin's approve route
// (POST /api/packs/quarantine/:name/approve, lib/server/routes/packs.js) is
// reachable by any pane's fetch and so refuses such a pack (409
// 'element-approve'); the two ways in are this row — a click in a confirm
// frame on the answer origin, whose nonce pane script can neither read nor
// forge (C46, as Restore and Fork) — and `claude-web-chat pack install` /
// `pack approve` at a terminal.
//
// It adds ONE row, 'pack-approve', to the control domain's action table (U81,
// lib/server/control/index.js) — never by editing that table:
//
//   fields ['name', 'tier']       the POST body, exactly (the card mounts
//                                 {action: 'pack-approve', params: {name, tier}})
//   params                        name: a pack name (lib/packs/manifest
//                                 assertSafeName); tier: 'local', or 'system' /
//                                 'global' (the user tier, read as 'system')
//   key                           '<name>:<tier>' (binds the frame's nonce)
//   layouts ['confirm'], limit {scope: 'project', ms: 5000}
//   describe → the review the person reads in the frame, text only (the frame
//              sets it with textContent, through its own palette): the pack's
//              name, version and tier, its source URL, each element type with
//              'draw.js runs in the surface page', its components (service.js
//              marked host code), services, themes and skill, and any reason it
//              cannot install. Nothing the pack wrote reaches the frame but
//              its names (kebab grammar) and its description, quoted as its
//              own claim, both through lib/core/text stripControls.
//   check   → (the staged element types: routes/packs.js stagedElementTypes,
//             the one reading the approve route's refusal shares)
//             'not-quarantined' (nothing staged under that name here),
//             'no-element-types' (a component or theme pack keeps its own route
//             and its 'Install it' button), 'host-only' (a user-tier approve by
//             a viewer that is not the host — K.1 C4: user-tier writes are the
//             host's), each with a hint naming the terminal command.
//   run     → lib/packs/install approvePack({name, root, tier, replace: false,
//             actor: 'control'}) — the same transaction the route and the CLI
//             run, the pack audit recording actor 'control' — then the packs
//             change exactly as the route announces it (routes/packs.js
//             packsAnnouncer: the `packs` event, which the element-type
//             registry invalidates on, the packs:changed and components frames,
//             and a theme reset when the update dropped the active theme).
//             → {ok: true, said: 'Installed <name>: <types>'} (the frame's
//             'done' line) | {ok: false, refused: 'install-refused', hint}.
//
// The control domain's invoke() writes the one audit line ({name, tier}: ids
// only), as for Fork. No `control` event: nothing reads one for an approve
// (the main bus's `packs` event is the record), and no notice: Claude learns of
// a new element type from the type registry, not from a one-shot notice.

const { stripControls } = require('../../core/text');
const { assertSafeName } = require('../../packs/manifest');
const defaultPacks = require('../../packs/install');
const { packsAnnouncer, stagedElementTypes } = require('../routes/packs');
const { resolvePaths } = require('../paths');
const { BadTarget } = require('./index');

const ACTION = 'pack-approve';
const APPROVE_LIMIT_MS = 5000;
const TIERS = Object.freeze({ local: 'local', system: 'system', global: 'system' });
const SAID_MAX = 120;
const TEXT_MAX = 280;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (s, max = TEXT_MAX) => stripControls(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, max);
const tierWord = (t) => (t === 'system' ? 'all projects' : 'this project');

const HINTS = Object.freeze({
  'not-quarantined': (name) => `nothing is quarantined under "${name}" in this project — download it for review first (＋ → Manage → Download for review, or claude-web-chat pack get <url>)`,
  'no-element-types': (name) => `"${name}" ships no element type: install it with Install it on its card, or claude-web-chat pack approve ${name}`,
  'host-only': (name) => `installing for all projects is the host's to do: run claude-web-chat pack approve ${name} in a terminal on the machine running web-chat`,
});

function errorsOf(review) {
  const rec = review && isPlain(review.record) ? review.record : {};
  const man = review && isPlain(review.manifest) ? review.manifest : {};
  const out = [...(Array.isArray(man.errors) ? man.errors : []), ...(Array.isArray(rec.errors) ? rec.errors : [])];
  if (review && review.manifestError) out.unshift(review.manifestError);
  return [...new Set(out.filter((e) => typeof e === 'string' && e))];
}

function installPackApprove(control, {
  root,
  paths = null,
  bus = null,
  packs = defaultPacks,
  log = () => {},
} = {}) {
  if (!control || typeof control.action !== 'function') throw new TypeError('installPackApprove needs the control domain');
  if (typeof root !== 'string' || !root) throw new TypeError('installPackApprove needs root');
  const say = (m) => { try { log(m); } catch { /* a logger never breaks an approve */ } };
  const announcer = bus && typeof bus.emit === 'function' ? packsAnnouncer({ bus, paths: paths || resolvePaths(root) }) : null;

  // The staged pack's review (lib/packs/install reviewQuarantine), or null.
  function reviewOf(name) {
    try { return packs.reviewQuarantine({ name, root }); } catch { return null; }
  }

  function params(source) {
    const s = isPlain(source) ? source : {};
    const name = s.name;
    if (typeof name !== 'string') throw new BadTarget('name: a pack name');
    try { assertSafeName(name); } catch { throw new BadTarget('name: a pack name'); }
    const tier = typeof s.tier === 'string' && Object.hasOwn(TIERS, s.tier) ? TIERS[s.tier] : null;
    if (!tier) throw new BadTarget("tier: 'local' or 'system'");
    return { name, tier };
  }

  async function describe(target) {
    const title = 'Approve and install';
    const review = reviewOf(target.name);
    if (!review) return { title, summary: `Nothing is quarantined under "${target.name}" in this project.` };
    const rec = isPlain(review.record) ? review.record : {};
    const types = stagedElementTypes(target.name, root, review);
    const version = rec.version ? ` ${clean(rec.version, 40)}` : '';
    const summary = types.length
      ? `Install the pack "${target.name}"${version} for ${tierWord(target.tier)}? It ships element type${types.length === 1 ? '' : 's'} whose draw.js runs in the surface page, with this page's permissions.`
      : `"${target.name}" ships no element type: install it with Install it on its card.`;
    const lines = [];
    const src = isPlain(rec.source) ? rec.source : {};
    if (src.url) lines.push(`From ${clean(src.url)}${src.sha ? ` @ ${clean(String(src.sha).slice(0, 7), 7)}` : ''}`);
    if (rec.description) lines.push(`Its description says: “${clean(rec.description, 200)}”`);
    const staged = Array.isArray(rec.elements) ? rec.elements : [];
    for (const name of types) {
      const el = staged.find((e) => e && e.name === name) || {};
      const bits = [];
      if (el.schema) bits.push(`schema ${clean(el.schema, 60)}`);
      if (Array.isArray(el.anchors) && el.anchors.length) bits.push(`anchors ${clean(el.anchors.join(', '), 80)}`);
      bits.push(el.draw || el.draw === undefined ? 'draw.js runs in the surface page' : 'no draw.js');
      lines.push(`Element type ${name} — ${bits.join(' · ')}`);
    }
    for (const c of Array.isArray(rec.components) ? rec.components : []) {
      if (!c || typeof c.name !== 'string') continue;
      lines.push(`Component ${clean(c.name, 64)}${c.has_service ? ' — service.js is host code, inert until claude-web-chat trust' : ''}`);
    }
    for (const th of Array.isArray(rec.themes) ? rec.themes : []) {
      if (th && typeof th.name === 'string') lines.push(`Theme ${clean(th.name, 64)}`);
    }
    if (rec.skill) lines.push('Its SKILL.md becomes part of Claude’s instructions');
    for (const e of errorsOf(review)) lines.push(`Cannot install: ${clean(e)}`);
    lines.push(`Every file: claude-web-chat pack review ${target.name}`);
    return { title, summary, lines };
  }

  const refuse = (code, name) => ({ refused: code, hint: HINTS[code](name) });

  async function check(target, reqCtx) {
    const review = reviewOf(target.name);
    if (!review) return refuse('not-quarantined', target.name);
    if (!stagedElementTypes(target.name, root, review).length) return refuse('no-element-types', target.name);
    if (target.tier === 'system' && isPlain(reqCtx) && reqCtx.remote === true) return refuse('host-only', target.name);
    return null;
  }

  async function run(target) {
    const types = stagedElementTypes(target.name, root, reviewOf(target.name));
    let out;
    try {
      out = packs.approvePack({ name: target.name, root, tier: target.tier, replace: false, actor: 'control', log: say });
    } catch (e) {
      if (e && e.userFacing) {
        return { ok: false, refused: 'install-refused', hint: clean(String(e.message || '').split('\n')[0], 300) || 'the pack could not be installed' };
      }
      throw e;
    }
    if (announcer) {
      try {
        announcer.changed({ op: 'approve', pack: out.pack.name, tier: out.tier });
        if (out.theme_reset) announcer.themeReset(out.theme_reset, 'pack-updated');
      } catch (e) { say(`control: pack-approve announce failed (${e && e.code || 'error'})`); }
    }
    const said = `Installed ${out.pack.name}${types.length ? `: ${types.join(', ')}` : ''}`;
    return { ok: true, said: said.length > SAID_MAX ? `${said.slice(0, SAID_MAX - 1)}…` : said };
  }

  const unregister = control.action(ACTION, {
    fields: ['name', 'tier'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: APPROVE_LIMIT_MS },
    params,
    key: (target) => `${target.name}:${target.tier}`,
    describe,
    check,
    run,
  });

  return { unregister, params, describe, check, run };
}

module.exports = { installPackApprove, ACTION, APPROVE_LIMIT_MS, HINTS };
