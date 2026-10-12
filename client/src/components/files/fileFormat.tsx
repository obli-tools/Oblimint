import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, FileWarning, Folder, FolderCog, Link2,
  Database, Lock,
} from 'lucide-react';
import type { FileEntry } from '@oblimint/shared';

// Pure helpers of the file explorer: paths, types, icons, editor language.

export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
export const parentPath = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const splitPath = (p: string) => p.split('/').filter(Boolean);

/** Normalizes a typed path ("staging//a/./b/" → "/staging/a/b"); null when it climbs or leaves the tree. */
export function normalizeTyped(p: string): string | null {
  const segs: string[] = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!segs.length) return null; segs.pop(); continue; }
    segs.push(s);
  }
  if (segs.length && segs[0] !== 'staging' && segs[0] !== 'data') return null;
  return `/${segs.join('/')}`;
}

/** Name the explorer accepts for a new / renamed entry. */
export function validEntryName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

export const extOf = (name: string) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const VIDEO = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi']);
const AUDIO = new Set(['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
const CODE = new Set(['php', 'phtml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'vue', 'py', 'rb', 'sh', 'go', 'twig', 'tpl', 'blade']);
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'ini', 'conf', 'cfg', 'env', 'yml', 'yaml', 'toml', 'csv', 'htaccess', 'lock', 'sql', 'json', 'gitignore', 'editorconfig', 'map']);

/** Inline preview (image / video / audio / pdf) — SVG never inline (script). */
export function previewKind(name: string): 'image' | 'video' | 'audio' | 'pdf' | null {
  const e = extOf(name);
  if (IMAGE.has(e) && e !== 'svg') return 'image';
  if (VIDEO.has(e) && e !== 'mkv' && e !== 'avi') return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  return null;
}

/** Opened in the editor on double-click (else: preview or download). */
export function looksText(name: string): boolean {
  const e = extOf(name);
  const lower = name.toLowerCase();
  return CODE.has(e) || TEXT.has(e) || e === 'svg' || lower === '.htaccess' || lower === '.env' || lower.startsWith('.') || lower === 'dockerfile' || lower === 'makefile' || e === '';
}

export type EditorLanguage = 'php' | 'javascript' | 'typescript' | 'css' | 'html' | 'json' | 'markdown' | 'xml' | 'sql' | 'yaml' | 'text';

export function languageOf(name: string): EditorLanguage {
  switch (extOf(name)) {
    case 'php': case 'phtml': case 'inc': return 'php';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'css': case 'scss': case 'less': return 'css';
    case 'html': case 'htm': case 'twig': case 'tpl': case 'vue': case 'blade': return 'html';
    case 'json': case 'map': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'xml': case 'svg': return 'xml';
    case 'sql': return 'sql';
    case 'yml': case 'yaml': return 'yaml';
    default: return 'text';
  }
}

export function FileIcon({ entry, size = 16 }: { entry: Pick<FileEntry, 'name' | 'kind'>; size?: number }) {
  const cls = 'shrink-0';
  if (entry.kind === 'dir') {
    if (entry.name === 'staging' || entry.name === 'data') return <FolderCog size={size} className={`${cls} text-accent`} />;
    return <Folder size={size} className={`${cls} text-amber-400`} fill="currentColor" fillOpacity={0.25} />;
  }
  if (entry.kind === 'symlink') return <Link2 size={size} className={`${cls} text-sky-400`} />;
  if (entry.kind === 'other') return <FileWarning size={size} className={`${cls} text-text-muted`} />;
  const e = extOf(entry.name);
  const lower = entry.name.toLowerCase();
  if (lower === '.htaccess' || lower === '.env' || lower.endsWith('.pem') || lower.endsWith('.key')) return <Lock size={size} className={`${cls} text-orange-400`} />;
  if (IMAGE.has(e)) return <FileImage size={size} className={`${cls} text-fuchsia-400`} />;
  if (VIDEO.has(e)) return <FileVideo size={size} className={`${cls} text-rose-400`} />;
  if (AUDIO.has(e)) return <FileAudio size={size} className={`${cls} text-pink-400`} />;
  if (ARCHIVE.has(e)) return <FileArchive size={size} className={`${cls} text-yellow-500`} />;
  if (e === 'json') return <FileJson size={size} className={`${cls} text-lime-400`} />;
  if (e === 'csv' || e === 'xlsx' || e === 'ods') return <FileSpreadsheet size={size} className={`${cls} text-emerald-400`} />;
  if (e === 'sql' || e === 'sqlite' || e === 'db') return <Database size={size} className={`${cls} text-cyan-400`} />;
  if (CODE.has(e)) return <FileCode size={size} className={`${cls} text-violet-400`} />;
  if (TEXT.has(e)) return <FileText size={size} className={`${cls} text-text-secondary`} />;
  return <File size={size} className={`${cls} text-text-muted`} />;
}

/** "rwxr-xr-x" */
export function modeString(mode: number, kind: FileEntry['kind']): string {
  const k = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let s = '';
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? bits[(8 - i) % 3] : '-';
  return k + s;
}

// ── Drag & drop of OS files / folders (webkitGetAsEntry) ─────────────────────

export interface DroppedTree {
  files: Array<{ file: File; rel: string }>;
  /** Relative folders (parents first), empty ones included. */
  dirs: string[];
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(out); return; }
      out.push(...batch);
      next();
    }, reject);
    next();
  });
}

/** Walks dropped items (folders recursively). Falls back to the flat file list. */
export async function readDrop(dt: DataTransfer): Promise<DroppedTree> {
  const tree: DroppedTree = { files: [], dirs: [] };
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (!entries.length || entries.some((e) => !e)) {
    for (const f of [...dt.files]) tree.files.push({ file: f, rel: f.name });
    return tree;
  }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      tree.files.push({ file, rel });
    } else if (entry.isDirectory) {
      tree.dirs.push(rel);
      for (const child of await readAllEntries((entry as FileSystemDirectoryEntry).createReader())) await walk(child, rel);
    }
  };
  for (const e of entries) await walk(e!, '');
  return tree;
}

/** <input webkitdirectory> selection → the same shape. */
export function readPicked(list: FileList): DroppedTree {
  const tree: DroppedTree = { files: [], dirs: [] };
  const dirs = new Set<string>();
  for (const f of [...list]) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    tree.files.push({ file: f, rel });
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  tree.dirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
  return tree;
}
