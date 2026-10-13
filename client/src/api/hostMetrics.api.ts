import apiClient from './client';
import type { ApiResponse, HostMetrics } from '@oblimint/shared';

/** GET /api/system/host-metrics — CPU / RAM / disk of the local node (platform admin). */
export const hostMetricsApi = {
  async get(): Promise<HostMetrics> {
    const res = await apiClient.get<ApiResponse<HostMetrics>>('/system/host-metrics');
    return res.data.data!;
  },
};
