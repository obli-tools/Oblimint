import apiClient from './client';
import type {
  AccountUsage, ApiResponse, NotificationChannel, NotificationChannelInput, NotificationTestResult, PlatformUsage, SiteUsage,
  TenantUsage, UsageAlert,
} from '@oblimint/shared';

// /api/usage + /api/notifications — docs/P2-PLAN.md §6.5.
// OWNED BY MODULE `ui-ops` (posed by the architect: complete thin wrappers of the server contract).
export const usageApi = {
  async account(accountId: number, month?: string): Promise<AccountUsage> {
    const res = await apiClient.get<ApiResponse<AccountUsage>>(`/usage/accounts/${accountId}`, { params: { month } });
    return res.data.data!;
  },
  async site(siteId: number, days?: number): Promise<SiteUsage> {
    const res = await apiClient.get<ApiResponse<SiteUsage>>(`/usage/sites/${siteId}`, { params: { days } });
    return res.data.data!;
  },
  async tenant(params: { tenantId?: number; month?: string } = {}): Promise<TenantUsage> {
    const res = await apiClient.get<ApiResponse<TenantUsage>>('/usage/tenant', { params });
    return res.data.data!;
  },
  async platform(month?: string): Promise<PlatformUsage> {
    const res = await apiClient.get<ApiResponse<PlatformUsage>>('/usage/platform', { params: { month } });
    return res.data.data!;
  },
  async alerts(params: { accountId?: number; open?: boolean } = {}): Promise<UsageAlert[]> {
    const res = await apiClient.get<ApiResponse<UsageAlert[]>>('/usage/alerts', { params: { accountId: params.accountId, open: params.open ? 1 : undefined } });
    return res.data.data ?? [];
  },
};

export const notificationsApi = {
  async list(): Promise<NotificationChannel[]> {
    const res = await apiClient.get<ApiResponse<NotificationChannel[]>>('/notifications/channels');
    return res.data.data ?? [];
  },
  async create(data: NotificationChannelInput): Promise<NotificationChannel> {
    const res = await apiClient.post<ApiResponse<NotificationChannel>>('/notifications/channels', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<NotificationChannelInput>): Promise<NotificationChannel> {
    const res = await apiClient.put<ApiResponse<NotificationChannel>>(`/notifications/channels/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/notifications/channels/${id}`);
  },
  async test(id: number): Promise<NotificationTestResult> {
    const res = await apiClient.post<ApiResponse<NotificationTestResult>>(`/notifications/channels/${id}/test`);
    return res.data.data!;
  },
};
