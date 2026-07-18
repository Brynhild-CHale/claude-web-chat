// The ONE source of the shadow-root mount + local pub/sub contract. Previously
// hand-copied three ways: the live client
// (public/client.js), the offline export runtime (lib/server/export.js), and the
// glance-preview doc (lib/server/routes/graph.js). Now they all consume THIS file.
//
// Two delivery channels, one physical file:
//   - browser: served as /mount-runtime.js and loaded via a classic script tag
//              BEFORE client.js.
//   - server:  read as TEXT (lib/server/runtime/mount-runtime-src.js) and spliced
//              verbatim into the export + preview HTML documents.
//
// It exposes three primitives; each consumer keeps its own outer shell (ws echo,
// pane chrome, theme application, slotting, title predicate) and calls these:
//   createStore(seed, publish?)        - the pub/sub store (no DOM, no ws)
//   attachAndExtract(host, html)       - shadow root + inline-script extraction
//   runScripts(root, scripts, ...)     - THE ONLY new Function() site
//
// Authored ES5-ish (var/function, Object.assign/Map/Set) so a baked offline
// export runs in any browser. Do NOT use ES-2016+ syntax here. Never embed an
// HTML closing-tag sequence for a script or style element in this file — the
// server splices this text unescaped inside a script element, so such a sequence
// would break out of the document (the mount-runtime test guards against it).
//
// Dev caveat: the server memoizes this file's text at first read, so editing it
// reflects in the browser on refresh but in export/preview only after
// `claude-web-chat restart` (consistent with the CLAUDE.md "lib/server/* → restart"
// rule).

