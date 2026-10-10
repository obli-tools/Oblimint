import apiClient from './client';
import type {
  ApiResponse, AppActionRequest, AppContainerAction, AppContainerInspect, AppDeployment, AppDeploymentDetail, AppEnvResponse,
  AppImageRollbackRequest, AppLogsResponse, AppRegistryCredential, AppRegistryCredentialInput, AppRegistryCredentialUpdate,
  AppResourceSummary, AppRollbackRequest, AppServiceInfo, AppServiceUpdate, AppStack, AppStackCreate, AppStackDeleteRequest,
  AppStackDetail, AppStackStatus, AppStackUpdate, AppStatsResponse, AppTemplate, AppTemplateCategory, AppTemplateDetail,
  AppTemplateInput, AppUpdateApplyRequest, AppUpdateCheck, ComposeValidateRequest, ComposeValidationResult, TenantAppPolicy,
  TenantAppPolicyUpdate,
} from '@oblimint/shared';

// /api/apps (stacks, sources, actions, deployments, updates, services, containers,
// validation, resources, catalog, registries, per-tenant policy) — docs/P4b-PLAN.md §6.1,
// contract in the header of server/src/routes/apps.routes.ts. Also the container stats
// of a stack (GET /api/monitoring/apps/:stackId/stats, §6.6). OWNED BY MODULE `ui-apps`.

export interface AppStackListParams {
  accountId?: number;
  tenantId?: number;
  status?: AppStackStatus;
  search?: string;
}

export type AppStatsRange = '1h' | '6h' | '24h' | '7d';

