import apiClient from './client';
import type { ApiResponse, ObligateConfig } from '@oblimint/shared';
import type { ObligateConfigInput, SystemInfo } from '@/types';

export const settingsApi = {
  // ── Obligate SSO gateway (same routes as Obliance) ───────────────────────
  async getObligateConfig(): Promise<ObligateConfig> {
    const res = await apiClient.get<ApiResponse<ObligateConfig>>('/admin/config/obligate');
    return res.data.data!;
  },

  /** `apiKey` / `inboundSecret`: omitted = unchanged, null = cleared. */
  async patchObligateConfig(patch: Omit<ObligateConfigInput, 'apiKey' | 'inboundSecret'> & { apiKey?: string | null; inboundSecret?: string | null }): Promise<ObligateConfig> {
    const res = await apiClient.put<ApiResponse<ObligateConfig>>('/admin/config/obligate', patch);
    return res.data.data!;
  },

  // ── System info (Settings → About) ───────────────────────────────────────
  async getSystemInfo(): Promise<SystemInfo> {
    const res = await apiClient.get('/system');
    const body = res.data as Partial<ApiResponse<SystemInfo>> & Partial<SystemInfo>;
    // Obliance answers the bare object; accept the { success, data } envelope too.
    return (body && body.data ? body.data : body) as SystemInfo;
  },
};
