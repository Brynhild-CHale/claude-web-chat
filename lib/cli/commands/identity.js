// `claude-web-chat identity` — the project's identity from the host: its display
// name, its logo and favicon (each with an optional dark variant), and whether
// the name shows beside the logo (spec §9.6, D11). The `project-identity` skill
// drives it; a person can too.
//
//   identity [show]                               what is set, and what each place draws
//   identity name "<name>" | name --reset         the name the topbar and the tab title show
//   identity show-name on|off                     hide the name beside a wordmark logo
//   identity logo <file>    [image options]       the topbar lockup's logo
//   identity favicon <file> [image options]       the square image for the tab
//   identity clear logo|logo-dark|favicon|favicon-dark|name|all|touch
//
//   image options: [--mode auto|pixel|smooth] [--background transparent|tile[:<#rgb|#rrggbb>]]
//                  [--dark auto|<file>] [--dry-run [--out <dir>]] [--preview]
//
// THIN OVER THE ENGINES. lib/core/icon makes the image (prepare, darkVariant,
// encode) from the user's bytes; lib/core/project-identity holds the identity.
// This file decides only where a change goes and what to say about it.
//
// WHERE A WRITE GOES. Through the running daemon when one answers — PUT/DELETE
// /api/project/* (lib/server/routes/project.js), so every open tab gets the
// `project` frame, one bus emit per change — else straight through the engine,
// which is the same rule set ("written directly (no surface running)"). A 404
// that is not the engine's JSON {error} is a daemon older than those routes:
// the write goes direct, and the restart that shows it is named. A READ (`show`)
// is always the engine's, straight off disk. Nothing here spawns a daemon
// (noSpawn) and nothing prompts: the skill agrees each step with the user
// before it runs a command. The CLI is local, so no request it makes carries
// the portal's remote label.
//
// THE IMAGE GOES AS BYTES. The pipeline's output reaches the daemon as a raw
// Buffer body (lib/client sends a Buffer as-is), and the preview pane carries
// the same bytes as data: URLs this file builds — never a hand copy: on
// 2026-10-02 two of three base64 images hand-copied into a render call arrived
// corrupted (D11), which is why the CLI posts the preview itself.
//
// LIGHT, THEN DARK. The engine drops a light image's dark variant whenever the
// light bytes change (a dark variant was made for the image it sat beside), so
// a dark variant is always written after its light image, and a run without
// --dark leaves a changed image with no dark variant — which is said when one
// was removed.
//
// THE USER'S FILE is read, never written, moved or touched; a --dry-run that
// would write a candidate over an input file is refused.
//
// THE HOME-SCREEN ICON FOLLOWS THE MARK (D11; ruling U77b@touch-icon-source,
// option b). The engine's `touch` image is an opaque square PNG made from the
// mark's artwork on a tile — lib/core/icon's touch variant, never a second
// resampler — and it has no dark variant. After every image write and clear
// (followMark): when this run wrote the mark's light image, its touch variant
// (made from the user's file, on the --background tile colour, else the flat
// ground, else black) is written LAST, after the image and its dark variant;
// when the mark became another stored image, the touch icon is re-derived
// from that image's bytes; when there is no mark, or the mark is an SVG (the
// pipeline never rasterises), the touch icon is removed, so the home screen
// never shows a stale icon. While the mark stays the same image, its touch
// icon stands. `clear touch` removes it alone.

const fs = require('fs');
const path = require('path');
const project = require('../../core/project-identity');
const icon = require('../../core/icon');
const { TYPES, MAX_BYTES } = require('../../core/brand-image');
const { projectPaths, fence, isInside, nearestExisting, realpath } = require('../../core/paths');
const { readPortfile } = require('../../core/portfiles');
const { escapeHtml } = require('../../core/html');
const { resolveRoot } = require('../../setup/registration');
const client = require('../../client');

const IMAGE_KINDS = ['logo', 'favicon'];
const CLEAR_TARGETS = ['logo', 'logo-dark', 'favicon', 'favicon-dark', 'name', 'all', 'touch'];
const MODES = ['auto', 'pixel', 'smooth'];
const PREVIEW_ID = 'identity-preview';
const PICK_SIGNAL = 'identity_pick';
const PREVIEW_SIZES = [16, 20, 24, 32];
const LOCKUP_HEIGHT = 20;
const TOUCH_PREVIEW = 60;

const NEVER_RASTERISED = 'an SVG is stored as it is and never rasterised';
const OPEN_FIRST = '--preview shows the candidates on the surface, and none is running here: run claude-web-chat open first';
const NO_TWO_HUES = 'this artwork has no two dominant hues, so there is no automatic dark variant: '
  + 'try --background tile, or pass --dark <file>';

const USAGE = `usage: claude-web-chat identity <verb>
  show                                   the name, the images, the mark and the modes
  name "<name>" | name --reset           the name the topbar and the tab title show
  show-name on|off                       hide the text name beside a wordmark logo
  logo <file> [options]                  the topbar lockup's logo
  favicon <file> [options]               the square image for the tab (and the home-screen icon)
  clear logo|logo-dark|favicon|favicon-dark|name|all|touch
options for logo and favicon:
  --mode auto|pixel|smooth               how the artwork is resampled (default auto)
  --background transparent|tile[:<#rgb|#rrggbb>]
                                         which variant is stored (default transparent)
  --dark auto|<file>                     a dark variant: generated, or from your own file
  --dry-run [--out <dir>]                apply nothing; write the candidates into <dir>
  --preview                              apply nothing; show the candidates on the surface to pick from`;

