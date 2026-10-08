import apiClient from './client';
import type { ApiResponse } from '@oblimint/shared';
import type { AuditLogRow } from '@/types';

export type { AuditLogRow };

export interface AuditLogFilters {
  action?: string;        // exact match, or prefix if ends with "."
  userId?: number;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  /** Master-only: narrow the god view to one tenant. */
  filterTenantId?: number;
}

export const auditApi = {
  async list(filters: AuditLogFilters = {}): Promise<{ items: AuditLogRow[]; total: number }> {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') params[k] = v as string | number;
    }
    const res = await apiClient.get<ApiResponse<{ items: AuditLogRow[]; total: number }>>('/audit', { params });
    return res.data.data ?? { items: [], total: 0 };
  },

  /** Optional route: an empty list when the server does not offer it. */
  async distinctActions(filterTenantId?: number): Promise<string[]> {
    const params: Record<string, number> = {};
    if (filterTenantId) params.filterTenantId = filterTenantId;
    try {
      const res = await apiClient.get<ApiResponse<string[]>>('/audit/distinct-actions', { params });
      return res.data.data ?? [];
    } catch {
      return [];
    }
  },
};
