import apiClient from './client';
import type {
  ApiResponse, PreviewFetchResult, PreviewLink, PreviewStartRequest, PreviewStartResult, SitePreview,
} from '@oblimint/shared';

// /api/sites/:id/preview* — feature B (release / staging previews).
export const previewsApi = {
  async get(siteId: number): Promise<SitePreview | null> {
    const res = await apiClient.get<ApiResponse<SitePreview | null>>(`/sites/${siteId}/preview`);
    return res.data.data ?? null;
  },

  async history(siteId: number, limit = 20): Promise<SitePreview[]> {
    const res = await apiClient.get<ApiResponse<SitePreview[]>>(`/sites/${siteId}/previews`, { params: { limit } });
    return res.data.data ?? [];
  },

  async start(siteId: number, data: PreviewStartRequest): Promise<PreviewStartResult> {
    const res = await apiClient.post<ApiResponse<PreviewStartResult>>(`/sites/${siteId}/preview`, data);
    return res.data.data!;
  },

  async shareLink(siteId: number): Promise<PreviewLink> {
    const res = await apiClient.post<ApiResponse<PreviewLink>>(`/sites/${siteId}/preview/link`);
    return res.data.data!;
  },

  async extend(siteId: number, ttlMinutes: number): Promise<SitePreview> {
    const res = await apiClient.post<ApiResponse<SitePreview>>(`/sites/${siteId}/preview/extend`, { ttlMinutes });
    return res.data.data!;
  },

  async stop(siteId: number): Promise<void> {
    await apiClient.delete(`/sites/${siteId}/preview`);
  },

  async fetch(siteId: number, q: { path: string; compare?: boolean; host?: 'preview' | 'live'; maxBytes?: number; method?: 'GET' | 'HEAD' }): Promise<PreviewFetchResult> {
    const res = await apiClient.get<ApiResponse<PreviewFetchResult>>(`/sites/${siteId}/preview/fetch`, {
      params: { path: q.path, ...(q.compare ? { compare: '1' } : {}), ...(q.host ? { host: q.host } : {}), ...(q.maxBytes ? { maxBytes: q.maxBytes } : {}), ...(q.method ? { method: q.method } : {}) },
    });
    return res.data.data!;
  },

  /**
   * "Open": the panel answers 302 to a 60 s claim link on the preview host,
   * which sets the gate cookie. Opened with window.open (synchronous: never
   * blocked as a pop-up), never in an iframe.
   */
  openUrl(siteId: number): string {
    return `/api/sites/${siteId}/preview/open`;
  },
};