// ── small helpers ───────────────────────────────────────────────────────────

function userFacing(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// A refusal: its message, then its hint on the next line.
function fail(message, hint) {
  throw userFacing(hint ? `${message}\n  ${hint}` : message);
}

const VALUE_FLAGS = new Set(['mode', 'background', 'dark', 'out']);
const BOOLEAN_FLAGS = new Set(['dry-run', 'preview', 'reset']);

// `--key value`, `--key=value`, the three booleans, and `--` ending the options
// (a name may start with dashes). An unknown option is refused.
function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { out._.push(...args.slice(i + 1).map(String)); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (BOOLEAN_FLAGS.has(key)) {
      if (val !== undefined) fail(`--${key} takes no value`);
      out[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) fail(`unknown option --${key}`, USAGE);
    if (val === undefined) {
      val = args[++i];
      if (val === undefined) fail(`--${key} needs a value`);
    }
    out[key] = String(val);
  }
  return out;
}

// Refuse any option the verb does not take, so a typo never passes silently.
function onlyFlags(flags, verb, allowed) {
  for (const k of Object.keys(flags)) {
    if (k !== '_' && !allowed.includes(k)) fail(`identity ${verb} takes no --${k}`, USAGE);
  }
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function aspect(w, h) {
  const g = gcd(w, h);
  if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`;
}

const typeName = (type) => (type === TYPES.svg ? 'SVG' : 'PNG');

// "PNG 160×160 (1:1), 2071 bytes" — an ImageMeta, a candidate, or anything with
// a type, a width, a height and a byte count.
function describe({ type, width, height, bytes }) {
  const size = width > 0 && height > 0 ? `${width}×${height} (${aspect(width, height)})` : 'no viewBox, so its size is unknown';
  return `${typeName(type)} ${size}, ${typeof bytes === 'number' ? bytes : bytes.length} bytes`;
}

// --background transparent | tile | tile:#rgb | tile:#rrggbb → { background,
// tile: [r, g, b] | null, spec } (spec: how a follow-up command spells it).
function parseBackground(value) {
  if (value === undefined || value === 'transparent') return { background: 'transparent', tile: null, spec: 'transparent' };
  if (value === 'tile') return { background: 'tile', tile: null, spec: 'tile' };
  const m = /^tile:#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!m) fail(`--background ${value}: use transparent, tile, or tile:<#rgb|#rrggbb>`);
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const tile = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { background: 'tile', tile, spec: `tile:#${hex.toLowerCase()}` };
}

// The user's image, read and nothing else: never written, moved or touched.
function readInput(file, what) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    fail(`cannot read ${what} ${file}: ${e.code === 'ENOENT' ? 'there is no such file' : e.message}`);
  }
  if (!st.isFile()) fail(`${what} ${file} is not a file`);
  try { return fs.readFileSync(file); } catch (e) { return fail(`cannot read ${what} ${file}: ${e.message}`); }
}

// icon.prepare, with its refusal (an IconError) said with its hint.
function prepareImage(bytes, options, file) {
  try { return icon.prepare(bytes, options); } catch (e) {
    if (e instanceof icon.IconError) return fail(`${file}: ${e.message}`, e.hint);
    throw e;
  }
}

// ── where a write goes ──────────────────────────────────────────────────────

// What each refusal status means, for the line that reports it.
function statusSays(status, what) {
  const light = what && what.endsWith('-dark') ? what.slice(0, -5) : null;
  return {
    400: 'invalid',
    403: 'refused for a remote viewer',
    404: 'not a web-chat project',
    409: light ? `set the ${light} first` : 'nothing to pair with',
    413: 'too large',
    415: 'not a PNG or an SVG',
    422: light ? `not the ${light}'s shape` : 'the wrong shape, or an SVG with active content',
  }[status] || 'refused';
}

function statusHint(status, what) {
  const light = what && what.endsWith('-dark') ? what.slice(0, -5) : null;
  if (status === 409 && light) return `set it first: claude-web-chat identity ${light} <file>`;
  if (status === 422 && light) return `make the dark variant from the same artwork (the ${light}'s aspect ratio), or use --dark auto`;
  if (status === 413) return `a stored image is at most ${MAX_BYTES} bytes`;
  if (status === 404) return 'run claude-web-chat init in the project first';
  return null;
}

function refusal(status, message, what) {
  return userFacing([`identity: ${what} refused (${status}: ${statusSays(status, what)}): ${message}`,
    ...(statusHint(status, what) ? [`  ${statusHint(status, what)}`] : [])].join('\n'));
}

const isEngineRefusal = (body) => Boolean(body) && typeof body === 'object' && typeof body.error === 'string';

