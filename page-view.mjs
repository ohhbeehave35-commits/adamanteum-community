// A readable web page for one vault note (owner 25 Oct 11:28): headings, tables, lists and code drawn as a page, and every
// colour value (#rrggbb, #rgb inside code, rgb(), rgba(), hsl()) drawn with a swatch beside it. Read-only, no script,
// nothing is fetched. Used by GET /acceptance/page. Pure: text in, HTML out.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLOR = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[0-9.]+)?\s*\)|hsla?\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*[0-9.]+)?\s*\)/g;
const SHORT = /^#[0-9a-fA-F]{3}$/;

/** A swatch for a colour value; the value stays visible as text so the page can be read without colour. */
export const swatch = (v) => `<span class="sw" style="--c:${esc(v)}"></span>`;

function colorize(htmlEscaped, inCode) {
  const text = htmlEscaped.replace(/&quot;/g, '"');
  let out = '';
  let last = 0;
  const re = inCode ? new RegExp(COLOR.source + '|#[0-9a-fA-F]{3}\\b', 'g') : new RegExp(COLOR.source, 'g');
  for (const m of text.matchAll(re)) {
    out += text.slice(last, m.index).replace(/"/g, '&quot;') + swatch(m[0].replace(/&quot;/g, '"')) + m[0];
    last = m.index + m[0].length;
  }
  return out + text.slice(last).replace(/"/g, '&quot;');
}

/** Inline markdown on already-escaped text. `link(target)` turns a note link into a page URL. */
function inline(raw, link) {
  const spans = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => { spans.push(`<code>${colorize(c, true)}</code>`); return `\u0000${spans.length - 1}\u0000`; });
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => { const u = link(t.trim()); return u ? `<a href="${esc(u)}">${l || t}</a>` : (l || t); });
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/&lt;(\/?)(sub|sup)&gt;/gi, '<$1$2>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^https?:\/\//i.test(u) ? `<a href="${esc(u)}" rel="noreferrer">${t}</a>` : /^(javascript|data):/i.test(u) ? t : (link(decodeURIComponent(u)) ? `<a href="${esc(link(decodeURIComponent(u)))}">${t}</a>` : t)));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = colorize(s.replace(/<[^>]+>/g, (t) => t.replace(/"/g, '\u0001')), false).replace(/\u0001/g, '"');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

/** Markdown body (frontmatter already allowed) to HTML. */
export function renderBody(md, link = (t) => t) {
  const lines = String(md).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = [];
  let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${colorize(esc(buf.join('\n')), false)}</pre>`);
    } else if (/^(#{1,6})\s+(.*)$/.test(l)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(l);
      out.push(`<h${m[1].length}>${inline(m[2], link)}</h${m[1].length}>`);
      i++;
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c, link)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t, link)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '), link)}</blockquote>`);
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push(`<p>${inline(buf.join(' '), link)}</p>`);
    }
  }
  return out.join('\n');
}

const CSS = `
:root{--bg:#11151d;--fg:#edf0f7;--mute:#a6afc2;--card:#191e28;--edge:#bac8e33d;--link:#b3bdf1}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--fg:#161a24;--mute:#566074;--card:#fff;--edge:#1a254033;--link:#3347b0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Segoe UI",system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 80px}
nav{font-size:14px;color:var(--mute);margin-bottom:6px}a{color:var(--link)}
h1{font-size:28px;margin:10px 0 6px}h2{font-size:21px;margin:28px 0 8px;border-bottom:1px solid var(--edge);padding-bottom:4px}h3{font-size:17px;margin:20px 0 6px}
p,li{overflow-wrap:anywhere}code{font:14px/1.5 ui-monospace,Consolas,monospace;background:var(--card);border:1px solid var(--edge);border-radius:6px;padding:1px 5px;overflow-wrap:anywhere}
pre{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:14px;overflow-x:auto;font:14px/1.5 ui-monospace,Consolas,monospace}
blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid var(--edge);color:var(--mute)}
.tw{overflow-x:auto;border:1px solid var(--edge);border-radius:12px;margin:12px 0;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--edge);vertical-align:top;overflow-wrap:break-word;word-break:normal}td{min-width:6.5em}td code{white-space:nowrap}
th{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}tr:last-child td{border-bottom:0}
.sw{display:inline-block;width:1.1em;height:1.1em;border-radius:4px;border:1px solid #8a93a8;margin-right:.4em;vertical-align:-.18em;background:var(--c)}
hr{border:0;border-top:1px solid var(--edge);margin:20px 0}
`;

/** The whole page. `crumbs` is [{label, href}], `title` the page heading source. */
export function renderPage({ title, body, crumbs = [], sourceLine = '' }) {
  const nav = crumbs.map((c) => `<a href="${esc(c.href)}">${esc(c.label)}</a>`).join(' / ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Adamanteum</title><link rel="icon" href="/assets/adamanteum-mark.svg" type="image/svg+xml"><style>${CSS}</style></head>
<body><main><nav>${nav}</nav>${body}${sourceLine ? `<hr><p class="mute" style="color:var(--mute);font-size:13px">${esc(sourceLine)}</p>` : ''}</main></body></html>`;
}

const h = (s) => esc(s);
/** The route's logic as a pure function. `entry` is the matching acceptance index entry or undefined; `read(path)` returns
 *  {dir:[names]} or {raw:text} or throws when the file is missing. Returns {status, html}. */
export async function notePage({ want, entry, read, resolveName = () => null }) {
  const tokenNote = /^Design-Tokens\/[A-Za-z0-9 ._()-]+\.md$/.test(want) || (/^Research\//.test(want) && !/(^|\/)(\.\.|OWNER-ONLY)(\/|$)/.test(want) && /\.(md|pdf|xlsx|json|png)$/i.test(want));
  const crumbs = [{ label: 'Acceptance index', href: '/acceptance' }];
  if (!entry && !tokenNote) return { status: 404, html: renderPage({ title: 'Not found', body: '<h1>Not found</h1><p>Only the acceptance index entries and the Design-Tokens pages open here.</p>', crumbs }) };
  const here = want.includes('/') ? want.slice(0, want.lastIndexOf('/')) : '';
  const pageUrl = (p) => '/acceptance/page?path=' + encodeURIComponent(p);
  const link = (t) => {
    if (/^https?:/i.test(t)) return t;
    if (/\.md$/i.test(t) || t.includes('/')) return pageUrl(/^(Design-Tokens|Research|Manual)\//.test(t) ? t : (here ? here + '/' : '') + t);
    const found = resolveName(t);
    return found ? pageUrl(found) : null;
  };
  try {
    const got = await read(want);
    const heading = entry?.name || want.split('/').pop().replace(/\.md$/, '');
    const body = got.dir ? `<h1>${h(heading)}</h1><ul>${got.dir.map((n) => `<li><a href="${pageUrl(want + '/' + n)}">${h(n)}</a></li>`).join('')}</ul>` : renderBody(got.raw, link);
    if (/^Design-Tokens\//.test(want) && want !== 'Design-Tokens/00-INDEX.md') crumbs.push({ label: 'Design tokens', href: pageUrl('Design-Tokens/00-INDEX.md') });
    if (/^Research\//.test(want) && !entry) crumbs.push({ label: 'Research index', href: pageUrl('Research/00-RESEARCH-VAULT-INDEX.md') });
    return { status: 200, html: renderPage({ title: heading, body, crumbs, sourceLine: 'Read-only view of ' + (entry?.file || want) }) };
  } catch {
    return { status: 404, html: renderPage({ title: 'Not found', body: `<h1>Not found on this machine</h1><p>${h(want)}</p>`, crumbs }) };
  }
}
