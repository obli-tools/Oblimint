import apiClient from './client';
import type {
  AccountClientUser, AccountClientUserAdd, AccountSshKey, ApiResponse, ClientCapability, ClientUserCandidate, FileAccessInfo,
  FileAccessPasswordResult, FileAccessUpdate, FileServerStatus, HostingAccount, HostingAccountCreate,
  HostingAccountStatus, HostingAccountUpdate, SshKeyInput,
} from '@oblimint/shared';

// /api/accounts (+ /users, /file-access, /filesrv) — docs/P1-PLAN.md §API.
// OWNED BY MODULE `ui-hosting` (ui-sites consumes fileAccess / fileServer).
export const accountsApi = {
  async list(params: { search?: string; status?: HostingAccountStatus; tenantId?: number } = {}): Promise<HostingAccount[]> {
    const res = await apiClient.get<ApiResponse<HostingAccount[]>>('/accounts', { params });
    return res.data.data ?? [];
  },

  async get(id: number): Promise<HostingAccount> {
    const res = await apiClient.get<ApiResponse<HostingAccount>>(`/accounts/${id}`);
    return res.data.data!;
  },

  async create(data: HostingAccountCreate): Promise<HostingAccount> {
    const res = await apiClient.post<ApiResponse<HostingAccount>>('/accounts', data);
    return res.data.data!;
  },

  async update(id: number, data: HostingAccountUpdate): Promise<HostingAccount> {
    const res = await apiClient.put<ApiResponse<HostingAccount>>(`/accounts/${id}`, data);
    return res.data.data!;
  },

  async suspend(id: number): Promise<HostingAccount> {
    const res = await apiClient.post<ApiResponse<HostingAccount>>(`/accounts/${id}/suspend`);
    return res.data.data!;
  },

  async unsuspend(id: number): Promise<HostingAccount> {
    const res = await apiClient.post<ApiResponse<HostingAccount>>(`/accounts/${id}/unsuspend`);
    return res.data.data!;
  },

  async refreshUsage(id: number): Promise<HostingAccount> {
    const res = await apiClient.post<ApiResponse<HostingAccount>>(`/accounts/${id}/usage/refresh`);
    return res.data.data!;
  },

  /** `confirm` must equal the account username. */
  async delete(id: number, confirm: string): Promise<void> {
    await apiClient.delete(`/accounts/${id}`, { data: { confirm } });
  },

  // ── Client users ───────────────────────────────────────────────────────────
  async listUsers(id: number): Promise<AccountClientUser[]> {
    const res = await apiClient.get<ApiResponse<AccountClientUser[]>>(`/accounts/${id}/users`);
    return res.data.data ?? [];
  },

  /** Client users of the account's workspace that "attach existing" may pick. */
  async listUserCandidates(id: number): Promise<ClientUserCandidate[]> {
    const res = await apiClient.get<ApiResponse<ClientUserCandidate[]>>(`/accounts/${id}/users/candidates`);
    return res.data.data ?? [];
  },

  async addUser(id: number, data: AccountClientUserAdd): Promise<AccountClientUser> {
    const res = await apiClient.post<ApiResponse<AccountClientUser>>(`/accounts/${id}/users`, data);
    return res.data.data!;
  },

  async updateUser(id: number, userId: number, capabilities: ClientCapability[]): Promise<AccountClientUser> {
    const res = await apiClient.put<ApiResponse<AccountClientUser>>(`/accounts/${id}/users/${userId}`, { capabilities });
    return res.data.data!;
  },

  async removeUser(id: number, userId: number, deleteUser = false): Promise<void> {
    await apiClient.delete(`/accounts/${id}/users/${userId}`, { params: deleteUser ? { deleteUser: 'true' } : {} });
  },

  // ── File access (SFTP credentials) ─────────────────────────────────────────
  async fileAccess(id: number): Promise<FileAccessInfo> {
    const res = await apiClient.get<ApiResponse<FileAccessInfo>>(`/accounts/${id}/file-access`);
    return res.data.data!;
  },

  async updateFileAccess(id: number, data: FileAccessUpdate): Promise<FileAccessInfo> {
    const res = await apiClient.put<ApiResponse<FileAccessInfo>>(`/accounts/${id}/file-access`, data);
    return res.data.data!;
  },

  /** Generates a new SFTP password, returned ONCE. */
  async resetFilePassword(id: number): Promise<FileAccessPasswordResult> {
    const res = await apiClient.post<ApiResponse<FileAccessPasswordResult>>(`/accounts/${id}/file-access/password`);
    return res.data.data!;
  },

  async disableFilePassword(id: number): Promise<FileAccessInfo> {
    const res = await apiClient.delete<ApiResponse<FileAccessInfo>>(`/accounts/${id}/file-access/password`);
    return res.data.data!;
  },

  async addSshKey(id: number, data: SshKeyInput): Promise<AccountSshKey> {
    const res = await apiClient.post<ApiResponse<AccountSshKey>>(`/accounts/${id}/file-access/keys`, data);
    return res.data.data!;
  },

  async deleteSshKey(id: number, keyId: number): Promise<void> {
    await apiClient.delete(`/accounts/${id}/file-access/keys/${keyId}`);
  },

  // ── File server container (on-demand activation) ───────────────────────────
  async fileServer(id: number): Promise<FileServerStatus> {
    const res = await apiClient.get<ApiResponse<FileServerStatus>>(`/accounts/${id}/filesrv`);
    return res.data.data!;
  },

  async activateFileServer(id: number, minutes: number): Promise<FileServerStatus> {
    const res = await apiClient.post<ApiResponse<FileServerStatus>>(`/accounts/${id}/filesrv/activate`, { minutes });
    return res.data.data!;
  },

  async deactivateFileServer(id: number): Promise<FileServerStatus> {
    const res = await apiClient.post<ApiResponse<FileServerStatus>>(`/accounts/${id}/filesrv/deactivate`);
    return res.data.data!;
  },
};
