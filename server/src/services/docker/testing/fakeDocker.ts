import { PassThrough } from 'stream';
import Docker from 'dockerode';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fake of the dockerode surface used by services/docker/* (tests
// only: Docker is never available on the dev box). It models containers,
// images, networks and records every mutating call in `calls`. demuxStream
// is dockerode's REAL implementation (docker-modem), so exec demux is tested
// against the true multiplexing code.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  state: 'running' | 'exited' | 'created' | 'restarting';
  spec: Docker.ContainerCreateOptions | null;
  networks: Map<string, FakeEndpoint>;
  startedAt: string | null;
  /** State.Error of the last failed start (e.g. its static address taken). */
  error?: string;
}

/** An endpoint: aliases, the static address requested (IPAMConfig) and the address it has while running. */
export interface FakeEndpoint {
  Aliases: string[];
  IPv4?: string | null;
  /** Address Docker chose (dynamic, running containers only). */
  addr?: string | null;
  /** Docker >= 28 EndpointSettings.GwPriority (kept only when set). */
  GwPriority?: number;
}

const STATIC_REFUSED = 'user specified IP address is supported only when connecting to networks with user configured subnets';

export interface FakeNetwork {
  name: string;
  labels: Record<string, string>;
  /** IPv4 subnet (IPAM.Config[0].Subnet), when modelled. */
  subnet?: string;
  ipRange?: string;
  options?: Record<string, string>;
  /** Docker ≤ 28 + subnet chosen by Docker: a static address is refused (connect; start for a create). */
  refuseStatic?: boolean;
}

export interface FakeExec {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** Never ends (timeout tests). */
  hang?: boolean;
}

function dockerError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(`(HTTP code ${statusCode}) ${message}`), { statusCode, json: { message } });
}

