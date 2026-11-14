import apiClient from './client';
import type { ApiResponse, HtaccessAccessReport, RuntimeSwitchCheck, RuntimeSwitchRequest, SiteBaseId, SiteCachePurgeResult, SiteRuntimeStatus } from '@oblimint/shared';

// /api/sites/:id/runtime — docs/P1-PLAN.md §API. OWNED BY MODULE `ui-sites`.
export const runtimeApi = {
  async status(siteId: number): Promise<SiteRuntimeStatus> {
    const res = await apiClient.get<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime`);
    return res.data.data!;
  },

  async check(siteId: number, base: SiteBaseId): Promise<RuntimeSwitchCheck> {
    const res = await apiClient.post<ApiResponse<RuntimeSwitchCheck>>(`/sites/${siteId}/runtime/check`, { base });
    return res.data.data!;
  },

  async switchBase(siteId: number, data: RuntimeSwitchRequest): Promise<SiteRuntimeStatus> {
    const res = await apiClient.post<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime/switch`, data);
    return res.data.data!;
  },

  async promotePreview(siteId: number): Promise<SiteRuntimeStatus> {
    const res = await apiClient.post<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime/preview/promote`);
    return res.data.data!;
  },

  async stopPreview(siteId: number): Promise<SiteRuntimeStatus> {
    const res = await apiClient.delete<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime/preview`);
    return res.data.data!;
  },

  /** LSCache (litespeed bases): empties the page cache of the site. */
  async purgeCache(siteId: number): Promise<SiteCachePurgeResult> {
    const res = await apiClient.post<ApiResponse<SiteCachePurgeResult>>(`/sites/${siteId}/runtime/cache/purge`);
    return res.data.data!;
  },

  /** litespeed bases: the .htaccess access rules of the live release, as enforced. */
  async htaccessAccess(siteId: number): Promise<HtaccessAccessReport> {
    const res = await apiClient.get<ApiResponse<HtaccessAccessReport>>(`/sites/${siteId}/runtime/htaccess-access`);
    return res.data.data!;
  },

  async restart(siteId: number): Promise<SiteRuntimeStatus> {
    const res = await apiClient.post<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime/restart`);
    return res.data.data!;
  },
};
