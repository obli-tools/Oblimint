import type Docker from 'dockerode';
import type { ContainmentSqlInstance, ContainmentSqlReason, ContainmentSqlSession, DbEngine } from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { inspectContainer } from '../docker/dockerOps';
import { engineFor } from '../docker/engine';
import { cidrContains, normalizeAddress, normalizeCidr } from '../firewall/addresses';
import { dbInstanceContainer } from '../hosting/naming';
import { errText } from '../setup/docker';
import { runSql, SqlError } from './instances';
import type { DbInstanceRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// SQL sessions opened through the external port of an instance (containment,
// step sqlSessions). The firewall freezes them but they stay on the server and
// work again after the lift: they are ended here. The site must never notice.
//
// What decides, from the address the ENGINE sees:
//   socket, loopback                    internal (site, panel, docker exec)
//   a network the container is attached to, except its gateway
//                                       internal (site, tools, admin UI on the account DB network)
//   the gateway of such a network       external: Docker's proxy of the published port
//                                       (IPv6 on an IPv4 network, host loopback) hides the
//                                       real client behind it; no container ever comes from it
//   any other address                   external (the DNAT of the published port keeps it)
//
// Fail closed, towards the site: a row we cannot read, or a container whose
// networks we cannot tell (no gateway), makes the distinction unreliable, and
// then NOTHING is killed on that engine. The report says so.
// ─────────────────────────────────────────────────────────────────────────────

/** Sessions listed in the report, per instance (the count stays exact). */
const MAX_LISTED = 100;
const LIST_TIMEOUT_MS = 20_000;
const SETTLE_ATTEMPTS = 10;
const SETTLE_MS = 500;

export interface InternalNetworks {
  ranges: string[];
  gateways: Set<string>;
}

type InstanceRow = Pick<DbInstanceRow, 'id' | 'name' | 'engine' | 'root_secret' | 'external_enabled' | 'node_id'>;

/** The networks of a container, from its inspect. null: it has none, or one without a gateway. */
export function internalNetworks(info: Pick<Docker.ContainerInspectInfo, 'NetworkSettings'>): InternalNetworks | null {
  const nets = Object.values(info.NetworkSettings?.Networks ?? {});
  const ranges: string[] = [];
  const gateways = new Set<string>();
  const add = (address: string | undefined, bits: number | undefined, gateway: string | undefined): boolean => {
    if (!address) return true;
    const gw = normalizeAddress(gateway);
    if (!gw || !bits) return false;
    try {
      ranges.push(normalizeCidr(`${address}/${bits}`, { 4: 0, 6: 0 }).cidr);
    } catch {
      return false;
    }
    gateways.add(gw.ip);
    return true;
  };
  for (const n of nets) {
    if (!add(n.IPAddress, n.IPPrefixLen, n.Gateway) || !add(n.GlobalIPv6Address, n.GlobalIPv6PrefixLen, n.IPv6Gateway)) return null;
  }
  return ranges.length ? { ranges, gateways } : null;
}

export type SessionClass = 'internal' | 'external' | 'unknown';

/** One client address as the engine reports it. '' is a socket or a thread of the server. */
export function classifyAddress(address: string, nets: InternalNetworks): SessionClass {
  if (address === '') return 'internal';
  const a = normalizeAddress(address);
  if (!a) return 'unknown';
  if (a.ip === '::1' || cidrContains('127.0.0.0/8', a.ip)) return 'internal';
  if (nets.gateways.has(a.ip)) return 'external';
  return nets.ranges.some((r) => cidrContains(r, a.ip)) ? 'internal' : 'external';
}

/**
 * The address in PROCESSLIST.HOST: 'localhost' (socket), '' (thread of the
 * server), 'ip:port', '[ipv6]:port'. null: anything else, a name for instance
 * (--skip-name-resolve is on: never expected).
 */
export function mysqlHostAddress(host: string): string | null {
  if (host === '' || host === 'localhost') return '';
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracket) return normalizeAddress(bracket[1])?.ip ?? null;
  const port = /^(.+):\d+$/.exec(host);
  if (port) {
    const a = normalizeAddress(port[1]);
    if (a) return a.ip;
  }
  return normalizeAddress(host)?.ip ?? null;
}

interface Session { id: string; user: string; address: string; /** As the engine wrote it (PostgreSQL compares it again when killing). */ raw: string }

