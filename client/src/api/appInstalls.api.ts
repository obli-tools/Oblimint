import apiClient from './client';
import type { ApiResponse, AppInstall, AppInstallRetryResult, AppInstallStartRequest, AppInstallStartResult, AppInstallStatus } from '@oblimint/shared';

// /api/app-installs — immutable application installer (shared/src/appInstall.ts).
export const appInstallsApi = {
  async list(params: { accountId?: number; status?: AppInstallStatus[] } = {}): Promise<AppInstall[]> {
    const res = await apiClient.get<ApiResponse<AppInstall[]>>('/app-installs', {
      params: { ...(params.accountId ? { accountId: params.accountId } : {}), ...(params.status?.length ? { status: params.status.join(',') } : {}) },
    });
    return res.data.data ?? [];
  },

  async get(id: number): Promise<AppInstall> {
    const res = await apiClient.get<ApiResponse<AppInstall>>(`/app-installs/${id}`);
    return res.data.data!;
  },

  /** The answer holds the admin password: shown once, kept in no store. */
  async start(data: AppInstallStartRequest): Promise<AppInstallStartResult> {
    const res = await apiClient.post<ApiResponse<AppInstallStartResult>>('/app-installs', data);
    return res.data.data!;
  },

  async retry(id: number): Promise<AppInstallRetryResult> {
    const res = await apiClient.post<ApiResponse<AppInstallRetryResult>>(`/app-installs/${id}/retry`);
    return res.data.data!;
  },

  async publish(id: number): Promise<AppInstall> {
    const res = await apiClient.post<ApiResponse<AppInstall>>(`/app-installs/${id}/publish`);
    return res.data.data!;
  },

  async cleanup(id: number): Promise<AppInstall> {
    const res = await apiClient.post<ApiResponse<AppInstall>>(`/app-installs/${id}/cleanup`);
    return res.data.data!;
  },
};
