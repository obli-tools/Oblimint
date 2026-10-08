import apiClient from './client';
import type { ApiResponse, User } from '@oblimint/shared';

/** TOTP only in P0 (no e-mail codes). */
export interface TwoFactorStatus {
  totpEnabled: boolean;
}

export interface TotpSetupData {
  secret: string;
  /** otpauth:// QR code rendered server-side as a data: URL (Obliance shape). */
  qrDataUrl: string;
}

export const twoFactorApi = {
  async getStatus(): Promise<TwoFactorStatus> {
    const res = await apiClient.get<ApiResponse<TwoFactorStatus>>('/profile/2fa/status');
    return res.data.data!;
  },

  async totpSetup(): Promise<TotpSetupData> {
    const res = await apiClient.post<ApiResponse<TotpSetupData>>('/profile/2fa/totp/setup');
    return res.data.data!;
  },

  async totpEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/totp/enable', { code });
  },

  /** P0 contract: POST `totp/disable` (Obliance used DELETE /profile/2fa/totp). */
  async totpDisable(): Promise<void> {
    await apiClient.post('/profile/2fa/totp/disable');
  },

  /** Second step of the login when the account has TOTP. */
  async verify(code: string): Promise<{ user: User }> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/profile/2fa/verify', { code, method: 'totp' });
    return res.data.data!;
  },
};
