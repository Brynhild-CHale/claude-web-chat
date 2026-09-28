// The replay player — the ONE piece of browser code a replay document runs.
//
// Two delivery channels, one physical file (the public/mount-runtime.js idea):
//   - browser: read as TEXT by lib/server/replay/document.js and spliced
//              verbatim into the replay document, where it boots the player
//              against the payload in #wc-replay-data.
//   - node:    require()d by test/replay-document.test.js, which drives the
//              timeline + controller below with a stubbed frame factory — the
//              part of a replay that must be deterministic is testable without
//              a browser.
//
// A replay is a sequence of STEPS (one per node, see domain/replay-path), each
// held on screen for a span of the timeline. The controller owns time: where
// the playhead is, which step that is, how far a fade into it has got, and
// which frames exist. Frames are <iframe srcdoc> copies of the node preview
// document (lib/server/preview.js), built on demand from the payload and
// WINDOWED — only the previous, current and next step are materialised — so a
// 200-step replay never holds 200 live documents.
//
// A step also SCROLLS its frame to what changed (lib/server/replay/document
// stepFocus hands each step `focus: {targets, enter}` — item ids). The TIME of
// every scroll move is fixed by the timeline alone (focusMoves: one slot per
// target, whatever the geometry), so the renderer knows server-side when to
// take the extra frames; WHERE each move goes is measured in the loaded frame
// (scrollPlan) and the scroll offset at any time is a pure function of the two
// (scrollAt) — the frame's scrollTop is SET, never CSS-smooth-scrolled, so a
// seek draws the motion frame by frame and the same time draws the same place.
//
// window.__wcReplay (the contract the overlay and the GIF renderer drive):
//   steps          the steps' public fields (id, label, author, kind, caption…)
//   duration()     total ms
//   seek(ms)       → Promise, resolved once the frames visible at `ms` have
//                  loaded, their fonts are ready, two animation frames have run
//                  and a short settle has passed. Deterministic: the same `ms`
//                  always draws the same thing, whatever was drawn before.
//   play() / pause() / ready() / stepBy(n) / setSpeed(x) / state() / subscribe(fn)
//
// Never embed an HTML closing-tag sequence for a script or style element in
// this file — the document splices it unescaped inside a script element (the
// replay-document test guards it). No network: the document is served under
// PREVIEW_CSP (connect-src 'none') and a downloaded replay.html is offline.