export const appsApi = {
  // ── stacks ──
  async listStacks(params: AppStackListParams = {}): Promise<AppStack[]> {
    const res = await apiClient.get<ApiResponse<AppStack[]>>('/apps/stacks', { params });
    return res.data.data ?? [];
  },
  async getStack(id: number): Promise<AppStackDetail> {
    const res = await apiClient.get<ApiResponse<AppStackDetail>>(`/apps/stacks/${id}`);
    return res.data.data!;
  },
  async createStack(data: AppStackCreate): Promise<AppStackDetail> {
    const res = await apiClient.post<ApiResponse<AppStackDetail>>('/apps/stacks', data);
    return res.data.data!;
  },
  async updateStack(id: number, data: AppStackUpdate): Promise<AppStackDetail> {
    const res = await apiClient.put<ApiResponse<AppStackDetail>>(`/apps/stacks/${id}`, data);
    return res.data.data!;
  },
  /** confirm = the stack name; ?force=1 also detaches the proxy hosts targeting it (409 stackInUse otherwise). */
  async deleteStack(id: number, data: AppStackDeleteRequest, force = false): Promise<void> {
    await apiClient.delete(`/apps/stacks/${id}`, { data, params: force ? { force: 1 } : undefined });
  },
  /** Sealed .env in clear (apps.manage, audited): fetched on demand only, never cached. */
  async getEnv(id: number): Promise<AppEnvResponse> {
    const res = await apiClient.get<ApiResponse<AppEnvResponse>>(`/apps/stacks/${id}/env`);
    return res.data.data!;
  },

  // ── sources ──
  /** ZIP source: the archive is the raw request body (application/zip). */
  async uploadZip(id: number, file: Blob, onProgress?: (pct: number) => void): Promise<AppStackDetail> {
    const res = await apiClient.post<ApiResponse<AppStackDetail>>(`/apps/stacks/${id}/source/zip`, file, {
      headers: { 'Content-Type': 'application/zip' },
      onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
    });
    return res.data.data!;
  },
  async pullGit(id: number, deploy?: boolean): Promise<{ commit: string | null; changed: boolean; deployment: AppDeployment | null }> {
    const res = await apiClient.post<ApiResponse<{ commit: string | null; changed: boolean; deployment: AppDeployment | null }>>(
      `/apps/stacks/${id}/source/pull`, { deploy },
    );
    return res.data.data!;
  },

  // ── actions / deployments ──
  async action(id: number, data: AppActionRequest): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/actions`, data);
    return res.data.data!;
  },
  async listDeployments(id: number, params: { limit?: number; offset?: number } = {}): Promise<{ items: AppDeployment[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: AppDeployment[]; total: number }>>(`/apps/stacks/${id}/deployments`, { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async getDeployment(id: number, depId: number): Promise<AppDeploymentDetail> {
    const res = await apiClient.get<ApiResponse<AppDeploymentDetail>>(`/apps/stacks/${id}/deployments/${depId}`);
    return res.data.data!;
  },
  async cancelDeployment(id: number, depId: number): Promise<{ cancelled: boolean }> {
    const res = await apiClient.post<ApiResponse<{ cancelled: boolean }>>(`/apps/stacks/${id}/deployments/${depId}/cancel`);
    return res.data.data!;
  },
  async rollback(id: number, data: AppRollbackRequest): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/rollback`, data);
    return res.data.data!;
  },

  // ── updates (digests) ──
  async checkUpdates(id: number): Promise<AppUpdateCheck> {
    const res = await apiClient.post<ApiResponse<AppUpdateCheck>>(`/apps/stacks/${id}/updates/check`);
    return res.data.data!;
  },
  async applyUpdates(id: number, data: AppUpdateApplyRequest = {}): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/updates/apply`, data);
    return res.data.data!;
  },
  async rollbackImage(id: number, data: AppImageRollbackRequest): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/updates/rollback`, data);
    return res.data.data!;
  },

  // ── services / containers ──
  async updateService(id: number, service: string, data: AppServiceUpdate): Promise<AppServiceInfo> {
    const res = await apiClient.put<ApiResponse<AppServiceInfo>>(`/apps/stacks/${id}/services/${encodeURIComponent(service)}`, data);
    return res.data.data!;
  },
  async sleep(id: number): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/sleep`);
    return res.data.data!;
  },
  async wake(id: number): Promise<AppDeployment> {
    const res = await apiClient.post<ApiResponse<AppDeployment>>(`/apps/stacks/${id}/wake`);
    return res.data.data!;
  },
  async containerAction(id: number, service: string, action: AppContainerAction): Promise<AppServiceInfo> {
    const res = await apiClient.post<ApiResponse<AppServiceInfo>>(`/apps/stacks/${id}/containers/${encodeURIComponent(service)}/${action}`);
    return res.data.data!;
  },
  async containerLogs(id: number, service: string, params: { tail?: number; since?: string } = {}): Promise<AppLogsResponse> {
    const res = await apiClient.get<ApiResponse<AppLogsResponse>>(`/apps/stacks/${id}/containers/${encodeURIComponent(service)}/logs`, { params });
    return res.data.data ?? { lines: [], truncated: false };
  },
  async inspectContainer(id: number, service: string): Promise<AppContainerInspect> {
    const res = await apiClient.get<ApiResponse<AppContainerInspect>>(`/apps/stacks/${id}/containers/${encodeURIComponent(service)}/inspect`);
    return res.data.data!;
  },

  // ── validation / resources / stats ──
  async validate(data: ComposeValidateRequest): Promise<ComposeValidationResult> {
    const res = await apiClient.post<ApiResponse<ComposeValidationResult>>('/apps/validate', data);
    return res.data.data!;
  },
  async resources(accountId: number): Promise<AppResourceSummary> {
    const res = await apiClient.get<ApiResponse<AppResourceSummary>>('/apps/resources', { params: { accountId } });
    return res.data.data!;
  },
  /** GET /api/monitoring/apps/:stackId/stats (module monitoring-automation). */
  async stats(stackId: number, range: AppStatsRange = '1h'): Promise<AppStatsResponse> {
    const res = await apiClient.get<ApiResponse<AppStatsResponse>>(`/monitoring/apps/${stackId}/stats`, { params: { range } });
    return res.data.data ?? { stackId, services: [] };
  },

  // ── catalog ──
  async listCatalog(params: { category?: AppTemplateCategory; search?: string } = {}): Promise<AppTemplate[]> {
    const res = await apiClient.get<ApiResponse<AppTemplate[]>>('/apps/catalog', { params });
    return res.data.data ?? [];
  },
  async getTemplate(slug: string): Promise<AppTemplateDetail> {
    const res = await apiClient.get<ApiResponse<AppTemplateDetail>>(`/apps/catalog/${encodeURIComponent(slug)}`);
    return res.data.data!;
  },
  async createTemplate(data: AppTemplateInput): Promise<AppTemplateDetail> {
    const res = await apiClient.post<ApiResponse<AppTemplateDetail>>('/apps/catalog', data);
    return res.data.data!;
  },
  async updateTemplate(id: number, data: Partial<AppTemplateInput>): Promise<AppTemplateDetail> {
    const res = await apiClient.put<ApiResponse<AppTemplateDetail>>(`/apps/catalog/${id}`, data);
    return res.data.data!;
  },
  async deleteTemplate(id: number): Promise<void> {
    await apiClient.delete(`/apps/catalog/${id}`);
  },

  // ── registry credentials (password write-only) ──
  async listRegistries(params: { accountId?: number; tenantId?: number } = {}): Promise<AppRegistryCredential[]> {
    const res = await apiClient.get<ApiResponse<AppRegistryCredential[]>>('/apps/registries', { params });
    return res.data.data ?? [];
  },
  async createRegistry(data: AppRegistryCredentialInput): Promise<AppRegistryCredential> {
    const res = await apiClient.post<ApiResponse<AppRegistryCredential>>('/apps/registries', data);
    return res.data.data!;
  },
  async updateRegistry(id: number, data: AppRegistryCredentialUpdate): Promise<AppRegistryCredential> {
    const res = await apiClient.put<ApiResponse<AppRegistryCredential>>(`/apps/registries/${id}`, data);
    return res.data.data!;
  },
  async deleteRegistry(id: number): Promise<void> {
    await apiClient.delete(`/apps/registries/${id}`);
  },

  // ── per-tenant policy (platform admin) ──
  async getTenantPolicy(tenantId: number): Promise<TenantAppPolicy> {
    const res = await apiClient.get<ApiResponse<TenantAppPolicy>>(`/apps/policy/tenants/${tenantId}`);
    return res.data.data!;
  },
  async updateTenantPolicy(tenantId: number, data: TenantAppPolicyUpdate): Promise<TenantAppPolicy> {
    const res = await apiClient.put<ApiResponse<TenantAppPolicy>>(`/apps/policy/tenants/${tenantId}`, data);
    return res.data.data!;
  },
};
