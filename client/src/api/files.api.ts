import apiClient, { isInObliTools } from './client';
import type {
  ApiResponse, FileExtractResult, FileListing, FileMoveItem, FileOpResult, FileText, FileUploadChunkResult, FileUploadRequest, FileUploadSession, FileUploadStatus,
} from '@oblimint/shared';

// /api/accounts/:id/files* — web file explorer (shared/src/files.ts).
const base = (accountId: number) => `/accounts/${accountId}/files`;

/** URL of a file's content (inline = shown by the browser when its type is safe). */
export function fileContentUrl(accountId: number, path: string, inline = false): string {
  const q = new URLSearchParams({ path, ...(inline ? { inline: '1' } : {}) });
  return `/api${base(accountId)}/download?${q}`;
}

/** URL of a zip of entries of one folder. */
export function fileZipUrl(accountId: number, dir: string, names: string[]): string {
  const q = new URLSearchParams({ path: dir });
  for (const n of names) q.append('name', n);
  return `/api${base(accountId)}/zip?${q}`;
}

export const filesApi = {
  async extract(accountId: number, path: string, to?: string, overwrite = false): Promise<FileExtractResult> {
    const res = await apiClient.post<ApiResponse<FileExtractResult>>(`${base(accountId)}/extract`, { path, ...(to ? { to } : {}), overwrite }, { timeout: 0 });
    return res.data.data!;
  },

  /** Downloads a zip of entries of one folder (folders recursively). */
  async downloadZip(accountId: number, dir: string, names: string[]): Promise<void> {
    const name = `${names.length === 1 ? names[0] : dir.split('/').filter(Boolean).pop() || 'files'}.zip`;
    if (isInObliTools) {
      const res = await apiClient.get<Blob>(fileZipUrl(accountId, dir, names).slice('/api'.length), { responseType: 'blob', timeout: 0 });
      const url = URL.createObjectURL(res.data);
      try { clickLink(url, name); } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      return;
    }
    clickLink(fileZipUrl(accountId, dir, names), name);
  },

  async list(accountId: number, path: string): Promise<FileListing> {
    const res = await apiClient.get<ApiResponse<FileListing>>(base(accountId), { params: { path } });
    return res.data.data!;
  },

  async readText(accountId: number, path: string): Promise<FileText> {
    const res = await apiClient.get<ApiResponse<FileText>>(`${base(accountId)}/text`, { params: { path } });
    return res.data.data!;
  },

  async mkdir(accountId: number, path: string): Promise<string> {
    const res = await apiClient.post<ApiResponse<{ path: string }>>(`${base(accountId)}/mkdir`, { path });
    return res.data.data!.path;
  },

  async remove(accountId: number, paths: string[]): Promise<FileOpResult[]> {
    const res = await apiClient.post<ApiResponse<FileOpResult[]>>(`${base(accountId)}/delete`, { paths });
    return res.data.data ?? [];
  },

  async move(accountId: number, items: FileMoveItem[], overwrite = false): Promise<FileOpResult[]> {
    const res = await apiClient.post<ApiResponse<FileOpResult[]>>(`${base(accountId)}/move`, { items, overwrite });
    return res.data.data ?? [];
  },

  async copy(accountId: number, items: FileMoveItem[]): Promise<FileOpResult[]> {
    const res = await apiClient.post<ApiResponse<FileOpResult[]>>(`${base(accountId)}/copy`, { items });
    return res.data.data ?? [];
  },

  async uploadStart(accountId: number, req: FileUploadRequest, signal?: AbortSignal): Promise<FileUploadSession> {
    const res = await apiClient.post<ApiResponse<FileUploadSession>>(`${base(accountId)}/uploads`, req, { signal });
    return res.data.data!;
  },

  async uploadStatus(accountId: number, id: string): Promise<FileUploadStatus> {
    const res = await apiClient.get<ApiResponse<FileUploadStatus>>(`${base(accountId)}/uploads/${id}`);
    return res.data.data!;
  },

  async uploadChunk(accountId: number, id: string, index: number, blob: Blob, onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<FileUploadChunkResult> {
    const res = await apiClient.put<ApiResponse<FileUploadChunkResult>>(`${base(accountId)}/uploads/${id}/${index}`, blob, {
      headers: { 'Content-Type': 'application/octet-stream' },
      onUploadProgress: (e) => onProgress?.(e.loaded),
      signal,
      timeout: 0,
    });
    return res.data.data!;
  },

  async uploadAbort(accountId: number, id: string): Promise<void> {
    await apiClient.delete(`${base(accountId)}/uploads/${id}`);
  },

  /** Saves a file through the browser (a link, or a blob inside ObliTools where cookies are blocked). */
  async download(accountId: number, path: string): Promise<void> {
    const name = path.split('/').pop() || 'download';
    if (isInObliTools) {
      const res = await apiClient.get<Blob>(`${base(accountId)}/download`, { params: { path }, responseType: 'blob', timeout: 0 });
      const url = URL.createObjectURL(res.data);
      try { clickLink(url, name); } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      return;
    }
    clickLink(fileContentUrl(accountId, path), name);
  },
};

function clickLink(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Writes a small content (editor save, new empty file) through the chunked
 * upload API, chunk after chunk. expectedMtime: refused (409 fileChanged)
 * when the file changed since it was read.
 */
export async function writeFileContent(accountId: number, path: string, blob: Blob, opts: { overwrite?: boolean; expectedMtime?: number } = {}): Promise<void> {
  const s = await filesApi.uploadStart(accountId, { path, size: blob.size, ...opts });
  for (let i = 0; i < s.count; i++) {
    await filesApi.uploadChunk(accountId, s.id, i, blob.slice(i * s.chunkSize, Math.min(blob.size, (i + 1) * s.chunkSize)));
  }
}
