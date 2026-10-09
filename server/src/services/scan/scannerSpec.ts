import type Docker from 'dockerode';
import { LABELS, PANEL_NETWORK, SCANNER_CONTAINER, scannerImage } from '../hosting/naming';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, TENANT_OOM_SCORE_ADJ, TMPFS_SHARED_FLAGS, withSpecHash } from '../docker/specs';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container spec of oblimint-scanner (docs/P3-PLAN.md §4.2, §9.1, M10) —
// scannerSpec.test.ts. Runtime contract: images/scanner/README.md.
//
// Hardening, and why each choice:
//  - User SCANNER_UID:SCANNER_UID (the image's `scand` user): clamd,
//    freshclam and scand all run unprivileged from the start, so no privilege
//    drop happens inside → CapDrop ALL and NO CapAdd (clamd's `User` /
//    freshclam's `DatabaseOwner` switching is not used).
//  - Panel network only, NO published port: only the panel talks to scand
//    (:8080), with the shared key. Tenants are never on that network and the
//    scanner never mounts a tenant tree: the panel SENDS the content.
//  - ReadonlyRootfs; writable: /var/lib/clamav (bind of the panel-only
//    hostPaths.scannerDir()/clamav, signatures survive recreations), /tmp
//    (YARA temp files, tmpfs sized for SCAND_CONCURRENCY files) and /run
//    (rendered configs, clamd socket).
//  - Tenant seccomp profile: the scanner parses hostile content (defence in
//    depth; clamd / Go only need ordinary syscalls).
//  - Memory without swap: 1.5 GiB with ClamAV (signatures ≈ 1 GiB resident;
//    reloads are NOT concurrent — ConcurrentDatabaseReload no — so no 2×
//    peak), 256 MiB YARA only. Tmpfs pages count in that limit.
//  - OomScoreAdj = tenant value (500), not the platform's: under host memory
//    pressure losing the scanner is harmless (publication falls back to the
//    heuristics with scannerUnavailable, never auto-validated — M10), losing
//    the edge / panel is not.
//  - RestartPolicy unless-stopped, json-file log rotation.
// ─────────────────────────────────────────────────────────────────────────────

/** uid/gid of the `scand` user of images/scanner (owner of /var/lib/clamav). */
export const SCANNER_UID = 954;
export const SCAND_PORT = 8080;
export const SCANNER_MEMORY_CLAMAV_BYTES = 1536 * 1048576;
export const SCANNER_MEMORY_LIGHT_BYTES = 256 * 1048576;
export const SCANNER_PIDS_LIMIT = 256;
/** Files scand handles at once (its tmpfs /tmp holds one copy of each). */
export const SCAND_CONCURRENCY = 4;
export const SCANNER_STOP_TIMEOUT_SEC = 20;
export const CONTAINER_CLAMAV_DIR = '/var/lib/clamav';

export interface ScannerContainerInput {
  /** Shared key (SCAND_KEY). */
  key: string;
  clamav: boolean;
  yara: boolean;
  /** freshclam runs per day (1 … 24). */
  signatureChecksPerDay: number;
  /** settings scanner.maxFileSizeMb: scand body limit + clamd MaxFileSize / StreamMaxLength. */
  maxFileSizeMb: number;
  /** Host path of the signature directory (hostPaths.scannerDir()/clamav). */
  clamavDir: string;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function scannerTmpfsMb(maxFileSizeMb: number): number {
  return Math.max(64, Math.ceil(maxFileSizeMb) * SCAND_CONCURRENCY + 32);
}

export function scannerContainerSpec(input: ScannerContainerInput): Docker.ContainerCreateOptions {
  const name = SCANNER_CONTAINER;
  const checks = Math.min(24, Math.max(1, Math.round(input.signatureChecksPerDay)));
  const maxMb = Math.min(512, Math.max(1, Math.round(input.maxFileSizeMb)));
  const memory = input.clamav ? SCANNER_MEMORY_CLAMAV_BYTES : SCANNER_MEMORY_LIGHT_BYTES;
  return withSpecHash({
    name,
    Image: scannerImage(),
    User: `${SCANNER_UID}:${SCANNER_UID}`,
    Env: [
      `SCAND_KEY=${input.key}`,
      `SCAND_CLAMAV=${input.clamav ? 1 : 0}`,
      `SCAND_YARA=${input.yara ? 1 : 0}`,
      `FRESHCLAM_CHECKS=${checks}`,
      `SCAND_MAX_FILE_MB=${maxMb}`,
      `SCAND_CONCURRENCY=${SCAND_CONCURRENCY}`,
    ],
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'scanner' },
    StopTimeout: SCANNER_STOP_TIMEOUT_SEC,
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: posix(input.clamavDir), Target: CONTAINER_CLAMAV_DIR, ReadOnly: false },
      ],
      Tmpfs: {
        '/tmp': `${TMPFS_SHARED_FLAGS},size=${scannerTmpfsMb(maxMb)}m`,
        '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: SCANNER_PIDS_LIMIT,
      OomScoreAdj: TENANT_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: PANEL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [PANEL_NETWORK]: { Aliases: [name] } } },
  });
}
