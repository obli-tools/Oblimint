import { AppError } from '../../middleware/errorHandler';
import { platformSettings } from '../platformSettings';
import { accountPlan } from './context';
import { appPolicyService } from './policy.service';

// ─────────────────────────────────────────────────────────────────────────────
// The conditions of a command in an application's container (AP7), ONE place
// for every surface: the panel's interactive console (socketHandlers.ts,
// apps:console:open and its re-check every 30 s) and the commands of an
// access key (keyStacks.exec, scope apps.exec). Beside the capability
// apps.console on the account (loadStack 'apps.console'), a command needs:
//   platform   settings.apps.consoleEnabled;
//   policy     the tenant's policy (allowConsole ≠ false);
//   plan       the account's plan appsConsole;
//   suspended  an account neither suspended nor being deleted.
// ─────────────────────────────────────────────────────────────────────────────

export type ConsoleRefusal = 'platform' | 'policy' | 'plan' | 'suspended';

/** Why no command may run in the stack's containers now (null: allowed). */
export async function consoleRefusal(stack: { tenant_id: number; account_id: number }): Promise<ConsoleRefusal | null> {
  const settings = await platformSettings.section('apps');
  if (!settings.consoleEnabled) return 'platform';
  const policy = await appPolicyService.effective(Number(stack.tenant_id));
  if (!policy.allowConsole) return 'policy';
  const plan = await accountPlan(Number(stack.account_id));
  if (plan.status === 'suspended' || plan.status === 'deleting') return 'suspended';
  if (plan.limits.appsConsole !== true) return 'plan';
  return null;
}

/**
 * The same conditions as an error with a clear code: consoleDisabled (403, details.reason platform / policy / plan),
 * accountSuspended (409) for a suspended account or one being deleted.
 */
export async function assertConsoleAllowed(stack: { tenant_id: number; account_id: number }): Promise<void> {
  const why = await consoleRefusal(stack);
  if (!why) return;
  if (why === 'suspended') throw new AppError(409, 'The account is suspended: no command runs in its containers', 'accountSuspended');
  const text = {
    platform: 'Commands in the containers are disabled on this platform',
    policy: 'Commands in the containers are disabled for this tenant',
    plan: 'The plan of the account does not include the console of the applications',
  }[why];
  throw new AppError(403, text, 'consoleDisabled', { reason: why });
}
