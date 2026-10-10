import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import { FakeDocker, muxFrame } from '../../docker/testing/fakeDocker';
import type { AppsDeps } from '../deps';
import type { AllocatedAppNetwork } from '../../network/segments.service';

// Fake Docker for the apps tests: FakeDocker + volumes, image digests, authenticated pulls, builds, health,
// pause, logs, and a recording fake of the other modules' contracts.

function dockerError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(`(HTTP code ${statusCode}) ${message}`), { statusCode, json: { message } });
}

export class FakeAppDocker extends FakeDocker {
  volumes = new Map<string, Docker.VolumeCreateOptions>();
  /** ref → RepoDigests of the local image. */
  digests = new Map<string, string[]>();
  /** Remote digest a pull of ref (repo:tag) gets. */
  remote = new Map<string, string>();
  pullAuths: Array<{ ref: string; auth: unknown }> = [];
  /** container → health status reported by inspect. */
  health = new Map<string, 'healthy' | 'unhealthy' | 'starting'>();
  /** container → exit code when stopped (one-shot services). */
  exitCodes = new Map<string, number>();
  paused = new Set<string>();
  restartCounts = new Map<string, number>();
  builds: Array<{ opts: Record<string, unknown> }> = [];
  buildFails: string | null = null;
  /** Pulls block until released (cancel tests). */
  pullGate: Promise<void> | null = null;
  /** Fails pulls of these refs with "unauthorized". */
  pullUnauthorized = new Set<string>();
  logsText = '';
  /** docker info: storage driver + backing filesystem (StorageOpt size support). */
  storage: { driver: string; backing: string } = { driver: 'overlay2', backing: 'xfs' };
  /** ref → image size in bytes (inspect Size). */
  sizes = new Map<string, number>();

  async info() {
    return { Driver: this.storage.driver, DriverStatus: [['Backing Filesystem', this.storage.backing], ['Supports d_type', 'true']] };
  }

  override async pull(ref: string, opts?: unknown): Promise<NodeJS.ReadableStream> {
    this.pullAuths.push({ ref, auth: (opts as { authconfig?: unknown } | undefined)?.authconfig ?? null });
    if (this.pullUnauthorized.has(ref)) throw dockerError(500, `pull access denied for ${ref}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied (unauthorized)`);
    if (this.pullGate) await this.pullGate;
    const s = await super.pull(ref);
    if (!this.pullFails.has(ref)) {
      const at = ref.indexOf('@');
      const repo = at >= 0 ? ref.slice(0, at) : ref.replace(/:[^/:]+$/, '');
      const digest = at >= 0 ? ref.slice(at + 1) : this.remote.get(ref) ?? `sha256:${'0'.repeat(63)}1`;
      const pinned = `${repo}@${digest}`;
      this.images.add(pinned);
      this.digests.set(ref, [pinned]);
      this.digests.set(pinned, [pinned]);
    }
    return s;
  }

  override getImage(ref: string) {
    const self = this;
    return {
      async inspect() {
        if (self.down) throw self.down;
        if (!self.images.has(ref)) throw dockerError(404, `No such image: ${ref}`);
        return { Id: `sha256:${Buffer.from(ref).toString('hex').slice(0, 64).padEnd(64, '0')}`, RepoDigests: self.digests.get(ref) ?? [], Config: { User: '' }, Size: self.sizes.get(ref) ?? 1048576 };
      },
      async remove() {
        self.images.delete(ref);
        self.calls.push(`remove-image ${ref}`);
      },
    };
  }

  async listImages(opts: { filters?: { label?: string[] } } = {}) {
    const want = (opts.filters?.label ?? [])[0];
    return [...this.images].filter((r) => r.startsWith('oblimint-build/') && (!want || r.includes(`/${want.split('=')[1]}-`))).map((r) => ({ Id: r, RepoTags: [r] }));
  }

  async buildImage(_ctx: NodeJS.ReadableStream, opts: Record<string, unknown>) {
    this.builds.push({ opts });
    (_ctx as unknown as { destroy?: () => void }).destroy?.();
    const s = new PassThrough();
    if (this.buildFails) Object.assign(s, { failRef: this.buildFails });
    else this.images.add(String(opts.t));
    s.end();
    return s;
  }

  getVolume(name: string) {
    const self = this;
    return {
      async inspect() {
        const v = self.volumes.get(name);
        if (!v) throw dockerError(404, `get ${name}: no such volume`);
        return { Name: name, Options: v.DriverOpts, Labels: v.Labels };
      },
      async remove() {
        if (!self.volumes.has(name)) throw dockerError(404, `get ${name}: no such volume`);
        self.volumes.delete(name);
        self.calls.push(`remove-volume ${name}`);
      },
    };
  }

