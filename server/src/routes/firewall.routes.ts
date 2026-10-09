import { Router, type Request } from 'express';
import { z } from 'zod';
import { ACCESS_MODES } from '@oblimint/shared';
import { idParam, loadAccount, resolveActor } from '../services/hosting/access';
import { parseBody } from '../services/docker/parseBody';
import { firewallService } from '../services/firewall/firewall.service';

// OWNED BY MODULE `hostd-firewall` (docs/P2-PLAN.md §6.4).
//
// accountAccessRoutes — mounted on /api/accounts AFTER accounts.routes.ts / filesrv.routes.ts. NO catch-all.
//   GET    /:id/access                      → AccountAccessInfo                          (read)
//   PUT    /:id/access                      AccountAccessUpdate (+ confirm) → AccountAccessInfo (files.manage)
//          Body: { mode?, grantTtlMinutes? (15…1440), confirm?: true }. Switching to
//          'allowlist' while the account has no live rule answers 409 lockoutRisk with
//          details { confirm: true, sessionIps: string[] } (the addresses allow-my-ips would
//          add) unless the body carries confirm: true.
//   POST   /:id/access/rules                AccessRuleInput → AccessRule (201)           (files.manage)
//          400 invalidCidr / cidrTooWide (< /8 v4, < /32 v6) / validation (expiresAt < now + 5 min);
//          409 ruleExists / ruleLimit (100 per account).
//   DELETE /:id/access/rules/:ruleId        → { deleted: true }                          (files.manage)
//   POST   /:id/access/allow-my-ips         → AccountAccessInfo (adds the session's seen + probed v4/v6 as rules;
//          409 noSessionIp when none is known)                                         (files.manage)
//   DELETE /:id/access/grants/:grantId      → { deleted: true }                          (files.manage)
//   DELETE /:id/access/bans/:banId          → { deleted: true }                          (files.manage)
//
// accessRoutes — mounted on /api/access.
//   POST   /probe                           → IpProbeTicket                              (auth)
//   GET    /my-ips                          → MyIpsInfo                                  (auth)
//
// systemFirewallRoutes — mounted on /api/system/firewall (platform admin).
//   GET    /                                → FirewallStatus
//   POST   /sync                            → FirewallStatus (re-push every account + global state)
export const accountAccessRoutes = Router();
export const accessRoutes = Router();
export const systemFirewallRoutes = Router();

export const accessUpdateSchema = z.object({
  mode: z.enum(ACCESS_MODES as [string, ...string[]]).optional(),
  grantTtlMinutes: z.number().int().min(15).max(1440).optional(),
  /** Acknowledges the lockout risk of an allow-list without any rule. */
  confirm: z.literal(true).optional(),
}).strict();

export const accessRuleSchema = z.object({
  cidr: z.string().trim().min(1).max(64),
  label: z.string().trim().max(100).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const actorOf = (req: Request) => resolveActor(req);

accountAccessRoutes.get('/:id/access', async (req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.getAccess(await actorOf(req), idParam(req)) });
  } catch (err) { next(err); }
});

accountAccessRoutes.put('/:id/access', async (req, res, next) => {
  try {
    const actor = await actorOf(req);
    const id = idParam(req);
    // Access check BEFORE the body (an invisible account is a 404, a read-only one a 403, whatever the body).
    await loadAccount(actor, id, 'files.manage');
    const body = parseBody(accessUpdateSchema, req.body) as z.infer<typeof accessUpdateSchema> & { mode?: (typeof ACCESS_MODES)[number] };
    res.json({ success: true, data: await firewallService.updateAccess(req, actor, id, body) });
  } catch (err) { next(err); }
});

accountAccessRoutes.post('/:id/access/rules', async (req, res, next) => {
  try {
    const actor = await actorOf(req);
    const id = idParam(req);
    await loadAccount(actor, id, 'files.manage');
    const input = parseBody(accessRuleSchema, req.body);
    res.status(201).json({ success: true, data: await firewallService.addRule(req, actor, id, input) });
  } catch (err) { next(err); }
});

accountAccessRoutes.delete('/:id/access/rules/:ruleId', async (req, res, next) => {
  try {
    await firewallService.deleteRule(req, await actorOf(req), idParam(req), idParam(req, 'ruleId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

accountAccessRoutes.post('/:id/access/allow-my-ips', async (req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.allowMyIps(req, await actorOf(req), idParam(req)) });
  } catch (err) { next(err); }
});

accountAccessRoutes.delete('/:id/access/grants/:grantId', async (req, res, next) => {
  try {
    await firewallService.deleteGrant(req, await actorOf(req), idParam(req), idParam(req, 'grantId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

accountAccessRoutes.delete('/:id/access/bans/:banId', async (req, res, next) => {
  try {
    await firewallService.unban(req, await actorOf(req), idParam(req), idParam(req, 'banId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

accessRoutes.post('/probe', async (req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.probeTicket(req) });
  } catch (err) { next(err); }
});

accessRoutes.get('/my-ips', async (req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.myIps(req) });
  } catch (err) { next(err); }
});

systemFirewallRoutes.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.status() });
  } catch (err) { next(err); }
});

systemFirewallRoutes.post('/sync', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await firewallService.syncNow() });
  } catch (err) { next(err); }
});
