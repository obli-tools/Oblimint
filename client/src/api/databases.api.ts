import apiClient from './client';
import type {
  ApiResponse, DbAdminSession, DbAttachmentResult, DbCatalog, DbDatabase, DbDatabaseCreate, DbDatabaseListItem, DbInstance,
  DbInstanceCreate, DbInstanceDetail, DbInstanceUpdate, DbPasswordResult, DbSetOwnerRequest, DbShareRequest, DbUser, DbUserCreate,
  DbUserUpdate, SiteDatabase, SiteDatabaseCreate,
} from '@oblimint/shared';

// /api/databases — docs/P2-PLAN.md §6.3. OWNED BY MODULE `ui-dns-db`
// (posed by the architect: complete thin wrappers of the server contract).
export const databasesApi = {
  async catalog(accountId?: number): Promise<DbCatalog> {
    const res = await apiClient.get<ApiResponse<DbCatalog>>('/databases/catalog', { params: { accountId } });
    return res.data.data!;
  },
  async listInstances(params: { accountId?: number; tenantId?: number } = {}): Promise<DbInstance[]> {
    const res = await apiClient.get<ApiResponse<DbInstance[]>>('/databases/instances', { params });
    return res.data.data ?? [];
  },
  async getInstance(id: number): Promise<DbInstanceDetail> {
    const res = await apiClient.get<ApiResponse<DbInstanceDetail>>(`/databases/instances/${id}`);
    return res.data.data!;
  },
  async createInstance(data: DbInstanceCreate): Promise<DbInstance> {
    const res = await apiClient.post<ApiResponse<DbInstance>>('/databases/instances', data);
    return res.data.data!;
  },
  async updateInstance(id: number, data: DbInstanceUpdate): Promise<DbInstance> {
    const res = await apiClient.put<ApiResponse<DbInstance>>(`/databases/instances/${id}`, data);
    return res.data.data!;
  },
  async deleteInstance(id: number, confirm: string): Promise<void> {
    await apiClient.delete(`/databases/instances/${id}`, { data: { confirm } });
  },
  async action(id: number, action: 'start' | 'stop' | 'restart'): Promise<DbInstance> {
    const res = await apiClient.post<ApiResponse<DbInstance>>(`/databases/instances/${id}/${action}`);
    return res.data.data!;
  },
  async setExternal(id: number, enabled: boolean): Promise<DbInstance> {
    const res = await apiClient.put<ApiResponse<DbInstance>>(`/databases/instances/${id}/external`, { enabled });
    return res.data.data!;
  },

  // ── databases ──
  async createDatabase(id: number, data: DbDatabaseCreate): Promise<DbDatabase> {
    const res = await apiClient.post<ApiResponse<DbDatabase>>(`/databases/instances/${id}/databases`, data);
    return res.data.data!;
  },
  async deleteDatabase(id: number, dbId: number, confirm: string): Promise<void> {
    await apiClient.delete(`/databases/instances/${id}/databases/${dbId}`, { data: { confirm } });
  },
  /** Same-origin URL of the dump download (GET, session cookie): use utils/download.downloadUrl. */
  dumpUrl(id: number, dbId: number): string {
    return `/api/databases/instances/${id}/databases/${dbId}/dump`;
  },
  /**
   * Fetches the dump as a Blob (browser path), so an error answer (429, 409
   * instanceBusy / instanceNotRunning, 403…) is reported instead of being
   * saved as the .sql.gz file. On error, the JSON body of the blob response is
   * decoded back into `response.data` so the coded error helpers work.
   */
  async dumpBlob(id: number, dbId: number): Promise<Blob> {
    try {
      const res = await apiClient.get<Blob>(`/databases/instances/${id}/databases/${dbId}/dump`, { responseType: 'blob' });
      return res.data;
    } catch (err) {
      const resp = (err as { response?: { data?: unknown } } | null)?.response;
      if (resp && resp.data instanceof Blob) {
        try { resp.data = JSON.parse(await resp.data.text()); } catch { resp.data = {}; }
      }
      throw err;
    }
  },
  /** Uploads a .sql or .sql.gz file as the raw body (originGuard RAW_UPLOAD_PATHS). */
  async restore(id: number, dbId: number, file: File, onProgress?: (pct: number) => void): Promise<void> {
    const gz = /\.gz$/i.test(file.name);
    await apiClient.post(`/databases/instances/${id}/databases/${dbId}/restore`, file, {
      headers: { 'Content-Type': gz ? 'application/gzip' : 'application/sql' },
      timeout: 0,
      onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
    });
  },

  // ── databases ↔ sites (migration 030: one optional owner site, shared with 0..N others) ──
  /** Every database the caller reads, with its owner site and shared sites (siteId: owned by / shared with that site). */
  async listDatabases(params: { accountId?: number; siteId?: number; tenantId?: number } = {}): Promise<DbDatabaseListItem[]> {
    const res = await apiClient.get<ApiResponse<DbDatabaseListItem[]>>('/databases/databases', { params });
    return res.data.data ?? [];
  },
  /** The databases of a site: owned, then shared with it. */
  async siteDatabases(siteId: number): Promise<SiteDatabase[]> {
    const res = await apiClient.get<ApiResponse<SiteDatabase[]>>(`/databases/sites/${siteId}/databases`);
    return res.data.data ?? [];
  },
  /** A new database owned by the site, on the account's default instance of `family` (409 noDefaultInstance). */
  async createSiteDatabase(siteId: number, data: SiteDatabaseCreate): Promise<SiteDatabase> {
    const res = await apiClient.post<ApiResponse<SiteDatabase>>(`/databases/sites/${siteId}/databases`, data);
    return res.data.data!;
  },
  /** siteId null = shared across the account again (the previous owner stays attached as shared). */
  async setOwner(id: number, dbId: number, data: DbSetOwnerRequest): Promise<DbAttachmentResult> {
    const res = await apiClient.put<ApiResponse<DbAttachmentResult>>(`/databases/instances/${id}/databases/${dbId}/owner`, data);
    return res.data.data!;
  },
  async share(id: number, dbId: number, data: DbShareRequest): Promise<DbAttachmentResult> {
    const res = await apiClient.post<ApiResponse<DbAttachmentResult>>(`/databases/instances/${id}/databases/${dbId}/shares`, data);
    return res.data.data!;
  },
  /** Detaches the database from a site (owner or shared); the SQL rights stay as they are. */
  async detach(id: number, dbId: number, siteId: number): Promise<DbAttachmentResult> {
    const res = await apiClient.delete<ApiResponse<DbAttachmentResult>>(`/databases/instances/${id}/databases/${dbId}/sites/${siteId}`);
    return res.data.data!;
  },

  // ── users ──
  async createUser(id: number, data: DbUserCreate): Promise<DbPasswordResult> {
    const res = await apiClient.post<ApiResponse<DbPasswordResult>>(`/databases/instances/${id}/users`, data);
    return res.data.data!;
  },
  async updateUser(id: number, userId: number, data: DbUserUpdate): Promise<DbUser> {
    const res = await apiClient.put<ApiResponse<DbUser>>(`/databases/instances/${id}/users/${userId}`, data);
    return res.data.data!;
  },
  async resetPassword(id: number, userId: number, password?: string | null): Promise<DbPasswordResult> {
    const res = await apiClient.post<ApiResponse<DbPasswordResult>>(`/databases/instances/${id}/users/${userId}/password`, { password: password ?? null });
    return res.data.data!;
  },
  async deleteUser(id: number, userId: number): Promise<void> {
    await apiClient.delete(`/databases/instances/${id}/users/${userId}`);
  },

  // ── admin UI single sign-on ──
  async openAdminSession(id: number, databaseId?: number | null, opts: { onStepUp?: () => void } = {}): Promise<DbAdminSession> {
    // Protectable (db.admin_open): the 2FA prompt / approval modal of the API client apply
    // (`onStepUp` runs just before one shows); never replayed after the modal (the URL would reach nobody).
    const res = await apiClient.post<ApiResponse<DbAdminSession>>(`/databases/instances/${id}/admin-session`, { databaseId: databaseId ?? null }, {
      noLaterReplay: true, onStepUp: opts.onStepUp,
    });
    return res.data.data!;
  },
};
