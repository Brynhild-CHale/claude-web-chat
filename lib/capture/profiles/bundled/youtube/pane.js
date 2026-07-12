// Capture pane for the youtube profile. Two modes via data-wc-when.
module.exports = {
  reduce(d) {
    return {
      title: d.title,
      channel: d.channel,
      views: d.views,
      published: d.published,
      likes: d.likes,
      thumbnail: d.thumbnail,
    };
  },

  render(d, ctx) {
    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
      );

    const stat = (label, val) =>
      val
        ? `<span style="white-space:nowrap;"><strong>${esc(val)}</strong> <span style="color:var(--wc-muted,#888);">${esc(
            label
          )}</span></span>`
        : '';

    const metaLine = [
      stat('views', d.views ? String(d.views).replace(/\s*views$/i, '') : null),
      stat('likes', d.likes),
      d.published
        ? `<span style="color:var(--wc-muted,#888);">${esc(d.published)}</span>`
        : '',
    ]
      .filter(Boolean)
      .join('<span style="color:var(--wc-border,#ccc);"> &middot; </span>');

    const links = (d.links || [])
      .map(
        (l) =>
          `<li><a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(
            l.text
          )}</a></li>`
      )
      .join('');

    const thumb = d.thumbnail
      ? `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="display:block;position:relative;">
           <img src="${esc(d.thumbnail)}" alt="${esc(d.title || '')}"
                style="width:100%;border-radius:var(--wc-radius,8px);display:block;" loading="lazy">
           <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
             <span style="width:54px;height:54px;border-radius:50%;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;">
               <span style="border-left:18px solid #fff;border-top:11px solid transparent;border-bottom:11px solid transparent;margin-left:5px;"></span>
             </span>
           </span>
         </a>`
      : '';

    return `
<style>
  .wc-yt a { color: var(--wc-content-accent, var(--wc-accent, #3366cc)); text-decoration: none; }
  .wc-yt a:hover { text-decoration: underline; }
</style>
<div class="wc-yt" style="font-family:var(--wc-font,system-ui);color:var(--wc-content-fg,var(--wc-fg,#111));padding:1rem;max-width:640px;">
  ${thumb}
  <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;margin-top:.7rem;">
    <h2 style="margin:0;font-size:1.15rem;line-height:1.3;"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(
      d.title || 'Untitled'
    )}</a></h2>
    <span style="font-size:.66rem;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:#c00;border-radius:4px;padding:.05rem .4rem;">YouTube</span>
  </div>
  ${
    d.channel
      ? `<div style="margin-top:.35rem;font-size:.92rem;">
           <a href="${esc(d.channel.url)}" target="_blank" rel="noopener"><strong>${esc(
             d.channel.name
           )}</strong></a>
           ${
             d.subscribers
               ? `<span style="color:var(--wc-muted,#888);"> &middot; ${esc(
                   d.subscribers
                 )}</span>`
               : ''
           }
         </div>`
      : ''
  }
  ${metaLine ? `<div style="margin-top:.3rem;font-size:.85rem;">${metaLine}</div>` : ''}

  <div data-wc-when="expanded">
    ${
      d.summary
        ? `<div style="margin-top:.8rem;padding:.6rem .8rem;border-left:3px solid var(--wc-accent,#c00);background:var(--wc-panel-bg,#f7f7f9);border-radius:0 var(--wc-radius,8px) var(--wc-radius,8px) 0;">
             <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;">AI summary</div>
             <div style="font-size:.88rem;line-height:1.5;margin-top:.2rem;">${esc(
               d.summary
             )}</div>
           </div>`
        : ''
    }
    ${
      d.description
        ? `<p style="margin:.7rem 0 0;font-size:.88rem;line-height:1.5;white-space:pre-wrap;">${esc(
            d.description
          )}</p>`
        : ''
    }
    ${
      links
        ? `<div style="margin-top:.7rem;"><div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;">Links in description</div><ul style="margin:.35rem 0 0;padding-left:1.15rem;line-height:1.6;font-size:.86rem;">${links}</ul></div>`
        : ''
    }
  </div>
</div>`;
  },
};
