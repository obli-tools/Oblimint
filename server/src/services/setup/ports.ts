// Host port evaluation of the setup checks (hostChecks.portsCheck), pure so
// it is unit-tested (ports.test.ts) without Docker.
//
// Only the ports a service of the CURRENT phase binds are fatal: the edge
// (80, 443). DNS (53, PowerDNS — P2) and mail (25 — P4) are deployed later
// (docs/ARCHITECTURE.md §phases): a listener there (systemd-resolved's stub
// on 127.0.0.53:53 on every stock Ubuntu, a local MTA) is only a warning —
// it must be freed before those modules are enabled, never before the install.

export const REQUIRED_PORTS = [80, 443] as const;
export const LATER_PORTS = [
  { port: 53, service: 'DNS' },
  { port: 25, service: 'mail' },
] as const;

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

export function evaluatePorts(netstatOutput: string): PortsVerdict {
  const later = LATER_PORTS.map((l) => l.port);
  const busy = parseListeners(netstatOutput, [...REQUIRED_PORTS, ...later]);
  const busyRequired = REQUIRED_PORTS.filter((p) => busy.has(p));
  const busyLater = LATER_PORTS.filter((l) => busy.has(l.port));
  const fixes: string[] = [];
  if (busyRequired.length) fixes.push('sudo systemctl disable --now nginx apache2 httpd 2>/dev/null');
  if (busy.has(53)) fixes.push("sudo sed -i 's/^#\\?DNSStubListener=.*/DNSStubListener=no/' /etc/systemd/resolved.conf && sudo systemctl restart systemd-resolved");
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
