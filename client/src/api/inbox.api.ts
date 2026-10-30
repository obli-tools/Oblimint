import apiClient from './client';
import type {
  ApiResponse, NotificationFamily, TransactionalMailLogEntry, TransactionalMailSettings, TransactionalMailSettingsInput, TransactionalMailTestResult,
  UserNotificationPage, UserNotificationPrefsInput, UserNotificationSettings,
} from '@oblimint/shared';

// /api/notifications/inbox + /preferences (the signed-in user, current tenant) and
// /api/system/transactional-mail (platform admin) — server/src/routes/notifications.routes.ts,
// systemTransactionalMail.routes.ts.
export const inboxApi = {
  async list(params: { unread?: boolean; family?: NotificationFamily | null; before?: number | null; limit?: number } = {}): Promise<UserNotificationPage> {
    const res = await apiClient.get<ApiResponse<UserNotificationPage>>('/notifications/inbox', {
      params: { unread: params.unread ? 1 : undefined, family: params.family ?? undefined, before: params.before ?? undefined, limit: params.limit },
    });
    return res.data.data!;
  },
  async unreadCount(): Promise<number> {
    const res = await apiClient.get<ApiResponse<{ unreadCount: number }>>('/notifications/inbox/unread-count');
    return res.data.data?.unreadCount ?? 0;
  },
  async markRead(ids: number[]): Promise<{ updated: number; unreadCount: number }> {
    const res = await apiClient.post<ApiResponse<{ updated: number; unreadCount: number }>>('/notifications/inbox/read', { ids });
    return res.data.data!;
  },
  async markUnread(ids: number[]): Promise<{ updated: number; unreadCount: number }> {
    const res = await apiClient.post<ApiResponse<{ updated: number; unreadCount: number }>>('/notifications/inbox/unread', { ids });
    return res.data.data!;
  },
  async markAllRead(): Promise<{ updated: number; unreadCount: number }> {
    const res = await apiClient.post<ApiResponse<{ updated: number; unreadCount: number }>>('/notifications/inbox/read-all');
    return res.data.data!;
  },
  async remove(ids: number[]): Promise<{ deleted: number; unreadCount: number }> {
    const res = await apiClient.post<ApiResponse<{ deleted: number; unreadCount: number }>>('/notifications/inbox/delete', { ids });
    return res.data.data!;
  },
  async preferences(): Promise<UserNotificationSettings> {
    const res = await apiClient.get<ApiResponse<UserNotificationSettings>>('/notifications/preferences');
    return res.data.data!;
  },
  async savePreferences(input: UserNotificationPrefsInput): Promise<UserNotificationSettings> {
    const res = await apiClient.put<ApiResponse<UserNotificationSettings>>('/notifications/preferences', input);
    return res.data.data!;
  },
};

export const transactionalMailApi = {
  async get(): Promise<TransactionalMailSettings> {
    const res = await apiClient.get<ApiResponse<TransactionalMailSettings>>('/system/transactional-mail');
    return res.data.data!;
  },
  async update(input: TransactionalMailSettingsInput): Promise<TransactionalMailSettings> {
    const res = await apiClient.put<ApiResponse<TransactionalMailSettings>>('/system/transactional-mail', input);
    return res.data.data!;
  },
  async test(to: string): Promise<TransactionalMailTestResult> {
    const res = await apiClient.post<ApiResponse<TransactionalMailTestResult>>('/system/transactional-mail/test', { to });
    return res.data.data!;
  },
  async log(limit = 20): Promise<TransactionalMailLogEntry[]> {
    const res = await apiClient.get<ApiResponse<TransactionalMailLogEntry[]>>('/system/transactional-mail/log', { params: { limit } });
    return res.data.data ?? [];
  },
};
