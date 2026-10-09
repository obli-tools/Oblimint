import { isIP } from 'net';
import type Docker from 'dockerode';
import { config } from '../../config';
import { LABELS, PANEL_NETWORK, PDNS_CONTAINER } from '../hosting/naming';
import { hostingLayout } from '../hosting/paths';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, TMPFS_FLAGS, TMPFS_SHARED_FLAGS, withSpecHash } from '../docker/specs';
import { PDNS_API_PORT } from './pdnsClient';

// ─────────────────────────────────────────────────────────────────────────────
// PURE spec of the oblimint-pdns container (pdnsSpec.test.ts). Hardened like
// the edge (docs/P1-PLAN.md §14 H1 adapted to a platform component):
//   - runs as the image user pdns (uid 953), CapDrop ALL, no capability added:
//     port 53 is bound thanks to net.ipv4.ip_unprivileged_port_start (network
//     namespace sysctl, Docker's default since 20.10, set explicitly);
//   - no-new-privileges, read-only root, tmpfs /run (rendered pdns.conf,
//     control socket) and /tmp, PidsLimit, memory limit without swap,
//     oom_score_adj of a platform component, json-file logs 10m × 3;
//   - state = gsqlite3 database in /srv/oblimint/dns (bind, panel only);
//   - host ports 53/udp + 53/tcp only: the API (8081) is NEVER published, it
//     answers on the panel network only (webserver-allow-from = its subnet), D3;
//     by default on every host address; OBLIMINT_PDNS_BIND restricts them to
//     given host addresses (e.g. the LAN / public IP), which is what lets
//     PowerDNS run next to systemd-resolved's stub on 127.0.0.53:53 (Docker
//     cannot bind 0.0.0.0:53 while any other socket holds port 53);
//     OBLIMINT_PDNS_PORT changes the host port (the container keeps 53);
//   - API key from the environment (sealed in app_config, pdnsClient.ts).
// Labels oblimint.internal / oblimint.role=pdns / oblimint.spec-hash.
// ─────────────────────────────────────────────────────────────────────────────

/** uid / gid of the pdns user of powerdns/pdns-auth-* (images/pdns/Dockerfile checks it). */
export const PDNS_UID = 953;
export const PDNS_MEMORY_BYTES = 256 * 1048576;
export const PDNS_PIDS_LIMIT = 256;
/** Mount point of /srv/oblimint/dns in the container (gsqlite3 database). */
export const PDNS_DATA_DIR = '/var/lib/powerdns';

export interface PdnsContainerInput {
  /** Host data root (config.hostDataDir, POSIX). */
  hostDataDir: string;
  apiKey: string;
  /** Subnets of the panel network (webserver-allow-from). */
  apiAllowFrom: string[];
  /** default-soa-content (zones always carry their own SOA; fallback only). */
  defaultSoaContent?: string | null;
  /** Image reference (default OBLIMINT_PDNS_IMAGE:OBLIMINT_IMAGE_TAG). */
  image?: string;
  /** Host addresses port 53 is published on ([] / absent = every address). */
  bindAddresses?: string[];
  /** Host port (default 53; the container always listens on 53). */
  hostPort?: number;
}

/** Docker PortBindings entries for the DNS port: one per host address, or one without HostIp (every address). */
export function pdnsHostBindings(bindAddresses: string[] | undefined, hostPort = 53): Array<{ HostIp?: string; HostPort: string }> {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error(`invalid PowerDNS host port ${hostPort}`);
  const port = String(hostPort);
  const addrs = [...new Set((bindAddresses ?? []).map((a) => a.trim().replace(/^\[(.*)\]$/, '$1')).filter(Boolean))];
  for (const a of addrs) if (isIP(a) === 0) throw new Error(`invalid PowerDNS bind address "${a}" (OBLIMINT_PDNS_BIND expects IP addresses)`);
  return addrs.length ? addrs.map((HostIp) => ({ HostIp, HostPort: port })) : [{ HostPort: port }];
}

export const pdnsImage = (): string => `${config.hosting.pdnsImage}:${config.hosting.imageTag}`;

/** Rejects anything that could break the rendered pdns.conf line (newline, '#'). */
function confValue(v: string, what: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f#]/.test(v)) throw new Error(`invalid ${what} for pdns.conf`);
  return v;
}