  async createVolume(spec: Docker.VolumeCreateOptions) {
    this.volumes.set(spec.Name!, spec);
    this.calls.push(`create-volume ${spec.Name}`);
    return {};
  }

  async listVolumes(opts: { filters?: { label?: string[] } } = {}) {
    const want = opts.filters?.label ?? [];
    return {
      Volumes: [...this.volumes.values()].filter((v) => want.every((l) => {
        const [k, val] = l.split('=');
        return v.Labels?.[k] === val;
      })).map((v) => ({ Name: v.Name, Labels: v.Labels })),
    };
  }

  override getContainer(ref: string) {
    const base = super.getContainer(ref);
    const self = this;
    const find = () => [...self.containers.values()].find((c) => c.name === ref || c.id === ref);
    return {
      ...base,
      async inspect(): Promise<Docker.ContainerInspectInfo> {
        const info = await base.inspect() as unknown as Record<string, unknown>;
        const c = find()!;
        const state = info.State as Record<string, unknown>;
        const h = self.health.get(c.name);
        if (h) state.Health = { Status: h, Log: [] };
        if (c.state === 'exited') state.ExitCode = self.exitCodes.get(c.name) ?? 0;
        state.Paused = self.paused.has(c.name);
        info.RestartCount = self.restartCounts.get(c.name) ?? 0;
        info.HostConfig = c.spec?.HostConfig ?? {};
        (info.Config as Record<string, unknown>).Env = c.spec?.Env ?? [];
        (info.Config as Record<string, unknown>).Image = c.spec?.Image ?? c.image;
        info.Mounts = (c.spec?.HostConfig?.Mounts ?? []).map((m) => ({ Type: m.Type, Source: m.Source, Destination: m.Target, RW: !m.ReadOnly }));
        info.Created = new Date().toISOString();
        return info as unknown as Docker.ContainerInspectInfo;
      },
      async pause() {
        self.paused.add(ref);
        self.calls.push(`pause ${ref}`);
      },
      async unpause() {
        if (!self.paused.has(ref)) throw dockerError(409, `Container ${ref} is not paused`);
        self.paused.delete(ref);
        self.calls.push(`unpause ${ref}`);
      },
      async logs() {
        return Buffer.concat([muxFrame(1, self.logsText)]);
      },
    };
  }
}

/** Recording fakes of the segmentation / proxy / edge contracts + instant clock. */
export function fakeAppsDeps(docker: FakeAppDocker, over: Partial<AppsDeps> = {}): { deps: Partial<AppsDeps>; events: string[] } {
  const events: string[] = [];
  let t = 1_700_000_000_000;
  const deps: Partial<AppsDeps> = {
    docker: async () => docker.asDocker(),
    segments: {
      async ensureAccountFabrics(accountId) {
        for (const n of [`oblimint-acct-${accountId}`, `oblimint-acct-${accountId}-db`]) if (!docker.networks.has(n)) docker.networks.set(n, { name: n, labels: {} });
        events.push(`fabrics ${accountId}`);
        return { front: `oblimint-acct-${accountId}`, back: `oblimint-acct-${accountId}-db` };
      },
      async allocateAppNetworks(stackId, _accountId, names): Promise<AllocatedAppNetwork[]> {
        events.push(`allocate ${stackId} ${names.join(',')}`);
        return names.map((n, i) => ({ name: n, dockerName: `oblimint-app-${stackId}-${n}`, subnet: `10.240.0.${i * 32}/27`, gateway: `10.240.0.${i * 32 + 1}` }));
      },
      async releaseAppNetworks(stackId) { events.push(`release ${stackId}`); },
      async stackFabricPlan(stackId) { return { accountId: 0, frontNetwork: '', backNetwork: '', backServices: stackId < 0 ? [] : [] }; },
      requestPolicySync(reason) { events.push(`policy ${reason}`); },
    },
    proxy: {
      async hostsTargetingStack() { return []; },
      async stackDeleted(stackId) { events.push(`proxy-deleted ${stackId}`); },
    },
    edgeSync(reason) { events.push(`edge ${reason}`); },
    async maintenanceOpen() { return true; },
    notify(event, payload) { events.push(`notify ${event} ${payload.key}`); },
    // git hosts resolve to a documentation (public-looking) address; never real DNS in tests
    async lookup() { return [{ address: '93.184.216.34', family: 4 }]; },
    async nodeAddresses() { return []; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    ...over,
  };
  return { deps, events };
}
