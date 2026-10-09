import apiClient from './client';
import type {
  ApiResponse, CertificateDetail, Domain, DomainClaim, DomainClaimCreate, DomainCreate, DomainUpdate, DomainVerification, SiteRoute,
  SiteRouteInput,
} from '@oblimint/shared';

// /api/domains (+ /routes, /certificate) — docs/P1-PLAN.md §API.
// OWNED BY MODULE `ui-hosting` (ui-sites consumes the route calls).
export const domainsApi = {
  async list(params: { accountId?: number; search?: string } = {}): Promise<Domain[]> {
    const res = await apiClient.get<ApiResponse<Domain[]>>('/domains', { params });
    return res.data.data ?? [];
  },

  async get(id: number): Promise<Domain> {
    const res = await apiClient.get<ApiResponse<Domain>>(`/domains/${id}`);
    return res.data.data!;
  },

  async create(data: DomainCreate): Promise<Domain> {
    const res = await apiClient.post<ApiResponse<Domain>>('/domains', data);
    return res.data.data!;
  },

  async update(id: number, data: DomainUpdate): Promise<Domain> {
    const res = await apiClient.put<ApiResponse<Domain>>(`/domains/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/domains/${id}`);
  },

  // ── Route table ────────────────────────────────────────────────────────────
  async addRoute(domainId: number, data: SiteRouteInput): Promise<SiteRoute> {
    const res = await apiClient.post<ApiResponse<SiteRoute>>(`/domains/${domainId}/routes`, data);
    return res.data.data!;
  },

  async updateRoute(domainId: number, routeId: number, data: SiteRouteInput): Promise<SiteRoute> {
    const res = await apiClient.put<ApiResponse<SiteRoute>>(`/domains/${domainId}/routes/${routeId}`, data);
    return res.data.data!;
  },

  async deleteRoute(domainId: number, routeId: number): Promise<void> {
    await apiClient.delete(`/domains/${domainId}/routes/${routeId}`);
  },

  // ── Certificate ────────────────────────────────────────────────────────────
  async certificate(domainId: number): Promise<CertificateDetail | null> {
    const res = await apiClient.get<ApiResponse<CertificateDetail | null>>(`/domains/${domainId}/certificate`);
    return res.data.data ?? null;
  },

  async renewCertificate(domainId: number, force = false): Promise<CertificateDetail> {
    const res = await apiClient.post<ApiResponse<CertificateDetail>>(`/domains/${domainId}/certificate/renew`, { force });
    return res.data.data!;
  },
};

// ── P2 ownership (docs/P2-PLAN.md §6.2) — module ui-dns-db owns this file in P2 ──
export const domainOwnershipApi = {
  async verification(domainId: number): Promise<DomainVerification> {
    const res = await apiClient.get<ApiResponse<DomainVerification>>(`/domains/${domainId}/verification`);
    return res.data.data!;
  },
  async check(domainId: number): Promise<DomainVerification> {
    const res = await apiClient.post<ApiResponse<DomainVerification>>(`/domains/${domainId}/verification/check`);
    return res.data.data!;
  },
  /** Platform admin only. */
  async force(domainId: number): Promise<DomainVerification> {
    const res = await apiClient.post<ApiResponse<DomainVerification>>(`/domains/${domainId}/verification/force`);
    return res.data.data!;
  },
  async listClaims(accountId?: number): Promise<DomainClaim[]> {
    const res = await apiClient.get<ApiResponse<DomainClaim[]>>('/domains/claims', { params: { accountId } });
    return res.data.data ?? [];
  },
  async createClaim(data: DomainClaimCreate): Promise<DomainClaim> {
    const res = await apiClient.post<ApiResponse<DomainClaim>>('/domains/claims', data);
    return res.data.data!;
  },
  async checkClaim(claimId: number): Promise<DomainClaim> {
    const res = await apiClient.post<ApiResponse<DomainClaim>>(`/domains/claims/${claimId}/check`);
    return res.data.data!;
  },
  async cancelClaim(claimId: number): Promise<void> {
    await apiClient.delete(`/domains/claims/${claimId}`);
  },
};
