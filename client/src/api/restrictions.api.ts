import apiClient from './client';
import type { ApiResponse, RestrictionFloor, RestrictionMap, RestrictionsView } from '@oblimint/shared';

// /api/restrictions — the workspace's matrix of sensitive actions (staff with
// `settings`), plus the platform floor (platform admin on the master
// workspace). Editing is itself the action `restrictions.manage`: a 2FA code
// may be asked (TwoFactorGate) or the change filed for approval (202 →
// PendingApprovalGate).
export const restrictionsApi = {
  async get(): Promise<RestrictionsView> {
    return (await apiClient.get<ApiResponse<RestrictionsView>>('/restrictions')).data.data!;
  },
  async setMap(map: RestrictionMap): Promise<RestrictionsView> {
    return (await apiClient.put<ApiResponse<RestrictionsView>>('/restrictions', { map })).data.data!;
  },
  async setFloor(floor: RestrictionFloor): Promise<RestrictionsView> {
    return (await apiClient.put<ApiResponse<RestrictionsView>>('/restrictions/floor', { floor })).data.data!;
  },
};
