import apiClient from './client';
import type { ApiResponse, HealthMonitorSettings, HealthMonitorTokenResult } from '@oblimint/shared';

// Deep health token + outbound heartbeat: /api/system/health-monitor (platform admin, master workspace).
export const healthMonitorApi = {
  async get(): Promise<HealthMonitorSettings> {
    return (await apiClient.get<ApiResponse<HealthMonitorSettings>>('/system/health-monitor')).data.data!;
  },
  async setHeartbeat(heartbeatUrl: string | null): Promise<HealthMonitorSettings> {
    return (await apiClient.put<ApiResponse<HealthMonitorSettings>>('/system/health-monitor', { heartbeatUrl })).data.data!;
  },
  async createToken(): Promise<HealthMonitorTokenResult> {
    return (await apiClient.post<ApiResponse<HealthMonitorTokenResult>>('/system/health-monitor/token')).data.data!;
  },
  async revokeToken(): Promise<HealthMonitorSettings> {
    return (await apiClient.delete<ApiResponse<HealthMonitorSettings>>('/system/health-monitor/token')).data.data!;
  },
  async test(): Promise<HealthMonitorSettings> {
    return (await apiClient.post<ApiResponse<HealthMonitorSettings>>('/system/health-monitor/test')).data.data!;
  },
};
