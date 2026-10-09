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
  networks: Map<string, { Aliases: string[] }>;
  startedAt: string | null;
}

export interface FakeNetwork {
  name: string;
  labels: Record<string, string>;
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
      id: `c${++seq}`.padEnd(12, '0'),
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
        for (const [n, ep] of c.networks) nets[n] = { Aliases: ep.Aliases, DNSNames: null };
        return {
          Id: c.id,
          Name: `/${c.name}`,
          Config: { Image: c.image, Labels: c.labels },
          State: {
            Status: c.state, Running: c.state === 'running' || c.state === 'restarting', StartedAt: c.startedAt ?? '0001-01-01T00:00:00Z', ExitCode: 0, Error: '',
          },
          HostConfig: { Memory: c.spec?.HostConfig?.Memory ?? 0, NanoCpus: c.spec?.HostConfig?.NanoCpus ?? 0 },
          NetworkSettings: { Networks: nets },
        } as unknown as Docker.ContainerInspectInfo;
      },
      async start() {
        const c = need();
        if (c.state === 'running') throw dockerError(304, 'container already started');
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
    const networks = new Map<string, { Aliases: string[] }>();
    const mode = spec.HostConfig?.NetworkMode;
    if (mode && mode !== 'host') {
      if (!this.networks.has(mode)) throw dockerError(404, `network ${mode} not found`);
      networks.set(mode, { Aliases: (spec.NetworkingConfig?.EndpointsConfig?.[mode]?.Aliases as string[] | undefined) ?? [] });
    }
    this.addContainer({ name, image: spec.Image!, labels: { ...(spec.Labels ?? {}) }, state: 'created', spec, networks, startedAt: null });
    this.calls.push(`create ${name}`);
    return this.getContainer(name);
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
        NetworkSettings: { Networks: Object.fromEntries([...c.networks].map(([n, ep]) => [n, { Aliases: ep.Aliases }])) },
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
        const containers: Record<string, { Name: string }> = {};
        for (const c of self.containers.values()) if (c.networks.has(name)) containers[c.id] = { Name: c.name };
        return { Name: n.name, Labels: n.labels, Containers: containers };
      },
      async connect(opts: { Container: string; EndpointConfig?: { Aliases?: string[] } }) {
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
        c.networks.set(name, { Aliases: opts.EndpointConfig?.Aliases ?? [] });
        self.calls.push(`connect ${c.name} ${name}${opts.EndpointConfig?.Aliases?.length ? ` alias=${opts.EndpointConfig.Aliases.join(',')}` : ''}`);
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

  async createNetwork(opts: { Name: string; Labels?: Record<string, string> }) {
    this.guard();
    if (this.networks.has(opts.Name)) throw dockerError(409, `network with name ${opts.Name} already exists`);
    if (this.networkCreateFails) throw dockerError(500, this.networkCreateFails);
    this.networks.set(opts.Name, { name: opts.Name, labels: opts.Labels ?? {} });
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
      .map((n) => ({ Name: n.name, Id: `n-${n.name}`, Labels: n.labels }));
  }
}
