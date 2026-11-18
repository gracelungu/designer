import { Fragment, useState, type ReactNode } from 'react';

/**
 * A small Markdown renderer for Claude's replies: headings, paragraphs, lists, quotes, tables,
 * fenced code with a copy button, inline code, bold, italic, links. It builds React elements
 * (never raw HTML), so nothing in a reply can inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={key++}>{inline(para.join('\n'))}</p>);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={key++} lang={fence[2]} code={body.join('\n')} />);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      flush();
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key++}>{blocks(body.join('\n'))}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: string[][] = [];
      const indent = li[1].length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= indent) {
          items.push([m[3]]);
          i++;
        } else if (lines[i].trim() && (/^\s{2,}/.test(lines[i]) || (m && m[1].length > indent))) {
          items[items.length - 1].push(lines[i].replace(new RegExp(`^\\s{0,${indent + 3}}`), ''));
          i++;
        } else break;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j}>{it.length > 1 ? blocks(it.join('\n')) : inline(it[0])}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)|(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<code key={k++}>{m[2]}</code>);
    else if (m[3] || m[4]) out.push(<strong key={k++}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5] || m[6]) out.push(<em key={k++}>{inline(m[5] ?? m[6])}</em>);
    else if (m[7]) out.push(<Link key={k++} href={m[8]}>{inline(m[7])}</Link>);
    else if (m[9]) out.push(<Link key={k++} href={m[9]}>{m[9]}</Link>);
    else out.push(<br key={k++} />);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.map((x, j) => (typeof x === 'string' ? <Fragment key={`t${j}`}>{x}</Fragment> : x));
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^(https?:|mailto:)/i.test(href) ? href : undefined;
  if (!safe) return <span className="md-link">{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (window.designerNative) {
          e.preventDefault();
          window.designerNative.openExternal(safe);
        }
      }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || 'text'}</span>
        <button
          className="md-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
