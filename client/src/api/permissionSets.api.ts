import apiClient from './client';
import type { ApiResponse, PermissionSet } from '@oblimint/shared';
import type { CapabilityDef, PermissionSetInput } from '@/types';

export const permissionSetsApi = {
  async list(): Promise<PermissionSet[]> {
    const res = await apiClient.get<ApiResponse<PermissionSet[]>>('/permission-sets');
    return res.data.data ?? [];
  },

  async capabilities(): Promise<CapabilityDef[]> {
    const res = await apiClient.get<ApiResponse<CapabilityDef[]>>('/permission-sets/capabilities');
    return res.data.data ?? [];
  },

  async create(data: PermissionSetInput): Promise<PermissionSet> {
    const res = await apiClient.post<ApiResponse<PermissionSet>>('/permission-sets', data);
    return res.data.data!;
  },

  async update(id: number, data: Partial<PermissionSetInput>): Promise<PermissionSet> {
    const res = await apiClient.put<ApiResponse<PermissionSet>>(`/permission-sets/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/permission-sets/${id}`);
  },
};
