import type { ImageRef } from './compose/image';

// ─────────────────────────────────────────────────────────────────────────────
// Registry v2 digest check (docs/P4b-PLAN.md §5.5, after Oblihub
// registry.service.ts, generalized): HEAD /v2/<repo>/manifests/<tag> with the
// manifest list / OCI index Accept headers (the digest of a multi-arch image
// is the index digest, which is what `docker pull` records in RepoDigests);
// a 401 with `WWW-Authenticate: Bearer realm=…,service=…,scope=…` is answered
// by the token flow (anonymous, or Basic with the stack's credentials) — the
// Docker Hub flow is that same challenge. Only registries of the allow-list
// are ever contacted (the caller checked the image against it); redirects are
// followed by fetch only for the blob CDN of GETs (HEAD has none).
// ─────────────────────────────────────────────────────────────────────────────

export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

const TIMEOUT_MS = 15_000;

export class RegistryCheckError extends Error {
  constructor(message: string, readonly auth = false) {
    super(message);
    this.name = 'RegistryCheckError';
  }
}

export function registryApiHost(registry: string): string {
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

/** Parses `Bearer realm="…",service="…",scope="…"` (null when not a Bearer challenge). */
export function parseBearerChallenge(header: string | null): { realm: string; service: string | null; scope: string | null } | null {
  if (!header || !/^\s*bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) params[m[1].toLowerCase()] = m[2];
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service ?? null, scope: params.scope ?? null };
}

export interface DigestCheckInput {
  ref: ImageRef;
  auth: { username: string; password: string } | null;
  fetch: typeof fetch;
}

function basic(auth: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
}

async function token(input: DigestCheckInput, challenge: { realm: string; service: string | null; scope: string | null }): Promise<string> {
  let url: URL;
  try {
    url = new URL(challenge.realm);
  } catch {
    throw new RegistryCheckError('invalid token realm');
  }
  if (url.protocol !== 'https:') throw new RegistryCheckError('token realm is not https');
  if (challenge.service) url.searchParams.set('service', challenge.service);
  url.searchParams.set('scope', challenge.scope ?? `repository:${input.ref.repository}:pull`);
  const res = await input.fetch(url, {
    headers: input.auth ? { Authorization: basic(input.auth) } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new RegistryCheckError(`token refused (${res.status})`, true);
  if (!res.ok) throw new RegistryCheckError(`token request failed (${res.status})`);
  const body = await res.json() as { token?: string; access_token?: string };
  const t = body.token ?? body.access_token;
  if (!t) throw new RegistryCheckError('no token in the registry answer');
  return t;
}

/** Remote digest of `ref` (its tag). Throws RegistryCheckError. */
export async function remoteDigest(input: DigestCheckInput): Promise<string> {
  const { ref } = input;
  if (ref.digest && !ref.tag) return ref.digest;
  const url = `https://${registryApiHost(ref.registry)}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag ?? 'latest')}`;
  const ask = (method: 'HEAD' | 'GET', authorization: string | null) => input.fetch(url, {
    method,
    redirect: 'error',
    headers: { Accept: MANIFEST_ACCEPT, ...(authorization ? { Authorization: authorization } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let authorization: string | null = null;
  let res = await ask('HEAD', null);
  if (res.status === 401) {
    const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
    if (challenge) authorization = `Bearer ${await token(input, challenge)}`;
    else if (input.auth && /^\s*basic/i.test(res.headers.get('www-authenticate') ?? '')) authorization = basic(input.auth);
    else throw new RegistryCheckError('authentication required', true);
    res = await ask('HEAD', authorization);
  }
  if (res.status === 401 || res.status === 403) throw new RegistryCheckError(`access denied (${res.status})`, true);
  if (res.status === 404) throw new RegistryCheckError('manifest not found');
  let digest = res.ok ? res.headers.get('docker-content-digest') : null;
  if (!digest && (res.ok || res.status === 405)) {
    // Some registries omit the header on HEAD: GET the manifest (small JSON).
    const get = await ask('GET', authorization);
    if (!get.ok) throw new RegistryCheckError(`manifest request failed (${get.status})`);
    digest = get.headers.get('docker-content-digest');
    await get.body?.cancel().catch(() => undefined);
  }
  if (!res.ok && !digest) throw new RegistryCheckError(`manifest request failed (${res.status})`);
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new RegistryCheckError('no digest in the registry answer');
  return digest;
}
