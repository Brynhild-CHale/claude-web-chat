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
//   runScripts(root, scripts, ...)     - a pane's inline-script bodies
//   runSeed(code, store)               - a component's seed.js
// The last two are THE ONLY dynamic-eval sites in the codebase. Beside them:
//   settle(root, mountId, why)         - the sync point: the pane's DOM is final
//   onSettle(fn) / generation(root)    - hear it / read a root's count of them
//   itemEl(doc, id)                    - a page item (pane host or markdown block) by id
//   paneFetch(mountId)                 - fetch stamped with the pane header (same origin only)
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
      // Silent bulk ops for the live client's full-surface reset. They
      // intentionally do NOT fire subscribers or publish — the authoritative
      // path re-mounts every pane immediately after, which re-subscribes. A
      // caller that does NOT re-mount (mounts.applySnapshot's reconcile) must
      // publish the diff itself, or a kept pane keeps rendering values the store
      // no longer holds. The frozen export/preview stores never call these.
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

  // The pane API a script gets beside store/root when its page cannot act on the
  // surface — the frozen export and the read-only previews. Both verbs answer
  // (never throw), so a pane that spawns children still mounts in a snapshot;
  // they just do nothing there.
  //
  // A frozen page never takes a pane down, so its `signal` never aborts and
  // `onUnmount` registers nothing. An engine without AbortController gets a
  // stand-in that answers the same questions (aborted:false, listeners no-ops).
  function frozenPaneApi() {
    var no = function () {
      return Promise.resolve({ ok: false, frozen: true, hint: 'this page is a read-only snapshot; panes cannot spawn or close panes here' });
    };
    return { spawn: no, close: no, signal: neverAborts(), onUnmount: function () {} };
  }

  function neverAborts() {
    if (typeof AbortController !== 'undefined') return new AbortController().signal;
    var nop = function () {};
    return { aborted: false, reason: undefined, onabort: null, addEventListener: nop, removeEventListener: nop,
      dispatchEvent: function () { return false; }, throwIfAborted: nop };
  }

  // ── a pane's timers end with the pane ────────────────────────────────────
  // With a `life` ({timers, signal, onUnmount}), runScripts compiles each pane
  // script with six more parameters that SHADOW the global timer functions
  // inside it: setTimeout, clearTimeout, setInterval, clearInterval,
  // requestAnimationFrame, cancelAnimationFrame. Each calls the global AT CALL
  // TIME (whatever `setTimeout` names when the pane calls it, not when the pane
  // mounted) and records the handle in `life.timers` as {handle, kind, clear}:
  // `clear()` is the matching global clear call, which the caller runs for
  // every entry still recorded when the pane goes (public/app/mounts.js
  // releasePane). A timeout or frame that has fired, and anything the pane
  // cleared itself, leaves the record. Once `life.signal` has aborted the pane
  // is gone, so a timer asked for after that (a script that awaited something
  // first) is never scheduled and answers 0.
  //
  // `window.setInterval` and friends are the globals themselves: a pane that
  // reaches for them is not tracked.
  var TIMER_PARAMS = 'setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame, cancelAnimationFrame';

  function paneTimers(life) {
    var timers = life.timers;
    var gone = function () { return !!(life.signal && life.signal.aborted); };
    // 'timer' covers timeouts and intervals: a browser clears either with
    // either call, so the pane's clears find either.
    function forget(handle, group) {
      timers.forEach(function (t) { if (t.handle === handle && t.group === group) timers.delete(t); });
    }
    function track(handle, kind, group, clear) {
      var entry = { handle: handle, kind: kind, group: group, clear: clear };
      timers.add(entry);
      return entry;
    }
    function wrapFire(fn, getEntry) {
      if (typeof fn !== 'function') return fn;
      return function () {
        var e = getEntry();
        if (e) timers.delete(e);
        return fn.apply(this, arguments);
      };
    }
    function oneShot(kind, schedule, clearName) {
      return function (fn) {
        if (gone()) return 0;
        var entry = null;
        var args = Array.prototype.slice.call(arguments);
        args[0] = wrapFire(fn, function () { return entry; });
        var handle = schedule(args);
        entry = track(handle, kind, kind === 'frame' ? 'frame' : 'timer', function () { clearByName(clearName, handle); });
        return handle;
      };
    }
    function clearer(clearName, group) {
      return function (handle) {
        forget(handle, group);
        return clearByName(clearName, handle);
      };
    }
    return [
      oneShot('timeout', function (args) { return setTimeout.apply(undefined, args); }, 'clearTimeout'),
      clearer('clearTimeout', 'timer'),
      function (fn) {
        if (gone()) return 0;
        var handle = setInterval.apply(undefined, arguments);
        track(handle, 'interval', 'timer', function () { clearByName('clearInterval', handle); });
        return handle;
      },
      clearer('clearInterval', 'timer'),
      oneShot('frame', function (args) { return requestAnimationFrame(args[0]); }, 'cancelAnimationFrame'),
      clearer('cancelAnimationFrame', 'frame'),
    ];
  }

  // ── a pane's same-origin fetches carry its mount id (PLAN 1B.4) ──────────
  // With a `life`, runScripts also shadows `fetch` inside each pane script with
  // paneFetch(mountId): the global fetch, looked up AT CALL TIME, with the pane
  // header (lib/core/writer-token PANE_HEADER — this file is spliced into
  // documents and cannot require it, so it spells the name once, here) set to
  // the pane's own mount id on every SAME-ORIGIN request. The daemon reads it
  // through lib/server/domain/writers resolveWriter: a local browser request
  // stamped with a live pane's id is that pane (class 'pane', owner
  // 'pane:<id>'), and the comment and spawn routes act on it. A cross-origin
  // URL goes to the global fetch untouched — a custom header would turn a
  // simple request into a preflighted one. A Request input is re-wrapped with
  // the header; a header of the same name the script set itself is replaced.
  //
  // COOPERATIVE, NOT A FENCE. Pane scripts run in the chrome's own realm
  // (lib/server/routes/packs.js records that as accepted; B1/X-4 own it), so a
  // script that calls `window.fetch` — or forges this header on it — is not
  // stamped, or is stamped as whichever pane it names. The stamp attributes
  // the pane scripts that cooperate; it cannot hold one that does not. Nothing
  // it grants is more than an unstamped browser request already has: a stamp
  // only NARROWS (a pane edits and deletes only its own pins; spawn and close
  // must name the stamping pane as the parent).
  //
  // The chrome's per-pane facade (public/app/mounts.js paneApiFor) sends its
  // spawn and close through the same function, so the header has one spelling.
  var PANE_HEADER = 'X-WC-Pane';

  function globalFetch() {
    if (glob && typeof glob.fetch === 'function') return glob.fetch;
    return typeof fetch === 'function' ? fetch : null;
  }

  function pageLocation() {
    if (glob && glob.location) return glob.location;
    return typeof location !== 'undefined' ? location : null;
  }

  // Same origin as the page: resolved against the page's own URL. With no
  // location at all (never the live chrome), only a relative URL counts: one
  // that does not parse on its own and is not scheme-relative.
  function isSameOrigin(url) {
    var loc = pageLocation();
    var s = String(url);
    try {
      if (loc && loc.href) return new URL(s, loc.href).origin === new URL(loc.href).origin;
    } catch (e) { return false; }
    try { new URL(s); return false; } catch (e2) { return s.slice(0, 2) !== '//'; }
  }

  // Copy a HeadersInit (a Headers, an array of pairs, or a plain object) into
  // a plain object, dropping any pane header the caller set.
  function copyHeaders(from, into) {
    if (!from) return into;
    var put = function (v, k) { if (String(k).toLowerCase() !== PANE_HEADER.toLowerCase()) into[k] = v; };
    if (Array.isArray(from)) from.forEach(function (pair) { if (pair) put(pair[1], pair[0]); });
    else if (typeof from.forEach === 'function') from.forEach(put);
    else for (var k in from) { if (Object.prototype.hasOwnProperty.call(from, k)) put(from[k], k); }
    return into;
  }

  function paneFetch(mountId) {
    var id = String(mountId);
    return function (input, init) {
      var f = globalFetch();
      if (!f) return Promise.reject(new TypeError('fetch is not available'));
      var isRequest = typeof Request === 'function' && input instanceof Request;
      if (!isSameOrigin(isRequest ? input.url : input)) return f(input, init);
      var opts = {};
      if (init) { for (var k in init) { if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k]; } }
      var headers = copyHeaders(isRequest ? input.headers : null, {});
      copyHeaders(init && init.headers, headers);
      headers[PANE_HEADER] = id;
      opts.headers = headers;
      return isRequest ? f(new Request(input, opts)) : f(input, opts);
    };
  }

  // THE dynamic-eval site for pane scripts: (store, root, params, mountId, api),
  // then `extra` — the parameter names runScripts shadows for a live pane (the
  // six timer names, and `fetch`), or none.
  function compileScript(extra, body) {
    return new Function('store, root, params, mountId, api' + (extra ? ', ' + extra : ''), body);
  }

  // The global clear by name, looked up at call time.
  function clearByName(name, handle) {
    if (name === 'clearTimeout') return clearTimeout(handle);
    if (name === 'clearInterval') return clearInterval(handle);
    if (typeof cancelAnimationFrame === 'function') return cancelAnimationFrame(handle);
  }

  // Compile each extracted inline-script body into its own function of
  // (store, root, params, mountId, api) and invoke it as fn(store, shadowRoot,
  // params||{}, mountId, api). Each script is isolated: one that throws is caught
  // (console.error) and does not abort its siblings or the mount. THE ONLY
  // dynamic-eval site in the codebase (see the conventions tripwire).
  //
  // `onError(err, scriptIndex)` is optional: the live client passes a reporter
  // that forwards the failure to the daemon's event ring (a dead script is
  // otherwise invisible outside the browser console — the double-silent
  // failure). The frozen export/preview consumers pass nothing.
  //
  // `api` is the pane's {spawn(spec), close(id)} (panes spawning panes): the live
  // client passes one bound to this mount id (public/app/mounts.js paneApiFor);
  // without one, a script gets frozenPaneApi().
  //
  // `life` ({timers, signal, onUnmount}) is optional too: the live client passes
  // one per pane, and each script is then compiled with the six timer names
  // shadowed (paneTimers, above), so the bare setTimeout / setInterval /
  // requestAnimationFrame of a pane script end with the pane. Without it the
  // compile is exactly what it always was — the frozen export and preview pass
  // none, and their scripts read the globals.
  //
  // With a `life`, `fetch` is shadowed too, after the timer names: paneFetch
  // (above) stamps the pane's same-origin requests with its mount id. Preview
  // and export (no `life`) keep the global fetch.
  function runScripts(root, scripts, store, params, mountId, onError, api, life) {
    var paneApi = api || frozenPaneApi();
    var timerArgs = life ? paneTimers(life) : null;
    // Most shadowed first. A script that declares one of the names itself with
    // let/const/class (`const fetch = …`) cannot be compiled with that name as
    // a parameter: one that declares `fetch` falls back to the timer names
    // alone (its timers still end with the pane; its fetches go unstamped),
    // and one that declares a timer name falls back to neither, as before — it
    // keeps working on the globals, only its timers go untracked.
    var shapes = timerArgs
      ? [[TIMER_PARAMS + ', fetch', timerArgs.concat([paneFetch(mountId)])], [TIMER_PARAMS, timerArgs]]
      : [];
    for (var i = 0; i < scripts.length; i++) {
      try {
        var fn = null;
        var extraArgs = [];
        for (var s = 0; s < shapes.length && !fn; s++) {
          try { fn = compileScript(shapes[s][0], scripts[i]); extraArgs = shapes[s][1]; } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
        }
        if (fn) fn.apply(undefined, [store, root, params || {}, mountId, paneApi].concat(extraArgs));
        else compileScript('', scripts[i])(store, root, params || {}, mountId, paneApi);
      } catch (e) {
        console.error('component script error', mountId, e);
        if (onError) { try { onError(e, i); } catch (e2) {} }
      }
    }
  }

  // A component's optional seed.js: browser-side code that computes default
  // params when the user spawns the component from the drawer. It runs as an
  // ASYNC function body with `store` in scope, so a seed may await.
  //
  // This lived in public/app/drawer.js, deriving the AsyncFunction constructor
  // inline. That is a second dynamic-eval site — the exact thing the conventions
  // ratchet exists to stop — and it dodged the tripwire only because the tripwire
  // matched one literal spelling and this is the other one. The eval belongs here
  // with runScripts, and the ratchet now matches this spelling too (see the
  // AsyncFunction pattern in test/conventions.test.js).
  //
  // Deriving the constructor WITHOUT writing `async function` in this file's own
  // source is deliberate: the server splices this text verbatim into exported
  // documents, so an engine too old to parse `async` would fail to parse the
  // WHOLE file rather than just this line. Built lazily, once.
  var _asyncCtor = null;
  function asyncCtor() {
    if (!_asyncCtor) {
      try {
        _asyncCtor = new Function('return Object.getPrototypeOf(async function () {}).constructor')();
      } catch (e) {
        // No async support in this engine. A plain Function still runs the seed;
        // `await` inside it would be a syntax error, which surfaces as a normal
        // seed failure rather than taking the page down.
        _asyncCtor = Function;
      }
    }
    return _asyncCtor;
  }

  // Returns a promise for whatever the seed returned (or null if it threw — a
  // broken seed must degrade to "no defaults", never to a dead spawn).
  function runSeed(code, store, onError) {
    try {
      var Ctor = asyncCtor();
      var fn = new Ctor('store', code);
      return Promise.resolve(fn(store)).catch(function (e) {
        if (onError) { try { onError(e); } catch (e2) {} }
        return null;
      });
    } catch (e) {
      if (onError) { try { onError(e); } catch (e2) {} }
      return Promise.resolve(null);
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
  // The ONE predicate for "this element's value is never captured". Two
  // consumers: the form-state capture below, and the shell's delegated
  // dom-event reporter (public/app/mounts.js reportEvent), which forwards an
  // event target's value into the daemon's event ring. Both must honour the
  // same guarantee — a password reaching get_events is the same leak as one
  // reaching form_state. Tolerates a non-element target (shadow root, document).
  function isValueExcluded(el) {
    if (!el) return false;
    var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') return true;
    if (el.hasAttribute && el.hasAttribute('data-no-persist')) return true;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return true;
    return false;
  }

  function formElements(root) {
    var els = root.querySelectorAll('input, textarea, select, [contenteditable]');
    var out = [];
    els.forEach(function (el) { if (!isValueExcluded(el)) out.push(el); });
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
  //
  // It returns X-11's tally of the snapshot's keys against the DOM it was
  // applied to, {kept, shifted, missing} (DECISIONS.md C4; the counter the
  // daemon keeps, lib/server/domain/form-shifts — the live chrome sends it,
  // the documents ignore it). A key K's base is K before its LAST ':' (an id
  // may hold one). kept: some field's key now equals K. shifted: K's base is
  // '#id' or '@name' and some field now carries that base at another index —
  // a real positional shift, whose value the exact-key lookup below does NOT
  // apply. missing: anything else (a base-less key that moved is missing).
  // The lookup stays the exact key: A2 (a re-key by element) is not built.
  function applyFormState(root, form_state) {
    if (!form_state) return;
    var els = formElements(root);
    var keysNow = Object.create(null);
    var basesNow = Object.create(null);
    els.forEach(function (el, i) {
      var k = formKey(el, i);
      keysNow[k] = true;
      var b = k.slice(0, k.lastIndexOf(':'));
      if (b) basesNow[b] = true;
    });
    var tally = { kept: 0, shifted: 0, missing: 0 };
    Object.keys(form_state).forEach(function (k) {
      if (keysNow[k] === true) { tally.kept++; return; }
      var c = k.lastIndexOf(':');
      var b = c >= 0 ? k.slice(0, c) : '';
      if (b && basesNow[b] === true) tally.shifted++;
      else tally.missing++;
    });
    els.forEach(function (el, i) {
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
    return tally;
  }

  // ── the settle sync point ─────────────────────────────────────────────────
  // THE moment a pane's anchorable DOM is final: later than runScripts' return
  // (after applyFormState, and for a mode pane after the wc:mode re-assert), and
  // again whenever the chrome changes what a mounted pane shows (a remote form,
  // a mode change from either side). Every shell calls it at those points as
  // window.__wcMount.settle(root, mountId, why), read off the global at the call.
  //
  // settle is synchronous and does nothing but count and tell: it bumps the
  // root's generation and calls each onSettle listener as
  // fn(root, mountId, gen, why), each try/caught on its own, then returns the
  // new generation. It schedules nothing and touches no DOM; a listener that
  // has work to do (the anchors resolver) schedules it itself, and can drop a
  // pass whose root's generation(root) has moved on since.
  var generations = new WeakMap();
  var settleListeners = [];

  function settle(root, mountId, why) {
    if (!root || typeof root !== 'object') return 0;
    var gen = (generations.get(root) || 0) + 1;
    generations.set(root, gen);
    var entries = settleListeners.slice();
    for (var i = 0; i < entries.length; i++) {
      try { entries[i].fn(root, mountId, gen, why); } catch (e) { console.error('settle listener error', mountId, e); }
    }
    return gen;
  }

  // → an unsubscribe that removes this registration (and only it), once.
  function onSettle(fn) {
    if (typeof fn !== 'function') throw new TypeError('onSettle: expects a function');
    var entry = { fn: fn };
    settleListeners.push(entry);
    return function () {
      var at = settleListeners.indexOf(entry);
      if (at >= 0) settleListeners.splice(at, 1);
    };
  }

  // The root's current generation: 0 until its first settle.
  function generation(root) {
    if (!root || typeof root !== 'object') return 0;
    return generations.get(root) || 0;
  }

  // An item of the page by its id, in any shell (the live chrome, a preview, a
  // replay frame, an export): {kind: 'pane', el: <its .mount-host>} or
  // {kind: 'md', el: <its [data-md-id] block>}, else null. It SCANS, and panes
  // first: a pane's id is agent-supplied and may name a chrome element
  // (contents-nav) — the live host then keeps it in data-mount-id only, and a
  // lookup by document id would find the chrome — and an arbitrary id would
  // need escaping to go into a selector.
  function itemEl(doc, id) {
    if (!doc || id == null) return null;
    var key = String(id);
    var hosts = doc.querySelectorAll('.mount-host');
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (((h.dataset && h.dataset.mountId) || h.id) === key) return { kind: 'pane', el: h };
    }
    var blocks = doc.querySelectorAll('[data-md-id]');
    for (var j = 0; j < blocks.length; j++) {
      if (blocks[j].getAttribute('data-md-id') === key) return { kind: 'md', el: blocks[j] };
    }
    return null;
  }

  var api = { createStore: createStore, frozenPaneApi: frozenPaneApi, attachAndExtract: attachAndExtract, runScripts: runScripts, paneFetch: paneFetch, runSeed: runSeed, captureFormState: captureFormState, applyFormState: applyFormState, isValueExcluded: isValueExcluded, settle: settle, onSettle: onSettle, generation: generation, itemEl: itemEl };
  if (glob) glob.__wcMount = api;                                                 // browser global (before client.js)
  if (typeof module !== 'undefined' && module.exports) module.exports = api;      // node require() — createStore is testable
})(typeof window !== 'undefined' ? window : null);
