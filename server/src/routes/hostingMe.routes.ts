import { Router } from 'express';
import type { ClientCapability, HostingMe } from '@oblimint/shared';
import { resolveActor } from '../services/hosting/access';

// /api/hosting — OWNED BY MODULE `hosting-api` (docs/P1-PLAN.md §API).
//   GET /me → HostingMe (any authenticated tenant member: staff or client)
// Drives the client-space UI (useHostingMe); the server stays the authority.
const router = Router();

router.get('/me', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    let data: HostingMe;
    if (actor.kind === 'staff') {
      data = { kind: 'staff', staffCapabilities: actor.caps === '*' ? '*' : [...actor.caps].sort(), accounts: {} };
    } else {
      const accounts: Record<number, ClientCapability[]> = {};
      for (const [accountId, caps] of actor.accounts) accounts[accountId] = [...caps].sort();
      data = { kind: 'client', staffCapabilities: [], accounts };
    }
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
