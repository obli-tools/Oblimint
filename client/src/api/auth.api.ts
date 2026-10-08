import apiClient from './client';
import type { User, ApiResponse } from '@oblimint/shared';
import type { LoginRequest, UserPermissions, ConnectedApp, SsoConfig } from '@/types';

export type LoginResult =
  | { user: User; requires2fa?: never }
  | { requires2fa: true; methods: { totp: boolean; email?: boolean }; user?: never };

export interface MeResponse {
  user: User;
  permissions?: UserPermissions;
  requires2faSetup?: boolean;
  currentTenantId?: number | null;
}

export const authApi = {
  async login(data: LoginRequest): Promise<LoginResult> {
    const res = await apiClient.post<ApiResponse<LoginResult>>('/auth/login', data);
    return res.data.data!;
  },

  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  },

  async me(): Promise<MeResponse> {
    const res = await apiClient.get<ApiResponse<MeResponse>>('/auth/me');
    return res.data.data!;
  },

  /** Obligate SSO availability (public). */
  async ssoConfig(): Promise<SsoConfig> {
    const res = await fetch('/api/auth/sso-config', { credentials: 'include' });
    const body = await res.json() as ApiResponse<SsoConfig>;
    return body.data ?? { obligateUrl: null, obligateEnabled: false };
  },

  /** Obli* apps registered on Obligate (header pills). Empty when SSO is off. */
  async connectedApps(): Promise<ConnectedApp[]> {
    const res = await fetch('/api/auth/connected-apps', { credentials: 'include' });
    const body = await res.json() as ApiResponse<ConnectedApp[]>;
    return body.success && body.data ? body.data : [];
  },
};
