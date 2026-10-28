// Display helpers (dates, sizes) of the webmail.

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/** List date: time today, day + month this year, else the full date. */
export function formatListDate(iso: string, lang: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatFullDate(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Splits text into plain runs and http(s) links (rendered as React elements, never as HTML). */
export function linkify(text: string): Array<{ text: string; href?: string }> {
  const out: Array<{ text: string; href?: string }> = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    const url = m[0].replace(/[.,;:!?]+$/, '');
    out.push({ text: url, href: url });
    last = i + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
