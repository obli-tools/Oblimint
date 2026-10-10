import type { EdgeUnitOwnerKind, EdgeUnitStatusKind } from '@oblimint/shared';

// Shared constants of the edge units (module edge-robustness, docs/P4b-PLAN.md §8).

export const EDGE_UNIT_OWNER_KINDS: readonly EdgeUnitOwnerKind[] = [
  'site-domain', 'platform', 'contributed', 'proxy-host', 'redirection', 'dead-host', 'stream', 'global',
];

export const EDGE_UNIT_STATUSES: readonly EdgeUnitStatusKind[] = ['pending', 'active', 'quarantined', 'stub', 'upstreamUnreachable', 'disabled'];
