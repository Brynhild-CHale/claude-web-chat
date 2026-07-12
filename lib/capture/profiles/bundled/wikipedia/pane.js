// Capture pane for the wikipedia profile. Two modes via data-wc-when.
// Content fields (summaryHtml, infobox facts' valueHtml) already contain
// sanitized <a> links from extract.js, so they are injected as HTML.
module.exports = {
  reduce(d) {
    return {
      title: d.title,
      shortDescription: d.shortDescription,
      image: d.image,
      temporalRange: d.infobox && d.infobox.temporalRange,
      facts: ((d.infobox && d.infobox.facts) || []).slice(-3),
    };
  },

  render(d, ctx) {
    const esc = (s) =>
      String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
      );

    const facts = (d.infobox && d.infobox.facts) || [];
    const factRows = facts
      .map(
        (f) =>
          `<tr><td style="color:var(--wc-muted,#666);padding:.1rem .7rem .1rem 0;white-space:nowrap;vertical-align:top;">${esc(
            f.key
          )}</td><td>${f.valueHtml || esc(f.value)}</td></tr>`
      )
      .join('');

    const summaryParas = (d.summaryHtml || [])
      .map((p) => `<p style="margin:.45rem 0;line-height:1.55;">${p}</p>`)
      .join('');

    const sections = (d.sections || [])
      .map(
        (s) =>
          `<li><a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(
            s.title
          )}</a></li>`
      )
      .join('');

    const lead = d.summaryHtml && d.summaryHtml[0] ? d.summaryHtml[0] : '';

    const img = d.image
      ? `<figure style="margin:.6rem 0 0;text-align:center;">
        <img src="${esc(d.image.src)}" alt="${esc(d.image.caption || d.title)}"
             style="max-width:100%;max-height:260px;border-radius:var(--wc-radius,8px);" loading="lazy">
        ${
          d.image.caption
            ? `<figcaption style="font-size:.72rem;color:var(--wc-muted,#888);margin-top:.3rem;line-height:1.4;">${esc(
                d.image.caption
              )}</figcaption>`
            : ''
        }
      </figure>`
      : '';

    return `
<style>
  .wc-wiki a { color: var(--wc-content-accent, var(--wc-accent, #3366cc)); text-decoration: none; }
  .wc-wiki a:hover { text-decoration: underline; }
</style>
<div class="wc-wiki" style="font-family:var(--wc-font,system-ui);color:var(--wc-content-fg,var(--wc-fg,#111));padding:1rem;max-width:720px;">
  <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;">
    <h2 style="margin:0;"><a href="${esc(d.titleHref || '#')}" target="_blank" rel="noopener">${esc(
      d.title
    )}</a></h2>
    <span style="font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:var(--wc-muted,#888);border:1px solid var(--wc-border,#ddd);border-radius:999px;padding:.05rem .55rem;">Wikipedia</span>
  </div>
  ${
    d.shortDescription
      ? `<div style="color:var(--wc-muted,#666);font-style:italic;margin-top:.15rem;">${esc(
          d.shortDescription
        )}</div>`
      : ''
  }
  ${img}
  ${
    d.infobox
      ? `<div style="margin-top:.8rem;border:1px solid var(--wc-border,#e3e3e8);border-radius:var(--wc-radius,8px);padding:.6rem .8rem;background:var(--wc-panel-bg,#f7f7f9);">
    ${
      d.infobox.temporalRange
        ? `<div style="font-size:.78rem;color:var(--wc-muted,#666);margin-bottom:.35rem;">⏳ ${esc(
            d.infobox.temporalRange
          )}</div>`
        : ''
    }
    <table style="border-collapse:collapse;font-size:.85rem;"><tbody>${factRows}</tbody></table>
  </div>`
      : ''
  }
  <p data-wc-when="reduced" style="margin:.75rem 0 0;line-height:1.55;">${lead}</p>
  <div data-wc-when="expanded">
    <div style="margin-top:.6rem;">${summaryParas}</div>
    ${
      sections
        ? `<div style="margin-top:.7rem;"><div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--wc-muted,#888);font-weight:600;">Contents</div><ul style="margin:.35rem 0 0;padding-left:1.15rem;line-height:1.65;">${sections}</ul></div>`
        : ''
    }
  </div>
</div>`;
  },
};
