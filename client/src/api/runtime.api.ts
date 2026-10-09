import apiClient from './client';
import type { ApiResponse, RuntimeSwitchCheck, RuntimeSwitchRequest, SiteBaseId, SiteRuntimeStatus } from '@oblimint/shared';

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

  async restart(siteId: number): Promise<SiteRuntimeStatus> {
    const res = await apiClient.post<ApiResponse<SiteRuntimeStatus>>(`/sites/${siteId}/runtime/restart`);
    return res.data.data!;
  },
};