(function (glob) {
  'use strict';

  var FADE_MS = 400;          // a fade never takes longer than this…
  var FADE_SHARE = 0.4;       // …or more than this share of its step's hold
  var PACE_MIN = 1000;        // pacing:'realtime' clamps each gap to 1–6 s
  var PACE_MAX = 6000;
  var SETTLE_MS = 40;         // after 2 rAF: let a pane's own first paint land
  var FRAME_TIMEOUT_MS = 8000; // a frame that never loads must not wedge a seek
  var SPEED_MIN = 0.25;
  var SPEED_MAX = 4;
  var MOVE_MS = 700;          // one scroll move takes this long…
  var MOVE_SHARE = 0.5;       // …or, all moves together, at most this share of the hold
  var FOCUS_MARGIN = 16;      // px kept above a target put at the top, and below one brought up
  var MAX_FOCUS = 5;          // scroll targets per step (the server sends no more)

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  function focusCount(st) {
    var f = st && st.focus;
    return f && f.targets && f.targets.length ? Math.min(f.targets.length, MAX_FOCUS) : 0;
  }

  // When a step's scroll moves happen — pure, geometry-free: n targets → n
  // moves, relative to the step's start. The first starts once the fade-in is
  // done; each is followed by a dwell on its target, and the first target
  // dwells twice as long as each of the rest (it is the newest thing on the
  // page). All moves together take at most MOVE_SHARE of what the fade leaves.
  // → [{ at, dur }]
  function focusMoves(dur, fade, n) {
    if (!n) return [];
    var avail = Math.max(0, dur - fade);
    var move = Math.round(Math.min(MOVE_MS, (avail * MOVE_SHARE) / n));
    var dwell = avail - move * n;
    var out = [];
    var at = fade;
    for (var k = 0; k < n; k++) {
      out.push({ at: at, dur: move });
      at += move + (dwell * (k === 0 ? 2 : 1)) / (n + 1);
    }
    return out;
  }

  // Where each move goes, from the frame's measured geometry — pure.
  //   geo: { winH (the visible height, captions excluded), docH,
  //          targets: [{top, height} | null], enter: [{top, height} | null] }
  // The frame comes in where the step before it left off (its targets, `enter`,
  // replayed on THIS frame's geometry — so a no-change step does not jump), then:
  //   1. the first target's TOP goes to the top of the window (FOCUS_MARGIN below it);
  //   2. every further target BELOW it, top to bottom, is brought fully into
  //      view — its bottom up to the window's bottom, or its top to the top
  //      when it is taller than the window. One already in view does not move
  //      the page, and nothing scrolls back up.
  // A target that is not on the page (or has no height) holds its slot still.
  // → { start, stops: [y per move] }
  function scrollPlan(geo, n) {
    var g = geo || {};
    var winH = finite(g.winH) && g.winH > 0 ? g.winH : 0;
    var maxY = Math.max(0, (finite(g.docH) ? g.docH : 0) - winH);
    function walk(list, y0) {
      var pos = y0;
      var stops = [];
      var first = null;
      var rest = [];
      for (var k = 0; k < (list || []).length; k++) {
        var t = list[k];
        if (!t || !finite(t.top) || !(t.height > 0)) continue;
        if (first == null) first = t;
        else if (t.top > first.top) rest.push(t);
      }
      if (first) {
        pos = clamp(first.top - FOCUS_MARGIN, 0, maxY);
        stops.push(pos);
        rest.sort(function (a, b) { return a.top - b.top; });
        for (var r = 0; r < rest.length; r++) {
          var e = rest[r];
          var bottom = e.top + e.height;
          if (!(e.top >= pos && bottom <= pos + winH)) {
            var y = e.height + 2 * FOCUS_MARGIN > winH ? e.top - FOCUS_MARGIN : bottom + FOCUS_MARGIN - winH;
            pos = Math.max(pos, clamp(y, 0, maxY));
          }
          stops.push(pos);
        }
      }
      return { end: pos, stops: stops };
    }
    var start = walk(g.enter, 0).end;
    var stops = walk(g.targets, start).stops;
    var out = [];
    var last = start;
    for (var i = 0; i < n; i++) { if (i < stops.length) last = stops[i]; out.push(last); }
    return { start: start, stops: out };
  }

  // The scroll offset `u` ms into a step — pure: the plan's start before the
  // first move, each move eased (easeInOutCubic) from where the last one ended.
  function scrollAt(moves, plan, u) {
    if (!plan) return 0;
    var y = plan.start;
    for (var k = 0; k < moves.length; k++) {
      var m = moves[k];
      var to = finite(plan.stops[k]) ? plan.stops[k] : y;
      if (u < m.at) return y;
      if (u < m.at + m.dur) return y + (to - y) * easeInOutCubic((u - m.at) / m.dur);
      y = to;
    }
    return y;
  }

  // The timeline — pure. One span per step: {start, dur, fade, moves}. `fade`
  // is how long the step takes to fade in over its predecessor (0 for a cut,
  // and for the first step, which has nothing to fade over); `moves` are its
  // scroll moves (focusMoves). A replay script's step
  // carries its own `hold_ms` and `transition` (domain/replay-path), which win
  // over the replay-wide hold, pacing and transition in `opts`.
  function timeline(steps, opts) {
    var o = opts || {};
    var hold = finite(o.hold_ms) ? o.hold_ms : 2500;
    var spans = [];
    var t = 0;
    for (var i = 0; i < steps.length; i++) {
      var dur = hold;
      var st = steps[i] || {};
      if (finite(st.hold_ms)) {
        dur = st.hold_ms;
      } else if (o.pacing === 'realtime') {
        // A step is held for as long as the user actually waited for the next
        // one, within reason; the last step has no "next" and gets the hold.
        var next = steps[i + 1];
        var gap = next && finite(next.dt_from_prev) ? next.dt_from_prev : hold;
        dur = clamp(gap, PACE_MIN, PACE_MAX);
      }
      var tr = st.transition || o.transition;
      var fade = (tr === 'fade' && i > 0) ? Math.min(FADE_MS, dur * FADE_SHARE) : 0;
      spans.push({ start: t, dur: dur, fade: fade, moves: focusMoves(dur, fade, focusCount(st)) });
      t += dur;
    }
    return { spans: spans, total: t };
  }

  // The step on screen at `ms` (the last one at and past the end).
  function indexAt(tl, ms) {
    var s = tl.spans;
    if (!s.length) return -1;
    var lo = 0, hi = s.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= ms) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Where to put the playhead to show step i FULLY — its start plus its fade.
  // Stepping and tick clicks land here; landing on the bare start of a faded
  // step would show only its predecessor.
  function stepTime(tl, i) {
    var sp = tl.spans[i];
    return sp ? sp.start + sp.fade : 0;
  }

  // createController({ steps, opts, makeFrame, env, onUpdate })
  //   makeFrame(step, index) → { ready: Promise, show(opacity, layer), destroy() }
  //     layer 2 = the current step, 1 = the step it is fading in over, 0 = hidden
  //   env: { now(), raf(fn), caf(id), setTimeout(fn, ms), clearTimeout(id)? } — injectable clock
  function createController(cfg) {
    var steps = cfg.steps || [];
    var opts = cfg.opts || {};
    var env = cfg.env;
    var makeFrame = cfg.makeFrame;
    var tl = timeline(steps, opts);
    var frames = {};                  // index → handle
    var meta = {};                    // index → { loaded, plan } for a live frame
    var t = 0;
    var playing = false;
    var speed = clamp(finite(opts.speed) ? opts.speed : 1, SPEED_MIN, SPEED_MAX);
    var rafId = null;
    var lastTick = 0;
    var subs = [];

    function frame(i) {
      if (!frames[i]) {
        var h = frames[i] = makeFrame(steps[i], i);
        var m = meta[i] = { loaded: false, plan: null };
        Promise.resolve(h.ready).then(function () { m.loaded = true; }, function () { /* never loads: never scrolls */ });
      }
      return frames[i];
    }

    // Scroll frame i to where it is `u` ms into its step. The plan is measured
    // once the frame has loaded (and again by every seek, after it settles);
    // a frame factory with no measure/scrollTo (a test stub) does not scroll.
    function scrollFrame(i, u, fresh) {
      var h = frames[i];
      var m = meta[i];
      if (!h || !m || !m.loaded || typeof h.scrollTo !== 'function' || typeof h.measure !== 'function') return null;
      var sp = tl.spans[i];
      if (!m.plan || fresh) m.plan = scrollPlan(h.measure((steps[i] && steps[i].focus) || {}), sp.moves.length);
      var y = scrollAt(sp.moves, m.plan, u);
      h.scrollTo(y);
      return y;
    }

    // The current frame at the playhead, and a frame faded over at its end.
    function scrollView(v, fresh) {
      if (v.index < 0) return;
      scrolled = scrollFrame(v.index, t - tl.spans[v.index].start, fresh);
      if (v.under >= 0) scrollFrame(v.under, tl.spans[v.under].dur, fresh);
    }
    var scrolled = null;

    // What is on screen at `ms`: the current step, and — mid-fade — the step
    // under it with how opaque the current one has got.
    function viewAt(ms) {
      var i = indexAt(tl, ms);
      if (i < 0) return { index: -1, under: -1, alpha: 1 };
      var sp = tl.spans[i];
      var alpha = sp.fade > 0 ? clamp((ms - sp.start) / sp.fade, 0, 1) : 1;
      return { index: i, under: alpha < 1 ? i - 1 : -1, alpha: alpha };
    }

    function snapshot() {
      var v = viewAt(t);
      return { t: t, total: tl.total, index: v.index, alpha: v.alpha, playing: playing, speed: speed, scroll: scrolled };
    }

    function notify() {
      var s = snapshot();
      for (var k = 0; k < subs.length; k++) { try { subs[k](s); } catch (e) { /* a subscriber is not the player */ } }
    }

    // Materialise the window around the current step, drop the rest, and set
    // every live frame's visibility. Returns the frames the view depends on.
    function render() {
      var v = viewAt(t);
      if (v.index < 0) { notify(); return []; }
      var keep = {};
      for (var d = -1; d <= 1; d++) {
        var j = v.index + d;
        if (j >= 0 && j < steps.length) keep[j] = true;
      }
      for (var k in frames) {
        if (!keep[k]) { try { frames[k].destroy(); } catch (e) { /* already gone */ } delete frames[k]; delete meta[k]; }
      }
      for (var w in keep) frame(Number(w));
      for (var m in frames) {
        var idx = Number(m);
        if (idx === v.index) frames[m].show(v.alpha, 2);
        else if (idx === v.under) frames[m].show(1, 1);
        else frames[m].show(0, 0);
      }
      scrollView(v, false);
      notify();
      var needed = [frames[v.index]];
      if (v.under >= 0) needed.push(frames[v.under]);
      return needed;
    }

    function withTimeout(p) {
      return new Promise(function (resolve) {
        var done = false;
        var timer = null;
        var finish = function () {
          if (done) return;
          done = true;
          if (timer != null && env.clearTimeout) env.clearTimeout(timer);
          resolve();
        };
        timer = env.setTimeout(finish, FRAME_TIMEOUT_MS);
        Promise.resolve(p).then(finish, finish);
      });
    }

    // Two animation frames, then `then` (the scroll, measured on the laid-out
    // page), then the settle that lets it paint.
    function settle(then) {
      return new Promise(function (resolve) {
        env.raf(function () { env.raf(function () { then(); env.setTimeout(resolve, SETTLE_MS); }); });
      });
    }

    function seek(ms) {
      t = clamp(finite(ms) ? ms : 0, 0, tl.total);
      var needed = render();
      var at = t;
      return Promise.all(needed.map(function (f) { return withTimeout(f.ready); }))
        .then(function () {
          return settle(function () {
            // A later seek has moved the playhead: it scrolls for itself.
            if (t === at) { scrollView(viewAt(at), true); notify(); }
          });
        })
        .then(function () { return { t: at, index: indexAt(tl, at) }; });
    }

    function tick() {
      rafId = null;
      if (!playing) return;
      var now = env.now();
      t = Math.min(tl.total, t + (now - lastTick) * speed);
      lastTick = now;
      if (t >= tl.total) playing = false;
      render();
      if (playing) rafId = env.raf(tick);
    }

    function play() {
      if (!steps.length) return;
      if (t >= tl.total) t = 0;       // play from the end starts over
      if (playing) return;
      playing = true;
      lastTick = env.now();
      render();
      rafId = env.raf(tick);
    }

    function pause() {
      playing = false;
      if (rafId != null) { env.caf(rafId); rafId = null; }
      notify();
    }

    function stepBy(n) {
      var i = viewAt(t).index;
      // Mid-fade, "back one" means the step being faded over — the one that is
      // still most of what is on screen.
      if (n < 0 && viewAt(t).alpha < 1) n += 1;
      var target = clamp(i + n, 0, Math.max(0, steps.length - 1));
      return seek(stepTime(tl, target));
    }

    return {
      steps: steps,
      timeline: tl,
      duration: function () { return tl.total; },
      seek: seek,
      play: play,
      pause: pause,
      toggle: function () { if (playing) pause(); else play(); },
      ready: function () { return seek(t); },
      stepBy: stepBy,
      stepTime: function (i) { return stepTime(tl, i); },
      setSpeed: function (x) { speed = clamp(finite(x) ? x : 1, SPEED_MIN, SPEED_MAX); notify(); },
      state: snapshot,
      subscribe: function (fn) {
        subs.push(fn);
        return function () { var k = subs.indexOf(fn); if (k >= 0) subs.splice(k, 1); };
      },
      liveFrames: function () { return Object.keys(frames).map(Number).sort(function (a, b) { return a - b; }); },
    };
  }

  // ── the browser half: the document's own view of the controller ──────────

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // When a step was committed, in the viewer's locale: "Sep 27, 14:03".
  function fmtWhen(ms) {
    if (!finite(ms)) return '';
    try {
      return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // The default frame factory: one <iframe srcdoc> per step, filled from the
  // preview template's three pieces around the step's theme and node — both
  // already escaped server-side, so this only concatenates (lib/server/preview).
  // `inset()` is how much of the frame's bottom the caption bar covers, in the
  // frame's own px (a bare document lays the caption over the stage).
  function iframeFactory(doc, payload, stage, inset) {
    var parts = payload.frame;
    var size = payload.opts.size;
    return function (step) {
      var f = doc.createElement('iframe');
      f.className = 'rp-frame';
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      f.setAttribute('scrolling', 'no');
      f.style.width = size.w + 'px';
      f.style.height = size.h + 'px';
      f.style.opacity = '0';
      var ready = new Promise(function (resolve) {
        f.addEventListener('load', function () {
          var d = null;
          try { d = f.contentDocument; } catch (e) { d = null; }
          var fonts = d && d.fonts && d.fonts.ready;
          if (fonts && fonts.then) fonts.then(function () { resolve(); }, function () { resolve(); });
          else resolve();
        });
      });
      f.srcdoc = parts[0] + (payload.themes[step.theme] || '') + parts[1] + step.node + parts[2];
      stage.appendChild(f);
      function page() {
        var d = null;
        try { d = f.contentDocument; } catch (e) { d = null; }
        return d && (d.scrollingElement || d.documentElement) ? d : null;
      }
      return {
        ready: ready,
        // Where the focus items sit on the page, document-relative (lib/server/
        // preview: a pane is the .pane around its #<id> mount host, a markdown
        // item its [data-md-id] block).
        measure: function (focus) {
          var d = page();
          if (!d) return null;
          var se = d.scrollingElement || d.documentElement;
          var y0 = se.scrollTop || 0;
          var blocks = null;
          function geo(id) {
            var el = d.getElementById(id);
            if (el && el.classList && el.classList.contains('mount-host')) el = el.parentNode;
            else {
              el = null;
              blocks = blocks || d.querySelectorAll('[data-md-id]');
              for (var k = 0; k < blocks.length; k++) if (blocks[k].getAttribute('data-md-id') === id) { el = blocks[k]; break; }
            }
            if (!el || !el.getBoundingClientRect) return null;
            var r = el.getBoundingClientRect();
            return r.height > 0 ? { top: r.top + y0, height: r.height } : null;
          }
          return {
            winH: Math.max(1, size.h - (inset ? inset() : 0)),
            docH: se.scrollHeight,
            targets: (focus.targets || []).map(geo),
            enter: (focus.enter || []).map(geo),
          };
        },
        scrollTo: function (y) {
          var d = page();
          if (d) (d.scrollingElement || d.documentElement).scrollTop = y;
        },
        show: function (opacity, layer) {
          f.style.opacity = String(opacity);
          f.style.zIndex = String(layer);
          f.style.visibility = layer > 0 ? 'visible' : 'hidden';
        },
        destroy: function () { if (f.parentNode) f.parentNode.removeChild(f); },
      };
    };
  }

  function mountPlayer(win, payload) {
    var doc = win.document;
    var $ = function (id) { return doc.getElementById(id); };
    var opts = payload.opts;
    var stage = $('rp-stage');
    var steps = payload.steps;
    // Test seam: a stubbed frame factory installed before this script runs.
    var makeFrame = typeof win.__wcReplayFrameFactory === 'function'
      ? win.__wcReplayFrameFactory
      : iframeFactory(doc, payload, stage, function () {
        var cap = $('rp-caption');
        if (!cap || !doc.body.classList.contains('rp-bare') || doc.body.classList.contains('rp-nocap')) return 0;
        var scale = parseFloat(stage.style.getPropertyValue('--rp-scale')) || 1;
        return cap.offsetHeight / scale;
      });

    var ctl = createController({
      steps: steps,
      opts: opts,
      makeFrame: makeFrame,
      env: {
        now: function () { return win.performance && win.performance.now ? win.performance.now() : Date.now(); },
        raf: function (fn) { return win.requestAnimationFrame(fn); },
        caf: function (id) { win.cancelAnimationFrame(id); },
        setTimeout: function (fn, ms) { return win.setTimeout(fn, ms); },
        clearTimeout: function (id) { win.clearTimeout(id); },
      },
    });

    // Frames are drawn at the replay's logical size and scaled to the stage.
    function fit() {
      var w = stage.clientWidth || opts.size.w;
      var h = stage.clientHeight || opts.size.h;
      var scale = Math.min(w / opts.size.w, h / opts.size.h) || 1;
      stage.style.setProperty('--rp-scale', String(scale));
      stage.style.setProperty('--rp-ox', ((w - opts.size.w * scale) / 2) + 'px');
      stage.style.setProperty('--rp-oy', ((h - opts.size.h * scale) / 2) + 'px');
    }
    fit();
    win.addEventListener('resize', fit);

    // ── caption ──
    var capTitle = $('rp-cap-title');
    var capNote = $('rp-cap-note');
    var capLabel = $('rp-cap-label');
    var capWho = $('rp-cap-who');
    var capText = $('rp-cap-text');
    var capReply = $('rp-cap-reply');
    var capFold = $('rp-cap-folded');
    var capTime = $('rp-cap-time');
    var lastCaption = -1;
    var title = (payload.meta && payload.meta.title) || '';
    if (capTitle) { capTitle.textContent = title; capTitle.hidden = !title; }
    function caption(i) {
      if (i === lastCaption || !capLabel) return;
      lastCaption = i;
      var s = steps[i] || {};
      var c = s.caption || {};
      // A grouped step lists every node it stands for; it shows the last one.
      capLabel.textContent = s.group && s.group.length ? s.group.join(' · ') : (s.label || '');
      capLabel.title = capLabel.textContent;
      capWho.textContent = s.author || '';
      if (capTime) capTime.textContent = fmtWhen(s.created_at);
      // The prompt only when the replay was built to include it (the payload
      // holds none otherwise); without it the caption is Claude's reply.
      if (capNote) { capNote.textContent = c.text || ''; capNote.hidden = !c.text; }
      capText.textContent = c.prompt || '';
      capText.hidden = !c.prompt;
      capReply.textContent = c.reply || '';
      capReply.hidden = !c.reply;
      capFold.textContent = s.folded_count ? '+' + s.folded_count + ' folded' : '';
      capFold.hidden = !s.folded_count;
    }

    // ── controls (chrome) ──
    var btnPlay = $('rp-play');
    var timeEl = $('rp-time');
    var countEl = $('rp-count');
    var scrub = $('rp-scrub');
    var fill = $('rp-scrub-fill');
    var tip = $('rp-scrub-tip');

    if (scrub) {
      var ticks = $('rp-ticks');
      for (var i = 0; i < steps.length; i++) {
        var tk = doc.createElement('span');
        tk.className = 'rp-tick';
        tk.style.left = (ctl.timeline.total ? (ctl.timeline.spans[i].start / ctl.timeline.total) * 100 : 0) + '%';
        tk.title = steps[i].label;
        ticks.appendChild(tk);
      }
      var msAt = function (clientX) {
        var r = scrub.getBoundingClientRect();
        var x = clamp((clientX - r.left) / (r.width || 1), 0, 1);
        return x * ctl.timeline.total;
      };
      var dragging = false;
      scrub.addEventListener('pointerdown', function (e) {
        dragging = true;
        if (scrub.setPointerCapture && e.pointerId != null) { try { scrub.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ } }
        ctl.pause();
        ctl.seek(msAt(e.clientX));
      });
      scrub.addEventListener('pointermove', function (e) {
        var ms = msAt(e.clientX);
        if (tip) {
          var s = steps[indexAt(ctl.timeline, ms)];
          tip.textContent = s ? s.label : '';
          tip.style.left = (ctl.timeline.total ? (ms / ctl.timeline.total) * 100 : 0) + '%';
          tip.hidden = false;
        }
        if (dragging) ctl.seek(ms);
      });
      scrub.addEventListener('pointerup', function () { dragging = false; });
      scrub.addEventListener('pointerleave', function () { if (tip) tip.hidden = true; });
    }
    if (btnPlay) btnPlay.addEventListener('click', function () { ctl.toggle(); });
    var prev = $('rp-prev');
    var next = $('rp-next');
    if (prev) prev.addEventListener('click', function () { ctl.pause(); ctl.stepBy(-1); });
    if (next) next.addEventListener('click', function () { ctl.pause(); ctl.stepBy(1); });

    ctl.subscribe(function (s) {
      caption(s.index);
      if (btnPlay) {
        btnPlay.textContent = s.playing ? '❚❚' : '▶';
        btnPlay.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
      }
      if (timeEl) timeEl.textContent = fmtTime(s.t) + ' / ' + fmtTime(s.total);
      if (countEl) countEl.textContent = (s.index + 1) + ' / ' + steps.length;
      if (fill) fill.style.width = (s.total ? (s.t / s.total) * 100 : 0) + '%';
    });

    if (opts.chrome) {
      doc.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === ' ') { e.preventDefault(); ctl.toggle(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); ctl.pause(); ctl.stepBy(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); ctl.pause(); ctl.stepBy(1); }
        else if (e.key === 'Home') { e.preventDefault(); ctl.pause(); ctl.seek(0); }
        else if (e.key === 'End') { e.preventDefault(); ctl.pause(); ctl.seek(ctl.timeline.total); }
      });
    }

    var api = {
      steps: steps.map(function (s) {
        return {
          id: s.id, label: s.label, author: s.author, kind: s.kind, caption: s.caption, folded_count: s.folded_count,
          hold_ms: s.hold_ms, transition: s.transition, group: s.group, focus: s.focus,
        };
      }),
      title: title,
      duration: ctl.duration,
      seek: ctl.seek,
      play: ctl.play,
      pause: ctl.pause,
      toggle: ctl.toggle,
      ready: ctl.ready,
      stepBy: ctl.stepBy,
      stepTime: ctl.stepTime,
      setSpeed: ctl.setSpeed,
      state: ctl.state,
      subscribe: ctl.subscribe,
    };
    win.__wcReplay = api;

    var startAt = finite(opts.at) ? ctl.stepTime(clamp(opts.at, 0, Math.max(0, steps.length - 1))) : 0;
    ctl.seek(startAt).then(function () { if (opts.autoplay) ctl.play(); });
    return api;
  }

  var exported = {
    timeline: timeline, indexAt: indexAt, stepTime: stepTime, createController: createController,
    focusMoves: focusMoves, scrollPlan: scrollPlan, scrollAt: scrollAt, easeInOutCubic: easeInOutCubic,
    FADE_MS: FADE_MS, MOVE_MS: MOVE_MS, FOCUS_MARGIN: FOCUS_MARGIN, MAX_FOCUS: MAX_FOCUS,
    FRAME_TIMEOUT_MS: FRAME_TIMEOUT_MS,
  };

  if (glob && glob.document) {
    var el = glob.document.getElementById('wc-replay-data');
    if (el) {
      var payload = null;
      try { payload = JSON.parse(el.textContent); } catch (e) { console.error('web-chat replay: bad payload', e); }
      if (payload) mountPlayer(glob, payload);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : null);
