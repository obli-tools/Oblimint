import apiClient from './client';
import type {
  AdapterId, AdapterRun, AdapterRunDetail, AdapterRunRequest, AdapterSchedule, AdapterScheduleInput, ApiResponse, DbSnapshot,
  MaintenanceWindow, MaintenanceWindowDetail, MaintenanceWindowListItem, QuarantineItem, QuarantineItemDetail, QuarantineRestoreRequest,
  QuarantineStatus, QuarantineSummary, ScanTestResult, ScannerStatus, SiteAdaptersInfo, SiteApiToken, SiteApiTokenCreate,
  SiteApiTokenCreated, SiteMaintenanceInfo, SiteMaintenanceSettingsUpdate, SupervisionInfo, WindowFile, WindowFileDiff,
  WindowOpenRequest, WindowRejectRequest, WindowValidateRequest,
} from '@oblimint/shared';

// P3 — updates and modification windows (docs/P3-PLAN.md §6). OWNED BY MODULE `ui-maintenance`
// (posed by the architect: complete thin wrappers of the server contract).
// Live updates: socket events WINDOW_UPDATED / ADAPTER_RUN_UPDATED / QUARANTINE_UPDATED (HostingSocketEvents).

type Page<T> = { items: T[]; total: number };
const EMPTY = { items: [], total: 0 };

export const maintenanceApi = {
  async info(siteId: number): Promise<SiteMaintenanceInfo> {
    const res = await apiClient.get<ApiResponse<SiteMaintenanceInfo>>(`/sites/${siteId}/maintenance`);
    return res.data.data!;
  },
  async updateSettings(siteId: number, data: SiteMaintenanceSettingsUpdate): Promise<SiteMaintenanceInfo> {
    const res = await apiClient.put<ApiResponse<SiteMaintenanceInfo>>(`/sites/${siteId}/maintenance`, data);
    return res.data.data!;
  },
  /** Overview across the sites the caller sees (status 'active' = every non-final window). */
  async listAll(params: { status?: string; accountId?: number; tenantId?: number; limit?: number; offset?: number } = {}): Promise<Page<MaintenanceWindowListItem>> {
    const res = await apiClient.get<ApiResponse<Page<MaintenanceWindowListItem>>>('/maintenance/windows', { params });
    return res.data.data ?? EMPTY;
  },
};

