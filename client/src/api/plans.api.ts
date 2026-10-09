import apiClient from './client';
import type { ApiResponse, Plan, PlanInput, TenantEnvelopeUsage } from '@oblimint/shared';

// /api/plans (docs/P1-PLAN.md §API). OWNED BY MODULE `ui-hosting`.
export const plansApi = {
  async list(): Promise<Plan[]> {
    const res = await apiClient.get<ApiResponse<Plan[]>>('/plans');
    return res.data.data ?? [];
  },

  async envelope(): Promise<TenantEnvelopeUsage> {
    const res = await apiClient.get<ApiResponse<TenantEnvelopeUsage>>('/plans/envelope');
    return res.data.data!;
  },

  async get(id: number): Promise<Plan> {
    const res = await apiClient.get<ApiResponse<Plan>>(`/plans/${id}`);
    return res.data.data!;
  },

  async create(data: PlanInput): Promise<Plan> {
    const res = await apiClient.post<ApiResponse<Plan>>('/plans', data);
    return res.data.data!;
  },

  async update(id: number, data: Partial<PlanInput>): Promise<Plan> {
    const res = await apiClient.put<ApiResponse<Plan>>(`/plans/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/plans/${id}`);
  },
};