/**
 * "address already in use" on the DNS port: a stock Ubuntu keeps
 * systemd-resolved's stub on 127.0.0.53:53, so publishing on every address
 * fails. Says how to publish on the host's own address instead.
 */
export function withBindHint(message: string, bind: string[] = config.hosting.pdnsBind, port = config.hosting.pdnsPort): string {
  if (!/address already in use|port is already allocated/i.test(message)) return message;
  return bind.length
    ? `${message} — port ${port} is already taken on ${bind.join(', ')}: free it or change OBLIMINT_PDNS_BIND / OBLIMINT_PDNS_PORT`
    : `${message} — another service holds port ${port} on the host (systemd-resolved's stub on 127.0.0.53 on a stock Ubuntu): `
      + `set OBLIMINT_PDNS_BIND=<host IP> on the panel container to publish DNS on that address only, or disable the stub (DNSStubListener=no)`;
}

export function pdnsContainerSpec(input: PdnsContainerInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.apiKey)) throw new Error('invalid PowerDNS API key');
  const allow = input.apiAllowFrom.map((s) => confValue(s.trim(), 'subnet')).filter(Boolean);
  if (allow.length === 0) throw new Error('the panel network has no subnet: cannot restrict the PowerDNS API');
  const env = [
    `PDNS_API_KEY=${input.apiKey}`,
    `PDNS_API_PORT=${PDNS_API_PORT}`,
    `PDNS_WEBSERVER_ALLOW_FROM=${allow.join(',')}`,
  ];
  const bindings = pdnsHostBindings(input.bindAddresses, input.hostPort ?? 53);
  if (input.defaultSoaContent) env.push(`PDNS_DEFAULT_SOA_CONTENT=${confValue(input.defaultSoaContent, 'SOA content')}`);
  return withSpecHash({
    name: PDNS_CONTAINER,
    Image: input.image ?? pdnsImage(),
    User: `${PDNS_UID}:${PDNS_UID}`,
    Env: env,
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'pdns' },
    ExposedPorts: { '53/udp': {}, '53/tcp': {}, [`${PDNS_API_PORT}/tcp`]: {} },
    HostConfig: {
      // No HostIp (default): every IPv4 / IPv6 address of the host; with
      // OBLIMINT_PDNS_BIND, only those addresses. 8081 deliberately absent.
      PortBindings: { '53/udp': bindings.map((b) => ({ ...b })), '53/tcp': bindings.map((b) => ({ ...b })) },
      Mounts: [{ Type: 'bind', Source: layout.dnsDir(), Target: PDNS_DATA_DIR, ReadOnly: false }],
      Tmpfs: {
        '/run': `${TMPFS_SHARED_FLAGS},size=8m`,
        '/tmp': `${TMPFS_FLAGS},size=16m`,
      },
      Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '53' },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: PDNS_PIDS_LIMIT,
      Memory: PDNS_MEMORY_BYTES,
      MemorySwap: PDNS_MEMORY_BYTES,
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: PANEL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [PANEL_NETWORK]: { Aliases: [PDNS_CONTAINER] } } },
  });
}

/** IPv4 / IPv6 subnets of a Docker network (IPAM config). */
export function networkSubnets(net: Pick<Docker.NetworkInspectInfo, 'IPAM'> | null | undefined): string[] {
  const cfg = (net?.IPAM?.Config ?? []) as Array<{ Subnet?: string }>;
  return cfg.map((c) => c.Subnet?.trim()).filter((s): s is string => !!s && /^[0-9a-f:.]+\/\d{1,3}$/i.test(s));
}

/** default-soa-content from the settings: '<primary NS>. <rname> 0 10800 3600 604800 3600' ('@' = the zone). */
export function defaultSoaContent(nameservers: string[], hostmasterEmail: string | null, panelHostname: string | null): string | null {
  const primary = (nameservers[0] ?? panelHostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!primary) return null;
  const email = (hostmasterEmail ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  const rname = at > 0 ? `${email.slice(0, at).replace(/\./g, '\\.')}.${email.slice(at + 1)}` : 'hostmaster.@';
  return `${primary}. ${rname.endsWith('@') ? rname : `${rname}.`} 0 10800 3600 604800 3600`;
}
