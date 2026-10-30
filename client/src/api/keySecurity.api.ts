import apiClient from './client';
import type { ApiResponse, KeySecuritySettings, KeySecuritySettingsUpdate, KeySecurityStatus } from '@oblimint/shared';

// IP security of the access keys / MCP: /api/system/key-security (platform admin, master workspace).
export const keySecurityApi = {
  async get(): Promise<KeySecuritySettings> {
    return (await apiClient.get<ApiResponse<KeySecuritySettings>>('/system/key-security')).data.data!;
  },
  async update(patch: KeySecuritySettingsUpdate): Promise<KeySecuritySettings> {
    return (await apiClient.put<ApiResponse<KeySecuritySettings>>('/system/key-security', patch)).data.data!;
  },
  async status(): Promise<KeySecurityStatus> {
    return (await apiClient.get<ApiResponse<KeySecurityStatus>>('/system/key-security/status')).data.data!;
  },
  /** Adds the address to the trusted IPs and lifts its platform bans. */
  async trust(ip: string): Promise<{ settings: KeySecuritySettings; liftedBans: number[] }> {
    return (await apiClient.post<ApiResponse<{ settings: KeySecuritySettings; liftedBans: number[] }>>('/system/key-security/trust', { ip })).data.data!;
  },
};
