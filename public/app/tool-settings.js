// The settings-pane host (annotation engine 2D.6; DECISIONS.md I.6 "a settings
// pane (small) / (large)"; notes-read-toolbar.md W-9). An annotation tool's
// settings open in one of two chrome frames:
//
//   small  anchored to the toolbar slot that opened it: below the anchor, or
//          flipped above it, clamped inside the viewport with a 16 px gutter
//          and placed again on every resize. Under 760 px it sits above the
//          bottom bar instead. The pin composer is the only other chrome panel
//          that positions itself.
//   large  a centred panel (app.css places it; no script).
//
//   openToolSettings({type, level, anchor?, schema, value, profile?, readOnly?,
//                     label, content?})
//     → {ok: true, close(), ready}   ready: a promise of {ok} once the form is
//                                   up, or {ok: false, refused, hint}
//     → {ok: false, refused, hint}  for tool-drawn content ('tool-drawn'), a
//                                   level that is not small or large
//                                   ('bad-level'), no type ('bad-type'), or a
//                                   schema whose root is not {type: 'object',
//                                   properties} ('bad-schema')
//   closeToolSettings()  · isToolSettingsOpen() · initToolSettings()
//
// THE CALLER supplies the schema and the current value (U338 reads both from
// toolbar-state.js), so this host fetches no tool data. It does not re-validate
// the schema: the daemon validated it at pack review (lib/core/settings-schema),
// and the chrome cannot require lib/core. Its only check is the cheap root test.
// `profile` names the profile whose settings Save replaces. When it is left
// out and the armed tool is this type, the armed profile is used
// (overlay.js armed().profile, K.2-14). Pass null to edit the plain settings.
//
// THE CONTENT is the schema path only. The builtin form-renderer component
// draws it, from GET /api/components/form-renderer. It is the one schema-form
// renderer, so the host never keeps a second copy. The component is mounted
// into the frame's one shadow host through the mount runtime
// (window.__wcMount.attachAndExtract and runScripts, its one eval home) over a
// DETACHED store (createStore with a publish hook). The hook catches the
// form's one store.set({[submit_key]: values}) and writes the values to this
// project's toolbar record, through toolbar-state.js's patchToolbar:
// {settings: {[type]: payload}} — the type's whole payload, the other level's
// fields carried from the project tier (K.2-87) — or {profiles: {[type]:
// list}} with the named profile's settings replaced. The values never reach the live store (it
// folds into graph nodes) or browser storage. The user tier's per-tool
// defaults are written only through patchUserToolbar, which this host does
// not call.
//
// runScripts gets NO `life`, as the frozen preview and export pass none.
// That is sound only because form-renderer's script starts no timer,
// subscription, request or listener outside its own root. A test reads its
// component.html and pins that. If form-renderer changes and breaks it, this
// host takes mounts.js's release path; it never grows a teardown list of its
// own. Taking the host out of the frame ends the form.
//
// Tool-drawn content (`content: 'tool'`, a tool drawing its own settings) is
// REFUSED. A third-party pack's script would run in the chrome's realm, so it
// waits for pack review and approval (4A/4B).
//
// THE FRAMES are .popovers registered in the shell's popover registry. An
// outside press, focus leaving, a window blur, another panel opening and
// Escape close them through the shell's ONE dismiss layer and its ONE Escape
// owner, handleEscape. This module adds no listener to the document. The only
// key it hears is Escape from a field inside the frame: the shell's keyboard
// layer leaves a field's keys to the field, so that one press is forwarded to
// handleEscape, the owner. Opening a frame closes the other one first.
//
// THEMING is --wc-* tokens only: app.css's `tool settings (U336)` block for the
// frames. Custom properties cross the shadow boundary and raw CSS does not.
// form-renderer's own style spells its colours, so the host puts one
// token-only <style> into the frame's shadow root, after the component's own.
// This works as theme.js applyPaneTheme's style in a pane's root, and like it
// carries data-wc-chrome. The look is expected to change with the toolbar's
// final mock-up (H-2).
import { registerPopover, handleEscape } from './shell.js';
import { request } from './http.js';
import { toolbarState, patchToolbar } from './toolbar-state.js';
import { armed } from './overlay.js';
import { isNarrow } from './viewport.js';

