import apiClient from './client';
import type { ApiResponse, ProxyTrafficOverviewRow, ProxyTrafficRange, ProxyTrafficReport } from '@oblimint/shared';

// /api/monitoring/traffic — docs/P4b-PLAN.md §6.6 / §10.1, contract frozen in
// server/src/routes/monitoring.routes.ts (module monitoring-automation). OWNED
// BY MODULE `ui-proxy`: complete thin typed wrappers of the traffic routes.

export const trafficApi = {
  /** One row per visible proxy host. */
  async overview(params: { accountId?: number; tenantId?: number; range?: ProxyTrafficRange } = {}): Promise<ProxyTrafficOverviewRow[]> {
    const res = await apiClient.get<ApiResponse<ProxyTrafficOverviewRow[]>>('/monitoring/traffic', { params });
    return res.data.data ?? [];
  },
  /** Report of one host; `status` keeps only the 4xx or 5xx samples / tops. */
  async report(proxyHostId: number, params: { range?: ProxyTrafficRange; status?: '4xx' | '5xx' } = {}): Promise<ProxyTrafficReport> {
    const res = await apiClient.get<ApiResponse<ProxyTrafficReport>>(`/monitoring/traffic/${proxyHostId}`, { params });
    return res.data.data!;
  },
};
