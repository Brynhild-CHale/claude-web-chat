// Gmail conversation extractor. root = node-html-parser document.
// Per message: sender, date, body with the quoted reply-chain + signature
// stripped (Gmail wraps those in .im / .gmail_quote). Body links preserved.
module.exports = ({ url, html, root }) => {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );

  const clean = (s) =>
    (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  const classesOf = (el) =>
    ((el && el.getAttribute && el.getAttribute('class')) || '').split(/\s+/);
  const hasAnyClass = (el, names) => classesOf(el).some((c) => names.includes(c));

  // Quoted-history / trimmed / signature wrappers to drop from a message body.
  const SKIP_CLASSES = [
    'im', 'gmail_quote', 'gmail_quote_container', 'gmail_extra',
    'moz-cite-prefix', 'adM', 'yj6qo', 'ajU', 'h5',
  ];

  const decode = (s) =>
    (s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&[a-z]+;/g, ' ');

  // Collect a message's own text, skipping quoted chain / signature / chrome.
  const walkText = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.rawText;
    if (node.nodeType !== 1) return '';
    const tag = (node.rawTagName || '').toLowerCase();
    if (['img', 'svg', 'style', 'script', 'blockquote'].includes(tag)) return '';
    if (hasAnyClass(node, SKIP_CLASSES)) return '';
    let t = node.childNodes.map(walkText).join('');
    if (['p', 'div', 'tr', 'li', 'br'].includes(tag)) t += '\n';
    return t;
  };

  // Cut at the first quoted-reply marker (Gmail "On … wrote:" or Outlook "From:").
  const cutQuote = (s) =>
    s.split(/(?:^|\n)\s*(?:On\b.{3,90}?\bwrote:|From:\s|-{2,}\s*Forwarded|_{5,})/)[0];

  const bodyText = (el) => {
    if (!el) return null;
    const t = clean(
      cutQuote(decode(walkText(el)))
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
    );
    return t || null;
  };

  const subject = clean(root.querySelector('h2.hP')?.text) || null;

  // Each message is a .gs block carrying a .gD sender. Dedupe by message key.
  const messages = [];
  const seen = new Set();
  for (const gs of root.querySelectorAll('.gs')) {
    const gd = gs.querySelector('.gD');
    if (!gd) continue;
    const from = {
      name: clean(gd.getAttribute('name') || gd.text),
      email: gd.getAttribute('email') || null,
    };
    const dateEl = gs.querySelector('.g3');
    const date = dateEl ? clean(dateEl.getAttribute('title') || dateEl.text) : null;
    const key = (from.email || from.name) + '|' + (date || messages.length);
    if (seen.has(key)) continue;
    seen.add(key);

    // Recipients of this message (.g2 spans carry name + email; inbox-list
    // entries use .yP and are excluded by scoping to the message block).
    const to = [];
    const tseen = new Set();
    for (const r of gs.querySelectorAll('.g2')) {
      const email = r.getAttribute('email');
      if (!email || tseen.has(email)) continue;
      tseen.add(email);
      to.push({ name: clean(r.getAttribute('name') || r.text) || email, email });
    }

    const a3s = gs.querySelector('.a3s'); // full body (open message)
    const snippet = gs.querySelector('.iA.g6'); // collapsed-message preview
    const expanded = !!a3s;
    const body = a3s ? bodyText(a3s) : clean(snippet?.text) || null;

    messages.push({ from, to, date, expanded, body });
  }

  // Attachments (thread-level): presence, name, size, type, and the direct
  // Gmail download link (the file itself is NOT fetched).
  const attachments = [];
  const aseen = new Set();
  for (const card of root.querySelectorAll('.aZo')) {
    const filename =
      clean(card.querySelector('.aV3')?.text) ||
      clean(card.getAttribute('data-name')) ||
      null;
    if (!filename) continue;
    const a = card.querySelector('a.aQy') || card.querySelector('a[href]');
    const url = (a ? a.getAttribute('href') || '' : '').replace(/&amp;/g, '&') || null;
    const dl = card.getAttribute('download_url') || '';
    const mime = dl.includes(':') ? dl.slice(0, dl.indexOf(':')) : null;
    const sizeM = clean(card.text).match(/(\d[\d.,]*\s?(?:bytes|KB|MB|GB))/i);
    const size = sizeM ? sizeM[1] : null;
    const key = filename + '|' + (url || '');
    if (aseen.has(key)) continue;
    aseen.add(key);
    attachments.push({ filename, size, mime, url });
  }

  // Unique contacts across the thread (sender + recipient roles), each with the
  // fullest name/email we saw. This is the whole contact available from the email.
  const contacts = [];
  const cmap = new Map();
  const addContact = (c, role) => {
    if (!c || !c.email) return;
    let rec = cmap.get(c.email);
    if (!rec) {
      rec = { name: c.name || c.email, email: c.email, roles: [] };
      cmap.set(c.email, rec);
      contacts.push(rec);
    }
    if (!rec.roles.includes(role)) rec.roles.push(role);
    if ((!rec.name || rec.name === 'me' || rec.name === rec.email) && c.name && c.name !== 'me') {
      rec.name = c.name;
    }
  };
  for (const m of messages) {
    addContact(m.from, 'sender');
    (m.to || []).forEach((t) => addContact(t, 'recipient'));
  }

  return {
    kind: 'email',
    url,
    subject,
    contacts,
    messageCount: messages.length,
    messages,
    attachments,
  };
};
