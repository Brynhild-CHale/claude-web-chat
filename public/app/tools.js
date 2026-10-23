// The tools in the chrome (annotation engine 2D.7; DECISIONS.md I.6 addenda
// 1–2, K.2-3, K.2-14; notes-read-toolbar.md W-7, W-11): which tool a slot or a
// key binding means, and arming it — over the chrome's ONE armed-tool state,
// the overlay's (public/app/overlay.js setArmed / armed / onArmedChange). This
// module keeps no second copy of what is armed, nor of its profile.
//
//   arm(target)        target: POINTER (or null) — the pointer tool, armable
//                      anywhere, as setArmed(null); {kind: 'slot', n} — the
//                      tool the CURRENT project pins at slot n; {kind: 'tool',
//                      type, profile?, label?, pack?} (a type string is
//                      {kind: 'tool', type}). → {ok: true, armed} or
//                      {ok: false, notice}; never throws.
//   disarm()           put whatever is armed down.
//   toggle(target)     pressing an armed tool's key again puts it down: the
//                      target's tool (and profile) armed now → disarm, else arm.
//   armSlot(n)         pinned[n-1] of this project's record (toolbar-state.js:
//                      the daemon's default `pinned` included); an empty slot
//                      is the notice "Slot n is empty in this project".
//   armTool(type, profile?, binding?)  setArmed(type, profile) when GET
//                      /api/toolbar's tools[] lists the type — hidden or not: a
//                      hidden tool is armed without pinning ("visiting": chrome
//                      state only, nothing is written); else the not-installed
//                      notice carrying the binding's data.
//   listedTools()      tools[] as toolbar-state.js last read it.
//   visiting()         the armed type when the project does not pin it, else null.
//   NOTICE             the chrome bus event every refusal goes out on.
//   initTools()        the hotkey registry's 'slot' and 'tool' target kinds and
//                      the 'tools' default source (idempotent).
//
// Refusals are notices, never throws: ONE chrome bus event,
//   bus.emit('tools:notice', {kind, text, type?, label?, pack?})
//   kind 'slot-empty'     "Slot n is empty in this project"
//        'read-only'      "Read-only while previewing <label>" — a type tool
//                         while a previous node is previewed (mounts.js
//                         contentReadOnly, D2); the pointer is still armable
//        'view-only'      "View only: tools need full access" — a type tool
//                         when toolbarState().canWrite is false (the one "may
//                         act" fact; H-6 a, element-policy's FLOOR_RULES)
//        'not-installed'  a tool binding whose type tools[] does not list: its
//                         type and label, and — ONLY for a binding from the
//                         user record — pack {name, source}. The project tier
//                         never carries a pack (lib/core/toolbar-record refuses
//                         it), and a target that is not one of the user
//                         record's own binding objects never passes one on.
// This module draws nothing (C2 b): the toolbar (U338) draws the notices, a
// pack's strings as text; the not-installed prompt (W-11) reads the same event
// later. NOTHING HERE INSTALLS, APPROVES, TRUSTS OR FETCHES: an install is the
// host's, through the drawer's Manage flow and lib/packs/install with its
// approval unchanged, and no notice offers one.
//
// Hotkeys (public/app/hotkeys.js, U333's seams): a {kind: 'slot', n} binding
// runs toggle of that slot, a {kind: 'tool', …} binding toggle of that tool —
// a type that is not listed resolves to its not-installed notice, never to an
// install. The 'tools' default source gives, after the chrome's own defaults,
// each listed type's manifest `arm` hotkey ({chord, target: {kind: 'tool',
// type}, label}; a chord the chrome already holds is left unbound and listed by
// conflicts(), D-7) and the slot keys 1–9 → {kind: 'slot', n} (G2 a: "Slot
// keys 1–9 follow the pinned order").
import { bus } from './bus.js';
import { setArmed, armed } from './overlay.js';
import { toolbarState } from './toolbar-state.js';
import { registerTargetKind, setDefaultSource } from './hotkeys.js';
import { POINTER } from './input-mode.js';
import { contentReadOnly } from './mounts.js';
import { view } from './state.js';
import { labelFor } from './labels.js';

export const NOTICE = 'tools:notice';
export const SLOTS = 9;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPointer = (t) => t == null || t === POINTER || (isObject(t) && t.id === POINTER.id && t.chrome === true);

export function listedTools() {
  const tools = toolbarState().tools;
  return Array.isArray(tools) ? tools.filter((t) => isObject(t) && typeof t.type === 'string' && t.type) : [];
}

const toolOf = (type) => listedTools().find((t) => t.type === type) || null;
const pinned = () => {
  const p = toolbarState().project;
  return p && Array.isArray(p.pinned) ? p.pinned : [];
};

export function visiting() {
  const a = armed();
  return a && !pinned().includes(a.type) ? a.type : null;
}

