import type {
  AppMaintenanceSchedule, PlatformComponentKind, PlatformImageGroup, PlatformImageStatus, PlatformUpdatePolicy, PlatformUpdateStatus,
} from '@oblimint/shared';
import { DEFAULT_PLATFORM_UPDATE_POLICY, PLATFORM_COMPONENT_KINDS } from '@oblimint/shared';
import { digestFromRepoDigests, parseImageRef } from '../apps/compose/image';
import { scheduleProblem, windowIsOpen } from '../monitoring/schedule';

// ─────────────────────────────────────────────────────────────────────────────
// Platform updates — PURE part (catalog.test.ts): which containers belong to
// which platform component, the per-image status, the order of an update run,
// the policy / maintenance window rules.
// ─────────────────────────────────────────────────────────────────────────────

/** A container of the node as observed (docker ps -a + labels). */
export interface ObservedContainer {
  name: string;
  /** Config.Image: the reference it was created from. */
  image: string;
  /** Image id it runs (sha256:…). */
  imageId: string;
  /** oblimint.role label. */
  role: string | null;
}

/** Local image of a reference (docker image inspect). */
export interface LocalImage {
  id: string;
  repoDigests: string[];
  version: string | null;
}

const ROLE_KIND: Record<string, PlatformComponentKind> = {
  hostd: 'hostd',
  edge: 'edge',
  filesrv: 'filesrv',
  pdns: 'dns',
  scanner: 'scanner',
  mail: 'mail',
  'mail-relay': 'mail-relay',
  webmail: 'webmail',
  dbadmin: 'dbadmin',
  site: 'site-base',
  'site-secondary': 'site-base',
  'site-preview': 'site-base',
  tools: 'tools',
};

/** Infra kinds recreated through their ensure() (infra.service / extensions), in run order. */
export const INFRA_RECREATE_ORDER: readonly PlatformComponentKind[] = ['hostd', 'edge', 'dns', 'scanner', 'mail', 'mail-relay', 'webmail', 'dbadmin'];

export function groupOf(kind: PlatformComponentKind): PlatformImageGroup {
  return kind === 'site-base' ? 'sites' : kind === 'tools' ? 'tools' : 'platform';
}

/**
 * docker ps shows the IMAGE ID instead of the reference when the tag moved to
 * another image since the container was created (a newer image was pulled but
 * the container still runs the old one): its reference must then be read from
 * Config.Image, or the very containers that need an update would be ignored.
 */
export function needsConfigImage(image: string): boolean {
  return /^sha256:[0-9a-f]{12,64}$/.test(image) || /^[0-9a-f]{12,64}$/.test(image);
}

/** Tag of a reference (null = none / digest only). */
export function tagOf(ref: string): string | null {
  return parseImageRef(ref)?.tag ?? null;
}

/**
 * Component of a container: the panel itself (by name), else its oblimint.role
 * — only images of the configured Oblimint tag are followed (official images
 * pinned by the configuration, such as redis, are not platform images).
 */
export function kindOf(c: ObservedContainer, opts: { tag: string; panelName: string | null }): PlatformComponentKind | null {
  if (opts.panelName && c.name === opts.panelName) return 'panel';
  const kind = c.role ? ROLE_KIND[c.role] : undefined;
  if (!kind) return null;
  if (tagOf(c.image) !== opts.tag) return null;
  return kind;
}

/** What the last checks remembered for an image. */
export interface RememberedImage {
  remoteDigest: string | null;
  checkedAt: string | null;
  error: string | null;
  failed?: boolean;
}

/**
 * Status of an image:
 *  - no local image / no registry digest recorded locally (local build) → unknown once checked;
 *  - remote digest ≠ local digest → updateAvailable;
 *  - local is current but containers still run an older image id → pendingRecreate;
 *  - the last run failed for it (and nothing newer) → failed.
 */
export function imageStatus(input: {
  ref: string;
  local: LocalImage | null;
  remote: RememberedImage | null;
  outdated: number;
  updating: boolean;
}): PlatformUpdateStatus {
  if (input.updating) return 'updating';
  const parsed = parseImageRef(input.ref);
  const localDigest = parsed && input.local ? digestFromRepoDigests(parsed, input.local.repoDigests) : null;
  const remote = input.remote;
  if (remote?.failed) return 'failed';
  if (remote?.remoteDigest && localDigest && remote.remoteDigest !== localDigest) return 'updateAvailable';
  if (remote?.remoteDigest && !input.local) return 'updateAvailable';
  if (input.outdated > 0) return 'pendingRecreate';
  if (!remote || !remote.checkedAt) return 'unchecked';
  if (remote.error || !remote.remoteDigest || !localDigest) return 'unknown';
  return 'upToDate';
}