// The writer: the daemon while one answers, else the engine. `via` says which
// took the last write, and why it was the engine.
function makeWriter(root, port) {
  let mode = port ? 'daemon' : 'direct';
  let why = port ? null : 'no-surface';

  async function write({ method, route, body, headers, what, direct }) {
    if (mode === 'daemon') {
      try {
        const r = await client.api(method, `/api/project/${route}`, body, { port, root, noSpawn: true, headers });
        return { via: 'daemon', ...(r && typeof r === 'object' ? r : {}) };
      } catch (e) {
        if (e instanceof client.NoServerError) {
          mode = 'direct'; why = 'no-surface';
        } else if (e instanceof client.HttpError) {
          if (e.status === 404 && !isEngineRefusal(e.body)) {
            mode = 'direct'; why = 'predates';
          } else {
            const b = e.body && typeof e.body === 'object' ? e.body : {};
            throw refusal(e.status, b.error || b.hint || String(e.body || e.message), what);
          }
        } else {
          throw e;
        }
      }
    }
    try {
      return { via: 'direct', why, ...direct() };
    } catch (e) {
      if (e instanceof project.ProjectError) throw refusal(e.status, e.message, what);
      throw e;
    }
  }

  return { write };
}

function viaSays(r) {
  if (r.via === 'daemon') return 'through the running surface: every open tab shows it';
  if (r.why === 'predates') return 'written directly — the running surface predates this; claude-web-chat restart shows it';
  return 'written directly (no surface running)';
}

// The daemon's port, from this project's portfile (a live pid), or the one the
// caller named.
function daemonPort(root, opts) {
  if (opts.port) return opts.port;
  const info = readPortfile('server', { root });
  return info ? info.port : null;
}

// ── show ────────────────────────────────────────────────────────────────────

const MARK_SAYS = { favicon: 'the favicon', logo: 'the logo (it is square)' };

function showLines(id) {
  const lines = [];
  lines.push(`  name          "${id.name}" — ${id.custom ? `set (the folder's name is "${id.default_name}")` : 'the folder\'s name'}`);
  lines.push(`  show name     ${id.show_name ? 'on: the name shows beside the logo' : 'off: the logo shows without the name (a wordmark)'}`);
  for (const [label, key] of [['logo', 'logo'], ['logo dark', 'logo_dark'], ['favicon', 'favicon'], ['favicon dark', 'favicon_dark']]) {
    lines.push(`  ${label.padEnd(13)} ${id[key] ? describe(id[key]) : 'none'}`);
  }
  lines.push(`  home screen   ${id.touch
    ? `${id.touch.width}×${id.touch.height} PNG${id.mark ? ` (from the ${id.mark})` : ''}`
    : 'web-chat\'s default'}`);
  lines.push(id.mark
    ? `  mark          ${MARK_SAYS[id.mark]}, ${id.mark_dark ? 'with a dark variant' : 'no dark variant (the same image in both modes)'} — the phone's topbar and the tab's favicon draw it`
    : '  mark          none — the phone\'s topbar shows no mark, and the tab shows web-chat\'s W');
  lines.push('  modes         the topbar follows web-chat\'s ◑ mode; the tab\'s favicon follows the browser\'s colour scheme');
  if (id.corrupt) {
    lines.push("  ⚠ the identity's record in .web-chat/ cannot be read (corrupt): the defaults are shown, and the next change replaces it");
  }
  return lines;
}

function show(root, log) {
  const id = project.identity(root);
  log(`Project identity (${root})`);
  for (const l of showLines(id)) log(l);
  return { verb: 'show', root, identity: id };
}

// ── name, show-name, clear ──────────────────────────────────────────────────

async function name(root, flags, ctx) {
  onlyFlags(flags, 'name', ['reset']);
  const { writer, log } = ctx;
  if (flags.reset) {
    if (flags._.length) fail('identity name --reset takes no name');
    const r = await writer.write({
      method: 'DELETE', route: 'name', what: 'name', direct: () => project.resetName(root),
    });
    log(r.removed
      ? `✓ the name is the folder's again: "${r.identity.name}" — ${viaSays(r)}`
      : `the name was already the folder's: "${r.identity.name}"`);
    return { verb: 'name', root, via: r.via, removed: r.removed, identity: r.identity };
  }
  if (!flags._.length) fail('identity name needs the name, in quotes ("Acme Web"), or --reset for the folder\'s name', USAGE);
  const wanted = flags._.join(' ');
  const before = project.identity(root);
  const r = await writer.write({
    method: 'PUT', route: 'name', body: { name: wanted }, what: 'name',
    direct: () => ({ identity: project.setName(root, wanted) }),
  });
  const id = r.identity;
  if (id.name === before.name && id.custom === before.custom) log(`the name is already "${id.name}"`);
  else log(`✓ the name is now "${id.name}"${id.custom ? '' : ' (the folder\'s)'}: the topbar and the tab title show it — ${viaSays(r)}`);
  return { verb: 'name', root, via: r.via, identity: id };
}

async function showName(root, flags, ctx) {
  onlyFlags(flags, 'show-name', []);
  const v = flags._[0];
  if (flags._.length !== 1 || (v !== 'on' && v !== 'off')) fail('identity show-name takes on or off', USAGE);
  const show = v === 'on';
  const before = project.identity(root);
  const r = await ctx.writer.write({
    method: 'PUT', route: 'show-name', body: { show }, what: 'show-name',
    direct: () => ({ identity: project.setShowName(root, show) }),
  });
  if (before.show_name === show) ctx.log(`the name already ${show ? 'shows' : 'is hidden'} beside the logo`);
  else ctx.log(`✓ the name ${show ? 'shows beside the logo again' : 'is hidden beside the logo (for a wordmark that spells it)'} — ${viaSays(r)}`);
  return { verb: 'show-name', root, via: r.via, identity: r.identity };
}

function removeImage(writer, root, kind) {
  return writer.write({
    method: 'DELETE', route: kind, what: kind, direct: () => project.removeImage(root, kind),
  });
}

