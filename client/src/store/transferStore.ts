import { create } from 'zustand';
import axios from 'axios';
import { SMALL_UPLOAD_BYTES, filesApi } from '@/api/files.api';

// ─────────────────────────────────────────────────────────────────────────────
// Upload queue of the file explorer (global: survives navigation, shown by the
// TransferDock). Each file is sent in chunks (server-chosen size, several in
// flight, each retried on its own with backoff); the chunk that completes the
// file makes the server put it in place. Folders dropped or picked are
// recreated first (mkdir, "already exists" is fine), then their files queued.
// A name conflict pauses only that file: overwrite / skip / keep both, for
// one file or the whole batch.
// ─────────────────────────────────────────────────────────────────────────────

export type TransferStatus = 'queued' | 'preparing' | 'uploading' | 'conflict' | 'done' | 'error' | 'cancelled' | 'skipped';
export type ConflictChoice = 'overwrite' | 'skip' | 'rename';

export interface Transfer {
  id: string;
  batchId: string;
  accountId: number;
  /** Destination (absolute virtual path). */
  path: string;
  name: string;
  size: number;
  sent: number;
  status: TransferStatus;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface UploadItem {
  file: File;
  /** Destination path (absolute virtual path, file name included). */
  path: string;
}

interface Batch {
  id: string;
  accountId: number;
  /** Folders to create first (absolute paths), parents before children. */
  dirs: string[];
  policy: ConflictChoice | null;
  ready: Promise<void>;
}

interface TransferState {
  transfers: Transfer[];
  /** Dock expanded. */
  open: boolean;
  /** Bumped when a file lands (explorers reload the folder they show). */
  changes: Array<{ accountId: number; dir: string; at: number }>;
  setOpen(open: boolean): void;
  enqueue(accountId: number, items: UploadItem[], dirs?: string[]): void;
  cancel(id: string): void;
  cancelAll(): void;
  retry(id: string): void;
  resolveConflict(id: string, choice: ConflictChoice, all: boolean): void;
  clearFinished(): void;
}

const FILES_IN_FLIGHT = 3;
const RETRY_DELAYS = [1000, 3000, 6000, 12000, 20000];

const files = new Map<string, File>();
const controllers = new Map<string, AbortController>();
const batches = new Map<string, Batch>();
let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

function errMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const d = err.response?.data as { error?: string } | undefined;
    return d?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
  return axios.isAxiosError(err) ? (err.response?.data as { code?: string } | undefined)?.code : undefined;
}

