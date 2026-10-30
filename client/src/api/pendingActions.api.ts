import apiClient from './client';
import type { ApiResponse, PendingAction, PendingActionList, PendingActionTab } from '@oblimint/shared';

// /api/pending-actions — confirmations and approvals of the sensitive actions
// (page /approvals). Session only: the server refuses every access key. The
// decisions ask the decider's own fresh code: the server answers 401
// twoFactorRequired and the API client's TwoFactorGate prompts, then replays.
export const pendingActionsApi = {
  async list(tab: PendingActionTab): Promise<PendingActionList> {
    return (await apiClient.get<ApiResponse<PendingActionList>>('/pending-actions', { params: { tab } })).data.data!;
  },
  async count(): Promise<number> {
    return (await apiClient.get<ApiResponse<{ todo: number }>>('/pending-actions/count')).data.data!.todo;
  },
  async get(id: number): Promise<PendingAction> {
    return (await apiClient.get<ApiResponse<PendingAction>>(`/pending-actions/${id}`)).data.data!;
  },
  /** The requester confirms his own 'sensitive' request (made through a key) with his code. */
  async confirm(id: number): Promise<PendingAction> {
    return (await apiClient.post<ApiResponse<PendingAction>>(`/pending-actions/${id}/confirm`, {})).data.data!;
  },
  /** Another eligible person approves a 'restricted' request, with his own code. */
  async approve(id: number, reason?: string): Promise<PendingAction> {
    return (await apiClient.post<ApiResponse<PendingAction>>(`/pending-actions/${id}/approve`, reason ? { reason } : {})).data.data!;
  },
  async deny(id: number, reason?: string): Promise<PendingAction> {
    return (await apiClient.post<ApiResponse<PendingAction>>(`/pending-actions/${id}/deny`, reason ? { reason } : {})).data.data!;
  },
  async cancel(id: number): Promise<PendingAction> {
    return (await apiClient.post<ApiResponse<PendingAction>>(`/pending-actions/${id}/cancel`, {})).data.data!;
  },
};
