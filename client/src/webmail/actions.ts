import i18n from './i18n';
import { destroyEmails, moveEmails, setKeyword, threadEmailIds, type Mailbox } from './jmap';
import { mailboxByRole, useWebmail } from './store';

// List / reader actions on whole threads (the list shows one row per thread:
// an action applies to the thread's messages in the current folder).

const t = (k: string, fallback: string, opts?: Record<string, unknown>) => (i18n.t(k, opts) as string) || fallback;

function threadsOf(listIds: string[]): string[] {
  const { list } = useWebmail.getState();
  return [...new Set(listIds.map((id) => list.emails[id]?.threadId).filter((x): x is string => !!x))];
}

async function after(listIds: string[], removeFromList: boolean, okText: string | null): Promise<void> {
  const s = useWebmail.getState();
  if (removeFromList) {
    s.dropEmails(listIds);
    const open = s.openThreadId;
    if (open && threadsOf(listIds).includes(open)) s.openThread(null);
  }
  if (okText) s.toast('ok', okText);
  await s.refreshMailboxes(true).catch(() => undefined);
}

function fail(err: unknown): void {
  useWebmail.getState().toast('error', (err as Error).message || t('wm.errors.generic', 'Something went wrong'));
}

export async function markSeen(listIds: string[], seen: boolean): Promise<void> {
  const s = useWebmail.getState();
  try {
    const emails = await threadEmailIds(threadsOf(listIds), s.search?.everywhere ? null : s.currentMailboxId);
    await setKeyword(emails.map((e) => e.id), '$seen', seen);
    s.patchEmails(listIds, (e) => ({ ...e, keywords: { ...e.keywords, $seen: seen } }));
    await after(listIds, false, null);
  } catch (err) { fail(err); }
}

export async function markFlagged(listIds: string[], flagged: boolean): Promise<void> {
  const s = useWebmail.getState();
  try {
    // The flag goes on the newest message of the thread (the listed one).
    await setKeyword(listIds, '$flagged', flagged);
    s.patchEmails(listIds, (e) => ({ ...e, keywords: { ...e.keywords, $flagged: flagged } }));
  } catch (err) { fail(err); }
}

export async function moveTo(listIds: string[], targetId: string): Promise<void> {
  const s = useWebmail.getState();
  const from = s.search?.everywhere ? null : s.currentMailboxId;
  try {
    const emails = await threadEmailIds(threadsOf(listIds), from);
    await moveEmails(emails, from, targetId);
    const target = s.mailboxes.find((m) => m.id === targetId);
    await after(listIds, targetId !== s.currentMailboxId, t('wm.toast.moved', `Moved to ${target?.name ?? ''}`, { name: target?.name ?? '' }));
  } catch (err) { fail(err); }
}

/**
 * Whether Delete destroys for good here: in Trash, or in a mailbox without a
 * Trash folder (accounts migrated from IMAP, folder renamed or removed).
 * Every caller confirms first when it does.
 */
export function deletesForGood(s: { mailboxes: Mailbox[]; currentMailboxId: string | null } = useWebmail.getState()): boolean {
  const trash = mailboxByRole(s.mailboxes, 'trash');
  return !trash || s.currentMailboxId === trash.id;
}

/** Delete: to Trash, or for good (deletesForGood, confirmed by the caller). */
export async function deleteThreads(listIds: string[]): Promise<void> {
  const s = useWebmail.getState();
  const trash = mailboxByRole(s.mailboxes, 'trash');
  try {
    if (!trash || deletesForGood(s)) {
      const emails = await threadEmailIds(threadsOf(listIds), s.currentMailboxId);
      await destroyEmails(emails.map((e) => e.id));
      await after(listIds, true, t('wm.toast.deleted', 'Deleted'));
      return;
    }
    await moveTo(listIds, trash.id);
  } catch (err) { fail(err); }
}

export function canArchive(): boolean {
  const s = useWebmail.getState();
  const a = mailboxByRole(s.mailboxes, 'archive');
  return !!a && a.id !== s.currentMailboxId;
}

export function canSpam(): boolean {
  const s = useWebmail.getState();
  const j = mailboxByRole(s.mailboxes, 'junk');
  return !!j && j.id !== s.currentMailboxId;
}

export async function archive(listIds: string[]): Promise<void> {
  const a = mailboxByRole(useWebmail.getState().mailboxes, 'archive');
  if (a) await moveTo(listIds, a.id);
}

export async function markSpam(listIds: string[]): Promise<void> {
  const j = mailboxByRole(useWebmail.getState().mailboxes, 'junk');
  if (j) await moveTo(listIds, j.id);
}

/** What a keyboard / toolbar action applies to: the selection, else the open conversation's listed message. */
export function currentTargets(): string[] {
  const s = useWebmail.getState();
  if (s.selection.length) return s.selection;
  if (!s.openThreadId) return [];
  const id = s.list.ids.find((i) => s.list.emails[i]?.threadId === s.openThreadId);
  return id ? [id] : [];
}

/** Read ↔ unread of `listIds` (any unread among them: all marked read). */
export async function toggleSeen(listIds: string[]): Promise<void> {
  if (!listIds.length) return;
  const { list } = useWebmail.getState();
  await markSeen(listIds, listIds.some((id) => !list.emails[id]?.keywords?.$seen));
}

/** Flag ↔ no flag of `listIds` (all flagged: the flag goes, else it is set). */
export async function toggleFlag(listIds: string[]): Promise<void> {
  if (!listIds.length) return;
  const { list } = useWebmail.getState();
  await markFlagged(listIds, !listIds.every((id) => list.emails[id]?.keywords?.$flagged));
}

/** Opens the conversation `delta` rows away from the open one (j / k), the first one when none is open. */
export function stepThread(delta: number): void {
  const s = useWebmail.getState();
  const { ids, emails } = s.list;
  if (!ids.length) return;
  const cur = s.openThreadId ? ids.findIndex((i) => emails[i]?.threadId === s.openThreadId) : -1;
  const next = cur < 0 ? (delta > 0 ? 0 : -1) : cur + delta;
  if (next < 0 || next >= ids.length) return;
  const e = emails[ids[next]];
  if (e) s.openThread(e.threadId);
  if (next >= ids.length - 5) void s.loadMore();
}

/**
 * Closes the open conversation. On a phone the conversation is a history
 * entry: MailShell pops it whenever the conversation closes, whatever closed
 * it (this, archive / delete / move of the open thread, the system Back).
 */
export function closeThread(): void {
  useWebmail.getState().openThread(null);
}

/** Asks the open composer to close (draft saved first): the phone's system Back button. */
export const COMPOSER_CLOSE_EVENT = 'wm:composer-close';