/** Aggregates the containers per image reference. */
export function buildImageList(input: {
  containers: ObservedContainer[];
  /** Extra references followed without a container (tools images present locally). */
  extraRefs?: Array<{ ref: string; kind: PlatformComponentKind }>;
  tag: string;
  panelName: string | null;
  locals: Map<string, LocalImage | null>;
  remembered: Map<string, RememberedImage>;
  updating: ReadonlySet<string>;
}): PlatformImageStatus[] {
  const byRef = new Map<string, { kind: PlatformComponentKind; containers: ObservedContainer[] }>();
  for (const c of input.containers) {
    const kind = kindOf(c, { tag: input.tag, panelName: input.panelName });
    if (!kind) continue;
    const e = byRef.get(c.image) ?? { kind, containers: [] };
    e.containers.push(c);
    byRef.set(c.image, e);
  }
  for (const x of input.extraRefs ?? []) if (!byRef.has(x.ref)) byRef.set(x.ref, { kind: x.kind, containers: [] });
  const order = (k: PlatformComponentKind) => PLATFORM_COMPONENT_KINDS.indexOf(k);
  return [...byRef.entries()]
    .map(([ref, e]): PlatformImageStatus => {
      const local = input.locals.get(ref) ?? null;
      const parsed = parseImageRef(ref);
      const outdated = local ? e.containers.filter((c) => c.imageId !== local.id).map((c) => c.name).sort() : [];
      const remembered = input.remembered.get(ref) ?? null;
      return {
        image: ref,
        kind: e.kind,
        group: groupOf(e.kind),
        containers: e.containers.map((c) => c.name).sort(),
        outdatedContainers: outdated,
        localImageId: local?.id ?? null,
        localDigest: parsed && local ? digestFromRepoDigests(parsed, local.repoDigests) : null,
        version: local?.version ?? null,
        remoteDigest: remembered?.remoteDigest ?? null,
        status: imageStatus({ ref, local, remote: remembered, outdated: outdated.length, updating: input.updating.has(ref) }),
        error: remembered?.error ?? null,
        checkedAt: remembered?.checkedAt ?? null,
      };
    })
    .sort((a, b) => order(a.kind) - order(b.kind) || a.image.localeCompare(b.image));
}

export type UpdateStep =
  | { type: 'pull'; image: string }
  | { type: 'recreate'; kind: PlatformComponentKind; images: string[] }
  | { type: 'accounts'; images: string[]; sites: boolean }
  | { type: 'panel'; image: string };

const NEEDS_WORK: ReadonlySet<PlatformUpdateStatus> = new Set(['updateAvailable', 'pendingRecreate', 'failed']);

/**
 * Steps of a run: every pull first (nothing is recreated while an image is
 * missing), then the infra components in INFRA_RECREATE_ORDER, then the
 * account containers (file servers always; site containers only with
 * `redeploySites`), the panel LAST (its recreation ends this process).
 * Tools images are only pulled (ephemeral containers).
 */
export function planRun(images: PlatformImageStatus[], req: { images?: string[] | null; redeploySites?: boolean }): UpdateStep[] {
  const wanted = req.images && req.images.length ? new Set(req.images) : null;
  const selected = images.filter((i) => (wanted ? wanted.has(i.image) : NEEDS_WORK.has(i.status)));
  const steps: UpdateStep[] = [];
  const pulls = selected.filter((i) => i.status !== 'pendingRecreate');
  for (const i of [...pulls.filter((p) => p.kind !== 'panel'), ...pulls.filter((p) => p.kind === 'panel')]) steps.push({ type: 'pull', image: i.image });
  for (const kind of INFRA_RECREATE_ORDER) {
    const refs = selected.filter((i) => i.kind === kind).map((i) => i.image);
    if (refs.length) steps.push({ type: 'recreate', kind, images: refs });
  }
  const accountRefs = selected.filter((i) => i.kind === 'filesrv' || (i.kind === 'site-base' && req.redeploySites)).map((i) => i.image);
  if (accountRefs.length) steps.push({ type: 'accounts', images: accountRefs, sites: !!req.redeploySites });
  const panel = selected.find((i) => i.kind === 'panel');
  if (panel) steps.push({ type: 'panel', image: panel.image });
  return steps;
}

// ── policy ──────────────────────────────────────────────────────────────────

export const MIN_CHECK_INTERVAL_MIN = 30;

/** Validated policy (invalid fields fall back to the defaults). */
export function normalizePolicy(raw: unknown): PlatformUpdatePolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlatformUpdatePolicy>;
  const d = DEFAULT_PLATFORM_UPDATE_POLICY;
  const interval = Number(p.checkIntervalMin);
  let window: AppMaintenanceSchedule | null = d.window;
  if (p.window === null) window = null;
  else if (p.window !== undefined) window = scheduleProblem(p.window) ? d.window : { ...(p.window as AppMaintenanceSchedule), days: [...(p.window as AppMaintenanceSchedule).days].sort((a, b) => a - b) };
  return {
    autoCheck: typeof p.autoCheck === 'boolean' ? p.autoCheck : d.autoCheck,
    checkIntervalMin: Number.isInteger(interval) && interval >= MIN_CHECK_INTERVAL_MIN && interval <= 10_080 ? interval : d.checkIntervalMin,
    autoUpdate: typeof p.autoUpdate === 'boolean' ? p.autoUpdate : d.autoUpdate,
    window,
    notify: typeof p.notify === 'boolean' ? p.notify : d.notify,
  };
}

/** A periodic check is due. */
export function checkDue(policy: PlatformUpdatePolicy, lastCheck: string | null, now: Date): boolean {
  if (!policy.autoCheck) return false;
  const last = lastCheck ? new Date(lastCheck).getTime() : 0;
  return !Number.isFinite(last) || now.getTime() - last >= policy.checkIntervalMin * 60_000;
}

/** Automatic updates may run now: enabled, a valid window, open now. `force` ('forcer maintenant') ignores the window. */
export function autoUpdateAllowed(policy: PlatformUpdatePolicy, now: Date, force = false): boolean {
  if (force) return true;
  if (!policy.autoUpdate || !policy.window || scheduleProblem(policy.window)) return false;
  return windowIsOpen(policy.window, now);
}

/** Images an automatic run takes: never the site containers (redeploySites false), a failed image only after a newer digest. */
export function autoRunImages(images: PlatformImageStatus[]): string[] {
  return images.filter((i) => i.status === 'updateAvailable' || i.status === 'pendingRecreate').map((i) => i.image);
}
