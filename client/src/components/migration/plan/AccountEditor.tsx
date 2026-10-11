import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  APP_PROFILES, SITE_BASES,
  type AppProfileId, type CwpAccount, type CwpDomain, type CwpInventory, type MigrationAccountChoice, type MigrationAccountPlan,
  type MigrationDomainChoice, type MigrationTargetCatalog, type PlannedSite, type SiteBaseId,
} from '@oblimint/shared';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Pill, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, warningsFor } from '../migrationFormat';
import { FollowUpList, InventoryStatus, WarningList, checkboxCls, useByteUnits, type InventoryLoad } from '../migrationUi';
import { RecordsTable } from '../discoveries/InventoryParts';
import { SERVING_TONE, cwpKindLabel, servingLabel } from '../discoveries/discoveryLabels';
import type { PlanEditor } from './usePlanEditor';

type DomainAs = NonNullable<MigrationDomainChoice['as']>;
const smallInput = cn(inputCls, 'py-1.5 text-xs');
const smallSelect = cn(selectCls, 'py-1.5 text-xs');

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl bg-bg-secondary">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <h3 className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{title}</h3>
        {count != null && <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{count}</span>}
        <span className="ml-auto text-xs text-text-muted">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="space-y-2 px-4 pb-4">{children}</div>}
    </section>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" className={checkboxCls} checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />;
}

/** Base select with the « unmaintained runtime » badge and the PHP version detected on the source. */
export function BaseSelect({ value, onChange, allowed, detected, id }: { value: SiteBaseId; onChange: (v: SiteBaseId) => void; allowed?: SiteBaseId[]; detected?: string | null; id?: string }) {
  const { t } = useTranslation();
  const def = SITE_BASES.find((b) => b.id === value);
  const list = SITE_BASES.filter((b) => !allowed || allowed.length === 0 || allowed.includes(b.id) || b.id === value);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select id={id} className={cn(smallSelect, 'w-auto min-w-[10rem]')} value={value} onChange={(e) => onChange(e.target.value as SiteBaseId)}>
        {list.map((b) => <option key={b.id} value={b.id}>{b.id}{b.unmaintained ? ` — ${t('migration.editor.unmaintainedShort') || 'unmaintained'}` : ''}</option>)}
      </select>
      {def?.unmaintained && <Pill tone="amber">{t('migration.editor.unmaintained') || 'unmaintained runtime'}</Pill>}
      {detected !== undefined && <span className="font-mono text-[11px] text-text-muted">{t('migration.editor.detectedPhp', { version: detected ?? '—', defaultValue: 'source: PHP {{version}}' })}</span>}
    </div>
  );
}

const parseLines = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter(Boolean);

/** One pattern per line: the raw text is kept locally (a new empty line being typed is not swallowed), the parsed list is written. */
function LinesField({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  const key = JSON.stringify(value);
  // An outside change (server answer, reset) replaces the text only when it differs from what is typed.
  useEffect(() => {
    setText((cur) => (JSON.stringify(parseLines(cur)) === key ? cur : (JSON.parse(key) as string[]).join('\n')));
  }, [key]);
  return (
    <textarea
      id={id} rows={2} className={cn(smallInput, 'font-mono')}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = parseLines(e.target.value);
        if (JSON.stringify(next) !== key) onChange(next);
      }}
      onBlur={() => setText(parseLines(text).join('\n'))}
      spellCheck={false}
    />
  );
}

/**
 * Entries outside the docroot copied with the site (CWP layout: ~/private_html…): the detected / attached ones of
 * the planned site + the home entries nobody cites. Ticking writes the full list (the detection is then replaced).
 */
