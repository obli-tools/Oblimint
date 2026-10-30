import apiClient from './client';
import type { ApiResponse, Tenant, TenantWithRole } from '@oblimint/shared';
import type { TenantInput } from '@/types';

export const tenantsApi = {
  /** Tenants the caller belongs to (with its role) — every tenant on the master god view. */
  async list(): Promise<TenantWithRole[]> {
    const res = await apiClient.get<ApiResponse<TenantWithRole[]>>('/tenants');
    return res.data.data ?? [];
  },

  async create(data: TenantInput): Promise<Tenant> {
    const res = await apiClient.post<ApiResponse<Tenant>>('/tenants', data);
    return res.data.data!;
  },

  /** keyRequireIp: "an IP is mandatory on the access keys" (null = the platform setting); a change is the action platform.key_security. */
  async update(id: number, data: Partial<TenantInput> & { keyRequireIp?: boolean | null }): Promise<Tenant> {
    const res = await apiClient.put<ApiResponse<Tenant>>(`/tenants/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/tenants/${id}`);
  },
};
