import apiClient from './client';
import type {
  ApiResponse, CronJob, CronJobInput, CronRun, CronRunDetail, LogFileInfo, LogQueryResult, LogSource,
} from '@oblimint/shared';

// /api/sites/:id/cron + /api/sites/:id/logs — docs/P2-PLAN.md §6.6–§6.7.
// OWNED BY MODULE `ui-ops` (posed by the architect: complete thin wrappers of the server contract).
// Live tail: socket 'logs:subscribe' / 'LOG_LINES' (LogSocketEvents, @oblimint/shared).
export const cronApi = {
  async list(siteId: number): Promise<CronJob[]> {
    const res = await apiClient.get<ApiResponse<CronJob[]>>(`/sites/${siteId}/cron`);
    return res.data.data ?? [];
  },
  async create(siteId: number, data: CronJobInput): Promise<CronJob> {
    const res = await apiClient.post<ApiResponse<CronJob>>(`/sites/${siteId}/cron`, data);
    return res.data.data!;
  },
  async update(siteId: number, jobId: number, data: Partial<CronJobInput>): Promise<CronJob> {
    const res = await apiClient.put<ApiResponse<CronJob>>(`/sites/${siteId}/cron/${jobId}`, data);
    return res.data.data!;
  },
  async delete(siteId: number, jobId: number): Promise<void> {
    await apiClient.delete(`/sites/${siteId}/cron/${jobId}`);
  },
  async runNow(siteId: number, jobId: number): Promise<CronRun> {
    const res = await apiClient.post<ApiResponse<CronRun>>(`/sites/${siteId}/cron/${jobId}/run`);
    return res.data.data!;
  },
  async runs(siteId: number, jobId: number, params: { limit?: number; offset?: number } = {}): Promise<{ items: CronRun[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: CronRun[]; total: number }>>(`/sites/${siteId}/cron/${jobId}/runs`, { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async run(siteId: number, runId: number): Promise<CronRunDetail> {
    const res = await apiClient.get<ApiResponse<CronRunDetail>>(`/sites/${siteId}/cron/runs/${runId}`);
    return res.data.data!;
  },
};

export const logsApi = {
  async query(siteId: number, params: { source: LogSource; since?: string; until?: string; q?: string; status?: string; limit?: number }): Promise<LogQueryResult> {
    const res = await apiClient.get<ApiResponse<LogQueryResult>>(`/sites/${siteId}/logs`, { params });
    return res.data.data!;
  },
  async files(siteId: number): Promise<LogFileInfo[]> {
    const res = await apiClient.get<ApiResponse<LogFileInfo[]>>(`/sites/${siteId}/logs/files`);
    return res.data.data ?? [];
  },
  /** Same-origin download URL (GET, session cookie): use utils/download.downloadUrl. */
  downloadUrl(siteId: number, source: LogSource, date?: string): string {
    const q = new URLSearchParams({ source, ...(date ? { date } : {}) });
    return `/api/sites/${siteId}/logs/download?${q}`;
  },
  /**
   * Same route fetched as a Blob (browser): the route answers JSON errors
   * (409 siteNotRunning, 429 rateLimited, 502, 404) that a plain anchor
   * download would hide or save as the file. The JSON error body is parsed
   * back so the usual error mapping applies.
   */
  async downloadBlob(siteId: number, source: LogSource, date?: string): Promise<Blob> {
    try {
      const res = await apiClient.get<Blob>(`/sites/${siteId}/logs/download`, {
        params: { source, ...(date ? { date } : {}) },
        responseType: 'blob',
      });
      return res.data;
    } catch (err) {
      const resp = (err as { response?: { data?: unknown } } | null)?.response;
      if (resp && resp.data instanceof Blob) {
        try { resp.data = JSON.parse(await resp.data.text()); } catch { resp.data = {}; }
      }
      throw err;
    }
  },
};
