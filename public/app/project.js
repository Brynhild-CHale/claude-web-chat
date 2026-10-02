// The project's identity in the chrome: its display name, whether the topbar
// shows that name beside the logo, and which images it has (design spec §9.2,
// §9.4). The daemon owns all of it (lib/core/project-identity, set from the host
// by `claude-web-chat identity` and the project-identity skill); this module
// keeps the one copy the chrome reads. It arrives as the answer to
// GET /api/project after every hello, and as a `project` frame whenever the host
// changes it. The topbar's co-brand lockup (cobrand.js) draws from it, and so
// does the tab's favicon (favicon.js, U77). Every change goes out on the chrome
// bus as `project` {identity}.
//
// THE TAB TITLE is the project's name, and nothing else: no " — web-chat"
// suffix, never a step, a state or a node (maintainer ruling N1, deviation 20).
// While Claude waits on the user a badge on the favicon says so; the title
// never changes for it. This module is document.title's one writer.
//
// The name is the user's text: it reaches the page as document.title and as
// textContent, never as markup. The daemon refuses control, bidi and invisible
// characters in it (lib/core/text); this module only trims and caps it.
//
// Its wiring is injected, as chat-state.js's is, so it imports nothing from the
// socket's module graph: main.js passes ws.js's seams,
//   initProject({ onFrame, onHello })
// and a test can pass its own.
import { bus } from './bus.js';

// The longest name the daemon stores, in code points (lib/core/project-identity
// NAME_MAX). A longer one on the wire is cut, never refused: the frame is still
// the project's.
export const NAME_MAX = 64;

const IMAGES = ['logo', 'logo_dark', 'favicon', 'favicon_dark', 'touch'];
const MARKS = new Set(['favicon', 'logo']);

// What the chrome shows before the daemon has said anything: web-chat's own
// name, no images (spec §9.4). index.html's <title> says the same.
export const DEFAULT_IDENTITY = Object.freeze({
  name: 'web-chat', custom: false, show_name: true,
  logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null,
  mark: null, mark_dark: false,
});

let identity = DEFAULT_IDENTITY;
// Whether a real identity (an answer or a frame) has landed. Until one has, a
// hello's folder name stands in for the name; after, a reconnect's hello never
// puts the folder name back over a renamed project.
let applied = false;
// Ordering for GET /api/project. Reads are numbered as they are issued, and an
// answer lands only if no later read's answer has landed already and no frame
// has landed since the read went out: either is newer news than the answer.
// (A frame carries the whole identity, so it never waits on a read.)
let reads = 0;          // reads issued
let readLanded = 0;     // the latest read whose answer landed
let frames = 0;         // identities that landed some other way: a frame, a caller
let wired = false;

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const cps = [...s];
  return cps.length > NAME_MAX ? cps.slice(0, NAME_MAX).join('') : s;
}

// One image's metadata, as the daemon reports it ({type, bytes, version,
// width, height}). An image with no version cannot be cache-keyed, so it is
// treated as absent, as brand.js treats a slot.
function cleanImage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const v = typeof m.version === 'string' || (typeof m.version === 'number' && Number.isFinite(m.version))
    ? String(m.version) : '';
  if (!v) return null;
  const dim = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
  return Object.freeze({
    type: typeof m.type === 'string' ? m.type : null,
    bytes: typeof m.bytes === 'number' && Number.isFinite(m.bytes) ? m.bytes : null,
    version: v,
    width: dim(m.width),
    height: dim(m.height),
  });
}

// The wire shape, read in one place. Null for anything that is not an identity
// (not an object, no usable name): the caller keeps what it had. Unknown fields
// are dropped (GET /api/project also carries name_max, max_bytes and types);
// inconsistent ones are made consistent, so a reader never meets a dark variant
// without its light image or a mark whose image is missing.
export function normalizeIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = cleanName(input.name);
  if (!name) return null;
  const out = {
    name,
    default_name: cleanName(input.default_name),
    custom: input.custom === true,
    show_name: input.show_name !== false,
  };
  for (const k of IMAGES) out[k] = cleanImage(input[k]);
  if (!out.logo) out.logo_dark = null;
  if (!out.favicon) out.favicon_dark = null;
  out.mark = MARKS.has(input.mark) && out[input.mark] ? input.mark : null;
  out.mark_dark = !!out.mark && input.mark_dark === true && !!out[`${out.mark}_dark`];
  if (input.corrupt === true) out.corrupt = true;
  return Object.freeze(out);
}

export function getProject() { return identity; }

function writeTitle() {
  if (typeof document === 'undefined') return;
  if (document.title !== identity.name) document.title = identity.name;
}

function set(next) {
  identity = next;
  writeTitle();
  bus.emit('project', { identity });
}

// Where an identity lands. Garbage keeps the last good value and returns
// false; nothing is emitted for it.
function land(input) {
  const next = normalizeIdentity(input);
  if (!next) return false;
  applied = true;
  set(next);
  return true;
}

// A `project` frame's identity, or a caller's that holds a fresh one.
export function applyProject(input) {
  if (!land(input)) return false;
  frames++;
  return true;
}

// GET /api/project. A failure (a daemon older than the project routes answers
// 404; a dropped connection throws) keeps what is known.
export async function refreshProject(fetchFn = (...a) => fetch(...a)) {
  const read = ++reads;
  const at = frames;
  let body;
  try {
    const r = await fetchFn('/api/project');
    if (!r || !r.ok) return false;
    body = await r.json();
  } catch { return false; }
  if (read < readLanded || at !== frames) return false;
  if (!land(body)) return false;
  readLanded = read;
  return true;
}

// Every hello, the first and every reconnect's. It carries the project's
// FOLDER name (`project`, unchanged for the bus golden); that is the name only
// while no identity has landed. The title is written again either way: it costs
// nothing, and it puts the name back over anything else that wrote it (ws.js's
// own hello handler, which runs just before this one, wrote "<folder> —
// web-chat" until the chat mirror's integration took that line out, spec §9.4).
// Then the identity is re-read: whatever changed while the socket was down
// arrives with it.
function onHelloFrame(msg, fetchFn) {
  const folder = cleanName(msg && msg.project);
  if (!applied && folder && (folder !== identity.name || folder !== identity.default_name)) {
    set(Object.freeze({ ...identity, name: folder, default_name: folder, custom: false }));
  } else {
    writeTitle();
  }
  refreshProject(fetchFn);
}

export function initProject({ onFrame, onHello, fetch: fetchFn } = {}) {
  if (wired) return;
  wired = true;
  const read = typeof fetchFn === 'function' ? fetchFn : (...a) => fetch(...a);
  if (typeof onHello === 'function') onHello((msg) => onHelloFrame(msg, read));
  if (typeof onFrame === 'function') onFrame('project', (msg) => { applyProject(msg && msg.identity); });
  writeTitle();
}