function retryable(err: unknown): boolean {
  if (!axios.isAxiosError(err) || axios.isCancel(err)) return false;
  const s = err.response?.status ?? 0;
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s !== 507 && s !== 501);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/** "name (2).ext" */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export const useTransferStore = create<TransferState>((set, get) => {
  const patch = (id: string, p: Partial<Transfer>) =>
    set((s) => ({ transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
  const find = (id: string) => get().transfers.find((t) => t.id === id);

  function pump(): void {
    const active = get().transfers.filter((t) => t.status === 'preparing' || t.status === 'uploading').length;
    let free = FILES_IN_FLIGHT - active;
    for (const t of get().transfers) {
      if (free <= 0) break;
      if (t.status !== 'queued') continue;
      free--;
      patch(t.id, { status: 'preparing', startedAt: Date.now(), error: undefined });
      void run(t.id).finally(pump);
    }
  }

  async function run(id: string): Promise<void> {
    const t = find(id);
    const file = files.get(id);
    const batch = t ? batches.get(t.batchId) : undefined;
    if (!t || !file || !batch) return;
    const ctl = new AbortController();
    controllers.set(id, ctl);
    const finish = (path: string) => {
      patch(id, { status: 'done', sent: file.size, finishedAt: Date.now(), path, name: path.split('/').pop()! });
      files.delete(id);
      set((s) => ({ changes: [...s.changes.slice(-50), { accountId: t.accountId, dir: parentOf(path), at: Date.now() }] }));
    };
    try {
      await batch.ready;
      let path = t.path;
      let overwrite = batch.policy === 'overwrite';
      const small = file.size <= SMALL_UPLOAD_BYTES;
      let session: Awaited<ReturnType<typeof filesApi.uploadStart>> | null = null;
      for (let n = 2; ; n++) {
        try {
          if (small) {
            // One request: retried on transient failures like a chunk.
            for (let attempt = 0; ; attempt++) {
              try {
                patch(id, { status: 'uploading', path });
                await filesApi.put(t.accountId, path, file, { overwrite }, (l) => patch(id, { sent: l }), ctl.signal);
                break;
              } catch (err) {
                patch(id, { sent: 0 });
                if (!retryable(err) || attempt >= RETRY_DELAYS.length) throw err;
                await sleep(RETRY_DELAYS[attempt], ctl.signal);
              }
            }
          } else {
            session = await filesApi.uploadStart(t.accountId, { path, size: file.size, overwrite }, ctl.signal);
          }
          break;
        } catch (err) {
          if (errCode(err) !== 'fileExists' || n > 100) throw err;
          const policy = batch.policy;
          if (policy === 'skip') { patch(id, { status: 'skipped', finishedAt: Date.now() }); return; }
          if (policy === 'overwrite') {
            if (overwrite) throw err; // a directory of that name: never replaced
            overwrite = true;
            continue;
          }
          if (policy === 'rename') { path = `${parentOf(t.path)}/${numberedName(t.name, n)}`; continue; }
          patch(id, { status: 'conflict' }); // resolveConflict() requeues it
          return;
        }
      }
      if (path !== t.path) patch(id, { path, name: path.split('/').pop()! });
      if (!session) {
        finish(path);
        return;
      }
      patch(id, { status: 'uploading' });
      const loaded = new Map<number, number>();
      const report = () => patch(id, { sent: [...loaded.values()].reduce((a, b) => a + b, 0) });
      const sess = session;
      const indexes = Array.from({ length: sess.count }, (_, i) => i);
      let done = false;
      const worker = async () => {
        for (let index = indexes.shift(); index !== undefined; index = indexes.shift()) {
          const start = index * sess.chunkSize;
          const blob = file.slice(start, Math.min(file.size, start + sess.chunkSize));
          for (let attempt = 0; ; attempt++) {
            try {
              const r = await filesApi.uploadChunk(t.accountId, sess.id, index, blob, (l) => { loaded.set(index, l); report(); }, ctl.signal);
              loaded.set(index, blob.size);
              report();
              if (r.done) done = true;
              break;
            } catch (err) {
              loaded.set(index, 0);
              if (!retryable(err) || attempt >= RETRY_DELAYS.length) throw err;
              await sleep(RETRY_DELAYS[attempt], ctl.signal);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(sess.parallel, sess.count)) }, worker));
      if (!done) throw new Error('upload incomplete');
      finish(path);
    } catch (err) {
      if (ctl.signal.aborted || axios.isCancel(err)) return; // cancel() already set the status
      patch(id, { status: 'error', error: errMessage(err), finishedAt: Date.now() });
    } finally {
      controllers.delete(id);
    }
  }

  async function prepareDirs(batch: Batch): Promise<void> {
    for (const dir of batch.dirs) {
      try {
        await filesApi.mkdir(batch.accountId, dir);
      } catch (err) {
        if (errCode(err) !== 'fileExists') throw err;
      }
    }
    if (batch.dirs.length) {
      const now = Date.now();
      set((s) => ({ changes: [...s.changes.slice(-50), ...batch.dirs.map((d) => ({ accountId: batch.accountId, dir: parentOf(d), at: now }))] }));
    }
  }

  return {
    transfers: [],
    open: true,
    changes: [],
    setOpen: (open) => set({ open }),

    enqueue(accountId, items, dirs = []) {
      const batchId = nextId();
      const batch: Batch = { id: batchId, accountId, dirs, policy: null, ready: Promise.resolve() };
      batch.ready = prepareDirs(batch);
      batches.set(batchId, batch);
      const added: Transfer[] = items.map((it) => {
        const id = nextId();
        files.set(id, it.file);
        return { id, batchId, accountId, path: it.path, name: it.file.name, size: it.file.size, sent: 0, status: 'queued' };
      });
      batch.ready.catch((err) => {
        for (const t of added) patch(t.id, { status: 'error', error: errMessage(err), finishedAt: Date.now() });
      });
      set((s) => ({ transfers: [...s.transfers, ...added], open: true }));
      pump();
    },

    cancel(id) {
      const t = find(id);
      if (!t || ['done', 'cancelled', 'skipped'].includes(t.status)) return;
      controllers.get(id)?.abort();
      patch(id, { status: 'cancelled', finishedAt: Date.now() });
      files.delete(id);
      pump();
    },

    cancelAll() {
      for (const t of get().transfers) get().cancel(t.id);
    },

    retry(id) {
      const t = find(id);
      if (!t || (t.status !== 'error' && t.status !== 'cancelled') || !files.has(id)) return;
      patch(id, { status: 'queued', sent: 0, error: undefined, finishedAt: undefined });
      pump();
    },

    resolveConflict(id, choice, all) {
      const t = find(id);
      if (!t) return;
      const batch = batches.get(t.batchId);
      const targets = all ? get().transfers.filter((x) => x.batchId === t.batchId && x.status === 'conflict') : [t];
      if (all && batch) batch.policy = choice;
      for (const x of targets) {
        if (choice === 'skip') {
          patch(x.id, { status: 'skipped', finishedAt: Date.now() });
          files.delete(x.id);
          continue;
        }
        // One file: a one-off policy for its own retry.
        if (!all && batch) {
          const single: Batch = { ...batch, id: nextId(), policy: choice, dirs: [], ready: Promise.resolve() };
          batches.set(single.id, single);
          patch(x.id, { batchId: single.id, status: 'queued' });
        } else {
          patch(x.id, { status: 'queued' });
        }
      }
      pump();
    },

    clearFinished() {
      set((s) => ({ transfers: s.transfers.filter((t) => !['done', 'cancelled', 'skipped', 'error'].includes(t.status)) }));
      for (const [id] of files) if (!get().transfers.some((t) => t.id === id)) files.delete(id);
    },
  };
});

/** Transfers still running (leave-page warning, dock badge). */
export const activeTransfers = (ts: Transfer[]) => ts.filter((t) => t.status === 'queued' || t.status === 'preparing' || t.status === 'uploading');