// ── the home-screen icon ────────────────────────────────────────────────────

const svgTouch = (kind) => `the home-screen icon stays web-chat's W: an SVG ${kind} cannot be turned into the PNG a home screen needs`;
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// The mark as one key: which image it is, and that image's version.
const markKey = (id) => (id.mark && id[id.mark] ? `${id.mark}@${id[id.mark].version}` : null);

function writeTouch(writer, root, bytes) {
  return writer.write({
    method: 'PUT', route: 'touch-icon', body: bytes, headers: { 'Content-Type': TYPES.png }, what: 'touch-icon',
    direct: () => project.writeImage(root, 'touch', bytes),
  });
}

function removeTouch(writer, root) {
  return writer.write({
    method: 'DELETE', route: 'touch-icon', what: 'touch-icon', direct: () => project.removeImage(root, 'touch'),
  });
}

// What a result object reports of the home-screen icon.
const touchResult = (f) => ({
  op: f.op, from: f.from, ...(f.reason ? { reason: f.reason } : {}),
  ...(f.via ? { via: f.via } : {}), ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
});

// The home-screen icon follows the mark. `before` and `after` are the identity
// around the change; `fresh` is { kind, prepared } when this run wrote `kind`
// from the user's file. → { op: 'set'|'remove'|'none', from, reason?, says?,
// via?, why?, identity, bytes? }; the caller logs `says`.
async function followMark(root, ctx, { before, after, fresh = null }) {
  const { writer } = ctx;
  const mark = after.mark;
  const drop = async (reason, says) => {
    if (!after.touch) return { op: 'none', from: mark, reason, says, identity: after };
    const r = await removeTouch(writer, root);
    return { op: r.removed ? 'remove' : 'none', from: mark, reason, says, ...r };
  };
  const put = async (bytes, image, says) => {
    const r = await writeTouch(writer, root, bytes);
    return {
      op: 'set', from: mark, bytes: bytes.length, ...r,
      says: `${says}: ${describe({ type: TYPES.png, width: image.width, height: image.height, bytes })} — ${viaSays(r)}`,
    };
  };

  // This run wrote the mark: its touch variant, made from the user's own file.
  if (fresh && mark === fresh.kind) {
    if (fresh.prepared.format === 'svg') {
      const f = await drop('svg', `  ${svgTouch(mark)}`);
      if (f.op === 'remove') f.says += `\n  the earlier home-screen icon was removed: it was made from another image`;
      return f;
    }
    const { touch, tile } = fresh.prepared.variants;
    return put(touch.bytes, touch.image, `✓ the home-screen icon follows the ${mark}, on an opaque ${hex(tile.colour)} tile`);
  }
  // The mark is the same image as before: its home-screen icon stands.
  if (markKey(before) === markKey(after)) return { op: 'none', from: mark, identity: after };
  if (!mark) return drop('no-mark', '  the home-screen icon is web-chat\'s W again: there is no square mark to make it from');
  // The mark is now another stored image: re-derived from that image's bytes.
  const img = project.readImage(root, mark);
  if (!img || img.type !== TYPES.png) return drop('svg', `  ${svgTouch(mark)}`);
  let prepared;
  try { prepared = icon.prepare(img.bytes, { kind: mark, mode: 'auto', tile: null }); } catch (e) {
    if (!(e instanceof icon.IconError)) throw e;
    return drop('underivable', `  the home-screen icon is web-chat's W: it cannot be made from the ${mark} (${e.message})`);
  }
  if (prepared.format !== 'png') return drop('svg', `  ${svgTouch(mark)}`);
  const { touch, tile } = prepared.variants;
  return put(touch.bytes, touch.image, `✓ the home-screen icon now follows the ${mark}, on an opaque ${hex(tile.colour)} tile`);
}