function OutsideField({ site, cwp, value, onChange }: {
  site: PlannedSite; cwp: CwpAccount | null; value: string[] | null | undefined; onChange: (v: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const units = useByteUnits();
  const home = (cwp?.homeDir ?? '').replace(/\/+$/, '');
  const short = (p: string) => (home && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  // Absent on a result computed before this field existed.
  const outside = site.outside ?? [];
  const listed = new Set(outside.map((o) => o.path));
  const leftovers = (cwp?.homeLeftovers ?? []).filter((e) => !listed.has(e.path));
  const attached = outside.filter((o) => o.attached).map((o) => o.path);
  const toggle = (path: string, on: boolean) => onChange(on ? [...new Set([...attached, path])] : attached.filter((p) => p !== path));
  if (outside.length === 0 && leftovers.length === 0) return null;
  const row = (path: string, checked: boolean, bytes: number | null, note: string | null) => (
    <label key={path} className="flex flex-wrap items-center gap-2 text-xs">
      <input type="checkbox" className={checkboxCls} checked={checked} onChange={(e) => toggle(path, e.target.checked)} />
      <code className="font-mono text-text-primary">{short(path)}</code>
      <span className="font-mono text-[11px] text-text-muted">{formatBytes(bytes, units)}</span>
      {note && <span className="text-[11px] text-text-muted">{note}</span>}
    </label>
  );
  return (
    <div className="md:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={labelCls}>{t('migration.editor.outside') || 'Outside the docroot'}</span>
        {value != null && (
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => onChange(null)}>
            {t('migration.editor.outsideAuto') || 'Back to automatic detection'}
          </button>
        )}
      </div>
      <p className="mb-1 text-[10px] text-text-muted">{t('migration.editor.outsideHint') || 'Copied with the site at the same place relative to the docroot (never served by the web, read-only).'}</p>
      <div className="space-y-1">
        {outside.map((o) => row(o.path, o.attached, o.bytes, o.citedBy
          ? t('migration.editor.outsideCitedBy', { file: o.citedBy, defaultValue: 'cited in {{file}}' })
          : (t('migration.editor.outsideManual') || 'attached by hand')))}
      </div>
      {leftovers.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-text-muted">{t('migration.editor.outsideLeftovers') || 'Other entries of the home (not migrated)'} ({leftovers.length})</summary>
          <div className="mt-1 space-y-1">{leftovers.map((e) => row(e.path, false, e.bytes, null))}</div>
        </details>
      )}
    </div>
  );
}

function DomainEditor({ d, editor, account, catalog, cwp }: { d: CwpDomain; editor: PlanEditor; account: MigrationAccountPlan | null; catalog: MigrationTargetCatalog | null; cwp: CwpAccount | null }) {
  const { t } = useTranslation();
  const user = d.account;
  const choice = editor.accountChoice(user).domains?.[d.fqdn] ?? {};
  const planned = account?.domains.find((x) => x.fqdn === d.fqdn) ?? null;
  const site = planned?.siteKey ? account?.sites.find((s) => s.key === planned.siteKey) ?? null : null;
  const proxy = planned?.proxyKey ? account?.proxies.find((p) => p.key === planned.proxyKey) ?? null : null;
  const derivedAs: DomainAs = !planned ? 'skip' : planned.servedBy === 'site' ? 'site' : planned.servedBy === 'proxy' ? 'proxy' : 'alias';
  const as: DomainAs = choice.as ?? derivedAs;
  const patch = (p: Partial<MigrationDomainChoice>) => editor.editAccount(user, (cur) => ({
    ...cur, domains: { ...(cur.domains ?? {}), [d.fqdn]: { ...(cur.domains?.[d.fqdn] ?? {}), ...p } },
  }));
  const warnings = account ? warningsFor(account.warnings, ['domain', 'site', 'proxy'], d.fqdn) : [];
  const siteWarnings = account && site ? warningsFor(account.warnings, 'site', site.key).filter((w) => !warnings.includes(w)) : [];
  const runtimes = choice.secondaryRuntimes ?? site?.secondaryRuntimes ?? [];
  const excludes = choice.excludes ?? site?.excludes ?? [];
  const proxyTarget = choice.proxy ?? (proxy ? { host: proxy.target.host, port: proxy.target.port, scheme: proxy.target.scheme, websocket: proxy.websocket } : d.proxy ? { host: d.proxy.host, port: d.proxy.port, scheme: d.proxy.scheme, websocket: d.proxy.websocket } : null);
  const base = (choice.base ?? site?.base ?? 'apache-php8.3') as SiteBaseId;

  return (
    <div className={cn('rounded-lg bg-bg-primary p-3', as === 'skip' && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm text-text-primary">{d.fqdn}</code>
        <Pill>{cwpKindLabel(t, d.kind)}</Pill>
        <Pill tone={SERVING_TONE[d.serving]}>{servingLabel(t, d.serving)}</Pill>
        {d.docrootNonStandard && <Pill tone="amber">{t('migration.inventory.nonStandard') || 'non-standard'}</Pill>}
        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor={`as-${d.fqdn}`}>{t('migration.editor.as') || 'Migrate as'}</label>
          <select id={`as-${d.fqdn}`} className={cn(smallSelect, 'w-auto')} value={as} onChange={(e) => patch({ as: e.target.value as DomainAs })}>
            <option value="site">{t('migration.editor.asSite') || 'Site'}</option>
            <option value="proxy">{t('migration.editor.asProxy') || 'Proxy host'}</option>
            <option value="alias">{t('migration.editor.asAlias') || 'Alias of another site'}</option>
            <option value="skip">{t('migration.editor.asSkip') || 'Skip'}</option>
          </select>
        </div>
      </div>

      {as === 'site' && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor={`sk-${d.fqdn}`}>{t('migration.editor.siteKey') || 'Site group'}</label>
            <input id={`sk-${d.fqdn}`} className={cn(smallInput, 'font-mono')} value={choice.siteKey ?? planned?.siteKey ?? ''} onChange={(e) => patch({ siteKey: e.target.value || null })} spellCheck={false} />
            <p className="mt-0.5 text-[10px] text-text-muted">{t('migration.editor.siteKeyHint') || 'Domains with the same group share one site (default: same docroot).'}</p>
          </div>
          <div>
            <label className={labelCls} htmlFor={`base-${d.fqdn}`}>{t('migration.editor.base') || 'Base'}</label>
            <BaseSelect id={`base-${d.fqdn}`} value={base} onChange={(v) => patch({ base: v })} allowed={catalog?.bases} detected={d.php?.version ?? null} />
          </div>
          <div>
            <label className={labelCls} htmlFor={`pr-${d.fqdn}`}>{t('migration.editor.profile') || 'Application profile'}</label>
            <select id={`pr-${d.fqdn}`} className={smallSelect} value={choice.profile ?? site?.profile ?? ''} onChange={(e) => patch({ profile: (e.target.value || null) as AppProfileId | null })}>
              <option value="">{t('migration.editor.noProfile') || 'None (generic)'}</option>
              {APP_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {site && site.dataPaths.length > 0 && <p className="mt-0.5 font-mono text-[10px] text-text-muted">{t('migration.editor.dataPaths') || 'Data'}: {site.dataPaths.map((p) => p.path).join(', ')}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor={`ver-${d.fqdn}`}>{t('migration.editor.verification') || 'Ownership'}</label>
            <select id={`ver-${d.fqdn}`} className={smallSelect} value={choice.verification ?? planned?.verification ?? 'txt'} onChange={(e) => patch({ verification: e.target.value as 'force' | 'txt' })}>
              <option value="force">{t('migration.editor.verifyForce') || 'Forced by the staff (audited)'}</option>
              <option value="txt">{t('migration.editor.verifyTxt') || 'TXT record at the current DNS host'}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor={`sr-${d.fqdn}`}>{t('migration.editor.sourceRoot') || 'Copied directory (source)'}</label>
            <input id={`sr-${d.fqdn}`} className={cn(smallInput, 'font-mono')} value={choice.sourceRoot ?? site?.sourceRoot ?? d.docroot ?? ''} onChange={(e) => patch({ sourceRoot: e.target.value || null })} spellCheck={false} />
          </div>
          <div>
            <label className={labelCls} htmlFor={`dr-${d.fqdn}`}>{t('migration.editor.docroot') || 'Docroot (relative)'}</label>
            <input id={`dr-${d.fqdn}`} className={cn(smallInput, 'font-mono')} value={choice.docroot ?? site?.docroot ?? ''} placeholder={t('migration.editor.docrootRoot') || '(the directory itself)'} onChange={(e) => patch({ docroot: e.target.value })} spellCheck={false} />
          </div>
          <div className="md:col-span-2">
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('migration.editor.runtimes') || 'Secondary runtimes (path prefix → base)'}</span>
              <IconButton size="sm" variant="ghost" label={t('migration.editor.addRuntime') || 'Add a runtime'} icon={<Plus size={13} />} onClick={() => patch({ secondaryRuntimes: [...runtimes, { pathPrefix: '/', base: 'apache-php7.4' }] })} />
            </div>
            {d.php && d.php.htaccessOverrides.length > 0 && <p className="mb-1 text-[11px] text-amber-400">{t('migration.editor.overridesFound') || '.htaccess overrides found'}: {d.php.htaccessOverrides.map((o) => `${o.path} → PHP ${o.version}`).join(', ')}</p>}
            <div className="space-y-1.5">
              {runtimes.map((rt, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input aria-label={t('migration.editor.pathPrefix') || 'Path prefix'} className={cn(smallInput, 'w-40 font-mono')} value={rt.pathPrefix} onChange={(e) => patch({ secondaryRuntimes: runtimes.map((x, j) => (j === i ? { ...x, pathPrefix: e.target.value } : x)) })} />
                  <BaseSelect value={rt.base} onChange={(v) => patch({ secondaryRuntimes: runtimes.map((x, j) => (j === i ? { ...x, base: v } : x)) })} allowed={catalog?.bases} />
                  <IconButton size="sm" variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 size={13} />} onClick={() => patch({ secondaryRuntimes: runtimes.filter((_, j) => j !== i) })} />
                </div>
              ))}
            </div>
          </div>
          <div className="md:col-span-2">
            <label className={labelCls} htmlFor={`ex-${d.fqdn}`}>{t('migration.editor.excludes') || 'Excluded from the copy (one pattern per line)'}</label>
            <LinesField id={`ex-${d.fqdn}`} value={excludes} onChange={(v) => patch({ excludes: v })} />
          </div>
          {site && !choice.sourceRoot && <OutsideField site={site} cwp={cwp} value={choice.outside} onChange={(v) => patch({ outside: v })} />}
        </div>
      )}

      {as === 'alias' && (
        <div className="mt-3 max-w-sm">
          <label className={labelCls} htmlFor={`ak-${d.fqdn}`}>{t('migration.editor.aliasOf') || 'Alias of the site'}</label>
          <select id={`ak-${d.fqdn}`} className={smallSelect} value={choice.siteKey ?? ''} onChange={(e) => patch({ siteKey: e.target.value || null })}>
            <option value="">{t('migration.editor.aliasOfMain') || 'Site of the main domain (default)'}</option>
            {(account?.sites ?? []).map((s) => <option key={s.key} value={s.key}>{s.slug} ({s.key})</option>)}
            {choice.siteKey && !(account?.sites ?? []).some((s) => s.key === choice.siteKey) && <option value={choice.siteKey}>{choice.siteKey}</option>}
          </select>
        </div>
      )}

      {as === 'proxy' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-[6rem_1fr_6rem_auto] sm:items-end">
          <div>
            <label className={labelCls} htmlFor={`ps-${d.fqdn}`}>{t('migration.editor.scheme') || 'Scheme'}</label>
            <select id={`ps-${d.fqdn}`} className={smallSelect} value={proxyTarget?.scheme ?? 'http'} onChange={(e) => patch({ proxy: { host: proxyTarget?.host ?? '', port: proxyTarget?.port ?? 80, websocket: proxyTarget?.websocket ?? false, scheme: e.target.value as 'http' | 'https' } })}>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor={`ph-${d.fqdn}`}>{t('migration.editor.targetHost') || 'Target host'}</label>
            <input id={`ph-${d.fqdn}`} className={cn(smallInput, 'font-mono')} value={proxyTarget?.host ?? ''} onChange={(e) => patch({ proxy: { scheme: proxyTarget?.scheme ?? 'http', port: proxyTarget?.port ?? 80, websocket: proxyTarget?.websocket ?? false, host: e.target.value.trim() } })} spellCheck={false} />
          </div>
          <div>
            <label className={labelCls} htmlFor={`pp-${d.fqdn}`}>{t('migration.editor.port') || 'Port'}</label>
            <input id={`pp-${d.fqdn}`} inputMode="numeric" className={cn(smallInput, 'font-mono')} value={proxyTarget?.port ?? ''} onChange={(e) => patch({ proxy: { scheme: proxyTarget?.scheme ?? 'http', host: proxyTarget?.host ?? '', websocket: proxyTarget?.websocket ?? false, port: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } })} />
          </div>
          <ToggleSwitch size="sm" checked={proxyTarget?.websocket ?? false} onChange={(v) => patch({ proxy: { scheme: proxyTarget?.scheme ?? 'http', host: proxyTarget?.host ?? '', port: proxyTarget?.port ?? 80, websocket: v } })} label="WebSocket" />
          <p className="text-[11px] text-text-muted sm:col-span-4">{t('migration.editor.proxyHint') || 'External target of a P4b proxy host: it must be reachable FROM the Oblimint node (not from the CWP server).'}</p>
        </div>
      )}

      {(warnings.length > 0 || siteWarnings.length > 0) && <div className="mt-2"><WarningList warnings={[...warnings, ...siteWarnings]} showScope={false} /></div>}
    </div>
  );
}

function SelectRow({ checked, onChange, label, children, warnings }: { checked: boolean; onChange: (v: boolean) => void; label: string; children?: ReactNode; warnings?: ReactNode }) {
  return (
    <div className={cn('rounded-md bg-bg-primary px-3 py-2', !checked && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Check checked={checked} onChange={onChange} label={label} />
        <code className="font-mono text-text-primary">{label}</code>
        {children}
      </div>
      {warnings}
    </div>
  );
}

/** Editor of one account of the plan (every change is written debounced and recomputes the dry-run). */
export function AccountEditor({ username, editor, inventory, inventoryStatus, catalog }: {
  username: string;
  editor: PlanEditor;
  inventory: CwpInventory | null;
  /** Loading / error of the inventory: « not available » is only said when it truly is not (no error, not loading). */
  inventoryStatus?: InventoryLoad;
  catalog: MigrationTargetCatalog | null;
}) {
  const { t } = useTranslation();
  const units = useByteUnits();
  const account = editor.plan.result?.accounts.find((a) => a.cwpUsername === username) ?? null;
  const choice = editor.accountChoice(username);
  const edit = (update: (c: MigrationAccountChoice) => MigrationAccountChoice) => editor.editAccount(username, update);
  type MapKey = 'databases' | 'dbUsers' | 'zones' | 'mailDomains' | 'mailboxes' | 'aliases' | 'certificates' | 'crons';
  const setIn = <K extends MapKey>(k: K, key: string, p: Record<string, unknown>) => edit((c) => ({
    ...c, [k]: { ...((c[k] ?? {}) as Record<string, object>), [key]: { ...(((c[k] ?? {}) as Record<string, object>)[key] ?? {}), ...p } },
  }));
  const sel = (k: MapKey, key: string, plannedHas: boolean): boolean => {
    const m = choice[k] as Record<string, { selected?: boolean }> | undefined;
    return m?.[key]?.selected ?? plannedHas;
  };
  const w = (kind: string, key: string) => {
    const list = account ? warningsFor(account.warnings, kind, key) : [];
    return list.length ? <div className="mt-1.5"><WarningList warnings={list} showScope={false} /></div> : null;
  };

  const inv = inventory;
  const domains = inv?.domains.filter((d) => d.account === username) ?? [];
  const dbs = inv?.databases.filter((d) => d.account === username) ?? [];
  const dbUserNames = [...new Set((inv?.dbUsers.filter((d) => d.account === username) ?? []).map((u) => u.user))];
  const zones = inv?.dnsZones.filter((z) => z.account === username) ?? [];
  const mailDomains = inv?.mailDomains.filter((m) => m.account === username) ?? [];
  const mailboxes = inv?.mailboxes.filter((m) => m.account === username || mailDomains.some((d) => d.name === m.domain)) ?? [];
  const aliases = inv?.mailAliases.filter((m) => m.account === username || mailDomains.some((d) => d.name === m.domain)) ?? [];
  const dkim = inv?.dkimKeys.filter((k) => k.account === username || mailDomains.some((d) => d.name === k.domain)) ?? [];
  const ftp = inv?.ftpUsers.filter((f) => f.account === username) ?? [];
  const crons = inv?.crons.filter((c) => c.account === username && !c.system) ?? [];
  const certs = inv?.certificates.filter((c) => c.account === username) ?? [];
  const tenantId = choice.tenantId ?? account?.tenantId ?? editor.plan.choices.global.defaultTenantId;
  const tenantPlans = (catalog?.plans ?? []).filter((p) => p.tenantId === tenantId);
  const dbi = choice.dbInstance ?? (account?.dbInstance ? { mode: account.dbInstance.mode, instanceId: account.dbInstance.instanceId, engine: account.dbInstance.engine, version: account.dbInstance.version, name: account.dbInstance.name } : null);
  const sites = account?.sites ?? [];

  if (!inv) {
    if (inventoryStatus && (inventoryStatus.loading || inventoryStatus.error)) return <InventoryStatus status={inventoryStatus} />;
    return <p className="text-sm text-text-muted">{t('migration.editor.noInventory') || 'Inventory not available.'}</p>;
  }

  return (
    <div className="space-y-3">
      {account && account.warnings.some((x) => x.scope.kind === 'account') && <WarningList warnings={account.warnings.filter((x) => x.scope.kind === 'account')} showScope={false} />}

      <Section title={t('migration.editor.account') || 'Account'}>
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleSwitch checked={choice.selected ?? account?.selected ?? true} onChange={(v) => edit((c) => ({ ...c, selected: v }))} label={t('migration.editor.selected') || 'Migrate this account'} />
          <ToggleSwitch checked={choice.suspended ?? account?.suspended ?? false} onChange={(v) => edit((c) => ({ ...c, suspended: v }))} label={t('migration.editor.suspended') || 'Suspended on the target'} />
          <div>
            <label className={labelCls} htmlFor="ae-tenant">{t('migration.accounts.tenant') || 'Workspace'}</label>
            <select id="ae-tenant" className={smallSelect} value={tenantId} onChange={(e) => edit((c) => ({ ...c, tenantId: Number(e.target.value), planId: null }))}>
              {(catalog?.tenants ?? [{ id: tenantId, name: `#${tenantId}` }]).map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ae-user">{t('migration.accounts.targetUsername') || 'Target username'}</label>
            <input id="ae-user" className={cn(smallInput, 'font-mono')} value={choice.targetUsername ?? account?.targetUsername ?? username} onChange={(e) => edit((c) => ({ ...c, targetUsername: e.target.value.trim().toLowerCase() || null }))} spellCheck={false} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="ae-plan">{t('migration.accounts.plan') || 'Plan'}</label>
            <select id="ae-plan" className={smallSelect} value={choice.planId ?? ''} onChange={(e) => edit((c) => ({ ...c, planId: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">{t('migration.accounts.fromPackage') || 'From the package mapping'}{account ? ` (${account.packageKey})` : ''}</option>
              {tenantPlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      </Section>

      <Section title={t('migration.editor.domains') || 'Domains'} count={domains.length}>
        {domains.map((d) => <DomainEditor key={d.fqdn} d={d} editor={editor} account={account} catalog={catalog} cwp={inv?.accounts.find((a) => a.username === username) ?? null} />)}
        {sites.length > 0 && (
          <p className="text-[11px] text-text-muted">
            {t('migration.editor.sitesResult') || 'Resulting sites'}: {sites.map((s) => `${s.slug} (${s.base}, ${s.routes.length})`).join(' · ')}
          </p>
        )}
      </Section>

      {(dbs.length > 0 || dbUserNames.length > 0) && (
        <Section title={t('migration.editor.databases') || 'Databases'} count={dbs.length}>
          <div className="grid gap-3 rounded-md bg-bg-primary p-3 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="ae-dbmode">{t('migration.editor.instance') || 'Instance'}</label>
              <select id="ae-dbmode" className={smallSelect} value={dbi?.mode ?? 'create'} onChange={(e) => edit((c) => ({ ...c, dbInstance: { ...(dbi ?? {}), mode: e.target.value as 'create' | 'existing' } }))}>
                <option value="create">{t('migration.editor.instanceCreate') || 'New MariaDB instance'}</option>
                <option value="existing">{t('migration.editor.instanceExisting') || 'Existing instance'}</option>
              </select>
            </div>
            {dbi?.mode === 'existing' ? (
              <div>
                <label className={labelCls} htmlFor="ae-dbid">{t('migration.editor.instanceId') || 'Instance id'}</label>
                <input id="ae-dbid" inputMode="numeric" className={cn(smallInput, 'font-mono')} value={dbi.instanceId ?? ''} onChange={(e) => edit((c) => ({ ...c, dbInstance: { ...dbi, mode: 'existing', instanceId: Number(e.target.value.replace(/[^0-9]/g, '')) || null } }))} />
              </div>
            ) : (
              <>
                <div>
                  <label className={labelCls} htmlFor="ae-dbver">{t('migration.editor.version') || 'Version'}</label>
                  <select id="ae-dbver" className={smallSelect} value={dbi?.version ?? editor.plan.choices.global.dbVersion} onChange={(e) => edit((c) => ({ ...c, dbInstance: { ...(dbi ?? { mode: 'create' }), mode: 'create', engine: 'mariadb', version: e.target.value } }))}>
                    {(catalog?.dbVersions ?? []).filter((v) => v.engine === 'mariadb').map((v) => <option key={v.version} value={v.version}>MariaDB {v.version}</option>)}
                    {!catalog && <option value={dbi?.version ?? editor.plan.choices.global.dbVersion}>MariaDB {dbi?.version ?? editor.plan.choices.global.dbVersion}</option>}
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="ae-dbname">{t('migration.editor.instanceName') || 'Instance name'}</label>
                  <input id="ae-dbname" className={cn(smallInput, 'font-mono')} value={dbi?.name ?? ''} placeholder={account?.dbInstance?.name ?? username} onChange={(e) => edit((c) => ({ ...c, dbInstance: { ...(dbi ?? { mode: 'create' }), name: e.target.value || null } }))} />
                </div>
              </>
            )}
          </div>
          {dbs.map((db) => {
            const planned = account?.databases.find((x) => x.name === db.name);
            const cs = choice.databases?.[db.name]?.dumpCharset ?? planned?.dumpCharset ?? 'utf8mb4';
            return (
              <SelectRow key={db.name} label={db.name} checked={sel('databases', db.name, !!planned)} onChange={(v) => setIn('databases', db.name, { selected: v })} warnings={w('database', db.name)}>
                <span className="font-mono text-[11px] text-text-muted">{formatBytes(db.sizeBytes, units)}</span>
                {db.objects.length > 0 && <Pill>DEFINER ×{db.objects.length}</Pill>}
                {db.latin1Tables > 0 && <Pill tone="amber">latin1</Pill>}
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-muted">
                  {t('migration.editor.dumpCharset') || 'Dump charset'}
                  <select className={cn(smallSelect, 'w-auto')} value={cs} onChange={(e) => setIn('databases', db.name, { dumpCharset: e.target.value })}>
                    <option value="utf8mb4">utf8mb4</option>
                    <option value="latin1">latin1</option>
                    <option value="binary">binary</option>
                  </select>
                </label>
              </SelectRow>
            );
          })}
          {dbUserNames.map((u) => {
            const planned = account?.dbUsers.find((x) => x.username === u);
            return (
              <SelectRow key={u} label={u} checked={sel('dbUsers', u, !!planned)} onChange={(v) => setIn('dbUsers', u, { selected: v })} warnings={w('dbUser', u)}>
                <Pill tone="blue">{t('migration.editor.dbUser') || 'user'}</Pill>
                {planned && <span className="font-mono text-[11px] text-text-muted">{planned.sourceHosts.join(', ')} → {planned.targetHost} · {planned.grants.map((g) => `${g.database}:${g.level}`).join(', ')}</span>}
              </SelectRow>
            );
          })}
        </Section>
      )}

      {zones.length > 0 && (
        <Section title={t('migration.editor.zones') || 'DNS zones'} count={zones.length}>
          {zones.map((z) => {
            const planned = account?.zones.find((x) => x.name === z.name);
            const zc = choice.zones?.[z.name];
            return (
              <SelectRow key={z.name} label={z.name} checked={sel('zones', z.name, !!planned)} onChange={(v) => setIn('zones', z.name, { selected: v })} warnings={w('zone', z.name)}>
                {planned && <span className="font-mono text-[11px] text-text-muted">{t('migration.editor.zoneStats', { records: planned.records.length, rewritten: planned.rewritten, dropped: planned.dropped.length, defaultValue: '{{records}} records · {{rewritten}} rewritten · {{dropped}} dropped' })}</span>}
                <span className="ml-auto"><ToggleSwitch size="sm" checked={zc?.rewriteIps ?? true} onChange={(v) => setIn('zones', z.name, { rewriteIps: v })} label={t('migration.editor.rewriteIps') || 'Rewrite the IPs'} /></span>
                {planned && <ZonePreview zone={planned} />}
              </SelectRow>
            );
          })}
        </Section>
      )}

      {(mailDomains.length > 0 || mailboxes.length > 0) && (
        <Section title={t('migration.editor.mail') || 'Mail'} count={mailboxes.length}>
          {mailDomains.map((md) => (
            <div key={md.name} className="space-y-1.5">
              <SelectRow label={md.name} checked={sel('mailDomains', md.name, !!account?.mailDomains.some((x) => x.name === md.name))} onChange={(v) => setIn('mailDomains', md.name, { selected: v })} warnings={w('mailDomain', md.name)}>
                <Pill tone="blue">{t('migration.editor.mailDomain') || 'mail domain'}</Pill>
                {dkim.filter((k) => k.domain === md.name).map((k) => {
                  const planned = account?.dkim.find((x) => x.domain === k.domain && x.selector === k.selector);
                  const key = `${k.domain}/${k.selector}`;
                  return (
                    <span key={key} className="ml-auto">
                      <ToggleSwitch size="sm" checked={choice.dkim?.[key]?.import ?? planned?.import ?? (k.bits ?? 0) >= 2048} onChange={(v) => edit((c) => ({ ...c, dkim: { ...(c.dkim ?? {}), [key]: { import: v } } }))} label={t('migration.editor.dkimImport', { selector: k.selector, bits: k.bits ?? '?', defaultValue: 'Import DKIM {{selector}} ({{bits}} bits)' })} />
                    </span>
                  );
                })}
              </SelectRow>
              <div className="space-y-1 pl-4">
                {mailboxes.filter((m) => m.domain === md.name).map((m) => (
                  <SelectRow key={m.address} label={m.address} checked={sel('mailboxes', m.address, !!account?.mailboxes.some((x) => x.address === m.address))} onChange={(v) => setIn('mailboxes', m.address, { selected: v })} warnings={w('mailbox', m.address)}>
                    <span className="font-mono text-[11px] text-text-muted">{formatBytes(m.maildirBytes ?? m.usedBytes, units)} · {m.hashScheme ?? '—'}</span>
                  </SelectRow>
                ))}
                {aliases.filter((a) => a.domain === md.name).map((a) => (
                  <SelectRow key={a.address} label={a.address} checked={sel('aliases', a.address, !!account?.aliases.some((x) => x.address === a.address))} onChange={(v) => setIn('aliases', a.address, { selected: v })} warnings={w('alias', a.address)}>
                    <span className="font-mono text-[11px] text-text-muted">→ {a.targets.join(', ')}</span>
                  </SelectRow>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}

      {ftp.length > 0 && (
        <Section title={t('migration.editor.ftp') || 'FTP'} count={ftp.length}>
          <p className="text-[11px] text-text-muted">{t('migration.editor.ftpHint') || 'The file server has ONE SFTP login per account (login = account name). A bcrypt Pure-FTPd user can be adopted: its password becomes the SFTP password of the account.'}</p>
          {ftp.map((f) => {
            const action = choice.ftpUsers?.[f.login]?.action ?? (account?.ftp?.login === f.login && account.ftp.adopt ? 'adopt-password' : 'skip');
            return (
              <div key={f.login} className="flex flex-wrap items-center gap-2 rounded-md bg-bg-primary px-3 py-2 text-xs">
                <code className="font-mono text-text-primary">{f.login}</code>
                <Pill tone={f.hashScheme === 'bcrypt' ? 'green' : 'amber'}>{f.hashScheme}</Pill>
                <select className={cn(smallSelect, 'ml-auto w-auto')} value={action} aria-label={f.login} onChange={(e) => edit((c) => {
                  const next: NonNullable<MigrationAccountChoice['ftpUsers']> = {};
                  for (const [k, v] of Object.entries(c.ftpUsers ?? {})) next[k] = e.target.value === 'adopt-password' ? { action: 'skip' } : v;
                  next[f.login] = { action: e.target.value as 'adopt-password' | 'skip' };
                  return { ...c, ftpUsers: next };
                })}>
                  <option value="adopt-password" disabled={f.hashScheme !== 'bcrypt'}>{t('migration.editor.ftpAdopt') || 'Adopt its password'}</option>
                  <option value="skip">{t('migration.editor.ftpSkip') || 'Do not migrate'}</option>
                </select>
                {w('ftpUser', f.login)}
              </div>
            );
          })}
        </Section>
      )}

      {crons.length > 0 && (
        <Section title={t('migration.editor.crons') || 'Crons'} count={crons.length}>
          {crons.map((c) => {
            const planned = account?.crons.find((x) => x.key === c.key);
            const cc = choice.crons?.[c.key];
            return (
              <div key={c.key} className={cn('space-y-1.5 rounded-md bg-bg-primary p-3 text-xs', !(cc?.selected ?? !!planned) && 'opacity-70')}>
                <div className="flex flex-wrap items-center gap-2">
                  <Check checked={cc?.selected ?? !!planned} onChange={(v) => setIn('crons', c.key, { selected: v })} label={c.key} />
                  <code className="font-mono text-text-muted">{c.key}</code>
                  {sites.length > 0 && (
                    <select aria-label={t('migration.editor.cronSite') || 'Site'} className={cn(smallSelect, 'ml-auto w-auto')} value={cc?.siteKey ?? ''} onChange={(e) => setIn('crons', c.key, { siteKey: e.target.value || null })}>
                      {/* Empty = automatic (site whose directory the command uses, else the first one): a cron always belongs to a site on the target. */}
                      <option value="">{`${t('migration.editor.cronSiteAuto') || 'Automatic (from the command paths)'}${planned?.siteKey ? ` → ${sites.find((s) => s.key === planned.siteKey)?.slug ?? planned.siteKey}` : ''}`}</option>
                      {sites.map((s) => <option key={s.key} value={s.key}>{s.slug}</option>)}
                    </select>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                  <input aria-label={t('migration.inventory.schedule') || 'Schedule'} className={cn(smallInput, 'font-mono')} value={cc?.schedule ?? planned?.schedule ?? c.schedule} onChange={(e) => setIn('crons', c.key, { schedule: e.target.value })} />
                  <input aria-label={t('migration.inventory.command') || 'Command'} className={cn(smallInput, 'font-mono')} value={cc?.command ?? planned?.command ?? c.command} onChange={(e) => setIn('crons', c.key, { command: e.target.value })} spellCheck={false} />
                </div>
                <p className="break-all font-mono text-[10px] text-text-muted">{t('migration.editor.original') || 'Original'}: {c.schedule} {c.command}</p>
                {w('cron', c.key)}
              </div>
            );
          })}
        </Section>
      )}

      {certs.length > 0 && (
        <Section title={t('migration.editor.certificates') || 'Certificates'} count={certs.length} defaultOpen={false}>
          {certs.map((c) => (
            <SelectRow key={c.fqdn} label={c.fqdn} checked={sel('certificates', c.fqdn, !!account?.certificates.some((x) => x.fqdn === c.fqdn))} onChange={(v) => setIn('certificates', c.fqdn, { selected: v })} warnings={w('certificate', c.fqdn)}>
              {c.expired && <Pill tone="red">{t('migration.inventory.expired') || 'expired'}</Pill>}
              {c.selfSigned && <Pill tone="amber">{t('migration.inventory.selfSigned') || 'self-signed'}</Pill>}
              <span className="font-mono text-[11px] text-text-muted">{c.names.length} {t('migration.inventory.namesCount') || 'names'}</span>
            </SelectRow>
          ))}
        </Section>
      )}

      {account && account.followUps.length > 0 && (
        <Section title={t('migration.editor.followUps') || 'Manual follow-ups'} count={account.followUps.length} defaultOpen={false}>
          <FollowUpList followUps={account.followUps} />
        </Section>
      )}
    </div>
  );
}

/** Planned records vs dropped ones (with the reason) of a zone. */
export function ZonePreview({ zone }: { zone: NonNullable<MigrationAccountPlan['zones'][number]> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? (t('migration.editor.hideRecords') || 'Hide the records') : (t('migration.editor.showRecords') || 'Show the records')}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <RecordsTable records={zone.records} />
          {zone.dropped.length > 0 && (
            <>
              <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('migration.editor.dropped') || 'Not imported'}</div>
              <RecordsTable records={zone.dropped.map((x) => x.record)} extra={(i) => <span className="text-[11px] text-amber-400">{t(`migration.dropReasons.${zone.dropped[i].reason}`, { defaultValue: zone.dropped[i].reason })}</span>} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
