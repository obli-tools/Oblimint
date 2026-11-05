import type { ContainmentSqlInstance } from '@oblimint/shared';

const MAX_LISTED = 100;

/** One run of the step sqlSessions over the previous ones: what was killed stays in the report. */
export function mergeSqlReports(before: ContainmentSqlInstance[], now: ContainmentSqlInstance[]): ContainmentSqlInstance[] {
  return now.map((n) => {
    const b = before.find((x) => x.instanceId === n.instanceId);
    if (!b) return n;
    return { ...n, killed: b.killed + n.killed, sessions: [...b.sessions, ...n.sessions].slice(0, MAX_LISTED) };
  });
}
