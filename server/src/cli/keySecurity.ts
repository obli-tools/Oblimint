import '../env';
import { MASTER_TENANT_ID, effectiveKeyStrictMode } from '@oblimint/shared';
import { db } from '../db';
import { auditService } from '../services/audit.service';
import { banKey, normalizeCidr } from '../services/firewall/addresses';
import { platformSettings } from '../services/platformSettings';
import { flushPlatformBansNow, liftPlatformBans } from '../services/security/bans.service';
import { bumpKeySecurityGeneration, keySurfaceGuard } from '../services/security/keySurfaceGuard';

// Out-of-panel escape of the IP security of the access keys / MCP (spec §5.7) —
// the only way back in when the owner's own address is banned. Never over HTTP.
const HELP = `Oblimint — IP security of the access keys / MCP (never locked out)

usage (inside the panel container):
  docker exec <panel container> node dist/src/cli/keySecurity.js <command>

commands:
  unban <ip> [--lift-only]
                lifts every platform ban of the address (an IPv6 address: its /64),
                whatever its source (key-intrusion, key-bruteforce, manual…), withdraws
                it from Obliguard and pushes nftables now; nginx follows within a minute.
                The address is ALSO added to the trusted IPs (like trust): otherwise its
                next call to /mcp or /api/v1 in strict mode would ban it again at once.
                --lift-only: only lift the bans (it may be banned again)
  trust <ip|cidr>
                adds the address (IPv6: its /64) or CIDR to the trusted IPs — never
                banned by the key surfaces' guard — and lifts every platform ban inside
                it (a CIDR: every banned address of the range)
  status        regime (strict / watch), strict mode, open keys, trusted IPs, the
                latest key-* bans
  help          this text

A platform ban covers every web port of the edge: the panel, /mcp, the client
space, the webmail and every hosted site. Both changes are written to the audit log.`;

function entryFor(raw: string): string | null {
  try {
    if (!raw.includes('/')) {
      const key = banKey(raw);
      return key ? normalizeCidr(key, { 4: 8, 6: 16 }).cidr : null;
    }
    return normalizeCidr(raw, { 4: 8, 6: 16 }).cidr;
  } catch {
    return null;
  }
}

async function lift(ip: string): Promise<number[]> {
  const lifted = await liftPlatformBans(ip, { actor: 'cli' });
  keySurfaceGuard.banLifted(ip);
  const flushed = await flushPlatformBansNow();
  await bumpKeySecurityGeneration();
  await auditService.log({ tenantId: MASTER_TENANT_ID, action: 'keySecurity.cli_unban', resourceType: 'ip', resourcePath: ip, details: { liftedBans: lifted } });
  console.log(lifted.length ? `Lifted ${lifted.length} platform ban(s) of ${ip} (${lifted.join(', ')}).` : `No active platform ban for ${ip}.`);
  if (flushed.hostd) console.log(`nftables not pushed now (${flushed.hostd}): the panel retries within 5 minutes.`);
  console.log('nginx (edge) follows within a minute.');
  return lifted;
}

async function trust(raw: string): Promise<void> {
  const entry = entryFor(raw);
  if (!entry) throw new Error(`invalid address or CIDR: ${raw}`);
  const s = await platformSettings.section('keySecurity');
  if (!s.trustedIps.includes(entry)) {
    if (s.trustedIps.length >= 256) throw new Error('at most 256 trusted addresses');
    await platformSettings.update({ keySecurity: { trustedIps: [...s.trustedIps, entry] } });
  }
  await auditService.log({ tenantId: MASTER_TENANT_ID, action: 'keySecurity.cli_trust', resourceType: 'ip', resourcePath: entry, details: {} });
  console.log(`${entry} is a trusted address of the key surfaces.`);
  // A CIDR: every platform ban overlapping the range, not only its network address.
  await lift(entry);
}

async function unban(ip: string, liftOnly: boolean): Promise<void> {
  if (!liftOnly) {
    try { await trust(ip); return; } catch (err) {
      // Never stay locked out: the bans are lifted even when the address cannot be trusted.
      console.error(`Not added to the trusted IPs (${(err as Error)?.message ?? err}): lifting the bans only.`);
    }
  }
  await lift(ip);
  console.log('Warning: not added to the trusted IPs — in strict mode its next call to /mcp, /api/v1 or /oauth/token bans it again.');
}

async function status(): Promise<void> {
  const st = await keySurfaceGuard.status(null);
  const s = await keySurfaceGuard.settings();
  console.log(`regime        ${st.regime}${st.regime === 'strict' ? ` (allow-list: ${st.allowListSize} entries)` : ''}`);
  console.log(`strict mode   ${s.strictMode} → ${effectiveKeyStrictMode(s)}${s.strictMode === 'auto' && s.autoStrictAt ? ` (strict from ${s.autoStrictAt})` : ''}`);
  console.log(`active keys   ${st.activeKeys}, open: ${st.openKeys.length}`);
  for (const k of st.openKeys.slice(0, 20)) {
    console.log(`  open ${k.kind} #${k.id} "${k.name}" (${k.why === 'tooWide' ? 'range too wide' : 'no address'}) — account ${k.accountUsername ?? k.accountId}, tenant ${k.tenantName ?? k.tenantId}, owner ${k.owner ?? '?'}`);
  }
  console.log(`require IP    ${s.requireIp ? 'yes' : 'no'} (platform default)`);
  console.log(`failures      ${s.maxFailures} in ${s.failureWindowMinutes} min`);
  console.log(`trusted IPs   ${s.trustedIps.join(', ') || '—'}`);
  console.log(`connectors    ${s.connectorSourceRanges.join(', ') || '— (connectors count as open keys)'}`);
  console.log(`admin IPs     ${st.staffSessionIps.join(', ') || '—'}`);
  const bans = await db('web_bans').whereIn('source', ['key-intrusion', 'key-bruteforce']).where({ is_active: true })
    .orderBy('created_at', 'desc').limit(20).select('ip', 'source', 'banned_until', 'created_at') as
    Array<{ ip: string; source: string; banned_until: Date | string | null; created_at: Date | string }>;
  console.log(`key bans      ${bans.length ? '' : '—'}`);
  for (const b of bans) {
    console.log(`  ${b.ip}  ${b.source}  since ${new Date(b.created_at).toISOString()}  ${b.banned_until ? `until ${new Date(b.banned_until).toISOString()}` : 'permanent'}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
  if (cmd === 'unban' && arg) { await unban(arg, flags.includes('--lift-only')); return 0; }
  if (cmd === 'trust' && arg) { await trust(arg); return 0; }
  if (cmd === 'status') { await status(); return 0; }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return 0; }
  console.error(HELP);
  return 2;
}

main(process.argv.slice(2))
  .then(async (code) => { await db.destroy(); process.exit(code); })
  .catch(async (err) => {
    console.error((err as Error)?.message ?? err);
    await db.destroy().catch(() => undefined);
    process.exit(1);
  });
