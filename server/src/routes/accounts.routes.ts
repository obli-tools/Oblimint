import { Router, type Request } from 'express';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';
import { accountsService } from '../services/hosting/accounts.service';
import { idParam, loadAccount, requireStaffActor, resolveActor } from '../services/hosting/access';
import { assertNotContained } from '../services/containment/guard';
import { clientUsersService } from '../services/hosting/clientUsers.service';
import { gateAction } from '../services/restrictions/gate';
import { accountTarget, gateAccount } from '../services/restrictions/targets';
import { fileAccessService } from '../services/hosting/fileAccess.service';
import {
  accountCreateSchema, accountUpdateSchema, clientUserActiveSchema, clientUserAddSchema, clientUserPasswordSchema, clientUserUpdateSchema,
  fileAccessUpdateSchema, sshKeyInputSchema,
  type AccountCreateBody, type AccountUpdateBody, type ClientUserAddBody, type ClientUserUpdateBody,
} from '../validators/hosting.schema';

// /api/accounts — OWNED BY MODULE `hosting-api` (docs/P1-PLAN.md §API).
// NO catch-all middleware here: /api/accounts/:id/filesrv/* is served by
// filesrv.routes.ts (module orchestration), mounted after this router.
//   GET    /                            ?search=&status=&tenantId= → HostingAccount[]
//   POST   /                            HostingAccountCreate → HostingAccount (staff, accounts.manage)
//   GET    /:id                         → HostingAccount
//   PUT    /:id                         HostingAccountUpdate → HostingAccount (accounts.manage)
//   POST   /:id/suspend                 → HostingAccount (accounts.manage)
//   POST   /:id/unsuspend               → HostingAccount (accounts.manage)
//   POST   /:id/usage/refresh           → HostingAccount (read; 502 backendUnavailable)
//   DELETE /:id                         { confirm: username } → { deleted: true } (accounts.manage)
// Customer logins (need 'users.manage': staff accounts.manage, or a client holding the
// capability users.manage on the account — anti-escalation rules: clientTeam.ts; gate
// 'account.client_users' with `op`; a client's writes 423 while the account is contained):
//   GET    /:id/users                   → AccountClientUser[] (rows flagged for the caller)
//   GET    /:id/users/candidates        → ClientUserCandidate[] (client: logins of the accounts it manages)
//   POST   /:id/users                   AccountClientUserAdd → AccountClientUser
//   PUT    /:id/users/:userId           AccountClientUserUpdate → AccountClientUser (capabilities, profile)
//   PUT    /:id/users/:userId/password  { password } → { updated: true } (secret; sessions ended)
//   PUT    /:id/users/:userId/active    { active } → AccountClientUser (disable ends the sessions)
//   DELETE /:id/users/:userId           ?deleteUser=true → { removed: true, userDeleted }
//   GET    /:id/file-access             → FileAccessInfo (read)
//   PUT    /:id/file-access             FileAccessUpdate → FileAccessInfo (files.manage)
//   POST   /:id/file-access/password    → FileAccessPasswordResult (files.manage, shown ONCE)
//   DELETE /:id/file-access/password    → FileAccessInfo (files.manage)
//   POST   /:id/file-access/keys        SshKeyInput → AccountSshKey (files.manage)
//   DELETE /:id/file-access/keys/:keyId → { deleted: true } (files.manage)
const router = Router();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** `confirm` from the JSON body (preferred) or the query string (clients that cannot send a DELETE body). */
const confirmOf = (req: Request): unknown => (req.body && typeof req.body === 'object' && 'confirm' in req.body ? req.body.confirm : req.query.confirm);

/**
 * Account of the customer-login routes: staff with accounts.manage, or a
 * client holding users.manage on it (what it may then touch: clientTeam.ts).
 * `write`: a client's change waits while the account is contained (its
 * capabilities are already off there: loadAccount answers 423 first).
 */
async function teamAccount(req: Request, write = false) {
  const actor = await resolveActor(req);
  const account = await loadAccount(actor, idParam(req), 'users.manage');
  if (write && actor.kind === 'client') await assertNotContained(account.id);
  return { actor, account };
}

// ── Accounts ─────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const data = await accountsService.list(await resolveActor(req), {
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      tenantId: optionalId(req.query.tenantId),
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/', requireStaffActor, validate(accountCreateSchema), async (req, res, next) => {
  try {
    const account = await accountsService.create(req, await resolveActor(req), req.body as AccountCreateBody);
    res.status(201).json({ success: true, data: account });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountsService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id', validate(accountUpdateSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountsService.update(req, await resolveActor(req), idParam(req), req.body as AccountUpdateBody) });
  } catch (err) { next(err); }
});

router.post('/:id/suspend', async (req, res, next) => {
  try {
    const account = await gateAccount(req, 'account.suspend', idParam(req), 'accounts.manage');
    res.json({ success: true, data: await accountsService.setSuspended(req, await resolveActor(req), account.id, true) });
  } catch (err) { next(err); }
});

router.post('/:id/unsuspend', async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountsService.setSuspended(req, await resolveActor(req), idParam(req), false) });
  } catch (err) { next(err); }
});