const isHex = (v: string) => /^(?:[0-9a-fA-F]{2})*$/.test(v);
const fromHex = (v: string) => Buffer.from(v, 'hex').toString('utf8');

/** Lists the sessions; hex so that no user or host can forge a column. A line we cannot read: unknown set. */
export function parseSessions(engine: DbEngine, stdout: string): { sessions: Session[]; unreadable: boolean } {
  const pg = dbFamilyOf(engine) === 'postgresql';
  const sessions: Session[] = [];
  let unreadable = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [id, user, host, ...rest] = line.split('\t');
    if (rest.length || !/^\d+$/.test(id ?? '') || user === undefined || host === undefined || !isHex(user) || !isHex(host)) { unreadable = true; continue; }
    const text = fromHex(host);
    const address = pg ? (text === '' ? '' : normalizeAddress(text)?.ip ?? null) : mysqlHostAddress(text);
    if (address === null) { unreadable = true; continue; }
    sessions.push({ id, user: fromHex(user), address, raw: text });
  }
  return { sessions, unreadable };
}

const LIST_SQL = {
  mysql: "SELECT ID, HEX(COALESCE(USER, '')), HEX(COALESCE(HOST, '')) FROM information_schema.PROCESSLIST",
  postgresql: "SELECT pid, encode(convert_to(COALESCE(usename::text, ''), 'UTF8'), 'hex'), encode(convert_to(COALESCE(host(client_addr), ''), 'UTF8'), 'hex') FROM pg_stat_activity",
} as const;

async function listSessions(docker: Docker, row: InstanceRow, password?: string): Promise<{ sessions: Session[]; unreadable: boolean }> {
  const out = await runSql(docker, row, { sql: `${LIST_SQL[dbFamilyOf(row.engine)]};` }, { batch: true, timeoutMs: LIST_TIMEOUT_MS, ...(password ? { password } : {}) });
  return parseSessions(row.engine, out.stdout);
}

