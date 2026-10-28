import i18n from './i18n';
import { destroyEmails, moveEmails, setKeyword, threadEmailIds } from './jmap';
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

/** Delete: to Trash, or for good when already in Trash (confirmed by the caller). */
export async function deleteThreads(listIds: string[]): Promise<void> {
  const s = useWebmail.getState();
  const trash = mailboxByRole(s.mailboxes, 'trash');
  try {
    if (!trash || s.currentMailboxId === trash.id) {
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