async function clear(root, flags, ctx) {
  onlyFlags(flags, 'clear', []);
  const { writer, log } = ctx;
  const target = flags._[0];
  if (flags._.length !== 1 || !CLEAR_TARGETS.includes(target)) {
    fail(`identity clear needs what to clear: ${CLEAR_TARGETS.join(', ')}`,
      'logo and favicon take their dark variants with them; all clears the four images and the name, and shows the name again; '
      + 'the home-screen icon follows the mark, and touch removes it alone');
  }
  const before = project.identity(root);
  const cleared = [];
  let last = null;
  const run = async (label, op) => {
    last = await op();
    if (last.removed) cleared.push(label);
  };
  const resetName = () => writer.write({ method: 'DELETE', route: 'name', what: 'name', direct: () => project.resetName(root) });
  let follow = null;
  if (target === 'name') {
    await run('name', resetName);
  } else if (target === 'touch') {
    await run('touch', () => removeTouch(writer, root));
  } else if (target !== 'all') {
    await run(target, () => removeImage(writer, root, target));
    // The home-screen icon follows the mark: removing the mark's image
    // re-derives it from the image that is the mark now, or removes it.
    follow = await followMark(root, ctx, { before, after: last.identity });
    if (follow.op !== 'none') last = follow;
    if (follow.op === 'remove') cleared.push('touch');
  } else {
    for (const kind of ['logo', 'logo-dark', 'favicon', 'favicon-dark']) await run(kind, () => removeImage(writer, root, kind));
    await run('touch', () => removeTouch(writer, root));
    await run('name', resetName);
    last = await writer.write({
      method: 'PUT', route: 'show-name', body: { show: true }, what: 'show-name',
      direct: () => ({ identity: project.setShowName(root, true) }),
    });
    if (!before.show_name) cleared.push('show-name');
  }
  const says = {
    name: `the name (it is the folder's again: "${last.identity.name}")`,
    logo: `the logo${before.logo_dark ? ' and its dark variant' : ''}`,
    favicon: `the favicon${before.favicon_dark ? ' and its dark variant' : ''}`,
    'logo-dark': 'the logo\'s dark variant',
    'favicon-dark': 'the favicon\'s dark variant',
    'show-name': 'the hidden name (it shows beside the logo again)',
    touch: 'the home-screen icon',
  };
  if (cleared.length) log(`✓ cleared ${cleared.map((c) => says[c]).join(', ')} — ${viaSays(last)}`);
  else log(target === 'all' ? 'nothing to clear: the identity is already the default' : `nothing to clear: ${target === 'name' ? `no name is set (it is the folder's: "${last.identity.name}")` : `${says[target]} was not set`}`);
  // A removal for want of a mark is already in the cleared line.
  if (follow && follow.says && !(follow.op === 'remove' && follow.reason === 'no-mark')) log(follow.says);
  return {
    verb: 'clear', root, target, via: last.via, cleared, identity: last.identity,
    ...(follow ? { touch: touchResult(follow) } : {}),
  };
}

// ── logo and favicon ────────────────────────────────────────────────────────

// The candidates a run computes: { name (the --out file name), background,
// dark, ext, type, bytes, width, height }.
function candidate(kind, background, dark, ext, bytes, width, height) {
  const name = `${kind}${background === 'tile' ? '-tile' : ''}${dark ? '-dark' : ''}.${ext}`;
  return { name, background, dark: Boolean(dark), ext, type: TYPES[ext], bytes, width, height };
}

// The variants of one prepared image, as candidates (an SVG has one).
function lightsOf(kind, prepared, dark) {
  if (prepared.format === 'svg') return [candidate(kind, 'transparent', dark, 'svg', prepared.bytes, prepared.width, prepared.height)];
  return ['transparent', 'tile'].map((b) => {
    const v = prepared.variants[b];
    return { ...candidate(kind, b, dark, 'png', v.bytes, v.image.width, v.image.height), image: v.image };
  });
}

// --out <dir>: created when missing; never inside .web-chat/ (lexically, or
// through a link that reaches it).
function outDir(root, cwd, out) {
  const abs = path.resolve(cwd, out);
  const dir = projectPaths(root).dir;
  if (fence(dir, abs) !== null || isInside(dir, nearestExisting(abs, { follow: false }))) {
    fail(`--out ${out} is inside .web-chat/, which holds the project's state: pick a directory outside it`);
  }
  try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { fail(`cannot make --out ${abs}: ${e.message}`); }
  return abs;
}

// Write each candidate into the --out directory, refusing one that would land
// on an input file (the user's file is never touched).
function writeCandidates(dir, cands, inputs, log) {
  const inputReal = new Set(inputs.map((f) => realpath(f) || path.resolve(f)));
  for (const c of cands) {
    const target = path.join(dir, c.name);
    if (inputReal.has(realpath(target) || target)) {
      fail(`--out would write ${c.name} over your file ${target}: pick another directory`);
    }
  }
  const written = [];
  for (const c of cands) {
    const target = path.join(dir, c.name);
    fs.writeFileSync(target, c.bytes);
    c.path = target;
    written.push(target);
    log(`  ${target}  ${describe(c)}`);
  }
  return written;
}

// Whether a candidate is square, by project-identity's 2 % rule (the mark's):
// one of unknown size (an SVG with no viewBox) is drawn as a square.
const squareish = (c) => !(c.width > 0 && c.height > 0)
  || Math.abs(c.width - c.height) <= icon.SQUARE_TOLERANCE * Math.max(c.width, c.height);

// What the mock tab says in place of a logo that is not square: the tab shows
// the mark, which is the favicon, else a square logo, else web-chat's W.
const NOT_THE_TAB = 'Not the tab\'s icon: a logo that is not square never shows in the tab (the favicon does, else web-chat\'s W).';

// The preview pane: each candidate at the favicon's and the lockup's sizes on
// a light and a dark ground (a candidate that is not square at that height and
// its own width, never squashed), beside a mock tab (a square one only; a wider
// logo says it is not the tab's icon) and, for a logo, a mock topbar lockup,
// with a "Use this" button that writes the identity_pick signal. Every image is
// a data: URL of the candidate's exact bytes; every text is escaped; the script
// queries only its own shadow root.
function previewHtml({ kind, cands, file, name, showName, pixel, darkArg }) {
  const url = (c) => `data:${c.type};base64,${c.bytes.toString('base64')}`;
  const render = pixel ? 'pixelated' : 'auto';
  const widthAt = (c, h) => (squareish(c) ? h : Math.max(1, Math.round((h * c.width) / c.height)));
  const lockupWidth = (c) => (c.width > 0 && c.height > 0 ? Math.round((LOCKUP_HEIGHT * c.width) / c.height) : LOCKUP_HEIGHT);
  const ground = (c, tone) => `<div class="idp-ground idp-${tone}">${PREVIEW_SIZES.map((s) => (
    `<figure><img src="${url(c)}" width="${widthAt(c, s)}" height="${s}" alt=""><figcaption>${s}</figcaption></figure>`)).join('')}</div>`;
  const tab = (c, tone) => `<div class="idp-tab idp-${tone}"><img src="${url(c)}" width="16" height="16" alt=""><span>${escapeHtml(`${name} — web-chat`)}</span></div>`;
  const tabRow = (c) => (squareish(c)
    ? `<div class="idp-row">${tab(c, 'light')}${tab(c, 'dark')}</div>`
    : `<p class="idp-note idp-notab">${escapeHtml(NOT_THE_TAB)}</p>`);
  const lockup = (c, tone) => `<div class="idp-bar idp-${tone}"><img src="${url(c)}" width="${lockupWidth(c)}" height="${LOCKUP_HEIGHT}" alt="">${
    showName ? `<span>${escapeHtml(name)}</span>` : ''}</div>`;
  const touch = cands.find((c) => c.touch) || null;
  const cards = cands.filter((c) => !c.touch).map((c) => {
    const pick = { kind, background: c.background === 'tile' ? c.backgroundSpec : 'transparent', dark: c.dark ? darkArg : null };
    const label = `${c.background}${c.dark ? ', dark variant' : ''}`;
    return `<section class="idp-card">
  <h3>${escapeHtml(label)} <small>${escapeHtml(describe(c))}</small></h3>
  <div class="idp-row">${ground(c, 'light')}${ground(c, 'dark')}</div>
  ${tabRow(c)}
  ${kind === 'logo' ? `<div class="idp-row">${lockup(c, 'light')}${lockup(c, 'dark')}</div>` : ''}
  <button type="button" data-pick="${escapeHtml(JSON.stringify(pick))}" data-label="${escapeHtml(label)}">Use this</button>
</section>`;
  }).join('\n');
  // The home-screen icon at 60 px, already on its opaque tile, on both grounds:
  // it is the same in both schemes and follows whichever candidate is picked.
  const home = (tone) => `<div class="idp-ground idp-${tone}"><figure><img class="idp-home" src="${url(touch)}" width="${TOUCH_PREVIEW}" height="${TOUCH_PREVIEW}" alt=""><figcaption>${TOUCH_PREVIEW}</figcaption></figure></div>`;
  const touchCard = touch ? `
<section class="idp-card idp-touch">
  <h3>home-screen icon <small>${escapeHtml(describe(touch))}</small></h3>
  <div class="idp-row">${home('light')}${home('dark')}</div>
  <p class="idp-note">${escapeHtml('Made from the same artwork on its opaque tile; it goes with whichever candidate you pick.')}</p>
</section>` : '';
  return `<style>
  .idp { font: 13px var(--wc-font, system-ui, sans-serif); color: var(--wc-fg, #222); }
  .idp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .idp-card { border: 1px solid var(--wc-border, #ccc); border-radius: var(--wc-radius, 8px); padding: 10px; }
  .idp-card h3 { margin: 0 0 8px; font-size: 13px; } .idp-card small { font-weight: normal; color: var(--wc-muted, #777); }
  .idp-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .idp-ground { display: flex; align-items: flex-end; gap: 10px; padding: 8px 10px; border-radius: 6px; }
  .idp-ground figure { margin: 0; text-align: center; } .idp-ground figcaption { font-size: 10px; opacity: .6; }
  .idp img { image-rendering: ${render}; display: block; }
  .idp-light { background: #f6f6f4; color: #222; } .idp-dark { background: #1c1c1e; color: #eee; }
  .idp-tab { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px 8px 0 0; max-width: 200px; }
  .idp-tab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .idp-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; min-width: 140px; font-weight: 600; }
  .idp button { padding: 4px 12px; cursor: pointer; }
  .idp .idp-home { border-radius: 13px; }
  .idp-note { margin: 0; color: var(--wc-muted, #777); }
  .idp-notab { margin-bottom: 8px; }
  .idp-status { margin-top: 8px; color: var(--wc-muted, #777); }
</style>
<div class="idp">
  <p>${escapeHtml(`Candidates for this project's ${kind}, from ${path.basename(file)}. Pick one, then press Push (P) to send the pick to Claude.`)}</p>
  <div class="idp-cards">
${cards}${touchCard}
  </div>
  <p class="idp-status" aria-live="polite"></p>
</div>
<script>
(function () {
  var prev = store.get('${PICK_SIGNAL}');
  var seq = prev && typeof prev.seq === 'number' ? prev.seq : 0;
  var status = root.querySelector('.idp-status');
  root.querySelectorAll('button[data-pick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = JSON.parse(b.getAttribute('data-pick'));
      seq += 1;
      store.set({ ${PICK_SIGNAL}: { seq: seq, kind: p.kind, background: p.background, dark: p.dark } });
      if (status) status.textContent = 'Picked: ' + b.getAttribute('data-label') + '. Press Push (P) to send it to Claude.';
    });
  });
})();
</script>`;
}

async function imageVerb(kind, root, flags, ctx) {
  onlyFlags(flags, kind, ['mode', 'background', 'dark', 'out', 'dry-run', 'preview']);
  const { log, cwd } = ctx;
  if (flags._.length !== 1) fail(`identity ${kind} takes one image file`, USAGE);
  const mode = flags.mode || 'auto';
  if (!MODES.includes(mode)) fail(`--mode ${mode}: use ${MODES.join(', ')}`);
  const bg = parseBackground(flags.background);
  if (flags.out !== undefined && !flags['dry-run']) fail('--out goes with --dry-run (identity … --dry-run --out <dir>)');
  const darkArg = flags.dark === undefined ? null : flags.dark;
  if (darkArg === '') fail('--dark needs auto or a file');

  const file = path.resolve(cwd, flags._[0]);
  const inputs = [file];
  const prepared = prepareImage(readInput(file, 'the image'), { kind, mode, tile: bg.tile }, file);
  const svg = prepared.format === 'svg';
  if (svg && bg.background === 'tile') {
    fail(`${file} is an SVG: ${NEVER_RASTERISED}, so it has no tile variant`, 'use --background transparent, or bring a PNG for a tile');
  }
  if (svg && darkArg === 'auto') {
    fail(`${file} is an SVG: ${NEVER_RASTERISED}, so it has no automatic dark variant — only --dark <file> gives it one`);
  }

  // The candidates: the light variants, and their dark variants when asked for.
  const lights = lightsOf(kind, prepared, false);
  for (const c of lights) c.backgroundSpec = bg.spec.startsWith('tile') ? bg.spec : 'tile';
  let darks = [];
  const noHues = [];
  if (darkArg === 'auto') {
    for (const l of lights) {
      const dv = icon.darkVariant(l.image, { cell: prepared.cell });
      if (!dv) { noHues.push(l.background); continue; }
      const bytes = icon.encode(dv.image);
      darks.push({ ...candidate(kind, l.background, true, 'png', bytes, dv.image.width, dv.image.height), backgroundSpec: l.backgroundSpec });
    }
  } else if (darkArg) {
    const darkFile = path.resolve(cwd, darkArg);
    inputs.push(darkFile);
    const dp = prepareImage(readInput(darkFile, 'the dark image'), { kind, mode, tile: bg.tile }, darkFile);
    if (dp.format === 'svg' && bg.background === 'tile') {
      fail(`${darkFile} is an SVG: ${NEVER_RASTERISED}, so it has no tile variant to pair with --background tile`);
    }
    darks = lightsOf(kind, dp, true).map((c) => ({ ...c, backgroundSpec: lights[0].backgroundSpec }));
  }
  const chosen = lights.find((c) => c.background === bg.background);
  const chosenDark = darks.find((c) => c.background === bg.background) || null;
  const notes = prepared.notes || [];
  // A PNG favicon's home-screen icon: one, whichever background is picked (it
  // sits on the same tile colour), and no dark variant.
  const touches = [];
  if (kind === 'favicon' && !svg) {
    const t = prepared.variants.touch;
    touches.push({
      name: 'favicon-touch.png', background: 'tile', dark: false, touch: true, ext: 'png', type: TYPES.png,
      bytes: t.bytes, width: t.image.width, height: t.image.height,
    });
  }

  const result = {
    verb: kind, kind, root, file, applied: false, via: null, written: [], dark_removed: false,
    dark: darkArg === 'auto' ? 'auto' : darkArg ? 'file' : null,
    candidates: [...lights, ...darks, ...touches].map(({ image, backgroundSpec, ...c }) => c),
    notes,
  };

  // Nothing is applied: write the candidates out, and/or show them.
  if (flags['dry-run'] || flags.preview) {
    if (flags.preview && !daemonPort(root, ctx.opts)) fail(OPEN_FIRST);
    log(`${kind} candidates from ${file} (nothing applied):`);
    for (const n of notes) log(`  · ${n}`);
    if (darkArg === 'auto' && noHues.length) log(`  ${NO_TWO_HUES}`);
    if (kind === 'favicon' && svg) log(`  ${svgTouch(kind)}`);
    const cands = [...lights, ...darks, ...touches];
    if (flags.out !== undefined) {
      const dir = outDir(root, cwd, flags.out);
      writeCandidates(dir, cands, inputs, log);
      result.out = dir;
      result.candidates = cands.map(({ image, backgroundSpec, ...c }) => c);
    } else {
      for (const c of cands) log(`  ${c.name}  ${describe(c)}`);
    }
    if (flags.preview) result.preview = await postPreview(root, ctx, { kind, cands, file, pixel: Boolean(prepared.pixel_art), darkArg });
    result.identity = project.identity(root);
    return result;
  }

  // Apply: the light image, then its dark variant, then the home-screen icon.
  const before = project.identity(root);
  const typeHeader = (c) => ({ 'Content-Type': c.type });
  const light = await ctx.writer.write({
    method: 'PUT', route: kind, body: chosen.bytes, headers: typeHeader(chosen), what: kind,
    direct: () => project.writeImage(root, kind, chosen.bytes),
  });
  result.applied = true;
  result.via = light.via;
  result.written.push({ kind, type: chosen.type, bytes: chosen.bytes.length, background: chosen.background });
  log(`✓ ${kind} set: ${describe(chosen)}${chosen.ext === 'png' ? `, ${chosen.background}` : ''} — ${viaSays(light)}`);
  for (const n of notes) log(`  · ${n}`);
  let id = light.identity;
  let darkRefused = null;
  if (chosenDark) {
    let dark = null;
    try {
      dark = await ctx.writer.write({
        method: 'PUT', route: `${kind}-dark`, body: chosenDark.bytes, headers: typeHeader(chosenDark), what: `${kind}-dark`,
        direct: () => project.writeImage(root, `${kind}-dark`, chosenDark.bytes),
      });
    } catch (e) {
      // A refused dark variant still leaves a new light image: its home-screen
      // icon follows below, before the refusal is reported.
      if (!e.userFacing) throw e;
      darkRefused = e;
    }
    if (dark) {
      result.written.push({ kind: `${kind}-dark`, type: chosenDark.type, bytes: chosenDark.bytes.length, background: chosenDark.background });
      log(`✓ ${kind} dark variant set${darkArg === 'auto' ? ' (generated)' : ''}: ${describe(chosenDark)} — ${viaSays(dark)}`);
      id = dark.identity;
    }
  } else {
    result.dark_removed = Boolean(light.dark_removed);
    if (darkArg === 'auto') log(`  ${NO_TWO_HUES}`);
    if (light.dark_removed) {
      log(`  the ${kind}'s earlier dark variant was removed: it was made for the old image. `
        + `Run again with --dark auto or --dark <file> for a new one.`);
    }
  }
  // The home-screen icon last: after the image and its dark variant.
  const follow = await followMark(root, ctx, { before, after: id, fresh: { kind, prepared } });
  if (follow.says) log(follow.says);
  result.touch = touchResult(follow);
  if (follow.op !== 'none') id = follow.identity;
  if (darkRefused) throw darkRefused;
  result.identity = id;
  log(id.mark
    ? `  the mark: ${MARK_SAYS[id.mark]}${id.mark_dark ? ', with a dark variant' : ''} — the phone's topbar and the tab's favicon draw it`
    : '  the mark: none — the phone\'s topbar shows no mark, and the tab shows web-chat\'s W');
  return result;
}

