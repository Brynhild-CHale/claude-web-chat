// The remote-access setup page (lib/server/tunnel-setup). Served on its own
// origin under a CSP that allows only this file, so it is the page's only
// script. Every call carries this load's nonce (X-WC-Setup) and JSON; the
// daemon refuses anything else. Everything shown is set as text — lines come
// from Cloudflare's answers and the user's own input.
//
// The API token lives in its <input> and in the body of the one call that
// uses it (plan or apply). It is never stored, put in a URL, or shown back.
(function () {
  'use strict';

  var meta = document.querySelector('meta[name="wc-setup-token"]');
  var CSRF = meta ? meta.getAttribute('content') : '';
  var POLL_MS = 4000;
  var $ = function (id) { return document.getElementById(id); };

  var SIGNIN_LABEL = {
    'pin+biometric': 'emailed PIN + biometrics',
    pin: 'emailed PIN',
    google: 'Google',
  };

  var planned = null;   // the input the shown plan was made from
  var expired = false;

  function call(name, body) {
    return fetch('/setup/tunnel/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WC-Setup': CSRF },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  }

  function markExpired(r, j) {
    if (r.status === 403 && j && /expired/.test(String(j.error || ''))) {
      expired = true;
      $('expired').hidden = false;
    }
  }

  function callJson(name, body) {
    return call(name, body).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; })
        .then(function (j) { markExpired(r, j); return j; });
    });
  }

  // A streamed step: one JSON object per line — {line} as it happens, then
  // {done, ok, …}. Read incrementally where the browser can, whole otherwise.
  function callStream(name, body, onLine) {
    return call(name, body).then(function (r) {
      var ctype = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (!r.ok || !/ndjson/.test(ctype)) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; })
          .then(function (j) { markExpired(r, j); return j; });
      }
      var final = { ok: false, error: 'the step ended without saying how it went' };
      var buf = '';
      var take = function (text) {
        buf += text;
        var nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          var raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!raw.trim()) continue;
          var o; try { o = JSON.parse(raw); } catch (e) { continue; }
          if (o.done) final = o; else if (typeof o.line === 'string') onLine(o.line);
        }
      };
      if (r.body && r.body.getReader && typeof TextDecoder !== 'undefined') {
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var pump = function () {
          return reader.read().then(function (x) {
            if (x.done) { take(dec.decode()); take('\n'); return final; }
            take(dec.decode(x.value, { stream: true }));
            return pump();
          });
        };
        return pump();
      }
      return r.text().then(function (t) { take(t + '\n'); return final; });
    });
  }

  // ── the form ─────────────────────────────────────────────────────────────

  function input() {
    var s = document.querySelector('input[name="signin"]:checked');
    var acctRow = $('acct-row');
    return {
      token: $('f-token').value.trim(),
      hostname: $('f-host').value.trim(),
      email: $('f-email').value.trim(),
      signin: s ? s.value : 'pin+biometric',
      account: acctRow && !acctRow.hidden ? $('f-account').value : null,
    };
  }
  function sameInput(a, b) {
    return !!(a && b) && a.token === b.token && a.hostname === b.hostname && a.email === b.email
      && a.signin === b.signin && a.account === b.account;
  }
  function msg(text, bad) {
    var m = $('form-msg');
    m.textContent = text || '';
    m.classList.toggle('bad', !!bad);
  }
  function show(pre, lines) {
    pre.hidden = false;
    pre.textContent = lines.join('\n');
  }
  function append(pre, line) {
    pre.hidden = false;
    pre.textContent += (pre.textContent ? '\n' : '') + line;
    pre.scrollTop = pre.scrollHeight;
  }
  function refreshApply() {
    $('btn-apply').disabled = !(planned && sameInput(planned, input()));
  }
  function busy(on) {
    ['btn-plan', 'btn-up'].forEach(function (id) { $(id).disabled = on; });
    if (on) $('btn-apply').disabled = true; else refreshApply();
  }
  function offerAccounts(accounts) {
    var sel = $('f-account');
    sel.textContent = '';
    accounts.forEach(function (a) {
      var o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name + ' (' + a.id + ')';
      sel.appendChild(o);
    });
    $('acct-row').hidden = false;
  }

  function plan() {
    var i = input();
    planned = null;
    busy(true);
    msg('Reading your Cloudflare account…');
    return callJson('plan', i).then(function (j) {
      show($('out-setup'), j.lines || []);
      if (j.ok) {
        planned = i;
        msg('Nothing was changed. If the plan looks right, press Apply.');
      } else if (j.accounts) {
        offerAccounts(j.accounts);
        msg('This token can see more than one Cloudflare account — pick one, then show the plan again.', true);
      } else {
        msg(j.error || 'setup could not read your account', true);
      }
    }, function () { msg('the daemon did not answer — is web-chat still running?', true); })
      .then(function () { busy(false); });
  }

  function apply() {
    var i = input();
    if (!sameInput(planned, i)) { refreshApply(); return Promise.resolve(); }
    busy(true);
    msg('Applying — this takes a few seconds…');
    var pre = $('out-setup');
    pre.textContent = '';
    return callStream('apply', i, function (line) { append(pre, line); }).then(function (f) {
      if (f.ok) {
        $('f-token').value = '';
        planned = null;
        msg('Done. Sign-in: ' + (SIGNIN_LABEL[f.signin] || f.signin) + (f.why ? ' — ' + f.why : '') + '. Now bring it up.');
        if (f.picker) setPicker(f.picker);
      } else {
        if (f.accounts) offerAccounts(f.accounts);
        msg(f.error || 'setup failed', true);
      }
    }, function () { msg('the daemon did not answer — is web-chat still running?', true); })
      .then(function () { busy(false); poll(); });
  }

  function up() {
    busy(true);
    var pre = $('out-up');
    pre.textContent = '';
    return callStream('up', {}, function (line) { append(pre, line); }).then(function (f) {
      if (!f.ok) append(pre, '✗ ' + (f.error || 'the tunnel did not come up'));
    }, function () { append(pre, '✗ the daemon did not answer — is web-chat still running?'); })
      .then(function () { busy(false); poll(); });
  }

  // ── live status ──────────────────────────────────────────────────────────

  function setPicker(url) {
    var a = $('lnk-picker');
    a.href = url;
    a.textContent = url;
    $('picker-none').hidden = true;
  }

  function check(id, done, detail) {
    var li = $(id);
    li.classList.toggle('done', done === true);
    li.classList.toggle('todo', done !== true);
    li.querySelector('.detail').textContent = detail || '';
  }

  function paint(j) {
    var s = j.status || {};
    var p = s.portal || {};
    var c = s.cloudflared;
    check('ck-config', !!s.configured, s.configured ? s.hostname : (s.error ? 'not yet — ' + s.error : 'not yet'));
    check('ck-portal', !!p.running, p.running ? 'running' : 'not running');
    check('ck-connector', !!(c && c.ready),
      !c ? '—' : c.ready ? 'ready' + (c.connections != null ? ' (' + c.connections + ' connection' + (c.connections === 1 ? '' : 's') + ')' : '')
        : (c.state || 'not ready') + (c.error ? ' · ' + c.error : ''));
    check('ck-signin', !!s.signin, s.signin ? (SIGNIN_LABEL[s.signin] || s.signin) : (s.configured ? 'set up by hand' : '—'));
    check('ck-picker', !!s.picker, s.picker || '—');
    if (s.picker) setPicker(s.picker);

    var warn = [];
    if (p.invalid) warn.push('The portal cannot read tunnel.json, so it answers every remote request with an error until the file is fixed.');
    if (p.restart && p.restart.length) warn.push('Restart needed: tunnel.json changed ' + p.restart.join(', ') + ' — press Bring it up.');
    else if (p.running && p.config_current === false) warn.push('The running portal does not enforce tunnel.json as it is now — press Bring it up.');
    if (p.running && p.token_current === false) warn.push('Restart needed (connector token changed) — press Bring it up.');
    if (s.jwks_error) warn.push('Access signing keys: ' + s.jwks_error);
    var w = $('st-warn');
    w.textContent = warn.join(' ');
    w.hidden = !warn.length;
    $('st-rerun').hidden = !s.configured;

    if (j.perms && !$('perms').childElementCount) {
      j.perms.forEach(function (p) {
        var li = document.createElement('li');
        li.textContent = p;
        $('perms').appendChild(li);
      });
    }
    if (j.links) {
      if (j.links.token) $('lnk-token').href = j.links.token;
      if (j.links.zeroTrust) $('lnk-zt').href = j.links.zeroTrust;
    }
    $('st-live').textContent = '· checked ' + new Date().toLocaleTimeString();
  }

  var pollTimer = null;
  var first = true;
  function poll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (expired) return Promise.resolve();
    return callJson('status').then(function (j) {
      if (j && j.ok) {
        if (first && j.defaults) {
          if (!$('f-host').value && j.defaults.hostname) $('f-host').value = j.defaults.hostname;
          if (!$('f-email').value && j.defaults.emails && j.defaults.emails.length) $('f-email').value = j.defaults.emails.join(', ');
          first = false;
        }
        paint(j);
      }
    }, function () {}).then(function () {
      if (!expired) pollTimer = setTimeout(poll, POLL_MS);
    });
  }

  // ── copy buttons (the terminal path) ─────────────────────────────────────

  function copy(btn) {
    var text = btn.getAttribute('data-copy') || '';
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Select it'; });
    } else btn.textContent = 'Select it';
  }

  function init() {
    $('btn-plan').addEventListener('click', plan);
    $('btn-apply').addEventListener('click', apply);
    $('btn-up').addEventListener('click', up);
    ['f-token', 'f-host', 'f-email', 'f-account'].forEach(function (id) {
      $(id).addEventListener('input', refreshApply);
      $(id).addEventListener('change', refreshApply);
    });
    document.querySelectorAll('input[name="signin"]').forEach(function (r) { r.addEventListener('change', refreshApply); });
    document.querySelectorAll('button.copy').forEach(function (b) { b.addEventListener('click', function () { copy(b); }); });
    poll();
  }

  // Exposed for the jsdom test only; the page itself never reads it.
  window.__wcTunnelSetup = { plan: plan, apply: apply, up: up, poll: poll, input: input };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
