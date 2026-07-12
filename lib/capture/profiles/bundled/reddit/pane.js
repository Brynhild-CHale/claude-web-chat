// Capture pane for the reddit profile. Two modes via data-wc-when.
// Body paragraphs (bodyHtml[]) and comment bodies (textHtml) already carry
// sanitized <a> links from extract.js, so they are injected as HTML.
module.exports = {
  reduce(d) {
    const body = (d.bodyHtml || []).join(' ').replace(/<[^>]+>/g, '');
    return {
      title: d.title,
      subreddit: d.subreddit,
      author: d.author,
      snippet: body || null,
      postType: d.postType,
      commentCount: d.commentCount,
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
      stat('upvotes', d.score),
      stat('comments', d.commentCount),
      d.created ? `<span style="color:var(--wc-muted,#888);">${esc(d.created)}</span>` : '',
    ]
      .filter(Boolean)
      .join('<span style="color:var(--wc-border,#ccc);"> &middot; </span>');

    // reduced one-liner: body snippet, else a post-type hint.
    const plainBody = (d.bodyHtml || []).join(' ').replace(/<[^>]+>/g, '').trim();
    const oneLine =
      plainBody ||
      (d.postType === 'image'
        ? 'Image post'
        : d.postType === 'link' && d.linkUrl
        ? 'Link → ' + (() => { try { return new URL(d.linkUrl).hostname; } catch (_) { return d.linkUrl; } })()
        : '');

    const bodyParas = (d.bodyHtml || [])
      .map((p) => `<p style="margin:.5rem 0;line-height:1.55;">${p}</p>`)
      .join('');

    const img = d.image
      ? `<figure style="margin:.7rem 0 0;text-align:center;">
           <a href="${esc(d.titleHref || d.url || '#')}" target="_blank" rel="noopener">
             <img src="${esc(d.image.src)}" alt="${esc(d.image.alt || d.title || '')}"
                  style="max-width:100%;max-height:420px;border-radius:var(--wc-radius,8px);" loading="lazy">
           </a>
         </figure>`
      : '';

    const linkCard =
      d.postType === 'link' && d.linkUrl
        ? `<a href="${esc(d.linkUrl)}" target="_blank" rel="noopener"
              style="display:block;margin-top:.7rem;padding:.5rem .7rem;border:1px solid var(--wc-border,#e3e3e8);border-radius:var(--wc-radius,8px);background:var(--wc-panel-bg,#f7f7f9);font-size:.86rem;word-break:break-all;">🔗 ${esc(
            d.linkUrl
          )}</a>`
        : '';

    const commentCard = (c) => `
      <div style="border-top:1px solid var(--wc-border-light,#eee);padding:.55rem 0;">
        <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;font-size:.82rem;">
          ${
            c.authorHref
              ? `<a href="${esc(c.authorHref)}" target="_blank" rel="noopener" style="font-weight:600;">${esc(
                  c.author
                )}</a>`
              : `<span style="font-weight:600;">${esc(c.author)}</span>`
          }
          ${c.score != null ? `<span style="color:var(--wc-muted,#888);">${esc(c.score)} points</span>` : ''}
          ${
            c.permalink
              ? `<a href="${esc(
                  c.permalink
                )}" target="_blank" rel="noopener" style="color:var(--wc-muted,#888);margin-left:auto;font-size:.76rem;white-space:nowrap;">permalink ↗</a>`
              : ''
          }
        </div>
        <div style="font-size:.88rem;line-height:1.5;margin-top:.2rem;">${c.textHtml || esc(c.text || '')}</div>
      </div>`;

    const comments = (d.comments || []).map(commentCard).join('');

    return `
<style>
  .wc-reddit a { color: var(--wc-content-accent, var(--wc-accent, #0079d3)); text-decoration: none; }
  .wc-reddit a:hover { text-decoration: underline; }
</style>
<div class="wc-reddit" style="font-family:var(--wc-font,system-ui);color:var(--wc-content-fg,var(--wc-fg,#111));padding:1rem;max-width:680px;">
  <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;">
    ${
      d.subreddit
        ? `<a href="${esc(d.subredditHref || '#')}" target="_blank" rel="noopener" style="font-weight:700;font-size:.9rem;">${esc(
            d.subreddit
          )}</a>`
        : ''
    }
    <span style="font-size:.66rem;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:#ff4500;border-radius:4px;padding:.05rem .4rem;">Reddit</span>
  </div>
  <h2 style="margin:.3rem 0 0;font-size:1.15rem;line-height:1.3;"><a href="${esc(
    d.titleHref || d.url || '#'
  )}" target="_blank" rel="noopener">${esc(d.title || 'Untitled post')}</a></h2>
  <div style="margin-top:.2rem;font-size:.82rem;color:var(--wc-muted,#888);">
    ${
      d.author
        ? d.authorHref
          ? `<a href="${esc(d.authorHref)}" target="_blank" rel="noopener">${esc(d.author)}</a>`
          : esc(d.author)
        : ''
    }
  </div>
  ${metaLine ? `<div style="margin-top:.3rem;font-size:.85rem;">${metaLine}</div>` : ''}

  <div data-wc-when="reduced">
    ${
      oneLine
        ? `<p style="margin:.6rem 0 0;line-height:1.5;color:var(--wc-fg,#333);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(
            oneLine
          )}</p>`
        : ''
    }
    ${
      d.comments && d.comments.length
        ? `<div style="margin-top:.5rem;font-size:.78rem;color:var(--wc-muted,#999);">${d.comments.length} top comment${
            d.comments.length === 1 ? '' : 's'
          } — expand to read</div>`
        : ''
    }
  </div>

  <div data-wc-when="expanded">
    ${img}
    ${linkCard}
    ${bodyParas ? `<div style="margin-top:.6rem;">${bodyParas}</div>` : ''}
    ${
      comments
        ? `<div style="margin-top:.8rem;">
             <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;">Top comments</div>
             ${comments}
           </div>`
        : ''
    }
  </div>
</div>`;
  },
};
