// Capture pane for the gmail profile. Two modes via data-wc-when.
// Contacts (senders + recipients) are click-to-reveal: tap a contact card to
// show their full name + email (mailto) and role in the thread.
module.exports = {
  reduce(d) {
    const msgs = d.messages || [];
    return {
      subject: d.subject,
      contacts: d.contacts,
      messageCount: d.messageCount,
      attachments: d.attachments,
      latest: msgs.length ? msgs[msgs.length - 1] : null,
    };
  },

  render(d, ctx) {
    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
      );

    const msgs = d.messages || [];
    const atts = d.attachments || [];
    const contacts = d.contacts || [];

    const initials = (name) =>
      (name || '?')
        .replace(/[^A-Za-z ]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || '?';

    // A click-to-reveal contact card: avatar + name; tap toggles the detail row.
    const contactCard = (c) => `
      <div class="wc-contact" data-email="${esc(c.email)}" style="border:1px solid var(--wc-border,#e3e3e8);border-radius:var(--wc-radius,8px);overflow:hidden;">
        <div class="wc-contact-head" style="display:flex;align-items:center;gap:.5rem;padding:.35rem .55rem;cursor:pointer;">
          <span style="flex:none;width:26px;height:26px;border-radius:50%;background:var(--wc-accent,#3366cc);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:600;">${esc(
            initials(c.name)
          )}</span>
          <span style="font-size:.85rem;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(
            c.name
          )}</span>
          <span class="wc-caret" style="color:var(--wc-muted,#999);font-size:.7rem;">▾</span>
        </div>
        <div class="wc-contact-detail" style="display:none;padding:.1rem .6rem .5rem 2.1rem;font-size:.8rem;line-height:1.6;">
          <div>✉ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>
          <div style="color:var(--wc-muted,#888);">${esc(
            (c.roles || []).join(' · ')
          )}</div>
        </div>
      </div>`;

    const contactsBlock = contacts.length
      ? `<div style="margin-top:.6rem;">
           <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;margin-bottom:.3rem;">Contacts (${contacts.length}) — tap to reveal</div>
           <div style="display:flex;flex-direction:column;gap:.35rem;">${contacts
             .map(contactCard)
             .join('')}</div>
         </div>`
      : '';

    const attachmentCard = (a) => `
      <div style="display:flex;align-items:center;gap:.5rem;border:1px solid var(--wc-border,#e3e3e8);border-radius:var(--wc-radius,8px);padding:.4rem .6rem;background:var(--wc-panel-bg,#f7f7f9);">
        <span style="font-size:1.1rem;">📎</span>
        <div style="min-width:0;flex:1;">
          <div style="font-size:.84rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(
            a.filename
          )}</div>
          <div style="font-size:.72rem;color:var(--wc-muted,#888);">${esc(
            [a.mime, a.size].filter(Boolean).join(' · ')
          )}</div>
        </div>
        ${
          a.url
            ? `<a href="${esc(
                a.url
              )}" target="_blank" rel="noopener" style="font-size:.78rem;white-space:nowrap;">⬇ Download</a>`
            : ''
        }
      </div>`;

    const attachmentsBlock = atts.length
      ? `<div style="margin-top:.7rem;display:flex;flex-direction:column;gap:.4rem;">
           <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;">Attachments (${atts.length})</div>
           ${atts.map(attachmentCard).join('')}
         </div>`
      : '';

    // Inline clickable contact (name) inside a message header.
    const contactInline = (c, extra) =>
      c && c.email
        ? `<span class="wc-contact" data-email="${esc(c.email)}" style="cursor:pointer;">
             <span class="wc-contact-head" style="font-weight:600;border-bottom:1px dotted var(--wc-border,#bbb);">${esc(
               c.name || c.email
             )}</span>
             <span class="wc-contact-detail" style="display:none;color:var(--wc-muted,#888);font-weight:400;"> &lt;<a href="mailto:${esc(
               c.email
             )}">${esc(c.email)}</a>&gt;</span>
           </span>${extra || ''}`
        : `<span style="font-weight:600;">${esc((c && c.name) || 'Unknown')}</span>`;

    const messageBlock = (m) => {
      const toLine = (m.to || []).length
        ? `<div style="font-size:.76rem;color:var(--wc-muted,#888);margin-top:.1rem;">to ${m.to
            .map((t) => contactInline(t))
            .join(', ')}</div>`
        : '';
      return `
      <div style="display:flex;gap:.6rem;padding:.6rem 0;border-top:1px solid var(--wc-border-light,#eee);">
        <div style="flex:none;width:30px;height:30px;border-radius:50%;background:var(--wc-accent,#3366cc);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;">${esc(
          initials(m.from && m.from.name)
        )}</div>
        <div style="min-width:0;flex:1;">
          <div style="display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
            <span style="font-size:.88rem;">${contactInline(m.from)}</span>
            <span style="color:var(--wc-muted,#888);font-size:.78rem;white-space:nowrap;">${esc(
              m.date || ''
            )}</span>
          </div>
          ${toLine}
          <div style="font-size:.86rem;line-height:1.5;margin-top:.25rem;white-space:pre-wrap;color:var(--wc-fg,#222);">${esc(
            m.body || ''
          )}</div>
        </div>
      </div>`;
    };

    const latest = msgs.length ? msgs[msgs.length - 1] : null;

    return `
