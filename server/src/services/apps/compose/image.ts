// ─────────────────────────────────────────────────────────────────────────────
// Image references (docs/P4b-PLAN.md §5.2, §5.5). PURE.
// Normalization after the Docker distribution rules: no registry → docker.io,
// a single path component on docker.io → library/<name>, no tag nor digest →
// :latest. The registry part is a host name (with a dot or a port, or
// "localhost"); docker.io aliases (index.docker.io, registry-1.docker.io)
// collapse to docker.io.
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageRef {
  /** Registry host (docker.io, ghcr.io, registry.example.com:5000). */
  registry: string;
  /** Repository path (library/nginx, owner/app). */
  repository: string;
  tag: string | null;
  /** sha256:… when pinned. */
  digest: string | null;
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);
const REPO_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const HOST_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(?::\d{1,5})?$/;

/** Parses an image reference; null when invalid. */
export function parseImageRef(raw: string): ImageRef | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 512 || /\s/.test(s)) return null;
  let rest = s;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!TAG_RE.test(tag)) return null;
  }
  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift()!.toLowerCase();
    if (!HOST_RE.test(registry)) return null;
  }
  if (DOCKER_HUB_ALIASES.has(registry)) registry = 'docker.io';
  if (parts.length === 0 || parts.some((p) => !REPO_COMPONENT.test(p))) return null;
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  const repository = parts.join('/');
  if (!tag && !digest) tag = 'latest';
  return { registry, repository, tag, digest };
}

/** Canonical text: registry/repository[:tag][@digest]. */
export function formatImageRef(ref: ImageRef): string {
  return `${ref.registry}/${ref.repository}${ref.tag ? `:${ref.tag}` : ''}${ref.digest ? `@${ref.digest}` : ''}`;
}

/** registry/repository (no tag / digest). */
export function repoName(ref: ImageRef): string {
  return `${ref.registry}/${ref.repository}`;
}

/** Same reference pinned on a digest (tag dropped: the digest is what Docker resolves). */
export function pinnedRef(ref: ImageRef, digest: string): string {
  return `${repoName(ref)}@${digest}`;
}

/** Registry host as the allow-lists write it (docker.io covers Docker Hub). */
export function registryAllowed(registry: string, allowed: readonly string[]): boolean {
  const r = DOCKER_HUB_ALIASES.has(registry.toLowerCase()) ? 'docker.io' : registry.toLowerCase();
  return allowed.some((a) => {
    const x = a.trim().toLowerCase();
    return (DOCKER_HUB_ALIASES.has(x) ? 'docker.io' : x) === r;
  });
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/**
 * Is the image refused by one of the deny patterns? A pattern is matched on
 * the normalized reference (with tag / digest), on registry/repository, and
 * on the short Docker Hub form (nginx:1 for docker.io/library/nginx:1).
 */
export function imageDenied(ref: ImageRef, patterns: readonly string[]): string | null {
  const full = formatImageRef(ref);
  const repo = repoName(ref);
  const candidates = [full, repo];
  if (ref.registry === 'docker.io') {
    const short = ref.repository.replace(/^library\//, '');
    candidates.push(`${short}${ref.tag ? `:${ref.tag}` : ''}`, short);
  }
  for (const p of patterns) {
    if (!p || !p.trim()) continue;
    const re = globToRegExp(p);
    if (candidates.some((c) => re.test(c))) return p;
  }
  return null;
}

/**
 * Digest of `ref`'s repository among an image's RepoDigests (entries like
 * "nginx@sha256:…" or "docker.io/library/nginx@sha256:…").
 */
export function digestFromRepoDigests(ref: ImageRef, repoDigests: readonly string[] | null | undefined): string | null {
  for (const entry of repoDigests ?? []) {
    const at = entry.lastIndexOf('@');
    if (at < 0) continue;
    const parsed = parseImageRef(entry);
    if (parsed && parsed.registry === ref.registry && parsed.repository === ref.repository && parsed.digest) return parsed.digest;
  }
  return null;
}
