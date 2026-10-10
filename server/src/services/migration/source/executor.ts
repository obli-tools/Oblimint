import type { MigrationCommandTemplateInfo, MigrationHostKey } from '@oblimint/shared';
import { db } from '../../../db';
import { SecretBoxError, openJson } from '../../../utils/secretBox';
import { SourceConnectionError, type SessionContext, type SourceSession } from '../contracts/source';
import { createSourceSession } from './session';
import { HostKeyRejectedError, connectSsh, type SourceSecret, type SshConnectParams, type SshConnectResult } from './ssh';
import { templateInfos } from './templates';

// ─────────────────────────────────────────────────────────────────────────────
// Read-only executor (docs/P5-PLAN.md §5). OWNED BY MODULE `source-executor`.
//
// The ONLY way the panel talks to a CWP source: closed allow-list of command
// templates (contracts/source.ts CommandTemplateArgs), argument validation +
// deny list (§5.3), SQL guard (§5.4), POSIX single-quote rendering, optional
// `sudo -n --`, phase rule (transfer-only templates refused in discovery),
// command log (migration_command_log; output of sensitive templates never
// logged / kept), SSH with a PINNED host key (ssh2), rsync pulls through the
// tunnel shim. There is no exported "exec(string)".
//
// Files: templates.ts (registry + rendering), pathPolicy.ts, sqlGuard.ts,
// ssh.ts (transport, host key), session.ts (SourceSession), commandLog.ts,
// rsync.ts / rsyncArgv.ts / tunnel.ts / rsyncShim.ts (pulls).
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'key' | 'password';
  secret_sealed: string | null;
  use_sudo: boolean;
  host_key_algorithm: string | null;
  host_key_fingerprint: string | null;
  pending_host_key_algorithm: string | null;
  pending_host_key_fingerprint: string | null;
}

type Connector = (p: SshConnectParams) => Promise<SshConnectResult>;
let connector: Connector = connectSsh;

/** Tests: replace the SSH transport (fake connection). */
export function setSshConnectorForTests(c: Connector | null): void {
  connector = c ?? connectSsh;
}

/** Opens the sealed credentials. Throws SourceConnectionError('noSecret'). Never logs them. */
export function openSourceSecret(row: Pick<SourceRow, 'secret_sealed'>): SourceSecret {
  if (!row.secret_sealed) throw new SourceConnectionError('noSecret', 'No credentials are stored for this source');
  try {
    return openJson<SourceSecret>('migration-source', row.secret_sealed);
  } catch (err) {
    if (err instanceof SecretBoxError) {
      throw new SourceConnectionError('noSecret', 'The stored credentials cannot be opened (SESSION_SECRET rotated?): enter them again');
    }
    throw new SourceConnectionError('noSecret', 'The stored credentials are unreadable');
  }
}

/** Remembers the key presented while unpinned / mismatching (displayed for confirmation, never trusted). */
export async function storePendingHostKey(sourceId: number, key: MigrationHostKey): Promise<void> {
  await db('migration_sources').where({ id: sourceId }).update({
    pending_host_key_algorithm: key.algorithm.slice(0, 64),
    pending_host_key_fingerprint: key.fingerprint.slice(0, 128),
    updated_at: db.fn.now(),
  });
}

/**
 * Connects to a source with its pinned key (null = capture only: the
 * connection is refused right after the key exchange, nothing runs). A
 * rejected key is stored as pending before the error is rethrown.
 */
export async function connectSource(row: SourceRow): Promise<SshConnectResult> {
  const secret = openSourceSecret(row);
  try {
    return await connector({
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.auth_method,
      secret,
      pinnedFingerprint: row.host_key_fingerprint,
    });
  } catch (err) {
    if (err instanceof HostKeyRejectedError) await storePendingHostKey(row.id, err.hostKey);
    throw err;
  }
}

export async function loadSourceRow(sourceId: number): Promise<SourceRow | null> {
  const row = await db('migration_sources').where({ id: sourceId }).first();
  return (row as SourceRow | undefined) ?? null;
}

export const sourceExecutor = {
  /** Opens a read-only session (SSH connection, host key checked against the pin). Throws SourceConnectionError. */
  async session(sourceId: number, ctx: SessionContext): Promise<SourceSession> {
    if (!ctx || (ctx.phase !== 'discovery' && ctx.phase !== 'transfer')) {
      throw new SourceConnectionError('connectFailed', 'Invalid session phase');
    }
    const row = await loadSourceRow(sourceId);
    if (!row) throw new SourceConnectionError('connectFailed', 'Unknown migration source');
    // MG3: nothing pinned → no connection at all (the test route captures the key).
    if (!row.host_key_fingerprint) throw new SourceConnectionError('hostKeyUnpinned', 'The host key of the source is not pinned yet');
    if (ctx.signal?.aborted) throw new SourceConnectionError('connectFailed', 'Cancelled');
    const { conn } = await connectSource(row);
    return createSourceSession({ sourceId, useSudo: !!row.use_sudo, conn, ctx });
  },

  /** The allow-list, for GET /system/migration/allowlist (documentation in the UI). */
  templates(): MigrationCommandTemplateInfo[] {
    return templateInfos();
  },
};
