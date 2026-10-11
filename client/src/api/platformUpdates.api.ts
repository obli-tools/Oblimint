import apiClient from './client';
import type {
  ApiResponse, PlatformUpdatePolicy, PlatformUpdateRequest, PlatformUpdateRun, PlatformUpdatesState, PlatformUpdatesSummary,
} from '@oblimint/shared';

// /api/system/updates — platform updates of a node (Nodes > Updates).
// Platform administrator on the master tenant only.
export const platformUpdatesApi = {
  async state(nodeId?: number): Promise<PlatformUpdatesState> {
    const res = await apiClient.get<ApiResponse<PlatformUpdatesState>>('/system/updates', { params: nodeId ? { nodeId } : {} });
    return res.data.data!;
  },

  async summary(nodeId?: number): Promise<PlatformUpdatesSummary> {
    const res = await apiClient.get<ApiResponse<PlatformUpdatesSummary>>('/system/updates/summary', { params: nodeId ? { nodeId } : {} });
    return res.data.data!;
  },

  async check(nodeId?: number, images?: string[]): Promise<PlatformUpdatesState> {
    const res = await apiClient.post<ApiResponse<PlatformUpdatesState>>('/system/updates/check', { nodeId, images });
    return res.data.data!;
  },

  async apply(body: PlatformUpdateRequest & { nodeId?: number; force?: boolean }): Promise<PlatformUpdateRun> {
    const res = await apiClient.post<ApiResponse<PlatformUpdateRun>>('/system/updates/apply', body);
    return res.data.data!;
  },

  async setPolicy(policy: Partial<PlatformUpdatePolicy>): Promise<PlatformUpdatePolicy> {
    const res = await apiClient.put<ApiResponse<PlatformUpdatePolicy>>('/system/updates/policy', policy);
    return res.data.data!;
  },
};
