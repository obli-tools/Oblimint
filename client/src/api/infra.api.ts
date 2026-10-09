import apiClient from './client';
import type { ApiResponse, EdgeStatus, EdgeSyncResult, InfraComponentId, InfraStatus } from '@oblimint/shared';

// /api/system/infra + /api/system/edge (platform admin) — docs/P1-PLAN.md §API.
// OWNED BY MODULE `ui-hosting` (Nodes page).
export const infraApi = {
  async status(): Promise<InfraStatus> {
    const res = await apiClient.get<ApiResponse<InfraStatus>>('/system/infra');
    return res.data.data!;
  },

  async deploy(component: InfraComponentId): Promise<InfraStatus> {
    const res = await apiClient.post<ApiResponse<InfraStatus>>(`/system/infra/${component}/deploy`);
    return res.data.data!;
  },

  async reconcile(): Promise<void> {
    await apiClient.post('/system/infra/reconcile');
  },

  async edgeStatus(): Promise<EdgeStatus> {
    const res = await apiClient.get<ApiResponse<EdgeStatus>>('/system/edge');
    return res.data.data!;
  },

  async edgeSync(): Promise<EdgeSyncResult> {
    const res = await apiClient.post<ApiResponse<EdgeSyncResult>>('/system/edge/sync');
    return res.data.data!;
  },

  async setAcmeDirectory(acmeDirectory: 'production' | 'staging'): Promise<EdgeStatus> {
    const res = await apiClient.put<ApiResponse<EdgeStatus>>('/system/edge/settings', { acmeDirectory });
    return res.data.data!;
  },
};
