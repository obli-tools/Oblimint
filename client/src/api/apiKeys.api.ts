import apiClient from './client';
import type { ApiKey, ApiKeyCreate, ApiKeyCreated, ApiKeyGrantable, ApiKeyUpdate, ApiResponse, OAuthAuthorizeInfo } from '@oblimint/shared';

// /api/accounts/:id/api-keys — access keys of an account (API /api/v1 and MCP server /mcp).
export const apiKeysApi = {
  async list(accountId: number): Promise<ApiKey[]> {
    const res = await apiClient.get<ApiResponse<ApiKey[]>>(`/accounts/${accountId}/api-keys`);
    return res.data.data ?? [];
  },

  /** Scopes the caller may grant on the account (greyed / presets of the key form); the server re-checks every save. */
  async grantable(accountId: number): Promise<ApiKeyGrantable> {
    const res = await apiClient.get<ApiResponse<ApiKeyGrantable>>(`/accounts/${accountId}/api-keys/grantable`);
    return res.data.data!;
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

  /** Connector: new client secret (shown once). */
  async rotateSecret(accountId: number, keyId: number): Promise<ApiKeyCreated> {
    const res = await apiClient.post<ApiResponse<ApiKeyCreated>>(`/accounts/${accountId}/api-keys/${keyId}/rotate-secret`, {});
    return res.data.data!;
  },

  /** Connector: ends one authorization (or all of them without `connectionId`). */
  async disconnect(accountId: number, keyId: number, connectionId?: string): Promise<void> {
    await apiClient.delete(`/accounts/${accountId}/api-keys/${keyId}/connections${connectionId ? `/${connectionId}` : ''}`);
  },
};

// /api/oauth — consent page of the Claude connectors (OAuth authorization).
export const oauthApi = {
  async info(query: string): Promise<OAuthAuthorizeInfo> {
    const res = await apiClient.get<ApiResponse<OAuthAuthorizeInfo>>(`/oauth/authorize${query}`);
    return res.data.data!;
  },

  async decide(params: Record<string, string>, approve: boolean): Promise<string> {
    const res = await apiClient.post<ApiResponse<{ redirectUrl: string }>>('/oauth/authorize', { ...params, approve });
    return res.data.data!.redirectUrl;
  },
};