router.post('/:id/usage/refresh', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountsService.refreshUsage(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const account = await loadAccount(actor, idParam(req), 'accounts.manage');
    const confirm = confirmOf(req);
    // A wrong confirmation is refused by the service, before anything is asked of a human.
    if (confirm === account.username) await gateAction(req, { action: 'account.delete', target: accountTarget(account), params: { username: account.username } });
    await accountsService.remove(req, actor, account.id, confirm);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── Client users ─────────────────────────────────────────────────────────────

router.get('/:id/users', async (req, res, next) => {
  try {
    const { actor, account } = await teamAccount(req);
    res.json({ success: true, data: await clientUsersService.list(account.id, actor) });
  } catch (err) { next(err); }
});

router.get('/:id/users/candidates', async (req, res, next) => {
  try {
    const { actor, account } = await teamAccount(req);
    res.json({ success: true, data: await clientUsersService.candidates(account, actor) });
  } catch (err) { next(err); }
});

router.post('/:id/users', async (req, res, next) => {
  try {
    const { account } = await teamAccount(req, true);
    await assertNotContained(account.id);
    const parsed = clientUserAddSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.errors.map((e) => `${e.path.length ? e.path.join('.') : '<root>'}: ${e.message}`);
      throw new AppError(400, `Validation failed — ${issues.join('; ')}`, undefined, parsed.error.flatten().fieldErrors);
    }
    // Refused before anyone is asked to confirm or approve (the service checks again).
    await clientUsersService.authorizeAdd(req, account, parsed.data as ClientUserAddBody);
    // A new login may carry a password: a secret (fingerprint only; panel: code instead of an approval).
    const { password, ...shown } = parsed.data as ClientUserAddBody & { password?: string | null };
    await gateAction(req, {
      action: 'account.client_users', target: accountTarget(account), params: { op: 'add', ...shown }, secretParams: password ? { password } : {},
    });
    const user = await clientUsersService.add(req, account, parsed.data as ClientUserAddBody);
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id/users/:userId', validate(clientUserUpdateSchema), async (req, res, next) => {
  try {
    const { account } = await teamAccount(req, true);
    const body = req.body as ClientUserUpdateBody;
    const userId = idParam(req, 'userId');
    await clientUsersService.authorizeUpdate(req, account, userId, body);
    await gateAction(req, {
      action: 'account.client_users', target: accountTarget(account), params: { op: 'update', userId, ...body },
    });
    res.json({ success: true, data: await clientUsersService.update(req, account, userId, body) });
  } catch (err) { next(err); }
});

router.put('/:id/users/:userId/password', validate(clientUserPasswordSchema), async (req, res, next) => {
  try {
    const { account } = await teamAccount(req, true);
    const userId = idParam(req, 'userId');
    await clientUsersService.authorizeLogin(req, account, userId, true);
    // The password enters the fingerprint only: never stored, shown nor logged.
    await gateAction(req, {
      action: 'account.client_users', target: accountTarget(account), params: { op: 'password', userId }, secretParams: { password: req.body.password },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await clientUsersService.setPassword(req, account, userId, req.body.password as string) });
  } catch (err) { next(err); }
});

router.put('/:id/users/:userId/active', validate(clientUserActiveSchema), async (req, res, next) => {
  try {
    const { account } = await teamAccount(req, true);
    const userId = idParam(req, 'userId');
    const active = req.body.active === true;
    await clientUsersService.authorizeLogin(req, account, userId, active);
    await gateAction(req, {
      action: 'account.client_users', target: accountTarget(account), params: { op: active ? 'enable' : 'disable', userId },
    });
    res.json({ success: true, data: await clientUsersService.setActive(req, account, userId, active) });
  } catch (err) { next(err); }
});

router.delete('/:id/users/:userId', async (req, res, next) => {
  try {
    const { account } = await teamAccount(req, true);
    const deleteUser = req.query.deleteUser === 'true' || req.query.deleteUser === '1';
    const userId = idParam(req, 'userId');
    await clientUsersService.authorizeRemove(req, account, userId);
    await gateAction(req, {
      action: 'account.client_users', target: accountTarget(account), params: { op: 'remove', userId, deleteUser },
    });
    const result = await clientUsersService.remove(req, account, userId, deleteUser);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── File access (SFTP credentials) ───────────────────────────────────────────

router.get('/:id/file-access', async (req, res, next) => {
  try {
    const account = await loadAccount(await resolveActor(req), idParam(req), 'read');
    res.json({ success: true, data: await fileAccessService.info(account.id) });
  } catch (err) { next(err); }
});

router.put('/:id/file-access', validate(fileAccessUpdateSchema), async (req, res, next) => {
  try {
    const account = await loadAccount(await resolveActor(req), idParam(req), 'files.manage');
    const data = req.body.mode ? await fileAccessService.setMode(req, account, req.body.mode) : await fileAccessService.info(account.id);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/file-access/password', async (req, res, next) => {
  try {
    const account = await gateAccount(req, 'account.sftp_credentials', idParam(req), 'files.manage', { op: 'password' });
    // Never cached anywhere: the password is shown once.
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await fileAccessService.resetPassword(req, account) });
  } catch (err) { next(err); }
});

router.delete('/:id/file-access/password', async (req, res, next) => {
  try {
    const account = await loadAccount(await resolveActor(req), idParam(req), 'files.manage');
    res.json({ success: true, data: await fileAccessService.clearPassword(req, account) });
  } catch (err) { next(err); }
});

router.post('/:id/file-access/keys', validate(sshKeyInputSchema), async (req, res, next) => {
  try {
    const account = await gateAccount(req, 'account.sftp_credentials', idParam(req), 'files.manage', { op: 'sshKey', ...req.body });
    const key = await fileAccessService.addKey(req, account, req.body);
    res.status(201).json({ success: true, data: key });
  } catch (err) { next(err); }
});

router.delete('/:id/file-access/keys/:keyId', async (req, res, next) => {
  try {
    const account = await loadAccount(await resolveActor(req), idParam(req), 'files.manage');
    await fileAccessService.deleteKey(req, account, idParam(req, 'keyId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