// --preview: one pane on the running surface, posted through lib/client. It
// never applies anything, and it needs a surface to show it on.
async function postPreview(root, ctx, { kind, cands, file, pixel, darkArg }) {
  const port = daemonPort(root, ctx.opts);
  if (!port) fail(OPEN_FIRST);
  const id = project.identity(root);
  const html = previewHtml({ kind, cands, file, name: id.name, showName: id.show_name, pixel, darkArg });
  const signals = [{ key: PICK_SIGNAL, wake: 'queue' }];
  let r;
  try {
    r = await client.api('POST', '/api/render', { id: PREVIEW_ID, html, params: { signals } }, { port, root, noSpawn: true });
  } catch (e) {
    if (e instanceof client.NoServerError) fail(OPEN_FIRST);
    if (e instanceof client.HttpError) fail(`the surface refused the preview pane (${e.status}): ${e.message}`);
    throw e;
  }
  if (!r || r.ok === false) fail(`the surface refused the preview pane: ${(r && (r.hint || r.error)) || 'no reason given'}`);
  const rel = path.relative(ctx.cwd, file) || file;
  const shown = cands.filter((c) => !c.touch);
  const n = shown.length;
  const beside = [shown.some(squareish) && 'a mock tab', kind === 'logo' && 'the topbar lockup'].filter(Boolean);
  ctx.log(`✓ the preview is on the surface (pane ${PREVIEW_ID}): ${n} candidate${n === 1 ? '' : 's'} at `
    + `${PREVIEW_SIZES.join(', ')} px on a light and a dark ground${beside.length ? `, beside ${beside.join(' and ')}` : ''}`
    + `${cands.some((c) => c.touch) ? `, and the home-screen icon at ${TOUCH_PREVIEW} px on its tile` : ''}`);
  ctx.log(`  Each "Use this" button writes the signal ${PICK_SIGNAL} {seq, kind, background, dark}; it reaches Claude when you press Push (P).`);
  ctx.log(`  Then apply the pick: claude-web-chat identity ${kind} ${rel} --background <background> [--dark <dark>]`);
  return { id: PREVIEW_ID, signal: PICK_SIGNAL, render: r };
}

