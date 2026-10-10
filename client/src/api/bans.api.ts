import apiClient from './client';
import type {
  ApiResponse, HoneypotPreset, WebBan, WebBanCreate, WebBanList, WebBanQuery, WebBanStats, WebFirewallSummary,
} from '@oblimint/shared';

// /api/bans — docs/P4b-PLAN.md §6.5, contract frozen in
// server/src/routes/bans.routes.ts. OWNED BY MODULE `ui-proxy`: complete thin
// typed wrappers of every route of the contract.

export const bansApi = {
  async list(params: WebBanQuery = {}): Promise<WebBanList> {
    const res = await apiClient.get<ApiResponse<WebBanList>>('/bans', { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async stats(params: { accountId?: number; tenantId?: number } = {}): Promise<WebBanStats> {
    const res = await apiClient.get<ApiResponse<WebBanStats>>('/bans/stats', { params });
    return res.data.data!;
  },
  /** The ≈ 45 common exploit paths ("Add the common exploit URLs"). */
  async honeypotPresets(): Promise<HoneypotPreset[]> {
    const res = await apiClient.get<ApiResponse<HoneypotPreset[]>>('/bans/honeypot-presets');
    return res.data.data ?? [];
  },
  async create(data: WebBanCreate): Promise<WebBan> {
    const res = await apiClient.post<ApiResponse<WebBan>>('/bans', data);
    return res.data.data!;
  },
  /** Unban (immediate, audited). */
  async remove(id: number): Promise<void> {
    await apiClient.delete(`/bans/${id}`);
  },
  /** Platform admin: account ban → platform ban (nginx everywhere + nftables). */
  async promote(id: number): Promise<WebBan> {
    const res = await apiClient.post<ApiResponse<WebBan>>(`/bans/${id}/promote`);
    return res.data.data!;
  },
  /** Platform admin: state of the nftables web firewall (hostd). */
  async firewall(): Promise<WebFirewallSummary> {
    const res = await apiClient.get<ApiResponse<WebFirewallSummary>>('/bans/firewall');
    return res.data.data!;
  },
};
