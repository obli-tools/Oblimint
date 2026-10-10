import type { MigrationWarning, PlannedZone } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import { MAX_TTL, MIN_TTL, RecordValidationError, validateRecord, type NormalizedRecord } from '../../../dns/records';
import type { MigrationStepContext, MigrationStepOutcome } from '../../contracts/execution';
import { isClientError, lower, outcome, ownerRelativeTo, runOwner, skipped, warning } from './common';
import { mailDnsDeps, type ZoneRecordRef } from './deps';

// ─────────────────────────────────────────────────────────────────────────────
// Step dns:zone:<name> (docs/P5-PLAN.md §9.4, D-DNS). The domain of the zone
// was created by the web-db 'domains' step WITHOUT zone (dnsZone 'none'): the
// zone is created here, attached to that domain (PlannedZone.domain), or reused
// (object map, else a zone of the same name in the SAME account), its default
// TTL set, then the records of the plan (already rewritten by the planner) are
// added as origin 'manual'. Upsert only, nothing is ever deleted (MG5).
//
// Record rule (idempotent):
//   1. the planned record is validated with dns/records.validateRecord (the
//      very rule createRecord applies); invalid → not written (zoneRecordsDropped);
//   2. an IDENTICAL record already exists (same relative name, type, normalized
//      content, priority — any origin) → skipped (re-run, or the auto A / AAAA
//      the edge already gives the domain);
//   3. a record of the same (name, type) exists with origin 'auto' or 'system'
//      (contributed by the platform: edge A / AAAA, mail DNS contributor MX /
//      SPF / DMARC / DKIM, P2 placeholders, ACME / verification) → skipped and
//      reported (zoneMailManaged): a manual record would OVERRIDE the whole
//      generated rrset (dns/records.applyOverrides) and freeze it;
//   4. the zone holds a domain whose mail is migrated to an engine with
//      mailboxes: the mail DNS contributor will publish its MX / SPF / DKIM /
//      DMARC once the mail domain exists (later in the run) — the source's MX,
//      SPF, _dmarc and _domainkey records are skipped (zoneMailManaged, info),
//      and so is any OTHER TXT at that mail domain name (zoneTxtShared,
//      warning): a manual TXT there would override the contributed SPF rrset;
//   5. otherwise createRecord (manual); 409 recordConflict (CNAME clash, …) →
//      skipped and reported; 409 recordLimit → the remaining records are
//      reported, the step ends with a warning.
// ─────────────────────────────────────────────────────────────────────────────

/** Why a record belongs to the mail DNS contributor of a migrated mail domain ('mail'), shares its TXT rrset ('txtShared'), or null. */
export function mailRrsetOf(rec: Pick<NormalizedRecord, 'name' | 'type' | 'content'>, mailNames: ReadonlySet<string>): 'mail' | 'txtShared' | null {
  if (rec.type !== 'MX' && rec.type !== 'TXT') return null;
  const n = rec.name;
  if (mailNames.has(n)) {
    if (rec.type === 'MX' || /^v=spf1(\s|$)/i.test(rec.content)) return 'mail';
    return 'txtShared';
  }
  if (rec.type !== 'TXT') return null;
  for (const d of mailNames) {
    const sub = (label: string) => (d === '@' ? label : `${label}.${d}`);
    if (n === sub('_dmarc')) return 'mail';
    if (n.endsWith(`.${sub('_domainkey')}`)) return 'mail';
  }
  return null;
}

const clampTtl = (ttl: number): number => Math.min(MAX_TTL, Math.max(MIN_TTL, Math.round(Number(ttl) || 3600)));
const sameRecord = (a: Pick<ZoneRecordRef, 'name' | 'type' | 'content' | 'priority'>, b: NormalizedRecord) =>
  a.name === b.name && a.type === b.type && a.content === b.content && (a.priority ?? null) === (b.priority ?? null);

export async function domainIdOf(ctx: MigrationStepContext, fqdn: string): Promise<number | null> {
  const name = lower(fqdn);
  const fromStep = (await ctx.stepResult('domains'))?.domainIds as Record<string, unknown> | undefined;
  const id = fromStep ? Number(fromStep[name]) : NaN;
  if (Number.isInteger(id) && id > 0) return id;
  return mailDnsDeps().objectMap.resolve(ctx.run.sourceId, 'domain', name, runOwner(ctx));
}

