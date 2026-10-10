import apiClient from './client';
import type {
  ApiResponse, NetworkFlowView, NetworkLink, NetworkLinkCreate, NetworkLinkUpdate, NetworkMigrateRequest, NetworkSegmentInfo,
  NetworkSystemStatus,
} from '@oblimint/shared';

// /api/network (segments, links) + /api/system/network (platform admin: status, sync,
// migration, flows) — docs/P4b-PLAN.md §6.2, contract in the header of
// server/src/routes/network.routes.ts. OWNED BY MODULE `ui-apps`.

export const networkApi = {
  async segments(accountId: number): Promise<NetworkSegmentInfo[]> {
    const res = await apiClient.get<ApiResponse<NetworkSegmentInfo[]>>('/network/segments', { params: { accountId } });
    return res.data.data ?? [];
  },
  async listLinks(params: { accountId?: number; tenantId?: number } = {}): Promise<NetworkLink[]> {
    const res = await apiClient.get<ApiResponse<NetworkLink[]>>('/network/links', { params });
    return res.data.data ?? [];
  },
  async createLink(data: NetworkLinkCreate): Promise<NetworkLink> {
    const res = await apiClient.post<ApiResponse<NetworkLink>>('/network/links', data);
    return res.data.data!;
  },
  async updateLink(id: number, data: NetworkLinkUpdate): Promise<NetworkLink> {
    const res = await apiClient.put<ApiResponse<NetworkLink>>(`/network/links/${id}`, data);
    return res.data.data!;
  },
  async deleteLink(id: number): Promise<void> {
    await apiClient.delete(`/network/links/${id}`);
  },
};

export const systemNetworkApi = {
  async status(): Promise<NetworkSystemStatus> {
    const res = await apiClient.get<ApiResponse<NetworkSystemStatus>>('/system/network');
    return res.data.data!;
  },
  async sync(): Promise<NetworkSystemStatus> {
    const res = await apiClient.post<ApiResponse<NetworkSystemStatus>>('/system/network/sync');
    return res.data.data!;
  },
  async migrate(data: NetworkMigrateRequest = {}): Promise<NetworkSystemStatus> {
    const res = await apiClient.post<ApiResponse<NetworkSystemStatus>>('/system/network/migrate', data);
    return res.data.data!;
  },
  async flows(accountId?: number): Promise<NetworkFlowView[]> {
    const res = await apiClient.get<ApiResponse<NetworkFlowView[]>>('/system/network/flows', { params: { accountId } });
    return res.data.data ?? [];
  },
};