function notice(detail) {
  bus.emit(NOTICE, Object.freeze({ ...detail }));
  return { ok: false, notice: detail };
}

// The pack a binding names, only when the binding IS one of the user record's
// own targets (the records are handed out by reference: lib/core/tier-merge,
// hotkeys.js and toolbar-state.js never copy them).
function userTierPack(binding) {
  if (!isObject(binding) || !isObject(binding.pack)) return null;
  const user = toolbarState().user;
  const own = user && isObject(user.bindings) ? Object.values(user.bindings) : [];
  if (!own.includes(binding)) return null;
  const { name, source } = binding.pack;
  return typeof name === 'string' && typeof source === 'string' ? { name, source } : null;
}

// Why a type tool may not be armed now, as a notice detail, or null.
function refusal() {
  if (contentReadOnly()) {
    return { kind: 'read-only', text: `Read-only while previewing ${labelFor(view.viewedId)}` };
  }
  if (toolbarState().canWrite === false) return { kind: 'view-only', text: 'View only: tools need full access' };
  return null;
}

export function disarm() {
  setArmed(null);
  return { ok: true, armed: null };
}

export function armTool(type, profile, binding) {
  if (typeof type !== 'string' || !type) return notice({ kind: 'not-installed', text: 'That tool is not installed in this project' });
  const why = refusal();
  if (why) return notice({ ...why, type });
  if (!toolOf(type)) {
    const label = isObject(binding) && typeof binding.label === 'string' && binding.label ? binding.label : type;
    const detail = { kind: 'not-installed', text: `${label} is not installed in this project`, type, label };
    const pack = userTierPack(binding);
    if (pack) detail.pack = pack;
    return notice(detail);
  }
  setArmed(type, typeof profile === 'string' && profile ? profile : null);
  return { ok: true, armed: armed() };
}

export function armSlot(n) {
  if (!Number.isInteger(n) || n < 1 || n > SLOTS) return notice({ kind: 'slot-empty', text: `Slot ${n} is empty in this project` });
  const type = pinned()[n - 1];
  if (!type) return notice({ kind: 'slot-empty', text: `Slot ${n} is empty in this project` });
  return armTool(type, null, null);
}

export function arm(target) {
  if (isPointer(target)) return disarm();
  if (typeof target === 'string') return armTool(target, null, null);
  if (!isObject(target)) return notice({ kind: 'not-installed', text: 'That tool is not installed in this project' });
  if (target.kind === 'slot') return armSlot(target.n);
  if (target.kind === 'tool') return armTool(target.type, target.profile, target);
  return notice({ kind: 'not-installed', text: 'That tool is not installed in this project' });
}

// The type and profile a target means now (a slot through this project's
// pinned list), or null for the pointer and an empty slot.
function meant(target) {
  if (isPointer(target)) return null;
  if (typeof target === 'string') return { type: target, profile: null };
  if (!isObject(target)) return null;
  if (target.kind === 'slot') {
    const type = Number.isInteger(target.n) ? pinned()[target.n - 1] : null;
    return type ? { type, profile: null } : null;
  }
  if (target.kind === 'tool' && typeof target.type === 'string') {
    return { type: target.type, profile: typeof target.profile === 'string' && target.profile ? target.profile : null };
  }
  return null;
}

export function toggle(target) {
  const now = armed();
  const want = meant(target);
  if (now && want && now.type === want.type && (now.profile || null) === want.profile) return disarm();
  return arm(target);
}

// ── the hotkey registry's seams ─────────────────────────────────────────────

function slotDefaults() {
  const out = [];
  for (let n = 1; n <= SLOTS; n++) out.push({ chord: String(n), target: { kind: 'slot', n }, label: `Slot ${n}` });
  return out;
}

function toolDefaults() {
  const out = [];
  for (const t of listedTools()) {
    for (const h of Array.isArray(t.hotkeys) ? t.hotkeys : []) {
      if (!isObject(h) || h.action !== 'arm' || typeof h.default !== 'string' || !h.default) continue;
      out.push({ chord: h.default, target: { kind: 'tool', type: t.type },
        label: typeof h.label === 'string' && h.label ? h.label : (t.label || t.type) });
    }
  }
  return out;
}

let inited = false;
export function initTools() {
  if (inited) return;
  inited = true;
  registerTargetKind('slot', (target) => ({
    run: () => toggle({ kind: 'slot', n: target.n }),
    label: `Slot ${target.n}`,
    context: 'page',
  }));
  registerTargetKind('tool', (target) => {
    const tool = toolOf(target.type);
    return {
      run: () => toggle(target),
      label: (tool && tool.label) || (typeof target.label === 'string' && target.label) || target.type,
      context: 'page',
    };
  });
  setDefaultSource('tools', () => [...toolDefaults(), ...slotDefaults()]);
}
