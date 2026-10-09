import apiClient from './client';
import type { ApiResponse, AppConfigData, HostingSettings, HostingSettingsUpdate } from '@oblimint/shared';

// /api/system/hosting-settings — docs/P2-PLAN.md §6.9 (platform admin).
// OWNED BY MODULE `ui-ops` (posed by the architect: complete thin wrapper of the server contract).
export const hostingSettingsApi = {
  async get(): Promise<HostingSettings> {
    const res = await apiClient.get<ApiResponse<HostingSettings>>('/system/hosting-settings');
    return res.data.data!;
  },
  async update(patch: HostingSettingsUpdate): Promise<HostingSettings> {
    const res = await apiClient.put<ApiResponse<HostingSettings>>('/system/hosting-settings', patch);
    return res.data.data!;
  },
  /** Panel identity from the setup wizard (host name, public IPs): GET /api/admin/config (P0). */
  async panelConfig(): Promise<AppConfigData> {
    const res = await apiClient.get<ApiResponse<AppConfigData>>('/admin/config');
    return res.data.data!;
  },
};
