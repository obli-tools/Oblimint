import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, CalendarOff, ChevronRight, FileText, Folder, Inbox, Keyboard, PenSquare, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { Mailbox } from '../jmap';
import { emptyDraft } from '../lib/compose';
import { useWebmail } from '../store';
import { CountPill, SectionLabel } from './ui';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export function roleIcon(role: string | null): ReactNode {
  const p = { size: 15, className: 'shrink-0' };
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


const FOLD_KEY = 'wm-folders-folded';

function readFolded(): boolean {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}

/**
 * Folders sidebar (Oblidesk Sidebar): the compose button, the special
 * folders, then the user's folders as a foldable section; pill rows, the
 * open folder on an accent wash, unread counts as pills.
 */
export function MailboxTree() {
  const { t } = useTranslation();
  const mailboxes = useWebmail((s) => s.mailboxes);
  const current = useWebmail((s) => s.currentMailboxId);
  const search = useWebmail((s) => s.search);
  const composer = useWebmail((s) => s.composer);
  const { openMailbox, openComposer, setDrawer, setOverlay } = useWebmail.getState();
  const nameOf = useMailboxName();
  const nodes = useMemo(() => flattenTree(mailboxes), [mailboxes]);
  const [folded, setFolded] = useState(readFolded);
  // Special folders (with their sub-folders) first, the user's tree below.
  const { special, others } = useMemo(() => {
    const a: Node[] = [];
    const b: Node[] = [];
    let inSpecial = false;
    for (const n of nodes) {
      if (n.depth === 0) inSpecial = !!n.m.role && ROLE_ORDER.includes(n.m.role);
      (inSpecial ? a : b).push(n);
    }
    return { special: a, others: b };
  }, [nodes]);
  const loading = mailboxes.length === 0;

  const toggleFold = () => {
    setFolded((v) => {
      try { localStorage.setItem(FOLD_KEY, v ? '0' : '1'); } catch { /* storage unavailable */ }
      return !v;
    });
  };

  const row = ({ m, depth }: Node) => {
    const active = m.id === current && !search?.everywhere;
    const unread = m.role === 'drafts' ? m.totalEmails : m.unreadEmails;
    return (
      <li key={m.id}>
        <button
          type="button"
          onClick={() => openMailbox(m.id)}
          aria-current={active ? 'page' : undefined}
          title={nameOf(m)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-[7px] py-1.5 pr-2 text-left text-[13px] transition-colors coarse:py-2.5',
            active ? 'bg-accent/15 font-medium text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        >
          <span className={cn(active ? 'text-accent' : 'opacity-80')}>{roleIcon(m.role)}</span>
          <span className={cn('min-w-0 flex-1 truncate', unread > 0 && m.role !== 'drafts' && !active && 'font-semibold text-text-primary')}>{nameOf(m)}</span>
          <CountPill value={unread} tone={m.role === 'drafts' ? 'default' : 'accent'} />
        </button>
      </li>
    );
  };

  return (
    <nav className="flex h-full flex-col" aria-label={t('wm.folders.title') || 'Folders'}>
      <div className="shrink-0 px-3 pb-1 pt-3">
        <button
          type="button"
          disabled={!!composer}
          onClick={() => { setDrawer(false); openComposer(emptyDraft()); }}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-[7px] bg-accent px-3 text-[13px] font-semibold text-bg-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          <PenSquare size={15} />{t('wm.compose.new') || 'New message'}
        </button>
      </div>

      <div className="wm-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-3 pb-1 pt-4"><SectionLabel>{t('wm.folders.mail') || 'Mail'}</SectionLabel></div>
        {loading ? (
          <div className="space-y-2 px-3 pt-1" aria-hidden>
            {[70, 55, 62, 48, 58].map((w, i) => <span key={i} className="wm-skel block h-5" style={{ width: `${w}%` }} />)}
          </div>
        ) : (
          <ul className="space-y-0.5">{special.map((n) => row(n))}</ul>
        )}

        {others.length > 0 && (
          <>
            <div className="flex items-center gap-2 pb-1 pt-4">
              <button type="button" onClick={toggleFold} aria-expanded={!folded}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-3 py-0.5 text-left transition-colors hover:bg-bg-hover">
                <ChevronRight size={11} className={cn('shrink-0 text-text-muted transition-transform duration-150', !folded && 'rotate-90')} />
                <SectionLabel>{t('wm.folders.title') || 'Folders'}</SectionLabel>
              </button>
            </div>
            {!folded && <ul className="space-y-0.5">{others.map((n) => row(n))}</ul>}
          </>
        )}
      </div>

      <div className="shrink-0 space-y-0.5 p-2">
        <div className="mx-1 mb-1.5 h-px bg-border" />
        <button type="button" onClick={() => { setDrawer(false); setOverlay('vacation'); }}
          className="flex w-full items-center gap-2.5 rounded-[7px] px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
          <CalendarOff size={15} className="shrink-0 opacity-80" />{t('wm.vacation.title') || 'Vacation responder'}
        </button>
        <button type="button" onClick={() => { setDrawer(false); setOverlay('shortcuts'); }}
          className="flex w-full items-center gap-2.5 rounded-[7px] px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary max-lg:hidden">
          <Keyboard size={15} className="shrink-0 opacity-80" />{t('wm.keys.title') || 'Keyboard shortcuts'}
        </button>
      </div>
    </nav>
  );
}
