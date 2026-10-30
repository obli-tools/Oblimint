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
  /**
   * API keys, listing with sha256 asked: SHA-256 (hex) of a regular file's
   * content; null when it was not computed (too large, over the listing's
   * budget). Absent otherwise.
   */
  sha256?: string | null;
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
  /** API keys, listing with sha256 asked: regular files left without a hash (sha256 null). */
  sha256Skipped?: number;
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
  /**
   * sha256 (hex) of the whole file. Required when files.write is a protected
   * action and the upload is approved (it enters the approval's fingerprint);
   * the chunks then go in order, one at a time (parallel: 1), and the file is
   * committed only when its content has this hash (409 contentMismatch).
   */
  contentSha256?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Fine file tools of the access keys (API v1 + MCP): bounded search, partial
// reads (lines or bytes), exact edits, and a SHA-256 precondition on every
// write so an agent never silently overwrites a change made over SFTP
// (409 fileChanged, details.currentSha256).
// ─────────────────────────────────────────────────────────────────────────────

/** A file is hashed (and read by lines) up to this size. */
export const FILE_HASH_MAX_BYTES = 64 * 1024 * 1024;
/** Lines returned by one partial read at most. */
export const FILE_READ_MAX_LINES = 2000;
/** Characters returned by one read by lines at most (a longer line is cut). */
export const FILE_READ_MAX_CHARS = 200_000;
/** Bytes returned by one read by bytes at most. */
export const FILE_READ_MAX_RANGE = 256 * 1024;
/** edit_file works on text files up to this size (the result too). */
export const FILE_EDIT_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_EDIT_MAX_EDITS = 50;
/** Listing with sha256: files hashed at most, and their total size. */
export const FILE_LIST_HASH_MAX_FILES = 200;
export const FILE_LIST_HASH_MAX_BYTES = 64 * 1024 * 1024;
/** Search: results by default / at most, matches per file, files bigger than this are skipped. */
export const FILE_SEARCH_DEFAULT_RESULTS = 100;
export const FILE_SEARCH_MAX_RESULTS = 500;
export const FILE_SEARCH_MAX_PER_FILE = 50;
export const FILE_SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Search budget: files read, bytes read, wall time. */
export const FILE_SEARCH_MAX_FILES = 10_000;
export const FILE_SEARCH_MAX_BYTES = 128 * 1024 * 1024;
export const FILE_SEARCH_MAX_MS = 15_000;
/** Folders skipped by the search unless includeVendor. */
export const FILE_SEARCH_VENDOR_DIRS = ['vendor', 'node_modules', '.git', '.svn', '.hg'] as const;

/** Partial read of a file: by lines (default) or by bytes (offset / length). */
export interface FileRange {
  path: string;
  mode: 'lines' | 'bytes';
  size: number;
  mtime: number;
  /** SHA-256 (hex) of the WHOLE file: pass it as expectedSha256 to write / edit it. null above FILE_HASH_MAX_BYTES. */
  sha256: string | null;
  /** Lines of the whole file (lines mode; null in bytes mode). */
  totalLines: number | null;
  /** Lines mode: first and last line returned (1-based; endLine = startLine - 1 when none). */
  startLine: number | null;
  endLine: number | null;
  /** Lines mode: the next line to read when the range was cut (null: nothing more asked / end of file). */
  nextLine: number | null;
  /** Bytes mode: offset of the window and bytes returned. */
  offset: number | null;
  length: number | null;
  /** Bytes mode: next offset (null at the end of the file). */
  nextOffset: number | null;
  encoding: 'utf8' | 'base64';
  /** The content (lines joined by "\n", line endings kept), null when binary (utf8) or too large. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** The range asked was cut (lines / characters cap): continue from nextLine. */
  truncated: boolean;
}

export interface FileSearchMatch {
  /** Path of the file, relative to the site area ("/wp-content/a.php"). */
  path: string;
  /** 1-based line and column (UTF-16 units) of the first match on the line. */
  line: number;
  column: number;
  /** The line (cut around the match when long). */
  text: string;
}

export type FileSearchStop = 'maxResults' | 'files' | 'bytes' | 'time';

export interface FileSearchResult {
  /** Folder searched (relative to the site area). */
  path: string;
  matches: FileSearchMatch[];
  filesScanned: number;
  filesMatched: number;
  /** Not every match is listed: why the search stopped (null: complete). */
  truncated: boolean;
  stoppedBy: FileSearchStop | null;
  skipped: {
    /** Binary files (by extension or content). */
    binary: number;
    /** Files over FILE_SEARCH_MAX_FILE_BYTES. */
    tooLarge: number;
    /** Symbolic links and special files (never followed). */
    links: number;
    /** Folders skipped (vendor, node_modules…), first ones. */
    dirs: string[];
  };
  durationMs: number;
}

/** One exact replacement of edit_file. */
export interface FileEdit {
  oldString: string;
  newString: string;
  /** Replace every occurrence (default: oldString must occur exactly once). */
  replaceAll?: boolean;
}

export interface FileEditResult {
  path: string;
  size: number;
  /** SHA-256 of the new content (the expectedSha256 of the next change). */
  sha256: string;
  previousSha256: string;
  replacements: number;
  /** The file had an executable bit: written files are 0644, it is gone (fix it over SFTP if needed). */
  executableBitLost: boolean;
}

/** Answer of a file write through a key (PUT content, write_file). */
export interface FileWriteResult {
  path: string;
  size: number;
  sha256: string;
}