<style>
  .wc-mail a { color: var(--wc-content-accent, var(--wc-accent, #3366cc)); text-decoration: none; }
  .wc-mail a:hover { text-decoration: underline; }
  .wc-mail .wc-contact.open .wc-caret { transform: rotate(180deg); }
</style>
<div class="wc-mail" style="font-family:var(--wc-font,system-ui);color:var(--wc-content-fg,var(--wc-fg,#111));padding:1rem;max-width:680px;">
  <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;">
    <h2 style="margin:0;font-size:1.15rem;">${
      d.url
        ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(
            d.subject || '(no subject)'
          )}</a>`
        : esc(d.subject || '(no subject)')
    }</h2>
    <span style="font-size:.64rem;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:#d93025;border-radius:4px;padding:.05rem .4rem;">Gmail</span>
    <span style="color:var(--wc-muted,#888);font-size:.78rem;">${esc(
      String(d.messageCount || msgs.length || 0)
    )} message${(d.messageCount || msgs.length) === 1 ? '' : 's'}</span>
    ${
      d.url
        ? `<a href="${esc(
            d.url
          )}" target="_blank" rel="noopener" style="font-size:.78rem;white-space:nowrap;margin-left:auto;">↗ Open in Gmail</a>`
        : ''
    }
  </div>

  <!-- reduced: contacts + latest message + attachments -->
  <div data-wc-when="reduced">
    ${contactsBlock}
    ${latest ? messageBlock(latest) : ''}
    ${
      msgs.length > 1
        ? `<div style="font-size:.76rem;color:var(--wc-muted,#999);padding-top:.3rem;">+ ${
            msgs.length - 1
          } earlier message${msgs.length - 1 === 1 ? '' : 's'} — expand to read</div>`
        : ''
    }
    ${attachmentsBlock}
  </div>

  <!-- expanded: contacts + full thread + attachments -->
  <div data-wc-when="expanded">
    ${contactsBlock}
    <div style="margin-top:.5rem;">${msgs.map(messageBlock).join('')}</div>
    ${attachmentsBlock}
  </div>
</div>
<script>
  (function () {
    root.addEventListener('click', function (e) {
      var head = e.target.closest && e.target.closest('.wc-contact-head');
      if (!head) return;
      var card = head.closest('.wc-contact');
      if (!card) return;
      if (e.target.tagName === 'A') return; // let mailto links work
      var detail = card.querySelector('.wc-contact-detail');
      if (!detail) return;
      var show = detail.style.display === 'none';
      detail.style.display = show ? '' : 'none';
      card.classList.toggle('open', show);
    });
  })();
</script>`;
  },
};
