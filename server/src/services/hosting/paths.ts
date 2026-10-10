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
//     (P3, docs/P3-PLAN.md §4)
//     sites/<siteId>/windows/<windowId>/          root:root 0700  one modification window (hostd)
//       lower/                                     RO bind of releases/<n> (lower layer kept reachable)
//       upper/ work/                               overlay write layer (= the diff) + workdir
//       export/{manifest.json,files/}              changed content exported for the panel (frozen window)
//       (the overlay itself is mounted OVER releases/<n>, propagated rslave into the site containers)
//     sites/<siteId>/work/<workspaceId>/tree/      uid:gid  copy of a release for an adapter run (tools container rw)
//     snapshots/<file>.sql.gz                      root:root 0700  database snapshots (panel)
//     quarantine/<entryId>/{content,meta.json}     root:root 0700  quarantined files (hostd, kept as evidence)
//
//   <root>/mail/                                    (P4, docs/P4-PLAN.md §4: panel + mail containers only, never a tenant)
//     data/<engine>/  config/<engine>/  dkim/  certs/<name>/  redis/  relay/  webmail/<kind>/
//   <root>/edge/conf.d/  edge/certs/  edge/acme/   (edge module)
//   (P4b, docs/P4b-PLAN.md §8 — module edge-robustness; mounted READ-ONLY in oblimint-edge except good/ which is not mounted)
//   <root>/edge/stream.d/   stream{} units          <root>/edge/global.d/   http{}-level units (maps, zones)
//   <root>/edge/aux/<unit>/ auxiliary files (htpasswd, error / waking pages)
//   <root>/edge/sandbox/<run>/  candidate trees tested in isolation (nginx -t -c)
//   <root>/edge/good/       last-known-good copy of conf.d / stream.d / global.d / aux (fallback at edge start)
//   (P4b, docs/P4b-PLAN.md §5 — module apps-core; inside the account tree → XFS project quota)
//   <root>/accounts/<id>/apps/                      root:root 0711
//     <stackId>/                                    root:root 0711
//       src/        git checkout / extracted ZIP / rendered template (panel writes, no-follow reads)
//       files/      files referenced by relative binds of an editor stack (panel writes)
//       volumes/<name>/   named volumes (Docker local driver, o=bind) — written by the containers
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
  /** P3 — adapter tools container: the workspace (copy of the release, rw) and the site data (rw). */
  toolsApp: '/srv/app',
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
    // ── P3 (docs/P3-PLAN.md §4) — hostd creates / mounts them; the panel only READS
    // export/ and work/<id>/tree/ (tenant-derived content: lstat, never follow a symlink).
    windows: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'windows'),
    window: (accountId: number, siteId: number, windowId: number) => joinPosix(site(accountId, siteId), 'windows', windowId),
    windowExport: (accountId: number, siteId: number, windowId: number) => joinPosix(site(accountId, siteId), 'windows', windowId, 'export'),
    windowExportFiles: (accountId: number, siteId: number, windowId: number) => joinPosix(site(accountId, siteId), 'windows', windowId, 'export', 'files'),
    windowManifest: (accountId: number, siteId: number, windowId: number) => joinPosix(site(accountId, siteId), 'windows', windowId, 'export', 'manifest.json'),
    workspaces: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'work'),
    workspace: (accountId: number, siteId: number, workspaceId: number) => joinPosix(site(accountId, siteId), 'work', workspaceId),
    workspaceTree: (accountId: number, siteId: number, workspaceId: number) => joinPosix(site(accountId, siteId), 'work', workspaceId, 'tree'),
    /** Database snapshots (panel writes, root 0700; counted in the account quota). */
    snapshots: (accountId: number) => joinPosix(account(accountId), 'snapshots'),
    snapshotFile: (accountId: number, fileName: string) => joinPosix(account(accountId), 'snapshots', fileName),
    /** Scanner state (ClamAV signatures), panel network only (module scanners). */
    scannerDir: () => joinPosix(r, 'scanner'),
    /** hostd quarantine store (root 0700, never mounted anywhere). */
    quarantine: (accountId: number) => joinPosix(account(accountId), 'quarantine'),
    // ── P4 (docs/P4-PLAN.md §4) — written by the panel, mounted ONLY in the mail
    // containers (never in a tenant container, never in the edge).
    /** Root of everything mail (root:root 0711). */
    mailRoot: () => joinPosix(r, 'mail'),
    /** Engine data: postfix-dovecot → vmail/<domain>/<local>/ (Maildir, uid 5000) + spool; stalwart → its store. */
    mailEngineData: (engine: 'postfix-dovecot' | 'stalwart') => joinPosix(r, 'mail', 'data', engine),
    /** Configuration generated from the panel DB for the engine (maps, passwd-file, sieve, rspamd maps…). */
    mailEngineConfig: (engine: 'postfix-dovecot' | 'stalwart') => joinPosix(r, 'mail', 'config', engine),
    /** DKIM private keys as files (engines reading keys from disk), 0600 owner = engine uid. */
    mailDkim: () => joinPosix(r, 'mail', 'dkim'),
    /** Certificates copied for the mail service: <primary name>/{fullchain,privkey}.pem. */
    mailCerts: () => joinPosix(r, 'mail', 'certs'),
    mailCertDir: (primaryName: string) => joinPosix(r, 'mail', 'certs', primaryName),
    /** Redis of rspamd (postfix-dovecot). */
    mailRedis: () => joinPosix(r, 'mail', 'redis'),
    /** Site relay: credentials (hashes), sender maps, limits, policy state. */
    mailRelay: () => joinPosix(r, 'mail', 'relay'),
    /** Webmail state (Roundcube SQLite DB / SnappyMail data). */
    webmailData: (kind: 'roundcube' | 'snappymail') => joinPosix(r, 'mail', 'webmail', kind),
    /** msmtp configuration of a site (written by the outbound module), inside the RO runtime dir (/etc/oblimint/site/msmtprc). */
    siteMsmtprc: (accountId: number, siteId: number) => joinPosix(site(accountId, siteId), 'runtime', 'msmtprc'),
    // ── P4b (docs/P4b-PLAN.md §5, §8)
    /** Apps of an account (root:root 0711), inside the account quota. */
    apps: (accountId: number) => joinPosix(account(accountId), 'apps'),
    appStack: (accountId: number, stackId: number) => joinPosix(account(accountId), 'apps', stackId),
    /** Source tree of a stack: git checkout / extracted ZIP / rendered catalog files. */
    appSource: (accountId: number, stackId: number) => joinPosix(account(accountId), 'apps', stackId, 'src'),
    /** Files of an editor stack referenced by relative binds. */
    appFiles: (accountId: number, stackId: number) => joinPosix(account(accountId), 'apps', stackId, 'files'),
    appVolumes: (accountId: number, stackId: number) => joinPosix(account(accountId), 'apps', stackId, 'volumes'),
    appVolume: (accountId: number, stackId: number, name: string) => joinPosix(account(accountId), 'apps', stackId, 'volumes', name),
    edgeStreamD: () => joinPosix(r, 'edge', 'stream.d'),
    edgeGlobalD: () => joinPosix(r, 'edge', 'global.d'),
    edgeAux: () => joinPosix(r, 'edge', 'aux'),
    edgeAuxUnit: (unitId: string) => joinPosix(r, 'edge', 'aux', unitId),
    edgeSandbox: () => joinPosix(r, 'edge', 'sandbox'),
    edgeGood: () => joinPosix(r, 'edge', 'good'),
    /** oauth2-proxy sidecars: nothing on disk (config by env), kept for symmetry. */
    authDir: () => joinPosix(r, 'auth'),
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
