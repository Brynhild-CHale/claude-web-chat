// The composer on the mod (design spec §15.7, §7.13; U91): what the chat
// composer gains when a web-chat mod is attached, and the image button.
//
//   initComposerMod()   (idempotent) registers the '/' rows provider and the
//                       image tool with chat-composer.js; call it after
//                       initChatComposer()
//   stopComposerMod()   unregisters both, removes the tool, aborts an upload
//                       in flight and revokes every preview URL it made
//
// THE '/' ROWS. When the followed conversation's process has a mod attached
// (Conversation.process.mod) and the daemon reports the mod capability, the
// SAFE_MOD_COMMANDS rows lead the '/' list, with Claude Code 2.1.296's own
// descriptions, labelled "runs in the terminal": choosing one inserts
// '/name ', and Send — queue.js sendMessage, the one send path — reaches the
// daemon's mod transport, which runs it as Claude Code's own command
// (lib/server/mod-transport.js). With no mod none is listed, and /model and
// every other config-persisting command never is (Q10).
//
// IMAGES. An "Add image" button, a pasted image and a dropped one each upload
// through POST /api/attachments with the File itself as the body and its type
// as the Content-Type, one at a time; the answered path becomes a chip of the
// message (chat-composer addAttachment, counted toward FILES_MAX), so Claude
// is told the path and Reads it (Q5: a path, never the bytes). The chip's
// preview is an object URL of the user's own File — the daemon never serves
// the bytes back — revoked when the chip goes. A refusal's hint shows under
// the input. The button shows at mirror level `full`, whether or not a mod is
// attached: a path rides the channel and the park too (ruled D6 (a)).
//
// IT RUNS IN THE CHROME'S REALM (ruling Q4), inside the composer's own root:
// no document- or window-level listener, no id, no focus, resize or
// visualViewport handling of its own (sheet-keyboard.js owns the keyboard).
//
// LOADS WITH NO DOM: the constants and modRows are read in plain node
// (test/composer-mod.test.js pins SAFE_MOD_COMMANDS equal to
// lib/server/composer.js's). It imports no ws.js and nothing that does at the
// top level.
import { bus } from './bus.js';
import { mirror, atLeast } from './chat-state.js';
import { setSkillRowsProvider, addAttachment, registerComposerTool } from './chat-composer.js';

// lib/server/composer.js SAFE_MOD_COMMANDS, pinned equal by a node-side test.
export const SAFE_MOD_COMMANDS = Object.freeze(['plan', 'compact', 'context', 'rename', 'recap']);
// Claude Code 2.1.296's own descriptions of the five.
export const MOD_COMMAND_DESCRIPTIONS = Object.freeze({
  plan: 'Enable plan mode or view the current session plan',
  compact: 'Free up context by summarizing the conversation so far',
  context: 'Show current context usage',
  rename: 'Rename the current conversation',
  recap: 'Generate a one-line session recap now',
});
export const MOD_ROW_LABEL = 'runs in the terminal';
export const ATTACHMENTS_ROUTE = '/api/attachments';
// lib/server/routes/attachments.js ATTACHMENT_TYPES.
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_BUTTON_LABEL = 'Add image';
export const IMAGE_TYPE_HINT = 'Add a PNG, JPEG, GIF or WebP image.';
const UPLOAD_FAILED = 'The image could not be added — check that web-chat is running, then try again.';

// ── pure ─────────────────────────────────────────────────────────────────────

// Is a mod attached to this conversation (the followed one, else the
// server's primary), as the daemon reports it?
export function modAttached(state, conversationId) {
  const s = state || {};
  if (!s.capabilities || s.capabilities.mod !== true) return false;
  const id = conversationId || s.followed || s.serverPrimary || null;
  const c = id && s.conversations && typeof s.conversations.get === 'function' ? s.conversations.get(id) : null;
  return !!(c && c.process && c.process.mod === true);
}

// The '/' rows the mod adds for a conversation: the five, or none.
export function modRows(state, conversationId) {
  if (!modAttached(state, conversationId)) return [];
  return SAFE_MOD_COMMANDS.map((name) => ({
    name, description: MOD_COMMAND_DESCRIPTIONS[name], origin: 'command', label: MOD_ROW_LABEL,
  }));
}

export const isImageFile = (f) => !!f && typeof f === 'object' && IMAGE_TYPES.includes(String(f.type || '').toLowerCase());

// ── the module's state ───────────────────────────────────────────────────────

