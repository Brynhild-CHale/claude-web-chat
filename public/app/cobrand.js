// The topbar's top-left corner: the co-brand lockup (design spec §9.4). Left of
// a hairline divider, the global theme's company image (Settings → Brand, or
// the theme pack's own marks; brand.js); right of it, the project's identity,
// its logo and its name (project.js).
//
//   #cobrand.cobrand[.has-logo][.has-mark][.has-plogo][.has-pmark][.no-name]
//    ├ span#cobrand-co.cobrand-co        only while a company image exists
//    │  ├ img#cobrand-logo  data-slot     the wide choice: the logotype, else the seal
//    │  └ img#cobrand-mark  data-slot     the narrow choice: the seal, else the logotype
//    ├ span.cobrand-div                   only with #cobrand-co
//    └ span#cobrand-proj.cobrand-proj    (index.html)
//       ├ img#cobrand-icon  data-shape    only with a project logo: tile (square) or wide
//       ├ img#cobrand-pmark               only with a project mark, the phone's
//       └ span#cobrand-name               always: the name
//
// ABSENT MEANS ABSENT. An image is in the DOM only while it has a source: no
// empty <img>, no letter tile standing in for a logo nobody set, no divider
// beside nothing. One that fails to load hides itself and drops its class, so a
// broken file leaves no broken-image glyph and no orphan divider either. This
// module sets only the classes and the data attributes; which images a width
// shows is app.css's, at the one narrow breakpoint (max-width: 759px). On a
// narrow screen the name is not drawn, and stays in the tooltip, the tab title
// and the accessibility tree.
//
// WHICH MODE. Every image here follows web-chat's OWN mode — the ◑ toggle and
// the theme, which theme.js marks on <html data-theme> — never the browser's
// colour scheme (that one is the favicon's). A MutationObserver on the
// attribute keeps this module out of theme.js's import graph. A flip swaps the
// company image for its reversed mark, and the project's images ask for
// ?mode=dark, which serves the dark variant when one is set and the light image
// otherwise.
//
// It redraws on the chrome bus's `brand` (brand.js, whenever the slots land)
// and `project` (project.js, whenever the identity does). The name is the
// user's text: textContent and a title attribute, never markup.
import { $ } from './state.js';
import { bus } from './bus.js';
import { slotSrc } from './brand.js';
import { getProject } from './project.js';

// web-chat's effective mode, as theme.js leaves it on <html>: data-theme="light",
// or no attribute for dark.
const viewMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// A project logo is drawn as the Final's 20px tile when it is square — width and
// height within 2 %, the identity engine's tolerance — and as a wordmark, at its
// own aspect ratio and never cropped, otherwise. A logo of unknown size is a
// wordmark: drawn at its own aspect ratio, it cannot be cropped.
const SQUARE_TOLERANCE = 0.02;
function shapeOf(meta) {
  const w = meta && meta.width;
  const h = meta && meta.height;
  if (!(w > 0 && h > 0)) return 'wide';
  return Math.abs(w - h) <= SQUARE_TOLERANCE * Math.max(w, h) ? 'tile' : 'wide';
}

// One of the project's images in `mode`, cache-keyed by the version of the file
// that mode serves, so a dark variant's change reloads only the dark image.
function projectSrc(route, light, dark, mode) {
  if (!light) return null;
  const meta = mode === 'dark' && dark ? dark : light;
  return `/project/${route}?${mode === 'dark' ? 'mode=dark&' : ''}v=${encodeURIComponent(meta.version)}`;
}

// One <img> of the lockup, kept to `src`: made when it gains one, removed when
// it loses it. A new source shows it again; a failed one hides it until then.
function syncImg(id, cls, src) {
  let img = $(id);
  if (!src) {
    if (img) img.remove();
    return null;
  }
  if (!img) {
    img = document.createElement('img');
    img.id = id;
    img.className = cls;
    img.alt = '';
    img.addEventListener('error', () => {
      img.hidden = true;
      render();
    });
  }
  if (img.getAttribute('src') !== src) {
    img.hidden = false;
    img.setAttribute('src', src);
  }
  return img;
}

