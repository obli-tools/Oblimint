import apiClient from './client';
import type {
  AccessList, AccessListInput, AccessListUpdate, AdvancedConfigLintResult, ApiResponse, AppStack, AppStackDetail, AuthProvider,
  AuthProviderInput, AuthProviderUpdate, CertificateListItem, CertificateStatus, CustomPage, CustomPageInput, CustomPagePreviewRequest,
  CustomPageUpdate, ImportedCertificate, ImportedCertificateInput, ProxyDeadHost, ProxyDeadHostInput, ProxyDeadHostUpdate, ProxyHost,
  ProxyHostInput, ProxyHostUpdate, ProxyQuickSetupRequest, ProxyRedirection, ProxyRedirectionInput, ProxyRedirectionUpdate, ProxyStream,
  ProxyStreamInput, ProxyStreamUpdate,
} from '@oblimint/shared';

// /api/proxy (hosts, redirections, dead hosts, streams, access lists, custom
// pages, auth providers, certificates, advanced-config lint) — docs/P4b-PLAN.md
// §6.3, contract frozen in server/src/routes/proxy.routes.ts. OWNED BY MODULE
// `ui-proxy`: complete thin typed wrappers of every route of the contract.

export interface ProxyListParams {
  accountId?: number;
  tenantId?: number;
}

export interface StreamPortInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  /** Stream id using the port, null = free. */
  usedBy: number | null;
}

/** `?force=1` on the deletes that refuse an object still in use (409 …InUse). */
const forceParams = (force: boolean) => (force ? { force: 1 } : undefined);

