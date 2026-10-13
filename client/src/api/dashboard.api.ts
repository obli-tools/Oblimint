import apiClient from './client';
import type { ApiResponse, DashboardOverview, DashboardSummary, PanelNode } from '@oblimint/shared';

export const dashboardApi = {
  async overview(): Promise<DashboardOverview> {
    const res = await apiClient.get<ApiResponse<DashboardOverview>>('/dashboard/overview');
    return res.data.data!;
  },

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
