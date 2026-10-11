import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Calculator, Save, X } from 'lucide-react';
import type { MigrationGlobalChoices, MigrationTargetCatalog } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Card, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, formatDateTime, planWarnings, severityCounts } from '../migrationFormat';
import { FollowUpList, MiniStat, SeverityCounts, WarningList, useByteUnits } from '../migrationUi';
import type { PlanEditor } from './usePlanEditor';

const INCLUDE_KEYS: Array<keyof MigrationGlobalChoices['include']> = ['files', 'databases', 'mail', 'dns', 'crons', 'certificates', 'proxies', 'ftp'];
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

function IpChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const ok = parts.filter((p) => IP_RE.test(p) && !value.includes(p));
    if (ok.length) onChange([...value, ...ok]);
    setText('');
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md bg-bg-tertiary px-2 py-1.5">
      {value.map((ip) => (
        <span key={ip} className="inline-flex items-center gap-1 rounded bg-bg-primary px-2 py-0.5 font-mono text-[11px] text-text-primary">
          {ip}
          <button type="button" aria-label={t('migration.overview.removeIp', { ip, defaultValue: 'Remove {{ip}}' })} onClick={() => onChange(value.filter((x) => x !== ip))} className="text-text-muted hover:text-status-down"><X size={11} /></button>
        </span>
      ))}
      <input
        aria-label={t('migration.overview.addIp') || 'Add an address'}
        className="min-w-[8rem] flex-1 bg-transparent font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none"
        value={text}
        placeholder={t('migration.overview.addIpPlaceholder') || 'IP, Enter to add'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
        spellCheck={false}
      />
    </div>
  );
}

