// The annotation engine's per-type remote policy (decision A4): what each
// element type lets a remote viewer see and send, and the rows that follows
// into the portal's and the daemon's tables. lib/core/remote-policy.js is the
// one reader: it compiles BUILTIN_ELEMENT_TYPES once, at load, into RULES
// (the floor rows), FRAME_RULES (one `element:<type>` row a type) and
// PRIVATE_RULES (the frame paths a private type's records are dropped from);
// the daemon's element routes read `typeGates` through it.
//
// THE FLOOR. A type's gate is `{see, send}`, each a mirror level: `see` the
// least level that gets its records, `send` the least that may write one. The
// floor is read to see and full to send (A4), and a type may only TIGHTEN it
// (see 'full', or 'local' for a type no remote viewer ever gets); a
// descriptor that would LOOSEN it — see below 'read', send below 'full', or
// send below see — is refused with a TypeError naming the type. 2C refuses
// such a pack at approve; nothing here ever widens what a remote viewer gets.
//
// WHAT THE PORTAL CARRIES. Only the type-agnostic floor rows (`floorRules`):
// the element routes are `/api/elements/*` whatever the type, so a plug-in
// type never needs a portal restart. The per-type gate is the daemon's
// (`typeGates`, read by 2B/2C's routes through audience.requireMirror), and
// so are the per-type frame rows (the daemon projects every frame itself).
//
// PRIVATE (decision A2): hidden from Claude's tools and from every remote
// viewer; local sockets on this machine see it. A type that may hold private
// records (`private: true`) has its frames' records filtered by
// remote-policy's dropPrivate before any non-local socket gets them: every
// record with `shared === false` is dropped from the frame's `elements` list
// (`privatePaths`). An element frame therefore carries its type's records as
// a list under `elements` — the shape the comments frame has under `comments`.
//
// No element.json exists in tranche 1: the three built-ins are declared here,
// statically. 2C compiles approved records and adds the ratchet that holds
// each built-in's element.json equal to its row here.
//
// Zero imports: remote-policy requires this file (the portal process loads
// both), so it may require nothing — not even remote-policy's level order.
// GATE_LEVELS is the part of that order a gate may name, and remote-policy
// checks it against MIRROR_LEVELS when it loads, so the two cannot drift.

// The levels a gate may name, least first: MIRROR_LEVELS from `read` up.
const GATE_LEVELS = Object.freeze(['read', 'full', 'local']);
const FLOOR = Object.freeze({ see: 'read', send: 'full' });

// The anchor families (decision C1): where an element is anchored decides how
// it versions, not a declaration.
const ELEMENT_FAMILIES = Object.freeze(['page', 'graph', 'chat']);

// A type name: lowercase kebab, as a component name is, at most 40.
const TYPE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TYPE_MAX = 40;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rank = (level) => GATE_LEVELS.indexOf(level);

function refuse(type, why) {
  const name = typeof type === 'string' ? JSON.stringify(type) : 'a descriptor';
  return new TypeError(`element-policy: element type ${name}: ${why}`);
}

