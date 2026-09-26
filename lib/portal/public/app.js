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

  function badge(text, cls) { return el('span', 'badge' + (cls ? ' ' + cls : ''), text); }

  // The surface half: started · N viewers · at n1.7, or why there is no link.
  function surfaceMeta(sf) {
    if (!sf) return 'surface stopped';
    if (!sf.reachable) return 'not answering';
    var bits = [];
    if (sf.started_at) bits.push('started ' + ago(sf.started_at));
    if (sf.viewers != null) bits.push(sf.viewers === 1 ? '1 viewer' : sf.viewers + ' viewers');
    if (sf.active_label) bits.push('at ' + sf.active_label);
    return bits.join(' · ');
  }

  // The Claude half: ● connected ×N · channel on/off · mid-turn / wake · last tool.
  function claudeLine(c, sf) {
    var line = el('div', 'claude');
    if (!c) { line.appendChild(el('span', null, 'no Claude session')); return line; }
    line.appendChild(el('span', 'dot live'));
    line.appendChild(el('span', null, 'Claude connected' + (c.sessions > 1 ? ' \u00d7' + c.sessions : '')));
    line.appendChild(badge(c.channel ? 'channel on' : 'channel off', c.channel ? 'on' : null));
    var turn = sf && sf.turn;
    if (turn === 'mid-turn') line.appendChild(badge('mid-turn', 'turn'));
    else if (turn === 'wake') line.appendChild(badge('wake turn', 'turn'));
    if (c.last_tool_at) line.appendChild(el('span', 'muted', 'last tool ' + ago(c.last_tool_at)));
    return line;
  }

  // A project with a running surface is a link to it. One with only a Claude
  // session is NOT: the portal never starts a daemon, so there is nothing to
  // open until someone runs `claude-web-chat open` on the host.
  function row(s) {
    var li = el('li', 'session' + (s.url ? '' : ' stopped'));
    var box = s.url ? el('a') : el('div', 'card');
    if (s.url) box.href = s.url;
    var top = el('div', 'row');
    top.appendChild(el('span', 'dot' + (s.surface && s.surface.reachable ? ' live' : '')));
    top.appendChild(el('span', 'title', s.title));
    top.appendChild(el('span', 'id', s.id));
    box.appendChild(top);
    box.appendChild(el('div', 'meta', s.url ? surfaceMeta(s.surface) : 'Claude attached \u00b7 surface stopped'));
    box.appendChild(claudeLine(s.claude, s.surface));
    if (!s.url) box.appendChild(el('div', 'meta', 'Start its surface on the host: claude-web-chat open'));
    if (s.root) box.appendChild(el('div', 'root', s.root));
    li.appendChild(box);
    return li;
  }

  // Running surfaces first, then the Claude-only projects; the server's order
  // (by title) within each.
  function order(list) {
    var up = [], down = [];
    list.forEach(function (s) { (s.url ? up : down).push(s); });
    return up.concat(down);
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
        var sessions = order(data.sessions || []);
        state.textContent = sessions.length ? '' : 'No web-chat surface or Claude session is running on this machine right now.';
        state.hidden = !!sessions.length;
        sessions.forEach(function (s) { list.appendChild(row(s)); });
      })
      .catch(function (e) { state.hidden = false; state.textContent = 'Could not load the session list (' + e.message + ').'; });
  }

  document.addEventListener('DOMContentLoaded', load);
  setInterval(function () { if (!document.hidden) load(); }, 10000);
}());