/** Overview: global choices (tenant, node, IPs, TTL, database engine, suspended accounts, includes, scan override), dry-run totals. */
export function PlanOverviewTab({ editor, catalog }: { editor: PlanEditor; catalog: MigrationTargetCatalog | null }) {
  const { t, i18n } = useTranslation();
  const units = useByteUnits();
  const { plan } = editor;
  // The draft lives in the editor: switching tab keeps it, and it counts as an unsaved change (badge + beforeunload).
  const g = editor.sectionValue('global');
  const dirty = editor.sectionDirty('global');
  const set = <K extends keyof MigrationGlobalChoices>(k: K, v: MigrationGlobalChoices[K]) => editor.setSection('global', (cur) => ({ ...cur, [k]: v }));

  const r = plan.result;
  const allWarnings = useMemo(() => (r ? planWarnings(r).warnings : []), [r]);
  const counts = severityCounts(allWarnings);
  const mariadb = (catalog?.dbVersions ?? []).filter((v) => v.engine === 'mariadb');
  const mysql = (catalog?.dbVersions ?? []).filter((v) => v.engine === 'mysql');

  return (
    <div className="space-y-4">
      {r && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat label={t('migration.overview.accounts') || 'Accounts'} value={r.totals.accounts} />
          <MiniStat label={t('migration.overview.selected') || 'Selected'} value={r.totals.selected} tone="green" />
          <MiniStat label={t('migration.overview.blocked') || 'Blocked'} value={r.totals.blocked} tone={r.totals.blocked > 0 ? 'red' : undefined} />
          <MiniStat label={t('migration.overview.files') || 'Files'} value={formatBytes(r.totals.filesBytes, units)} />
          <MiniStat label={t('migration.overview.databases') || 'Databases'} value={formatBytes(r.totals.dbBytes, units)} />
          <MiniStat label={t('migration.overview.mail') || 'Mail'} value={formatBytes(r.totals.mailBytes, units)} />
        </div>
      )}
      {r && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>{t('migration.overview.dryRun') || 'Dry-run'} · {formatDateTime(r.computedAt, i18n.language)}</span>
          <SeverityCounts counts={counts} />
        </div>
      )}

      <Card
        title={t('migration.overview.globalChoices') || 'Global choices'}
        actions={
          <>
            {dirty && <Button size="sm" variant="ghost" onClick={() => editor.resetSection('global')}>{t('migration.common.reset') || 'Reset'}</Button>}
            <Button size="sm" loading={editor.savingChoices} disabled={!dirty} onClick={() => { void editor.saveSection('global'); }}>
              <Save size={13} className="mr-1.5" />{t('migration.overview.saveAndCompute') || 'Save and recompute'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="g-tenant" className={labelCls}>{t('migration.overview.defaultTenant') || 'Default target workspace'}</label>
            <select id="g-tenant" className={selectCls} value={g.defaultTenantId} onChange={(e) => set('defaultTenantId', Number(e.target.value))}>
              {(catalog?.tenants ?? [{ id: g.defaultTenantId, name: `#${g.defaultTenantId}` }]).map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="g-node" className={labelCls}>{t('migration.overview.node') || 'Node of the new accounts'}</label>
            <select id="g-node" className={selectCls} value={g.nodeId ?? ''} onChange={(e) => set('nodeId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('migration.overview.localNode') || 'Local node'}</option>
              {(catalog?.nodes ?? []).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-2">
            <span className={labelCls}>{t('migration.overview.sourceIps') || 'Addresses of the CWP server (rewritten in the zones)'}</span>
            <IpChips value={g.sourceIps} onChange={(v) => set('sourceIps', v)} />
            <p className="mt-1 text-[11px] text-text-muted">{t('migration.overview.sourceIpsHint') || 'Exact rewrite in the A / AAAA records and the ip4: / ip6: tokens of the SPF. A records pointing to other machines are kept.'}</p>
          </div>
          <div>
            <label htmlFor="g-v4" className={labelCls}>{t('migration.overview.targetIpv4') || 'New IPv4'}</label>
            <input id="g-v4" className={cn(inputCls, 'font-mono')} value={g.targetIpv4 ?? ''} placeholder={catalog?.platformIpv4 ?? ''} onChange={(e) => set('targetIpv4', e.target.value.trim() || null)} spellCheck={false} />
          </div>
          <div>
            <label htmlFor="g-v6" className={labelCls}>{t('migration.overview.targetIpv6') || 'New IPv6'}</label>
            <input id="g-v6" className={cn(inputCls, 'font-mono')} value={g.targetIpv6 ?? ''} placeholder={catalog?.platformIpv6 ?? ''} onChange={(e) => set('targetIpv6', e.target.value.trim() || null)} spellCheck={false} />
          </div>
          <div>
            <label htmlFor="g-ttl" className={labelCls}>{t('migration.overview.importTtl') || 'TTL forced on the imported records'}</label>
            <input
              id="g-ttl" inputMode="numeric" className={cn(inputCls, 'font-mono')}
              value={g.importTtl ?? ''}
              placeholder={t('migration.overview.keepTtl') || 'keep the source TTL'}
              onChange={(e) => { const n = Number(e.target.value.replace(/[^0-9]/g, '')); set('importTtl', e.target.value.trim() && n > 0 ? n : null); }}
            />
            <p className="mt-1 text-[11px] text-text-muted">{t('migration.overview.importTtlHint') || '60 … 604800 s, until the cutover. Empty = keep.'}</p>
          </div>
          <div>
            <label htmlFor="g-db" className={labelCls}>{t('migration.overview.dbEngine') || 'Database instances'}</label>
            <select id="g-db" className={selectCls} value={`${g.dbEngine}:${g.dbVersion}`} onChange={(e) => { const [en, v] = e.target.value.split(':'); set('dbEngine', en as MigrationGlobalChoices['dbEngine']); set('dbVersion', v); }}>
              {mariadb.length === 0 && <option value={`${g.dbEngine}:${g.dbVersion}`}>{g.dbEngine} {g.dbVersion}</option>}
              {mariadb.map((v) => <option key={v.version} value={`mariadb:${v.version}`}>MariaDB {v.version}{v.nativeHashes ? '' : ' ⚠'}</option>)}
              {mysql.map((v) => <option key={v.version} value={`mysql:${v.version}`} disabled>MySQL {v.version} — {t('migration.overview.mysqlRefused') || 'refused'}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-text-muted">{t('migration.overview.dbEngineHint') || 'MariaDB only (≥ 10.6): native password hashes and SET USER are guaranteed there, so users keep their passwords and DEFINERs are restored. MySQL is refused (dbEngineUnsupported).'}</p>
          </div>
          <div>
            <label htmlFor="g-susp" className={labelCls}>{t('migration.overview.suspended') || 'Suspended accounts'}</label>
            <select id="g-susp" className={selectCls} value={g.suspendedAccounts} onChange={(e) => set('suspendedAccounts', e.target.value as MigrationGlobalChoices['suspendedAccounts'])}>
              <option value="keep-suspended">{t('migration.overview.suspendedKeep') || 'Migrate them suspended'}</option>
              <option value="activate">{t('migration.overview.suspendedActivate') || 'Migrate them active'}</option>
              <option value="skip">{t('migration.overview.suspendedSkip') || 'Do not migrate them'}</option>
            </select>
          </div>
        </div>

        <div className="mt-5">
          <span className={labelCls}>{t('migration.overview.include') || 'Migrate'}</span>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {INCLUDE_KEYS.map((k) => (
              <ToggleSwitch key={k} checked={g.include[k]} onChange={(v) => set('include', { ...g.include, [k]: v })} label={t(`migration.overview.includes.${k}`, { defaultValue: k })} />
            ))}
          </div>
        </div>

        <div className={cn('mt-5 rounded-lg p-3', g.scanOverride ? 'bg-status-down/10 ring-1 ring-status-down/40' : 'bg-bg-primary')}>
          <ToggleSwitch checked={g.scanOverride} onChange={(v) => set('scanOverride', v)} label={t('migration.overview.scanOverride') || 'Publish even when the scan blocks'} />
          <p className={cn('mt-1.5 flex items-start gap-1.5 text-[11px]', g.scanOverride ? 'text-status-down' : 'text-text-muted')}>
            <AlertTriangle size={12} className="mt-px shrink-0" />
            {t('migration.overview.scanOverrideHint') || 'Staff override, audited: a release whose malware / secret scan blocks is approved with the reason « migration CWP ». Leave off unless the source code was reviewed.'}
          </p>
        </div>
      </Card>

      {r && (r.warnings.length > 0 || r.followUps.length > 0) && (
        <Card title={t('migration.overview.planWarnings') || 'Plan-wide warnings and follow-ups'}>
          <div className="space-y-3">
            <WarningList warnings={r.warnings} />
            <FollowUpList followUps={r.followUps} />
          </div>
        </Card>
      )}
      {!r && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-bg-secondary p-4 text-sm text-text-secondary">
          {t('migration.overview.noResult') || 'No dry-run yet.'}
          <Button size="sm" loading={editor.computing} onClick={() => { void editor.compute(); }}><Calculator size={13} className="mr-1.5" />{t('migration.plan.compute') || 'Recompute'}</Button>
        </div>
      )}
    </div>
  );
}