export const GUTTER = 16;   // px kept clear at every viewport edge
export const GAP = 6;       // px between the anchor (or the bottom bar) and the small frame
export const SUBMIT_KEY = 'tool_settings';   // the detached store's one key
export const TOOL_DRAWN_HINT = 'tool-drawn settings wait for pack review (4A/4B)';
const FORM_COMPONENT = 'form-renderer';

// The token-only style inside the frame's shadow root, over form-renderer's
// own spelled colours. Each selector out-ranks the component's (`:host` adds a
// class's weight) and is appended after it.
export const SHADOW_CSS = [
  ':host .frm { font-family: var(--wc-font); color: var(--wc-fg); }',
  ':host .field > label { color: var(--wc-muted); }',
  ':host .field > label .req, :host .error { color: var(--wc-rust); }',
  ':host .field input[type=text], :host .field input[type=number], :host .field select {'
    + ' background: var(--wc-content-bg); color: var(--wc-content-fg); border-color: var(--wc-border);'
    + ' border-radius: var(--wc-radius-sm); }',
  ':host .field input:focus, :host .field select:focus { outline-color: var(--wc-accent); border-color: var(--wc-accent); }',
  ':host .field input[type=checkbox] { accent-color: var(--wc-accent); }',
  // The Save button (U402a, K.5 J3): its label is --wc-fg on a neutral fill in
  // every state, and the accent marks the control as its border. No accent
  // fill carries a label at 4.5:1 on all six pack-modes (--wc-accent-fg on
  // --wc-accent reads 3.45 earthy light), and this style cannot read the mode.
  // The hover and focus fill, --wc-header-bg, reads 11.34:1 or more with
  // --wc-fg on every pack-mode. That tint alone is not a cue everywhere
  // (georgetown-blue light draws --wc-header-bg and --wc-panel-bg both
  // #ffffff), so the one hover rule also darkens the border to the label's
  // own --wc-fg (U402b, X2/Y2): a visible change on every pack-mode, no
  // per-pack case, and the border pair is the label pair, 11.34:1 or more.
  ':host .submit { background: var(--wc-panel-bg); border-color: var(--wc-accent); color: var(--wc-fg);'
    + ' border-radius: var(--wc-radius-sm); }',
  ':host .submit:hover, :host .submit:focus-visible { background: var(--wc-header-bg); border-color: var(--wc-fg);'
    + ' color: var(--wc-fg); }',
].join('\n');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEditable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const refuse = (refused, hint) => ({ ok: false, refused, hint });

let frames = null;    // {small, large}: each {el, title, sub, hint}
let current = null;   // the open frame's context, or null

function buildFrame(level) {
  const el = document.createElement('div');
  el.className = `popover tool-settings ${level === 'small' ? 'ts-small' : 'ts-large'} hidden`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  const head = document.createElement('div');
  head.className = 'ts-head';
  const title = document.createElement('span');
  title.className = 'ts-title';
  const sub = document.createElement('span');
  sub.className = 'ts-sub';
  head.append(title, sub);
  const hint = document.createElement('p');
  hint.className = 'ts-hint';
  hint.setAttribute('role', 'status');
  el.append(head, hint);
  // Escape from a field inside the frame: the keyboard layer leaves it to the
  // field, so it is forwarded to the one Escape owner. Any other Escape reaches
  // handleEscape through the layer itself, so only a field's is forwarded.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.metaKey || e.ctrlKey) return;
    const src = (e.composedPath && e.composedPath()[0]) || e.target;
    if (isEditable(src)) handleEscape();
  });
  document.body.appendChild(el);
  return { el, title, sub, hint };
}

// Build both frames and register them with the shell's popover registry.
// Idempotent.
export function initToolSettings() {
  if (frames) return;
  const small = buildFrame('small');
  const large = buildFrame('large');
  small.el.id = 'tool-settings-small';
  large.el.id = 'tool-settings-large';
  frames = { small, large };
  for (const f of [small, large]) registerPopover({ el: f.el, close: () => { if (current && current.frame === f) closeToolSettings(); } });
}

export function isToolSettingsOpen() { return !!current; }

