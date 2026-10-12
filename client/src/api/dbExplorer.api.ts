import apiClient from './client';
import type {
  ApiResponse, DbxInfo, DbxQueryResponse, DbxRowKey, DbxRows, DbxRowsRequest, DbxTable, DbxTableInfo,
} from '@oblimint/shared';

// /api/databases/instances/:id/databases/:dbId/explorer* — integrated database explorer.
const base = (instanceId: number, dbId: number) => `/databases/instances/${instanceId}/databases/${dbId}/explorer`;

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

  async query(instanceId: number, dbId: number, sql: string): Promise<DbxQueryResponse> {
    const res = await apiClient.post<ApiResponse<DbxQueryResponse>>(`${base(instanceId, dbId)}/query`, { sql }, { timeout: 120_000 });
    return res.data.data!;
  },
};