// ── dispatch ────────────────────────────────────────────────────────────────

// identity(args, {cwd, log, port}) → a result object. A refusal throws
// {userFacing: true} (lib/cli/index.js prints it and exits 1).
async function identity(args = [], opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const cwd = opts.cwd || process.cwd();
  const [verb = 'show', ...rest] = args.map(String);
  if (verb === 'help' || verb === '--help' || verb === '-h') { log(USAGE); return null; }
  const known = ['show', 'name', 'show-name', 'clear', ...IMAGE_KINDS];
  if (!known.includes(verb)) fail(`unknown identity verb: ${verb}`, USAGE);
  const flags = parseArgs(rest);
  // The project first: outside one, every verb refuses before reading a file.
  const { root } = resolveRoot(cwd, { mode: 'existing' });
  if (verb === 'show') {
    onlyFlags(flags, 'show', []);
    if (flags._.length) fail('identity show takes no arguments');
    return show(root, log);
  }
  const ctx = { log, cwd, opts, writer: makeWriter(root, daemonPort(root, opts)) };
  if (verb === 'name') return name(root, flags, ctx);
  if (verb === 'show-name') return showName(root, flags, ctx);
  if (verb === 'clear') return clear(root, flags, ctx);
  return imageVerb(verb, root, flags, ctx);
}

module.exports = identity;
module.exports.PREVIEW_ID = PREVIEW_ID;
module.exports.PICK_SIGNAL = PICK_SIGNAL;
module.exports.NO_TWO_HUES = NO_TWO_HUES;
module.exports.USAGE = USAGE;
