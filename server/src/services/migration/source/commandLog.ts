import type { MigrationCommandPhase, MigrationCommandStatus } from '@oblimint/shared';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Command log of the read-only executor (docs/P5-PLAN.md §5.5): ONE
// migration_command_log row per call, refusals included. Holds the rendered
// command (arguments included), never the output — of any template — and for
// sensitive templates a generic error only. The sink is injectable (tests).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_LOGGED_COMMAND = 8 * 1024;

export interface CommandLogRow {
  sourceId: number;
  discoveryId: number | null;
  runId: number | null;
  template: string;
  /** Rendered command ('<invalid>' when the rendering itself was refused). */
  command: string;
  phase: MigrationCommandPhase;
  sensitive: boolean;
  status: MigrationCommandStatus;
  exitCode: number | null;
  bytesOut: number;
  durationMs: number | null;
  /** Refusal reason / failure text. NEVER output. */
  error: string | null;
}

export interface CommandLogSink {
  write(row: CommandLogRow): Promise<void>;
}

export function capCommand(command: string): string {
  if (command.length <= MAX_LOGGED_COMMAND) return command;
  const marker = ' …[truncated]';
  return command.slice(0, MAX_LOGGED_COMMAND - marker.length) + marker;
}

/** The production sink. Never throws (a log failure must not hide the command's own outcome). */
export const dbCommandLogSink: CommandLogSink = {
  async write(row: CommandLogRow): Promise<void> {
    try {
      await db('migration_command_log').insert({
        source_id: row.sourceId,
        discovery_id: row.discoveryId,
        run_id: row.runId,
        template: row.template.slice(0, 64),
        command: capCommand(row.command),
        phase: row.phase,
        sensitive: row.sensitive,
        status: row.status,
        exit_code: row.exitCode,
        bytes_out: row.bytesOut,
        duration_ms: row.durationMs,
        error: row.error ? row.error.slice(0, 1000) : null,
      });
    } catch (err) {
      // Metadata only (no command text: it may be long; never any output).
      logger.warn({ err: (err as Error).message, sourceId: row.sourceId, template: row.template, status: row.status },
        'migration command log write failed');
    }
  },
};

let currentSink: CommandLogSink = dbCommandLogSink;

export function commandLogSink(): CommandLogSink {
  return currentSink;
}

export function setCommandLogSinkForTests(sink: CommandLogSink | null): void {
  currentSink = sink ?? dbCommandLogSink;
}

/** In-memory sink (tests). */
export class MemoryCommandLogSink implements CommandLogSink {
  readonly rows: CommandLogRow[] = [];
  async write(row: CommandLogRow): Promise<void> {
    this.rows.push({ ...row, command: capCommand(row.command) });
  }
}
