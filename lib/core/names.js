// lib/core/names.js — what is a legal component name, in one place.
//
// A component name is not decoration: it BECOMES A DIRECTORY. Every writer
// (`POST /api/components`, the components registry, a pack's manifest/plan/tree)
// joins it to a tier directory, and every reader joins it again to resolve
// `component.html` / `seed.js` / `service.js`. So exactly two rules govern it,
// and they are declared here rather than at each of those sites:
//
//   1. THE GRAMMAR. `^[a-z][a-z0-9-]*$` — plain kebab-case, no dots, no slashes,
//      no `..`, no leading dash. It is a containment rule wearing a style rule's
//      clothes: a name that cannot contain a separator cannot escape its parent.
//   2. THE RESERVED LIST. The six builtin components below are a HARD refusal,
//      in either tier, for either actor, with no override. `seedBuiltins`
//      (lib/server/builtins.js) only refreshes a directory whose meta.json says
//      `builtin: true`, so anything that writes a same-named directory WITHOUT
//      that marker wins permanently — the real builtin never comes back and
//      every later fix to it silently fails to land.
//
// The list lives in core rather than in lib/server because lib/packs needs it
// too, and `lib/packs → lib/server` is backwards. Dependency direction: this
// file imports nothing at all, from lib/ or anywhere.
//
// Pack names share the GRAMMAR but not the RESERVED LIST (a pack is checked
// against reserved *skill* names, which derive from lib/update/managed-files and
// so cannot live in core). That is why `reserved` is an explicit option rather
// than an assumption — see `assertComponentName`.

// The one declaration of the kebab grammar. test/conventions.test.js ratchets
// this literal to this file: a second copy anywhere under lib/ or public/ fails
// the build.
const COMPONENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

// The one list of reserved component names. Frozen because a mutation here would
// be a silent hole in every refusal downstream; callers that need a mutable copy
// (`reservedComponentNames()`) slice it.
const BUILTIN_COMPONENTS = Object.freeze([
  'form-renderer',
  'node-render',
  'website',
  'git-dashboard',
  'file-editor',
  'web-chat-tour',
]);

// Non-throwing predicate. Required because a pack manifest COLLECTS every
// problem rather than throwing at the first one (lib/packs/manifest.js
// validateManifest) — an assert-only engine could not serve that caller.
function isComponentName(name) {
  return typeof name === 'string' && COMPONENT_NAME_RE.test(name);
}

// Case-SENSITIVE membership, matching the `BUILTINS.includes(name)` it replaces.
// Deliberately unlike the theme library, which resolves builtin theme names
// case-insensitively: a component name with an uppercase letter fails the
// grammar first, so case-folding here would only ever mask a name that is
// already refused.
function isReservedComponentName(name) {
  return BUILTIN_COMPONENTS.includes(name);
}

// The assertion every writer calls before a name becomes a path.
//
// Throws a `userFacing` Error carrying a `code` — 'name-invalid' or
// 'name-reserved' — so each caller can map one refusal onto its own wire shape
// (a 400 `{error}` from the components route, a 200 `{ok:false, hint}` from the
// packs route, a raw throw in the CLI) without re-deciding what is legal.
//
//   what     — how the name is described in the message ('component name',
//              'pack name', 'unit name'). Shapes the wording only.
//   reserved — check the builtin list too. FALSE for pack names, which have a
//              different reserved set; passing true there would refuse a pack
//              for sharing a name with a component, which is not the rule.
function assertComponentName(name, { what = 'component name', reserved = true } = {}) {
  const n = String(name == null ? '' : name);
  if (!isComponentName(n)) {
    const e = new Error(`${what} ${JSON.stringify(n)} is not a plain kebab-case name, and that name is used to build a directory path — refused.`);
    e.userFacing = true;
    e.code = 'name-invalid';
    throw e;
  }
  if (reserved && isReservedComponentName(n)) {
    const e = new Error(`"${n}" is a built-in component name. A copy under that name would shadow the built-in permanently — web-chat only repairs a component whose meta.json says builtin. Refused, in either tier, for either actor; there is no override.`);
    e.userFacing = true;
    e.code = 'name-reserved';
    throw e;
  }
  return n;
}

module.exports = {
  COMPONENT_NAME_RE,
  BUILTIN_COMPONENTS,
  isComponentName,
  isReservedComponentName,
  assertComponentName,
};