/** One frame of Docker's multiplexed stream (stream 1 = stdout, 2 = stderr). */
export function muxFrame(stream: 1 | 2, payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

let seq = 0;

export class FakeDocker {
  containers = new Map<string, FakeContainer>();
  images = new Set<string>();
  /** Images whose pull fails (registry 404). */
  pullFails = new Set<string>();
  networks = new Map<string, FakeNetwork>();
  calls: string[] = [];
  /** exec results by container name (default exit 0). */
  execResults = new Map<string, FakeExec>();
  /** When set, every call rejects with this error (Docker unreachable). */
  down: (Error & { code?: string }) | null = null;
  /** Fails the next N network connects whose aliases match ("alias" = with aliases, "any" = all). */
  /** When set, network creation fails with this message (pool exhausted…). */
  networkCreateFails: string | null = null;
  connectFails: { remaining: number; when: 'alias' | 'any' } | null = null;
  modem: { demuxStream: Docker['modem']['demuxStream']; followProgress: (s: NodeJS.ReadableStream, done: (err: Error | null) => void, progress?: (ev: unknown) => void) => void };

  constructor() {
    const real = new Docker({ socketPath: '/nonexistent/docker.sock' });
    this.modem = {
      demuxStream: real.modem.demuxStream.bind(real.modem),
      followProgress: (stream, done, progress) => {
        const failed = (stream as unknown as { failRef?: string }).failRef;
        progress?.({ status: 'Pulling fs layer', id: 'abc' });
        if (failed) {
          progress?.({ error: `manifest for ${failed} not found` });
          done(null); // Docker reports pull errors in the progress stream
          return;
        }
        progress?.({ status: 'Download complete', id: 'abc' });
        done(null);
      },
    };
  }

  asDocker(): Docker {
    return this as unknown as Docker;
  }

  private guard(): void {
    if (this.down) throw this.down;
  }

  /** Adds an existing container (fixtures). */
  addContainer(c: Partial<FakeContainer> & { name: string }): FakeContainer {
    const full: FakeContainer = {
      // Zero-padded on the left: 'c1' and 'c10' padded on the right were the same id (find() returned the wrong one).
      id: `c${String(++seq).padStart(11, '0')}`,
      image: 'img',
      labels: {},
      state: 'running',
      spec: null,
      networks: new Map(),
      startedAt: new Date().toISOString(),
      ...c,
    };
    this.containers.set(full.name, full);
    return full;
  }

  private find(ref: string): FakeContainer | undefined {
    return this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.id === ref || c.id.startsWith(ref));
  }

  getContainer(ref: string) {
    const self = this;
    const need = () => {
      self.guard();
      const c = self.find(ref);
      if (!c) throw dockerError(404, `No such container: ${ref}`);
      return c;
    };
    return {
      async inspect(): Promise<Docker.ContainerInspectInfo> {
        const c = need();
        const nets: Record<string, unknown> = {};
        for (const [n, ep] of c.networks) {
          nets[n] = {
            Aliases: ep.Aliases, DNSNames: null, IPAMConfig: ep.IPv4 ? { IPv4Address: ep.IPv4 } : null,
            IPAddress: c.state === 'running' ? (ep.IPv4 ?? ep.addr ?? '') : '',
            ...(ep.GwPriority ? { GwPriority: ep.GwPriority } : {}),
          };
        }
        return {
          Id: c.id,
          Name: `/${c.name}`,
          Image: c.image,
          Config: { Image: c.image, Labels: c.labels },
          State: {
            Status: c.state, Running: c.state === 'running' || c.state === 'restarting', StartedAt: c.startedAt ?? '0001-01-01T00:00:00Z', ExitCode: 0, Error: c.error ?? '',
          },
          HostConfig: { Memory: c.spec?.HostConfig?.Memory ?? 0, NanoCpus: c.spec?.HostConfig?.NanoCpus ?? 0 },
          NetworkSettings: { Networks: nets },
        } as unknown as Docker.ContainerInspectInfo;
      },
      async start() {
        const c = need();
        if (c.state === 'running') throw dockerError(304, 'container already started');
        for (const [n, ep] of c.networks) {
          if (ep.IPv4 && self.networks.get(n)?.refuseStatic) throw dockerError(400, STATIC_REFUSED);
          if (ep.IPv4 && self.addressHolder(n, ep.IPv4, c.name)) {
            c.error = 'failed to set up container networking: Address already in use';
            throw dockerError(500, c.error);
          }
        }
        c.error = '';
        c.state = 'running';
        c.startedAt = new Date().toISOString();
        self.calls.push(`start ${c.name}`);
      },
      async stop() {
        const c = need();
        if (c.state !== 'running') throw dockerError(304, 'container already stopped');
        c.state = 'exited';
        self.calls.push(`stop ${c.name}`);
      },
      async restart() {
        const c = need();
        c.state = 'running';
        self.calls.push(`restart ${c.name}`);
      },
      async remove() {
        const c = need();
        self.containers.delete(c.name);
        self.calls.push(`remove ${c.name}`);
      },
      async exec(opts: Docker.ExecCreateOptions) {
        const c = need();
        if (c.state !== 'running') throw dockerError(409, `Container ${c.name} is not running`);
        self.calls.push(`exec ${c.name} ${(opts.Cmd ?? []).join(' ')}`);
        const result = self.execResults.get(c.name) ?? { exitCode: 0 };
        return {
          async start() {
            const s = new PassThrough();
            if (!result.hang) {
              setImmediate(() => {
                if (result.stdout) s.write(muxFrame(1, result.stdout));
                if (result.stderr) s.write(muxFrame(2, result.stderr));
                s.end();
              });
            }
            return s;
          },
          async inspect() {
            return { ExitCode: result.exitCode, Running: false };
          },
        };
      },
    };
  }

  getImage(ref: string) {
    const self = this;
    return {
      async inspect() {
        self.guard();
        if (!self.images.has(ref)) throw dockerError(404, `No such image: ${ref}`);
        return { Id: `sha256:${ref}` };
      },
    };
  }

  async pull(ref: string): Promise<NodeJS.ReadableStream> {
    this.guard();
    this.calls.push(`pull ${ref}`);
    const s = new PassThrough();
    if (this.pullFails.has(ref)) Object.assign(s, { failRef: ref });
    else this.images.add(ref);
    s.end();
    return s;
  }

  async createContainer(spec: Docker.ContainerCreateOptions) {
    this.guard();
    const name = spec.name!;
    if (this.containers.has(name)) throw dockerError(409, `Conflict. The container name "/${name}" is already in use`);
    if (!this.images.has(spec.Image!)) throw dockerError(404, `No such image: ${spec.Image}`);
    const networks = new Map<string, FakeEndpoint>();
    const mode = spec.HostConfig?.NetworkMode;
    if (mode && mode !== 'host' && mode !== 'none') {
      if (!this.networks.has(mode)) throw dockerError(404, `network ${mode} not found`);
      const ep = spec.NetworkingConfig?.EndpointsConfig?.[mode];
      const ip = ep?.IPAMConfig?.IPv4Address;
      networks.set(mode, { Aliases: (ep?.Aliases as string[] | undefined) ?? [], ...(ip ? { IPv4: ip } : {}) });
    }
    this.addContainer({ name, image: spec.Image!, labels: { ...(spec.Labels ?? {}) }, state: 'created', spec, networks, startedAt: null });
    this.calls.push(`create ${name}`);
    return Object.assign(this.getContainer(name), { id: this.containers.get(name)!.id });
  }

  async listContainers(opts: { all?: boolean; filters?: { label?: string[] } } = {}): Promise<Docker.ContainerInfo[]> {
    this.guard();
    const wanted = opts.filters?.label ?? [];
    return [...this.containers.values()]
      .filter((c) => opts.all || c.state === 'running')
      .filter((c) => wanted.every((l) => {
        const [k, v] = l.split('=');
        return v === undefined ? k in c.labels : c.labels[k] === v;
      }))
      .map((c) => ({
        Id: c.id, Names: [`/${c.name}`], Image: c.image, State: c.state, Labels: c.labels,
        NetworkSettings: {
          Networks: Object.fromEntries([...c.networks].map(([n, ep]) => [n, {
            Aliases: ep.Aliases, IPAMConfig: ep.IPv4 ? { IPv4Address: ep.IPv4 } : null, IPAddress: c.state === 'running' ? (ep.IPv4 ?? ep.addr ?? '') : '',
          }])),
        },
      }) as unknown as Docker.ContainerInfo);
  }

  getNetwork(name: string) {
    const self = this;
    const need = () => {
      self.guard();
      const n = self.networks.get(name);
      if (!n) throw dockerError(404, `network ${name} not found`);
      return n;
    };
    return {
      async inspect() {
        const n = need();
        const containers: Record<string, { Name: string; IPv4Address?: string }> = {};
        for (const c of self.containers.values()) {
          const ep = c.networks.get(name);
          if (!ep) continue;
          containers[c.id] = { Name: c.name, ...(c.state === 'running' && (ep.IPv4 ?? ep.addr) ? { IPv4Address: `${ep.IPv4 ?? ep.addr}/24` } : {}) };
        }
        return {
          Id: `n-${n.name}`.padEnd(64, '0'), Name: n.name, Driver: 'bridge', Labels: n.labels, Containers: containers, Options: n.options ?? {},
          IPAM: { Config: n.subnet ? [{ Subnet: n.subnet, ...(n.ipRange ? { IPRange: n.ipRange } : {}) }] : [] },
        };
      },
      async connect(opts: { Container: string; EndpointConfig?: { Aliases?: string[]; IPAMConfig?: { IPv4Address?: string }; GwPriority?: number } }) {
        need();
        const c = self.find(opts.Container);
        if (!c) throw dockerError(404, `No such container: ${opts.Container}`);
        if (c.networks.has(name)) throw dockerError(403, `endpoint with name ${c.name} already exists in network ${name}`);
        const cf = self.connectFails;
        if (cf && cf.remaining > 0 && (cf.when === 'any' || opts.EndpointConfig?.Aliases?.length)) {
          cf.remaining--;
          self.calls.push(`connect-failed ${c.name} ${name}`);
          throw dockerError(500, 'daemon hiccup');
        }
        const ip = opts.EndpointConfig?.IPAMConfig?.IPv4Address ?? null;
        if (ip && self.networks.get(name)?.refuseStatic) {
          self.calls.push(`connect-refused ${c.name} ${name} ip=${ip}`);
          throw dockerError(400, STATIC_REFUSED);
        }
        if (ip && c.state === 'running' && self.addressHolder(name, ip, c.name)) {
          self.calls.push(`connect-inuse ${c.name} ${name} ip=${ip}`);
          throw dockerError(403, `Address already in use`);
        }
        const gwp = Number(opts.EndpointConfig?.GwPriority) || 0;
        c.networks.set(name, { Aliases: opts.EndpointConfig?.Aliases ?? [], ...(ip ? { IPv4: ip } : {}), ...(gwp ? { GwPriority: gwp } : {}) });
        self.calls.push(`connect ${c.name} ${name}${opts.EndpointConfig?.Aliases?.length ? ` alias=${opts.EndpointConfig.Aliases.join(',')}` : ''}${ip ? ` ip=${ip}` : ''}`);
      },
      async disconnect(opts: { Container: string }) {
        need();
        const c = self.find(opts.Container);
        if (!c || !c.networks.has(name)) throw dockerError(403, `container ${opts.Container} is not connected to network ${name}`);
        c.networks.delete(name);
        self.calls.push(`disconnect ${c.name} ${name}`);
      },
      async remove() {
        need();
        self.networks.delete(name);
        self.calls.push(`remove-network ${name}`);
      },
    };
  }

  /** Running container (other than `except`) holding `ip` on `network`. */
  addressHolder(network: string, ip: string, except: string): string | null {
    for (const c of this.containers.values()) {
      if (c.name === except || c.state !== 'running') continue;
      const ep = c.networks.get(network);
      if (ep && (ep.IPv4 ?? ep.addr) === ip) return c.name;
    }
    return null;
  }

  async version() {
    this.guard();
    return { Version: this.engineVersion };
  }

  /** Version answered by version() (Docker ≥ 29 accepts static addresses on any user network). */
  engineVersion = '28.5.2';

  async createNetwork(opts: { Name: string; Labels?: Record<string, string>; Options?: Record<string, string>; IPAM?: { Config?: Array<{ Subnet?: string; IPRange?: string }> } }) {
    this.guard();
    if (this.networks.has(opts.Name)) throw dockerError(409, `network with name ${opts.Name} already exists`);
    if (this.networkCreateFails) throw dockerError(500, this.networkCreateFails);
    const cfg = opts.IPAM?.Config?.[0];
    this.networks.set(opts.Name, { name: opts.Name, labels: opts.Labels ?? {}, subnet: cfg?.Subnet, ipRange: cfg?.IPRange, options: opts.Options });
    this.calls.push(`create-network ${opts.Name}`);
    return { id: `n-${opts.Name}` };
  }

  async listNetworks(opts: { filters?: { label?: string[] } } = {}) {
    this.guard();
    const wanted = opts.filters?.label ?? [];
    return [...this.networks.values()]
      .filter((n) => wanted.every((l) => {
        const [k, v] = l.split('=');
        return v === undefined ? k in n.labels : n.labels[k] === v;
      }))
      .map((n) => ({
        Name: n.name, Id: `n-${n.name}`.padEnd(64, '0'), Driver: 'bridge', Labels: n.labels, Options: n.options ?? {},
        IPAM: { Config: n.subnet ? [{ Subnet: n.subnet, ...(n.ipRange ? { IPRange: n.ipRange } : {}) }] : [] },
      }));
  }
}