// Put `nodes` (nulls skipped) first in `parent`, in this order, moving only
// what is out of place: a redraw that changes nothing touches nothing.
function order(parent, nodes) {
  let prev = null;
  for (const n of nodes) {
    if (!n) continue;
    const want = prev ? prev.nextElementSibling : parent.firstElementChild;
    if (n !== want) parent.insertBefore(n, want);
    prev = n;
  }
}

const shown = (img) => !!img && !img.hidden;
const setData = (el, key, value) => { if (el.dataset[key] !== value) el.dataset[key] = value; };

function render() {
  const host = $('cobrand');
  const proj = $('cobrand-proj');
  const nameEl = $('cobrand-name');
  if (!host || !proj || !nameEl) return;
  const mode = viewMode();

  // The company half: the logotype is the slot designed for the topbar, the
  // seal the square emblem the phone lockup draws. Each falls back to the
  // other, so a theme with either one has both.
  const logotype = slotSrc('logotype', mode);
  const seal = slotSrc('seal', mode);
  const wide = logotype ? { slot: 'logotype', src: logotype } : seal ? { slot: 'seal', src: seal } : null;
  const narrow = seal ? { slot: 'seal', src: seal } : logotype ? { slot: 'logotype', src: logotype } : null;
  let co = $('cobrand-co');
  let div = host.querySelector('.cobrand-div');
  let logo = null;
  let mark = null;
  if (wide && narrow) {
    if (!co) {
      co = document.createElement('span');
      co.id = 'cobrand-co';
      co.className = 'cobrand-co';
    }
    if (!div) {
      div = document.createElement('span');
      div.className = 'cobrand-div';
      div.setAttribute('aria-hidden', 'true');
    }
    order(host, [co, div, proj]);
    logo = syncImg('cobrand-logo', 'cobrand-logo', wide.src);
    mark = syncImg('cobrand-mark', 'cobrand-mark', narrow.src);
    setData(logo, 'slot', wide.slot);
    setData(mark, 'slot', narrow.slot);
    order(co, [logo, mark]);
  } else {
    if (co) co.remove();
    if (div) div.remove();
  }

  // The project half: the logo (wide screens) and the mark (the phone's square
  // image: the favicon, else a square logo), each in this mode.
  const id = getProject();
  const icon = syncImg('cobrand-icon', 'cobrand-icon', projectSrc('logo', id.logo, id.logo_dark, mode));
  if (icon) setData(icon, 'shape', shapeOf(id.logo));
  const source = id.mark;
  const pmark = syncImg('cobrand-pmark', 'cobrand-pmark',
    source ? projectSrc('mark', id[source], id.mark_dark ? id[`${source}_dark`] : null, mode) : null);
  order(proj, [icon, pmark, nameEl]);

  if (nameEl.textContent !== id.name) nameEl.textContent = id.name;
  const folder = id.default_name;
  const tip = id.custom && folder && folder !== id.name ? `${id.name} (${folder})` : id.name;
  if (host.title !== tip) host.title = tip;

  host.classList.toggle('has-logo', shown(logo));
  host.classList.toggle('has-mark', shown(mark));
  host.classList.toggle('has-plogo', shown(icon));
  host.classList.toggle('has-pmark', shown(pmark));
  // The text name steps back only beside a logo that shows: show_name is off
  // for a wordmark that already spells the name, and with no logo (or one
  // that failed) the name is all the project half has.
  host.classList.toggle('no-name', id.show_name === false && shown(icon));
}

let started = false;
export function initCobrand() {
  if (started) return;
  started = true;
  bus.on('brand', () => render());
  bus.on('project', () => render());
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => render())
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  render();
}
