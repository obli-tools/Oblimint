import apiClient from './client';
import type { User, ApiResponse } from '@oblimint/shared';
import type { CreateUserRequest, UpdateUserRequest, UserTenantAssignment } from '@/types';

export const usersApi = {
  async list(): Promise<User[]> {
    const res = await apiClient.get<ApiResponse<User[]>>('/users');
    return res.data.data ?? [];
  },

  async getById(id: number): Promise<User> {
    const res = await apiClient.get<ApiResponse<User>>(`/users/${id}`);
    return res.data.data!;
  },

  async create(data: CreateUserRequest): Promise<User> {
    const res = await apiClient.post<ApiResponse<User>>('/users', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateUserRequest): Promise<User> {
    const res = await apiClient.put<ApiResponse<User>>(`/users/${id}`, data);
    return res.data.data!;
  },

  async changePassword(id: number, password: string): Promise<void> {
    await apiClient.put(`/users/${id}/password`, { password });
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}`);
  },

  async getTenants(id: number): Promise<UserTenantAssignment[]> {
    const res = await apiClient.get<ApiResponse<UserTenantAssignment[]>>(`/users/${id}/tenants`);
    return res.data.data ?? [];
  },

  /** role: 'admin' or a permission set slug ('user' by default). */
  async setTenants(id: number, assignments: { tenantId: number; role: string }[]): Promise<void> {
    await apiClient.put(`/users/${id}/tenants`, { assignments });
  },

  async resetMfa(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}/2fa`);
  },
};
