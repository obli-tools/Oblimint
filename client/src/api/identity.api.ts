import apiClient from './client';
import type {
  ApiResponse, EmailChangeResult, EmailState, PasswordResetRequested, PasswordResetTokenState, RecoveryCodesGenerated, RecoveryCodesStatus,
} from '@oblimint/shared';

// Self-service identity (shared/src/identity.ts). The /auth/* calls are public
// (no session): forgotten password and the links e-mailed by the panel.

export const identityApi = {
  async requestPasswordReset(email: string): Promise<PasswordResetRequested> {
    const res = await apiClient.post<ApiResponse<PasswordResetRequested>>('/auth/password-reset', { email });
    return res.data.data!;
  },

  async validateResetToken(token: string): Promise<PasswordResetTokenState> {
    try {
      const res = await apiClient.post<ApiResponse<PasswordResetTokenState>>('/auth/password-reset/validate', { token });
      return res.data.data ?? { valid: false };
    } catch {
      return { valid: false };
    }
  },

  async confirmPasswordReset(token: string, newPassword: string): Promise<{ kind: 'staff' | 'client' }> {
    const res = await apiClient.post<ApiResponse<{ kind: 'staff' | 'client' }>>('/auth/password-reset/confirm', { token, newPassword });
    return res.data.data!;
  },

  async confirmEmailChange(token: string): Promise<{ email: string; kind: 'staff' | 'client' }> {
    const res = await apiClient.post<ApiResponse<{ email: string; kind: 'staff' | 'client' }>>('/auth/email-change/confirm', { token });
    return res.data.data!;
  },

  // ── signed in ──
  async emailState(): Promise<EmailState> {
    const res = await apiClient.get<ApiResponse<EmailState>>('/profile/email');
    return res.data.data!;
  },

  /** Step-up (TOTP code or current password) handled by the api client prompt. null removes the address. */
  async changeEmail(email: string | null): Promise<EmailChangeResult> {
    const res = await apiClient.post<ApiResponse<EmailChangeResult>>('/profile/email', { email });
    return res.data.data!;
  },

  async verifyEmail(): Promise<EmailChangeResult> {
    const res = await apiClient.post<ApiResponse<EmailChangeResult>>('/profile/email/verify', {});
    return res.data.data!;
  },

  async cancelEmailChange(): Promise<EmailState> {
    const res = await apiClient.delete<ApiResponse<EmailState>>('/profile/email/pending');
    return res.data.data!;
  },

  async recoveryStatus(): Promise<RecoveryCodesStatus> {
    const res = await apiClient.get<ApiResponse<RecoveryCodesStatus>>('/profile/2fa/recovery-codes');
    return res.data.data!;
  },

  /** A new batch (step-up: a current TOTP code); the previous codes stop working. */
  async regenerateRecoveryCodes(): Promise<RecoveryCodesGenerated> {
    const res = await apiClient.post<ApiResponse<RecoveryCodesGenerated>>('/profile/2fa/recovery-codes', {});
    return res.data.data!;
  },
};
