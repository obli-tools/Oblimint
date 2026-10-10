import type { AppStackStatus } from '@oblimint/shared';
import type { HostingActor, HostingNeed } from '../hosting/access';
import { loadOwned } from '../hosting/p4bAccess';

// Access to app stacks (docs/P4b-PLAN.md §12). OWNED BY MODULE `apps-core` (implemented by the architect
// on hosting/p4bAccess.ts; the module may extend AppStackRow with more columns, never change loadStack's
// contract: 404 invisible, 403 without the need).

export interface AppStackRow {
  id: number;
  tenant_id: number;
  account_id: number;
  node_id: number;
  name: string;
  display_name: string;
  source_type: 'editor' | 'git' | 'zip' | 'catalog';
  status: AppStackStatus;
  desired_state: 'running' | 'stopped';
  [column: string]: unknown;
}

/** One stack visible to the actor with `need` ('read', 'apps.manage', 'apps.console'). */
export async function loadStack(actor: HostingActor, stackId: number, need: HostingNeed = 'read'): Promise<AppStackRow> {
  return loadOwned<AppStackRow & { account_id: number }>(actor, 'app_stacks', stackId, need, 'Application');
}
