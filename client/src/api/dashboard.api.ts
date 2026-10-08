import apiClient from './client';
import type { ApiResponse, DashboardSummary, PanelNode } from '@oblimint/shared';

export const dashboardApi = {
  async summary(): Promise<DashboardSummary> {
    const res = await apiClient.get<ApiResponse<DashboardSummary>>('/dashboard/summary');
    return res.data.data!;
  },
};

export const nodesApi = {
  async list(): Promise<PanelNode[]> {
    const res = await apiClient.get<ApiResponse<PanelNode[]>>('/nodes');
    return res.data.data ?? [];
  },
};
