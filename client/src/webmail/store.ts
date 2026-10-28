import { create } from 'zustand';
import type { WebmailSessionInfo } from '@oblimint/shared';
import { buildFilter, loadMailboxes, queryThreads, type EmailListItem, type Mailbox, type SearchQuery } from './jmap';
import type { DraftFields } from './lib/compose';

// State of the webmail SPA (zustand, like the panel).

export const PAGE_SIZE = 50;

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

interface ListState {
  ids: string[];
  emails: Record<string, EmailListItem>;
  threadSizes: Record<string, number>;
  total: number;
  loading: boolean;
  /** Bumped at each reload (stale answers are dropped). */
  version: number;
}

export interface ComposerState extends DraftFields {
  /** Local key (one composer at a time in v1). */
  key: number;
  /** Id of the saved draft (replaced at each save). */
  draftId: string | null;
}

interface WebmailState {
  phase: 'loading' | 'login' | 'ssoConfirm' | 'ready';
  session: WebmailSessionInfo | null;
  /** Pending SSO token (confirmation when a session is already open). */
  ssoToken: string | null;
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  search: SearchQuery | null;
  list: ListState;
  selection: string[];
  openThreadId: string | null;
  /** Phone layout: folders drawer open. */
  drawerOpen: boolean;
  composer: ComposerState | null;
  toasts: Toast[];

  setPhase(p: WebmailState['phase']): void;
  setSession(s: WebmailSessionInfo | null): void;
  setSsoToken(t: string | null): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  refreshMailboxes(background?: boolean): Promise<void>;
  openMailbox(id: string): void;
  setSearch(q: SearchQuery | null): void;
  reloadList(background?: boolean): Promise<void>;
  loadMore(): Promise<void>;
  setSelection(ids: string[]): void;
  toggleSelected(id: string): void;
  openThread(threadId: string | null): void;
  setDrawer(open: boolean): void;
  openComposer(d: DraftFields): void;
  updateComposer(patch: Partial<ComposerState>): void;
  closeComposer(): void;
  patchEmails(ids: string[], fn: (e: EmailListItem) => EmailListItem): void;
  dropEmails(ids: string[]): void;
  reset(): void;
}

const emptyList = (): ListState => ({ ids: [], emails: {}, threadSizes: {}, total: 0, loading: false, version: 0 });
let toastSeq = 0;
let composerSeq = 0;

export function mailboxByRole(mailboxes: Mailbox[], role: string): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role);
}

export const useWebmail = create<WebmailState>((set, get) => ({
  phase: 'loading',
  session: null,
  ssoToken: null,
  mailboxes: [],
  currentMailboxId: null,
  search: null,
  list: emptyList(),
  selection: [],
  openThreadId: null,
  drawerOpen: false,
  composer: null,
  toasts: [],

  setPhase: (phase) => set({ phase }),
  setSession: (session) => set({ session }),
  setSsoToken: (ssoToken) => set({ ssoToken }),
  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  async refreshMailboxes(background = false) {
    const mailboxes = await loadMailboxes(background);
    const cur = get().currentMailboxId;
    const inbox = mailboxByRole(mailboxes, 'inbox') ?? mailboxes[0];
    set({ mailboxes, currentMailboxId: cur && mailboxes.some((m) => m.id === cur) ? cur : inbox?.id ?? null });
  },

  openMailbox(id) {
    set({ currentMailboxId: id, search: null, selection: [], openThreadId: null, drawerOpen: false });
    void get().reloadList();
  },

  setSearch(q) {
    set({ search: q, selection: [], openThreadId: null });
    void get().reloadList();
  },

  async reloadList(background = false) {
    const { currentMailboxId, search, list } = get();
    const version = list.version + 1;
    set({ list: { ...list, loading: !background, version } });
    try {
      const keep = background ? Math.max(PAGE_SIZE, list.ids.length) : PAGE_SIZE;
      const page = await queryThreads(buildFilter(currentMailboxId, search), 0, Math.min(keep, 200), background);
      if (get().list.version !== version) return;
      set({ list: { ids: page.ids, emails: page.emails, threadSizes: page.threadSizes, total: page.total, loading: false, version } });
    } catch (err) {
      if (get().list.version === version) set({ list: { ...get().list, loading: false } });
      if (!background) get().toast('error', (err as Error).message);
    }
  },

  async loadMore() {
    const { list, currentMailboxId, search } = get();
    if (list.loading || list.ids.length >= list.total) return;
    const version = list.version;
    set({ list: { ...list, loading: true } });
    try {
      const page = await queryThreads(buildFilter(currentMailboxId, search), list.ids.length, PAGE_SIZE);
      const cur = get().list;
      if (cur.version !== version) return;
      const seen = new Set(cur.ids);
      set({
        list: {
          ...cur,
          ids: [...cur.ids, ...page.ids.filter((i) => !seen.has(i))],
          emails: { ...cur.emails, ...page.emails },
          threadSizes: { ...cur.threadSizes, ...page.threadSizes },
          total: page.total,
          loading: false,
        },
      });
    } catch (err) {
      set({ list: { ...get().list, loading: false } });
      get().toast('error', (err as Error).message);
    }
  },

  setSelection: (selection) => set({ selection }),
  toggleSelected: (id) => set((s) => ({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] })),
  openThread: (openThreadId) => set({ openThreadId }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  openComposer: (d) => set({ composer: { ...d, key: ++composerSeq, draftId: null } }),
  updateComposer: (patch) => set((s) => (s.composer ? { composer: { ...s.composer, ...patch } } : {})),
  closeComposer: () => set({ composer: null }),
  patchEmails: (ids, fn) => set((s) => {
    const emails = { ...s.list.emails };
    for (const id of ids) if (emails[id]) emails[id] = fn(emails[id]);
    return { list: { ...s.list, emails } };
  }),
  dropEmails: (ids) => set((s) => {
    const drop = new Set(ids);
    return {
      list: { ...s.list, ids: s.list.ids.filter((i) => !drop.has(i)), total: Math.max(0, s.list.total - ids.length) },
      selection: s.selection.filter((i) => !drop.has(i)),
    };
  }),
  reset: () => set({
    session: null, mailboxes: [], currentMailboxId: null, search: null, list: emptyList(), selection: [], openThreadId: null, composer: null, drawerOpen: false,
  }),
}));
