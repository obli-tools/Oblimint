import apiClient from './client';
import type { ApiResponse, EdgeApplyRecord, EdgeUnitState, EdgeUnitStatusKind } from '@oblimint/shared';

// /api/edge/units (tenant) and /api/system/edge/units|applies|rollback
// (platform admin) — docs/P4b-PLAN.md §6.4, contract frozen in
// server/src/routes/edgeUnits.routes.ts. OWNED BY MODULE `ui-proxy`: complete
// thin typed wrappers of every route of the contract. The edge status itself
// (GET /system/edge) is wrapped by infraApi.edgeStatus (P1).

export const edgeUnitsApi = {
  /** Units of the visible accounts (errors as a generic label for a client, A6). */
  async list(params: { accountId?: number; tenantId?: number; status?: EdgeUnitStatusKind } = {}): Promise<EdgeUnitState[]> {
    const res = await apiClient.get<ApiResponse<EdgeUnitState[]>>('/edge/units', { params });
    return res.data.data ?? [];
  },
};

/** Platform admin. */
export const systemEdgeUnitsApi = {
  /** Every unit, with the full nginx -t / lint / probe output. */
  async list(params: { status?: EdgeUnitStatusKind; accountId?: number } = {}): Promise<EdgeUnitState[]> {
    const res = await apiClient.get<ApiResponse<EdgeUnitState[]>>('/system/edge/units', { params });
    return res.data.data ?? [];
  },
  /** Re-validate + apply that unit now. */
  async retry(unitId: string): Promise<EdgeUnitState> {
    const res = await apiClient.post<ApiResponse<EdgeUnitState>>(`/system/edge/units/${encodeURIComponent(unitId)}/retry`);
    return res.data.data!;
  },
  async applies(limit = 50): Promise<EdgeApplyRecord[]> {
    const res = await apiClient.get<ApiResponse<EdgeApplyRecord[]>>('/system/edge/applies', { params: { limit } });
    return res.data.data ?? [];
  },
  /** Back to the previous good snapshot (audited). */
  async rollback(): Promise<EdgeApplyRecord> {
    const res = await apiClient.post<ApiResponse<EdgeApplyRecord>>('/system/edge/rollback');
    return res.data.data!;
  },
};
