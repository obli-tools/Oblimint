import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import axios from 'axios';
import { create } from 'zustand';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpFromLine, ClipboardCopy, ClipboardPaste, Copy, Download, Eye, FilePlus, FolderInput,
  FolderPlus, FolderUp, HardDrive, Home, Link2, Lock, Pencil, RefreshCw, Scissors, Search, Trash2, Upload, X,
} from 'lucide-react';
import type { FileEntry, FileListing, FileOpResult } from '@oblimint/shared';
import { filesApi, writeFileContent } from '@/api/files.api';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { formatBytes } from '@/components/usage/usageFormat';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';
import { numberedName, useTransferStore, type UploadItem } from '@/store/transferStore';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { FileEditorModal } from './FileEditorModal';
import { FilePreviewModal } from './FilePreviewModal';
import {
  FileIcon, baseName, joinPath, looksText, modeString, normalizeTyped, parentPath, previewKind, readDrop, readPicked, splitPath, validEntryName,
  type DroppedTree,
} from './fileFormat';

// ─────────────────────────────────────────────────────────────────────────────
// Web file explorer of a hosting account (Oblireach « Files » UX): toolbar,
// breadcrumb (click the empty part or Ctrl+L to type a path), filter (Ctrl+F or
// just type in the list), sortable list (folders first), multi-selection
// (click, Ctrl/⌘+click, Shift+click, Ctrl+A, arrows), context menu,
// keyboard shortcuts (Enter, Backspace / Alt+↑, Alt+←/→, F2, Delete, F5,
// Ctrl+C / X / V), drag & drop of OS files and folders (onto the list or a
// folder row) and of rows onto a folder or a crumb (move), integrated editor
// and media preview. Uploads go to the global transfer queue (TransferDock).
// ─────────────────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'size' | 'mtime';
const DRAG_TYPE = 'application/x-oblimint-files';
const PAGE = 1000;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Internal clipboard (cut / copy), shared by every explorer of the page. */
const useFileClipboard = create<{ accountId: number | null; mode: 'copy' | 'cut'; paths: string[]; set(accountId: number, mode: 'copy' | 'cut', paths: string[]): void; clear(): void }>((set) => ({
  accountId: null, mode: 'copy', paths: [],
  set: (accountId, mode, paths) => set({ accountId, mode, paths }),
  clear: () => set({ accountId: null, paths: [] }),
}));

function readSort(): { key: SortKey; dir: 1 | -1 } {
  try {
    const v = JSON.parse(localStorage.getItem('oblimint.files.sort') ?? '');
    if (['name', 'size', 'mtime'].includes(v?.key) && (v?.dir === 1 || v?.dir === -1)) return v;
  } catch { /* default */ }
  return { key: 'name', dir: 1 };
}

