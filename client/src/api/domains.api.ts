import apiClient from './client';
import type {
  ApiResponse, CertificateDetail, Domain, DomainCreate, DomainUpdate, SiteRoute, SiteRouteInput,
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