async function killSessions(docker: Docker, row: InstanceRow, sessions: Session[], password?: string): Promise<void> {
  const opts = { batch: true, timeoutMs: LIST_TIMEOUT_MS, ...(password ? { password } : {}) };
  if (dbFamilyOf(row.engine) === 'postgresql') {
    // pid AND address: a pid reused since the listing is not this session. Both come from our parser (digits, normalized address).
    const pairs = sessions.filter((s) => /^[0-9a-fA-F:.]+$/.test(s.raw)).map((s) => `(${s.id}, '${s.raw}')`).join(', ');
    if (!pairs) return;
    await runSql(docker, row, { sql: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE (pid, host(client_addr)) IN (${pairs});` }, opts);
    return;
  }
  for (const s of sessions) {
    try {
      await runSql(docker, row, { sql: `KILL CONNECTION ${s.id};` }, opts);
    } catch (err) {
      // ERROR 1094 Unknown thread id: it ended by itself. The ids are never reused while the server runs.
      if (!(err instanceof SqlError) || !/\b1094\b/.test(err.output)) throw err;
    }
  }
}

function report(row: InstanceRow, state: ContainmentSqlInstance['state'], fields: Partial<ContainmentSqlInstance> = {}): ContainmentSqlInstance {
  return { instanceId: row.id, name: row.name, engine: row.engine, state, reason: null, killed: 0, kept: 0, remaining: 0, sessions: [], error: null, ...fields };
}

const errorOf = (err: unknown): string => (err instanceof SqlError ? `${err.message}: ${err.output}` : errText(err)).slice(0, 300);
const toListed = (sessions: Session[]): ContainmentSqlSession[] => sessions.slice(0, MAX_LISTED).map((s) => ({ user: s.user, ip: s.address }));

interface Scan {
  row: InstanceRow;
  docker: Docker | null;
  nets: InternalNetworks | null;
  external: Session[];
  kept: number;
  /** Nothing more to do on this instance. */
  result: ContainmentSqlInstance | null;
  /** The distinction cannot be trusted here: nothing is killed on its engine. */
  reason: ContainmentSqlReason | null;
}

async function scanInstance(row: InstanceRow, dockerOf: (r: InstanceRow) => Promise<Docker>, passwordOf: (r: InstanceRow) => string | undefined): Promise<Scan> {
  const scan: Scan = { row, docker: null, nets: null, external: [], kept: 0, result: null, reason: null };
  try {
    const docker = await dockerOf(row);
    scan.docker = docker;
    const info = await inspectContainer(docker, dbInstanceContainer(row.id));
    if (!info?.State?.Running) { scan.result = report(row, 'stopped'); return scan; }
    const published = Object.keys(info.HostConfig?.PortBindings ?? {}).length > 0;
    if (!row.external_enabled && !published) { scan.result = report(row, 'notExposed'); return scan; }
    scan.nets = internalNetworks(info);
    if (!scan.nets) { scan.reason = 'unknownNetwork'; return scan; }
    const { sessions, unreadable } = await listSessions(docker, row, passwordOf(row));
    if (unreadable) { scan.reason = 'unreadableSession'; return scan; }
    const classes = sessions.map((s) => ({ s, c: classifyAddress(s.address, scan.nets as InternalNetworks) }));
    if (classes.some((x) => x.c === 'unknown')) { scan.reason = 'unreadableSession'; return scan; }
    scan.external = classes.filter((x) => x.c === 'external').map((x) => x.s);
    scan.kept = classes.length - scan.external.length;
  } catch (err) {
    scan.result = report(row, 'failed', { error: errorOf(err) });
  }
  return scan;
}

async function closeInstance(scan: Scan, passwordOf: (r: InstanceRow) => string | undefined, settleMs: number): Promise<ContainmentSqlInstance> {
  const { row, external, kept } = scan;
  if (!external.length) return report(row, 'closed', { kept });
  const docker = scan.docker as Docker;
  const nets = scan.nets as InternalNetworks;
  const listed = toListed(external);
  try {
    await killSessions(docker, row, external, passwordOf(row));
    // The engine ends a session asynchronously (a running statement rolls back first).
    const targeted = new Set(external.map((s) => s.id));
    let left: Session[] = [];
    for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
      const { sessions } = await listSessions(docker, row, passwordOf(row));
      left = sessions.filter((s) => classifyAddress(s.address, nets) === 'external');
      if (!left.length) break;
      if (i < SETTLE_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, settleMs));
    }
    const killed = external.length - left.filter((s) => targeted.has(s.id)).length;
    if (left.length) return report(row, 'failed', { killed, kept, remaining: left.length, sessions: listed, error: `${left.length} external session(s) still open` });
    return report(row, 'closed', { killed, kept, sessions: listed });
  } catch (err) {
    return report(row, 'failed', { kept, remaining: external.length, sessions: listed, error: errorOf(err) });
  }
}

export interface CloseExternalOptions {
  dockerOf?: (row: InstanceRow) => Promise<Docker>;
  /** Tests: the superuser password, instead of the sealed secret of the row. */
  passwordOf?: (row: InstanceRow) => string | undefined;
  settleMs?: number;
}

/**
 * Lists every instance first, then kills: one instance whose sessions cannot be
 * told apart holds back all the instances of its engine. Never throws: each
 * instance reports its own state, and a failure leaves the others untouched.
 */
export async function closeExternalSessionsOn(rows: InstanceRow[], opts: CloseExternalOptions = {}): Promise<ContainmentSqlInstance[]> {
  const dockerOf = opts.dockerOf ?? ((row: InstanceRow) => engineFor(row.node_id));
  const passwordOf = opts.passwordOf ?? (() => undefined);
  const scans: Scan[] = [];
  for (const row of rows) scans.push(await scanInstance(row, dockerOf, passwordOf));
  const unreliable = new Set(scans.filter((s) => s.reason).map((s) => s.row.engine));
  const out: ContainmentSqlInstance[] = [];
  for (const scan of scans) {
    if (scan.result) out.push(scan.result);
    else if (unreliable.has(scan.row.engine)) out.push(report(scan.row, 'unreliable', { reason: scan.reason ?? 'sameEngine' }));
    else out.push(await closeInstance(scan, passwordOf, opts.settleMs ?? SETTLE_MS));
  }
  return out;
}

/** The instances of an account, for the containment. */
export async function closeAccountExternalSessions(accountId: number): Promise<ContainmentSqlInstance[]> {
  const rows = await db('db_instances').where({ account_id: accountId }).whereNot('status', 'deleting').orderBy('id')
    .select('id', 'name', 'engine', 'root_secret', 'external_enabled', 'node_id') as InstanceRow[];
  return closeExternalSessionsOn(rows);
}
