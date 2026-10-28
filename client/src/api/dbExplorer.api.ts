import apiClient from './client';
import type {
  ApiResponse, DbxDdlPreview, DbxDdlRequest, DbxExportRequest, DbxExportTicket, DbxImportOptions, DbxImportStatus, DbxInfo, DbxMaintenanceOp, DbxObject,
  DbxObjectDefinition, DbxObjectKind, DbxQueryResponse, DbxRowKey, DbxRows, DbxRowsRequest, DbxSavedQuery, DbxSchema, DbxSearchRequest, DbxSearchResponse,
  DbxTable, DbxTableInfo,
} from '@oblimint/shared';

// /api/databases/instances/:id/databases/:dbId/explorer* — integrated database explorer.
const base = (instanceId: number, dbId: number) => `/databases/instances/${instanceId}/databases/${dbId}/explorer`;

export interface DbxDdlApplyResult extends DbxQueryResponse {
  statements: string[];
}

export const dbExplorerApi = {
  async info(instanceId: number, dbId: number): Promise<DbxInfo> {
    const res = await apiClient.get<ApiResponse<DbxInfo>>(base(instanceId, dbId), { timeout: 60_000 });
    return res.data.data!;
  },

  async close(instanceId: number, dbId: number): Promise<void> {
    await apiClient.delete(base(instanceId, dbId));
  },

  async tables(instanceId: number, dbId: number, refresh = false): Promise<DbxTable[]> {
    const res = await apiClient.get<ApiResponse<DbxTable[]>>(`${base(instanceId, dbId)}/tables`, { params: refresh ? { refresh: 1 } : {} });
    return res.data.data ?? [];
  },

  async table(instanceId: number, dbId: number, table: string): Promise<DbxTableInfo> {
    const res = await apiClient.get<ApiResponse<DbxTableInfo>>(`${base(instanceId, dbId)}/table`, { params: { t: table } });
    return res.data.data!;
  },

  async schema(instanceId: number, dbId: number): Promise<DbxSchema> {
    const res = await apiClient.get<ApiResponse<DbxSchema>>(`${base(instanceId, dbId)}/schema`);
    return res.data.data!;
  },

  async rows(instanceId: number, dbId: number, table: string, req: DbxRowsRequest): Promise<DbxRows> {
    const res = await apiClient.post<ApiResponse<DbxRows>>(`${base(instanceId, dbId)}/rows`, { table, ...req });
    return res.data.data!;
  },

  async insert(instanceId: number, dbId: number, table: string, values: Record<string, string | null>): Promise<void> {
    await apiClient.post(`${base(instanceId, dbId)}/insert`, { table, values });
  },

  async update(instanceId: number, dbId: number, table: string, key: DbxRowKey, values: Record<string, string | null>): Promise<number> {
    const res = await apiClient.post<ApiResponse<{ affected: number }>>(`${base(instanceId, dbId)}/update`, { table, key, values });
    return res.data.data!.affected;
  },

  async remove(instanceId: number, dbId: number, table: string, keys: DbxRowKey[]): Promise<number> {
    const res = await apiClient.post<ApiResponse<{ affected: number }>>(`${base(instanceId, dbId)}/delete`, { table, keys });
    return res.data.data!.affected;
  },

  async query(instanceId: number, dbId: number, sql: string, timeoutS?: number): Promise<DbxQueryResponse> {
    const res = await apiClient.post<ApiResponse<DbxQueryResponse>>(`${base(instanceId, dbId)}/query`, { sql, ...(timeoutS ? { timeoutS } : {}) }, { timeout: ((timeoutS ?? 30) + 90) * 1000 });
    return res.data.data!;
  },

  async cancel(instanceId: number, dbId: number): Promise<boolean> {
    const res = await apiClient.post<ApiResponse<{ cancelled: boolean }>>(`${base(instanceId, dbId)}/cancel`, {});
    return res.data.data!.cancelled;
  },

  async ddlPreview(instanceId: number, dbId: number, request: DbxDdlRequest): Promise<DbxDdlPreview> {
    const res = await apiClient.post<ApiResponse<DbxDdlPreview>>(`${base(instanceId, dbId)}/ddl/preview`, { request });
    return res.data.data!;
  },

  async ddlApply(instanceId: number, dbId: number, request: DbxDdlRequest): Promise<DbxDdlApplyResult> {
    const res = await apiClient.post<ApiResponse<DbxDdlApplyResult>>(`${base(instanceId, dbId)}/ddl/apply`, { request }, { timeout: 600_000 });
    return res.data.data!;
  },

  async objects(instanceId: number, dbId: number): Promise<DbxObject[]> {
    const res = await apiClient.get<ApiResponse<DbxObject[]>>(`${base(instanceId, dbId)}/objects`);
    return res.data.data ?? [];
  },

  async objectDefinition(instanceId: number, dbId: number, kind: DbxObjectKind, id: string): Promise<DbxObjectDefinition> {
    const res = await apiClient.get<ApiResponse<DbxObjectDefinition>>(`${base(instanceId, dbId)}/objects/definition`, { params: { kind, id } });
    return res.data.data!;
  },

  async search(instanceId: number, dbId: number, req: DbxSearchRequest): Promise<DbxSearchResponse> {
    const res = await apiClient.post<ApiResponse<DbxSearchResponse>>(`${base(instanceId, dbId)}/search`, req, { timeout: 120_000 });
    return res.data.data!;
  },

  async maintenance(instanceId: number, dbId: number, op: DbxMaintenanceOp, tables: string[]): Promise<DbxQueryResponse> {
    const res = await apiClient.post<ApiResponse<DbxQueryResponse>>(`${base(instanceId, dbId)}/maintenance`, { op, tables }, { timeout: 30 * 60_000 });
    return res.data.data!;
  },

  /** A one-shot ticket; the file is then a plain GET of `ticket.url` (streamed by the browser, never buffered here). */
  async prepareExport(instanceId: number, dbId: number, req: DbxExportRequest): Promise<DbxExportTicket> {
    const res = await apiClient.post<ApiResponse<DbxExportTicket>>(`${base(instanceId, dbId)}/export`, req);
    return res.data.data!;
  },

  /** Uploads the file (raw body) and resolves with the final status; progress comes from importStatus(). */
  async startImport(instanceId: number, dbId: number, file: File, options: DbxImportOptions, onUpload?: (sent: number) => void, signal?: AbortSignal): Promise<DbxImportStatus> {
    const res = await apiClient.post<ApiResponse<DbxImportStatus>>(`${base(instanceId, dbId)}/import`, file, {
      params: { options: JSON.stringify(options) },
      headers: { 'Content-Type': /\.gz$/i.test(file.name) ? 'application/gzip' : 'application/octet-stream' },
      timeout: 0,
      signal,
      onUploadProgress: (e) => onUpload?.(e.loaded),
    });
    return res.data.data!;
  },

  async importStatus(instanceId: number, dbId: number): Promise<DbxImportStatus | null> {
    const res = await apiClient.get<ApiResponse<DbxImportStatus | null>>(`${base(instanceId, dbId)}/import`);
    return res.data.data ?? null;
  },

  async cancelImport(instanceId: number, dbId: number): Promise<boolean> {
    const res = await apiClient.post<ApiResponse<{ cancelled: boolean }>>(`${base(instanceId, dbId)}/import/cancel`, {});
    return res.data.data!.cancelled;
  },

  async savedQueries(instanceId: number, dbId: number): Promise<DbxSavedQuery[]> {
    const res = await apiClient.get<ApiResponse<DbxSavedQuery[]>>(`${base(instanceId, dbId)}/queries`);
    return res.data.data ?? [];
  },

  async saveQuery(instanceId: number, dbId: number, body: { name: string; sql: string }): Promise<DbxSavedQuery> {
    const res = await apiClient.post<ApiResponse<DbxSavedQuery>>(`${base(instanceId, dbId)}/queries`, body);
    return res.data.data!;
  },

  async updateQuery(instanceId: number, dbId: number, id: number, body: { name?: string; sql?: string }): Promise<DbxSavedQuery> {
    const res = await apiClient.put<ApiResponse<DbxSavedQuery>>(`${base(instanceId, dbId)}/queries/${id}`, body);
    return res.data.data!;
  },

  async deleteQuery(instanceId: number, dbId: number, id: number): Promise<void> {
    await apiClient.delete(`${base(instanceId, dbId)}/queries/${id}`);
  },
};