export const windowsApi = {
  async list(siteId: number, params: { limit?: number; offset?: number; status?: string } = {}): Promise<Page<MaintenanceWindow>> {
    const res = await apiClient.get<ApiResponse<Page<MaintenanceWindow>>>(`/sites/${siteId}/windows`, { params });
    return res.data.data ?? EMPTY;
  },
  async open(siteId: number, data: WindowOpenRequest): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows`, data);
    return res.data.data!;
  },
  async get(siteId: number, windowId: number): Promise<MaintenanceWindowDetail> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindowDetail>>(`/sites/${siteId}/windows/${windowId}`);
    return res.data.data!;
  },
  async extend(siteId: number, windowId: number, minutes: number): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows/${windowId}/extend`, { minutes });
    return res.data.data!;
  },
  async close(siteId: number, windowId: number): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows/${windowId}/close`);
    return res.data.data!;
  },
  async validate(siteId: number, windowId: number, data: WindowValidateRequest = {}): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows/${windowId}/validate`, data);
    return res.data.data!;
  },
  async reject(siteId: number, windowId: number, data: WindowRejectRequest = {}): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows/${windowId}/reject`, data);
    return res.data.data!;
  },
  async reanalyze(siteId: number, windowId: number): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(`/sites/${siteId}/windows/${windowId}/reanalyze`);
    return res.data.data!;
  },
  async files(siteId: number, windowId: number, params: { change?: string; minRisk?: number; q?: string; limit?: number; offset?: number } = {}): Promise<Page<WindowFile>> {
    const res = await apiClient.get<ApiResponse<Page<WindowFile>>>(`/sites/${siteId}/windows/${windowId}/files`, { params });
    return res.data.data ?? EMPTY;
  },
  async diff(siteId: number, windowId: number, file: string): Promise<WindowFileDiff> {
    const res = await apiClient.get<ApiResponse<WindowFileDiff>>(`/sites/${siteId}/windows/${windowId}/diff`, { params: { file } });
    return res.data.data!;
  },
};

export const siteTokensApi = {
  async list(siteId: number): Promise<SiteApiToken[]> {
    const res = await apiClient.get<ApiResponse<SiteApiToken[]>>(`/sites/${siteId}/tokens`);
    return res.data.data ?? [];
  },
  async create(siteId: number, data: SiteApiTokenCreate): Promise<SiteApiTokenCreated> {
    const res = await apiClient.post<ApiResponse<SiteApiTokenCreated>>(`/sites/${siteId}/tokens`, data);
    return res.data.data!;
  },
  async delete(siteId: number, tokenId: number): Promise<void> {
    await apiClient.delete(`/sites/${siteId}/tokens/${tokenId}`);
  },
};

export const snapshotsApi = {
  async list(siteId: number, params: { limit?: number; offset?: number } = {}): Promise<Page<DbSnapshot>> {
    const res = await apiClient.get<ApiResponse<Page<DbSnapshot>>>(`/sites/${siteId}/snapshots`, { params });
    return res.data.data ?? EMPTY;
  },
  async restore(siteId: number, snapshotId: number): Promise<void> {
    await apiClient.post(`/sites/${siteId}/snapshots/${snapshotId}/restore`);
  },
  async delete(siteId: number, snapshotId: number): Promise<void> {
    await apiClient.delete(`/sites/${siteId}/snapshots/${snapshotId}`);
  },
};

export const adaptersApi = {
  async info(siteId: number): Promise<SiteAdaptersInfo> {
    const res = await apiClient.get<ApiResponse<SiteAdaptersInfo>>(`/sites/${siteId}/adapters`);
    return res.data.data!;
  },
  async run(siteId: number, data: AdapterRunRequest): Promise<AdapterRun> {
    const res = await apiClient.post<ApiResponse<AdapterRun>>(`/sites/${siteId}/adapters/runs`, data);
    return res.data.data!;
  },
  async runs(siteId: number, params: { limit?: number; offset?: number } = {}): Promise<Page<AdapterRun>> {
    const res = await apiClient.get<ApiResponse<Page<AdapterRun>>>(`/sites/${siteId}/adapters/runs`, { params });
    return res.data.data ?? EMPTY;
  },
  async getRun(siteId: number, runId: number): Promise<AdapterRunDetail> {
    const res = await apiClient.get<ApiResponse<AdapterRunDetail>>(`/sites/${siteId}/adapters/runs/${runId}`);
    return res.data.data!;
  },
  async putSchedule(siteId: number, adapter: AdapterId, data: AdapterScheduleInput): Promise<AdapterSchedule> {
    const res = await apiClient.put<ApiResponse<AdapterSchedule>>(`/sites/${siteId}/adapters/schedules/${adapter}`, data);
    return res.data.data!;
  },
  async deleteSchedule(siteId: number, adapter: AdapterId): Promise<void> {
    await apiClient.delete(`/sites/${siteId}/adapters/schedules/${adapter}`);
  },
};

export const quarantineApi = {
  async list(params: { accountId?: number; siteId?: number; status?: QuarantineStatus; tenantId?: number; limit?: number; offset?: number } = {}): Promise<Page<QuarantineItem>> {
    const res = await apiClient.get<ApiResponse<Page<QuarantineItem>>>('/quarantine', { params });
    return res.data.data ?? EMPTY;
  },
  async summary(accountId?: number): Promise<QuarantineSummary> {
    const res = await apiClient.get<ApiResponse<QuarantineSummary>>('/quarantine/summary', { params: accountId ? { accountId } : {} });
    return res.data.data ?? { quarantined: 0, last24h: 0 };
  },
  async get(id: number): Promise<QuarantineItemDetail> {
    const res = await apiClient.get<ApiResponse<QuarantineItemDetail>>(`/quarantine/${id}`);
    return res.data.data!;
  },
  async restore(id: number, data: QuarantineRestoreRequest = {}): Promise<QuarantineItem> {
    const res = await apiClient.post<ApiResponse<QuarantineItem>>(`/quarantine/${id}/restore`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<QuarantineItem> {
    const res = await apiClient.delete<ApiResponse<QuarantineItem>>(`/quarantine/${id}`);
    return res.data.data!;
  },
};

export const supervisionApi = {
  async get(siteId: number): Promise<SupervisionInfo> {
    const res = await apiClient.get<ApiResponse<SupervisionInfo>>(`/sites/${siteId}/supervision`);
    return res.data.data!;
  },
  async digest(siteId: number): Promise<SupervisionInfo> {
    const res = await apiClient.post<ApiResponse<SupervisionInfo>>(`/sites/${siteId}/supervision/digest`);
    return res.data.data!;
  },
};

/** Platform admin: /api/system/scanner (settings: hostingSettingsApi section `scanner`; deploy: infraApi.deploy('scanner')). */
export const scannerApi = {
  async status(): Promise<ScannerStatus> {
    const res = await apiClient.get<ApiResponse<ScannerStatus>>('/system/scanner');
    return res.data.data!;
  },
  async update(): Promise<ScannerStatus> {
    const res = await apiClient.post<ApiResponse<ScannerStatus>>('/system/scanner/update');
    return res.data.data!;
  },
  async test(): Promise<ScanTestResult> {
    const res = await apiClient.post<ApiResponse<ScanTestResult>>('/system/scanner/test');
    return res.data.data!;
  },
};
