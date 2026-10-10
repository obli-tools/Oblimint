import apiClient from './client';
import type {
  ApiResponse, PublicStatusPage, StatusPage, StatusPageInput, StatusPageUpdate, UptimeCheckPoint, UptimeMonitor, UptimeMonitorInput,
  UptimeMonitorUpdate, UptimeStatus,
} from '@oblimint/shared';

// /api/uptime (monitors, status pages) + /api/public/status-pages/:slug (no session) —
// docs/P4b-PLAN.md §6.6 / §10, contracts in the headers of
// server/src/routes/{uptime,publicStatus}.routes.ts. OWNED BY MODULE `ui-apps`.

export type UptimeRange = '24h' | '7d' | '30d';

export interface UptimeListParams {
  accountId?: number;
  tenantId?: number;
}

export const uptimeApi = {
  // ── monitors ──
  async listMonitors(params: UptimeListParams & { status?: UptimeStatus } = {}): Promise<UptimeMonitor[]> {
    const res = await apiClient.get<ApiResponse<UptimeMonitor[]>>('/uptime/monitors', { params });
    return res.data.data ?? [];
  },
  async getMonitor(id: number): Promise<UptimeMonitor> {
    const res = await apiClient.get<ApiResponse<UptimeMonitor>>(`/uptime/monitors/${id}`);
    return res.data.data!;
  },
  async createMonitor(data: UptimeMonitorInput): Promise<UptimeMonitor> {
    const res = await apiClient.post<ApiResponse<UptimeMonitor>>('/uptime/monitors', data);
    return res.data.data!;
  },
  async updateMonitor(id: number, data: UptimeMonitorUpdate): Promise<UptimeMonitor> {
    const res = await apiClient.put<ApiResponse<UptimeMonitor>>(`/uptime/monitors/${id}`, data);
    return res.data.data!;
  },
  async deleteMonitor(id: number): Promise<void> {
    await apiClient.delete(`/uptime/monitors/${id}`);
  },
  async checks(id: number, range: UptimeRange = '24h'): Promise<UptimeCheckPoint[]> {
    const res = await apiClient.get<ApiResponse<UptimeCheckPoint[]>>(`/uptime/monitors/${id}/checks`, { params: { range } });
    return res.data.data ?? [];
  },
  async checkNow(id: number): Promise<UptimeCheckPoint> {
    const res = await apiClient.post<ApiResponse<UptimeCheckPoint>>(`/uptime/monitors/${id}/check-now`);
    return res.data.data!;
  },
  async syncProxyHosts(accountId: number): Promise<{ created: number; removed: number }> {
    const res = await apiClient.post<ApiResponse<{ created: number; removed: number }>>('/uptime/sync-proxy-hosts', { accountId });
    return res.data.data ?? { created: 0, removed: 0 };
  },

  // ── status pages ──
  async listStatusPages(params: UptimeListParams = {}): Promise<StatusPage[]> {
    const res = await apiClient.get<ApiResponse<StatusPage[]>>('/uptime/status-pages', { params });
    return res.data.data ?? [];
  },
  async getStatusPage(id: number): Promise<StatusPage> {
    const res = await apiClient.get<ApiResponse<StatusPage>>(`/uptime/status-pages/${id}`);
    return res.data.data!;
  },
  async createStatusPage(data: StatusPageInput): Promise<StatusPage> {
    const res = await apiClient.post<ApiResponse<StatusPage>>('/uptime/status-pages', data);
    return res.data.data!;
  },
  async updateStatusPage(id: number, data: StatusPageUpdate): Promise<StatusPage> {
    const res = await apiClient.put<ApiResponse<StatusPage>>(`/uptime/status-pages/${id}`, data);
    return res.data.data!;
  },
  async deleteStatusPage(id: number): Promise<void> {
    await apiClient.delete(`/uptime/status-pages/${id}`);
  },
};

/** Public status page (no session: sent without credentials). 404 = unknown / unpublished. */
export const publicStatusApi = {
  async get(slug: string): Promise<PublicStatusPage> {
    const res = await apiClient.get<ApiResponse<PublicStatusPage>>(`/public/status-pages/${encodeURIComponent(slug)}`, { withCredentials: false });
    return res.data.data!;
  },
};
