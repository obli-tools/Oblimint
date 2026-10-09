import { Router, type Request } from 'express';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';
import { accountsService } from '../services/hosting/accounts.service';
import { assertStaff, idParam, loadAccount, requireStaffActor, resolveActor } from '../services/hosting/access';
import { clientUsersService } from '../services/hosting/clientUsers.service';
import { fileAccessService } from '../services/hosting/fileAccess.service';
import {
  accountCreateSchema, accountUpdateSchema, clientUserAddSchema, clientUserCapabilitiesSchema, fileAccessUpdateSchema, sshKeyInputSchema,
  type AccountCreateBody, type AccountUpdateBody, type ClientUserAddBody,
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
//   GET    /:id/users                   → AccountClientUser[] (staff, accounts.manage)
//   GET    /:id/users/candidates        → ClientUserCandidate[] (staff, accounts.manage)
//   POST   /:id/users                   AccountClientUserAdd → AccountClientUser (staff, accounts.manage)
//   PUT    /:id/users/:userId           { capabilities } → AccountClientUser (staff, accounts.manage)
//   DELETE /:id/users/:userId           ?deleteUser=true → { removed: true } (staff, accounts.manage)
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

/** Account with `need`, for the client-user routes: staff only (clients never manage users in P1). */
async function staffAccount(req: Request) {
  const actor = await resolveActor(req);
  const account = await loadAccount(actor, idParam(req), 'accounts.manage');
  assertStaff(actor);
  return account;
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
    res.json({ success: true, data: await accountsService.setSuspended(req, await resolveActor(req), idParam(req), true) });
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
    await accountsService.remove(req, await resolveActor(req), idParam(req), confirmOf(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── Client users ─────────────────────────────────────────────────────────────

router.get('/:id/users', async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    res.json({ success: true, data: await clientUsersService.list(account.id) });
  } catch (err) { next(err); }
});

router.get('/:id/users/candidates', async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    res.json({ success: true, data: await clientUsersService.candidates(account) });
  } catch (err) { next(err); }
});

router.post('/:id/users', async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    const parsed = clientUserAddSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.errors.map((e) => `${e.path.length ? e.path.join('.') : '<root>'}: ${e.message}`);
      throw new AppError(400, `Validation failed — ${issues.join('; ')}`, undefined, parsed.error.flatten().fieldErrors);
    }
    const user = await clientUsersService.add(req, account, parsed.data as ClientUserAddBody);
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id/users/:userId', validate(clientUserCapabilitiesSchema), async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    const user = await clientUsersService.updateCapabilities(req, account, idParam(req, 'userId'), req.body.capabilities);
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.delete('/:id/users/:userId', async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    const deleteUser = req.query.deleteUser === 'true' || req.query.deleteUser === '1';
    const result = await clientUsersService.remove(req, account, idParam(req, 'userId'), deleteUser);
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
    const account = await loadAccount(await resolveActor(req), idParam(req), 'files.manage');
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
    const account = await loadAccount(await resolveActor(req), idParam(req), 'files.manage');
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
