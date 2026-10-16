import apiClient from './client';
import type {
  ApiResponse, BackupDestination, BackupDestinationInput, BackupRestoreItem, BackupRestoreResult, BackupRun, BackupSettings, BackupSettingsUpdate,
} from '@oblimint/shared';

// External backups: /api/system/backups (platform admin) and /api/accounts/:id/backups.
export const backupsApi = {
  async settings(): Promise<BackupSettings> {
    return (await apiClient.get<ApiResponse<BackupSettings>>('/system/backups/settings')).data.data!;
  },
  async updateSettings(body: BackupSettingsUpdate): Promise<BackupSettings> {
    return (await apiClient.put<ApiResponse<BackupSettings>>('/system/backups/settings', body)).data.data!;
  },
  async destinations(): Promise<BackupDestination[]> {
    return (await apiClient.get<ApiResponse<BackupDestination[]>>('/system/backups/destinations')).data.data ?? [];
  },
  async saveDestination(id: number | null, body: BackupDestinationInput): Promise<BackupDestination> {
    const res = id === null
      ? await apiClient.post<ApiResponse<BackupDestination>>('/system/backups/destinations', body)
      : await apiClient.put<ApiResponse<BackupDestination>>(`/system/backups/destinations/${id}`, body);
    return res.data.data!;
  },
  async removeDestination(id: number): Promise<void> {
    await apiClient.delete(`/system/backups/destinations/${id}`);
  },
  async testDestination(id: number): Promise<BackupDestination> {
    return (await apiClient.post<ApiResponse<BackupDestination>>(`/system/backups/destinations/${id}/test`)).data.data!;
  },
  async runs(scope?: 'account' | 'panel'): Promise<BackupRun[]> {
    return (await apiClient.get<ApiResponse<BackupRun[]>>('/system/backups/runs', { params: scope ? { scope } : {} })).data.data ?? [];
  },
  async runPanel(): Promise<{ runId: number }> {
    return (await apiClient.post<ApiResponse<{ runId: number }>>('/system/backups/panel/run')).data.data!;
  },

  async account(accountId: number): Promise<{ runs: BackupRun[]; enabled: boolean; scheduled: boolean }> {
    return (await apiClient.get<ApiResponse<{ runs: BackupRun[]; enabled: boolean; scheduled: boolean }>>(`/accounts/${accountId}/backups`)).data.data!;
  },
  async runAccount(accountId: number): Promise<{ runId: number }> {
    return (await apiClient.post<ApiResponse<{ runId: number }>>(`/accounts/${accountId}/backups/run`)).data.data!;
  },
  async setAccountEnabled(accountId: number, enabled: boolean): Promise<void> {
    await apiClient.put(`/accounts/${accountId}/backups/enabled`, { enabled });
  },
  async restore(accountId: number, runId: number, items: BackupRestoreItem[]): Promise<BackupRestoreResult> {
    return (await apiClient.post<ApiResponse<BackupRestoreResult>>(`/accounts/${accountId}/backups/${runId}/restore`, { items }, { timeout: 0 })).data.data!;
  },
};
