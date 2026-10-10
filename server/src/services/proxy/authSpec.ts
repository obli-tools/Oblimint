import type Docker from 'dockerode';
import { isValidServerName } from '../edge/nginxConfig';
import { AUTH_NETWORK, AUTH_REDIS_CONTAINER, AUTH_SIDECAR_PORT, LABELS, P4B_LABELS, authSidecarContainer } from '../hosting/naming';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, TMPFS_SHARED_FLAGS, withSpecHash } from '../docker/specs';
import { AUTH_GROUP_RE, AZURE_CLIENT_ID_RE, AZURE_TENANT_RE } from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container specs of the forward-auth infrastructure (docs/P4b-PLAN.md
// §8.8, invariant PX5; authSpec.test.ts):
//   - oblimint-oauth2-<providerId>: oauth2-proxy (official image, pinned),
//     OIDC provider on https://login.microsoftonline.com/<tenant>/v2.0,
//     --reverse-proxy, --set-xauthrequest, upstream static://202 (auth only),
//     sessions in the shared Redis (cookie name per provider = key prefix),
//     whitelist = the protected domains (anti open redirect);
//   - oblimint-auth-redis: session store (no persistence, password).
// Hardening: AUTH_NETWORK only (never an account network, never the panel
// network), no published port, no bind mount at all (no Docker socket, no
// account tree), CapDrop ALL, no-new-privileges, read-only root + small
// tmpfs, 64 MiB, PIDs bounded, platform OOM score, non-root user, labels
// oblimint.internal + oblimint.role=proxy-auth (+ oblimint.auth-provider) —
// NEVER oblimint.account (the edge joins every network carrying it).
// ─────────────────────────────────────────────────────────────────────────────

export const AUTH_MEMORY_BYTES = 64 * 1048576;
export const AUTH_PIDS_LIMIT = 64;
export const AUTH_REDIS_PORT = 6379;
/** distroless "nonroot" of the oauth2-proxy image; redis user of the alpine image. */
export const OAUTH2_PROXY_USER = '65532:65532';
export const AUTH_REDIS_USER = '999:1000';

export interface AuthSidecarInput {
  providerId: number;
  image: string;
  azureTenantId: string;
  clientId: string;
  clientSecret: string;
  /** 16 / 24 / 32 ASCII characters. */
  cookieSecret: string;
  allowedEmailDomains: string[];
  allowedGroups: string[];
  /** Host names of the protected domains (redirect whitelist). */
  whitelistDomains: string[];
  redisPassword: string;
}

export class AuthSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthSpecError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const REDIS_PASSWORD_RE = /^[A-Za-z0-9_-]{24,128}$/;

const hardening = (): Docker.HostConfig => ({
  NetworkMode: AUTH_NETWORK,
  ReadonlyRootfs: true,
  CapDrop: ['ALL'],
  SecurityOpt: [NO_NEW_PRIVILEGES],
  Memory: AUTH_MEMORY_BYTES,
  MemorySwap: AUTH_MEMORY_BYTES,
  PidsLimit: AUTH_PIDS_LIMIT,
  OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
  LogConfig: LOG_CONFIG,
  RestartPolicy: { Name: 'unless-stopped' },
});

/** Throws AuthSpecError on any value that is not strictly valid (never reaches an env line). */
export function authSidecarSpec(input: AuthSidecarInput): Docker.ContainerCreateOptions {
  const id = Number(input.providerId);
  if (!Number.isInteger(id) || id <= 0) throw new AuthSpecError('invalid provider id');
  if (!AZURE_TENANT_RE.test(input.azureTenantId)) throw new AuthSpecError('invalid Azure tenant');
  if (!AZURE_CLIENT_ID_RE.test(input.clientId)) throw new AuthSpecError('invalid client id');
  if (!input.clientSecret || input.clientSecret.length > 512 || CONTROL_RE.test(input.clientSecret)) throw new AuthSpecError('invalid client secret');
  if (![16, 24, 32].includes(input.cookieSecret.length) || !/^[A-Za-z0-9_-]+$/.test(input.cookieSecret)) throw new AuthSpecError('invalid cookie secret');
  if (!REDIS_PASSWORD_RE.test(input.redisPassword)) throw new AuthSpecError('invalid redis password');
  const domains = [...new Set(input.allowedEmailDomains.map((d) => d.toLowerCase()).filter(isValidServerName))];
  const groups = [...new Set(input.allowedGroups.filter((g) => AUTH_GROUP_RE.test(g)))];
  const whitelist = [...new Set(input.whitelistDomains.map((d) => d.toLowerCase()).filter(isValidServerName))].sort();
  const env = [
    'OAUTH2_PROXY_PROVIDER=oidc',
    'OAUTH2_PROXY_PROVIDER_DISPLAY_NAME=Microsoft',
    `OAUTH2_PROXY_OIDC_ISSUER_URL=https://login.microsoftonline.com/${input.azureTenantId}/v2.0`,
    `OAUTH2_PROXY_CLIENT_ID=${input.clientId.toLowerCase()}`,
    `OAUTH2_PROXY_CLIENT_SECRET=${input.clientSecret}`,
    `OAUTH2_PROXY_COOKIE_SECRET=${input.cookieSecret}`,
    `OAUTH2_PROXY_COOKIE_NAME=_oblimint_auth_${id}`,
    'OAUTH2_PROXY_COOKIE_SECURE=true',
    'OAUTH2_PROXY_COOKIE_SAMESITE=lax',
    `OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:${AUTH_SIDECAR_PORT}`,
    // Auth only: nginx asks /oauth2/auth (auth_request); the sign-in flow goes through /oauth2/ proxied by the edge.
    'OAUTH2_PROXY_UPSTREAMS=static://202',
    'OAUTH2_PROXY_REVERSE_PROXY=true',
    'OAUTH2_PROXY_SET_XAUTHREQUEST=true',
    'OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true',
    'OAUTH2_PROXY_SCOPE=openid email profile',
    // Entra ID v2 tokens carry no email_verified claim.
    'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true',
    'OAUTH2_PROXY_SESSION_STORE_TYPE=redis',
    `OAUTH2_PROXY_REDIS_CONNECTION_URL=redis://${AUTH_REDIS_CONTAINER}:${AUTH_REDIS_PORT}`,
    `OAUTH2_PROXY_REDIS_PASSWORD=${input.redisPassword}`,
    `OAUTH2_PROXY_EMAIL_DOMAINS=${domains.length ? domains.join(',') : '*'}`,
    ...(groups.length ? [`OAUTH2_PROXY_ALLOWED_GROUPS=${groups.join(',')}`] : []),
    ...(whitelist.length ? [`OAUTH2_PROXY_WHITELIST_DOMAINS=${whitelist.join(',')}`] : []),
    'OAUTH2_PROXY_SILENCE_PING_LOGGING=true',
  ];
  return withSpecHash({
    name: authSidecarContainer(id),
    Image: input.image,
    User: OAUTH2_PROXY_USER,
    Env: env,
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.role]: 'proxy-auth',
      [P4B_LABELS.authProvider]: String(id),
    },
    ExposedPorts: { [`${AUTH_SIDECAR_PORT}/tcp`]: {} },
    HostConfig: { ...hardening(), Tmpfs: { '/tmp': `${TMPFS_SHARED_FLAGS},size=16m` } },
  });
}

export function authRedisSpec(image: string, password: string): Docker.ContainerCreateOptions {
  if (!REDIS_PASSWORD_RE.test(password)) throw new AuthSpecError('invalid redis password');
  return withSpecHash({
    name: AUTH_REDIS_CONTAINER,
    Image: image,
    User: AUTH_REDIS_USER,
    Cmd: ['redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '48mb', '--maxmemory-policy', 'allkeys-lru',
      '--protected-mode', 'no', '--requirepass', password],
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.role]: 'proxy-auth',
    },
    ExposedPorts: { [`${AUTH_REDIS_PORT}/tcp`]: {} },
    HostConfig: { ...hardening(), Tmpfs: { '/data': `${TMPFS_SHARED_FLAGS},size=32m`, '/tmp': `${TMPFS_SHARED_FLAGS},size=8m` } },
  });
}
