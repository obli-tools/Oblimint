import type { CwpDnsZone } from '@oblimint/shared';
import { parseNamedConf, type NamedZone } from '../parsers/namedConf';
import { axfrFailed, parseZoneText, type ParsedZone } from '../parsers/zone';
import { baseName } from '../parsers/system';
import { DiscoveryContext, errorText } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phase dns (P5-PLAN §7.4, CWP-MAP §9): zones declared in named.conf (+ orphan
// /var/named/<zone>.db files), dynamic (allow-update / update-policy) and
// journal (.jnl) flags, records read JOURNAL APPLIED (dns.zoneDump =
// named-checkzone -j -D), fallback dns.axfr on 127.0.0.1, last resort the
// file itself. Zone ↔ account by exact domain match; CwpDomain.dnsZone = the
// longest zone suffix.
// ─────────────────────────────────────────────────────────────────────────────

export const NAMED_DIR = '/var/named';

/** Longest zone that contains the name (exact or suffix). */
export function containingZone(name: string, zones: string[]): string | null {
  let best: string | null = null;
  for (const z of zones) {
    if ((name === z || name.endsWith(`.${z}`)) && (best === null || z.length > best.length)) best = z;
  }
  return best;
}

function toZone(name: string, file: string | null, parsed: ParsedZone, via: CwpDnsZone['readVia'], declared: boolean, dynamic: boolean, journal: boolean): CwpDnsZone {
  return {
    name, file, dynamic, journal, readVia: via, serial: parsed.serial, defaultTtl: parsed.defaultTtl, records: parsed.records,
    account: null, nameservers: parsed.nameservers, declared,
  };
}

export async function phaseDns(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const conf = await ctx.tryRun('named.conf', 'dns.namedConf', {});
  const declared: NamedZone[] = conf ? parseNamedConf(conf.stdout).filter((z) => z.type === null || /^(master|primary)$/i.test(z.type)) : [];
  const listing = await ctx.find('/var/named', NAMED_DIR, 1, 'f');
  const present = new Set(listing.map((e) => e.path));

  const done = new Set<string>();
  for (const z of declared) {
    ctx.checkAbort();
    if (done.has(z.name)) continue;
    done.add(z.name);
    const journal = z.file ? present.has(`${z.file}.jnl`) : false;
    let parsed: ParsedZone | null = null;
    let via: CwpDnsZone['readVia'] = 'checkzone';
    if (z.file) {
      try {
        const r = await ctx.run('dns.zoneDump', { zone: z.name, file: z.file }, { allowNonZeroExit: true });
        if (r.exitCode === 0) {
          const p = parseZoneText(r.stdout, z.name);
          if (p.soa) parsed = p;
        }
      } catch (err) {
        ctx.checkAbort();
        ctx.warn('zoneReadFailed', 'info', { kind: 'zone', key: z.name }, { via: 'checkzone', error: errorText(err) });
      }
    }
    if (!parsed) {
      via = 'axfr';
      try {
        const r = await ctx.run('dns.axfr', { zone: z.name }, { allowNonZeroExit: true });
        if (r.exitCode === 0 && !axfrFailed(r.stdout)) {
          const p = parseZoneText(r.stdout, z.name);
          if (p.soa) parsed = p;
        }
        if (!parsed) ctx.warn('axfrRefused', 'info', { kind: 'zone', key: z.name });
      } catch (err) {
        ctx.checkAbort();
        ctx.warn('axfrRefused', 'info', { kind: 'zone', key: z.name }, { error: errorText(err) });
      }
    }
    if (!parsed && z.file) {
      via = 'file';
      const files = await ctx.readFiles(`zone ${z.name}`, [z.file]);
      const text = files.get(z.file) ?? null;
      if (text !== null) parsed = parseZoneText(text, z.name);
      if (parsed && (z.dynamic || journal)) {
        ctx.warn('zoneReadFailed', 'warning', { kind: 'zone', key: z.name }, { via: 'file', stale: true });
      }
    }
    if (!parsed) {
      ctx.warn('zoneReadFailed', 'warning', { kind: 'zone', key: z.name }, { via: 'none' });
      st.dnsZones.push({
        name: z.name, file: z.file, dynamic: z.dynamic, journal, readVia: 'file', serial: null, defaultTtl: null, records: [],
        account: null, nameservers: [], declared: true,
      });
      continue;
    }
    if (parsed.skipped > 0) ctx.warn('zoneRecordsSkipped', 'info', { kind: 'zone', key: z.name }, { count: parsed.skipped });
    st.dnsZones.push(toZone(z.name, z.file, parsed, via, true, z.dynamic, journal));
  }

  // Orphan <zone>.db files (not declared; .restore / backups ignored).
  const declaredFiles = new Set(declared.map((z) => z.file).filter(Boolean));
  const orphans = listing
    .filter((e) => e.path.endsWith('.db') && !declaredFiles.has(e.path))
    .map((e) => ({ path: e.path, zone: baseName(e.path).slice(0, -3).toLowerCase() }))
    .filter((o) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(o.zone) && !done.has(o.zone));
  if (orphans.length > 0) {
    const files = await ctx.readFiles('orphan zones', orphans.map((o) => o.path));
    for (const o of orphans) {
      const text = files.get(o.path) ?? null;
      if (text === null) { ctx.warn('zoneReadFailed', 'info', { kind: 'zone', key: o.zone }, { via: 'file' }); continue; }
      const parsed = parseZoneText(text, o.zone);
      if (!parsed.soa && parsed.records.length === 0) continue;
      done.add(o.zone);
      st.dnsZones.push(toZone(o.zone, o.path, parsed, 'file', false, false, present.has(`${o.path}.jnl`)));
    }
  }

  // Zone ↔ account / domain.
  const zoneNames = st.dnsZones.map((z) => z.name);
  const domainByFqdn = new Map(st.domains.map((d) => [d.fqdn, d]));
  for (const z of st.dnsZones) {
    z.account = domainByFqdn.get(z.name)?.account ?? null;
    if (z.records.length > 0 && !z.records.some((r) => r.type === 'NS')) {
      ctx.warn('zoneNoNs', 'info', { kind: 'zone', key: z.name, account: z.account });
    }
    if (!z.declared) {
      ctx.addOutside({
        kind: 'dns-orphan-zone', key: z.name, account: z.account, code: 'dnsOrphanZone', suggestion: 'manual',
        params: { zone: z.name }, details: { zone: z.name, file: z.file, records: z.records.length },
      });
    }
    if (z.dynamic) {
      ctx.addOutside({
        kind: 'dns-dynamic-zone', key: z.name, account: z.account, code: 'dnsDynamicZone', suggestion: 'manual',
        params: { zone: z.name, journal: z.journal }, details: { zone: z.name, file: z.file, journal: z.journal, readVia: z.readVia },
      });
    }
  }
  for (const d of st.domains) d.dnsZone = containingZone(d.fqdn, zoneNames);
}
