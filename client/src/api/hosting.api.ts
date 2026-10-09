import apiClient from './client';
import type { ApiResponse, HostingMe } from '@oblimint/shared';

// GET /api/hosting/me — what the caller may do in the hosting area
// (docs/P1-PLAN.md §API). Shared by the hosting and sites UI modules.
export const hostingApi = {
  async me(): Promise<HostingMe> {
    const res = await apiClient.get<ApiResponse<HostingMe>>('/hosting/me');
    return res.data.data!;
  },
};
