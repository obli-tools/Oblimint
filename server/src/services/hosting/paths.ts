import path from 'path';
import { config, dataDir } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Hosting filesystem layout (docs/P1-PLAN.md §Arborescence). SHARED CONTRACT:
// hostd (Go) computes the very same paths from its own root — keep
// hostd/layout.go in sync with this file.
//
//   <root>/accounts/<accountId>/                 root:root 0711
//     staging/                                   uid:gid   0750  (SFTP /staging)
//       <siteSlug>/                              uid:gid   0750
//     data/                                      root:gid  0750  (SFTP /data; root-owned: data/<slug> is a bind source, the uid must not swap it)
//       <siteSlug>/<data path>/                  uid:gid   0750  (→ /srv/data in the site container)
//     filesrv/                                   uid:gid   0700  (SFTPGo state, host keys)
//     sites/                                     root:root 0711
//       <siteId>/                                root:root 0755
//         repo.git/                              root:root 0700  (bare repo, panel only)
//         releases/                              root:root 0755  (→ /srv/releases, READ-ONLY)
//           <n>/                                 immutable release trees
//           current -> <n>                       relative symlink, switched atomically
//         runtime/                               root:root 0755  (→ /etc/oblimint/site, READ-ONLY)
//           <role>[-<runtimeId>].json            SiteRuntimeConfig per container
//
//     dbsock/                                    root:gid  0750  (P2: parent of the socket dirs, root-owned: bind sources)
//       mysql/                                   root:gid  0750  → /run/mysqld (RO) in EVERY site container; holds the symlink
//                                                                mysqld.sock -> /run/oblimint-db/i-<default id>/mysqld.sock (hostd)
//       postgresql/                              root:gid  0750  → /run/postgresql (RO) in every site container; symlink
//                                                                .s.PGSQL.5432 -> /run/oblimint-db/i-<default id>/.s.PGSQL.5432
//       i-<instanceId>/                          uid:gid   0750  socket dir of one instance (rw in the DB container;
//                                                                sites see it under /run/oblimint-db/i-<id>, RO bind of dbsock/)
//     databases/                                 root:root 0711  (P2)
//       <instanceId>/                            uid:gid   0700  data dir of one instance (counted in the XFS project)
//
//   <root>/edge/conf.d/  edge/certs/  edge/acme/   (edge module)
//   <root>/dns/                                     (P2: PowerDNS state, panel only)
//   <root>/logs/<accountId>/<siteId>/              (P2: persisted access logs, panel only)
//   <root>/run/hostd.sock                           (never mounted in tenant containers)
// ─────────────────────────────────────────────────────────────────────────────

/** Container-side mount points (images/ contract). */
export const CONTAINER_PATHS = {
  /** P2 — site containers: default socket dirs + every instance socket dir (read-write: clients connect()). */
  dbSocketMysql: '/run/mysqld',
  dbSocketPostgresql: '/run/postgresql',
  /**
   * NEVER under /run/oblimint (OBLIMINT_RUN of the site images, written by the
   * account uid): Docker would create the missing parent of the bind as
   * root:root 0755 on the /run tmpfs and every site container would crash-loop
   * (images/*: prepare_dirs). Same value in shared DB_SOCKET_PATHS.instancesDir
   * and hostd/layout.go dbSocketsInContainer.
   */
  dbSocketsAll: '/run/oblimint-db',
  /** Site containers: the releases/ directory, READ-ONLY. Docroot = /srv/releases/current/<docroot>. */
  releases: '/srv/releases',
  /** Site containers: data/<siteSlug>, read-write, never executed. */
  data: '/srv/data',
  /** Site containers: runtime/<role>.json mounted as site.json (read-only directory). */
  siteConfigDir: '/etc/oblimint/site',
  /** File server: the account root seen by SFTP users (/staging, /data). */
  filesRoot: '/srv/files',
  /** File server: SFTPGo state directory. */
  filesrvState: '/var/lib/sftpgo',
} as const;

function joinPosix(...parts: Array<string | number>): string {
  return path.posix.join(...parts.map(String));
}

/** dataDir as a POSIX path (Docker binds and hostd use POSIX paths). */
function posixRoot(dir: string): string {
  return dir.replace(/\\/g, '/');
}

/**
 * Builds the layout under a given root. `local` = paths as seen by THIS
 * process (panel container, or a test temp dir); `host` = paths on the
 * Docker host (bind sources).
 */
export function hostingLayout(root: string) {
  const r = posixRoot(root);
  const account = (accountId: number) => joinPosix(r, 'accounts', accountId);
  const site = (accountId: number, siteId: number) => joinPosix(account(accountId), 'sites', siteId);
  return {
    root: r,
    accountsRoot: () => joinPosix(r, 'accounts'),
    account,
    staging: (accountId: number) => joinPosix(account(accountId), 'staging'),
    siteStaging: (accountId: number, siteSlug: string) => joinPosix(account(accountId), 'staging', siteSlug),
    data: (accountId: number) => joinPosix(account(accountId), 'data'),
    siteData: (accountId: number, siteSlug: string) => joinPosix(account(accountId), 'data', siteSlug),
    fileServerState: (accountId: number) => joinPosix(account(accountId), 'filesrv'),
    site,
    repo: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'repo.git'),
    releases: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'releases'),
    release: (accountId: number, siteId: number, n: number) => joinPosix(site(accountId, siteId), 'releases', n),
    currentLink: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'releases', 'current'),
    runtime: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'runtime'),
    // P2 — database sockets / data (hostd creates them; see the tree above).
    dbSockets: (accountId: number) => joinPosix(account(accountId), 'dbsock'),
    dbSocketDefault: (accountId: number, family: 'mysql' | 'postgresql') => joinPosix(account(accountId), 'dbsock', family),
    dbSocketInstance: (accountId: number, instanceId: number) => joinPosix(account(accountId), 'dbsock', `i-${instanceId}`),
    dbData: (accountId: number, instanceId: number) => joinPosix(account(accountId), 'databases', instanceId),
    dnsDir: () => joinPosix(r, 'dns'),
    logsDir: () => joinPosix(r, 'logs'),
    siteLogs: (accountId: number, siteId: number) => joinPosix(r, 'logs', accountId, siteId),
    edge: () => joinPosix(r, 'edge'),
    edgeConfD: () => joinPosix(r, 'edge', 'conf.d'),
    edgeCerts: () => joinPosix(r, 'edge', 'certs'),
    edgeAcme: () => joinPosix(r, 'edge', 'acme'),
    runDir: () => joinPosix(r, 'run'),
  };
}

export type HostingLayout = ReturnType<typeof hostingLayout>;

/** Paths as seen by the panel process (it mounts /srv/oblimint at the same path). */
export const localPaths: HostingLayout = hostingLayout(dataDir);

/** Paths on the Docker host (bind mount sources). */
export const hostPaths: HostingLayout = hostingLayout(config.hostDataDir);

/** Name of the runtime config file of one container of a site. */
export function runtimeConfigFile(role: 'primary' | 'secondary' | 'preview', runtimeId?: number | null): string {
  return role === 'secondary' ? `secondary-${runtimeId}.json` : `${role}.json`;
}
