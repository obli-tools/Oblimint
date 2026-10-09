// Host port evaluation of the setup checks (hostChecks.portsCheck), pure so
// it is unit-tested (ports.test.ts) without Docker.
//
// Only the ports a service of the CURRENT phase binds are fatal: the edge
// (80, 443). DNS (53, PowerDNS — P2) and mail (25 — P4) are deployed later
// (docs/ARCHITECTURE.md §phases): a listener there (systemd-resolved's stub
// on 127.0.0.53:53 on every stock Ubuntu, a local MTA) is only a warning —
// it must be freed before those modules are enabled, never before the install.
// With OBLIMINT_PDNS_BIND (PowerDNS published on given host addresses only),
// a DNS listener on ANOTHER specific address (the stub on 127.0.0.53) is no
// conflict: only one on a bound address or on the wildcard is reported.

export const REQUIRED_PORTS = [80, 443] as const;
export const LATER_PORTS = [
  { port: 53, service: 'DNS' },
  { port: 25, service: 'mail' },
] as const;

export interface PortsOptions {
  /** Host addresses PowerDNS will publish on (config.hosting.pdnsBind; [] = every address). */
  dnsBind?: readonly string[];
  /** Host port of PowerDNS (config.hosting.pdnsPort, default 53). */
  dnsPort?: number;
}

const WILDCARDS = new Set(['0.0.0.0', '::', '*', '']);

/** Host part of a netstat local address ("127.0.0.53:53" → 127.0.0.53, ":::53" → ::). */
function localHost(col: string): string {
  return col.slice(0, col.lastIndexOf(':')).replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

/**
 * Drops the DNS-port listeners that cannot collide with PowerDNS published
 * on `bind` only: a listener on another specific address. Wildcard listeners
 * (and every listener when `bind` is empty) are kept.
 */
export function dropNonConflictingDns(output: string, bind: readonly string[], port: number): string {
  if (bind.length === 0) return output;
  const wanted = new Set(bind.map((a) => a.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')));
  return output.split('\n').filter((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^(tcp|udp)6?$/.test(cols[0])) return true;
    const col = cols[3];
    if (Number(col.slice(col.lastIndexOf(':') + 1)) !== port) return true;
    const host = localHost(col);
    return WILDCARDS.has(host) || wanted.has(host) || wanted.has(host.replace(/^::ffff:/, ''));
  }).join('\n');
}

export interface PortsVerdict {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fixCommand?: string;
}

/** Busy watched ports (port → protocols) in `netstat -ltnu` output. */
export function parseListeners(output: string, watched: readonly number[]): Map<number, Set<string>> {
  const busy = new Map<number, Set<string>>();
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^(tcp|udp)6?$/.test(cols[0])) continue;
    if (cols[0].startsWith('tcp') && !/LISTEN/i.test(line)) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(':') + 1));
    if (!watched.includes(port)) continue;
    if (!busy.has(port)) busy.set(port, new Set());
    busy.get(port)!.add(cols[0].replace(/6$/, ''));
  }
  return busy;
}

const fmt = (busy: Map<number, Set<string>>, ports: readonly number[]): string =>
  ports.filter((p) => busy.has(p)).map((p) => `${p}/${[...busy.get(p)!].sort().join('+')}`).join(', ');

export function evaluatePorts(netstatOutput: string, opts: PortsOptions = {}): PortsVerdict {
  const dnsPort = opts.dnsPort ?? 53;
  const laterPorts = LATER_PORTS.map((l) => (l.service === 'DNS' ? { ...l, port: dnsPort } : l));
  const later = laterPorts.map((l) => l.port);
  const busy = parseListeners(dropNonConflictingDns(netstatOutput, opts.dnsBind ?? [], dnsPort), [...REQUIRED_PORTS, ...later]);
  const busyRequired = REQUIRED_PORTS.filter((p) => busy.has(p));
  const busyLater = laterPorts.filter((l) => busy.has(l.port));
  const fixes: string[] = [];
  if (busyRequired.length) fixes.push('sudo systemctl disable --now nginx apache2 httpd 2>/dev/null');
  if (busy.has(dnsPort) && !opts.dnsBind?.length) {
    fixes.push('# DNS: publish PowerDNS on the host address only (OBLIMINT_PDNS_BIND=<host IP> on the panel container), or disable the resolved stub:');
  }
  if (busy.has(dnsPort)) fixes.push("sudo sed -i 's/^#\\?DNSStubListener=.*/DNSStubListener=no/' /etc/systemd/resolved.conf && sudo systemctl restart systemd-resolved");
  if (busy.has(25)) fixes.push('sudo systemctl disable --now postfix exim4 2>/dev/null');
  const fixCommand = fixes.join('\n') || undefined;
  const laterNote = busyLater.length
    ? `in use, needed later by ${busyLater.map((l) => `${l.service} (${l.port})`).join(', ')}: ${fmt(busy, busyLater.map((l) => l.port))} — free before enabling those modules`
    : '';
  if (busyRequired.length) {
    const detail = `Already in use on the host: ${fmt(busy, REQUIRED_PORTS)}${laterNote ? `; also ${laterNote}` : ''}`;
    return { status: 'fail', detail, fixCommand };
  }
  if (busyLater.length) {
    return { status: 'warn', detail: `Ports ${REQUIRED_PORTS.join(', ')} free; ${laterNote}`, fixCommand };
  }
  return { status: 'ok', detail: `Ports ${[...REQUIRED_PORTS, ...later].join(', ')} free on the host` };
}