export const proxyApi = {
  // ── proxy hosts ──
  async listHosts(params: ProxyListParams & { search?: string } = {}): Promise<ProxyHost[]> {
    const res = await apiClient.get<ApiResponse<ProxyHost[]>>('/proxy/hosts', { params });
    return res.data.data ?? [];
  },
  async getHost(id: number): Promise<ProxyHost> {
    const res = await apiClient.get<ApiResponse<ProxyHost>>(`/proxy/hosts/${id}`);
    return res.data.data!;
  },
  async createHost(data: ProxyHostInput): Promise<ProxyHost> {
    const res = await apiClient.post<ApiResponse<ProxyHost>>('/proxy/hosts', data);
    return res.data.data!;
  },
  async quickSetup(data: ProxyQuickSetupRequest): Promise<ProxyHost> {
    const res = await apiClient.post<ApiResponse<ProxyHost>>('/proxy/hosts/quick-setup', data);
    return res.data.data!;
  },
  async updateHost(id: number, data: ProxyHostUpdate): Promise<ProxyHost> {
    const res = await apiClient.put<ApiResponse<ProxyHost>>(`/proxy/hosts/${id}`, data);
    return res.data.data!;
  },
  async deleteHost(id: number): Promise<void> {
    await apiClient.delete(`/proxy/hosts/${id}`);
  },
  /** Re-validate + apply the host's edge unit now ("Restore"). */
  async retryHost(id: number): Promise<ProxyHost> {
    const res = await apiClient.post<ApiResponse<ProxyHost>>(`/proxy/hosts/${id}/retry`);
    return res.data.data!;
  },

  // ── redirections ──
  async listRedirections(params: ProxyListParams = {}): Promise<ProxyRedirection[]> {
    const res = await apiClient.get<ApiResponse<ProxyRedirection[]>>('/proxy/redirections', { params });
    return res.data.data ?? [];
  },
  async getRedirection(id: number): Promise<ProxyRedirection> {
    const res = await apiClient.get<ApiResponse<ProxyRedirection>>(`/proxy/redirections/${id}`);
    return res.data.data!;
  },
  async createRedirection(data: ProxyRedirectionInput): Promise<ProxyRedirection> {
    const res = await apiClient.post<ApiResponse<ProxyRedirection>>('/proxy/redirections', data);
    return res.data.data!;
  },
  async updateRedirection(id: number, data: ProxyRedirectionUpdate): Promise<ProxyRedirection> {
    const res = await apiClient.put<ApiResponse<ProxyRedirection>>(`/proxy/redirections/${id}`, data);
    return res.data.data!;
  },
  async deleteRedirection(id: number): Promise<void> {
    await apiClient.delete(`/proxy/redirections/${id}`);
  },

  // ── dead hosts ──
  async listDeadHosts(params: ProxyListParams = {}): Promise<ProxyDeadHost[]> {
    const res = await apiClient.get<ApiResponse<ProxyDeadHost[]>>('/proxy/dead-hosts', { params });
    return res.data.data ?? [];
  },
  async getDeadHost(id: number): Promise<ProxyDeadHost> {
    const res = await apiClient.get<ApiResponse<ProxyDeadHost>>(`/proxy/dead-hosts/${id}`);
    return res.data.data!;
  },
  async createDeadHost(data: ProxyDeadHostInput): Promise<ProxyDeadHost> {
    const res = await apiClient.post<ApiResponse<ProxyDeadHost>>('/proxy/dead-hosts', data);
    return res.data.data!;
  },
  async updateDeadHost(id: number, data: ProxyDeadHostUpdate): Promise<ProxyDeadHost> {
    const res = await apiClient.put<ApiResponse<ProxyDeadHost>>(`/proxy/dead-hosts/${id}`, data);
    return res.data.data!;
  },
  async deleteDeadHost(id: number): Promise<void> {
    await apiClient.delete(`/proxy/dead-hosts/${id}`);
  },

  // ── streams (staff) ──
  async listStreams(params: ProxyListParams = {}): Promise<ProxyStream[]> {
    const res = await apiClient.get<ApiResponse<ProxyStream[]>>('/proxy/streams', { params });
    return res.data.data ?? [];
  },
  async getStream(id: number): Promise<ProxyStream> {
    const res = await apiClient.get<ApiResponse<ProxyStream>>(`/proxy/streams/${id}`);
    return res.data.data!;
  },
  async createStream(data: ProxyStreamInput): Promise<ProxyStream> {
    const res = await apiClient.post<ApiResponse<ProxyStream>>('/proxy/streams', data);
    return res.data.data!;
  },
  async updateStream(id: number, data: ProxyStreamUpdate): Promise<ProxyStream> {
    const res = await apiClient.put<ApiResponse<ProxyStream>>(`/proxy/streams/${id}`, data);
    return res.data.data!;
  },
  async deleteStream(id: number): Promise<void> {
    await apiClient.delete(`/proxy/streams/${id}`);
  },
  /** Platform-approved stream ports (settings edge.streamPorts) and their use. */
  async streamPorts(): Promise<StreamPortInfo[]> {
    const res = await apiClient.get<ApiResponse<StreamPortInfo[]>>('/proxy/stream-ports');
    return res.data.data ?? [];
  },

  // ── access lists ──
  async listAccessLists(params: ProxyListParams = {}): Promise<AccessList[]> {
    const res = await apiClient.get<ApiResponse<AccessList[]>>('/proxy/access-lists', { params });
    return res.data.data ?? [];
  },
  async getAccessList(id: number): Promise<AccessList> {
    const res = await apiClient.get<ApiResponse<AccessList>>(`/proxy/access-lists/${id}`);
    return res.data.data!;
  },
  async createAccessList(data: AccessListInput): Promise<AccessList> {
    const res = await apiClient.post<ApiResponse<AccessList>>('/proxy/access-lists', data);
    return res.data.data!;
  },
  async updateAccessList(id: number, data: AccessListUpdate): Promise<AccessList> {
    const res = await apiClient.put<ApiResponse<AccessList>>(`/proxy/access-lists/${id}`, data);
    return res.data.data!;
  },
  /** 409 accessListInUse unless force (the hosts / routes using it lose it). */
  async deleteAccessList(id: number, force = false): Promise<void> {
    await apiClient.delete(`/proxy/access-lists/${id}`, { params: forceParams(force) });
  },

  // ── custom pages ──
  /** Account pages + the platform pages of the tenant (read-only for a client). */
  async listCustomPages(params: ProxyListParams = {}): Promise<CustomPage[]> {
    const res = await apiClient.get<ApiResponse<CustomPage[]>>('/proxy/custom-pages', { params });
    return res.data.data ?? [];
  },
  async getCustomPage(id: number): Promise<CustomPage> {
    const res = await apiClient.get<ApiResponse<CustomPage>>(`/proxy/custom-pages/${id}`);
    return res.data.data!;
  },
  async createCustomPage(data: CustomPageInput): Promise<CustomPage> {
    const res = await apiClient.post<ApiResponse<CustomPage>>('/proxy/custom-pages', data);
    return res.data.data!;
  },
  async updateCustomPage(id: number, data: CustomPageUpdate): Promise<CustomPage> {
    const res = await apiClient.put<ApiResponse<CustomPage>>(`/proxy/custom-pages/${id}`, data);
    return res.data.data!;
  },
  /** 409 customPageInUse while the page is used (no force for pages). */
  async deleteCustomPage(id: number): Promise<void> {
    await apiClient.delete(`/proxy/custom-pages/${id}`);
  },
  /** Rendered HTML (placeholders replaced) — shown in a sandboxed iframe only. */
  async previewCustomPage(data: CustomPagePreviewRequest): Promise<string> {
    const res = await apiClient.post<ApiResponse<{ html: string }>>('/proxy/custom-pages/preview', data);
    return res.data.data?.html ?? '';
  },

  // ── forward-auth providers ──
  async listAuthProviders(params: ProxyListParams = {}): Promise<AuthProvider[]> {
    const res = await apiClient.get<ApiResponse<AuthProvider[]>>('/proxy/auth-providers', { params });
    return res.data.data ?? [];
  },
  async getAuthProvider(id: number): Promise<AuthProvider> {
    const res = await apiClient.get<ApiResponse<AuthProvider>>(`/proxy/auth-providers/${id}`);
    return res.data.data!;
  },
  async createAuthProvider(data: AuthProviderInput): Promise<AuthProvider> {
    const res = await apiClient.post<ApiResponse<AuthProvider>>('/proxy/auth-providers', data);
    return res.data.data!;
  },
  async updateAuthProvider(id: number, data: AuthProviderUpdate): Promise<AuthProvider> {
    const res = await apiClient.put<ApiResponse<AuthProvider>>(`/proxy/auth-providers/${id}`, data);
    return res.data.data!;
  },
  async deleteAuthProvider(id: number): Promise<void> {
    await apiClient.delete(`/proxy/auth-providers/${id}`);
  },

  // ── certificates ──
  async listCertificates(params: ProxyListParams & { status?: CertificateStatus } = {}): Promise<CertificateListItem[]> {
    const res = await apiClient.get<ApiResponse<CertificateListItem[]>>('/proxy/certificates', { params });
    return res.data.data ?? [];
  },
  async importCertificate(data: ImportedCertificateInput): Promise<ImportedCertificate> {
    const res = await apiClient.post<ApiResponse<ImportedCertificate>>('/proxy/certificates/import', data);
    return res.data.data!;
  },
  async deleteImportedCertificate(id: number): Promise<void> {
    await apiClient.delete(`/proxy/certificates/imported/${id}`);
  },

  // ── advanced config (platform staff) ──
  async lintAdvancedConfig(text: string): Promise<AdvancedConfigLintResult> {
    const res = await apiClient.post<ApiResponse<AdvancedConfigLintResult>>('/proxy/advanced-config/lint', { text });
    return res.data.data!;
  },
};

/**
 * Read-only lookups of the app stacks targeted by a proxy host (contract of
 * module apps-core, server/src/routes/apps.routes.ts: GET /apps/stacks and
 * GET /apps/stacks/:id). Kept here so the proxy UI does not depend on the
 * wrappers of ui-apps, written in parallel.
 */
export const proxyAppsLookup = {
  async stacks(params: ProxyListParams = {}): Promise<AppStack[]> {
    const res = await apiClient.get<ApiResponse<AppStack[]>>('/apps/stacks', { params });
    return res.data.data ?? [];
  },
  async stack(id: number): Promise<AppStackDetail> {
    const res = await apiClient.get<ApiResponse<AppStackDetail>>(`/apps/stacks/${id}`);
    return res.data.data!;
  },
};
