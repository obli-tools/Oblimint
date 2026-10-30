// =============================================================================
// Client-local types — shapes the client relies on that are not (yet) in
// @oblimint/shared. Mirrors Obliance's equivalents; move them to shared/ when
// the server agent publishes them there.
// =============================================================================

import type { User, UserRole, UserKind, TenantLimits } from '@oblimint/shared';

export interface LoginRequest {
  username: string;
  password: string;
}

/** `permissions` of GET /api/auth/me (Obliance shape, device-specific fields dropped). */
export interface UserPermissions {
  canCreate?: boolean;
  /** Capabilities of the caller's permission set on the current tenant. */
  tenantCapabilities?: string[];
}

/** GET /api/auth/sso-config (public). */
export interface SsoConfig {
  obligateUrl: string | null;
  obligateEnabled: boolean;
  /** Obligate answered the server's reachability probe. */
  obligateReachable?: boolean;
  /** Address the page was loaded from: 'client' = client space (no SSO), 'admin' = panel host, null = other (IP…). */
  panelRole?: 'admin' | 'client' | null;
  /** https://<client space host>, when one is configured. */
  clientPanelUrl?: string | null;
  /** The platform can e-mail a password reset link ("Forgot your password?" shown). */
  passwordResetAvailable?: boolean;
}

/** GET /api/auth/connected-apps — Obli* apps registered on Obligate. */
export interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string;
  color: string | null;
  /** Marks the entry that is this app itself (resolved by Obligate from the Bearer key). */
  self?: boolean;
  /** Not an Obli* app (filed under "More…" in Obligate): listed in the "More…" dropdown. */
  thirdParty?: boolean;
}

/** Membership of a user in a tenant (GET/PUT /api/users/:id/tenants). */
export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug?: string;
  /** Obliance shape: every tenant is listed, `isMember` says whether the user belongs to it. */
  isMember: boolean;
  /** Permission-set slug (admin, user, viewer, custom…). */
  role: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string | null;
  email?: string | null;
  role: UserRole;
  kind?: UserKind;
  /** Membership role in the creator's tenant (manager that is not a platform admin). */
  tenantRole?: string;
}

export interface UpdateUserRequest {
  username?: string;
  displayName?: string | null;
  email?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export interface TenantInput {
  name: string;
  slug: string;
  limits: TenantLimits;
}

export interface PermissionSetInput {
  name: string;
  slug?: string;
  capabilities: string[];
}

/** GET /api/permission-sets/capabilities — catalogue of grantable capabilities. */
export interface CapabilityDef {
  key: string;
  /** English label from the server; the client prefers t('capabilities.<key>'). */
  label: string;
}

/** Settings → About. GET /api/system (Obliance shape, RMM fields dropped). */
export interface SystemInfo {
  appVersion: string;
  nodeVersion: string;
  uptimeSeconds: number;
  memory: {
    processRssMb: number;
    processHeapMb: number;
    systemTotalMb: number;
    systemFreeMb: number;
  };
  cpu: {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    cores: number;
  };
  environment: {
    isDocker: boolean;
    platform: string;
    dbStatus: 'ok' | 'error';
  };
}

/** Obligate settings write payload (PUT /api/admin/config/obligate). */
export interface ObligateConfigInput {
  url?: string | null;
  apiKey?: string;
  enabled?: boolean;
  inboundSecret?: string;
}

/** Row of GET /api/audit (the server's type: resourcePath, apiKeyId…). */
export type { AuditLogRow, AuditApiKeyRef } from '@oblimint/shared';

export type { User };
