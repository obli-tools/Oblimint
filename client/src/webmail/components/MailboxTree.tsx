import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FileText, Folder, Inbox, PenSquare, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';
import type { Mailbox } from '../jmap';
import { emptyDraft } from '../lib/compose';
import { useWebmail } from '../store';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export function roleIcon(role: string | null): ReactNode {
  const p = { size: 16, className: 'shrink-0' };
  switch (role) {
    case 'inbox': return <Inbox {...p} />;
    case 'drafts': return <FileText {...p} />;
    case 'sent': return <Send {...p} />;
    case 'archive': return <Archive {...p} />;
    case 'junk': return <ShieldAlert {...p} />;
    case 'trash': return <Trash2 {...p} />;
    default: return <Folder {...p} />;
  }
}

/** Localized name of a special folder (the engine's own names otherwise). */
export function useMailboxName(): (m: Mailbox) => string {
  const { t } = useTranslation();
  return (m: Mailbox) => {
    switch (m.role) {
      case 'inbox': return t('wm.folders.inbox') || 'Inbox';
      case 'drafts': return t('wm.folders.drafts') || 'Drafts';
      case 'sent': return t('wm.folders.sent') || 'Sent';
      case 'archive': return t('wm.folders.archive') || 'Archive';
      case 'junk': return t('wm.folders.junk') || 'Spam';
      case 'trash': return t('wm.folders.trash') || 'Trash';
      default: return m.name;
    }
  };
}

interface Node { m: Mailbox; depth: number }

/** Folders as a tree: special folders first (fixed order), then the others by sortOrder / name. */
export function flattenTree(mailboxes: Mailbox[]): Node[] {
  const children = new Map<string | null, Mailbox[]>();
  for (const m of mailboxes) {
    const p = m.parentId && mailboxes.some((x) => x.id === m.parentId) ? m.parentId : null;
    children.set(p, [...(children.get(p) ?? []), m]);
  }
  const rank = (m: Mailbox) => { const i = ROLE_ORDER.indexOf(m.role ?? ''); return i < 0 ? 100 : i; };
  const sort = (l: Mailbox[]) => [...l].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const m of sort(children.get(parent) ?? [])) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ m, depth });
      walk(m.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return out;
}

export function MailboxTree() {
  const { t } = useTranslation();
  const mailboxes = useWebmail((s) => s.mailboxes);
  const current = useWebmail((s) => s.currentMailboxId);
  const search = useWebmail((s) => s.search);
  const openMailbox = useWebmail((s) => s.openMailbox);
  const openComposer = useWebmail((s) => s.openComposer);
  const setDrawer = useWebmail((s) => s.setDrawer);
  const nameOf = useMailboxName();
  const nodes = useMemo(() => flattenTree(mailboxes), [mailboxes]);

  return (
    <nav className="flex h-full flex-col gap-3 px-2 py-3" aria-label={t('wm.folders.title') || 'Folders'}>
      <Button className="mx-1 justify-start gap-2" onClick={() => { setDrawer(false); openComposer(emptyDraft()); }}>
        <PenSquare size={16} />{t('wm.compose.new') || 'New message'}
      </Button>
      <div className="flex items-center gap-2 px-2 pt-1">
        <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{t('wm.folders.title') || 'Folders'}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {nodes.map(({ m, depth }) => {
          const active = m.id === current && !search?.everywhere;
          const unread = m.role === 'drafts' ? m.totalEmails : m.unreadEmails;
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => openMailbox(m.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] transition-colors coarse:py-2.5',
                  active ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
                style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
              >
                <span className={cn(active && 'text-accent')}>{roleIcon(m.role)}</span>
                <span className={cn('flex-1 truncate', unread > 0 && m.role !== 'drafts' && 'font-semibold text-text-primary')}>{nameOf(m)}</span>
                {unread > 0 && (
                  <span className={cn(
                    'shrink-0 min-w-[1.4rem] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold',
                    m.role === 'drafts' ? 'bg-bg-tertiary text-text-muted' : 'bg-accent/20 text-accent',
                  )}>
                    {unread > 999 ? '999+' : unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
