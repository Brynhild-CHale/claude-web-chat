// Comment pins (feature 6) — ported from public/client.js setupPins().
//
// Pin mode: click any element on the surface to attach a comment. The pin is
// anchored to that element (mount id + selector + text + ordinal) and persisted
// server-side via /api/comments (a dedicated comments array, NOT the store —
// private pins must never leak into Claude's store reads). Shown as a 📌 marker.
// Each pin has a "share with Claude" toggle (default on); Claude reads only
// shared pins via get_comments.
import { view, $ } from './state.js';

// Module-level pin-mode state, shared between the #btn-pin-mode click handler
// (wired in initComments) and the exported togglePinMode()/setPinMode() the
// keyboard layer calls. `btn` is assigned once initComments runs.
let inited = false;
let pinMode = false;
let btn = null;
// Hoisted to module scope so the WS `comments` frame (F13) and the rail's
// answered-dot derivation (B4) can read/apply the live pin set without a fetch.
// `renderMarkersFn` is the closure-private repaint, exposed once initComments runs.
let liveComments = [];
let renderMarkersFn = null;

// F13: apply a pushed `comments` WS frame — swap the live pin set and repaint
// markers immediately (the 3s poll is now only a fallback). Exported for ws.js.
export function applyCommentsFrame(comments) {
  liveComments = Array.isArray(comments) ? comments : [];
  if (renderMarkersFn) renderMarkersFn();
}

// B4: has Claude replied in this pin's thread? Mirrors the marker's answered
// logic so the rail dot can go green only once Claude has answered. Exported for
// queue.js, which derives the dot state from the live cache.
export function isCommentAnswered(id) {
  const pin = liveComments.find((c) => c.id === id);
  return !!(pin && Array.isArray(pin.replies) && pin.replies.some((r) => r && r.author === 'claude'));
}

// Pins are suppressed while previewing a detached (historical) node — they
// belong to the live surface only. (Old file-global `previewing` → view.previewing.)
const isPreview = () => !!view.previewing;

// The single internal pin-mode toggle: the button handler and both exports call it.
export function setPinMode(on) {
  pinMode = on && !isPreview();
  if (btn) btn.classList.toggle('active', pinMode);
  document.body.classList.toggle('pin-mode', pinMode);
}

export function togglePinMode() {
  setPinMode(!pinMode);
}