function apiError(err: unknown): { code?: string; message: string } {
  if (axios.isAxiosError(err)) {
    const d = err.response?.data as { code?: string; error?: string } | undefined;
    return { code: d?.code, message: d?.error || err.message };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '');

export function FileExplorer({ accountId, path, onPathChange, className }: {
  accountId: number;
  path: string;
  onPathChange: (path: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const clipboard = useFileClipboard();
  const enqueue = useTransferStore((s) => s.enqueue);
  const changes = useTransferStore((s) => s.changes);

  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState(readSort);
  const [filter, setFilter] = useState('');
  const [typing, setTyping] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; onRow: boolean } | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // '' = the folder shown, else a row name
  const [limit, setLimit] = useState(PAGE);
  const [sites, setSites] = useState<Record<string, string>>({});
  const history = useRef<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const loadedAt = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const load = useCallback(async (keepSelection = false) => {
    setLoading(true);
    try {
      const l = await filesApi.list(accountId, path);
      setListing(l);
      setError(null);
      loadedAt.current = Date.now();
      if (!keepSelection) { setSelected(new Set()); setAnchor(null); setCursor(null); }
      else setSelected((s) => new Set([...s].filter((n) => l.entries.some((e) => e.name === n))));
      if (splitPath(l.path).length === 1) {
        const labels: Record<string, string> = {};
        for (const e of l.entries) if (e.site) labels[e.name] = e.site.label;
        setSites((s) => ({ ...s, ...labels }));
      }
    } catch (err) {
      setError(apiError(err).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [accountId, path]);

  useEffect(() => {
    setFilter('');
    setLimit(PAGE);
    void load();
  }, [load]);

  // Site labels of the breadcrumb when opened deep (one listing of /staging).
  useEffect(() => {
    if (splitPath(path).length < 2 || Object.keys(sites).length) return;
    filesApi.list(accountId, '/staging').then((l) => {
      const labels: Record<string, string> = {};
      for (const e of l.entries) if (e.site) labels[e.name] = e.site.label;
      setSites(labels);
    }).catch(() => { /* labels are cosmetic */ });
  }, [accountId, path, sites]);

  // Files landed by the transfer queue in this folder → reload (debounced).
  useEffect(() => {
    const hit = changes.some((c) => c.accountId === accountId && c.dir === path && c.at > loadedAt.current);
    if (!hit) return;
    const id = setTimeout(() => void load(true), 400);
    return () => clearTimeout(id);
  }, [accountId, changes, load, path]);

  const navigate = useCallback((to: string, record = true) => {
    if (to === path) { void load(true); return; }
    if (record) { history.current.back.push(path); history.current.forward = []; }
    onPathChange(to);
  }, [load, onPathChange, path]);

  const goBack = () => {
    const to = history.current.back.pop();
    if (to === undefined) return;
    history.current.forward.push(path);
    onPathChange(to);
  };
  const goForward = () => {
    const to = history.current.forward.pop();
    if (to === undefined) return;
    history.current.back.push(path);
    onPathChange(to);
  };

  const entries = listing?.entries ?? [];
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? entries.filter((e) => e.name.toLowerCase().includes(f)) : [...entries];
    list.sort((a, b) => {
      const da = a.kind === 'dir' ? 0 : 1;
      const db = b.kind === 'dir' ? 0 : 1;
      if (da !== db) return da - db;
      let c = 0;
      if (sort.key === 'size') c = a.size - b.size;
      else if (sort.key === 'mtime') c = a.mtime - b.mtime;
      if (c === 0) c = collator.compare(a.name, b.name);
      return c * sort.dir;
    });
    return list;
  }, [entries, filter, sort]);
  const visible = rows.slice(0, limit);
  const byName = useMemo(() => new Map(entries.map((e) => [e.name, e])), [entries]);
  const selectedEntries = rows.filter((e) => selected.has(e.name));
  const writable = listing?.writable === true;
  const depth = splitPath(path).length;
  const canPaste = writable && clipboard.accountId === accountId && clipboard.paths.length > 0;

  const setSortKey = (key: SortKey) => {
    const next = { key, dir: (sort.key === key ? -sort.dir : 1) as 1 | -1 };
    setSort(next);
    try { localStorage.setItem('oblimint.files.sort', JSON.stringify(next)); } catch { /* private mode */ }
  };

  // ── Selection ──
  const selectOnly = (name: string | null) => {
    setSelected(name ? new Set([name]) : new Set());
    setAnchor(name);
    setCursor(name);
  };
  const clickRow = (e: MouseEvent, name: string) => {
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.name === anchor);
      const b = rows.findIndex((r) => r.name === name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = rows.slice(lo, hi + 1).map((r) => r.name);
      setSelected(new Set(e.ctrlKey || e.metaKey ? [...selected, ...range] : range));
      setCursor(name);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const s = new Set(selected);
      if (s.has(name)) s.delete(name); else s.add(name);
      setSelected(s);
      setAnchor(name);
      setCursor(name);
      return;
    }
    selectOnly(name);
  };
  const moveCursor = (delta: number | 'home' | 'end', extend: boolean) => {
    if (!rows.length) return;
    const cur = cursor ? rows.findIndex((r) => r.name === cursor) : -1;
    let i = delta === 'home' ? 0 : delta === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, cur + delta));
    if (cur < 0 && typeof delta === 'number') i = delta > 0 ? 0 : rows.length - 1;
    const name = rows[i].name;
    if (i >= limit) setLimit(i + PAGE);
    if (extend && anchor) {
      const a = rows.findIndex((r) => r.name === anchor);
      const [lo, hi] = a < i ? [a, i] : [i, a];
      setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.name)));
      setCursor(name);
    } else {
      selectOnly(name);
    }
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  // ── Actions ──
  const reportBatch = (results: FileOpResult[], okKey: string, okFallback: string) => {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (ok) toast.success(t(okKey, { count: ok, defaultValue: okFallback }));
    for (const f of failed.slice(0, 3)) toast.error(`${baseName(f.path)} : ${f.error ?? f.code}`);
    if (failed.length > 3) toast.error(t('files.errors.more', { count: failed.length - 3, defaultValue: '… and {{count}} more error(s)' }));
  };

  const openEntry = (e: FileEntry) => {
    const p = joinPath(path, e.name);
    if (e.kind === 'dir') { navigate(p); return; }
    if (e.kind === 'symlink') {
      toast(t('files.symlinkInfo', { target: e.target ?? '?', defaultValue: 'Symbolic link to {{target}}: links are shown but never followed.' }), { icon: '🔗' });
      return;
    }
    if (e.kind !== 'file') return;
    if (previewKind(e.name)) { setPreview(p); return; }
    if (looksText(e.name)) { setEditor(p); return; }
    void filesApi.download(accountId, p);
  };

  const newFolder = async () => {
    if (!writable) return;
    const name = await prompt({ title: t('files.actions.newFolder') || 'New folder', placeholder: t('files.namePlaceholder') || 'Name', required: true, plain: true, maxLength: 255 });
    if (name === null) return;
    if (!validEntryName(name.trim())) { toast.error(t('files.errors.invalidName') || 'Invalid name'); return; }
    try {
      await filesApi.mkdir(accountId, joinPath(path, name.trim()));
      await load(true);
      selectOnly(name.trim());
    } catch (err) { toast.error(apiError(err).message); }
  };

  const newFile = async () => {
    if (!writable) return;
    const name = await prompt({ title: t('files.actions.newFile') || 'New file', placeholder: 'index.php', required: true, plain: true, maxLength: 255 });
    if (name === null) return;
    const n = name.trim();
    if (!validEntryName(n)) { toast.error(t('files.errors.invalidName') || 'Invalid name'); return; }
    try {
      await writeFileContent(accountId, joinPath(path, n), new Blob([]));
      await load(true);
      selectOnly(n);
      setEditor(joinPath(path, n));
    } catch (err) { toast.error(apiError(err).message); }
  };

  const rename = async (target?: FileEntry) => {
    const e = target ?? (selectedEntries.length === 1 ? selectedEntries[0] : null);
    if (!e || !writable) return;
    const name = await prompt({ title: t('files.actions.rename') || 'Rename', defaultValue: e.name, required: true, plain: true, maxLength: 255 });
    if (name === null || name.trim() === e.name) return;
    const n = name.trim();
    if (!validEntryName(n)) { toast.error(t('files.errors.invalidName') || 'Invalid name'); return; }
    try {
      const [r] = await filesApi.move(accountId, [{ from: joinPath(path, e.name), to: joinPath(path, n) }]);
      if (!r?.ok) { toast.error(r?.error ?? 'Error'); return; }
      await load(true);
      selectOnly(n);
    } catch (err) { toast.error(apiError(err).message); }
  };

  const remove = async (targets = selectedEntries) => {
    if (!targets.length || !writable && !listing?.uploadsBlocked) return;
    const names = targets.map((e) => e.name);
    const dirs = targets.filter((e) => e.kind === 'dir').length;
    const ok = await confirm({
      title: t('files.actions.delete') || 'Delete',
      message: (
        <div className="space-y-2 text-sm">
          <p>{t('files.deleteConfirm', { count: names.length, defaultValue: 'Delete {{count}} item(s)? This cannot be undone.' })}</p>
          {dirs > 0 && <p className="text-status-down">{t('files.deleteDirs', { count: dirs, defaultValue: '{{count}} folder(s) will be deleted with everything they contain.' })}</p>}
          <ul className="max-h-32 overflow-y-auto font-mono text-xs text-text-secondary">
            {names.slice(0, 8).map((n) => <li key={n} className="truncate">{n}</li>)}
            {names.length > 8 && <li>… +{names.length - 8}</li>}
          </ul>
        </div>
      ),
      danger: true,
    });
    if (!ok) return;
    try {
      reportBatch(await filesApi.remove(accountId, names.map((n) => joinPath(path, n))), 'files.deleted', '{{count}} item(s) deleted');
    } catch (err) { toast.error(apiError(err).message); }
    await load();
  };

  const download = () => {
    const files = selectedEntries.filter((e) => e.kind === 'file');
    if (selectedEntries.some((e) => e.kind === 'dir')) toast(t('files.noFolderDownload') || 'Folders cannot be downloaded yet: only the selected files are.', { icon: 'ℹ️' });
    files.slice(0, 20).forEach((e, i) => setTimeout(() => void filesApi.download(accountId, joinPath(path, e.name)), i * 400));
  };

  const putClipboard = (mode: 'copy' | 'cut') => {
    if (!selectedEntries.length) return;
    clipboard.set(accountId, mode, selectedEntries.map((e) => joinPath(path, e.name)));
    toast.success(t(mode === 'copy' ? 'files.copied' : 'files.cut', { count: selectedEntries.length, defaultValue: mode === 'copy' ? '{{count}} item(s) copied' : '{{count}} item(s) cut' }));
  };

  /** Free name in the folder shown ("a (2).txt"…). */
  const freeName = (name: string, taken: Set<string>) => {
    if (!taken.has(name)) return name;
    for (let n = 2; n < 1000; n++) { const c = numberedName(name, n); if (!taken.has(c)) return c; }
    return name;
  };

  const moveInto = async (dir: string, paths: string[]) => {
    const items = paths.filter((p) => parentPath(p) !== dir && dir !== p && !dir.startsWith(`${p}/`)).map((p) => ({ from: p, to: joinPath(dir, baseName(p)) }));
    if (!items.length) return;
    try {
      let res = await filesApi.move(accountId, items);
      const conflicts = items.filter((_, i) => res[i]?.code === 'fileExists');
      if (conflicts.length && await confirm({
        title: t('files.replaceTitle') || 'Replace?',
        message: t('files.replaceMessage', { count: conflicts.length, defaultValue: '{{count}} item(s) already exist in the destination. Replace the files? (folders are never replaced)' }),
        confirmLabel: t('files.transfers.overwrite') || 'Overwrite',
        danger: true,
      })) {
        const again = await filesApi.move(accountId, conflicts, true);
        res = res.map((r) => (r.code === 'fileExists' ? again.find((a) => a.path === r.path) ?? r : r));
      }
      reportBatch(res, 'files.moved', '{{count}} item(s) moved');
    } catch (err) { toast.error(apiError(err).message); }
    await load(true);
  };

  const paste = async () => {
    if (!canPaste) return;
    if (clipboard.mode === 'cut') {
      await moveInto(path, clipboard.paths);
      clipboard.clear();
      return;
    }
    const taken = new Set(entries.map((e) => e.name));
    const items = clipboard.paths.map((p) => {
      const name = freeName(baseName(p), taken);
      taken.add(name);
      return { from: p, to: joinPath(path, name) };
    });
    const id = toast.loading(t('files.copying') || 'Copying…');
    try {
      reportBatch(await filesApi.copy(accountId, items), 'files.copiedDone', '{{count}} item(s) copied');
    } catch (err) { toast.error(apiError(err).message); } finally { toast.dismiss(id); }
    await load(true);
  };

  const uploadTree = (tree: DroppedTree, dir = path) => {
    if (!tree.files.length && !tree.dirs.length) return;
    const items: UploadItem[] = tree.files.map((f) => ({ file: f.file, path: joinPath(dir, f.rel) }));
    enqueue(accountId, items, tree.dirs.map((d) => joinPath(dir, d)));
  };

  // ── Keyboard ──
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const cur = cursor ? byName.get(cursor) : undefined;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'ArrowDown' && !e.altKey) { handled(); moveCursor(1, e.shiftKey); }
    else if (k === 'ArrowUp' && e.altKey) { handled(); if (depth) navigate(parentPath(path)); }
    else if (k === 'ArrowUp') { handled(); moveCursor(-1, e.shiftKey); }
    else if (k === 'ArrowLeft' && e.altKey) { handled(); goBack(); }
    else if (k === 'ArrowRight' && e.altKey) { handled(); goForward(); }
    else if (k === 'Home') { handled(); moveCursor('home', e.shiftKey); }
    else if (k === 'End') { handled(); moveCursor('end', e.shiftKey); }
    else if (k === 'PageDown') { handled(); moveCursor(15, e.shiftKey); }
    else if (k === 'PageUp') { handled(); moveCursor(-15, e.shiftKey); }
    else if (k === 'Enter') { handled(); if (selectedEntries.length > 1) download(); else if (cur) openEntry(cur); }
    else if (k === 'Backspace' && !filter) { handled(); if (depth) navigate(parentPath(path)); }
    else if (k === 'Backspace') { handled(); setFilter((f) => f.slice(0, -1)); }
    else if (k === 'Delete') { handled(); void remove(); }
    else if (k === 'F2') { handled(); void rename(); }
    else if (k === 'F5' || (mod && k.toLowerCase() === 'r')) { handled(); void load(true); }
    else if (mod && k.toLowerCase() === 'a') { handled(); setSelected(new Set(rows.map((r) => r.name))); }
    else if (mod && k.toLowerCase() === 'c') { handled(); putClipboard('copy'); }
    else if (mod && k.toLowerCase() === 'x') { handled(); if (writable) putClipboard('cut'); }
    else if (mod && k.toLowerCase() === 'v') { handled(); void paste(); }
    else if (mod && k.toLowerCase() === 'f') { handled(); filterRef.current?.focus(); }
    else if (mod && k.toLowerCase() === 'l') { handled(); setTyping(path); }
    else if (k === 'Escape') { handled(); if (filter) setFilter(''); else selectOnly(null); }
    else if (k.length === 1 && !mod && !e.altKey && k !== ' ') { handled(); setFilter((f) => f + k); }
  };

  // ── Drag & drop ──
  const internalPaths = (dt: DataTransfer): string[] | null => {
    if (!dt.types.includes(DRAG_TYPE)) return null;
    try {
      const v = JSON.parse(dt.getData(DRAG_TYPE)) as { accountId: number; paths: string[] };
      return v.accountId === accountId ? v.paths : [];
    } catch { return []; }
  };
  const onRowDragStart = (e: DragEvent, name: string) => {
    const names = selected.has(name) ? [...selected] : [name];
    if (!selected.has(name)) selectOnly(name);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ accountId, paths: names.map((n) => joinPath(path, n)) }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE);
  const dropInto = async (e: DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropTarget(null);
    const internal = internalPaths(e.dataTransfer);
    if (internal) {
      if (!internal.length) return;
      const ok = await confirm({
        title: t('files.moveTitle') || 'Move',
        message: t('files.moveConfirm', { count: internal.length, dir, defaultValue: 'Move {{count}} item(s) to {{dir}}?' }),
        confirmLabel: t('files.actions.move') || 'Move',
      });
      if (ok) await moveInto(dir, internal);
      return;
    }
    if (!writable && dir === path) { toast.error(t('files.readOnlyHere') || 'This folder is read-only.'); return; }
    try {
      uploadTree(await readDrop(e.dataTransfer), dir);
    } catch (err) { toast.error(apiError(err).message); }
  };

  // ── Context menu ──
  const menuItems = (onRow: boolean): ContextMenuItem[] => {
    const one = selectedEntries.length === 1 ? selectedEntries[0] : null;
    if (!onRow) {
      return [
        { key: 'newFolder', label: t('files.actions.newFolder') || 'New folder', icon: <FolderPlus size={15} />, onClick: () => void newFolder(), disabled: !writable },
        { key: 'newFile', label: t('files.actions.newFile') || 'New file', icon: <FilePlus size={15} />, onClick: () => void newFile(), disabled: !writable },
        { key: 'upload', label: t('files.actions.upload') || 'Upload files', icon: <Upload size={15} />, onClick: () => fileInput.current?.click(), disabled: !writable },
        { key: 'uploadDir', label: t('files.actions.uploadFolder') || 'Upload a folder', icon: <FolderUp size={15} />, onClick: () => folderInput.current?.click(), disabled: !writable },
        { key: 'paste', label: t('files.actions.paste') || 'Paste', icon: <ClipboardPaste size={15} />, shortcut: 'Ctrl+V', onClick: () => void paste(), disabled: !canPaste, separator: true },
        { key: 'refresh', label: t('files.actions.refresh') || 'Refresh', icon: <RefreshCw size={15} />, shortcut: 'F5', onClick: () => void load(true) },
        { key: 'copyPath', label: t('files.actions.copyPath') || 'Copy the path', icon: <ClipboardCopy size={15} />, onClick: () => void copyText(path) },
      ];
    }
    return [
      { key: 'open', label: one?.kind === 'dir' ? (t('files.actions.open') || 'Open') : one && previewKind(one.name) ? (t('files.actions.preview') || 'Preview') : (t('files.actions.edit') || 'Edit'),
        icon: one && previewKind(one.name) ? <Eye size={15} /> : <FolderInput size={15} />, shortcut: 'Enter', onClick: () => one && openEntry(one), disabled: !one || one.kind === 'symlink' || one.kind === 'other' },
      { key: 'download', label: t('files.actions.download') || 'Download', icon: <Download size={15} />, onClick: download, disabled: !selectedEntries.some((e) => e.kind === 'file') },
      { key: 'copy', label: t('files.actions.copy') || 'Copy', icon: <Copy size={15} />, shortcut: 'Ctrl+C', onClick: () => putClipboard('copy'), separator: true },
      { key: 'cut', label: t('files.actions.cut') || 'Cut', icon: <Scissors size={15} />, shortcut: 'Ctrl+X', onClick: () => putClipboard('cut'), disabled: !writable },
      { key: 'paste', label: t('files.actions.pasteInto') || 'Paste into', icon: <ClipboardPaste size={15} />, onClick: () => one && void (async () => { await moveOrCopyInto(joinPath(path, one.name)); })(), disabled: !one || one.kind !== 'dir' || clipboard.accountId !== accountId || !clipboard.paths.length },
      { key: 'rename', label: t('files.actions.rename') || 'Rename', icon: <Pencil size={15} />, shortcut: 'F2', onClick: () => void rename(), disabled: !one || !writable },
      { key: 'copyPath', label: t('files.actions.copyPath') || 'Copy the path', icon: <ClipboardCopy size={15} />, onClick: () => void copyText(one ? joinPath(path, one.name) : path), disabled: !one },
      { key: 'delete', label: t('files.actions.delete') || 'Delete', icon: <Trash2 size={15} />, shortcut: 'Del', danger: true, separator: true, onClick: () => void remove(), disabled: !writable && !listing?.uploadsBlocked },
    ];
  };

  const moveOrCopyInto = async (dir: string) => {
    if (clipboard.mode === 'cut') { await moveInto(dir, clipboard.paths); clipboard.clear(); return; }
    const items = clipboard.paths.map((p) => ({ from: p, to: joinPath(dir, baseName(p)) }));
    try { reportBatch(await filesApi.copy(accountId, items), 'files.copiedDone', '{{count}} item(s) copied'); } catch (err) { toast.error(apiError(err).message); }
  };

  // ── Rendering ──
  const crumbs = splitPath(path);
  const crumbLabel = (seg: string, i: number) => {
    if (i === 0) return seg === 'staging' ? (t('files.areas.staging') || 'Code (staging)') : (t('files.areas.data') || 'Data');
    if (i === 1 && sites[seg]) return `${seg} · ${sites[seg]}`;
    return seg;
  };
  const sortIcon = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null);
  const selSize = selectedEntries.reduce((s, e) => s + (e.kind === 'file' ? e.size : 0), 0);
  const previewSiblings = rows.filter((e) => e.kind === 'file' && previewKind(e.name)).map((e) => joinPath(path, e.name));
  const th = 'px-3 py-2 text-left text-[11px] font-mono font-medium uppercase tracking-[0.12em] text-text-muted select-none';

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl bg-bg-secondary', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.04] px-2 py-1.5">
        <IconButton size="sm" label={`${t('files.back') || 'Back'} (Alt+←)`} icon={<ArrowLeft className="h-4 w-4" />} onClick={goBack} disabled={!history.current.back.length} />
        <IconButton size="sm" label={`${t('files.forward') || 'Forward'} (Alt+→)`} icon={<ArrowRight className="h-4 w-4" />} onClick={goForward} disabled={!history.current.forward.length} />
        <IconButton size="sm" label={`${t('files.up') || 'Parent folder'} (Alt+↑)`} icon={<ArrowUpFromLine className="h-4 w-4" />} onClick={() => navigate(parentPath(path))} disabled={!depth} />
        <IconButton size="sm" label={`${t('files.actions.refresh') || 'Refresh'} (F5)`} icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />} onClick={() => void load(true)} />

        {/* Breadcrumb / typed path */}
        <div className="mx-1 flex min-w-[180px] flex-1 items-center rounded-lg bg-bg-primary/60 px-2 py-1">
          {typing !== null ? (
            <input
              autoFocus
              value={typing}
              onChange={(e) => setTyping(e.target.value)}
              onBlur={() => setTyping(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setTyping(null); listRef.current?.focus(); }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const p = normalizeTyped(typing);
                  setTyping(null);
                  if (p === null) toast.error(t('files.errors.invalidPath') || 'Invalid path (under /staging or /data)');
                  else navigate(p);
                  listRef.current?.focus();
                }
              }}
              spellCheck={false}
              className="w-full bg-transparent font-mono text-[13px] text-text-primary outline-none"
            />
          ) : (
            <div className="flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto" onClick={(e) => { if (e.target === e.currentTarget) setTyping(path); }}>
              <button type="button" onClick={() => navigate('/')} className="flex shrink-0 items-center rounded px-1 py-0.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary" title={t('files.root') || 'Account root'}>
                <Home className="h-3.5 w-3.5" />
              </button>
              {crumbs.map((seg, i) => {
                const to = `/${crumbs.slice(0, i + 1).join('/')}`;
                return (
                  <span key={to} className="flex shrink-0 items-center">
                    <span className="px-0.5 text-text-muted">/</span>
                    <button
                      type="button"
                      onClick={() => navigate(to)}
                      onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE) && i >= 1) { e.preventDefault(); setDropTarget(`crumb:${to}`); } }}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(e) => void dropInto(e, to)}
                      className={cn('max-w-[220px] truncate rounded px-1 py-0.5 text-[13px] hover:bg-bg-hover', i === crumbs.length - 1 ? 'font-medium text-text-primary' : 'text-text-secondary',
                        dropTarget === `crumb:${to}` && 'bg-accent/20 ring-1 ring-accent')}
                    >
                      {crumbLabel(seg, i)}
                    </button>
                  </span>
                );
              })}
              <span className="min-w-[24px] flex-1 self-stretch" onClick={() => setTyping(path)} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-bg-primary/60 px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); listRef.current?.focus(); } if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.focus(); moveCursor(1, false); } }}
            placeholder={t('files.filter') || 'Filter'}
            className="w-28 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted sm:w-36"
          />
          {filter && <button type="button" onClick={() => setFilter('')} className="text-text-muted hover:text-text-primary"><X className="h-3.5 w-3.5" /></button>}
        </div>

        <span className="mx-0.5 hidden h-5 w-px bg-white/[0.06] sm:block" />
        <IconButton size="sm" label={t('files.actions.newFolder') || 'New folder'} icon={<FolderPlus className="h-4 w-4" />} onClick={() => void newFolder()} disabled={!writable} />
        <IconButton size="sm" label={t('files.actions.newFile') || 'New file'} icon={<FilePlus className="h-4 w-4" />} onClick={() => void newFile()} disabled={!writable} />
        <IconButton size="sm" label={t('files.actions.upload') || 'Upload files'} icon={<Upload className="h-4 w-4" />} onClick={() => fileInput.current?.click()} disabled={!writable} />
        <IconButton size="sm" label={t('files.actions.uploadFolder') || 'Upload a folder'} icon={<FolderUp className="h-4 w-4" />} onClick={() => folderInput.current?.click()} disabled={!writable} />
        <IconButton size="sm" label={t('files.actions.download') || 'Download'} icon={<Download className="h-4 w-4" />} onClick={download} disabled={!selectedEntries.some((e) => e.kind === 'file')} />
        <IconButton size="sm" label={`${t('files.actions.rename') || 'Rename'} (F2)`} icon={<Pencil className="h-4 w-4" />} onClick={() => void rename()} disabled={selectedEntries.length !== 1 || !writable} />
        <IconButton size="sm" label={`${t('files.actions.copy') || 'Copy'} (Ctrl+C)`} icon={<Copy className="h-4 w-4" />} onClick={() => putClipboard('copy')} disabled={!selectedEntries.length} />
        <IconButton size="sm" label={`${t('files.actions.cut') || 'Cut'} (Ctrl+X)`} icon={<Scissors className="h-4 w-4" />} onClick={() => putClipboard('cut')} disabled={!selectedEntries.length || !writable} />
        <IconButton size="sm" label={`${t('files.actions.paste') || 'Paste'} (Ctrl+V)`} icon={<ClipboardPaste className="h-4 w-4" />} onClick={() => void paste()} disabled={!canPaste} />
        <IconButton size="sm" variant="danger" label={`${t('files.actions.delete') || 'Delete'} (Del)`} icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove()} disabled={!selectedEntries.length || (!writable && !listing?.uploadsBlocked)} />
      </div>

      {listing?.uploadsBlocked && (
        <div className="flex items-center gap-2 bg-status-pending/10 px-3 py-1.5 text-xs text-status-pending">
          <Lock className="h-3.5 w-3.5" />{t('files.quotaBlocked') || 'Disk quota exceeded: uploads are blocked (reading and deleting remain possible).'}
        </div>
      )}

      {/* List */}
      <div
        ref={listRef}
        tabIndex={0}
        role="grid"
        aria-label={path}
        onKeyDown={onKey}
        onClick={(e) => { if (e.target === e.currentTarget) selectOnly(null); }}
        onContextMenu={(e) => { e.preventDefault(); if (e.target === e.currentTarget) selectOnly(null); setMenu({ x: e.clientX, y: e.clientY, onRow: false }); }}
        onDragEnter={(e) => { if (!e.dataTransfer.types.includes('Files')) return; dragDepth.current++; if (dropTarget === null) setDropTarget(''); }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropTarget(null); }}
        onDragOver={(e) => { if (acceptsDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? 'move' : 'copy'; } }}
        onDrop={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); dragDepth.current = 0; setDropTarget(null); return; } void dropInto(e, path); }}
        className={cn('relative min-h-[260px] flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
          dropTarget === '' && 'bg-accent/[0.04]')}
      >
        {error ? (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <p className="text-sm text-status-down">{error}</p>
            <button type="button" onClick={() => navigate('/')} className="text-xs text-accent hover:underline">{t('files.root') || 'Account root'}</button>
          </div>
        ) : !listing ? (
          <div className="flex justify-center p-10"><LoadingSpinner /></div>
        ) : (
          <table className="w-full table-fixed text-sm" onContextMenu={(e) => e.stopPropagation()}>
            <thead className="sticky top-0 z-10 bg-bg-secondary">
              <tr>
                <th className={cn(th, 'cursor-pointer hover:text-text-primary')} onClick={() => setSortKey('name')} aria-sort={sort.key === 'name' ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <span className="inline-flex items-center gap-1">{t('files.columns.name') || 'Name'}{sortIcon('name')}</span>
                </th>
                <th className={cn(th, 'w-[110px] cursor-pointer text-right hover:text-text-primary')} onClick={() => setSortKey('size')} aria-sort={sort.key === 'size' ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <span className="inline-flex items-center gap-1">{sortIcon('size')}{t('files.columns.size') || 'Size'}</span>
                </th>
                <th className={cn(th, 'hidden w-[170px] cursor-pointer hover:text-text-primary sm:table-cell')} onClick={() => setSortKey('mtime')} aria-sort={sort.key === 'mtime' ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <span className="inline-flex items-center gap-1">{t('files.columns.modified') || 'Modified'}{sortIcon('mtime')}</span>
                </th>
                <th className={cn(th, 'hidden w-[120px] lg:table-cell')}>{t('files.columns.mode') || 'Permissions'}</th>
              </tr>
            </thead>
            <tbody
              onContextMenu={(e) => {
                const row = (e.target as HTMLElement).closest('tr[data-name]') as HTMLElement | null;
                e.preventDefault();
                e.stopPropagation();
                if (row) {
                  const name = row.dataset.name!;
                  if (!selected.has(name)) selectOnly(name);
                  setMenu({ x: e.clientX, y: e.clientY, onRow: true });
                }
              }}
            >
              {visible.map((e) => {
                const isSel = selected.has(e.name);
                const isCut = clipboard.mode === 'cut' && clipboard.accountId === accountId && clipboard.paths.includes(joinPath(path, e.name));
                const isDropDir = e.kind === 'dir' && dropTarget === e.name;
                return (
                  <tr
                    key={e.name}
                    data-name={e.name}
                    aria-selected={isSel}
                    draggable={depth >= 2}
                    onDragStart={(ev) => onRowDragStart(ev, e.name)}
                    onDragOver={(ev) => { if (e.kind === 'dir' && acceptsDrop(ev)) { ev.preventDefault(); ev.stopPropagation(); setDropTarget(e.name); } }}
                    onDragLeave={() => { if (dropTarget === e.name) setDropTarget(''); }}
                    onDrop={(ev) => { if (e.kind === 'dir') void dropInto(ev, joinPath(path, e.name)); }}
                    onClick={(ev) => { clickRow(ev, e.name); listRef.current?.focus(); }}
                    onDoubleClick={() => openEntry(e)}
                    className={cn(
                      'cursor-default border-t border-white/[0.03] transition-colors',
                      isSel ? 'bg-accent/[0.14] hover:bg-accent/20' : 'hover:bg-bg-hover/60',
                      cursor === e.name && 'shadow-[inset_2px_0_0_rgb(var(--c-accent))]',
                      isDropDir && 'bg-accent/25 ring-1 ring-inset ring-accent',
                      isCut && 'opacity-50',
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <FileIcon entry={e} />
                        <span className="truncate text-text-primary" title={e.name}>{e.name}</span>
                        {e.kind === 'symlink' && <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-text-muted"><Link2 className="h-3 w-3 shrink-0" />{e.target}</span>}
                        {e.site && <span className="shrink-0 truncate rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">{e.site.label}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-text-secondary">{e.kind === 'file' ? formatBytes(e.size) : ''}</td>
                    <td className="hidden px-3 py-1.5 font-mono text-xs text-text-secondary sm:table-cell">{fmtDate(e.mtime)}</td>
                    <td className="hidden px-3 py-1.5 font-mono text-[11px] text-text-muted lg:table-cell">{depth ? modeString(e.mode, e.kind) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {listing && !rows.length && !error && (
          <div className="pointer-events-none flex flex-col items-center gap-2 p-10 text-center text-sm text-text-muted">
            <HardDrive className="h-8 w-8 opacity-50" />
            {filter ? (t('files.noMatch') || 'Nothing matches the filter.') : (t('files.empty') || 'This folder is empty.')}
            {!filter && writable && <span className="text-xs">{t('files.dropHint') || 'Drop files or folders here to upload them.'}</span>}
          </div>
        )}
        {rows.length > limit && (
          <div className="flex justify-center p-3">
            <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover">
              {t('files.showMore', { count: Math.min(PAGE, rows.length - limit), total: rows.length, defaultValue: 'Show {{count}} more ({{total}} in all)' })}
            </button>
          </div>
        )}
        {dropTarget === '' && writable && (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-bg-primary/40">
            <span className="rounded-lg bg-bg-secondary px-3 py-1.5 text-sm text-accent shadow">{t('files.dropHere', { dir: path, defaultValue: 'Drop to upload into {{dir}}' })}</span>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-text-muted">
        <span>{t('files.status.items', { count: rows.length, defaultValue: '{{count}} item(s)' })}{filter && ` / ${entries.length}`}</span>
        {selectedEntries.length > 0 && <span>{t('files.status.selected', { count: selectedEntries.length, size: formatBytes(selSize), defaultValue: '{{count}} selected ({{size}})' })}</span>}
        {selectedEntries.length === 1 && selectedEntries[0].kind !== 'dir' && depth > 0 && (
          <span className="hidden md:inline">{modeString(selectedEntries[0].mode, selectedEntries[0].kind)} · {fmtDate(selectedEntries[0].mtime)}</span>
        )}
        {listing?.truncated && <span className="text-status-pending">{t('files.truncated') || 'Too many entries: only the first 20 000 are listed.'}</span>}
        {listing && !writable && depth > 0 && !listing.uploadsBlocked && (
          <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />{depth < 2 ? (t('files.readOnlyTop') || 'Site folders are managed by the panel') : (t('files.readOnlyHere') || 'This folder is read-only.')}</span>
        )}
        {clipboard.paths.length > 0 && clipboard.accountId === accountId && (
          <span className="ml-auto inline-flex items-center gap-1">
            {clipboard.mode === 'cut' ? <Scissors className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {t('files.status.clipboard', { count: clipboard.paths.length, defaultValue: '{{count}} in the clipboard' })}
            <button type="button" onClick={clipboard.clear} className="hover:text-text-primary"><X className="h-3 w-3" /></button>
          </span>
        )}
      </div>

      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) uploadTree(readPicked(e.target.files)); e.target.value = ''; }} />
      <input
        ref={(el) => { folderInput.current = el; if (el) el.setAttribute('webkitdirectory', ''); }}
        type="file"
        multiple
        hidden
        onChange={(e) => { if (e.target.files) uploadTree(readPicked(e.target.files)); e.target.value = ''; }}
      />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.onRow)} onClose={() => { setMenu(null); listRef.current?.focus(); }} />}
      {editor && (
        <FileEditorModal accountId={accountId} path={editor} readOnly={!writable && parentPath(editor) === path}
          onClose={() => { setEditor(null); listRef.current?.focus(); }} onSaved={() => void load(true)} />
      )}
      {preview && (
        <FilePreviewModal accountId={accountId} path={preview} siblings={previewSiblings} onNavigate={setPreview} onClose={() => { setPreview(null); listRef.current?.focus(); }} />
      )}
    </div>
  );
}
