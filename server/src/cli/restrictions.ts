import '../env';
import { db } from '../db';
import { resetRestrictionsFloor, unlockRestrictionsManage } from '../services/restrictions/unlock';

// Out-of-panel escape of the sensitive actions (never over HTTP):
//
//   docker exec oblimint node dist/src/cli/restrictions.js unlock [<tenantId>|all]
//       removes 'restrictions.manage' from the platform floor and from the
//       tenant's map (every tenant by default): the matrix can be changed
//       from the panel again;
//   docker exec oblimint node dist/src/cli/restrictions.js reset-floor
//       empties the platform floor.
//
// Both are written to the audit log (restrictions.cli_unlock / cli_floor).

const USAGE = 'usage: restrictions.js unlock [<tenantId>|all] | reset-floor';

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === 'unlock') {
    let tenantId: number | null = null;
    if (arg && arg !== 'all') {
      tenantId = Number(arg);
      if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error(USAGE); return 2; }
    }
    const r = await unlockRestrictionsManage(tenantId);
    console.log(`restrictions.manage removed from ${r.tenants.length} tenant map(s)${r.tenants.length ? ` (${r.tenants.join(', ')})` : ''}; floor ${r.floorChanged ? 'lowered' : 'unchanged'}.`);
    return 0;
  }
  if (cmd === 'reset-floor') {
    const r = await resetRestrictionsFloor();
    console.log(r.removed.length ? `Platform floor emptied (${r.removed.join(', ')}).` : 'The platform floor was already empty.');
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2))
  .then(async (code) => { await db.destroy(); process.exit(code); })
  .catch(async (err) => {
    console.error((err as Error)?.message ?? err);
    await db.destroy().catch(() => undefined);
    process.exit(1);
  });
