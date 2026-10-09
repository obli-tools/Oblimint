import apiClient from './client';
import type {
  ApiResponse, ApproveRequest, ProfileDetection, PublishRequest, Release, ReleaseDetail, ReleaseDiff, Site, StagingStatus,
} from '@oblimint/shared';

// /api/sites/:id/releases + /staging — docs/P1-PLAN.md §API. OWNED BY MODULE `ui-sites`
// (P3: `ui-maintenance` — approval with a staff override of a blocked scan, docs/P3-PLAN.md §6.2).
export const releasesApi = {
  async list(siteId: number, params: { limit?: number; offset?: number } = {}): Promise<{ items: Release[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: Release[]; total: number }>>(`/sites/${siteId}/releases`, { params });
    return res.data.data ?? { items: [], total: 0 };
  },

  async get(siteId: number, releaseId: number): Promise<ReleaseDetail> {
    const res = await apiClient.get<ApiResponse<ReleaseDetail>>(`/sites/${siteId}/releases/${releaseId}`);
    return res.data.data!;
  },

  async publish(siteId: number, data: PublishRequest = {}): Promise<Release> {
    const res = await apiClient.post<ApiResponse<Release>>(`/sites/${siteId}/releases`, data);
    return res.data.data!;
  },

  /** against: a release id, 'previous' (default) or 'empty'; file: load one file's full patch. */
  async diff(siteId: number, releaseId: number, against: number | 'previous' | 'empty' = 'previous', file?: string): Promise<ReleaseDiff> {
    const res = await apiClient.get<ApiResponse<ReleaseDiff>>(`/sites/${siteId}/releases/${releaseId}/diff`, {
      params: { against, ...(file ? { file } : {}) },
    });
    return res.data.data!;
  },

  async rollback(siteId: number, releaseId: number): Promise<Site> {
    const res = await apiClient.post<ApiResponse<Site>>(`/sites/${siteId}/releases/${releaseId}/rollback`);
    return res.data.data!;
  },

  /** P3: `{ override: true, reason }` = staff override of a blocked scan (audited; 403 overrideForbidden otherwise). */
  async approve(siteId: number, releaseId: number, data: ApproveRequest = {}): Promise<Release> {
    const res = await apiClient.post<ApiResponse<Release>>(`/sites/${siteId}/releases/${releaseId}/approve`, data);
    return res.data.data!;
  },

  async reject(siteId: number, releaseId: number, reason?: string): Promise<Release> {
    const res = await apiClient.post<ApiResponse<Release>>(`/sites/${siteId}/releases/${releaseId}/reject`, { reason: reason ?? null });
    return res.data.data!;
  },

  async staging(siteId: number): Promise<StagingStatus> {
    const res = await apiClient.get<ApiResponse<StagingStatus>>(`/sites/${siteId}/staging`);
    return res.data.data!;
  },

  async detectProfile(siteId: number): Promise<ProfileDetection> {
    const res = await apiClient.get<ApiResponse<ProfileDetection>>(`/sites/${siteId}/staging/detect`);
    return res.data.data!;
  },
};
