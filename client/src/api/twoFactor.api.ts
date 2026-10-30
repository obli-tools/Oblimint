import apiClient from './client';
import type { ApiResponse, RecoveryCodesGenerated, User } from '@oblimint/shared';

/** TOTP only in P0 (no e-mail codes). */
export interface TwoFactorStatus {
  totpEnabled: boolean;
  /** Unused recovery codes of the current batch (0 = none). */
  recoveryCodesRemaining?: number;
  recoveryCodesTotal?: number;
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

  /** Enables the authenticator; the answer carries its first batch of recovery codes (shown once). */
  async totpEnable(code: string): Promise<{ recoveryCodes?: RecoveryCodesGenerated }> {
    const res = await apiClient.post<ApiResponse<{ recoveryCodes?: RecoveryCodesGenerated }>>('/profile/2fa/totp/enable', { code });
    return res.data.data ?? {};
  },

  /** P0 contract: POST `totp/disable` (Obliance used DELETE /profile/2fa/totp). */
  async totpDisable(): Promise<void> {
    await apiClient.post('/profile/2fa/totp/disable');
  },

  /** Second step of the login when the account has TOTP. */
  async verify(code: string, method: 'totp' | 'recovery' = 'totp'): Promise<{ user: User; recoveryCodesRemaining?: number }> {
    const res = await apiClient.post<ApiResponse<{ user: User; recoveryCodesRemaining?: number }>>('/profile/2fa/verify', { code, method });
    return res.data.data!;
  },
};
