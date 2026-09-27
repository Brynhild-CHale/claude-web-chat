// The portal's session picker. Served under a CSP with no inline script, and
// builds every node with createElement/textContent — a project title is a
// directory name, and a directory name can be anything.
//
// Two sections: ACTIVE (a running surface — the row is a link to it) and
// INACTIVE (stopped). Every row is clickable. An inactive project known on this
// machine opens a confirm step ("Start <title> on <host>?"); confirming POSTs
// /api/sessions/<id>/start, which starts its daemon on the host and answers
// with the session's url, and the page goes there. One that is not known here
// (a Claude session whose surface never booted) can only be started on the
// host, and the confirm step says so instead of offering Start.
(function () {
  'use strict';

  var host = 'this machine';
  var pending = null; // the row the confirm step is asking about
  var busy = false;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ago(ms) {
    if (!ms) return null;
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function badge(text, cls) { return el('span', 'badge' + (cls ? ' ' + cls : ''), text); }

  // The surface half: started · N viewers · at n1.7, or why it is not running.
  function surfaceMeta(s) {
    var sf = s.surface;
    if (!sf) {
      var seen = ago(s.last_seen_at);
      return s.known ? 'stopped' + (seen ? ' · last up ' + seen : '') : 'surface never started here';
    }
    if (!sf.reachable) return 'not answering';
    var bits = [];
    if (sf.started_at) bits.push('started ' + ago(sf.started_at));
    if (sf.viewers != null) bits.push(sf.viewers === 1 ? '1 viewer' : sf.viewers + ' viewers');
    if (sf.active_label) bits.push('at ' + sf.active_label);
    return bits.join(' · ');
  }

  // The Claude half: ● connected ×N · channel on/off · mid-turn / wake · last tool.
  function claudeLine(c, sf) {
    var line = el('span', 'claude');
    if (!c) { line.appendChild(el('span', 'muted', 'no Claude session')); return line; }
    line.appendChild(el('span', 'dot live'));
    line.appendChild(el('span', null, 'Claude connected' + (c.sessions > 1 ? ' ×' + c.sessions : '')));
    line.appendChild(badge(c.channel ? 'channel on' : 'channel off', c.channel ? 'on' : null));
    var turn = sf && sf.turn;
    if (turn === 'mid-turn') line.appendChild(badge('mid-turn', 'turn'));
    else if (turn === 'wake') line.appendChild(badge('wake turn', 'turn'));
    if (c.last_tool_at) line.appendChild(el('span', 'muted', 'last tool ' + ago(c.last_tool_at)));
    return line;
  }

  function body(box, s) {
    var top = el('span', 'row');
    top.appendChild(el('span', 'dot' + (s.surface && s.surface.reachable ? ' live' : '')));
    top.appendChild(el('span', 'title', s.title));
    top.appendChild(el('span', 'id', s.id));
    if (!s.url && s.known) top.appendChild(el('span', 'go', 'Start ›'));
    box.appendChild(top);
    box.appendChild(el('span', 'meta', surfaceMeta(s)));
    box.appendChild(claudeLine(s.claude, s.surface));
    if (s.root) box.appendChild(el('span', 'root', s.root));
  }

  // An active row is a link to its surface; an inactive one a button that
  // opens the confirm step.
  function row(s) {
    var li = el('li', 'session' + (s.url ? '' : ' stopped'));
    var box;
    if (s.url) {
      box = el('a', 'card');
      box.href = s.url;
    } else {
      box = el('button', 'card');
      box.type = 'button';
      box.addEventListener('click', function () { ask(s); });
    }
    body(box, s);
    li.appendChild(box);
    return li;
  }

  function ask(s) {
    if (busy) return;
    pending = s;
    var go = $('confirm-go');
    $('confirm-q').textContent = s.known
      ? 'Start ' + s.title + ' on ' + host + '?'
      : s.title + ' has not been started on ' + host + ' yet.';
    $('confirm-note').textContent = s.known
      ? 'This starts its web-chat surface on the host and opens it here.'
      : 'Start it once on the host with claude-web-chat open; after that it can be started from here.';
    go.hidden = !s.known;
    go.disabled = false;
    go.textContent = 'Start';
    $('confirm').hidden = false;
    (s.known ? go : $('confirm-cancel')).focus();
  }

  function dismiss() {
    if (busy) return;
    pending = null;
    $('confirm').hidden = true;
  }

  function failed(msg) {
    var go = $('confirm-go');
    busy = false;
    go.disabled = false;
    go.textContent = 'Try again';
    $('confirm-note').textContent = msg;
  }

  function start() {
    var s = pending;
    if (!s || !s.known || busy) return;
    busy = true;
    var go = $('confirm-go');
    go.disabled = true;
    go.textContent = 'Starting…';
    $('confirm-note').textContent = 'Starting ' + s.title + ' on ' + host + '…';
    fetch('/api/sessions/' + encodeURIComponent(s.id) + '/start', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (data) {
        if (data && data.ok && data.url) { window.location.assign(data.url); return; }
        failed((data && data.error) || 'Could not start it.');
      })
      .catch(function (e) { failed('Could not start it (' + e.message + ').'); });
  }

  function fill(listId, groupId, items) {
    var list = $(listId);
    list.textContent = '';
    items.forEach(function (s) { list.appendChild(row(s)); });
    $(groupId).hidden = !items.length;
  }

  function load() {
    var state = $('state');
    return fetch('/api/sessions', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var who = $('who');
        if (data.email) { who.textContent = 'Signed in as ' + data.email; who.hidden = false; }
        if (data.host) { host = data.host; $('host').textContent = host; }
        var sessions = data.sessions || [];
        fill('active', 'active-group', sessions.filter(function (s) { return !!s.url; }));
        fill('inactive', 'inactive-group', sessions.filter(function (s) { return !s.url; }));
        state.textContent = sessions.length ? '' : 'No web-chat project is known on this machine yet.';
        state.hidden = !!sessions.length;
      })
      .catch(function (e) { state.hidden = false; state.textContent = 'Could not load the session list (' + e.message + ').'; });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('confirm-go').addEventListener('click', start);
    $('confirm-cancel').addEventListener('click', dismiss);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') dismiss(); });
    load();
  });
  setInterval(function () { if (!document.hidden && !busy) load(); }, 10000);
}());
