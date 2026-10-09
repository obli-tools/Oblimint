import apiClient from './client';
import type {
  ApiResponse, DkimAlgorithm, DkimKey, MailAlias, MailAliasInput, MailAliasUpdate, MailAutoresponderInput, MailBan, Mailbox, MailboxCreate,
  MailboxCreated, MailboxDetail, MailboxUpdate, MailDnsStatus, MailDomain, MailDomainCreate, MailDomainDetail, MailDomainDnsUpdate,
  MailDomainUpdate, MailEngine, MailForwardingInput, MailLogDirection, MailLogEntry, MailLogEventKind, MailOutboundState, MailOverview,
  MailPasswordChange, MailPasswordResult, MailQueueItem, MailSystemStatus, OpenRelayTestResult, SiteMailRelay, SiteMailRelayUpdate,
  WebmailSsoTicket,
} from '@oblimint/shared';

// /api/mail, /api/system/mail, /api/sites/:id/mail-relay — docs/P4-PLAN.md §6.
// OWNED BY MODULE `ui-mail` (posed by the architect: complete thin wrappers of
// the server contract).

export interface MailListParams {
  accountId?: number;
  tenantId?: number;
  mailDomainId?: number;
  search?: string;
}

export interface MailLogParams {
  accountId?: number;
  tenantId?: number;
  siteId?: number;
  mailboxId?: number;
  direction?: MailLogDirection;
  event?: MailLogEventKind;
  since?: string;
  until?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export const mailApi = {
  // ── overview / domains ──
  async overview(accountId?: number): Promise<MailOverview> {
    const res = await apiClient.get<ApiResponse<MailOverview>>('/mail/overview', { params: { accountId } });
    return res.data.data!;
  },
  async listDomains(params: MailListParams = {}): Promise<MailDomain[]> {
    const res = await apiClient.get<ApiResponse<MailDomain[]>>('/mail/domains', { params });
    return res.data.data ?? [];
  },
  async getDomain(id: number): Promise<MailDomainDetail> {
    const res = await apiClient.get<ApiResponse<MailDomainDetail>>(`/mail/domains/${id}`);
    return res.data.data!;
  },
  async createDomain(data: MailDomainCreate): Promise<MailDomainDetail> {
    const res = await apiClient.post<ApiResponse<MailDomainDetail>>('/mail/domains', data);
    return res.data.data!;
  },
  async updateDomain(id: number, data: MailDomainUpdate): Promise<MailDomainDetail> {
    const res = await apiClient.put<ApiResponse<MailDomainDetail>>(`/mail/domains/${id}`, data);
    return res.data.data!;
  },
  /** force (staff only): also deletes its mailboxes / aliases. */
  async deleteDomain(id: number, confirm: string, force = false): Promise<void> {
    await apiClient.delete(`/mail/domains/${id}`, { data: { confirm }, params: force ? { force: 1 } : undefined });
  },

  // ── mailboxes ──
  async listMailboxes(params: MailListParams & { limit?: number; offset?: number } = {}): Promise<{ items: Mailbox[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: Mailbox[]; total: number }>>('/mail/mailboxes', { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async getMailbox(id: number): Promise<MailboxDetail> {
    const res = await apiClient.get<ApiResponse<MailboxDetail>>(`/mail/mailboxes/${id}`);
    return res.data.data!;
  },
  async createMailbox(data: MailboxCreate): Promise<MailboxCreated> {
    const res = await apiClient.post<ApiResponse<MailboxCreated>>('/mail/mailboxes', data);
    return res.data.data!;
  },
  async updateMailbox(id: number, data: MailboxUpdate): Promise<MailboxDetail> {
    const res = await apiClient.put<ApiResponse<MailboxDetail>>(`/mail/mailboxes/${id}`, data);
    return res.data.data!;
  },
  async setPassword(id: number, data: MailPasswordChange): Promise<MailPasswordResult> {
    const res = await apiClient.post<ApiResponse<MailPasswordResult>>(`/mail/mailboxes/${id}/password`, data);
    return res.data.data!;
  },
  async setForwarding(id: number, data: MailForwardingInput): Promise<MailboxDetail> {
    const res = await apiClient.put<ApiResponse<MailboxDetail>>(`/mail/mailboxes/${id}/forwarding`, data);
    return res.data.data!;
  },
  async setAutoresponder(id: number, data: MailAutoresponderInput): Promise<MailboxDetail> {
    const res = await apiClient.put<ApiResponse<MailboxDetail>>(`/mail/mailboxes/${id}/autoresponder`, data);
    return res.data.data!;
  },
  async deleteMailbox(id: number, confirm: string): Promise<void> {
    await apiClient.delete(`/mail/mailboxes/${id}`, { data: { confirm } });
  },
  async openWebmail(id: number): Promise<WebmailSsoTicket> {
    const res = await apiClient.post<ApiResponse<WebmailSsoTicket>>(`/mail/mailboxes/${id}/webmail-session`);
    return res.data.data!;
  },

  // ── aliases ──
  async listAliases(params: MailListParams = {}): Promise<MailAlias[]> {
    const res = await apiClient.get<ApiResponse<MailAlias[]>>('/mail/aliases', { params });
    return res.data.data ?? [];
  },
  async createAlias(data: MailAliasInput): Promise<MailAlias> {
    const res = await apiClient.post<ApiResponse<MailAlias>>('/mail/aliases', data);
    return res.data.data!;
  },
  async updateAlias(id: number, data: MailAliasUpdate): Promise<MailAlias> {
    const res = await apiClient.put<ApiResponse<MailAlias>>(`/mail/aliases/${id}`, data);
    return res.data.data!;
  },
  async deleteAlias(id: number): Promise<void> {
    await apiClient.delete(`/mail/aliases/${id}`);
  },

  // ── DNS / DKIM ──
  async dnsStatus(mailDomainId: number): Promise<MailDnsStatus> {
    const res = await apiClient.get<ApiResponse<MailDnsStatus>>(`/mail/domains/${mailDomainId}/dns`);
    return res.data.data!;
  },
  async dnsCheck(mailDomainId: number): Promise<MailDnsStatus> {
    const res = await apiClient.post<ApiResponse<MailDnsStatus>>(`/mail/domains/${mailDomainId}/dns/check`);
    return res.data.data!;
  },
  async updateDnsSettings(mailDomainId: number, data: MailDomainDnsUpdate): Promise<MailDnsStatus> {
    const res = await apiClient.put<ApiResponse<MailDnsStatus>>(`/mail/domains/${mailDomainId}/dns-settings`, data);
    return res.data.data!;
  },
  async dkimKeys(mailDomainId: number): Promise<DkimKey[]> {
    const res = await apiClient.get<ApiResponse<DkimKey[]>>(`/mail/domains/${mailDomainId}/dkim`);
    return res.data.data ?? [];
  },
  async rotateDkim(mailDomainId: number, algorithm?: DkimAlgorithm): Promise<DkimKey[]> {
    const res = await apiClient.post<ApiResponse<DkimKey[]>>(`/mail/domains/${mailDomainId}/dkim/rotate`, algorithm ? { algorithm } : {});
    return res.data.data ?? [];
  },

  // ── outbound / queue / logs / relay ──
  async outbound(accountId: number): Promise<MailOutboundState> {
    const res = await apiClient.get<ApiResponse<MailOutboundState>>('/mail/outbound', { params: { accountId } });
    return res.data.data!;
  },
  async suspendOutbound(accountId: number, reason?: string | null): Promise<MailOutboundState> {
    const res = await apiClient.post<ApiResponse<MailOutboundState>>(`/mail/outbound/${accountId}/suspend`, { reason: reason ?? null });
    return res.data.data!;
  },
  async resumeOutbound(accountId: number): Promise<MailOutboundState> {
    const res = await apiClient.post<ApiResponse<MailOutboundState>>(`/mail/outbound/${accountId}/resume`);
    return res.data.data!;
  },
  async queue(params: { accountId?: number; tenantId?: number; limit?: number; offset?: number } = {}): Promise<{ items: MailQueueItem[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: MailQueueItem[]; total: number }>>('/mail/queue', { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async queueAction(queueId: string, action: 'retry' | 'delete'): Promise<void> {
    await apiClient.post(`/mail/queue/${encodeURIComponent(queueId)}/${action}`);
  },
  async logs(params: MailLogParams = {}): Promise<{ items: MailLogEntry[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: MailLogEntry[]; total: number }>>('/mail/logs', { params });
    return res.data.data ?? { items: [], total: 0 };
  },
  async relays(accountId: number): Promise<SiteMailRelay[]> {
    const res = await apiClient.get<ApiResponse<SiteMailRelay[]>>('/mail/relays', { params: { accountId } });
    return res.data.data ?? [];
  },
  async siteRelay(siteId: number): Promise<SiteMailRelay> {
    const res = await apiClient.get<ApiResponse<SiteMailRelay>>(`/sites/${siteId}/mail-relay`);
    return res.data.data!;
  },
  async updateSiteRelay(siteId: number, data: SiteMailRelayUpdate): Promise<SiteMailRelay> {
    const res = await apiClient.put<ApiResponse<SiteMailRelay>>(`/sites/${siteId}/mail-relay`, data);
    return res.data.data!;
  },
  async rotateSiteRelay(siteId: number): Promise<SiteMailRelay> {
    const res = await apiClient.post<ApiResponse<SiteMailRelay>>(`/sites/${siteId}/mail-relay/rotate`);
    return res.data.data!;
  },
};

/** Platform admin (/api/system/mail). */
export const systemMailApi = {
  async status(): Promise<MailSystemStatus> {
    const res = await apiClient.get<ApiResponse<MailSystemStatus>>('/system/mail');
    return res.data.data!;
  },
  async sync(force = false): Promise<MailSystemStatus> {
    const res = await apiClient.post<ApiResponse<MailSystemStatus>>('/system/mail/sync', { force });
    return res.data.data!;
  },
  async changeEngine(engine: MailEngine): Promise<MailSystemStatus> {
    const res = await apiClient.put<ApiResponse<MailSystemStatus>>('/system/mail/engine', { engine });
    return res.data.data!;
  },
  async bans(): Promise<MailBan[]> {
    const res = await apiClient.get<ApiResponse<MailBan[]>>('/system/mail/bans');
    return res.data.data ?? [];
  },
  async unban(id: number): Promise<void> {
    await apiClient.delete(`/system/mail/bans/${id}`);
  },
  async relayTest(): Promise<OpenRelayTestResult> {
    const res = await apiClient.post<ApiResponse<OpenRelayTestResult>>('/system/mail/relay-test');
    return res.data.data!;
  },
};
