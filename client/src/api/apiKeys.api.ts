import apiClient from './client';
import type { ApiKey, ApiKeyCreate, ApiKeyCreated, ApiKeyUpdate, ApiResponse } from '@oblimint/shared';

// /api/accounts/:id/api-keys — access keys of an account (API /api/v1 and MCP server /mcp).
export const apiKeysApi = {
  async list(accountId: number): Promise<ApiKey[]> {
    const res = await apiClient.get<ApiResponse<ApiKey[]>>(`/accounts/${accountId}/api-keys`);
    return res.data.data ?? [];
  },

  async create(accountId: number, body: ApiKeyCreate): Promise<ApiKeyCreated> {
    const res = await apiClient.post<ApiResponse<ApiKeyCreated>>(`/accounts/${accountId}/api-keys`, body);
    return res.data.data!;
  },

  async update(accountId: number, keyId: number, body: ApiKeyUpdate): Promise<ApiKey> {
    const res = await apiClient.put<ApiResponse<ApiKey>>(`/accounts/${accountId}/api-keys/${keyId}`, body);
    return res.data.data!;
  },

  async remove(accountId: number, keyId: number): Promise<void> {
    await apiClient.delete(`/accounts/${accountId}/api-keys/${keyId}`);
  },
};
