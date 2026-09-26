// The portal's session picker. Served under a CSP with no inline script, and
// builds every node with createElement/textContent — a project title is a
// directory name, and a directory name can be anything.
(function () {
  'use strict';

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

  function row(s) {
    var li = el('li', 'session');
    var a = el('a');
    a.href = s.url;
    var top = el('div', 'row');
    top.appendChild(el('span', 'dot' + (s.reachable ? ' live' : '')));
    top.appendChild(el('span', 'title', s.title));
    top.appendChild(el('span', 'id', s.id));
    a.appendChild(top);
    var bits = [];
    if (!s.reachable) bits.push('not answering');
    if (s.started_at) bits.push('started ' + ago(s.started_at));
    if (s.viewers != null) bits.push(s.viewers === 1 ? '1 viewer' : s.viewers + ' viewers');
    if (s.claude_seen_at) bits.push('Claude seen ' + ago(s.claude_seen_at));
    else if (s.reachable) bits.push('no Claude session yet');
    a.appendChild(el('div', 'meta', bits.join(' · ')));
    if (s.root) a.appendChild(el('div', 'root', s.root));
    li.appendChild(a);
    return li;
  }

  function load() {
    var state = document.getElementById('state');
    var list = document.getElementById('sessions');
    fetch('/api/sessions', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var who = document.getElementById('who');
        if (data.email) { who.textContent = 'Signed in as ' + data.email; who.hidden = false; }
        list.textContent = '';
        var sessions = (data.sessions || []).slice().sort(function (a, b) { return (b.started_at || 0) - (a.started_at || 0); });
        state.textContent = sessions.length ? '' : 'No web-chat surface is running on this machine right now.';
        state.hidden = !!sessions.length;
        sessions.forEach(function (s) { list.appendChild(row(s)); });
      })
      .catch(function (e) { state.hidden = false; state.textContent = 'Could not load the session list (' + e.message + ').'; });
  }

  document.addEventListener('DOMContentLoaded', load);
  setInterval(function () { if (!document.hidden) load(); }, 10000);
}());