export async function runZoneStep(ctx: MigrationStepContext, zoneName: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const name = lower(zoneName);
  const scope = { kind: 'zone' as const, key: name };
  const z: PlannedZone | undefined = ctx.account.zones.find((x) => lower(x.name) === name);
  if (!z) return skipped({ zone: name, reason: 'notInPlan' });
  const accountId = ctx.targetAccountId();
  if (!accountId) throw new Error('The target account does not exist yet (account step)');
  const warnings: MigrationWarning[] = [];

  // ── zone: object map → same-name zone of the account → create ──
  let zoneId = await deps.objectMap.resolve(ctx.run.sourceId, 'zone', name, runOwner(ctx));
  let created = false;
  if (!zoneId) {
    const existing = await deps.dns.findZone(name);
    if (existing) {
      if (existing.accountId !== accountId) {
        throw Object.assign(new Error(`A DNS zone ${name} already exists outside this account`), { statusCode: 409, code: 'zoneExists' });
      }
      zoneId = existing.id;
    } else {
      const domainId = z.domain ? await domainIdOf(ctx, z.domain) : null;
      try {
        const zone = await deps.dns.createZone(ctx.req, ctx.actor, domainId
          ? { accountId, domainId, kind: 'hosted', templateId: null }
          : { accountId, name, kind: 'hosted', templateId: null });
        zoneId = zone.id;
        created = true;
      } catch (err) {
        if (isClientError(err, 'dnsDisabled')) {
          await ctx.log('warn', 'dnsDisabled', { zone: name });
          return skipped({ zone: name, reason: 'dnsDisabled' }, [warning(ctx, 'dnsDisabled', 'warning', scope, { zone: name })]);
        }
        throw err;
      }
    }
    await deps.objectMap.put({
      sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'zone', sourceKey: name, targetTable: 'dns_zones',
      targetId: zoneId, meta: { name }, runId: ctx.run.id,
    });
  }

  const zone = await deps.dns.findZone(name);
  if (!zone || zone.id !== zoneId) throw new Error(`DNS zone ${name} vanished during the step`);
  if (zone.kind !== 'hosted') {
    return skipped({ zoneId, zone: name, reason: 'zoneNotHosted' }, [warning(ctx, 'zoneNotHosted', 'warning', scope, { zone: name })]);
  }
  const defaultTtl = clampTtl(z.defaultTtl);
  if (zone.defaultTtl !== defaultTtl) await deps.dns.setDefaultTtl(ctx.req, ctx.actor, zoneId, defaultTtl);

  // ── records ──
  const existing = await deps.dns.records(zoneId);
  // Mail domains of this account migrated into this zone (relative names), when the engine hosts mailboxes.
  const mailNames = new Set<string>();
  if (mailEngineHasMailboxes(await deps.mail.engine())) {
    const zones = ctx.account.zones.map((x) => lower(x.name));
    for (const m of ctx.account.mailDomains) {
      const md = lower(m.name);
      const closest = zones.filter((zn) => md === zn || md.endsWith(`.${zn}`)).sort((a, b) => b.length - a.length)[0];
      if (closest === name) mailNames.add(ownerRelativeTo(md, name));
    }
  }
  const shared: string[] = [];
  let inserted = 0;
  let identical = 0;
  const managed: string[] = [];
  const conflicts: string[] = [];
  const invalid: string[] = [];
  let limitReached = false;
  let i = 0;
  for (const r of z.records) {
    if (++i % 25 === 0) await ctx.checkpoint();
    const label = `${lower(r.name) || name} ${String(r.type).toUpperCase()}`;
    if (limitReached) { conflicts.push(label); continue; }
    let rec: NormalizedRecord;
    try {
      rec = validateRecord(
        { name: ownerRelativeTo(r.name, name), type: r.type, content: r.content, ttl: clampTtl(r.ttl), priority: r.priority },
        { zone: name, defaultTtl },
      );
    } catch (err) {
      if (err instanceof RecordValidationError) { invalid.push(label); continue; }
      throw err;
    }
    if (existing.some((e) => sameRecord(e, rec))) { identical++; continue; }
    const mailRrset = mailRrsetOf(rec, mailNames);
    if (mailRrset === 'txtShared') { shared.push(label); continue; }
    if (mailRrset === 'mail' || existing.some((e) => e.name === rec.name && e.type === rec.type && (e.origin === 'auto' || e.origin === 'system'))) {
      managed.push(label);
      await ctx.log('info', 'zoneMailManaged', { zone: name, name: rec.name, type: rec.type });
      continue;
    }
    try {
      const row = await deps.dns.createRecord(ctx.req, ctx.actor, zoneId, {
        name: rec.name, type: rec.type, content: rec.content, ttl: rec.ttl, priority: rec.priority, comment: 'Migration CWP',
      });
      existing.push({ id: row.id, name: rec.name, type: rec.type, content: rec.content, priority: rec.priority, origin: 'manual' });
      inserted++;
    } catch (err) {
      if (isClientError(err, 'recordLimit')) { limitReached = true; conflicts.push(label); continue; }
      if (isClientError(err, 'recordConflict')) { conflicts.push(label); continue; }
      if (isClientError(err, 'recordInvalid')) { invalid.push(label); continue; }
      throw err;
    }
  }

  const list = (xs: string[]) => xs.slice(0, 20).join(', ') + (xs.length > 20 ? ` (+${xs.length - 20})` : '');
  if (managed.length) warnings.push(warning(ctx, 'zoneMailManaged', 'info', scope, { zone: name, count: managed.length, records: list(managed) }));
  if (shared.length) warnings.push(warning(ctx, 'zoneTxtShared', 'warning', scope, { zone: name, count: shared.length, records: list(shared) }));
  if (invalid.length) warnings.push(warning(ctx, 'zoneRecordsDropped', 'warning', scope, { zone: name, count: invalid.length, records: list(invalid) }));
  if (conflicts.length) {
    warnings.push(warning(ctx, limitReached ? 'zoneRecordLimit' : 'zoneRecordConflict', 'warning', scope, { zone: name, count: conflicts.length, records: list(conflicts) }));
  }
  await ctx.log('info', 'zoneImported', { zone: name, created, inserted, skipped: identical + managed.length + shared.length + invalid.length + conflicts.length });
  return outcome({
    zoneId, zone: name, created, inserted,
    skipped: identical + managed.length + shared.length + invalid.length + conflicts.length,
    identical, managed: managed.length, shared: shared.length, invalid: invalid.length, conflicts: conflicts.length,
  }, warnings);
}