(function (glob) {
  // A local pub/sub store. `set(patch, opts?)` shallow-merges, fires per-key
  // subscribers (value, key) then wildcard subscribers (patch) — each try/caught
  // in isolation — then calls the optional `publish(patch, opts)` hook (the live
  // client passes its guarded ws send here; the frozen export/preview pass none).
  function createStore(seed, publish) {
    var _state = Object.assign({}, seed || {});
    var subs = new Map();
    var allSubs = new Set();
    return {
      get: function (k) { return k === undefined ? Object.assign({}, _state) : _state[k]; },
      set: function (patch, opts) {
        opts = opts || {};
        Object.assign(_state, patch);
        Object.keys(patch).forEach(function (k) {
          var s = subs.get(k);
          if (s) s.forEach(function (fn) { try { fn(patch[k], k); } catch (e) { console.error(e); } });
        });
        allSubs.forEach(function (fn) { try { fn(patch); } catch (e) { console.error(e); } });
        if (publish) publish(patch, opts);
      },
      subscribe: function (keyOrFn, maybeFn) {
        if (typeof keyOrFn === 'function') { allSubs.add(keyOrFn); return function () { allSubs.delete(keyOrFn); }; }
        if (!subs.has(keyOrFn)) subs.set(keyOrFn, new Set());
        subs.get(keyOrFn).add(maybeFn);
        return function () { subs.get(keyOrFn).delete(maybeFn); };
      },
      // Silent bulk ops for the live client's full-surface reset (replace) and
      // (re)hello (merge). They intentionally do NOT fire subscribers or publish —
      // the client re-mounts every pane immediately after, which re-subscribes.
      // The frozen export/preview stores never call these.
      replace: function (next) {
        Object.keys(_state).forEach(function (k) { delete _state[k]; });
        Object.assign(_state, next || {});
      },
      merge: function (next) { Object.assign(_state, next || {}); },
    };
  }

  // Attach an open shadow root to `host`, parse `html` into it, and lift out the
  // inline-script bodies (declared markup mounts first; scripts run after).
  // Returns { root, scripts } — `root` is the open shadow root.
  function attachAndExtract(host, html) {
    var root = host.attachShadow({ mode: 'open' });
    var tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    var scripts = [];
    tpl.content.querySelectorAll('script').forEach(function (s) { scripts.push(s.textContent); s.remove(); });
    root.appendChild(tpl.content.cloneNode(true));
    return { root: root, scripts: scripts };
  }

  // Compile each extracted inline-script body into its own function of
  // (store, root, params, mountId) and invoke it as fn(store, shadowRoot,
  // params||{}, mountId). Each script is isolated: one that throws is caught
  // (console.error) and does not abort its siblings or the mount. THE ONLY
  // dynamic-eval site in the codebase (see the conventions tripwire).
  //
  // `onError(err, scriptIndex)` is optional: the live client passes a reporter
  // that forwards the failure to the daemon's event ring (a dead script is
  // otherwise invisible outside the browser console — the double-silent
  // failure). The frozen export/preview consumers pass nothing.
  function runScripts(root, scripts, store, params, mountId, onError) {
    for (var i = 0; i < scripts.length; i++) {
      try {
        var fn = new Function('store', 'root', 'params', 'mountId', scripts[i]);
        fn(store, root, params || {}, mountId);
      } catch (e) {
        console.error('component script error', mountId, e);
        if (onError) { try { onError(e, i); } catch (e2) {} }
      }
    }
  }

  // ── Form-state persistence primitives ────────────────────────────────────
  // A pane's form-element values (inputs, textareas, selects, contenteditable)
  // live only in its shadow DOM — rebuilt from the html snapshot on every
  // remount, so typed state would evaporate on refresh/navigation. These two
  // primitives are the one capture/apply contract: the live client debounce-
  // captures into the mount record (persisted via SNAPSHOT_FIELDS into nodes,
  // drafts, exports), and every consumer re-applies after runScripts.
  //
  // Element keys are deterministic across remounts of the same html:
  // '#<id>' / '@<name>' (when present) plus the element's enumeration index —
  // so unnamed fields still round-trip, and a same-id re-render rehydrates
  // best-effort (unmatched keys are silently dropped).
  // Skipped: password fields (never persist secrets into graph history),
  // hidden/file inputs (script-owned / unsettable), and anything marked
  // data-no-persist.
  function formElements(root) {
    var els = root.querySelectorAll('input, textarea, select, [contenteditable]');
    var out = [];
    els.forEach(function (el) {
      var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') return;
      if (el.hasAttribute && el.hasAttribute('data-no-persist')) return;
      if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return;
      out.push(el);
    });
    return out;
  }

  function formKey(el, i) {
    var base = el.id ? ('#' + el.id) : (el.name ? ('@' + el.name) : '');
    return base + ':' + i;
  }

  function captureFormState(root) {
    var out = {};
    formElements(root).forEach(function (el, i) {
      var key = formKey(el, i);
      var tag = el.tagName;
      var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') out[key] = { checked: !!el.checked };
      else if (tag === 'SELECT' && el.multiple) {
        var vals = [];
        for (var j = 0; j < el.options.length; j++) if (el.options[j].selected) vals.push(el.options[j].value);
        out[key] = { values: vals };
      } else if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') !== null)) {
        out[key] = { text: el.innerText };
      } else out[key] = { value: el.value };
    });
    return out;
  }

  // Apply a captured snapshot onto a (re)mounted root. Fires 'input' + 'change'
  // on each element whose value actually changed, so pane scripts that mirror
  // fields into local state resync — dispatch is guarded per element so one
  // throwing listener doesn't abort the rest.
  function applyFormState(root, form_state) {
    if (!form_state) return;
    formElements(root).forEach(function (el, i) {
      var rec = form_state[formKey(el, i)];
      if (!rec || typeof rec !== 'object') return;
      var changed = false;
      try {
        var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if ('checked' in rec && !!el.checked !== !!rec.checked) { el.checked = !!rec.checked; changed = true; }
        } else if (el.tagName === 'SELECT' && el.multiple) {
          if (rec.values) {
            for (var j = 0; j < el.options.length; j++) {
              var want = rec.values.indexOf(el.options[j].value) >= 0;
              if (el.options[j].selected !== want) { el.options[j].selected = want; changed = true; }
            }
          }
        } else if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') !== null)) {
          if ('text' in rec && el.innerText !== rec.text) { el.innerText = rec.text; changed = true; }
        } else if ('value' in rec && el.value !== rec.value) { el.value = rec.value; changed = true; }
        if (changed) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) { console.error('applyFormState', e); }
    });
  }

  var api = { createStore: createStore, attachAndExtract: attachAndExtract, runScripts: runScripts, captureFormState: captureFormState, applyFormState: applyFormState };
  if (glob) glob.__wcMount = api;                                                 // browser global (before client.js)
  if (typeof module !== 'undefined' && module.exports) module.exports = api;      // node require() — createStore is testable
})(typeof window !== 'undefined' ? window : null);