// A descriptor → its normalized, frozen copy, or a TypeError that names the
// type and what is wrong: not an object, a type that is not kebab, a family
// that is not an anchor family, a gate level that is not one, a gate below the
// floor, `send` below `see`, or `private` not a boolean. Never mutates `d`.
function validateDescriptor(d) {
  if (!isObject(d)) throw refuse(undefined, 'a descriptor is an object');
  const { type, family, remote } = d;
  if (typeof type !== 'string' || type.length > TYPE_MAX || !TYPE_RE.test(type)) {
    throw refuse(type, `the type is a lowercase kebab name of at most ${TYPE_MAX} characters`);
  }
  if (!ELEMENT_FAMILIES.includes(family)) {
    throw refuse(type, `the family is one of ${ELEMENT_FAMILIES.join(', ')} (got ${JSON.stringify(family)})`);
  }
  if (!isObject(remote)) throw refuse(type, 'remote is {see, send}');
  for (const k of ['see', 'send']) {
    // `basic`, the one mirror level below every gate, is a loosening too.
    if (remote[k] === 'basic' || (rank(remote[k]) !== -1 && rank(remote[k]) < rank(FLOOR[k]))) {
      throw refuse(type, `remote.${k} ${JSON.stringify(remote[k])} loosens the floor (${k} at least ${FLOOR[k]})`);
    }
    if (rank(remote[k]) === -1) {
      throw refuse(type, `remote.${k} is one of ${GATE_LEVELS.join(', ')} (got ${JSON.stringify(remote[k])})`);
    }
  }
  if (rank(remote.send) < rank(remote.see)) {
    throw refuse(type, `remote.send ${JSON.stringify(remote.send)} is below remote.see ${JSON.stringify(remote.see)}`);
  }
  if ('private' in d && typeof d.private !== 'boolean') throw refuse(type, 'private is true or false');
  return Object.freeze({
    type, family,
    remote: Object.freeze({ see: remote.see, send: remote.send }),
    private: d.private === true,
  });
}

// The three built-in types (2C.4; box-grab per ruling box-grabs@2C.4), each
// at the floor and able to hold private records.
const BUILTIN_ELEMENT_TYPES = Object.freeze(['comment', 'highlight', 'box-grab'].map((type) => validateDescriptor({
  type, family: 'page', remote: { see: 'read', send: 'full' }, private: true,
})));

// The portal's rows for every element route, whatever the type, in first-match
// order: the search add-on's row (4E's, declared now so 4E needs no second
// protocol bump; its body filter is the daemon's), a read, the writes, and
// everything else under /api/elements refused. No hint: remote-policy words
// them (the hints are its; this file has no words a viewer reads).
const FLOOR_RULES = Object.freeze([
  Object.freeze({ methods: Object.freeze(['GET']), path: '/api/elements/search', allow: true, mirror: FLOOR.see }),
  Object.freeze({ methods: Object.freeze(['GET']), path: '/api/elements/*', allow: true, mirror: FLOOR.see }),
  Object.freeze({ methods: Object.freeze(['POST', 'PATCH', 'DELETE']), path: '/api/elements/*', allow: true, mirror: FLOOR.send }),
  Object.freeze({ methods: '*', path: '/api/elements/*', allow: false }),
]);

// The frame type an element type's frames are sent as.
const frameType = (type) => `element:${type}`;
// What dropPrivate drops from a private type's frame: its records' list.
const PRIVATE_FRAME_PATHS = Object.freeze(['elements[]']);

// descriptors → { floorRules, typeGates, frames, privatePaths }, all frozen.
// Pure and deterministic: the same descriptors in any order give deep-equal
// output (sorted by type). Throws a TypeError for a descriptor
// validateDescriptor refuses, or for a type declared twice.
function compileElementPolicy(descriptors) {
  if (!Array.isArray(descriptors)) throw new TypeError('element-policy: compileElementPolicy takes a list of descriptors');
  const seen = new Set();
  const all = descriptors.map((d) => {
    const v = validateDescriptor(d);
    if (seen.has(v.type)) throw refuse(v.type, 'declared twice');
    seen.add(v.type);
    return v;
  }).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const typeGates = {};
  const frames = [];
  const privatePaths = {};
  for (const d of all) {
    typeGates[d.type] = Object.freeze({ see: d.remote.see, send: d.remote.send });
    frames.push(Object.freeze({ type: frameType(d.type), level: d.remote.see }));
    if (d.private) privatePaths[frameType(d.type)] = PRIVATE_FRAME_PATHS;
  }
  return Object.freeze({
    floorRules: FLOOR_RULES,
    typeGates: Object.freeze(typeGates),
    frames: Object.freeze(frames),
    privatePaths: Object.freeze(privatePaths),
  });
}

module.exports = {
  BUILTIN_ELEMENT_TYPES, ELEMENT_FAMILIES, GATE_LEVELS, FLOOR,
  validateDescriptor, compileElementPolicy, frameType,
};
