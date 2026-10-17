import { Fragment, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

// Small Markdown renderer for the panel's own documents (the API guide): headings,
// paragraphs, lists (one nested level), quotes, fenced code, tables, rules;
// inline `code`, **bold**, *italic*. React elements only, never raw HTML, so a
// document can never inject markup.

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: Array<{ text: string; children: string[] }> }
  | { kind: 'table'; head: string[]; rows: string[][] };

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function cells(line: string): string[] {
  // Split on | not escaped as \|.
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push({ kind: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (/^-{3,}\s*$/.test(line)) { out.push({ kind: 'hr' }); i++; continue; }
    if (line.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      out.push({ kind: 'table', head, rows });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li && !li[1]) {
      const ordered = /\d/.test(li[2]);
      const items: Array<{ text: string; children: string[] }> = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        if (m[1]) { items[items.length - 1]?.children.push(m[3]); i++; continue; }
        items.push({ text: m[3], children: [] });
        i++;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\||-{3,}\s*$)/.test(lines[i]) && !LIST_RE.test(lines[i])) body.push(lines[i++]);
    out.push({ kind: 'p', text: body.join(' ') });
  }
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<code key={k++} className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-[0.85em] text-text-primary">{m[1]}</code>);
    else if (m[2] !== undefined) parts.push(<strong key={k++} className="font-semibold text-text-primary">{inline(m[2])}</strong>);
    else parts.push(<em key={k++}>{inline(m[3])}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const HEADING_CLS: Record<number, string> = {
  1: 'text-lg font-semibold text-text-primary',
  2: 'mt-6 border-b border-border pb-1 text-base font-semibold text-text-primary',
  3: 'mt-4 text-sm font-semibold text-text-primary',
};

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed text-text-secondary', className)}>
      {parse(source).map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const Tag = (`h${Math.min(b.level, 4)}`) as 'h1' | 'h2' | 'h3' | 'h4';
            return <Tag key={i} className={HEADING_CLS[b.level] ?? HEADING_CLS[3]}>{inline(b.text)}</Tag>;
          }
          case 'p': return <p key={i}>{inline(b.text)}</p>;
          case 'quote': return <blockquote key={i} className="rounded-lg border-l-2 border-accent bg-accent/5 px-3 py-2 text-text-primary">{inline(b.text)}</blockquote>;
          case 'hr': return <hr key={i} className="border-border" />;
          case 'code': return <pre key={i} className="overflow-x-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] text-text-primary">{b.text}</pre>;
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i} className={cn('space-y-1 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    {inline(it.text)}
                    {it.children.length > 0 && <ul className="mt-1 list-[circle] space-y-1 pl-5">{it.children.map((c, n) => <li key={n}>{inline(c)}</li>)}</ul>}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table': return (
            <div key={i} className="overflow-x-auto rounded-lg ring-1 ring-border">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-bg-tertiary/60 text-text-primary">
                  <tr>{b.head.map((c, j) => <th key={j} className="px-2.5 py-1.5 font-medium">{inline(c)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j} className="border-t border-border/60 align-top">
                      {r.map((c, n) => <td key={n} className="px-2.5 py-1.5">{c ? inline(c) : <Fragment />}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          default: return null;
        }
      })}
    </div>
  );
}
