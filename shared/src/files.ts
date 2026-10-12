// ─────────────────────────────────────────────────────────────────────────────
// Web file explorer of a hosting account (« Fichiers »): the same tree as the
// account's SFTP server — /staging/<site>/… (code, published by the panel) and
// /data/<site>/<data path>/… (files written by the site). Paths are absolute in
// that virtual tree ("/staging/blog/wp-content"). The explorer can change
// exactly what the SFTP user can: nothing on the first two levels, nothing in a
// directory that is not the account's (data/<site> itself, for example).
// ─────────────────────────────────────────────────────────────────────────────

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  kind: FileKind;
  /** Bytes (0 for anything but a regular file). */
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  /** Permission bits (0o644…). */
  mode: number;
  /** Symlink target, as written (never followed). */
  target?: string;
  /** Site of a /staging/<slug> or /data/<slug> entry. */
  site?: { id: number; label: string };
}

export interface FileListing {
  /** Normalized absolute path ("/", "/staging", "/staging/blog/css"). */
  path: string;
  /** Entries can be created / renamed / deleted in this directory. */
  writable: boolean;
  entries: FileEntry[];
  /** More than FILES_MAX_ENTRIES entries: the first ones only. */
  truncated: boolean;
  /** Over quota (plan action block-uploads): read and delete only. */
  uploadsBlocked: boolean;
}

export const FILES_MAX_ENTRIES = 20_000;
/** The integrated editor opens text files up to this size. */
export const FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export interface FileText {
  path: string;
  size: number;
  mtime: number;
  /** null when the file is binary (a NUL byte in its first 8 KiB) or too large. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

/** One item of a batch operation (delete, move, copy). */
export interface FileOpResult {
  path: string;
  ok: boolean;
  code?: string;
  error?: string;
}

export interface FileMoveItem {
  from: string;
  to: string;
}

export interface FileUploadRequest {
  /** Absolute path of the file to create. */
  path: string;
  size: number;
  overwrite?: boolean;
  /** Integrated editor: refuse the save if the file changed since it was opened (409 fileChanged). */
  expectedMtime?: number;
}

export interface FileUploadSession {
  id: string;
  chunkSize: number;
  /** Number of chunks (at least 1, an empty file is one empty chunk). */
  count: number;
  /** Suggested number of chunks in flight. */
  parallel: number;
}

export interface FileUploadChunkResult {
  /** The last chunk arrived: the file is in place. */
  done: boolean;
  received: number;
}

export interface FileUploadStatus {
  received: number[];
  count: number;
  chunkSize: number;
}

/** Result of extracting an archive (zip, tar, tar.gz) into a folder. */
export interface FileExtractResult {
  files: number;
  dirs: number;
  bytes: number;
  /** Links / special entries skipped, existing files kept (no overwrite). */
  skipped: number;
  /** Entries blocked by a link or a file in the way (first 100). */
  conflicts: string[];
}
