import apiClient from './client';
import type {
  ApiResponse, AppProfileId, Site, SiteCreate, SiteDataPath, SiteDataPathInput, SiteRoute, SiteRuntime,
  SitePhpRuntime, SiteRuntimeInput, SiteUpdate,
} from '@oblimint/shared';

// /api/sites (+ /data-paths, /runtimes, /routes) — docs/P1-PLAN.md §API.
// OWNED BY MODULE `ui-sites`.
export const sitesApi = {
  async list(params: { accountId?: number; search?: string } = {}): Promise<Site[]> {
    const res = await apiClient.get<ApiResponse<Site[]>>('/sites', { params });
    return res.data.data ?? [];
  },

  /** Exact PHP version of the containers of the visible sites (advisories). */
  async phpRuntime(): Promise<SitePhpRuntime[]> {
    const res = await apiClient.get<ApiResponse<SitePhpRuntime[]>>('/sites/php-runtime');
    return res.data.data ?? [];
  },

  async get(id: number): Promise<Site> {
    const res = await apiClient.get<ApiResponse<Site>>(`/sites/${id}`);
    return res.data.data!;
  },

  async create(data: SiteCreate): Promise<Site> {
    const res = await apiClient.post<ApiResponse<Site>>('/sites', data);
    return res.data.data!;
  },

  async update(id: number, data: SiteUpdate): Promise<Site> {
    const res = await apiClient.put<ApiResponse<Site>>(`/sites/${id}`, data);
    return res.data.data!;
  },

  /** `confirm` must equal the site slug. */
  async delete(id: number, confirm: string): Promise<void> {
    await apiClient.delete(`/sites/${id}`, { data: { confirm } });
  },

  async stop(id: number): Promise<Site> {
    const res = await apiClient.post<ApiResponse<Site>>(`/sites/${id}/stop`);
    return res.data.data!;
  },

  async start(id: number): Promise<Site> {
    const res = await apiClient.post<ApiResponse<Site>>(`/sites/${id}/start`);
    return res.data.data!;
  },

  // ── Data paths ─────────────────────────────────────────────────────────────
  async dataPaths(id: number): Promise<SiteDataPath[]> {
    const res = await apiClient.get<ApiResponse<SiteDataPath[]>>(`/sites/${id}/data-paths`);
    return res.data.data ?? [];
  },

  async addDataPath(id: number, data: SiteDataPathInput): Promise<SiteDataPath> {
    const res = await apiClient.post<ApiResponse<SiteDataPath>>(`/sites/${id}/data-paths`, data);
    return res.data.data!;
  },

  async updateDataPath(id: number, pathId: number, data: Partial<Pick<SiteDataPathInput, 'policy' | 'allowedExtensions'>>): Promise<SiteDataPath> {
    const res = await apiClient.put<ApiResponse<SiteDataPath>>(`/sites/${id}/data-paths/${pathId}`, data);
    return res.data.data!;
  },

  async deleteDataPath(id: number, pathId: number): Promise<void> {
    await apiClient.delete(`/sites/${id}/data-paths/${pathId}`);
  },

  async applyProfile(id: number, profile: AppProfileId): Promise<SiteDataPath[]> {
    const res = await apiClient.post<ApiResponse<SiteDataPath[]>>(`/sites/${id}/data-paths/apply-profile`, { profile });
    return res.data.data ?? [];
  },

  // ── Secondary runtimes ─────────────────────────────────────────────────────
  async runtimes(id: number): Promise<SiteRuntime[]> {
    const res = await apiClient.get<ApiResponse<SiteRuntime[]>>(`/sites/${id}/runtimes`);
    return res.data.data ?? [];
  },

  async addRuntime(id: number, data: SiteRuntimeInput): Promise<SiteRuntime> {
    const res = await apiClient.post<ApiResponse<SiteRuntime>>(`/sites/${id}/runtimes`, data);
    return res.data.data!;
  },

  async deleteRuntime(id: number, runtimeId: number): Promise<void> {
    await apiClient.delete(`/sites/${id}/runtimes/${runtimeId}`);
  },

  /** Routes (domain + prefix) that target this site. */
  async routes(id: number): Promise<SiteRoute[]> {
    const res = await apiClient.get<ApiResponse<SiteRoute[]>>(`/sites/${id}/routes`);
    return res.data.data ?? [];
  },
};
