import apiClient from './client';
import type {
  AccountPortsInfo, ApiResponse, DedicatedIpAssign, NetInterface, PortAllocationPreview, PortAllocationRequest, PortBinding, PortPoolStatus, PublicIp,
  PublicIpCreate, PublicIpUpdate, PublishStatus,
} from '@oblimint/shared';

// Public ports + dedicated IPs (migration 032) — contract in the header of server/src/routes/publicPorts.routes.ts.

export const publicPortsApi = {
  async account(accountId: number): Promise<AccountPortsInfo> {
    const res = await apiClient.get<ApiResponse<AccountPortsInfo>>(`/accounts/${accountId}/network/ports`);
    return res.data.data!;
  },
  async setAllocation(accountId: number, body: PortAllocationRequest): Promise<AccountPortsInfo> {
    const res = await apiClient.put<ApiResponse<AccountPortsInfo>>(`/accounts/${accountId}/network/ports`, body);
    return res.data.data!;
  },
  async preview(accountId: number, body: PortAllocationRequest): Promise<PortAllocationPreview> {
    const res = await apiClient.post<ApiResponse<PortAllocationPreview>>(`/accounts/${accountId}/network/ports/preview`, body);
    return res.data.data!;
  },
  async setDedicatedIp(accountId: number, body: DedicatedIpAssign): Promise<PublicIp | null> {
    const res = await apiClient.put<ApiResponse<PublicIp | null>>(`/accounts/${accountId}/network/dedicated-ip`, body);
    return res.data.data ?? null;
  },
  async stackBindings(stackId: number): Promise<PortBinding[]> {
    const res = await apiClient.get<ApiResponse<PortBinding[]>>(`/apps/stacks/${stackId}/bindings`);
    return res.data.data ?? [];
  },
};

export const systemPublicPortsApi = {
  async pool(): Promise<PortPoolStatus> {
    const res = await apiClient.get<ApiResponse<PortPoolStatus>>('/system/network/ports');
    return res.data.data!;
  },
  async list(): Promise<PublicIp[]> {
    const res = await apiClient.get<ApiResponse<PublicIp[]>>('/system/network/public-ips');
    return res.data.data ?? [];
  },
  async create(body: PublicIpCreate): Promise<PublicIp> {
    const res = await apiClient.post<ApiResponse<PublicIp>>('/system/network/public-ips', body);
    return res.data.data!;
  },
  async update(id: number, body: PublicIpUpdate): Promise<PublicIp> {
    const res = await apiClient.patch<ApiResponse<PublicIp>>(`/system/network/public-ips/${id}`, body);
    return res.data.data!;
  },
  async remove(id: number): Promise<void> {
    await apiClient.delete(`/system/network/public-ips/${id}`);
  },
  async check(id: number): Promise<PublicIp> {
    const res = await apiClient.post<ApiResponse<PublicIp>>(`/system/network/public-ips/${id}/check`);
    return res.data.data!;
  },
  async interfaces(): Promise<NetInterface[]> {
    const res = await apiClient.get<ApiResponse<NetInterface[]>>('/system/network/interfaces');
    return res.data.data ?? [];
  },
  async publish(): Promise<PublishStatus> {
    const res = await apiClient.get<ApiResponse<PublishStatus>>('/system/network/publish');
    return res.data.data!;
  },
};

/** "20000–20009" */
export const fmtPortRange = (r: { from: number; to: number }): string => (r.from === r.to ? String(r.from) : `${r.from}–${r.to}`);
