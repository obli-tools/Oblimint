import apiClient from './client';
import type {
  AccessRule, AccessRuleInput, AccountAccessInfo, AccountAccessUpdate, ApiResponse, FirewallStatus, IpProbeResult,
  IpProbeTicket, MyIpsInfo,
} from '@oblimint/shared';

// /api/accounts/:id/access, /api/access, /api/system/firewall — docs/P2-PLAN.md §6.4.
// OWNED BY MODULE `ui-ops` (posed by the architect: complete thin wrappers of the server contract).
export const firewallApi = {
  async getAccess(accountId: number): Promise<AccountAccessInfo> {
    const res = await apiClient.get<ApiResponse<AccountAccessInfo>>(`/accounts/${accountId}/access`);
    return res.data.data!;
  },
  /** `confirm: true` re-sends a mode change the server refused with 409 lockoutRisk (details.confirm). */
  async updateAccess(accountId: number, data: AccountAccessUpdate & { confirm?: boolean }): Promise<AccountAccessInfo> {
    const res = await apiClient.put<ApiResponse<AccountAccessInfo>>(`/accounts/${accountId}/access`, data);
    return res.data.data!;
  },
  async addRule(accountId: number, data: AccessRuleInput): Promise<AccessRule> {
    const res = await apiClient.post<ApiResponse<AccessRule>>(`/accounts/${accountId}/access/rules`, data);
    return res.data.data!;
  },
  async deleteRule(accountId: number, ruleId: number): Promise<void> {
    await apiClient.delete(`/accounts/${accountId}/access/rules/${ruleId}`);
  },
  async allowMyIps(accountId: number): Promise<AccountAccessInfo> {
    const res = await apiClient.post<ApiResponse<AccountAccessInfo>>(`/accounts/${accountId}/access/allow-my-ips`);
    return res.data.data!;
  },
  async deleteGrant(accountId: number, grantId: number): Promise<void> {
    await apiClient.delete(`/accounts/${accountId}/access/grants/${grantId}`);
  },
  async unban(accountId: number, banId: number): Promise<void> {
    await apiClient.delete(`/accounts/${accountId}/access/bans/${banId}`);
  },

  // ── my addresses (v4-only / v6-only probes) ──
  async probeTicket(): Promise<IpProbeTicket> {
    const res = await apiClient.post<ApiResponse<IpProbeTicket>>('/access/probe');
    return res.data.data!;
  },
  /** Calls a probe URL (other host name: plain fetch, no credentials). null on failure (no v6, blocked…). */
  async runProbe(url: string): Promise<IpProbeResult | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(url, { credentials: 'omit', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!r.ok) return null;
      const body = await r.json() as ApiResponse<IpProbeResult>;
      return body.data ?? null;
    } catch {
      return null;
    }
  },
  async myIps(): Promise<MyIpsInfo> {
    const res = await apiClient.get<ApiResponse<MyIpsInfo>>('/access/my-ips');
    return res.data.data!;
  },

  // ── platform (admin) ──
  async status(): Promise<FirewallStatus> {
    const res = await apiClient.get<ApiResponse<FirewallStatus>>('/system/firewall');
    return res.data.data!;
  },
  async syncAll(): Promise<FirewallStatus> {
    const res = await apiClient.post<ApiResponse<FirewallStatus>>('/system/firewall/sync');
    return res.data.data!;
  },
};
