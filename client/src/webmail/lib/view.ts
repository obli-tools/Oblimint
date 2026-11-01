// Pure display helpers of the webmail shell (avatars, quick filters, layout
// widths, the "Back to Oblimint" link). No DOM, no store: unit-tested.

/** Quick filter of the message list (tabs above the rows). */
export type QuickFilter = 'all' | 'unread' | 'flagged';

export const QUICK_FILTERS: readonly QuickFilter[] = ['all', 'unread', 'flagged'];

/** JMAP FilterCondition of a quick filter (null: none). */
export function quickCondition(q: QuickFilter | null | undefined): Record<string, unknown> | null {
  if (q === 'unread') return { notKeyword: '$seen' };
  if (q === 'flagged') return { hasKeyword: '$flagged' };
  return null;
}

/** Adds the quick filter to a JMAP filter (AND), leaving `filter` untouched. */
export function withQuickFilter(filter: Record<string, unknown>, q: QuickFilter | null | undefined): Record<string, unknown> {
  const extra = quickCondition(q);
  if (!extra) return filter;
  if (Object.keys(filter).length === 0) return extra;
  if (filter.operator === 'AND' && Array.isArray(filter.conditions)) return { operator: 'AND', conditions: [...filter.conditions, extra] };
  return { operator: 'AND', conditions: [filter, extra] };
}

/**
 * One or two initials of a display name or an address: "Jeanne Dupont" → "JD",
 * "support@example.org" → "S", "" → "?". Letters and digits only (no emoji,
 * no punctuation), upper case.
 */
export function initials(nameOrEmail: string | null | undefined): string {
  const raw = (nameOrEmail ?? '').trim();
  if (!raw) return '?';
  const base = raw.includes('@') && !raw.includes(' ') ? raw.split('@')[0] : raw.replace(/<[^>]*>/g, ' ');
  const words = base.split(/[\s._-]+/).map((w) => Array.from(w).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '').filter(Boolean);
  if (words.length === 0) return '?';
  const pick = raw.includes('@') && !raw.includes(' ') ? words.slice(0, 1) : [words[0], words.length > 1 ? words[words.length - 1] : ''];
  return pick.join('').toLocaleUpperCase().slice(0, 2);
}

/**
 * Stable avatar hue of a correspondent, kept in the Oblimint mint family
 * (hue 158 ± 50: teal → green → turquoise), like Oblidesk keeps its avatars
 * in its cyan family. Same input, same hue, across reloads.
 */
export function avatarHue(seed: string | null | undefined): number {
  const s = (seed ?? '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) % 3600;
  return 158 + ((hash % 100) - 50);
}

/** Clamped pane width (splitters, stored values). */
export function clampWidth(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/**
 * Widest the list may get while the reading pane keeps `readingMin` px:
 * `listW` / `readingW` are the panes' current rendered widths (the splitter
 * between them excluded). Never below `min`, never above `max`.
 */
export function maxListWidth(listW: number, readingW: number, readingMin: number, min: number, max: number): number {
  const room = Math.floor(listW + readingW - readingMin);
  return Math.max(min, Math.min(max, Number.isFinite(room) ? room : max));
}

interface ListRows<T> { ids: string[]; emails: Record<string, T>; threadSizes: Record<string, number> }

/**
 * Reload of the list while a conversation is open: when the new page no
 * longer has the open conversation (marked read under the Unread filter,
 * unflagged under Flagged…), its row stays where it was until the
 * conversation is closed (Outlook / Gmail), so the reader keeps its toolbar,
 * J / K and the shortcuts. `next` is not modified.
 */
export function keepOpenRow<T extends { threadId: string }>(prev: ListRows<T>, next: ListRows<T>, openThreadId: string | null): ListRows<T> {
  if (!openThreadId) return next;
  if (next.ids.some((i) => next.emails[i]?.threadId === openThreadId)) return next;
  const row = prev.ids.find((i) => prev.emails[i]?.threadId === openThreadId);
  if (!row || !prev.emails[row]) return next;
  const ids = next.ids.filter((i) => i !== row);
  ids.splice(Math.min(prev.ids.indexOf(row), ids.length), 0, row);
  const threadSizes = { ...next.threadSizes };
  if (prev.threadSizes[openThreadId] !== undefined && threadSizes[openThreadId] === undefined) threadSizes[openThreadId] = prev.threadSizes[openThreadId];
  return { ids, emails: { ...next.emails, [row]: prev.emails[row] }, threadSizes };
}

/**
 * The "Back to Oblimint" link, only when it is an absolute http(s) URL
 * without credentials (never javascript:, data:, a relative path…).
 */
export function safePanelUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