let running = false;
let gen = 0;
let tool = null;            // registerComposerTool's handle
let unprovide = null;
let offs = [];
let box = null;             // span.cc-image-tool
let button = null;
let picker = null;          // its hidden file input
let chain = Promise.resolve();
let ctl = null;             // the upload in flight
const urls = new Set();     // object URLs this module made, until revoked

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function revoke(url) {
  if (!urls.delete(url)) return;
  try { URL.revokeObjectURL(url); } catch { /* nothing to free */ }
}

function preview(file) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    const url = URL.createObjectURL(file);
    urls.add(url);
    return url;
  } catch {
    return null;
  }
}

function hint(text) {
  if (tool) tool.hint(text);
}

// One upload: POST the File itself, then hand its path to the composer.
async function uploadOne(file, my) {
  if (my !== gen || !running) return;
  const c = new AbortController();
  ctl = c;
  let body = null;
  try {
    const res = await fetch(ATTACHMENTS_ROUTE, {
      method: 'POST', headers: { 'Content-Type': String(file.type).toLowerCase() }, body: file, signal: c.signal,
    });
    try { body = await res.json(); } catch { body = null; }
  } catch {
    body = null;
  }
  if (ctl === c) ctl = null;
  if (my !== gen || !running) return;
  if (!body || body.ok !== true || typeof body.path !== 'string') {
    hint((body && typeof body.hint === 'string' && body.hint) ? body.hint : UPLOAD_FAILED);
    return;
  }
  const thumb = preview(file);
  const r = addAttachment({ path: body.path, bytes: body.bytes, thumb, onGone: () => { if (thumb) revoke(thumb); } });
  if (!r || r.ok !== true) {
    if (thumb) revoke(thumb);
    if (r && r.hint) hint(r.hint);
  }
}

// Images, one at a time, in the order given; anything else is refused with a
// hint.
function upload(list) {
  const files = [...(list || [])];
  if (!files.length) return chain;
  const images = files.filter(isImageFile);
  if (images.length < files.length) hint(IMAGE_TYPE_HINT);
  const my = gen;
  for (const f of images) chain = chain.then(() => uploadOne(f, my)).catch(() => {});
  return chain;
}

const filesOf = (dt) => (dt && dt.files ? [...dt.files] : []);
const hasFiles = (dt) => !!dt && !!dt.types && [...dt.types].includes('Files');

function onPaste(e) {
  if (!level()) return;
  const images = filesOf(e.clipboardData).filter(isImageFile);
  if (!images.length) return;
  // The image is the paste; text pasted beside it (some apps put a name) keeps
  // its default.
  const text = e.clipboardData && typeof e.clipboardData.getData === 'function' ? e.clipboardData.getData('text/plain') : '';
  if (!text) e.preventDefault();
  upload(images);
}
function onDragover(e) {
  if (level() && hasFiles(e.dataTransfer)) e.preventDefault();
}
function onDrop(e) {
  if (!level()) return;
  const files = filesOf(e.dataTransfer);
  if (!files.length) return;
  e.preventDefault();
  upload(files);
}

const level = () => atLeast(mirror.access && mirror.access.level, 'full');

function decide() {
  if (box) box.hidden = !level();
}

function build() {
  box = el('span', 'cc-image-tool');
  button = el('button', 'cc-image', '＋');
  button.type = 'button';
  button.title = IMAGE_BUTTON_LABEL;
  button.setAttribute('aria-label', IMAGE_BUTTON_LABEL);
  picker = el('input', 'cc-image-input');
  picker.type = 'file';
  picker.accept = IMAGE_TYPES.join(',');
  picker.multiple = true;
  picker.hidden = true;
  picker.tabIndex = -1;
  button.addEventListener('click', () => { if (level()) picker.click(); });
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])];
    picker.value = '';
    upload(files);
  });
  box.append(button, picker);
}

export function initComposerMod() {
  if (running) return;
  if (typeof document === 'undefined') return;
  running = true;
  build();
  unprovide = setSkillRowsProvider((cid) => modRows(mirror, cid));
  tool = registerComposerTool(box, { paste: onPaste, dragover: onDragover, drop: onDrop });
  decide();
  offs = [bus.on('mirror', decide)];
}

export function stopComposerMod() {
  if (!running) return;
  running = false;
  gen += 1;
  for (const off of offs) off();
  offs = [];
  if (unprovide) { unprovide(); unprovide = null; }
  if (tool) { tool.remove(); tool = null; }
  if (ctl) { ctl.abort(); ctl = null; }
  for (const url of [...urls]) revoke(url);
  chain = Promise.resolve();
  box = null;
  button = null;
  picker = null;
}