export function closeToolSettings() {
  const ctx = current;
  if (!ctx) return;
  current = null;
  window.removeEventListener('resize', ctx.onResize);
  const { el } = ctx.frame;
  const hadFocus = el.contains(document.activeElement);
  el.classList.add('hidden');
  el.style.left = '';
  el.style.top = '';
  // The host goes, and the form goes with it: its one listener is on its own
  // form, inside the shadow root.
  if (ctx.host.parentNode) ctx.host.remove();
  ctx.frame.hint.textContent = '';
  if (hadFocus && ctx.anchor && ctx.anchor.isConnected && typeof ctx.anchor.focus === 'function') {
    try { ctx.anchor.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
}

// The small frame's place, in viewport pixels.
function rectOf(el) {
  const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return r || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

function placeSmall(ctx) {
  const { el } = ctx.frame;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const own = rectOf(el);
  const w = own.width;
  const h = own.height;
  const maxLeft = Math.max(GUTTER, vw - w - GUTTER);
  const maxTop = Math.max(GUTTER, vh - h - GUTTER);
  const a = ctx.anchor && ctx.anchor.isConnected ? rectOf(ctx.anchor) : null;
  let left;
  let top;
  if (isNarrow()) {
    // Above the bottom bar, whatever opened it.
    const bar = document.getElementById('bottombar');
    const b = bar ? rectOf(bar) : null;
    const barTop = b && b.height > 0 ? b.top : vh;
    left = clamp(a ? a.left : GUTTER, GUTTER, maxLeft);
    top = clamp(barTop - GAP - h, GUTTER, Math.max(GUTTER, barTop - GAP - h));
  } else if (a) {
    const below = a.bottom + GAP;
    const above = a.top - GAP - h;
    if (below + h <= vh - GUTTER) top = below;
    else if (above >= GUTTER) top = above;
    else top = clamp(below, GUTTER, maxTop);
    left = clamp(a.left, GUTTER, maxLeft);
  } else {
    left = clamp((vw - w) / 2, GUTTER, maxLeft);
    top = clamp(vh * 0.15, GUTTER, maxTop);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function place(ctx) {
  if (current !== ctx || ctx.level !== 'small') return;
  placeSmall(ctx);
}

function showHint(ctx, text) {
  if (current !== ctx) return;
  ctx.frame.hint.textContent = text ? String(text) : '';
}

// The fields a level's schema declares, from the type's registry row
// (toolbarState().tools, GET /api/toolbar's tools[]): row.settings[level]
// .properties' keys. An unknown row or an undeclared level declares none.
function declared(type, level) {
  const row = toolbarState().tools.find((t) => t.type === type);
  const schema = row && isObject(row.settings) ? row.settings[level] : null;
  return new Set(isObject(schema) && isObject(schema.properties) ? Object.keys(schema.properties) : []);
}

// The type's WHOLE plain payload for the project tier (K.2-87). The record
// merges settings per TYPE (lib/core/toolbar-record: a type's payload
// replaces), so a frame that sent only its own level's fields would drop the
// other level's values at this tier. This frame is the writer that knows both
// levels: it starts from the project tier's current settings[type], read at
// Save time (the profile branch reads its list the same way, so a write
// landed since the frame opened is kept, not clobbered), carries each field
// the OTHER level declares and this one does not, untouched, and overlays the
// frame's values. A key no level declares is dropped (the daemon would refuse
// it). The current value is the tier's own record, never the merged view, so
// a user-tier default is not copied into the project's record.
function wholePayload(type, level, values) {
  const other = declared(type, level === 'small' ? 'large' : 'small');
  if (!other.size) return values;
  const own = declared(type, level);
  const have = toolbarState().project.settings[type];
  const out = {};
  if (isObject(have)) {
    for (const k of Object.keys(have)) if (other.has(k) && !own.has(k)) out[k] = have[k];
  }
  return { ...out, ...values };
}

// The PATCH body Save sends: the type's whole plain payload (wholePayload), or
// the profile list with the named profile's settings replaced (added when it
// is new), the others kept. A profile is one payload, so it is sent as the
// frame gives it.
function patchBody(type, level, profile, values) {
  if (typeof profile !== 'string') return { settings: { [type]: wholePayload(type, level, values) } };
  const have = toolbarState().project.profiles[type];
  const list = (Array.isArray(have) ? have : []).filter((p) => isObject(p) && typeof p.name === 'string');
  let found = false;
  const next = list.map((p) => {
    if (p.name !== profile) return { name: p.name, settings: isObject(p.settings) ? p.settings : {} };
    found = true;
    return { name: p.name, settings: values };
  });
  if (!found) next.push({ name: profile, settings: values });
  return { profiles: { [type]: next } };
}

async function save(ctx, values) {
  if (current !== ctx || ctx.readOnly || ctx.saving) return;
  if (!isObject(values)) return;
  ctx.saving = true;
  showHint(ctx, '');
  const r = await patchToolbar(patchBody(ctx.type, ctx.level, ctx.profile, values));
  ctx.saving = false;
  if (current !== ctx) return;
  if (r && r.ok) { closeToolSettings(); return; }
  showHint(ctx, (r && r.hint) || 'The settings were not saved.');
}

// Mount form-renderer into the frame's host. Resolves {ok} or a refusal.
async function mountForm(ctx) {
  const r = await request('GET', `/api/components/${FORM_COMPONENT}`);
  if (current !== ctx) return refuse('closed', 'the settings frame closed before its form loaded');
  const source = r.ok && isObject(r.body) && typeof r.body.source === 'string' ? r.body.source : null;
  if (!source) {
    const hint = (r && !r.ok && r.hint) || 'The settings form could not be loaded.';
    showHint(ctx, hint);
    return refuse((r && r.refused) || 'no-form', hint);
  }
  const M = window.__wcMount;
  const { root, scripts } = M.attachAndExtract(ctx.host, source);
  const style = document.createElement('style');
  style.setAttribute('data-wc-chrome', 'tool-settings');
  style.textContent = SHADOW_CSS;
  root.appendChild(style);
  // The detached store: its publish hook is the form's only way out.
  const store = M.createStore({}, (patch) => {
    if (isObject(patch) && Object.prototype.hasOwnProperty.call(patch, SUBMIT_KEY)) save(ctx, patch[SUBMIT_KEY]);
  });
  const params = { schema: ctx.schema, initial: ctx.value, submit_key: SUBMIT_KEY, submit_label: 'Save', title: ctx.label };
  M.runScripts(root, scripts, store, params, ctx.frame.el.id);
  if (ctx.readOnly) {
    for (const f of root.querySelectorAll('input, select, textarea, button')) f.disabled = true;
    for (const a of root.querySelectorAll('.actions, button[type=submit]')) a.remove();
  }
  place(ctx);
  if (!ctx.readOnly) {
    const first = root.querySelector('input, select, textarea');
    if (first) { try { first.focus({ preventScroll: true }); } catch { /* not focusable */ } }
  }
  return { ok: true };
}

export function openToolSettings(opts) {
  const o = isObject(opts) ? opts : {};
  if (o.content === 'tool') return refuse('tool-drawn', TOOL_DRAWN_HINT);
  if (o.level !== 'small' && o.level !== 'large') return refuse('bad-level', "level is 'small' or 'large'");
  if (typeof o.type !== 'string' || !o.type) return refuse('bad-type', 'type names the tool whose settings these are');
  if (!isObject(o.schema) || o.schema.type !== 'object' || !isObject(o.schema.properties)) {
    return refuse('bad-schema', "a settings schema's root is {type: 'object', properties}");
  }
  initToolSettings();
  closeToolSettings();   // one frame at a time
  let profile = null;
  if (typeof o.profile === 'string' && o.profile) profile = o.profile;
  else if (o.profile === undefined) {
    const a = armed();
    if (a && a.type === o.type && typeof a.profile === 'string' && a.profile) profile = a.profile;
  }
  const frame = frames[o.level];
  const label = typeof o.label === 'string' && o.label ? o.label : o.type;
  const host = document.createElement('div');
  host.className = 'ts-host';
  frame.el.insertBefore(host, frame.hint);
  frame.title.textContent = label;
  frame.el.setAttribute('aria-label', label);
  frame.sub.textContent = profile ? `Profile: ${profile}` : '';
  frame.hint.textContent = '';
  const ctx = {
    frame, host, level: o.level, type: o.type, profile, label,
    schema: o.schema, value: isObject(o.value) ? o.value : {},
    readOnly: o.readOnly === true,
    anchor: o.anchor && o.anchor.nodeType === 1 ? o.anchor : null,
    saving: false, onResize: null,
  };
  ctx.onResize = () => place(ctx);
  current = ctx;
  // One panel at a time: the shell closes every other open panel.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: frame.el } }));
  frame.el.classList.remove('hidden');
  place(ctx);
  window.addEventListener('resize', ctx.onResize);
  const ready = mountForm(ctx).catch((e) => {
    console.error('[web-chat] tool settings: the form failed to mount', e);
    showHint(ctx, 'The settings form could not be shown.');
    return refuse('error', 'The settings form could not be shown.');
  });
  return { ok: true, close: () => { if (current === ctx) closeToolSettings(); }, ready };
}