export function initComments() {
  if (inited) return; // never create a second pair of setInterval pollers
  btn = $('btn-pin-mode');
  if (!btn) return;
  inited = true;

  const layer = document.createElement('div');
  layer.id = 'pin-layer';
  document.body.appendChild(layer);
  // One delegated click handler for every marker (F11): the layer survives marker
  // rebuilds, so a click can never land on a detached listener. `_pins` is stamped
  // per marker in rebuildMarkers.
  layer.addEventListener('click', (ev) => {
    const m = ev.target.closest && ev.target.closest('.pin-marker');
    if (!m || !m._pins) return;
    ev.stopPropagation();
    openPinMenu(m._pins, ev.clientX, ev.clientY);
  });

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = (window.CSS && CSS.escape) ? CSS.escape.bind(CSS) : (s) => s;

  async function refresh() {
    try {
      const r = await fetch('/api/comments').then((x) => x.json());
      liveComments = Array.isArray(r.comments) ? r.comments : [];
    } catch (_) {}
    renderMarkers();
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); setPinMode(!pinMode); });

  // --- anchor capture ---
  function hostFromPath(path) {
    for (const n of path) if (n && n.classList && n.classList.contains('mount-host')) return n;
    return null;
  }
  // Build a selector from the element's own tag + classes (the spike's most
  // robust anchor). CSS.escape each class so Tailwind-style tokens (md:flex,
  // w-1/2, leading digits) yield a queryable selector instead of throwing.
  function selectorFor(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '*';
    const classes = el.classList ? [...el.classList].map(cssEsc) : [];
    return tag + (classes.length ? '.' + classes.join('.') : '');
  }
  function captureAnchor(target, host) {
    const sel = selectorFor(target);
    let ordinal = 0;
    try { ordinal = Math.max(0, [...host.shadowRoot.querySelectorAll(sel)].indexOf(target)); } catch (_) {}
    return { mount: host.id, selector: sel, text: (target.textContent || '').trim().slice(0, 120), ordinal };
  }

  // In pin mode, resolve an event to the pane + element it targets — or null when
  // it's outside any mount (composer, markers, topbar), which passes through.
  function hit(e) {
    if (!pinMode) return null;
    const path = e.composedPath ? e.composedPath() : [];
    const host = hostFromPath(path);
    if (!host || !host.shadowRoot) return null;
    return { host, path };
  }
  // Placing a pin must beat the pane's OWN controls. A pane button commonly acts on
  // pointerdown/mousedown (before the click), so intercepting only `click` let the
  // button win. We stopPropagation the whole press sequence in the CAPTURE phase so
  // it never reaches the pane's handlers — but deliberately DON'T preventDefault on
  // the press events, since cancelling pointerdown can suppress the browser's own
  // click and we still need it. The composer opens on the click (release).
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    document.addEventListener(type, (e) => { if (hit(e)) e.stopPropagation(); }, true);
  }
  document.addEventListener('click', (e) => {
    const h = hit(e);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    const target = h.path[0] && h.path[0].nodeType === 1 ? h.path[0] : e.target;
    openComposer(captureAnchor(target, h.host), e.clientX, e.clientY);
  }, true);

  // --- popovers (composer + pin menu), dismissed on outside mousedown ---
  let pop = null, onOutside = null;
  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    if (onOutside) { document.removeEventListener('mousedown', onOutside); onOutside = null; }
  }
  function openPop(el, x, y, w, h) {
    closePop();
    pop = el;
    document.body.appendChild(el);
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    el.addEventListener('mousedown', (ev) => ev.stopPropagation());
    onOutside = () => closePop();
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  }

  function openComposer(anchor, x, y) {
    const el = document.createElement('div');
    el.className = 'pin-pop';
    el.innerHTML =
      '<div class="pin-anchor">📌 ' + esc(anchor.mount) + (anchor.text ? ' · “' + esc(anchor.text.slice(0, 40)) + '”' : '') + '</div>'
      + '<textarea class="pin-text" rows="3" placeholder="Comment…"></textarea>'
      + '<label class="pin-share"><input type="checkbox" class="pin-share-cb" checked> Share with Claude</label>'
      + '<div class="pin-actions"><button class="pin-cancel">Cancel</button><button class="pin-save">Pin</button></div>';
    openPop(el, x, y, 264, 156);
    const ta = el.querySelector('.pin-text');
    ta.focus();
    el.querySelector('.pin-cancel').addEventListener('click', closePop);
    el.querySelector('.pin-save').addEventListener('click', async () => {
      const text = ta.value.trim();
      const shared = el.querySelector('.pin-share-cb').checked;
      closePop();
      setPinMode(false);
      try {
        await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, shared, anchor }) });
      } catch (_) {}
      refresh();
    });
  }

  // Local pin lookup/update so a fresh reply re-renders the open thread without a
  // round-trip to the server list.
  const findPin = (id) => liveComments.find((c) => c.id === id) || null;
  function upsertPin(pin) {
    const i = liveComments.findIndex((c) => c.id === pin.id);
    if (i >= 0) liveComments[i] = pin; else liveComments.push(pin);
  }
  // A pin's thread as message rows: the root note (a user message) then each reply.
  function threadMessages(pin) {
    const msgs = [{ author: 'user', text: pin.text || '' }];
    for (const r of (Array.isArray(pin.replies) ? pin.replies : [])) msgs.push(r);
    return msgs;
  }

  // A marker click opens the thread(s) it stands for — one pin opens its thread,
  // a grouped marker opens a chooser.
  function openPinMenu(pins, x, y) {
    if (isPreview()) return; // never mutate live pins while viewing history
    if (pins.length > 1) openThreadChooser(pins, x, y);
    else openThread(pins[0].id, x, y);
  }

  function openThreadChooser(pins, x, y) {
    const el = document.createElement('div');
    el.className = 'pin-pop pin-chooser';
    el.innerHTML = '<div class="pin-anchor">' + pins.length + ' comments here</div>'
      + pins.map((p) => {
        const n = Array.isArray(p.replies) ? p.replies.length : 0;
        const answered = (p.replies || []).some((r) => r.author === 'claude');
        return '<button class="pin-thread-row" data-id="' + esc(p.id) + '">'
          + '<span class="ptr-dot' + (answered ? ' answered' : '') + (p.shared ? '' : ' private') + '"></span>'
          + '<span class="ptr-text">' + esc((p.text || '(no comment)').slice(0, 60)) + '</span>'
          + (n ? '<span class="ptr-n">' + n + '</span>' : '') + '</button>';
      }).join('');
    openPop(el, x, y, 288, 44 + pins.length * 34);
    el.querySelectorAll('.pin-thread-row').forEach((row) =>
      row.addEventListener('click', () => openThread(row.dataset.id, x, y)));
  }

  // The Google-Docs-style thread: anchor, the message stack (you / Claude), and a
  // reply box that posts a USER reply (which enqueues so Push continues the thread).
  function openThread(id, x, y) {
    const pin = findPin(id);
    if (!pin) { closePop(); return; }
    const el = document.createElement('div');
    el.className = 'pin-pop pin-thread';
    const anchorLabel = esc(pin.anchor && pin.anchor.mount ? pin.anchor.mount : 'pane')
      + (pin.anchor && pin.anchor.text ? ' · “' + esc(String(pin.anchor.text).slice(0, 32)) + '”' : '');
    const msgs = threadMessages(pin).map((mmsg) =>
      '<div class="pin-msg ' + (mmsg.author === 'claude' ? 'claude' : 'user') + '">'
      + '<div class="pin-who">' + (mmsg.author === 'claude' ? 'Claude' : 'You') + '</div>'
      + '<div class="pin-body">' + esc(mmsg.text || '') + '</div></div>').join('');
    el.innerHTML =
      '<div class="pin-anchor">📌 ' + anchorLabel + '</div>'
      + '<div class="pin-thread-msgs">' + msgs + '</div>'
      + '<div class="pin-reply"><textarea class="pin-reply-text" rows="2" placeholder="Reply…"></textarea>'
      + '<div class="pin-actions"><label class="pin-share"><input type="checkbox" class="pin-share-cb" '
      + (pin.shared ? 'checked' : '') + '> Shared</label><span class="pin-spacer"></span>'
      + '<button class="pin-del" title="Delete this comment">Delete</button>'
      + '<button class="pin-reply-send">Reply</button></div></div>';
    openPop(el, x, y, 300, 260);
    const ta = el.querySelector('.pin-reply-text');
    ta.focus();
    const send = async () => {
      const text = ta.value.trim();
      if (!text) return;
      const stale = el.querySelector('.pin-reply-err');
      if (stale) stale.remove();
      let r = null;
      try {
        const resp = await fetch('/api/comments/' + encodeURIComponent(pin.id) + '/reply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, author: 'user' }),
        });
        if (resp.ok) r = await resp.json();
      } catch (_) {}
      // F10: only a confirmed ok response with a pin clears the draft (via the
      // re-render below). A 404 / {error} / network failure keeps the typed reply
      // and shows an inline hint instead of silently re-rendering from stale cache.
      if (!r || !r.pin) {
        const err = document.createElement('div');
        err.className = 'pin-reply-err';
        err.textContent = 'Reply failed — draft kept. Try again.';
        el.querySelector('.pin-reply').appendChild(err);
        return;
      }
      upsertPin(r.pin);
      renderMarkers();
      openThread(pin.id, x, y); // re-render the thread in place with the new message
    };
    el.querySelector('.pin-reply-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    el.querySelector('.pin-share-cb').addEventListener('change', async (ev) => {
      try { await fetch('/api/comments/' + encodeURIComponent(pin.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared: ev.target.checked }) }); } catch (_) {}
      refresh();
    });
    el.querySelector('.pin-del').addEventListener('click', async () => {
      closePop();
      try { await fetch('/api/comments/' + encodeURIComponent(pin.id), { method: 'DELETE' }); } catch (_) {}
      refresh();
    });
  }

  // --- marker rendering (resolve each pin's element, draw a 📌 over it) ---
  // Ordinal is the primary disambiguator (class/tag selector is the spike's most
  // reliable anchor, 6/6); text is only a tiebreak so identical-text twins don't
  // pull the marker to the wrong element.
  function resolveAnchorEl(a) {
    const host = a && $(a.mount);
    if (!host || !host.shadowRoot) return null;
    let cands = [];
    try { cands = [...host.shadowRoot.querySelectorAll(a.selector)]; } catch (_) { return null; }
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const txt = (e) => (e.textContent || '').trim().slice(0, 120);
    if (Number.isInteger(a.ordinal) && a.ordinal >= 0 && a.ordinal < cands.length) {
      const atOrdinal = cands[a.ordinal];
      if (!a.text || txt(atOrdinal) === a.text) return atOrdinal;
      return cands.find((e) => txt(e) === a.text) || atOrdinal;
    }
    if (a.text) {
      const byText = cands.find((e) => txt(e) === a.text);
      if (byText) return byText;
    }
    return cands[0];
  }

  // A 26px map-pin glyph; currentColor + a panel-bg hole so it reads
  // as a pin at any theme. Coloured by the marker's state class (see .pin-marker CSS).
  const PIN_SVG = '<svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true">'
    + '<path d="M8 1.4c-2.5 0-4.4 2-4.4 4.4 0 3.2 4.4 8.8 4.4 8.8s4.4-5.6 4.4-8.8C12.4 3.4 10.5 1.4 8 1.4z" fill="currentColor"/>'
    + '<circle cx="8" cy="5.8" r="1.55" style="fill:var(--wc-panel-bg)"/></svg>';
  const answeredByClaude = (pin) => Array.isArray(pin.replies) && pin.replies.some((r) => r && r.author === 'claude');

  // F11: marker rendering is split so scroll/resize/idle never rebuild nodes (which
  // detaches a marker mid-click). `markerSig` is a cheap fingerprint of the pin set
  // and its colour-bearing state; nodes are rebuilt only when it changes, and every
  // other frame just repositions the existing nodes.
  let markerSig = null;
  function markersSig() {
    const parts = [];
    for (const pin of liveComments) {
      if (!(pin.anchor && resolveAnchorEl(pin.anchor))) continue;
      parts.push(pin.id + ':' + (pin.shared ? 1 : 0) + ':' + (answeredByClaude(pin) ? 1 : 0));
    }
    return parts.join('|');
  }

  // Reposition existing marker nodes over their anchors — no node churn, so an
  // in-flight click survives. A vanished or zero-size anchor hides its marker.
  function positionMarkers() {
    for (const m of layer.children) {
      const el = m._anchor && resolveAnchorEl(m._anchor);
      const r = el && el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) { m.style.display = 'none'; continue; }
      m.style.display = '';
      m.style.left = r.left + 'px';
      m.style.top = r.top + 'px';
    }
  }

  // Rebuild the marker nodes from scratch (only on a pin-set/state change). Group
  // pins by the element they resolve to: multiple comments on one element share ONE
  // marker with a subscript count. Positions are set by positionMarkers.
  function rebuildMarkers() {
    layer.innerHTML = '';
    const groups = new Map(); // element → { pins:[] }
    for (const pin of liveComments) {
      const el = pin.anchor && resolveAnchorEl(pin.anchor);
      if (!el) continue;
      let g = groups.get(el);
      if (!g) { g = { pins: [] }; groups.set(el, g); }
      g.pins.push(pin);
    }
    for (const { pins } of groups.values()) {
      const anyShared = pins.some((p) => p.shared);
      const answered = pins.some((p) => p.shared && answeredByClaude(p));
      // colour: all-private → muted; Claude answered a thread → green;
      // otherwise coral (--wc-comment).
      const state = !anyShared ? 'private' : (answered ? 'replied' : '');
      const m = document.createElement('div');
      m.className = 'pin-marker' + (state ? ' ' + state : '');
      m.innerHTML = PIN_SVG + (pins.length > 1 ? '<span class="pin-count">' + pins.length + '</span>' : '');
      m.title = pins.map((p) => (p.shared ? '' : '(private) ') + (p.text || '')).join('  •  ');
      m._pins = pins;                 // read by the delegated click handler
      m._anchor = pins[0].anchor;     // representative anchor for repositioning
      layer.appendChild(m);
    }
    positionMarkers();
  }

  function renderMarkers() {
    if (isPreview()) { // pins belong to the live surface only
      if (layer.firstChild) layer.innerHTML = '';
      markerSig = null; // force a rebuild when we return to live
      return;
    }
    const sig = markersSig();
    if (sig !== markerSig) { markerSig = sig; rebuildMarkers(); }
    else positionMarkers();
  }
  renderMarkersFn = renderMarkers; // expose for applyCommentsFrame (F13)

  // Scroll/resize only reposition (F11) — cheap and non-destructive.
  window.addEventListener('scroll', positionMarkers, true);
  window.addEventListener('resize', positionMarkers);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // F12: guard an in-progress reply. When the reply textarea is focused and holds
    // a draft, the first Escape only blurs it (popover + draft survive); the next
    // Escape (focus now off it) closes as before. shell.js stands down here because
    // the focused textarea is editable.
    const ta = pop && pop.querySelector && pop.querySelector('.pin-reply-text');
    if (ta && document.activeElement === ta && ta.value.trim()) { e.preventDefault(); ta.blur(); return; }
    closePop();
    setPinMode(false);
  });
  setInterval(renderMarkers, 500); // reflow / preview-transition fallback; rebuilds only on a pin-set change (F11)
  setInterval(refresh, 3000);      // fallback sync — the WS `comments` frame is now the primary path (F13)
  refresh();
}
