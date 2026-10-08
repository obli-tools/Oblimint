import type { User, UserPreferences } from '@oblimint/shared';

/** Columns of `users` read by rowToUser (never the hash or the TOTP secret out of the server). */
export interface UserRow {
  id: number;
  username: string;
  password_hash?: string | null;
  display_name: string | null;
  role: string;
  kind?: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  preferences?: UserPreferences | string | null;
  email?: string | null;
  preferred_language?: string | null;
  totp_enabled?: boolean;
  foreign_source?: string | null;
  foreign_id?: number | null;
  foreign_source_url?: string | null;
  avatar?: string | null;
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

export function rowToUser(row: UserRow): User {
  let prefs: UserPreferences = {};
  if (row.preferences) {
    try { prefs = typeof row.preferences === 'string' ? JSON.parse(row.preferences) : row.preferences; } catch { prefs = {}; }
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    kind: row.kind === 'client' ? 'client' : 'staff',
    isActive: row.is_active,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    preferences: prefs,
    totpEnabled: row.totp_enabled ?? false,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    foreignSource: row.foreign_source ?? null,
    foreignId: row.foreign_id ?? null,
    foreignSourceUrl: row.foreign_source_url ?? null,
    hasPassword: !!row.password_hash,
    avatar: row.avatar ?? null,
  };
}
