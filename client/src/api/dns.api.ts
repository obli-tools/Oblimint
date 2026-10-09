import apiClient from './client';
import type {
  ApiResponse, DnsDelegationCheck, DnsRecord, DnsRecordInput, DnsServerStatus, DnsTemplate, DnsTemplateInput, DnsZone,
  DnsZoneCreate, DnsZoneDetail, DnsZoneUpdate,
} from '@oblimint/shared';

// /api/dns + /api/system/dns — docs/P2-PLAN.md §6.1. OWNED BY MODULE `ui-dns-db`
// (posed by the architect: complete thin wrappers of the server contract).
export const dnsApi = {
  async listZones(params: { accountId?: number; search?: string; tenantId?: number; platform?: boolean } = {}): Promise<DnsZone[]> {
    const res = await apiClient.get<ApiResponse<DnsZone[]>>('/dns/zones', { params: { ...params, platform: params.platform ? 1 : undefined } });
    return res.data.data ?? [];
  },
  async getZone(id: number): Promise<DnsZoneDetail> {
    const res = await apiClient.get<ApiResponse<DnsZoneDetail>>(`/dns/zones/${id}`);
    return res.data.data!;
  },
  async createZone(data: DnsZoneCreate): Promise<DnsZone> {
    const res = await apiClient.post<ApiResponse<DnsZone>>('/dns/zones', data);
    return res.data.data!;
  },
  async updateZone(id: number, data: DnsZoneUpdate): Promise<DnsZoneDetail> {
    const res = await apiClient.put<ApiResponse<DnsZoneDetail>>(`/dns/zones/${id}`, data);
    return res.data.data!;
  },
  async deleteZone(id: number): Promise<void> {
    await apiClient.delete(`/dns/zones/${id}`);
  },
  async resetZone(id: number, keepManual: boolean): Promise<DnsZoneDetail> {
    const res = await apiClient.post<ApiResponse<DnsZoneDetail>>(`/dns/zones/${id}/reset`, { keepManual });
    return res.data.data!;
  },
  async applyTemplate(id: number, templateId: number): Promise<DnsZoneDetail> {
    const res = await apiClient.post<ApiResponse<DnsZoneDetail>>(`/dns/zones/${id}/apply-template`, { templateId });
    return res.data.data!;
  },
  async exportZone(id: number): Promise<string> {
    const res = await apiClient.get<string>(`/dns/zones/${id}/export`, { responseType: 'text', transformResponse: (d) => d });
    return res.data;
  },
  async checkDelegation(id: number): Promise<DnsDelegationCheck> {
    const res = await apiClient.get<ApiResponse<DnsDelegationCheck>>(`/dns/zones/${id}/delegation`);
    return res.data.data!;
  },

  // ── records ──
  async createRecord(zoneId: number, data: DnsRecordInput): Promise<DnsRecord> {
    const res = await apiClient.post<ApiResponse<DnsRecord>>(`/dns/zones/${zoneId}/records`, data);
    return res.data.data!;
  },
  async updateRecord(zoneId: number, recordId: number, data: DnsRecordInput): Promise<DnsRecord> {
    const res = await apiClient.put<ApiResponse<DnsRecord>>(`/dns/zones/${zoneId}/records/${recordId}`, data);
    return res.data.data!;
  },
  async deleteRecord(zoneId: number, recordId: number): Promise<void> {
    await apiClient.delete(`/dns/zones/${zoneId}/records/${recordId}`);
  },

  // ── templates ──
  async listTemplates(params: { tenantId?: number } = {}): Promise<DnsTemplate[]> {
    const res = await apiClient.get<ApiResponse<DnsTemplate[]>>('/dns/templates', { params });
    return res.data.data ?? [];
  },
  async createTemplate(data: DnsTemplateInput): Promise<DnsTemplate> {
    const res = await apiClient.post<ApiResponse<DnsTemplate>>('/dns/templates', data);
    return res.data.data!;
  },
  async updateTemplate(id: number, data: Partial<DnsTemplateInput>): Promise<DnsTemplate> {
    const res = await apiClient.put<ApiResponse<DnsTemplate>>(`/dns/templates/${id}`, data);
    return res.data.data!;
  },
  async deleteTemplate(id: number): Promise<void> {
    await apiClient.delete(`/dns/templates/${id}`);
  },

  // ── platform (admin) ──
  async serverStatus(): Promise<DnsServerStatus> {
    const res = await apiClient.get<ApiResponse<DnsServerStatus>>('/system/dns');
    return res.data.data!;
  },
  async syncAll(): Promise<DnsServerStatus> {
    const res = await apiClient.post<ApiResponse<DnsServerStatus>>('/system/dns/sync');
    return res.data.data!;
  },
};
