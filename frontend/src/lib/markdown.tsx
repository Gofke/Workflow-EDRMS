import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Safe Markdown for the assistant's answers. The text is turned into React
 * elements — never into HTML — so markup in an answer is shown as text and
 * cannot run. Supported: paragraphs, headings, bullet and numbered lists,
 * tables, code, bold, italic and links. Links go only to pages of this system
 * (/…) or to https addresses; anything else stays plain text.
 */

// Emphasis with _ or * only around whole words, so codes like AI_QUESTION_ANSWERED stay intact.
const INLINE = /(\*\*[^*\n]+\*\*|(?<![\w])__[^_\n]+__(?![\w])|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w])_[^_\s][^_\n]*_(?![\w]))/g;

export function safeHref(href: string): { internal: boolean; href: string } | null {
  const h = href.trim();
  if (/^\/(?!\/)[\w\-/.?=&%#]*$/.test(h)) return { internal: true, href: h };
  if (/^https:\/\/[^\s<>"']+$/i.test(h)) return { internal: false, href: h };
  return null;
}

export function inline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    if (token.startsWith('**') || token.startsWith('__')) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const target = safeHref(lm[2]);
      if (!target) out.push(lm[1]);
      else if (target.internal)
        out.push(
          <Link key={key} to={target.href}>
            {lm[1]}
          </Link>,
        );
      else
        out.push(
          <a key={key} href={target.href} target="_blank" rel="noopener noreferrer">
            {lm[1]}
          </a>,
        );
    } else out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const key = `b${k++}`;
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={key} className="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key} className="md-h">
          {inline(heading[2], key)}
        </p>,
      );
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j}>{inline(h, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = number.test(line);
      const re = ordered ? number : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i += 1;
      }
      const list = items.map((it, j) => <li key={j}>{inline(it, `${key}l${j}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{list}</ol> : <ul key={key}>{list}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*[-*•]\s+|^\s*\d+[.)]\s+|^\s*```|^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {inline(p, `${key}p${j}`)}
          </span>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
